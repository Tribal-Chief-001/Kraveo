import { describe, expect, it } from 'vitest';
import { DriverPartner, DriverPin, Order } from '../types';
import { activeOrderCountByVendor, averageDeliveryMinutes, isMapVendor, istDay, sameData, trackedRiders, tripsTodayByRider } from './dashboardStats';
import { appendOlderPage, mergeOrderLists, oldestOrderId } from './orders';
import { STALE_AFTER_MS } from './riderMarkers';

const NOW = Date.parse('2026-10-06T10:00:00Z'); // 15:30 on 6 Oct in India
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const order = (id: string, over: Partial<Order> = {}): Order => ({
  id, customerName: 'C', vendorName: 'V', items: [], itemsCount: 0, totalAmount: 100, deliveryFee: 10, dropoffHostel: 'BH1',
  status: 'PLACED', paymentStatus: 'PAID', createdAt: ago(60 * 60_000), ...over,
});
const pin = (id: string, over: Partial<DriverPin> = {}): DriverPin => ({ id, name: `R${id}`, lat: 23.07, lng: 76.85, heading: 0, status: 'IDLE', lastUpdated: ago(5_000), dutyStatus: 'ONLINE', approvalStatus: 'APPROVED', ...over });
const partner = (userId: string, over: Partial<DriverPartner> = {}): DriverPartner => ({
  id: `p-${userId}`, userId, name: `P${userId}`, phone: '', studentRegNo: '', runnerCode: '', vehicleType: 'Bike', vehicleRegNo: '', emergencyPhone: '',
  dutyStatus: 'ONLINE', ordersToday: 0, totalEarningsToday: 0, avgCompletionTimeMinutes: 0, onTimeRatePercent: 0, rating: 5, createdAt: ago(0), approvalStatus: 'APPROVED', ...over,
});

describe('WEB-01 activeOrderCountByVendor', () => {
  it('counts only open orders, per restaurant', () => {
    const counts = activeOrderCountByVendor([
      order('1', { vendorId: 'a', status: 'PLACED' }),
      order('2', { vendorId: 'a', status: 'PREPARING' }),
      order('3', { vendorId: 'a', status: 'DELIVERED' }),
      order('4', { vendorId: 'a', status: 'CANCELLED' }),
      order('5', { vendorId: 'b', status: 'PICKED_UP' }),
      order('6', { status: 'PLACED' }), // no vendor id: counted for nobody
    ]);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBeUndefined();
  });
});

describe('WEB-02 tripsTodayByRider (India time)', () => {
  it('istDay uses the Asia/Kolkata calendar day', () => {
    expect(istDay('2026-10-05T19:00:00Z')).toBe('2026-10-06'); // 00:30 IST
    expect(istDay('2026-10-05T18:00:00Z')).toBe('2026-10-05'); // 23:30 IST
    expect(istDay('nonsense')).toBeNull();
    expect(istDay(null)).toBeNull();
  });
  it('counts delivered orders of today per rider user id; ignores other days, other statuses and unassigned orders', () => {
    const trips = tripsTodayByRider([
      order('1', { status: 'DELIVERED', driverId: 'u1', deliveredAt: ago(30 * 60_000) }),
      order('2', { status: 'DELIVERED', driverId: 'u1', deliveredAt: '2026-10-06T00:10:00Z' }), // 05:40 IST today
      order('3', { status: 'DELIVERED', driverId: 'u1', deliveredAt: '2026-10-05T17:00:00Z' }), // 22:30 IST yesterday
      order('4', { status: 'PICKED_UP', driverId: 'u1' }),
      order('5', { status: 'DELIVERED', driverId: 'u2', deliveredAt: ago(60_000) }),
      order('6', { status: 'DELIVERED', deliveredAt: ago(60_000) }),
      order('7', { status: 'DELIVERED', driverId: 'u2', deliveredAt: null }),
    ], NOW);
    expect(trips.get('u1')).toBe(2);
    expect(trips.get('u2')).toBe(1);
    expect(trips.size).toBe(2);
  });
});

describe('WEB-08 averageDeliveryMinutes', () => {
  it('uses deliveredAt - createdAt and ignores a later updatedAt', () => {
    const avg = averageDeliveryMinutes([
      order('1', { status: 'DELIVERED', createdAt: ago(60 * 60_000), deliveredAt: ago(40 * 60_000), updatedAt: ago(1_000) }), // 20 min
      order('2', { status: 'DELIVERED', createdAt: ago(60 * 60_000), deliveredAt: ago(30 * 60_000), updatedAt: ago(1_000) }), // 30 min
    ]);
    expect(avg?.value).toBeCloseTo(25, 5);
    expect(avg?.count).toBe(2);
  });
  it('leaves out delivered orders without deliveredAt, and returns null when nothing counts', () => {
    expect(averageDeliveryMinutes([order('1', { status: 'DELIVERED', updatedAt: ago(1_000) }), order('2', { status: 'PLACED' })])).toBeNull();
    expect(averageDeliveryMinutes([])).toBeNull();
  });
});

