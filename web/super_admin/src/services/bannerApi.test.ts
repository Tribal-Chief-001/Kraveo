// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiService, clearAuthToken, setAuthToken } from './api';
import { copyAnswer, createAnswer, deleteAnswer, errorAnswer, patchAnswer, rawBanner, rawBannerList, rawCopy, rawCreated, rawSecond, reorderAnswer, uploadPromoOk } from '../test/bannerFixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAuthToken(); localStorage.clear(); });

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (body: unknown, status = 200) => {
  setAuthToken('tokentokentoken');
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const call = (f: ReturnType<typeof stub>) => ({ url: String(f.mock.calls[0][0]), init: f.mock.calls[0][1] as RequestInit });
const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
const headers = (init: RequestInit) => init.headers as Record<string, string>;

describe('banner endpoints (Docs/25 section 7.2, real shapes)', () => {
  it('GET /api/admin/banners parses every row; the token is a header, never in the URL', async () => {
    const f = stub(rawBannerList());
    const rows = await apiService.fetchBanners();
    expect(path(call(f).url)).toBe('/api/admin/banners');
    expect(call(f).url).not.toContain('tokentoken');
    expect(headers(call(f).init).Authorization).toBe('Bearer tokentokentoken');
    expect(rows.map((b) => [b.title, b.status, b.ctr])).toEqual([['One', 'SCHEDULED', 12.5], ['Second', 'LIVE', null]]);
  });

  it('an empty list is fine; an answer that is not a list is a plain error, not a crash', async () => {
    stub({ success: true, count: 0, data: [] });
    expect(await apiService.fetchBanners()).toEqual([]);
    stub({ success: true });
    await expect(apiService.fetchBanners()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('POST /api/admin/banners sends the body and returns the new banner', async () => {
    const f = stub(createAnswer(rawCreated()));
    const created = await apiService.createBanner({ title: 'Diwali Dhamaka', imageUrl: 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg', theme: 'DARK', isActive: true });
    expect(path(call(f).url)).toBe('/api/admin/banners');
    expect(call(f).init.method).toBe('POST');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ title: 'Diwali Dhamaka', imageUrl: 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg', theme: 'DARK', isActive: true });
    expect(created).toMatchObject({ id: '33341894-b6d3-4f67-91fa-a908eca24823', title: 'Diwali Dhamaka', status: 'LIVE', ctr: null, viewCount: 0 });
  });

  it('PATCH sends only the changes; null clears; changed:false is passed on', async () => {
    const f = stub(patchAnswer(rawBanner({ title: 'Renamed' })));
    const out = await apiService.updateBanner('dd002330-7627-4565-8199-a55a758f1411', { title: 'Renamed', endsAt: null });
    expect(path(call(f).url)).toBe('/api/admin/banners/dd002330-7627-4565-8199-a55a758f1411');
    expect(call(f).init.method).toBe('PATCH');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ title: 'Renamed', endsAt: null });
    expect(out).toMatchObject({ changed: true, message: 'Banner saved.', banner: { title: 'Renamed' } });
    stub(patchAnswer(rawBanner(), false));
    expect(await apiService.updateBanner('x', { title: 'One' })).toMatchObject({ changed: false, message: 'Nothing to change.' });
  });

  it('the id in the path is encoded', async () => {
    const f = stub(patchAnswer(rawBanner()));
    await apiService.updateBanner('a/b?c', { isActive: false });
    expect(path(call(f).url)).toBe('/api/admin/banners/a%2Fb%3Fc');
  });

  it('POST /reorder sends {ids} and returns the full list in the new order', async () => {
    const f = stub(reorderAnswer([rawSecond({ sortOrder: 10 }), rawBanner({ sortOrder: 20 })]));
    const rows = await apiService.reorderBanners(['3a6fef14-70ff-47de-b0c2-1d328e4b597e', 'dd002330-7627-4565-8199-a55a758f1411']);
    expect(path(call(f).url)).toBe('/api/admin/banners/reorder');
    expect(call(f).init.method).toBe('POST');
    expect(JSON.parse(call(f).init.body as string)).toEqual({ ids: ['3a6fef14-70ff-47de-b0c2-1d328e4b597e', 'dd002330-7627-4565-8199-a55a758f1411'] });
    expect(rows.map((b) => b.title)).toEqual(['Second', 'One']);
  });

  it('POST /:id/duplicate returns the switched-off copy', async () => {
    const f = stub(copyAnswer(rawCopy()), 201);
    const copy = await apiService.duplicateBanner('dd002330-7627-4565-8199-a55a758f1411');
    expect(path(call(f).url)).toBe('/api/admin/banners/dd002330-7627-4565-8199-a55a758f1411/duplicate');
    expect(call(f).init.method).toBe('POST');
    expect(copy).toMatchObject({ title: 'Launch (copy)', isActive: false, status: 'OFF', viewCount: 0, clickCount: 0, ctr: null });
  });

  it('DELETE works for a fresh delete and for an already deleted banner (deleted:false)', async () => {
    const f = stub(deleteAnswer('ad014502-4efe-4931-8e69-a4cce3fb969f'));
    await expect(apiService.deleteBanner('ad014502-4efe-4931-8e69-a4cce3fb969f')).resolves.toBeUndefined();
    expect(call(f).init.method).toBe('DELETE');
    expect(path(call(f).url)).toBe('/api/admin/banners/ad014502-4efe-4931-8e69-a4cce3fb969f');
    stub(deleteAnswer('ad014502-4efe-4931-8e69-a4cce3fb969f', false));
    await expect(apiService.deleteBanner('ad014502-4efe-4931-8e69-a4cce3fb969f')).resolves.toBeUndefined();
  });

  it('upload with purpose=promo posts the raw bytes and returns the address', async () => {
    const f = stub(uploadPromoOk);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const out = await apiService.uploadImage(blob, 'promo');
    expect(path(call(f).url)).toBe('/api/admin/uploads/image?purpose=promo');
    expect(call(f).init.body).toBe(blob);
    expect(headers(call(f).init)['Content-Type']).toBe('image/webp');
    expect(out).toEqual({ url: 'https://api.kraveo.site/uploads/promo/2026/e04403271c142510261d74e738ff1852.png', width: 1200, height: 600, bytes: 68 });
  });
});

describe('banner errors keep code, field and the server wording (Docs/25 7.3)', () => {
  it.each([
    ['BANNER_LINK_INVALID', 400, 'linkUrl', 'The link must start with https:// (http, javascript:, data:, intent:, market:, mailto:, tel:, file: and app links are not allowed).'],
    ['BANNER_IMAGE_INVALID', 400, 'imageUrl', 'The image address must start with https://'],
    ['BANNER_SCHEDULE_INVALID', 400, 'endsAt', 'The end must be after the start.'],
    ['BANNER_SCHEDULE_INVALID', 400, 'endsAt', 'This end time has already passed. Choose a later end time (or clear it), or keep the banner switched off.'],
    ['BAD_REQUEST', 400, 'title', 'The title must be 2 to 60 characters.'],
    ['BANNER_LIMIT', 409, undefined, 'There are already 30 banners. Delete one you no longer need first.'],
    ['BANNER_UNKNOWN', 400, 'ids', 'One of the banners no longer exists.'],
    ['NOT_FOUND', 404, undefined, 'Banner not found (it may have been deleted).'],
    ['RATE_LIMITED', 429, undefined, 'Too many requests. Try again later.'],
  ])('%s (%s, field %s)', async (code, status, field, message) => {
    stub(errorAnswer(code, message, field), status);
    const failure = await apiService.createBanner({ title: 'x' }).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status, code, message, field });
  });

  it('401 and 403 are plain ApiErrors the panel hands to the session handler', async () => {
    stub({ success: false, message: 'Admin access required.' }, 403);
    await expect(apiService.fetchBanners()).rejects.toMatchObject({ status: 403 });
    stub({}, 401);
    await expect(apiService.fetchBanners()).rejects.toMatchObject({ status: 401 });
  });

  it('a network failure is a plain message', async () => {
    setAuthToken('tokentokentoken');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(apiService.fetchBanners()).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
