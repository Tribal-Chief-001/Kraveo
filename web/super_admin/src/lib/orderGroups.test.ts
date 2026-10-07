import { describe, expect, it } from 'vitest';
import { normalizeOrder, normalizeOrderPartial } from '../types';
import {
  GROUP_MONEY_PROBLEMS, cancelToastText, cancelWholeGroupText, groupBadgeText, groupIdOf, groupMoneyNote, groupPositionText, groupRestaurantNames, groupSearchTerms,
  parseCancelOutcome, parseGroupInfo, reassignWholeGroupText,
} from './orderGroups';
import { groupStatusLabel, parseGroupView } from './groupView';
import { normalizeAttention } from './orderProblems';
import { preferRiderOrder, refundInfo, riderOrderLabel } from './orders';
import { upsertOrder } from './orders';
import { validateFees, FeesForm, parseRestaurantsPerOrder } from './pricing';
import { GROUP_ID, GROUP_ORDER_IDS, rawGroup, rawGroupAttentionRow, rawGroupCancel, rawGroupOrder, rawGroupView } from '../test/fixtures';

describe('parseGroupInfo (OrderView.group, Docs/22 10.4)', () => {
  it('reads the real admin shape', () => {
    const g = parseGroupInfo(rawGroup(1))!;
    expect(g).toMatchObject({ id: GROUP_ID, index: 1, size: 2, primary: false });
    expect(g.stops).toEqual([
      { orderId: GROUP_ORDER_IDS[0], index: 0, status: 'ACCEPTED', vendorName: 'Kitchen 1', vendorAddress: 'Gate 1', itemCount: 2 },
      { orderId: GROUP_ORDER_IDS[1], index: 1, status: 'PLACED', vendorName: 'Kitchen 2', vendorAddress: 'Gate 2', itemCount: 1 },
    ]);
    expect(parseGroupInfo(rawGroup(0))!.primary).toBe(true);
  });

  it('a missing, null or non-object group is "not grouped"', () => {
    for (const bad of [undefined, null, 'x', 5, [], {}]) expect(parseGroupInfo(bad)).toBeUndefined();
  });

  it('the restaurant-shaped { size, allAccepted } (no id) is not a group', () => {
    expect(parseGroupInfo({ size: 2, allAccepted: false })).toBeUndefined();
  });

  it('ignores unknown fields and survives garbage stops; sorts stops by index; size is at least the stops listed', () => {
    const g = parseGroupInfo({ id: 'g1', index: '1', size: 1, primary: 'yes', future: { a: 1 }, stops: [null, 5, { orderId: 'b', index: 1, status: 'picked_up', vendor: null }, { orderId: 'a', index: 0 }, { index: 2 }] })!;
    expect(g.stops.map((s) => [s.orderId, s.index, s.status, s.vendorName, s.itemCount])).toEqual([['a', 0, 'PLACED', 'Restaurant', 0], ['b', 1, 'PICKED_UP', 'Restaurant', 0]]);
    expect(g.size).toBe(2);
    expect(g.index).toBe(1);
    expect(g.primary).toBe(false); // not a boolean: derived from index
  });

  it('texts', () => {
    const g = parseGroupInfo(rawGroup(0))!;
    expect(groupBadgeText(g)).toBe('Combined order · 2 restaurants');
    expect(groupPositionText({ index: 0, size: 3 })).toBe('1 of 3');
    expect(groupRestaurantNames(g)).toEqual(['Kitchen 1', 'Kitchen 2']);
    expect(groupSearchTerms(g)).toEqual([GROUP_ID, 'Kitchen 1', 'Kitchen 2']);
    expect(groupSearchTerms(undefined)).toEqual([]);
    expect(cancelWholeGroupText({ size: 3 }, true)).toBe('This cancels the WHOLE combined order (all 3 restaurants) and refunds the customer in full.');
    expect(cancelWholeGroupText({ size: 3 }, false)).not.toContain('refunds the customer');
    expect(reassignWholeGroupText({ size: 2 })).toContain('all 2 orders');
    expect(groupMoneyNote({ size: 2 })).toContain('whole combined order (2 restaurants)');
    expect(GROUP_MONEY_PROBLEMS.has('REFUND_FAILED')).toBe(true);
    expect(GROUP_MONEY_PROBLEMS.has('NO_RIDER')).toBe(false);
  });
});

