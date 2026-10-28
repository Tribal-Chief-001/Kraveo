/**
 * Per-restaurant menu order (Docs/26 section 3). Real PostgreSQL, real HTTP endpoints.
 * Covers: the one dish order (sortOrder, createdAt, id) in EVERY dish-listing payload, legacy rows unchanged, default position of new dishes,
 * import `position`, PUT /admin/vendors/:id/menu-order (sections, dishes, errors, idempotency, caps, audit, rate limit), `position` on dish edit,
 * concurrency (menu order vs dish create vs import vs position edit: no deadlock, no duplicate positions after a rewrite), the migration on rows.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { invalidateSettingsCache } from '../../src/services/settings';
import { layoutSections, assignSortOrder } from '../../src/services/menuOrder';

jest.setTimeout(120_000);

const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const O1 = { id: 'usr-mo-v1', phone: '+91 9999851111', vendorId: 'mo-ven-1' };
const O2 = { id: 'usr-mo-v2', phone: '+91 9999852222', vendorId: 'mo-ven-2' };
const O3 = { id: 'usr-mo-v3', phone: '+91 9999853333', vendorId: 'mo-ven-3' };
const VENDORS = [O1, O2, O3].map((o) => o.vendorId);
const H = (t: string) => getAuthHeader(t);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tO1 = getVendorToken(O1.id, O1.phone);
const tO2 = getVendorToken(O2.id, O2.phone);

const CAP = process.env.CUT_CAPTURE_DIR;
const cap = (name: string, body: unknown) => { if (CAP) fs.writeFileSync(path.join(CAP, `${name}.json`), JSON.stringify(body, null, 2)); };

describe('Menu order (Docs/26 section 3)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let clock = 0;

  const adminGet = (p: string) => request.get(p).set(H(tAdmin));
  const adminPost = (p: string, body: unknown = {}) => request.post(p).set(H(tAdmin)).send(body as any);
  const adminPatch = (p: string, body: unknown = {}) => request.patch(p).set(H(tAdmin)).send(body as any);
  const putOrder = (vendorId: string, body: unknown, token = tAdmin) => request.put(`/api/admin/vendors/${vendorId}/menu-order`).set(H(token)).send(body as any);
  const imp = (vendorId: string, rows: unknown[], extra: Record<string, unknown> = {}) => adminPost(`/api/admin/vendors/${vendorId}/menu-import`, { rows, ...extra });
  const wipe = () => prisma.menuItem.deleteMany({ where: { vendorId: { in: VENDORS } } });
  /** A dish straight in the table (so sortOrder / createdAt are exactly what the test says). createdAt strictly increases per call. */
  const mk = (vendorId: string, name: string, category: string, extra: Record<string, unknown> = {}) =>
    prisma.menuItem.create({
      data: { vendorId, name, category, price: 10, vendorPrice: 10, description: 'd', imageUrl: '', createdAt: new Date(Date.UTC(2026, 0, 1) + ++clock * 1000), ...extra } as any,
    });
  const names = (rows: { name: string }[]) => rows.map((r) => r.name);
  const dbOrder = async (vendorId: string) => (await prisma.menuItem.findMany({ where: { vendorId, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })).map((d) => d.name);
  const sortOrders = async (vendorId: string) => Object.fromEntries((await prisma.menuItem.findMany({ where: { vendorId } })).map((d) => [d.name, d.sortOrder]));
  const idsOf = async (vendorId: string) => Object.fromEntries((await prisma.menuItem.findMany({ where: { vendorId } })).map((d) => [d.name, d.id]));

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    for (const o of [O1, O2, O3]) {
      await prisma.user.upsert({ where: { id: o.id }, update: {}, create: { id: o.id, name: `MO Owner ${o.vendorId}`, phone: o.phone, role: Role.VENDOR } });
      await prisma.vendor.upsert({
        where: { id: o.vendorId },
        update: { userId: o.id, approvalStatus: 'APPROVED', commissionType: null, commissionValue: null, isAcceptingOrders: true, name: `MO Kitchen ${o.vendorId.slice(-1)}` },
        create: { id: o.vendorId, userId: o.id, name: `MO Kitchen ${o.vendorId.slice(-1)}`, category: 'Test', address: 'Gate', bannerImage: '', approvalStatus: 'APPROVED' },
      });
    }
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    __resetRateLimits();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    await wipe();
  });

  afterAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    await wipe();
    await prisma.vendor.deleteMany({ where: { id: { in: VENDORS } } });
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('the one dish order in every payload', () => {
    /** Every payload that lists the dishes of ONE restaurant, as the names in the order the API gave them. */
    const allPayloads = async (o: typeof O1, token: string) => {
      const out: Record<string, string[]> = {};
      out['public /menus'] = names((await request.get(`/api/menus/${o.vendorId}`)).body.data);
      out['public /vendors/:id menu'] = names((await request.get(`/api/vendors/${o.vendorId}`)).body.data.menu);
      out['public /vendors/:id menuItems'] = names((await request.get(`/api/vendors/${o.vendorId}`)).body.data.menuItems);
      out['public /vendors'] = names((await request.get('/api/vendors')).body.data.find((v: any) => v.id === o.vendorId).menuItems);
      out['student /vendors'] = names((await request.get('/api/vendors').set(H(tStudent))).body.data.find((v: any) => v.id === o.vendorId).menuItems);
      out['owner /menus'] = names((await request.get(`/api/menus/${o.vendorId}`).set(H(token))).body.data);
      out['owner menu-manage'] = names((await request.get(`/api/vendors/${o.vendorId}/menu-manage`).set(H(token))).body.data);
      out['owner /vendors/:id'] = names((await request.get(`/api/vendors/${o.vendorId}`).set(H(token))).body.data.menuItems);
      out['owner /vendors'] = names((await request.get('/api/vendors').set(H(token))).body.data.find((v: any) => v.id === o.vendorId).menuItems);
      out['admin /menus'] = names((await adminGet(`/api/menus/${o.vendorId}`)).body.data);
      out['admin /vendors/:id'] = names((await adminGet(`/api/vendors/${o.vendorId}`)).body.data.menuItems);
      out['admin /vendors'] = names((await adminGet('/api/vendors')).body.data.find((v: any) => v.id === o.vendorId).menuItems);
      out['admin catalog?vendorId'] = names((await adminGet(`/api/admin/catalog?vendorId=${o.vendorId}&pageSize=100`)).body.data);
      out['admin catalog?vendorId&status=ALL'] = names((await adminGet(`/api/admin/catalog?vendorId=${o.vendorId}&status=ALL&pageSize=100`)).body.data);
      out['admin catalog?vendorId&status=LIVE'] = names((await adminGet(`/api/admin/catalog?vendorId=${o.vendorId}&status=LIVE&pageSize=100`)).body.data);
      return out;
    };

    test('LEGACY rows (all sortOrder 0): every payload lists them oldest first, ties by id: exactly what the restaurant had before', async () => {
      const t = new Date(Date.UTC(2026, 3, 1));
      await mk(O1.vendorId, 'Old 1', 'Main Course');
      await mk(O1.vendorId, 'Old 2', 'Snacks');
      await mk(O1.vendorId, 'Old 3', 'Main Course');
      // two dishes with the SAME createdAt: the id decides, in every payload, in every call
      await prisma.menuItem.createMany({ data: [
        { id: 'zz-tie-b', vendorId: O1.vendorId, name: 'Tie B', category: 'Snacks', price: 5, vendorPrice: 5, description: 'd', imageUrl: '', createdAt: t },
        { id: 'zz-tie-a', vendorId: O1.vendorId, name: 'Tie A', category: 'Snacks', price: 5, vendorPrice: 5, description: 'd', imageUrl: '', createdAt: t },
      ] });
      // (the two tie rows are newer than the three above: they come last, A before B)
      const expected = ['Old 1', 'Old 2', 'Old 3', 'Tie A', 'Tie B'];
      const sorted = (await prisma.menuItem.findMany({ where: { vendorId: O1.vendorId } })).every((d) => d.sortOrder === 0);
      expect(sorted).toBe(true);
      for (let round = 0; round < 3; round++) {
        for (const [what, got] of Object.entries(await allPayloads(O1, tO1))) expect([what, got]).toEqual([what, expected]);
      }
    });

    test('with positions: sortOrder wins, then createdAt, then id; every payload agrees; pages of the admin list never overlap', async () => {
      await mk(O1.vendorId, 'P30', 'Main Course', { sortOrder: 30 });
      await mk(O1.vendorId, 'P10', 'Snacks', { sortOrder: 10 });
      await mk(O1.vendorId, 'P20 older', 'Main Course', { sortOrder: 20 });
      await mk(O1.vendorId, 'P20 newer', 'Snacks', { sortOrder: 20 });
      await mk(O1.vendorId, 'Legacy 0', 'Desserts'); // sortOrder 0 sorts FIRST (documented: 0 = unordered, kept as is)
      const expected = ['Legacy 0', 'P10', 'P20 older', 'P20 newer', 'P30'];
      for (const [what, got] of Object.entries(await allPayloads(O1, tO1))) expect([what, got]).toEqual([what, expected]);
      const seen: string[] = [];
      for (const page of [1, 2, 3]) seen.push(...names((await adminGet(`/api/admin/catalog?vendorId=${O1.vendorId}&pageSize=2&page=${page}`)).body.data));
      expect(seen).toEqual(expected);
    });

    test('hidden dishes follow the same rules as before: pending ones only for the owner / admin, deleted ones nowhere; order unaffected', async () => {
      await mk(O1.vendorId, 'Live B', 'Main Course', { sortOrder: 20 });
      await mk(O1.vendorId, 'Pending A', 'Main Course', { sortOrder: 10, approvalStatus: 'PENDING' });
      await mk(O1.vendorId, 'Gone', 'Main Course', { sortOrder: 5, deletedAt: new Date() });
      await mk(O1.vendorId, 'Live C', 'Main Course', { sortOrder: 30 });
      const p = await allPayloads(O1, tO1);
      expect(p['public /menus']).toEqual(['Live B', 'Live C']);
      expect(p['student /vendors']).toEqual(['Live B', 'Live C']);
      expect(p['owner menu-manage']).toEqual(['Pending A', 'Live B', 'Live C']);
      expect(p['admin /menus']).toEqual(['Pending A', 'Live B', 'Live C']);
      expect(p['admin catalog?vendorId']).toEqual(['Pending A', 'Live B', 'Live C']);
    });

    test('the customer payload carries sortOrder; the owner payload does not', async () => {
      await mk(O1.vendorId, 'Shown', 'Main Course', { sortOrder: 40 });
      const pub = (await request.get(`/api/menus/${O1.vendorId}`)).body.data[0];
      expect(pub.sortOrder).toBe(40);
      const own = (await request.get(`/api/vendors/${O1.vendorId}/menu-manage`).set(H(tO1))).body.data[0];
      expect('sortOrder' in own).toBe(false);
      const adminRow = (await adminGet(`/api/admin/catalog?vendorId=${O1.vendorId}`)).body.data[0];
      expect(adminRow.sortOrder).toBe(40);
    });
  });

  // =========================================================================================
  describe('where new dishes go', () => {
    test('a new dish goes last: legacy-only restaurant gets 10, then 20, 30; a restaurant-created (pending) dish too; deleted dishes count', async () => {
      await mk(O1.vendorId, 'Legacy A', 'Main Course');
      const a = await adminPost('/api/admin/catalog', { vendorId: O1.vendorId, name: 'New A', vendorPrice: 50, category: 'Main Course' });
      expect(a.body.data.sortOrder).toBe(10);
      const b = await adminPost('/api/admin/catalog', { vendorId: O1.vendorId, name: 'New B', vendorPrice: 50, category: 'Snacks' });
      expect(b.body.data.sortOrder).toBe(20);
      const c = await request.post(`/api/vendors/${O1.vendorId}/items`).set(H(tO1)).send({ name: 'Owner C', price: 40, category: 'Main Course', description: 'd' });
      expect(c.status).toBe(201);
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: c.body.data.id } })).sortOrder).toBe(30);
      await adminPatch(`/api/admin/catalog/${b.body.data.id}`, { description: 'x' });
      await request.delete(`/api/admin/catalog/${c.body.data.id}`).set(H(tAdmin));
      const d = await adminPost('/api/admin/catalog', { vendorId: O1.vendorId, name: 'New D', vendorPrice: 50, category: 'Main Course' });
      expect(d.body.data.sortOrder).toBe(40); // the deleted dish's 30 still counts: a restore can never land in front of a newer dish
      expect(await dbOrder(O1.vendorId)).toEqual(['Legacy A', 'New A', 'New B', 'New D']);
      // another restaurant is not touched
      expect(await prisma.menuItem.count({ where: { vendorId: O2.vendorId } })).toBe(0);
      const other = await adminPost('/api/admin/catalog', { vendorId: O2.vendorId, name: 'Other', vendorPrice: 50, category: 'Main Course' });
      expect(other.body.data.sortOrder).toBe(10);
    });

    test('parallel creates in one restaurant get distinct, increasing positions (the restaurant row serialises them)', async () => {
      const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => adminPost('/api/admin/catalog', { vendorId: O1.vendorId, name: `Par ${i}`, vendorPrice: 10 + i, category: 'Main Course' })));
      expect(rs.map((r) => r.status)).toEqual(Array(12).fill(201));
      const so = rs.map((r) => r.body.data.sortOrder).sort((a, b) => a - b);
      expect(so).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) * 10));
    });
  });

  // =========================================================================================
  describe('menu import: position', () => {
    test('position x 10; without position the rows go after the last dish in file order; ties keep file order; dry run shows the position', async () => {
      await mk(O1.vendorId, 'Existing', 'Main Course', { sortOrder: 50 });
      const rows = [
        { name: 'File 1', category: 'Main Course', vendorPrice: 10 },
        { name: 'File 2', category: 'Snacks', vendorPrice: 10, position: 3 },
        { name: 'File 3', category: 'Main Course', vendorPrice: 10 },
        { name: 'File 4', category: 'Snacks', vendorPrice: 10, position: 3 }, // same position as File 2: file order decides
        { name: 'File 5', category: 'Main Course', vendorPrice: 10, position: 1 },
      ];
      const dry = await imp(O1.vendorId, rows);
      expect(dry.body.data.rows.map((r: any) => r.sortOrder)).toEqual([60, 30, 70, 30, 10]);
      expect(await prisma.menuItem.count({ where: { vendorId: O1.vendorId } })).toBe(1);
      const applied = await imp(O1.vendorId, rows, { dryRun: false });
      expect(applied.status).toBe(200);
      expect(await dbOrder(O1.vendorId)).toEqual(['File 5', 'File 2', 'File 4', 'Existing', 'File 1', 'File 3']);
      expect(await sortOrders(O1.vendorId)).toEqual({ 'File 1': 60, 'File 2': 30, 'File 3': 70, 'File 4': 30, 'File 5': 10, Existing: 50 });
      cap('import_apply_position', applied.body);
      const listed = names((await request.get(`/api/menus/${O1.vendorId}`)).body.data);
      expect(listed).toEqual(['File 5', 'File 2', 'File 4', 'Existing', 'File 1', 'File 3']);
    });

    test('a fresh restaurant: a file without positions keeps the file order exactly (10, 20, 30 ...)', async () => {
      const rows = ['Z first', 'A second', 'M third', 'B fourth'].map((name) => ({ name, category: 'Main Course', vendorPrice: 10 }));
      await imp(O1.vendorId, rows, { dryRun: false });
      expect(await dbOrder(O1.vendorId)).toEqual(['Z first', 'A second', 'M third', 'B fourth']);
      expect(Object.values(await sortOrders(O1.vendorId)).sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
    });

    test('UPDATE with position moves an existing dish; without position the dish stays where it is; invalid positions are row errors', async () => {
      await imp(O1.vendorId, ['U1', 'U2', 'U3'].map((name) => ({ name, category: 'Main Course', vendorPrice: 10 })), { dryRun: false });
      const up = await imp(O1.vendorId, [
        { name: 'U1', category: 'Main Course', vendorPrice: 10, position: 9 },
        { name: 'U2', category: 'Main Course', vendorPrice: 11 },
        { name: 'U3', category: 'Main Course', vendorPrice: 10 },
      ], { dryRun: false, onDuplicate: 'UPDATE' });
      expect(up.body.data.summary).toMatchObject({ update: 2, skip: 1 });
      expect(await sortOrders(O1.vendorId)).toEqual({ U1: 90, U2: 20, U3: 30 });
      expect(await dbOrder(O1.vendorId)).toEqual(['U2', 'U3', 'U1']);
      for (const position of [0, -1, 1.5, '3', 10_001]) {
        const bad = await imp(O1.vendorId, [{ name: 'Bad Pos', category: 'Main Course', vendorPrice: 10, position }]);
        expect(bad.body.data.rows[0]).toMatchObject({ action: 'invalid', errors: [{ field: 'position' }] });
      }
      expect((await imp(O1.vendorId, [{ name: 'Bad Pos', category: 'Main Course', vendorPrice: 10, position: 10_000 }])).body.data.rows[0]).toMatchObject({ action: 'create', sortOrder: 100_000 });
    });

    test('all or nothing: one invalid row and nothing is written, positions included; the same file twice is idempotent', async () => {
      const rows = [
        { name: 'AN 1', category: 'Main Course', vendorPrice: 10, position: 1 },
        { name: 'AN 2', category: 'Nope Category', vendorPrice: 10, position: 2 },
      ];
      const r = await imp(O1.vendorId, rows, { dryRun: false });
      expect([r.status, r.body.code]).toEqual([400, 'IMPORT_INVALID']);
      expect(await prisma.menuItem.count({ where: { vendorId: O1.vendorId } })).toBe(0);
      const good = [rows[0]];
      expect((await imp(O1.vendorId, good, { dryRun: false })).body.data.summary.create).toBe(1);
      expect((await imp(O1.vendorId, good, { dryRun: false })).body.data.summary).toMatchObject({ create: 0, skip: 1 });
    });
  });

  // =========================================================================================
  describe('PUT /admin/vendors/:id/menu-order', () => {
    /** Main Course: Dal, Paneer, Roti-ish ; Snacks: Samosa, Pakora ; Desserts: Kheer. Created in an interleaved way with legacy 0 positions. */
    const seed = async () => {
      await mk(O1.vendorId, 'Dal', 'Main Course');
      await mk(O1.vendorId, 'Samosa', 'Snacks');
      await mk(O1.vendorId, 'Paneer', 'Main Course');
      await mk(O1.vendorId, 'Kheer', 'Desserts');
      await mk(O1.vendorId, 'Pakora', 'Snacks');
      await mk(O1.vendorId, 'Roti', 'Main Course');
    };

    test('sections: listed first in the given order, the rest keep their relative order after; dishes keep their order; the answer is the section list', async () => {
      await seed();
      const r = await putOrder(O1.vendorId, { sections: ['Desserts', 'Snacks'] });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true, changed: true, message: 'Menu order saved.', count: 3, data: [{ category: 'Desserts', dishCount: 1 }, { category: 'Snacks', dishCount: 2 }, { category: 'Main Course', dishCount: 3 }] });
      cap('menu_order_response', r.body);
      expect(await dbOrder(O1.vendorId)).toEqual(['Kheer', 'Samosa', 'Pakora', 'Dal', 'Paneer', 'Roti']);
      expect(await sortOrders(O1.vendorId)).toEqual({ Kheer: 10, Samosa: 20, Pakora: 30, Dal: 40, Paneer: 50, Roti: 60 });
      for (const [what, got] of Object.entries({
        public: names((await request.get(`/api/menus/${O1.vendorId}`)).body.data),
        owner: names((await request.get(`/api/vendors/${O1.vendorId}/menu-manage`).set(H(tO1))).body.data),
        admin: names((await adminGet(`/api/admin/catalog?vendorId=${O1.vendorId}`)).body.data),
      })) expect([what, got]).toEqual([what, ['Kheer', 'Samosa', 'Pakora', 'Dal', 'Paneer', 'Roti']]);
    });

    test('dishes: listed positions order the dishes inside THEIR section (position is a rank, gaps are fine), unlisted dishes follow in their old order', async () => {
      await seed();
      const ids = await idsOf(O1.vendorId);
      const r = await putOrder(O1.vendorId, { sections: [], dishes: [{ id: ids.Roti, position: 1 }, { id: ids.Dal, position: 7 }, { id: ids.Pakora, position: 2 }] });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([{ category: 'Main Course', dishCount: 3 }, { category: 'Snacks', dishCount: 2 }, { category: 'Desserts', dishCount: 1 }]);
      expect(await dbOrder(O1.vendorId)).toEqual(['Roti', 'Dal', 'Paneer', 'Pakora', 'Samosa', 'Kheer']);
      // equal positions: the old order breaks the tie
      await putOrder(O1.vendorId, { sections: ['Main Course', 'Snacks', 'Desserts'], dishes: [{ id: ids.Paneer, position: 1 }, { id: ids.Roti, position: 1 }] });
      expect(await dbOrder(O1.vendorId)).toEqual(['Roti', 'Paneer', 'Dal', 'Pakora', 'Samosa', 'Kheer']);
    });

    test('names are matched ignoring case and spacing; a listed section the restaurant has no dish in is MENU_ORDER_INVALID, and nothing changes', async () => {
      await seed();
      const ok = await putOrder(O1.vendorId, { sections: ['  snacks ', 'DESSERTS'] });
      expect(ok.status).toBe(200);
      expect(ok.body.data.map((s: any) => s.category)).toEqual(['Snacks', 'Desserts', 'Main Course']);
      const before = await sortOrders(O1.vendorId);
      const bad = await putOrder(O1.vendorId, { sections: ['Snacks', 'Biryani'] });
      expect([bad.status, bad.body.code, bad.body.field]).toEqual([400, 'MENU_ORDER_INVALID', 'sections[1]']);
      expect(bad.body.message).toMatch(/Biryani/);
      cap('error_menu_order_invalid', bad.body);
      expect(await sortOrders(O1.vendorId)).toEqual(before);
      // a section that exists only on a deleted dish does not count
      await prisma.menuItem.updateMany({ where: { vendorId: O1.vendorId, category: 'Desserts' }, data: { deletedAt: new Date() } });
      expect((await putOrder(O1.vendorId, { sections: ['Desserts'] })).body.code).toBe('MENU_ORDER_INVALID');
    });

    test('invalid bodies: wrong types, duplicates, unknown keys, bad positions, other restaurant\'s or deleted or unknown dish ids; all 400 MENU_ORDER_INVALID, nothing written', async () => {
      await seed();
      await mk(O2.vendorId, 'Foreign', 'Main Course');
      const foreign = (await prisma.menuItem.findFirstOrThrow({ where: { vendorId: O2.vendorId } })).id;
      const deleted = await mk(O1.vendorId, 'Deleted', 'Main Course', { deletedAt: new Date() });
      const mine = (await prisma.menuItem.findFirstOrThrow({ where: { vendorId: O1.vendorId, name: 'Dal' } })).id;
      const before = await sortOrders(O1.vendorId);
      const cases: [string, unknown][] = [
        ['no body', {}],
        ['sections not a list', { sections: 'Snacks' }],
        ['section not a string', { sections: [5] }],
        ['empty section name', { sections: ['  '] }],
        ['section listed twice', { sections: ['Snacks', 'snacks'] }],
        ['unknown key', { sections: [], extra: 1 }],
        ['dishes not a list', { sections: [], dishes: 'x' }],
        ['dish not an object', { sections: [], dishes: ['x'] }],
        ['dish with extra key', { sections: [], dishes: [{ id: mine, position: 1, foo: 2 }] }],
        ['bad id', { sections: [], dishes: [{ id: '../x', position: 1 }] }],
        ['position 0', { sections: [], dishes: [{ id: mine, position: 0 }] }],
        ['position 1.5', { sections: [], dishes: [{ id: mine, position: 1.5 }] }],
        ['position string', { sections: [], dishes: [{ id: mine, position: '1' }] }],
        ['position too big', { sections: [], dishes: [{ id: mine, position: 10_001 }] }],
        ['same dish twice', { sections: [], dishes: [{ id: mine, position: 1 }, { id: mine, position: 2 }] }],
        ["another restaurant's dish", { sections: [], dishes: [{ id: foreign, position: 1 }] }],
        ['deleted dish', { sections: [], dishes: [{ id: deleted.id, position: 1 }] }],
        ['unknown dish', { sections: [], dishes: [{ id: randomUUID(), position: 1 }] }],
        ['array body', [] as unknown],
      ];
      for (const [what, body] of cases) {
        const r = await putOrder(O1.vendorId, body);
        expect([what, r.status, r.body.code]).toEqual([what, 400, 'MENU_ORDER_INVALID']);
      }
      expect(await sortOrders(O1.vendorId)).toEqual({ ...before, Deleted: 0 });
      // the foreign restaurant was never touched
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: foreign } })).sortOrder).toBe(0);
    });

    test('caps: more than 60 sections or 400 dishes is refused before any work', async () => {
      await seed();
      expect((await putOrder(O1.vendorId, { sections: Array.from({ length: 61 }, (_, i) => `S${i}`) })).body).toMatchObject({ code: 'MENU_ORDER_INVALID', field: 'sections' });
      const many = Array.from({ length: 401 }, () => ({ id: randomUUID(), position: 1 }));
      expect((await putOrder(O1.vendorId, { sections: [], dishes: many })).body).toMatchObject({ code: 'MENU_ORDER_INVALID', field: 'dishes' });
      // exactly the caps are accepted by the validator (they then fail on the content, not the size)
      expect((await putOrder(O1.vendorId, { sections: Array.from({ length: 60 }, (_, i) => `S${i}`) })).body.message).toMatch(/no dishes in a section called/);
      expect((await putOrder(O1.vendorId, { sections: [], dishes: many.slice(0, 400) })).body.message).toMatch(/does not belong/);
    });

    test('idempotent: the same body twice is changed:false and writes nothing (no audit row, no updatedAt change)', async () => {
      await seed();
      const body = { sections: ['Snacks', 'Main Course', 'Desserts'] };
      const first = await putOrder(O1.vendorId, body);
      expect(first.body.changed).toBe(true);
      const stamp = await prisma.menuItem.findMany({ where: { vendorId: O1.vendorId }, select: { id: true, updatedAt: true } });
      const second = await putOrder(O1.vendorId, body);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ success: true, changed: false, message: 'Nothing to change: the menu already has this order.', data: first.body.data });
      expect(await prisma.menuItem.findMany({ where: { vendorId: O1.vendorId }, select: { id: true, updatedAt: true } })).toEqual(stamp);
      expect(await prisma.adminAuditLog.count({ where: { action: 'MENU_ORDER_SET', targetId: O1.vendorId } })).toBe(1);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'MENU_ORDER_SET' } });
      expect(audit.summary).toMatch(/menu order of MO Kitchen 1: 6 dishes in 3 sections \(6 positions rewritten\)/);
      // a body that already matches the legacy order still writes once (0 -> 10, 20 ...), then is stable
      await wipe();
      await mk(O1.vendorId, 'Only 1', 'Main Course');
      expect((await putOrder(O1.vendorId, { sections: ['Main Course'] })).body.changed).toBe(true);
      expect((await putOrder(O1.vendorId, { sections: ['Main Course'] })).body.changed).toBe(false);
    });

    test('rewrites exactly the non-deleted dishes of THIS restaurant: deleted dishes and other restaurants keep their numbers; pending dishes are ordered too', async () => {
      await seed();
      await mk(O1.vendorId, 'Hidden Pending', 'Desserts', { approvalStatus: 'PENDING' });
      await mk(O1.vendorId, 'Deleted', 'Desserts', { deletedAt: new Date(), sortOrder: 77 });
      await mk(O2.vendorId, 'Other A', 'Snacks', { sortOrder: 5 });
      await mk(O2.vendorId, 'Other B', 'Main Course', { sortOrder: 6 });
      await putOrder(O1.vendorId, { sections: ['Desserts'] });
      const so = await sortOrders(O1.vendorId);
      expect(so.Deleted).toBe(77);
      expect(await dbOrder(O1.vendorId)).toEqual(['Kheer', 'Hidden Pending', 'Dal', 'Paneer', 'Roti', 'Samosa', 'Pakora']);
      expect(await sortOrders(O2.vendorId)).toEqual({ 'Other A': 5, 'Other B': 6 });
      // after a rewrite every non-deleted dish has its own position: 10, 20 ... n x 10, no duplicate, no gap
      expect(Object.entries(so).filter(([n]) => n !== 'Deleted').map(([, v]) => v).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 60, 70]);
      // restoring the deleted dish puts it by its old number (77: last)
      await prisma.menuItem.update({ where: { id: (await idsOf(O1.vendorId)).Deleted }, data: { deletedAt: null } });
      expect((await dbOrder(O1.vendorId)).slice(-1)).toEqual(['Deleted']);
    });

    test('a restaurant with no dishes: an empty list is fine (changed:false); unknown restaurant 404; bad id 400', async () => {
      const empty = await putOrder(O3.vendorId, { sections: [] });
      expect(empty.body).toMatchObject({ success: true, changed: false, count: 0, data: [] });
      const nope = await putOrder('does-not-exist', { sections: [] });
      expect([nope.status, nope.body.code]).toEqual([404, 'NOT_FOUND']);
      expect((await putOrder('bad id!', { sections: [] })).status).toBe(400);
    });

    test('who may call it: admins only (401 anonymous, 403 owner, student)', async () => {
      await seed();
      const before = await sortOrders(O1.vendorId);
      expect((await request.put(`/api/admin/vendors/${O1.vendorId}/menu-order`).send({ sections: [] })).status).toBe(401);
      for (const t of [tO1, tO2, tStudent]) expect((await putOrder(O1.vendorId, { sections: ['Snacks'] }, t)).status).toBe(403);
      expect(await sortOrders(O1.vendorId)).toEqual(before);
    });

    test('rate limited per admin', async () => {
      process.env.RL_ADMIN_MENU_ORDER_MAX = '3';
      __resetRateLimits();
      await seed();
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await putOrder(O1.vendorId, { sections: [] })).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    });

    test('section order is also what a customer would derive: first appearance of each category in the served order', async () => {
      await seed();
      await putOrder(O1.vendorId, { sections: ['Snacks', 'Desserts'] });
      const served = (await request.get(`/api/menus/${O1.vendorId}`)).body.data as { category: string; sortOrder: number }[];
      const firstSeen: string[] = [];
      for (const d of served) if (!firstSeen.includes(d.category)) firstSeen.push(d.category);
      expect(firstSeen).toEqual(['Snacks', 'Desserts', 'Main Course']);
      expect(served.every((d, i) => i === 0 || d.sortOrder > served[i - 1].sortOrder)).toBe(true);
    });
  });

  // =========================================================================================
  describe('admin dish edit: position', () => {
    test('moves the dish inside its section; positions beyond the end mean last; other sections keep their order', async () => {
      await mk(O1.vendorId, 'A1', 'Main Course');
      await mk(O1.vendorId, 'B1', 'Snacks');
      await mk(O1.vendorId, 'A2', 'Main Course');
      await mk(O1.vendorId, 'A3', 'Main Course');
      await mk(O1.vendorId, 'B2', 'Snacks');
      const ids = await idsOf(O1.vendorId);
      const r = await adminPatch(`/api/admin/catalog/${ids.A3}`, { position: 1 });
      expect(r.status).toBe(200);
      expect(await dbOrder(O1.vendorId)).toEqual(['A3', 'A1', 'A2', 'B1', 'B2']);
      await adminPatch(`/api/admin/catalog/${ids.A3}`, { position: 99 });
      expect(await dbOrder(O1.vendorId)).toEqual(['A1', 'A2', 'A3', 'B1', 'B2']);
      await adminPatch(`/api/admin/catalog/${ids.B2}`, { position: 1 });
      expect(await dbOrder(O1.vendorId)).toEqual(['A1', 'A2', 'A3', 'B2', 'B1']);
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: ids.B2 } })).sortOrder).toBe(40);
      // the same position again: the order is the same, nothing is rewritten (the dish itself is still "edited")
      const before = await sortOrders(O1.vendorId);
      await adminPatch(`/api/admin/catalog/${ids.B2}`, { position: 1 });
      expect(await sortOrders(O1.vendorId)).toEqual(before);
      // position together with other fields
      const both = await adminPatch(`/api/admin/catalog/${ids.A1}`, { position: 2, description: 'moved' });
      expect(both.body.data).toMatchObject({ description: 'moved', sortOrder: 20 });
      expect(await dbOrder(O1.vendorId)).toEqual(['A2', 'A1', 'A3', 'B2', 'B1']);
    });

    test('position with a category change lands in the new section at that place', async () => {
      await mk(O1.vendorId, 'M1', 'Main Course');
      await mk(O1.vendorId, 'S1', 'Snacks');
      await mk(O1.vendorId, 'S2', 'Snacks');
      const ids = await idsOf(O1.vendorId);
      const r = await adminPatch(`/api/admin/catalog/${ids.M1}`, { category: 'Snacks', position: 2 });
      expect(r.status).toBe(200);
      expect(r.body.data.category).toBe('Snacks');
      expect(await dbOrder(O1.vendorId)).toEqual(['S1', 'M1', 'S2']);
    });

    test('invalid positions are 400, a deleted dish is 409, an unknown dish 404; nothing changes', async () => {
      await mk(O1.vendorId, 'X1', 'Main Course');
      const d = await mk(O1.vendorId, 'Gone', 'Main Course', { deletedAt: new Date() });
      const ids = await idsOf(O1.vendorId);
      for (const position of [0, -2, 1.5, '2', null, 10_001]) {
        const r = await adminPatch(`/api/admin/catalog/${ids.X1}`, { position });
        expect([position, r.status, r.body.field]).toEqual([position, 400, 'position']);
      }
      expect((await adminPatch(`/api/admin/catalog/${d.id}`, { position: 1 })).status).toBe(409);
      expect((await adminPatch(`/api/admin/catalog/${randomUUID()}`, { position: 1 })).status).toBe(404);
      expect(await sortOrders(O1.vendorId)).toEqual({ X1: 0, Gone: 0 });
      expect((await adminPatch(`/api/admin/catalog/${ids.X1}`, {})).status).toBe(400);
    });
  });

  // =========================================================================================
  describe('concurrency', () => {
    test('menu-order, dish create, import and position edit at the same time: no deadlock, no 5xx, every dish exactly once; one more rewrite leaves unique positions', async () => {
      const base = ['Dal', 'Samosa', 'Paneer', 'Kheer', 'Pakora', 'Roti'].map((n, i) => mk(O1.vendorId, n, ['Main Course', 'Snacks', 'Main Course', 'Desserts', 'Snacks', 'Main Course'][i]));
      await Promise.all(base);
      const ids = await idsOf(O1.vendorId);
      const sections = [['Desserts', 'Snacks'], ['Snacks', 'Main Course', 'Desserts'], ['Main Course'], []];
      const jobs: Promise<supertest.Response>[] = [];
      for (let i = 0; i < 24; i++) {
        const kind = i % 4;
        if (kind === 0) jobs.push(putOrder(O1.vendorId, { sections: sections[i % sections.length], dishes: [{ id: ids.Roti, position: (i % 3) + 1 }] }));
        else if (kind === 1) jobs.push(adminPost('/api/admin/catalog', { vendorId: O1.vendorId, name: `Storm ${i}`, vendorPrice: 20, category: ['Main Course', 'Snacks', 'Desserts'][i % 3] }));
        else if (kind === 2) jobs.push(imp(O1.vendorId, [{ name: `Imp ${i}`, category: 'Snacks', vendorPrice: 10, position: (i % 5) + 1 }, { name: `Imp ${i}b`, category: 'Main Course', vendorPrice: 10 }], { dryRun: false }));
        else jobs.push(adminPatch(`/api/admin/catalog/${ids[['Dal', 'Samosa', 'Paneer', 'Kheer', 'Pakora', 'Roti'][i % 6]]}`, { position: (i % 4) + 1 }));
      }
      const res = await Promise.all(jobs);
      const bad = res.filter((r) => r.status >= 500 || r.status === 409 || r.status === 400);
      expect(bad.map((r) => [r.status, r.body.code, r.body.message])).toEqual([]);
      const total = await prisma.menuItem.count({ where: { vendorId: O1.vendorId } });
      expect(total).toBe(6 + 6 + 12);
      // the listing is total and stable: the same twice, every dish once
      const a = names((await request.get(`/api/menus/${O1.vendorId}`)).body.data);
      const b = names((await request.get(`/api/menus/${O1.vendorId}`)).body.data);
      expect(a).toEqual(b);
      expect(new Set(a).size).toBe(total);
      expect(a).toEqual(await dbOrder(O1.vendorId));
      // one final rewrite makes every position unique and gap free, and it is idempotent
      const fin = await putOrder(O1.vendorId, { sections: ['Main Course', 'Snacks', 'Desserts'] });
      expect(fin.status).toBe(200);
      expect(Object.values(await sortOrders(O1.vendorId)).sort((x, y) => x - y)).toEqual(Array.from({ length: total }, (_, i) => (i + 1) * 10));
      expect((await putOrder(O1.vendorId, { sections: ['Main Course', 'Snacks', 'Desserts'] })).body.changed).toBe(false);
    });

    test('two menu-orders racing: the result is one of the two bodies, never a mix; both answer 200', async () => {
      for (const [n, c] of [['a1', 'Main Course'], ['a2', 'Main Course'], ['b1', 'Snacks'], ['b2', 'Snacks'], ['c1', 'Desserts']] as const) await mk(O1.vendorId, n, c);
      const x = { sections: ['Main Course', 'Snacks', 'Desserts'] };
      const y = { sections: ['Desserts', 'Snacks', 'Main Course'] };
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => putOrder(O1.vendorId, i % 2 ? x : y)));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      const got = await dbOrder(O1.vendorId);
      expect([['a1', 'a2', 'b1', 'b2', 'c1'], ['c1', 'b1', 'b2', 'a1', 'a2']]).toContainEqual(got);
    });

    test('menu-order of restaurant A and a dish create in restaurant B do not block each other', async () => {
      await mk(O1.vendorId, 'A', 'Main Course');
      const t = Date.now();
      const [r1, r2] = await Promise.all([putOrder(O1.vendorId, { sections: ['Main Course'] }), adminPost('/api/admin/catalog', { vendorId: O2.vendorId, name: 'B', vendorPrice: 5, category: 'Main Course' })]);
      expect([r1.status, r2.status]).toEqual([200, 201]);
      expect(Date.now() - t).toBeLessThan(10_000);
    });
  });

  // =========================================================================================
  describe('pure layout', () => {
    test('layoutSections groups by first appearance, assignSortOrder numbers 10, 20 ...', () => {
      const s = layoutSections([{ id: '1', category: 'A' }, { id: '2', category: 'B' }, { id: '3', category: 'a ' }, { id: '4', category: 'C' }, { id: '5', category: 'B' }]);
      expect(s.map((x) => [x.label, x.ids])).toEqual([['A', ['1', '3']], ['B', ['2', '5']], ['C', ['4']]]);
      expect([...assignSortOrder(s)]).toEqual([['1', 10], ['3', 20], ['2', 30], ['5', 40], ['4', 50]]);
      expect(layoutSections([])).toEqual([]);
    });
  });

  // =========================================================================================
  describe('migration 20261014_menu_order on a table with rows', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261014_menu_order/migration.sql'), 'utf8');
    // only the real statements: BEGIN / SET LOCAL / COMMIT belong to psql; here one transaction + a scratch schema play that role
    const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((x) => x.trim()).filter((x) => x && !/^(BEGIN|COMMIT|SET LOCAL)/i.test(x));

    test('adds the column with default 0 to existing rows (nothing else changes), the index exists once, and a second run is a no-op', async () => {
      await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS mig_menu_order CASCADE');
      await prisma.$executeRawUnsafe('CREATE SCHEMA mig_menu_order');
      try {
        const run = async (stmts: string[]) => prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL search_path TO mig_menu_order');
          for (const s of stmts) await tx.$executeRawUnsafe(s);
        });
        // the previous schema's MenuItem (without sortOrder) with production-shaped rows
        await run([
          `CREATE TABLE "MenuItem" ("id" TEXT PRIMARY KEY, "vendorId" TEXT NOT NULL, "name" TEXT NOT NULL, "price" DOUBLE PRECISION NOT NULL, "category" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "deletedAt" TIMESTAMP(3))`,
          `INSERT INTO "MenuItem" ("id","vendorId","name","price","category") SELECT 'm' || g, 'v' || (g % 4), 'Dish ' || g, 10 + g, 'Main Course' FROM generate_series(1, 300) g`,
          `INSERT INTO "MenuItem" ("id","vendorId","name","price","category","deletedAt") VALUES ('gone','v1','Deleted dish',5,'Snacks', now())`,
        ]);
        const snapshot = async () => (await prisma.$queryRawUnsafe<{ s: string }[]>(`SELECT md5(string_agg(t::text, '|' ORDER BY "id")) AS s FROM (SELECT "id","vendorId","name","price","category","createdAt","deletedAt" FROM mig_menu_order."MenuItem") t`))[0].s;
        const before = await snapshot();
        await run(statements);
        expect(await snapshot()).toBe(before); // every pre-existing column of every row is untouched
        const rows = await prisma.$queryRawUnsafe<{ n: number; zero: number }[]>('SELECT count(*)::int AS n, count(*) FILTER (WHERE "sortOrder" = 0)::int AS zero FROM mig_menu_order."MenuItem"');
        expect(rows[0]).toEqual({ n: 301, zero: 301 });
        await run(statements); // idempotent
        expect(await snapshot()).toBe(before);
        const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'mig_menu_order' AND tablename = 'MenuItem' AND indexname = 'MenuItem_vendorId_sortOrder_idx'`);
        expect(idx).toHaveLength(1);
        const col = await prisma.$queryRawUnsafe<{ is_nullable: string; column_default: string; data_type: string }[]>(`SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_schema = 'mig_menu_order' AND table_name = 'MenuItem' AND column_name = 'sortOrder'`);
        expect(col[0]).toEqual({ is_nullable: 'NO', column_default: '0', data_type: 'integer' });
      } finally {
        await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS mig_menu_order CASCADE');
      }
    });

    test('the migration file is what schema.prisma needs: same column and index name as the live test database (created by db push)', async () => {
      const col = await prisma.$queryRawUnsafe<{ is_nullable: string; column_default: string }[]>(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'MenuItem' AND column_name = 'sortOrder' AND table_schema = current_schema()`);
      expect(col[0]).toEqual({ is_nullable: 'NO', column_default: '0' });
      const idx = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'MenuItem_vendorId_sortOrder_idx'`);
      expect(idx[0].indexdef).toContain('("vendorId", "sortOrder")');
      expect(sql).toContain('"MenuItem_vendorId_sortOrder_idx"');
    });
  });
});
