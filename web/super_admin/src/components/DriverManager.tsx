import React, { useMemo, useState } from 'react';
import { Bike, ChevronRight, Clock, Phone, SearchX, Star, Users, Wallet, Zap } from 'lucide-react';
import { DriverPartner } from '../types';
import { inr } from '../lib/tokens';
import { AnimatedNumber } from './ui/AnimatedNumber';
import { Avatar } from './ui/Avatar';
import { Drawer } from './ui/Drawer';
import { EmptyState } from './ui/EmptyState';
import { KpiTile } from './ui/KpiTile';
import { SkeletonCard } from './ui/Skeleton';

interface DriverManagerProps {
  drivers: DriverPartner[];
  onToggleStatus?: (driverId: string) => void;
  loading?: boolean;
  query?: string;
  onClearQuery?: () => void;
}

type DutyFilter = 'ALL' | DriverPartner['dutyStatus'];

const DUTY: Record<DriverPartner['dutyStatus'], { label: string; dot: string; text: string; bg: string; live: boolean }> = {
  ONLINE: { label: 'Online', dot: 'bg-kraveo-g400', text: 'text-kraveo-g300', bg: 'bg-kraveo-g400/15', live: true },
  IN_TRANSIT: { label: 'In transit', dot: 'bg-kraveo-status-pickedUp', text: 'text-kraveo-status-pickedUp', bg: 'bg-kraveo-status-pickedUp/15', live: true },
  OFFLINE: { label: 'Offline', dot: 'bg-kraveo-ink3', text: 'text-kraveo-ink2', bg: 'bg-kraveo-surface2', live: false },
};

