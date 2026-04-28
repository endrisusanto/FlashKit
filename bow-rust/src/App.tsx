import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Play, Wifi, Smartphone, Check, Zap, Terminal, ChevronDown, ChevronUp } from "lucide-react";

export default function App() {
  const [devices, setDevices] = useState<string[]>([]);
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [ssid, setSsid] = useState("2");
  const [password, setPassword] = useState("1234qwer");
  const [logExpanded, setLogExpanded] = useState(true);

  const appendLog = (msg: string) => setLogs(prev => [...prev, msg]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const refreshDevices = async () => {
    setLoading(true);
    appendLog("Scanning devices...");
    try {
      const version: string = await invoke("get_adb_version");
      appendLog(version);
      const list: string[] = await invoke("get_devices");
      setDevices(list);
      if (devices.length === 0) setSelectedDevices(list);
      appendLog(`Found ${list.length} device(s)`);
    } catch (e: any) {
      appendLog(`ERROR: ${e}`);
    }
    setLoading(false);
  };

  const toggleDevice = (id: string) => {
    setSelectedDevices(prev =>
      prev.includes(id) ? prev.filter(d => d !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (selectedDevices.length === devices.length) {
      setSelectedDevices([]);
    } else {
      setSelectedDevices([...devices]);
    }
  };

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  const skipWz = async () => {
    if (selectedDevices.length === 0) return;
    setLoading(true);
    setLogExpanded(true);
    appendLog("──── Skip Setup Wizard ────");
    for (const dev of selectedDevices) {
      appendLog(`[${dev}] Applying settings...`);
      try {
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put global stay_on_while_plugged_in 7"] }); await delay(300);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put global device_provisioned 1"] }); await delay(300);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put secure user_setup_complete 1"] }); await delay(300);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put system samsung_eula_agree 1"] }); await delay(300);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put system screen_off_timeout 600000"] }); await delay(300);
        await invoke("run_adb", { args: ["-s", dev, "shell", "locksettings set-disabled true"] }); await delay(300);
        appendLog(`[${dev}] Disabling setup wizards...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "pm disable-user com.sec.android.app.SecSetupWizard"] }); await delay(300);
        await invoke("run_adb", { args: ["-s", dev, "shell", "pm disable-user com.google.android.setupwizard"] }); await delay(300);
        appendLog(`[${dev}] Sending HOME key...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "input keyevent KEYCODE_HOME"] });
        appendLog(`[${dev}] ✓ Done`);
      } catch (e: any) {
        appendLog(`[${dev}] ✗ ${e}`);
      }
    }
    appendLog("──── Complete ────");
    setLoading(false);
  };

  const connectWifi = async () => {
    if (selectedDevices.length === 0 || !ssid) return;
    setLoading(true);
    setLogExpanded(true);
    appendLog(`──── WiFi: ${ssid} ────`);
    let appDir: string;
    try { appDir = await invoke("get_app_dir"); } catch { appDir = "."; }
    const sep = appDir.includes("\\") ? "\\" : "/";
    const apk = `${appDir}${sep}WifiUtil.apk`;

    for (const dev of selectedDevices) {
      try {
        appendLog(`[${dev}] Installing WifiUtil...`);
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", apk] }); await delay(1000);
        appendLog(`[${dev}] Configuring...`);
        const method = password
          ? `am instrument -e method addWpaPskNetwork -e ssid "${ssid}" -e psk "${password}" -w com.android.tradefed.utils.wifi/.WifiUtil`
          : `am instrument -e method addOpenNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`;
        await invoke("run_adb", { args: ["-s", dev, "shell", method] }); await delay(500);
        appendLog(`[${dev}] Associating...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] }); await delay(500);
        appendLog(`[${dev}] ✓ Connected`);
      } catch (e: any) {
        appendLog(`[${dev}] ✗ ${e}`);
      }
    }
    appendLog("──── Complete ────");
    setLoading(false);
  };

  useEffect(() => { refreshDevices(); }, []);

  return (
    <div className="flex flex-col h-screen select-none bg-[var(--win-bg-solid)] overflow-hidden rounded-xl border border-[var(--win-border)]">
      {/* ── TITLEBAR ── */}
      <header className="flex items-center px-6 h-12 bg-[var(--win-bg-smoke)] border-b border-[var(--win-border)] shrink-0" data-tauri-drag-region>
        <div className="flex items-center gap-3">
          <Zap className="w-5 h-5 text-[var(--win-accent)]" />
          <span className="text-[14px] font-semibold text-[var(--win-text-secondary)]">FlashKit</span>
        </div>
      </header>

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 flex min-h-0 p-4 gap-4">

        {/* ── LEFT: DEVICE LIST ── */}
        <div className="w-[320px] win-card flex flex-col bg-[var(--win-bg-smoke)] overflow-hidden shadow-xl">
          <div className="p-5 border-b border-[var(--win-border)]">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[15px] font-bold">Devices</span>
              <button onClick={refreshDevices} disabled={loading} className="win-btn-subtle !p-2 !min-h-0">
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
            {devices.length > 0 && (
              <button onClick={selectAll} className="text-[13px] text-[var(--win-accent)] hover:opacity-80 transition-opacity cursor-pointer">
                {selectedDevices.length === devices.length ? "Deselect all" : "Select all connected"}
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {devices.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-[var(--win-text-disabled)] text-center px-6 py-10">
                <Smartphone className="w-10 h-10 mb-4 opacity-20" />
                <p className="text-[14px] font-medium">No devices found</p>
                <p className="text-[12px] mt-2 leading-relaxed text-[var(--win-text-tertiary)]">Connect your device via USB and make sure ADB is enabled.</p>
              </div>
            ) : (
              <div className="space-y-1">
                {devices.map(dev => {
                  const sel = selectedDevices.includes(dev);
                  return (
                    <div key={dev} onClick={() => toggleDevice(dev)} className={`win-list-item !py-3 !px-4 ${sel ? "selected" : ""}`}>
                      <div className={`win-checkbox ${sel ? "checked" : ""}`}>
                        {sel && <Check className="w-3 h-3 text-black" strokeWidth={3} />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium truncate">{dev}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="p-4 bg-[rgba(0,0,0,0.1)] border-t border-[var(--win-border)]">
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${devices.length > 0 ? "bg-[var(--win-success)] shadow-[0_0_8px_rgba(108,203,95,0.4)]" : "bg-[var(--win-text-disabled)]"}`}></div>
              <span className="text-[12px] text-[var(--win-text-tertiary)] font-medium">
                {selectedDevices.length} of {devices.length} devices selected
              </span>
            </div>
          </div>
        </div>

        {/* ── RIGHT: CONFIG & ACTIONS ── */}
        <div className="flex-1 flex flex-col gap-4 min-w-0">

          {/* ── CONFIG CARD ── */}
          <div className="win-card p-6 bg-[var(--win-bg-smoke)] shadow-lg">
            <h3 className="text-[14px] font-bold mb-5 flex items-center gap-2">
              <Wifi className="w-4 h-4 text-[var(--win-accent)]" />
              WiFi Configuration
            </h3>
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="block text-[12px] font-medium text-[var(--win-text-tertiary)] uppercase tracking-wider">Network SSID</label>
                <input
                  type="text"
                  value={ssid}
                  onChange={e => setSsid(e.target.value)}
                  className="win-input !py-2.5"
                  placeholder="e.g. MyWiFiNetwork"
                />
              </div>
              <div className="space-y-2">
                <label className="block text-[12px] font-medium text-[var(--win-text-tertiary)] uppercase tracking-wider">Password</label>
                <input
                  type="text"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="win-input !py-2.5"
                  placeholder="Password (leave blank for open)"
                />
              </div>
            </div>
          </div>

          {/* ── ACTION CARDS ── */}
          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={skipWz}
              disabled={loading || selectedDevices.length === 0}
              className="win-action-card !p-8 hover:!bg-[rgba(255,255,255,0.02)] active:scale-[0.98]"
            >
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#0078d4] to-[#00c6ff] flex items-center justify-center shadow-lg mb-2">
                <Play className="w-7 h-7 text-white fill-white" />
              </div>
              <span className="text-[16px] font-bold">Skip Setup Wizard</span>
              <span className="text-[12px] text-[var(--win-text-tertiary)] mt-1">Full bypass algorithm</span>
            </button>

            <button
              onClick={connectWifi}
              disabled={loading || selectedDevices.length === 0 || !ssid}
              className="win-action-card !p-8 hover:!bg-[rgba(255,255,255,0.02)] active:scale-[0.98]"
            >
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#107c10] to-[#27ae60] flex items-center justify-center shadow-lg mb-2">
                <Wifi className="w-7 h-7 text-white" />
              </div>
              <span className="text-[16px] font-bold">Connect WiFi</span>
              <span className="text-[12px] text-[var(--win-text-tertiary)] mt-1">Automatic provisioning</span>
            </button>
          </div>

          {/* ── LOG PANEL ── */}
          <div className={`win-card bg-[var(--win-bg-smoke)] flex flex-col shrink-0 transition-all duration-300 shadow-xl overflow-hidden ${logExpanded ? "flex-1" : "h-[44px]"}`}>
            <button
              onClick={() => setLogExpanded(!logExpanded)}
              className="flex items-center justify-between px-5 h-[44px] shrink-0 hover:bg-[var(--win-subtle-hover)] cursor-pointer border-b border-[var(--win-border)]"
            >
              <div className="flex items-center gap-3">
                <Terminal className="w-4 h-4 text-[var(--win-accent)]" />
                <span className="text-[13px] font-bold">System Output</span>
                {loading && (
                  <div className="flex items-center gap-2 ml-4">
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--win-warning)] animate-pulse"></div>
                    <span className="text-[11px] text-[var(--win-warning)] font-bold">PROVISIONING...</span>
                  </div>
                )}
              </div>
              {logExpanded ? <ChevronDown className="w-4 h-4 text-[var(--win-text-disabled)]" /> : <ChevronUp className="w-4 h-4 text-[var(--win-text-disabled)]" />}
            </button>
            {logExpanded && (
              <div className="flex-1 min-h-0 p-4">
                <div className="win-terminal h-full p-4 overflow-y-auto custom-scrollbar">
                  {logs.length === 0 ? (
                    <span className="text-[var(--win-text-disabled)] italic opacity-50">Awaiting user action...</span>
                  ) : (
                    <div className="space-y-1">
                      {logs.map((log, i) => (
                        <div key={i} className={`leading-6 text-[13px] ${
                          log.includes("✓") ? "text-[var(--win-success)] font-bold" :
                          log.includes("✗") || log.includes("ERROR") ? "text-[var(--win-error)] font-bold" :
                          log.startsWith("────") ? "text-[var(--win-accent)] font-bold mt-2" :
                          "text-[var(--win-text-secondary)]"
                        }`}>
                          <span className="text-[var(--win-text-disabled)] mr-2 select-none">›</span>
                          {log}
                        </div>
                      ))}
                    </div>
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── STATUS BAR ── */}
      <footer className="flex items-center justify-between px-6 h-[28px] bg-[var(--win-accent-bg)] text-[11px] text-white font-semibold shrink-0 shadow-[0_-4px_10px_rgba(0,0,0,0.2)]">
        <div className="flex items-center gap-4">
          <span className="uppercase tracking-widest">FlashKit v1.0.0</span>
          <span className="opacity-60">|</span>
          <span>Build: Stable</span>
        </div>
        <div className="flex items-center gap-2">
          <Smartphone className="w-3 h-3" />
          <span>{devices.length > 0 ? `${devices.length} Device(s) Ready` : "No Connection"}</span>
        </div>
      </footer>
    </div>
  );
}
