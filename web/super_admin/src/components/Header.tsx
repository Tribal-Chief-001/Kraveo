import React from 'react';
import { Shield, Bell, RefreshCw, Radio } from 'lucide-react';

interface HeaderProps {
  activeTab: string;
  isLiveConnected: boolean;
  onRefresh: () => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, isLiveConnected, onRefresh }) => {
  const getTabTitle = () => {
    switch (activeTab) {
      case 'map': return 'Live Campus Command Center';
      case 'orders': return 'Active Orders Matrix';
      case 'vendors': return 'Dhaba & Menu Management';
      case 'analytics': return 'Campus Delivery Analytics';
      default: return 'Command Center';
    }
  };

  return (
    <header className="h-16 border-b border-[#242f46] bg-[#1b1c1c]/90 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-30">
      <div className="flex items-center space-x-4">
        <h1 className="text-lg font-extrabold text-white tracking-tight flex items-center gap-2">
          {getTabTitle()}
        </h1>
        <div className="flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-[#151c2c] border border-[#242f46]">
          <span className={`w-2 h-2 rounded-full ${isLiveConnected ? 'bg-[#91d78a] animate-pulse' : 'bg-[#fdd400]'}`} />
          <span className="text-gray-300 flex items-center gap-1">
            <Radio className="w-3 h-3 text-[#fdd400] animate-spin" />
            {isLiveConnected ? 'Socket.io Stream Active' : 'Connecting Engine...'}
          </span>
        </div>
      </div>

      <div className="flex items-center space-x-3">
        <button 
          onClick={onRefresh}
          className="p-2 rounded-xl bg-[#151c2c] hover:bg-[#1b2538] text-gray-300 border border-[#242f46] transition-colors"
          title="Refresh Data Feed"
        >
          <RefreshCw className="w-4 h-4 text-[#fdd400]" />
        </button>
        
        <div className="relative">
          <button className="p-2 rounded-xl bg-[#151c2c] text-gray-300 border border-[#242f46] hover:text-white">
            <Bell className="w-4 h-4" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-[#fdd400] rounded-full" />
          </button>
        </div>

        <div className="h-6 w-[1px] bg-[#242f46] mx-1" />

        <div className="flex items-center space-x-3 bg-[#151c2c] px-3 py-1.5 rounded-xl border border-[#242f46]">
          <div className="w-8 h-8 rounded-full bg-[#00450d] border border-[#91d78a]/40 flex items-center justify-center font-bold text-[#fdd400] text-xs">
            KV
          </div>
          <div className="text-left">
            <div className="text-xs font-bold text-white flex items-center gap-1">
              Kraveo Founder <Shield className="w-3 h-3 text-[#fdd400] inline" />
            </div>
            <div className="text-[10px] text-gray-400">VIT Bhopal Super Admin</div>
          </div>
        </div>
      </div>
    </header>
  );
};
