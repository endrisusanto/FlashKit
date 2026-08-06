import { useState, useEffect, useRef, useMemo } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, RefreshCw, Play, Smartphone, Wifi, ChevronRight, Check, AlertTriangle, X, Download, ShieldAlert, DatabaseZap, FileText } from "lucide-react";
import OdinFlash, { OdinFlashRef, DeviceData, SharedFirmwareFiles } from "./OdinFlash";
import logo from './assets/logo.png';
import confetti from 'canvas-confetti';

type CachedDevice = {
  serial: string;
  usb_port: string;
  model: string;
  info: Record<string, string>;
};

type DeviceCache = {
  devices: CachedDevice[];
  updated_at_ms: number;
};

type SamsungPortInfo = {
  port_name: string;
  usb_port: string;
  serial_number?: string | null;
};

type DeviceView = {
  id: string;
  type: "adb" | "odin";
  odinKey?: string;
  serial?: string;
  model?: string;
  port?: string;
};

type SharedUiState = {
  firmware_files: {
    bl: string;
    ap: string;
    cp: string;
    csc: string;
    userdata: string;
  };
  selected_devices: string[];
  automation_state: {
    seq_odin: boolean;
    seq_skip_wz: boolean;
    seq_gba: boolean;
    seq_wifi: boolean;
    loading: boolean;
    current_step: number | null;
    is_stopping: boolean;
    logs: string[];
  };
  odin_devices?: Record<string, any>;
  verify_state?: Record<string, any>;
  updated_at_ms: number;
};

function sameStringList(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameDeviceMap(a: Record<string, any>, b: Record<string, any>) {
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => {
    const dA = a[k];
    const dB = b[k];
    return dB && dA.status === dB.status && dA.progress === dB.progress && dA.checked === dB.checked && dA.model === dB.model;
  });
}

function sameFilePaths(a: SharedFirmwareFiles, b: SharedFirmwareFiles) {
  if (!a || !b) return false;
  return a.bl === b.bl && a.ap === b.ap && a.cp === b.cp && a.csc === b.csc && a.userdata === b.userdata;
}

function sameVerifyStateMap(a?: Record<string, any>, b?: Record<string, any>) {
  if (!a || !b) return a === b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => {
    const vA = a[k];
    const vB = b[k];
    return vB && vA.text === vB.text && vA.progress === vB.progress && vA.verifying === vB.verifying;
  });
}

function isTauriRuntime() {
  return Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
}

function desktopBridgeUrl() {
  const saved = localStorage.getItem("desktop_bridge_url");
  if (saved) return saved;
  return "/bridge";
}

async function pingDesktopBridge() {
  try {
    const url = desktopBridgeUrl();
    const response = await fetch(`${url}/status`, { cache: "no-store" });
    if (response.ok) return true;
  } catch {}

  // ponytail: clear stale/broken localStorage saved bridge URL
  if (localStorage.getItem("desktop_bridge_url") !== null) {
    localStorage.removeItem("desktop_bridge_url");
    try {
      const response = await fetch("/bridge/status", { cache: "no-store" });
      if (response.ok) return true;
    } catch {}
  }

  // ponytail: fallback direct port 9977 if relative /bridge is not proxied
  try {
    const fallbackUrl = "http://" + window.location.hostname + ":9977";
    const response = await fetch(`${fallbackUrl}/status`, { cache: "no-store" });
    if (response.ok) {
      localStorage.setItem("desktop_bridge_url", fallbackUrl);
      return true;
    }
  } catch {}

  return false;
}

function desktopHostUrl() {
  return "/host";
}

