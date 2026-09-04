import React, { useEffect, useState } from 'react';
import { TrendingUp, DollarSign, Clock, Users, Award, RefreshCw } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, BarChart, Bar } from 'recharts';
import { AnalyticsData } from '../types';
import { apiService } from '../services/api';

type Range = 'today' | '7d' | '30d';

export const AnalyticsPanel: React.FC = () => {
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = async (nextRange = range) => {
    setLoading(true); setError('');
    try { setData(await apiService.fetchAnalytics(nextRange)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Analytics could not be loaded.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [range]);

  const cards = data ? [
    { label: 'Gross paid volume', value: `₹${data.grossOrderVolume.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, note: `${data.orderCount} orders in selected range`, icon: DollarSign, color: 'text-emerald-500' },
    { label: 'Average delivery time', value: `${data.averageDeliveryMinutes.toFixed(1)} min`, note: 'Created to last persisted update', icon: Clock, color: 'text-amber-500' },
    { label: 'Active students', value: data.activeStudents.toLocaleString('en-IN'), note: `${data.cancellationRate.toFixed(1)}% cancellation rate`, icon: Users, color: 'text-orange-500' },
    { label: 'Top vendor', value: data.topVendor?.name || 'No delivered orders', note: data.topVendor ? `${data.topVendor.deliveredOrders} delivered orders` : 'Awaiting completed orders', icon: Award, color: 'text-purple-500' },
  ] : [];

  return <div className="space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div><h2 className="text-lg font-bold text-white">Operations analytics</h2><p className="text-xs text-gray-400">Calculated from persisted orders; no sample metrics are shown.</p></div>
      <div className="flex items-center gap-2">
        {(['today', '7d', '30d'] as Range[]).map((option) => <button key={option} onClick={() => setRange(option)} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${range === option ? 'bg-[#fdd400] text-[#0B0F19]' : 'border border-[#242F46] text-gray-300'}`}>{option === 'today' ? 'Today' : option}</button>)}
        <button aria-label="Refresh analytics" title="Refresh analytics" onClick={() => void load()} className="rounded-lg border border-[#242F46] p-2 text-gray-300 hover:text-white"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>
    </div>
    {error && <div role="alert" className="rounded-xl border border-red-500/40 bg-red-950/30 px-4 py-3 text-xs text-red-200">{error}</div>}
    {loading && !data && <div className="rounded-xl border border-[#242F46] p-8 text-center text-sm text-gray-400">Loading persisted analytics…</div>}
    {!loading && !data && !error && <div className="rounded-xl border border-[#242F46] p-8 text-center text-sm text-gray-400">No analytics data available for this range.</div>}
    {data && <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, note, icon: Icon, color }) => <div key={label} className="glass-card rounded-xl p-4 space-y-1"><div className="text-xs font-bold uppercase text-gray-400">{label}</div><div className="flex items-center justify-between gap-2 text-2xl font-extrabold text-white"><span className="truncate">{value}</span><Icon className={`h-6 w-6 shrink-0 ${color}`} /></div><p className="text-[11px] text-gray-400">{note}</p></div>)}</div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="glass-card rounded-2xl border border-[#242F46] p-5 space-y-4"><h3 className="flex items-center gap-2 text-sm font-bold text-white"><TrendingUp className="h-4 w-4 text-orange-500" /> Orders by hour</h3><div className="h-64"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data.hourlyOrders}><defs><linearGradient id="colorOrders" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#FF5722" stopOpacity={0.8}/><stop offset="95%" stopColor="#FF5722" stopOpacity={0}/></linearGradient></defs><XAxis dataKey="hour" stroke="#64748B" fontSize={10} interval={2}/><YAxis stroke="#64748B" fontSize={11} allowDecimals={false}/><Tooltip contentStyle={{ background: '#0B0F19', borderColor: '#242F46', borderRadius: '12px', fontSize: '12px' }}/><Area type="monotone" dataKey="orders" stroke="#FF5722" fill="url(#colorOrders)"/></AreaChart></ResponsiveContainer></div></div>
        <div className="glass-card rounded-2xl border border-[#242F46] p-5 space-y-4"><h3 className="flex items-center gap-2 text-sm font-bold text-white"><Users className="h-4 w-4 text-amber-500" /> Hostel drop-off volume</h3>{data.hostelOrders.length ? <div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.hostelOrders}><XAxis dataKey="hostel" stroke="#64748B" fontSize={10}/><YAxis stroke="#64748B" fontSize={11} allowDecimals={false}/><Tooltip contentStyle={{ background: '#0B0F19', borderColor: '#242F46', borderRadius: '12px', fontSize: '12px' }}/><Bar dataKey="orders" fill="#FF9800" radius={[6, 6, 0, 0]}/></BarChart></ResponsiveContainer></div> : <div className="flex h-64 items-center justify-center text-sm text-gray-500">No non-cancelled orders in this range.</div>}</div>
      </div>
      <p className="text-right text-[11px] text-gray-500">Generated {new Date(data.generatedAt).toLocaleString()}</p>
    </>}
  </div>;
};
