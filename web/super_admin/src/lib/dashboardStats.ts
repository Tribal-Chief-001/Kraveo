// Pure helpers for numbers the dashboard shows and decisions it makes (no React, no DOM).
// Everything here is computed from data the dashboard has actually loaded; nothing is invented.
import { DriverPartner, DriverPin, Order, Vendor } from '../types';
import { vendorHasRealPin } from './campus';
import { STALE_AFTER_MS, positionAgeMs } from './riderMarkers';
import { isTerminal } from './orders';

// ───────────────────────── Orders -> numbers ─────────────────────────

/** Open (not delivered, not cancelled) orders per restaurant id. The vendors API does not send this, so it is counted here. */
export const activeOrderCountByVendor = (orders: Order[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const order of orders) {
    if (!order.vendorId || isTerminal(order.status)) continue;
    counts.set(order.vendorId, (counts.get(order.vendorId) ?? 0) + 1);
  }
  return counts;
};

/** Calendar day (YYYY-MM-DD) of a moment in Asia/Kolkata, or null when the value is not a date. */
export const istDay = (value: string | number | Date | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
};

/**
 * Deliveries finished today (India time) per rider. Keyed by `Order.driverId`, which is the rider's USER id.
 * Only loaded orders can be counted, so this is "of the loaded orders".
 */
export const tripsTodayByRider = (orders: Order[], now: number): Map<string, number> => {
  const today = istDay(now);
  const counts = new Map<string, number>();
  if (!today) return counts;
  for (const order of orders) {
    if (order.status !== 'DELIVERED' || !order.driverId) continue;
    if (istDay(order.deliveredAt) !== today) continue;
    counts.set(order.driverId, (counts.get(order.driverId) ?? 0) + 1);
  }
  return counts;
};

/**
 * Average minutes from placing to delivery over delivered orders, the same definition as the Analytics tab
 * (`deliveredAt - createdAt`). Orders without a `deliveredAt` are left out: `updatedAt` moves on later writes
 * (a review, a refund) and would inflate the average.
 */
export const averageDeliveryMinutes = (orders: Order[]): { value: number; count: number } | null => {
  const spans = orders
    .filter((order) => order.status === 'DELIVERED' && order.deliveredAt)
    .map((order) => (new Date(order.deliveredAt as string).getTime() - new Date(order.createdAt).getTime()) / 60000)
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0);
  return spans.length ? { value: spans.reduce((sum, minutes) => sum + minutes, 0) / spans.length, count: spans.length } : null;
};

// ───────────────────────── Map ─────────────────────────

/** Only approved restaurants with a real pin are live pins on the map (an older server sends no status: counts as approved). */
export const isMapVendor = (vendor: Pick<Vendor, 'approvalStatus' | 'lat' | 'lng' | 'hasLocation'>): boolean =>
  (vendor.approvalStatus === undefined || vendor.approvalStatus === null || vendor.approvalStatus === 'APPROVED') && vendorHasRealPin(vendor);

const ON_DUTY = new Set(['ONLINE', 'IN_TRANSIT']);

/**
 * The riders worth tracking live. Left out (they may still be in the roster):
 * - off duty (the roster is fresher than a position's own flag, so it wins),
 * - not approved,
 * - not known to be on duty AND no fix within the staleness limit (rehearsal / test riders with an old row).
 * A rider that carries an open order always stays, so a problem is never hidden.
 */
export const trackedRiders = (
  pins: DriverPin[],
  roster: DriverPartner[],
  activeOrderRiderIds: ReadonlySet<string>,
  now: number,
): DriverPin[] => {
  const byUser = new Map(roster.filter((partner) => partner.userId).map((partner) => [partner.userId as string, partner] as const));
  return pins.filter((pin) => {
    if (activeOrderRiderIds.has(pin.id)) return true;
    const partner = byUser.get(pin.id);
    const duty = partner?.dutyStatus ?? pin.dutyStatus;
    if (duty === 'OFFLINE') return false;
    const approval = partner?.approvalStatus ?? pin.approvalStatus;
    if (approval && approval !== 'APPROVED') return false;
    const onDuty = duty !== undefined && ON_DUTY.has(duty);
    const age = positionAgeMs(pin.lastUpdated, now);
    if (!onDuty && (age === null || age > STALE_AFTER_MS)) return false;
    return true;
  });
};

// ───────────────────────── Change detection (silent refresh) ─────────────────────────

/** True when two API lists are the same data, so the poll can keep the old array and skip a re-render. */
export const sameData = (a: unknown, b: unknown): boolean => {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};