describe('WEB-11 isMapVendor', () => {
  const real = { lat: 23.0745, lng: 76.859, hasLocation: true };
  it('approved (or no status on an old server) with a real pin is drawn', () => {
    expect(isMapVendor({ ...real, approvalStatus: 'APPROVED' })).toBe(true);
    expect(isMapVendor({ ...real })).toBe(true);
  });
  it('suspended, pending, rejected and pin-less restaurants are not drawn', () => {
    for (const approvalStatus of ['SUSPENDED', 'PENDING', 'REJECTED'] as const) expect(isMapVendor({ ...real, approvalStatus })).toBe(false);
    expect(isMapVendor({ approvalStatus: 'APPROVED', lat: 23.0768, lng: 76.8524, hasLocation: false })).toBe(false);
  });
});

describe('WEB-16 trackedRiders', () => {
  const none = new Set<string>();
  it('keeps fresh on-duty riders', () => {
    expect(trackedRiders([pin('u1')], [partner('u1')], none, NOW).map((p) => p.id)).toEqual(['u1']);
  });
  it('drops offline riders (the roster is fresher than the pin) and unapproved riders', () => {
    const pins = [pin('u1'), pin('u2'), pin('u3', { approvalStatus: 'SUSPENDED' }), pin('u4', { dutyStatus: 'OFFLINE' })];
    const roster = [partner('u1', { dutyStatus: 'OFFLINE' }), partner('u2')];
    expect(trackedRiders(pins, roster, none, NOW).map((p) => p.id)).toEqual(['u2']);
  });
  it('drops a ghost: old position and not known to be on duty; keeps an on-duty rider whose fix is stale (shown grey)', () => {
    const old = ago(STALE_AFTER_MS + 60_000);
    const ghost = pin('ghost', { dutyStatus: undefined, lastUpdated: old, approvalStatus: null });
    const stale = pin('stale', { lastUpdated: old });
    expect(trackedRiders([ghost, stale], [], none, NOW).map((p) => p.id)).toEqual(['stale']);
  });
  it('an old server (no duty flag) with a fresh fix still counts as on duty', () => {
    expect(trackedRiders([pin('u1', { dutyStatus: undefined, approvalStatus: null })], [], none, NOW)).toHaveLength(1);
  });
  it('a rider carrying an open order is never hidden', () => {
    expect(trackedRiders([pin('u1', { dutyStatus: 'OFFLINE' })], [], new Set(['u1']), NOW)).toHaveLength(1);
  });
});

describe('WEB-05 sameData', () => {
  it('equal lists are the same, a changed field is not', () => {
    expect(sameData([{ id: 'a', open: true }], [{ id: 'a', open: true }])).toBe(true);
    expect(sameData([{ id: 'a', open: true }], [{ id: 'a', open: false }])).toBe(false);
  });
});

describe('WEB-03 older pages', () => {
  const o = (id: string, minsAgo: number) => order(id, { createdAt: ago(minsAgo * 60_000) });
  it('oldestOrderId picks the oldest loaded order', () => {
    expect(oldestOrderId([o('new', 1), o('mid', 50), o('old', 500)])).toBe('old');
    expect(oldestOrderId([])).toBeNull();
  });
  it('appendOlderPage adds unseen orders below and keeps the same array when nothing is new', () => {
    const local = [o('a', 1), o('b', 2)];
    expect(appendOlderPage(local, [o('b', 2), o('c', 3)]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(appendOlderPage(local, [o('a', 1)])).toBe(local);
  });
  it('mergeOrderLists drops older local orders by default, keeps them with keepOlder (so a poll does not undo "Load older")', () => {
    const local = [o('n1', 1), o('n2', 2), o('old1', 900), o('old2', 1000)];
    const page = [o('n1', 1), o('n2', 2)];
    expect(mergeOrderLists(local, page).map((x) => x.id)).toEqual(['n1', 'n2']);
    expect(mergeOrderLists(local, page, { keepOlder: true }).map((x) => x.id)).toEqual(['n1', 'n2', 'old1', 'old2']);
  });
  it('keepOlder still lets a poll update an order that is on the page and keeps a brand-new local order on top', () => {
    const local = [o('fresh', 0), o('n1', 5), o('old1', 900)];
    const page = [order('n1', { createdAt: ago(5 * 60_000), status: 'ACCEPTED', updatedAt: ago(0) })];
    const merged = mergeOrderLists(local, page, { keepOlder: true });
    expect(merged.map((x) => x.id)).toEqual(['fresh', 'n1', 'old1']);
    expect(merged[1].status).toBe('ACCEPTED');
  });
});
