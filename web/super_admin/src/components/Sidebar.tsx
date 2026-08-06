import React from 'react';
import { TabType } from '../types';
import { MapPin, ShoppingBag, Store, TrendingUp, Cpu, Utensils } from 'lucide-react';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab }) => {
  const navItems = [
    { id: 'map', label: 'Live Map Console', icon: MapPin },
    { id: 'orders', label: 'Order Command Matrix', icon: ShoppingBag },
    { id: 'vendors', label: 'Dhabas & Menus', icon: Store },
    { id: 'analytics', label: 'Campus Analytics', icon: TrendingUp },
  ];

  return (
    <aside className="w-64 border-r border-[#242f46] bg-[#1b1c1c] flex flex-col justify-between p-4 sticky top-0 h-screen">
      <div>
        {/* Kraveo Logo Brand from Stitch UI */}
        <div className="flex items-center space-x-3 px-3 py-4 mb-6 border-b border-[#242f46]">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00450d] via-[#1b5e20] to-[#fdd400] flex items-center justify-center shadow-lg shadow-[#00450d]/40 font-black text-white text-xl tracking-wider border border-white/20">
            K
          </div>
          <div>
            <h1 className="text-lg font-black text-white tracking-wide flex items-center gap-1">
              KRAVEO <Utensils className="w-4 h-4 text-[#fdd400]" />
            </h1>
            <p className="text-[10px] uppercase font-bold text-[#fdd400] tracking-widest">VIT Bhopal Campus</p>
          </div>
        </div>

        {/* Navigation Section */}
        <div className="space-y-1.5">
          <p className="px-3 text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Core Operations</p>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id as TabType)}
                className={`w-full flex items-center space-x-3 px-3 py-3 rounded-xl font-bold text-xs tracking-wide transition-all duration-200 ${
                  isActive
                    ? 'bg-gradient-to-r from-[#00450d] to-[#1b5e20] text-white shadow-md shadow-[#00450d]/40 border border-[#91d78a]/30'
                    : 'text-gray-400 hover:text-white hover:bg-[#151c2c]'
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? 'text-[#fdd400]' : 'text-gray-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* System Engine Card */}
      <div className="p-3 rounded-xl bg-[#151c2c] border border-[#242f46] space-y-2">
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span className="flex items-center gap-1.5 font-semibold text-white">
            <Cpu className="w-4 h-4 text-[#fdd400]" /> Engine
          </span>
          <span className="text-[10px] text-[#91d78a] font-mono font-bold bg-[#00450d] px-2 py-0.5 rounded-full">
            ONLINE
          </span>
        </div>
        <div className="text-[11px] text-gray-400 leading-tight">
          Monitoring Highway Dhabas & Hostel Drop-off Gates.
        </div>
      </div>
    </aside>
  );
};