const DutyPill: React.FC<{ status: DriverPartner['dutyStatus'] }> = ({ status }) => {
  const d = DUTY[status] ?? DUTY.OFFLINE;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${d.bg} ${d.text}`}>
      <span className={`k-dot ${d.dot} ${d.live ? 'k-dot-live' : ''}`} aria-hidden="true" />{d.label}
    </span>
  );
};

const dash = (value?: string): string => (value && value.trim() ? value : '-');

const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="k-inset px-4 py-3">
    <p className="k-label">{label}</p>
    <div className="mt-0.5 break-words text-sm font-bold text-kraveo-ink">{children}</div>
  </div>
);

export const DriverManager: React.FC<DriverManagerProps> = ({ drivers, loading = false, query = '', onClearQuery }) => {
  const [filter, setFilter] = useState<DutyFilter>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedDriver = drivers.find((d) => d.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return drivers.filter((d) => {
      const matchesFilter = filter === 'ALL' || d.dutyStatus === filter;
      const matchesSearch = !q || d.name.toLowerCase().includes(q) || d.studentRegNo.toLowerCase().includes(q) || d.runnerCode.toLowerCase().includes(q);
      return matchesFilter && matchesSearch;
    });
  }, [drivers, filter, query]);

  const counts = useMemo(() => ({
    ALL: drivers.length,
    ONLINE: drivers.filter((d) => d.dutyStatus === 'ONLINE').length,
    IN_TRANSIT: drivers.filter((d) => d.dutyStatus === 'IN_TRANSIT').length,
    OFFLINE: drivers.filter((d) => d.dutyStatus === 'OFFLINE').length,
  }), [drivers]);

  const hasData = drivers.length > 0;
  const activeCount = counts.ONLINE + counts.IN_TRANSIT;
  const totalPayoutToday = drivers.reduce((sum, d) => sum + d.totalEarningsToday, 0);
  const totalOrdersToday = drivers.reduce((sum, d) => sum + d.ordersToday, 0);
  const timed = drivers.filter((d) => d.avgCompletionTimeMinutes > 0);
  const avgCompletion = timed.length ? timed.reduce((sum, d) => sum + d.avgCompletionTimeMinutes, 0) / timed.length : null;
  const initialLoad = loading && !hasData;

  return (
    <div className="space-y-5">
      <section aria-label="Runner summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiTile index={0} loading={initialLoad} label="On duty" icon={Users}
          value={<><AnimatedNumber value={hasData ? activeCount : null} />{hasData && <span className="text-xl text-kraveo-ink3"> / {drivers.length}</span>}</>}
          note={hasData ? `${counts.IN_TRANSIT} delivering now` : 'No runners registered'} />
        <KpiTile index={1} loading={initialLoad} label="Trips today" icon={Zap} tone="text-kraveo-status-pickedUp" toneBg="bg-kraveo-status-pickedUp/15"
          value={<AnimatedNumber value={hasData ? totalOrdersToday : null} />} note="Completed by all runners" />
        <KpiTile index={2} loading={initialLoad} label="Payouts today" icon={Wallet} tone="text-kraveo-status-ready" toneBg="bg-kraveo-status-ready/15"
          value={<AnimatedNumber value={hasData ? totalPayoutToday : null} prefix={'₹'} />} note="Sum of runner earnings" />
        <KpiTile index={3} loading={initialLoad} label="Avg completion" icon={Clock} tone="text-kraveo-status-atGate" toneBg="bg-kraveo-status-atGate/15"
          value={<AnimatedNumber value={avgCompletion} decimals={1} suffix={avgCompletion === null ? '' : ' min'} />} note={avgCompletion === null ? 'No completed trips reported' : `Across ${timed.length} runner${timed.length === 1 ? '' : 's'}`} />
      </section>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0" role="group" aria-label="Filter by duty status">
        {([['ALL', 'All runners'], ['ONLINE', 'Online'], ['IN_TRANSIT', 'In transit'], ['OFFLINE', 'Offline']] as const).map(([id, label]) => (
          <button key={id} className="k-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${filter === id ? 'bg-kraveo-g400/25' : 'bg-kraveo-line/70'}`}>{counts[id]}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 2xl:grid-cols-3">
        {initialLoad && Array.from({ length: 6 }).map((_, index) => <SkeletonCard key={index} lines={2} />)}
        {!initialLoad && !hasData && <div className="k-card sm:col-span-2 2xl:col-span-3"><EmptyState icon={Bike} title="No runners yet" description="Runner partners appear here once they register through the driver app." /></div>}
        {!initialLoad && hasData && filtered.length === 0 && (
          <div className="k-card sm:col-span-2 2xl:col-span-3">
            <EmptyState icon={SearchX} title="No runners match" description="Nothing matches the current filter and search." action={<button className="k-btn-ghost" onClick={() => { setFilter('ALL'); onClearQuery?.(); }}>Clear filters</button>} />
          </div>
        )}
        {filtered.map((d, index) => (
          <div
            key={d.id}
            role="button"
            tabIndex={0}
            aria-label={`Open details for ${d.name}`}
            onClick={() => setSelectedId(d.id)}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(d.id); } }}
            className="k-card k-card-hover k-reveal cursor-pointer p-5 text-left"
            style={{ ['--i' as string]: Math.min(index, 10) }}
          >
            <div className="flex items-start gap-3.5">
              <Avatar name={d.name} imageUrl={d.avatarUrl} size="lg" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-display text-lg font-bold leading-tight text-kraveo-ink">{d.name}</h3>
                <p className="truncate text-xs text-kraveo-ink3">{d.studentRegNo ? `Reg ${d.studentRegNo}` : 'Reg no. not provided'}</p>
                <div className="mt-2"><DutyPill status={d.dutyStatus} /></div>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-kraveo-ink3" aria-hidden="true" />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="k-inset px-2 py-2.5"><p className="k-label !text-[10px]">Trips</p><p className="k-num text-lg text-kraveo-ink">{d.ordersToday}</p></div>
              <div className="k-inset px-2 py-2.5"><p className="k-label !text-[10px]">Payout</p><p className="k-num text-lg text-kraveo-ink">{inr(d.totalEarningsToday)}</p></div>
              <div className="k-inset px-2 py-2.5"><p className="k-label !text-[10px]">Rating</p>
                <p className="k-num flex items-center justify-center gap-1 text-lg text-kraveo-ink">
                  {d.rating > 0 ? <><Star className="h-3.5 w-3.5 fill-kraveo-yellow text-kraveo-yellow" aria-hidden="true" />{d.rating.toFixed(1)}</> : <span className="text-kraveo-ink3">New</span>}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Drawer
        open={Boolean(selectedDriver)}
        onClose={() => setSelectedId(null)}
        title={selectedDriver?.name ?? 'Runner'}
        subtitle={selectedDriver?.runnerCode ? `Runner code ${selectedDriver.runnerCode}` : 'Runner details'}
        icon={Bike}
        footer={<button onClick={() => setSelectedId(null)} className="k-btn-ghost mb-1 w-full">Close</button>}
      >
        {selectedDriver && (
          <div className="space-y-3">
            <div className="flex items-center gap-4 pb-2">
              <Avatar name={selectedDriver.name} imageUrl={selectedDriver.avatarUrl} size="lg" />
              <div><DutyPill status={selectedDriver.dutyStatus} /><p className="mt-2 text-xs text-kraveo-ink3">Joined {new Date(selectedDriver.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <DetailRow label="Avg completion">{selectedDriver.avgCompletionTimeMinutes > 0 ? `${selectedDriver.avgCompletionTimeMinutes} min` : '-'}</DetailRow>
              <DetailRow label="On-time rate">{selectedDriver.onTimeRatePercent > 0 ? `${selectedDriver.onTimeRatePercent}%` : '-'}</DetailRow>
              <DetailRow label="Trips today">{selectedDriver.ordersToday}</DetailRow>
              <DetailRow label="Earned today">{inr(selectedDriver.totalEarningsToday)}</DetailRow>
            </div>
            <DetailRow label="Student reg no.">{dash(selectedDriver.studentRegNo)}</DetailRow>
            <DetailRow label="Phone">
              {selectedDriver.phone ? <a className="inline-flex items-center gap-1.5 text-kraveo-g300 hover:underline" href={`tel:${selectedDriver.phone}`}><Phone className="h-3.5 w-3.5" aria-hidden="true" />{selectedDriver.phone}</a> : '-'}
            </DetailRow>
            <DetailRow label="Emergency phone">
              {selectedDriver.emergencyPhone ? <a className="inline-flex items-center gap-1.5 text-kraveo-g300 hover:underline" href={`tel:${selectedDriver.emergencyPhone}`}><Phone className="h-3.5 w-3.5" aria-hidden="true" />{selectedDriver.emergencyPhone}</a> : '-'}
            </DetailRow>
            <DetailRow label="Vehicle">{selectedDriver.vehicleType}{selectedDriver.vehicleRegNo !== 'Not registered' ? ` (${selectedDriver.vehicleRegNo})` : ''}</DetailRow>
            <DetailRow label="Payout UPI"><span className="font-mono">{dash(selectedDriver.upiId)}</span></DetailRow>
          </div>
        )}
      </Drawer>
    </div>
  );
};
