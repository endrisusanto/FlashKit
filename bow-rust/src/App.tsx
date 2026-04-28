import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Play, Wifi, Smartphone, Check, Zap, Terminal, CheckCircle, Settings } from "lucide-react";

export default function App() {
  const [devices, setDevices] = useState<string[]>([]);
  const [deviceDetails, setDeviceDetails] = useState<Record<string, any>>({});
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [ssid, setSsid] = useState("2");
  const [password, setPassword] = useState("1234qwer");

  const appendLog = (msg: string) => setLogs(prev => [...prev, msg]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const refreshDevices = async () => {
    setLoading(true);
    appendLog("Scanning COM ports & Modems...");
    
    try {
      const samsungPorts: string[] = await invoke("get_samsung_ports");
      if (samsungPorts.length > 0) {
        appendLog(`[Auto] Detected ${samsungPorts.length} Samsung Modem(s). Waking up ADB...`);
        // Parallel AT Exploit to all ports
        await Promise.all(samsungPorts.map(async (port) => {
          await sendAT(true, port);
        }));
        await delay(2000);
      }
    } catch (e) {
      console.error("Modem scan failed", e);
    }

    appendLog("Scanning ADB devices...");
    try {
      const list: string[] = await invoke("get_devices");
      setDevices(list);
      
      // PARALLEL FETCHING
      const details: Record<string, any> = {};
      await Promise.all(list.map(async (id) => {
        try {
          const info: any = await invoke("get_device_info", { serial: id });
          details[id] = info;
        } catch (e) {
          console.error(`Failed to get info for ${id}`, e);
        }
      }));
      setDeviceDetails(details);
      
      if (selectedDevices.length === 0) setSelectedDevices(list);
      appendLog(`Found ${list.length} ADB device(s)`);
    } catch (e: any) {
      appendLog(`ERROR: ${e}`);
    }
    setLoading(false);
  };

  const sendAT = async (silent = false, portOverride?: string) => {
    let portToUse = portOverride;
    if (!portToUse) {
      const auto: string[] = await invoke("get_samsung_ports");
      if (auto.length > 0) portToUse = auto[0];
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

    appendLog("Phase 1: Initializing Force AT Exploit (Multi-Modem)...");
    try {
      const samsungPorts: string[] = await invoke("get_samsung_ports");
      if (samsungPorts.length > 0) {
        await Promise.all(samsungPorts.map(p => sendAT(false, p)));
        await delay(2000);
      }
    } catch (e) {}

    const list: string[] = await invoke("get_devices");
    setDevices(list);
    const activeDevices = list.length > 0 ? list : selectedDevices;

    if (activeDevices.length === 0) {
      appendLog("✗ No devices found. Check connection.");
      setLoading(false);
      return;
    }

    appendLog("Phase 2: FULL WZ SKIP (PARALLEL)");
    
    let apkData: string;
    let apkDataTest: string;
    try {
      apkData = await invoke("get_resource_path", { name: "Data_Saver_Test-debug.apk" });
      apkDataTest = await invoke("get_resource_path", { name: "Data_Saver_Test-debug-androidTest.apk" });
    } catch (e) {
      appendLog(`ERROR: Resources missing. ${e}`);
      setLoading(false);
      return;
    }

    // PARALLEL EXECUTION
    await Promise.all(activeDevices.map(async (dev) => {
      appendLog(`[${dev}] Starting process...`);
      try {
        const run = async (args: string[]) => {
          await invoke("run_adb", { args: ["-s", dev, "shell", ...args] });
          await delay(100); // Micro-delay to prevent UI freeze
        };

        await run(["settings put global system_locales en-US"]);
        await run(["settings put system system_locales en-US"]);
        await run(["settings put global stay_on_while_plugged_in 7"]);
        await run(["settings put global device_provisioned 1"]);
        await run(["settings put secure user_setup_complete 1"]);
        await run(["settings put global verifier_verify_adb_installs 0"]); // Disable verify apps over USB
        await run(["settings put system samsung_eula_agree 1"]);
        await run(["settings put system screen_off_timeout 600000"]);
        await run(["settings put system time_12_24 12"]);
        await run(["locksettings set-disabled true"]);
        
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apkData] });
        await delay(200);
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apkDataTest] });
        await delay(200);
        
        await invoke("run_adb", { args: ["-s", dev, "shell", "am instrument -w -m -e debug false -e class 'com.example.DataSaver.ExampleInstrumentedTest' com.example.DataSaver.test/androidx.test.runner.AndroidJUnitRunner"] });
        await delay(500);
        
        await run(["pm disable-user com.sec.android.app.SecSetupWizard"]);
        await run(["pm disable-user com.google.android.setupwizard"]);
        
        await invoke("run_adb", { args: ["-s", dev, "uninstall", "com.example.DataSaver"] });
        await delay(100);
        await invoke("run_adb", { args: ["-s", dev, "uninstall", "com.example.DataSaver.test"] });
        await delay(100);
        
        await run(["svc wifi enable"]);
        await run(["settings put global wifi_on 1"]);
        await run(["input keyevent KEYCODE_HOME"]);
        appendLog(`[${dev}] ✓ SUCCESS`);
      } catch (e: any) {
        appendLog(`[${dev}] ✗ FAILED: ${e}`);
      }
    }));

    appendLog("──── Parallel Processing Complete ────");
    setLoading(false);
  };

  const setupPrecondition = async () => {
    const activeDevices = selectedDevices.length > 0 ? selectedDevices : devices;
    if (activeDevices.length === 0) {
      appendLog("✗ No devices selected.");
      return;
    }
    setLoading(true);
    appendLog("──── Setup Precondition (Parallel) ────");
    
    await Promise.all(activeDevices.map(async (dev) => {
      try {
        const run = async (args: string[]) => {
          await invoke("run_adb", { args: ["-s", dev, "shell", ...args] });
          await delay(100);
        };

        await run(["settings put global development_settings_enabled 1"]);
        await run(["settings put global adb_enabled 1"]);
        await run(["settings put global verifier_verify_adb_installs 0"]); // Disable verify apps over USB
        
        // USB MTP Retry Logic
        let usbSuccess = false;
        for (let i = 0; i < 3; i++) {
          try {
            await invoke("run_adb", { args: ["-s", dev, "shell", "svc usb setFunctions mtp"] });
            usbSuccess = true;
            break;
          } catch (e) {
            await delay(1000);
          }
        }
        if (!usbSuccess) appendLog(`[${dev}] ⚠ USB MTP failed after retries`);

        await run(["settings put system screen_off_timeout 600000"]);
        await run(["settings put system time_12_24 12"]);
        await run(["locksettings set-disabled true"]);
        await run(["svc wifi enable"]);
        appendLog(`[${dev}] ✓ GBA & Dev Settings Applied`);
      } catch (e: any) {
        appendLog(`[${dev}] ✗ ${e}`);
      }
    }));
    
    appendLog("──── Complete ────");
    setLoading(false);
  };

  const connectWifi = async () => {
    setLoading(true);
    
    const activeDevices = selectedDevices.length > 0 ? selectedDevices : devices;
    if (activeDevices.length === 0 || !ssid) {
      appendLog("✗ No devices or SSID.");
      setLoading(false);
      return;
    }

    appendLog(`──── WiFi Setup (Parallel + Hidden): ${ssid} ────`);
    
    let apk: string;
    try {
      apk = await invoke("get_resource_path", { name: "WifiUtil.apk" });
    } catch (e) {
      appendLog(`ERROR: WifiUtil.apk missing. ${e}`);
      setLoading(false);
      return;
    }

    await Promise.all(activeDevices.map(async (dev) => {
      try {
        appendLog(`[${dev}] Enabling WiFi...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] });
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apk] });
        
        // Added -e hidden true for hidden networks
        const method = password
          ? `am instrument -e method addWpaPskNetwork -e ssid "${ssid}" -e psk "${password}" -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`
          : `am instrument -e method addOpenNetwork -e ssid "${ssid}" -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`;
        
        await invoke("run_adb", { args: ["-s", dev, "shell", method] });
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method saveConfiguration -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        
        const status: string = await invoke("run_adb", { args: ["-s", dev, "shell", "dumpsys wifi | grep mNetworkInfo"] });
        appendLog(`[${dev}] Status: ${status.includes("CONNECTED/CONNECTED") ? "✓ Connected" : "⚠ Check HP"}`);
      } catch (e: any) {
        appendLog(`[${dev}] ✗ ${e}`);
      }
    }));

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
          <span className="text-[11px] px-2 py-0.5 rounded bg-[rgba(255,255,255,0.05)] text-[var(--win-text-tertiary)]">v1.2.2</span>
          <button onClick={() => refreshDevices()} className="p-2 hover:bg-[rgba(255,255,255,0.08)] rounded-md transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[var(--win-accent)]' : ''}`} />
          </button>
        </div>
      </header>

      {/* ── DASHBOARD CONTENT ── */}
      <main className="flex-1 flex min-h-0 p-4 gap-4 overflow-hidden">
        
        {/* Left: Device List */}
        <div className="w-96 flex flex-col gap-3 shrink-0">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[13px] font-semibold text-[var(--win-text-secondary)] uppercase tracking-tighter">Device Management ({devices.length})</h3>
            <button 
              onClick={refreshDevices}
              className="text-[11px] text-[var(--win-accent)] hover:underline font-medium uppercase"
            >
              Scan
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto pr-1 space-y-3 custom-scrollbar">
            {devices.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-30 gap-3 grayscale win-card">
                <Smartphone className="w-10 h-10" />
                <span className="text-[12px] font-bold uppercase">No Devices Ready</span>
              </div>
            ) : (
              <div className="space-y-2">
                <button 
                  onClick={selectAll}
                  className="w-full flex items-center justify-between px-4 py-2 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[var(--win-border)] hover:bg-[rgba(255,255,255,0.06)] transition-all"
                >
                  <span className="text-[11px] font-bold text-[var(--win-text-tertiary)] uppercase">Select All Available</span>
                  <div className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${selectedDevices.length === devices.length ? 'bg-[var(--win-accent)] border-[var(--win-accent)]' : 'border-[rgba(255,255,255,0.3)]'}`}>
                    {selectedDevices.length === devices.length && <Check className="w-3 h-3 text-black font-extrabold" />}
                  </div>
                </button>
                
                {devices.map(id => (
                  <div
                    key={id}
                    onClick={() => toggleDevice(id)}
                    className={`relative w-full flex items-center gap-4 px-4 py-4 rounded-xl border transition-all cursor-pointer group ${selectedDevices.includes(id) ? 'bg-[rgba(0,120,212,0.12)] border-[var(--win-accent)] shadow-[0_4px_12px_rgba(0,0,0,0.2)]' : 'bg-[rgba(255,255,255,0.02)] border-[var(--win-border)] hover:border-[rgba(255,255,255,0.2)]'}`}
                  >
                    <div className={`w-6 h-6 rounded-md border flex items-center justify-center transition-all shrink-0 ${selectedDevices.includes(id) ? 'bg-[var(--win-accent)] border-[var(--win-accent)] scale-110' : 'border-[rgba(255,255,255,0.2)] group-hover:border-[var(--win-accent)]'}`}>
                      {selectedDevices.includes(id) && <Check className="w-4 h-4 text-black font-black" />}
                    </div>
                    
                    <div className="flex flex-col min-w-0 flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[14px] font-bold text-[var(--win-text-primary)] truncate tracking-tight">{deviceDetails[id]?.['ro.product.model'] || id}</span>
                        <span className="text-[10px] text-[var(--win-accent)] font-black opacity-80">#{id.slice(-4)}</span>
                      </div>
                      <div className="grid grid-cols-1 gap-1 opacity-70">
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-black bg-[rgba(255,255,255,0.05)] px-1.5 py-0.5 rounded text-[var(--win-text-tertiary)]">PDA</span>
                          <span className="text-[10px] font-semibold truncate">{deviceDetails[id]?.['ro.build.PDA'] || 'N/A'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-black bg-[rgba(255,255,255,0.05)] px-1.5 py-0.5 rounded text-[var(--win-text-tertiary)]">CSC</span>
                          <span className="text-[10px] font-semibold truncate">{deviceDetails[id]?.['ro.csc.sales_code'] || 'N/A'} ({deviceDetails[id]?.['ro.csc.country_code'] || '??'})</span>
                        </div>
                      </div>
                    </div>
                  </div>
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

          <div className="win-card bg-[rgba(0,0,0,0.2)] border-[var(--win-border)] p-6">
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
          </div>

          {/* ── LOG PANEL ── */}
          <div className={`win-card flex flex-col bg-black border-[var(--win-border)] transition-all duration-300 flex-1 min-h-0`}>
            <div className="flex items-center justify-between px-4 h-10 border-b border-[var(--win-border)] shrink-0">
              <div className="flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-[var(--win-accent)]" />
                <span className="text-[11px] font-bold uppercase tracking-widest">System Log</span>
              </div>
              <button 
                onClick={() => setLogs([])}
                className="text-[10px] text-[var(--win-text-disabled)] hover:text-white uppercase font-bold"
              >
                Clear
              </button>
            </div>
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
