import React from 'react';
import { Bell, LogOut, Radio, RefreshCw, Shield } from 'lucide-react';
import { AdminProfile, TabType } from '../types';

interface HeaderProps {
  activeTab: TabType;
  isLiveConnected: boolean;
  isLoading: boolean;
  adminProfile?: AdminProfile;
  onRefresh: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, isLiveConnected, isLoading, adminProfile, onRefresh, onLogout }) => {
  const title: Record<TabType, string> = {
    map: 'Live Campus Command Center',
    orders: 'Active Orders Matrix',
    vendors: 'Dhaba & Menu Management',
    drivers: 'Driver Partner Operations',
    analytics: 'Campus Delivery Analytics',
  };

  return (
    <header className="sticky top-0 z-30 flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-[#242f46] bg-[#1b1c1c]/95 px-4 py-3 backdrop-blur-md sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="truncate text-base font-extrabold tracking-tight text-white sm:text-lg">{title[activeTab]}</h1>
        <div className="hidden items-center gap-2 rounded-full border border-[#242f46] bg-[#151c2c] px-3 py-1 text-xs font-semibold sm:flex">
          <span className={`h-2 w-2 rounded-full ${isLiveConnected ? 'bg-[#91d78a] animate-pulse' : 'bg-red-400'}`} />
          <span className="flex items-center gap-1 text-gray-300"><Radio className="h-3 w-3 text-[#fdd400]" />{isLiveConnected ? 'Live stream' : 'Offline'}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button aria-label="Refresh data feed" title="Refresh data feed" onClick={onRefresh} disabled={isLoading} className="rounded-xl border border-[#242f46] bg-[#151c2c] p-2 text-gray-300 transition-colors hover:bg-[#1b2538] disabled:cursor-wait disabled:opacity-60">
          <RefreshCw className={`h-4 w-4 text-[#fdd400] ${isLoading ? 'animate-spin' : ''}`} />
        </button>
        <button aria-label="Notifications" title="Notifications are not configured" className="relative rounded-xl border border-[#242f46] bg-[#151c2c] p-2 text-gray-300">
          <Bell className="h-4 w-4" />
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[#fdd400]" />
        </button>
        <div className="hidden h-6 w-px bg-[#242f46] sm:block" />
        <div className="hidden items-center gap-2 rounded-xl border border-[#242f46] bg-[#151c2c] px-3 py-1.5 sm:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[#91d78a]/40 bg-[#00450d] text-xs font-bold text-[#fdd400]">{(adminProfile?.name || 'AD').slice(0, 2).toUpperCase()}</div>
          <div className="max-w-40 text-left"><div className="truncate text-xs font-bold text-white">{adminProfile?.name || 'Admin'} <Shield className="inline h-3 w-3 text-[#fdd400]" /></div><div className="truncate text-[10px] text-gray-400">Administrator</div></div>
        </div>
        <button aria-label="Log out" title="Lock and log out" onClick={onLogout} className="flex items-center gap-1.5 rounded-xl border border-red-500/30 bg-red-950/40 p-2 text-xs font-bold text-red-300 transition-colors hover:bg-red-900/60 sm:px-3"><LogOut className="h-4 w-4 text-red-400" /><span className="hidden sm:inline">Log out</span></button>
      </div>
    </header>
  );
};
