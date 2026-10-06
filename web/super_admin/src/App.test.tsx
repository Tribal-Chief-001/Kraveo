// @vitest-environment jsdom
// App wiring for the pre-demo fixes: stored-session check (WEB-07), socket reconnects (WEB-06),
// silent refresh of vendors and riders (WEB-05), force-assigning an offline rider (WEB-04). API and socket are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

const sockets: any[] = [];
const ioCalls: any[] = [];
vi.mock('socket.io-client', () => ({
  io: (url: string, opts: any) => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const socket = { handlers, on: (event: string, fn: any) => { handlers[event] = fn; }, emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() };
    sockets.push(socket);
    ioCalls.push({ url, opts });
    return socket;
  },
}));
vi.mock('./components/CampusMap', () => ({ default: () => null }));

import { App } from './App';
import { ToastProvider } from './components/ui/Toast';
import { ApiError, apiService } from './services/api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ToastProvider><App /></ToastProvider>); });
  return host;
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const byText = (selector: string, text: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll(selector)).find((el) => el.textContent?.trim() === text) as HTMLElement | undefined;

const TOKEN_KEY = 'kraveo_admin_token';
const NOW = Date.now();
const rider = { id: 'p1', userId: 'u1', name: 'Sleepy', phone: '9', studentRegNo: '', runnerCode: 'R1', vehicleType: 'Bike', vehicleRegNo: 'MP', emergencyPhone: '', dutyStatus: 'OFFLINE', ordersToday: 0, totalEarningsToday: 0, avgCompletionTimeMinutes: 0, onTimeRatePercent: 0, rating: 5, createdAt: new Date(NOW).toISOString(), approvalStatus: 'APPROVED' } as any;
const paidOrder = { id: 'order-abc123', customerName: 'Asha', vendorName: 'Sharma Dhaba', vendorId: 'v1', items: [], itemsCount: 1, totalAmount: 100, deliveryFee: 10, dropoffHostel: 'BH1', status: 'ACCEPTED', paymentStatus: 'PAID', createdAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW - 30_000).toISOString() } as any;

const mockApi = () => {
  vi.spyOn(apiService, 'validateSession').mockResolvedValue({ id: 'a1', name: 'Admin', phone: '1', role: 'ADMIN' } as any);
  const fetchOrderPage = vi.spyOn(apiService, 'fetchOrderPage').mockResolvedValue({ orders: [paidOrder], nextCursor: null });
  const fetchVendors = vi.spyOn(apiService, 'fetchVendors').mockResolvedValue([]);
  const fetchDrivers = vi.spyOn(apiService, 'fetchDrivers').mockResolvedValue([rider]);
  vi.spyOn(apiService, 'fetchDriverLocations').mockResolvedValue([]);
  vi.spyOn(apiService, 'fetchNeedsAttention').mockResolvedValue({ available: true, entries: [] });
  vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 0, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 }, data: [] } as any);
  vi.spyOn(apiService, 'fetchCampus').mockResolvedValue(null);
  return { fetchOrderPage, fetchVendors, fetchDrivers };
};