describe('Order parsing keeps the group', () => {
  it('normalizeOrder reads group and groupId from the real admin OrderView', () => {
    const o = normalizeOrder(rawGroupOrder(1));
    expect(o.group).toMatchObject({ id: GROUP_ID, index: 1, size: 2, primary: false });
    expect(o.groupId).toBe(GROUP_ID);
    expect(groupIdOf(o)).toBe(GROUP_ID);
  });

  it('a single order has no group key at all (not even undefined values from the parser)', () => {
    const { group, groupId, ...single } = rawGroupOrder(0);
    const o = normalizeOrder(single);
    expect('group' in o).toBe(false);
    expect('groupId' in o).toBe(false);
    expect(groupIdOf(o)).toBeUndefined();
  });

  it('groupId alone (older shape) is kept; a customer-style group without top-level groupId derives it', () => {
    expect(normalizeOrder({ id: 'x', groupId: 'g9' }).groupId).toBe('g9');
    expect(normalizeOrder({ id: 'x', group: rawGroup(0) }).groupId).toBe(GROUP_ID);
  });

  it('partial live updates: a missing group keeps the known one, an explicit null clears it, junk is ignored', () => {
    const base = normalizeOrder(rawGroupOrder(0));
    const keep = upsertOrder([base], normalizeOrderPartial({ id: base.id, status: 'PREPARING', updatedAt: '2026-10-07T03:45:00.000Z' }));
    expect(keep[0].group?.id).toBe(GROUP_ID);
    expect(keep[0].status).toBe('PREPARING');
    const junk = upsertOrder([base], normalizeOrderPartial({ id: base.id, group: { size: 2, allAccepted: true }, updatedAt: '2026-10-07T03:46:00.000Z' }));
    expect(junk[0].group?.id).toBe(GROUP_ID);
    const cleared = upsertOrder([base], normalizeOrderPartial({ id: base.id, group: null, updatedAt: '2026-10-07T03:47:00.000Z' }));
    expect(cleared[0].group).toBeUndefined();
  });

  it('the sibling status chips in stops follow a newer group payload', () => {
    const base = normalizeOrder(rawGroupOrder(0));
    const next = upsertOrder([base], normalizeOrderPartial({ id: base.id, group: rawGroup(0, {}, ['ACCEPTED', 'ACCEPTED']), updatedAt: '2026-10-07T03:48:00.000Z' }));
    expect(next[0].group!.stops.map((s) => s.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
  });
});

describe('parseGroupView (GET /api/order-groups/:id)', () => {
  it('reads the real shape, with the orders as full orders in group order', () => {
    const v = parseGroupView({ success: true, data: { ...rawGroupView(), orders: [rawGroupOrder(1), rawGroupOrder(0)] } })!;
    expect(v).toMatchObject({ id: GROUP_ID, status: 'AWAITING_RESTAURANTS', paymentStatus: 'PAID', total: 260, subtotal: 270, feeTotal: 40, discount: 50, couponCode: 'KRAVEO50', restaurantCount: 2, payOrderId: GROUP_ORDER_IDS[0] });
    expect(v.orders.map((o) => o.id)).toEqual(GROUP_ORDER_IDS);
    expect(v.orders[1].vendorName).toBe('Kitchen 2');
  });

  it('never invents numbers: a missing or bad money field is null, not 0', () => {
    const v = parseGroupView({ id: 'g', status: 'cancelled', total: 'abc', subtotal: null, orders: 'nope' })!;
    expect([v.total, v.subtotal, v.feeTotal, v.discount, v.restaurantCount]).toEqual([null, null, null, null, null]);
    expect(v.status).toBe('CANCELLED');
    expect(v.orders).toEqual([]);
  });

  it('is null when there is no group id (so the caller shows an error instead of an empty panel)', () => {
    for (const bad of [null, undefined, {}, { data: {} }, { data: [] }, 'x']) expect(parseGroupView(bad)).toBeNull();
  });

  it('status wording', () => {
    expect(groupStatusLabel('AWAITING_RESTAURANTS')).toBe('Waiting for restaurants');
    expect(groupStatusLabel('PREPARING')).toBe('Preparing');
    expect(groupStatusLabel('SOMETHING_NEW')).toBe('Something new');
  });
});

describe('admin cancel answer', () => {
  it('reads groupId and cancelledOrders from the real answer', () => {
    expect(parseCancelOutcome(rawGroupCancel())).toEqual({ groupId: GROUP_ID, cancelledOrders: 2 });
    expect(parseCancelOutcome(rawGroupCancel({ cancelledOrders: 0, message: 'This order was already cancelled.' }))).toEqual({ groupId: GROUP_ID, cancelledOrders: 0 });
  });
  it('single orders and junk have neither', () => {
    expect(parseCancelOutcome({ success: true, message: 'Order cancelled.', data: {} })).toEqual({ groupId: null, cancelledOrders: null });
    expect(parseCancelOutcome(null)).toEqual({ groupId: null, cancelledOrders: null });
    expect(parseCancelOutcome({ groupId: 'g', cancelledOrders: -3 })).toEqual({ groupId: 'g', cancelledOrders: null });
  });
  it('toast says how many orders were cancelled', () => {
    expect(cancelToastText({ groupId: 'g', cancelledOrders: 3 }, { paid: true, refundFailed: false })).toEqual({
      title: 'Combined order cancelled', description: '3 orders were cancelled (the whole combined order). The customer is being refunded in full automatically.',
    });
    expect(cancelToastText({ groupId: 'g', cancelledOrders: 2 }, { paid: false, refundFailed: false }).description).toContain('No payment was captured');
    expect(cancelToastText({ groupId: 'g', cancelledOrders: 2 }, { paid: true, refundFailed: true }).description).toContain('refund failed');
  });
  it('already cancelled: says nothing changed; no count from an older server falls back to what we knew, else generic', () => {
    expect(cancelToastText({ groupId: 'g', cancelledOrders: 0 }, { paid: true, refundFailed: false }).title).toBe('Already cancelled');
    expect(cancelToastText({ groupId: 'g', cancelledOrders: null }, { size: 2, paid: true, refundFailed: false }).description).toContain('2 orders were cancelled');
    expect(cancelToastText({ groupId: 'g', cancelledOrders: null }, { paid: true, refundFailed: false }).description).toContain('The whole combined order was cancelled.');
  });
  it('a single order keeps the old wording', () => {
    expect(cancelToastText({ groupId: null, cancelledOrders: null }, { paid: true, refundFailed: false })).toEqual({ title: 'Order cancelled', description: 'The customer is being refunded automatically.' });
    expect(cancelToastText({ groupId: null, cancelledOrders: null }, { paid: false, refundFailed: false }).description).toBe('No payment was captured, nothing to refund.');
  });
});

describe('needs-attention rows of a combined order', () => {
  it('carry the group id (row level) and the group on the order', () => {
    const [entry] = normalizeAttention({ success: true, data: [rawGroupAttentionRow()] });
    expect(entry.groupId).toBe(GROUP_ID);
    expect(entry.order?.group?.size).toBe(2);
    expect(entry.problems[0].detail).toContain('Combined order of 2 restaurants');
  });
  it('a single-order row has no groupId', () => {
    const { groupId, ...single } = rawGroupAttentionRow();
    const row = { ...single, order: { ...rawGroupOrder(0), group: undefined, groupId: undefined } };
    const [entry] = normalizeAttention({ data: [row] });
    expect('groupId' in entry).toBe(false);
  });
});

describe('refund wording for the parts of a combined order', () => {
  it('a cancelled paid SIBLING is not "Paid, no refund recorded" (the refund lives on the primary)', () => {
    const sibling = normalizeOrder(rawGroupOrder(1, { status: 'CANCELLED', cancelledBy: 'SYSTEM' }));
    expect(refundInfo(sibling)).toMatchObject({ label: 'Refund is on the combined order', tone: 'info' });
  });
  it('the PRIMARY keeps the real warning, and a single order is unchanged', () => {
    expect(refundInfo(normalizeOrder(rawGroupOrder(0, { status: 'CANCELLED' })))?.label).toBe('Paid, no refund recorded');
    expect(refundInfo(normalizeOrder({ id: 's', status: 'CANCELLED', paymentStatus: 'PAID' }))?.label).toBe('Paid, no refund recorded');
  });
  it('a sibling already refunded just says Refunded', () => {
    expect(refundInfo(normalizeOrder(rawGroupOrder(1, { status: 'CANCELLED', paymentStatus: 'REFUNDED' })))?.label).toBe('Refunded');
  });
});

describe('one rider, several parts', () => {
  const part = (index: number, status: string) => normalizeOrder(rawGroupOrder(index, { status, driverId: 'u1' }));
  it('prefers the most advanced part, then the primary; unrelated orders: the later one wins as before', () => {
    expect(preferRiderOrder(part(1, 'PICKED_UP'), part(0, 'READY_FOR_PICKUP'))).toBe(true);
    expect(preferRiderOrder(part(1, 'READY_FOR_PICKUP'), part(0, 'PICKED_UP'))).toBe(false);
    expect(preferRiderOrder(part(0, 'PICKED_UP'), part(1, 'PICKED_UP'))).toBe(true);
    expect(preferRiderOrder(part(1, 'PICKED_UP'), part(0, 'PICKED_UP'))).toBe(false);
    expect(preferRiderOrder(normalizeOrder({ id: 'a' }), part(0, 'PICKED_UP'))).toBe(true);
  });
  it('label names the combined order instead of one part', () => {
    expect(riderOrderLabel(part(0, 'PICKED_UP'))).toBe('Combined order (2 restaurants) to BH2');
    expect(riderOrderLabel(normalizeOrder({ id: 'abc123456', dropoffHostel: 'BH1' }))).toBe('#123456 to BH1');
  });
});

describe('fees: maxRestaurantsPerOrder and the extra restaurant fee (match backend validateFees)', () => {
  const form = (over: Partial<FeesForm> = {}): FeesForm => ({
    baseFee: '25', lines: [], extraRestaurantFee: '15', freeFeeAbove: '0', smallOrderBelow: '0', smallOrderFee: '0', gstOnFeesPercent: '18', gstOnFoodPercent: '5', maxRestaurantsPerOrder: '3', ...over,
  });
  it('accepts whole numbers 1 to 5 and sends a number', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(validateFees(form({ maxRestaurantsPerOrder: String(n) })).value?.maxRestaurantsPerOrder).toBe(n);
  });
  it('refuses 0, 6, decimals, text, empty and negative', () => {
    for (const bad of ['0', '6', '3.5', 'abc', '', '-1', '1e1', ' ']) {
      const r = validateFees(form({ maxRestaurantsPerOrder: bad }));
      expect([bad, r.ok]).toEqual([bad, false]);
      expect(r.errors.maxRestaurantsPerOrder).toContain('whole number from 1 to 5');
    }
    expect(parseRestaurantsPerOrder(' 4 ')).toEqual({ ok: true, value: 4 });
  });
  it('extra restaurant fee is 0..200 (server limit), not the 500 of the other fees', () => {
    expect(validateFees(form({ extraRestaurantFee: '0' })).ok).toBe(true);
    expect(validateFees(form({ extraRestaurantFee: '200' })).ok).toBe(true);
    expect(validateFees(form({ extraRestaurantFee: '200.5' })).ok).toBe(false);
    expect(validateFees(form({ extraRestaurantFee: '201' })).ok).toBe(false);
    expect(validateFees(form({ extraRestaurantFee: '15.555' })).ok).toBe(false);
    expect(validateFees(form({ baseFee: '500' })).ok).toBe(true); // other fees keep their limit
  });
});
