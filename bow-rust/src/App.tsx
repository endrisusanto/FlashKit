import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Play, Wifi, Smartphone, Check, Terminal, CheckCircle } from "lucide-react";

export default function App() {
  const [devices, setDevices] = useState<string[]>([]);
  const [deviceDetails, setDeviceDetails] = useState<Record<string, any>>({});
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [ssid, setSsid] = useState("RTT / IEEE 802.11");
  const [password, setPassword] = useState("1234qwer");

  const appendLog = (msg: string) => setLogs(prev => [...prev, msg]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  const refreshDevices = async () => {
    setLoading(true);
    appendLog("Memindai port COM & Modem...");
    try {
      const samsungPorts: string[] = await invoke("get_samsung_ports");
      if (samsungPorts.length > 0) {
        appendLog(`[Auto] Mendeteksi ${samsungPorts.length} Samsung Modem. Membangunkan ADB...`);
        await Promise.all(samsungPorts.map(port => sendAT(true, port)));
        await delay(2000);
      }
    } catch (e) { console.error(e); }

    appendLog("Memindai perangkat ADB...");
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
      appendLog(`Ditemukan ${list.length} perangkat`);
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

  const skipWz = async () => {
    setLoading(true);
    appendLog("Tahap 1: Inisialisasi AT Exploit...");
    const ports: string[] = await invoke("get_samsung_ports");
    if (ports.length > 0) { await Promise.all(ports.map(p => sendAT(false, p))); await delay(2500); }
    const list: string[] = await invoke("get_devices");
    const active = list.length > 0 ? list : selectedDevices;
    if (active.length === 0) { appendLog("✗ Perangkat tidak ditemukan."); setLoading(false); return; }

    let apkData: string, apkTest: string, apkLang: string;
    try {
      apkData = await invoke("get_resource_path", { name: "Data_Saver_Test-debug.apk" });
      apkTest = await invoke("get_resource_path", { name: "Data_Saver_Test-debug-androidTest.apk" });
      apkLang = await invoke("get_resource_path", { name: "language.apk" });
    } catch (e) { appendLog(`ERROR: APK tidak ditemukan. ${e}`); setLoading(false); return; }

    await Promise.all(active.map(async (dev) => {
      appendLog(`[${dev}] Memproses...`);
      try {
        const run = async (args: string[]) => { await invoke("run_adb", { args: ["-s", dev, "shell", ...args] }); await delay(100); };
        appendLog(`[${dev}] Mengatur Bahasa (English US)...`);
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
        appendLog(`[${dev}] ✓ BERHASIL`);
      } catch (e: any) { appendLog(`[${dev}] ✗ GAGAL: ${e}`); }
    }));
    setLoading(false);
  };

  const setupPrecondition = async () => {
    const active = selectedDevices.length > 0 ? selectedDevices : devices;
    if (active.length === 0) { appendLog("✗ Perangkat tidak terpilih."); return; }
    setLoading(true);
    appendLog("──── Setup Precondition (Paralel) ────");
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
        await run(["settings put global stay_on_while_plugged_in 7"]);
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
    if (active.length === 0 || !ssid) { appendLog("✗ Perangkat atau SSID kosong."); return; }
    setLoading(true);
    appendLog(`──── WiFi Sync: ${ssid} (WifiUtil) ────`);
    
    let apk: string;
    try { apk = await invoke("get_resource_path", { name: "WifiUtil.apk" }); } catch (e) { appendLog(`ERR: ${e}`); setLoading(false); return; }

    await Promise.all(active.map(async (dev) => {
      try {
        appendLog(`[${dev}] Menyiapkan WifiUtil...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] });
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apk] });
        await delay(800);

        const addCmd = password 
          ? `am instrument -e method addWpaPskNetwork -e ssid "${ssid}" -e psk "${password}" -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`
          : `am instrument -e method addOpenNetwork -e ssid "${ssid}" -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`;
        
        const addResult: string = await invoke("run_adb", { args: ["-s", dev, "shell", addCmd] });
        let netId = "";
        const match = addResult.match(/result=(\d+)/);
        if (match && match[1]) { netId = match[1]; }

        if (netId) {
          await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e id ${netId} -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        } else {
          await invoke("run_adb", { args: ["-s", dev, "shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        }

        await invoke("run_adb", { args: ["-s", dev, "shell", "am instrument -e method saveConfiguration -w com.android.tradefed.utils.wifi/.WifiUtil"] });
        await delay(5000); 
        
        const status: string = await invoke("run_adb", { args: ["-s", dev, "shell", "dumpsys wifi | grep mNetworkInfo"] });
        if (status.includes("CONNECTED") || status.includes(ssid)) {
          appendLog(`[${dev}] ✓ WiFi TERHUBUNG`);
        } else {
          appendLog(`[${dev}] ⚠ Cek manual (Status: ${status.split('\n')[0].trim()})`);
        }
      } catch (e: any) { appendLog(`[${dev}] ✗ GAGAL: ${e}`); }
    }));
    setLoading(false);
  };

  const toggleDevice = (id: string) => setSelectedDevices(p => p.includes(id) ? p.filter(d => d !== id) : [...p, id]);
  const selectAll = () => setSelectedDevices(selectedDevices.length === devices.length ? [] : [...devices]);

  return (
    <div className="flex flex-col h-screen bg-[#0f0f0f] text-white overflow-hidden border border-[#222]">
      {/* ── NAVBAR (Centered Title) ── */}
      <header className="flex items-center px-8 h-14 bg-[#151515] border-b border-[#222] shrink-0 relative" data-tauri-drag-region>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[16px] font-black tracking-[0.2em] uppercase text-white/90">FlashKit</span>
        </div>
        <div className="flex-1" />
      </header>

      <main className="flex-1 flex min-h-0 p-8 gap-8 overflow-hidden">
        {/* Left: Device Pool (Responsive Width) */}
        <div className="w-1/3 min-w-[350px] max-w-[500px] flex flex-col gap-6 shrink-0">
          <div className="flex flex-col gap-3">
            <h3 className="text-[11px] font-black text-white/40 uppercase tracking-widest text-center">Daftar Perangkat ({devices.length})</h3>
            <div className="flex items-center justify-center gap-3 px-2">
              <button onClick={refreshDevices} className="p-2.5 bg-white/5 border border-white/10 hover:bg-white/10 transition-all">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-500' : 'text-white/60'}`} />
              </button>
              <button onClick={selectAll} className="px-6 py-2 bg-white/5 border border-white/10 text-[10px] font-black uppercase hover:bg-white/10 transition-all tracking-widest">
                {selectedDevices.length === devices.length ? "Batal Semua" : "Pilih Semua"}
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto space-y-12 pr-2 custom-scrollbar py-32">
            {devices.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-10 gap-4 border-2 border-dashed border-white/10">
                <Smartphone className="w-12 h-12" />
                <span className="text-[10px] font-black uppercase tracking-widest">Menunggu Koneksi</span>
              </div>
            ) : (
              devices.map(id => (
                <div 
                  key={id} 
                  onClick={() => toggleDevice(id)} 
                  className={`p-7 border transition-all cursor-pointer ${selectedDevices.includes(id) ? 'border-white shadow-[0_0_15px_rgba(255,255,255,0.25)]' : 'border-[#222] hover:border-white/10'}`}
                  style={{ borderRadius: '0px !important' }}
                >
                  <div className="flex items-center justify-between mb-5">
                    <div className="flex flex-col min-w-0">
                      <span className="text-[17px] font-bold truncate pr-4 leading-tight">{deviceDetails[id]?.['ro.product.model'] || id}</span>
                      <span className="text-[11px] text-white/25 font-mono tracking-tight">SN: {id}</span>
                    </div>
                    <div className={`w-6 h-6 border flex items-center justify-center transition-all ${selectedDevices.includes(id) ? 'bg-white border-white shadow-[0_0_10px_rgba(255,255,255,0.4)]' : 'border-white/10'}`} style={{ borderRadius: '0px !important' }}>
                      {selectedDevices.includes(id) && <Check className="w-3.5 h-3.5 text-black font-black" />}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 pt-5 border-t border-white/5">
                    <div className="flex flex-col min-w-0"><span className="text-[9px] opacity-25 uppercase font-black tracking-widest mb-1">PDA</span><span className="text-[11px] font-mono truncate text-blue-400/80">{deviceDetails[id]?.['ro.build.PDA'] || 'N/A'}</span></div>
                    <div className="flex flex-col min-w-0 items-end"><span className="text-[9px] opacity-25 uppercase font-black tracking-widest mb-1">Region</span><span className="text-[11px] font-mono text-white/60">{deviceDetails[id]?.['ro.csc.sales_code'] || 'N/A'}</span></div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: Dashboard */}
        <div className="flex-1 flex flex-col gap-8 min-w-0">
          {/* WiFi Card */}
          <div className="p-8 bg-[#1a1a1a] border border-[#222]">
            <div className="flex items-center justify-center gap-3 mb-8">
              <Wifi className="w-5 h-5 text-green-500" />
              <span className="text-[12px] font-black uppercase tracking-widest text-center">Pengaturan WiFi</span>
            </div>
            <div className="grid grid-cols-2 gap-8">
              <input value={ssid} onChange={e => setSsid(e.target.value)} className="win-input px-6 py-4" placeholder="Nama WiFi (SSID)" style={{ borderRadius: '0px !important' }} />
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="win-input px-6 py-4" placeholder="Kata Sandi" style={{ borderRadius: '0px !important' }} />
            </div>
          </div>

          {/* Action Grid */}
          <div className="p-8 bg-[#1a1a1a] border border-[#222]">
            <div className="grid grid-cols-3 gap-8">
              <button onClick={skipWz} disabled={loading} className="win-action-card bg-blue-600 hover:bg-blue-500 shadow-xl shadow-blue-900/10 h-40" style={{ borderRadius: '0px !important' }}>
                <Play className="w-10 h-10 text-white" />
                <span className="text-[13px] font-black uppercase tracking-tight">Skip Wizard</span>
              </button>
              <button onClick={setupPrecondition} disabled={loading} className="win-action-card bg-purple-600 hover:bg-purple-500 shadow-xl shadow-purple-900/10 h-40" style={{ borderRadius: '0px !important' }}>
                <CheckCircle className="w-10 h-10 text-white" />
                <span className="text-[13px] font-black uppercase tracking-tight">Setup GBA</span>
              </button>
              <button onClick={connectWifi} disabled={loading} className="win-action-card bg-green-600 hover:bg-green-500 shadow-xl shadow-green-900/10 h-40" style={{ borderRadius: '0px !important' }}>
                <Wifi className="w-10 h-10 text-white" />
                <span className="text-[13px] font-black uppercase tracking-tight">WiFi Sync</span>
              </button>
            </div>
          </div>

          {/* System Log */}
          <div className="flex-1 bg-black border border-[#222] flex flex-col min-h-0 overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-8 h-14 bg-white/5 border-b border-[#222]">
              <div className="flex-1 flex items-center justify-center gap-3">
                <Terminal className="w-4 h-4 text-blue-500" />
                <span className="text-[11px] font-black uppercase tracking-widest">Log Sistem</span>
              </div>
              <button onClick={() => setLogs([])} className="text-[10px] font-black text-white/20 hover:text-white px-4 py-1.5 bg-white/5 transition-all">CLEAR</button>
            </div>
            <div className="flex-1 overflow-y-auto p-8 font-mono text-[13px] select-text leading-relaxed custom-scrollbar">
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-white/5 uppercase tracking-[0.5em] font-black italic">Ready</div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="mb-3 border-l-2 border-white/5 pl-5 hover:border-blue-500 transition-all py-1 hover:bg-white/[0.02]">
                    <span className="text-white/20 mr-5 font-normal">[{new Date().toLocaleTimeString()}]</span>
                    <span className={`${log.includes('✗') || log.includes('ERR') || log.includes('GAGAL') ? 'text-red-400 font-bold' : log.includes('✓') || log.includes('BERHASIL') ? 'text-green-400 font-bold' : 'text-white/75'}`}>{log}</span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </main>

      <footer className="h-10 bg-[#151515] border-t border-[#222] flex items-center px-8 justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className={`w-2.5 h-2.5 rounded-full ${devices.length > 0 ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.4)]' : 'bg-white/10'}`} />
          <span className="text-[10px] font-black uppercase tracking-widest text-white/40">{devices.length} Units Connected</span>
        </div>
        <span className="text-[11px] font-black tracking-[0.2em] text-blue-500/80 uppercase">v1.4.0</span>
      </footer>
    </div>
  );
}
