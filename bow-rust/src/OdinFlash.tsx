import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ShieldAlert, RefreshCw, DatabaseZap, Trash2 } from "lucide-react";
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

export interface DeviceData {
  path: string;
  port: string;
  status: "Ready" | "Flashing..." | "Pass" | "Fail";
  progress: number;
  log: string;
  checked: boolean;
  busyByOther?: boolean;
  serial?: string;
  model?: string;
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

// Removed extractUsbPort as it is replaced by Rust resolve_usb_path

const SLOT_LABELS: Record<SlotKey, string> = {
  bl: "BL",
  ap: "AP",
  cp: "CP",
  csc: "CSC",
  userdata: "USERDATA",
};

// ── Component ──────────────────────────────────────────────────────────

export interface OdinFlashProps {
  allSerials?: string[];
  selectedSerials?: string[];
  setSelectedSerials?: React.Dispatch<React.SetStateAction<string[]>>;
  onDevicesUpdate?: (devices: Record<string, DeviceData>) => void;
  onVerifyProgress?: (progress: number) => void;
  onVerifyStateChange?: (verifying: boolean, progress: number) => void;
}

const OdinFlash = forwardRef<OdinFlashRef, OdinFlashProps>(({ allSerials, selectedSerials, setSelectedSerials, onDevicesUpdate, onVerifyProgress, onVerifyStateChange }, ref) => {
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
  const [busyDevices, setBusyDevices] = useState<string[]>([]);

  const devicesRef = useRef(devices);
  const isFlashingRef = useRef(isFlashing);
  const selectedSerialsRef = useRef(selectedSerials);
  const allSerialsRef = useRef(allSerials);
  const scanInFlightRef = useRef(false);
  devicesRef.current = devices;
  isFlashingRef.current = isFlashing;
  selectedSerialsRef.current = selectedSerials;
  allSerialsRef.current = allSerials;

  useImperativeHandle(ref, () => ({
    startFlash: async () => {
      return await startFlashInternal();
    },
    hasCheckedDevices: () => {
      return Object.values(devicesRef.current).some(d => d.checked);
    }
  }));

  // Sync devices update back to parent
  useEffect(() => {
    if (onDevicesUpdate) {
      onDevicesUpdate(devices);
    }
  }, [devices, onDevicesUpdate]);

  const overallVerifyProgress = useMemo(() => {
    const verifying = Object.values(verifyState).filter(s => s.verifying);
    if (verifying.length === 0) return 0;
    return verifying.reduce((acc, s) => acc + s.progress, 0) / verifying.length;
  }, [verifyState]);

  const overallFlashProgress = useMemo(() => {
    const flashing = Object.values(devices).filter(d => d.status === "Flashing...");
    if (flashing.length === 0) return 0;
    return flashing.reduce((acc, d) => acc + d.progress, 0) / flashing.length;
  }, [devices]);

  useEffect(() => {
    if (onVerifyProgress) onVerifyProgress(overallFlashProgress > 0 ? overallFlashProgress : overallVerifyProgress);
  }, [overallFlashProgress, overallVerifyProgress, onVerifyProgress]);

  const isVerifyingAnyFile = useMemo(() => {
    return Object.values(verifyState).some(s => s.verifying);
  }, [verifyState]);

  useEffect(() => {
    if (onVerifyStateChange) {
      onVerifyStateChange(isVerifyingAnyFile, overallVerifyProgress);
    }
  }, [isVerifyingAnyFile, overallVerifyProgress, onVerifyStateChange]);

  // ── Busy device polling (cross-instance) ──────────────────────────────

  useEffect(() => {
    const poll = async () => {
      try {
        const busy: string[] = await invoke("get_busy_devices");
        setBusyDevices(busy);
      } catch { }
    };
    poll();
    const interval = setInterval(poll, 4000);
    return () => clearInterval(interval);
  }, []);

  const resetBusy = async () => {
    try {
      await invoke("reset_busy_devices");
      const busy: string[] = await invoke("get_busy_devices");
      setBusyDevices(busy);
    } catch { }
  };

  const resetDeviceMetadata = async () => {
    try {
      await invoke("reset_device_cache");
      Object.keys(localStorage)
        .filter(key => key.startsWith("port_history_"))
        .forEach(key => localStorage.removeItem(key));
      setDevices({});
    } catch { }
  };

  // ── Odin device scanning ──────────────────────────────────────────────────────

  async function scanDevices() {
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;
    try {
      const list: string[] = await invoke("odin_list_devices");
      const resolvedPorts: Record<string, string> = await invoke("resolve_usb_paths", { devices: list });
      
      setDevices(prev => {
        const updated = { ...prev };

        // Clean up disconnected devices
        for (const key of Object.keys(updated)) {
          const isCurrentOdin = list.includes(key);
          const serial = updated[key].serial;
          const isCurrentAdb = serial ? allSerialsRef.current?.includes(serial) : false;

          if (!isCurrentOdin && !isCurrentAdb) {
            if (updated[key].status !== "Flashing...") {
              delete updated[key];
            }
          }
        }

        for (const dev of list) {
          if (!updated[dev]) {
            const port = resolvedPorts[dev];
            let serial = undefined;
            let model = undefined;
            try {
              const history = localStorage.getItem('port_history_' + port);
              if (history) {
                const parsed = JSON.parse(history);
                serial = parsed.serial;
                model = parsed.model;
              }
            } catch (e) {}

            updated[dev] = {
              path: dev,
              port: port,
              serial,
              model,
              status: "Ready",
              progress: 0,
              checked: false,
              log: `${getTimestamp()} Attached at ${dev}\n${getTimestamp()} Waiting for flash command...`,
            };
          }
        }
        return updated;
      });
    } catch (e) {
      console.error("Scan error:", e);
    } finally {
      scanInFlightRef.current = false;
    }
  }

  async function forceRefresh() {
    setDevices({});
    await scanDevices();
  }

  useEffect(() => {
    scanDevices();
    const interval = setInterval(scanDevices, 5000);
    return () => clearInterval(interval);
  }, []);

  // Run scanDevices immediately when connected ADB serials change to keep Odin list in sync
  useEffect(() => {
    scanDevices();
  }, [allSerials]);

  // Sync with App.tsx checked state
  useEffect(() => {
    if (selectedSerials) {
      setDevices(prev => {
        let changed = false;
        const next = { ...prev };
        let matchedBySerial = false;
        
        for (const [key, dev] of Object.entries(next)) {
          const shouldBeChecked = (dev.serial && selectedSerials.includes(dev.serial)) || selectedSerials.includes(key);
          if (dev.serial) {
            matchedBySerial = true;
          }
          if (dev.checked !== shouldBeChecked) {
            next[key] = { ...dev, checked: shouldBeChecked };
            changed = true;
          }
        }
        
        // Fallback for Windows where serial cannot be resolved from COM port
        if (!matchedBySerial && allSerials && allSerials.length > 0) {
          const odinKeys = Object.keys(next);
          for (let i = 0; i < odinKeys.length; i++) {
            const key = odinKeys[i];
            const adbSerialForThisIndex = allSerials[i];
            if (adbSerialForThisIndex) {
              const shouldBeChecked = selectedSerials.includes(adbSerialForThisIndex);
              if (next[key].checked !== shouldBeChecked) {
                next[key] = { ...next[key], checked: shouldBeChecked };
                changed = true;
              }
            }
          }
        }

        return changed ? next : prev;
      });
    }
  }, [selectedSerials, allSerials]);

  // ── Listen flash progress events (THROTTLED) ─────────────────────────

  const pendingUpdatesRef = useRef<Record<string, { progress: number, newLogLines: string[] }>>({});
  const updateIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!updateIntervalRef.current) {
      updateIntervalRef.current = setInterval(() => {
        if (Object.keys(pendingUpdatesRef.current).length > 0) {
          setDevices(prev => {
            let changed = false;
            const next = { ...prev };
            for (const dev in pendingUpdatesRef.current) {
              if (next[dev]) {
                const updates = pendingUpdatesRef.current[dev];
                next[dev] = { 
                  ...next[dev], 
                  progress: updates.progress !== -1 ? updates.progress : next[dev].progress,
                  log: updates.newLogLines.length > 0 ? `${next[dev].log}\n${updates.newLogLines.join('\n')}` : next[dev].log
                };
                changed = true;
              }
            }
            pendingUpdatesRef.current = {};
            return changed ? next : prev;
          });
        }
      }, 200); // Update UI 5 times a second
    }
    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current);
        updateIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    Object.keys(devices).forEach(dev => {
      listen<string>(`flash-progress-${dev}`, (event) => {
        const msg = event.payload;
        const pctMatch = msg.match(/\((\d+)%\)/g);

        if (!pendingUpdatesRef.current[dev]) {
          pendingUpdatesRef.current[dev] = { progress: -1, newLogLines: [] };
        }

        let clean = msg;
        if (pctMatch) {
          const lastPct = parseInt(pctMatch[pctMatch.length - 1].replace(/\D/g, ""), 10);
          pendingUpdatesRef.current[dev].progress = lastPct;
          clean = msg.replace(/\(\d+%\)/g, "").trim();
        }

        if (clean) {
          pendingUpdatesRef.current[dev].newLogLines.push(`${getTimestamp()} ${clean}`);
        }
      }).then(fn => unlisteners.push(fn));
    });

