import { describe, expect, it } from 'vitest';
import {
  blockFromError, customerState, knownBlock, outcomeNeedsNotice, parseBlockOrders, parseCustomerDetail, parseCustomerList, parseCustomerRow, parseOutcome, parseOwner,
  parseOwnerResult, parseRiderImpact, parseVendorImpact, riderKnownBlock, vendorKnownBlock,
} from './accountParse';
import { ApiError } from '../services/api';
import {
  ORDER_ID, rawCancelled, rawCustomerDetail, rawCustomerList, rawCustomerRow, rawHasActiveDelivery, rawHasOpenOrders, rawFoodWithRider, rawOpenOrder, rawOrderInDelivery, rawOwner,
  rawOwnerCreate, rawOwnerView, rawRefundNotSettled, rawRiderImpact, rawVendorHasOpenOrders, rawVendorImpact,
} from '../test/adminFixtures';

const api = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);

describe('customers', () => {
  it('parses a real list row and keeps the status, last sign-in, open-order count and totals', () => {
    const row = parseCustomerRow(rawCustomerRow({ openOrders: 2, accountStatus: 'SUSPENDED', statusReason: 'Fake orders' }))!;
    expect(row).toMatchObject({ id: 'zc-cust-1', accountStatus: 'SUSPENDED', statusReason: 'Fake orders', openOrders: 2, ordersCount: 4, totalSpent: 820, lastLoginAt: '2026-10-28T17:30:00.000Z' });
  });

  it('never produces NaN: missing, null, text and infinite numbers become 0; unknown fields are ignored', () => {
    const row = parseCustomerRow({ id: 'c1', name: 'A', ordersCount: 'x', totalSpent: null, kraveoCoins: undefined, openOrders: NaN, lastOrderAt: 'not a date', surprise: { deep: 1 }, accountStatus: 'WEIRD' })!;
    expect(row).toMatchObject({ ordersCount: 0, totalSpent: 0, kraveoCoins: 0, openOrders: 0, lastOrderAt: null, accountStatus: 'ACTIVE' });
    expect(Object.values(row).some((v) => typeof v === 'number' && Number.isNaN(v))).toBe(false);
    expect((row as any).surprise).toBeUndefined();
    expect(parseCustomerRow({ id: Infinity as any, name: 'x', totalSpent: Infinity })?.totalSpent).toBeUndefined();
  });

  it('drops rows without an id and answers null for a body that is not a list', () => {
    expect(parseCustomerList({ data: [rawCustomerRow(), { name: 'no id' }, null, 'x'] })!.data).toHaveLength(1);
    expect(parseCustomerList({ success: true })).toBeNull();
    expect(parseCustomerList(null)).toBeNull();
    expect(parseCustomerList(rawCustomerList([], { total: 'bad' }))!.total).toBe(0);
  });

  it('parses the detail: open orders, refunds owed, stats and orders (a missing vendor or driver is null)', () => {
    const d = parseCustomerDetail(rawCustomerDetail({
      openOrders: [rawOpenOrder()], refundsOwed: [{ orderId: ORDER_ID, refundStatus: 'FAILED', amount: 205 }, { nothing: true }],
      orders: [{ id: 'o1', status: 'PLACED', vendor: null, driver: null, items: 'oops', payments: [null] }],
    }))!;
    expect(d.openOrders).toEqual([{ id: ORDER_ID, status: 'PLACED', paymentStatus: 'PAID', totalAmount: 205, groupId: null }]);
    expect(d.refundsOwed).toEqual([{ orderId: ORDER_ID, refundStatus: 'FAILED', amount: 205 }]);
    expect(d.orders[0]).toMatchObject({ vendor: null, driver: null, items: [], payments: [], totalAmount: 0 });
    expect(d.stats.ordersCount).toBe(4);
  });

  it('a detail without stats still gets numbers (count of orders), not NaN', () => {
    const d = parseCustomerDetail({ id: 'c', name: 'x', orders: [{ id: 'o' }] })!;
    expect(d.stats).toMatchObject({ ordersCount: 1, totalSpent: 0, deliveredCount: 0, firstOrderAt: null });
  });

  it('customerState tells admin removal from a self deletion', () => {
    expect(customerState({ accountStatus: 'ACTIVE', deleted: false })).toBe('ACTIVE');
    expect(customerState({ accountStatus: 'SUSPENDED', deleted: false })).toBe('SUSPENDED');
    expect(customerState({ accountStatus: 'REMOVED', deleted: true })).toBe('REMOVED');
    expect(customerState({ accountStatus: 'ACTIVE', deleted: true })).toBe('DELETED');
  });
});

