// @vitest-environment jsdom
// App wiring for admin user management: the Activity tab, the open switch of an ownerless restaurant (NO_OWNER), and the vendor list
// reacting to an owner change. API and socket are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('./components/CampusMap', () => ({ default: () => null }));

import { App } from './App';
import { ToastProvider } from './components/ui/Toast';
import { ApiError, apiService } from './services/api';
import { normalizeVendor } from './types';
import { parseAuditActions, parseAuditPage } from './lib/auditParse';
import { rawAdminVendor, rawAuditActions, rawAuditPage, rawNoOwner, rawOwnerlessVendor } from './test/adminFixtures';

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
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement;

const mockApi = (vendors = [normalizeVendor(rawAdminVendor()), normalizeVendor(rawOwnerlessVendor())]) => {
  vi.spyOn(apiService, 'validateSession').mockResolvedValue({ id: 'a1', name: 'Admin', phone: '1', role: 'ADMIN' } as any);
  vi.spyOn(apiService, 'fetchOrderPage').mockResolvedValue({ orders: [], nextCursor: null });
  vi.spyOn(apiService, 'fetchVendors').mockResolvedValue(vendors);
  vi.spyOn(apiService, 'fetchDrivers').mockResolvedValue([]);
  vi.spyOn(apiService, 'fetchDriverLocations').mockResolvedValue([]);
  vi.spyOn(apiService, 'fetchNeedsAttention').mockResolvedValue({ available: true, entries: [] });
  vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 0, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 }, data: [] } as any);
  vi.spyOn(apiService, 'fetchCampus').mockResolvedValue(null);
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

describe('Activity tab', () => {
  it('is in the sidebar, opens the log (read only) and has no search box in the header (it has its own filters)', async () => {
    mockApi();
    const fetchLog = vi.spyOn(apiService, 'fetchAuditLog').mockResolvedValue(parseAuditPage(rawAuditPage())!);
    vi.spyOn(apiService, 'fetchAuditActions').mockResolvedValue(parseAuditActions(rawAuditActions())!);
    await mount();
    await flush();
    const nav = document.querySelector('nav[aria-label="Primary"]')!;
    const item = Array.from(nav.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Activity')!;
    expect(item).toBeDefined();
    await click(item);
    await flush();
    expect(document.querySelector('h1')!.textContent).toBe('Activity');
    expect(fetchLog).toHaveBeenCalledTimes(1);
    expect(document.querySelector('table')!.textContent).toContain('Customer suspended');
    expect(document.querySelector('input[type="search"]#au-q')).not.toBeNull();
    expect(document.querySelector('header input[type="search"]')).toBeNull();
    // read only: nothing on the screen writes
    expect(Array.from(document.querySelectorAll('main button')).map((b) => b.textContent).join('|')).not.toMatch(/delete|remove|edit/i);
  });

  it('a target in the log opens the tab it belongs to', async () => {
    mockApi();
    vi.spyOn(apiService, 'fetchAuditLog').mockResolvedValue(parseAuditPage(rawAuditPage([{ ...rawAuditPage().data[0], id: 'v1', action: 'VENDOR_REMOVED', targetType: 'VENDOR', targetId: 'ven-1abcdef' }]))!);
    vi.spyOn(apiService, 'fetchAuditActions').mockResolvedValue([]);
    await mount();
    await flush();
    await click(byLabel('Activity'));
    await flush();
    await click(Array.from(document.querySelectorAll('tbody button')).find((b) => b.textContent === 'Open Restaurants')!);
    await flush();
    expect(document.querySelector('h1')!.textContent).toBe('Vendors');
  });
});

describe('opening a restaurant without an owner', () => {
  it('shows the amber chip and a disabled switch; nothing is sent', async () => {
    mockApi();
    const toggle = vi.spyOn(apiService, 'toggleVendorStatus');
    await mount();
    await flush();
    await click(byLabel('Vendors'));
    await flush();
    const sw = document.querySelector('[role="switch"][aria-label="Imported Biryani House: accepting orders"]') as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(document.body.textContent).toContain('No owner');
    await click(sw);
    expect(toggle).not.toHaveBeenCalled();
  });

  it('if the server still refuses (409 NO_OWNER, e.g. the owner was detached in another tab) its message is shown as a message and the switch goes back', async () => {
    // The screen thinks it has an owner; the server knows better.
    mockApi([normalizeVendor(rawAdminVendor({ isAcceptingOrders: false }))]);
    vi.spyOn(apiService, 'toggleVendorStatus').mockRejectedValue(new ApiError(409, rawNoOwner().message, 'NO_OWNER', undefined, rawNoOwner()));
    await mount();
    await flush();
    await click(byLabel('Vendors'));
    await flush();
    const sw = () => document.querySelector('[role="switch"][aria-label="Sharma Dhaba: accepting orders"]') as HTMLButtonElement;
    expect(sw().getAttribute('aria-checked')).toBe('false');
    await click(sw());
    await flush();
    expect(document.body.textContent).toContain('Cannot open this restaurant');
    expect(document.body.textContent).toContain('Add an owner login first.');
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('main [role="alert"]')).toBeNull(); // not the red session-error banner
  });
});

describe('owner changes reach the list', () => {
  it('creating an owner in the Edit drawer updates the card behind it (chip gone, switch usable) without a reload', async () => {
    mockApi([normalizeVendor(rawOwnerlessVendor())]);
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    vi.spyOn(apiService, 'fetchVendorImpact').mockResolvedValue({} as any);
    vi.spyOn(apiService, 'createOwner').mockResolvedValue({ owner: { id: 'zc-vown-9', name: 'New Owner', phone: '+91 9876543299', accountStatus: 'ACTIVE', statusReason: null, lastLoginAt: null }, changed: true, generatedPassword: 'Abcdefgh23456789', restaurantClosed: true, payoutAccountMoved: false, openOrders: 0, warning: null, detachedUser: null, outcome: { changed: true, cancelled: [], failed: [], released: [], releaseFailed: [], remaining: [], warning: null }, issuedAt: null });
    await mount();
    await flush();
    await click(byLabel('Vendors'));
    await flush();
    await click(byLabel('Edit restaurant Imported Biryani House'));
    await flush();
    const open = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Create or attach an owner login')!;
    await click(open);
    const setValue = (id: string, value: string) => act(async () => {
      const el = document.getElementById(id) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await setValue('ow-name', 'New Owner');
    await setValue('ow-phone', '9876543299');
    await click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Create login')!);
    await flush();
    // finish the credential dialog
    const dlg = Array.from(document.querySelectorAll('[role="alertdialog"]')).pop() as HTMLElement;
    expect(dlg.textContent).toContain('Abcdefgh23456789');
    await click(dlg.querySelector('input[type="checkbox"]')!);
    await click(Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent === 'Done')!);
    expect(document.body.textContent).not.toContain('Abcdefgh23456789');
    // the card behind the drawer
    const card = Array.from(document.querySelectorAll('article')).find((a) => a.querySelector('h3')?.textContent === 'Imported Biryani House')!;
    expect(card.textContent).not.toContain('No owner');
    expect(card.textContent).toContain('Owner: New Owner');
  });
});

