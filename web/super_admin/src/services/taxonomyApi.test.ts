// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ImportInvalidError, apiService, clearAuthToken, setAuthToken } from './api';
import { normalizeVendor } from '../types';
import {
  bulkMixed, errorBody, importApplied, importDryRun, importInvalid, mergeDryRun, profileSaved, rawCategory, rawCategoryList, rawNorthIndian, rawUnused, rawVendor, uploadOk,
} from '../test/taxonomyFixtures';

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
const headers = (init: RequestInit) => init.headers as Record<string, string>;

describe('category endpoints (Docs/23 3.2)', () => {
  it('GET /api/admin/categories: all or only the active ones; the token is a header, never in the URL', async () => {
    const f = stub(rawCategoryList());
    const list = await apiService.fetchCategories({ includeInactive: true });
    expect(path(call(f).url)).toBe('/api/admin/categories?includeInactive=1');
    expect(call(f).url).not.toContain('tokentoken');
    expect(headers(call(f).init).Authorization).toBe('Bearer tokentokentoken');
    expect(list.map((c) => c.name)).toEqual(['Biryani', 'North Indian', 'Rolls & Wraps']);
    const g = stub(rawCategoryList());
    await apiService.fetchCategories();
    expect(path(call(g).url)).toBe('/api/admin/categories');
  });

  it('a list answer that is not a list is a plain UNEXPECTED_RESPONSE error', async () => {
    stub({ success: true, data: 'nope' });
    await expect(apiService.fetchCategories()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('POST create sends the body and returns the new category (201)', async () => {
    const f = stub({ success: true, message: 'Category created.', data: rawUnused() }, 201);
    const created = await apiService.createCategory({ name: 'Rolls & Wraps', icon: 'roll', forRestaurants: true, forDishes: true, showOnHome: false });
    expect(call(f).init.method).toBe('POST');
    expect(path(call(f).url)).toBe('/api/admin/categories');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ name: 'Rolls & Wraps', icon: 'roll', forRestaurants: true, forDishes: true, showOnHome: false });
    expect(created).toMatchObject({ id: '3f19f8c2-09bc-414c-962d-183fc2237e9a', name: 'Rolls & Wraps', inUse: false });
  });

  it('create onto an existing name: 409 CATEGORY_EXISTS keeps the existing category in extra', async () => {
    stub(errorBody('CATEGORY_EXISTS', 'There is already a category called "North Indian".', { field: 'name', existing: rawNorthIndian() }), 409);
    const error = await apiService.createCategory({ name: 'north indian' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'CATEGORY_EXISTS', field: 'name', message: 'There is already a category called "North Indian".' });
    expect(error.extra.existing.id).toBe('02236158-229f-48fc-9fe8-4b1220e74ed7');
  });

  it('PATCH sends only the given keys and reports changed / the server message', async () => {
    const f = stub({ success: true, changed: false, message: 'Nothing to change.', data: rawUnused() });
    const out = await apiService.updateCategory('3f19/f8', { isActive: false });
    expect(path(call(f).url)).toBe('/api/admin/categories/3f19%2Ff8');
    expect(call(f).init.method).toBe('PATCH');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ isActive: false });
    expect(out).toMatchObject({ changed: false, message: 'Nothing to change.' });
    expect(out.category.name).toBe('Rolls & Wraps');
  });

  it('PATCH flag off while in use: 409 CATEGORY_IN_USE with field and the count', async () => {
    stub(errorBody('CATEGORY_IN_USE', '1 dish uses this category, so it cannot stop being a dish category. Merge it into another one first.', { field: 'forDishes', dishes: 1 }), 409);
    await expect(apiService.updateCategory('x', { forDishes: false })).rejects.toMatchObject({ code: 'CATEGORY_IN_USE', field: 'forDishes', extra: { dishes: 1 } });
  });

  it('POST reorder sends the ids and returns the whole list in the new order', async () => {
    const f = stub({ success: true, changed: true, message: 'Order saved.', data: [rawUnused({ sortOrder: 1 }), rawCategory({ sortOrder: 2 })] });
    const list = await apiService.reorderCategories(['3f19f8c2-09bc-414c-962d-183fc2237e9a', '72077a2d-9b97-48de-9956-8d0167228f34']);
    expect(path(call(f).url)).toBe('/api/admin/categories/reorder');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ ids: ['3f19f8c2-09bc-414c-962d-183fc2237e9a', '72077a2d-9b97-48de-9956-8d0167228f34'] });
    expect(list.map((c) => c.sortOrder)).toEqual([1, 2]);
  });

  it('reorder with an unknown id: 400 CATEGORY_UNKNOWN', async () => {
    stub(errorBody('CATEGORY_UNKNOWN', 'One of the categories no longer exists.', { field: 'ids' }), 400);
    await expect(apiService.reorderCategories(['gone'])).rejects.toMatchObject({ status: 400, code: 'CATEGORY_UNKNOWN', field: 'ids' });
  });

  it('merge always sends dryRun explicitly; the dry run answer has the counts', async () => {
    const f = stub(mergeDryRun);
    const preview = await apiService.mergeCategory('02236158-229f-48fc-9fe8-4b1220e74ed7', '72077a2d-9b97-48de-9956-8d0167228f34', true);
    expect(path(call(f).url)).toBe('/api/admin/categories/02236158-229f-48fc-9fe8-4b1220e74ed7/merge');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ intoId: '72077a2d-9b97-48de-9956-8d0167228f34', dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, dishes: 0, restaurants: 1 });
    const g = stub({ success: true, message: 'Merged.', data: { dryRun: false, from: { id: 'a', name: 'A' }, into: { id: 'b', name: 'B' }, dishes: 3, restaurants: 0, category: rawCategory({ id: 'b', name: 'B' }) } });
    const done = await apiService.mergeCategory('a', 'b', false);
    expect(JSON.parse(call(g).init.body as string)).toEqual({ intoId: 'b', dryRun: false });
    expect(done).toMatchObject({ dryRun: false, dishes: 3 });
  });

  it('merge onto a hidden category: 409 CATEGORY_INACTIVE', async () => {
    stub(errorBody('CATEGORY_INACTIVE', 'The category you merge into is hidden. Show it first.', { field: 'intoId' }), 409);
    await expect(apiService.mergeCategory('a', 'b', false)).rejects.toMatchObject({ code: 'CATEGORY_INACTIVE', field: 'intoId' });
  });

  it('DELETE uses the id in the path; in use is 409 with the counts', async () => {
    const f = stub({ success: true, message: 'Category deleted.', data: { id: '3f19f8c2', name: 'Rolls & Wraps' } });
    await apiService.deleteCategory('3f19f8c2');
    expect(call(f).init.method).toBe('DELETE');
    expect(path(call(f).url)).toBe('/api/admin/categories/3f19f8c2');
    stub(errorBody('CATEGORY_IN_USE', 'This category is used by 1 restaurant and 1 dish. Hide it, or merge it into another category.', { restaurants: 1, dishes: 1 }), 409);
    await expect(apiService.deleteCategory('x')).rejects.toMatchObject({ code: 'CATEGORY_IN_USE', extra: { restaurants: 1, dishes: 1 } });
  });

  it('401 and 403 keep their status so the app can log out', async () => {
    stub({ success: false, message: 'Not allowed.' }, 403);
    await expect(apiService.fetchCategories()).rejects.toMatchObject({ status: 403 });
  });
});

