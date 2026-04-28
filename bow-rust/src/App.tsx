import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Play, Wifi, Smartphone, Check, Zap, Terminal, ChevronDown, ChevronUp, CheckCircle, Settings } from "lucide-react";

export default function App() {
  const [devices, setDevices] = useState<string[]>([]);
  const [deviceDetails, setDeviceDetails] = useState<Record<string, any>>({});
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
    appendLog("Scanning COM ports & Modems...");
    
    // 1. Detect and Force AT Exploit Silently first
    try {
      const ports: string[] = await invoke("get_serial_ports");
      setSerialPorts(ports);
      const autoPort: string | null = await invoke("get_samsung_port");
      if (autoPort) {
        setSelectedPort(autoPort);
        appendLog(`[Auto] Samsung Modem detected on ${autoPort}. Waking up ADB...`);
        // Kirim AT Exploit tanpa log berlebihan
        await sendAT(true); 
        await delay(2000); // Tunggu ADB bangun
      } else {
        if (ports.length > 0 && !selectedPort) setSelectedPort(ports[0]);
      }
    } catch (e) {
      console.error("Modem scan failed", e);
    }

    appendLog("Scanning ADB devices...");
    try {
      const list: string[] = await invoke("get_devices");
      setDevices(list);
      
      const details: Record<string, any> = {};
      for (const id of list) {
        try {
          const info: any = await invoke("get_device_info", { serial: id });
          details[id] = info;
        } catch (e) {
          console.error(`Failed to get info for ${id}`, e);
        }
      }
      setDeviceDetails(details);
      
      if (selectedDevices.length === 0) setSelectedDevices(list);
      appendLog(`Found ${list.length} ADB device(s)`);
    } catch (e: any) {
      appendLog(`ERROR: ${e}`);
    }
    setLoading(false);
  };

  const sendAT = async (silent = false) => {
    let portToUse = selectedPort;
    if (!portToUse) {
      const auto: string | null = await invoke("get_samsung_port");
      if (auto) portToUse = auto;
    }

    if (!portToUse) {
      if (!silent) appendLog("✗ No COM port detected for AT Exploit.");
      return false;
    }

    if (!silent) appendLog(`──── Sending AT Exploit to ${portToUse} ────`);
    
    const runCommandWithRetry = async (cmd: string, retries = 2) => {
      for (let i = 0; i <= retries; i++) {
        try {
          const resp: string = await invoke("send_at_command", { portName: portToUse, command: cmd });
          if (resp.includes("OK") || resp.includes("DONE") || resp.length > 0) return resp;
        } catch (e: any) {
          if (i === retries) throw e;
          await delay(1000);
        }
      }
      return "";
    };

    try {
      if (!silent) appendLog(`[${portToUse}] Sending AT+USBDEBUG=1...`);
      await runCommandWithRetry("AT+USBDEBUG=1");
      await delay(500);
      if (!silent) appendLog(`[${portToUse}] Sending AT+ENGMODES=1,2,0...`);
      await runCommandWithRetry("AT+ENGMODES=1,2,0");
      if (!silent) appendLog(`[${portToUse}] ✓ Exploit Sent.`);
      return true;
    } catch (e: any) {
      if (!silent) appendLog(`[${portToUse}] ✗ AT Failed: ${e}`);
      return false;
    }
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
    setLoading(true);
    setLogExpanded(true);

    // Default Force AT Command
    appendLog("Phase 1: Initializing Force AT Exploit...");
    await sendAT(false);
    await delay(2000); // Wait for ADB to wake up

    const list: string[] = await invoke("get_devices");
    setDevices(list);
    const activeDevices = list.length > 0 ? list : selectedDevices;

    if (activeDevices.length === 0) {
      appendLog("✗ No devices found even after AT Exploit. Please check connection.");
      setLoading(false);
      return;
    }

    appendLog("Phase 2: FULL WZ SKIP (BOW ALGORITHM)");
    
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

    for (const dev of activeDevices) {
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
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apkData] }); await delay(500);
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apkDataTest] }); await delay(500);
        
        appendLog(`[${dev}] Step 3: Triggering exploit...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "am instrument -w -m -e debug false -e class 'com.example.DataSaver.ExampleInstrumentedTest' com.example.DataSaver.test/androidx.test.runner.AndroidJUnitRunner"] });
        await delay(1000);
        
        appendLog(`[${dev}] Step 4: Disabling Setup Wizards...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "pm disable-user com.sec.android.app.SecSetupWizard"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "pm disable-user com.google.android.setupwizard"] }); await delay(200);
        
        appendLog(`[${dev}] Step 5: Cleaning up...`);
        await invoke("run_adb", { args: ["-s", dev, "uninstall", "com.example.DataSaver"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "uninstall", "com.example.DataSaver.test"] }); await delay(200);
        
        appendLog(`[${dev}] Step 6: Enabling WiFi & Sending HOME key...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put global wifi_on 1"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "input keyevent KEYCODE_HOME"] });
        appendLog(`[${dev}] ✓ SUCCESS`);
      } catch (e: any) {
        appendLog(`[${dev}] ✗ FAILED: ${e}`);
      }
    }
    appendLog("──── Complete ────");
    setLoading(false);
  };

  const setupPrecondition = async () => {
    if (selectedDevices.length === 0) {
      const list: string[] = await invoke("get_devices");
      if (list.length === 0) {
        appendLog("✗ No devices selected.");
        return;
      }
    }
    setLoading(true);
    setLogExpanded(true);
    appendLog("──── Setup Precondition GBA Test ────");
    for (const dev of selectedDevices.length > 0 ? selectedDevices : devices) {
      appendLog(`[${dev}] Applying GBA Preconditions...`);
      try {
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put system screen_off_timeout 600000"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "settings put system time_12_24 12"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "locksettings set-disabled true"] }); await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] }); await delay(200);
        appendLog(`[${dev}] ✓ GBA Settings Applied`);
      } catch (e: any) {
        appendLog(`[${dev}] ✗ ${e}`);
      }
    }
    appendLog("──── Complete ────");
    setLoading(false);
  };

  const connectWifi = async () => {
    setLoading(true);
    setLogExpanded(true);
    
    const activeDevices = selectedDevices.length > 0 ? selectedDevices : devices;
    if (activeDevices.length === 0 || !ssid) {
      appendLog("✗ No devices or SSID.");
      setLoading(false);
      return;
    }

    appendLog(`──── WiFi Setup: ${ssid} ────`);
    
    let apk: string;
    try {
      apk = await invoke("get_resource_path", { name: "WifiUtil.apk" });
    } catch (e) {
      appendLog(`ERROR: WifiUtil.apk not found. ${e}`);
      setLoading(false);
      return;
    }

    for (const dev of activeDevices) {
      try {
        appendLog(`[${dev}] Ensuring WiFi is ON...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] }); await delay(500);

        appendLog(`[${dev}] Installing WifiUtil...`);
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apk] }); await delay(1000);
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
          <span className="text-[12px] font-bold tracking-widest uppercase opacity-80">FlashKit ⚡</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-2 py-0.5 rounded bg-[rgba(255,255,255,0.05)] text-[var(--win-text-tertiary)]">v1.1.4</span>
          <button onClick={() => window.location.reload()} className="p-2 hover:bg-[rgba(255,255,255,0.08)] rounded-md transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[var(--win-accent)]' : ''}`} />
          </button>
        </div>
      </header>

      {/* ── DASHBOARD CONTENT ── */}
      <main className="flex-1 flex min-h-0 p-4 gap-4 overflow-hidden">
        
        {/* Left: Device List */}
        <div className="w-96 flex flex-col gap-3 shrink-0">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[13px] font-semibold text-[var(--win-text-secondary)]">Devices ({devices.length})</h3>
            <button 
              onClick={refreshDevices}
              className="text-[11px] text-[var(--win-accent)] hover:underline font-medium"
            >
              Refresh
            </button>
          </div>
          
          <div className="flex-1 win-card overflow-y-auto p-2 bg-[rgba(255,255,255,0.02)]">
            {devices.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-30 gap-3 grayscale">
                <Smartphone className="w-10 h-10" />
                <span className="text-[12px]">No devices detected</span>
              </div>
            ) : (
              <div className="space-y-1">
                <button 
                  onClick={selectAll}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-[rgba(255,255,255,0.05)] transition-colors text-left"
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${selectedDevices.length === devices.length ? 'bg-[var(--win-accent)] border-[var(--win-accent)]' : 'border-[rgba(255,255,255,0.3)]'}`}>
                    {selectedDevices.length === devices.length && <Check className="w-3 h-3 text-black font-bold" />}
                  </div>
                  <span className="text-[13px] font-semibold">Select All</span>
                </button>
                <div className="h-[1px] bg-[var(--win-border)] my-2 mx-2" />
                {devices.map(id => (
                  <button
                    key={id}
                    onClick={() => toggleDevice(id)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-[rgba(255,255,255,0.08)] transition-all group border border-transparent hover:border-[rgba(255,255,255,0.05)]"
                  >
                    <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors shrink-0 ${selectedDevices.includes(id) ? 'bg-[var(--win-accent)] border-[var(--win-accent)]' : 'border-[rgba(255,255,255,0.2)] group-hover:border-[var(--win-accent)]'}`}>
                      {selectedDevices.includes(id) && <Check className="w-3.5 h-3.5 text-black font-bold" />}
                    </div>
                    <div className="flex flex-col min-w-0 flex-1 ml-2 text-left">
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-bold text-[var(--win-text-primary)] truncate">{deviceDetails[id]?.['ro.product.model'] || id}</span>
                        <span className="text-[10px] text-[var(--win-accent)] font-bold">{id.slice(-4)}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 mt-1 opacity-60">
                        <span className="text-[10px] uppercase font-bold text-[var(--win-text-tertiary)]">PDA: {deviceDetails[id]?.['ro.build.PDA'] || 'N/A'}</span>
                        <span className="text-[10px] uppercase font-bold text-[var(--win-text-tertiary)] text-right">CSC: {deviceDetails[id]?.['ro.csc.sales_code'] || 'N/A'} ({deviceDetails[id]?.['ro.csc.country_code'] || '??'})</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Main Config & Actions */}
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          
          <div className="flex gap-4 shrink-0 overflow-x-auto pb-1">
            {/* WiFi Config */}
            <div className="win-card p-5 flex-1 min-w-[300px]">
              <div className="flex items-center gap-2 mb-4">
                <Wifi className="w-4 h-4 text-[var(--win-accent)]" />
                <h3 className="text-[13px] font-bold uppercase tracking-tight">WiFi Configuration</h3>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-[var(--win-text-tertiary)] uppercase tracking-wider">SSID</label>
                  <input 
                    value={ssid}
                    onChange={e => setSsid(e.target.value)}
                    className="win-input"
                    placeholder="WIFI Name"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-[var(--win-text-tertiary)] uppercase tracking-wider">Password</label>
                  <input 
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="win-input"
                    placeholder="••••••••"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 win-card bg-[rgba(0,0,0,0.2)] border-[var(--win-border)] p-6 overflow-y-auto">
            {/* Actions */}
            <section>
              <h3 className="text-[13px] font-semibold mb-3 text-[var(--win-text-secondary)]">Actions</h3>
              <div className="grid grid-cols-3 gap-4">
                <button
                  onClick={skipWz}
                  disabled={loading}
                  className="win-action-card"
                >
                  <div className="w-10 h-10 rounded-lg bg-[#0078d4] flex items-center justify-center">
                    <Play className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-[14px] font-semibold">Skip Wizard</span>
                  <span className="win-badge bg-[rgba(255,255,255,0.06)] text-[var(--win-text-tertiary)]">
                    Force AT Mode
                  </span>
                </button>

                <button
                  onClick={setupPrecondition}
                  disabled={loading}
                  className="win-action-card"
                >
                  <div className="w-10 h-10 rounded-lg bg-[#6b21a8] flex items-center justify-center">
                    <CheckCircle className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-[14px] font-semibold">Setup GBA</span>
                  <span className="win-badge bg-[rgba(255,255,255,0.06)] text-[var(--win-text-tertiary)]">
                    Precondition
                  </span>
                </button>

                <button
                  onClick={connectWifi}
                  disabled={loading || !ssid}
                  className="win-action-card"
                >
                  <div className="w-10 h-10 rounded-lg bg-[#107c10] flex items-center justify-center">
                    <Wifi className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-[14px] font-semibold">WiFi Connect</span>
                  <span className="win-badge bg-[rgba(255,255,255,0.06)] text-[var(--win-text-tertiary)]">
                    Auto-Provision
                  </span>
                </button>
              </div>
            </section>

            {/* ADB Exploit via COM */}
            <section className="mt-8">
              <h3 className="text-[13px] font-semibold mb-3 text-[var(--win-text-secondary)]">ADB Exploit (Virtual COM)</h3>
              <div className="win-card p-5 bg-[rgba(255,165,0,0.05)] border-[rgba(255,165,0,0.2)]">
                <div className="flex items-end gap-4">
                  <div className="flex-1">
                    <label className="block text-[12px] text-[var(--win-text-tertiary)] mb-2 uppercase tracking-tight font-bold">Modem Port</label>
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
                    onClick={() => sendAT()}
                    disabled={loading || !selectedPort}
                    className="win-btn-accent !bg-[var(--win-warning)] !text-black hover:!opacity-90 flex items-center gap-2 h-[38px] px-6"
                  >
                    <Zap className="w-4 h-4" />
                    Force AT Exploit
                  </button>
                </div>
                <p className="text-[11px] text-[var(--win-text-disabled)] mt-3">
                  Automatic Samsung Modem detection is enabled.
                </p>
              </div>
            </section>
          </div>

          {/* ── LOG PANEL ── */}
          <div className={`win-card flex flex-col bg-black border-[var(--win-border)] transition-all duration-300 ${logExpanded ? 'h-64' : 'h-10'}`}>
            <button 
              onClick={() => setLogExpanded(!logExpanded)}
              className="flex items-center justify-between px-4 h-10 border-b border-[var(--win-border)] hover:bg-[rgba(255,255,255,0.03)] shrink-0"
            >
              <div className="flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-[var(--win-accent)]" />
                <span className="text-[11px] font-bold uppercase tracking-widest">System Log</span>
              </div>
              {logExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed select-text cursor-text">
              {logs.length === 0 ? (
                <span className="opacity-30">Waiting for commands...</span>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="mb-1">
                    <span className="text-[var(--win-text-disabled)] mr-2">[{new Date().toLocaleTimeString()}]</span>
                    <span className={log.startsWith('ERROR') || log.includes('✗') ? 'text-[var(--win-error)]' : log.includes('✓') ? 'text-[var(--win-success)]' : ''}>
                      {log}
                    </span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </main>

      {/* ── STATUS BAR ── */}
      <footer className="h-8 bg-[var(--win-bg-smoke)] border-t border-[var(--win-border)] flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${devices.length > 0 ? 'bg-[var(--win-success)] shadow-[0_0_8px_rgba(39,174,96,0.5)]' : 'bg-[var(--win-text-disabled)]'}`} />
            <span className="text-[10px] font-semibold text-[var(--win-text-secondary)] uppercase">{devices.length > 0 ? `${devices.length} Device(s) Ready` : 'No Device Connected'}</span>
          </div>
          <div className="h-3 w-[1px] bg-[var(--win-border)]" />
          <div className="flex items-center gap-1.5 text-[var(--win-text-tertiary)]">
            <Settings className="w-3 h-3" />
            <span className="text-[10px] font-semibold uppercase">ADB: Stable</span>
          </div>
        </div>
        <div className="text-[10px] font-bold text-[var(--win-accent)] uppercase tracking-tighter">
          FlashKit Professional Provisioning
        </div>
      </footer>
    </div>
  );
}