describe('outcome of an action', () => {
  it('reads the real cancelled / failed answer', () => {
    const o = parseOutcome({ success: true, changed: true, ...rawCancelled() });
    expect(o.cancelled).toEqual([{ orderId: ORDER_ID, groupId: null, cancelledOrders: 1, refund: 'STARTED', refundMessage: null }]);
    expect(o.failed).toEqual([]);
    expect(outcomeNeedsNotice(o)).toBe(true);
  });
  it('a combined order is one entry with its part count; failures keep code and message', () => {
    const o = parseOutcome({ changed: false, cancelled: [{ orderId: 'a', groupId: 'g1', cancelledOrders: 2, refund: 'NONE' }], failed: [{ orderId: 'b', code: 'ORDER_IN_DELIVERY', message: 'With a rider.' }], released: ['r1', 5], releaseFailed: [{ orderId: 'r2', code: 'X', message: 'no' }], warning: 'Careful' });
    expect(o).toMatchObject({ changed: false, warning: 'Careful', released: ['r1'] });
    expect(o.cancelled[0]).toMatchObject({ groupId: 'g1', cancelledOrders: 2, refund: 'NONE' });
    expect(o.remaining).toEqual([]);
    expect(o.failed[0]).toEqual({ orderId: 'b', code: 'ORDER_IN_DELIVERY', message: 'With a rider.' });
    expect(o.releaseFailed).toHaveLength(1);
  });
  it('nothing special -> no notice; junk -> an empty outcome', () => {
    expect(outcomeNeedsNotice(parseOutcome({ success: true, changed: true }))).toBe(false);
    expect(parseOutcome(null)).toMatchObject({ changed: true, cancelled: [], failed: [], released: [], warning: null });
  });
});

describe('blocking orders and the 409 answers', () => {
  it('accepts order objects and plain ids (REFUND_NOT_SETTLED)', () => {
    expect(parseBlockOrders([rawOpenOrder({ groupId: 'g' }), 'ord-9', { id: '' }, null])).toEqual([
      { id: ORDER_ID, status: 'PLACED', paymentStatus: 'PAID', totalAmount: 205, groupId: 'g' },
      { id: 'ord-9', status: null, paymentStatus: null, totalAmount: null, groupId: null },
    ]);
  });

  it('HAS_OPEN_ORDERS for a customer: the list, the server text and the explicit cancel choice', () => {
    const b = blockFromError(api(409, rawHasOpenOrders()), 'customer', 'suspend')!;
    expect(b.code).toBe('HAS_OPEN_ORDERS');
    expect(b.message).toContain('1 order(s) in progress');
    expect(b.orders).toHaveLength(1);
    expect(b.choice!.label).toBe('Cancel these orders and refund the customer');
    expect(b.choice!.submitLabel).toBe('Cancel the orders and refund, then suspend');
  });

  it('a restaurant block names the combined-order effect; its list comes from `orders`', () => {
    const b = blockFromError(api(409, rawVendorHasOpenOrders()), 'vendor', 'remove')!;
    expect(b.orders).toHaveLength(1);
    expect(b.choice!.detail).toContain('combined order is cancelled as a whole');
    expect(blockFromError(api(409, rawHasOpenOrders()), 'customer', 'suspend')!.choice!.detail).not.toContain('combined');
  });

  it('ORDER_IN_DELIVERY, FOOD_WITH_RIDER and REFUND_NOT_SETTLED offer no choice (nothing can resolve them here)', () => {
    for (const body of [rawOrderInDelivery(), rawFoodWithRider(), rawRefundNotSettled()]) {
      const b = blockFromError(api(409, body), 'customer', 'remove')!;
      expect(b.choice).toBeUndefined();
      expect(b.orders.length).toBeGreaterThan(0);
    }
  });

  it('HAS_ACTIVE_DELIVERY offers handing the deliveries back to the pool', () => {
    const b = blockFromError(api(409, rawHasActiveDelivery()), 'rider', 'remove')!;
    expect(b.choice!.label).toContain('back to the pool');
    expect(b.choice!.submitLabel).toBe('Hand the deliveries back, then remove');
  });

  it('other errors are not blocks (400, 429, unknown 409, plain Error)', () => {
    expect(blockFromError(api(400, { code: 'CONFIRM_MISMATCH', message: 'x' }), 'customer', 'remove')).toBeNull();
    expect(blockFromError(api(429, { code: 'RATE_LIMITED', message: 'x' }), 'customer', 'remove')).toBeNull();
    expect(blockFromError(api(409, { code: 'NOT_RESTORABLE', message: 'x' }), 'customer', 'remove')).toBeNull();
    expect(blockFromError(new Error('x'), 'customer', 'remove')).toBeNull();
    expect(blockFromError(null, 'customer', 'remove')).toBeNull();
  });

  it('knownBlock: open orders give the choice; an order on the way gives only "wait"; none gives null', () => {
    expect(knownBlock([], 'customer', 'suspend')).toBeNull();
    const open = knownBlock(parseBlockOrders([rawOpenOrder()]), 'customer', 'suspend')!;
    expect(open.choice).toBeDefined();
    expect(open.message).toBe('They have 1 order in progress.');
    const way = knownBlock(parseBlockOrders([rawOpenOrder(), rawOpenOrder({ id: 'ord-2', status: 'PICKED_UP' })]), 'customer', 'suspend')!;
    expect(way.choice).toBeUndefined();
    expect(way.code).toBe('ORDER_IN_DELIVERY');
    expect(way.message).toContain('is with a rider right now');
    expect(knownBlock(parseBlockOrders([rawOpenOrder(), rawOpenOrder({ id: 'o2' })]), 'vendor', 'remove')!.message).toBe('This restaurant has 2 orders in progress.');
  });
});

