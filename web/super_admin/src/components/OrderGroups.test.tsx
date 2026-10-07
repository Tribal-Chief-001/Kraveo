// @vitest-environment jsdom
// Docs/22 combined orders in the dashboard: badge, sibling list, lazy group total, cancel-the-whole-group wording, needs-attention, reassign note.
// Data comes from the real-shape fixtures in test/fixtures.ts (copied from the backend e2e tests).
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { OrderDrawer } from './OrderDrawer';
import { OrdersTable } from './OrdersTable';
import { NeedsAttentionPanel } from './NeedsAttentionPanel';
import { LiveCommandCenter } from './LiveCommandCenter';
import { RiderAssignSelect } from './OrderControls';
import { GroupBadge } from './ui/GroupBadge';
import { normalizeOrder } from '../types';
import { normalizeAttention } from '../lib/orderProblems';
import { parseGroupView } from '../lib/groupView';
import { byText, click, flush, mount, type, unmount } from '../test/dom';
import { GROUP_ID, GROUP_ORDER_IDS, rawGroupAttentionRow, rawGroupOrder, rawGroupView } from '../test/fixtures';
import { act } from 'react';

vi.mock('./CampusMap', () => ({ default: () => <div data-testid="map-stub" /> }));

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const noop = async () => true;
const baseProps = (over: Record<string, unknown> = {}) => ({
  order: normalizeOrder(rawGroupOrder(0)), mode: 'view' as const, onModeChange: vi.fn(), onClose: vi.fn(), riders: [],
  onAdvance: noop, onReassign: noop, onCancel: vi.fn(async () => null as string | null), onResetOtpLock: noop, onRetryRefund: noop,
  fetchGroup: vi.fn(async () => parseGroupView(rawGroupView())!), onOpenOrder: vi.fn(), ...over,
});
const render = async (over: Record<string, unknown> = {}) => {
  const props = baseProps(over);
  await mount(<OrderDrawer {...(props as any)} />);
  await flush();
  return props;
};
const text = () => document.body.textContent ?? '';

describe('GroupBadge', () => {
  it('shows "Combined order · N restaurants" and "1 of N", with an accessible label; nothing for a single order', async () => {
    const host = await mount(<><GroupBadge group={normalizeOrder(rawGroupOrder(1)).group} /><GroupBadge group={undefined} /></>);
    const badges = host.querySelectorAll('[data-testid="group-badge"]');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain('Combined order · 2 restaurants');
    expect(badges[0].textContent).toContain('2 of 2');
    expect(badges[0].getAttribute('aria-label')).toBe('Combined order of 2 restaurants, this is restaurant 2 of 2');
    expect(badges[0].className).toContain('flex-wrap'); // wraps on a 360 px phone instead of overflowing
  });
});

