import React from 'react';
import { DriverPin, Order } from '../types';
import { MapPin, Navigation, Bike, Store, ShieldAlert, Clock } from 'lucide-react';

interface LiveCommandCenterProps {
  drivers: DriverPin[];
  orders: Order[];
  onReassignDriver: (orderId: string) => void;
}

export const LiveCommandCenter: React.FC<LiveCommandCenterProps> = ({ drivers, orders, onReassignDriver }) => {
  const activeOrders = orders.filter((o) => o.status !== 'DELIVERED' && o.status !== 'CANCELLED');

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="stitch-card p-4 rounded-2xl space-y-1 border border-[#242f46]">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">Active Deliveries</div>
          <div className="text-2xl font-black text-white flex items-center justify-between">
            <span>{activeOrders.length}</span>
            <Bike className="w-6 h-6 text-[#fdd400]" />
          </div>
          <p className="text-[11px] text-[#91d78a] font-semibold">↑ 100% on-time dispatch rate</p>
        </div>

        <div className="stitch-card p-4 rounded-2xl space-y-1 border border-[#242f46]">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">Active Runners</div>
          <div className="text-2xl font-black text-white flex items-center justify-between">
            <span>{drivers.length} Active</span>
            <Navigation className="w-6 h-6 text-[#91d78a] animate-pulse" />
          </div>
          <p className="text-[11px] text-gray-400">Stream frequency: 3 sec GPS feed</p>
        </div>

        <div className="stitch-card p-4 rounded-2xl space-y-1 border border-[#242f46]">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">Dhabas Open</div>
          <div className="text-2xl font-black text-white flex items-center justify-between">
            <span>3 Highway Dhabas</span>
            <Store className="w-6 h-6 text-[#00450d]" />
          </div>
          <p className="text-[11px] text-gray-400">Ashta-Kothri Highway Cluster</p>
        </div>

        <div className="stitch-card p-4 rounded-2xl space-y-1 border border-[#242f46]">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">Campus Gate Hub</div>
          <div className="text-2xl font-black text-white flex items-center justify-between">
            <span>VIT Gate 1 & 2</span>
            <ShieldAlert className="w-6 h-6 text-[#fdd400]" />
          </div>
          <p className="text-[11px] text-[#91d78a] font-semibold">Hostel drop-offs active</p>
        </div>
      </div>

      {/* Main Map Console */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 stitch-card rounded-2xl p-4 flex flex-col justify-between h-[520px] relative overflow-hidden border border-[#242f46]">
          <div className="flex items-center justify-between z-10 bg-[#1b1c1c]/90 p-3 rounded-xl backdrop-blur-md border border-[#242f46]">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[#91d78a] animate-ping" />
              <span className="text-sm font-bold text-white">Live VIT Bhopal Logistics Canvas</span>
            </div>
            <div className="text-xs text-gray-400 font-mono">
              Coordinates: 23.0768° N, 76.8524° E
            </div>
          </div>

          {/* Map Layout Visualizer */}
          <div className="absolute inset-0 bg-[#1b1c1c]">
            <div className="absolute inset-0 bg-[radial-gradient(#242f46_1px,transparent_1px)] [background-size:16px_16px] opacity-40" />

            <svg className="absolute inset-0 w-full h-full stroke-[#fdd400]/40 stroke-[3] fill-none">
              <path d="M 50 120 Q 200 180 400 220 T 700 350" strokeDasharray="6,6" />
              <path d="M 400 220 L 520 400" stroke="#00450d" strokeWidth="3" opacity="0.8" />
            </svg>

            {/* Dhaba Nodes */}
            <div className="absolute top-[100px] left-[120px] flex items-center gap-2 bg-[#151c2c] px-3 py-1.5 rounded-xl border border-[#00450d] shadow-lg">
              <Store className="w-4 h-4 text-[#fdd400]" />
              <div>
                <div className="text-xs font-bold text-white">Sharma Dhaba</div>
                <div className="text-[9px] text-gray-400">Highway km 1.2</div>
              </div>
            </div>

            <div className="absolute top-[180px] left-[350px] flex items-center gap-2 bg-[#151c2c] px-3 py-1.5 rounded-xl border border-[#00450d] shadow-lg">
              <Store className="w-4 h-4 text-[#91d78a]" />
              <div>
                <div className="text-xs font-bold text-white">Campus Night Canteen</div>
                <div className="text-[9px] text-gray-400">Gate 1 Entry</div>
              </div>
            </div>

            {/* Hostel Nodes */}
            <div className="absolute bottom-[80px] right-[140px] flex items-center gap-2 bg-[#151c2c] px-3 py-1.5 rounded-xl border border-[#fdd400] shadow-lg">
              <MapPin className="w-4 h-4 text-[#fdd400] animate-bounce" />
              <div>
                <div className="text-xs font-bold text-white">Boys Hostel Block 3</div>
                <div className="text-[9px] text-[#91d78a] font-bold">2 Active Dropoffs</div>
              </div>
            </div>

            {/* Runner Pins with Dynamic Non-Stacking Positions */}
            {drivers.map((drv, idx) => {
              const topPos = 180 + ((idx * 60) % 200);
              const leftPos = 200 + ((idx * 110) % 360);
              return (
                <div 
                  key={drv.id}
                  style={{ top: `${topPos}px`, left: `${leftPos}px` }}
                  className="absolute flex items-center gap-2 bg-gradient-to-r from-[#00450d] to-[#1b5e20] px-3 py-1.5 rounded-full text-white shadow-xl border border-[#91d78a]/40 transition-all duration-500"
                >
                  <Bike className="w-4 h-4 text-[#fdd400] animate-pulse" />
                  <div className="text-xs font-bold">{drv.name} (Runner #{idx + 1})</div>
                </div>
              );
            })}
          </div>

          <div className="z-10 bg-[#1b1c1c]/90 p-3 rounded-xl backdrop-blur-md border border-[#242f46] flex items-center justify-between text-xs text-gray-400">
            <div className="flex items-center space-x-4">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#00450d]" /> Dhaba Node
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#fdd400]" /> Hostel Gate Dropoff
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#91d78a]" /> Moving Runner
              </span>
            </div>
            <div className="text-[#91d78a] font-semibold">Traffic: Highway Clear</div>
          </div>
        </div>

        {/* Live Delivery Feed */}
        <div className="stitch-card rounded-2xl p-4 flex flex-col justify-between h-[520px] overflow-hidden border border-[#242f46]">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-[#242f46] mb-3">
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#fdd400]" /> Live Delivery Pipeline ({activeOrders.length})
              </h3>
              <span className="text-[10px] bg-[#00450d] text-[#91d78a] font-bold px-2.5 py-0.5 rounded-full border border-[#91d78a]/30">
                Real-Time
              </span>
            </div>

            <div className="space-y-3 overflow-y-auto max-h-[420px] pr-1">
              {activeOrders.map((ord) => (
                <div key={ord.id} className="p-3 rounded-xl bg-[#1b1c1c] border border-[#242f46] hover:border-[#fdd400]/40 transition-colors space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-[#fdd400]">{ord.id}</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#fdd400]/10 text-[#fdd400] border border-[#fdd400]/30">
                      {ord.status}
                    </span>
                  </div>

                  <div className="text-xs text-gray-200 font-bold">{ord.vendorName}</div>
                  
                  <div className="text-[11px] text-gray-400 flex items-center justify-between">
                    <span>📍 {ord.dropoffHostel}</span>
                    <span className="font-bold text-white">₹{ord.totalAmount}</span>
                  </div>

                  <div className="pt-2 border-t border-[#242f46] flex items-center justify-between text-[11px]">
                    <span className="text-gray-400">Runner: <strong className="text-white">{ord.driverName || 'Unassigned'}</strong></span>
                    <button 
                      onClick={() => onReassignDriver(ord.id)}
                      className="px-2.5 py-1 bg-[#00450d] hover:bg-[#1b5e20] text-white rounded-lg text-[10px] font-bold border border-[#91d78a]/30 transition-colors"
                    >
                      Reassign
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
