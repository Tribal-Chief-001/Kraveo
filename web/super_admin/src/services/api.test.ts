// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiService, clearAuthToken, getAuthToken, setAuthToken } from './api';

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
