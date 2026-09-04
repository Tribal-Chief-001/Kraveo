import React from 'react';
import { TabType } from '../types';
import { MapPin, ShoppingBag, Store, TrendingUp, Cpu, Bike } from 'lucide-react';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab }) => {
  const navItems = [
    { id: 'map', label: 'Live Map Console', icon: MapPin },
    { id: 'orders', label: 'Order Command Matrix', icon: ShoppingBag },
    { id: 'vendors', label: 'Dhabas & Menus', icon: Store },
    { id: 'drivers', label: 'Driver Partners', icon: Bike },
    { id: 'analytics', label: 'Campus Analytics', icon: TrendingUp },
  ];

  return (
    <aside className="flex w-full flex-col justify-between border-b border-[#242f46] bg-[#1b1c1c] p-3 lg:sticky lg:top-0 lg:h-screen lg:w-64 lg:border-b-0 lg:border-r lg:p-4">
      <div>
        {/* Kraveo Logo Brand */}
        <div className="mb-3 flex items-center space-x-3 border-b border-[#242f46] px-2 py-2 sm:mb-6 sm:py-3">
          <img 
            src="/logo-bgremove.png" 
            alt="Kraveo" 
            className="h-12 w-auto object-contain drop-shadow-md" 
          />
          <div>
            <p className="text-[10px] uppercase font-extrabold text-[#91d78a] tracking-wider">Ops Console</p>
            <p className="text-[10px] uppercase font-bold text-gray-400 tracking-widest">VIT Bhopal</p>
          </div>
        </div>

        {/* Navigation Section */}
        <div className="space-y-1.5">
          <p className="mb-2 hidden px-3 text-[10px] font-bold uppercase tracking-widest text-gray-400 sm:block">Core Operations</p>
          <div className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id as TabType)}
                aria-label={item.label}
                className={`flex min-w-max items-center space-x-2 rounded-xl px-3 py-2.5 text-xs font-bold tracking-wide transition-all duration-200 lg:w-full lg:space-x-3 lg:py-3 ${
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
      </div>

      {/* System Engine Card */}
      <div className="mt-3 hidden space-y-2 rounded-xl border border-[#242f46] bg-[#151c2c] p-3 lg:block">
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