async function bridgeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${desktopBridgeUrl()}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args: args || {} }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Bridge command failed: ${command}`);
  return payload.value as T;
}

const playSuccessSound = () => {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, ctx.currentTime);
    osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2);
    osc.frequency.setValueAtTime(1046.50, ctx.currentTime + 0.3);

    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.8);
  } catch (e) { console.error("Audio error", e); }
};

function normalizeModelName(rawModel?: string): string {
  if (!rawModel) return "Unknown Model";
  let cleaned = rawModel.trim().replace(/_/g, "-").toUpperCase();
  if (cleaned.startsWith("SM") && !cleaned.startsWith("SM-")) {
    cleaned = cleaned.replace(/^SM/, "SM-");
  }
  return cleaned || "Unknown Model";
}

// ponytail: helper to check if local automation state matches remote applied state
function isAutomationStateEqual(a: any, b: any): boolean {
  if (!a || !b) return false;
  return (
    a.seq_odin === b.seq_odin &&
    a.seq_skip_wz === b.seq_skip_wz &&
    a.seq_gba === b.seq_gba &&
    a.seq_wifi === b.seq_wifi &&
    a.loading === b.loading &&
    a.current_step === b.current_step &&
    a.is_stopping === b.is_stopping &&
    sameStringList(a.logs || [], b.logs || [])
  );
}

// ponytail: check if firmware filename contains a device's model code (region-agnostic)
function isFirmwareForModel(firmwareFilename: string, deviceModel: string): boolean {
  if (!firmwareFilename || !deviceModel) return false;
  const upper = firmwareFilename.toUpperCase();
  // Extract raw model code: "SM-S721B" -> "S721B", "SM-F741B" -> "F741B"
  const normalized = normalizeModelName(deviceModel);
  const raw = normalized.replace(/^SM-/, "");
  if (!raw || raw === "UNKNOWN MODEL") return false;
  return upper.includes(raw);
}

function adbShellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const DEFAULT_WIFI_SSID = "RTT / IEEE 802.11";
const DEFAULT_WIFI_PASSWORD = "1234qwer";

let confettiInterval: any = null;

const startConfettiLoop = (onStop?: () => void) => {
  if (confettiInterval) clearInterval(confettiInterval);
  const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };

  confettiInterval = setInterval(() => {
    confetti({ ...defaults, particleCount: 40, origin: { x: Math.random(), y: Math.random() - 0.2 } });
  }, 350);

  const stopConfetti = () => {
    if (confettiInterval) {
      clearInterval(confettiInterval);
      confettiInterval = null;
    }
    try { confetti.reset(); } catch (e) { }
    window.removeEventListener('mousedown', stopConfetti);
    if (onStop) onStop();
  };

  setTimeout(() => {
    window.addEventListener('mousedown', stopConfetti);
  }, 500);
};

export default function App() {
  const [desktopActive, setDesktopActive] = useState(isTauriRuntime());
  const [desktopBridgeOnline, setDesktopBridgeOnline] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [deviceDetails, setDeviceDetails] = useState<Record<string, any>>({});
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [busyDevices, setBusyDevices] = useState<string[]>([]);
  const [odinDeviceStates, setOdinDeviceStates] = useState<Record<string, DeviceData>>({});
  const [currentVerifyProgress, setCurrentVerifyProgress] = useState(0);
  const [isVerifyingMd5, setIsVerifyingMd5] = useState(false);
  const [verifyMd5Progress, setVerifyMd5Progress] = useState(0);
  const [sharedVerifyState, setSharedVerifyState] = useState<Record<string, { text: string; progress: number; verifying: boolean }> | undefined>(undefined);
  const [sharedFirmwareFiles, setSharedFirmwareFiles] = useState<SharedFirmwareFiles | null>(null);
  const [apFileName, setApFileName] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [ssid, setSsid] = useState(DEFAULT_WIFI_SSID);
  const [password, setPassword] = useState(DEFAULT_WIFI_PASSWORD);

  // Tab navigation
  const [activeTab, setActiveTab] = useState<"provisioning" | "odin">("provisioning");

  // Modal State
  const [showAdbWarningModal, setShowAdbWarningModal] = useState(false);

  // Download Modal State
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showWifiModal, setShowWifiModal] = useState(false);
  const [downloadSelectedDevices, setDownloadSelectedDevices] = useState<string[]>([]);
  const [appTrayEnabled, setAppTrayEnabled] = useState(false);

  // Master Sequence States
  const [showSplash, setShowSplash] = useState(true);
  const odinRef = useRef<OdinFlashRef>(null);
  const [seqOdin, setSeqOdin] = useState(false);
  const [seqSkipWz, setSeqSkipWz] = useState(false);
  const [seqGba, setSeqGba] = useState(false);
  const [seqWifi, setSeqWifi] = useState(false);
  const [currentStep, setCurrentStep] = useState<number | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const stopRequested = useRef(false);
  const lastDeviceCacheAt = useRef(0);
  const refreshInFlightRef = useRef(false);
  const sharedUiSeenAt = useRef(0);
  const sharedUiHydrated = useRef(false);
  const lastAppliedAutomationState = useRef<any>(null);
  const lastSavedSelectedDevices = useRef<string[]>([]);
  const lastLocalSaveMs = useRef(0); // ponytail: debounce self-echo events
  const backendActive = desktopActive || desktopBridgeOnline;

  const invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
    return desktopActive ? tauriInvoke<T>(command, args) : bridgeInvoke<T>(command, args);
  };

  useEffect(() => {
    if (backendActive) {
      invoke("set_app_tray_enabled", { enabled: appTrayEnabled }).catch(() => {});
    }
  }, [backendActive, appTrayEnabled]);

  const handleToggleAppTray = async (enabled: boolean) => {
    setAppTrayEnabled(enabled);
    localStorage.setItem("appTrayEnabled", String(enabled));
    try {
      await invoke("set_app_tray_enabled", { enabled });
    } catch (e) {
      console.error(e);
    }
  };

  const toggleSeqOdin = () => {
    if (loading) return;
    setSeqOdin(prev => !prev);
  };

  const toggleSeqSkipWz = () => {
    if (loading) return;
    setSeqSkipWz(prev => !prev);
  };

  const toggleSeqGba = () => {
    if (loading) return;
    setSeqGba(prev => !prev);
  };

  const toggleSeqWifi = () => {
    if (loading) return;
    setSeqWifi(prev => !prev);
  };

  const appendLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${time}] ${msg}`]);
  };

  useEffect(() => {
    if (!desktopActive) return;
    ["seqOdin", "seqSkipWz", "seqGba", "seqWifi", "wifi_ssid", "wifi_password", "appTrayEnabled"]
      .forEach(key => localStorage.removeItem(key));
  }, [desktopActive]);

  useEffect(() => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('port_history_')) {
          const val = localStorage.getItem(key);
          if (val) {
            const parsed = JSON.parse(val);
            if (parsed.model) {
              const norm = normalizeModelName(parsed.model);
              if (norm !== parsed.model) {
                parsed.model = norm;
                localStorage.setItem(key, JSON.stringify(parsed));
              }
            }
          }
        }
      }
    } catch {}
  }, []);

  const reopenDesktop = async () => {
    try {
      const online = await pingDesktopBridge();
      setDesktopBridgeOnline(online);
      if (online) {
        await fetch(`${desktopBridgeUrl()}/focus`, { method: "POST" });
        return;
      }
    } catch { }
    try {
      const res = await fetch(`${desktopHostUrl()}/reopen`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`Gateway returned status ${res.status}`);
      }
    } catch {
      window.location.href = "flashkit://open";
    }
    setTimeout(() => setDesktopActive(isTauriRuntime()), 1200);
  };

  useEffect(() => {
    const refreshRuntime = () => setDesktopActive(isTauriRuntime());
    window.addEventListener("focus", refreshRuntime);
    document.addEventListener("visibilitychange", refreshRuntime);
    return () => {
      window.removeEventListener("focus", refreshRuntime);
      document.removeEventListener("visibilitychange", refreshRuntime);
    };
  }, []);

  useEffect(() => {
    if (desktopActive) return;
    let cancelled = false;
    const pollBridge = async () => {
      try {
        const online = await pingDesktopBridge();
        if (!cancelled) setDesktopBridgeOnline(online);
      } catch {
        if (!cancelled) setDesktopBridgeOnline(false);
      }
    };
    pollBridge();
    const interval = window.setInterval(pollBridge, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [desktopActive]);

  const applySharedUiState = (state: SharedUiState) => {
    if (!state || !state.updated_at_ms) return;
    if (state.updated_at_ms <= sharedUiSeenAt.current) return;
    sharedUiSeenAt.current = state.updated_at_ms;

    // ponytail: skip automation_state & selected_devices echo from our own save (1000ms debounce)
    const isSelfEcho = Date.now() - lastLocalSaveMs.current < 1000;

    if (!isSelfEcho) {
      // ponytail: sync selected_devices across all windows & clients
      if (state.selected_devices) {
        setSelectedDevices(prev => {
          if (sameStringList(prev, state.selected_devices)) return prev;
          lastSavedSelectedDevices.current = state.selected_devices;
          return state.selected_devices;
        });
      }

      // ponytail: sync automation_state (flow checkboxes, loading, logs) across all windows & clients
      const incoming = state.automation_state;
      if (incoming) {
        if (!isAutomationStateEqual(incoming, lastAppliedAutomationState.current)) {
          lastAppliedAutomationState.current = incoming;
          setSeqOdin(incoming.seq_odin);
          setSeqSkipWz(incoming.seq_skip_wz);
          setSeqGba(incoming.seq_gba);
          setSeqWifi(incoming.seq_wifi);
          setLoading(incoming.loading);
          setCurrentStep(incoming.current_step);
          setIsStopping(incoming.is_stopping);
          if (incoming.logs) setLogs(prev => sameStringList(prev, incoming.logs) ? prev : incoming.logs);
        }
      }
    }

    // ponytail: always sync odin_devices, verify_state, firmware_files (no flicker risk)
    if (state.odin_devices) {
      const incomingOdin = state.odin_devices as Record<string, DeviceData>;
      setOdinDeviceStates(prev => sameDeviceMap(prev, incomingOdin) ? prev : incomingOdin);
    }
    if (state.verify_state && typeof state.verify_state === "object") {
      const incomingVerify = state.verify_state as Record<string, { text: string; progress: number; verifying: boolean }>;
      setSharedVerifyState(prev => sameVerifyStateMap(prev, incomingVerify) ? prev : incomingVerify);
    }
    if (state.firmware_files) {
      setSharedFirmwareFiles(prev => sameFilePaths(prev || { bl: "", ap: "", cp: "", csc: "", userdata: "" }, state.firmware_files) ? prev : state.firmware_files);
      const name = state.firmware_files.ap ? (state.firmware_files.ap.split(/[/\\]/).pop() || "") : "";
      setApFileName(prev => prev === name ? prev : name);
    }
  };

  useEffect(() => {
    if (!backendActive) return;
    let cancelled = false;
    invoke<SharedUiState>("get_shared_ui_state")
      .then(state => {
        if (!cancelled) applySharedUiState(state);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) sharedUiHydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [backendActive]);

  useEffect(() => {
    if (!desktopActive) return;
    const unlisten = listen<SharedUiState>("shared-ui-updated", (event) => {
      applySharedUiState(event.payload);
      sharedUiHydrated.current = true;
    });
    return () => {
      unlisten.then(fn => fn());
    };
  }, [desktopActive]);

  // ponytail: Real-time Event Stream / SSE sync for Web client
  useEffect(() => {
    if (desktopActive || !backendActive) return;
    const host = window.location.hostname || "127.0.0.1";
    const sseUrl = localStorage.getItem("desktop_bridge_url") || `http://${host}:9977/events`;
    let es: EventSource | null = null;
    const handleSseMsg = (event: MessageEvent) => {
      try {
        const state: SharedUiState = JSON.parse(event.data);
        applySharedUiState(state);
        sharedUiHydrated.current = true;
      } catch { }
    };

    try {
      es = new EventSource(sseUrl);
      es.onmessage = handleSseMsg;
      es.addEventListener("message", handleSseMsg);
    } catch { }
    return () => {
      es?.close();
    };
  }, [backendActive, desktopActive]);

  // ponytail: Polling fallback for Web client to ensure instant sync when SSE drops or reconnects
  useEffect(() => {
    if (desktopActive || !backendActive) return;
    const pollState = () => {
      invoke<SharedUiState>("get_shared_ui_state")
        .then(state => {
          applySharedUiState(state);
          sharedUiHydrated.current = true;
        })
        .catch(() => {});
    };
    pollState();
    const interval = window.setInterval(pollState, 1500);
    return () => window.clearInterval(interval);
  }, [backendActive, desktopActive]);

  // ponytail: debounced writer for local user changes; guards against echoing remote applies back
  useEffect(() => {
    if (!backendActive || !sharedUiHydrated.current) return;
    // ponytail: web clients must not overwrite active backend automation state
    if (!desktopActive && lastAppliedAutomationState.current?.loading && !loading) return;

    const currentAuto = {
      seq_odin: seqOdin,
      seq_skip_wz: seqSkipWz,
      seq_gba: seqGba,
      seq_wifi: seqWifi,
      loading,
      current_step: currentStep,
      is_stopping: isStopping,
      logs,
    };

    if (isAutomationStateEqual(currentAuto, lastAppliedAutomationState.current)) return;

    lastAppliedAutomationState.current = currentAuto;
    lastLocalSaveMs.current = Date.now(); // ponytail: debounce self-echo
    invoke<SharedUiState>("save_shared_ui_state", {
      automation_state: currentAuto,
    }).then(state => {
      sharedUiSeenAt.current = state.updated_at_ms;
      if (state.automation_state) {
        lastAppliedAutomationState.current = state.automation_state;
      }
    }).catch(() => {});
  }, [backendActive, seqOdin, seqSkipWz, seqGba, seqWifi, loading, currentStep, isStopping, logs]);

  // ponytail: writer for local device selection changes to backend
  useEffect(() => {
    if (!backendActive || !sharedUiHydrated.current) return;
    if (sameStringList(selectedDevices, lastSavedSelectedDevices.current)) return;

    lastSavedSelectedDevices.current = selectedDevices;

    lastLocalSaveMs.current = Date.now(); // ponytail: debounce self-echo
    invoke<SharedUiState>("save_shared_ui_state", {
      selected_devices: selectedDevices,
    }).then(state => {
      sharedUiSeenAt.current = state.updated_at_ms;
      if (state.selected_devices) {
        lastSavedSelectedDevices.current = state.selected_devices;
      }
    }).catch(() => {});
  }, [backendActive, selectedDevices]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    // Pre-warm confetti canvas to prevent first-click lag
    try { confetti({ particleCount: 0 }); } catch (e) { }

    const t = setTimeout(() => setShowSplash(false), 2000);
    return () => clearTimeout(t);
  }, []);

  const handleEmergencyStop = async () => {
    if (stopRequested.current) return;
    stopRequested.current = true;
    setIsStopping(true);
    appendLog("‼ EMERGENCY STOP DIAKTIFKAN! Mematikan semua proses...");

    try {
      await invoke("emergency_stop");
      appendLog("✓ Semua proses Odin & ADB telah dihentikan paksa.");
    } catch (e) {
      appendLog(`✗ Gagal menghentikan proses: ${e}`);
    }

    // Reset status setelah 10 detik agar tombol tidak menyala selamanya jika ada proses yang macet
    setTimeout(() => {
      if (!loading) {
        stopRequested.current = false;
        setIsStopping(false);
      }
    }, 10000);
  };

  useEffect(() => {
    if (!loading && stopRequested.current) {
      stopRequested.current = false;
      setIsStopping(false);
    }
  }, [loading]);

  const applyDeviceCache = (cache: DeviceCache) => {
    if (!cache || !cache.devices) return;
    if (cache.updated_at_ms > 0 && cache.updated_at_ms <= lastDeviceCacheAt.current) return;

    const cachedDevices = cache.devices.map(device => device.serial);
    const cachedDetails = cache.devices.reduce<Record<string, any>>((acc, device) => {
      const modelName = device.info?.['ro.product.model'] || device.model || "";
      acc[device.serial] = {
        ...(device.info || {}),
        usb_port: device.usb_port,
        _model: modelName,
        model: modelName,
      };
      if (device.usb_port && modelName) {
        localStorage.setItem('port_history_' + device.usb_port, JSON.stringify({
          serial: device.serial,
          model: modelName,
        }));
      }
      return acc;
    }, {});

    lastDeviceCacheAt.current = cache.updated_at_ms;
    setDevices(prev => sameStringList(prev, cachedDevices) ? prev : cachedDevices);
    setDeviceDetails(prev => ({ ...prev, ...cachedDetails }));
  };

  useEffect(() => {
    if (!backendActive) return;
    const poll = async () => {
      try {
        const [busy, cache] = await Promise.all([
          invoke<string[]>("get_busy_devices"),
          invoke<DeviceCache>("get_device_cache"),
        ]);
        setBusyDevices(busy);
        if (!loading) applyDeviceCache(cache);
      } catch { }
    };
    poll();
    const interval = setInterval(poll, 4000);
    let unlistenCache: (() => void) | undefined;
    let unlistenBusy: (() => void) | undefined;
    if (desktopActive) {
      listen<DeviceCache>("device-cache-updated", (event) => applyDeviceCache(event.payload)).then(fn => { unlistenCache = fn; });
      listen<string[]>("busy-state-updated", (event) => setBusyDevices(event.payload)).then(fn => { unlistenBusy = fn; });
    }
    return () => {
      clearInterval(interval);
      unlistenCache?.();
      unlistenBusy?.();
    };
  }, [loading, desktopActive, backendActive]);

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  const waitForAdb = async (timeoutMs = 600000, expectedDevices: string[] = [], preFlashDevices: string[] = []) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (stopRequested.current) return false;
      try {
        const list: string[] = await invoke<string[]>("get_devices");
        const readyDevices = expectedDevices.length > 0
          ? list.filter(d => expectedDevices.includes(d))
          : list.filter(d => !preFlashDevices.includes(d));
        if (readyDevices.length > 0) return true;
      } catch (e) {
        console.error(e);
      }
      await delay(5000);
    }
    return false;
  };

  const refreshDevices = async (silent = false) => {
    if (!backendActive) return;
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsRefreshingDevices(true);
    try {
      if (!silent) appendLog("[COM] Memindai port COM & Samsung Modem...");
      let samsungPortsCount = 0;
      try {
        const samsungPorts: string[] = await invoke("get_samsung_ports");
        samsungPortsCount = samsungPorts.length;
        if (samsungPorts.length > 0) {
          if (!silent) appendLog(`[COM] Ditemukan ${samsungPorts.length} Samsung Modem (${samsungPorts.join(", ")}). Membangunkan ADB...`);
          await Promise.all(samsungPorts.map(port => sendAT(true, port)));
          await delay(2000);
        } else {
          if (!silent) appendLog("[COM] Ditemukan 0 Samsung Modem (COM Port)");
        }
      } catch (e) {
        if (!silent) appendLog(`[COM] Peringatan: ${e}`);
      }

      if (!silent) appendLog("Memindai perangkat ADB...");
      try {
        const advList: any[] = await invoke("get_adb_devices_advanced");
        const list = advList.map((d: any) => d.serial);
        setDevices(prev => sameStringList(prev, list) ? prev : list);
        const details: Record<string, any> = {};

        for (const adv of advList) {
          const info = adv.info || {};
          const normModel = normalizeModelName(info['ro.product.model'] || adv.model);
          details[adv.serial] = { ...info, usb_port: adv.usb_port, _model: normModel, model: normModel, 'ro.product.model': normModel };
          localStorage.setItem('port_history_' + adv.usb_port, JSON.stringify({ serial: adv.serial, model: normModel }));
        }

        setDeviceDetails(details);
        const cache = await invoke<DeviceCache>("save_device_cache", {
          devices: advList.map((adv: any) => {
            const detail = details[adv.serial] || {};
            const { usb_port, _model, ...info } = detail;
            return {
              serial: adv.serial,
              usb_port: adv.usb_port,
              model: normalizeModelName(info['ro.product.model'] || adv.model || ""),
              info,
            };
          }),
        });
        lastDeviceCacheAt.current = cache.updated_at_ms;
        if (!silent) appendLog(`Ditemukan ${list.length} perangkat`);

        // ponytail: warn if modem detected but no ADB found (device needs reboot)
        if (samsungPortsCount > 0 && list.length === 0 && !silent) {
          setShowAdbWarningModal(true);
        }
      } catch (e: any) { if (!silent) appendLog(`ERROR: ${e}`); }
      try {
        void odinRef.current?.refreshDevices().catch(console.error);
      } catch (e) {
        console.error(e);
      }
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshingDevices(false);
    }
  };

  useEffect(() => {
    if (backendActive) refreshDevices(true);
  }, [backendActive]);

  const resetBusy = async () => {
    try {
      await invoke("reset_busy_devices");
      appendLog("✓ Status BUSY pada semua perangkat telah direset.");
      const busy: string[] = await invoke("get_busy_devices");
      setBusyDevices(busy);
    } catch (e) {
      appendLog(`✗ Gagal mereset status busy: ${e}`);
    }
  };

  const resetStoredDeviceMetadata = async () => {
    try {
      await invoke("reset_device_cache");
      Object.keys(localStorage)
        .filter(key => key.startsWith("port_history_"))
        .forEach(key => localStorage.removeItem(key));
      lastDeviceCacheAt.current = 0;
      setDevices([]);
      setDeviceDetails({});
      setSelectedDevices([]);
      setDownloadSelectedDevices([]);
      appendLog("✓ Metadata perangkat tersimpan telah dihapus.");
      await refreshDevices(true);
    } catch (e) {
      appendLog(`✗ Gagal mereset metadata perangkat: ${e}`);
    }
  };

  const sendAT = async (silent = false, portOverride?: string) => {
    let portToUse = portOverride;
    if (!portToUse) {
      const auto: string[] = await invoke("get_samsung_ports");
      if (auto.length > 0) portToUse = auto[0];
    }
    if (!portToUse) {
      if (!silent) appendLog("✗ Tidak ada port COM terdeteksi.");
      return false;
    }
    const runWithRetry = async (cmd: string) => {
      for (let i = 0; i < 2; i++) {
        try { await invoke("send_at_command", { portName: portToUse, command: cmd }); return true; }
        catch { await delay(1000); }
      }
      return false;
    };
    try {
      if (!silent) appendLog(`[${portToUse}] Mengirim Exploit...`);
      await runWithRetry("AT+USBDEBUG=1");
      await delay(500);
      await runWithRetry("AT+ENGMODES=1,2,0");
      if (!silent) appendLog(`[${portToUse}] ✓ OK`);
      return true;
    } catch (e: any) {
      if (!silent) appendLog(`[${portToUse}] ✗ ${e}`);
      return false;
    }
  };

  const getSelectedSamsungPorts = async (sourceList: string[]) => {
    if (sourceList.length === 0) return [];

    const samsungPorts = await invoke<SamsungPortInfo[]>("get_samsung_ports_detailed").catch(() => []);
    const selected = new Set(sourceList);
    const selectedUsbPorts = new Set(
      sourceList
        .map(id => deviceDetails[id]?.usb_port)
        .filter((port): port is string => Boolean(port))
    );

    const matched = samsungPorts.filter(port => {
      const serial = port.serial_number || "";
      return selected.has(serial) || (port.usb_port && selectedUsbPorts.has(port.usb_port));
    });

    return [...new Set(matched.map(port => port.port_name))];
  };

  const skipWz = async (isSequence = false, manualSelection?: string[]) => {
    if (!isSequence) setLoading(true);
    appendLog("Tahap 1: Inisialisasi AT Exploit...");
    let active: string[] = [];
    const sourceList = manualSelection || selectedDevices;
    if (sourceList.length === 0) {
      appendLog("✗ Tidak ada perangkat yang dicentang untuk Skip Wizard.");
      if (!isSequence) setLoading(false);
      return;
    }

    const ports = await getSelectedSamsungPorts(sourceList);
    if (ports.length > 0) {
      await Promise.all(ports.map(p => sendAT(false, p)));
      await delay(2500);
    } else {
      appendLog("⚠ Port modem Samsung untuk perangkat terpilih tidak ditemukan. Melanjutkan cek ADB tanpa broadcast AT.");
    }

    for (let i = 0; i < 10; i++) {
      if (stopRequested.current) throw new Error("STOP");
      const list: string[] = await invoke("get_devices");
      active = sourceList.length > 0
        ? sourceList.filter(id => list.includes(id))
        : list;
      if (active.length > 0) break;
      if (isSequence) {
        appendLog(`⏳ Menunggu perangkat untuk Skip Wizard (Percobaan ${i + 1}/10). Mencoba lagi dalam 10 detik...`);
        await delay(10000);
      } else {
        break;
      }
    }

    if (active.length === 0) { appendLog("✗ Perangkat tidak ditemukan atau tidak terpilih."); if (!isSequence) setLoading(false); return; }

    let apkData: string, apkTest: string, apkLang: string;
    try {
      if (stopRequested.current) throw new Error("STOP");
      apkData = await invoke("get_resource_path", { name: "Data_Saver_Test-debug.apk" });
      apkTest = await invoke("get_resource_path", { name: "Data_Saver_Test-debug-androidTest.apk" });
      apkLang = await invoke("get_resource_path", { name: "language.apk" });
    } catch (e) { appendLog(`ERROR: APK tidak ditemukan. ${e}`); if (!isSequence) setLoading(false); return; }

    await Promise.all(active.map(async (dev) => {
      if (stopRequested.current) return;
      appendLog(`[${dev}] Memproses Skip Wizard...`);
      try {
        const run = async (args: string[]) => {
          if (stopRequested.current) return;
          await invoke("run_adb", { args: ["-s", dev, "shell", ...args] });
          await delay(100);
        };
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apkLang] });
        await run(["am start -n net.sanapeli.adbchangelanguage/.AdbChangeLanguage --es language en --es country US"]);
        await delay(800);
        await run(["settings put global system_locales en-US"]);
        await run(["settings put system system_locales en-US"]);
        await run(["settings put global stay_on_while_plugged_in 7"]);
        await run(["settings put global device_provisioned 1"]);
        await run(["settings put secure user_setup_complete 1"]);
        await run(["settings put global verifier_verify_adb_installs 0"]);
        await run(["settings put system samsung_eula_agree 1"]);
        await run(["settings put system screen_off_timeout 600000"]);
        await run(["settings put system time_12_24 12"]);
        await run(["locksettings set-disabled true"]);
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apkData] });
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apkTest] });
        await invoke("run_adb", { args: ["-s", dev, "shell", "am instrument -w -m -e debug false -e class 'com.example.DataSaver.ExampleInstrumentedTest' com.example.DataSaver.test/androidx.test.runner.AndroidJUnitRunner"] });
        await delay(500);
        await run(["pm disable-user com.sec.android.app.SecSetupWizard"]);
        await run(["pm disable-user com.google.android.setupwizard"]);
        await invoke("run_adb", { args: ["-s", dev, "uninstall", "com.example.DataSaver"] });
        await invoke("run_adb", { args: ["-s", dev, "uninstall", "com.example.DataSaver.test"] });
        await run(["pm uninstall net.sanapeli.adbchangelanguage"]);
        await run(["svc wifi enable"]);
        await run(["settings put global wifi_on 1"]);
        await run(["input keyevent KEYCODE_HOME"]);
        appendLog(`[${dev}] ✓ SKIP WIZARD BERHASIL`);
      } catch (e: any) { appendLog(`[${dev}] ✗ GAGAL: ${e}`); }
    }));
    if (!isSequence) setLoading(false);
  };

  const setupPrecondition = async (isSequence = false, manualSelection?: string[]) => {
    let active: string[] = [];
    if (!isSequence) setLoading(true);

    const sourceList = manualSelection || selectedDevices;
    // Auto-retry untuk mendapatkan perangkat jika kosong
    for (let i = 0; i < 10; i++) {
      if (stopRequested.current) throw new Error("STOP");
      const list: string[] = await invoke("get_devices");
      active = sourceList.length > 0
        ? sourceList.filter(id => list.includes(id))
        : list;
      if (active.length > 0) break;
      if (isSequence) {
        appendLog(`⏳ Menunggu perangkat untuk Setup GBA (Percobaan ${i + 1}/10). Mencoba lagi dalam 10 detik...`);
        await delay(10000);
      } else {
        break;
      }
    }

    if (active.length === 0) { appendLog("✗ Perangkat tidak terpilih."); if (!isSequence) setLoading(false); return; }
    if (!isSequence) setLoading(true);
    appendLog("──── Setup Precondition ────");
    await Promise.all(active.map(async (dev) => {
      if (stopRequested.current) return;
      try {
        const run = async (args: string[]) => {
          if (stopRequested.current) return;
          await invoke("run_adb", { args: ["-s", dev, "shell", ...args] });
          await delay(100);
        };
        await run(["settings put global development_settings_enabled 1"]);
        await run(["settings put global adb_enabled 1"]);
        await run(["settings put global verifier_verify_adb_installs 0"]);
        for (let i = 0; i < 3; i++) {
          try { await invoke("run_adb", { args: ["-s", dev, "shell", "svc usb setFunctions mtp"] }); break; }
          catch { await delay(1000); }
        }
        await run(["settings put system screen_off_timeout 600000"]);
        await run(["settings put global stay_on_while_plugged_in 7"]);
        await run(["settings put system time_12_24 12"]);
        await run(["locksettings set-disabled true"]);
        await run(["svc wifi enable"]);
        appendLog(`[${dev}] ✓ SETUP GBA OK`);
      } catch (e: any) { appendLog(`[${dev}] ✗ ${e}`); }
    }));
    if (!isSequence) setLoading(false);
  };

  const connectWifi = async (isSequence = false, manualSelection?: string[]) => {
    if (!isSequence) setLoading(true);

    let active: string[] = [];
    const sourceList = manualSelection || selectedDevices;
    // Auto-retry untuk mendapatkan perangkat jika kosong
    for (let i = 0; i < 10; i++) {
      if (stopRequested.current) throw new Error("STOP");
      const list: string[] = await invoke("get_devices");
      active = sourceList.length > 0
        ? sourceList.filter(id => list.includes(id))
        : list;
      if (active.length > 0) break;
      if (isSequence) {
        appendLog(`⏳ Menunggu perangkat untuk WiFi Connect (Percobaan ${i + 1}/10). Mencoba lagi dalam 10 detik...`);
        await delay(10000);
      } else {
        break;
      }
    }

    if (active.length === 0 || !ssid) { appendLog("✗ Perangkat atau SSID kosong."); if (!isSequence) setLoading(false); return; }
    if (!isSequence) setLoading(true);
    appendLog(`──── WiFi Connect: ${ssid} ────`);

    let apk: string;
    try {
      if (stopRequested.current) throw new Error("STOP");
      apk = await invoke("get_resource_path", { name: "WifiUtil.apk" });
    } catch (e) { appendLog(`ERR: ${e}`); if (!isSequence) setLoading(false); return; }

    await Promise.all(active.map(async (dev) => {
      if (stopRequested.current) return;
      try {
        appendLog(`[${dev}] Menyiapkan utilitas WiFi...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] });
        // Clean install to avoid signature mismatch
        try { await invoke("run_adb", { args: ["-s", dev, "shell", "pm uninstall com.android.tradefed.utils.wifi"] }); } catch { }
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apk] });
        await delay(2000);
        appendLog(`[${dev}] Mengirim profil WiFi...`);

        const addCmd = password
          ? `am instrument -e method addWpaPskNetwork -e ssid ${adbShellQuote(ssid)} -e psk ${adbShellQuote(password)} -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`
          : `am instrument -e method addOpenNetwork -e ssid ${adbShellQuote(ssid)} -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`;

        const addResult: string = await invoke("run_adb", { args: ["-s", dev, "shell", addCmd] });
        let netId = "";
        const match = addResult.match(/result=(\d+)/);
        if (match && match[1]) { netId = match[1]; }

        if (netId) {
          await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e id ${netId} -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        } else {
          await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e ssid ${adbShellQuote(ssid)} -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        }

        await invoke("run_adb", { args: ["-s", dev, "shell", "am instrument -e method saveConfiguration -w com.android.tradefed.utils.wifi/.WifiUtil"] });
        await delay(2000);
        // Uninstall WifiUtil setelah profil tersimpan — profil sudah disimpan oleh saveConfiguration
        try { await invoke("run_adb", { args: ["-s", dev, "shell", "pm uninstall com.android.tradefed.utils.wifi"] }); } catch { }
        appendLog(`[${dev}] ✓ WiFi Connect SELESAI`);
      } catch (e: any) { appendLog(`[${dev}] ✗ GAGAL: ${e}`); }
    }));
    if (!isSequence) setLoading(false);
  };

  const forceDownloadMode = async () => {
    if (downloadSelectedDevices.length === 0) return;

    // Cek ulang apakah ada yang tiba-tiba busy di instance lain
    const busy: string[] = await invoke("get_busy_devices");
    const stillAvailable = downloadSelectedDevices.filter(id => !busy.includes(id));

    if (stillAvailable.length === 0) {
      appendLog("✗ Gagal: Semua perangkat terpilih sedang sibuk di jendela lain.");
      setShowDownloadModal(false);
      return;
    }

    setLoading(true);
    // Mark as busy
    try { await invoke("mark_busy", { serials: stillAvailable }); } catch { }

    try {
      appendLog(`Memaksa ${stillAvailable.length} perangkat ke Download Mode...`);

      // ponytail: run adb reboot download commands in parallel
      await Promise.all(stillAvailable.map(async (dev) => {
        if (stopRequested.current) return;
        try {
          await invoke("run_adb", { args: ["-s", dev, "reboot", "download"] });
          appendLog(`[${dev}] ✓ Perintah Reboot Download Mode dikirim`);
        } catch (e: any) {
          appendLog(`[${dev}] ✗ Gagal: ${e}`);
        }
      }));
    } finally {
      // Clear busy
      try { await invoke("clear_busy", { serials: stillAvailable }); } catch { }
      setLoading(false);
      setShowDownloadModal(false);
      setDownloadSelectedDevices([]);
    }
  };

  const runMasterSequence = async () => {
    if (loading) return;

    stopRequested.current = false;
    setIsStopping(false);

    // Proteksi: Cek apakah ada perangkat terpilih yang sedang sibuk di jendela lain
    const busy: string[] = await invoke("get_busy_devices");
    const activeSelection = selectedDevices.filter(id => !busy.includes(id));

    if (activeSelection.length === 0 && selectedDevices.length > 0) {
      appendLog("✗ Master Sequence dibatalkan: Perangkat sedang sibuk di jendela lain.");
      return;
    }

    setLoading(true);
    // Mark as busy for the whole sequence
    try { await invoke("mark_busy", { serials: activeSelection }); } catch { }

    try {
      await new Promise(r => setTimeout(r, 50));

      stopRequested.current = false;
      appendLog("==== MEMULAI MASTER SEQUENCE ====");
      if (activeSelection.length > 0) {
        appendLog(`[Auto] Mengunci ${activeSelection.length} perangkat: ${activeSelection.join(", ")}`);
      } else if (seqOdin) {
        appendLog("[Auto] Memulai dengan mode Odin (Deteksi ADB akan dilakukan setelah flashing).");
      }

      let currentSelection = activeSelection;
      let preFlashAdb: string[] = [];
      try { preFlashAdb = await invoke<string[]>("get_devices"); } catch (e) { }

      if (seqOdin) {
        if (stopRequested.current) throw new Error("STOP");
        setCurrentStep(0);
        if (odinRef.current) {
          appendLog("Tahap 0: Menjalankan Odin Flashing...");
          if (!odinRef.current.hasCheckedDevices()) {
            appendLog("✗ Odin Flash dilewati: Tidak ada perangkat yang dicentang di tab Odin Flash.");
          } else {
            const flashResult = await odinRef.current.startFlash();
            if (!flashResult) {
              appendLog("⚠ Odin Flash memiliki kegagalan atau file firmware belum dipilih!");
              return;
            } else {
              appendLog("✓ Odin Flash Selesai.");
              appendLog("⏳ Menunggu perangkat reboot dan terdeteksi ADB (Maksimal 10 Menit)...");

              const adbReady = await waitForAdb(600000, activeSelection, preFlashAdb);
              if (!adbReady) {
                appendLog("✗ Timeout: Perangkat tidak terdeteksi oleh ADB setelah 10 menit.");
                return;
              }

              appendLog("✓ Perangkat ADB terdeteksi! Menunggu stabilisasi sistem (10 detik)...");
              await delay(10000);
              await refreshDevices(true);

              // Refresh list device di layar (Retry logic: 30x)
              let foundNew = false;
              for (let i = 0; i < 30; i++) {
                if (stopRequested.current) break;
                await refreshDevices(true);
                try {
                  const currentAdb = await invoke<string[]>("get_devices");
                  // Serial ADB bisa tetap sama setelah flash; cukup cocokkan perangkat yang dikunci.
                  const newlyBooted = activeSelection.length > 0
                    ? currentAdb.filter(d => activeSelection.includes(d))
                    : currentAdb.filter(d => !preFlashAdb.includes(d));

                  if (newlyBooted.length > 0) {
                    setSelectedDevices(newlyBooted);
                    currentSelection = newlyBooted;
                    if (activeSelection.length === 0 || newlyBooted.length >= activeSelection.length) {
                      appendLog(`✓ Semua perangkat target (${newlyBooted.length}) terdeteksi kembali: ${newlyBooted.join(", ")}`);
                      foundNew = true;
                      break;
                    }
                  }
                } catch (e) { }

                if (i < 29) {
                  appendLog(`⏳ Perangkat belum terdeteksi sempurna (Percobaan ${i + 1}/30). Mencoba lagi dalam 10 detik...`);
                  await delay(10000);
                }
              }

              if (!foundNew) {
                appendLog("✗ KRITIKAL: Perangkat tidak ditemukan setelah 30x percobaan!");
                alert("Kritikal: Perangkat tidak terdeteksi setelah reboot!\nProses dihentikan secara paksa demi keamanan.");
                await handleEmergencyStop();
                return;
              }
            }
          }
        }
      }

      if (seqSkipWz) {
        if (stopRequested.current) throw new Error("STOP");
        setCurrentStep(1);
        await skipWz(true, currentSelection);
        await delay(2000);
      }

      if (seqGba) {
        if (stopRequested.current) throw new Error("STOP");
        setCurrentStep(2);
        await setupPrecondition(true, currentSelection);
        await delay(2000);
      }

      if (seqWifi) {
        if (stopRequested.current) throw new Error("STOP");
        setCurrentStep(3);
        await connectWifi(true, currentSelection);
        await delay(2000);
      }

      appendLog("==== MASTER SEQUENCE SELESAI ====");
      startConfettiLoop();
      playSuccessSound();
    } catch (e: any) {
      if (e?.message === "STOP" || stopRequested.current) {
        appendLog("‼ MASTER SEQUENCE DIHENTIKAN OLEH USER.");
      } else {
        appendLog(`✗ Master Sequence Gagal: ${e}`);
      }
    } finally {
      setCurrentStep(null);
      setLoading(false);
      // Clear busy at the end
      try { await invoke("clear_busy", { serials: activeSelection }); } catch { }
    }
  };

  const toggleDevice = (id: string, serial?: string, odinKey?: string, port?: string) => {
    if (busyDevices.includes(id)) return;
    const keys = [id, serial, odinKey, port].filter((k): k is string => Boolean(k));
    setSelectedDevices(prev => {
      const isCurrentlySelected = keys.some(k => prev.includes(k));
      return isCurrentlySelected
        ? prev.filter(item => !keys.includes(item))
        : Array.from(new Set([...prev, ...keys]));
    });
  };

  const mergedDevices = useMemo<DeviceView[]>(() => {
    const list: DeviceView[] = [];
    const seenSerials = new Set<string>();

    // 1. Add all ADB devices first
    devices.forEach(serial => {
      seenSerials.add(serial);
      const detail = deviceDetails[serial] || {};
      let model = detail['ro.product.model'] || detail._model || detail.model;

      // Fallback 1: check port_history in localStorage
      if (!model && detail.usb_port) {
        try {
          const hist = localStorage.getItem('port_history_' + detail.usb_port);
          if (hist) model = JSON.parse(hist).model;
        } catch {}
      }

      // Fallback 2: search all localStorage port_history entries for matching serial
      if (!model) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('port_history_')) {
            try {
              const hist = JSON.parse(localStorage.getItem(key) || '{}');
              if (hist.serial === serial && hist.model) {
                model = hist.model;
                break;
              }
            } catch {}
          }
        }
      }

      const normalized = normalizeModelName(model || serial);

      list.push({
        id: serial,
        type: "adb",
        serial: serial,
        model: normalized,
        port: detail.usb_port,
      });
    });

    // 2. Add Odin devices
    Object.entries(odinDeviceStates).forEach(([path, data]) => {
      const serial = data.serial;
      const model = normalizeModelName(data.model);
      const port = data.port;
      if (serial && seenSerials.has(serial)) {
        // Link existing ADB entry to Odin state
        const idx = list.findIndex(item => item.serial === serial);
        if (idx !== -1) {
          list[idx].odinKey = path;
          list[idx].model = normalizeModelName(list[idx].model || model);
        }
      } else {
        if (serial) {
          seenSerials.add(serial);
        }
        list.push({
          id: serial || path,
          type: "odin",
          odinKey: path,
          serial: serial,
          model: model,
          port: port,
        });
      }
    });

    // Sort: 1. Ready, 2. Flashing..., 3. Others (stable fallback using id)
    return list.sort((a, b) => {
      const getWeight = (item: typeof a) => {
        const odinData = item.odinKey ? odinDeviceStates[item.odinKey] : undefined;
        if (odinData) {
          if (odinData.status === "Ready") return 3;
          if (odinData.status === "Flashing..." || odinData.status === "Pass") return 2;
        }
        return 1;
      };

      const wA = getWeight(a);
      const wB = getWeight(b);

      if (wA !== wB) {
        return wB - wA;
      }
      return a.id.localeCompare(b.id);
    });
  }, [devices, deviceDetails, odinDeviceStates]);

  const availableDeviceIds = useMemo(
    () => mergedDevices.filter(d => !busyDevices.includes(d.id)).map(d => d.id),
    [mergedDevices, busyDevices]
  );

  // ponytail: Keep selectedDevices intact across transient USB disconnects/reboots during automation
  useEffect(() => {
    // Keep selected items intact across transient disconnects/reboots
  }, [mergedDevices, loading]);

  const groupedDevices = useMemo(() => {
    const groups = new Map<string, { model: string; devices: DeviceView[] }>();
    mergedDevices.forEach(device => {
      const model = normalizeModelName(device.model);
      const key = model.toLowerCase();
      if (!groups.has(key)) groups.set(key, { model, devices: [] });
      groups.get(key)!.devices.push({
        ...device,
        model,
      });
    });
    return [...groups.values()];
  }, [mergedDevices]);

  const selectAll = () => {
    setSelectedDevices(selectedDevices.length === availableDeviceIds.length ? [] : [...availableDeviceIds]);
  };

  // ponytail: Auto-select removed per user preference.
  // Matching firmware devices are highlighted with Amber outline (unchecked) or Blinking White outline (checked).

  const downloadAvailableDevices = devices.filter(id => !busyDevices.includes(id));
  const allDownloadDevicesSelected = downloadAvailableDevices.length > 0 && downloadAvailableDevices.every(id => downloadSelectedDevices.includes(id));



  if (showSplash) {
    return (
      <div className="flex flex-col h-screen bg-[#050505] items-center justify-center text-white select-none" data-tauri-drag-region>
        <div className="w-28 h-28 flex items-center justify-center rounded-[2rem] overflow-hidden bg-white/5 border border-white/10 p-2">
          <img src={logo} alt="FlashKit Logo" className="w-full h-full object-contain" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen h-[100dvh] bg-[#050505] text-white overflow-hidden select-none p-2 sm:p-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="flex flex-col flex-1 overflow-hidden bg-[#0a0a0a] border border-[#222] rounded-3xl shadow-[0_0_60px_rgba(0,0,0,0.8)] relative">

        {showAdbWarningModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <div className="bg-[#1a1a1a] border border-orange-500/50 rounded-2xl w-full max-w-md overflow-hidden shadow-[0_0_50px_rgba(249,115,22,0.15)] relative">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-orange-600 to-yellow-500"></div>
              <div className="p-4 sm:p-8">
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-12 h-12 rounded-full bg-orange-500/10 flex items-center justify-center shrink-0 border border-orange-500/20">
                    <AlertTriangle className="w-6 h-6 text-orange-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-white">Device Not Detected</h3>
                    <p className="text-[13px] text-white/60 mt-1">Samsung Modem ditemukan tetapi ADB gagal.</p>
                  </div>
                </div>

                <div className="bg-black/50 border border-white/5 rounded-xl p-5 mb-8">
                  <p className="text-[13px] text-white/80 leading-relaxed mb-4">
                    Sistem mendeteksi adanya perangkat Samsung yang terhubung, namun tidak merespon perintah ADB.
                  </p>
                  <div className="flex flex-col gap-3">
                    <div className="flex gap-3 items-start">
                      <span className="flex items-center justify-center w-5 h-5 rounded bg-orange-500/20 text-orange-400 text-[10px] font-black shrink-0 mt-0.5">1</span>
                      <p className="text-[12px] text-white/60">Pastikan perangkat sudah <strong>aktif / boot up</strong> sepenuhnya ke layar Setup (SUW) atau Homescreen.</p>
                    </div>
                    <div className="flex gap-3 items-start">
                      <span className="flex items-center justify-center w-5 h-5 rounded bg-orange-500/20 text-orange-400 text-[10px] font-black shrink-0 mt-0.5">2</span>
                      <p className="text-[12px] text-white/60">Pastikan <strong>USB Debugging</strong> (ADB) sudah aktif atau mode <strong>Skip SUW</strong> telah dieksekusi.</p>
                    </div>
                    <div className="flex gap-3 items-start">
                      <span className="flex items-center justify-center w-5 h-5 rounded bg-orange-500/20 text-orange-400 text-[10px] font-black shrink-0 mt-0.5">3</span>
                      <p className="text-[12px] text-white/60">Jika baru selesai flash Odin, tunggu 1-2 menit hingga device benar-benar menyala.</p>
                    </div>
                  </div>
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => setShowAdbWarningModal(false)}
                    className="flex-1 py-3 px-6 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-xl transition-all"
                  >
                    Mengerti
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── DOWNLOAD MODE MODAL ── */}
        {showDownloadModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-[#111] border border-[#333] rounded-2xl sm:rounded-3xl p-4 sm:p-8 max-w-2xl w-full shadow-2xl relative">
              <div className="absolute top-4 sm:top-6 right-4 sm:right-6">
                <button onClick={() => setShowDownloadModal(false)} className="p-2 text-white/40 hover:text-white hover:bg-white/10 transition-all rounded-xl">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="flex items-center gap-4 mb-4 pr-14">
                <div className="w-12 h-12 rounded-full bg-blue-500/20 flex items-center justify-center border border-blue-500/30">
                  <Download className="w-6 h-6 text-blue-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold">Force Download Mode</h2>
                  <p className="text-sm text-white/50">Reboot perangkat ke mode Odin</p>
                </div>
              </div>

              <button
                onClick={() => refreshDevices()}
                title="Refresh Daftar Perangkat"
                className="w-full mb-6 flex items-center justify-center gap-2 px-4 py-3 text-[11px] font-black uppercase tracking-widest text-white/55 hover:text-white bg-white/5 hover:bg-white/10 transition-all rounded-xl border border-white/10"
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshingDevices ? 'animate-spin text-blue-500' : ''}`} />
                Refresh Device List
              </button>

              <div className="flex items-center justify-between gap-3 mb-4">
                <span className="text-[11px] font-black uppercase tracking-widest text-white/35">
                  {downloadSelectedDevices.length} / {downloadAvailableDevices.length} Device Selected
                </span>
                <button
                  onClick={() => setDownloadSelectedDevices(allDownloadDevicesSelected ? [] : downloadAvailableDevices)}
                  disabled={downloadAvailableDevices.length === 0 || loading}
                  className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-[10px] font-black uppercase tracking-widest text-white/70 transition-all"
                >
                  {allDownloadDevicesSelected ? "Deselect All" : "Select All"}
                </button>
              </div>

              <div className="flex flex-col gap-4 mb-10 max-h-[40vh] overflow-y-auto custom-scrollbar pr-2">
                {loading && devices.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-8 gap-4 border border-white/5 rounded-2xl bg-white/[0.02]">
                    <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
                    <span className="text-[12px] font-black uppercase tracking-widest text-white/50">Memindai Perangkat...</span>
                  </div>
                ) : devices.length === 0 ? (
                  <div className="p-4 rounded-xl border border-white/5 bg-white/5 text-center text-sm text-white/40 italic">
                    Tidak ada perangkat ADB yang terdeteksi.
                  </div>
                ) : (
                  devices.map(dev => {
                    const detail = deviceDetails[dev] || {};
                    const model = detail['ro.product.model'] || detail._model || 'Unknown Model';
                    const port = detail.usb_port || 'Unknown Port';

                    return (
                      <div
                        key={dev}
                        onClick={() => !busyDevices.includes(dev) && setDownloadSelectedDevices(p => p.includes(dev) ? p.filter(d => d !== dev) : [...p, dev])}
                        className={`p-5 rounded-2xl border transition-all cursor-pointer flex items-center gap-5 select-none
                        ${busyDevices.includes(dev) ? 'opacity-60 cursor-not-allowed bg-red-500/5 border-red-500/20' : downloadSelectedDevices.includes(dev) ? 'bg-blue-500/10 border-blue-500/50' : 'bg-black border-white/10 hover:border-white/30'}`}
                      >
                        <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 border transition-all
                        ${downloadSelectedDevices.includes(dev) ? 'bg-blue-500 border-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]' : 'bg-transparent border-white/20'}`}>
                          {downloadSelectedDevices.includes(dev) && <Check className="w-4 h-4 text-white" />}
                        </div>
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <Smartphone className="w-5 h-5 text-white/30 shrink-0" />
                          <div className="flex flex-col min-w-0">
                            <span className="font-bold text-[15px] tracking-wide truncate">{model}</span>
                            <span className="font-mono text-[11px] text-white/35 truncate">SN: {dev} &bull; {port}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="border-t border-white/5 pt-6">
                <button
                  onClick={() => forceDownloadMode()}
                  disabled={downloadSelectedDevices.length === 0 || loading}
                  className="w-full py-5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-all shadow-[0_0_20px_rgba(37,99,235,0.3)] flex justify-center items-center gap-2"
                >
                  {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                  REBOOT TO DOWNLOAD MODE
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── WIFI & SETTINGS MODAL ── */}
        {showWifiModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={() => setShowWifiModal(false)}>
            <div className="bg-[#181818] border border-[#2a2a2a] rounded-2xl p-6 sm:p-8 max-w-md w-full shadow-2xl relative" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-6 border-b border-[#2a2a2a] pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center border border-blue-500/30">
                    <Wifi className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black uppercase tracking-wider text-white">Pengaturan WiFi & Aplikasi</h3>
                    <p className="text-[10px] text-white/40 font-mono">Preset WiFi & Fitur App System Tray</p>
                  </div>
                </div>
                <button onClick={() => setShowWifiModal(false)} className="p-2 text-white/40 hover:text-white hover:bg-white/10 transition-all rounded-xl">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-col gap-4">
                <div>
                  <label className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-1.5 block">Nama WiFi (SSID)</label>
                  <input
                    value={ssid}
                    onChange={e => setSsid(e.target.value)}
                    className="win-input w-full px-4 py-3 rounded-xl text-sm"
                    placeholder="Nama WiFi (SSID)"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-1.5 block">Kata Sandi (Password)</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="win-input w-full px-4 py-3 rounded-xl text-sm"
                    placeholder="Kata Sandi (kosongkan jika Open WiFi)"
                  />
                </div>

                <div className="pt-3 border-t border-[#2a2a2a] flex flex-col gap-2">
                  <label className="text-[11px] font-black uppercase tracking-wider text-white/40 block">Fitur Aplikasi</label>
                  <label className="flex items-center gap-3 cursor-pointer p-3 rounded-xl bg-white/5 border border-white/10 hover:border-white/20 transition-all select-none">
                    <input
                      type="checkbox"
                      checked={appTrayEnabled}
                      onChange={e => handleToggleAppTray(e.target.checked)}
                      className="w-4 h-4 rounded border-white/20 text-blue-600 focus:ring-0 accent-blue-500 cursor-pointer"
                    />
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-bold text-white">Enable App Tray (System Tray)</span>
                      <span className="text-[10px] text-white/40 leading-tight">Jika dicentang, tombol [X] meminimalkan aplikasi ke System Tray.</span>
                    </div>
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-[#2a2a2a]">
                <button
                  onClick={() => setShowWifiModal(false)}
                  className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all shadow-[0_0_15px_rgba(37,99,235,0.3)]"
                >
                  Simpan & Tutup
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── NAVBAR ── */}
        <header className="grid grid-cols-[1fr_auto_1fr] items-center px-4 md:px-8 h-16 md:h-20 bg-[#0d0d0d] border-b border-[#222] shrink-0 gap-3" data-tauri-drag-region>
          <div className="justify-self-start" />
          <div className="flex h-full gap-2 md:gap-4 shrink-0">
            <button
              id="tab-provisioning"
              onClick={() => setActiveTab("provisioning")}
              className={`h-full px-3 sm:px-6 md:px-12 text-[10px] sm:text-[11px] md:text-[13px] font-black uppercase tracking-[0.05em] sm:tracking-[0.1em] md:tracking-[0.2em] border-b-[3px] transition-all ${activeTab === "provisioning"
                ? "border-white text-white bg-white/[0.02]"
                : "border-transparent text-white/30 hover:text-white/60 hover:bg-white/[0.01]"
                }`}
            >
              AUTO SETUP
            </button>
            <button
              id="tab-odin"
              onClick={() => setActiveTab("odin")}
              className={`h-full px-3 sm:px-6 md:px-12 text-[10px] sm:text-[11px] md:text-[13px] font-black uppercase tracking-[0.05em] sm:tracking-[0.1em] md:tracking-[0.2em] border-b-[3px] transition-all relative overflow-hidden ${activeTab === "odin"
                ? "border-blue-500 text-blue-400 bg-blue-500/[0.02]"
                : "border-transparent text-white/30 hover:text-white/60 hover:bg-white/[0.01]"
                }`}
            >
              {currentVerifyProgress > 0 && currentVerifyProgress < 100 && (
                <div
                  className="absolute bottom-0 left-0 h-full bg-blue-500/30 shadow-[0_0_24px_rgba(59,130,246,0.35)] transition-all duration-300 pointer-events-none"
                  style={{ width: `${currentVerifyProgress}%` }}
                />
              )}
              <span className="relative z-10">FIRMWARE</span>
            </button>
          </div>
        </header>

        {/* Always mount OdinFlash to retain state and refs, but hide it if not active */}
        <div className={activeTab === "odin" ? "flex-1 flex flex-col min-h-0 p-2 sm:p-4 md:p-8 overflow-y-auto" : "hidden"}>
          <div className="flex-1 flex flex-col bg-[#121212] border border-[#222] rounded-xl md:rounded-3xl p-3 md:p-8 overflow-y-auto md:overflow-hidden shadow-inner custom-scrollbar">
            {backendActive && (
              <OdinFlash
                ref={odinRef}
                allSerials={devices}
                selectedSerials={selectedDevices}
                setSelectedSerials={setSelectedDevices}
                odinDevices={odinDeviceStates}
                onDevicesUpdate={setOdinDeviceStates}
                sharedVerifyState={sharedVerifyState}
                sharedFirmwareFiles={sharedFirmwareFiles || undefined}
                onVerifyProgress={setCurrentVerifyProgress}
                onVerifyStateChange={(verifying, progress) => {
                  setIsVerifyingMd5(verifying);
                  setVerifyMd5Progress(progress);
                }}
                onApFileChange={setApFileName}
              />
            )}
          </div>
        </div>

        <main className={activeTab === "provisioning" ? "flex-1 flex min-h-0 p-3 md:p-8 overflow-hidden" : "hidden"}>
          <div className="flex-1 flex flex-col md:flex-row bg-[#121212] border border-[#222] rounded-xl md:rounded-3xl p-4 md:p-8 gap-4 overflow-y-auto shadow-inner custom-scrollbar">
            {/* Left: Device Pool */}
            <div className="w-full md:w-1/3 md:min-w-[350px] md:max-w-[500px] flex flex-col gap-4 md:gap-8 shrink-0 min-h-[300px] md:min-h-0">
              <div className="flex flex-col gap-3">
                <h3 className="text-[11px] font-black text-white/40 uppercase tracking-widest text-center">Daftar Perangkat ({mergedDevices.length})</h3>
                <div className="flex items-center justify-center gap-3 px-2">
                  <button onClick={() => refreshDevices()} title="Refresh Device List" className="p-2.5 bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all rounded-xl shadow-sm">
                    <RefreshCw className={`w-4 h-4 ${isRefreshingDevices ? 'animate-spin text-blue-500' : 'text-white/60'}`} />
                  </button>
                  <button onClick={resetBusy} title="Reset All Busy Status" className="p-2.5 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/40 transition-all rounded-xl shadow-sm group">
                    <ShieldAlert className="w-4 h-4 text-red-500/60 group-hover:text-red-500 transition-colors" />
                  </button>
                  <button onClick={resetStoredDeviceMetadata} title="Reset Stored Device Metadata" className="p-2.5 bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 hover:border-amber-500/40 transition-all rounded-xl shadow-sm group">
                    <DatabaseZap className="w-4 h-4 text-amber-500/70 group-hover:text-amber-400 transition-colors" />
                  </button>
                  <button onClick={selectAll} className="flex-1 py-2.5 bg-white/5 border border-white/10 text-[10px] font-black uppercase hover:bg-white/10 hover:border-white/20 transition-all tracking-widest rounded-xl shadow-sm">
                    {selectedDevices.length === availableDeviceIds.length ? "Uncheck All" : "Select All"}
                  </button>
                </div>
              </div>
              <div className="flex-1 flex flex-col overflow-y-auto gap-3 pr-2 custom-scrollbar py-2 max-h-[calc(100vh-310px)] min-h-0">
                {mergedDevices.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center opacity-10 gap-4 border-2 border-dashed border-white/10">
                    <Smartphone className="w-12 h-12" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Menunggu Koneksi</span>
                  </div>
                ) : (
                  groupedDevices.map(group => {
                    const groupAvailableIds = group.devices.filter(d => !busyDevices.includes(d.id)).map(d => d.id);
                    const allGroupSelected = groupAvailableIds.length > 0 && groupAvailableIds.every(id => selectedDevices.includes(id));
                    const selectedCount = group.devices.filter(d => selectedDevices.includes(d.id)).length;
                    const busyCount = group.devices.filter(d => busyDevices.includes(d.id)).length;
                    const flashingCount = group.devices.filter(d => {
                      const status = d.odinKey ? odinDeviceStates[d.odinKey]?.status : undefined;
                      return status === "Flashing...";
                    }).length;
                    const passCount = group.devices.filter(d => {
                      const status = d.odinKey ? odinDeviceStates[d.odinKey]?.status : undefined;
                      return status === "Pass";
                    }).length;
                    const failCount = group.devices.filter(d => {
                      const status = d.odinKey ? odinDeviceStates[d.odinKey]?.status : undefined;
                      return status === "Fail";
                    }).length;

                    return (
                      <section key={group.model} className="flex flex-col gap-2">
                        <button
                          onClick={() => setSelectedDevices(prev => {
                            const current = new Set(prev);
                            groupAvailableIds.forEach(id => allGroupSelected ? current.delete(id) : current.add(id));
                            return [...current];
                          })}
                          disabled={groupAvailableIds.length === 0}
                          className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5 hover:border-white/15 disabled:opacity-40 transition-all"
                        >
                          <span className="text-[11px] font-black uppercase tracking-widest text-white/45 truncate">{group.model}</span>
                          <span className="flex items-center gap-1.5 text-[10px] font-black text-white/30">
                            <span>{selectedCount}/{group.devices.length}</span>
                            {busyCount > 0 && <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">BUSY {busyCount}</span>}
                            {flashingCount > 0 && <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">FLASH {flashingCount}</span>}
                            {passCount > 0 && <span className="px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">PASS {passCount}</span>}
                            {failCount > 0 && <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">FAIL {failCount}</span>}
                          </span>
                        </button>
                        {group.devices.map((item) => {
                          const id = item.id;
                          const odinData = item.odinKey ? odinDeviceStates[item.odinKey] : undefined;
                          const isOdinMode = item.type === "odin" || (odinData !== undefined);
                          const isFlashing = odinData?.status === "Flashing...";
                          const isPass = odinData?.status === "Pass";
                          const isFail = odinData?.status === "Fail";
                          const isSelected = selectedDevices.includes(id) ||
                            Boolean(item.serial && selectedDevices.includes(item.serial)) ||
                            Boolean(item.odinKey && selectedDevices.includes(item.odinKey));

                          const isModelMatch = isFirmwareForModel(apFileName, item.model || "");

                          let borderStyle = "";
                          if (busyDevices.includes(id) && !isSelected) {
                            borderStyle = "opacity-75 cursor-not-allowed border-red-500/20 bg-red-500/5 shadow-[0_0_10px_rgba(239,68,68,0.1)]";
                          } else if (isFlashing) {
                            borderStyle = "border-blue-500 bg-blue-500/10 shadow-[0_0_15px_rgba(59,130,246,0.3)]";
                          } else if (isPass) {
                            borderStyle = "border-green-500 bg-green-500/10 shadow-[0_0_15px_rgba(34,197,94,0.3)]";
                          } else if (isFail) {
                            borderStyle = "border-red-500 bg-red-500/10 shadow-[0_0_15px_rgba(239,68,68,0.3)]";
                          } else if (isModelMatch) {
                            if (isSelected) {
                              // Matching model & CHECKED: Blinking White Outline
                              borderStyle = "border-2 border-white bg-white/10 shadow-[0_0_20px_rgba(255,255,255,0.8)] animate-pulse";
                            } else {
                              // Matching model & UNCHECKED: Regular Amber Outline
                              borderStyle = "border-2 border-amber-500/90 bg-amber-500/5 shadow-[0_0_15px_rgba(245,158,11,0.4)]";
                            }
                          } else if (isSelected) {
                            borderStyle = "border-white bg-white/5 shadow-[0_0_15px_rgba(255,255,255,0.25)]";
                          } else {
                            borderStyle = "border-[#222] hover:border-white/10";
                          }

                          return (
                            <div
                              key={id}
                              onClick={() => !busyDevices.includes(id) && toggleDevice(id, item.serial, item.odinKey, item.port)}
                              className={`h-[96px] shrink-0 p-4 rounded-xl border transition-all cursor-pointer relative overflow-hidden ${borderStyle}`}
                            >
                              {isFlashing && odinData && (
                                <div
                                  className="absolute inset-y-0 left-0 bg-blue-500/25 shadow-[0_0_35px_rgba(59,130,246,0.25)] transition-all duration-300 z-0"
                                  style={{ width: `${odinData.progress}%` }}
                                />
                              )}
                              {isPass && <div className="absolute inset-0 bg-green-500/10 z-0" />}
                              {isFail && <div className="absolute inset-0 bg-red-500/10 z-0" />}

                              <div className="relative z-10 h-full flex flex-col justify-center">
                                <div className="flex items-center justify-between">
                                  <div className="flex flex-col min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[16px] font-bold truncate pr-1 leading-tight">
                                        {item.model || id}
                                      </span>
                                      {isOdinMode && (
                                        <span className={`text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded ${isFlashing ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse' :
                                            isPass ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
                                              isFail ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                                                'bg-blue-500/10 text-blue-400/80 border border-blue-500/20'
                                          }`}>
                                          {isFlashing ? `Flashing ${odinData?.progress}%` : isPass ? "Odin Completed" : odinData?.status || "Odin Mode"}
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-[11px] text-white/25 font-mono tracking-tight mt-0.5">
                                      {item.serial ? `SN: ${item.serial}` : 'SN: Unknown'} &bull; {item.port || 'Unknown Port'}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {busyDevices.includes(id) && <span className="bg-red-600 px-2 py-0.5 rounded text-[10px] font-black tracking-[0.15em] text-white shadow-[0_0_10px_rgba(220,38,38,0.5)]">BUSY</span>}
                                    <div className={`w-6 h-6 border flex items-center justify-center transition-all ${
                                      isFlashing || (loading && isSelected)
                                        ? 'bg-blue-500/20 border-blue-500'
                                        : isSelected
                                        ? 'bg-white border-white'
                                        : 'border-white/10'
                                    }`}>
                                      {isFlashing || (loading && isSelected) ? (
                                        <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                                      ) : isSelected ? (
                                        <Check className="w-3.5 h-3.5 text-black font-black" />
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </section>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right: Dashboard */}
            <div className="flex-1 flex flex-col gap-6 md:gap-10 min-w-0">

              {/* MASTER SEQUENCE CARD */}
              <div className="p-4 md:p-8 bg-[#181818] border border-[#2a2a2a] rounded-xl md:rounded-2xl relative overflow-hidden">
                <div className="flex items-center justify-center mb-6 md:mb-10">
                  <div className="flex items-center gap-1 md:gap-2 flex-wrap justify-center">
                    <div className={`flex items-center gap-2 transition-all duration-500 ${!seqOdin ? 'hidden' : ''} ${currentStep === 0 ? 'opacity-100 text-orange-400 drop-shadow-[0_0_8px_rgba(251,146,60,0.8)]' : (currentStep && currentStep > 0 ? 'opacity-50 text-white' : 'opacity-30 text-white')}`}>
                      <span className={`text-[10px] font-black uppercase tracking-widest`}>Odin Flash</span>
                      <ChevronRight className="w-3 h-3" />
                    </div>
                    <div className={`flex items-center gap-2 transition-all duration-500 ${!seqSkipWz ? 'hidden' : ''} ${currentStep === 1 ? 'opacity-100 text-blue-400 drop-shadow-[0_0_8px_rgba(96,165,250,0.8)]' : (currentStep && currentStep > 1 ? 'opacity-50 text-white' : 'opacity-30 text-white')}`}>
                      <span className={`text-[10px] font-black uppercase tracking-widest`}>Skip WZ</span>
                      <ChevronRight className="w-3 h-3" />
                    </div>
                    <div className={`flex items-center gap-2 transition-all duration-500 ${!seqGba ? 'hidden' : ''} ${currentStep === 2 ? 'opacity-100 text-purple-400 drop-shadow-[0_0_8px_rgba(192,132,252,0.8)]' : (currentStep && currentStep > 2 ? 'opacity-50 text-white' : 'opacity-30 text-white')}`}>
                      <span className={`text-[10px] font-black uppercase tracking-widest`}>Setup GBA</span>
                      <ChevronRight className="w-3 h-3" />
                    </div>
                    <div className={`flex items-center gap-2 transition-all duration-500 ${!seqWifi ? 'hidden' : ''} ${currentStep === 3 ? 'opacity-100 text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 'opacity-30 text-white'}`}>
                      <span className={`text-[10px] font-black uppercase tracking-widest`}>WiFi Connect</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-4 md:gap-8">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-6">
                    <div onClick={toggleSeqOdin} className={`p-3 md:p-6 border rounded-xl transition-all flex flex-col items-center justify-center gap-2 md:gap-4 ${loading ? 'cursor-not-allowed opacity-40 pointer-events-none' : 'cursor-pointer'} ${seqOdin ? 'border-orange-500 bg-orange-500/10' : 'border-[#333] bg-black/40'}${loading ? '' : ' hover:border-white/20'}`}>
                      <div className={`w-7 h-7 border rounded-md flex items-center justify-center transition-all ${seqOdin ? 'bg-orange-500 border-orange-500 shadow-[0_0_15px_rgba(251,146,60,0.5)]' : 'border-white/20'}`}>
                        {seqOdin && <Check className="w-5 h-5 text-white" strokeWidth={4} />}
                      </div>
                      <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqOdin ? 'text-orange-400' : 'text-white/40'}`}>Odin Flash</span>
                    </div>
                    <div onClick={toggleSeqSkipWz} className={`p-6 border rounded-xl transition-all flex flex-col items-center justify-center gap-4 ${loading ? 'cursor-not-allowed opacity-40 pointer-events-none' : 'cursor-pointer'} ${seqSkipWz ? 'border-blue-500 bg-blue-500/10' : 'border-[#333] bg-black/40'}${loading ? '' : ' hover:border-white/20'}`}>
                      <div className={`w-7 h-7 border rounded-md flex items-center justify-center transition-all ${seqSkipWz ? 'bg-blue-500 border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 'border-white/20'}`}>
                        {seqSkipWz && <Check className="w-5 h-5 text-white" strokeWidth={4} />}
                      </div>
                      <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqSkipWz ? 'text-blue-400' : 'text-white/40'}`}>Skip WZ</span>
                    </div>
                    <div onClick={toggleSeqGba} className={`p-6 border rounded-xl transition-all flex flex-col items-center justify-center gap-4 ${loading ? 'cursor-not-allowed opacity-40 pointer-events-none' : 'cursor-pointer'} ${seqGba ? 'border-purple-500 bg-purple-500/10' : 'border-[#333] bg-black/40'}${loading ? '' : ' hover:border-white/20'}`}>
                      <div className={`w-7 h-7 border rounded-md flex items-center justify-center transition-all ${seqGba ? 'bg-purple-500 border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.5)]' : 'border-white/20'}`}>
                        {seqGba && <Check className="w-5 h-5 text-white" strokeWidth={4} />}
                      </div>
                      <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqGba ? 'text-purple-400' : 'text-white/40'}`}>Setup GBA</span>
                    </div>
                    <div
                      onClick={toggleSeqWifi}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!loading) setShowWifiModal(true);
                      }}
                      title="Klik kiri: Toggle WiFi Connect | Klik kanan: Preset SSID & Password"
                      className={`p-6 border rounded-xl transition-all flex flex-col items-center justify-center gap-4 relative group ${loading ? 'cursor-not-allowed opacity-40 pointer-events-none' : 'cursor-pointer'} ${seqWifi ? 'border-green-500 bg-green-500/10' : 'border-[#333] bg-black/40'}${loading ? '' : ' hover:border-white/20'}`}
                    >
                      <div className={`w-7 h-7 border rounded-md flex items-center justify-center transition-all ${seqWifi ? 'bg-green-500 border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.5)]' : 'border-white/20'}`}>
                        {seqWifi && <Check className="w-5 h-5 text-white" strokeWidth={4} />}
                      </div>
                      <span className={`text-[9px] md:text-[11px] font-black uppercase tracking-widest text-center ${seqWifi ? 'text-green-400' : 'text-white/40'}`}>WiFi Connect</span>
                    </div>
                  </div>
                  <button
                    onClick={() => runMasterSequence()}
                    disabled={loading || (seqOdin && isVerifyingMd5) || (!seqOdin && !seqSkipWz && !seqGba && !seqWifi)}
                    className={`w-full mt-2 py-4 md:py-6 rounded-xl transition-all font-black uppercase tracking-widest text-[14px] md:text-[16px] flex items-center justify-center gap-3 md:gap-4 border-2 ${
                      seqOdin && isVerifyingMd5
                        ? 'border-blue-500/50 bg-[#111] text-white/80 cursor-not-allowed'
                        : loading
                        ? 'bg-[#111] border-[#333] text-white/40 cursor-not-allowed'
                        : 'bg-white text-black border-white hover:bg-gray-200 disabled:opacity-30'
                    }`}
                    style={
                      seqOdin && isVerifyingMd5
                        ? {
                            background: `linear-gradient(to right, rgba(59, 130, 246, 0.25) ${verifyMd5Progress}%, transparent ${verifyMd5Progress}%)`,
                          }
                        : undefined
                    }
                  >
                    {seqOdin && isVerifyingMd5 ? (
                      <RefreshCw className="w-5 md:w-6 h-5 md:h-6 animate-spin text-blue-500" />
                    ) : loading && currentStep !== null ? (
                      <RefreshCw className="w-5 md:w-6 h-5 md:h-6 animate-spin" />
                    ) : (
                      <Play className="w-5 md:w-6 h-5 md:h-6" />
                    )}
                    <span>
                      {seqOdin && isVerifyingMd5
                        ? `Verifying MD5 . . . ${Math.round(verifyMd5Progress)}%`
                        : loading && currentStep !== null
                        ? 'Memproses...'
                        : 'Jalankan Automasi'}
                    </span>
                  </button>

                  {/* AP / ALL Firmware Filename Badge */}
                  <div className="flex items-center justify-center mt-1.5">
                    <div
                      className={`px-2 py-0.5 rounded-md border text-[10px] font-mono flex items-center gap-1.5 max-w-full overflow-hidden transition-all ${
                        apFileName
                          ? 'border-white/15 bg-white/10 text-white/70'
                          : 'border-white/5 bg-white/5 text-white/25'
                      }`}
                      title={apFileName ? `File AP/ALL: ${apFileName}` : "Belum ada file AP/ALL yang dipilih pada tab Firmware"}
                    >
                      <FileText className={`w-3 h-3 shrink-0 ${apFileName ? 'text-white/50' : 'text-white/20'}`} />
                      <span className="truncate">
                        {apFileName ? `AP/ALL: ${apFileName}` : 'AP/ALL: Belum ada file'}
                      </span>
                    </div>
                  </div>
                </div>
                {loading && currentStep !== null && <div className="absolute bottom-0 left-0 h-1 bg-blue-500 w-full animate-pulse"></div>}
              </div>

              {/* System Log */}
              <div className="flex-1 bg-black border border-[#2a2a2a] rounded-xl md:rounded-2xl flex flex-col min-h-[250px] md:min-h-0 overflow-hidden shadow-lg mt-2 md:mt-0">
                <div className="flex items-center justify-between px-4 md:px-8 h-8 bg-white/5 border-b border-[#2a2a2a]">
                  <div className="flex-1 flex items-center justify-center gap-3">
                    <Terminal className="w-4 h-4 text-blue-500" />
                    <span className="text-[11px] font-black uppercase tracking-widest">Log Sistem</span>
                  </div>
                  <button onClick={() => setLogs([])} className="text-[10px] font-black text-white/20 hover:text-white px-2 md:px-3 py-1 bg-white/5 rounded transition-all">CLEAR</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 md:p-6 font-mono text-[11px] md:text-[13px] select-text leading-relaxed custom-scrollbar">
                  {logs.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-white/5 uppercase tracking-[0.5em] font-black italic">Ready</div>
                  ) : (
                    logs.map((log, i) => {
                      const isErr = log.includes('✗') || log.includes('ERR') || log.includes('GAGAL');
                      const isOk = log.includes('✓') || log.includes('BERHASIL') || log.includes('SELESAI');
                      const match = log.match(/^\[(.*?)\] (.*)$/);
                      const timeStr = match ? `[${match[1]}]` : "";
                      const msgStr = match ? match[2] : log;

                      return (
                        <div key={i} className="mb-[2px] border-l-2 border-white/5 pl-4 hover:border-blue-500 transition-all py-1 hover:bg-blue-500/10 flex items-start break-all rounded-r-md">
                          <span className="text-white/20 mr-5 font-normal whitespace-nowrap">{timeStr}</span>
                          <span className={`${isErr ? 'text-red-400 font-bold' : isOk ? 'text-green-400 font-bold' : 'text-white/75'}`}>{msgStr}</span>
                        </div>
                      );
                    })
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            </div>
          </div>

          {/* ── FLOATING ACTION BUTTONS ── */}
          <div className="absolute bottom-16 md:bottom-20 right-6 md:right-8 flex flex-col gap-3 md:gap-4 z-40">
            {/* Emergency Stop Button */}
            <button
              onClick={handleEmergencyStop}
              className={`w-10 h-10 md:w-14 md:h-14 rounded-full flex items-center justify-center transition-all border shadow-lg ${isStopping
                ? "bg-red-600 border-red-400 shadow-[0_0_30px_rgba(239,68,68,0.8)] animate-glow-red"
                : (loading ? "bg-red-900/40 border-red-600/50 text-red-500 animate-pulse" : "bg-red-900/30 hover:bg-red-900/50 border-red-900/50 text-red-500/50 hover:text-red-500")
                }`}
              title="EMERGENCY STOP (Cancel All Processes)"
            >
              <ShieldAlert className="w-5 h-5 md:w-7 md:h-7" />
            </button>

            {/* Download Mode Button */}
            <button
              onClick={async () => {
                setShowDownloadModal(true);
                setLoading(true);
                try {
                  const cache: DeviceCache = await invoke("get_device_cache");
                  applyDeviceCache(cache);
                  const list = cache.devices.length > 0 ? cache.devices.map(device => device.serial) : await invoke<string[]>("get_devices");
                  if (cache.devices.length === 0) setDevices(list);
                  setDownloadSelectedDevices(list.filter(id => !busyDevices.includes(id)));
                } catch (e) {
                  console.error(e);
                } finally {
                  setLoading(false);
                }
              }}
              className="w-10 h-10 md:w-14 md:h-14 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-[0_0_30px_rgba(37,99,235,0.5)] flex items-center justify-center transition-transform hover:scale-110 active:scale-95 border border-blue-400"
              title="Force Download Mode"
            >
              <Download className="w-5 h-5 md:w-6 md:h-6" />
            </button>
          </div>
        </main>

        <footer className="h-10 bg-[#0d0d0d] border-t border-[#222] flex items-center px-8 justify-between shrink-0 relative z-50">
          <div className="flex items-center gap-4">
            <div className={`w-2.5 h-2.5 rounded-full ${mergedDevices.length > 0 ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.4)]' : 'bg-white/10'}`} />
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40">{mergedDevices.length} Units Connected</span>
          </div>
        </footer>

        {!backendActive && (
          <div className="absolute inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-sm p-6">
            <div className="w-full max-w-md rounded-2xl border border-orange-500/40 bg-[#151515] p-6 shadow-[0_0_50px_rgba(249,115,22,0.15)]">
              <div className="flex items-center gap-4 mb-5">
                <div className="w-11 h-11 rounded-xl bg-orange-500/15 border border-orange-500/25 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-orange-400" />
                </div>
                <div>
                  <h2 className="text-base font-black uppercase tracking-widest">Desktop Inactive</h2>
                  <p className="text-[12px] text-white/45 mt-1">
                    {desktopBridgeOnline ? "Bridge online. Reopen will focus desktop." : "Bridge offline. Reopen will launch FlashKit desktop."}
                  </p>
                </div>
              </div>
              <button
                onClick={reopenDesktop}
                className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-400 text-black text-[12px] font-black uppercase tracking-widest transition-all"
              >
                {desktopBridgeOnline ? "Focus Desktop" : "Reopen Desktop"}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
