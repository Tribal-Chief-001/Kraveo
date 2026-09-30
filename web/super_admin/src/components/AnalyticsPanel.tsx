import React, { useEffect, useMemo, useState } from 'react';
import { Award, BarChart3, Clock, IndianRupee, RefreshCw, TrendingUp, Users } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AnalyticsData } from '../types';
import { apiService } from '../services/api';
import { palette } from '../lib/tokens';
import { AnimatedNumber } from './ui/AnimatedNumber';
import { EmptyState } from './ui/EmptyState';
import { KpiTile } from './ui/KpiTile';
import { Skeleton } from './ui/Skeleton';

type Range = 'today' | '7d' | '30d';

const RANGE_LABEL: Record<Range, string> = { today: 'Today', '7d': '7 days', '30d': '30 days' };

const reducedMotion = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const AXIS = { fill: palette.ink3, fontSize: 11, fontFamily: 'Plus Jakarta Sans Variable, system-ui, sans-serif' };

const tooltipProps = {
  contentStyle: { background: palette.surface2, border: `1px solid ${palette.line}`, borderRadius: 16, fontSize: 12, color: palette.ink, boxShadow: '0 18px 40px rgba(0,0,0,0.42)' },
  labelStyle: { color: palette.ink2, fontWeight: 700, marginBottom: 2 },
  itemStyle: { color: palette.ink },
  cursor: { stroke: palette.line, fill: 'rgba(67,174,85,0.08)' },
} as const;

const ChartCard: React.FC<{ title: string; icon: React.ElementType; insight?: string; index: number; children: React.ReactNode }> = ({ title, icon: Icon, insight, index, children }) => (
  <section className="k-card k-reveal p-4 sm:p-5" style={{ ['--i' as string]: index }}>
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <h2 className="flex items-center gap-2 font-display text-base font-bold text-kraveo-ink"><Icon className="h-4 w-4 text-kraveo-g400" aria-hidden="true" />{title}</h2>
      {insight && <span className="rounded-full bg-kraveo-surface2 px-3 py-1 text-xs font-semibold text-kraveo-ink2">{insight}</span>}
    </div>
    {children}
  </section>
);

