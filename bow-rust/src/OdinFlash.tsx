import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useMemo } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ShieldAlert, RefreshCw, DatabaseZap, Trash2 } from "lucide-react";
import "./OdinFlash.css";

// ── Types ──────────────────────────────────────────────────────────────

type SlotKey = "bl" | "ap" | "cp" | "csc" | "userdata";

export interface FilePaths {
  bl: string;
  ap: string;
  cp: string;
  csc: string;
  userdata: string;
}

export type SharedFirmwareFiles = FilePaths;

interface ServerFileEntry {
  path: string;
  name: string;
  is_dir: boolean;
}

interface WebProgressResponse {
  seq: number;
  events: { seq: number; device: string; line: string }[];
}

export interface SharedUiState {
  firmware_files: FilePaths;
  selected_devices: string[];
  odin_devices?: Record<string, DeviceData>;
  updated_at_ms: number;
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
  refreshDevices: () => Promise<void>;
  resetAllStatuses: () => void;
  cancelFlashing?: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────

function getTimestamp() {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
}

function sameDeviceMap(a: Record<string, DeviceData>, b: Record<string, DeviceData>) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => {
    const left = a[key];
    const right = b[key];
    return Boolean(right) &&
      left.path === right.path &&
      left.port === right.port &&
      left.status === right.status &&
      left.progress === right.progress &&
      left.checked === right.checked &&
      left.busyByOther === right.busyByOther &&
      left.serial === right.serial &&
      left.model === right.model &&
      left.log === right.log;
  });
}

function isTauriRuntime() {
  return Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
}

function desktopBridgeUrl() {
  return "/bridge";
}

async function bridgeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${desktopBridgeUrl()}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args: args || {} }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || `Bridge command failed: ${command}`);
  return payload.value as T;
}

// Removed extractUsbPort as it is replaced by Rust resolve_usb_path

const SLOT_LABELS: Record<SlotKey, string> = {
  bl: "BL",
  ap: "AP",
  cp: "CP",
  csc: "CSC",
  userdata: "USERDATA",
};

function normalizeModelName(rawModel?: string): string {
  if (!rawModel) return "Unknown Model";
  let cleaned = rawModel.trim().replace(/_/g, "-").toUpperCase();
  if (cleaned.startsWith("SM") && !cleaned.startsWith("SM-")) {
    cleaned = cleaned.replace(/^SM/, "SM-");
  }
  return cleaned || "Unknown Model";
}

// ponytail: parse SM-XXXX model from AP_/ALL_ firmware filename
function isFirmwareForModel(firmwareFilename: string, deviceModel: string): boolean {
  if (!firmwareFilename || !deviceModel) return false;
  const upper = firmwareFilename.toUpperCase();
  const normalized = normalizeModelName(deviceModel);
  const raw = normalized.replace(/^SM-/, "");
  if (!raw || raw === "UNKNOWN MODEL") return false;
  return upper.includes(raw);
}

// ── Component ──────────────────────────────────────────────────────────

export interface OdinFlashProps {
  allSerials?: string[];
  selectedSerials?: string[];
  setSelectedSerials?: React.Dispatch<React.SetStateAction<string[]>>;
  odinDevices?: Record<string, DeviceData>;
  deviceDetails?: Record<string, any>;
  onDevicesUpdate?: (devices: Record<string, DeviceData>) => void;
  onVerifyProgress?: (progress: number) => void;
  onVerifyStateChange?: (verifying: boolean, progress: number) => void;
  onOdinFlashProgress?: (flashing: boolean, progress: number) => void;
  onApFileChange?: (filename: string) => void;
  isLeader: boolean;
}

