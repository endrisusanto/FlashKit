import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./OdinFlash.css";

// ── Types ──────────────────────────────────────────────────────────────

type SlotKey = "bl" | "ap" | "cp" | "csc" | "userdata";

interface FilePaths {
  bl: string;
  ap: string;
  cp: string;
  csc: string;
  userdata: string;
}

interface DeviceData {
  path: string;
  port: string;
  status: "Ready" | "Flashing..." | "Pass" | "Fail";
  progress: number;
  log: string;
  checked: boolean;
}

export interface OdinFlashRef {
  startFlash: () => Promise<boolean>;
  hasCheckedDevices: () => boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

function getTimestamp() {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
}

function extractUsbPort(path: string) {
  const parts = path.split("/");
  if (parts.length >= 2) return `USB:${parts[parts.length - 2]}-${parts[parts.length - 1]}`;
  return path;
}

const SLOT_LABELS: Record<SlotKey, string> = {
  bl: "BL",
  ap: "AP",
  cp: "CP",
  csc: "CSC",
  userdata: "USERDATA",
};

// ── Component ──────────────────────────────────────────────────────────

const OdinFlash = forwardRef<OdinFlashRef>((_, ref) => {
  const [filePaths, setFilePaths] = useState<FilePaths>({ bl: "", ap: "", cp: "", csc: "", userdata: "" });
  const [verifyState, setVerifyState] = useState<Record<SlotKey, { text: string; progress: number; verifying: boolean }>>({
    bl: { text: "", progress: 0, verifying: false },
    ap: { text: "", progress: 0, verifying: false },
    cp: { text: "", progress: 0, verifying: false },
    csc: { text: "", progress: 0, verifying: false },
    userdata: { text: "", progress: 0, verifying: false },
  });
  const [devices, setDevices] = useState<Record<string, DeviceData>>({});
  const [isFlashing, setIsFlashing] = useState(false);
  const [logModal, setLogModal] = useState<{ device: string; log: string } | null>(null);

  const devicesRef = useRef(devices);
  const isFlashingRef = useRef(isFlashing);
  devicesRef.current = devices;
  isFlashingRef.current = isFlashing;

  useImperativeHandle(ref, () => ({
    startFlash: async () => {
      return await startFlashInternal();
    },
    hasCheckedDevices: () => {
      return Object.values(devicesRef.current).some(d => d.checked);
    }
  }));

  // ── Device Scan ──────────────────────────────────────────────────────

  async function scanDevices() {
    if (isFlashingRef.current) return;
    try {
      const list: string[] = await invoke("odin_list_devices");
      setDevices(prev => {
        const updated = { ...prev };
        list.forEach(dev => {
          if (!updated[dev]) {
            updated[dev] = {
              path: dev,
              port: extractUsbPort(dev),
              status: "Ready",
              progress: 0,
              checked: true,
              log: `${getTimestamp()} Attached at ${dev}\n${getTimestamp()} Waiting for flash command...`,
            };
          }
        });
        return updated;
      });
    } catch (e) {
      console.error("Scan error:", e);
    }
  }

  async function forceRefresh() {
    setDevices({});
    await scanDevices();
  }

  useEffect(() => {
    scanDevices();
    const interval = setInterval(scanDevices, 2000);
    return () => clearInterval(interval);
  }, []);

  // ── Listen flash progress events ─────────────────────────────────────

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    Object.keys(devices).forEach(dev => {
      listen<string>(`flash-progress-${dev}`, (event) => {
        const msg = event.payload;
        const pctMatch = msg.match(/\((\d+)%\)/g);

        setDevices(prev => {
          const d = prev[dev];
          if (!d) return prev;

          let newProgress = d.progress;
          let clean = msg;

          if (pctMatch) {
            const lastPct = parseInt(pctMatch[pctMatch.length - 1].replace(/\D/g, ""), 10);
            newProgress = lastPct;
            clean = msg.replace(/\(\d+%\)/g, "").trim();
          }

          const newLog = clean ? `${d.log}\n${getTimestamp()} ${clean}` : d.log;
          return { ...prev, [dev]: { ...d, progress: newProgress, log: newLog } };
        });
      }).then(fn => unlisteners.push(fn));
    });

    return () => unlisteners.forEach(fn => fn());
  }, [Object.keys(devices).join(",")]);

  // ── File selection & verification ────────────────────────────────────