export const AnalyticsPanel: React.FC = () => {
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const animate = !reducedMotion();

  const load = async (nextRange = range) => {
    setLoading(true); setError('');
    try { setData(await apiService.fetchAnalytics(nextRange)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Analytics could not be loaded.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [range]);

  const peak = useMemo(() => {
    const hours = data?.hourlyOrders ?? [];
    return hours.reduce<{ hour: string; orders: number } | null>((best, item) => (item.orders > 0 && (!best || item.orders > best.orders) ? item : best), null);
  }, [data]);
  const topHostel = useMemo(() => {
    const hostels = data?.hostelOrders ?? [];
    return hostels.reduce<{ hostel: string; orders: number } | null>((best, item) => (!best || item.orders > best.orders ? item : best), null);
  }, [data]);

  const hasHourly = Boolean(data?.hourlyOrders.some((item) => item.orders > 0));
  const hostelData = data?.hostelOrders ?? [];
  const firstLoad = loading && !data;
  const noOrders = Boolean(data) && data!.orderCount === 0;

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="px-1 text-sm text-kraveo-ink2">Calculated from persisted orders. Empty means no orders, never sample data.</p>
        <div className="flex items-center gap-2">
          <div className="flex gap-2" role="group" aria-label="Date range">
            {(['today', '7d', '30d'] as Range[]).map((option) => (
              <button key={option} className="k-chip" aria-pressed={range === option} onClick={() => setRange(option)}>{RANGE_LABEL[option]}</button>
            ))}
          </div>
          <button aria-label="Refresh analytics" title="Refresh analytics" onClick={() => void load()} disabled={loading} className="k-icon-btn">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">
          <span>{error}</span>
          <button className="k-btn-ghost !min-h-[36px]" onClick={() => void load()}>Try again</button>
        </div>
      )}

      {!data && !loading && !error && (
        <div className="k-card"><EmptyState icon={BarChart3} title="No analytics for this range" description="Numbers appear once orders exist in the selected range." /></div>
      )}

      {(data || firstLoad) && (
        <>
          <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <KpiTile index={0} loading={firstLoad} label="Gross volume" icon={IndianRupee} tone="text-kraveo-g400"
              value={<AnimatedNumber value={data ? data.grossOrderVolume : null} prefix={'₹'} />} note={data ? `${data.orderCount} order${data.orderCount === 1 ? '' : 's'} in range` : undefined} />
            <KpiTile index={1} loading={firstLoad} label="Avg delivery time" icon={Clock} tone="text-kraveo-status-pickedUp" toneBg="bg-kraveo-status-pickedUp/15"
              value={<AnimatedNumber value={data && data.averageDeliveryMinutes > 0 ? data.averageDeliveryMinutes : null} decimals={1} suffix={data && data.averageDeliveryMinutes > 0 ? ' min' : ''} />}
              note={data && data.averageDeliveryMinutes > 0 ? 'Created to last persisted update' : 'No delivered orders yet'} />
            <KpiTile index={2} loading={firstLoad} label="Active students" icon={Users} tone="text-kraveo-status-accepted" toneBg="bg-kraveo-status-accepted/15"
              value={<AnimatedNumber value={data ? data.activeStudents : null} />} note={data ? `${data.cancellationRate.toFixed(1)}% cancellation rate` : undefined} />
            <KpiTile index={3} loading={firstLoad} label="Top vendor" icon={Award} tone="text-kraveo-status-atGate" toneBg="bg-kraveo-status-atGate/15"
              value={<span className="block truncate text-2xl sm:text-[26px]">{data?.topVendor?.name || '-'}</span>}
              note={data?.topVendor ? `${data.topVendor.deliveredOrders} delivered order${data.topVendor.deliveredOrders === 1 ? '' : 's'}` : 'Awaiting completed orders'} />
          </section>

          <div className="grid grid-cols-1 gap-4 sm:gap-6 xl:grid-cols-2">
            <ChartCard index={4} title="Orders by hour" icon={TrendingUp} insight={peak ? `Peak ${peak.hour} · ${peak.orders} order${peak.orders === 1 ? '' : 's'}` : undefined}>
              {firstLoad ? <Skeleton className="h-64 w-full" /> : hasHourly ? (
                <div className="h-64" role="img" aria-label={peak ? `Orders by hour. Busiest hour is ${peak.hour} with ${peak.orders} orders.` : 'Orders by hour'}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data!.hourlyOrders} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                      <defs>
                        <linearGradient id="kraveoOrdersFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={palette.g400} stopOpacity={0.45} />
                          <stop offset="100%" stopColor={palette.g400} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={palette.line} strokeDasharray="3 5" vertical={false} />
                      <XAxis dataKey="hour" tick={AXIS} tickLine={false} axisLine={{ stroke: palette.line }} interval="preserveStartEnd" minTickGap={20} />
                      <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip {...tooltipProps} formatter={(value: number) => [value, 'Orders']} />
                      <Area type="monotone" dataKey="orders" stroke={palette.g400} strokeWidth={2.5} fill="url(#kraveoOrdersFill)" isAnimationActive={animate} activeDot={{ r: 5, fill: palette.g400, stroke: palette.night, strokeWidth: 2 }} />
                      {peak && <ReferenceDot x={peak.hour} y={peak.orders} r={6} fill={palette.yellow} stroke={palette.night} strokeWidth={2} />}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : <EmptyState icon={BarChart3} title="No orders in this range" description="The chart fills in as soon as orders are placed." className="h-64" />}
            </ChartCard>

            <ChartCard index={5} title="Hostel drop-off volume" icon={Users} insight={topHostel && topHostel.orders > 0 ? `Top ${topHostel.hostel} · ${topHostel.orders}` : undefined}>
              {firstLoad ? <Skeleton className="h-64 w-full" /> : hostelData.length ? (
                <div style={{ height: Math.max(256, hostelData.length * 40 + 24) }} role="img" aria-label="Orders by hostel drop-off">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={hostelData} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
                      <CartesianGrid stroke={palette.line} strokeDasharray="3 5" horizontal={false} />
                      <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
                      <YAxis type="category" dataKey="hostel" tick={AXIS} tickLine={false} axisLine={false} width={96} interval={0} />
                      <Tooltip {...tooltipProps} formatter={(value: number) => [value, 'Orders']} />
                      <Bar dataKey="orders" radius={[0, 8, 8, 0]} barSize={20} isAnimationActive={animate}>
                        {hostelData.map((entry) => <Cell key={entry.hostel} fill={topHostel && entry.hostel === topHostel.hostel && entry.orders > 0 ? '#74C880' : palette.g400} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <EmptyState icon={Users} title={noOrders ? 'No orders in this range' : 'No non-cancelled orders'} description="Drop-off hostels appear here once orders come in." className="h-64" />}
            </ChartCard>
          </div>

          {data && <p className="text-right text-[11px] text-kraveo-ink3">Generated {new Date(data.generatedAt).toLocaleString('en-IN')}</p>}
        </>
      )}
    </div>
  );
};
