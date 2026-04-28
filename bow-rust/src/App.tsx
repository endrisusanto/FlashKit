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
  const [serialPorts, setSerialPorts] = useState<string[]>([]);
  const [selectedPort, setSelectedPort] = useState("");

  const appendLog = (msg: string) => setLogs(prev => [...prev, msg]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const refreshDevices = async () => {
    setLoading(true);
    appendLog("Scanning ADB devices...");
    try {
      const list: string[] = await invoke("get_devices");
      setDevices(list);
      if (devices.length === 0) setSelectedDevices(list);
      appendLog(`Found ${list.length} ADB device(s)`);
    } catch (e: any) {
      appendLog(`ERROR: ${e}`);
    }

    appendLog("Scanning COM ports...");
    try {
      const ports: string[] = await invoke("get_serial_ports");
      setSerialPorts(ports);
      if (ports.length > 0 && !selectedPort) setSelectedPort(ports[0]);
      appendLog(`Found ${ports.length} COM port(s)`);
    } catch (e: any) {
      appendLog(`ERROR: ${e}`);
    }
    setLoading(false);
  };

  const sendAT = async () => {
    if (!selectedPort) return;
    setLoading(true);
    setLogExpanded(true);
    appendLog(`──── Sending AT Exploit to ${selectedPort} ────`);
    try {
      appendLog(`[${selectedPort}] Sending AT+USBDEBUG=1...`);
      const resp1: string = await invoke("send_at_command", { portName: selectedPort, command: "AT+USBDEBUG=1" });
      appendLog(`Resp: ${resp1}`);
      await delay(1000);
      appendLog(`[${selectedPort}] Sending AT+ENGMODES=1,2,0...`);
      const resp2: string = await invoke("send_at_command", { portName: selectedPort, command: "AT+ENGMODES=1,2,0" });
      appendLog(`Resp: ${resp2}`);
      appendLog(`[${selectedPort}] ✓ Done. Now check 'adb devices'.`);
    } catch (e: any) {
      appendLog(`[${selectedPort}] ✗ ${e}`);
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
    appendLog("──── FULL WZ SKIP (BOW ALGORITHM) ────");
    
    let apkData: string;
    let apkDataTest: string;
    try {
      apkData = await invoke("get_resource_path", { name: "Data_Saver_Test-debug.apk" });
      apkDataTest = await invoke("get_resource_path", { name: "Data_Saver_Test-debug-androidTest.apk" });
    } catch (e) {
      appendLog(`ERROR: Resources not found. ${e}`);
      setLoading(false);
      return;
    }

    for (const dev of selectedDevices) {
      appendLog(`[${dev}] Step 1: Global & System Settings...`);
      try {
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put global stay_on_while_plugged_in 7"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put global device_provisioned 1"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put secure user_setup_complete 1"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put system samsung_eula_agree 1"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put system screen_off_timeout 600000"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put system time_12_24 12"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "locksettings set-disabled true"] }); await delay(200);
        
        appendLog(`[${dev}] Step 2: Deploying DataSaver exploit...`);
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", apkData] }); await delay(500);
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", apkDataTest] }); await delay(500);
        
        appendLog(`[${dev}] Step 3: Triggering exploit...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "am instrument -w -m -e debug false -e class 'com.example.DataSaver.ExampleInstrumentedTest' com.example.DataSaver.test/androidx.test.runner.AndroidJUnitRunner"] });
        await delay(1000);
        
        appendLog(`[${dev}] Step 4: Disabling Setup Wizards...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "pm disable-user com.sec.android.app.SecSetupWizard"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "pm disable-user com.google.android.setupwizard"] }); await delay(200);
        
        appendLog(`[${dev}] Step 5: Cleaning up...`);
        await invoke("run_adb", { args: ["-s", dev, "uninstall", "com.example.DataSaver"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "uninstall", "com.example.DataSaver.test"] }); await delay(200);
        
        appendLog(`[${dev}] Step 6: Sending HOME key...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "input keyevent KEYCODE_HOME"] });
        appendLog(`[${dev}] ✓ SUCCESS`);
      } catch (e: any) {
        appendLog(`[${dev}] ✗ FAILED: ${e}`);
      }
    }
    appendLog("──── Complete ────");
    setLoading(false);
  };

  const connectWifi = async () => {
    if (selectedDevices.length === 0 || !ssid) return;
    setLoading(true);
    setLogExpanded(true);
    appendLog(`──── WiFi Setup: ${ssid} ────`);
    
    let apk: string;
    try {
      apk = await invoke("get_resource_path", { name: "WifiUtil.apk" });
    } catch (e) {
      appendLog(`ERROR: WifiUtil.apk not found. ${e}`);
      setLoading(false);
      return;
    }

    for (const dev of selectedDevices) {
      try {
        appendLog(`[${dev}] Installing WifiUtil...`);
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", apk] }); await delay(1000);
        appendLog(`[${dev}] Configuring network...`);
        const method = password
          ? `am instrument -e method addWpaPskNetwork -e ssid "${ssid}" -e psk "${password}" -w com.android.tradefed.utils.wifi/.WifiUtil`
          : `am instrument -e method addOpenNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`;
        await invoke("run_adb", { args: ["-s", dev, "shell", method] }); await delay(500);
        
        appendLog(`[${dev}] Associating & Saving...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] }); await delay(500);
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method saveConfiguration -w com.android.tradefed.utils.wifi/.WifiUtil`] }); await delay(500);
        
        appendLog(`[${dev}] Verifying connection...`);
        const status: string = await invoke("run_adb", { args: ["-s", dev, "shell", "dumpsys wifi | grep mNetworkInfo"] });
        appendLog(`[${dev}] Status: ${status.includes("CONNECTED/CONNECTED") ? "✓ Connected" : "⚠ Check HP"}`);
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
            {/* Actions */}
            <section>
              <h3 className="text-[13px] font-semibold mb-3 text-[var(--win-text-secondary)]">Actions</h3>
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={skipWz}
                  disabled={loading || selectedDevices.length === 0}
                  className="win-action-card"
                >
                  <div className="w-10 h-10 rounded-lg bg-[#0078d4] flex items-center justify-center">
                    <Play className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-[14px] font-semibold">Skip Setup Wizard</span>
                  <span className="win-badge bg-[rgba(255,255,255,0.06)] text-[var(--win-text-tertiary)]">
                    {selectedDevices.length} device(s)
                  </span>
                </button>

                <button
                  onClick={connectWifi}
                  disabled={loading || selectedDevices.length === 0 || !ssid}
                  className="win-action-card"
                >
                  <div className="w-10 h-10 rounded-lg bg-[#107c10] flex items-center justify-center">
                    <Wifi className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-[14px] font-semibold">Connect WiFi</span>
                  <span className="win-badge bg-[rgba(255,255,255,0.06)] text-[var(--win-text-tertiary)]">
                    {ssid || "No SSID"}
                  </span>
                </button>
              </div>
            </section>

            {/* ADB Exploit via COM */}
            <section className="mt-6">
              <h3 className="text-[13px] font-semibold mb-3 text-[var(--win-text-secondary)]">ADB Exploit (Virtual COM)</h3>
              <div className="win-card p-5 bg-[rgba(255,165,0,0.05)] border-[rgba(255,165,0,0.2)]">
                <div className="flex items-end gap-4">
                  <div className="flex-1">
                    <label className="block text-[12px] text-[var(--win-text-tertiary)] mb-2 uppercase tracking-tight font-bold">Select COM Port</label>
                    <select
                      value={selectedPort}
                      onChange={e => setSelectedPort(e.target.value)}
                      className="win-input !border-b-[var(--win-warning)] cursor-pointer"
                    >
                      {serialPorts.length === 0 ? (
                        <option value="">No ports detected</option>
                      ) : (
                        serialPorts.map(p => <option key={p} value={p}>{p}</option>)
                      )}
                    </select>
                  </div>
                  <button
                    onClick={sendAT}
                    disabled={loading || !selectedPort}
                    className="win-btn-accent !bg-[var(--win-warning)] !text-black hover:!opacity-90 flex items-center gap-2 h-[38px] px-6"
                  >
                    <Zap className="w-4 h-4" />
                    Force Enable ADB
                  </button>
                </div>
                <p className="text-[11px] text-[var(--win-text-disabled)] mt-3">
                  Use this if 'adb devices' is empty. Requires Samsung Mobile USB Modem port.
                </p>
              </div>
            </section>
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