const OdinFlash = forwardRef<OdinFlashRef, OdinFlashProps>(({ allSerials, selectedSerials, setSelectedSerials, deviceDetails, onDevicesUpdate, onVerifyProgress, onVerifyStateChange, onOdinFlashProgress, onApFileChange }, ref) => {
  const desktopActive = isTauriRuntime();
  const invoke = <T,>(command: string, args?: Record<string, unknown>) =>
    desktopActive ? tauriInvoke<T>(command, args) : bridgeInvoke<T>(command, args);
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
  const [filePicker, setFilePicker] = useState<{ slot: SlotKey; path: string; entries: ServerFileEntry[]; loading: boolean } | null>(null);
  const [busyDevices, setBusyDevices] = useState<string[]>([]);

  const devicesRef = useRef(devices);
  const deviceDetailsRef = useRef(deviceDetails);
  const isFlashingRef = useRef(isFlashing);
  const selectedSerialsRef = useRef(selectedSerials);
  const allSerialsRef = useRef(allSerials);
  const scanInFlightRef = useRef(false);
  const latestVerifyIdRef = useRef<Record<SlotKey, number>>({ bl: 0, ap: 0, cp: 0, csc: 0, userdata: 0 });
  const webProgressSeqRef = useRef(0);
  const filePathsRef = useRef(filePaths);

  useEffect(() => {
    isFlashingRef.current = isFlashing;
    selectedSerialsRef.current = selectedSerials;
    allSerialsRef.current = allSerials;
    deviceDetailsRef.current = deviceDetails;
  }, [isFlashing, selectedSerials, allSerials, deviceDetails]);

  // ponytail: Firmware file selection is kept local to each instance/window



  const apFilename = useMemo(() => {
    if (filePaths.ap) return filePaths.ap.split(/[/\\]/).pop() || "";
    if (verifyState.ap.verifying || verifyState.ap.text) return verifyState.ap.text;
    return "";
  }, [filePaths.ap, verifyState.ap]);

  useEffect(() => {
    if (onApFileChange) {
      onApFileChange(apFilename);
    }
  }, [apFilename, onApFileChange]);

  // ponytail: Auto-select devices matching firmware model directly
  // ponytail: Auto-select removed per user preference.
  // Matching firmware devices are highlighted with Amber outline (unchecked) or Blinking White outline (checked).

  // ponytail: Reset any stale "Fail" status back to "Ready" whenever AP/ALL firmware is loaded or changed
  useEffect(() => {
    if (!filePaths.ap) return;
    setDevices(prev => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[key].status === "Fail" && !isFlashingRef.current) {
          next[key] = { ...next[key], status: "Ready", progress: 0 };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filePaths.ap]);

  // ponytail: OdinFlash relies on App.tsx parent for global UI state polling to avoid duplicate ping-pong disk reads.





  const cancelAllFlashing = () => {
    scanInFlightRef.current = false;
    pendingUpdatesRef.current = {};
    setDevices(prev => {
      const updated = { ...prev };
      for (const dev of Object.keys(updated)) {
        if (updated[dev].status === "Flashing...") {
          updated[dev] = { ...updated[dev], status: "Fail", progress: 0 };
        }
      }
      return updated;
    });
  };

  useImperativeHandle(ref, () => ({
    startFlash: async () => {
      return await startFlashInternal();
    },
    hasCheckedDevices: () => {
      const sel = selectedSerialsRef.current || [];
      if (sel.length > 0) return true;
      return Object.values(devicesRef.current).some(d => d.checked);
    },
    refreshDevices: async () => {
      await forceRefresh();
    },
    resetAllStatuses: () => {
      setDevices(prev => {
        const updated = { ...prev };
        for (const k of Object.keys(updated)) {
          if (updated[k].status === "Pass" || updated[k].status === "Fail") {
            updated[k] = { ...updated[k], status: "Ready", progress: 0 };
          }
        }
        devicesRef.current = updated;
        return updated;
      });
      try { invoke("save_shared_ui_state", { odin_devices: {} }); } catch { }
    },
    cancelFlashing: cancelAllFlashing,
  }));

  // Sync devices update back to parent
  useEffect(() => {
    if (onDevicesUpdate) {
      onDevicesUpdate(devices);
    }
  }, [devices, onDevicesUpdate]);

  const overallVerifyProgress = useMemo(() => {
    const slots = (["bl", "ap", "cp", "csc", "userdata"] as SlotKey[]).filter(
      s => verifyState[s].verifying || filePaths[s]
    );
    if (slots.length === 0) return 0;
    const total = slots.reduce((acc, s) => {
      if (verifyState[s].verifying) return acc + verifyState[s].progress;
      if (filePaths[s]) return acc + 100;
      return acc;
    }, 0);
    return Math.round(total / slots.length);
  }, [verifyState, filePaths]);

  const overallFlashProgress = useMemo(() => {
    const activeOrFinished = Object.values(devices).filter(d => d.status === "Flashing..." || d.status === "Pass" || d.status === "Fail");
    if (activeOrFinished.length === 0) return 0;
    const total = activeOrFinished.reduce((acc, d) => acc + (d.status === "Pass" ? 100 : d.progress), 0);
    return Math.round(total / activeOrFinished.length);
  }, [devices]);

  const isVerifyingAnyFile = useMemo(() => {
    return Object.values(verifyState).some(s => s.verifying);
  }, [verifyState]);

  useEffect(() => {
    if (onOdinFlashProgress) {
      onOdinFlashProgress(isFlashing, isFlashing ? overallFlashProgress : 0);
    }
  }, [isFlashing, overallFlashProgress, onOdinFlashProgress]);



  useEffect(() => {
    if (onVerifyProgress) {
      onVerifyProgress(isVerifyingAnyFile ? overallVerifyProgress : 0);
    }
  }, [isVerifyingAnyFile, overallVerifyProgress, onVerifyProgress]);

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
    let unlistenBusy: (() => void) | undefined;
    if (desktopActive) {
      listen<string[]>("busy-state-updated", (event) => setBusyDevices(event.payload)).then(fn => { unlistenBusy = fn; });
    }
    return () => {
      clearInterval(interval);
      unlistenBusy?.();
    };
  }, [desktopActive]);

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
      await invoke("reset_busy_devices").catch(() => {});
      setDevices({});
      if (onDevicesUpdate) onDevicesUpdate({});
    } catch { }
  };

  async function scanDevices(force = false): Promise<Record<string, DeviceData>> {
    if (scanInFlightRef.current && !force) return devicesRef.current;
    scanInFlightRef.current = true;
    try {
      const list: string[] = await invoke("odin_list_devices");
      const resolvedPorts: Record<string, string> = await invoke("resolve_usb_paths", { devices: list });
      
      const prev = devicesRef.current;
      const updated = { ...prev };

      // Clean up or reset devices that finished flashing and returned to ADB or disconnected
      for (const key of Object.keys(updated)) {
        const isCurrentOdin = list.includes(key);
        const serial = updated[key].serial;
        const isCurrentAdb = serial ? allSerialsRef.current?.includes(serial) : false;

        if (isCurrentAdb && (updated[key].status === "Pass" || updated[key].status === "Fail")) {
          // Device booted back up into ADB mode: reset status to Ready!
          updated[key] = { ...updated[key], status: "Ready", progress: 0 };
        } else if (!isCurrentOdin && !isCurrentAdb && !isFlashingRef.current && updated[key].status !== "Ready") {
          delete updated[key];
        }
      }

      for (const dev of list) {
        const port = resolvedPorts[dev];

        let preservedSerial: string | undefined = undefined;
        let preservedModel: string | undefined = undefined;

        for (const [oldKey, oldData] of Object.entries(updated)) {
          if (oldKey !== dev && oldData.port === port && !list.includes(oldKey)) {
            if (oldData.serial) preservedSerial = oldData.serial;
            if (oldData.model) preservedModel = oldData.model;
            delete updated[oldKey];
          }
        }

        if (!updated[dev]) {
          let serial = preservedSerial;
          let model = preservedModel;

          if (!serial || !model) {
            for (const oldData of Object.values(prev)) {
              if (oldData.port === port || oldData.path === dev) {
                if (!serial && oldData.serial) serial = oldData.serial;
                if (!model && oldData.model) model = oldData.model;
              }
            }
          }

          if ((!serial || !model) && deviceDetailsRef.current) {
            const cached = Object.values(deviceDetailsRef.current).find((d: any) =>
              (port && d.usb_port === port) || (dev && d.usb_port === dev) || (serial && d.serial === serial)
            );
            if (cached) {
              if (!model) model = cached.model || cached._model || cached['ro.product.model'];
              if (!serial) serial = cached.serial;
            }
          }

          // Fix: Fallback to port_history localStorage for model/serial recovery after download mode reboot
          if (!serial || !model) {
            try {
              const history = localStorage.getItem('port_history_' + port);
              if (history) {
                const parsed = JSON.parse(history);
                if (!serial && parsed.serial) serial = parsed.serial;
                if (!model && parsed.model) model = parsed.model;
              }
            } catch {}
          }

          const isSelected = Boolean(
            (serial && selectedSerialsRef.current?.includes(serial)) ||
            selectedSerialsRef.current?.includes(dev) ||
            (port && selectedSerialsRef.current?.includes(port))
          );
          updated[dev] = {
            path: dev,
            port: port,
            serial,
            model,
            status: "Ready",
            progress: 0,
            checked: isSelected,
            log: `${getTimestamp()} Attached at ${dev}\n${getTimestamp()} Waiting for flash command...`,
          };
        } else {
          if (!updated[dev].serial && preservedSerial) updated[dev].serial = preservedSerial;
          if (!updated[dev].model && preservedModel) updated[dev].model = preservedModel;
          if (updated[dev].status === "Fail") {
            updated[dev] = {
              ...updated[dev],
              status: "Ready",
              progress: 0,
            };
          }
        }
      }

      devicesRef.current = updated;
      setDevices(prev => sameDeviceMap(prev, updated) ? prev : updated);
      return updated;
    } catch (e) {
      console.error("Scan error:", e);
      return devicesRef.current;
    } finally {
      scanInFlightRef.current = false;
    }
  }

  async function forceRefresh() {
    setDevices(prev => {
      const updated = { ...prev };
      for (const key of Object.keys(updated)) {
        if (updated[key].status === "Pass" || updated[key].status === "Fail") {
          updated[key] = {
            ...updated[key],
            status: "Ready",
            progress: 0,
          };
        }
      }
      devicesRef.current = updated;
      try { invoke("save_shared_ui_state", { odin_devices: {} }); } catch { }
      return updated;
    });
    return await scanDevices(true);
  }

  useEffect(() => {
    scanDevices();
    const interval = setInterval(() => {
      if (!isFlashingRef.current) {
        scanDevices();
      }
    }, 2000);
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
          const shouldBeChecked = Boolean(
            (dev.serial && selectedSerials.includes(dev.serial)) ||
            selectedSerials.includes(key) ||
            (dev.port && selectedSerials.includes(dev.port))
          );
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
            const dev = next[key];
            const adbSerialForThisIndex = allSerials[i];
            const shouldBeChecked = Boolean(
              selectedSerials.includes(key) ||
              (dev.port && selectedSerials.includes(dev.port)) ||
              (adbSerialForThisIndex && selectedSerials.includes(adbSerialForThisIndex))
            );
            if (dev.checked !== shouldBeChecked) {
              next[key] = { ...dev, checked: shouldBeChecked };
              changed = true;
            }
          }
        }

        return changed ? next : prev;
      });
    }
  }, [selectedSerials, allSerials]);

  // ── Listen flash progress events (THROTTLED) ─────────────────────────

  const pendingUpdatesRef = useRef<Record<string, { progress: number, newLogLines: string[], status?: DeviceData["status"] }>>({});
  const updateIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!updateIntervalRef.current) {
      updateIntervalRef.current = window.setInterval(() => {
        if (Object.keys(pendingUpdatesRef.current).length > 0) {
          setDevices(prev => {
            let changed = false;
            const next = { ...prev };
            const toDelete: string[] = [];

            for (const dev in pendingUpdatesRef.current) {
              if (next[dev]) {
                const updates = pendingUpdatesRef.current[dev];
                let finalStatus = updates.status || next[dev].status;
                if (updates.progress >= 100 || updates.status === "Pass") {
                  finalStatus = "Pass";
                } else if (isFlashingRef.current && (next[dev].status === "Pass" || next[dev].status === "Fail") && updates.status === "Flashing...") {
                  finalStatus = next[dev].status;
                }
                const isPass = finalStatus === "Pass";
                const curPct = next[dev].progress || 0;
                const incomingPct = isPass ? 100 : (updates.progress !== -1 ? updates.progress : curPct);
                const nextPct = Math.max(curPct, incomingPct);

                next[dev] = { 
                  ...next[dev], 
                  status: finalStatus,
                  progress: nextPct,
                  log: updates.newLogLines.length > 0 ? `${next[dev].log}\n${updates.newLogLines.join('\n')}` : next[dev].log
                };
                toDelete.push(dev);
                changed = true;
              } else {
                toDelete.push(dev);
              }
            }

            for (const dev of toDelete) {
              delete pendingUpdatesRef.current[dev];
            }

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
    if (!desktopActive) return;
    const unlisteners: (() => void)[] = [];

    Object.keys(devices).forEach(dev => {
      listen<string>(`flash-progress-${dev}`, (event) => {
        const msg = event.payload;
        const pctMatch = msg.match(/\((\d+)%\)/g);

        if (!pendingUpdatesRef.current[dev]) {
          pendingUpdatesRef.current[dev] = { progress: -1, newLogLines: [] };
        }

        let clean = msg;
        if (msg.startsWith("STATUS:Pass:")) {
          pendingUpdatesRef.current[dev].status = "Pass";
          pendingUpdatesRef.current[dev].progress = 100;
          clean = msg.replace("STATUS:Pass:", "");
        } else if (msg.startsWith("STATUS:Fail:")) {
          pendingUpdatesRef.current[dev].status = "Fail";
          clean = `ERROR: ${msg.replace("STATUS:Fail:", "")}`;
        } else {
          const currentStatus = pendingUpdatesRef.current[dev].status || devicesRef.current[dev]?.status;
          if (currentStatus !== "Pass" && currentStatus !== "Fail") {
            pendingUpdatesRef.current[dev].status = "Flashing...";
          }
        }

        if (pctMatch) {
          const currentStatus = pendingUpdatesRef.current[dev].status || devicesRef.current[dev]?.status;
          if (currentStatus !== "Pass" && currentStatus !== "Fail") {
            const lastPct = parseInt(pctMatch[pctMatch.length - 1].replace(/\D/g, ""), 10);
            pendingUpdatesRef.current[dev].progress = lastPct;
          }
          clean = msg.replace(/\(\d+%\)/g, "").trim();
        }

        if (clean) {
          pendingUpdatesRef.current[dev].newLogLines.push(`${getTimestamp()} ${clean}`);
        }
      }).then(fn => unlisteners.push(fn));
    });

    return () => unlisteners.forEach(fn => fn());
  }, [desktopActive, Object.keys(devices).join(",")]);
  // Listen to IPC shared progress from other instances
  useEffect(() => {
    if (!desktopActive) return;
    const unlisten = listen<{ device: string; line: string }>("flash-progress-ipc", (event) => {
      // Only process flash-progress-ipc if THIS instance is actively flashing
      if (!isFlashingRef.current) return;
      const { device, line } = event.payload;

      if (device.startsWith("md5-")) {
        return;
      }

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
          if (nextStatus !== "Pass" && nextStatus !== "Fail" && nextStatus !== "Flashing...") {
            nextStatus = "Flashing...";
          }
          const pctMatch = line.match(/\((\d+)%\)/g);
          let clean = line;
          if (pctMatch) {
            if (nextStatus !== "Pass" && nextStatus !== "Fail") {
              const lastPct = parseInt(pctMatch[pctMatch.length - 1].replace(/\D/g, ""), 10);
              nextProgress = lastPct;
            }
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
  }, [desktopActive]);

  useEffect(() => {
    if (desktopActive || !isFlashing) return;
    const poll = async () => {
      try {
        const response = await fetch(`${desktopBridgeUrl()}/progress?since=${webProgressSeqRef.current}`, { cache: "no-store" });
        const payload: WebProgressResponse = await response.json();
        webProgressSeqRef.current = payload.seq;
        if (payload.events.length === 0) return;

        setDevices(prev => {
          let changed = false;
          const next = { ...prev };
          for (const event of payload.events) {
            const current = next[event.device];
            if (!current || current.status !== "Flashing...") continue;

            let status: DeviceData["status"] = current.status;
            let progress = current.progress;
            let line = event.line;
            if (line.startsWith("STATUS:Pass:")) {
              status = "Pass";
              progress = 100;
              line = line.replace("STATUS:Pass:", "");
            } else if (line.startsWith("STATUS:Fail:")) {
              status = "Fail";
              line = `ERROR: ${line.replace("STATUS:Fail:", "")}`;
            } else {
              const pctMatch = line.match(/\((\d+)%\)/g);
              if (pctMatch) {
                progress = parseInt(pctMatch[pctMatch.length - 1].replace(/\D/g, ""), 10);
                line = line.replace(/\(\d+%\)/g, "").trim();
              }
            }
            next[event.device] = {
              ...current,
              status,
              progress,
              log: line ? `${current.log}\n${getTimestamp()} ${line}` : current.log,
            };
            changed = true;
          }
          return changed ? next : prev;
        });
      } catch { }
    };
    poll();
    const interval = window.setInterval(poll, 1000);
    return () => window.clearInterval(interval);
  }, [desktopActive, isFlashing]);
  // ── File selection & verification ────────────────────────────────────

  async function openServerFilePicker(slot: SlotKey, path = "") {
    setFilePicker({ slot, path, entries: [], loading: true });
    try {
      const entries = await invoke<ServerFileEntry[]>("list_server_files", path ? { path } : {});
      const actualPath = entries.length > 0 ? entries[0].path.split(/[/\\]/).slice(0, -1).join("/") || "/" : path;
      setFilePicker({ slot, path: actualPath, entries, loading: false });
    } catch (e) {
      alert(`Gagal baca folder server:\n${e}`);
      setFilePicker(null);
    }
  }

  function parentServerPath(path: string) {
    if (!path || path === "/") return "/";
    const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    return parent;
  }

  async function selectFile(slot: SlotKey) {
    if (isFlashingRef.current) return;
    try {
      if (!desktopActive) {
        await openServerFilePicker(slot);
        return;
      }
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
    if (!path || isFlashingRef.current) return;
    const verifyId = Date.now() + Math.random();
    latestVerifyIdRef.current[slot] = verifyId;
    const fname = (path.split(/[/\\]/).pop() || "").toUpperCase();

    // Validasi awalan nama file sesuai slot
    if (slot === "bl" && !fname.startsWith("BL_")) {
      alert(`File salah! Slot BL hanya menerima file dengan awalan "BL_"\nFile Anda: ${fname}`);
      return;
    }
    if (slot === "ap" && !fname.startsWith("AP_") && !fname.startsWith("ALL_")) {
      alert(`File salah! Slot AP hanya menerima file dengan awalan "AP_" atau "ALL_"\nFile Anda: ${fname}`);
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

    const name = path.split(/[/\\]/).pop() || path;
    setFilePaths(prev => ({ ...prev, [slot]: "" }));
    setVerifyState(prev => ({
      ...prev,
      [slot]: { text: `Verifying MD5... 0% (${name})`, progress: 0, verifying: true },
    }));

    let webProgressTimer: number | undefined;
    const unlisten = desktopActive
      ? await listen<string>(`md5-progress-${slot}`, (event) => {
          if (latestVerifyIdRef.current[slot] !== verifyId) return;
          const msg = event.payload;
          const pctMatch = msg.match(/\((\d+)%\)/g);
          if (pctMatch) {
            const pct = parseInt(pctMatch[pctMatch.length - 1].replace(/\D/g, ""), 10);
            setVerifyState(prev => {
              const curPct = prev[slot]?.progress || 0;
              const nextPct = Math.max(curPct, pct);
              return {
                ...prev,
                [slot]: { ...prev[slot], text: `Verifying MD5... ${nextPct}%`, progress: nextPct },
              };
            });
          }
        })
      : () => {};

    try {
      await invoke<string>("odin_check_file", { path, slot });
      if (latestVerifyIdRef.current[slot] !== verifyId) return;
      setFilePaths(prev => {
        const nextFiles = { ...prev, [slot]: path };
        filePathsRef.current = nextFiles;
        return nextFiles;
      });
      setVerifyState(prev => ({
        ...prev,
        [slot]: { text: name, progress: 100, verifying: false },
      }));
    } catch (err) {
      if (latestVerifyIdRef.current[slot] !== verifyId) return;
      setFilePaths(prev => ({ ...prev, [slot]: "" }));
      setVerifyState(prev => ({
        ...prev,
        [slot]: { text: "ERROR: Invalid MD5!", progress: 0, verifying: false },
      }));
      alert(`File Verification Failed for ${slot.toUpperCase()}:\n${err}`);
    } finally {
      if (webProgressTimer) window.clearInterval(webProgressTimer);
      unlisten();
    }
  }

  function handleDrop(slot: SlotKey, path: string) {
    if (isFlashingRef.current) return;
    verifyFile(slot, path);
  }

  function clearFiles() {
    if (isFlashingRef.current) return;
    latestVerifyIdRef.current = { bl: 0, ap: 0, cp: 0, csc: 0, userdata: 0 };
    const empty = { bl: "", ap: "", cp: "", csc: "", userdata: "" };
    setFilePaths(empty);
    filePathsRef.current = empty;
    if (onApFileChange) onApFileChange("");
    setVerifyState({
      bl: { text: "", progress: 0, verifying: false },
      ap: { text: "", progress: 0, verifying: false },
      cp: { text: "", progress: 0, verifying: false },
      csc: { text: "", progress: 0, verifying: false },
      userdata: { text: "", progress: 0, verifying: false },
    });
  }

  function clearFile(slot: SlotKey) {
    if (isFlashingRef.current) return;
    latestVerifyIdRef.current[slot] = Date.now() + Math.random();
    if (slot === "ap" && onApFileChange) onApFileChange("");
    setFilePaths(prev => {
      const nextFiles = { ...prev, [slot]: "" };
      filePathsRef.current = nextFiles;
      return nextFiles;
    });
    setVerifyState(prev => ({ ...prev, [slot]: { text: "", progress: 0, verifying: false } }));
  }

  // ── Drag-drop for firmware files ─────────────────────────────────────

  useEffect(() => {
    if (!desktopActive) return;
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
  }, [desktopActive, filePaths]);

  // ── Flash ─────────────────────────────────────────────────────────────

  async function startFlashInternal(): Promise<boolean> {
    await forceRefresh();
    const sel = selectedSerialsRef.current || [];
    const checkedMap = new Map<string, DeviceData>();
    for (const [dev, d] of Object.entries(devicesRef.current)) {
      const isMatch = d.checked || 
        sel.includes(dev) || 
        (d.port && sel.includes(d.port)) || 
        (d.serial && sel.includes(d.serial));
      if (isMatch && d.status !== "Flashing...") {
        checkedMap.set(dev, d);
      }
    }
    if (checkedMap.size === 0 && Object.keys(devicesRef.current).length > 0 && sel.length > 0) {
      for (const [dev, d] of Object.entries(devicesRef.current)) {
        if (d.status !== "Flashing...") {
          checkedMap.set(dev, d);
        }
      }
    }

    const checked = Array.from(checkedMap.entries());
    if (checked.length === 0) return false;

    try {
      const activeOdinList: string[] = await invoke("odin_list_devices");
      if (activeOdinList.length > 0) {
        const notInOdin = checked.filter(([dev, d]) => !activeOdinList.includes(dev) && !activeOdinList.includes(d.path));
        if (notInOdin.length === checked.length) {
          console.error("Perhatian: Perangkat yang dipilih belum berada dalam Odin Mode (Download Mode)!\nHarap masukkan perangkat ke Download Mode terlebih dahulu.");
          return false;
        }
      }
    } catch { }

    const files = filePathsRef.current;
    if (!files.bl && !files.ap && !files.cp && !files.csc && !files.userdata) {
      console.error("Tidak ada file firmware yang dipilih di tab Odin Flash! Silakan pilih file tar.md5 terlebih dahulu.");
      return false;
    }

    setIsFlashing(true);
    if (!desktopActive) {
      try {
        const response = await fetch(`${desktopBridgeUrl()}/progress?since=0`, { cache: "no-store" });
        const payload: WebProgressResponse = await response.json();
        webProgressSeqRef.current = payload.seq;
      } catch { }
    }

    // Tandai device sebagai busy untuk instance FlashKit lain
    const checkedSerials = checked.flatMap(([dev, data]) => 
      [dev, data.serial, data.port, data.path].filter((x): x is string => Boolean(x))
    );
    try { await invoke("mark_busy", { serials: checkedSerials }); } catch { }

    let anyPass = false;

    try {
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
                bl: files.bl,
                ap: files.ap,
                cp: files.cp,
                csc: files.csc,
                userdata: files.userdata,
              },
            });
            delete pendingUpdatesRef.current[dev];
            setDevices(prev => ({
              ...prev,
              [dev]: { ...prev[dev], status: "Pass", progress: 100, log: prev[dev].log + `\n${getTimestamp()} ${result}` },
            }));
            anyPass = true;
          } catch (err) {
            delete pendingUpdatesRef.current[dev];
            setDevices(prev => ({
              ...prev,
              [dev]: { ...prev[dev], status: "Fail", log: prev[dev].log + `\n${getTimestamp()} ERROR: ${err}` },
            }));
          }
        })
      );
    } finally {
      try { await invoke("clear_busy", { serials: checkedSerials }); } catch { }
      setIsFlashing(false);
    }

    return anyPass;
  }

  // ── UI (Original Odin-Clone Style) ────────────────────────────────────

  const readyToFlashCount = Object.values(devices).filter(d => d.checked && d.status !== "Flashing...").length;
  const anyFlashing = Object.values(devices).some(d => d.status === "Flashing...");
  const firmwareReadonly = isFlashing;
  const visibleDevices = useMemo(() => {
    return Object.entries(devices).sort(([devA, dataA], [devB, dataB]) => {
      const matchA = isFirmwareForModel(apFilename, dataA.model || "");
      const matchB = isFirmwareForModel(apFilename, dataB.model || "");
      if (matchA !== matchB) return matchA ? -1 : 1;
      return devA.localeCompare(devB);
    });
  }, [devices, apFilename]);

  return (
    <div className="odin-container">
      <div className="devices-section">
        {visibleDevices.length === 0 ? (
          <div className="device-skeleton">
            No devices currently in Odin state
          </div>
        ) : (
          visibleDevices.map(([dev, data]) => {
            const isDevBusy = busyDevices.some(b => b === dev || b === data.path || (data.serial && b === data.serial) || (data.port && b === data.port));
            const isModelMatch = !isDevBusy && isFirmwareForModel(apFilename, data.model || "");

            let cardExtraStyle: React.CSSProperties = {};
            if (isModelMatch && data.status !== "Flashing...") {
              if (data.checked) {
                cardExtraStyle = {
                  border: "2px solid #ffffff",
                  boxShadow: "0 0 20px rgba(255, 255, 255, 0.8)",
                  animation: "pulse 1.5s infinite ease-in-out",
                  background: "rgba(255, 255, 255, 0.08)",
                };
              } else {
                cardExtraStyle = {
                  border: "2px solid rgba(245, 158, 11, 0.9)",
                  boxShadow: "0 0 15px rgba(245, 158, 11, 0.4)",
                  background: "rgba(245, 158, 11, 0.05)",
                };
              }
            }

            return (
              <div
                key={dev}
                className={`device-card ${data.status === "Flashing..." ? "flashing-state" : ""}`}
                style={cardExtraStyle}
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
                      if (data.status !== "Flashing..." && !isDevBusy) {
                        const newChecked = !data.checked;
                        
                        // Sync back to App.tsx
                        if (setSelectedSerials) {
                          const keysToRemove = [dev, data.serial, data.port].filter((k): k is string => Boolean(k));
                          setSelectedSerials(prev => {
                            if (newChecked) {
                              const idsToAdd = [dev, data.serial, data.port].filter((k): k is string => Boolean(k));
                              return Array.from(new Set([...prev, ...idsToAdd]));
                            } else {
                              return prev.filter(s => !keysToRemove.includes(s));
                            }
                          });
                        } else {
                          const nextDevices = { ...devices, [dev]: { ...devices[dev], checked: newChecked } };
                          setDevices(nextDevices);
                        }
                      }
                    }}
                  >
                    <input type="checkbox" checked={data.checked} readOnly disabled={data.status === "Flashing..." || isDevBusy} />
                    <div className={`custom-checkbox ${data.status === "Flashing..." ? 'flashing-checkbox' : ''}`}>
                      {data.status === "Flashing..." ? (
                        <RefreshCw className="w-3.5 h-3.5 text-white animate-spin" />
                      ) : (
                        <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"></path></svg>
                      )}
                    </div>
                  </div>
                  <h3 className="dev-title">
                    <span>{data.model || "Device"}{isDevBusy && <span style={{ marginLeft: 6, background: '#dc2626', color: 'white', fontSize: '10px', fontWeight: 900, letterSpacing: '0.15em', padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', boxShadow: '0 0 10px rgba(220,38,38,0.5)' }}>ODIN</span>}</span>
                    <span className={
                      data.status === "Pass" ? "dev-status-success" :
                      data.status === "Fail" ? "dev-status-fail" :
                      data.status === "Flashing..." ? "dev-status-flashing" :
                      "dev-status-ready"
                    }>
                      {data.status === "Pass" ? "Odin Completed!" : data.status}
                    </span>
                  </h3>
                  <p className="dev-path">
                    {data.port} {data.serial ? `(${data.serial})` : ''}
                    <span style={{ fontWeight: 600 }}>{data.progress}%</span>
                  </p>
                </div>
              </div>
            </div>
            );
          })
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
                <div className={`file-row file-row-${slot}`} key={slot}>
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
                  <div className={`file-input-wrapper ${firmwareReadonly ? "readonly" : ""}`} onClick={() => selectFile(slot)}>
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
                      disabled={firmwareReadonly || vs.verifying || (!hasFile && !vs.text)}
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
        <div className="action-sub-grid">
          <button className="btn-icon" title="Refresh Devices" onClick={forceRefresh}>
            <RefreshCw width={20} height={20} />
          </button>
          <button className="btn-icon" style={{ color: "#ff453a" }} title="Reset Busy Status" onClick={resetBusy}>
            <ShieldAlert width={20} height={20} />
          </button>
          <button className="btn-icon btn-icon-warning" title="Reset Stored Device Metadata" onClick={resetDeviceMetadata}>
            <DatabaseZap width={20} height={20} />
          </button>
          <button className="btn-icon" title="Clear files" onClick={clearFiles} disabled={firmwareReadonly}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>
        </div>
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
      {filePicker && (
        <div className="odin-modal">
          <div className="odin-modal-content server-file-picker">
            <div className="odin-modal-header">
              <h3>{SLOT_LABELS[filePicker.slot]} Server Files</h3>
              <button className="btn-ghost-icon" onClick={() => setFilePicker(null)}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
            <div className="odin-modal-body">
              <div className="server-file-path">
                <button type="button" className="server-file-up" onClick={() => openServerFilePicker(filePicker.slot, parentServerPath(filePicker.path))}>Up</button>
                <span>{filePicker.path}</span>
              </div>
              <div className="server-file-list">
                {filePicker.loading ? (
                  <div className="server-file-empty">Loading...</div>
                ) : filePicker.entries.length === 0 ? (
                  <div className="server-file-empty">No firmware files</div>
                ) : (
                  filePicker.entries.map(entry => (
                    <button
                      key={entry.path}
                      type="button"
                      className={`server-file-row ${entry.is_dir ? "server-file-dir" : ""}`}
                      onClick={() => entry.is_dir ? openServerFilePicker(filePicker.slot, entry.path) : (setFilePicker(null), verifyFile(filePicker.slot, entry.path))}
                    >
                      <span>{entry.is_dir ? "DIR" : "FILE"}</span>
                      <strong>{entry.name}</strong>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default OdinFlash;
