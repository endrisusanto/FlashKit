import { useState, useEffect } from 'react';
import App from './App';
import { Plus, Trash2, Settings, X, Server, Network } from 'lucide-react';

interface Workstation {
  id: string;
  name: string;
  url: string;
}

export default function InstanceManager() {
  const isNativeTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;

  const [workstations, setWorkstations] = useState<Workstation[]>(() => {
    try {
      const saved = localStorage.getItem('fk_workstations');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return [
      { id: 'local', name: 'Local Workstation', url: 'http://localhost:9977' },
      { id: 'cloud-workstation-1', name: 'Workstation 1', url: 'wss://flashkit.endrisusanto.my.id/ws/dashboard?agent_id=workstation-1' }
    ];
  });

  const [activeId, setActiveId] = useState<string>(() => {
    return workstations[0]?.id || 'local';
  });

  const [showSettings, setShowSettings] = useState(false);
  const [newVal, setNewVal] = useState({
    name: 'Workstation 2',
    url: 'wss://flashkit.endrisusanto.my.id/ws/dashboard?agent_id=workstation-2'
  });
  const [globalToken, setGlobalToken] = useState(() => {
    return localStorage.getItem('fk_global_token') || 'flashkit-secure-token-2026';
  });

  useEffect(() => {
    localStorage.setItem('fk_workstations', JSON.stringify(workstations));
  }, [workstations]);

  useEffect(() => {
    localStorage.setItem('fk_global_token', globalToken);
  }, [globalToken]);

  // If running inside the native Tauri window, bypass the tab manager entirely and render App directly
  if (isNativeTauri) {
    return <App />;
  }

  const addWorkstation = () => {
    if (!newVal.name || !newVal.url) return;
    const newId = `ws-${Math.random().toString(36).substring(2, 9)}`;
    setWorkstations(prev => [...prev, { id: newId, name: newVal.name, url: newVal.url }]);
    
    try {
      const match = newVal.name.match(/\d+/);
      const nextNum = match ? parseInt(match[0], 10) + 1 : 3;
      setNewVal({
        name: `Workstation ${nextNum}`,
        url: `wss://flashkit.endrisusanto.my.id/ws/dashboard?agent_id=workstation-${nextNum}`
      });
    } catch {
      setNewVal({ name: '', url: '' });
    }
  };

  const removeWorkstation = (id: string) => {
    if (workstations.length <= 1) {
      alert("At least one workstation must remain.");
      return;
    }
    setWorkstations(prev => prev.filter(w => w.id !== id));
    if (activeId === id) {
      setActiveId(workstations.find(w => w.id !== id)?.id || 'local');
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#070708] text-[#f4f4f5] font-sans overflow-hidden">
      {/* Premium Navigation Tab Bar */}
      <div className="flex items-center justify-between border-b border-[#1f1f23] px-6 py-3 bg-black/40 backdrop-blur-md z-30 select-none">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-orange-500 animate-pulse shadow-[0_0_10px_rgba(249,115,22,0.8)]" />
            <span className="text-xs font-black tracking-[0.25em] text-white uppercase">FLASHKIT CLOUD</span>
          </div>
          
          <div className="flex items-center gap-1.5 bg-[#121215] border border-[#1f1f23] p-1 rounded-xl">
            {workstations.map(w => {
              const isWs = w.url.startsWith('ws://') || w.url.startsWith('wss://');
              const active = w.id === activeId;
              return (
                <button
                  key={w.id}
                  onClick={() => setActiveId(w.id)}
                  className={`px-4 py-2 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all duration-300 flex items-center gap-2 ${
                    active
                      ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.4)]'
                      : 'text-white/40 hover:text-white/80 hover:bg-white/5'
                  }`}
                >
                  {isWs ? <Network className="w-3.5 h-3.5" /> : <Server className="w-3.5 h-3.5" />}
                  {w.name}
                </button>
              );
            })}
          </div>
        </div>

        <button
          onClick={() => setShowSettings(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '32px',
            height: '32px',
            padding: '0px',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '8px',
            color: 'rgba(255, 255, 255, 0.6)',
            cursor: 'pointer',
            transition: 'all 0.2s',
            margin: 'auto 0px auto auto',
            flexShrink: 0,
            boxSizing: 'border-box'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
            e.currentTarget.style.color = '#ffffff';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
          }}
        >
          <Settings style={{ width: '16px', height: '16px', display: 'block', padding: '0px', margin: '0px' }} />
        </button>
      </div>

      {/* Main View Container */}
      <div className="flex-1 overflow-hidden relative">
        {workstations.map(w => (
          <div
            key={w.id}
            className={`absolute inset-0 transition-all duration-500 ${
              w.id === activeId ? 'opacity-100 scale-100 pointer-events-auto' : 'opacity-0 scale-95 pointer-events-none'
            }`}
          >
            {w.id === activeId && (
              <App key={w.id} overrideBridgeUrl={w.url} />
            )}
          </div>
        ))}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="bg-[#0f0f12] border border-[#1f1f23] w-full max-w-lg p-6 rounded-2xl shadow-2xl relative">
            <button
              onClick={() => setShowSettings(false)}
              className="absolute right-4 top-4 p-1 rounded-lg hover:bg-white/5 text-white/40 hover:text-white transition-all"
            >
              <X className="w-5 h-5" />
            </button>

            <h2 className="text-sm font-black tracking-widest uppercase text-white mb-6">Workstations Config</h2>

            <div className="mb-6 space-y-4">
              <div>
                <label className="block text-[10px] font-black uppercase text-white/40 tracking-wider mb-2">Global Secure Token</label>
                <input
                  type="text"
                  value={globalToken}
                  onChange={(e) => setGlobalToken(e.target.value)}
                  className="w-full bg-black/40 border border-[#27272a] rounded-xl px-4 py-2.5 text-xs text-white focus:border-orange-500 focus:outline-none transition-all"
                />
              </div>

              <div className="border-t border-[#1f1f23] pt-4">
                <label className="block text-[10px] font-black uppercase text-white/40 tracking-wider mb-3">Add Workstation</label>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="Name (e.g. Bench 1)"
                    value={newVal.name}
                    onChange={(e) => setNewVal(prev => ({ ...prev, name: e.target.value }))}
                    className="bg-black/40 border border-[#27272a] rounded-xl px-4 py-2.5 text-xs text-white focus:border-orange-500 focus:outline-none transition-all"
                  />
                  <input
                    type="text"
                    placeholder="URL (http:// or wss://)"
                    value={newVal.url}
                    onChange={(e) => setNewVal(prev => ({ ...prev, url: e.target.value }))}
                    className="bg-black/40 border border-[#27272a] rounded-xl px-4 py-2.5 text-xs text-white focus:border-orange-500 focus:outline-none transition-all"
                  />
                </div>
                <button
                  onClick={addWorkstation}
                  className="w-full bg-orange-500 text-white py-2.5 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-orange-600 transition-all flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" /> Add to List
                </button>
              </div>
            </div>

            <div className="border-t border-[#1f1f23] pt-4 max-h-48 overflow-y-auto">
              <label className="block text-[10px] font-black uppercase text-white/40 tracking-wider mb-3">Registered List</label>
              <div className="space-y-2">
                {workstations.map(w => (
                  <div key={w.id} className="flex items-center justify-between bg-black/40 border border-[#1f1f23] p-3 rounded-xl">
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-white">{w.name}</span>
                      <span className="text-[10px] text-white/30 truncate max-w-xs">{w.url}</span>
                    </div>
                    <button
                      onClick={() => removeWorkstation(w.id)}
                      className="p-2 text-white/30 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
