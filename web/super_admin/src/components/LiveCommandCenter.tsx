import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bike, Clock, Crosshair, MapPin, PackageCheck, Radio, Timer, UserX, Users } from 'lucide-react';
import { DriverPartner, DriverPin, Order, OrderStatus, Vendor } from '../types';
import { apiService } from '../services/api';
import { DropPointInfo, FALLBACK_DROP_POINTS, LatLng, campusCenter, vendorHasRealPin } from '../lib/campus';
import { RIDER_STATE_META, RIDER_STATE_ORDER, RiderMarkerState, countByState, riderMarkerState } from '../lib/riderMarkers';
import type { MapRider, MapVendor } from './CampusMap';
import { PIPELINE_ORDER, STATUS_META, inr, statusMeta, timeAgo } from '../lib/tokens';
import { AnimatedNumber } from './ui/AnimatedNumber';
import { PaymentPill, OtpLockedPill } from './ui/OrderBadges';
import { ReassignHandler, RiderAssignSelect, shortId } from './OrderControls';
import { Avatar } from './ui/Avatar';
import { EmptyState } from './ui/EmptyState';
import { KpiTile } from './ui/KpiTile';
import { Skeleton } from './ui/Skeleton';

// Leaflet (~150 kB) loads only when the map tab is opened; the rest of the dashboard never pays for it.
const CampusMap = lazy(() => import('./CampusMap'));

/** If the map chunk cannot load (offline, blocked) or the map throws, the list and the pipeline keep working. */
class MapBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('campus map failed:', error instanceof Error ? error.message : 'unknown error'); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center rounded-k-lg border border-kraveo-line bg-kraveo-night/60">
        <EmptyState icon={MapPin} title="The map could not be loaded" description="Check the connection and reload the page. The runner list and the delivery pipeline are not affected." />
      </div>
    );
  }
}

interface LiveCommandCenterProps {
  drivers: DriverPin[];
  orders: Order[];
  driverPartners: DriverPartner[];
  /** Restaurants with a real pin are drawn on the map. */
  vendors?: Vendor[];
  onReassignDriver: ReassignHandler;
  /** Opens the order drawer (details, cancel, reset OTP lock). */
  onOpenOrder?: (orderId: string) => void;
  loading?: boolean;
  query?: string;
}

const EMPTY_VENDORS: Vendor[] = [];

