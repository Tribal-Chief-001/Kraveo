import React, { useMemo, useState } from 'react';
import { Bike, ChevronRight, Loader2, Moon, Phone, Plus, SearchX, Truck, Users, Zap } from 'lucide-react';
import { DriverPartner, Order } from '../types';
import { tripsTodayByRider } from '../lib/dashboardStats';
import { AddPartnerDrawer } from './AddPartnerDrawer';
import { RiderAction, RiderActionDialogs } from './RiderActions';
import { apiService } from '../services/api';
import { adminErrorText } from '../lib/errors';
import { useToast } from './ui/Toast';
import { AnimatedNumber } from './ui/AnimatedNumber';
import { ApprovalPill } from './ui/ApprovalPill';
import { Avatar } from './ui/Avatar';
import { Drawer } from './ui/Drawer';
import { EmptyState } from './ui/EmptyState';
import { KpiTile } from './ui/KpiTile';
import { SkeletonCard } from './ui/Skeleton';

interface DriverManagerProps {
  drivers: DriverPartner[];
  /** The loaded orders: "Trips today" is counted from them (deliveries finished today, India time). */
  orders?: Order[];
  /** Current time from the app, so the count rolls over at midnight. */
  now?: number;
  onToggleStatus?: (driverId: string) => void;
  /** Called after a rider was created, so the list reloads. */
  onCreated?: () => void;
  loading?: boolean;
  query?: string;
  onClearQuery?: () => void;
  /** Docs/28: a rider was suspended, reactivated, removed or restored: reload the list. Falls back to `onCreated`. */
  onChanged?: () => void;
  /** Logs the admin out on 401/403 (the action dialogs). */
  onAuthError?: (error: unknown) => void;
  /** Opens an order in the order drawer (the blocking deliveries in the dialogs are links). */
  onOpenOrder?: (orderId: string) => void;
}

type DutyFilter = 'ALL' | 'REMOVED' | DriverPartner['dutyStatus'];

const isRemoved = (d: Pick<DriverPartner, 'accountStatus'>): boolean => d.accountStatus === 'REMOVED';

const RemovedPill: React.FC = () => <span className="inline-flex whitespace-nowrap rounded-full bg-kraveo-danger/15 px-2.5 py-1 text-[11px] font-bold text-kraveo-danger">Removed</span>;

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

const NO_ORDERS: Order[] = [];

