import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal, RefreshCw, Play, Smartphone, Wifi, ChevronRight, Check, AlertTriangle, X } from "lucide-react";
import OdinFlash, { OdinFlashRef } from "./OdinFlash";
import logo from './assets/logo.png';
import confetti from 'canvas-confetti';

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

let confettiInterval: any = null;

const startConfettiLoop = () => {
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
    try { confetti.reset(); } catch (e) {}
    window.removeEventListener('mousedown', stopConfetti);
  };

  setTimeout(() => {
    window.addEventListener('mousedown', stopConfetti);
  }, 500);
};



export default function App() {
  const [devices, setDevices] = useState<string[]>([]);
  const [deviceDetails, setDeviceDetails] = useState<Record<string, any>>({});
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [ssid, setSsid] = useState("RTT / IEEE 802.11");
  const [password, setPassword] = useState("1234qwer");

  // Tab navigation
  const [activeTab, setActiveTab] = useState<"provisioning" | "odin">("provisioning");

  // Modal State
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [showAdbWarningModal, setShowAdbWarningModal] = useState(false);
  const [failedDevice, setFailedDevice] = useState<string | null>(null);

  // Master Sequence States
  const [showSplash, setShowSplash] = useState(true);
  const odinRef = useRef<OdinFlashRef>(null);
  const [seqOdin, setSeqOdin] = useState(localStorage.getItem('seqOdin') === 'true');
  const [seqSkipWz, setSeqSkipWz] = useState(localStorage.getItem('seqSkipWz') !== 'false');
  const [seqGba, setSeqGba] = useState(localStorage.getItem('seqGba') !== 'false');
  const [seqWifi, setSeqWifi] = useState(localStorage.getItem('seqWifi') !== 'false');
  const [currentStep, setCurrentStep] = useState<number | null>(null);

  const appendLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${time}] ${msg}`]);
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    localStorage.setItem('seqOdin', String(seqOdin));
    localStorage.setItem('seqSkipWz', String(seqSkipWz));
    localStorage.setItem('seqGba', String(seqGba));
    localStorage.setItem('seqWifi', String(seqWifi));
  }, [seqOdin, seqSkipWz, seqGba, seqWifi]);

  useEffect(() => {
    // Pre-warm confetti canvas to prevent first-click lag
    try { confetti({ particleCount: 0 }); } catch (e) {}
    
    const t = setTimeout(() => setShowSplash(false), 2000);
    return () => clearTimeout(t);
  }, []);

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  const waitForAdb = async (timeoutMs = 180000, preFlashDevices: string[] = []) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const list: string[] = await invoke<string[]>("get_devices");
        const newDevices = list.filter(d => !preFlashDevices.includes(d));
        if (newDevices.length > 0) return true;
      } catch (e) {
        console.error(e);
      }
      await delay(5000);
    }
    return false;
  };

  const refreshDevices = async () => {
    setLoading(true);
    appendLog("Memindai port COM & Modem...");
    let samsungPortsCount = 0;
    try {
      const samsungPorts: string[] = await invoke("get_samsung_ports");
      samsungPortsCount = samsungPorts.length;
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
          console.error(`Gagal ambil data ${id}:`, e);
          hasFail = true;
          setFailedDevice(id);
        }
      }));

      setDeviceDetails(details);
      if (selectedDevices.length === 0) setSelectedDevices(list);
      appendLog(`Ditemukan ${list.length} perangkat`);

      if (samsungPortsCount > 0 && list.length === 0) {
        setShowAdbWarningModal(true);
      }

      if (hasFail) {
        setShowErrorModal(true);
        appendLog("⚠ PERINGATAN: Beberapa perangkat gagal memberikan data prop.");
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
        const run = async (args: string[]) => { await invoke("run_adb", { args: ["-s", dev, "shell", ...args] }); await delay(100); };
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

  const setupPrecondition = async (isSequence = false) => {
    let active: string[] = [];
    if (!isSequence) setLoading(true);

    // Auto-retry untuk mendapatkan perangkat jika kosong
    for (let i = 0; i < 5; i++) {
      const list: string[] = await invoke("get_devices");
      active = list.length > 0 ? list : selectedDevices;
      if (active.length > 0) break;
      if (isSequence) {
        appendLog(`⏳ Menunggu perangkat untuk Setup GBA (Percobaan ${i + 1}/5)...`);
        await delay(3000);
      } else {
        break;
      }
    }

    if (active.length === 0) { appendLog("✗ Perangkat tidak terpilih."); if (!isSequence) setLoading(false); return; }
    if (!isSequence) setLoading(true);
    appendLog("──── Setup Precondition ────");
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
        appendLog(`[${dev}] ✓ SETUP GBA OK`);
      } catch (e: any) { appendLog(`[${dev}] ✗ ${e}`); }
    }));
    if (!isSequence) setLoading(false);
  };

  const connectWifi = async (isSequence = false) => {
    if (!isSequence) setLoading(true);

    let active: string[] = [];
    // Auto-retry untuk mendapatkan perangkat jika kosong
    for (let i = 0; i < 5; i++) {
      const list: string[] = await invoke("get_devices");
      active = list.length > 0 ? list : selectedDevices;
      if (active.length > 0) break;
      if (isSequence) {
        appendLog(`⏳ Menunggu perangkat untuk WiFi Connect (Percobaan ${i + 1}/5)...`);
        await delay(3000);
      } else {
        break;
      }
    }

    if (active.length === 0 || !ssid) { appendLog("✗ Perangkat atau SSID kosong."); if (!isSequence) setLoading(false); return; }
    if (!isSequence) setLoading(true);
    appendLog(`──── WiFi Connect: ${ssid} ────`);

    let apk: string;
    try { apk = await invoke("get_resource_path", { name: "WifiUtil.apk" }); } catch (e) { appendLog(`ERR: ${e}`); if (!isSequence) setLoading(false); return; }

    await Promise.all(active.map(async (dev) => {
      try {
        appendLog(`[${dev}] Mengirim profil WiFi...`);
        await invoke("run_adb", { args: ["-s", dev, "shell", "svc wifi enable"] });
        await invoke("run_adb", { args: ["-s", dev, "install", "-r", "-g", "--bypass-low-target-sdk-block", apk] });
        await delay(500);

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
        appendLog(`[${dev}] ✓ WiFi Connect SELESAI`);
      } catch (e: any) { appendLog(`[${dev}] ✗ GAGAL: ${e}`); }
    }));
    if (!isSequence) setLoading(false);
  };

  const runMasterSequence = async (e?: React.MouseEvent) => {
    if (loading) return;
    
    if (e) {
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      // Tunggu animasi confetti selesai (await) agar tidak frame-drop saat React re-render
      await confetti({ particleCount: 60, spread: 70, origin: { x, y }, colors: ['#3b82f6', '#a855f7', '#22c55e'] });
    }

    setLoading(true);
    await new Promise(r => setTimeout(r, 50));

    appendLog("==== MEMULAI MASTER SEQUENCE ====");

    let preFlashAdb: string[] = [];
    try { preFlashAdb = await invoke<string[]>("get_devices"); } catch (e) { }

    if (seqOdin) {
      setCurrentStep(0);
      if (odinRef.current) {
        appendLog("Tahap 0: Menjalankan Odin Flashing...");
        if (!odinRef.current.hasCheckedDevices()) {
          appendLog("✗ Odin Flash dilewati: Tidak ada perangkat yang dicentang di tab Odin Flash.");
        } else {
          const flashResult = await odinRef.current.startFlash();
          if (!flashResult) {
            appendLog("⚠ Odin Flash memiliki kegagalan atau file firmware belum dipilih!");
            appendLog("==== MASTER SEQUENCE DIBATALKAN ====");
            setLoading(false);
            setCurrentStep(null);
            return;
          } else {
            appendLog("✓ Odin Flash Selesai.");
            appendLog("⏳ Menunggu perangkat reboot dan terdeteksi ADB (Maksimal 3 Menit)...");

            const adbReady = await waitForAdb(180000, preFlashAdb);
            if (!adbReady) {
              appendLog("✗ Timeout: Perangkat tidak terdeteksi oleh ADB setelah 3 menit.");
              appendLog("==== MASTER SEQUENCE DIBATALKAN ====");
              setLoading(false);
              setCurrentStep(null);
              return;
            }

            appendLog("✓ Perangkat ADB terdeteksi! Menunggu stabilisasi sistem (10 detik)...");
            await delay(10000); // Ekstra waktu agar layanan background android siap

            // Refresh list device di layar agar terpilih untuk tahap selanjutnya
            await refreshDevices();
            
            try {
              const currentAdb = await invoke<string[]>("get_devices");
              const newlyBooted = currentAdb.filter(d => !preFlashAdb.includes(d));
              if (newlyBooted.length > 0) {
                setSelectedDevices(newlyBooted);
                appendLog(`[Auto] Mengunci proses selanjutnya hanya untuk ${newlyBooted.length} perangkat yang baru di-flash.`);
              }
            } catch (e) {}
          }
        }
      }
    }

    if (seqSkipWz) {
      setCurrentStep(1);
      await skipWz(true);
      await delay(2000);
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
    startConfettiLoop();
    playSuccessSound();
  };

  const toggleDevice = (id: string) => setSelectedDevices(p => p.includes(id) ? p.filter(d => d !== id) : [...p, id]);
  const selectAll = () => setSelectedDevices(selectedDevices.length === devices.length ? [] : [...devices]);

  if (showSplash) {
    return (
      <div className="flex flex-col h-screen bg-[#050505] items-center justify-center text-white select-none relative overflow-hidden" data-tauri-drag-region>
        <div className="relative flex items-center justify-center pointer-events-none">
          <div className="absolute w-40 h-40 bg-blue-500/20 rounded-full blur-[50px] animate-pulse" />
          <div className="absolute w-32 h-32 bg-purple-500/20 rounded-full blur-[40px] animate-pulse delay-75" />
          <div className="z-10 flex flex-col items-center gap-8">
            <div className="w-28 h-28 flex items-center justify-center shadow-[0_0_60px_rgba(37,99,235,0.4)] rounded-[2rem] overflow-hidden bg-white/5 border border-white/10 backdrop-blur-md p-2">
              <img src={logo} alt="FlashKit Logo" className="w-full h-full object-contain drop-shadow-2xl" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#050505] text-white overflow-hidden select-none p-4">
      <div className="flex flex-col flex-1 overflow-hidden bg-[#0a0a0a] border border-[#222] rounded-3xl shadow-[0_0_60px_rgba(0,0,0,0.8)] relative">

        {/* ── ERROR MODAL (Industrial Style) ── */}
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

      {showAdbWarningModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#1a1a1a] border border-orange-500/50 rounded-2xl w-full max-w-md overflow-hidden shadow-[0_0_50px_rgba(249,115,22,0.15)] relative">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-orange-600 to-yellow-500"></div>
            <div className="p-8">
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

        {/* ── NAVBAR ── */}
        <header className="flex items-center justify-center px-10 h-20 bg-[#0d0d0d] border-b border-[#222] shrink-0" data-tauri-drag-region>
          {/* Tabs - Centered */}
          <div className="flex h-full gap-4">
            <button
              id="tab-provisioning"
              onClick={() => setActiveTab("provisioning")}
              className={`h-full px-12 text-[13px] font-black uppercase tracking-[0.2em] border-b-[3px] transition-all ${activeTab === "provisioning"
                ? "border-white text-white bg-white/[0.02]"
                : "border-transparent text-white/30 hover:text-white/60 hover:bg-white/[0.01]"
                }`}
            >
              AUTO SETUP
            </button>
            <button
              id="tab-odin"
              onClick={() => setActiveTab("odin")}
              className={`h-full px-12 text-[13px] font-black uppercase tracking-[0.2em] border-b-[3px] transition-all ${activeTab === "odin"
                ? "border-blue-500 text-blue-400 bg-blue-500/[0.02]"
                : "border-transparent text-white/30 hover:text-white/60 hover:bg-white/[0.01]"
                }`}
            >
              FIRMWARE
            </button>
          </div>
        </header>

        {/* Always mount OdinFlash to retain state and refs, but hide it if not active */}
        <div className={activeTab === "odin" ? "flex-1 flex flex-col min-h-0 p-8" : "hidden"}>
          <div className="flex-1 flex flex-col bg-[#121212] border border-[#222] rounded-3xl p-8 overflow-hidden shadow-inner">
            <OdinFlash ref={odinRef} />
          </div>
        </div>

        <main className={activeTab === "provisioning" ? "flex-1 flex min-h-0 p-8 overflow-hidden" : "hidden"}>
          <div className="flex-1 flex bg-[#121212] border border-[#222] rounded-3xl p-8 gap-2 overflow-hidden shadow-inner">
            {/* Left: Device Pool */}
            <div className="w-1/3 min-w-[350px] max-w-[500px] flex flex-col gap-8 shrink-0">
              <div className="flex flex-col gap-3">
                <h3 className="text-[11px] font-black text-white/40 uppercase tracking-widest text-center">Daftar Perangkat ({devices.length})</h3>
                <div className="flex items-center justify-center gap-3 px-2">
                  <button onClick={refreshDevices} className="p-2.5 bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all rounded-xl shadow-sm">
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-500' : 'text-white/60'}`} />
                  </button>
                  <button onClick={selectAll} className="px-10 py-2.5 bg-white/5 border border-white/10 text-[10px] font-black uppercase hover:bg-white/10 hover:border-white/20 transition-all tracking-widest rounded-xl shadow-sm">
                    {selectedDevices.length === devices.length ? "Uncheck All" : "Select All"}
                  </button>
                </div>
              </div>
              <div className="flex-1 flex flex-col overflow-y-auto gap-5 pr-2 custom-scrollbar py-2">
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
                      className={`p-7 rounded-2xl border transition-all cursor-pointer ${selectedDevices.includes(id) ? 'border-white shadow-[0_0_15px_rgba(255,255,255,0.25)]' : 'border-[#222] hover:border-white/10'}`}
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

            {/* Right: Dashboard */}
            <div className="flex-1 flex flex-col gap-10 min-w-0">

              {/* WIFI CONFIG CARD */}
              <div className="p-8 bg-[#181818] border border-[#2a2a2a] rounded-2xl">
                <div className="flex items-center justify-center mb-6">
                  <div className="flex items-center gap-3">
                    <Wifi className="w-5 h-5 text-white/40" />
                    <span className="text-[12px] font-black uppercase tracking-widest text-white/40">Pengaturan WiFi</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-8">
                  <input value={ssid} onChange={e => setSsid(e.target.value)} className="win-input px-6 py-4 rounded-xl" placeholder="Nama WiFi (SSID)" />
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="win-input px-6 py-4 rounded-xl" placeholder="Kata Sandi" />
                </div>
              </div>

              {/* MASTER SEQUENCE CARD */}
              <div className="p-8 bg-[#181818] border border-[#2a2a2a] rounded-2xl relative overflow-hidden">
                <div className="flex items-center justify-center mb-10">
                  <div className="flex items-center gap-2">
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

                <div className="flex flex-col gap-8">
                  <div className="grid grid-cols-4 gap-6">
                    <div onClick={() => !loading && setSeqOdin(!seqOdin)} className={`p-6 border rounded-xl transition-all cursor-pointer flex flex-col items-center justify-center gap-4 ${seqOdin ? 'border-orange-500 bg-orange-500/10' : 'border-[#333] bg-black/40 hover:border-white/20'}`}>
                      <div className={`w-7 h-7 border rounded-md flex items-center justify-center transition-all ${seqOdin ? 'bg-orange-500 border-orange-500 shadow-[0_0_15px_rgba(251,146,60,0.5)]' : 'border-white/20'}`}>
                        {seqOdin && <Check className="w-5 h-5 text-white" strokeWidth={4} />}
                      </div>
                      <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqOdin ? 'text-orange-400' : 'text-white/40'}`}>Odin Flash</span>
                    </div>
                    <div onClick={() => !loading && setSeqSkipWz(!seqSkipWz)} className={`p-6 border rounded-xl transition-all cursor-pointer flex flex-col items-center justify-center gap-4 ${seqSkipWz ? 'border-blue-500 bg-blue-500/10' : 'border-[#333] bg-black/40 hover:border-white/20'}`}>
                      <div className={`w-7 h-7 border rounded-md flex items-center justify-center transition-all ${seqSkipWz ? 'bg-blue-500 border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 'border-white/20'}`}>
                        {seqSkipWz && <Check className="w-5 h-5 text-white" strokeWidth={4} />}
                      </div>
                      <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqSkipWz ? 'text-blue-400' : 'text-white/40'}`}>Skip WZ</span>
                    </div>
                    <div onClick={() => !loading && setSeqGba(!seqGba)} className={`p-6 border rounded-xl transition-all cursor-pointer flex flex-col items-center justify-center gap-4 ${seqGba ? 'border-purple-500 bg-purple-500/10' : 'border-[#333] bg-black/40 hover:border-white/20'}`}>
                      <div className={`w-7 h-7 border rounded-md flex items-center justify-center transition-all ${seqGba ? 'bg-purple-500 border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.5)]' : 'border-white/20'}`}>
                        {seqGba && <Check className="w-5 h-5 text-white" strokeWidth={4} />}
                      </div>
                      <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqGba ? 'text-purple-400' : 'text-white/40'}`}>Setup GBA</span>
                    </div>
                    <div onClick={() => !loading && setSeqWifi(!seqWifi)} className={`p-6 border rounded-xl transition-all cursor-pointer flex flex-col items-center justify-center gap-4 ${seqWifi ? 'border-green-500 bg-green-500/10' : 'border-[#333] bg-black/40 hover:border-white/20'}`}>
                      <div className={`w-7 h-7 border rounded-md flex items-center justify-center transition-all ${seqWifi ? 'bg-green-500 border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.5)]' : 'border-white/20'}`}>
                        {seqWifi && <Check className="w-5 h-5 text-white" strokeWidth={4} />}
                      </div>
                      <span className={`text-[11px] font-black uppercase tracking-widest text-center ${seqWifi ? 'text-green-400' : 'text-white/40'}`}>WiFi Connect</span>
                    </div>
                  </div>
                  <button onClick={(e) => runMasterSequence(e)} disabled={loading || (!seqOdin && !seqSkipWz && !seqGba && !seqWifi)} className={`w-full mt-2 py-6 rounded-xl transition-all font-black uppercase tracking-widest text-[16px] flex items-center justify-center gap-4 border-2 ${loading ? 'bg-[#111] border-[#333] text-white/40 cursor-not-allowed' : 'bg-white text-black border-white hover:bg-gray-200 disabled:opacity-30'}`}>
                    {loading && currentStep !== null ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Play className="w-6 h-6" />}
                    <span>{loading && currentStep !== null ? 'Memproses...' : 'Jalankan Automasi'}</span>
                  </button>
                </div>
                {loading && currentStep !== null && <div className="absolute bottom-0 left-0 h-1 bg-blue-500 w-full animate-pulse"></div>}
              </div>

              {/* System Log */}
              <div className="flex-1 bg-black border border-[#2a2a2a] rounded-2xl flex flex-col min-h-0 overflow-hidden shadow-lg">
                <div className="flex items-center justify-between px-8 h-8 bg-white/5 border-b border-[#2a2a2a]">
                  <div className="flex-1 flex items-center justify-center gap-3">
                    <Terminal className="w-4 h-4 text-blue-500" />
                    <span className="text-[11px] font-black uppercase tracking-widest">Log Sistem</span>
                  </div>
                  <button onClick={() => setLogs([])} className="text-[10px] font-black text-white/20 hover:text-white px-3 py-1 bg-white/5 rounded transition-all">CLEAR</button>
                </div>
                <div className="flex-1 overflow-y-auto p-6 font-mono text-[13px] select-text leading-relaxed custom-scrollbar">
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
        </main>

        <footer className="h-10 bg-[#0d0d0d] border-t border-[#222] flex items-center px-8 justify-between shrink-0">
          <div className="flex items-center gap-4">
            <div className={`w-2.5 h-2.5 rounded-full ${devices.length > 0 ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.4)]' : 'bg-white/10'}`} />
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40">{devices.length} Units Connected</span>
          </div>
          <span className="text-[11px] font-black tracking-[0.2em] text-blue-500/80 uppercase">v1.5.0 &bull; FlashKit By Endri-Pro</span>
        </footer>

      </div>
    </div>
  );
}
