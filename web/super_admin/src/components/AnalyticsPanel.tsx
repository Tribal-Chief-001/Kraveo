import React from 'react';
import { TrendingUp, DollarSign, Clock, Users, Award } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, BarChart, Bar } from 'recharts';

const hourlyOrdersData = [
  { hour: '12 PM', orders: 15 },
  { hour: '2 PM', orders: 32 },
  { hour: '4 PM', orders: 18 },
  { hour: '6 PM', orders: 45 },
  { hour: '8 PM', orders: 85 },
  { hour: '10 PM', orders: 120 },
  { hour: '12 AM', orders: 140 },
  { hour: '2 AM', orders: 60 }
];

const hostelOrdersData = [
  { hostel: 'Boys Block 1', orders: 45 },
  { hostel: 'Boys Block 2', orders: 60 },
  { hostel: 'Boys Block 3', orders: 95 },
  { hostel: 'Boys Block 4', orders: 50 },
  { hostel: 'Girls Gate 1', orders: 80 },
  { hostel: 'Girls Gate 2', orders: 70 }
];

export const AnalyticsPanel: React.FC = () => {
  return (
    <div className="space-y-6">
      {/* Metric Highlights */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="glass-card p-4 rounded-xl space-y-1">
          <div className="text-xs font-bold text-gray-400 uppercase">Gross Order Volume</div>
          <div className="text-2xl font-extrabold text-white flex items-center justify-between">
            <span>₹42,850</span>
            <DollarSign className="w-6 h-6 text-emerald-500" />
          </div>
          <p className="text-[11px] text-emerald-400">↑ +24% vs last week</p>
        </div>

        <div className="glass-card p-4 rounded-xl space-y-1">
          <div className="text-xs font-bold text-gray-400 uppercase">Avg Delivery Time</div>
          <div className="text-2xl font-extrabold text-white flex items-center justify-between">
            <span>26.4 Mins</span>
            <Clock className="w-6 h-6 text-amber-500" />
          </div>
          <p className="text-[11px] text-gray-400">Highway dhaba to Hostel Gate</p>
        </div>

        <div className="glass-card p-4 rounded-xl space-y-1">
          <div className="text-xs font-bold text-gray-400 uppercase">Active Students</div>
          <div className="text-2xl font-extrabold text-white flex items-center justify-between">
            <span>485 Unique</span>
            <Users className="w-6 h-6 text-orange-500" />
          </div>
          <p className="text-[11px] text-emerald-400">VIT Bhopal Campus Active</p>
        </div>

        <div className="glass-card p-4 rounded-xl space-y-1">
          <div className="text-xs font-bold text-gray-400 uppercase">Top Dhaba</div>
          <div className="text-2xl font-extrabold text-white flex items-center justify-between">
            <span>Sharma Dhaba</span>
            <Award className="w-6 h-6 text-purple-500" />
          </div>
          <p className="text-[11px] text-gray-400">182 Thalis Delivered</p>
        </div>
      </div>

      {/* Analytics Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Peak Order Hours Area Chart */}
        <div className="glass-card rounded-2xl p-5 border border-[#242F46] space-y-4">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-orange-500" /> Campus Peak Order Hours (Late Night Rush)
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={hourlyOrdersData}>
                <defs>
                  <linearGradient id="colorOrders" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#FF5722" stopOpacity={0.8}/>
                    <stop offset="95%" stopColor="#FF5722" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="hour" stroke="#64748B" fontSize={11} />
                <YAxis stroke="#64748B" fontSize={11} />
                <Tooltip contentStyle={{ background: '#0B0F19', borderColor: '#242F46', borderRadius: '12px', fontSize: '12px' }} />
                <Area type="monotone" dataKey="orders" stroke="#FF5722" fillOpacity={1} fill="url(#colorOrders)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Hostel Dropoff Distribution Bar Chart */}
        <div className="glass-card rounded-2xl p-5 border border-[#242F46] space-y-4">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-amber-500" /> Hostel Block Delivery Volume
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hostelOrdersData}>
                <XAxis dataKey="hostel" stroke="#64748B" fontSize={10} />
                <YAxis stroke="#64748B" fontSize={11} />
                <Tooltip contentStyle={{ background: '#0B0F19', borderColor: '#242F46', borderRadius: '12px', fontSize: '12px' }} />
                <Bar dataKey="orders" fill="#FF9800" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
