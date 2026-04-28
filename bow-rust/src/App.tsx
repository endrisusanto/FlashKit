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

    let apkData: string, apkTest: string, apkLang: string;
    try {
      apkData = await invoke("get_resource_path", { name: "Data_Saver_Test-debug.apk" });
      apkTest = await invoke("get_resource_path", { name: "Data_Saver_Test-debug-androidTest.apk" });
      apkLang = await invoke("get_resource_path", { name: "language.apk" });
    } catch (e) {
      appendLog(`ERROR: APKs missing. ${e}`);
      setLoading(false);
      return;
    }

    await Promise.all(active.map(async (dev) => {
      appendLog(`[${dev}] Processing...`);
      try {
        const run = async (args: string[]) => { await invoke("run_adb", { args: ["-s", dev, "shell", ...args] }); await delay(100); };
        
        // Use language.apk for English US (Correct Package Name)
        appendLog(`[${dev}] Language Enabler (net.sanapeli)...`);
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
        
        appendLog(`[${dev}] Installing Provisioning Tools...`);
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
    try { 
      apk = await invoke("get_resource_path", { name: "WifiUtil.apk" }); 
    } catch (e) { 
      appendLog(`ERR: ${e}`); 
      setLoading(false); 
      return; 
    }

    await Promise.all(active.map(async (dev) => {
      try {
        appendLog(`[${dev}] Preparing WifiUtil...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] });
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apk] });
        await delay(500);

        // 1. Add Network
        const addCmd = password 
          ? `am instrument -e method addWpaPskNetwork -e ssid "${ssid}" -e psk "${password}" -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`
          : `am instrument -e method addOpenNetwork -e ssid "${ssid}" -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`;
        
        appendLog(`[${dev}] Adding Network...`);
        const addResult: string = await invoke("run_adb", { args: ["-s", dev, "shell", addCmd] });
        
        let netId = "";
        const match = addResult.match(/result=(\d+)/);
        if (match && match[1]) {
          netId = match[1];
          appendLog(`[${dev}] Network ID: ${netId}`);
        } else {
          appendLog(`[${dev}] ⚠ Could not parse ID, trying SSID fallback...`);
        }

        // 2. Associate Network
        appendLog(`[${dev}] Associating...`);
        if (netId) {
          await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e id ${netId} -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        } else {
          await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        }
        await delay(500);

        // 3. Save Configuration
        appendLog(`[${dev}] Saving...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method saveConfiguration -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        
        await delay(2000); 
        const status: string = await invoke("run_adb", { args: ["-s", dev, "shell", "dumpsys wifi | grep mNetworkInfo"] });
        if (status.includes("CONNECTED/CONNECTED")) {
          appendLog(`[${dev}] ✓ WiFi CONNECTED`);
        } else {
          appendLog(`[${dev}] ⚠ Check device (Status: DISCONNECTED)`);
        }
      } catch (e: any) { 
        appendLog(`[${dev}] ✗ ${e}`); 
      }
    }));
    setLoading(false);
  };

  const toggleDevice = (id: string) => setSelectedDevices(p => p.includes(id) ? p.filter(d => d !== id) : [...p, id]);
  const selectAll = () => setSelectedDevices(selectedDevices.length === devices.length ? [] : [...devices]);

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-white overflow-hidden rounded-xl border border-[#222]">
      {/* ── TITLEBAR ── */}
      <header className="flex items-center px-6 h-12 bg-[#111] border-b border-[#222] shrink-0" data-tauri-drag-region>
        <Zap className="w-5 h-5 text-blue-500 mr-3 animate-pulse" />
        <span className="text-[12px] font-black tracking-widest uppercase opacity-80">FlashKit ⚡ v1.2.5</span>
        <div className="flex-1" />
        <button onClick={refreshDevices} className="p-2 hover:bg-white/10 rounded-md transition-all">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-500' : ''}`} />
        </button>
      </header>

      <main className="flex-1 flex min-h-0 p-5 gap-5 overflow-hidden">
        {/* Left: Device Cards */}
        <div className="w-96 flex flex-col gap-4 shrink-0">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-[10px] font-black text-white/40 uppercase tracking-widest">Device Pool ({devices.length})</h3>
            <button onClick={selectAll} className="text-[10px] text-blue-500 font-black uppercase hover:underline">
              {selectedDevices.length === devices.length ? "Deselect All" : "Select All"}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar p-1">
            {devices.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-10 gap-4 border-2 border-dashed border-white/20 rounded-2xl">
                <Smartphone className="w-12 h-12" />
                <span className="text-[10px] font-black uppercase tracking-widest">Awaiting Connections</span>
              </div>
            ) : (
              devices.map(id => (
                <div key={id} onClick={() => toggleDevice(id)} className={`p-5 rounded-2xl border-2 transition-all cursor-pointer group relative overflow-hidden ${selectedDevices.includes(id) ? 'bg-blue-600/10 border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.2)] scale-[1.02]' : 'bg-white/5 border-[#222] hover:border-white/20'}`}>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex flex-col min-w-0">
                      <span className="text-[14px] font-black truncate text-white leading-none mb-1">{deviceDetails[id]?.['ro.product.model'] || "SM-Model"}</span>
                      <span className="text-[10px] font-mono text-white/40">S/N: {id}</span>
                    </div>
                    <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${selectedDevices.includes(id) ? 'bg-blue-500 border-blue-500' : 'border-white/10 group-hover:border-white/30'}`}>
                      {selectedDevices.includes(id) && <Check className="w-4 h-4 text-white font-black" />}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
                    <div className="flex flex-col min-w-0">
                      <span className="text-[8px] font-black text-white/30 uppercase mb-1">PDA Version</span>
                      <span className="text-[10px] font-bold truncate text-blue-400">{deviceDetails[id]?.['ro.build.PDA'] || 'N/A'}</span>
                    </div>
                    <div className="flex flex-col min-w-0 items-end">
                      <span className="text-[8px] font-black text-white/30 uppercase mb-1">Region Info</span>
                      <span className="text-[10px] font-bold text-white/80">{deviceDetails[id]?.['ro.csc.sales_code'] || 'N/A'}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: Dashboard */}
        <div className="flex-1 flex flex-col gap-5 min-w-0">
          {/* WiFi Card */}
          <div className="p-6 rounded-2xl bg-white/5 border border-[#222]">
            <div className="flex items-center gap-3 mb-5"><Wifi className="w-5 h-5 text-green-500" /><span className="text-[11px] font-black uppercase tracking-widest">Network Config</span></div>
            <div className="grid grid-cols-2 gap-5">
              <input value={ssid} onChange={e => setSsid(e.target.value)} className="bg-black/50 border border-[#333] rounded-xl px-4 py-3 text-[12px] focus:border-green-500 outline-none transition-all" placeholder="SSID" />
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="bg-black/50 border border-[#333] rounded-xl px-4 py-3 text-[12px] focus:border-green-500 outline-none transition-all" placeholder="PASSWORD" />
            </div>
          </div>

          {/* Action Grid */}
          <div className="p-6 rounded-2xl bg-white/5 border border-[#222]">
            <h3 className="text-[10px] font-black mb-5 text-white/40 uppercase tracking-widest">Deployment Controls</h3>
            <div className="grid grid-cols-3 gap-5">
              <button onClick={skipWz} disabled={loading} className="h-32 flex flex-col items-center justify-center gap-3 rounded-2xl bg-blue-600 hover:bg-blue-500 disabled:bg-white/5 disabled:opacity-50 transition-all shadow-lg group active:scale-95">
                <Play className="w-8 h-8 text-white group-hover:scale-125 transition-all" />
                <span className="text-[13px] font-black uppercase">Skip Wizard</span>
              </button>
              <button onClick={setupPrecondition} disabled={loading} className="h-32 flex flex-col items-center justify-center gap-3 rounded-2xl bg-purple-600 hover:bg-purple-500 disabled:bg-white/5 disabled:opacity-50 transition-all shadow-lg group active:scale-95">
                <CheckCircle className="w-8 h-8 text-white group-hover:scale-125 transition-all" />
                <span className="text-[13px] font-black uppercase">Setup GBA</span>
              </button>
              <button onClick={connectWifi} disabled={loading} className="h-32 flex flex-col items-center justify-center gap-3 rounded-2xl bg-green-600 hover:bg-green-500 disabled:bg-white/5 disabled:opacity-50 transition-all shadow-lg group active:scale-95">
                <Wifi className="w-8 h-8 text-white group-hover:scale-125 transition-all" />
                <span className="text-[13px] font-black uppercase">WiFi Connect</span>
              </button>
            </div>
          </div>

          {/* System Log */}
          <div className="flex-1 bg-black/80 rounded-2xl border border-[#222] flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center justify-between px-5 h-12 bg-white/5 border-b border-white/5">
              <div className="flex items-center gap-3"><Terminal className="w-4 h-4 text-blue-500" /><span className="text-[10px] font-black uppercase tracking-widest">Master Console</span></div>
              <button onClick={() => setLogs([])} className="text-[9px] font-black text-white/30 hover:text-white transition-all px-3 py-1 bg-white/5 rounded-md">CLEAR</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 font-mono text-[12px] select-text leading-relaxed">
              {logs.length === 0 ? (
                <span className="text-white/10 italic">Console ready for operations...</span>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="mb-2 border-l-2 border-white/5 pl-3 hover:border-blue-500 transition-all">
                    <span className="text-white/20 mr-3">[{new Date().toLocaleTimeString()}]</span>
                    <span className={`${log.includes('✗') || log.includes('ERR') ? 'text-red-400 font-bold' : log.includes('✓') ? 'text-green-400 font-bold' : 'text-white/80'}`}>{log}</span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </main>

      <footer className="h-10 bg-[#111] border-t border-[#222] flex items-center px-6 justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className={`w-2 h-2 rounded-full ${devices.length > 0 ? 'bg-green-500 animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'bg-white/10'}`} />
          <span className="text-[10px] font-black uppercase tracking-widest text-white/60">{devices.length} Units Online</span>
        </div>
        <span className="text-[10px] font-black tracking-widest text-blue-500 uppercase">FlashKit Pro Engine v1.2.5</span>
      </footer>
    </div>
  );
}
