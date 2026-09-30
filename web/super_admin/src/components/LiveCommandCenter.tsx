import React, { useEffect, useMemo, useState } from 'react';
import { Bike, Clock, Crosshair, MapPin, PackageCheck, Radio, Timer, UserX, Users } from 'lucide-react';
import { DriverPartner, DriverPin, Order, OrderStatus } from '../types';
import { PIPELINE_ORDER, STATUS_META, inr, statusMeta, timeAgo } from '../lib/tokens';
import { AnimatedNumber } from './ui/AnimatedNumber';
import { Avatar } from './ui/Avatar';
import { EmptyState } from './ui/EmptyState';
import { KpiTile } from './ui/KpiTile';
import { Skeleton } from './ui/Skeleton';

interface LiveCommandCenterProps {
  drivers: DriverPin[];
  orders: Order[];
  driverPartners: DriverPartner[];
  onReassignDriver: (orderId: string, driverId: string | null) => void;
  loading?: boolean;
  query?: string;
}

// Same projection as before: a fixed window around the VIT Bhopal campus.
const projectCoordinate = (lat: number, lng: number) => ({
  top: `${Math.max(8, Math.min(88, 50 - (lat - 23.0768) * 900))}%`,
  left: `${Math.max(6, Math.min(94, 50 + (lng - 76.8524) * 650))}%`,
});

const STALE_AFTER_MS = 15 * 60 * 1000;
const UNASSIGN_VALUE = '__unassign__';

type RunnerState = 'available' | 'assigned' | 'onTheWay' | 'atGate';

const RUNNER_STATE: Record<RunnerState, { label: string; hex: string; dot: string; text: string }> = {
  available: { label: 'Available', hex: '#43AE55', dot: 'bg-kraveo-g400', text: 'text-kraveo-g400' },
  assigned: { label: 'Assigned', hex: '#14B8A6', dot: 'bg-kraveo-status-accepted', text: 'text-kraveo-status-accepted' },
  onTheWay: { label: 'On the way', hex: '#3B82F6', dot: 'bg-kraveo-status-pickedUp', text: 'text-kraveo-status-pickedUp' },
  atGate: { label: 'At gate', hex: '#8B5CF6', dot: 'bg-kraveo-status-atGate', text: 'text-kraveo-status-atGate' },
};

const shortId = (id: string): string => (id.length > 9 ? `#${id.slice(-6).toUpperCase()}` : `#${id}`);

const orderMatches = (order: Order, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [order.id, order.vendorName, order.customerName, order.dropoffHostel, order.driverName]
    .some((value) => Boolean(value) && String(value).toLowerCase().includes(q));
};

