import React, { useState } from 'react';
import { DriverPartner } from '../types';
import { Bike, Shield, Star, Clock, Phone, Award, Search, CheckCircle2, AlertCircle } from 'lucide-react';

interface DriverManagerProps {
  drivers: DriverPartner[];
  onToggleStatus?: (driverId: string) => void;
}

export const DriverManager: React.FC<DriverManagerProps> = ({ drivers }) => {
  const [filter, setFilter] = useState<'ALL' | 'ONLINE' | 'IN_TRANSIT' | 'OFFLINE'>('ALL');
  const [search, setSearch] = useState('');
  const [selectedDriver, setSelectedDriver] = useState<DriverPartner | null>(null);

  const filtered = drivers.filter((d) => {
    const matchesFilter = filter === 'ALL' || d.dutyStatus === filter;
    const matchesSearch = d.name.toLowerCase().includes(search.toLowerCase()) || 
                          d.studentRegNo.toLowerCase().includes(search.toLowerCase()) ||
                          d.runnerCode.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const activeCount = drivers.filter((d) => d.dutyStatus === 'ONLINE' || d.dutyStatus === 'IN_TRANSIT').length;
  const totalPayoutToday = drivers.reduce((sum, d) => sum + d.totalEarningsToday, 0);
  const totalOrdersToday = drivers.reduce((sum, d) => sum + d.ordersToday, 0);

  return (
    <div className="space-y-6">
      {/* Top Header & Summary Cards */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Bike className="w-5 h-5 text-[#fdd400]" /> Delivery Partner & Runner Ops Dashboard
          </h2>
          <p className="text-xs text-gray-400">Track registered delivery partners, earnings, completion speeds, and campus gate clearance</p>
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="stitch-card p-4 rounded-2xl border border-[#242f46] space-y-1">
          <div className="text-[11px] font-bold text-gray-400 uppercase">Active Runners on Duty</div>
          <div className="text-2xl font-extrabold text-white flex items-center justify-between">
            <span>{activeCount} / {drivers.length}</span>
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
          </div>
          <p className="text-[11px] text-[#91d78a]">Available for dispatch</p>
        </div>

        <div className="stitch-card p-4 rounded-2xl border border-[#242f46] space-y-1">
          <div className="text-[11px] font-bold text-gray-400 uppercase">Deliveries Completed Today</div>
          <div className="text-2xl font-extrabold text-[#fdd400]">
            {totalOrdersToday} trips
          </div>
          <p className="text-[11px] text-gray-400">Hostel gate handshakes</p>
        </div>

        <div className="stitch-card p-4 rounded-2xl border border-[#242f46] space-y-1">
          <div className="text-[11px] font-bold text-gray-400 uppercase">Total Runner Payouts Today</div>
          <div className="text-2xl font-extrabold text-emerald-400">
            ₹{totalPayoutToday}
          </div>
          <p className="text-[11px] text-emerald-400">Flat ₹40 per delivery</p>
        </div>

        <div className="stitch-card p-4 rounded-2xl border border-[#242f46] space-y-1">
          <div className="text-[11px] font-bold text-gray-400 uppercase">Avg Delivery Speed</div>
          <div className="text-2xl font-extrabold text-white flex items-center gap-1.5">
            <Clock className="w-5 h-5 text-sky-400" /> 18.2 mins
          </div>
          <p className="text-[11px] text-sky-400">Dhaba to Hostel Gate</p>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 bg-[#151c2c] p-3 rounded-2xl border border-[#242f46]">
        <div className="flex items-center gap-2">
          {(['ALL', 'ONLINE', 'IN_TRANSIT', 'OFFLINE'] as const).map((st) => (
            <button
              key={st}
              onClick={() => setFilter(st)}
              className={`px-3 py-1.5 rounded-xl text-xs font-extrabold transition-all ${
                filter === st
                  ? 'bg-[#00450d] text-white border border-[#91d78a]/40 shadow-md'
                  : 'bg-[#1b1c1c] text-gray-400 hover:text-white border border-[#242f46]'
              }`}
            >
              {st === 'ALL' ? 'ALL RUNNERS' : st.replace('_', ' ')}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-64">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by Name, Reg No, or Runner ID..."
            className="w-full bg-[#1b1c1c] border border-[#242f46] rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#fdd400]"
          />
        </div>
      </div>

      {/* Drivers Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {filtered.map((d) => (
          <div 
            key={d.id} 
            onClick={() => setSelectedDriver(d)}
            className="stitch-card rounded-2xl p-5 border border-[#242f46] space-y-4 hover:border-[#fdd400]/50 cursor-pointer transition-all"
          >
            {/* Header / Avatar */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <img 
                  src={d.avatarUrl} 
                  alt={d.name} 
                  className="w-12 h-12 rounded-full object-cover border-2 border-[#fdd400]"
                />
                <div>
                  <h3 className="font-extrabold text-white text-base leading-snug">{d.name}</h3>
                  <p className="text-xs text-[#fdd400] font-bold">VIT Reg: {d.studentRegNo}</p>
                </div>
              </div>

              <span className={`px-2.5 py-1 rounded-xl text-[10px] font-black border ${
                d.dutyStatus === 'ONLINE' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                d.dutyStatus === 'IN_TRANSIT' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
                'bg-gray-500/10 text-gray-400 border-gray-500/30'
              }`}>
                {d.dutyStatus.replace('_', ' ')}
              </span>
            </div>

            {/* Runner Code & Vehicle Details */}
            <div className="bg-[#1b1c1c] p-3 rounded-xl border border-[#242f46] space-y-1 text-xs">
              <div className="flex justify-between text-gray-300">
                <span className="text-gray-500">Runner Pass Code:</span>
                <span className="font-mono font-bold text-[#fdd400]">{d.runnerCode}</span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span className="text-gray-500">Vehicle Registered:</span>
                <span className="font-bold text-white">{d.vehicleType}</span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span className="text-gray-500">Emergency Phone:</span>
                <span className="font-mono text-emerald-400">{d.emergencyPhone}</span>
              </div>
            </div>

            {/* Performance Stats Metrics Bar */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[#242f46] text-center">
              <div className="bg-[#1b1c1c] p-2 rounded-xl">
                <div className="text-[10px] text-gray-500 font-bold">Trips Today</div>
                <div className="text-sm font-extrabold text-white">{d.ordersToday}</div>
              </div>
              <div className="bg-[#1b1c1c] p-2 rounded-xl">
                <div className="text-[10px] text-gray-500 font-bold">Payout</div>
                <div className="text-sm font-extrabold text-emerald-400">₹{d.totalEarningsToday}</div>
              </div>
              <div className="bg-[#1b1c1c] p-2 rounded-xl">
                <div className="text-[10px] text-gray-500 font-bold">Rating</div>
                <div className="text-sm font-extrabold text-[#fdd400] flex items-center justify-center gap-0.5">
                  <Star className="w-3 h-3 fill-[#fdd400]" /> {d.rating}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Detailed Driver Modal Inspector Drawer */}
      {selectedDriver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="stitch-card bg-[#151c2c] border border-[#242f46] rounded-2xl w-full max-w-lg p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#242f46] pb-3">
              <div className="flex items-center gap-3">
                <img src={selectedDriver.avatarUrl} className="w-12 h-12 rounded-full border-2 border-[#fdd400]" />
                <div>
                  <h3 className="text-lg font-bold text-white">{selectedDriver.name}</h3>
                  <p className="text-xs text-[#fdd400]">Runner Code: {selectedDriver.runnerCode}</p>
                </div>
              </div>
              <button onClick={() => setSelectedDriver(null)} className="text-gray-400 hover:text-white font-extrabold text-lg">
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#1b1c1c] p-3 rounded-xl border border-[#242f46]">
                  <span className="text-gray-500 block">VIT Student Reg No</span>
                  <span className="font-bold text-white text-sm">{selectedDriver.studentRegNo}</span>
                </div>
                <div className="bg-[#1b1c1c] p-3 rounded-xl border border-[#242f46]">
                  <span className="text-gray-500 block">Payout UPI Address</span>
                  <span className="font-mono text-emerald-400 text-sm">{selectedDriver.upiId}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#1b1c1c] p-3 rounded-xl border border-[#242f46]">
                  <span className="text-gray-500 block">Avg Completion Speed</span>
                  <span className="font-bold text-sky-400 text-sm">{selectedDriver.avgCompletionTimeMinutes} mins</span>
                </div>
                <div className="bg-[#1b1c1c] p-3 rounded-xl border border-[#242f46]">
                  <span className="text-gray-500 block">On-Time Success Rate</span>
                  <span className="font-bold text-emerald-400 text-sm">{selectedDriver.onTimeRatePercent}%</span>
                </div>
              </div>

              <div className="bg-[#1b1c1c] p-3 rounded-xl border border-[#242f46]">
                <span className="text-gray-500 block">Vehicle Registration & Plate</span>
                <span className="font-bold text-white">{selectedDriver.vehicleType} ({selectedDriver.vehicleRegNo})</span>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setSelectedDriver(null)}
                className="px-5 py-2 bg-[#00450d] text-white font-bold rounded-xl text-xs hover:bg-[#1b5e20] border border-[#91d78a]/30"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
