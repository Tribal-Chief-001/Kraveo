// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiService, clearAuthToken, setAuthToken } from './api';
import { changePendingRaw, pendingRaw, rawDish, rawList, rawPreview, settingView } from '../test/fixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAuthToken(); localStorage.clear(); });

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (body: unknown, status = 200) => {
  setAuthToken('tokentokentoken');
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const call = (fetchMock: ReturnType<typeof stub>) => ({ url: String(fetchMock.mock.calls[0][0]), init: fetchMock.mock.calls[0][1] as RequestInit });
const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

describe('catalog endpoints (Docs/21 section 4)', () => {
  it('GET /api/admin/catalog with status, vendorId, q and page; empty filters are left out', async () => {
    const f = stub(rawList([], { page: 2 }));
    await apiService.fetchCatalog({ status: 'LIVE', vendorId: 'v 1', q: ' roll ', page: 2 });
    expect(path(call(f).url)).toBe('/api/admin/catalog?status=LIVE&vendorId=v+1&q=roll&page=2');
    expect((call(f).init.headers as Record<string, string>).Authorization).toBe('Bearer tokentokentoken');
    const g = stub(rawList([]));
    await apiService.fetchCatalog({});
    expect(path(call(g).url)).toBe('/api/admin/catalog?page=1');
  });

  it('an answer that is not a dish list is a plain error, not a crash', async () => {
    stub({ success: true });
    await expect(apiService.fetchCatalog({})).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('GET pending-count: data { pending, changePending, total }', async () => {
    const f = stub({ success: true, data: { pending: 3, changePending: 1, total: 4 } });
    expect(await apiService.fetchCatalogPendingCounts()).toEqual({ pending: 3, changePending: 1, total: 4 });
    expect(path(call(f).url)).toBe('/api/admin/catalog/pending-count');
    stub({ nope: true });
    await expect(apiService.fetchCatalogPendingCounts()).rejects.toBeInstanceOf(ApiError);
  });

  it('approve / reject / patch / delete / restore / create use the contract paths and bodies', async () => {
    let f = stub({ success: true, changed: true, data: rawDish(), preview: rawPreview(100) });
    await apiService.approveCatalogItem('d/1', { applyPending: true, commissionType: 'FLAT', commissionValue: 5 });
    expect(path(call(f).url)).toBe('/api/admin/catalog/d%2F1/approve');
    expect(call(f).init.method).toBe('POST');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ applyPending: true, commissionType: 'FLAT', commissionValue: 5 });

    f = stub({ success: true, changed: true, message: 'Dish rejected.', data: pendingRaw({ status: 'REJECTED', approvalStatus: 'REJECTED', rejectionReason: 'No photo' }) });
    const rejected = await apiService.rejectCatalogItem('d1', 'No photo');
    expect(rejected).toMatchObject({ state: 'REJECTED', rejectionReason: 'No photo' });
    expect(path(call(f).url)).toBe('/api/admin/catalog/d1/reject');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ reason: 'No photo' });

    f = stub({ success: true });
    await apiService.updateCatalogItem('d1', { commissionType: null, commissionValue: null });
    expect(call(f).init.method).toBe('PATCH');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ commissionType: null, commissionValue: null });

    f = stub({ success: true });
    await apiService.deleteCatalogItem('d1');
    expect(call(f).init.method).toBe('DELETE');
    expect(path(call(f).url)).toBe('/api/admin/catalog/d1');

    f = stub({ success: true });
    await apiService.restoreCatalogItem('d1');
    expect(path(call(f).url)).toBe('/api/admin/catalog/d1/restore');

    f = stub({ success: true, message: 'Dish created and live.', data: rawDish({ id: 'new1', name: 'Chai', vendorPrice: 10, price: 11 }) });
    const created = await apiService.createCatalogItem({ vendorId: 'v1', name: 'Chai', vendorPrice: 10 });
    expect(path(call(f).url)).toBe('/api/admin/catalog');
    expect(call(f).init.method).toBe('POST');
    expect(created?.id).toBe('new1');
  });

  it('preview posts the numbers and returns price + commission', async () => {
    const f = stub({ success: true, data: rawPreview(100) });
    const result = await apiService.previewCatalogPrice({ vendorId: 'v1', vendorPrice: 100, commissionType: 'PERCENT', commissionValue: 12 });
    expect(path(call(f).url)).toBe('/api/admin/catalog/preview');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ vendorId: 'v1', vendorPrice: 100, commissionType: 'PERCENT', commissionValue: 12 });
    expect(result).toEqual({ price: 112, commission: 12, nominalCommission: 12, roundingStep: 1, rule: { type: 'PERCENT', value: 12, source: 'GLOBAL' } });
    stub({ data: {} });
    await expect(apiService.previewCatalogPrice({ vendorId: 'v1', vendorPrice: 100 })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('a cancelled preview request rejects with ABORTED and sends no stale answer', async () => {
    setAuthToken('tokentokentoken');
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => { init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); })));
    const controller = new AbortController();
    const pending = apiService.previewCatalogPrice({ vendorId: 'v1', vendorPrice: 100 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('recalculate always sends dryRun explicitly and reads the real answer', async () => {
    let f = stub({ success: true, message: '3 of 9 dishes would change.', data: { dryRun: true, applied: false, total: 9, changed: 3, changes: [], truncated: false } });
    expect(await apiService.recalculatePrices(true)).toMatchObject({ dryRun: true, changed: 3, total: 9, truncated: false });
    expect(path(call(f).url)).toBe('/api/admin/catalog/recalculate');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ dryRun: true });
    f = stub({ success: true, data: { dryRun: false, applied: true, total: 9, changed: 3, changes: [], truncated: false } });
    expect(await apiService.recalculatePrices(false)).toMatchObject({ applied: true });
    expect(JSON.parse(call(f).init.body as string)).toEqual({ dryRun: false });
  });

  it('settings: GET returns the group view; PUT sends the group object itself and reports recalculateRecommended', async () => {
    let f = stub({ success: true, data: settingView('rounding', { step: 5 }) });
    const view = await apiService.fetchSettings('rounding');
    expect(view).toMatchObject({ group: 'rounding', value: { step: 5 }, isDefault: false });
    expect(path(call(f).url)).toBe('/api/admin/settings/rounding');
    f = stub({ success: true, changed: true, message: 'Saved. Existing dish prices keep their old value until you run "Recalculate prices".', recalculateRecommended: true, data: settingView('rounding', { step: 1 }) });
    const saved = await apiService.saveSettings('rounding', { step: 1 });
    expect(call(f).init.method).toBe('PUT');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ step: 1 });
    expect(saved).toMatchObject({ value: { step: 1 }, changed: true, recalculateRecommended: true });
    stub({ success: true });
    expect((await apiService.saveSettings('rounding', { step: 2 })).value).toEqual({ step: 2 }); // a bare ack falls back to what was sent
    stub('nope');
    await expect(apiService.fetchSettings('fees')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('PATCH /api/admin/vendors/:id/commission {type, value}; null/null clears the override', async () => {
    let f = stub({ success: true, message: 'Saved. 2 dish prices are out of date: run "Recalculate prices".', data: { vendor: { id: 'v1', name: 'S', commissionType: 'PERCENT', commissionValue: 8 }, effective: { type: 'PERCENT', value: 8, source: 'VENDOR' }, dishCount: 5, staleDishes: 2 } });
    const r = await apiService.setVendorCommission('v1', { type: 'PERCENT', value: 8 });
    expect(r).toMatchObject({ commission: { type: 'PERCENT', value: 8 }, staleDishes: 2, dishCount: 5 });
    expect(r.message).toContain('out of date');
    expect(path(call(f).url)).toBe('/api/admin/vendors/v1/commission');
    expect(call(f).init.method).toBe('PATCH');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ type: 'PERCENT', value: 8 });
    f = stub({ success: true, message: 'Saved.', data: { vendor: { id: 'v1', name: 'S', commissionType: null, commissionValue: null }, effective: { type: 'PERCENT', value: 0, source: 'GLOBAL' }, dishCount: 5, staleDishes: 0 } });
    expect((await apiService.setVendorCommission('v1', { type: null, value: null })).commission).toEqual({ type: null, value: null });
    expect(JSON.parse(call(f).init.body as string)).toEqual({ type: null, value: null });
  });

  it('server errors keep their plain message and status', async () => {
    stub({ success: false, message: 'Price is too high.', code: 'VALIDATION' }, 400);
    await expect(apiService.updateCatalogItem('d1', { vendorPrice: 1 })).rejects.toMatchObject({ status: 400, message: 'Price is too high.', code: 'VALIDATION' });
  });
});
