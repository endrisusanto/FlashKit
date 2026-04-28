import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Play, Wifi, Smartphone, Check, Zap, Terminal, CheckCircle } from "lucide-react";

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

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  const refreshDevices = async () => {
    setLoading(true);
    appendLog("Scanning COM ports & Modems...");
    
    try {
      const samsungPorts: string[] = await invoke("get_samsung_ports");
      if (samsungPorts.length > 0) {
        appendLog(`[Auto] Detected ${samsungPorts.length} Samsung Modem(s). Waking up ADB...`);
        await Promise.all(samsungPorts.map(port => sendAT(true, port)));
        await delay(2000);
      }
    } catch (e) { console.error(e); }

    appendLog("Scanning ADB devices...");
    try {
      const list: string[] = await invoke("get_devices");
      setDevices(list);
      const details: Record<string, any> = {};
      await Promise.all(list.map(async (id) => {
        try {
          const info: any = await invoke("get_device_info", { serial: id });
          details[id] = info;
        } catch (e) { console.error(e); }
      }));
      setDeviceDetails(details);
      if (selectedDevices.length === 0) setSelectedDevices(list);
      appendLog(`Found ${list.length} device(s)`);
    } catch (e: any) { appendLog(`ERROR: ${e}`); }
    setLoading(false);
  };

  const sendAT = async (silent = false, portOverride?: string) => {
    let portToUse = portOverride;
    if (!portToUse) {
      const auto: string[] = await invoke("get_samsung_ports");
      if (auto.length > 0) portToUse = auto[0];
    }
    if (!portToUse) {
      if (!silent) appendLog("✗ No COM port detected.");
      return false;
    }

    const runWithRetry = async (cmd: string) => {
      for (let i = 0; i < 2; i++) {
        try {
          await invoke("send_at_command", { portName: portToUse, command: cmd });
          return true;
        } catch (e) { await delay(1000); }
      }
      return false;
    };

    try {
      if (!silent) appendLog(`[${portToUse}] Sending Exploit...`);
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

  const skipWz = async () => {
    setLoading(true);
    appendLog("Phase 1: Initializing Force AT Exploit...");
    const ports: string[] = await invoke("get_samsung_ports");
    if (ports.length > 0) {
      await Promise.all(ports.map(p => sendAT(false, p)));
      await delay(2500);
    }

    const list: string[] = await invoke("get_devices");
    const active = list.length > 0 ? list : selectedDevices;
    if (active.length === 0) {
      appendLog("✗ No devices found.");
      setLoading(false);
      return;
    }

    let apkData: string, apkTest: string;
    try {
      apkData = await invoke("get_resource_path", { name: "Data_Saver_Test-debug.apk" });
      apkTest = await invoke("get_resource_path", { name: "Data_Saver_Test-debug-androidTest.apk" });
    } catch (e) {
      appendLog(`ERROR: APKs missing. ${e}`);
      setLoading(false);
      return;
    }

    await Promise.all(active.map(async (dev) => {
      appendLog(`[${dev}] Processing...`);
      try {
        const run = async (args: string[]) => { await invoke("run_adb", { args: ["-s", dev, "shell", ...args] }); await delay(100); };
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
        await run(["svc wifi enable"]);
        await run(["settings put global wifi_on 1"]);
        await run(["input keyevent KEYCODE_HOME"]);
        appendLog(`[${dev}] ✓ SUCCESS`);
      } catch (e: any) { appendLog(`[${dev}] ✗ ${e}`); }
    }));
    setLoading(false);
  };

  const setupPrecondition = async () => {
    const active = selectedDevices.length > 0 ? selectedDevices : devices;
    if (active.length === 0) { appendLog("✗ No devices."); return; }
    setLoading(true);
    appendLog("──── Setup Precondition (Parallel) ────");
    await Promise.all(active.map(async (dev) => {
      try {
        const run = async (args: string[]) => { await invoke("run_adb", { args: ["-s", dev, "shell", ...args] }); await delay(100); };
        await run(["settings put global development_settings_enabled 1"]);
        await run(["settings put global adb_enabled 1"]);
        await run(["settings put global verifier_verify_adb_installs 0"]);
        for (let i = 0; i < 3; i++) {
          try { await invoke("run_adb", { args: ["-s", dev, "shell", "svc usb setFunctions mtp"] }); break; } 
          catch { await delay(1000); }
        }
        await run(["settings put system screen_off_timeout 600000"]);
        await run(["settings put system time_12_24 12"]);
        await run(["locksettings set-disabled true"]);
        await run(["svc wifi enable"]);
        appendLog(`[${dev}] ✓ OK`);
      } catch (e: any) { appendLog(`[${dev}] ✗ ${e}`); }
    }));
    setLoading(false);
  };

  const connectWifi = async () => {
    const active = selectedDevices.length > 0 ? selectedDevices : devices;
    if (active.length === 0 || !ssid) { appendLog("✗ No devices/SSID."); return; }
    setLoading(true);
    appendLog(`──── WiFi Setup: ${ssid} ────`);
    let apk: string;
    try { apk = await invoke("get_resource_path", { name: "WifiUtil.apk" }); } catch (e) { appendLog(`ERR: ${e}`); setLoading(false); return; }
    await Promise.all(active.map(async (dev) => {
      try {
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] });
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apk] });
        const m = password ? `addWpaPskNetwork -e ssid "${ssid}" -e psk "${password}"` : `addOpenNetwork -e ssid "${ssid}"`;
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method ${m} -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method saveConfiguration -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        appendLog(`[${dev}] ✓ WiFi Configured`);
      } catch (e: any) { appendLog(`[${dev}] ✗ ${e}`); }
    }));
    setLoading(false);
  };

  const toggleDevice = (id: string) => setSelectedDevices(p => p.includes(id) ? p.filter(d => d !== id) : [...p, id]);
  const selectAll = () => setSelectedDevices(selectedDevices.length === devices.length ? [] : [...devices]);

  return (
    <div className="flex flex-col h-screen bg-[var(--win-bg-solid)] overflow-hidden rounded-xl border border-[var(--win-border)]">
      {/* ── TITLEBAR ── */}
      <header className="flex items-center px-6 h-12 bg-[var(--win-bg-smoke)] border-b border-[var(--win-border)] shrink-0" data-tauri-drag-region>
        <Zap className="w-5 h-5 text-[var(--win-accent)] mr-3" />
        <span className="text-[12px] font-bold tracking-widest uppercase opacity-80">FlashKit ⚡ v1.2.3</span>
        <div className="flex-1" />
        <button onClick={refreshDevices} className="p-2 hover:bg-[rgba(255,255,255,0.08)] rounded-md">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[var(--win-accent)]' : ''}`} />
        </button>
      </header>

      <main className="flex-1 flex min-h-0 p-4 gap-4 overflow-hidden">
        {/* Left: Device Cards */}
        <div className="w-96 flex flex-col gap-3 shrink-0">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[11px] font-bold text-[var(--win-text-secondary)] uppercase">Devices ({devices.length})</h3>
            <button onClick={selectAll} className="text-[10px] text-[var(--win-accent)] font-bold uppercase hover:underline">
              {selectedDevices.length === devices.length ? "Deselect All" : "Select All"}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
            {devices.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-20 gap-3 border border-dashed border-[var(--win-border)] rounded-xl">
                <Smartphone className="w-10 h-10" />
                <span className="text-[10px] font-bold uppercase">No Devices Detected</span>
              </div>
            ) : (
              devices.map(id => (
                <div key={id} onClick={() => toggleDevice(id)} className={`p-4 rounded-xl border transition-all cursor-pointer ${selectedDevices.includes(id) ? 'bg-[rgba(0,120,212,0.15)] border-[var(--win-accent)] shadow-lg' : 'bg-[rgba(255,255,255,0.02)] border-[var(--win-border)] hover:border-[rgba(255,255,255,0.2)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[13px] font-bold truncate pr-2">{deviceDetails[id]?.['ro.product.model'] || id}</span>
                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${selectedDevices.includes(id) ? 'bg-[var(--win-accent)] border-[var(--win-accent)]' : 'border-[rgba(255,255,255,0.3)]'}`}>
                      {selectedDevices.includes(id) && <Check className="w-3 h-3 text-black font-black" />}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col"><span className="text-[9px] opacity-40 uppercase font-black">PDA</span><span className="text-[10px] font-mono truncate">{deviceDetails[id]?.['ro.build.PDA'] || 'N/A'}</span></div>
                    <div className="flex flex-col items-end"><span className="text-[9px] opacity-40 uppercase font-black">CSC</span><span className="text-[10px] font-mono">{deviceDetails[id]?.['ro.csc.sales_code'] || 'N/A'}</span></div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: Dashboard */}
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          {/* WiFi Card */}
          <div className="win-card p-5 shrink-0">
            <div className="flex items-center gap-2 mb-4"><Wifi className="w-4 h-4 text-[var(--win-accent)]" /><span className="text-[11px] font-bold uppercase">WiFi Configuration</span></div>
            <div className="grid grid-cols-2 gap-4">
              <input value={ssid} onChange={e => setSsid(e.target.value)} className="win-input" placeholder="SSID" />
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="win-input" placeholder="Password" />
            </div>
          </div>

          {/* Action Grid */}
          <div className="win-card p-5 bg-[rgba(0,0,0,0.1)]">
            <h3 className="text-[11px] font-bold mb-4 opacity-50 uppercase">Device Actions</h3>
            <div className="grid grid-cols-3 gap-4">
              <button onClick={skipWz} disabled={loading} className="win-action-card h-24 flex flex-col items-center justify-center gap-2">
                <Play className="w-6 h-6 text-[#0078d4]" />
                <span className="text-[12px] font-bold">Skip Wizard</span>
              </button>
              <button onClick={setupPrecondition} disabled={loading} className="win-action-card h-24 flex flex-col items-center justify-center gap-2">
                <CheckCircle className="w-6 h-6 text-[#6b21a8]" />
                <span className="text-[12px] font-bold">Setup GBA</span>
              </button>
              <button onClick={connectWifi} disabled={loading} className="win-action-card h-24 flex flex-col items-center justify-center gap-2">
                <Wifi className="w-6 h-6 text-[#107c10]" />
                <span className="text-[12px] font-bold">WiFi Connect</span>
              </button>
            </div>
          </div>

          {/* System Log */}
          <div className="flex-1 win-card bg-black border-[var(--win-border)] flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center justify-between px-4 h-10 border-b border-[var(--win-border)]">
              <div className="flex items-center gap-2"><Terminal className="w-3 h-3 text-[var(--win-accent)]" /><span className="text-[10px] font-bold uppercase">System Log</span></div>
              <button onClick={() => setLogs([])} className="text-[9px] opacity-50 hover:opacity-100 font-bold">CLEAR</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] select-text">
              {logs.map((log, i) => (
                <div key={i} className="mb-1">
                  <span className="opacity-30 mr-2">[{new Date().toLocaleTimeString()}]</span>
                  <span className={log.includes('✗') || log.includes('ERR') ? 'text-red-400' : log.includes('✓') ? 'text-green-400' : ''}>{log}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </main>

      <footer className="h-8 bg-[var(--win-bg-smoke)] border-t border-[var(--win-border)] flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className={`w-2 h-2 rounded-full ${devices.length > 0 ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-gray-600'}`} />
          <span className="text-[10px] font-bold uppercase opacity-60">{devices.length} Device(s) Ready</span>
        </div>
        <span className="text-[10px] font-black tracking-tighter text-[var(--win-accent)] uppercase">FlashKit Professional</span>
      </footer>
    </div>
  );
}
