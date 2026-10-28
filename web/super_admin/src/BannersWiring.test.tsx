// @vitest-environment jsdom
// App wiring for Docs/25: the Banners tab (sidebar item, header title, no search box, session handling). API and socket are mocked.
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
import { parseBanner } from './lib/bannerParse';
import { rawVendor } from './test/taxonomyFixtures';
import { rawBanner, rawSecond } from './test/bannerFixtures';

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

describe('Banners tab', () => {
  it('the sidebar has a Banners entry that opens the panel with the header title and no search box', async () => {
    mockApi();
    const list = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([parseBanner(rawBanner())!, parseBanner(rawSecond())!]);
    await mount();
    await flush();
    expect(nav('Banners')).toBeTruthy();
    expect(nav('Banners').querySelector('svg')).not.toBeNull();
    await click(nav('Banners'));
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(document.querySelector('h1')?.textContent).toBe('Banners');
    expect(document.querySelectorAll('li[data-banner-id]')).toHaveLength(2);
    expect(nav('Banners').getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('#global-search')).toBeNull();
    expect(document.querySelector('#global-search-mobile')).toBeNull();
  });

  it('leaving and coming back loads the list again; other tabs are not asked for banners', async () => {
    mockApi();
    const list = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([]);
    await mount();
    await flush();
    expect(list).not.toHaveBeenCalled();
    await click(nav('Banners'));
    await flush();
    await click(nav('Vendors'));
    await flush();
    await click(nav('Banners'));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('No banners yet');
  });

  it('a 401 from the banner list logs the admin out (session handling is shared)', async () => {
    mockApi();
    vi.spyOn(apiService, 'fetchBanners').mockRejectedValue(new ApiError(401, 'Session expired'));
    await mount();
    await flush();
    await click(nav('Banners'));
    await flush();
    expect(localStorage.getItem('kraveo_admin_token')).toBeNull();
    expect(document.querySelector('input[type="password"], input')).not.toBeNull(); // login screen
  });
});