beforeEach(() => {
  sockets.length = 0; ioCalls.length = 0;
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'stored-admin-token-123');
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('WEB-07 stored session check', () => {
  it('server unreachable: keeps the token, says it is retrying, does not show the login screen', async () => {
    mockApi();
    vi.spyOn(apiService, 'validateSession').mockRejectedValue(new ApiError(0, 'The operations API is unreachable.', 'NETWORK'));
    const h = await mount();
    await flush();
    expect(localStorage.getItem(TOKEN_KEY)).toBe('stored-admin-token-123');
    expect(h.textContent).toContain('Cannot reach the server, retrying');
  });

  it('5xx and 429 keep the token too', async () => {
    mockApi();
    vi.spyOn(apiService, 'validateSession').mockRejectedValue(new ApiError(503, 'Service unavailable'));
    await mount();
    await flush();
    expect(localStorage.getItem(TOKEN_KEY)).toBe('stored-admin-token-123');
  });

  it('401 clears the token and shows the login screen', async () => {
    mockApi();
    vi.spyOn(apiService, 'validateSession').mockRejectedValue(new ApiError(401, 'Session expired'));
    const h = await mount();
    await flush();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(h.textContent).not.toContain('Cannot reach the server');
    expect(h.querySelector('input')).not.toBeNull();
  });
});

describe('WEB-06 / WEB-05 live socket', () => {
  it('never gives up reconnecting, retries after a server-side disconnect, and refreshes vendors and riders on reconnect', async () => {
    const api = mockApi();
    await mount();
    await flush();
    expect(ioCalls).toHaveLength(1);
    expect(ioCalls[0].opts.reconnectionAttempts).toBe(Infinity);
    expect(ioCalls[0].opts.reconnectionDelayMax).toBeLessThanOrEqual(10_000);
    const socket = sockets[0];

    await act(async () => { socket.handlers.disconnect('io server disconnect'); });
    expect(socket.connect).toHaveBeenCalledTimes(1);
    await act(async () => { socket.handlers.disconnect('transport close'); });
    expect(socket.connect).toHaveBeenCalledTimes(1); // socket.io retries those itself

    const vendorCalls = api.fetchVendors.mock.calls.length;
    const driverCalls = api.fetchDrivers.mock.calls.length;
    await act(async () => { socket.handlers.connect(); }); // first connect: no catch-up
    await act(async () => { socket.handlers.connect(); }); // reconnect: catch up from REST
    await flush();
    expect(api.fetchVendors.mock.calls.length).toBeGreaterThan(vendorCalls);
    expect(api.fetchDrivers.mock.calls.length).toBeGreaterThan(driverCalls);
  });
});

describe('WEB-04 assigning an offline rider', () => {
  it('asks "Assign anyway?", and only on yes sends force: true', async () => {
    mockApi();
    const reassign = vi.spyOn(apiService, 'reassignOrderDriver').mockResolvedValue({ ...paidOrder, driverId: 'u1', driverName: 'Sleepy' });
    const h = await mount();
    await flush();
    const select = h.querySelector('select[aria-label^="Assign rider for order"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const choose = async () => act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'p1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await choose();
    let dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('This rider is offline. Assign anyway?');
    expect(reassign).not.toHaveBeenCalled();
    await click(byText('button', 'Cancel', dialog)!);
    await flush();
    expect(reassign).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Rider not changed');

    await choose();
    dialog = document.querySelector('[role="alertdialog"]')!;
    await click(byText('button', 'Assign anyway', dialog)!);
    await flush();
    expect(reassign).toHaveBeenCalledWith('order-abc123', 'p1', true);
  });

  it('a rider the roster thinks is online but the server says is offline: asks, then resends with force', async () => {
    mockApi();
    vi.spyOn(apiService, 'fetchDrivers').mockResolvedValue([{ ...rider, dutyStatus: 'ONLINE' }]);
    const reassign = vi.spyOn(apiService, 'reassignOrderDriver')
      .mockRejectedValueOnce(new ApiError(409, 'That rider is offline. Send force: true to assign them anyway.', 'RIDER_OFFLINE'))
      .mockResolvedValueOnce({ ...paidOrder, driverId: 'u1', driverName: 'Sleepy' });
    const h = await mount();
    await flush();
    const select = h.querySelector('select[aria-label^="Assign rider for order"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'p1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Assign anyway?');
    await click(byText('button', 'Assign anyway', dialog)!);
    await flush();
    expect(reassign).toHaveBeenNthCalledWith(1, 'order-abc123', 'p1', false);
    expect(reassign).toHaveBeenNthCalledWith(2, 'order-abc123', 'p1', true);
  });

  it('RIDER_BUSY shows a plain sentence, not the server wording', async () => {
    mockApi();
    vi.spyOn(apiService, 'fetchDrivers').mockResolvedValue([{ ...rider, dutyStatus: 'ONLINE' }]);
    vi.spyOn(apiService, 'reassignOrderDriver').mockRejectedValue(new ApiError(409, 'raw server text', 'RIDER_BUSY'));
    const h = await mount();
    await flush();
    const select = h.querySelector('select[aria-label^="Assign rider for order"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'p1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain('already has an active order');
    expect(document.body.textContent).not.toContain('raw server text');
  });
});