describe('order drawer: combined order', () => {
  it('shows the badge, the restaurants with their status chips, and loads the group lazily (once) for the group id', async () => {
    const props = await render();
    expect(props.fetchGroup).toHaveBeenCalledTimes(1);
    expect((props.fetchGroup as any).mock.calls[0][0]).toBe(GROUP_ID);
    const panel = document.querySelector('[data-testid="group-panel"]')!;
    expect(panel.textContent).toContain('Combined order · 2 restaurants');
    const items = panel.querySelectorAll('ul[aria-label="Restaurants in this combined order"] li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Kitchen 1');
    expect(items[0].textContent).toContain('This order');
    expect(items[1].textContent).toContain('Kitchen 2');
    expect(items[1].textContent).toContain('Placed');
    expect(items[0].getAttribute('aria-current')).toBe('true');
  });

  it('shows the group total only from the server: food, fees, discount, total, and where the single payment is recorded', async () => {
    await render({ order: normalizeOrder(rawGroupOrder(1)) });
    const totals = document.querySelector('dl[aria-label="Combined order total"]')!;
    expect(totals.textContent).toContain('Food (all restaurants)₹270');
    expect(totals.textContent).toContain('Fees (delivery and extra restaurants)₹40');
    expect(totals.textContent).toContain('Discount (KRAVEO50)−₹50');
    expect(totals.textContent).toContain('Group total paid by the customer₹260');
    expect(text()).toContain('Waiting for restaurants');
    expect(text()).toContain(`#${GROUP_ORDER_IDS[0].slice(-6).toUpperCase()}`); // the payment lives on the primary
    // this order's own money is labelled as its share, not as the total
    expect(text()).toContain("This restaurant's share");
  });

  it('while the group loads: a loading note, the siblings from the order itself, no invented total', async () => {
    let resolve: (v: any) => void = () => {};
    const fetchGroup = vi.fn(() => new Promise<any>((r) => { resolve = r; }));
    await render({ fetchGroup });
    expect(document.querySelector('[role="status"][aria-label="Loading combined order totals"]')).not.toBeNull();
    expect(document.querySelectorAll('ul[aria-label="Restaurants in this combined order"] li')).toHaveLength(2);
    expect(text()).not.toContain('Group total paid');
    await act(async () => { resolve(parseGroupView(rawGroupView())); });
    await flush();
    expect(text()).toContain('Group total paid by the customer');
    expect(document.querySelector('[aria-label="Loading combined order totals"]')).toBeNull();
  });

  it('when the group cannot be loaded: an alert with the server message and Try again (which loads it); the siblings stay listed', async () => {
    const fetchGroup = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Order not found'), { status: 404 }))
      .mockResolvedValue(parseGroupView(rawGroupView())!);
    await render({ fetchGroup });
    const alert = document.querySelector('[data-testid="group-panel"] [role="alert"]')!;
    expect(alert.textContent).toContain('The group total could not be loaded: Order not found');
    expect(document.querySelectorAll('ul[aria-label="Restaurants in this combined order"] li')).toHaveLength(2);
    expect(text()).not.toContain('Group total paid');
    await click(byText('button', 'Try again', alert as any));
    await flush();
    expect(fetchGroup).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Group total paid by the customer₹260');
  });

  it('freshly loaded sibling statuses replace the stale ones from the order, and a sibling can be opened (not the current one)', async () => {
    const fresh = rawGroupView({ orders: [rawGroupOrder(0), rawGroupOrder(1, { status: 'ACCEPTED' })] });
    const props = await render({ fetchGroup: vi.fn(async () => parseGroupView(fresh)!) });
    const items = document.querySelectorAll('ul[aria-label="Restaurants in this combined order"] li');
    expect(items[1].textContent).toContain('Accepted'); // the order's own stops said PLACED
    expect(items[0].querySelector('button')).toBeNull();
    const open = items[1].querySelector('button')!;
    expect(open.getAttribute('aria-label')).toContain('Kitchen 2');
    await click(open);
    expect(props.onOpenOrder).toHaveBeenCalledWith(GROUP_ORDER_IDS[1]);
  });

  it('a single order: no group panel, no badge, and the group endpoint is never called', async () => {
    const { group, groupId, ...single } = rawGroupOrder(0);
    const props = await render({ order: normalizeOrder(single) });
    expect(props.fetchGroup).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="group-panel"]')).toBeNull();
    expect(document.querySelector('[data-testid="group-badge"]')).toBeNull();
    expect(text()).not.toContain('Combined order');
    expect(text()).toContain('Cancel order and refund');
  });

  it('the cancel button and rider label say it is the whole group', async () => {
    await render();
    expect(text()).toContain('Cancel the whole combined order (2) and refund');
    expect(text()).toContain('Rider (for all 2 orders)');
    expect(text()).toContain('Combined order: this moves all 2 orders to the rider');
  });

  it('a refund problem on a combined order mentions the whole group', async () => {
    const order = normalizeOrder(rawGroupOrder(0, { status: 'CANCELLED', refundStatus: 'FAILED', refundError: 'provider error' }));
    await render({ order, problems: [{ code: 'PAYMENT_MISMATCH', detail: 'Captured Rs 10 but the total is Rs 260' }] });
    expect(text()).toContain('The payment and the refund belong to the whole combined order (2 restaurants)');
  });
});

