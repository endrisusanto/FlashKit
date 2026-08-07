import React, { useState, useRef, useEffect } from "react";

export interface WorkstationNode {
  id: string;
  name: string;
  deviceCount: number;
  isOnline: boolean;
  ip?: string;
}

interface WorkstationSelectorProps {
  nodes: WorkstationNode[];
  selectedNodeId: string;
  customNodeName?: string;
  onSelectNode: (nodeId: string) => void;
}

export const WorkstationSelector: React.FC<WorkstationSelectorProps> = ({
  nodes,
  selectedNodeId,
  customNodeName,
  onSelectNode,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const baseNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0] || {
    id: "local",
    name: "Local Workstation",
    deviceCount: 0,
    isOnline: true,
  };

  const displayName = (customNodeName && customNodeName.trim()) || baseNode.name;

  return (
    <div className="relative inline-block text-left z-[99999]" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 sm:gap-2 px-2.5 py-1 sm:py-1.5 bg-[#1a1a1a] hover:bg-[#252525] border border-[#333] hover:border-[#444] rounded-lg text-[10px] sm:text-xs font-medium text-white/90 transition-all duration-200 shadow-sm whitespace-nowrap shrink-0"
      >
        {/* Pulsing dot - 100% circle & vertically centered */}
        <span className="relative inline-flex items-center justify-center h-2.5 w-2.5 shrink-0 my-auto">
          {baseNode.isOnline && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          )}
          <span
            className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
              baseNode.isOnline ? "bg-emerald-500" : "bg-zinc-500"
            }`}
          ></span>
        </span>

        {/* Node Name */}
        <span className="font-semibold text-emerald-400 uppercase tracking-wider text-[10px] sm:text-[11px] truncate max-w-[85px] xs:max-w-[120px] sm:max-w-[180px]">
          {displayName}
        </span>

        {/* Phone Count Badge */}
        <span className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[9px] sm:text-[10px] font-bold rounded shrink-0 flex items-center gap-1">
          📱 {baseNode.deviceCount}
        </span>

        {/* Chevron Arrow */}
        <svg
          className={`w-3 h-3 sm:w-3.5 sm:h-3.5 text-white/50 transition-transform duration-200 shrink-0 ${
            isOpen ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu - Aligned Left & Highest Stacking Context */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-2 w-64 bg-[#141414] border border-[#2a2a2a] rounded-xl shadow-2xl z-[999999] overflow-hidden divide-y divide-[#222] backdrop-blur-md">
          <div className="p-2.5 bg-[#181818]">
            <p className="text-[10px] font-bold text-white/40 uppercase tracking-wider">
              Node Workstation Terhubung
            </p>
          </div>
          <div className="py-1 max-h-60 overflow-y-auto custom-scrollbar">
            {nodes.length === 0 ? (
              <button
                onClick={() => {
                  onSelectNode("local");
                  setIsOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/5 flex items-center justify-between"
              >
                <span>{displayName}</span>
                <span className="text-[10px] text-emerald-400 font-medium">Aktif</span>
              </button>
            ) : (
              nodes.map((node) => {
                const isSelected = node.id === selectedNodeId;
                const nodeName = isSelected ? displayName : node.name;
                return (
                  <button
                    key={node.id}
                    onClick={() => {
                      onSelectNode(node.id);
                      setIsOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2.5 text-xs flex items-center justify-between transition-colors ${
                      isSelected
                        ? "bg-emerald-500/10 text-emerald-400 font-semibold"
                        : "text-white/80 hover:bg-white/5"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="relative inline-flex items-center justify-center h-2 w-2 shrink-0">
                        <span
                          className={`relative inline-flex rounded-full h-2 w-2 ${
                            node.isOnline ? "bg-emerald-500" : "bg-zinc-600"
                          }`}
                        />
                      </span>
                      <div>
                        <div className="font-medium text-white/90">{nodeName}</div>
                        {node.ip && (
                          <div className="text-[10px] text-white/40 font-mono">{node.ip}</div>
                        )}
                      </div>
                    </div>
                    <span className="px-2 py-0.5 bg-[#222] text-emerald-400 text-[10px] rounded font-mono font-bold">
                      📱 {node.deviceCount}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