describe('edit restaurant (Docs/23 3.3)', () => {
  it('PATCH /api/admin/vendors/:id/profile sends only the changed keys and returns the fresh vendor', async () => {
    const f = stub(profileSaved());
    const out = await apiService.updateVendorProfile('sh-ven-1', { name: 'Shape Kitchen & Co', cuisineIds: ['02236158-229f-48fc-9fe8-4b1220e74ed7', '72077a2d-9b97-48de-9956-8d0167228f34'], bannerImage: null });
    expect(path(call(f).url)).toBe('/api/admin/vendors/sh-ven-1/profile');
    expect(call(f).init.method).toBe('PATCH');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ name: 'Shape Kitchen & Co', cuisineIds: ['02236158-229f-48fc-9fe8-4b1220e74ed7', '72077a2d-9b97-48de-9956-8d0167228f34'], bannerImage: null });
    expect(out.changed).toBe(true);
    expect(out.message).toBe('Restaurant saved.');
    expect(out.vendor).toMatchObject({ id: 'sh-ven-1', name: 'Shape Kitchen & Co', category: 'North Indian • Biryani', eta: '15-20 min', fssaiNumber: '12345678901234', address: 'Ashta road, near gate 4' });
    expect(out.vendor.cuisines).toEqual([{ id: '02236158-229f-48fc-9fe8-4b1220e74ed7', name: 'North Indian', icon: 'restaurant' }, { id: '72077a2d-9b97-48de-9956-8d0167228f34', name: 'Biryani', icon: 'biryani' }]);
  });

  it('the same body again is a success with changed:false', async () => {
    stub({ success: true, changed: false, message: 'Nothing to change.', data: rawVendor() });
    const out = await apiService.updateVendorProfile('sh-ven-1', { eta: '15-20 min' });
    expect(out).toMatchObject({ changed: false, message: 'Nothing to change.' });
  });

  it.each([
    ['NAME_TAKEN', 409, 'Another restaurant already uses this name.', 'name'],
    ['TOO_MANY_CATEGORIES', 400, 'A restaurant can have at most 6 categories.', 'cuisineIds'],
    ['CATEGORY_NOT_AVAILABLE', 400, 'This category cannot be used for restaurants.', 'cuisineIds'],
    ['BAD_REQUEST', 400, 'The FSSAI number has 14 digits.', 'fssaiNumber'],
  ])('%s keeps the code, field and message for the form', async (code, status, message, field) => {
    stub(errorBody(code, message, { field }), status);
    await expect(apiService.updateVendorProfile('v', { name: 'x' })).rejects.toMatchObject({ status, code, field, message });
  });

  it('an answer without a vendor is a plain error, not a crash', async () => {
    stub({ success: true });
    await expect(apiService.updateVendorProfile('v', { name: 'x' })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('normalizeVendor reads the new fields and stays quiet when an older server sends none', () => {
    const v = normalizeVendor(rawVendor({ fssaiNumber: null }));
    expect(v.fssaiNumber).toBeNull();
    expect(v.bannerImage).toContain('unsplash');
    const old = normalizeVendor({ id: 'v1', name: 'Old', category: 'Cafe', rating: 4, isAcceptingOrders: true, address: 'x' });
    expect('cuisines' in old).toBe(false);
    expect('eta' in old).toBe(false);
    expect('bannerImage' in old).toBe(false);
    expect(normalizeVendor({ id: 'v2', cuisines: [{ id: 'c1' }, null, { name: 'no id' }] }).cuisines).toEqual([{ id: 'c1', name: 'Category', icon: 'restaurant' }]);
  });

  it('createPartner passes cuisineIds through', async () => {
    const f = stub({ success: true, profileId: 'p1' });
    await apiService.createPartner({ role: 'VENDOR', name: 'Owner', phone: '9876543210', password: 'abcdefgh', restaurantName: 'Dhaba', address: 'Gate 4', cuisineIds: ['a', 'b'] });
    expect(JSON.parse(call(f).init.body as string)).toMatchObject({ cuisineIds: ['a', 'b'], restaurantName: 'Dhaba' });
  });
});

describe('image upload (Docs/23 3.6)', () => {
  it('POSTs the raw bytes with the picture content type; purpose in the query; token only in the header', async () => {
    const f = stub(uploadOk);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const out = await apiService.uploadImage(blob, 'banner');
    expect(path(call(f).url)).toBe('/api/admin/uploads/image?purpose=banner');
    expect(call(f).url).not.toContain('tokentoken');
    expect(call(f).init.method).toBe('POST');
    expect(call(f).init.body).toBe(blob);
    expect(headers(call(f).init)['Content-Type']).toBe('image/webp');
    expect(headers(call(f).init).Authorization).toBe('Bearer tokentokentoken');
    expect(out).toEqual({ url: 'https://api.kraveo.site/uploads/banner/2026/bcff31b889235190508d11aaf6161e67.png', width: 800, height: 450, bytes: 68 });
  });

  it.each([
    ['IMAGE_TOO_SMALL', 400, 'The photo is too small (100x100). The shorter side must be at least 200 pixels.'],
    ['UNSUPPORTED_IMAGE_TYPE', 415, 'Only JPEG, PNG or WebP photos can be uploaded.'],
    ['RATE_LIMITED', 429, 'Too many uploads. Try again later.'],
    ['UPLOAD_UNAVAILABLE', 503, 'Image storage is not available right now. Try again, or paste a link instead.'],
  ])('%s is shown with the server wording', async (code, status, message) => {
    stub(errorBody(code, message), status);
    await expect(apiService.uploadImage(new Blob(['x'], { type: 'image/png' }), 'dish')).rejects.toMatchObject({ status, code, message });
  });

  it('an answer without a usable link is a plain error', async () => {
    stub({ success: true, data: { url: '' } });
    await expect(apiService.uploadImage(new Blob(['x'], { type: 'image/png' }), 'dish')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});

describe('bulk dish actions and menu import (Docs/23 3.5)', () => {
  it('POST /api/admin/catalog/bulk with ids, action and (for SET_CATEGORY) the category', async () => {
    const f = stub(bulkMixed);
    const out = await apiService.bulkCatalog(['a', 'b'], 'SET_CATEGORY', { categoryId: 'c1' });
    expect(path(call(f).url)).toBe('/api/admin/catalog/bulk');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ ids: ['a', 'b'], action: 'SET_CATEGORY', categoryId: 'c1' });
    expect(out).toMatchObject({ ok: 2, failed: 2 });
    const g = stub(bulkMixed);
    await apiService.bulkCatalog(['a'], 'DELETE');
    expect(JSON.parse(call(g).init.body as string)).toEqual({ ids: ['a'], action: 'DELETE' });
  });

  it('bulk request errors are ordinary ApiErrors with the field', async () => {
    stub(errorBody('BAD_REQUEST', 'Choose at least one dish.', { field: 'ids' }), 400);
    await expect(apiService.bulkCatalog([], 'DELETE')).rejects.toMatchObject({ status: 400, field: 'ids', message: 'Choose at least one dish.' });
    stub(errorBody('CATEGORY_UNKNOWN', 'Pick a category from the list.', { field: 'category', suggestions: ['Biryani'] }), 400);
    await expect(apiService.bulkCatalog(['a'], 'SET_CATEGORY', { category: 'Biriyani' })).rejects.toMatchObject({ code: 'CATEGORY_UNKNOWN', extra: { suggestions: ['Biryani'] } });
  });

  it('menu import: dry run and apply send dryRun and onDuplicate explicitly', async () => {
    const f = stub(importDryRun);
    const rows = [{ name: 'Paneer Tikka', category: 'Starters', vendorPrice: 120 }];
    const report = await apiService.importMenu('sh-ven-1', rows, { dryRun: true, onDuplicate: 'SKIP' });
    expect(path(call(f).url)).toBe('/api/admin/vendors/sh-ven-1/menu-import');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ rows, dryRun: true, onDuplicate: 'SKIP' });
    expect(report.summary).toEqual({ create: 2, update: 0, skip: 1, invalid: 2, total: 5 });
    const g = stub(importApplied);
    const applied = await apiService.importMenu('sh-ven-1', rows, { dryRun: false, onDuplicate: 'UPDATE' });
    expect(JSON.parse(call(g).init.body as string)).toMatchObject({ dryRun: false, onDuplicate: 'UPDATE' });
    expect(applied.applied).toBe(true);
  });

  it('applying a file with invalid rows throws ImportInvalidError carrying the report', async () => {
    stub(importInvalid, 400);
    const error = await apiService.importMenu('v', [], { dryRun: false, onDuplicate: 'SKIP' }).catch((e) => e);
    expect(error).toBeInstanceOf(ImportInvalidError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.report.summary.invalid).toBe(2);
    expect(error.message).toBe('2 rows are not valid. Nothing was imported. Fix them and try again.');
  });

  it('too many rows / payload too large / rate limited are ordinary errors', async () => {
    stub(errorBody('TOO_MANY_ROWS', 'Import at most 200 dishes at a time.', { field: 'rows' }), 400);
    await expect(apiService.importMenu('v', [], { dryRun: true, onDuplicate: 'SKIP' })).rejects.toMatchObject({ code: 'TOO_MANY_ROWS' });
    stub(errorBody('PAYLOAD_TOO_LARGE', 'That file is too big.'), 413);
    await expect(apiService.importMenu('v', [], { dryRun: true, onDuplicate: 'SKIP' })).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('a dry run answer without a report is a plain error', async () => {
    stub({ success: true });
    await expect(apiService.importMenu('v', [], { dryRun: true, onDuplicate: 'SKIP' })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});