describe('riders', () => {
  it('parses the impact answer and builds the blocks (food with the rider beats a handover)', () => {
    const impact = parseRiderImpact(rawRiderImpact({ activeDeliveries: [{ id: 'a1', status: 'ACCEPTED' }], foodWithRider: [] }).data)!;
    expect(impact).toMatchObject({ driverId: 'drv-1', userId: 'u-rider-1', accountStatus: 'ACTIVE' });
    expect(riderKnownBlock(impact, 'remove')!.choice).toBeDefined();
    const food = parseRiderImpact(rawRiderImpact({ activeDeliveries: [{ id: 'a1', status: 'PICKED_UP' }], foodWithRider: [{ id: 'a1', status: 'PICKED_UP' }] }).data)!;
    expect(riderKnownBlock(food, 'remove')!.choice).toBeUndefined();
    expect(riderKnownBlock(parseRiderImpact(rawRiderImpact().data)!, 'remove')).toBeNull();
    expect(parseRiderImpact({})).toBeNull();
  });
});

describe('restaurants and owners', () => {
  it('parses the impact answer incl. unpaid settlements; bad numbers become 0', () => {
    const i = parseVendorImpact(rawVendorImpact({ openOrders: [rawOpenOrder()], unpaidSettlements: { count: '2', amount: 'x' } }).data)!;
    expect(i).toMatchObject({ vendorId: 'ven-1', hasOwner: true, unpaidSettlements: { count: 2, amount: 0 } });
    expect(parseVendorImpact(null)).toBeNull();
  });
  it('vendorKnownBlock: inDelivery means wait; open orders mean the choice', () => {
    expect(vendorKnownBlock(parseVendorImpact(rawVendorImpact().data)!, 'suspend')).toBeNull();
    expect(vendorKnownBlock(parseVendorImpact(rawVendorImpact({ openOrders: [rawOpenOrder()] }).data)!, 'suspend')!.choice).toBeDefined();
    expect(vendorKnownBlock(parseVendorImpact(rawVendorImpact({ openOrders: [rawOpenOrder()], inDelivery: [rawOpenOrder({ status: 'PICKED_UP' })] }).data)!, 'suspend')!.choice).toBeUndefined();
  });

  it('owner: `id` (restaurant row) and `userId` (owner endpoints) both work; null when there is none', () => {
    expect(parseOwner(rawOwner())).toMatchObject({ id: 'zc-vown-2', name: 'Owner2 Kitchen', phone: '+91 9777620002', accountStatus: 'ACTIVE' });
    expect(parseOwner(rawOwnerView())).toMatchObject({ id: 'zc-vown-9' });
    expect(parseOwner(null)).toBeNull();
    expect(parseOwner({ name: 'no id' })).toBeNull();
    expect(parseOwner(rawOwner({ accountStatus: 'SUSPENDED', statusReason: 'Paused' }))).toMatchObject({ accountStatus: 'SUSPENDED', statusReason: 'Paused' });
  });

  it('the create answer carries the generated password once, and the closed flag', () => {
    const r = parseOwnerResult(rawOwnerCreate());
    expect(r.generatedPassword).toBe('pZq7NwEu3KxT9sBd');
    expect(r).toMatchObject({ restaurantClosed: true, payoutAccountMoved: false, owner: { id: 'zc-vown-9' } });
    expect(parseOwnerResult({ success: true, owner: rawOwnerView() }).generatedPassword).toBeNull();
    expect(parseOwnerResult({ success: true, changed: true, owner: null, detachedUser: { id: 'u9', name: 'Old' }, cancelled: [] }).detachedUser).toEqual({ id: 'u9', name: 'Old' });
  });
});