describe('order drawer: cancelling a combined order', () => {
  it('the cancel form says it cancels the WHOLE order, lists every restaurant and refunds the group total', async () => {
    await render({ mode: 'cancel' });
    const warning = document.querySelector('[data-testid="cancel-group-warning"]')!;
    expect(warning.textContent).toContain('This cancels the WHOLE combined order (all 2 restaurants) and refunds the customer in full.');
    expect(warning.textContent).toContain('Kitchen 1');
    expect(warning.textContent).toContain('Kitchen 2');
    expect(text()).toContain('Refunds ₹260 for the whole combined order, automatically'); // the group total, not this order's share of 190
    expect(text()).not.toContain('Refunds ₹190');
    expect(byText('button', 'Cancel all 2 orders and refund')).toBeDefined();
  });

  it('before the group has loaded the refund amount is not guessed', async () => {
    await render({ mode: 'cancel', fetchGroup: vi.fn(() => new Promise(() => {})) });
    expect(text()).toContain('Refunds the full payment for the whole combined order, automatically');
    expect(text()).not.toMatch(/Refunds ₹\d/);
  });

  it('an unpaid combined order does not promise a refund', async () => {
    await render({ mode: 'cancel', order: normalizeOrder(rawGroupOrder(0, { paymentStatus: 'PENDING', status: 'PLACED' })) });
    const warning = document.querySelector('[data-testid="cancel-group-warning"]')!;
    expect(warning.textContent).toContain('(all 2 restaurants). Nothing was paid, so nothing is refunded.');
    expect(warning.textContent).not.toContain('refunds the customer in full');
  });

  it('submitting asks once more with the same sentence; Keep order sends nothing, Confirm sends the cancel once', async () => {
    const props = await render({ mode: 'cancel' });
    await type(document.getElementById('admin-cancel-reason'), 'Kitchen 2 is closed');
    const submit = () => click(document.querySelector('button[type="submit"][form="admin-cancel-form"]'));
    await submit();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Cancel all 2 restaurants?');
    expect(dialog.textContent).toContain('This cancels the WHOLE combined order (all 2 restaurants) and refunds the customer in full.');
    await click(byText('button', 'Keep order', dialog as any));
    expect(props.onCancel).not.toHaveBeenCalled();
    await submit();
    await click(byText('button', 'Cancel all 2 orders', document.querySelector('[role="alertdialog"]') as any));
    await flush();
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledWith(GROUP_ORDER_IDS[0], 'Kitchen 2 is closed');
  });

  it('a single order is cancelled without the extra question and with the old texts', async () => {
    const { group, groupId, ...single } = rawGroupOrder(0);
    const props = await render({ mode: 'cancel', order: normalizeOrder(single) });
    expect(document.querySelector('[data-testid="cancel-group-warning"]')).toBeNull();
    expect(text()).toContain('Refunds ₹190 to the customer automatically');
    await type(document.getElementById('admin-cancel-reason'), 'Customer asked');
    await click(document.querySelector('button[type="submit"][form="admin-cancel-form"]'));
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(props.onCancel).toHaveBeenCalledWith(GROUP_ORDER_IDS[0], 'Customer asked');
  });
});