export const LiveCommandCenter: React.FC<LiveCommandCenterProps> = ({ drivers, orders, driverPartners, onReassignDriver, loading = false, query = '' }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const initialLoad = loading && orders.length === 0 && driverPartners.length === 0;

  const activeOrders = useMemo(() => orders.filter((order) => !['DELIVERED', 'CANCELLED'].includes(order.status)), [orders]);
  const pendingCount = orders.filter((order) => order.status === 'PLACED').length;
  const runnersOnline = driverPartners.filter((driver) => driver.dutyStatus === 'ONLINE' || driver.dutyStatus === 'IN_TRANSIT').length;

  // Average created -> last update over delivered orders in the feed (same definition the analytics note uses).
  const avgDeliveryMinutes = useMemo(() => {
    const spans = orders
      .filter((order) => order.status === 'DELIVERED' && order.updatedAt)
      .map((order) => (new Date(order.updatedAt as string).getTime() - new Date(order.createdAt).getTime()) / 60000)
      .filter((minutes) => Number.isFinite(minutes) && minutes > 0);
    return spans.length ? { value: spans.reduce((sum, minutes) => sum + minutes, 0) / spans.length, count: spans.length } : null;
  }, [orders]);

  const activeByDriver = useMemo(() => {
    const map = new Map<string, Order>();
    activeOrders.forEach((order) => { if (order.driverId) map.set(order.driverId, order); });
    return map;
  }, [activeOrders]);

  const runnerState = (driver: DriverPin): RunnerState => {
    const order = activeByDriver.get(driver.id);
    if (!order) return 'available';
    if (order.status === 'ARRIVED_AT_GATE') return 'atGate';
    if (order.status === 'PICKED_UP') return 'onTheWay';
    return 'assigned';
  };

  const isStale = (driver: DriverPin): boolean => {
    if (!driver.lastUpdated) return false;
    const t = new Date(driver.lastUpdated).getTime();
    return Number.isFinite(t) && now - t > STALE_AFTER_MS;
  };

  const plottable = drivers.filter((driver) => Number.isFinite(driver.lat) && Number.isFinite(driver.lng));
  const stateCounts = plottable.reduce<Record<RunnerState, number>>((acc, driver) => { acc[runnerState(driver)] += 1; return acc; }, { available: 0, assigned: 0, onTheWay: 0, atGate: 0 });

  const visibleOrders = activeOrders.filter((order) => orderMatches(order, query));
  const lanes = PIPELINE_ORDER.map((key) => ({
    key,
    meta: STATUS_META[key],
    orders: visibleOrders.filter((order) => statusMeta(order.status).key === key),
  }));

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* KPI strip: every number comes from the loaded feeds; "-" when a source has nothing to report */}
      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiTile index={0} loading={initialLoad} label="Active deliveries" icon={Bike} tone="text-kraveo-status-pickedUp" toneBg="bg-kraveo-status-pickedUp/15"
          value={<AnimatedNumber value={activeOrders.length} />} note={activeOrders.length ? 'Orders not yet delivered' : 'No open orders'} />
        <KpiTile index={1} loading={initialLoad} label="Drivers online" icon={Users}
          value={<AnimatedNumber value={driverPartners.length ? runnersOnline : null} />}
          note={driverPartners.length ? `of ${driverPartners.length} registered runners` : 'Runner roster unavailable'} />
        <KpiTile index={2} loading={initialLoad} label="Pending orders" icon={PackageCheck} tone="text-kraveo-status-placed" toneBg="bg-kraveo-status-placed/15"
          value={<AnimatedNumber value={pendingCount} />} note={pendingCount ? 'Waiting for the vendor to accept' : 'Nothing waiting'} />
        <KpiTile index={3} loading={initialLoad} label="Avg delivery time" icon={Timer} tone="text-kraveo-status-atGate" toneBg="bg-kraveo-status-atGate/15"
          value={<AnimatedNumber value={avgDeliveryMinutes ? avgDeliveryMinutes.value : null} decimals={1} suffix={avgDeliveryMinutes ? ' min' : ''} />}
          note={avgDeliveryMinutes ? `Placed to last update, ${avgDeliveryMinutes.count} delivered` : 'No delivered orders yet'} />
      </section>

      {/* Map + runners */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6" aria-label="Runner map">
        <div className="k-card k-reveal flex h-[420px] min-w-0 flex-col overflow-hidden p-3 sm:h-[480px] sm:p-4 lg:col-span-2" style={{ ['--i' as string]: 4 }}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-k-sm bg-kraveo-g400/15 text-kraveo-g400"><Crosshair className="h-4 w-4" aria-hidden="true" /></span>
              <div>
                <h2 className="font-display text-base font-bold leading-tight text-kraveo-ink">Live coordinate view</h2>
                <p className="text-[11px] text-kraveo-ink3">VIT Bhopal region</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-kraveo-surface2 px-3 py-1 text-xs font-bold text-kraveo-ink2">
              <Radio className="h-3.5 w-3.5 text-kraveo-g400" aria-hidden="true" />{plottable.length} runner{plottable.length === 1 ? '' : 's'} plotted
            </span>
          </div>

          <div className="relative flex-1 overflow-hidden rounded-k-lg border border-kraveo-line bg-[radial-gradient(ellipse_at_50%_40%,#12281A_0%,#0B140D_55%,#080D09_100%)]">
            <div className="k-map-grid absolute inset-0" />
            <div className="absolute inset-x-6 top-1/2 border-t border-dashed border-kraveo-g400/20" />
            <div className="absolute inset-y-6 left-1/2 border-l border-dashed border-kraveo-g400/20" />
            <span className="absolute left-3 top-3 rounded-md bg-kraveo-night/70 px-2 py-1 text-[10px] font-bold tracking-widest text-kraveo-ink3">N</span>

            {plottable.map((driver) => {
              const state = runnerState(driver);
              const s = RUNNER_STATE[state];
              const stale = isStale(driver);
              const description = `${driver.name}, ${s.label.toLowerCase()}, ${driver.lat.toFixed(5)}, ${driver.lng.toFixed(5)}${driver.lastUpdated ? `, updated ${timeAgo(driver.lastUpdated, now)}` : ''}${stale ? ', location is stale' : ''}`;
              return (
                <div
                  key={driver.id}
                  tabIndex={0}
                  role="img"
                  aria-label={description}
                  style={projectCoordinate(driver.lat, driver.lng)}
                  className={`group absolute -translate-x-1/2 -translate-y-1/2 outline-none transition-[top,left] duration-slow ease-emphasized focus-visible:z-20 hover:z-20 ${stale ? 'opacity-50' : ''}`}
                >
                  <div className="relative mx-auto flex h-5 w-5 items-center justify-center">
                    {!stale && <span className="absolute inset-0 animate-ring-out rounded-full" style={{ backgroundColor: s.hex }} aria-hidden="true" />}
                    <span className="relative h-3.5 w-3.5 rounded-full border-2 border-kraveo-night" style={{ backgroundColor: s.hex, boxShadow: `0 0 14px ${s.hex}` }} />
                  </div>
                  <div className="mt-1 max-w-[7rem] truncate rounded-full border border-kraveo-line bg-kraveo-night/85 px-2 py-0.5 text-center text-[10px] font-bold text-kraveo-ink backdrop-blur group-hover:border-kraveo-g400/50 group-focus-visible:border-kraveo-g400/50">{driver.name}</div>
                  <div role="tooltip" className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 hidden w-max max-w-[14rem] -translate-x-1/2 rounded-k-sm border border-kraveo-line bg-kraveo-surface2 px-3 py-2 text-[11px] leading-snug text-kraveo-ink2 shadow-k-lift group-hover:block group-focus-visible:block">
                    <p className="font-bold text-kraveo-ink">{driver.name}</p>
                    <p className={s.text}>{s.label}{stale ? ' · stale' : ''}</p>
                    <p className="font-mono text-kraveo-ink3">{driver.lat.toFixed(5)}, {driver.lng.toFixed(5)}</p>
                    {driver.lastUpdated && <p className="text-kraveo-ink3">Updated {timeAgo(driver.lastUpdated, now)}</p>}
                  </div>
                </div>
              );
            })}

            {plottable.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <EmptyState icon={MapPin} title="No runner positions yet" description="Markers appear here as soon as the location feed reports a runner's position." />
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs text-kraveo-ink2" aria-label="Map legend" role="group">
            {(Object.keys(RUNNER_STATE) as RunnerState[]).map((state) => (
              <span key={state} className="inline-flex items-center gap-1.5">
                <span className={`k-dot ${RUNNER_STATE[state].dot}`} aria-hidden="true" />
                {RUNNER_STATE[state].label}
                <span className="font-bold tabular-nums text-kraveo-ink">{stateCounts[state]}</span>
              </span>
            ))}
            <span className="ml-auto hidden text-[11px] text-kraveo-ink3 sm:inline">Faded marker: no update for 15 min</span>
          </div>
        </div>

        <div className="k-card k-reveal flex max-h-[420px] min-w-0 flex-col overflow-hidden p-4 sm:max-h-[480px] sm:h-[480px]" style={{ ['--i' as string]: 5 }}>
          <div className="mb-3 flex items-center justify-between border-b border-kraveo-line pb-3">
            <h2 className="flex items-center gap-2 font-display text-base font-bold text-kraveo-ink"><Bike className="h-4 w-4 text-kraveo-g400" aria-hidden="true" /> Tracked runners</h2>
            <span className="rounded-full bg-kraveo-surface2 px-2.5 py-0.5 text-xs font-bold tabular-nums text-kraveo-ink2">{drivers.length}</span>
          </div>
          <ul className="-mx-1 flex-1 space-y-1.5 overflow-y-auto px-1">
            {initialLoad && Array.from({ length: 4 }).map((_, index) => <li key={index}><Skeleton className="h-14 w-full" /></li>)}
            {!initialLoad && drivers.length === 0 && <li><EmptyState icon={Bike} title="No location feed" description="No runner has reported a location yet." className="py-8" /></li>}
            {drivers.map((driver) => {
              const state = runnerState(driver);
              const order = activeByDriver.get(driver.id);
              return (
                <li key={driver.id} className="flex items-center gap-3 rounded-k-md border border-transparent p-2.5 transition-colors hover:border-kraveo-line hover:bg-kraveo-surface2">
                  <Avatar name={driver.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-kraveo-ink">{driver.name}</p>
                    <p className="truncate text-[11px] text-kraveo-ink3">{order ? `${shortId(order.id)} · ${order.dropoffHostel}` : `Updated ${timeAgo(driver.lastUpdated, now)}`}</p>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold ${RUNNER_STATE[state].text}`}><span className={`k-dot ${RUNNER_STATE[state].dot}`} aria-hidden="true" />{RUNNER_STATE[state].label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* Delivery pipeline lanes */}
      <section aria-label="Delivery pipeline" className="space-y-3">
        <div className="flex items-center justify-between gap-3 px-1">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold text-kraveo-ink"><Clock className="h-4 w-4 text-kraveo-g400" aria-hidden="true" /> Delivery pipeline
            <span className="rounded-full bg-kraveo-surface2 px-2.5 py-0.5 text-xs font-bold tabular-nums text-kraveo-ink2">{visibleOrders.length}</span>
          </h2>
          {query.trim() && <span className="text-xs text-kraveo-ink3">Filtered by "{query.trim()}"</span>}
        </div>

        <div className="k-scroll-snap -mx-4 flex gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 2xl:mx-0 2xl:px-0">
          {lanes.map((lane, laneIndex) => (
            <div key={lane.key} className="k-card k-reveal flex max-h-[520px] w-[280px] shrink-0 flex-col overflow-hidden p-3 2xl:w-auto 2xl:min-w-0 2xl:flex-1" style={{ ['--i' as string]: laneIndex + 6 }}>
              <div className="mb-3 flex items-center justify-between gap-2 border-b border-kraveo-line pb-3">
                <span className={`inline-flex items-center gap-2 text-sm font-bold ${lane.meta.text}`}>
                  <span className={`k-dot ${lane.meta.dot} ${lane.orders.length ? 'k-dot-live' : ''}`} style={{ ['--dot' as string]: `${lane.meta.hex}99` }} aria-hidden="true" />
                  {lane.meta.label}
                </span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-extrabold tabular-nums ${lane.meta.bg} ${lane.meta.text}`}>{lane.orders.length}</span>
              </div>
              <div className="flex-1 space-y-2.5 overflow-y-auto pr-0.5">
                {initialLoad && <><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></>}
                {!initialLoad && lane.orders.length === 0 && (
                  <div className="flex h-24 items-center justify-center rounded-k-md border border-dashed border-kraveo-line text-xs text-kraveo-ink3">{query.trim() ? 'No matching orders' : 'Nothing here'}</div>
                )}
                {lane.orders.map((order) => (
                  <article key={order.id} className="rounded-k-md border border-kraveo-line bg-kraveo-night/60 p-3 transition-colors hover:border-kraveo-g400/40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-kraveo-ink" title={order.id}>{shortId(order.id)}</span>
                      <span className="text-[11px] text-kraveo-ink3">{timeAgo(order.createdAt, now)}</span>
                    </div>
                    <p className="mt-1.5 truncate text-sm font-bold text-kraveo-ink">{order.vendorName}</p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-kraveo-ink2">
                      <span className="flex min-w-0 items-center gap-1"><MapPin className="h-3 w-3 shrink-0 text-kraveo-ink3" aria-hidden="true" /><span className="truncate">{order.dropoffHostel}</span></span>
                      <span className="k-num shrink-0 text-sm text-kraveo-ink">{inr(order.totalAmount)}</span>
                    </div>
                    <div className="mt-2.5 border-t border-kraveo-line pt-2.5">
                      <div className="mb-2 flex items-center gap-2 text-xs">
                        {order.driverName
                          ? <><Avatar name={order.driverName} size="sm" className="!h-6 !w-6 !text-[9px]" /><span className="truncate font-bold text-kraveo-ink">{order.driverName}</span></>
                          : <span className="inline-flex items-center gap-1.5 rounded-full bg-kraveo-status-placed/15 px-2.5 py-1 font-bold text-kraveo-status-placed"><UserX className="h-3 w-3" aria-hidden="true" />Unassigned</span>}
                      </div>
                      <select
                        aria-label={`Assign runner for order ${shortId(order.id)}`}
                        value=""
                        onChange={(event) => {
                          const value = event.target.value;
                          onReassignDriver(order.id, value === UNASSIGN_VALUE || !value ? null : value);
                        }}
                        className="k-select !min-h-[36px] text-xs font-bold"
                      >
                        <option value="">{order.driverName ? 'Change runner' : 'Assign runner'}</option>
                        {driverPartners.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}{driver.dutyStatus === 'OFFLINE' ? ' (offline)' : ''}</option>)}
                        {order.driverId && <option value={UNASSIGN_VALUE}>Unassign runner</option>}
                      </select>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
