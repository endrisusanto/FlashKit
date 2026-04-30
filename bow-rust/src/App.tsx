import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Play, Wifi, Smartphone, Check, Terminal, ChevronRight, AlertTriangle, X } from "lucide-react";

export default function App() {
  const [devices, setDevices] = useState<string[]>([]);
  const [deviceDetails, setDeviceDetails] = useState<Record<string, any>>({});
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [ssid, setSsid] = useState("RTT / IEEE 802.11");
  const [password, setPassword] = useState("1234qwer");

  const [showErrorModal, setShowErrorModal] = useState(false);
  const [failedDevice, setFailedDevice] = useState<string | null>(null);

  const [seqSkipWz, setSeqSkipWz] = useState(localStorage.getItem('seqSkipWz') !== 'false');
  const [seqGba, setSeqGba] = useState(localStorage.getItem('seqGba') !== 'false');
  const [seqWifi, setSeqWifi] = useState(localStorage.getItem('seqWifi') !== 'false');
  const [currentStep, setCurrentStep] = useState<number | null>(null);

  const appendLog = (msg: string) => setLogs(prev => [...prev, msg]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    localStorage.setItem('seqSkipWz', String(seqSkipWz));
    localStorage.setItem('seqGba', String(seqGba));
    localStorage.setItem('seqWifi', String(seqWifi));
  }, [seqSkipWz, seqGba, seqWifi]);

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Fungsi helper untuk menjalankan ADB dengan Smart Retry & AT Exploit Recovery
  const runAdbWithRetry = async (dev: string, args: string[], maxRetries = 2) => {
    let lastError = "";
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await invoke("run_adb", { args: ["-s", dev, ...args] });
      } catch (e: any) {
        lastError = e.toString();
        if (lastError.toLowerCase().includes("device not found") || lastError.toLowerCase().includes("closed")) {
          if (i < maxRetries) {
            appendLog(`[${dev}] ⚠ Koneksi hilang, mencoba pemulihan AT Exploit (Attempt ${i+1}/${maxRetries})...`);
            await sendAT(true); // Coba wake up via AT
            await delay(2000);
            continue;
          }
        }
        throw e;
      }
    }
    throw new Error(lastError);
  };

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
      let hasFail = false;

      await Promise.all(list.map(async (id) => {
        try {
          const info: any = await invoke("get_device_info", { serial: id });
          if (!info || Object.keys(info).length === 0) throw new Error("Data Kosong");
          details[id] = info;
        } catch (e) { 
          hasFail = true;
          setFailedDevice(id);
        }
      }));

      setDeviceDetails(details);
      if (selectedDevices.length === 0) setSelectedDevices(list);
      appendLog(`Ditemukan ${list.length} perangkat`);
      
      if (hasFail) {
        setShowErrorModal(true);
      }
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

  const skipWz = async (isSequence = false) => {
    if (!isSequence) setLoading(true);
    appendLog("Tahap 1: Inisialisasi AT Exploit...");
    const ports: string[] = await invoke("get_samsung_ports");
    if (ports.length > 0) { await Promise.all(ports.map(p => sendAT(false, p))); await delay(2500); }
    const list: string[] = await invoke("get_devices");
    const active = list.length > 0 ? list : selectedDevices;
    if (active.length === 0) { appendLog("✗ Perangkat tidak ditemukan."); if (!isSequence) setLoading(false); return; }

    let apkData: string, apkTest: string, apkLang: string;
    try {
      apkData = await invoke("get_resource_path", { name: "Data_Saver_Test-debug.apk" });
      apkTest = await invoke("get_resource_path", { name: "Data_Saver_Test-debug-androidTest.apk" });
      apkLang = await invoke("get_resource_path", { name: "language.apk" });
    } catch (e) { appendLog(`ERROR: APK tidak ditemukan. ${e}`); if (!isSequence) setLoading(false); return; }

    await Promise.all(active.map(async (dev) => {
      appendLog(`[${dev}] Memproses Skip Wizard...`);
      try {
        const run = async (args: string[]) => { await runAdbWithRetry(dev, ["shell", ...args]); await delay(100); };
        await runAdbWithRetry(dev, ["install", "-r", "-g", "--bypass-low-target-sdk-block", apkLang]);
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
        await runAdbWithRetry(dev, ["install", "-r", "-g", "--bypass-low-target-sdk-block", apkData]);
        await runAdbWithRetry(dev, ["install", "-r", "-g", "--bypass-low-target-sdk-block", apkTest]);
        await runAdbWithRetry(dev, ["shell", "am instrument -w -m -e debug false -e class 'com.example.DataSaver.ExampleInstrumentedTest' com.example.DataSaver.test/androidx.test.runner.AndroidJUnitRunner"]);
        await delay(500);
        await run(["pm disable-user com.sec.android.app.SecSetupWizard"]);
        await run(["pm disable-user com.google.android.setupwizard"]);
        await runAdbWithRetry(dev, ["uninstall", "com.example.DataSaver"]);
        await runAdbWithRetry(dev, ["uninstall", "com.example.DataSaver.test"]);
        await run(["pm uninstall net.sanapeli.adbchangelanguage"]);
        await run(["svc wifi enable"]);
        await run(["settings put global wifi_on 1"]);
        await run(["input keyevent KEYCODE_HOME"]);
        appendLog(`[${dev}] ✓ SKIP WIZARD BERHASIL`);
      } catch (e: any) { appendLog(`[${dev}] ✗ GAGAL: ${e}`); }
    }));
    if (!isSequence) setLoading(false);
  };

  const setupPrecondition = async (isSequence = false) => {
    const active = selectedDevices.length > 0 ? selectedDevices : devices;
    if (active.length === 0) { appendLog("✗ Perangkat tidak terpilih."); return; }
    if (!isSequence) setLoading(true);
    appendLog("──── Setup Precondition ────");
    await Promise.all(active.map(async (dev) => {
      try {
        const run = async (args: string[]) => { await runAdbWithRetry(dev, ["shell", ...args]); await delay(100); };
        await run(["settings put global development_settings_enabled 1"]);
        await run(["settings put global adb_enabled 1"]);
        await run(["settings put global verifier_verify_adb_installs 0"]);
        for (let i = 0; i < 3; i++) {
          try { await runAdbWithRetry(dev, ["shell", "svc usb setFunctions mtp"]); break; } 
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

  const connectWifi = async (isSequence = false) => {
    const active = selectedDevices.length > 0 ? selectedDevices : devices;
    if (active.length === 0 || !ssid) { appendLog("✗ Perangkat atau SSID kosong."); return; }
    if (!isSequence) setLoading(true);
    appendLog(`──── WiFi Sync: ${ssid} ────`);
    
    let apk: string;
    try { apk = await invoke("get_resource_path", { name: "WifiUtil.apk" }); } catch (e) { appendLog(`ERR: ${e}`); if (!isSequence) setLoading(false); return; }

    await Promise.all(active.map(async (dev) => {
      try {
        appendLog(`[${dev}] Mengirim profil WiFi...`);
        await runAdbWithRetry(dev, ["shell", "svc wifi enable"]);
        await runAdbWithRetry(dev, ["install", "-r", "-g", "--bypass-low-target-sdk-block", apk]);
        await delay(500);

        const addCmd = password 
          ? `am instrument -e method addWpaPskNetwork -e ssid "${ssid}" -e psk "${password}" -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`
          : `am instrument -e method addOpenNetwork -e ssid "${ssid}" -e hidden true -w com.android.tradefed.utils.wifi/.WifiUtil`;
        
        const addResult: string = await runAdbWithRetry(dev, ["shell", addCmd]);
        let netId = "";
        const match = addResult.match(/result=(\d+)/);
        if (match && match[1]) { netId = match[1]; }

        if (netId) {
          await runAdbWithRetry(dev, ["shell", `am instrument -e method associateNetwork -e id ${netId} -w com.android.tradefed.utils.wifi/.WifiUtil`]);
        } else {
          await runAdbWithRetry(dev, ["shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`]);
        }

        await runAdbWithRetry(dev, ["shell", "am instrument -e method saveConfiguration -w com.android.tradefed.utils.wifi/.WifiUtil"]);
        appendLog(`[${dev}] ✓ WiFi SYNC SELESAI`);
      } catch (e: any) { appendLog(`[${dev}] ✗ GAGAL: ${e}`); }
    }));
    if (!isSequence) setLoading(false);
  };

  const runMasterSequence = async () => {
    if (!seqSkipWz && !seqGba && !seqWifi) {
      appendLog("✗ Tidak ada aksi yang diaktifkan di Master Sequence.");
      return;
    }
    
    setLoading(true);
    appendLog("==== MEMULAI MASTER SEQUENCE ====");

    if (seqSkipWz) {
      setCurrentStep(1);
      await skipWz(true);
      await delay(3000); // Beri jeda lebih lama setelah Skip Wizard agar ADB stabil
    }

    if (seqGba) {
      setCurrentStep(2);
      await setupPrecondition(true);
      await delay(2000);
    }

    if (seqWifi) {
      setCurrentStep(3);
      await connectWifi(true);
      await delay(2000);
    }

    setCurrentStep(null);
    setLoading(false);
    appendLog("==== MASTER SEQUENCE SELESAI ====");
  };

  const toggleDevice = (id: string) => setSelectedDevices(p => p.includes(id) ? p.filter(d => d !== id) : [...p, id]);
  const selectAll = () => setSelectedDevices(selectedDevices.length === devices.length ? [] : [...devices]);

  return (
    <div className="flex flex-col h-screen bg-[#0f0f0f] text-white overflow-hidden border border-[#222] select-none">
      
      {showErrorModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-8">
          <div className="w-full max-w-md bg-[#1a1a1a] border border-red-500/50 shadow-[0_0_50px_rgba(239,68,68,0.2)] relative">
            <div className="flex items-center justify-between p-6 border-b border-white/5 bg-red-500/5">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-red-500" />
                <span className="text-[12px] font-black uppercase tracking-widest text-red-500">Device Data Error</span>
              </div>
              <button onClick={() => setShowErrorModal(false)} className="p-1 hover:bg-white/5 transition-all">
                <X className="w-4 h-4 text-white/40" />
              </button>
            </div>
            <div className="p-8 space-y-6">
              <p className="text-[14px] leading-relaxed text-white/80">
                Gagal mengambil data properti dari perangkat <span className="font-mono text-red-400">[{failedDevice}]</span>.
              </p>
              <div className="bg-black/50 border-l-2 border-red-500 p-5 space-y-3">
                <p className="text-[11px] font-black uppercase tracking-widest text-white/40">Kemungkinan Penyebab:</p>
                <ul className="text-[12px] space-y-2 list-disc list-inside text-white/60">
                  <li>Mode <span className="text-white font-bold">Skip_SUW</span> belum diaktifkan</li>
                  <li>Mode <span className="text-white font-bold">USB Debugging</span> belum terinstall/aktif</li>
                  <li>Perangkat belum di-awake melalui AT Exploit</li>
                </ul>
              </div>
              <button 
                onClick={() => { setShowErrorModal(false); sendAT(); }}
                className="w-full py-4 bg-red-500 hover:bg-red-400 text-white font-black uppercase tracking-widest text-[11px] transition-all"
              >
                Jalankan AT Exploit Sekarang
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="flex items-center px-8 h-14 bg-[#151515] border-b border-[#222] shrink-0 relative" data-tauri-drag-region>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[16px] font-black tracking-[0.2em] uppercase text-white/90">FlashKit</span>
        </div>
        <div className="flex-1" />
      </header>

      <main className="flex-1 flex min-h-0 p-8 gap-8 overflow-hidden">
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
                >
                  <div className="flex items-center justify-between mb-5">
                    <div className="flex flex-col min-w-0">
                      <span className="text-[17px] font-bold truncate pr-4 leading-tight">{deviceDetails[id]?.['ro.product.model'] || id}</span>
                      <span className="text-[11px] text-white/25 font-mono tracking-tight">SN: {id}</span>
                    </div>
                    <div className={`w-6 h-6 border flex items-center justify-center transition-all ${selectedDevices.includes(id) ? 'bg-white border-white' : 'border-white/10'}`}>
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

        <div className="flex-1 flex flex-col gap-8 min-w-0">
          <div className="p-8 bg-[#1a1a1a] border border-[#222]">
            <div className="flex items-center justify-center mb-6">
              <div className="flex items-center gap-3">
                <Wifi className="w-4 h-4 text-white/40" />
                <span className="text-[11px] font-black uppercase tracking-widest text-white/40">Pengaturan WiFi</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-8">
              <input value={ssid} onChange={e => setSsid(e.target.value)} className="win-input px-6 py-4" placeholder="Nama WiFi (SSID)" />
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="win-input px-6 py-4" placeholder="Kata Sandi" />
            </div>
          </div>

          <div className="p-8 bg-[#1a1a1a] border border-[#222] relative overflow-hidden">
            <div className="flex items-center justify-center mb-8">
              <div className="flex items-center gap-2">
                <div className={`flex items-center gap-2 transition-all duration-500 ${!seqSkipWz ? 'hidden' : ''} ${currentStep === 1 ? 'opacity-100' : (currentStep && currentStep > 1 ? 'opacity-30' : 'opacity-10')}`}>
                  <span className={`text-[10px] font-black uppercase tracking-widest ${currentStep === 1 ? 'text-blue-400 drop-shadow-[0_0_8px_rgba(96,165,250,0.8)]' : ''}`}>Skip WZ</span>
                  <ChevronRight className="w-3 h-3" />
                </div>
                <div className={`flex items-center gap-2 transition-all duration-500 ${!seqGba ? 'hidden' : ''} ${currentStep === 2 ? 'opacity-100' : (currentStep && currentStep > 2 ? 'opacity-30' : 'opacity-10')}`}>
                  <span className={`text-[10px] font-black uppercase tracking-widest ${currentStep === 2 ? 'text-purple-400 drop-shadow-[0_0_8px_rgba(192,132,252,0.8)]' : ''}`}>Setup GBA</span>
                  <ChevronRight className="w-3 h-3" />
                </div>
                <div className={`flex items-center gap-2 transition-all duration-500 ${!seqWifi ? 'hidden' : ''} ${currentStep === 3 ? 'opacity-100' : 'opacity-10'}`}>
                  <span className={`text-[10px] font-black uppercase tracking-widest ${currentStep === 3 ? 'text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.8)]' : ''}`}>WiFi Sync</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-6">
              <div className="grid grid-cols-3 gap-6">
                <div onClick={() => !loading && setSeqSkipWz(!seqSkipWz)} className={`p-6 border transition-all cursor-pointer flex flex-col items-center justify-center gap-4 ${seqSkipWz ? 'border-blue-500 bg-blue-500/10' : 'border-[#333] bg-black/40 hover:border-white/20'}`}>
                  <div className={`w-5 h-5 border flex items-center justify-center transition-all ${seqSkipWz ? 'bg-blue-500 border-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]' : 'border-white/20'}`}>
                    {seqSkipWz && <Check className="w-3 h-3 text-white font-black" />}
                  </div>
                  <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqSkipWz ? 'text-blue-400' : 'text-white/40'}`}>Skip Wizard</span>
                </div>
                <div onClick={() => !loading && setSeqGba(!seqGba)} className={`p-6 border transition-all cursor-pointer flex flex-col items-center justify-center gap-4 ${seqGba ? 'border-purple-500 bg-purple-500/10' : 'border-[#333] bg-black/40 hover:border-white/20'}`}>
                  <div className={`w-5 h-5 border flex items-center justify-center transition-all ${seqGba ? 'bg-purple-500 border-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.5)]' : 'border-white/20'}`}>
                    {seqGba && <Check className="w-3 h-3 text-white font-black" />}
                  </div>
                  <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqGba ? 'text-purple-400' : 'text-white/40'}`}>Setup GBA</span>
                </div>
                <div onClick={() => !loading && setSeqWifi(!seqWifi)} className={`p-6 border transition-all cursor-pointer flex flex-col items-center justify-center gap-4 ${seqWifi ? 'border-green-500 bg-green-500/10' : 'border-[#333] bg-black/40 hover:border-white/20'}`}>
                  <div className={`w-5 h-5 border flex items-center justify-center transition-all ${seqWifi ? 'bg-green-500 border-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'border-white/20'}`}>
                    {seqWifi && <Check className="w-3 h-3 text-white font-black" />}
                  </div>
                  <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqWifi ? 'text-green-400' : 'text-white/40'}`}>WiFi Sync</span>
                </div>
              </div>
              <button onClick={runMasterSequence} disabled={loading || (!seqSkipWz && !seqGba && !seqWifi)} className={`w-full py-5 transition-all font-black uppercase tracking-widest text-[14px] flex items-center justify-center gap-3 border-2 ${loading ? 'bg-[#111] border-[#333] text-white/40 cursor-not-allowed' : 'bg-white text-black border-white hover:bg-gray-200 disabled:opacity-30'}`}>
                {loading && currentStep !== null ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Play className="w-6 h-6" />}
                <span>{loading && currentStep !== null ? 'Memproses...' : 'Jalankan Automasi'}</span>
              </button>
            </div>
            {loading && currentStep !== null && <div className="absolute bottom-0 left-0 h-1 bg-blue-500 w-full animate-pulse"></div>}
          </div>

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
                    <span className={`${log.includes('✗') || log.includes('ERR') || log.includes('GAGAL') ? 'text-red-400 font-bold' : log.includes('✓') || log.includes('BERHASIL') || log.includes('SELESAI') ? 'text-green-400 font-bold' : 'text-white/75'}`}>{log}</span>
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
        <span className="text-[11px] font-black tracking-[0.2em] text-blue-500/80 uppercase">v1.5.0</span>
      </footer>
    </div>
  );
}