/** One tracked-runner row. Memoised on primitives, so a position update only re-renders the row that moved. */
const RunnerRow = React.memo(function RunnerRow({ id, name, state, subtitle, onFocus }: { id: string; name: string; state: RiderMarkerState; subtitle: string; onFocus: (id: string) => void }) {
  const meta = RIDER_STATE_META[state];
  return (
    <li>
      <button
        type="button"
        onClick={() => onFocus(id)}
        aria-label={`${name}, ${meta.label.toLowerCase()}. ${subtitle}. Show on map`}
        className="flex w-full items-center gap-3 rounded-k-md border border-transparent p-2.5 text-left transition-colors hover:border-kraveo-line hover:bg-kraveo-surface2"
      >
        <Avatar name={name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-kraveo-ink">{name}</span>
          <span className="block truncate text-[11px] text-kraveo-ink3">{subtitle}</span>
        </span>
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold ${meta.text}`}><span className={`k-dot ${meta.dot}`} aria-hidden="true" />{meta.label}</span>
      </button>
    </li>
  );
});

const orderMatches = (order: Order, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [order.id, order.vendorName, order.customerName, order.dropoffHostel, order.driverName]
    .some((value) => Boolean(value) && String(value).toLowerCase().includes(q));
};

export const LiveCommandCenter: React.FC<LiveCommandCenterProps> = ({ drivers, orders, driverPartners, vendors = EMPTY_VENDORS, onReassignDriver, onOpenOrder, loading = false, query = '' }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const initialLoad = loading && orders.length === 0 && driverPartners.length === 0;

  const activeOrders = useMemo(() => orders.filter((order) => !['DELIVERED', 'CANCELLED'].includes(order.status)), [orders]);
  // Only paid orders reach the restaurant (contract 1.2); unpaid ones are waiting on the customer, not the vendor.
  const pendingCount = orders.filter((order) => order.status === 'PLACED' && order.paymentStatus === 'PAID').length;
  const unpaidCount = orders.filter((order) => order.status === 'PLACED' && order.paymentStatus !== 'PAID').length;
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

  // Marker state per rider: off duty > stale (> 2 min) > delivering > heading to the restaurant > idle.
  const riderStates = useMemo(() => {
    const map = new Map<string, RiderMarkerState>();
    // The roster is live (driver_duty_update), a position's own duty flag is only as fresh as its last fix.
    const dutyByUser = new Map(driverPartners.filter((partner) => partner.userId).map((partner) => [partner.userId as string, partner.dutyStatus] as const));
    for (const driver of drivers) {
      map.set(driver.id, riderMarkerState({ dutyStatus: dutyByUser.get(driver.id) ?? driver.dutyStatus, lastUpdated: driver.lastUpdated, orderStatus: activeByDriver.get(driver.id)?.status, now }));
    }
    return map;
  }, [drivers, driverPartners, activeByDriver, now]);

  const plottable = useMemo(() => drivers.filter((driver) => Number.isFinite(driver.lat) && Number.isFinite(driver.lng)), [drivers]);
  const stateCounts = useMemo(() => countByState(plottable.map((driver) => riderStates.get(driver.id) ?? 'stale')), [plottable, riderStates]);

  // Campus data: built-in copy first, the server's answer replaces it when it arrives.
  const [campus, setCampus] = useState<{ center: LatLng; dropPoints: DropPointInfo[] }>(() => ({ center: campusCenter(), dropPoints: FALLBACK_DROP_POINTS }));
  useEffect(() => {
    let alive = true;
    apiService.fetchCampus().then((data) => { if (alive && data) setCampus(data); });
    return () => { alive = false; };
  }, []);

  const mapRiders = useMemo<MapRider[]>(() => plottable.map((driver) => {
    const order = activeByDriver.get(driver.id);
    return {
      id: driver.id,
      name: driver.name,
      lat: driver.lat,
      lng: driver.lng,
      state: riderStates.get(driver.id) ?? 'stale',
      lastUpdated: driver.lastUpdated,
      orderLabel: order ? `${shortId(order.id)} to ${order.dropoffHostel}` : null,
    };
  }), [plottable, activeByDriver, riderStates]);

  const mapVendors = useMemo<MapVendor[]>(() => vendors
    .filter((vendor) => vendorHasRealPin(vendor))
    .map((vendor) => ({ id: vendor.id, name: vendor.name, lat: vendor.lat as number, lng: vendor.lng as number })), [vendors]);

  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  const focusCounter = useRef(0);
  const focusRider = useCallback((id: string) => { focusCounter.current += 1; setFocusRequest({ id, n: focusCounter.current }); }, []);

  // The parent re-creates these handlers on every render; the pipeline below must not re-render because of that.
  const reassignRef = useRef(onReassignDriver);
  reassignRef.current = onReassignDriver;
  const openOrderRef = useRef(onOpenOrder);
  openOrderRef.current = onOpenOrder;
  const hasOpenOrder = Boolean(onOpenOrder);
  const stableReassign = useCallback<ReassignHandler>((...args) => reassignRef.current(...args), []);
  const stableOpenOrder = useMemo(() => (hasOpenOrder ? (orderId: string) => openOrderRef.current?.(orderId) : undefined), [hasOpenOrder]);

  const visibleOrders = useMemo(() => activeOrders.filter((order) => orderMatches(order, query)), [activeOrders, query]);
  const lanes = useMemo(() => PIPELINE_ORDER.map((key) => ({
    key,
    meta: STATUS_META[key],
    orders: visibleOrders.filter((order) => statusMeta(order.status).key === key),
  })), [visibleOrders]);

  // Rebuilt only when orders, riders or the filter change. A position update (every few seconds per rider)
  // re-renders the map card and the changed list row, never the order lanes.
  const pipeline = useMemo(() => (
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
                      {stableOpenOrder
                        ? <button type="button" aria-haspopup="dialog" aria-label={`Open order ${shortId(order.id)}`} onClick={() => stableOpenOrder(order.id)} className="rounded font-mono text-xs font-bold text-kraveo-g300 hover:underline" title={order.id}>{shortId(order.id)}</button>
                        : <span className="font-mono text-xs font-bold text-kraveo-ink" title={order.id}>{shortId(order.id)}</span>}
                      <span className="text-[11px] text-kraveo-ink3">{timeAgo(order.createdAt, now)}</span>
                    </div>
                    <p className="mt-1.5 truncate text-sm font-bold text-kraveo-ink">{order.vendorName}</p>
                    {(order.paymentStatus !== 'PAID' || order.otpLocked) && <div className="mt-1 flex flex-wrap gap-1"><PaymentPill status={order.paymentStatus} /><OtpLockedPill order={order} /></div>}
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
                      <RiderAssignSelect order={order} riders={driverPartners} onReassign={stableReassign} />
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
  ), [lanes, visibleOrders.length, query, initialLoad, now, driverPartners, stableOpenOrder, stableReassign]);

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
          value={<AnimatedNumber value={pendingCount} />} note={pendingCount ? `Paid, waiting for the restaurant${unpaidCount ? ` · ${unpaidCount} unpaid` : ''}` : unpaidCount ? `${unpaidCount} waiting for payment` : 'Nothing waiting'} />
        <KpiTile index={3} loading={initialLoad} label="Avg delivery time" icon={Timer} tone="text-kraveo-status-atGate" toneBg="bg-kraveo-status-atGate/15"
          value={<AnimatedNumber value={avgDeliveryMinutes ? avgDeliveryMinutes.value : null} decimals={1} suffix={avgDeliveryMinutes ? ' min' : ''} />}
          note={avgDeliveryMinutes ? `Placed to last update, ${avgDeliveryMinutes.count} delivered` : 'No delivered orders yet'} />
      </section>

      {/* Map + runners */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6" aria-label="Runner map">
        <div className="k-card k-reveal flex h-[460px] min-w-0 flex-col overflow-hidden p-3 sm:h-[520px] sm:p-4 lg:col-span-2" style={{ ['--i' as string]: 4 }}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-k-sm bg-kraveo-g400/15 text-kraveo-g400"><Crosshair className="h-4 w-4" aria-hidden="true" /></span>
              <div>
                <h2 className="font-display text-base font-bold leading-tight text-kraveo-ink">Live campus map</h2>
                <p className="text-[11px] text-kraveo-ink3">Drop points, restaurants and riders on duty</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-kraveo-surface2 px-3 py-1 text-xs font-bold text-kraveo-ink2" aria-live="polite">
              <Radio className="h-3.5 w-3.5 text-kraveo-g400" aria-hidden="true" />{plottable.length} runner{plottable.length === 1 ? '' : 's'} plotted
            </span>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-k-lg border border-kraveo-line">
            <MapBoundary>
              <Suspense fallback={<div className="h-full w-full animate-pulse bg-kraveo-surface2/60" aria-busy="true" aria-label="Loading map" />}>
                <CampusMap riders={mapRiders} vendors={mapVendors} dropPoints={campus.dropPoints} center={campus.center} now={now} focusRequest={focusRequest} />
              </Suspense>
            </MapBoundary>
            {plottable.length === 0 && !initialLoad && (
              <p className="pointer-events-none absolute left-1/2 top-3 z-[500] -translate-x-1/2 rounded-full border border-kraveo-line bg-kraveo-night/90 px-3 py-1 text-[11px] text-kraveo-ink2" role="status">
                No runner positions yet. Markers appear when a runner goes on duty.
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs text-kraveo-ink2" aria-label="Map legend" role="group">
            {RIDER_STATE_ORDER.map((state) => (
              <span key={state} className="inline-flex items-center gap-1.5">
                <span className="k-dot" style={{ backgroundColor: RIDER_STATE_META[state].hex }} aria-hidden="true" />
                {RIDER_STATE_META[state].label}
                <span className="font-bold tabular-nums text-kraveo-ink">{stateCounts[state]}</span>
              </span>
            ))}
            <span className="ml-auto hidden text-[11px] text-kraveo-ink3 sm:inline">Grey: no update for 2 min</span>
          </div>
        </div>

        <div className="k-card k-reveal flex max-h-[420px] min-w-0 flex-col overflow-hidden p-4 sm:max-h-[520px] sm:h-[520px]" style={{ ['--i' as string]: 5 }}>
          <div className="mb-3 flex items-center justify-between border-b border-kraveo-line pb-3">
            <h2 className="flex items-center gap-2 font-display text-base font-bold text-kraveo-ink"><Bike className="h-4 w-4 text-kraveo-g400" aria-hidden="true" /> Tracked runners</h2>
            <span className="rounded-full bg-kraveo-surface2 px-2.5 py-0.5 text-xs font-bold tabular-nums text-kraveo-ink2">{drivers.length}</span>
          </div>
          <ul className="-mx-1 flex-1 space-y-1.5 overflow-y-auto px-1" aria-label="Tracked runners">
            {initialLoad && Array.from({ length: 4 }).map((_, index) => <li key={index}><Skeleton className="h-14 w-full" /></li>)}
            {!initialLoad && drivers.length === 0 && <li><EmptyState icon={Bike} title="No location feed" description="No runner has reported a location yet." className="py-8" /></li>}
            {drivers.map((driver) => {
              const order = activeByDriver.get(driver.id);
              return (
                <RunnerRow
                  key={driver.id}
                  id={driver.id}
                  name={driver.name}
                  state={riderStates.get(driver.id) ?? 'stale'}
                  subtitle={order ? `${shortId(order.id)} · ${order.dropoffHostel}` : `Updated ${timeAgo(driver.lastUpdated, now)}`}
                  onFocus={focusRider}
                />
              );
            })}
          </ul>
        </div>
      </section>

      {pipeline}
    </div>
  );
};
