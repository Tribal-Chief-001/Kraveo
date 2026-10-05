import { DriverPin } from '../types';

// Pure helpers for the live campus map: marker state and incremental merging of rider positions.
// No React, no DOM, no Leaflet, so they are trivially unit-testable (src/lib/riderMarkers.test.ts).

export type RiderMarkerState = 'idle' | 'toRestaurant' | 'delivering' | 'stale' | 'offline';

/** A position older than this is "stale" (contract: > 2 minutes). */
export const STALE_AFTER_MS = 2 * 60 * 1000;

export interface RiderStateMeta {
  label: string;
  /** Marker / legend colour. */
  hex: string;
  /** Tailwind classes for the legend dot and the list label (literal strings so the scanner finds them). */
  dot: string;
  text: string;
}

export const RIDER_STATE_ORDER: RiderMarkerState[] = ['idle', 'toRestaurant', 'delivering', 'stale', 'offline'];

export const RIDER_STATE_META: Record<RiderMarkerState, RiderStateMeta> = {
  idle: { label: 'Idle', hex: '#43AE55', dot: 'bg-kraveo-g400', text: 'text-kraveo-g400' },
  toRestaurant: { label: 'To restaurant', hex: '#F5A524', dot: 'bg-kraveo-status-placed', text: 'text-kraveo-status-placed' },
  delivering: { label: 'Delivering', hex: '#3B82F6', dot: 'bg-kraveo-status-pickedUp', text: 'text-kraveo-status-pickedUp' },
  stale: { label: 'Stale', hex: '#9CA3AF', dot: 'bg-kraveo-ink3', text: 'text-kraveo-ink2' },
  offline: { label: 'Offline', hex: '#4B5563', dot: 'bg-kraveo-line', text: 'text-kraveo-ink3' },
};

const TO_RESTAURANT = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);
const DELIVERING = new Set(['PICKED_UP', 'ARRIVED_AT_GATE']);

export interface RiderStateInput {
  /** Undefined on a server that predates the campus-maps release: the rider counts as on duty. */
  dutyStatus?: string | null;
  lastUpdated?: string | number | Date | null;
  /** Status of the order this rider carries, if any. */
  orderStatus?: string | null;
  now: number;
}

/** Age of a position in ms, or null when the time is missing or not a date. */
export const positionAgeMs = (lastUpdated: RiderStateInput['lastUpdated'], now: number): number | null => {
  if (lastUpdated === undefined || lastUpdated === null || lastUpdated === '') return null;
  const t = new Date(lastUpdated).getTime();
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
};

/**
 * offline  (off duty)  beats everything;
 * stale    (no usable time, or older than 2 min) beats what the rider is doing, because the dot would lie;
 * otherwise by the carried order: picked up / at the gate = delivering, accepted..ready = to restaurant, none = idle.
 */
export const riderMarkerState = ({ dutyStatus, lastUpdated, orderStatus, now }: RiderStateInput): RiderMarkerState => {
  if (dutyStatus === 'OFFLINE') return 'offline';
  const age = positionAgeMs(lastUpdated, now);
  if (age === null || age > STALE_AFTER_MS) return 'stale';
  if (orderStatus && DELIVERING.has(orderStatus)) return 'delivering';
  if (orderStatus && TO_RESTAURANT.has(orderStatus)) return 'toRestaurant';
  return 'idle';
};

/** Counts per state for the legend (every state present, zero when empty). */
export const countByState = (states: Iterable<RiderMarkerState>): Record<RiderMarkerState, number> => {
  const out: Record<RiderMarkerState, number> = { idle: 0, toRestaurant: 0, delivering: 0, stale: 0, offline: 0 };
  for (const s of states) out[s] += 1;
  return out;
};

/** "12 s ago" style age for popups and labels. Shorter than timeAgo and exact under a minute. */
export const ageLabel = (ageMs: number | null): string => {
  if (ageMs === null) return 'no update yet';
  const s = Math.round(ageMs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

/** Screen-reader description of one marker. */
export const describeRider = (name: string, state: RiderMarkerState, ageMs: number | null, orderLabel?: string | null): string =>
  `Rider ${name}, ${RIDER_STATE_META[state].label.toLowerCase()}${orderLabel ? `, ${orderLabel}` : ''}, updated ${ageLabel(ageMs)}`;

/**
 * Applies a batch of position updates to the current list WITHOUT rebuilding rows that did not change:
 * - unchanged rows keep their object identity (so memoised rows and markers see "no change"),
 * - an older fix never replaces a newer one (events can arrive out of order),
 * - a new rider is added at the front, like the first load order,
 * - returns the SAME array when nothing changed.
 */
export const mergeRiderPins = (previous: DriverPin[], updates: DriverPin[]): DriverPin[] => {
  if (updates.length === 0) return previous;
  const index = new Map(previous.map((p, i) => [p.id, i] as const));
  let next: DriverPin[] | null = null;
  const fresh: DriverPin[] = [];
  const ts = (v?: string) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : -Infinity; };
  for (const u of updates) {
    const i = index.get(u.id);
    if (i === undefined) { fresh.push(u); index.set(u.id, -1); continue; }
    if (i === -1) continue; // duplicate new rider in one batch: the first one wins (callers pass the newest per rider)
    const cur = (next ?? previous)[i];
    if (ts(u.lastUpdated) < ts(cur.lastUpdated)) continue;
    const merged: DriverPin = {
      ...cur,
      ...u,
      // keep what the update did not carry
      dutyStatus: u.dutyStatus ?? cur.dutyStatus,
      approvalStatus: u.approvalStatus ?? cur.approvalStatus,
      name: u.name && u.name !== 'Runner' ? u.name : cur.name,
    };
    const same = merged.lat === cur.lat && merged.lng === cur.lng && merged.heading === cur.heading && merged.lastUpdated === cur.lastUpdated
      && merged.dutyStatus === cur.dutyStatus && merged.approvalStatus === cur.approvalStatus && merged.name === cur.name;
    if (same) continue;
    if (!next) next = previous.slice();
    next[i] = merged;
  }
  if (!next && fresh.length === 0) return previous;
  return fresh.length ? [...fresh, ...(next ?? previous)] : (next as DriverPin[]);
};

/** Keeps only the newest update per rider from a buffered batch (the 1 s flush in App). */
export const newestPerRider = (batch: DriverPin[]): DriverPin[] => {
  const latest = new Map<string, DriverPin>();
  const ts = (v?: string) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : -Infinity; };
  for (const p of batch) {
    const cur = latest.get(p.id);
    if (!cur || ts(p.lastUpdated) >= ts(cur.lastUpdated)) latest.set(p.id, p);
  }
  return [...latest.values()];
};

/**
 * The full list from REST (initial load, reconnect, poll): same result as merging, plus riders that are no longer in the
 * server's list disappear. Rows that did not change keep their identity and the same array comes back when nothing changed.
 */
export const replaceRiderPins = (previous: DriverPin[], fresh: DriverPin[]): DriverPin[] => {
  const keep = new Set(fresh.map((p) => p.id));
  const base = previous.every((p) => keep.has(p.id)) ? previous : previous.filter((p) => keep.has(p.id));
  return mergeRiderPins(base, fresh);
};
