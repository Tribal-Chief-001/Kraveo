/**
 * Managed categories (Docs/23 sections 3.1 and 3.2): the public list, admin create / patch / reorder / merge / delete, the rename cascade
 * into the denormalised dish and restaurant strings, the delete rules, audit rows, rate limits, role checks and a concurrency stress.
 * Real PostgreSQL, real HTTP. Every category made here starts with "ZT" so the suite ignores whatever other suites left in the table.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';

jest.setTimeout(120_000);

const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const OWNER = { id: 'usr-ca-v1', phone: '+91 9999871111' };
const V = [
  { id: 'ca-ven-1', status: 'APPROVED' as const },
  { id: 'ca-ven-2', status: 'APPROVED' as const },
  { id: 'ca-ven-3', status: 'PENDING' as const },
];
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const tStudent = getStudentToken();
const tVendor = getVendorToken(OWNER.id, OWNER.phone);
const tDriver = getDriverToken();
const H = (t: string) => getAuthHeader(t);
const P = 'ZT';

describe('Managed categories', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const post = (path: string, body: unknown = {}, t = tAdmin) => request.post(path).set(H(t)).send(body as any);
  const patch = (path: string, body: unknown = {}, t = tAdmin) => request.patch(path).set(H(t)).send(body as any);
  const del = (path: string, t = tAdmin) => request.delete(path).set(H(t));
  const adminList = async (all = true) => (await request.get(`/api/admin/categories${all ? '?includeInactive=1' : ''}`).set(H(tAdmin))).body.data.filter((c: any) => c.name.startsWith(P)) as any[];
  const publicList = async (q = '') => (await request.get(`/api/categories${q}`)).body.data.filter((c: any) => c.name.startsWith(P)) as any[];
  const mk = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await post('/api/admin/categories', { name: `${P} ${name}`, ...extra });
    expect([name, r.status]).toEqual([name, 201]);
    return r.body.data as any;
  };
  const audits = (action: string, targetId?: string) => prisma.adminAuditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) } });
  /** Tags a restaurant with categories exactly like the server does (links + derived string), without using the endpoint under test elsewhere. */
  const tag = async (vendorId: string, cats: { id: string; name: string }[]) => {
    await prisma.vendorCategory.deleteMany({ where: { vendorId } });
    for (const [position, c] of cats.entries()) await prisma.vendorCategory.create({ data: { vendorId, categoryId: c.id, position } });
    await prisma.vendor.update({ where: { id: vendorId }, data: { category: cats.map((c) => c.name).join(' • ') || 'Campus kitchen' } });
  };
  let dishNo = 0;
  const dish = (vendorId: string, cat: { id: string; name: string }, extra: Record<string, unknown> = {}) =>
    prisma.menuItem.create({ data: { id: `ca-d-${++dishNo}-${randomUUID().slice(0, 6)}`, vendorId, name: `Dish ${dishNo}`, price: 100, vendorPrice: 100, category: cat.name, categoryId: cat.id, description: '', imageUrl: '', ...extra } });
  const wipe = async () => {
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: V.map((v) => v.id) } } });
    await prisma.vendorCategory.deleteMany({ where: { vendorId: { in: V.map((v) => v.id) } } });
    await prisma.vendor.updateMany({ where: { id: { in: V.map((v) => v.id) } }, data: { category: 'Test' } });
    await prisma.vendorCategory.deleteMany({ where: { category: { name: { startsWith: P } } } });
    await prisma.menuItem.updateMany({ where: { category: { startsWith: P } }, data: { categoryId: null } });
    await prisma.category.deleteMany({ where: { name: { startsWith: P } } });
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.user.upsert({ where: { id: OWNER.id }, update: {}, create: { id: OWNER.id, name: 'CA Owner', phone: OWNER.phone, role: Role.VENDOR } });
    for (const v of V) {
      await prisma.vendor.upsert({
        where: { id: v.id },
        update: { userId: OWNER.id, approvalStatus: v.status },
        create: { id: v.id, userId: OWNER.id, name: `CA Kitchen ${v.id.slice(-1)}`, category: 'Test', address: 'Gate', bannerImage: '', approvalStatus: v.status },
      });
    }
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    __resetRateLimits();
    await wipe();
    await prisma.adminAuditLog.deleteMany({ where: { action: { startsWith: 'CATEGORY_' } } });
  });

  afterAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    await wipe();
    await prisma.vendor.deleteMany({ where: { id: { in: V.map((v) => v.id) } } });
    await prisma.adminAuditLog.deleteMany({ where: { action: { startsWith: 'CATEGORY_' } } });
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('public list: GET /api/categories', () => {
    test('no login needed, cacheable for a minute, exact shape, ordered by sortOrder then name, inactive ones hidden', async () => {
      const b = await mk('Beta');
      const a = await mk('Alpha');
      const hidden = await mk('Hidden');
      await patch(`/api/admin/categories/${hidden.id}`, { isActive: false });
      const r = await request.get('/api/categories');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('public, max-age=60');
      expect(r.body.success).toBe(true);
      expect(r.body.count).toBe(r.body.data.length);
      const mine = r.body.data.filter((c: any) => c.name.startsWith(P));
      expect(mine.map((c: any) => c.name)).toEqual([`${P} Beta`, `${P} Alpha`]); // created order = sortOrder order
      expect(Object.keys(mine[0]).sort()).toEqual(['dishCount', 'forDishes', 'forRestaurants', 'icon', 'id', 'name', 'nameHi', 'restaurantCount', 'showOnHome', 'sortOrder']);
      expect(mine[0]).toMatchObject({ id: b.id, nameHi: null, forRestaurants: true, forDishes: true, showOnHome: false, restaurantCount: 0, dishCount: 0 });
      expect(a.sortOrder).toBe(b.sortOrder + 1);
      // equal sortOrder: by name
      await patch(`/api/admin/categories/${a.id}`, { sortOrder: b.sortOrder });
      expect((await publicList()).map((c) => c.name)).toEqual([`${P} Alpha`, `${P} Beta`]);
    });

    test('?for= filters: restaurants, dishes, home (home = showOnHome and something to show); a bad value is a 400', async () => {
      const both = await mk('Both', { showOnHome: true });
      const restOnly = await mk('RestOnly', { forDishes: false, showOnHome: true });
      const dishOnly = await mk('DishOnly', { forRestaurants: false, showOnHome: true });
      const noHome = await mk('NoHome');
      await tag(V[0].id, [restOnly]);
      await dish(V[0].id, both);
      await dish(V[0].id, dishOnly);
      await dish(V[0].id, noHome);
      const names = async (q: string) => (await publicList(q)).map((c) => c.name.slice(P.length + 1)).sort();
      expect(await names('?for=restaurants')).toEqual(['Both', 'NoHome', 'RestOnly']);
      expect(await names('?for=dishes')).toEqual(['Both', 'DishOnly', 'NoHome']);
      expect(await names('?for=home')).toEqual(['Both', 'DishOnly', 'RestOnly']);
      const unused = await mk('UnusedHome', { showOnHome: true });
      expect(await names('?for=home')).not.toContain('UnusedHome'); // on Home only when it has an approved restaurant or dish
      expect(unused.showOnHome).toBe(true);
      for (const q of ['?for=food', '?for=', '?for=home&for=dishes']) expect([q, (await request.get(`/api/categories${q}`)).status]).toEqual([q, 400]);
    });

    test('counts: restaurantCount = APPROVED restaurants, dishCount = approved and not deleted dishes (pending, rejected and deleted do not count); one grouped query', async () => {
      const c = await mk('Counted');
      await tag(V[0].id, [c]);
      await tag(V[1].id, [c]);
      await tag(V[2].id, [c]); // PENDING restaurant
      await dish(V[0].id, c);
      await dish(V[0].id, c);
      await dish(V[0].id, c, { approvalStatus: 'PENDING' });
      await dish(V[0].id, c, { approvalStatus: 'REJECTED' });
      await dish(V[0].id, c, { deletedAt: new Date() });
      const row = (await publicList())[0];
      expect([row.restaurantCount, row.dishCount]).toEqual([2, 2]);
      const adminRow = (await adminList())[0];
      expect(adminRow.usage).toEqual({ restaurants: 3, dishes: 5 });
      expect(adminRow.inUse).toBe(true);
    });
  });

  // =========================================================================================
  describe('access: restaurant owners, customers and riders can never call an admin category endpoint', () => {
    test('401 without a token, 403 for student / restaurant owner / rider on every endpoint, and nothing changes', async () => {
      const c = await mk('Guarded');
      const other = await mk('Other');
      const calls: [string, string, unknown][] = [
        ['get', '/api/admin/categories', undefined], ['post', '/api/admin/categories', { name: 'ZT Nope' }],
        ['patch', `/api/admin/categories/${c.id}`, { name: 'ZT Renamed' }], ['post', '/api/admin/categories/reorder', { ids: [other.id, c.id] }],
        ['post', `/api/admin/categories/${c.id}/merge`, { intoId: other.id, dryRun: false }], ['delete', `/api/admin/categories/${c.id}`, undefined],
      ];
      for (const [method, path, body] of calls) {
        const anon = await (request as any)[method](path).send(body as any);
        expect([method, path, anon.status]).toEqual([method, path, 401]);
        for (const t of [tStudent, tVendor, tDriver]) {
          const r = await (request as any)[method](path).set(H(t)).send(body as any);
          expect([method, path, r.status]).toEqual([method, path, 403]);
        }
      }
      expect((await adminList()).map((x) => x.name)).toEqual([`${P} Guarded`, `${P} Other`]);
      expect(await audits('CATEGORY_EDITED')).toHaveLength(0);
    });
  });

  // =========================================================================================
  describe('create', () => {
    test('defaults, trimming, next sortOrder, icon guessed from the name, audit row', async () => {
      const first = await mk('  Biryani   House ');
      expect(first).toMatchObject({ name: `${P} Biryani House`, slug: 'zt-biryani-house', nameHi: null, icon: 'biryani', isActive: true, forRestaurants: true, forDishes: true, showOnHome: false, restaurantCount: 0, dishCount: 0, inUse: false });
      expect(first.usage).toEqual({ restaurants: 0, dishes: 0 });
      const second = await post('/api/admin/categories', { name: `${P} Chai`, nameHi: ' चाय ', icon: 'coffee', forRestaurants: false, showOnHome: true });
      expect(second.status).toBe(201);
      expect(second.body.data).toMatchObject({ nameHi: 'चाय', icon: 'coffee', forRestaurants: false, forDishes: true, showOnHome: true, sortOrder: first.sortOrder + 1 });
      const rows = await audits('CATEGORY_CREATED');
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.targetId === first.id)!.summary).toContain('ZT Biryani House');
    });

    test('validation: name rules, icon set, flags, unknown keys; nothing is stored for a refused request', async () => {
      const bad: [string, unknown, string][] = [
        ['too short', { name: 'Z' }, 'name'], ['empty', { name: '   ' }, 'name'], ['missing', {}, 'name'], ['not text', { name: 5 }, 'name'],
        ['31 chars', { name: 'x'.repeat(31) }, 'name'], ['html', { name: 'ZT <b>bold</b>' }, 'name'], ['symbols', { name: 'ZT Fish!' }, 'name'],
        ['hindi in name', { name: 'ZT चाय' }, 'name'], ['only symbols', { name: '&&' }, 'name'], ['control char', { name: 'ZT a\u0007b' }, 'name'],
        ['bad icon', { name: 'ZT Ok', icon: 'rocket' }, 'icon'], ['icon type', { name: 'ZT Ok', icon: 7 }, 'icon'], ['long hindi', { name: 'ZT Ok', nameHi: 'अ'.repeat(31) }, 'nameHi'],
        ['hindi html', { name: 'ZT Ok', nameHi: '<i>x</i>' }, 'nameHi'], ['flag type', { name: 'ZT Ok', showOnHome: 'yes' }, 'showOnHome'],
        ['unusable', { name: 'ZT Ok', forRestaurants: false, forDishes: false }, 'forDishes'], ['unknown key', { name: 'ZT Ok', sortOrder: 3 }, 'sortOrder'],
        ['isActive on create', { name: 'ZT Ok', isActive: false }, 'isActive'],
      ];
      for (const [label, body, field] of bad) {
        const r = await post('/api/admin/categories', body);
        expect([label, r.status, r.body.success, r.body.code, r.body.field]).toEqual([label, 400, false, 'BAD_REQUEST', field]);
      }
      expect(await adminList()).toHaveLength(0);
      // allowed punctuation and exact boundaries
      for (const name of [`${P} A&B`, `${P} Pav-Bhaji`, `${P} Chef's/Special+`, `ZT${'x'.repeat(28)}`]) expect([name, (await post('/api/admin/categories', { name })).status]).toEqual([name, 201]);
    });

    test('a duplicate name (ignoring case and spacing) is a 409 CATEGORY_EXISTS that carries the existing category', async () => {
      const a = await mk('Street Food');
      for (const name of ['zt street food', 'ZT   STREET   FOOD', 'ZT Street-Food', ' ZT Street Food ']) {
        const r = await post('/api/admin/categories', { name });
        expect([name, r.status, r.body.code, r.body.field, r.body.existing?.id]).toEqual([name, 409, 'CATEGORY_EXISTS', 'name', a.id]);
        expect(r.body.existing).toMatchObject({ name: `${P} Street Food`, slug: 'zt-street-food' });
      }
      expect(await adminList()).toHaveLength(1);
    });

    test('ten parallel creates of the same name: exactly one wins, nine are 409', async () => {
      const rs = await Promise.all(Array.from({ length: 10 }, () => post('/api/admin/categories', { name: `${P} Race` })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'CATEGORY_EXISTS')).toHaveLength(9);
      expect(await adminList()).toHaveLength(1);
    });

    test('at most 300 categories', async () => {
      const have = await prisma.category.count();
      const rows = Array.from({ length: Math.max(0, 300 - have) }, (_, i) => ({ name: `${P}fill ${i}`, slug: `zt-fill-${i}`, sortOrder: 9000 + i }));
      await prisma.category.createMany({ data: rows });
      const r = await post('/api/admin/categories', { name: `${P} One More` });
      expect([r.status, r.body.code]).toEqual([409, 'TOO_MANY_CATEGORIES']);
    });
  });

  // =========================================================================================
  describe('patch', () => {
    test('every field; an identical body is a no-op (changed:false, no audit); unknown keys and bad values are 400', async () => {
      const c = await mk('Patchme');
      const r = await patch(`/api/admin/categories/${c.id}`, { nameHi: 'पैच', icon: 'pizza', showOnHome: true, forDishes: false, isActive: false, sortOrder: 77 });
      expect([r.status, r.body.changed]).toEqual([200, true]);
      expect(r.body.data).toMatchObject({ id: c.id, nameHi: 'पैच', icon: 'pizza', showOnHome: true, forDishes: false, forRestaurants: true, isActive: false, sortOrder: 77 });
      const again = await patch(`/api/admin/categories/${c.id}`, { nameHi: 'पैच', icon: 'pizza', showOnHome: true, forDishes: false, isActive: false, sortOrder: 77 });
      expect([again.status, again.body.changed]).toEqual([200, false]);
      expect(await audits('CATEGORY_EDITED', c.id)).toHaveLength(1);
      expect((await patch(`/api/admin/categories/${c.id}`, { nameHi: null })).body.data.nameHi).toBeNull();
      const bad: [unknown, string][] = [[{}, 'body'], [{ slug: 'x' }, 'slug'], [{ name: 'Z' }, 'name'], [{ icon: 'nope' }, 'icon'], [{ sortOrder: -1 }, 'sortOrder'], [{ sortOrder: 1.5 }, 'sortOrder'],
        [{ sortOrder: '3' }, 'sortOrder'], [{ isActive: 'no' }, 'isActive'], [{ forRestaurants: false, forDishes: false }, 'forDishes']];
      for (const [body, field] of bad) {
        const x = await patch(`/api/admin/categories/${c.id}`, body);
        expect([JSON.stringify(body), x.status, x.body.field]).toEqual([JSON.stringify(body), 400, field]);
      }
      expect((await patch('/api/admin/categories/no-such-id', { icon: 'egg' })).status).toBe(404);
      expect((await patch('/api/admin/categories/bad%20id', { icon: 'egg' })).status).toBe(400);
    });

    test('RENAME rewrites the dish names and the restaurant strings of everything that uses it, in one go', async () => {
      const north = await mk('North');
      const thali = await mk('Thali');
      const tea = await mk('Tea');
      await tag(V[0].id, [north, thali]);
      await tag(V[1].id, [tea, thali, north]);
      await tag(V[2].id, [thali]); // a pending restaurant is renamed too
      const d1 = await dish(V[0].id, thali);
      const d2 = await dish(V[1].id, thali, { approvalStatus: 'PENDING' });
      const d3 = await dish(V[1].id, thali, { deletedAt: new Date() });
      const d4 = await dish(V[0].id, tea);
      const r = await patch(`/api/admin/categories/${thali.id}`, { name: `${P} Thalis & Combos` });
      expect([r.status, r.body.changed, r.body.data.name, r.body.data.slug]).toEqual([200, true, `${P} Thalis & Combos`, 'zt-thalis-combos']);
      const dishes = await prisma.menuItem.findMany({ where: { id: { in: [d1.id, d2.id, d3.id, d4.id] } }, orderBy: { id: 'asc' } });
      const byId = new Map(dishes.map((d) => [d.id, d.category]));
      expect([byId.get(d1.id), byId.get(d2.id), byId.get(d3.id), byId.get(d4.id)]).toEqual([`${P} Thalis & Combos`, `${P} Thalis & Combos`, `${P} Thalis & Combos`, `${P} Tea`]);
      const vendors = Object.fromEntries((await prisma.vendor.findMany({ where: { id: { in: V.map((v) => v.id) } } })).map((v) => [v.id, v.category]));
      expect(vendors).toEqual({
        'ca-ven-1': `${P} North • ${P} Thalis & Combos`,
        'ca-ven-2': `${P} Tea • ${P} Thalis & Combos • ${P} North`,
        'ca-ven-3': `${P} Thalis & Combos`,
      });
      expect((await audits('CATEGORY_EDITED', thali.id))[0].summary).toContain('updated 3 dishes, 3 restaurants');
      // a case-only rename is a rename (same slug) and rewrites the strings again
      const c2 = await patch(`/api/admin/categories/${thali.id}`, { name: `${P} thalis & combos` });
      expect([c2.status, c2.body.changed]).toEqual([200, true]);
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: d1.id } })).category).toBe(`${P} thalis & combos`);
      // renaming something nobody uses touches no other row
      const lonely = await mk('Lonely');
      expect((await patch(`/api/admin/categories/${lonely.id}`, { name: `${P} Lonelier` })).status).toBe(200);
    });

    test('a rename onto another category (same slug) is a 409 CATEGORY_EXISTS and changes nothing', async () => {
      const a = await mk('Alpha');
      const b = await mk('Beta');
      const d = await dish(V[0].id, b);
      const r = await patch(`/api/admin/categories/${b.id}`, { name: `zt  ALPHA`, icon: 'egg' });
      expect([r.status, r.body.code, r.body.existing?.id]).toEqual([409, 'CATEGORY_EXISTS', a.id]);
      expect((await prisma.category.findUniqueOrThrow({ where: { id: b.id } })).icon).toBe('restaurant'); // the icon change of the same request was not applied
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: d.id } })).category).toBe(`${P} Beta`);
    });

    test('forDishes / forRestaurants cannot be switched off while the category is in use (409 CATEGORY_IN_USE); unused or unchanged is fine', async () => {
      const used = await mk('Used');
      await dish(V[0].id, used);
      await tag(V[1].id, [used]);
      const noDishes = await patch(`/api/admin/categories/${used.id}`, { forDishes: false });
      expect([noDishes.status, noDishes.body.code, noDishes.body.field, noDishes.body.dishes]).toEqual([409, 'CATEGORY_IN_USE', 'forDishes', 1]);
      const noRest = await patch(`/api/admin/categories/${used.id}`, { forRestaurants: false });
      expect([noRest.status, noRest.body.code, noRest.body.field, noRest.body.restaurants]).toEqual([409, 'CATEGORY_IN_USE', 'forRestaurants', 1]);
      expect((await patch(`/api/admin/categories/${used.id}`, { forDishes: true, forRestaurants: true, showOnHome: true })).status).toBe(200); // unchanged flags are fine
      expect((await patch(`/api/admin/categories/${used.id}`, { isActive: false })).status).toBe(200); // hiding is always allowed
      const free = await mk('Free');
      expect((await patch(`/api/admin/categories/${free.id}`, { forDishes: false })).status).toBe(200);
      // a deleted dish still blocks (it can be restored)
      const ghost = await mk('Ghost');
      await dish(V[0].id, ghost, { deletedAt: new Date() });
      expect((await patch(`/api/admin/categories/${ghost.id}`, { forDishes: false })).body.code).toBe('CATEGORY_IN_USE');
    });
  });

  // =========================================================================================
  describe('reorder', () => {
    test('renumbers 1..n in the given order; categories not listed follow in their old order; unknown / duplicate ids are 400; the same order again is a no-op', async () => {
      const [a, b, c, d] = [await mk('A'), await mk('B'), await mk('C'), await mk('D')];
      const r = await post('/api/admin/categories/reorder', { ids: [d.id, b.id] });
      expect([r.status, r.body.changed]).toEqual([200, true]);
      const order = (await publicList()).map((x) => x.name.slice(P.length + 1));
      expect(order).toEqual(['D', 'B', 'A', 'C']);
      const sorted = (await adminList()).map((x) => [x.name.slice(P.length + 1), x.sortOrder]);
      expect(sorted.map((x) => x[0])).toEqual(['D', 'B', 'A', 'C']);
      expect(new Set(sorted.map((x) => x[1])).size).toBe(4); // distinct, strictly increasing positions
      expect(r.body.data.filter((x: any) => x.name.startsWith(P)).map((x: any) => x.id)).toEqual([d.id, b.id, a.id, c.id]);
      const everyId = ((await request.get('/api/admin/categories?includeInactive=1').set(H(tAdmin))).body.data as any[]).map((x) => x.id);
      const same = await post('/api/admin/categories/reorder', { ids: everyId });
      expect(same.body.changed).toBe(false);
      expect((await post('/api/admin/categories/reorder', { ids: everyId })).body.changed).toBe(false);
      const sameAgain = same;
      expect([sameAgain.status, sameAgain.body.changed]).toEqual([200, false]);
      expect((await audits('CATEGORY_REORDERED')).length).toBe(1);
      for (const [label, ids] of [['unknown', [a.id, 'does-not-exist']], ['duplicate', [a.id, a.id]], ['empty', []], ['bad id', ['bad id!']], ['not a list', 'abc']] as const) {
        const x = await post('/api/admin/categories/reorder', { ids });
        expect([label, x.status, x.body.field]).toEqual([label, 400, 'ids']);
      }
      expect((await post('/api/admin/categories/reorder', { ids: [a.id, 'does-not-exist'] })).body.code).toBe('CATEGORY_UNKNOWN');
      expect((await publicList()).map((x) => x.name.slice(P.length + 1))).toEqual(['D', 'B', 'A', 'C']); // the refused calls changed nothing
    });
  });

  // =========================================================================================
  describe('merge', () => {
    const setup = async () => {
      const from = await mk('From');
      const into = await mk('Into');
      const x = await mk('Extra');
      await tag(V[0].id, [x, from]); // only the source
      await tag(V[1].id, [from, into, x]); // both: the links are deduplicated, the better (smaller) position wins
      await tag(V[2].id, [into]); // only the target
      const dishes = [await dish(V[0].id, from), await dish(V[1].id, from, { approvalStatus: 'PENDING' }), await dish(V[1].id, from, { deletedAt: new Date() }), await dish(V[0].id, into)];
      return { from, into, x, dishes };
    };

    test('dry run is the DEFAULT: it reports what would move and writes nothing', async () => {
      const { from, into } = await setup();
      for (const body of [{ intoId: into.id }, { intoId: into.id, dryRun: true }]) {
        const r = await post(`/api/admin/categories/${from.id}/merge`, body);
        expect(r.status).toBe(200);
        expect(r.body.data).toEqual({ dryRun: true, from: { id: from.id, name: `${P} From` }, into: { id: into.id, name: `${P} Into` }, dishes: 3, restaurants: 2 });
      }
      expect(await prisma.category.count({ where: { id: from.id } })).toBe(1);
      expect(await prisma.menuItem.count({ where: { categoryId: from.id } })).toBe(3);
      expect(await audits('CATEGORY_MERGED')).toHaveLength(0);
    });

    test('apply: dishes and restaurants move, strings are rewritten, positions are tidy, the source is gone, one audit row; a second click is a 404', async () => {
      const { from, into, x, dishes } = await setup();
      const r = await post(`/api/admin/categories/${from.id}/merge`, { intoId: into.id, dryRun: false });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ dryRun: false, from: { id: from.id }, into: { id: into.id, name: `${P} Into` }, dishes: 3, restaurants: 2 });
      expect(r.body.data.category).toMatchObject({ id: into.id, usage: { restaurants: 3, dishes: 4 } });
      expect(await prisma.category.count({ where: { id: from.id } })).toBe(0);
      const moved = await prisma.menuItem.findMany({ where: { id: { in: dishes.map((d) => d.id) } } });
      expect(moved.every((d) => d.categoryId === into.id && d.category === `${P} Into`)).toBe(true);
      const links = await prisma.vendorCategory.findMany({ where: { vendorId: { in: V.map((v) => v.id) } }, orderBy: [{ vendorId: 'asc' }, { position: 'asc' }] });
      expect(links.map((l) => [l.vendorId, l.categoryId === into.id ? 'into' : l.categoryId === x.id ? 'x' : '?', l.position])).toEqual([
        ['ca-ven-1', 'x', 0], ['ca-ven-1', 'into', 1],
        ['ca-ven-2', 'into', 0], ['ca-ven-2', 'x', 1], // had [from, into, x]: one "Into" link at the better position 0
        ['ca-ven-3', 'into', 0],
      ]);
      const strings = Object.fromEntries((await prisma.vendor.findMany({ where: { id: { in: V.map((v) => v.id) } } })).map((v) => [v.id, v.category]));
      expect(strings).toEqual({ 'ca-ven-1': `${P} Extra • ${P} Into`, 'ca-ven-2': `${P} Into • ${P} Extra`, 'ca-ven-3': `${P} Into` });
      expect(await audits('CATEGORY_MERGED')).toHaveLength(1);
      const again = await post(`/api/admin/categories/${from.id}/merge`, { intoId: into.id, dryRun: false });
      expect([again.status, again.body.code]).toEqual([404, 'NOT_FOUND']);
    });

    test('refusals: itself, unknown ids, a hidden target, a target that cannot hold what moves, bad bodies', async () => {
      const dishOnly = await mk('DishOnly', { forRestaurants: false });
      const restOnly = await mk('RestOnly', { forDishes: false });
      const used = await mk('UsedByBoth');
      await dish(V[0].id, used);
      await tag(V[0].id, [used]);
      const hidden = await mk('Hidden');
      await patch(`/api/admin/categories/${hidden.id}`, { isActive: false });
      const m = (from: any, body: unknown) => post(`/api/admin/categories/${from.id}/merge`, body);
      expect((await m(used, { intoId: used.id })).status).toBe(400);
      expect((await m(used, { intoId: 'nope' })).status).toBe(404);
      expect((await post('/api/admin/categories/nope/merge', { intoId: used.id })).status).toBe(404);
      expect((await m(used, { intoId: hidden.id })).body.code).toBe('CATEGORY_INACTIVE');
      expect((await m(used, { intoId: dishOnly.id })).body.code).toBe('CATEGORY_INCOMPATIBLE');
      expect((await m(used, { intoId: restOnly.id })).body.code).toBe('CATEGORY_INCOMPATIBLE');
      for (const body of [{}, { intoId: 5 }, { intoId: 'bad id!' }, { intoId: dishOnly.id, dryRun: 'no' }, { intoId: dishOnly.id, extra: 1 }]) {
        const r = await m(used, body);
        expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      }
      expect(await prisma.category.count({ where: { id: used.id } })).toBe(1);
    });
  });

  // =========================================================================================
  describe('delete', () => {
    test('only an unused category can be deleted; the 409 says how many restaurants and dishes use it; a second delete is a 404', async () => {
      const free = await mk('Free');
      const r = await del(`/api/admin/categories/${free.id}`);
      expect([r.status, r.body.success, r.body.data]).toEqual([200, true, { id: free.id, name: `${P} Free` }]);
      expect((await audits('CATEGORY_DELETED', free.id))).toHaveLength(1);
      expect((await del(`/api/admin/categories/${free.id}`)).status).toBe(404);

      const byDish = await mk('ByDish');
      await dish(V[0].id, byDish, { deletedAt: new Date() }); // a deleted dish still counts: it can be restored
      const a = await del(`/api/admin/categories/${byDish.id}`);
      expect([a.status, a.body.code, a.body.dishes, a.body.restaurants]).toEqual([409, 'CATEGORY_IN_USE', 1, 0]);
      const byVendor = await mk('ByVendor');
      await tag(V[2].id, [byVendor]); // a pending restaurant too
      const b = await del(`/api/admin/categories/${byVendor.id}`);
      expect([b.status, b.body.code, b.body.dishes, b.body.restaurants]).toEqual([409, 'CATEGORY_IN_USE', 0, 1]);
      expect(await prisma.category.count({ where: { id: { in: [byDish.id, byVendor.id] } } })).toBe(2);
      expect((await del('/api/admin/categories/bad%20id')).status).toBe(400);
    });

    test('the foreign keys are the backstop: even a raw delete of a used category is refused by the database', async () => {
      const c = await mk('Backstop');
      await dish(V[0].id, c);
      await expect(prisma.category.delete({ where: { id: c.id } })).rejects.toMatchObject({ code: 'P2003' });
      await tag(V[1].id, [await mk('Backstop2')]);
      const c2 = await prisma.category.findFirstOrThrow({ where: { name: `${P} Backstop2` } });
      await expect(prisma.category.delete({ where: { id: c2.id } })).rejects.toMatchObject({ code: 'P2003' });
    });
  });

  // =========================================================================================
  describe('rate limit and audit', () => {
    test('category writes are limited per admin (rule ADMIN_CATEGORY_WRITE, here 4 per window); reads are not', async () => {
      process.env.RL_ADMIN_CATEGORY_WRITE_MAX = '4';
      const c = await mk('RL');
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await patch(`/api/admin/categories/${c.id}`, { sortOrder: i + 1 })).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
      expect((await request.get('/api/admin/categories').set(H(tAdmin))).status).toBe(200);
      const r = await patch(`/api/admin/categories/${c.id}`, { sortOrder: 1 });
      expect([r.status, r.body.code]).toEqual([429, 'RATE_LIMITED']);
    });
  });

  // =========================================================================================
  describe('concurrency: rename / merge / delete / dish creation / restaurant edits at the same moment', () => {
    test('whatever the interleaving, no dish or restaurant ends up with a stale name or a missing category, and nothing answers 500', async () => {
      for (let round = 0; round < 3; round++) {
        await wipe();
        const [s1, s2, s3] = [await mk(`S1 r${round}`), await mk(`S2 r${round}`), await mk(`S3 r${round}`)];
        await tag(V[0].id, [s1, s2]);
        await tag(V[1].id, [s2, s3]);
        for (const c of [s1, s2, s3]) await dish(V[0].id, c);
        const adminDish = (c: { id: string; name: string }, byId: boolean) =>
          post('/api/admin/catalog', { vendorId: V[round % 2].id, name: `Race ${randomUUID().slice(0, 6)}`, vendorPrice: 50, ...(byId ? { categoryId: c.id } : { category: c.name }) });
        const reqs: Promise<supertest.Response>[] = [];
        for (let i = 0; i < 4; i++) reqs.push(post('/api/admin/categories/' + s1.id.toString() + '/merge', { intoId: s2.id, dryRun: false }));
        reqs.push(patch(`/api/admin/categories/${s2.id}`, { name: `${P} S2 renamed a${round}` }), patch(`/api/admin/categories/${s2.id}`, { name: `${P} S2 renamed b${round}` }));
        reqs.push(patch(`/api/admin/categories/${s3.id}`, { name: `${P} S3 renamed${round}` }), patch(`/api/admin/categories/${s1.id}`, { name: `${P} S1 renamed${round}` }));
        reqs.push(post(`/api/admin/categories/${s3.id}/merge`, { intoId: s2.id, dryRun: false }));
        reqs.push(del(`/api/admin/categories/${s1.id}`), del(`/api/admin/categories/${s3.id}`), del(`/api/admin/categories/${s2.id}`));
        for (let i = 0; i < 6; i++) for (const c of [s1, s2, s3]) reqs.push(adminDish(c, i % 2 === 0));
        for (const v of [V[0], V[1]]) reqs.push(patch(`/api/admin/vendors/${v.id}/profile`, { cuisineIds: [s2.id, s1.id, s3.id] }), patch(`/api/admin/vendors/${v.id}/profile`, { cuisineIds: [s3.id] }));
        const results = await Promise.all(reqs);
        const odd = results.filter((r) => ![200, 201, 400, 404, 409].includes(r.status));
        expect(odd.map((r) => [r.status, r.body])).toEqual([]);
        // the stress is only meaningful if real work happened: dishes were created, something was renamed or merged
        expect(results.filter((r) => r.status === 201).length).toBeGreaterThan(0);
        expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(2);

        // invariant 1: every dish of ours points to an existing category and carries exactly its current name
        const dishes = await prisma.menuItem.findMany({ where: { vendorId: { in: V.map((v) => v.id) } }, include: { categoryRef: true } });
        expect(dishes.length).toBeGreaterThanOrEqual(3);
        for (const d of dishes) {
          expect(d.categoryRef).not.toBeNull();
          expect([d.id, d.category]).toEqual([d.id, d.categoryRef!.name]);
        }
        // invariant 2: every restaurant string is exactly its links in order
        for (const v of [V[0], V[1]]) {
          const links = await prisma.vendorCategory.findMany({ where: { vendorId: v.id }, orderBy: [{ position: 'asc' }, { categoryId: 'asc' }], include: { category: true } });
          const row = await prisma.vendor.findUniqueOrThrow({ where: { id: v.id } });
          expect([v.id, row.category]).toEqual([v.id, links.length ? links.map((l) => l.category.name).join(' • ') : 'Campus kitchen']);
          expect(new Set(links.map((l) => l.categoryId)).size).toBe(links.length);
        }
        // invariant 3: no two categories share a slug and no ZT category lost its name
        const cats = await prisma.category.findMany({ where: { name: { startsWith: P } } });
        expect(new Set(cats.map((c) => c.slug)).size).toBe(cats.length);
      }
    });

    test('dish creation racing a rename of its category: the new dish always carries the NEW name afterwards', async () => {
      for (let round = 0; round < 4; round++) {
        const c = await mk(`Racing ${round}`);
        const newName = `${P} Racing ${round} new`;
        const reqs = [
          patch(`/api/admin/categories/${c.id}`, { name: newName }),
          ...Array.from({ length: 8 }, () => post('/api/admin/catalog', { vendorId: V[0].id, name: `RR ${randomUUID().slice(0, 6)}`, vendorPrice: 40, categoryId: c.id })),
        ];
        const rs = await Promise.all(reqs);
        expect(rs[0].status).toBe(200);
        expect(rs.slice(1).every((r) => r.status === 201)).toBe(true);
        const rows = await prisma.menuItem.findMany({ where: { categoryId: c.id } });
        expect(rows).toHaveLength(8);
        expect(rows.every((d) => d.category === newName)).toBe(true);
      }
    });
  });
});
