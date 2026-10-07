// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiService, clearAuthToken, getAuthToken, setAuthToken } from './api';
import { GROUP_ID, GROUP_ORDER_IDS, rawGroupAttentionRow, rawGroupCancel, rawGroupOrder, rawGroupView } from '../test/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearAuthToken();
  localStorage.clear();
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('WEB-09 token storage never throws', () => {
  it('works normally with a usable localStorage', () => {
    setAuthToken('Bearer abcdefghijkl');
    expect(getAuthToken()).toBe('abcdefghijkl');
    expect(localStorage.getItem('kraveo_admin_token')).toBe('abcdefghijkl');
    clearAuthToken();
    expect(getAuthToken()).toBe('');
  });

  it('blocked storage: reads, writes and clears do not throw, and the token lives in memory for this tab', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    vi.stubGlobal('localStorage', blocked);
    expect(() => getAuthToken()).not.toThrow();
    expect(getAuthToken()).toBe('');
    expect(() => setAuthToken('tokentokentoken')).not.toThrow();
    expect(getAuthToken()).toBe('tokentokentoken');
    expect(() => clearAuthToken()).not.toThrow();
    expect(getAuthToken()).toBe('');
  });

  it('a write that fails while reads work (quota) still keeps the token for this tab', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: () => { throw new Error('quota'); }, removeItem: (k: string) => { store.delete(k); } });
    setAuthToken('tokentokentoken');
    expect(getAuthToken()).toBe('tokentokentoken');
  });

  it('a token cleared in another tab (storage empty, writes fine) logs this tab out', () => {
    setAuthToken('tokentokentoken');
    localStorage.removeItem('kraveo_admin_token');
    expect(getAuthToken()).toBe('');
  });
});

describe('WEB-04 reassign sends force only when asked', () => {
  it('no force flag by default; force: true when forced', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { id: 'o1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await apiService.reassignOrderDriver('o1', 'd1');
    await apiService.reassignOrderDriver('o1', 'd1', true);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call as any)[1].body));
    expect(bodies[0]).toEqual({ driverId: 'd1' });
    expect(bodies[1]).toEqual({ driverId: 'd1', force: true });
  });

  it('keeps the server error code so the dashboard can ask "Assign anyway?"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: false, message: 'offline', code: 'RIDER_OFFLINE' }, 409)));
    await expect(apiService.reassignOrderDriver('o1', 'd1')).rejects.toMatchObject({ status: 409, code: 'RIDER_OFFLINE' });
  });
});

describe('WEB-03 order pages', () => {
  it('fetchOrderPage sends limit and cursor and returns nextCursor', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, nextCursor: 'cur2', data: [{ id: 'o1', createdAt: '2026-10-06T10:00:00Z' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await apiService.fetchOrderPage('cur1', 100);
    expect((fetchMock.mock.calls[0] as any)[0]).toContain('/api/orders?limit=100&cursor=cur1');
    expect(page.orders.map((o) => o.id)).toEqual(['o1']);
    expect(page.nextCursor).toBe('cur2');
  });

  it('fetchOrders is still a plain list; no nextCursor means no more pages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, nextCursor: null, data: [{ id: 'o1' }, { id: 'o2' }] })));
    expect((await apiService.fetchOrders()).map((o) => o.id)).toEqual(['o1', 'o2']);
    expect((await apiService.fetchOrderPage()).nextCursor).toBeNull();
  });
});

describe('Docs/22 combined orders', () => {
  it('cancelOrderWithResult keeps groupId and cancelledOrders, and still returns the order', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(rawGroupCancel()));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiService.cancelOrderWithResult(GROUP_ORDER_IDS[1], 'Admin decision');
    expect((fetchMock.mock.calls[0] as any)[0]).toContain(`/api/admin/orders/${GROUP_ORDER_IDS[1]}/cancel`);
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual({ reason: 'Admin decision' });
    expect(result.outcome).toEqual({ groupId: GROUP_ID, cancelledOrders: 2 });
    expect(result.order).toMatchObject({ id: GROUP_ORDER_IDS[1], status: 'CANCELLED', cancelledBy: 'ADMIN' });
    expect(result.order?.group?.size).toBe(2);
  });

  it('cancelOrder (old signature) still resolves to the order; a single-order answer has no group outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, message: 'Order cancelled.', data: { id: 'o1', status: 'CANCELLED' } })));
    expect((await apiService.cancelOrder('o1', 'because')))?.toMatchObject({ id: 'o1', status: 'CANCELLED' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, message: 'Order cancelled.', data: { id: 'o1', status: 'CANCELLED' } })));
    expect((await apiService.cancelOrderWithResult('o1', 'because')).outcome).toEqual({ groupId: null, cancelledOrders: null });
  });

  it('an answer without an order (older server) gives order null, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true })));
    expect(await apiService.cancelOrder('o1', 'because')).toBeNull();
  });

  it('fetchOrderGroup reads GET /api/order-groups/:id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: rawGroupView() }));
    vi.stubGlobal('fetch', fetchMock);
    const view = await apiService.fetchOrderGroup(GROUP_ID);
    expect((fetchMock.mock.calls[0] as any)[0]).toContain(`/api/order-groups/${GROUP_ID}`);
    expect(view).toMatchObject({ id: GROUP_ID, total: 260, subtotal: 270, feeTotal: 40, discount: 50 });
    expect(view.orders).toHaveLength(2);
  });

  it('fetchOrderGroup: 404 keeps the server message and status; a body that is not a group is a clear error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: false, code: 'NOT_FOUND', message: 'Order not found' }, 404)));
    await expect(apiService.fetchOrderGroup(GROUP_ID)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Order not found' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, data: { hello: 'world' } })));
    await expect(apiService.fetchOrderGroup(GROUP_ID)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('fetchOrderPage keeps the group of each order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, nextCursor: null, data: [rawGroupOrder(0), { id: 'single' }] })));
    const page = await apiService.fetchOrderPage();
    expect(page.orders[0].group?.id).toBe(GROUP_ID);
    expect(page.orders[1].group).toBeUndefined();
  });

  it('fetchNeedsAttention keeps groupId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, count: 1, data: [rawGroupAttentionRow()] })));
    const result = await apiService.fetchNeedsAttention();
    expect(result.entries[0].groupId).toBe(GROUP_ID);
  });
});