describe('orders table: one row per order, with the group badge', () => {
  const orders = [normalizeOrder(rawGroupOrder(0)), normalizeOrder(rawGroupOrder(1)), normalizeOrder({ id: 'single-order-1', customerName: 'Ravi', vendorName: 'Solo Dhaba', status: 'PLACED', paymentStatus: 'PAID', totalAmount: 100, createdAt: '2026-10-07T03:00:00.000Z' })];
  const table = (query = '') => (
    <OrdersTable orders={orders} attentionIds={new Set()} onAdvance={noop} onOpenOrder={vi.fn()} now={Date.parse('2026-10-07T03:50:00.000Z')} query={query} />
  );

  it('keeps one row per order (no merged or duplicated rows) and badges only the grouped ones, with "1 of 2" / "2 of 2"', async () => {
    const host = await mount(table());
    const rows = host.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    const badges = Array.from(host.querySelectorAll('tbody [data-testid="group-badge"]')).map((b) => b.textContent);
    expect(badges).toHaveLength(2);
    expect(badges[0]).toContain('1 of 2');
    expect(badges[1]).toContain('2 of 2');
    expect(rows[2].querySelector('[data-testid="group-badge"]')).toBeNull();
    expect(rows[0].textContent).toContain("this restaurant's share");
    expect(rows[2].textContent).not.toContain('share');
  });

  it('the phone cards badge the grouped orders too', async () => {
    const host = await mount(table());
    expect(host.querySelectorAll('article [data-testid="group-badge"]')).toHaveLength(2);
    expect(host.querySelectorAll('article')).toHaveLength(3);
  });

  it('search finds both parts by the other restaurant\'s name or the group id', async () => {
    const byOther = await mount(table('kitchen 2'));
    expect(byOther.querySelectorAll('tbody tr')).toHaveLength(2);
    await unmount();
    const byGroup = await mount(table(GROUP_ID));
    expect(byGroup.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});

describe('needs-attention list', () => {
  const entries = normalizeAttention({ success: true, data: [rawGroupAttentionRow()] });
  const props = (over: Record<string, unknown> = {}) => ({
    entries, serverAvailable: true, loading: false, error: '', checkedAt: Date.now(), onRefresh: () => {}, onOpenOrder: vi.fn(),
    onResetOtpLock: noop, onRetryRefund: noop, ...over,
  });

  it('shows the group (badge and restaurants) and, for a refund problem, says the money belongs to the whole group', async () => {
    const host = await mount(<NeedsAttentionPanel {...(props() as any)} />);
    const group = host.querySelector('[data-testid="attention-group"]')!;
    expect(group.textContent).toContain('Combined order · 2 restaurants');
    expect(group.textContent).toContain('Restaurants: Kitchen 1, Kitchen 2');
    expect(group.textContent).toContain('The payment and the refund belong to the whole combined order (2 restaurants)');
    expect(host.textContent).toContain('Combined order of 2 restaurants (Kitchen 1, Kitchen 2): this one payment covers all of them.'); // the server's own detail line
    expect(host.querySelectorAll('article')).toHaveLength(1); // one card for the group, as the server sends it
  });

  it('a non-money problem shows the group but not the refund sentence; the cancel button says combined order; search by restaurant works', async () => {
    const row = rawGroupAttentionRow({ problem: 'STUCK_UNACCEPTED', problems: ['STUCK_UNACCEPTED'], detail: 'Not accepted', order: rawGroupOrder(1, { status: 'PLACED' }) });
    const host = await mount(<NeedsAttentionPanel {...(props({ entries: normalizeAttention({ data: [row] }), query: 'kitchen 1' }) as any)} />);
    expect(host.querySelector('[data-testid="attention-group"]')!.textContent).not.toContain('refund belong');
    expect(host.querySelectorAll('article')).toHaveLength(1);
    await unmount();
    const none = await mount(<NeedsAttentionPanel {...(props({ entries: normalizeAttention({ data: [row] }), query: 'no such restaurant' }) as any)} />);
    expect(none.querySelectorAll('article')).toHaveLength(0);
  });

  it('a single-order entry has no group box', async () => {
    const single = normalizeAttention({ data: [{ problem: 'NO_RIDER', problems: ['NO_RIDER'], detail: 'x', order: { id: 'single', status: 'READY_FOR_PICKUP', paymentStatus: 'PAID' } }] });
    const host = await mount(<NeedsAttentionPanel {...(props({ entries: single }) as any)} />);
    expect(host.querySelector('[data-testid="attention-group"]')).toBeNull();
  });
});

describe('reassign a rider', () => {
  it('explains that it moves the whole group, linked to the select for screen readers; nothing extra for a single order', async () => {
    const host = await mount(<><RiderAssignSelect order={normalizeOrder(rawGroupOrder(0))} riders={[]} onReassign={noop} id="a" /><RiderAssignSelect order={normalizeOrder({ id: 'single', paymentStatus: 'PAID' })} riders={[]} onReassign={noop} id="b" /></>);
    const selects = host.querySelectorAll('select');
    const note = host.querySelector('p')!;
    expect(note.textContent).toContain('this moves all 2 orders to the rider');
    expect(selects[0].getAttribute('aria-describedby')).toContain(note.id);
    expect(host.querySelectorAll('p')).toHaveLength(1);
    expect(selects[1].getAttribute('aria-describedby')).toBeNull();
  });
});

describe('live pipeline', () => {
  it('lists each part as its own card (one per order) with the group badge', async () => {
    const orders = [normalizeOrder(rawGroupOrder(0)), normalizeOrder(rawGroupOrder(1, { status: 'ACCEPTED' }))];
    const host = await mount(<LiveCommandCenter drivers={[]} orders={orders} driverPartners={[]} onReassignDriver={noop} onOpenOrder={vi.fn()} />);
    await flush();
    const cards = host.querySelectorAll('section[aria-label="Delivery pipeline"] article');
    expect(cards).toHaveLength(2);
    cards.forEach((card) => expect(card.querySelector('[data-testid="group-badge"]')).not.toBeNull());
  });
});
