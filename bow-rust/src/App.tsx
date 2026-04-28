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

        appendLog(`[${dev}] Associating...`);
        if (netId) {
          await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e id ${netId} -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        } else {
          await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        }
        await delay(500);

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
    <div className="flex flex-col h-screen bg-[#050505] text-white overflow-hidden border border-[#1a1a1a] rounded-none">
      {/* ── HEADER (Tighter) ── */}
      <header className="flex items-center px-6 h-12 bg-[#0a0a0a] border-b border-[#1a1a1a] shrink-0" data-tauri-drag-region>
        <Zap className="w-4 h-4 text-blue-500 mr-3 animate-pulse" />
        <span className="text-[11px] font-black tracking-[0.3em] uppercase opacity-40">FlashKit Pro v1.4.0</span>
        <div className="flex-1" />
        <button onClick={refreshDevices} className="p-2.5 hover:bg-white/5 transition-all active:scale-95">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-500' : 'text-white/20'}`} />
        </button>
      </header>

      {/* ── MAIN LAYOUT (Modern Negative Space) ── */}
      <main className="flex-1 flex min-h-0 p-6 gap-6 overflow-hidden">

        {/* Left: Device Pool (Sidebar) */}
        <div className="w-[400px] flex flex-col gap-6 shrink-0">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em]">Deployment Pool ({devices.length})</h3>
            <button onClick={selectAll} className="text-[9px] text-blue-500 font-black uppercase hover:text-blue-400 transition-colors">
              [ {selectedDevices.length === devices.length ? "Deselect All" : "Select All Units"} ]
            </button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-4 pr-3 custom-scrollbar">
            {devices.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-5 border border-dashed border-white/10 bg-white/[0.01]">
                <Smartphone className="w-12 h-12" />
                <span className="text-[10px] font-black uppercase tracking-[0.4em] mt-6">Searching ADB...</span>
              </div>
            ) : (
              devices.map(id => (
                <div
                  key={id}
                  onClick={() => toggleDevice(id)}
                  className={`p-5 border transition-all cursor-pointer group relative ${selectedDevices.includes(id) ? 'bg-[#0f0f0f] border-blue-600 shadow-lg' : 'bg-[#080808] border-[#1a1a1a] hover:border-white/10'}`}
                >
                  {selectedDevices.includes(id) && <div className="absolute top-0 left-0 w-1 h-full bg-blue-600" />}
                  <div className="flex items-center justify-between mb-5">
                    <div className="flex flex-col min-w-0">
                      <span className="text-[14px] font-black truncate text-white uppercase tracking-tight">{deviceDetails[id]?.['ro.product.model'] || "SAMSUNG-UNIT"}</span>
                      <span className="text-[9px] font-mono text-white/20 mt-1.5 uppercase tracking-tighter">Serial: {id}</span>
                    </div>
                    <div className={`w-5 h-5 border flex items-center justify-center transition-all ${selectedDevices.includes(id) ? 'bg-blue-600 border-blue-600' : 'border-white/10'}`}>
                      {selectedDevices.includes(id) && <Check className="w-3.5 h-3.5 text-white font-black" />}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-6 pt-5 border-t border-white/5 bg-black/20 -mx-5 px-5 pb-0">
                    <div className="flex flex-col min-w-0 py-1">
                      <span className="text-[8px] font-black text-white/20 uppercase mb-1.5 tracking-widest">PDA Build</span>
                      <span className="text-[11px] font-bold truncate text-white/80 font-mono tracking-tighter">{deviceDetails[id]?.['ro.build.PDA'] || 'N/A'}</span>
                    </div>
                    <div className="flex flex-col min-w-0 items-end py-1">
                      <span className="text-[8px] font-black text-white/20 uppercase mb-1.5 tracking-widest">CSC Region</span>
                      <span className="text-[11px] font-bold text-blue-500 font-mono tracking-tighter">{deviceDetails[id]?.['ro.csc.sales_code'] || 'N/A'}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: Dashboard Operations */}
        <div className="flex-1 flex flex-col gap-6 min-w-0">

          {/* Module 1: Network Form (Spacious Inputs) */}
          <div className="p-6 bg-[#080808] border border-[#1a1a1a]">
            <div className="flex items-center gap-3 mb-8">
              <Wifi className="w-4 h-4 text-green-500" />
              <span className="text-[11px] font-black uppercase tracking-[0.2em] text-white/40">Network Provisioning Matrix</span>
            </div>
            <div className="grid grid-cols-2 gap-8">
              <div className="flex flex-col gap-3">
                <label className="text-[9px] font-black text-white/20 uppercase tracking-[0.1em] ml-1">SSID Identifier</label>
                <input value={ssid} onChange={e => setSsid(e.target.value)} className="bg-black border border-[#1a1a1a] px-5 py-3.5 text-[13px] font-bold focus:border-green-600 outline-none transition-all placeholder:opacity-5" placeholder="NETWORK_NAME" />
              </div>
              <div className="flex flex-col gap-3">
                <label className="text-[9px] font-black text-white/20 uppercase tracking-[0.1em] ml-1">Secret Key</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="bg-black border border-[#1a1a1a] px-5 py-3.5 text-[13px] font-bold focus:border-green-600 outline-none transition-all placeholder:opacity-5" placeholder="********" />
              </div>
            </div>
          </div>

          {/* Module 2: Control Matrix */}
          <div className="p-6 bg-[#080808] border border-[#1a1a1a]">
            <h3 className="text-[10px] font-black mb-8 text-white/20 uppercase tracking-[0.2em]">Execution Center</h3>
            <div className="grid grid-cols-3 gap-6">
              <button onClick={skipWz} disabled={loading} className="h-28 flex flex-col items-center justify-center gap-3 bg-blue-700 hover:bg-blue-600 disabled:opacity-20 transition-all active:scale-[0.98]">
                <Play className="w-6 h-6 text-white" />
                <span className="text-[12px] font-black uppercase tracking-widest text-white/90">Skip Wizard</span>
              </button>
              <button onClick={setupPrecondition} disabled={loading} className="h-28 flex flex-col items-center justify-center gap-3 bg-purple-700 hover:bg-purple-600 disabled:opacity-20 transition-all active:scale-[0.98]">
                <CheckCircle className="w-6 h-6 text-white" />
                <span className="text-[12px] font-black uppercase tracking-widest text-white/90">Setup GBA</span>
              </button>
              <button onClick={connectWifi} disabled={loading} className="h-28 flex flex-col items-center justify-center gap-3 bg-green-700 hover:bg-green-600 disabled:opacity-20 transition-all active:scale-[0.98]">
                <Wifi className="w-6 h-6 text-white" />
                <span className="text-[12px] font-black uppercase tracking-widest text-white/90">WiFi Connect</span>
              </button>
            </div>
          </div>

          {/* Module 3: Modern Console */}
          <div className="flex-1 bg-black border border-[#1a1a1a] flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center justify-between px-6 h-11 bg-[#0a0a0a] border-b border-[#1a1a1a]">
              <div className="flex items-center gap-3 text-white/30">
                <Terminal className="w-3.5 h-3.5 text-blue-500" />
                <span className="text-[9px] font-black uppercase tracking-[0.15em]">Operation Log System</span>
              </div>
              <button onClick={() => setLogs([])} className="text-[8px] font-black text-white/10 hover:text-white/40 transition-all uppercase">[ Clear Logs ]</button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 font-mono text-[11px] leading-loose select-text custom-scrollbar bg-[#020202]">
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center opacity-[0.03] select-none">
                  <span className="text-[20px] font-black uppercase tracking-[1.5em]">System Idle</span>
                </div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="mb-2 flex gap-4 border-l border-white/5 pl-4 hover:border-blue-600/20 transition-colors">
                    <span className="text-white/10 select-none font-mono">[{new Date().toLocaleTimeString([], { hour12: false })}]</span>
                    <span className={`${log.includes('✗') || log.includes('ERR') ? 'text-red-500 font-black' : log.includes('✓') ? 'text-green-500 font-black' : 'text-white/50'}`}>{log}</span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </main>

      {/* ── FOOTER ── */}
      <footer className="h-9 bg-[#0a0a0a] border-t border-[#1a1a1a] flex items-center px-6 justify-between shrink-0">
        <div className="flex items-center gap-4 text-white/20">
          <div className={`w-1.5 h-1.5 rounded-none ${devices.length > 0 ? 'bg-green-600 shadow-[0_0_10px_rgba(22,163,74,0.3)]' : 'bg-white/5'}`} />
          <span className="text-[9px] font-black uppercase tracking-[0.2em]">{devices.length} Units Ready</span>
        </div>
        <span className="text-[9px] font-black tracking-widest text-blue-900 uppercase">FlashKit</span>
      </footer>
    </div>
  );
}
