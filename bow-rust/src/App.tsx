import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Play, Wifi, Smartphone, CheckSquare, Square, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function App() {
  const [devices, setDevices] = useState<string[]>([]);
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Progress Logs
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Wizard State
  const [step, setStep] = useState(1);

  // WiFi Config States (Default requested)
  const [ssid, setSsid] = useState("2");
  const [password, setPassword] = useState("1234qwer");

  // ADB Version

  const appendLog = (msg: string) => {
    setLogs(prev => [...prev, msg]);
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const refreshDevices = async () => {
    setLoading(true);
    setLogs([]);
    appendLog("REFRESHING DEVICES...");
    try {
      const version: string = await invoke("get_adb_version");
      appendLog(`ADB INFO:\n${version}`);

      const list: string[] = await invoke("get_devices");
      setDevices(list);
      if (devices.length === 0) setSelectedDevices(list);
      appendLog(`FOUND ${list.length} DEVICE(S)`);
    } catch (e: any) {
      appendLog(`[ERROR] ${e}`);
    }
    setLoading(false);
  };

  const toggleDevice = (deviceId: string) => {
    if (selectedDevices.includes(deviceId)) {
      setSelectedDevices(selectedDevices.filter(d => d !== deviceId));
    } else {
      setSelectedDevices([...selectedDevices, deviceId]);
    }
  };

  const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

  const skipWz = async () => {
    if (selectedDevices.length === 0) return;
    setLoading(true);
    appendLog(`=== STARTING FULL WZ SKIP (BOW ALGORITHM) ===`);
    
    for (const device of selectedDevices) {
      appendLog(`[${device}] Initializing connection...`);
      await delay(500);

      appendLog(`[${device}] Applying Global & System Settings...`);
      try {
        await invoke("run_adb", { args: ["-s", device, "shell", "settings put global stay_on_while_plugged_in 7"] });
        await delay(300);
        await invoke("run_adb", { args: ["-s", device, "shell", "settings put global device_provisioned 1"] });
        await delay(300);
        await invoke("run_adb", { args: ["-s", device, "shell", "settings put secure user_setup_complete 1"] });
        await delay(300);
        await invoke("run_adb", { args: ["-s", device, "shell", "settings put system samsung_eula_agree 1"] });
        await delay(300);
        await invoke("run_adb", { args: ["-s", device, "shell", "settings put system screen_off_timeout 600000"] });
        await delay(300);
        await invoke("run_adb", { args: ["-s", device, "shell", "locksettings set-disabled true"] });
        
        appendLog(`[${device}] Disabling Setup Wizard Packages...`);
        await delay(500);
        await invoke("run_adb", { args: ["-s", device, "shell", "pm disable-user com.sec.android.app.SecSetupWizard"] });
        await delay(300);
        await invoke("run_adb", { args: ["-s", device, "shell", "pm disable-user com.google.android.setupwizard"] });
        
        appendLog(`[${device}] Sending Home Key Event...`);
        await delay(500);
        await invoke("run_adb", { args: ["-s", device, "shell", "input keyevent KEYCODE_HOME"] });
        
        appendLog(`[${device}] Skip WZ Process Complete!`);
      } catch (e: any) {
        appendLog(`[${device}] ERROR: ${e}`);
      }
    }
    
    appendLog("=== FULL WZ SKIP FINISHED ===");
    setLoading(false);
  };

  const reconnectWifi = async () => {
    if (selectedDevices.length === 0) return;
    if (!ssid) {
      appendLog("[ERROR] SSID CANNOT BE EMPTY!");
      return;
    }
    setLoading(true);
    appendLog(`=== CONNECTING TO WIFI '${ssid}' (WIFIUTIL METHOD) ===`);
    
    let appDir: string;
    try {
      appDir = await invoke("get_app_dir");
    } catch {
      appDir = ".";
    }
    const sep = appDir.includes("\\") ? "\\" : "/";
    const wifiApkPath = `${appDir}${sep}WifiUtil.apk`;

    for (const device of selectedDevices) {
      try {
        appendLog(`[${device}] Installing WifiUtil.apk...`);
        await invoke("run_adb", { args: ["-s", device, "install", "-r", wifiApkPath] });
        await delay(1000); // Give it time to install
        
        appendLog(`[${device}] Configuring Network '${ssid}'...`);
        if (password) {
          await invoke("run_adb", { args: ["-s", device, "shell", `am instrument -e method addWpaPskNetwork -e ssid "${ssid}" -e psk "${password}" -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        } else {
          await invoke("run_adb", { args: ["-s", device, "shell", `am instrument -e method addOpenNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        }
        await delay(500);
        
        appendLog(`[${device}] Associating to '${ssid}'...`);
        await invoke("run_adb", { args: ["-s", device, "shell", `am instrument -e method associateNetwork -e ssid "${ssid}" -w com.android.tradefed.utils.wifi/.WifiUtil`] });
        await delay(500);
        
        appendLog(`[${device}] WiFi Process Complete.`);
      } catch (e: any) {
        appendLog(`[${device}] ERROR: ${e}`);
      }
    }
    
    appendLog("=== WIFI PROCESS FINISHED ===");
    setLoading(false);
  };

  useEffect(() => {
    refreshDevices();
  }, []);

  const steps = [
    { id: 1, name: "SELECT DEVICES" },
    { id: 2, name: "WIFI CONFIG" },
    { id: 3, name: "EXECUTION" }
  ];

  // Brutal Button CSS classes without overriding background
  const brutalBtnClass = "border-4 border-black shadow-[6px_6px_0_0_#111] hover:translate-x-1 hover:translate-y-1 hover:shadow-[2px_2px_0_0_#111] transition-all font-black uppercase";

  return (
    <div className="min-h-screen p-8 flex flex-col font-mono selection:bg-[#ff3366] selection:text-white">
      {/* HEADER */}
      <header className="mb-10 brutal-box p-6 bg-[#ffff00]">
        <h1 className="text-4xl font-black uppercase tracking-tighter border-b-4 border-black pb-2 mb-2 inline-block">BOW DEVICE MANAGER</h1>
        <p className="font-bold">v21.01.2021 [RUST EDITION]</p>
      </header>

      {/* BREADCRUMB WIZARD */}
      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {steps.map((s, index) => (
          <div key={s.id} className="flex items-center gap-2">
            <button 
              onClick={() => setStep(s.id)}
              className={`px-4 py-2 border-4 border-black font-black uppercase transition-all ${step === s.id ? 'bg-[#ff3366] text-white shadow-[4px_4px_0_0_#111]' : 'bg-white hover:bg-gray-200 shadow-[4px_4px_0_0_#111]'}`}
            >
              {s.id}. {s.name}
            </button>
            {index < steps.length - 1 && <ChevronRight className="w-8 h-8" />}
          </div>
        ))}
      </div>

      {/* WIZARD CONTENT */}
      <div className="flex-1 flex flex-col relative">
        <AnimatePresence mode="wait">
          
          {/* STEP 1: DEVICES */}
          {step === 1 && (
            <motion.div 
              key="step1"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex-1 brutal-box p-6 flex flex-col"
            >
              <div className="flex justify-between items-center mb-6 border-b-4 border-black pb-4">
                <h2 className="text-2xl font-black">TARGET DEVICES ({selectedDevices.length}/{devices.length})</h2>
                <button onClick={refreshDevices} disabled={loading} className={`${brutalBtnClass} px-4 py-2 bg-[#00ffcc] flex items-center gap-2`}>
                  <RefreshCw className={loading ? 'animate-spin' : ''} /> REFRESH
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto border-4 border-black bg-white p-2">
                {devices.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center p-10 text-gray-500">
                    <Smartphone className="w-16 h-16 mb-4" />
                    <p className="text-xl font-bold">NO DEVICES DETECTED</p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {devices.map(device => {
                      const isSelected = selectedDevices.includes(device);
                      return (
                        <li 
                          key={device} 
                          onClick={() => toggleDevice(device)}
                          className={`p-4 border-4 border-black cursor-pointer flex items-center justify-between ${isSelected ? 'bg-[#ffff00]' : 'bg-gray-100 hover:bg-gray-200'}`}
                        >
                          <div className="flex items-center gap-4">
                            {isSelected ? <CheckSquare className="w-8 h-8" /> : <Square className="w-8 h-8" />}
                            <div className="text-xl font-black">{device}</div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              <div className="mt-6 flex justify-end">
                <button onClick={() => setStep(2)} className={`${brutalBtnClass} px-8 py-3 bg-black text-white text-xl`}>NEXT &gt;</button>
              </div>
            </motion.div>
          )}

          {/* STEP 2: WIFI */}
          {step === 2 && (
            <motion.div 
              key="step2"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex-1 brutal-box p-6 flex flex-col"
            >
              <h2 className="text-2xl font-black mb-6 border-b-4 border-black pb-4">WIFI CONFIGURATION</h2>
              <div className="space-y-6 max-w-xl">
                <div>
                  <label className="block text-xl font-black mb-2">NETWORK SSID</label>
                  <input 
                    type="text" 
                    value={ssid}
                    onChange={(e) => setSsid(e.target.value)}
                    className="brutal-input w-full p-4 text-xl"
                    placeholder="WIFI NAME"
                  />
                </div>
                <div>
                  <label className="block text-xl font-black mb-2">PASSWORD</label>
                  <input 
                    type="text" 
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="brutal-input w-full p-4 text-xl"
                    placeholder="LEAVE BLANK IF OPEN"
                  />
                </div>
              </div>
              <div className="mt-auto flex justify-between pt-6">
                <button onClick={() => setStep(1)} className={`${brutalBtnClass} px-8 py-3 bg-white text-xl text-black`}>&lt; BACK</button>
                <button onClick={() => setStep(3)} className={`${brutalBtnClass} px-8 py-3 bg-black text-white text-xl`}>NEXT &gt;</button>
              </div>
            </motion.div>
          )}

          {/* STEP 3: EXECUTION */}
          {step === 3 && (
            <motion.div 
              key="step3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex-1 flex flex-col gap-6"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <button 
                  onClick={skipWz}
                  disabled={loading || selectedDevices.length === 0}
                  className={`${brutalBtnClass} p-8 bg-[#ff3366] text-white flex flex-col items-center justify-center gap-4 disabled:opacity-50 disabled:grayscale`}
                >
                  <Play className="w-16 h-16" />
                  <span className="text-2xl font-black">SKIP WIZARD & SETUP</span>
                  <span className="bg-black text-white px-2 py-1 text-sm border border-white">TARGET: {selectedDevices.length} DEV</span>
                </button>

                <button 
                  onClick={reconnectWifi}
                  disabled={loading || selectedDevices.length === 0 || !ssid}
                  className={`${brutalBtnClass} p-8 bg-[#00ffcc] text-black flex flex-col items-center justify-center gap-4 disabled:opacity-50 disabled:grayscale`}
                >
                  <Wifi className="w-16 h-16" />
                  <span className="text-2xl font-black">CONNECT TO WIFI</span>
                  <span className="bg-black text-[#00ffcc] px-2 py-1 text-sm">SSID: {ssid || 'NONE'}</span>
                </button>
              </div>

              <div className="flex-1 border-4 border-black shadow-[6px_6px_0_0_#111] p-4 bg-black text-[#00ffcc] flex flex-col h-[300px]">
                <h3 className="text-xl font-black border-b-4 border-[#00ffcc] pb-2 mb-4 shrink-0">SYSTEM LOG</h3>
                <div className="flex-1 font-mono text-sm break-words overflow-y-auto pr-2 custom-scrollbar flex flex-col gap-1">
                  {logs.length === 0 ? "> READY AWAITING COMMANDS..." : (
                    logs.map((log, i) => (
                      <div key={i} className="opacity-90">&gt; {log}</div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
              
              <div className="flex justify-start">
                <button onClick={() => setStep(2)} className={`${brutalBtnClass} px-8 py-3 bg-white text-xl text-black`}>&lt; BACK</button>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  );
}