  async function selectFile(slot: SlotKey) {
    if (isFlashing) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Firmware", extensions: ["tar.md5", "tar", "img", "lz4"] }],
      });
      if (selected && typeof selected === "string") await verifyFile(slot, selected);
    } catch (e) {
      console.error(e);
    }
  }

  async function verifyFile(slot: SlotKey, path: string) {
    setVerifyState(prev => ({
      ...prev,
      [slot]: { text: "Verifying MD5... 0%", progress: 0, verifying: true },
    }));

    const unlisten = await listen<string>(`md5-progress-${slot}`, (event) => {
      const msg = event.payload;
      const pctMatch = msg.match(/\((\d+)%\)/g);
      if (pctMatch) {
        const pct = parseInt(pctMatch[pctMatch.length - 1].replace(/\D/g, ""), 10);
        setVerifyState(prev => ({
          ...prev,
          [slot]: { ...prev[slot], text: `Verifying MD5... ${pct}%`, progress: pct },
        }));
      }
    });

    try {
      await invoke<string>("odin_check_file", { path, slot });
      const name = path.split(/[/\\]/).pop() || path;
      setFilePaths(prev => ({ ...prev, [slot]: path }));
      setVerifyState(prev => ({
        ...prev,
        [slot]: { text: name, progress: 100, verifying: false },
      }));
    } catch (err) {
      setFilePaths(prev => ({ ...prev, [slot]: "" }));
      setVerifyState(prev => ({
        ...prev,
        [slot]: { text: "ERROR: Invalid MD5!", progress: 0, verifying: false },
      }));
      alert(`File Verification Failed for ${slot.toUpperCase()}:\n${err}`);
    } finally {
      unlisten();
    }
  }

  function handleDrop(slot: SlotKey, path: string) {
    if (!isFlashing) verifyFile(slot, path);
  }

  function clearFiles() {
    setFilePaths({ bl: "", ap: "", cp: "", csc: "", userdata: "" });
    setVerifyState({
      bl: { text: "", progress: 0, verifying: false },
      ap: { text: "", progress: 0, verifying: false },
      cp: { text: "", progress: 0, verifying: false },
      csc: { text: "", progress: 0, verifying: false },
      userdata: { text: "", progress: 0, verifying: false },
    });
  }

  // ── Drag-drop for firmware files ─────────────────────────────────────

  useEffect(() => {
    const unlistenDrop = listen<{ paths: string[] }>("tauri://drag-drop", event => {
      for (const path of event.payload.paths) {
        const fname = (path.split(/[/\\]/).pop() || "").toUpperCase();
        if (fname.startsWith("BL_")) handleDrop("bl", path);
        else if (fname.startsWith("AP_") || fname.startsWith("ALL_")) handleDrop("ap", path);
        else if (fname.startsWith("CP_")) handleDrop("cp", path);
        else if (fname.startsWith("CSC_") || fname.startsWith("HOME_CSC_")) handleDrop("csc", path);
        else if (fname.startsWith("USERDATA_")) handleDrop("userdata", path);
        else if (!filePaths.ap) handleDrop("ap", path);
      }
    });
    return () => { unlistenDrop.then(fn => fn()); };
  }, [filePaths]);

  // ── Flash ─────────────────────────────────────────────────────────────

  async function startFlashInternal(): Promise<boolean> {
    const checked = Object.entries(devicesRef.current).filter(([, d]) => d.checked);
    if (checked.length === 0) return false;

    if (!filePaths.bl && !filePaths.ap && !filePaths.cp && !filePaths.csc && !filePaths.userdata) {
      alert("Tidak ada file firmware yang dipilih di tab Odin Flash! Silakan pilih file tar.md5 terlebih dahulu.");
      return false;
    }

    setIsFlashing(true);
    let anyFail = false;
    let anyPass = false;

    await Promise.all(
      checked.map(async ([dev]) => {
        setDevices(prev => ({
          ...prev,
          [dev]: { ...prev[dev], status: "Flashing...", progress: 0, log: prev[dev].log + `\n${getTimestamp()} =====================\n${getTimestamp()} STARTING ODIN ENGINE\n${getTimestamp()} =====================` },
        }));

        try {
          const result: string = await invoke("odin_flash_device", {
            params: {
              device: dev,
              bl: filePaths.bl,
              ap: filePaths.ap,
              cp: filePaths.cp,
              csc: filePaths.csc,
              userdata: filePaths.userdata,
            },
          });
          setDevices(prev => ({
            ...prev,
            [dev]: { ...prev[dev], status: "Pass", progress: 100, log: prev[dev].log + `\n${getTimestamp()} ${result}` },
          }));
          anyPass = true;
        } catch (err) {
          setDevices(prev => ({
            ...prev,
            [dev]: { ...prev[dev], status: "Fail", log: prev[dev].log + `\n${getTimestamp()} ERROR: ${err}` },
          }));
          anyFail = true;
        }
      })
    );

    setIsFlashing(false);
    return !anyFail && anyPass;
  }

  // ── UI (Original Odin-Clone Style) ────────────────────────────────────

  const checkedCount = Object.values(devices).filter(d => d.checked).length;

  return (
    <div className="odin-container">
      <div className="devices-section">
        {Object.entries(devices).length === 0 ? (
          <>
            <div className="device-skeleton"></div>
            <div className="device-skeleton"></div>
            <div className="device-skeleton"></div>
            <div className="device-skeleton"></div>
          </>
        ) : (
          Object.entries(devices).map(([dev, data]) => (
            <div
              key={dev}
              className={`device-card ${data.status === "Flashing..." ? "flashing-state" : ""}`}
              onClick={() => setLogModal({ device: dev, log: data.log })}
            >
              <div className="dev-progress-bg" style={{ width: `${data.progress}%` }}></div>
              <div className="dev-content">
                <div className="dev-icon-area">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line>
                  </svg>
                </div>
                <div className="dev-info-area">
                  <div
                    className="custom-check-wrapper"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isFlashing) {
                        setDevices(prev => ({ ...prev, [dev]: { ...prev[dev], checked: !prev[dev].checked } }));
                      }
                    }}
                  >
                    <input type="checkbox" checked={data.checked} readOnly disabled={isFlashing} />
                    <div className="custom-checkbox">
                      <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"></path></svg>
                    </div>
                  </div>
                  <h3 className="dev-title">
                    Device:
                    <span className={
                      data.status === "Pass" ? "dev-status-success" :
                      data.status === "Fail" ? "dev-status-fail" :
                      data.status === "Flashing..." ? "dev-status-flashing" :
                      "dev-status-ready"
                    }>{data.status}</span>
                  </h3>
                  <p className="dev-path">
                    {data.port}
                    <span style={{ fontWeight: 600 }}>{data.progress}%</span>
                  </p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="firmware-section">
        <h2 className="section-title">FIRMWARE FILES</h2>
        <div className="firmware-card">
          <div className="file-list">
            {(["bl", "ap", "cp", "csc", "userdata"] as SlotKey[]).map(slot => {
              const vs = verifyState[slot];
              const hasFile = filePaths[slot] !== "";
              return (
                <div className="file-row" key={slot}>
                  <div className="file-label">
                    {slot === "csc" ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                    ) : slot === "userdata" ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>
                    )}
                    <span>{SLOT_LABELS[slot]}</span>
                  </div>
                  <div className={`file-input-wrapper ${isFlashing ? "flashing-disabled" : ""}`} onClick={() => selectFile(slot)}>
                    <input
                      type="text"
                      readOnly
                      placeholder="Click or drop file..."
                      value={vs.text || (hasFile ? filePaths[slot].split(/[/\\]/).pop() : "")}
                      className={vs.verifying ? "verifying" : ""}
                    />
                    <div className="file-progress" style={{ width: `${vs.progress}%`, opacity: vs.verifying ? 1 : 0 }}></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="action-section">
        <button className="btn-start-flash" onClick={startFlashInternal} disabled={isFlashing || checkedCount === 0}>
          <div className="btn-content">
            <svg className={`gear-icon ${!isFlashing ? "hidden" : ""}`} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            <span>{isFlashing ? "FLASHING..." : "START FLASHING"}</span>
          </div>
        </button>
        <button className="btn-icon" title="Refresh Devices" onClick={forceRefresh} disabled={isFlashing}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
        </button>
        <button className="btn-icon" style={{ marginLeft: "8px" }} title="Clear files" onClick={clearFiles} disabled={isFlashing}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </div>

      {logModal && (
        <div className="odin-modal">
          <div className="odin-modal-content">
            <div className="odin-modal-header">
              <h3>Device Log</h3>
              <button className="btn-ghost-icon" onClick={() => setLogModal(null)}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
            <div className="odin-modal-body">
              <div className="odin-device-log">{logModal.log}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default OdinFlash;