    return () => unlisteners.forEach(fn => fn());
  }, [Object.keys(devices).join(",")]);
  // Listen to IPC shared progress from other instances
  useEffect(() => {
    const unlisten = listen<{ device: string; line: string }>("flash-progress-ipc", (event) => {
      const { device, line } = event.payload;

      setDevices(prev => {
        if (!prev[device]) return prev;

        const currentDev = prev[device];
        let nextStatus = currentDev.status;
        let nextProgress = currentDev.progress;
        let nextLog = currentDev.log;

        if (line.startsWith("STATUS:Pass:")) {
          const result = line.replace("STATUS:Pass:", "");
          nextStatus = "Pass";
          nextProgress = 100;
          nextLog = `${nextLog}\n${getTimestamp()} ${result}`;
        } else if (line.startsWith("STATUS:Fail:")) {
          const err = line.replace("STATUS:Fail:", "");
          nextStatus = "Fail";
          nextLog = `${nextLog}\n${getTimestamp()} ERROR: ${err}`;
        } else {
          if (nextStatus !== "Flashing...") {
            nextStatus = "Flashing...";
          }
          const pctMatch = line.match(/\((\d+)%\)/g);
          let clean = line;
          if (pctMatch) {
            const lastPct = parseInt(pctMatch[pctMatch.length - 1].replace(/\D/g, ""), 10);
            nextProgress = lastPct;
            clean = line.replace(/\(\d+%\)/g, "").trim();
          }
          if (clean) {
            nextLog = `${nextLog}\n${getTimestamp()} ${clean}`;
          }
        }

        return {
          ...prev,
          [device]: {
            ...currentDev,
            status: nextStatus,
            progress: nextProgress,
            log: nextLog,
          }
        };
      });
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);
  // ── File selection & verification ────────────────────────────────────

  async function selectFile(slot: SlotKey) {
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
    const fname = (path.split(/[/\\]/).pop() || "").toUpperCase();
    
    // Validasi awalan nama file sesuai slot
    if (slot === "bl" && !fname.startsWith("BL_")) {
      alert(`File salah! Slot BL hanya menerima file dengan awalan "BL_"\nFile Anda: ${fname}`);
      return;
    }
    if (slot === "ap" && !fname.startsWith("AP_") && !fname.startsWith("ALL_")) {
      alert(`File salah! Slot AP hanya menerima file dengan awalan "AP_"\nFile Anda: ${fname}`);
      return;
    }
    if (slot === "cp" && !fname.startsWith("CP_")) {
      alert(`File salah! Slot CP hanya menerima file dengan awalan "CP_"\nFile Anda: ${fname}`);
      return;
    }
    if (slot === "csc" && !fname.startsWith("CSC_") && !fname.startsWith("HOME_CSC_")) {
      alert(`File salah! Slot CSC hanya menerima file dengan awalan "CSC_" atau "HOME_CSC_"\nFile Anda: ${fname}`);
      return;
    }
    if (slot === "userdata" && !fname.startsWith("USERDATA_")) {
      alert(`File salah! Slot USERDATA hanya menerima file dengan awalan "USERDATA_"\nFile Anda: ${fname}`);
      return;
    }

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
    verifyFile(slot, path);
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

  function clearFile(slot: SlotKey) {
    setFilePaths(prev => ({ ...prev, [slot]: "" }));
    setVerifyState(prev => ({ ...prev, [slot]: { text: "", progress: 0, verifying: false } }));
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
    const checked = Object.entries(devicesRef.current).filter(([, d]) => d.checked && d.status !== "Flashing...");
    if (checked.length === 0) return false;

    if (!filePaths.bl && !filePaths.ap && !filePaths.cp && !filePaths.csc && !filePaths.userdata) {
      alert("Tidak ada file firmware yang dipilih di tab Odin Flash! Silakan pilih file tar.md5 terlebih dahulu.");
      return false;
    }

    setIsFlashing(true);

    // Tandai device sebagai busy untuk instance FlashKit lain
    const checkedSerials = checked.flatMap(([dev, data]) => data.serial ? [dev, data.serial] : [dev]);
    try { await invoke("mark_busy", { serials: checkedSerials }); } catch { }

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

    // Hapus busy flag setelah selesai
    try { await invoke("clear_busy", { serials: checkedSerials }); } catch { }

    setIsFlashing(false);
    return !anyFail && anyPass;
  }

  // ── UI (Original Odin-Clone Style) ────────────────────────────────────

  const readyToFlashCount = Object.values(devices).filter(d => d.checked && d.status !== "Flashing...").length;
  const anyFlashing = Object.values(devices).some(d => d.status === "Flashing...");
  const visibleDevices = Object.entries(devices).filter(([, d]) => d.status !== "Pass");

  return (
    <div className="odin-container">
      <div className="devices-section">
        {visibleDevices.length === 0 ? (
          <div className="device-skeleton">
            No devices currently in Odin state
          </div>
        ) : (
          visibleDevices.map(([dev, data]) => (
              <div key={dev} className={`device-card ${data.status === "Flashing..." ? "flashing-state" : ""}`}
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
                      if (data.status !== "Flashing..." && !(busyDevices.includes(dev) && data.status === "Ready")) {
                        const newChecked = !data.checked;
                        setDevices(prev => ({ ...prev, [dev]: { ...prev[dev], checked: newChecked } }));
                        
                        // Sync back to App.tsx
                        if (setSelectedSerials) {
                          const idToSync = data.serial || dev;
                          setSelectedSerials(prev => {
                            if (newChecked) {
                              return prev.includes(idToSync) ? prev : [...prev, idToSync];
                            } else {
                              return prev.filter(s => s !== idToSync);
                            }
                          });
                        }
                      }
                    }}
                  >
                    <input type="checkbox" checked={data.checked} readOnly disabled={data.status === "Flashing..." || (busyDevices.includes(dev) && data.status === "Ready")} />
                    <div className="custom-checkbox">
                      <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"></path></svg>
                    </div>
                  </div>
                  <h3 className="dev-title">
                    <span>{data.model || "Device"}{busyDevices.includes(dev) && <span style={{ marginLeft: 6, background: '#dc2626', color: 'white', fontSize: '10px', fontWeight: 900, letterSpacing: '0.15em', padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', boxShadow: '0 0 10px rgba(220,38,38,0.5)' }}>BUSY</span>}</span>
                    <span className={
                      data.status === "Pass" ? "dev-status-success" :
                      data.status === "Fail" ? "dev-status-fail" :
                      data.status === "Flashing..." ? "dev-status-flashing" :
                      "dev-status-ready"
                    }>{data.status}</span>
                  </h3>
                  <p className="dev-path">
                    {data.port} {data.serial ? `(${data.serial})` : ''}
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
                  <div className="file-input-wrapper" onClick={() => selectFile(slot)}>
                    <input
                      type="text"
                      readOnly
                      placeholder="Click or drop file..."
                      value={vs.text || (hasFile ? filePaths[slot].split(/[/\\]/).pop() : "")}
                      className={vs.verifying ? "verifying" : ""}
                    />
                    <button
                      type="button"
                      className="file-clear-button"
                      title={`Clear ${SLOT_LABELS[slot]}`}
                      disabled={vs.verifying || (!hasFile && !vs.text)}
                      onClick={(e) => {
                        e.stopPropagation();
                        clearFile(slot);
                      }}
                    >
                      <Trash2 width={16} height={16} />
                    </button>
                    <div className="file-progress" style={{ width: `${vs.progress}%`, opacity: vs.verifying ? 1 : 0 }}></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="action-section">
        <button className="btn-start-flash" onClick={startFlashInternal} disabled={readyToFlashCount === 0}>
          <div className="btn-content">
            <svg className={`gear-icon ${!anyFlashing ? "hidden" : ""}`} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            <span>{readyToFlashCount > 0 ? "START FLASHING" : anyFlashing ? "FLASHING..." : "START FLASHING"}</span>
          </div>
        </button>
        <button className="btn-icon" title="Refresh Devices" onClick={forceRefresh}>
          <RefreshCw width={20} height={20} />
        </button>
        <button className="btn-icon" style={{ color: "#ff453a" }} title="Reset Busy Status" onClick={resetBusy}>
          <ShieldAlert width={20} height={20} />
        </button>
        <button className="btn-icon btn-icon-warning" title="Reset Stored Device Metadata" onClick={resetDeviceMetadata}>
          <DatabaseZap width={20} height={20} />
        </button>
        <button className="btn-icon" title="Clear files" onClick={clearFiles}>
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
