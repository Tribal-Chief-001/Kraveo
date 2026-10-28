/**
 * "Cut from sale" commission and the customer menu price (Docs/26 sections 1 and 2). Real PostgreSQL, real HTTP endpoints.
 * Covers: CUT in every place that takes a rule (global setting, restaurant, dish, approve, preview, recalculate), `menuPrice` on admin
 * create / edit / preview / menu import (all error codes), what orders snapshot for CUT restaurants (3 restaurants x 3 percents, odd
 * prices, multi-item carts, a group across a CUT and a PERCENT restaurant), settlement exact to the paisa, owner/customer visibility.
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
import { createSettlements } from '../../src/services/settlement';
import { toPaise } from '../../src/services/pricing';

jest.setTimeout(120_000);

const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const owners = [1, 2, 3, 4].map((n) => ({ id: `usr-cut-v${n}`, phone: `+91 99998${n}${n}${n}${n}${n}`, vendorId: `cut-ven-${n}` }));
const [C1, C2, C3, C4] = owners; // C1..C3 run CUT rules, C4 a PERCENT rule
const ALL = owners.map((o) => o.vendorId);
const H = (t: string) => getAuthHeader(t);
const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const tOwner = (o: (typeof owners)[number]) => getVendorToken(o.id, o.phone);

/** Real responses are written here when CUT_CAPTURE_DIR is set (used to copy exact JSON into Docs/26 section 7). */
const CAP = process.env.CUT_CAPTURE_DIR;
const cap = (name: string, body: unknown) => { if (CAP) fs.writeFileSync(path.join(CAP, `${name}.json`), JSON.stringify(body, null, 2)); };

const keysDeep = (v: unknown, acc = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); }
  return acc;
};