export const DriverManager: React.FC<DriverManagerProps> = ({ drivers, orders = NO_ORDERS, now = Date.now(), onCreated, loading = false, query = '', onClearQuery, onChanged, onAuthError, onOpenOrder }) => {
  const toast = useToast();
  const [action, setAction] = useState<RiderAction | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [filter, setFilter] = useState<DutyFilter>('ALL');
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedDriver = drivers.find((d) => d.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return drivers.filter((d) => {
      const matchesFilter = filter === 'ALL' || (filter === 'REMOVED' ? isRemoved(d) : d.dutyStatus === filter);
      const matchesSearch = !q || d.name.toLowerCase().includes(q) || d.studentRegNo.toLowerCase().includes(q) || d.runnerCode.toLowerCase().includes(q) || d.phone.toLowerCase().includes(q) || d.vehicleRegNo.toLowerCase().includes(q);
      return matchesFilter && matchesSearch;
    });
  }, [drivers, filter, query]);

  const counts = useMemo(() => ({
    ALL: drivers.length,
    ONLINE: drivers.filter((d) => d.dutyStatus === 'ONLINE').length,
    IN_TRANSIT: drivers.filter((d) => d.dutyStatus === 'IN_TRANSIT').length,
    OFFLINE: drivers.filter((d) => d.dutyStatus === 'OFFLINE').length,
    REMOVED: drivers.filter(isRemoved).length,
  }), [drivers]);

  const hasData = drivers.length > 0;
  const activeCount = counts.ONLINE + counts.IN_TRANSIT;
  // Counted from the loaded orders (the server keeps no per-rider daily numbers). Order.driverId is the rider's user id.
  const tripsByRider = useMemo(() => tripsTodayByRider(orders, now), [orders, now]);
  const tripsFor = (driver: DriverPartner): number => (driver.userId ? tripsByRider.get(driver.userId) ?? 0 : 0);
  const totalOrdersToday = drivers.reduce((sum, d) => sum + tripsFor(d), 0);
  const initialLoad = loading && !hasData;

  const reactivate = async (rider: DriverPartner) => {
    if (reactivating) return;
    setReactivating(true);
    try {
      await apiService.decidePartner('DRIVER', rider.id, 'APPROVED');
      toast.success('Reactivated', `${rider.name} can work again. They go on duty from the app.`);
      (onChanged ?? onCreated)?.();
    } catch (e) {
      onAuthError?.(e);
      toast.error('Could not reactivate', adminErrorText(e, 'Please try again.'));
    } finally { setReactivating(false); }
  };

  return (
    <div className="space-y-5">
      <section aria-label="Runner summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiTile index={0} loading={initialLoad} label="On duty" icon={Users}
          value={<><AnimatedNumber value={hasData ? activeCount : null} />{hasData && <span className="text-xl text-kraveo-ink3"> / {drivers.length}</span>}</>}
          note={hasData ? `${counts.IN_TRANSIT} delivering now` : 'No runners registered'} />
        <KpiTile index={1} loading={initialLoad} label="Trips today" icon={Zap} tone="text-kraveo-status-pickedUp" toneBg="bg-kraveo-status-pickedUp/15"
          value={<AnimatedNumber value={hasData ? totalOrdersToday : null} />} note="Delivered today, from the loaded orders" />
        <KpiTile index={2} loading={initialLoad} label="Delivering now" icon={Truck} tone="text-kraveo-status-ready" toneBg="bg-kraveo-status-ready/15"
          value={<AnimatedNumber value={hasData ? counts.IN_TRANSIT : null} />} note="Runners on a delivery" />
        <KpiTile index={3} loading={initialLoad} label="Offline" icon={Moon} tone="text-kraveo-status-atGate" toneBg="bg-kraveo-status-atGate/15"
          value={<AnimatedNumber value={hasData ? counts.OFFLINE : null} />} note="Registered but not on duty" />
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0" role="group" aria-label="Filter by duty status">
        {([['ALL', 'All runners'], ['ONLINE', 'Online'], ['IN_TRANSIT', 'In transit'], ['OFFLINE', 'Offline'], ...(counts.REMOVED > 0 || filter === 'REMOVED' ? [['REMOVED', 'Removed'] as const] : [])] as const).map(([id, label]) => (
          <button key={id} className="k-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${filter === id ? 'bg-kraveo-g400/25' : 'bg-kraveo-line/70'}`}>{counts[id]}</span>
          </button>
        ))}
      </div>
      <button onClick={() => setShowAdd(true)} className="k-btn-accent"><Plus className="h-4 w-4" aria-hidden="true" /> Add rider</button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 2xl:grid-cols-3">
        {initialLoad && Array.from({ length: 6 }).map((_, index) => <SkeletonCard key={index} lines={2} />)}
        {!initialLoad && !hasData && <div className="k-card sm:col-span-2 2xl:col-span-3"><EmptyState icon={Bike} title="No runners yet" description="Riders appear here once you add one or approve an application from the Applications tab." action={<button className="k-btn-accent" onClick={() => setShowAdd(true)}><Plus className="h-4 w-4" aria-hidden="true" /> Add rider</button>} /></div>}
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
                <p className="truncate text-xs text-kraveo-ink3">{d.runnerCode ? `Runner ${d.runnerCode}` : 'No runner code'}{d.phone ? ` · ${d.phone}` : ''}</p>
                <div className="mt-2 flex flex-wrap gap-1.5"><DutyPill status={d.dutyStatus} /><ApprovalPill status={d.approvalStatus} />{isRemoved(d) && <RemovedPill />}</div>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-kraveo-ink3" aria-hidden="true" />
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 text-center">
              <div className="k-inset px-2 py-2.5"><p className="k-label !text-[10px]">Trips today</p><p className="k-num text-lg text-kraveo-ink">{tripsFor(d)}</p></div>
            </div>
          </div>
        ))}
      </div>

      <Drawer
        open={Boolean(selectedDriver)}
        onClose={() => { setSelectedId(null); setAction(null); }}
        title={selectedDriver?.name ?? 'Runner'}
        subtitle={selectedDriver?.runnerCode ? `Runner code ${selectedDriver.runnerCode}` : 'Runner details'}
        icon={Bike}
        focusFirstField={false}
        footer={(
          <div className="flex flex-wrap gap-2 pb-4">
            {selectedDriver && !isRemoved(selectedDriver) && selectedDriver.approvalStatus === 'APPROVED' && <button type="button" className="k-btn-ghost min-w-[7rem] flex-1" onClick={() => setAction('suspend')}>Suspend</button>}
            {selectedDriver && !isRemoved(selectedDriver) && selectedDriver.approvalStatus === 'SUSPENDED' && (
              <button type="button" className="k-btn-primary min-w-[7rem] flex-1" disabled={reactivating} aria-busy={reactivating} onClick={() => void reactivate(selectedDriver)}>{reactivating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Reactivate</button>
            )}
            {selectedDriver && isRemoved(selectedDriver) && <button type="button" className="k-btn-primary min-w-[7rem] flex-1" onClick={() => setAction('restore')}>Restore</button>}
            {selectedDriver && !isRemoved(selectedDriver) && selectedDriver.userId && <button type="button" className="k-btn-ghost min-w-[7rem] flex-1" onClick={() => setAction('reset')}>Reset password</button>}
            {selectedDriver && !isRemoved(selectedDriver) && <button type="button" className="k-btn-danger min-w-[7rem] flex-1" onClick={() => setAction('remove')}>Remove</button>}
            <button type="button" onClick={() => { setSelectedId(null); setAction(null); }} className="k-btn-ghost min-w-[7rem] flex-1">Close</button>
          </div>
        )}
      >
        {selectedDriver && (
          <div className="space-y-3">
            <div className="flex items-center gap-4 pb-2">
              <Avatar name={selectedDriver.name} imageUrl={selectedDriver.avatarUrl} size="lg" />
              <div><div className="flex flex-wrap gap-1.5"><DutyPill status={selectedDriver.dutyStatus} />{isRemoved(selectedDriver) && <RemovedPill />}</div><p className="mt-2 text-xs text-kraveo-ink3">Joined {new Date(selectedDriver.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <DetailRow label="Trips today">{tripsFor(selectedDriver)}</DetailRow>
            </div>
            {isRemoved(selectedDriver) && <p role="status" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 p-3 text-sm text-kraveo-ink">This rider was removed. They cannot sign in. Their past deliveries and payout records stay, and their phone number stays reserved. Restore them to let them sign in again.</p>}
            {selectedDriver.approvalStatus && selectedDriver.approvalStatus !== 'APPROVED' && <DetailRow label="Approval"><ApprovalPill status={selectedDriver.approvalStatus} /></DetailRow>}
            {selectedDriver.lastLoginAt && <DetailRow label="Last sign-in">{new Date(selectedDriver.lastLoginAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</DetailRow>}
            {selectedDriver.studentRegNo && <DetailRow label="Student reg no.">{dash(selectedDriver.studentRegNo)}</DetailRow>}
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
        {selectedDriver && (
          <RiderActionDialogs action={action} rider={selectedDriver} onClose={() => setAction(null)} onDone={() => (onChanged ?? onCreated)?.()} onAuthError={(e) => onAuthError?.(e)} onOpenOrder={onOpenOrder} />
        )}
      </Drawer>
      <AddPartnerDrawer open={showAdd} kind="DRIVER" onClose={() => setShowAdd(false)} onCreated={() => onCreated?.()} />
    </div>
  );
};
