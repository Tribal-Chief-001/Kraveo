// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ImportInvalidError, apiService, clearAuthToken, setAuthToken } from './api';
import { rawList } from '../test/fixtures';
import {
  CUT_DISH_CREATED, CUT_PREVIEW_MENU, CUT_SETTING_SAVED, CUT_VENDOR_SAVED, ERR_NEEDS_CUT, ERR_NOT_EXACT, ERR_ORDER_INVALID, ERR_PRICE_REQUIRED, IMPORT_DRY_CUT, IMPORT_INVALID_CUT, MENU_ORDER_SAVED,
} from '../test/cutFixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAuthToken(); localStorage.clear(); });

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (body: unknown, status = 200) => {
  setAuthToken('tokentokentoken');
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const call = (f: ReturnType<typeof stub>) => ({ url: String(f.mock.calls[0][0]).replace(/^https?:\/\/[^/]+/, ''), init: f.mock.calls[0][1] as RequestInit, body: JSON.parse(String((f.mock.calls[0][1] as RequestInit).body ?? 'null')) });

describe('Docs/26 endpoints', () => {
  it('preview with menuPrice sends menuPrice (no vendorPrice) and returns the restaurant share', async () => {
    const f = stub(CUT_PREVIEW_MENU);
    const p = await apiService.previewCatalogMenuPrice({ vendorId: 'cut-ven-1', menuPrice: 115, commissionType: 'CUT', commissionValue: 30 });
    expect(call(f)).toMatchObject({ url: '/api/admin/catalog/preview', body: { vendorId: 'cut-ven-1', menuPrice: 115, commissionType: 'CUT', commissionValue: 30 } });
    expect(call(f).init.method).toBe('POST');
    expect('vendorPrice' in call(f).body).toBe(false);
    expect(p).toMatchObject({ price: 115, vendorPrice: 80.5, commission: 34.5, rule: { type: 'CUT', value: 30, source: 'DISH' } });
  });

  it('preview of a menu price: a garbled answer is a plain error', async () => {
    stub({ success: true, data: {} });
    await expect(apiService.previewCatalogMenuPrice({ vendorId: 'v', menuPrice: 10 })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('create with menuPrice posts it and reads the CUT dish back', async () => {
    const f = stub(CUT_DISH_CREATED, 201);
    const dish = await apiService.createCatalogItem({ vendorId: 'cut-ven-1', name: 'Dish c55c391e', menuPrice: 115 });
    expect(call(f).body).toEqual({ vendorId: 'cut-ven-1', name: 'Dish c55c391e', menuPrice: 115 });
    expect(dish).toMatchObject({ price: 115, vendorPrice: 80.5, sortOrder: 10, commission: { type: 'CUT', value: 30 } });
  });

  it('edit with menuPrice is a PATCH with only that field', async () => {
    const f = stub({ ...CUT_DISH_CREATED, preview: {} });
    await apiService.updateCatalogItem('d1', { menuPrice: 200 });
    expect(call(f)).toMatchObject({ url: '/api/admin/catalog/d1', body: { menuPrice: 200 } });
    expect(call(f).init.method).toBe('PATCH');
  });

  it.each([ERR_PRICE_REQUIRED, ERR_NEEDS_CUT, ERR_NOT_EXACT])('the error $code keeps code, field and the whole body (nearestPrice)', async (body) => {
    stub(body, 400);
    const error = await apiService.createCatalogItem({ vendorId: 'v', name: 'n', menuPrice: 10 }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: body.code, field: 'menuPrice', message: body.message });
    expect(error.extra).toEqual(body);
  });

  it('the setting and the restaurant commission accept CUT', async () => {
    let f = stub(CUT_SETTING_SAVED);
    const saved = await apiService.saveSettings('commission', { type: 'CUT', value: 20 });
    expect(call(f)).toMatchObject({ url: '/api/admin/settings/commission', body: { type: 'CUT', value: 20 } });
    expect(saved).toMatchObject({ recalculateRecommended: true, value: { type: 'CUT', value: 20 } });
    f = stub(CUT_VENDOR_SAVED);
    const vendor = await apiService.setVendorCommission('cut-ven-1', { type: 'CUT', value: 30 });
    expect(call(f).body).toEqual({ type: 'CUT', value: 30 });
    expect(vendor.commission).toEqual({ type: 'CUT', value: 30 });
  });

  it('fetchCatalog can ask for a page size (capped at the server maximum of 100)', async () => {
    const f = stub(rawList([]));
    await apiService.fetchCatalog({ vendorId: 'v1', page: 2, pageSize: 100 });
    expect(call(f).url).toBe('/api/admin/catalog?vendorId=v1&page=2&pageSize=100');
    const g = stub(rawList([]));
    await apiService.fetchCatalog({ pageSize: 5000 });
    expect(call(g).url).toBe('/api/admin/catalog?page=1&pageSize=100');
  });

  it('import: rows may carry menuPrice and position; the report keeps vendorPrice and sortOrder', async () => {
    const f = stub(IMPORT_DRY_CUT);
    const report = await apiService.importMenu('cut-ven-1', [{ name: 'Imp A', category: 'Main', menuPrice: 115 }, { name: 'Imp D', category: 'Main', menuPrice: 250, position: 7 }], { dryRun: true, onDuplicate: 'SKIP' });
    expect(call(f).body).toEqual({ rows: [{ name: 'Imp A', category: 'Main', menuPrice: 115 }, { name: 'Imp D', category: 'Main', menuPrice: 250, position: 7 }], dryRun: true, onDuplicate: 'SKIP' });
    expect(report.rows.map((r) => [r.computedPrice, r.vendorPrice, r.sortOrder])).toEqual([[115, 80.5, 10], [100, 70, 20], [99, 69.3, 30], [250, 175, 70]]);
  });

  it('import apply with invalid rows throws ImportInvalidError carrying the codes', async () => {
    stub(IMPORT_INVALID_CUT, 400);
    const error = await apiService.importMenu('cut-ven-1', [], { dryRun: false, onDuplicate: 'SKIP' }).catch((e) => e);
    expect(error).toBeInstanceOf(ImportInvalidError);
    expect(error.report.rows[1].errors[0]).toMatchObject({ code: 'PRICE_REQUIRED', field: 'menuPrice' });
  });

  it('menu order: PUT /api/admin/vendors/:id/menu-order with sections and dishes', async () => {
    const f = stub(MENU_ORDER_SAVED);
    const body = { sections: ['Desserts', 'Snacks'], dishes: [{ id: 'dish-1', position: 1 }] };
    const out = await apiService.saveMenuOrder('cut/ven 1', body);
    expect(call(f)).toMatchObject({ url: '/api/admin/vendors/cut%2Fven%201/menu-order', body });
    expect(call(f).init.method).toBe('PUT');
    expect(out).toMatchObject({ changed: true, message: 'Menu order saved.' });
    expect(out.sections[0]).toEqual({ category: 'Desserts', dishCount: 1 });
  });

  it('menu order errors keep code and field; an answer without a list is a plain error', async () => {
    stub(ERR_ORDER_INVALID, 400);
    await expect(apiService.saveMenuOrder('v1', { sections: ['Biryani'], dishes: [] })).rejects.toMatchObject({ status: 400, code: 'MENU_ORDER_INVALID', field: 'sections[1]' });
    stub({ success: true });
    await expect(apiService.saveMenuOrder('v1', { sections: [], dishes: [] })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    stub({ success: false, code: 'RATE_LIMITED', message: 'Too many menu order changes. Try again in a few minutes.' }, 429);
    await expect(apiService.saveMenuOrder('v1', { sections: [], dishes: [] })).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });
});
