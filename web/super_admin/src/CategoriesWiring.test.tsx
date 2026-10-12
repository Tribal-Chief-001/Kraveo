// @vitest-environment jsdom
// App wiring for Docs/23: the Categories tab, and a saved restaurant profile refreshing the vendor list. API and socket are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('./components/CampusMap', () => ({ default: () => null }));

import { App } from './App';
import { ToastProvider } from './components/ui/Toast';
import { ApiError, apiService } from './services/api';
import { normalizeVendor } from './types';
import { parseCategory } from './lib/categoryParse';
import { rawCategory, rawNorthIndian, rawVendor } from './test/taxonomyFixtures';

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
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const nav = (label: string) => Array.from(document.querySelectorAll('nav[aria-label="Primary"] button')).find((b) => b.getAttribute('aria-label')?.startsWith(label)) as HTMLButtonElement;

const mockApi = (vendors = [normalizeVendor(rawVendor())]) => {
  vi.spyOn(apiService, 'validateSession').mockResolvedValue({ id: 'a1', name: 'Admin', phone: '1', role: 'ADMIN' } as any);
  vi.spyOn(apiService, 'fetchOrderPage').mockResolvedValue({ orders: [], nextCursor: null });
  const fetchVendors = vi.spyOn(apiService, 'fetchVendors').mockResolvedValue(vendors);
  vi.spyOn(apiService, 'fetchDrivers').mockResolvedValue([]);
  vi.spyOn(apiService, 'fetchDriverLocations').mockResolvedValue([]);
  vi.spyOn(apiService, 'fetchNeedsAttention').mockResolvedValue({ available: true, entries: [] });
  vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 0, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 }, data: [] } as any);
  vi.spyOn(apiService, 'fetchCampus').mockResolvedValue(null);
  vi.spyOn(apiService, 'fetchCatalogPendingCounts').mockResolvedValue({ pending: 0, changePending: 0, total: 0 });
  vi.spyOn(apiService, 'fetchPendingSettlementCount').mockResolvedValue(0);
  return { fetchVendors };
};

beforeEach(() => { localStorage.clear(); localStorage.setItem('kraveo_admin_token', 'stored-admin-token-123'); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('Categories tab', () => {
  it('the sidebar has a Categories entry that opens the panel with the title from the header', async () => {
    mockApi();
    const list = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([parseCategory(rawCategory())!, parseCategory(rawNorthIndian())!]);
    await mount();
    await flush();
    expect(nav('Categories')).toBeTruthy();
    await click(nav('Categories'));
    await flush();
    expect(list).toHaveBeenCalledWith({ includeInactive: true });
    expect(document.querySelector('h1')?.textContent).toBe('Categories');
    expect(document.body.textContent).toContain('What the switches mean');
    expect(document.querySelectorAll('li[data-category-id]')).toHaveLength(2);
    expect(nav('Categories').getAttribute('aria-current')).toBe('page');
  });

  it('a 401 from the category list logs the admin out (session handling is shared)', async () => {
    mockApi();
    vi.spyOn(apiService, 'fetchCategories').mockRejectedValue(new ApiError(401, 'Session expired'));
    await mount();
    await flush();
    await click(nav('Categories'));
    await flush();
    expect(localStorage.getItem('kraveo_admin_token')).toBeNull();
    expect(document.querySelector('input[type="password"], input')).not.toBeNull(); // login screen
  });

  it('renaming a category reloads the vendors so the new name shows (the server rewrote their text)', async () => {
    const api = mockApi();
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([parseCategory(rawCategory())!]);
    vi.spyOn(apiService, 'updateCategory').mockResolvedValue({ category: parseCategory(rawCategory({ name: 'Biryani & Pulao' }))!, changed: true, message: 'Category saved.' });
    await mount();
    await flush();
    await click(nav('Categories'));
    await flush();
    const before = api.fetchVendors.mock.calls.length;
    await click(document.querySelector('button[aria-label="Edit Biryani"]'));
    const input = document.querySelector('[role="dialog"] input[maxlength="40"]:not([lang])') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Biryani & Pulao');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Save changes'));
    await flush();
    expect(api.fetchVendors.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('Vendors tab: edit restaurant', () => {
  it('saving a profile shows the new values at once and reloads the vendor list', async () => {
    const api = mockApi();
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([parseCategory(rawCategory())!, parseCategory(rawNorthIndian())!]);
    const fresh = normalizeVendor(rawVendor({ name: 'Shape Kitchen Deluxe', category: 'Biryani', cuisines: [{ id: '72077a2d-9b97-48de-9956-8d0167228f34', name: 'Biryani', icon: 'biryani' }] }));
    vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: fresh, changed: true, message: 'Restaurant saved.' });
    await mount();
    await flush();
    await click(nav('Vendors'));
    await flush();
    expect(document.body.textContent).toContain('Shape Kitchen & Co');
    const before = api.fetchVendors.mock.calls.length;
    await click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Edit restaurant'));
    await flush();
    const name = document.getElementById('er-name') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Shape Kitchen Deluxe');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Save changes'));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain('Shape Kitchen Deluxe');
    expect(api.fetchVendors.mock.calls.length).toBeGreaterThan(before);
  });
});
