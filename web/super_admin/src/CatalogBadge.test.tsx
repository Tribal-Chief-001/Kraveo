// @vitest-environment jsdom
// The sidebar badge of the Catalog tab shows data.total of GET /api/admin/catalog/pending-count; the admin vendor view carries the commission.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('./components/CampusMap', () => ({ default: () => null }));

import { App } from './App';
import { ToastProvider } from './components/ui/Toast';
import { apiService } from './services/api';
import { normalizeVendor } from './types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => { localStorage.clear(); localStorage.setItem('kraveo_admin_token', 'stored-admin-token-123'); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null; document.body.innerHTML = ''; localStorage.clear();
});

describe('Catalog sidebar badge', () => {
  it('shows total = new dishes + price-change requests', async () => {
    vi.spyOn(apiService, 'validateSession').mockResolvedValue({ id: 'a1', name: 'Admin', phone: '1', role: 'ADMIN' } as any);
    vi.spyOn(apiService, 'fetchOrderPage').mockResolvedValue({ orders: [], nextCursor: null });
    vi.spyOn(apiService, 'fetchVendors').mockResolvedValue([]);
    vi.spyOn(apiService, 'fetchDrivers').mockResolvedValue([]);
    vi.spyOn(apiService, 'fetchDriverLocations').mockResolvedValue([]);
    vi.spyOn(apiService, 'fetchNeedsAttention').mockResolvedValue({ available: true, entries: [] });
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 0, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 }, data: [] } as any);
    vi.spyOn(apiService, 'fetchCampus').mockResolvedValue(null);
    vi.spyOn(apiService, 'fetchCatalogPendingCounts').mockResolvedValue({ pending: 3, changePending: 2, total: 5 });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<ToastProvider><App /></ToastProvider>); });
    await flush(); await flush();
    expect(document.querySelector('nav button[aria-label="Catalog (5)"]')).not.toBeNull();
  });
});

describe('admin vendor view', () => {
  it('keeps the restaurant commission, and null means it inherits the default', () => {
    expect(normalizeVendor({ id: 'v1', name: 'A', commissionType: 'PERCENT', commissionValue: 12 })).toMatchObject({ commissionType: 'PERCENT', commissionValue: 12 });
    expect(normalizeVendor({ id: 'v1', name: 'A', commissionType: null, commissionValue: null })).toMatchObject({ commissionType: null, commissionValue: null });
    expect(normalizeVendor({ id: 'v1', name: 'A', commissionType: 'FLAT', commissionValue: 4.5 })).toMatchObject({ commissionType: 'FLAT', commissionValue: 4.5 });
  });
  it('a response without the fields (non-admin view) leaves them unknown, not "default"', () => {
    expect(normalizeVendor({ id: 'v1', name: 'A' }).commissionType).toBeUndefined();
  });
});
