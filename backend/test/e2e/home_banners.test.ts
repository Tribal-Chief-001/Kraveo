/**
 * Home banners (Docs/25 sections 1-2): public list (live window with an injectable clock, cache, headers), events (atomic counters),
 * admin create / patch / delete / reorder / duplicate, link and text hygiene, schedule rules, caps, audit rows, rate limits, role checks,
 * upload purpose=promo and concurrency stress. Real PostgreSQL, real HTTP.
 * Set BANNER_SAMPLES_OUT=<file> to dump the real responses used by Docs/25 section 7.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { __resetUploadUsage } from '../../src/routes/uploads';
import {
  __setBannerClock, invalidatePublicBanners, MAX_BANNERS, flushBannerEvents, shutdownBannerEvents, recordBannerEvents, MAX_PENDING_VIEWS, MAX_PENDING_CLICKS,
} from '../../src/services/banners';
import { makePng } from '../harness/images';

jest.setTimeout(120_000);

const tAdmin = getAdminToken();
const tStudent = getStudentToken();
const tVendor = getVendorToken();
const tDriver = getDriverToken();
const H = (t: string) => getAuthHeader(t);
const NOW = new Date('2026-11-01T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const IMG = 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg';
const samples: Record<string, unknown> = {};

describe('Home banners', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let uploadDir: string;

  const post = (p: string, body: unknown = {}, t = tAdmin) => request.post(p).set(H(t)).send(body as any);
  const patch = (p: string, body: unknown = {}, t = tAdmin) => request.patch(p).set(H(t)).send(body as any);
  const del = (p: string, t = tAdmin) => request.delete(p).set(H(t));
  const valid = (extra: Record<string, unknown> = {}) => ({ title: 'Diwali Dhamaka', imageUrl: IMG, ...extra });
  const mk = async (extra: Record<string, unknown> = {}) => {
    const r = await post('/api/admin/banners', valid(extra));
    expect([extra, r.status, r.body.message]).toEqual([extra, 201, 'Banner created.']);
    return r.body.data as any;
  };
  const raw = (extra: Record<string, unknown> = {}) => prisma.homeBanner.create({ data: { title: 'Raw', imageUrl: IMG, ...extra } as any });
  const pub = async () => (await request.get('/api/banners')).body.data as any[];
  const adminList = async () => (await request.get('/api/admin/banners').set(H(tAdmin))).body.data as any[];
  const audits = (action: string, targetId?: string) => prisma.adminAuditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) } });
  const events = (body: unknown) => request.post('/api/banners/events').send(body as any);
  const counts = async (id: string) => { await flushBannerEvents(); return prisma.homeBanner.findUniqueOrThrow({ where: { id }, select: { viewCount: true, clickCount: true } }); };
  const keep = (name: string, body: unknown) => { samples[name] = body; };

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraveo-banners-test-'));
    process.env.UPLOAD_DIR = uploadDir;
    process.env.PUBLIC_BASE_URL = 'https://api.test.kraveo/';
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    for (const k of ['BANNERS_CACHE_TTL_MS', 'BANNERS_ENABLED', 'BANNER_LINK_HOSTS', 'BANNER_IMAGE_HOSTS', 'BANNER_EVENTS_FLUSH_MS']) delete process.env[k];
    await shutdownBannerEvents();
    __resetRateLimits();
    __resetUploadUsage();
    __setBannerClock(null);
    await prisma.homeBanner.deleteMany({});
    invalidatePublicBanners();
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ action: { startsWith: 'BANNER_' } }, { targetType: 'UPLOAD' }] } });
  });

  afterAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    for (const k of ['BANNERS_CACHE_TTL_MS', 'BANNERS_ENABLED', 'BANNER_LINK_HOSTS', 'BANNER_IMAGE_HOSTS', 'BANNER_EVENTS_FLUSH_MS']) delete process.env[k];
    await shutdownBannerEvents();
    delete process.env.UPLOAD_DIR;
    delete process.env.PUBLIC_BASE_URL;
    __setBannerClock(null);
    if (process.env.BANNER_SAMPLES_OUT) fs.writeFileSync(process.env.BANNER_SAMPLES_OUT, JSON.stringify(samples, null, 2));
    fs.rmSync(uploadDir, { recursive: true, force: true });
    await prisma.homeBanner.deleteMany({});
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ action: { startsWith: 'BANNER_' } }, { targetType: 'UPLOAD' }] } });
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('public list: GET /api/banners', () => {
    test('no login, cacheable 30 s, exact shape without counters or schedule, ordered by sortOrder then createdAt', async () => {
      __setBannerClock(() => NOW);
      const b = await mk({ title: 'Second' });
      const a = await mk({ title: 'First', subtitle: 'Sub', linkUrl: 'https://forms.gle/AbC123', ctaLabel: 'Join now', theme: 'LIGHT', startsAt: at(-60), endsAt: at(600) });
      await prisma.homeBanner.update({ where: { id: a.id }, data: { viewCount: 9, clickCount: 3 } });
      await prisma.homeBanner.update({ where: { id: a.id }, data: { sortOrder: 20 } });
      await prisma.homeBanner.update({ where: { id: b.id }, data: { sortOrder: 5 } });
      const r = await request.get('/api/banners');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('public, max-age=30');
      expect(Object.keys(r.body).sort()).toEqual(['data', 'success']);
      expect(r.body.data.map((x: any) => x.title)).toEqual(['Second', 'First']);
      expect(Object.keys(r.body.data[1]).sort()).toEqual(['ctaLabel', 'id', 'imageUrl', 'linkUrl', 'subtitle', 'theme', 'title']);
      expect(r.body.data[1]).toEqual({ id: a.id, title: 'First', subtitle: 'Sub', imageUrl: IMG, linkUrl: 'https://forms.gle/AbC123', ctaLabel: 'Join now', theme: 'LIGHT' });
      expect(r.body.data[0]).toMatchObject({ id: b.id, subtitle: null, linkUrl: null, ctaLabel: null, theme: 'DARK' });
      keep('public_list', r.body);
      // equal sortOrder -> older first
      await prisma.homeBanner.updateMany({ data: { sortOrder: 50 } });
      expect((await pub()).map((x) => x.title)).toEqual(['Second', 'First']);
    });

    test('only LIVE rows: switched off, not started, expired and other placements are hidden; boundaries use the clock (start inclusive, end exclusive)', async () => {
      __setBannerClock(() => NOW);
      await raw({ title: 'Live open', sortOrder: 10 });
      await raw({ title: 'Live window', sortOrder: 20, startsAt: new Date(at(-5)), endsAt: new Date(at(5)) });
      await raw({ title: 'Starts exactly now', sortOrder: 30, startsAt: NOW });
      await raw({ title: 'Off', sortOrder: 40, isActive: false });
      await raw({ title: 'Future', sortOrder: 50, startsAt: new Date(at(1)) });
      await raw({ title: 'Ends exactly now', sortOrder: 60, endsAt: NOW });
      await raw({ title: 'Expired', sortOrder: 70, endsAt: new Date(at(-1)) });
      await raw({ title: 'Other placement', sortOrder: 80, placement: 'CHECKOUT' });
      expect((await pub()).map((x) => x.title)).toEqual(['Live open', 'Live window', 'Starts exactly now']);
      __setBannerClock(() => new Date(at(2)));
      expect((await pub()).map((x) => x.title)).toEqual(['Live open', 'Live window', 'Starts exactly now', 'Future']);
      __setBannerClock(() => new Date(at(6)));
      expect((await pub()).map((x) => x.title)).toEqual(['Live open', 'Starts exactly now', 'Future']);
    });

    test('at most 10 are shown, in order', async () => {
      for (let i = 1; i <= 12; i += 1) await raw({ title: `B${String(i).padStart(2, '0')}`, sortOrder: i * 10 });
      const list = await pub();
      expect(list).toHaveLength(10);
      expect(list.map((x) => x.title)).toEqual(Array.from({ length: 10 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`));
    });

    test('empty list is a normal answer', async () => {
      const r = await request.get('/api/banners');
      expect([r.status, r.body]).toEqual([200, { success: true, data: [] }]);
    });

    test('the 30 s cache is really on, and every admin write drops it at once (create, patch, toggle, delete, reorder, duplicate)', async () => {
      process.env.BANNERS_CACHE_TTL_MS = '30000';
      invalidatePublicBanners();
      const a = await mk({ title: 'Cached A' });
      expect((await pub()).map((x) => x.title)).toEqual(['Cached A']);
      await prisma.homeBanner.update({ where: { id: a.id }, data: { title: 'Changed behind the cache' } });
      expect((await pub())[0].title).toBe('Cached A'); // proof that the cache serves
      // create
      const b = await mk({ title: 'Cached B' });
      expect((await pub()).map((x) => x.title)).toEqual(['Changed behind the cache', 'Cached B']);
      // patch
      await patch(`/api/admin/banners/${a.id}`, { title: 'Patched A' });
      expect((await pub()).map((x) => x.title)).toEqual(['Patched A', 'Cached B']);
      // toggle
      await patch(`/api/admin/banners/${b.id}`, { isActive: false });
      expect((await pub()).map((x) => x.title)).toEqual(['Patched A']);
      await patch(`/api/admin/banners/${b.id}`, { isActive: true });
      expect(await pub()).toHaveLength(2);
      // reorder
      await post('/api/admin/banners/reorder', { ids: [b.id, a.id] });
      expect((await pub()).map((x) => x.title)).toEqual(['Cached B', 'Patched A']);
      // duplicate (copy is OFF: list unchanged) then switch the copy on
      const copy = (await post(`/api/admin/banners/${a.id}/duplicate`)).body.data;
      expect(await pub()).toHaveLength(2);
      await patch(`/api/admin/banners/${copy.id}`, { isActive: true });
      expect(await pub()).toHaveLength(3);
      // delete
      await del(`/api/admin/banners/${copy.id}`);
      await del(`/api/admin/banners/${b.id}`);
      expect((await pub()).map((x) => x.title)).toEqual(['Patched A']);
    });

    test('a cached list still follows the clock (a banner ends on time while the cache is warm) and events do not drop the cache', async () => {
      process.env.BANNERS_CACHE_TTL_MS = '30000';
      __setBannerClock(() => NOW);
      const a = await mk({ title: 'Ends soon', endsAt: at(5) });
      expect(await pub()).toHaveLength(1);
      __setBannerClock(() => new Date(at(5)));
      expect(await pub()).toHaveLength(0);
      await events({ views: [a.id] });
      expect((await counts(a.id)).viewCount).toBe(1);
    });

    test('rate limited per IP', async () => {
      process.env.RL_BANNERS_PUBLIC_MAX = '3';
      const codes = [];
      for (let i = 0; i < 5; i += 1) codes.push((await request.get('/api/banners')).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    });
  });

  // =========================================================================================
  describe('events: POST /api/banners/events', () => {
    test('anonymous is fine, counts views and clicks, exact answer', async () => {
      const a = await mk();
      const r = await events({ views: [a.id], clicks: [a.id] });
      expect([r.status, r.body]).toEqual([200, { success: true }]);
      expect(await counts(a.id)).toEqual({ viewCount: 1, clickCount: 1 });
      keep('events_request', { views: [a.id], clicks: [a.id] });
      keep('events_response', r.body);
      const withToken = await request.post('/api/banners/events').set(H(tStudent)).send({ views: [a.id] });
      expect(withToken.status).toBe(200);
      expect((await counts(a.id)).viewCount).toBe(2);
    });

    test('50 parallel calls increment exactly 50 (atomic, no deadlock with opposite id orders), views and clicks', async () => {
      const a = await mk();
      const b = await mk({ title: 'Other' });
      const client = supertest(server.baseUrl);
      const out = await Promise.all(Array.from({ length: 50 }, (_, i) => client.post('/api/banners/events').send({ views: i % 2 ? [a.id, b.id] : [b.id, a.id], clicks: [a.id] })));  // opposite id orders on purpose
      expect(out.map((r) => r.status)).toEqual(Array(50).fill(200));
      expect(await counts(a.id)).toEqual({ viewCount: 50, clickCount: 50 });
      expect(await counts(b.id)).toEqual({ viewCount: 50, clickCount: 0 });
    });

    test('unknown, inactive and malformed ids are ignored silently; nothing ever errors', async () => {
      const a = await mk();
      const off = await mk({ title: 'Off one', isActive: false });
      const cases: unknown[] = [
        { views: ['nope', off.id, 'a b', '../x', 5, null, {}, [a.id]], clicks: 'x' }, {}, [], 'text', null, { views: 'x' }, { views: { 0: a.id } },
        { views: [a.id], extra: 'ignored', __proto__x: 1 },
      ];
      for (const body of cases) {
        const r = await events(body);
        expect([JSON.stringify(body), r.status, r.body]).toEqual([JSON.stringify(body), 200, { success: true }]);
      }
      expect(await counts(off.id)).toEqual({ viewCount: 0, clickCount: 0 });
      expect((await counts(a.id)).viewCount).toBe(1); // only the last case listed it validly
    });

    test('the same id twice in one call counts once; at most 10 views and 5 clicks per call', async () => {
      const a = await mk();
      await events({ views: [a.id, a.id, a.id], clicks: [a.id, a.id] });
      expect(await counts(a.id)).toEqual({ viewCount: 1, clickCount: 1 });
      const rows = [];
      for (let i = 0; i < 12; i += 1) rows.push(await raw({ title: `R${i}`, sortOrder: i }));
      await events({ views: rows.map((r) => r.id), clicks: rows.map((r) => r.id) });
      await flushBannerEvents();
      const after = await prisma.homeBanner.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { sortOrder: 'asc' } });
      expect(after.filter((r) => r.viewCount === 1)).toHaveLength(10);
      expect(after.filter((r) => r.clickCount === 1)).toHaveLength(5);
    });

    test('an oversize body (> 2 KB) is refused with 413 before it is read; the counters stay', async () => {
      const a = await mk();
      const big = JSON.stringify({ views: [a.id], pad: 'x'.repeat(3000) });
      const t0 = Date.now();
      const r = await request.post('/api/banners/events').set('Content-Type', 'application/json').send(big);
      expect([r.status, r.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(await counts(a.id)).toEqual({ viewCount: 0, clickCount: 0 });
      const ok = await request.post('/api/banners/events').set('Content-Type', 'application/json').send(JSON.stringify({ views: [a.id], pad: 'x'.repeat(1500) }));
      expect(ok.status).toBe(200);
    });

    test('malformed JSON is 400, a compressed body and a non-JSON body never count', async () => {
      const a = await mk();
      const bad = await request.post('/api/banners/events').set('Content-Type', 'application/json').send('{"views": [');
      expect(bad.status).toBe(400);
      const gz = await request.post('/api/banners/events').set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send(require('zlib').gzipSync(JSON.stringify({ views: [a.id] })));
      expect(gz.status).toBeGreaterThanOrEqual(400);
      expect(gz.status).toBeLessThan(500);
      const text = await request.post('/api/banners/events').set('Content-Type', 'text/plain').send(JSON.stringify({ views: [a.id] }));
      expect([text.status, text.body]).toEqual([200, { success: true }]);
      expect(await counts(a.id)).toEqual({ viewCount: 0, clickCount: 0 });
    });

    test('rate limited per IP (and the count includes refused-size calls)', async () => {
      process.env.RL_BANNER_EVENTS_MAX = '3';
      const codes = [];
      for (let i = 0; i < 5; i += 1) codes.push((await events({})).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    });

    test('the request never waits for the counter write: it answers while the database write hangs, and the counts land at the next flush', async () => {
      const a = await mk();
      await events({ views: [a.id] }); // warm start: the id check has run
      const spy = jest.spyOn(prisma, '$executeRaw').mockImplementation((() => new Promise(() => undefined)) as any); // a write that never finishes
      const r = await events({ views: [a.id], clicks: [a.id] });
      expect([r.status, r.body]).toEqual([200, { success: true }]);
      expect(spy).not.toHaveBeenCalled(); // nothing is written in the request path
      spy.mockRestore();
      expect(await counts(a.id)).toEqual({ viewCount: 2, clickCount: 1 });
    });

    test('a timer flushes by itself every BANNER_EVENTS_FLUSH_MS (approximate counters)', async () => {
      process.env.BANNER_EVENTS_FLUSH_MS = '100';
      await shutdownBannerEvents(); // drop a timer started earlier so the new interval is read
      const a = await mk();
      await events({ views: [a.id] });
      expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } })).viewCount).toBe(0);
      await new Promise((r) => setTimeout(r, 450));
      expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } })).viewCount).toBe(1);
    });

    test('shutdown flush writes the pending counts and stops the timer', async () => {
      const a = await mk();
      await events({ views: [a.id, a.id], clicks: [a.id] });
      await events({ views: [a.id] });
      expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } })).viewCount).toBe(0); // still in memory
      await shutdownBannerEvents();
      expect(await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ viewCount: 2, clickCount: 1 });
    });

    test('per-banner caps per flush interval: at most 2000 views and 500 clicks are accepted, the rest is dropped', async () => {
      const a = await mk();
      const bumpForTest = recordBannerEvents;
      for (let i = 0; i < 5; i += 1) await Promise.all(Array.from({ length: 450 }, () => bumpForTest({ views: [a.id], clicks: [a.id] })));
      const c = await counts(a.id);
      expect(c).toEqual({ viewCount: MAX_PENDING_VIEWS, clickCount: MAX_PENDING_CLICKS });
      await bumpForTest({ views: [a.id], clicks: [a.id] }); // a new interval starts after the flush
      expect(await counts(a.id)).toEqual({ viewCount: MAX_PENDING_VIEWS + 1, clickCount: MAX_PENDING_CLICKS + 1 });
    });

    test('a failed flush keeps the counts and retries; it never throws, never crashes, and nothing is counted twice', async () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const a = await mk();
      const b = await mk({ title: 'Second banner' });
      await events({ views: [a.id, b.id], clicks: [a.id] });
      const spy = jest.spyOn(prisma, '$executeRaw').mockRejectedValue(new Error('db down'));
      await expect(flushBannerEvents()).resolves.toBeUndefined();
      await expect(flushBannerEvents()).resolves.toBeUndefined();
      expect(err).toHaveBeenCalled();
      spy.mockRestore();
      await events({ views: [a.id] }); // new counts arrive while the old ones wait
      expect(await counts(a.id)).toEqual({ viewCount: 2, clickCount: 1 });
      expect(await counts(b.id)).toEqual({ viewCount: 1, clickCount: 0 });
      await flushBannerEvents();
      expect(await counts(a.id)).toEqual({ viewCount: 2, clickCount: 1 });
    });

    test('a failure in the middle of a flush writes the banners before it once and keeps only the rest', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const a = await mk({ title: 'First banner' });
      const b = await mk({ title: 'Second banner' });
      const [lo, hi] = [a.id, b.id].sort();
      await events({ views: [a.id, b.id] });
      const real = prisma.$executeRaw.bind(prisma);
      let n = 0;
      jest.spyOn(prisma, '$executeRaw').mockImplementation(((...args: any[]) => (++n === 2 ? Promise.reject(new Error('boom')) : (real as any)(...args))) as any);
      await flushBannerEvents();
      jest.restoreAllMocks();
      expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: lo } })).viewCount).toBe(1);
      expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: hi } })).viewCount).toBe(0);
      await flushBannerEvents();
      expect([(await counts(lo)).viewCount, (await counts(hi)).viewCount]).toEqual([1, 1]);
    });
  });

  // =========================================================================================
  describe('links and images (security)', () => {
    const BAD_LINKS: unknown[] = [
      'http://example.com/', 'HTTP://example.com/', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
      'intent://scan/#Intent;scheme=zxing;package=com.google.zxing;end', 'market://details?id=com.kraveo.customer', 'mailto:a@b.com', 'tel:+911234567890',
      'file:///etc/passwd', 'ftp://example.com/x', 'myapp://open', 'blob:https://example.com/x', 'about:blank', 'vbscript:x', 'sms:+911234567890',
      'https://127.0.0.1/', 'https://10.0.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://[2001:db8::1]/', 'https://localhost/', 'https://localhost./',
      'https://app.localhost/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://0177.0.0.1/', 'https://127.1/', 'https://example/', 'https://example.com:8443/',
      'https://user:pass@example.com/', 'https://user@example.com/', 'https://:pass@example.com/', 'https://exa mple.com/', 'https://example.com/a b',
      'https://example.com/\nx', 'https://example.com/a\tb', 'https://example.com/a\u0000b', 'https://example.com/\u200b', 'https://example.com/\u202e', 'https://example.com/\\evil',
      'https:example.com', 'https:/example.com', 'https:\\\\example.com', '//example.com', 'example.com', 'www.example.com', 'https://', 'https://.com',
      'https://exa..mple.com', 'https://-bad.com', 'https://a.com/' + 'x'.repeat(500), 123, true, ['https://example.com/'], { url: 'https://example.com/' },
    ];

    test.each(BAD_LINKS.map((l) => [typeof l === 'string' ? l.slice(0, 60) : JSON.stringify(l), l]))('create refuses link %j', async (_n, link) => {
      const r = await post('/api/admin/banners', valid({ linkUrl: link }));
      expect([r.status, r.body.code, r.body.field, r.body.success]).toEqual([400, 'BANNER_LINK_INVALID', 'linkUrl', false]);
      expect(typeof r.body.message).toBe('string');
      expect(await prisma.homeBanner.count()).toBe(0);
    });

    test('patch refuses every bad link too and leaves the row alone', async () => {
      const a = await mk({ linkUrl: 'https://example.com/ok' });
      for (const l of BAD_LINKS) {
        const r = await patch(`/api/admin/banners/${a.id}`, { linkUrl: l });
        expect([String(l).slice(0, 40), r.status, r.body.code]).toEqual([String(l).slice(0, 40), 400, 'BANNER_LINK_INVALID']);
      }
      expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } })).linkUrl).toBe('https://example.com/ok');
    });

    test.each([
      ['https://play.google.com/store/apps/details?id=com.kraveo.customer', 'https://play.google.com/store/apps/details?id=com.kraveo.customer'],
      ['https://forms.gle/AbC123xyz', 'https://forms.gle/AbC123xyz'],
      ['https://docs.google.com/forms/d/e/1FAIpQLSx_y-z/viewform?usp=sf_link', 'https://docs.google.com/forms/d/e/1FAIpQLSx_y-z/viewform?usp=sf_link'],
      ['https://example.com', 'https://example.com/'],
      ['HTTPS://Example.COM/Path?A=1#frag', 'https://example.com/Path?A=1#frag'],
      ['  https://example.com/x  ', 'https://example.com/x'],
      ['https://example.com/y\n', 'https://example.com/y'], // outer white space is trimmed
      ['https://example.com:443/x', 'https://example.com/x'],
      ['https://münchen.de/ä', 'https://xn--mnchen-3ya.de/%C3%A4'],
      ['https://example.com/?q=नमस्ते', 'https://example.com/?q=%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87'],
      ['https://a.b.c.example.co.in/x', 'https://a.b.c.example.co.in/x'],
    ])('accepts and normalises %s', async (input, expected) => {
      const r = await post('/api/admin/banners', valid({ linkUrl: input }));
      expect([r.status, r.body.data?.linkUrl]).toEqual([201, expected]);
      const p = await patch(`/api/admin/banners/${r.body.data.id}`, { linkUrl: null });
      expect(p.body.data.linkUrl).toBeNull();
    });

    test('no link at all (absent, null, empty, blank) is a display-only banner', async () => {
      for (const link of [undefined, null, '', '   ']) {
        const r = await post('/api/admin/banners', valid(link === undefined ? {} : { linkUrl: link }));
        expect([r.status, r.body.data.linkUrl]).toEqual([201, null]);
      }
    });

    test('imageUrl: required, https only, same host rules (code BANNER_IMAGE_INVALID)', async () => {
      for (const img of [undefined, null, '', 'http://example.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://127.0.0.1/a.jpg', 'https://user:p@example.com/a.jpg', 5, 'https://example.com/' + 'a'.repeat(500)]) {
        const r = await post('/api/admin/banners', { title: 'No image', ...(img === undefined ? {} : { imageUrl: img }) });
        expect([String(img).slice(0, 30), r.status, r.body.code, r.body.field]).toEqual([String(img).slice(0, 30), 400, 'BANNER_IMAGE_INVALID', 'imageUrl']);
      }
      const ok = await post('/api/admin/banners', { title: 'Own upload', imageUrl: 'https://api.kraveo.site/uploads/promo/2026/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp' });
      expect(ok.status).toBe(201);
      const p = await patch(`/api/admin/banners/${ok.body.data.id}`, { imageUrl: 'http://example.com/a.jpg' });
      expect([p.status, p.body.code]).toEqual([400, 'BANNER_IMAGE_INVALID']);
    });
  });

  // =========================================================================================
  describe('text hygiene and strict bodies (XSS / injection)', () => {
    test('markup, control, bidi and zero-width characters are refused on every text field with a field name', async () => {
      const BAD = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'a > b', 'ab\u202ecd', 'ab\u2066cd', 'ab\u200bcd', '\ufeffabc', 'ab\u200ecd', 'ab\u0007cd', 'ab\u0000cd', 'ab\u2028cd', 'ab\u009fcd'];
      for (const field of ['title', 'subtitle', 'ctaLabel']) {
        for (const v of BAD) {
          const r = await post('/api/admin/banners', valid({ [field]: v }));
          expect([field, JSON.stringify(v), r.status, r.body.field]).toEqual([field, JSON.stringify(v), 400, field]);
        }
      }
      expect(await prisma.homeBanner.count()).toBe(0);
      // the same on edit
      const a = await mk();
      const p = await patch(`/api/admin/banners/${a.id}`, { title: '<b>x</b>' });
      expect([p.status, p.body.field]).toEqual([400, 'title']);
    });

    test('Hindi and emoji are fine (NFC, collapsed white space); length counts characters, not bytes', async () => {
      const r = await post('/api/admin/banners', valid({ title: '  दिवाली   ऑफर \n 🎉 ', subtitle: 'सभी ऑर्डर पर 20% छूट 🍕', ctaLabel: 'अभी ऑर्डर करें' }));
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ title: 'दिवाली ऑफर 🎉', subtitle: 'सभी ऑर्डर पर 20% छूट 🍕', ctaLabel: 'अभी ऑर्डर करें' });
      const decomposed = await post('/api/admin/banners', valid({ title: 'Cafe\u0301 night' }));
      expect(decomposed.body.data.title).toBe('Café night');
      const family = await post('/api/admin/banners', valid({ title: '👨\u200d👩\u200d👧 family day' })); // ZWJ sequences are real emoji
      expect(family.status).toBe(201);
      expect((await post('/api/admin/banners', valid({ title: '🎉'.repeat(60) }))).status).toBe(201);
      expect((await post('/api/admin/banners', valid({ title: '🎉'.repeat(61) }))).status).toBe(400);
    });

    test('length rules: title 2..60, subtitle <= 120, button text <= 20, blank optional text becomes null', async () => {
      const cases: [Record<string, unknown>, number][] = [
        [{ title: 'A' }, 400], [{ title: '  A  ' }, 400], [{ title: '' }, 400], [{ title: 'AB' }, 201], [{ title: 'x'.repeat(60) }, 201], [{ title: 'x'.repeat(61) }, 400],
        [{ subtitle: 'x'.repeat(120) }, 201], [{ subtitle: 'x'.repeat(121) }, 400], [{ ctaLabel: 'x'.repeat(20) }, 201], [{ ctaLabel: 'x'.repeat(21) }, 400],
      ];
      for (const [extra, status] of cases) expect([JSON.stringify(extra).slice(0, 40), (await post('/api/admin/banners', valid(extra))).status]).toEqual([JSON.stringify(extra).slice(0, 40), status]);
      const blank = await post('/api/admin/banners', valid({ subtitle: '   ', ctaLabel: null }));
      expect(blank.body.data).toMatchObject({ subtitle: null, ctaLabel: null });
    });

    test('wrong types: arrays / objects / numbers / null for text, booleans and enums answer 400 with the field', async () => {
      for (const [k, v] of [['title', ['a', 'b']], ['title', { a: 1 }], ['title', 5], ['title', null], ['title', undefined], ['subtitle', ['x']], ['subtitle', 5], ['ctaLabel', { a: 1 }], ['theme', 'dark'], ['theme', 'RED'], ['theme', ['DARK']], ['isActive', 'true'], ['isActive', 1], ['isActive', null], ['placement', 'CHECKOUT'], ['placement', null]] as [string, unknown][]) {
        const r = await post('/api/admin/banners', valid({ [k]: v }));
        expect([k, JSON.stringify(v), r.status, r.body.field]).toEqual([k, JSON.stringify(v), 400, k]);
      }
      for (const body of [[], 'x', null]) expect((await post('/api/admin/banners', body)).status).toBe(400);
    });

    test('unknown keys and prototype-pollution keys are refused; Object.prototype stays clean', async () => {
      for (const extra of ['{"extra":1}', '{"__proto__":{"isAdmin":true}}', '{"constructor":{"prototype":{"x":1}}}', '{"prototype":1}', '{"viewCount":99}', '{"id":"x"}', '{"sortOrder":1}', '{"status":"LIVE"}']) {
        const r = await request.post('/api/admin/banners').set(H(tAdmin)).set('Content-Type', 'application/json').send(`{"title":"Fine title","imageUrl":"${IMG}",${extra.slice(1)}`);
        expect([extra, r.status, r.body.success]).toEqual([extra, 400, false]);
      }
      expect(({} as any).isAdmin).toBeUndefined();
      expect(({} as any).x).toBeUndefined();
      expect(await prisma.homeBanner.count()).toBe(0);
      const a = await mk();
      const p = await request.patch(`/api/admin/banners/${a.id}`).set(H(tAdmin)).set('Content-Type', 'application/json').send('{"__proto__":{"polluted":1}}');
      expect(p.status).toBe(400);
      expect(({} as any).polluted).toBeUndefined();
    });

    test('huge values answer quickly: 90 KB title -> 400, 200 KB body -> 413, malformed JSON -> 400', async () => {
      const t0 = Date.now();
      const big = await post('/api/admin/banners', valid({ title: 'x'.repeat(90_000) }));
      const huge = await post('/api/admin/banners', valid({ title: 'x'.repeat(200_000) }));
      const broken = await request.post('/api/admin/banners').set(H(tAdmin)).set('Content-Type', 'application/json').send('{"title": ');
      expect([big.status, huge.status, broken.status]).toEqual([400, 413, 400]);
      expect(Date.now() - t0).toBeLessThan(3000);
    });

    test('a stored title is inert text: the public list returns it exactly as stored (JSON, nothing rendered)', async () => {
      const r = await post('/api/admin/banners', valid({ title: 'Tom & "Jerry" \'s', subtitle: "O'Neil & co" }));
      expect(r.status).toBe(201);
      const list = await pub();
      expect(list[0]).toMatchObject({ title: 'Tom & "Jerry" \'s', subtitle: "O'Neil & co" });
    });
  });

  // =========================================================================================
  describe('schedule and status', () => {
    test('endsAt must be after startsAt (create and patch); bad formats are refused', async () => {
      const same = await post('/api/admin/banners', valid({ startsAt: at(10), endsAt: at(10) }));
      expect([same.status, same.body.code, same.body.field]).toEqual([400, 'BANNER_SCHEDULE_INVALID', 'endsAt']);
      expect((await post('/api/admin/banners', valid({ startsAt: at(10), endsAt: at(5) }))).status).toBe(400);
      for (const bad of ['tomorrow', '2026-11-01', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-11-01T10:00:00', 1790000000000, true, ['2026-11-01T10:00:00Z'], '1999-01-01T00:00:00Z', '2101-01-01T00:00:00Z']) {
        const r = await post('/api/admin/banners', valid({ startsAt: bad }));
        expect([JSON.stringify(bad), r.status, r.body.code]).toEqual([JSON.stringify(bad), 400, 'BANNER_SCHEDULE_INVALID']);
      }
      const a = await mk({ startsAt: at(60), endsAt: at(120) });
      expect((await patch(`/api/admin/banners/${a.id}`, { startsAt: at(180) })).body.code).toBe('BANNER_SCHEDULE_INVALID'); // start after the existing end
      expect((await patch(`/api/admin/banners/${a.id}`, { endsAt: at(30) })).body.code).toBe('BANNER_SCHEDULE_INVALID');
      expect((await patch(`/api/admin/banners/${a.id}`, { startsAt: at(180), endsAt: at(240) })).status).toBe(200);
    });

    test('a zone offset is accepted and stored as the UTC instant; null clears either end', async () => {
      const r = await post('/api/admin/banners', valid({ startsAt: '2026-11-02T08:00:00+05:30', endsAt: '2026-11-03T23:59:00.000+05:30' }));
      expect(r.body.data).toMatchObject({ startsAt: '2026-11-02T02:30:00.000Z', endsAt: '2026-11-03T18:29:00.000Z' });
      const cleared = await patch(`/api/admin/banners/${r.body.data.id}`, { startsAt: null, endsAt: null });
      expect(cleared.body.data).toMatchObject({ startsAt: null, endsAt: null, status: 'LIVE' });
      const again = await patch(`/api/admin/banners/${r.body.data.id}`, { startsAt: null });
      expect([again.body.changed, again.body.message]).toEqual([false, 'Nothing to change.']);
    });

    test('status per row: LIVE, SCHEDULED, EXPIRED, OFF follow the clock; ctr is a percentage with one decimal or null', async () => {
      __setBannerClock(() => NOW);
      const live = await mk({ title: 'Live' });
      const sched = await mk({ title: 'Sched', startsAt: at(1) });
      const exp = await raw({ title: 'Exp', sortOrder: 900, endsAt: new Date(at(-1)) });
      const off = await mk({ title: 'Off', isActive: false });
      await prisma.homeBanner.update({ where: { id: live.id }, data: { viewCount: 8, clickCount: 1 } });
      await prisma.homeBanner.update({ where: { id: sched.id }, data: { viewCount: 3, clickCount: 1 } });
      const rows = await adminList();
      const by = (id: string) => rows.find((r) => r.id === id);
      expect([by(live.id).status, by(sched.id).status, by(exp.id).status, by(off.id).status]).toEqual(['LIVE', 'SCHEDULED', 'EXPIRED', 'OFF']);
      expect([by(live.id).ctr, by(sched.id).ctr, by(off.id).ctr]).toEqual([12.5, 33.3, null]);
      __setBannerClock(() => new Date(at(2)));
      expect((await adminList()).find((r) => r.id === sched.id).status).toBe('LIVE');
      // an OFF banner whose window has ended is OFF (the switch wins)
      await prisma.homeBanner.update({ where: { id: off.id }, data: { endsAt: new Date(at(-5)) } });
      expect((await adminList()).find((r) => r.id === off.id).status).toBe('OFF');
    });

    test('expired-banner rule: no new ACTIVE banner with a past end; editing other fields of an expired banner is fine; turning it on needs a new end', async () => {
      __setBannerClock(() => NOW);
      const c = await post('/api/admin/banners', valid({ endsAt: at(-1) }));
      expect([c.status, c.body.code, c.body.field]).toEqual([400, 'BANNER_SCHEDULE_INVALID', 'endsAt']);
      const off = await post('/api/admin/banners', valid({ endsAt: at(-1), isActive: false }));
      expect([off.status, off.body.data.status]).toEqual([201, 'OFF']);
      const id = off.body.data.id;
      expect((await patch(`/api/admin/banners/${id}`, { isActive: true })).body.code).toBe('BANNER_SCHEDULE_INVALID');
      expect((await patch(`/api/admin/banners/${id}`, { isActive: true, endsAt: at(-2) })).body.code).toBe('BANNER_SCHEDULE_INVALID');
      expect((await patch(`/api/admin/banners/${id}`, { title: 'Still off, new title' })).status).toBe(200);
      const on = await patch(`/api/admin/banners/${id}`, { isActive: true, endsAt: at(60) });
      expect([on.status, on.body.data.status]).toEqual([200, 'LIVE']);
      const cleared = await patch(`/api/admin/banners/${id}`, { isActive: false, endsAt: at(-1) }); // allowed together with isActive:false
      expect([cleared.status, cleared.body.data.status]).toEqual([200, 'OFF']);
      expect((await patch(`/api/admin/banners/${id}`, { isActive: true, endsAt: null })).body.data.status).toBe('LIVE');
      // time passes: an active banner expires by itself; its text can still be edited, a past end cannot be set while active
      __setBannerClock(() => new Date(at(120)));
      const expired = (await adminList())[0];
      expect(expired.status).toBe('LIVE'); // endsAt was cleared above
      const e2 = await mk({ title: 'Ends in an hour', endsAt: at(180) });
      __setBannerClock(() => new Date(at(300)));
      expect((await adminList()).find((r) => r.id === e2.id).status).toBe('EXPIRED');
      expect((await patch(`/api/admin/banners/${e2.id}`, { title: 'Typo fixed' })).status).toBe(200);
      expect((await patch(`/api/admin/banners/${e2.id}`, { endsAt: at(200) })).body.code).toBe('BANNER_SCHEDULE_INVALID');
      expect((await patch(`/api/admin/banners/${e2.id}`, { endsAt: at(400) })).body.data.status).toBe('LIVE');
    });
  });

  // =========================================================================================
  describe('admin list, create and patch', () => {
    test('create answers 201 with the full admin row; defaults: DARK, HOME, active, last in the list (10, 20, ...)', async () => {
      const r = await post('/api/admin/banners', valid());
      expect(r.status).toBe(201);
      expect(Object.keys(r.body).sort()).toEqual(['data', 'message', 'success']);
      expect(Object.keys(r.body.data).sort()).toEqual(['clickCount', 'createdAt', 'createdByUserId', 'ctaLabel', 'ctr', 'endsAt', 'id', 'imageUrl', 'isActive', 'linkUrl', 'placement', 'rank', 'shown', 'sortOrder', 'startsAt', 'status', 'subtitle', 'theme', 'title', 'updatedAt', 'viewCount']);
      expect(r.body.data).toMatchObject({ title: 'Diwali Dhamaka', subtitle: null, linkUrl: null, ctaLabel: null, theme: 'DARK', placement: 'HOME', isActive: true, startsAt: null, endsAt: null, sortOrder: 10, viewCount: 0, clickCount: 0, ctr: null, status: 'LIVE', rank: 1, shown: true, createdByUserId: 'usr-5' });
      expect((await mk()).sortOrder).toBe(20);
      keep('create_response', r.body);
    });

    test('admin list: all rows (off and expired too) with counters, in order, exact shape', async () => {
      const a = await mk({ title: 'One', linkUrl: 'https://forms.gle/x1', ctaLabel: 'Go', startsAt: at(-10), endsAt: at(10) });
      await mk({ title: 'Two', isActive: false });
      await prisma.homeBanner.update({ where: { id: a.id }, data: { viewCount: 40, clickCount: 5 } });
      const r = await request.get('/api/admin/banners').set(H(tAdmin));
      expect(r.status).toBe(200);
      expect(r.body.count).toBe(2);
      expect(r.body.data.map((x: any) => x.title)).toEqual(['One', 'Two']);
      expect(r.body.data[0]).toMatchObject({ viewCount: 40, clickCount: 5, ctr: 12.5 });
      expect(r.body.data[1].status).toBe('OFF');
      keep('admin_list', r.body);
    });

    test('patch is partial; the answer carries changed + message + the full row; unchanged values are "nothing to change" (no audit, updatedAt kept)', async () => {
      const a = await mk({ title: 'Original', subtitle: 'Sub' });
      const r = await patch(`/api/admin/banners/${a.id}`, { title: 'Renamed', theme: 'LIGHT', ctaLabel: 'Order now', linkUrl: 'https://play.google.com/store/apps/details?id=x' });
      expect([r.status, r.body.success, r.body.changed, r.body.message]).toEqual([200, true, true, 'Banner saved.']);
      expect(r.body.data).toMatchObject({ id: a.id, title: 'Renamed', subtitle: 'Sub', theme: 'LIGHT', ctaLabel: 'Order now', sortOrder: a.sortOrder });
      keep('patch_response', r.body);
      const before = (await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } })).updatedAt.getTime();
      const noop = await patch(`/api/admin/banners/${a.id}`, { title: 'Renamed', theme: 'LIGHT', subtitle: 'Sub', startsAt: null });
      expect([noop.body.changed, noop.body.message]).toEqual([false, 'Nothing to change.']);
      expect((await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } })).updatedAt.getTime()).toBe(before);
      expect(await audits('BANNER_EDITED', a.id)).toHaveLength(1);
      const cleared = await patch(`/api/admin/banners/${a.id}`, { subtitle: null, ctaLabel: '', linkUrl: null });
      expect(cleared.body.data).toMatchObject({ subtitle: null, ctaLabel: null, linkUrl: null });
    });

    test('patch: empty body 400, unknown id 404, malformed id 400, read-only fields refused', async () => {
      const a = await mk();
      expect((await patch(`/api/admin/banners/${a.id}`, {})).status).toBe(400);
      const nf = await patch('/api/admin/banners/00000000-0000-4000-8000-000000000000', { title: 'Hello' });
      expect([nf.status, nf.body.code]).toEqual([404, 'NOT_FOUND']);
      expect((await patch('/api/admin/banners/bad%20id', { title: 'Hello' })).status).toBe(400);
      expect((await patch('/api/admin/banners/%00', { title: 'Hello' })).status).toBe(400);
      for (const k of ['viewCount', 'clickCount', 'sortOrder', 'id', 'createdAt', 'status', 'ctr']) expect([k, (await patch(`/api/admin/banners/${a.id}`, { [k]: 1 })).status]).toEqual([k, 400]);
    });

    test('the edit takes a row lock: a patch waits for a transaction that holds the row, then applies', async () => {
      const a = await mk({ title: 'Locked' });
      let patchDone = false;
      let pending: Promise<any> = Promise.resolve();
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "HomeBanner" WHERE "id" = ${a.id} FOR UPDATE`;
        pending = patch(`/api/admin/banners/${a.id}`, { title: 'After the lock' }).then((r) => { patchDone = true; return r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(patchDone).toBe(false);
      });
      const r = await pending;
      expect([r.status, r.body.data.title]).toEqual([200, 'After the lock']);
    });

    test('parallel edits of the same banner: all answer 200, the row ends with one of the values, no 500', async () => {
      const a = await mk();
      const out = await Promise.all(Array.from({ length: 12 }, (_, i) => patch(`/api/admin/banners/${a.id}`, { title: `Title ${i}`, theme: i % 2 ? 'LIGHT' : 'DARK' })));
      expect(out.map((r) => r.status)).toEqual(Array(12).fill(200));
      const row = await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.title).toMatch(/^Title \d+$/);
    });
  });

  // =========================================================================================
  describe('limits, delete, reorder, duplicate', () => {
    test('30 banners at most (409 BANNER_LIMIT) for create and duplicate; deleting one frees a slot', async () => {
      for (let i = 0; i < MAX_BANNERS; i += 1) await raw({ title: `R${i}`, sortOrder: (i + 1) * 10 });
      const r = await post('/api/admin/banners', valid());
      expect([r.status, r.body.code]).toEqual([409, 'BANNER_LIMIT']);
      const first = (await adminList())[0];
      expect((await post(`/api/admin/banners/${first.id}/duplicate`)).body.code).toBe('BANNER_LIMIT');
      await del(`/api/admin/banners/${first.id}`);
      expect((await post('/api/admin/banners', valid())).status).toBe(201);
    });

    test('35 parallel creates: exactly 30 rows, the rest 409, no 500, sortOrders distinct', async () => {
      const client = supertest(server.baseUrl);
      const out = await Promise.all(Array.from({ length: 35 }, (_, i) => client.post('/api/admin/banners').set(H(tAdmin)).send(valid({ title: `Race ${i}` }))));
      const codes = out.map((r) => r.status);
      expect(codes.filter((c) => c === 201)).toHaveLength(30);
      expect(codes.filter((c) => c === 409)).toHaveLength(5);
      expect(out.filter((r) => r.status === 409).every((r) => r.body.code === 'BANNER_LIMIT')).toBe(true);
      const rows = await prisma.homeBanner.findMany();
      expect(rows).toHaveLength(30);
      expect(new Set(rows.map((r) => r.sortOrder)).size).toBe(30);
    });

    test('delete: removes it, audits it, is idempotent (200 with deleted:false the second time), and a double parallel delete deletes once', async () => {
      const a = await mk({ title: 'Doomed' });
      const r = await del(`/api/admin/banners/${a.id}`);
      expect([r.status, r.body]).toEqual([200, { success: true, message: 'Banner deleted.', data: { id: a.id, title: 'Doomed', deleted: true } }]);
      keep('delete_response', r.body);
      const again = await del(`/api/admin/banners/${a.id}`);
      expect([again.status, again.body.data]).toEqual([200, { id: a.id, deleted: false }]);
      expect(await prisma.homeBanner.count()).toBe(0);
      expect(await audits('BANNER_DELETED', a.id)).toHaveLength(1);
      const b = await mk();
      const client = supertest(server.baseUrl);
      const out = await Promise.all([1, 2, 3, 4].map(() => client.delete(`/api/admin/banners/${b.id}`).set(H(tAdmin))));
      expect(out.map((o) => o.status)).toEqual([200, 200, 200, 200]);
      expect(out.filter((o) => o.body.data.deleted).length).toBe(1);
      expect(await audits('BANNER_DELETED', b.id)).toHaveLength(1);
      expect((await del('/api/admin/banners/bad%20id')).status).toBe(400);
    });

    test('reorder: listed ids get 10, 20, ... the others follow; the public list follows; the same call twice changes nothing', async () => {
      const a = await mk({ title: 'Alpha' }); const b = await mk({ title: 'Beta' }); const c = await mk({ title: 'Gamma' }); const d = await mk({ title: 'Delta' });
      const r = await post('/api/admin/banners/reorder', { ids: [c.id, a.id] });
      expect([r.status, r.body.success, r.body.changed, r.body.message]).toEqual([200, true, true, 'Order saved.']);
      expect(r.body.data.map((x: any) => [x.title, x.sortOrder])).toEqual([['Gamma', 10], ['Alpha', 20], ['Beta', 30], ['Delta', 40]]);
      keep('reorder_request', { ids: [c.id, a.id] });
      keep('reorder_response', r.body);
      expect((await pub()).map((x) => x.title)).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
      const again = await post('/api/admin/banners/reorder', { ids: [c.id, a.id] });
      expect([again.body.changed, again.body.message]).toEqual([false, 'The order was already like this.']);
      expect(await audits('BANNER_REORDERED')).toHaveLength(1);
      const full = await post('/api/admin/banners/reorder', { ids: [d.id, b.id, a.id, c.id] });
      expect(full.body.data.map((x: any) => x.title)).toEqual(['Delta', 'Beta', 'Alpha', 'Gamma']);
    });

    test('reorder: unknown / deleted ids -> 400 BANNER_UNKNOWN (nothing changes); bad lists -> 400', async () => {
      const a = await mk({ title: 'Alpha' }); const b = await mk({ title: 'Beta' });
      const gone = await mk({ title: 'Gone' });
      await del(`/api/admin/banners/${gone.id}`);
      for (const ids of [[b.id, '00000000-0000-4000-8000-000000000000'], [gone.id]]) {
        const r = await post('/api/admin/banners/reorder', { ids });
        expect([r.status, r.body.code, r.body.field]).toEqual([400, 'BANNER_UNKNOWN', 'ids']);
      }
      for (const ids of [[], [a.id, a.id], 'x', null, undefined, [5], ['bad id'], Array.from({ length: 31 }, (_, i) => `id${i}`)]) {
        expect([JSON.stringify(ids)?.slice(0, 30), (await post('/api/admin/banners/reorder', { ids })).status]).toEqual([JSON.stringify(ids)?.slice(0, 30), 400]);
      }
      expect((await adminList()).map((x) => x.title)).toEqual(['Alpha', 'Beta']);
    });

    test('duplicate: a switched-off copy at the end with " (copy)", counters reset, schedule and link kept; long titles are cut to 60; unknown id 404', async () => {
      const a = await mk({ title: 'Launch', subtitle: 'Sub', linkUrl: 'https://forms.gle/z', ctaLabel: 'Join', theme: 'LIGHT', startsAt: at(60), endsAt: at(120) });
      await mk({ title: 'Later one' });
      await prisma.homeBanner.update({ where: { id: a.id }, data: { viewCount: 7, clickCount: 2 } });
      const r = await post(`/api/admin/banners/${a.id}/duplicate`);
      expect([r.status, r.body.message]).toEqual([201, 'Banner duplicated. The copy is switched off.']);
      expect(r.body.data).toMatchObject({ title: 'Launch (copy)', subtitle: 'Sub', linkUrl: 'https://forms.gle/z', ctaLabel: 'Join', theme: 'LIGHT', isActive: false, status: 'OFF', viewCount: 0, clickCount: 0, ctr: null, sortOrder: 30, startsAt: at(60), endsAt: at(120) });
      expect(r.body.data.id).not.toBe(a.id);
      keep('duplicate_response', r.body);
      const long = await mk({ title: 'L'.repeat(60) });
      const lc = await post(`/api/admin/banners/${long.id}/duplicate`);
      expect(Array.from(lc.body.data.title)).toHaveLength(60);
      expect(lc.body.data.title.endsWith(' (copy)')).toBe(true);
      expect((await post('/api/admin/banners/00000000-0000-4000-8000-000000000000/duplicate')).status).toBe(404);
      expect(await audits('BANNER_DUPLICATED')).toHaveLength(2);
    });

    test('stress: parallel reorders, creates, duplicates, deletes and patches never 500 and leave distinct sortOrders', async () => {
      const seed = [];
      for (let i = 0; i < 8; i += 1) seed.push(await mk({ title: `S${i}` }));
      const client = supertest(server.baseUrl);
      const shuffle = (xs: any[], k: number) => xs.map((x, i) => [x, (i * 7 + k * 3) % 11] as const).sort((p, q) => p[1] - q[1]).map((p) => p[0]);
      const jobs: Promise<any>[] = [];
      for (let k = 0; k < 6; k += 1) jobs.push(client.post('/api/admin/banners/reorder').set(H(tAdmin)).send({ ids: shuffle(seed, k).map((s) => s.id) }));
      for (let k = 0; k < 4; k += 1) jobs.push(client.post('/api/admin/banners').set(H(tAdmin)).send(valid({ title: `New ${k}` })));
      for (let k = 0; k < 4; k += 1) jobs.push(client.post(`/api/admin/banners/${seed[k].id}/duplicate`).set(H(tAdmin)));
      for (let k = 4; k < 8; k += 1) jobs.push(client.delete(`/api/admin/banners/${seed[k].id}`).set(H(tAdmin)));
      for (let k = 0; k < 8; k += 1) jobs.push(client.patch(`/api/admin/banners/${seed[k].id}`).set(H(tAdmin)).send({ title: `Edited ${k}` }));
      const out = await Promise.all(jobs);
      expect(out.filter((r) => r.status >= 500).map((r) => r.body)).toEqual([]);
      expect(out.every((r) => [200, 201, 400, 404].includes(r.status))).toBe(true);
      const rows = await prisma.homeBanner.findMany({ orderBy: { sortOrder: 'asc' } });
      expect(new Set(rows.map((r) => r.sortOrder)).size).toBe(rows.length);
      expect(rows.every((r) => r.sortOrder % 10 === 0 && r.sortOrder > 0)).toBe(true);
    });
  });

  // =========================================================================================
  describe('audit, rate limits, roles', () => {
    test('every admin write leaves one audit row: WHO first, then the new link and image (and the old link on an edit); prose last; <= 300 characters', async () => {
      const a = await mk({ title: 'Audited', linkUrl: 'https://example.com/?token=secret123' });
      await patch(`/api/admin/banners/${a.id}`, { title: 'Audited 2', linkUrl: 'https://example.com/?token=secret456', isActive: false });
      const b = (await post(`/api/admin/banners/${a.id}/duplicate`)).body.data;
      await post('/api/admin/banners/reorder', { ids: [b.id] });
      await del(`/api/admin/banners/${b.id}`);
      const rows = await prisma.adminAuditLog.findMany({ where: { action: { startsWith: 'BANNER_' } }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.action)).toEqual(['BANNER_CREATED', 'BANNER_EDITED', 'BANNER_DUPLICATED', 'BANNER_REORDERED', 'BANNER_DELETED']);
      expect(rows.every((r) => r.targetType === 'BANNER')).toBe(true);
      expect(rows.every((r) => r.summary.includes('admin usr-5 '))).toBe(true);
      expect(rows[0].summary).toContain('link https://example.com/?token=secret123');
      expect(rows[0].summary).toContain(`image ${IMG}`);
      expect(rows[1].summary).toContain('link https://example.com/?token=secret456');
      expect(rows[1].summary).toContain('was https://example.com/?token=secret123');
      expect(rows[1].summary).toContain(`image ${IMG}`);
      expect(rows[1].summary).toContain('"Audited" -> "Audited 2"');
      expect(rows[1].summary).toContain('isActive true -> false');
      expect(rows[2].summary).toContain('link https://example.com/?token=secret456');
      expect(rows[4].summary).toContain('link https://example.com/?token=secret456');
      expect(rows.every((r) => r.summary.length <= 300)).toBe(true);
    });

    test('audit with 500-character addresses and a real uuid actor: still <= 300, the actor and the START of every address survive, prose is what gets cut', async () => {
      const long = (host: string) => `https://${host}/${'p'.repeat(470)}`;
      const uuid = '11111111-2222-4333-8444-555555555555';
      await prisma.user.upsert({ where: { id: uuid }, update: {}, create: { id: uuid, name: 'Long Admin', phone: '+91 9999870001', role: 'ADMIN' } });
      const t = getAdminToken(uuid, '+91 9999870001');
      try {
        const r = await post('/api/admin/banners', { title: 'Long', imageUrl: long('img.example.com'), linkUrl: long('link.example.com') }, t);
        expect(r.status).toBe(201);
        const e = await patch(`/api/admin/banners/${r.body.data.id}`, { linkUrl: long('link2.example.com'), title: 'Long 2' }, t);
        expect(e.status).toBe(200);
        const rows = await prisma.adminAuditLog.findMany({ where: { action: { in: ['BANNER_CREATED', 'BANNER_EDITED'] } }, orderBy: { createdAt: 'asc' } });
        for (const row of rows) {
          expect(row.summary.length).toBeLessThanOrEqual(300);
          expect(row.summary).toContain(`admin ${uuid} `);
          expect(row.summary).toContain('https://img.example.com/pppp');
        }
        expect(rows[0].summary).toContain('https://link.example.com/pppp');
        expect(rows[1].summary).toContain('link https://link2.example.com/pppp');
        expect(rows[1].summary).toContain('was https://link.example.com/pppp');
        expect(rows[1].summary).toContain('...');
      } finally {
        await prisma.user.delete({ where: { id: uuid } }).catch(() => undefined);
      }
    });

    test('admin writes are rate limited per admin; reads are not', async () => {
      process.env.RL_ADMIN_BANNER_WRITE_MAX = '3';
      const codes = [];
      for (let i = 0; i < 5; i += 1) codes.push((await post('/api/admin/banners', valid({ title: `RL ${i}` }))).status);
      expect(codes).toEqual([201, 201, 201, 429, 429]);
      expect((await request.get('/api/admin/banners').set(H(tAdmin))).status).toBe(200);
      const limited = await post('/api/admin/banners', valid());
      expect(limited.body.code).toBe('RATE_LIMITED');
    });

    test('owner, customer, driver and anonymous cannot use any admin banner endpoint (403 / 401)', async () => {
      const a = await mk();
      const calls: [string, string, unknown?][] = [
        ['get', '/api/admin/banners'], ['post', '/api/admin/banners', valid()], ['patch', `/api/admin/banners/${a.id}`, { title: 'Hacked' }],
        ['delete', `/api/admin/banners/${a.id}`], ['post', '/api/admin/banners/reorder', { ids: [a.id] }], ['post', `/api/admin/banners/${a.id}/duplicate`],
      ];
      for (const [method, url, body] of calls) {
        for (const [who, token, status] of [['owner', tVendor, 403], ['customer', tStudent, 403], ['driver', tDriver, 403], ['anonymous', null, 401]] as const) {
          let req = (request as any)[method](url);
          if (token) req = req.set(H(token));
          const r = await req.send(body as any);
          expect([method, url.replace(a.id, ':id'), who, r.status]).toEqual([method, url.replace(a.id, ':id'), who, status]);
        }
      }
      const row = await prisma.homeBanner.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.title).toBe('Diwali Dhamaka');
      expect(await prisma.homeBanner.count()).toBe(1);
    });
  });

  // =========================================================================================
  describe('operator switches (env) and live rank', () => {
    test('BANNER_LINK_HOSTS: unset = any https host; set = exact host or subdomain only, message names the hosts; edits that do not touch the link are never blocked', async () => {
      expect((await post('/api/admin/banners', valid({ linkUrl: 'https://anything.example.org/x' }))).status).toBe(201);
      process.env.BANNER_LINK_HOSTS = 'play.google.com, forms.gle,docs.google.com,kraveo.site';
      for (const ok of ['https://play.google.com/store/apps/details?id=x', 'https://forms.gle/abc', 'https://docs.google.com/forms/d/e/1/viewform', 'https://kraveo.site/', 'https://www.kraveo.site/offers', 'https://FORMS.GLE/x']) {
        expect([ok, (await post('/api/admin/banners', valid({ linkUrl: ok }))).status]).toEqual([ok, 201]);
      }
      for (const no of ['https://evil.example.com/', 'https://notkraveo.site/', 'https://kraveo.site.evil.com/', 'https://evilplay.google.com.evil.io/', 'https://google.com/']) {
        const r = await post('/api/admin/banners', valid({ linkUrl: no }));
        expect([no, r.status, r.body.code, r.body.field]).toEqual([no, 400, 'BANNER_LINK_INVALID', 'linkUrl']);
        expect(r.body.message).toContain('play.google.com, forms.gle, docs.google.com, kraveo.site');
        const p = await patch(`/api/admin/banners/${(await adminList())[0].id}`, { linkUrl: no });
        expect([no, p.status, p.body.code]).toEqual([no, 400, 'BANNER_LINK_INVALID']);
      }
      // the first banner keeps its (now disallowed) host; fixing its title is fine, clearing the link is fine
      const first = (await adminList())[0];
      expect(first.linkUrl).toBe('https://anything.example.org/x');
      expect((await patch(`/api/admin/banners/${first.id}`, { title: 'Still editable', linkUrl: 'https://anything.example.org/x' })).status).toBe(200);
      expect((await patch(`/api/admin/banners/${first.id}`, { linkUrl: null })).status).toBe(200);
      // no link at all is not a host violation
      expect((await post('/api/admin/banners', valid())).status).toBe(201);
      // other bad schemes keep their own message
      expect((await post('/api/admin/banners', valid({ linkUrl: 'http://forms.gle/x' }))).body.code).toBe('BANNER_LINK_INVALID');
    });

    test('BANNER_IMAGE_HOSTS: same rule for imageUrl (code BANNER_IMAGE_INVALID); our own uploads host can be listed', async () => {
      process.env.BANNER_IMAGE_HOSTS = 'api.kraveo.site,.cdn.example.com';
      expect((await post('/api/admin/banners', valid())).status).toBe(201); // IMG is on api.kraveo.site
      expect((await post('/api/admin/banners', valid({ imageUrl: 'https://img.cdn.example.com/a.jpg' }))).status).toBe(201);
      for (const no of ['https://tracker.evil.com/pixel.png', 'https://api.kraveo.site.evil.com/a.jpg', 'https://cdn.example.com.evil.io/a.jpg']) {
        const r = await post('/api/admin/banners', valid({ imageUrl: no }));
        expect([no, r.status, r.body.code, r.body.field]).toEqual([no, 400, 'BANNER_IMAGE_INVALID', 'imageUrl']);
        expect(r.body.message).toContain('api.kraveo.site, cdn.example.com');
      }
      const a = (await adminList())[0];
      const p = await patch(`/api/admin/banners/${a.id}`, { imageUrl: 'https://tracker.evil.com/pixel.png' });
      expect([p.status, p.body.code]).toEqual([400, 'BANNER_IMAGE_INVALID']);
      expect((await patch(`/api/admin/banners/${a.id}`, { title: 'Fine title' })).status).toBe(200);
      delete process.env.BANNER_IMAGE_HOSTS;
      expect((await post('/api/admin/banners', valid({ imageUrl: 'https://tracker.evil.com/pixel.png' }))).status).toBe(201);
    });

    test('BANNERS_ENABLED=false hides everything at once (also with a warm cache); true / unset / other values show it again; the admin list is unaffected', async () => {
      process.env.BANNERS_CACHE_TTL_MS = '30000';
      invalidatePublicBanners();
      await mk({ title: 'Visible' });
      expect(await pub()).toHaveLength(1);
      for (const off of ['false', 'FALSE', ' 0 ', 'no', 'off']) {
        process.env.BANNERS_ENABLED = off;
        const r = await request.get('/api/banners');
        expect([off, r.status, r.body]).toEqual([off, 200, { success: true, data: [] }]);
        expect(r.headers['cache-control']).toBe('public, max-age=30');
      }
      expect((await adminList())).toHaveLength(1);
      process.env.BANNERS_ENABLED = 'false';
      await mk({ title: 'Created while off' }); // writes still work
      expect(await pub()).toEqual([]);
      for (const on of ['true', '1', '', 'yes', 'whatever']) {
        process.env.BANNERS_ENABLED = on;
        expect([on, (await pub()).length]).toEqual([on, 2]);
      }
      delete process.env.BANNERS_ENABLED;
      expect(await pub()).toHaveLength(2);
    });

    test('rank / shown: position among the LIVE banners, shown = rank <= 10; off, scheduled and expired rows have rank null and shown false', async () => {
      __setBannerClock(() => NOW);
      for (let i = 1; i <= 12; i += 1) await mk({ title: `Live ${String(i).padStart(2, '0')}` });
      const off = await mk({ title: 'Off one', isActive: false });
      const sched = await mk({ title: 'Scheduled one', startsAt: at(5) });
      const rows = await adminList();
      const live = rows.filter((r) => r.status === 'LIVE');
      expect(live.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(live.map((r) => r.shown)).toEqual([...Array(10).fill(true), false, false]);
      for (const id of [off.id, sched.id]) expect(rows.find((r) => r.id === id)).toMatchObject({ rank: null, shown: false });
      expect((await pub())).toHaveLength(10); // the public list agrees
      expect((await pub()).map((x) => x.title)).toEqual(live.slice(0, 10).map((r) => r.title));
      // a single-row answer is ranked against the others too
      const p = await patch(`/api/admin/banners/${rows.find((r) => r.title === 'Live 11')!.id}`, { title: 'Eleventh' });
      expect(p.body.data).toMatchObject({ rank: 11, shown: false, status: 'LIVE' });
      const on = await patch(`/api/admin/banners/${off.id}`, { isActive: true });
      expect(on.body.data).toMatchObject({ rank: 13, shown: false });
      // reorder moves the cut line
      const ids = (await adminList()).map((r) => r.id);
      const r = await post('/api/admin/banners/reorder', { ids: [ids[11], ...ids.slice(0, 11)] });
      expect(r.body.data[0]).toMatchObject({ title: 'Live 12', rank: 1, shown: true });
      expect(r.body.data.find((x: any) => x.title === 'Eleventh')).toMatchObject({ rank: 12, shown: false });
      keep('admin_list_ranked', r.body.data.slice(10, 12));
    });
  });

  // =========================================================================================
  describe('image upload purpose=promo', () => {
    test('stored under promo/, served back, and usable as a banner image', async () => {
      const png = makePng(1200, 600);
      const r = await request.post('/api/admin/uploads/image?purpose=promo').set(H(tAdmin)).set('Content-Type', 'image/png').send(png);
      expect(r.status).toBe(201);
      expect(r.body.data.url).toMatch(/^https:\/\/api\.test\.kraveo\/uploads\/promo\/\d{4}\/[0-9a-f]{32}\.png$/);
      expect(r.body.data).toMatchObject({ width: 1200, height: 600, bytes: png.length });
      keep('upload_response', r.body);
      const got = await request.get(new URL(r.body.data.url).pathname);
      expect([got.status, got.headers['x-content-type-options'], got.headers['cross-origin-resource-policy']]).toEqual([200, 'nosniff', 'cross-origin']);
      expect((await post('/api/admin/banners', { title: 'Uploaded', imageUrl: r.body.data.url })).status).toBe(201);
      expect(fs.readdirSync(path.join(uploadDir, 'promo'))).toHaveLength(1);
    });

    test('same checks as other purposes (size, type, role) and old purposes still work; unknown purposes are still refused', async () => {
      const small = await request.post('/api/admin/uploads/image?purpose=promo').set(H(tAdmin)).set('Content-Type', 'image/png').send(makePng(100, 100));
      expect([small.status, small.body.code]).toEqual([400, 'IMAGE_TOO_SMALL']);
      const html = await request.post('/api/admin/uploads/image?purpose=promo').set(H(tAdmin)).set('Content-Type', 'image/png').send(Buffer.from('<html><script>alert(1)</script></html>'));
      expect(html.status).toBe(415);
      expect((await request.post('/api/admin/uploads/image?purpose=promo').set(H(tStudent)).set('Content-Type', 'image/png').send(makePng(600, 300))).status).toBe(403);
      for (const purpose of ['dish', 'banner']) expect((await request.post(`/api/admin/uploads/image?purpose=${purpose}`).set(H(tAdmin)).set('Content-Type', 'image/png').send(makePng(600, 300))).status).toBe(201);
      for (const purpose of ['PROMO', 'promo/../x', 'promos', '']) {
        const r = await request.post(`/api/admin/uploads/image?purpose=${encodeURIComponent(purpose)}`).set(H(tAdmin)).set('Content-Type', 'image/png').send(makePng(600, 300));
        expect([purpose, r.status, r.body.field]).toEqual([purpose, 400, 'purpose']);
      }
    });
  });
});
