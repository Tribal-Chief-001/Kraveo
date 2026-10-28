/**
 * Dish categories for every writer (Docs/23 section 3.4), bulk actions (3.5) and the whole-menu import (3.5).
 * Real PostgreSQL, real HTTP, the real pricing engine (Docs/21).
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { invalidateSettingsCache } from '../../src/services/settings';

jest.setTimeout(180_000);

const OWN = { id: 'usr-dc-o1', phone: '+91 9999891111' };
const V1 = 'dc-ven-1';
const V2 = 'dc-ven-2';
const tAdmin = getAdminToken();
const tStudent = getStudentToken();
const tOwner = getVendorToken(OWN.id, OWN.phone);
const H = (t: string) => getAuthHeader(t);
const P = 'ZD';
const DEFAULT_IMG = 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400';

describe('Dish categories, bulk actions and menu import', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let main: { id: string; name: string };
  let hidden: { id: string; name: string };
  let restOnly: { id: string; name: string };
  let other: { id: string; name: string };

  const adminPost = (path: string, body: unknown = {}) => request.post(path).set(H(tAdmin)).send(body as any);
  const adminPatch = (path: string, body: unknown = {}) => request.patch(path).set(H(tAdmin)).send(body as any);
  const mkCat = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await adminPost('/api/admin/categories', { name: `${P} ${name}`, ...extra });
    expect([name, r.status]).toEqual([name, 201]);
    return r.body.data as { id: string; name: string };
  };
  const ownerAdd = (body: Record<string, unknown>, vendorId = V1) => request.post(`/api/vendors/${vendorId}/items`).set(H(tOwner)).send({ name: `Dish ${randomUUID().slice(0, 6)}`, price: 100, description: 'd', ...body });
  const adminAdd = (body: Record<string, unknown>) => adminPost('/api/admin/catalog', { vendorId: V1, name: `Dish ${randomUUID().slice(0, 6)}`, vendorPrice: 100, ...body });
  const audits = (action: string, targetId?: string) => prisma.adminAuditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) } });
  const dbDish = (id: string) => prisma.menuItem.findUniqueOrThrow({ where: { id } });
  const bulk = (body: unknown) => adminPost('/api/admin/catalog/bulk', body);
  const imp = (rows: unknown, extra: Record<string, unknown> = {}, vendorId = V1) => adminPost(`/api/admin/vendors/${vendorId}/menu-import`, { rows, ...extra });
  const row = (name: string, extra: Record<string, unknown> = {}) => ({ name, category: `${P} Main`, vendorPrice: 100, ...extra });
  const wipe = async () => {
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: [V1, V2] } } });
    await prisma.vendorCategory.deleteMany({ where: { category: { name: { startsWith: P } } } });
    await prisma.menuItem.updateMany({ where: { category: { startsWith: P } }, data: { categoryId: null } });
    await prisma.category.deleteMany({ where: { name: { startsWith: P } } });
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.user.upsert({ where: { id: OWN.id }, update: {}, create: { id: OWN.id, name: 'DC Owner', phone: OWN.phone, role: Role.VENDOR } });
    for (const id of [V1, V2]) {
      await prisma.vendor.upsert({ where: { id }, update: { userId: id === V1 ? OWN.id : null, approvalStatus: 'APPROVED', commissionType: null, commissionValue: null }, create: { id, userId: id === V1 ? OWN.id : null, name: `DC Kitchen ${id.slice(-1)}`, category: 'Test', address: 'Gate', bannerImage: '', approvalStatus: 'APPROVED' } });
    }
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    __resetRateLimits();
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    await wipe();
    await prisma.vendor.updateMany({ where: { id: { in: [V1, V2] } }, data: { commissionType: null, commissionValue: null } });
    await prisma.adminAuditLog.deleteMany({});
    main = await mkCat('Main');
    other = await mkCat('Other');
    hidden = await mkCat('Hidden');
    await adminPatch(`/api/admin/categories/${hidden.id}`, { isActive: false });
    restOnly = await mkCat('RestOnly', { forDishes: false });
  });

  afterAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    await wipe();
    await prisma.vendor.deleteMany({ where: { id: { in: [V1, V2] } } });
    await prisma.adminAuditLog.deleteMany({});
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('restaurant app: POST /vendors/:id/items keeps working with the free-text category', () => {
    test('the old style: a name matched ignoring case and spacing, stored in its canonical spelling with the id; the answer has category + categoryId and no price data', async () => {
      const r = await ownerAdd({ category: `  ${P.toLowerCase()}   MAIN ` });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ category: `${P} Main`, categoryId: main.id, status: 'PENDING', price: 100 });
      expect(JSON.stringify(r.body)).not.toMatch(/commission|vendorPrice/);
      expect(await dbDish(r.body.data.id)).toMatchObject({ category: `${P} Main`, categoryId: main.id, createdBy: 'VENDOR', approvalStatus: 'PENDING' });
    });

    test('categoryId works; both together must agree; an id that does not exist or a mismatch is CATEGORY_UNKNOWN', async () => {
      const byId = await ownerAdd({ categoryId: other.id });
      expect([byId.status, byId.body.data.category, byId.body.data.categoryId]).toEqual([201, `${P} Other`, other.id]);
      const both = await ownerAdd({ category: `${P} other`, categoryId: other.id });
      expect(both.status).toBe(201);
      const clash = await ownerAdd({ category: `${P} Main`, categoryId: other.id });
      expect([clash.status, clash.body.code]).toEqual([400, 'CATEGORY_UNKNOWN']);
      const ghost = await ownerAdd({ categoryId: 'no-such-category' });
      expect([ghost.status, ghost.body.code]).toEqual([400, 'CATEGORY_UNKNOWN']);
      expect((await ownerAdd({ categoryId: 'bad id!' })).body.code).toBe('CATEGORY_UNKNOWN');
      expect((await ownerAdd({ categoryId: 7 })).body.code).toBe('CATEGORY_UNKNOWN');
    });

    test('unknown, hidden and not-a-dish-category names are refused with the plain message and NO suggestions for a restaurant; nothing is stored', async () => {
      for (const category of [`${P} Nope`, `${P} Hidden`, `${P} RestOnly`, 'Totally Unknown Cuisine']) {
        const r = await ownerAdd({ category });
        expect([category, r.status, r.body.success, r.body.code, r.body.field, r.body.message]).toEqual([category, 400, false, 'CATEGORY_UNKNOWN', 'category', 'Pick a category from the list.']);
        expect('suggestions' in r.body).toBe(false);
      }
      expect(await prisma.menuItem.count({ where: { vendorId: V1 } })).toBe(0);
    });

    test('old validation is unchanged (40 chars, not text), nothing given = Main Course, and the six names the old app hard-codes are accepted', async () => {
      expect((await ownerAdd({ category: 'c'.repeat(41) })).status).toBe(400);
      expect((await ownerAdd({ category: 5 })).status).toBe(400);
      for (const category of ['Main Course', 'Breads', 'Beverages', 'Snacks', 'Desserts', 'Fast Food']) {
        const r = await ownerAdd({ category });
        expect([category, r.status, r.body.data?.category]).toEqual([category, 201, category]);
      }
      const none = await ownerAdd({});
      expect([none.status, none.body.data.category]).toEqual([201, 'Main Course']);
      const blank = await ownerAdd({ category: '   ' });
      expect([blank.status, blank.body.data.category]).toEqual([201, 'Main Course']);
    });

    test("'Main Course' is created when it does not exist yet (dish-only, not on Home)", async () => {
      await prisma.menuItem.updateMany({ where: { categoryRef: { slug: 'main-course' } }, data: { categoryId: null } });
      await prisma.category.deleteMany({ where: { slug: 'main-course' } });
      const r = await ownerAdd({});
      expect([r.status, r.body.data.category]).toEqual([201, 'Main Course']);
      expect(await prisma.category.findUniqueOrThrow({ where: { slug: 'main-course' } })).toMatchObject({ name: 'Main Course', isActive: true, forDishes: true, forRestaurants: false, showOnHome: false });
      expect((await ownerAdd({})).status).toBe(201); // second time: found, not created twice
      expect(await prisma.category.count({ where: { slug: 'main-course' } })).toBe(1);
    });

    test('the restaurant still cannot change a category later (PATCH takes only isAvailable and price)', async () => {
      const id = (await ownerAdd({ category: `${P} Main` })).body.data.id;
      const r = await request.patch(`/api/vendors/items/${id}`).set(H(tOwner)).send({ category: `${P} Other` });
      expect(r.status).toBe(400);
      expect((await dbDish(id)).categoryId).toBe(main.id);
    });
  });

  // =========================================================================================
  describe('admin: create and edit a dish', () => {
    test('create by name or id; unknown names get suggestions (closest active dish categories) for admins only', async () => {
      const a = await adminAdd({ category: `${P} main` });
      expect([a.status, a.body.data.category, a.body.data.categoryId]).toEqual([201, `${P} Main`, main.id]);
      const b = await adminAdd({ categoryId: other.id });
      expect([b.status, b.body.data.category]).toEqual([201, `${P} Other`]);
      const bad = await adminAdd({ category: `${P} Mian` });
      expect([bad.status, bad.body.code, bad.body.message]).toEqual([400, 'CATEGORY_UNKNOWN', 'Pick a category from the list.']);
      expect(bad.body.suggestions).toEqual([`${P} Main`]);
      const none = await adminAdd({ category: 'Zzzzzzzz' });
      expect(none.body.suggestions).toEqual([]);
      const hid = await adminAdd({ category: `${P} Hidden` });
      expect(hid.body.code).toBe('CATEGORY_UNKNOWN');
      expect(hid.body.suggestions).not.toContain(`${P} Hidden`); // a hidden category is never suggested
      expect((await adminAdd({ category: `${P} RestOnly` })).body.code).toBe('CATEGORY_UNKNOWN');
      expect((await adminAdd({})).body.data.category).toBe('Main Course');
    });

    test('edit: change by name or id, same category sent again is fine, unknown is refused with suggestions, the price rules of Docs/21 are untouched', async () => {
      const d = (await adminAdd({ category: `${P} Main` })).body.data;
      const r1 = await adminPatch(`/api/admin/catalog/${d.id}`, { category: `${P} OTHER` });
      expect([r1.status, r1.body.data.category, r1.body.data.categoryId]).toEqual([200, `${P} Other`, other.id]);
      const r2 = await adminPatch(`/api/admin/catalog/${d.id}`, { categoryId: main.id, vendorPrice: 120 });
      expect([r2.status, r2.body.data.category, r2.body.data.price]).toEqual([200, `${P} Main`, 120]);
      const r3 = await adminPatch(`/api/admin/catalog/${d.id}`, { category: `${P} Mian` });
      expect([r3.status, r3.body.code, r3.body.suggestions]).toEqual([400, 'CATEGORY_UNKNOWN', [`${P} Main`]]);
      expect((await adminPatch(`/api/admin/catalog/${d.id}`, { categoryId: 12 })).status).toBe(400);
      expect((await dbDish(d.id)).categoryId).toBe(main.id);
      const blank = await adminPatch(`/api/admin/catalog/${d.id}`, { category: '' });
      expect([blank.status, blank.body.data.category]).toEqual([200, 'Main Course']); // as before: blank = Main Course
      expect((await audits('DISH_EDITED', d.id)).length).toBeGreaterThanOrEqual(3);
    });

    test('an edit that does NOT change the category never fails because the category was hidden or made restaurant-only since', async () => {
      const d = (await adminAdd({ category: `${P} Other` })).body.data;
      await adminPatch(`/api/admin/categories/${other.id}`, { isActive: false });
      expect((await adminPatch(`/api/admin/catalog/${d.id}`, { name: 'Renamed dish' })).status).toBe(200);
      expect((await adminPatch(`/api/admin/catalog/${d.id}`, { name: 'Renamed again', category: `${P} Other` })).status).toBe(200); // same name sent back
      expect((await adminPatch(`/api/admin/catalog/${d.id}`, { categoryId: other.id, isVeg: false })).status).toBe(200); // same id sent back
      const move = await adminPatch(`/api/admin/catalog/${d.id}`, { category: `${P} Hidden` }); // moving INTO a hidden one is refused
      expect(move.body.code).toBe('CATEGORY_UNKNOWN');
      expect((await adminPatch(`/api/admin/catalog/${d.id}`, { category: `${P} Main` })).status).toBe(200); // moving out is fine
      expect((await adminPatch(`/api/admin/catalog/${d.id}`, { category: `${P} Other` })).body.code).toBe('CATEGORY_UNKNOWN'); // and back in is not
    });

    test('a legacy dish without categoryId keeps editing; sending its own category name links it, even to a hidden category', async () => {
      const legacy = await prisma.menuItem.create({ data: { id: `dc-leg-${randomUUID().slice(0, 5)}`, vendorId: V1, name: 'Legacy', price: 50, vendorPrice: 50, category: 'Some Old Words', description: '', imageUrl: '' } });
      expect((await adminPatch(`/api/admin/catalog/${legacy.id}`, { name: 'Legacy 2' })).status).toBe(200);
      expect((await dbDish(legacy.id)).categoryId).toBeNull(); // untouched
      const twin = await prisma.menuItem.create({ data: { id: `dc-leg-${randomUUID().slice(0, 5)}`, vendorId: V1, name: 'Twin', price: 50, vendorPrice: 50, category: ` ${P.toLowerCase()} hidden`, description: '', imageUrl: '' } });
      const linked = await adminPatch(`/api/admin/catalog/${twin.id}`, { category: ` ${P} hidden ` });
      expect([linked.status, linked.body.data.category, linked.body.data.categoryId]).toEqual([200, `${P} Hidden`, hidden.id]);
    });

    test('dish payloads carry categoryId for the admin, the owner and customers; owner views still have no commission or customer price', async () => {
      const d = (await adminAdd({ category: `${P} Main`, commissionType: 'PERCENT', commissionValue: 10 })).body.data;
      expect(d.categoryId).toBe(main.id);
      const list = await request.get('/api/admin/catalog?q=Dish').set(H(tAdmin));
      expect(list.body.data.find((x: any) => x.id === d.id).categoryId).toBe(main.id);
      const pub = (await request.get(`/api/menus/${V1}`)).body.data.find((x: any) => x.id === d.id);
      expect(pub.categoryId).toBe(main.id);
      expect(JSON.stringify(pub)).not.toMatch(/commission|vendorPrice/);
      const own = (await request.get(`/api/menus/${V1}`).set(H(tOwner))).body.data.find((x: any) => x.id === d.id);
      expect(own).toMatchObject({ categoryId: main.id, price: 100, status: 'LIVE' });
      expect(JSON.stringify(own)).not.toMatch(/commission|computedPrice|effectiveCommission/);
      const manage = (await request.get(`/api/vendors/${V1}/menu-manage`).set(H(tOwner))).body.data.find((x: any) => x.id === d.id);
      expect(manage.categoryId).toBe(main.id);
      expect(JSON.stringify(manage)).not.toMatch(/commission|computedPrice/);
    });
  });

  // =========================================================================================
  describe('bulk: POST /api/admin/catalog/bulk', () => {
    const live = async (n: number, extra: Record<string, unknown> = {}) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push((await adminAdd({ category: `${P} Main`, ...extra })).body.data.id);
      return ids;
    };

    test('availability: result per dish with changed flags, idempotent on a second call, one audit row per change', async () => {
      const ids = await live(3);
      const off = await bulk({ ids, action: 'UNAVAILABLE' });
      expect(off.status).toBe(200);
      expect(off.body.data).toEqual({ results: ids.map((id) => ({ id, ok: true, changed: true })), ok: 3, failed: 0 });
      for (const id of ids) expect((await dbDish(id)).isAvailable).toBe(false);
      const again = await bulk({ ids, action: 'UNAVAILABLE' });
      expect(again.body.data.results.every((r: any) => r.ok && r.changed === false)).toBe(true);
      expect((await audits('DISH_EDITED')).filter((a) => /unavailable \(bulk\)/.test(a.summary))).toHaveLength(3);
      const on = await bulk({ ids: [ids[0]], action: 'AVAILABLE' });
      expect(on.body.data).toMatchObject({ ok: 1, failed: 0 });
      expect((await dbDish(ids[0])).isAvailable).toBe(true);
    });

    test('mixed outcomes: a failure never aborts the others and is reported with code and message; unknown ids are NOT_FOUND', async () => {
      const [a, b, c] = await live(3);
      await request.delete(`/api/admin/catalog/${b}`).set(H(tAdmin));
      const r = await bulk({ ids: [a, b, 'no-such-dish', c], action: 'UNAVAILABLE' });
      expect(r.status).toBe(200);
      expect(r.body.data.ok).toBe(2);
      expect(r.body.data.failed).toBe(2);
      expect(r.body.data.results).toEqual([
        { id: a, ok: true, changed: true },
        { id: b, ok: false, changed: false, code: 'ITEM_DELETED', message: 'This dish is deleted. Restore it first.' },
        { id: 'no-such-dish', ok: false, changed: false, code: 'NOT_FOUND', message: 'Menu item not found.' },
        { id: c, ok: true, changed: true },
      ]);
      expect([(await dbDish(a)).isAvailable, (await dbDish(c)).isAvailable]).toEqual([false, false]);
    });

    test('DELETE and RESTORE are soft and idempotent; APPROVE approves a pending dish with its price and refuses a deleted one like the single endpoint', async () => {
      const [a, b] = await live(2);
      const pending = (await ownerAdd({ category: `${P} Main`, price: 80 })).body.data.id;
      const del = await bulk({ ids: [a, b], action: 'DELETE' });
      expect(del.body.data.results.map((r: any) => r.changed)).toEqual([true, true]);
      expect((await bulk({ ids: [a], action: 'DELETE' })).body.data.results[0]).toEqual({ id: a, ok: true, changed: false });
      expect((await dbDish(a)).deletedAt).not.toBeNull();
      const restore = await bulk({ ids: [a, pending], action: 'RESTORE' });
      expect(restore.body.data.results.map((r: any) => [r.ok, r.changed])).toEqual([[true, true], [true, false]]);
      expect((await dbDish(a)).deletedAt).toBeNull();
      const ap = await bulk({ ids: [pending, b, 'nope'], action: 'APPROVE' });
      expect(ap.body.data.results.map((r: any) => [r.ok, r.changed, r.code])).toEqual([[true, true, undefined], [false, false, 'ITEM_DELETED'], [false, false, 'NOT_FOUND']]);
      expect(await dbDish(pending)).toMatchObject({ approvalStatus: 'APPROVED', price: 80 });
      expect((await bulk({ ids: [pending], action: 'APPROVE' })).body.data.results[0].changed).toBe(false); // a second click changes nothing
      expect((await audits('DISH_APPROVED', pending))).toHaveLength(1);
      expect((await audits('DISH_DELETED')).length).toBe(2);
      expect((await audits('DISH_RESTORED')).length).toBe(1);
    });

    test('SET_CATEGORY: by name or id, per dish rules (hidden target refused for the whole request, a dish that keeps its category is unchanged)', async () => {
      const ids = await live(2);
      const r = await bulk({ ids, action: 'SET_CATEGORY', category: `${P} other` });
      expect(r.body.data).toEqual({ results: ids.map((id) => ({ id, ok: true, changed: true })), ok: 2, failed: 0 });
      expect((await dbDish(ids[0]))).toMatchObject({ category: `${P} Other`, categoryId: other.id });
      const same = await bulk({ ids, action: 'SET_CATEGORY', categoryId: other.id });
      expect(same.body.data.results.every((x: any) => x.ok && !x.changed)).toBe(true);
      const bad = await bulk({ ids, action: 'SET_CATEGORY', category: `${P} Hidden` });
      expect([bad.status, bad.body.code]).toEqual([400, 'CATEGORY_UNKNOWN']);
      const typo = await bulk({ ids, action: 'SET_CATEGORY', category: `${P} Mian` });
      expect(typo.body.suggestions).toEqual([`${P} Main`]);
      expect((await dbDish(ids[0])).categoryId).toBe(other.id);
      expect((await audits('DISH_EDITED')).filter((a) => /moved .* to "ZD Other" \(bulk\)/.test(a.summary))).toHaveLength(2);
    });

    test('request validation: 1..100 distinct valid ids, a known action, the category only with SET_CATEGORY, no unknown keys', async () => {
      const id = (await live(1))[0];
      const many = Array.from({ length: 101 }, (_, i) => `id-${i}`);
      const cases: [string, unknown, string, number?][] = [
        ['no ids', { action: 'DELETE' }, 'ids'], ['empty ids', { ids: [], action: 'DELETE' }, 'ids'], ['101 ids', { ids: many, action: 'DELETE' }, 'ids'], ['dup ids', { ids: [id, id], action: 'DELETE' }, 'ids'],
        ['bad id', { ids: ['bad id!'], action: 'DELETE' }, 'ids'], ['id type', { ids: [5], action: 'DELETE' }, 'ids'], ['ids not list', { ids: id, action: 'DELETE' }, 'ids'],
        ['no action', { ids: [id] }, 'action'], ['bad action', { ids: [id], action: 'EXPLODE' }, 'action'], ['lower case action', { ids: [id], action: 'delete' }, 'action'],
        ['SET_CATEGORY without category', { ids: [id], action: 'SET_CATEGORY' }, 'category'], ['category with DELETE', { ids: [id], action: 'DELETE', category: `${P} Main` }, 'category'],
        ['unknown key', { ids: [id], action: 'DELETE', force: true }, 'force'],
      ];
      for (const [label, body, field] of cases) {
        const r = await bulk(body);
        expect([label, r.status, r.body.success, r.body.field]).toEqual([label, 400, false, field]);
      }
      expect((await dbDish(id)).deletedAt).toBeNull();
      const hundred = await live(0);
      expect(hundred).toEqual([]);
      const exactly100 = Array.from({ length: 100 }, (_, i) => `ghost-${i}`);
      const r = await bulk({ ids: exactly100, action: 'DELETE' });
      expect([r.status, r.body.data.ok, r.body.data.failed]).toEqual([200, 0, 100]); // 100 is allowed; none exists
    });

    test('double click: two identical bulk deletes at the same moment delete each dish once (one audit row each)', async () => {
      const ids = await live(5);
      const [a, b] = await Promise.all([bulk({ ids, action: 'DELETE' }), bulk({ ids, action: 'DELETE' })]);
      const changed = [...a.body.data.results, ...b.body.data.results].filter((r: any) => r.changed).length;
      expect(changed).toBe(5);
      expect(await audits('DISH_DELETED')).toHaveLength(5);
    });

    test('only ADMIN (401 / 403) and rate limited (ADMIN_CATALOG_BULK)', async () => {
      const id = (await live(1))[0];
      expect((await request.post('/api/admin/catalog/bulk').send({ ids: [id], action: 'DELETE' })).status).toBe(401);
      for (const t of [tStudent, tOwner]) expect((await request.post('/api/admin/catalog/bulk').set(H(t)).send({ ids: [id], action: 'DELETE' })).status).toBe(403);
      expect((await dbDish(id)).deletedAt).toBeNull();
      process.env.RL_ADMIN_CATALOG_BULK_MAX = '2';
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await bulk({ ids: [id], action: 'AVAILABLE' })).status);
      expect(codes).toEqual([200, 200, 429]);
    });
  });

  // =========================================================================================
  describe('menu import: POST /api/admin/vendors/:id/menu-import', () => {
    test('dry run is the DEFAULT and writes nothing; it reports every row with its action, errors and the computed customer price', async () => {
      await request.patch(`/api/admin/vendors/${V1}/commission`).set(H(tAdmin)).send({ type: 'PERCENT', value: 10 });
      await request.put('/api/admin/settings/rounding').set(H(tAdmin)).send({ step: 5 });
      const rows = [row('Paneer Tikka', { vendorPrice: 101 }), row('Dal Fry', { vendorPrice: 80, isVeg: true, description: ' Yellow   dal ' }), row('Bad Category', { category: `${P} Nope` })];
      for (const body of [{ rows }, { rows, dryRun: true }]) {
        const r = await adminPost(`/api/admin/vendors/${V1}/menu-import`, body);
        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({ dryRun: true, applied: false, summary: { create: 2, update: 0, skip: 0, invalid: 1, total: 3 } });
        expect(r.body.data.rows).toEqual([
          // Docs/26 added `vendorPrice` (the restaurant's price the row resolves to) and `sortOrder` (the menu position the row writes) to every row.
          { index: 0, name: 'Paneer Tikka', action: 'create', errors: [], computedPrice: 115, vendorPrice: 101, sortOrder: 10 }, // 101 + 10% = 111.1 -> rounded UP to a multiple of 5
          { index: 1, name: 'Dal Fry', action: 'create', errors: [], computedPrice: 90, vendorPrice: 80, sortOrder: 20 }, // 80 + 8 = 88 -> 90
          { index: 2, name: 'Bad Category', action: 'invalid', errors: [{ field: 'category', message: 'Pick a category from the list.' }], computedPrice: 110, vendorPrice: 100, sortOrder: null },
        ]);
      }
      expect(await prisma.menuItem.count({ where: { vendorId: V1 } })).toBe(0);
      expect(await audits('MENU_IMPORTED')).toHaveLength(0);
    });

    test('apply: every valid row is created LIVE in one transaction; the stored price equals the pricing engine (preview endpoint), defaults are filled, the answer lists the new ids, one audit row', async () => {
      await request.put('/api/admin/settings/commission').set(H(tAdmin)).send({ type: 'FLAT', value: 7 });
      await request.put('/api/admin/settings/rounding').set(H(tAdmin)).send({ step: 5 });
      await request.patch(`/api/admin/vendors/${V1}/commission`).set(H(tAdmin)).send({ type: 'PERCENT', value: 12.5 });
      const rows = [
        row('Plain', { vendorPrice: 33.33 }), row('  Full   Dish ', { category: `${P.toLowerCase()} other`, vendorPrice: 250, isVeg: false, description: 'Spicy', imageUrl: 'https://img.test/a.jpg', isAvailable: false }),
        row('Cheap', { vendorPrice: 0.01 }), row('Max', { vendorPrice: 5000 }),
      ];
      const r = await imp(rows, { dryRun: false });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ dryRun: false, applied: true, summary: { create: 4, update: 0, skip: 0, invalid: 0, total: 4 } });
      expect(r.body.data.rows.map((x: any) => x.action)).toEqual(['create', 'create', 'create', 'create']);
      for (const [i, x] of r.body.data.rows.entries()) {
        const d = await dbDish(x.dishId);
        const preview = await adminPost('/api/admin/catalog/preview', { vendorId: V1, vendorPrice: rows[i].vendorPrice });
        expect([d.price, x.computedPrice]).toEqual([preview.body.data.price, preview.body.data.price]); // the Docs/21 engine, not a second formula
        expect(d).toMatchObject({ vendorId: V1, vendorPrice: rows[i].vendorPrice, approvalStatus: 'APPROVED', createdBy: 'ADMIN', commissionType: null, commissionValue: null, deletedAt: null, pendingVendorPrice: null });
        expect(d.reviewedAt).not.toBeNull();
      }
      const [plain, full] = await Promise.all(r.body.data.rows.slice(0, 2).map((x: any) => dbDish(x.dishId)));
      expect(plain).toMatchObject({ name: 'Plain', category: `${P} Main`, categoryId: main.id, description: '', imageUrl: DEFAULT_IMG, isVeg: true, isAvailable: true });
      expect(full).toMatchObject({ name: 'Full Dish', category: `${P} Other`, categoryId: other.id, description: 'Spicy', imageUrl: 'https://img.test/a.jpg', isVeg: false, isAvailable: false });
      // customers see them (approved, live)
      const menu = (await request.get(`/api/menus/${V1}`)).body.data;
      expect(menu.map((m: any) => m.name).sort()).toEqual(['Cheap', 'Full Dish', 'Max', 'Plain']);
      const a = await audits('MENU_IMPORTED', V1);
      expect(a).toHaveLength(1);
      expect(a[0].summary).toContain('4 added, 0 updated, 0 skipped');
    });

    test('row validation: each field with its own message; unknown columns; the price cap is 5000 with 2 decimals; name 2..60', async () => {
      const bad = (extra: Record<string, unknown>) => ({ name: 'Ok Dish', category: `${P} Main`, vendorPrice: 10, ...extra });
      const cases: [Record<string, unknown>, string][] = [
        [{ name: 'A' }, 'name'], [{ name: 'x'.repeat(61) }, 'name'], [{ name: 5 }, 'name'], [{ name: '<b>x</b>' }, 'name'], [{ name: undefined }, 'name'],
        [{ category: undefined }, 'category'], [{ category: '' }, 'category'], [{ category: 5 }, 'category'], [{ category: `${P} Hidden` }, 'category'], [{ category: `${P} RestOnly` }, 'category'],
        [{ vendorPrice: 0 }, 'vendorPrice'], [{ vendorPrice: -1 }, 'vendorPrice'], [{ vendorPrice: '10' }, 'vendorPrice'], [{ vendorPrice: 5000.01 }, 'vendorPrice'], [{ vendorPrice: 10.123 }, 'vendorPrice'], [{ vendorPrice: undefined }, 'vendorPrice'], [{ vendorPrice: null }, 'vendorPrice'],
        [{ isVeg: 'yes' }, 'isVeg'], [{ isAvailable: 1 }, 'isAvailable'], [{ description: 'x'.repeat(301) }, 'description'], [{ description: 5 }, 'description'],
        [{ imageUrl: 'ftp://x/a.png' }, 'imageUrl'], [{ imageUrl: 'javascript:1' }, 'imageUrl'], [{ imageUrl: 'https://x/a b.png' }, 'imageUrl'], [{ imageUrl: `https://x/${'a'.repeat(500)}` }, 'imageUrl'],
        [{ colour: 'red' }, 'colour'],
      ];
      const r = await imp(cases.map(([extra]) => bad(extra)).concat([bad({ vendorPrice: 5000 }) as any, bad({ name: 'AB', imageUrl: '', description: null, isVeg: null }) as any, 'not a row' as any, null as any, [1] as any]));
      expect(r.status).toBe(200);
      const out = r.body.data.rows;
      for (const [i, [, field]] of cases.entries()) expect([i, out[i].action, out[i].errors.map((e: any) => e.field)]).toEqual([i, 'invalid', [field]]);
      expect(out[cases.length].action).toBe('create'); // exactly 5000 is fine
      expect(out[cases.length + 1].action).toBe('create'); // empty imageUrl, null description and null isVeg are the same as leaving them out
      expect(out.slice(cases.length + 2).map((x: any) => [x.action, x.errors[0].field])).toEqual([['invalid', 'row'], ['invalid', 'row'], ['invalid', 'row']]);
      expect(r.body.data.summary.total).toBe(cases.length + 5);
    });

    test('all or nothing: ONE invalid row means 400 IMPORT_INVALID with the same row report, and not a single dish is written', async () => {
      const rows = [row('Good One'), row('Good Two'), row('Broken', { vendorPrice: -5 }), row('Good Three')];
      const r = await imp(rows, { dryRun: false });
      expect([r.status, r.body.success, r.body.code]).toEqual([400, false, 'IMPORT_INVALID']);
      expect(r.body.data).toMatchObject({ dryRun: false, applied: false, summary: { create: 3, update: 0, skip: 0, invalid: 1, total: 4 } });
      expect(r.body.data.rows.map((x: any) => x.action)).toEqual(['create', 'create', 'invalid', 'create']);
      expect(r.body.data.rows[2].errors[0].field).toBe('vendorPrice');
      expect(await prisma.menuItem.count({ where: { vendorId: V1 } })).toBe(0);
      expect(await audits('MENU_IMPORTED')).toHaveLength(0);
      // the dry run of the same file reports exactly the same rows
      const dry = await imp(rows);
      expect(dry.body.data.rows).toEqual(r.body.data.rows);
    });

    test('duplicates: same name ignoring case and spacing. In the database: SKIP (default) or UPDATE; inside the file: the later row is invalid; two dishes already sharing a name: invalid', async () => {
      const existing = (await adminAdd({ name: 'Paneer Tikka', category: `${P} Main`, vendorPrice: 100, description: 'Old text', isVeg: true })).body.data;
      await adminAdd({ name: 'Twin', category: `${P} Main`, vendorPrice: 10 });
      await adminAdd({ name: 'twin', category: `${P} Main`, vendorPrice: 10 });
      const deleted = (await adminAdd({ name: 'Gone Dish', category: `${P} Main`, vendorPrice: 10 })).body.data;
      await request.delete(`/api/admin/catalog/${deleted.id}`).set(H(tAdmin));
      const rows = [row('  PANEER   tikka ', { vendorPrice: 150 }), row('New Dish'), row('new dish'), row('Twin'), row('Gone Dish')];
      const skip = await imp(rows);
      expect(skip.body.data.rows.map((x: any) => [x.action, x.reason ?? null])).toEqual([['skip', 'DUPLICATE_EXISTS'], ['create', null], ['invalid', null], ['invalid', null], ['create', null]]);
      expect(skip.body.data.rows[2].errors[0].message).toMatch(/repeated in the file \(first at row 2\)/);
      expect(skip.body.data.rows[3].errors[0].message).toMatch(/more than one dish with this name/);
      expect(skip.body.data.rows[0].dishId).toBeDefined();
      // a soft-deleted dish does not count: the name can be used again
      expect(skip.body.data.summary).toMatchObject({ create: 2, update: 0, skip: 1, invalid: 2 });
      const upd = await imp([row('paneer tikka', { vendorPrice: 150, description: ' New   text ' })], { onDuplicate: 'UPDATE' });
      expect(upd.body.data.rows[0]).toMatchObject({ action: 'update', computedPrice: 150, dishId: existing.id });
    });

    test('UPDATE applies only what the row carries (empty cells keep the stored value), recomputes the price, drops a pending price request, and a row with nothing new is a skip', async () => {
      const d = (await adminAdd({ name: 'Keeper', category: `${P} Main`, vendorPrice: 100, description: 'Old text', isVeg: false, imageUrl: 'https://img.test/keep.jpg', commissionType: 'FLAT', commissionValue: 5 })).body.data;
      await prisma.menuItem.update({ where: { id: d.id }, data: { pendingVendorPrice: 130 } });
      const r = await imp([row('KEEPER', { vendorPrice: 200, category: `${P} Other` })], { dryRun: false, onDuplicate: 'UPDATE' });
      expect(r.body.data.summary).toMatchObject({ create: 0, update: 1, skip: 0, invalid: 0 });
      expect(await dbDish(d.id)).toMatchObject({ name: 'Keeper', vendorPrice: 200, price: 205, pendingVendorPrice: null, category: `${P} Other`, categoryId: other.id, description: 'Old text', isVeg: false, imageUrl: 'https://img.test/keep.jpg', commissionType: 'FLAT', commissionValue: 5 });
      const same = await imp([row('Keeper', { vendorPrice: 200, category: `${P} Other` })], { dryRun: false, onDuplicate: 'UPDATE' });
      expect(same.body.data.rows[0]).toMatchObject({ action: 'skip', reason: 'UNCHANGED' });
      expect(same.body.data.summary).toMatchObject({ update: 0, skip: 1 });
      expect(await audits('MENU_IMPORTED')).toHaveLength(1); // nothing changed the second time: no audit row
      // a PENDING dish stays pending when its price is updated by an import
      const pend = (await ownerAdd({ name: 'Pending One', category: `${P} Main`, price: 50 })).body.data;
      await imp([row('pending one', { vendorPrice: 60 })], { dryRun: false, onDuplicate: 'UPDATE' });
      expect(await dbDish(pend.id)).toMatchObject({ approvalStatus: 'PENDING', vendorPrice: 60, price: 60 });
    });

    test('double click: the same import applied again (also 6 at once) creates nothing twice; the second answer says every row is a duplicate', async () => {
      const rows = Array.from({ length: 12 }, (_, i) => row(`Dish number ${i}`, { vendorPrice: 10 + i }));
      const first = await imp(rows, { dryRun: false });
      expect(first.body.data.summary).toMatchObject({ create: 12, skip: 0 });
      const second = await imp(rows, { dryRun: false });
      expect(second.body.data.summary).toMatchObject({ create: 0, skip: 12 });
      expect(second.body.data.rows.every((x: any) => x.reason === 'DUPLICATE_EXISTS')).toBe(true);
      await prisma.menuItem.deleteMany({ where: { vendorId: V1 } });
      const rs = await Promise.all(Array.from({ length: 6 }, () => imp(rows, { dryRun: false })));
      expect(rs.every((x) => x.status === 200)).toBe(true);
      expect(rs.map((x) => x.body.data.summary.create).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 0, 12]);
      expect(await prisma.menuItem.count({ where: { vendorId: V1 } })).toBe(12);
      expect((await audits('MENU_IMPORTED')).length).toBe(2);
    });

    test('limits: 1..200 rows, a 200-row file with fat fields (over 100 KB) is accepted, a body over 400 KB is refused as too large', async () => {
      expect((await imp([])).status).toBe(400);
      expect((await adminPost(`/api/admin/vendors/${V1}/menu-import`, {})).status).toBe(400);
      expect((await imp('x' as any)).status).toBe(400);
      const over = await imp(Array.from({ length: 201 }, (_, i) => row(`Dish ${i}`)));
      expect([over.status, over.body.code, over.body.field]).toEqual([400, 'TOO_MANY_ROWS', 'rows']);
      const fat = Array.from({ length: 200 }, (_, i) => row(`Fat dish ${i}`, { description: 'd'.repeat(300), imageUrl: `https://img.test/${'a'.repeat(450)}${i}.jpg`, vendorPrice: 10 + i }));
      expect(JSON.stringify(fat).length).toBeGreaterThan(150_000);
      const ok = await imp(fat, { dryRun: false });
      expect([ok.status, ok.body.data?.summary]).toEqual([200, { create: 200, update: 0, skip: 0, invalid: 0, total: 200 }]);
      const huge = await adminPost(`/api/admin/vendors/${V2}/menu-import`, { rows: [row('x')], pad: 'p'.repeat(450_000) });
      expect([huge.status, huge.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
      // every other JSON route keeps the 100 KB limit
      const smallRoute = await adminPost('/api/admin/catalog/bulk', { ids: ['a'], action: 'DELETE', pad: 'p'.repeat(150_000) });
      expect(smallRoute.status).toBe(413);
    });

    test('request validation: unknown keys, dryRun / onDuplicate types, unknown restaurant, bad id', async () => {
      const cases: [unknown, string][] = [[{ rows: [row('x')], dryRun: 'false' }, 'dryRun'], [{ rows: [row('x')], onDuplicate: 'REPLACE' }, 'onDuplicate'], [{ rows: [row('x')], vendorId: V2 }, 'vendorId'], [{ rows: [row('x')], onDuplicate: 'update' }, 'onDuplicate']];
      for (const [body, field] of cases) {
        const r = await adminPost(`/api/admin/vendors/${V1}/menu-import`, body);
        expect([JSON.stringify(body).slice(0, 40), r.status, r.body.field]).toEqual([JSON.stringify(body).slice(0, 40), 400, field]);
      }
      expect((await imp([row('x')], {}, 'no-such-vendor')).status).toBe(404);
      expect((await imp([row('x')], { dryRun: false }, 'no-such-vendor')).status).toBe(404);
      expect((await imp([row('x')], {}, 'bad%20id')).status).toBe(400);
    });

    test('only ADMIN (401 / 403, also for the owner of that very restaurant) and rate limited (ADMIN_MENU_IMPORT)', async () => {
      const body = { rows: [row('Hack')], dryRun: false };
      expect((await request.post(`/api/admin/vendors/${V1}/menu-import`).send(body)).status).toBe(401);
      for (const t of [tStudent, tOwner]) expect((await request.post(`/api/admin/vendors/${V1}/menu-import`).set(H(t)).send(body)).status).toBe(403);
      expect(await prisma.menuItem.count({ where: { vendorId: V1 } })).toBe(0);
      process.env.RL_ADMIN_MENU_IMPORT_MAX = '3';
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await imp([row('RL')])).status);
      expect(codes).toEqual([200, 200, 200, 429]);
    });

    test('a category renamed, hidden or deleted between the preview and the apply is caught: the apply re-validates and writes nothing', async () => {
      const rows = [row('Late One'), row('Late Two', { category: `${P} Other` })];
      expect((await imp(rows)).body.data.summary.invalid).toBe(0);
      await adminPatch(`/api/admin/categories/${other.id}`, { name: `${P} Renamed` });
      const r = await imp(rows, { dryRun: false });
      expect([r.status, r.body.code, r.body.data.rows[1].action]).toEqual([400, 'IMPORT_INVALID', 'invalid']);
      await adminPatch(`/api/admin/categories/${other.id}`, { name: `${P} Other`, isActive: false });
      expect((await imp(rows, { dryRun: false })).body.code).toBe('IMPORT_INVALID');
      expect(await prisma.menuItem.count({ where: { vendorId: V1 } })).toBe(0);
    });

    test('import racing renames / merges of its categories: every dish ends with its category\'s current name, no 500', async () => {
      for (let round = 0; round < 3; round++) {
        await prisma.menuItem.deleteMany({ where: { vendorId: V1 } });
        const a = await mkCat(`Race A${round}`);
        const b = await mkCat(`Race B${round}`);
        const rows = Array.from({ length: 10 }, (_, i) => row(`Race dish ${round}-${i}`, { category: i % 2 ? a.name : b.name }));
        const rs = await Promise.all([
          imp(rows, { dryRun: false }), imp(rows, { dryRun: false }),
          adminPatch(`/api/admin/categories/${a.id}`, { name: `${P} Race A${round} renamed` }),
          adminPost(`/api/admin/categories/${b.id}/merge`, { intoId: a.id, dryRun: false }),
          adminPatch(`/api/admin/categories/${a.id}`, { name: `${P} Race A${round} again` }),
        ]);
        expect(rs.filter((r) => ![200, 400, 404, 409].includes(r.status)).map((r) => [r.status, r.body])).toEqual([]);
        const dishes = await prisma.menuItem.findMany({ where: { vendorId: V1 }, include: { categoryRef: true } });
        for (const d of dishes) expect([d.name, d.categoryRef?.name]).toEqual([d.name, d.category]);
        expect(new Set(dishes.map((d) => d.name.toLowerCase())).size).toBe(dishes.length); // never a dish twice
        await prisma.menuItem.deleteMany({ where: { vendorId: V1 } });
      }
    });
  });
});