describe('Cut from sale (Docs/26)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const adminGet = (p: string) => request.get(p).set(H(tAdmin));
  const adminPost = (p: string, body: unknown = {}) => request.post(p).set(H(tAdmin)).send(body as any);
  const adminPatch = (p: string, body: unknown = {}) => request.patch(p).set(H(tAdmin)).send(body as any);
  const adminPut = (p: string, body: unknown = {}) => request.put(p).set(H(tAdmin)).send(body as any);
  const setVendorRule = (vendorId: string, type: string | null, value: number | null) => adminPatch(`/api/admin/vendors/${vendorId}/commission`, { type, value });
  const setGlobal = (type: string, value: number) => adminPut('/api/admin/settings/commission', { type, value });
  const setRounding = (step: number) => adminPut('/api/admin/settings/rounding', { step });
  const create = (vendorId: string, body: Record<string, unknown>) => adminPost('/api/admin/catalog', { vendorId, name: `Dish ${randomUUID().slice(0, 8)}`, category: 'Main Course', ...body });
  const dbDish = (id: string) => prisma.menuItem.findUniqueOrThrow({ where: { id } });
  const imp = (vendorId: string, rows: unknown[], extra: Record<string, unknown> = {}) => adminPost(`/api/admin/vendors/${vendorId}/menu-import`, { rows, ...extra });
  const row = (name: string, extra: Record<string, unknown> = {}) => ({ name, category: 'Main Course', ...extra });
  const resetSettings = async () => { await prisma.appSetting.deleteMany({}); invalidateSettingsCache(); };
  const wipeDishes = () => prisma.menuItem.deleteMany({ where: { vendorId: { in: ALL } } });
  const clearActive = () => prisma.order.updateMany({ where: { customerId: STUDENT.id, status: 'PLACED', paymentStatus: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  const order = (vendorId: string, items: { itemId: string; quantity: number }[]) =>
    request.post('/api/orders').set(H(tStudent)).send({ vendorId, items, dropoffHostel: 'Block 2', clientRequestId: randomUUID() });

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.appSetting.deleteMany({});
    for (const o of owners) await prisma.user.upsert({ where: { id: o.id }, update: {}, create: { id: o.id, name: `Cut Owner ${o.vendorId}`, phone: o.phone, role: Role.VENDOR } });
    for (const o of owners) {
      await prisma.vendor.upsert({
        where: { id: o.vendorId },
        update: { userId: o.id, approvalStatus: 'APPROVED', commissionType: null, commissionValue: null, isAcceptingOrders: true },
        create: { id: o.vendorId, userId: o.id, name: `Cut Kitchen ${o.vendorId.slice(-1)}`, category: 'Test', address: 'Gate', bannerImage: '', approvalStatus: 'APPROVED' },
      });
    }
    await prisma.user.update({ where: { id: STUDENT.id }, data: { name: 'Rahul Sharma', phone: STUDENT.phone, hostelBlock: 'Block 3' } });
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    __resetRateLimits();
    await resetSettings();
    await prisma.adminAuditLog.deleteMany({});
    await clearActive();
    await prisma.vendor.updateMany({ where: { id: { in: ALL } }, data: { commissionType: null, commissionValue: null } });
    await wipeDishes();
  });

  afterAll(async () => {
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    await prisma.settlementAdjustment.deleteMany({});
    await prisma.order.updateMany({ where: { vendorId: { in: ALL } }, data: { settlementId: null } });
    await prisma.settlement.deleteMany({ where: { vendorId: { in: ALL } } });
    await prisma.order.deleteMany({ where: { vendorId: { in: ALL } } });
    await wipeDishes();
    await prisma.vendor.deleteMany({ where: { id: { in: ALL } } });
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('CUT is accepted wherever a rule is accepted', () => {
    test('global setting: CUT 0..90 with two decimals; 90.01, 100 and 3 decimals are refused and nothing is stored', async () => {
      const ok = await setGlobal('CUT', 20);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ success: true, changed: true, recalculateRecommended: true, data: { group: 'commission', isDefault: false, value: { type: 'CUT', value: 20 } } });
      cap('settings_commission_cut', ok.body);
      for (const value of [90.01, 100, 150, -1, 12.345]) {
        const r = await setGlobal('CUT', value);
        expect([r.status, r.body.field]).toEqual([400, 'value']);
      }
      expect((await setGlobal('CUT', 90)).status).toBe(200);
      expect((await setGlobal('CUT', 0.01)).status).toBe(200);
      expect((await setGlobal('CUT', 12.5)).status).toBe(200);
      const bad = await setGlobal('CUT', 100);
      expect(bad.body.message).toMatch(/cannot be more than 90%/);
      expect((await adminGet('/api/admin/settings/commission')).body.data.value).toEqual({ type: 'CUT', value: 12.5 });
      // merging a type change over a stored value that is too big for it is refused as a whole
      expect((await setGlobal('PERCENT', 100)).status).toBe(200);
      const merged = await adminPut('/api/admin/settings/commission', { type: 'CUT' });
      expect([merged.status, merged.body.field]).toEqual([400, 'value']);
      expect((await adminGet('/api/admin/settings/commission')).body.data.value).toEqual({ type: 'PERCENT', value: 100 });
      expect((await adminPut('/api/admin/settings/commission', { type: 'NOPE', value: 1 })).body.message).toMatch(/PERCENT, FLAT or CUT/);
    });

    test('restaurant default: PATCH /vendors/:id/commission accepts CUT and answers with the rule', async () => {
      const r = await setVendorRule(C1.vendorId, 'CUT', 30);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        vendor: { id: C1.vendorId, commissionType: 'CUT', commissionValue: 30 },
        effective: { type: 'CUT', value: 30, source: 'VENDOR' },
        dishCount: 0, staleDishes: 0,
      });
      cap('vendor_commission_cut', r.body);
      for (const value of [90.01, 100, 101, 5.555]) expect((await setVendorRule(C1.vendorId, 'CUT', value)).status).toBe(400);
      const stored = await prisma.vendor.findUniqueOrThrow({ where: { id: C1.vendorId } });
      expect([stored.commissionType, stored.commissionValue]).toEqual(['CUT', 30]);
      // the admin vendor list shows the stored columns
      const list = await adminGet('/api/vendors');
      expect(list.body.data.find((v: any) => v.id === C1.vendorId)).toMatchObject({ commissionType: 'CUT', commissionValue: 30 });
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'VENDOR_COMMISSION_SET', targetId: C1.vendorId } });
      expect(audit.summary).toContain('inherited -> 30% of the sale');
      expect((await setVendorRule(C1.vendorId, null, null)).body.data.effective).toMatchObject({ type: 'PERCENT', value: 0, source: 'GLOBAL' });
    });

    test('dish override and the dish views: create with CUT, price follows, commission shown as {type:CUT,value,source}', async () => {
      const r = await create(C1.vendorId, { vendorPrice: 80.5, commissionType: 'CUT', commissionValue: 30 });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({
        vendorPrice: 80.5, price: 115, computedPrice: 115, priceIsStale: false, effectiveCommission: 34.5,
        commission: { type: 'CUT', value: 30, source: 'DISH' }, commissionOverride: { type: 'CUT', value: 30 },
      });
      const stored = await dbDish(r.body.data.id);
      expect([stored.commissionType, stored.commissionValue, stored.price, stored.vendorPrice]).toEqual(['CUT', 30, 115, 80.5]);
      expect((await create(C1.vendorId, { vendorPrice: 80, commissionType: 'CUT', commissionValue: 100 })).status).toBe(400);
      expect((await create(C1.vendorId, { vendorPrice: 80, commissionType: 'CUT', commissionValue: 91 })).status).toBe(400);
      // edit: switch override PERCENT -> CUT and back
      const e = await adminPatch(`/api/admin/catalog/${r.body.data.id}`, { commissionType: 'PERCENT', commissionValue: 10 });
      expect(e.body.data).toMatchObject({ price: 89, commission: { type: 'PERCENT', value: 10, source: 'DISH' } }); // 80.5 + 8.05 = 88.55 -> 89
      const e2 = await adminPatch(`/api/admin/catalog/${r.body.data.id}`, { commissionType: 'CUT', commissionValue: 50 });
      expect(e2.body.data).toMatchObject({ price: 161, effectiveCommission: 80.5, commission: { type: 'CUT', value: 50, source: 'DISH' } });
      const audit = await prisma.adminAuditLog.findMany({ where: { action: 'DISH_EDITED', targetId: r.body.data.id } });
      expect(audit.length).toBe(2);
    });

    test('global CUT is inherited by dishes of restaurants without a rule; a restaurant CUT beats the global PERCENT', async () => {
      await setGlobal('CUT', 20);
      const inherited = await create(C2.vendorId, { vendorPrice: 80 });
      expect(inherited.body.data).toMatchObject({ price: 100, effectiveCommission: 20, commission: { type: 'CUT', value: 20, source: 'GLOBAL' }, commissionOverride: null });
      await setGlobal('PERCENT', 10);
      await setVendorRule(C2.vendorId, 'CUT', 25);
      const fromVendor = await create(C2.vendorId, { vendorPrice: 75 });
      expect(fromVendor.body.data).toMatchObject({ price: 100, commission: { type: 'CUT', value: 25, source: 'VENDOR' } });
    });

    test('approve a restaurant-submitted dish with a CUT override; a restaurant price of 80 sells for 100', async () => {
      const added = await request.post(`/api/vendors/${C1.vendorId}/items`).set(H(tOwner(C1))).send({ name: 'Owner Dal', price: 80, category: 'Main Course', description: 'd' });
      expect(added.status).toBe(201);
      const a = await adminPost(`/api/admin/catalog/${added.body.data.id}/approve`, { commissionType: 'CUT', commissionValue: 20 });
      expect(a.status).toBe(200);
      expect(a.body.data).toMatchObject({ status: 'LIVE', vendorPrice: 80, price: 100, commission: { type: 'CUT', value: 20, source: 'DISH' } });
      expect(a.body.preview).toMatchObject({ vendorPrice: 80, price: 100, effectiveCommission: 20, commission: { type: 'CUT', value: 20, source: 'DISH' } });
      expect((await adminPost(`/api/admin/catalog/${added.body.data.id}/approve`, { commissionType: 'CUT', commissionValue: 100 })).status).toBe(400);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'DISH_APPROVED', targetId: added.body.data.id } });
      expect(audit.summary).toContain('commission 20% of the sale (dish)');
    });

    test('recalculate with CUT: dry run lists the change, apply writes it, a second apply changes nothing', async () => {
      const d = await create(C3.vendorId, { vendorPrice: 80 });
      expect(d.body.data.price).toBe(80);
      await setGlobal('CUT', 20);
      const dry = await adminPost('/api/admin/catalog/recalculate', { vendorId: C3.vendorId });
      expect(dry.body.data).toMatchObject({ dryRun: true, applied: false, total: 1, changed: 1, changes: [{ id: d.body.data.id, vendorPrice: 80, oldPrice: 80, newPrice: 100 }] });
      expect((await dbDish(d.body.data.id)).price).toBe(80);
      const applied = await adminPost('/api/admin/catalog/recalculate', { vendorId: C3.vendorId, dryRun: false });
      expect(applied.body.data).toMatchObject({ applied: true, changed: 1 });
      expect((await dbDish(d.body.data.id)).price).toBe(100);
      expect((await adminPost('/api/admin/catalog/recalculate', { vendorId: C3.vendorId, dryRun: false })).body.data.changed).toBe(0);
    });

    test('rounding step 5 with CUT: price is rounded UP and the extra goes to Kraveo; a menu price that is a multiple of 5 stays exact', async () => {
      await setRounding(5);
      await setGlobal('CUT', 30);
      const d = await create(C1.vendorId, { vendorPrice: 81 }); // 81 / 0.7 = 115.71 -> 116 -> 120
      expect(d.body.data).toMatchObject({ price: 120, effectiveCommission: 39 });
      const m = await create(C1.vendorId, { menuPrice: 115 });
      expect(m.body.data).toMatchObject({ vendorPrice: 80.5, price: 115, effectiveCommission: 34.5 });
    });
  });

  // =========================================================================================
  describe('menuPrice on preview, admin create and admin edit', () => {
    test('preview with a CUT rule derives the restaurant price and shows the customer price', async () => {
      const r = await adminPost('/api/admin/catalog/preview', { vendorId: C1.vendorId, menuPrice: 115, commissionType: 'CUT', commissionValue: 30 });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ menuPrice: 115, vendorPrice: 80.5, price: 115, effectiveCommission: 34.5, nominalCommission: 34.5, commission: { type: 'CUT', value: 30, source: 'DISH' }, roundingStep: 1 });
      cap('preview_cut_menu_price', r.body);
      const viaVendor = await setVendorRule(C1.vendorId, 'CUT', 20);
      expect(viaVendor.status).toBe(200);
      const p2 = await adminPost('/api/admin/catalog/preview', { vendorId: C1.vendorId, vendorPrice: 80 });
      expect(p2.body.data).toEqual({ vendorPrice: 80, price: 100, effectiveCommission: 20, nominalCommission: 20, commission: { type: 'CUT', value: 20, source: 'VENDOR' }, roundingStep: 1 });
      cap('preview_cut_vendor_price', p2.body);
      // a preview that cannot be exact says so with the code (prices rounded to the paisa: a whole-rupee step makes most prices reachable)
      await setRounding(0);
      const odd = await adminPost('/api/admin/catalog/preview', { vendorId: C1.vendorId, menuPrice: 10, commissionType: 'CUT', commissionValue: 33.33 });
      expect([odd.status, odd.body.code, odd.body.nearestPrice]).toEqual([400, 'MENU_PRICE_NOT_EXACT', 9.99]);
      // both prices
      const both = await adminPost('/api/admin/catalog/preview', { vendorId: C1.vendorId, menuPrice: 115, vendorPrice: 80.5 });
      expect([both.status, both.body.code]).toEqual([400, 'PRICE_REQUIRED']);
    });

    test('create with menuPrice: stored restaurant price is the derived share, the customer price is exactly the menu price', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const r = await create(C1.vendorId, { menuPrice: 115 });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ vendorPrice: 80.5, price: 115, computedPrice: 115, effectiveCommission: 34.5, commission: { type: 'CUT', value: 30, source: 'VENDOR' }, sortOrder: 10 });
      cap('dish_create_menu_price', r.body);
      const stored = await dbDish(r.body.data.id);
      expect([stored.vendorPrice, stored.price]).toEqual([80.5, 115]);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'DISH_CREATED', targetId: r.body.data.id } });
      expect(audit.summary).toContain('restaurant Rs 80.5, customer Rs 115');
      // the dish's own override decides, not the restaurant's
      const own = await create(C1.vendorId, { menuPrice: 200, commissionType: 'CUT', commissionValue: 10 });
      expect(own.body.data).toMatchObject({ vendorPrice: 180, price: 200, commission: { type: 'CUT', value: 10, source: 'DISH' } });
      // with the whole-rupee step a price with paise cannot be sold (it would be rounded up): the nearest whole rupee is offered
      const paiseOnStep1 = await create(C1.vendorId, { menuPrice: 99.9 });
      expect([paiseOnStep1.body.code, paiseOnStep1.body.nearestPrice]).toEqual(['MENU_PRICE_NOT_EXACT', 100]);
      await setRounding(0);
      expect((await create(C1.vendorId, { menuPrice: 99.9 })).body.data).toMatchObject({ vendorPrice: 69.93, price: 99.9 });
      await setRounding(1);
      for (const bad of [0, -5, 5000.01, 12.345, '115', null, NaN]) {
        const x = await create(C1.vendorId, { menuPrice: bad });
        expect([x.status, x.body.field]).toEqual([400, 'menuPrice']);
      }
      expect((await create(C1.vendorId, { menuPrice: 5000 })).body.data).toMatchObject({ vendorPrice: 3500, price: 5000 });
    });

    test('create errors: PRICE_REQUIRED (both), MENU_PRICE_NEEDS_CUT_RULE, MENU_PRICE_NOT_EXACT with the nearest price; nothing is created', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const both = await create(C1.vendorId, { menuPrice: 115, vendorPrice: 80.5 });
      expect([both.status, both.body.code, both.body.field]).toEqual([400, 'PRICE_REQUIRED', 'menuPrice']);
      cap('error_price_required', both.body);
      const bothLegacy = await create(C1.vendorId, { menuPrice: 115, price: 80.5 });
      expect(bothLegacy.body.code).toBe('PRICE_REQUIRED');
      // neither keeps the old answer
      const neither = await create(C1.vendorId, {});
      expect([neither.status, neither.body.code, neither.body.field]).toEqual([400, 'BAD_REQUEST', 'vendorPrice']);

      await setVendorRule(C4.vendorId, 'PERCENT', 10);
      const wrong = await create(C4.vendorId, { menuPrice: 110 });
      expect([wrong.status, wrong.body.code, wrong.body.field]).toEqual([400, 'MENU_PRICE_NEEDS_CUT_RULE', 'menuPrice']);
      expect(wrong.body.message).toMatch(/Cut from sale/);
      cap('error_menu_price_needs_cut_rule', wrong.body);
      // the global default PERCENT 0 is not CUT either
      expect((await create(C2.vendorId, { menuPrice: 110 })).body.code).toBe('MENU_PRICE_NEEDS_CUT_RULE');
      // a dish override of FLAT beats the restaurant's CUT
      expect((await create(C1.vendorId, { menuPrice: 110, commissionType: 'FLAT', commissionValue: 5 })).body.code).toBe('MENU_PRICE_NEEDS_CUT_RULE');

      await setRounding(0);
      await setVendorRule(C3.vendorId, 'CUT', 33.33);
      const odd = await create(C3.vendorId, { menuPrice: 10 });
      expect([odd.status, odd.body.code, odd.body.field]).toEqual([400, 'MENU_PRICE_NOT_EXACT', 'menuPrice']);
      expect(odd.body).toMatchObject({ nearestPrice: 9.99 });
      expect(odd.body.message).toMatch(/nearest price that works is Rs 9\.99/);
      cap('error_menu_price_not_exact', odd.body);
      // step 5: Rs 117 is not a multiple of 5
      await setRounding(5);
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const step = await create(C1.vendorId, { menuPrice: 117 });
      expect([step.body.code, step.body.nearestPrice]).toEqual(['MENU_PRICE_NOT_EXACT', 115]);
      expect(await prisma.menuItem.count({ where: { vendorId: { in: [C1.vendorId, C3.vendorId, C4.vendorId] } } })).toBe(0);
    });

    test('a restaurant (owner) cannot send menuPrice: it is ignored by their endpoint and never stored as a customer price', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const r = await request.post(`/api/vendors/${C1.vendorId}/items`).set(H(tOwner(C1))).send({ name: 'Sneaky', price: 80, menuPrice: 1, category: 'Main Course', description: 'd' });
      expect(r.status).toBe(201);
      const stored = await dbDish(r.body.data.id);
      expect([stored.vendorPrice, stored.approvalStatus]).toEqual([80, 'PENDING']);
    });

    test('edit with menuPrice re-derives the restaurant price; with a new override in the same request; refused for non-CUT; vendorPrice+menuPrice is PRICE_REQUIRED', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const d = (await create(C1.vendorId, { menuPrice: 115 })).body.data;
      const e = await adminPatch(`/api/admin/catalog/${d.id}`, { menuPrice: 200 });
      expect(e.status).toBe(200);
      expect(e.body.data).toMatchObject({ vendorPrice: 140, price: 200, effectiveCommission: 60 });
      expect(e.body.preview).toMatchObject({ previousVendorPrice: 80.5, previousPrice: 115, vendorPrice: 140, price: 200 });
      cap('dish_edit_menu_price', e.body);
      const both = await adminPatch(`/api/admin/catalog/${d.id}`, { menuPrice: 200, vendorPrice: 140 });
      expect([both.status, both.body.code]).toEqual([400, 'PRICE_REQUIRED']);
      // new override in the same request decides the share
      const e2 = await adminPatch(`/api/admin/catalog/${d.id}`, { menuPrice: 200, commissionType: 'CUT', commissionValue: 20 });
      expect(e2.body.data).toMatchObject({ vendorPrice: 160, price: 200, commission: { type: 'CUT', value: 20, source: 'DISH' } });
      const wrong = await adminPatch(`/api/admin/catalog/${d.id}`, { menuPrice: 200, commissionType: 'PERCENT', commissionValue: 5 });
      expect([wrong.status, wrong.body.code]).toEqual([400, 'MENU_PRICE_NEEDS_CUT_RULE']);
      expect((await dbDish(d.id)).vendorPrice).toBe(160); // the refused edit changed nothing
      // an open restaurant request is superseded by the admin's menu price
      const live = (await create(C1.vendorId, { menuPrice: 100 })).body.data;
      await prisma.menuItem.update({ where: { id: live.id }, data: { pendingVendorPrice: 90 } });
      await adminPatch(`/api/admin/catalog/${live.id}`, { menuPrice: 120 });
      expect((await dbDish(live.id)).pendingVendorPrice).toBeNull();
      // same menu price again: nothing wrong, idempotent values
      const again = await adminPatch(`/api/admin/catalog/${live.id}`, { menuPrice: 120 });
      expect(again.body.data).toMatchObject({ vendorPrice: 84, price: 120 });
    });
  });

  // =========================================================================================
  describe('menu import with menuPrice', () => {
    test('dry run reports vendorPrice and the computed customer price for menuPrice rows; apply writes them; the second call is all skip', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const rows = [
        row('Imp A', { menuPrice: 115 }),
        row('Imp B', { vendorPrice: 70, isVeg: false }),
        row('Imp C', { menuPrice: 99 }),
        row('Imp D', { menuPrice: 250, position: 7 }),
      ];
      const dry = await imp(C1.vendorId, rows);
      expect(dry.status).toBe(200);
      expect(dry.body.data.summary).toEqual({ create: 4, update: 0, skip: 0, invalid: 0, total: 4 });
      expect(dry.body.data.rows).toEqual([
        { index: 0, name: 'Imp A', action: 'create', errors: [], computedPrice: 115, vendorPrice: 80.5, sortOrder: 10 },
        { index: 1, name: 'Imp B', action: 'create', errors: [], computedPrice: 100, vendorPrice: 70, sortOrder: 20 },
        { index: 2, name: 'Imp C', action: 'create', errors: [], computedPrice: 99, vendorPrice: 69.3, sortOrder: 30 },
        { index: 3, name: 'Imp D', action: 'create', errors: [], computedPrice: 250, vendorPrice: 175, sortOrder: 70 },
      ]);
      cap('import_dry_run_menu_price', dry.body);
      expect(await prisma.menuItem.count({ where: { vendorId: C1.vendorId } })).toBe(0);

      const applied = await imp(C1.vendorId, rows, { dryRun: false });
      expect(applied.status).toBe(200);
      expect(applied.body.data).toMatchObject({ dryRun: false, applied: true, summary: { create: 4, update: 0, skip: 0, invalid: 0, total: 4 } });
      expect(applied.body.data.rows.map((r: any) => [r.vendorPrice, r.computedPrice, r.sortOrder])).toEqual([[80.5, 115, 10], [70, 100, 20], [69.3, 99, 30], [175, 250, 70]]);
      cap('import_apply_menu_price', applied.body);
      const stored = await prisma.menuItem.findMany({ where: { vendorId: C1.vendorId }, orderBy: { sortOrder: 'asc' } });
      expect(stored.map((d) => [d.name, d.vendorPrice, d.price, d.sortOrder, d.approvalStatus, d.createdBy])).toEqual([
        ['Imp A', 80.5, 115, 10, 'APPROVED', 'ADMIN'], ['Imp B', 70, 100, 20, 'APPROVED', 'ADMIN'], ['Imp C', 69.3, 99, 30, 'APPROVED', 'ADMIN'], ['Imp D', 175, 250, 70, 'APPROVED', 'ADMIN'],
      ]);
      const again = await imp(C1.vendorId, rows, { dryRun: false });
      expect(again.body.data.summary).toEqual({ create: 0, update: 0, skip: 4, invalid: 0, total: 4 });
      expect(await prisma.menuItem.count({ where: { vendorId: C1.vendorId } })).toBe(4);
    });

    test('row errors: both prices, neither price, menuPrice without a CUT rule, not exact; the whole apply is refused and writes nothing (all or nothing)', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const rows = [
        row('Good One', { menuPrice: 115 }),
        row('Both', { menuPrice: 115, vendorPrice: 80.5 }),
        row('Neither'),
        row('Null Prices', { menuPrice: null, vendorPrice: null }),
        row('Too Cheap', { menuPrice: 0 }),
        row('Too Dear', { menuPrice: 5001 }),
        row('Bad Position', { menuPrice: 100, position: 0 }),
        row('Float Position', { menuPrice: 100, position: 1.5 }),
        row('Dish Override Wins', { menuPrice: 110 }),
      ];
      const dry = await imp(C1.vendorId, rows);
      expect(dry.status).toBe(200);
      const byName = Object.fromEntries(dry.body.data.rows.map((r: any) => [r.name, r]));
      expect(byName['Good One']).toMatchObject({ action: 'create', errors: [] });
      expect(byName['Both']).toMatchObject({ action: 'invalid', errors: [{ field: 'menuPrice', code: 'PRICE_REQUIRED' }], vendorPrice: null });
      expect(byName['Neither']).toMatchObject({ action: 'invalid', errors: [{ field: 'vendorPrice', code: 'PRICE_REQUIRED' }] });
      expect(byName['Null Prices'].errors[0].code).toBe('PRICE_REQUIRED');
      expect(byName['Too Cheap'].errors[0]).toMatchObject({ field: 'menuPrice' });
      expect(byName['Too Dear'].errors[0].message).toMatch(/cannot be more than/);
      expect(byName['Bad Position'].errors[0]).toMatchObject({ field: 'position' });
      expect(byName['Float Position'].errors[0]).toMatchObject({ field: 'position' });
      cap('import_dry_run_errors', dry.body);

      const apply = await imp(C1.vendorId, rows, { dryRun: false });
      expect([apply.status, apply.body.code]).toEqual([400, 'IMPORT_INVALID']);
      expect(apply.body.data.applied).toBe(false);
      expect(await prisma.menuItem.count({ where: { vendorId: C1.vendorId } })).toBe(0);
      cap('import_apply_invalid', apply.body);
    });

    test('menuPrice without a CUT rule: MENU_PRICE_NEEDS_CUT_RULE with a plain message, vendorPrice rows in the same file are fine', async () => {
      await setVendorRule(C4.vendorId, 'PERCENT', 10);
      const dry = await imp(C4.vendorId, [row('Plain A', { vendorPrice: 100 }), row('Plain B', { menuPrice: 110 })]);
      expect(dry.body.data.rows[0]).toMatchObject({ action: 'create', computedPrice: 110, vendorPrice: 100 });
      expect(dry.body.data.rows[1]).toMatchObject({ action: 'invalid', computedPrice: null, vendorPrice: null });
      expect(dry.body.data.rows[1].errors[0]).toMatchObject({ field: 'menuPrice', code: 'MENU_PRICE_NEEDS_CUT_RULE' });
      expect(dry.body.data.rows[1].errors[0].message).toMatch(/Cut from sale/);
      expect((await imp(C4.vendorId, [row('Plain B', { menuPrice: 110 })], { dryRun: false })).body.code).toBe('IMPORT_INVALID');
      // the global default being CUT makes it legal for a restaurant without its own rule
      await setGlobal('CUT', 10);
      const ok = await imp(C2.vendorId, [row('Global Cut', { menuPrice: 100 })]);
      expect(ok.body.data.rows[0]).toMatchObject({ action: 'create', vendorPrice: 90, computedPrice: 100 });
      // ... but a restaurant PERCENT rule beats the global CUT
      expect((await imp(C4.vendorId, [row('Plain B', { menuPrice: 110 })])).body.data.rows[0].errors[0].code).toBe('MENU_PRICE_NEEDS_CUT_RULE');
    });

    test('not exact: MENU_PRICE_NOT_EXACT carries the nearest price that works', async () => {
      await setRounding(0);
      await setVendorRule(C3.vendorId, 'CUT', 33.33);
      const dry = await imp(C3.vendorId, [row('Third', { menuPrice: 10 }), row('Fine', { menuPrice: 99.99 })]);
      expect(dry.body.data.rows[0]).toMatchObject({ action: 'invalid', errors: [{ field: 'menuPrice', code: 'MENU_PRICE_NOT_EXACT', nearestPrice: 9.99 }] });
      expect(dry.body.data.rows[0].errors[0].message).toMatch(/Rs 9\.99/);
      expect(dry.body.data.rows[1].action).toMatch(/create|invalid/);
      cap('import_row_not_exact', dry.body.data.rows[0]);
    });

    test('duplicates: SKIP keeps the dish (computed price shown), UPDATE with a new menuPrice re-prices it and clears an open request; the dish override decides the rule', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const first = await imp(C1.vendorId, [row('Dup', { menuPrice: 115 })], { dryRun: false });
      const id = first.body.data.rows[0].dishId;
      const skip = await imp(C1.vendorId, [row('Dup', { menuPrice: 200 })]);
      expect(skip.body.data.rows[0]).toMatchObject({ action: 'skip', reason: 'DUPLICATE_EXISTS', computedPrice: 200, vendorPrice: 140, sortOrder: null });
      expect((await dbDish(id)).price).toBe(115);
      await prisma.menuItem.update({ where: { id }, data: { pendingVendorPrice: 99 } });
      const upd = await imp(C1.vendorId, [row('Dup', { menuPrice: 200 })], { dryRun: false, onDuplicate: 'UPDATE' });
      expect(upd.body.data.rows[0]).toMatchObject({ action: 'update', computedPrice: 200, vendorPrice: 140 });
      expect(await dbDish(id)).toMatchObject({ vendorPrice: 140, price: 200, pendingVendorPrice: null });
      // the same row again: nothing changes
      const same = await imp(C1.vendorId, [row('Dup', { menuPrice: 200 })], { dryRun: false, onDuplicate: 'UPDATE' });
      expect(same.body.data.rows[0]).toMatchObject({ action: 'skip', reason: 'UNCHANGED' });
      // a dish with its own non-CUT override cannot take a menuPrice
      await prisma.menuItem.update({ where: { id }, data: { commissionType: 'PERCENT', commissionValue: 10 } });
      const wrong = await imp(C1.vendorId, [row('Dup', { menuPrice: 300 })], { onDuplicate: 'UPDATE' });
      expect(wrong.body.data.rows[0].errors[0].code).toBe('MENU_PRICE_NEEDS_CUT_RULE');
      // ... but a vendorPrice row for it works as before
      const ok = await imp(C1.vendorId, [row('Dup', { vendorPrice: 100 })], { onDuplicate: 'UPDATE' });
      expect(ok.body.data.rows[0]).toMatchObject({ action: 'update', computedPrice: 110, vendorPrice: 100 });
    });

    test('rows with only vendorPrice behave exactly as before (PERCENT restaurant, no sortOrder surprises)', async () => {
      await setVendorRule(C4.vendorId, 'PERCENT', 10);
      const r = await imp(C4.vendorId, [row('Old Style', { vendorPrice: 100 })], { dryRun: false });
      expect(r.body.data.rows[0]).toMatchObject({ action: 'create', computedPrice: 110, vendorPrice: 100 });
      expect(await dbDish(r.body.data.rows[0].dishId)).toMatchObject({ vendorPrice: 100, price: 110, sortOrder: 10, commissionType: null });
    });
  });

  // =========================================================================================
  describe('orders snapshot a CUT exactly', () => {
    const PERCENTS = [20, 30, 17];
    const MENU_PRICES = [115, 99, 37, 249, 1, 333]; // odd prices
    const paise = toPaise;

    test('3 restaurants x 3 percents x multi-item carts: vendorSubtotal is (100-X)% of the food sale and commissionTotal X% to the paisa', async () => {
      const rows: { vendorId: string; x: number; orderId: string; food: number; vendor: number; comm: number }[] = [];
      for (const o of [C1, C2, C3]) {
        for (const x of PERCENTS) {
          await wipeDishes();
          await setVendorRule(o.vendorId, 'CUT', x);
          const dishes = [] as { id: string; menuPrice: number }[];
          for (const mp of MENU_PRICES) {
            const made = await create(o.vendorId, { menuPrice: mp });
            expect([made.status, made.body.data?.price]).toEqual([201, mp]);
            dishes.push({ id: made.body.data.id, menuPrice: mp });
          }
          const qty = [3, 1, 2, 5, 7, 2];
          const placed = await order(o.vendorId, dishes.map((d, i) => ({ itemId: d.id, quantity: qty[i] })));
          expect([placed.status, placed.body.code]).toEqual([201, undefined]);
          const food = dishes.reduce((a, d, i) => a + paise(d.menuPrice) * qty[i], 0);
          const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.id }, include: { items: true } });
          expect(paise(row.subtotal)).toBe(food);
          // the heart of the contract: exact percentages of the food sale, in integer paise
          expect(paise(row.vendorSubtotal) * 100).toBe(food * (100 - x));
          expect(paise(row.commissionTotal) * 100).toBe(food * x);
          expect(paise(row.vendorSubtotal) + paise(row.commissionTotal)).toBe(food);
          for (const it of row.items) {
            expect(paise(it.vendorUnitPrice) * 100).toBe(paise(it.price) * (100 - x));
            expect(paise(it.commissionUnit) * 100).toBe(paise(it.price) * x);
          }
          // the customer pays the menu prices plus the all-in fee, nothing else
          expect(paise(row.totalAmount)).toBe(food + paise(row.deliveryFee));
          rows.push({ vendorId: o.vendorId, x, orderId: row.id, food, vendor: paise(row.vendorSubtotal), comm: paise(row.commissionTotal) });
          // settle later: delivered and paid, and out of the way of the "one active order" rule
          await prisma.order.update({ where: { id: row.id }, data: { status: 'DELIVERED', paymentStatus: 'PAID', deliveredAt: new Date(Date.now() - 2 * 3_600_000) } });
        }
      }
      expect(rows).toHaveLength(9);

      // settlement of those orders: exact to the paisa, per restaurant
      for (const o of [C1, C2, C3]) {
        const res = await createSettlements({ vendorId: o.vendorId, createdBy: 'test' });
        expect(res.created).toHaveLength(1);
        const mine = rows.filter((r) => r.vendorId === o.vendorId);
        const settlement = await prisma.settlement.findFirstOrThrow({ where: { vendorId: o.vendorId } });
        expect(settlement.orderCount).toBe(3);
        expect(paise(settlement.foodGross)).toBe(mine.reduce((a, r) => a + r.food, 0));
        expect(paise(settlement.vendorAmount)).toBe(mine.reduce((a, r) => a + r.vendor, 0));
        expect(paise(settlement.commissionAmount)).toBe(mine.reduce((a, r) => a + r.comm, 0));
        // and each order inside is exactly (100-X)% / X% of its own sale
        expect(mine.every((r) => r.vendor * 100 === r.food * (100 - r.x) && r.comm * 100 === r.food * r.x)).toBe(true);
        expect(paise(settlement.netPayable)).toBe(paise(settlement.vendorAmount) + paise(settlement.adjustmentTotal));
      }
      // finance sees the same commission
      const fin = await adminGet('/api/admin/finance/summary');
      expect(fin.status).toBe(200);
      expect(paise(fin.body.data.commission)).toBe(rows.reduce((a, r) => a + r.comm, 0));
    });

    test('a vendorPrice dish under CUT (no menuPrice) still snapshots what the engine priced, and legacy PERCENT / FLAT dishes order exactly as before in the same restaurant', async () => {
      await setVendorRule(C4.vendorId, 'CUT', 30);
      const viaVendor = (await create(C4.vendorId, { vendorPrice: 81 })).body.data; // 81 / 0.7 = 115.71 -> 116
      const percent = (await create(C4.vendorId, { vendorPrice: 100, commissionType: 'PERCENT', commissionValue: 10 })).body.data;
      const flat = (await create(C4.vendorId, { vendorPrice: 50, commissionType: 'FLAT', commissionValue: 7 })).body.data;
      expect([viaVendor.price, percent.price, flat.price]).toEqual([116, 110, 57]);
      const placed = await order(C4.vendorId, [{ itemId: viaVendor.id, quantity: 2 }, { itemId: percent.id, quantity: 1 }, { itemId: flat.id, quantity: 3 }]);
      expect(placed.status).toBe(201);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.id }, include: { items: true } });
      expect(row).toMatchObject({ subtotal: 513, vendorSubtotal: 412, commissionTotal: 101 });
      expect(row.items.map((i) => [i.price, i.vendorUnitPrice, i.commissionUnit, i.quantity]).sort()).toEqual([[110, 100, 10, 1], [116, 81, 35, 2], [57, 50, 7, 3]].sort());
    });

    test('a GROUP order across a CUT restaurant and a PERCENT restaurant: each child snapshots its own rule, the children add up to the group', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      await setVendorRule(C4.vendorId, 'PERCENT', 10);
      const a = [(await create(C1.vendorId, { menuPrice: 115 })).body.data, (await create(C1.vendorId, { menuPrice: 37 })).body.data];
      const b = [(await create(C4.vendorId, { vendorPrice: 99 })).body.data, (await create(C4.vendorId, { vendorPrice: 33.33 })).body.data];
      const placed = await request.post('/api/order-groups').set(H(tStudent)).send({
        restaurants: [
          { vendorId: C1.vendorId, items: [{ itemId: a[0].id, quantity: 3 }, { itemId: a[1].id, quantity: 2 }] },
          { vendorId: C4.vendorId, items: [{ itemId: b[0].id, quantity: 1 }, { itemId: b[1].id, quantity: 4 }] },
        ],
        dropoffHostel: 'BH2', clientRequestId: randomUUID(),
      });
      expect([placed.status, placed.body.code]).toEqual([201, undefined]);
      const children = await prisma.order.findMany({ where: { groupId: placed.body.data.id }, orderBy: { groupIndex: 'asc' }, include: { items: true } });
      expect(children.map((c) => c.vendorId)).toEqual([C1.vendorId, C4.vendorId]);
      const [cut, pct] = children;
      const food1 = paise(115) * 3 + paise(37) * 2;
      expect(paise(cut.subtotal)).toBe(food1);
      expect(paise(cut.vendorSubtotal) * 100).toBe(food1 * 70); // exactly 70% of the sale
      expect(paise(cut.commissionTotal) * 100).toBe(food1 * 30); // exactly 30%
      // the PERCENT child: 99 -> 108.9 -> 109, 33.33 -> 36.663 -> 37
      expect(pct.items.map((i) => [i.price, i.vendorUnitPrice]).sort()).toEqual([[109, 99], [37, 33.33]].sort());
      expect(paise(pct.vendorSubtotal)).toBe(paise(99) + 4 * paise(33.33));
      expect(paise(pct.subtotal)).toBe(paise(109) + 4 * paise(37));
      expect(paise(pct.commissionTotal)).toBe(paise(pct.subtotal) - paise(pct.vendorSubtotal));
      const group = await prisma.orderGroup.findUniqueOrThrow({ where: { id: placed.body.data.id } });
      expect(children.reduce((acc, c) => acc + paise(c.totalAmount), 0)).toBe(paise(group.totalAmount));
      // deliver and settle the CUT child: exact
      await prisma.order.update({ where: { id: cut.id }, data: { status: 'DELIVERED', paymentStatus: 'PAID', deliveredAt: new Date(Date.now() - 3_600_000) } });
      const s = await createSettlements({ vendorId: C1.vendorId, createdBy: 'test' });
      expect(s.created).toHaveLength(1);
      const st = await prisma.settlement.findFirstOrThrow({ where: { vendorId: C1.vendorId }, orderBy: { createdAt: 'desc' } });
      expect([paise(st.vendorAmount) * 100, paise(st.commissionAmount) * 100]).toEqual([food1 * 70, food1 * 30]);
      await prisma.order.updateMany({ where: { groupId: placed.body.data.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    });

    test('changing the rule or the price later never touches an order already placed', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const d = (await create(C1.vendorId, { menuPrice: 115 })).body.data;
      const placed = await order(C1.vendorId, [{ itemId: d.id, quantity: 2 }]);
      expect(placed.status).toBe(201);
      await setVendorRule(C1.vendorId, 'CUT', 50);
      await adminPost('/api/admin/catalog/recalculate', { dryRun: false });
      expect((await dbDish(d.id)).price).toBe(161); // 80.5 / 0.5
      const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.id }, include: { items: true } });
      expect(row).toMatchObject({ subtotal: 230, vendorSubtotal: 161, commissionTotal: 69 });
      expect(row.items[0]).toMatchObject({ price: 115, vendorUnitPrice: 80.5, commissionUnit: 34.5 });
    });
  });

  // =========================================================================================
  describe('visibility: the restaurant never learns the cut or the customer price', () => {
    const FORBIDDEN = ['commission', 'commissionType', 'commissionValue', 'effectiveCommission', 'computedPrice', 'vendorPrice', 'menuPrice', 'pendingVendorPrice', 'priceIsStale', 'commissionOverride', 'pendingCustomerPrice', 'nominalCommission'];

    test('owner payloads (menu-manage, /vendors/:id, /vendors, /menus/:id, dish create/toggle) carry only their own price and no cut', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const d = (await create(C1.vendorId, { menuPrice: 115 })).body.data;
      const owner = tOwner(C1);
      const payloads = [
        (await request.get(`/api/vendors/${C1.vendorId}/menu-manage`).set(H(owner))).body,
        (await request.get(`/api/vendors/${C1.vendorId}`).set(H(owner))).body,
        (await request.get('/api/vendors').set(H(owner))).body,
        (await request.get(`/api/menus/${C1.vendorId}`).set(H(owner))).body,
        (await request.patch(`/api/menus/${d.id}/toggle`).set(H(owner))).body,
        (await request.patch(`/api/menus/${d.id}/toggle`).set(H(owner))).body, // back to available
        (await request.post(`/api/vendors/${C1.vendorId}/items`).set(H(owner)).send({ name: 'Mine', price: 60, category: 'Main Course', description: 'd' })).body,
      ];
      for (const p of payloads) {
        expect(p.success).toBe(true);
        const keys = keysDeep(p);
        for (const f of FORBIDDEN) expect([f, keys.has(f)]).toEqual([f, false]);
      }
      // the owner sees ITS price (80.5), never 115
      const manage = payloads[0] as any;
      expect(manage.data.find((x: any) => x.id === d.id)).toMatchObject({ price: 80.5, status: 'LIVE' });
      expect(JSON.stringify(payloads)).not.toMatch(/\b115\b/);
      // no cut figure either: the 30 never appears as a commission-ish key (already covered by the key list), and the order rows the owner reads carry vendor money only
      const placed = await order(C1.vendorId, [{ itemId: d.id, quantity: 2 }]);
      expect(placed.status).toBe(201);
      await prisma.order.update({ where: { id: placed.body.data.id }, data: { paymentStatus: 'PAID' } }); // restaurants only see paid orders
      const ownerOrders = await request.get('/api/orders').set(H(owner));
      const detail = await request.get(`/api/orders/${placed.body.data.id}`).set(H(owner));
      expect(detail.status).toBe(200);
      for (const body of [ownerOrders.body, detail.body]) {
        const orderKeys = keysDeep(body);
        for (const f of ['commission', 'commissionTotal', 'commissionUnit', 'vendorSubtotal', 'deliveryFee', 'discount', 'feeBreakdown']) expect([f, orderKeys.has(f)]).toEqual([f, false]);
      }
      const ownerOrder = (ownerOrders.body.data ?? []).find((o: any) => o.id === placed.body.data.id);
      expect(ownerOrder).toBeDefined();
      expect([ownerOrder.totalAmount, detail.body.data.totalAmount]).toEqual([161, 161]); // "You earn": 2 x 80.5, never the customer's 230
    });

    test('customers see the customer price, a menu position, and nothing about the restaurant price or the cut', async () => {
      await setVendorRule(C1.vendorId, 'CUT', 30);
      const d = (await create(C1.vendorId, { menuPrice: 115 })).body.data;
      const pub = [
        (await request.get(`/api/menus/${C1.vendorId}`)).body,
        (await request.get(`/api/vendors/${C1.vendorId}`).set(H(tStudent))).body,
        (await request.get('/api/vendors').set(H(tStudent))).body,
      ];
      for (const p of pub) {
        const keys = keysDeep(p);
        for (const f of FORBIDDEN) expect([f, keys.has(f)]).toEqual([f, false]);
      }
      const dish = (pub[0] as any).data.find((x: any) => x.id === d.id);
      expect(dish).toMatchObject({ price: 115, sortOrder: 10 });
      cap('public_menu_dish', dish);
    });
  });
});
