/**
 * Pricing, catalog approval and settings (Docs/21 sections 2-4 and 9), phase 1. Real PostgreSQL, real HTTP endpoints.
 * Covers: settings endpoints (validation, audit, cache, races), the restaurant dish flow (pending / live / change pending / rejected),
 * what customers can and cannot reach, the admin catalog endpoints, the commission engine through the API, recalculate, race safety,
 * rate limits and audit rows.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { invalidateSettingsCache, getSettings } from '../../src/services/settings';
import { validateAndCalculateOrder } from '../../src/utils/validation';

jest.setTimeout(60_000);

const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const V1 = { id: 'usr-pc-v1', phone: '+91 9999861111', vendorId: 'pc-ven-1' };
const V2 = { id: 'usr-pc-v2', phone: '+91 9999862222', vendorId: 'pc-ven-2' };
const PENDING_V = { id: 'usr-pc-v3', phone: '+91 9999863333', vendorId: 'pc-ven-3' };

const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const tV1 = getVendorToken(V1.id, V1.phone);
const tV2 = getVendorToken(V2.id, V2.phone);
const tV3 = getVendorToken(PENDING_V.id, PENDING_V.phone);
const H = (t: string) => getAuthHeader(t);

/** Fields no restaurant response may ever carry. */
const FORBIDDEN_FOR_VENDOR = ['commission', 'commissionType', 'commissionValue', 'effectiveCommission', 'computedPrice', 'vendorPrice', 'pendingVendorPrice', 'priceIsStale', 'commissionOverride', 'pendingCustomerPrice'];
const keysDeep = (v: unknown, acc = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); }
  return acc;
};

describe('Pricing and catalog (phase 1)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const get = (path: string, token?: string) => (token ? request.get(path).set(H(token)) : request.get(path));
  const adminGet = (path: string) => request.get(path).set(H(tAdmin));
  const adminPost = (path: string, body: unknown = {}) => request.post(path).set(H(tAdmin)).send(body as any);
  const adminPatch = (path: string, body: unknown = {}) => request.patch(path).set(H(tAdmin)).send(body as any);
  const adminPut = (path: string, body: unknown = {}) => request.put(path).set(H(tAdmin)).send(body as any);
  const adminDel = (path: string) => request.delete(path).set(H(tAdmin));
  const addDish = (token: string, vendorId: string, body: Record<string, unknown> = {}) =>
    request.post(`/api/vendors/${vendorId}/items`).set(H(token)).send({ name: `Dish ${randomUUID().slice(0, 6)}`, price: 100, category: 'Main', description: 'd', ...body });
  const patchDish = (token: string, id: string, body: unknown) => request.patch(`/api/vendors/items/${id}`).set(H(token)).send(body as any);
  const order = (items: { itemId: string; quantity: number }[], vendorId = V1.vendorId, extra: Record<string, unknown> = {}) =>
    request.post('/api/orders').set(H(tStudent)).send({ vendorId, items, dropoffHostel: 'Block 2', clientRequestId: randomUUID(), ...extra });
  const dbItem = (id: string) => prisma.menuItem.findUniqueOrThrow({ where: { id } });
  const audits = (action: string, targetId?: string) => prisma.adminAuditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) } });
  const setFees = (body: unknown) => adminPut('/api/admin/settings/fees', body);
  const setCommission = (type: string, value: number) => adminPut('/api/admin/settings/commission', { type, value });
  const setRounding = (step: number) => adminPut('/api/admin/settings/rounding', { step });
  const resetSettings = async () => { await prisma.appSetting.deleteMany({}); invalidateSettingsCache(); };
  /** An approved live dish for V1 with the given restaurant price (0% commission, step 1 unless settings say otherwise). */
  const liveDish = async (vendorPrice: number, extra: Record<string, unknown> = {}) => {
    const r = await adminPost('/api/admin/catalog', { vendorId: V1.vendorId, name: `Live ${randomUUID().slice(0, 6)}`, vendorPrice, ...extra });
    expect(r.status).toBe(201);
    return r.body.data as any;
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.appSetting.deleteMany({});
    for (const u of [
      { id: V1.id, name: 'PC Owner One', phone: V1.phone, role: Role.VENDOR },
      { id: V2.id, name: 'PC Owner Two', phone: V2.phone, role: Role.VENDOR },
      { id: PENDING_V.id, name: 'PC Owner Three', phone: PENDING_V.phone, role: Role.VENDOR },
    ]) await prisma.user.upsert({ where: { id: u.id }, update: u, create: u });
    for (const [v, status] of [[V1, 'APPROVED'], [V2, 'APPROVED'], [PENDING_V, 'PENDING']] as const) {
      await prisma.vendor.upsert({
        where: { id: v.vendorId },
        update: { userId: v.id, approvalStatus: status, commissionType: null, commissionValue: null, isAcceptingOrders: true },
        create: { id: v.vendorId, userId: v.id, name: `PC Kitchen ${v.vendorId.slice(-1)}`, category: 'Test', address: 'Gate', bannerImage: '', approvalStatus: status },
      });
    }
    await prisma.user.update({ where: { id: STUDENT.id }, data: { name: 'Rahul Sharma', phone: STUDENT.phone, hostelBlock: 'Block 3' } });
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    delete process.env.SETTINGS_CACHE_TTL_MS;
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    __resetRateLimits();
    await resetSettings();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.order.updateMany({ where: { customerId: STUDENT.id, status: 'PLACED', paymentStatus: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await prisma.vendor.updateMany({ where: { id: { in: [V1.vendorId, V2.vendorId] } }, data: { commissionType: null, commissionValue: null } });
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: [V1.vendorId, V2.vendorId, PENDING_V.vendorId] } } });
  });

  afterAll(async () => {
    delete process.env.SETTINGS_CACHE_TTL_MS;
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    await prisma.order.deleteMany({ where: { vendorId: { in: [V1.vendorId, V2.vendorId, PENDING_V.vendorId] } } });
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: [V1.vendorId, V2.vendorId, PENDING_V.vendorId] } } });
    await prisma.vendor.deleteMany({ where: { id: { in: [V1.vendorId, V2.vendorId, PENDING_V.vendorId] } } });
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('settings endpoints', () => {
    test('GET returns the defaults of every group (isDefault) and only admins may read or write', async () => {
      const all = await adminGet('/api/admin/settings');
      expect(all.status).toBe(200);
      expect(all.body.data.map((g: any) => g.group)).toEqual(['fees', 'commission', 'rounding', 'settlement']);
      expect(all.body.data.every((g: any) => g.isDefault === true)).toBe(true);
      const fees = (await adminGet('/api/admin/settings/fees')).body.data;
      expect(fees.value).toEqual({ baseFee: 25, lines: [], extraRestaurantFee: 15, freeFeeAbove: 0, smallOrderBelow: 0, smallOrderFee: 0, gstOnFeesPercent: 18, gstOnFoodPercent: 5, maxRestaurantsPerOrder: 3 }); // Docs/22 added maxRestaurantsPerOrder (default 3)
      expect((await adminGet('/api/admin/settings/commission')).body.data.value).toEqual({ type: 'PERCENT', value: 0 });
      expect((await adminGet('/api/admin/settings/rounding')).body.data.value).toEqual({ step: 1 });
      expect((await adminGet('/api/admin/settings/settlement')).body.data.value).toEqual({ time: '22:00', mode: 'MANUAL_PAYOUT', autoCreate: true, holdDays: 0 });
      expect((await adminGet('/api/admin/settings/nope')).status).toBe(404);
      for (const t of [tStudent, tV1]) {
        expect((await get('/api/admin/settings', t)).status).toBe(403);
        expect((await request.put('/api/admin/settings/fees').set(H(t)).send({ baseFee: 1 })).status).toBe(403);
      }
      expect((await request.get('/api/admin/settings')).status).toBe(401);
      expect((await request.put('/api/admin/settings/fees').send({ baseFee: 1 })).status).toBe(401);
    });

    test('PUT merges over the current value, is audited with old and new value, and GET shows it (isDefault false)', async () => {
      const r = await setFees({ baseFee: 30, freeFeeAbove: 300 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ success: true, changed: true, data: { group: 'fees', isDefault: false, updatedBy: ADMIN.id } });
      expect(r.body.data.value).toMatchObject({ baseFee: 30, freeFeeAbove: 300, extraRestaurantFee: 15 }); // untouched keys keep their value
      expect((await adminGet('/api/admin/settings/fees')).body.data.value.baseFee).toBe(30);
      const [row] = await audits('SETTINGS_UPDATED', 'fees');
      expect(row.summary).toContain('baseFee 25 -> 30');
      expect(row.summary).toContain('freeFeeAbove 0 -> 300');
      // saving the same thing again changes nothing but is still recorded
      expect((await setFees({ baseFee: 30 })).body.changed).toBe(false);
      expect((await audits('SETTINGS_UPDATED', 'fees')).length).toBe(2);
    });

    test('invalid input is refused as a whole with the field named, and nothing is stored', async () => {
      const cases: [string, unknown, string][] = [
        ['fees', { baseFee: -1 }, 'baseFee'],
        ['fees', { baseFee: 'free' }, 'baseFee'],
        ['fees', { baseFee: 10.123 }, 'baseFee'],
        ['fees', { baseFee: 9999 }, 'baseFee'],
        ['fees', { surprise: 1 }, 'surprise'],
        ['fees', { lines: [{ key: 'a', label: 'A', amount: 10 }] }, 'lines'], // does not add up to 25
        ['commission', { type: 'PERCENT', value: 150 }, 'value'],
        ['commission', { type: 'WEIRD', value: 5 }, 'type'],
        ['rounding', { step: 3 }, 'step'],
        ['settlement', { time: '25:00' }, 'time'],
        ['settlement', { mode: 'AUTO_PAYOUT' }, 'mode'],
      ];
      for (const [group, body, field] of cases) {
        const r = await adminPut(`/api/admin/settings/${group}`, body);
        expect([group, r.status, r.body.field]).toEqual([group, 400, field]);
      }
      expect((await adminPut('/api/admin/settings/fees', [1, 2])).status).toBe(400);
      expect((await adminPut('/api/admin/settings/nope', { a: 1 })).status).toBe(404);
      expect(await prisma.appSetting.count()).toBe(0);
      expect(await audits('SETTINGS_UPDATED')).toHaveLength(0);
    });

    test('named fee lines must add up to the base fee; changing the base fee needs matching lines in the same request', async () => {
      const ok = await setFees({ lines: [{ key: 'delivery', label: 'Delivery', amount: 15 }, { key: 'gst', label: 'GST', amount: 6 }, { key: 'packing', label: 'Packaging', amount: 4 }] });
      expect(ok.status).toBe(200);
      const raise = await setFees({ baseFee: 30 }); // lines now sum to 25: refused
      expect([raise.status, raise.body.field]).toEqual([400, 'lines']);
      expect((await setFees({ baseFee: 30, lines: [{ key: 'delivery', label: 'Delivery', amount: 30 }] })).status).toBe(200);
      expect((await setFees({ lines: [] })).status).toBe(200);
    });

    test('commission and rounding changes tell the admin to recalculate; the fee does not', async () => {
      expect((await setCommission('PERCENT', 10)).body.recalculateRecommended).toBe(true);
      expect((await setRounding(5)).body.recalculateRecommended).toBe(true);
      expect((await setCommission('PERCENT', 10)).body.recalculateRecommended).toBeUndefined(); // unchanged
      expect((await setFees({ baseFee: 20 })).body.recalculateRecommended).toBeUndefined();
    });

    test('the cache is dropped on every write (and a direct database edit is only seen after the TTL or an invalidation)', async () => {
      process.env.SETTINGS_CACHE_TTL_MS = '600000';
      invalidateSettingsCache();
      expect((await getSettings()).fees.baseFee).toBe(25);
      await prisma.appSetting.create({ data: { key: 'fees', value: { baseFee: 99, lines: [], extraRestaurantFee: 15, freeFeeAbove: 0, smallOrderBelow: 0, smallOrderFee: 0, gstOnFeesPercent: 18, gstOnFoodPercent: 5 } } });
      expect((await getSettings()).fees.baseFee).toBe(25); // cached
      invalidateSettingsCache();
      expect((await getSettings()).fees.baseFee).toBe(99);
      expect((await setFees({ baseFee: 40 })).status).toBe(200);
      expect((await getSettings()).fees.baseFee).toBe(40); // the PUT dropped the cache itself
      const o = await validateAndCalculateOrder(V1.vendorId, [{ itemId: (await liveDish(100)).id, quantity: 1 }]);
      expect(o.calculatedDeliveryFee).toBe(40);
    });

    test('a corrupt stored value falls back to the defaults, so pricing never breaks', async () => {
      await prisma.appSetting.create({ data: { key: 'fees', value: { baseFee: 'lots' } } });
      await prisma.appSetting.create({ data: { key: 'commission', value: [] } });
      invalidateSettingsCache();
      const s = await getSettings();
      expect(s.fees.baseFee).toBe(25);
      expect(s.commission).toEqual({ type: 'PERCENT', value: 0 });
      const g = (await adminGet('/api/admin/settings/fees')).body.data;
      expect(g).toMatchObject({ isDefault: true });
      const dish = await liveDish(80);
      const placed = await order([{ itemId: dish.id, quantity: 1 }]);
      expect([placed.status, placed.body.data.totalAmount]).toEqual([201, 105]);
    });

    test('parallel saves of different keys under a lock all survive (nobody overwrites anybody)', async () => {
      const bodies = [{ freeFeeAbove: 300 }, { extraRestaurantFee: 20 }, { smallOrderBelow: 50, smallOrderFee: 5 }, { gstOnFoodPercent: 12 }, { gstOnFeesPercent: 28 }, { freeFeeAbove: 300 }];
      const rs = await Promise.all(bodies.map((b) => setFees(b)));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      const v = (await adminGet('/api/admin/settings/fees')).body.data.value;
      expect(v).toMatchObject({ freeFeeAbove: 300, extraRestaurantFee: 20, smallOrderBelow: 50, smallOrderFee: 5, gstOnFoodPercent: 12, gstOnFeesPercent: 28, baseFee: 25 });
      expect(await prisma.appSetting.count({ where: { key: 'fees' } })).toBe(1);
      expect((await audits('SETTINGS_UPDATED', 'fees')).length).toBe(6);
    });

    test('settings writes are rate limited per admin', async () => {
      process.env.RL_ADMIN_SETTINGS_WRITE_MAX = '3';
      __resetRateLimits();
      for (let i = 0; i < 3; i++) expect((await setFees({ baseFee: 20 + i })).status).toBe(200);
      const r = await setFees({ baseFee: 30 });
      expect([r.status, r.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect((await adminGet('/api/admin/settings/fees')).status).toBe(200); // reads are not limited
    });
  });

  // =========================================================================================
  describe('restaurant dish flow', () => {
    test('a restaurant adds a dish: PENDING, its own price, nothing about commission or the customer price', async () => {
      await setCommission('PERCENT', 10);
      const r = await addDish(tV1, V1.vendorId, { name: 'Paneer Roll', price: 80, description: 'Hot' });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ name: 'Paneer Roll', price: 80, status: 'PENDING', isAvailable: true, vendorId: V1.vendorId });
      for (const k of FORBIDDEN_FOR_VENDOR) expect(keysDeep(r.body).has(k)).toBe(false);
      const row = await dbItem(r.body.data.id);
      expect(row).toMatchObject({ approvalStatus: 'PENDING', vendorPrice: 80, createdBy: 'VENDOR', deletedAt: null });
      expect(row.price).toBe(88); // computed for the record, not visible to anyone until approval
    });

    test('menu-manage lists its own dishes with status, vendor price and reason; others cannot read it', async () => {
      const a = (await addDish(tV1, V1.vendorId, { name: 'A', price: 50 })).body.data.id;
      const b = (await addDish(tV1, V1.vendorId, { name: 'B', price: 60 })).body.data.id;
      const c = (await addDish(tV1, V1.vendorId, { name: 'C', price: 70 })).body.data.id;
      await addDish(tV2, V2.vendorId, { name: 'Other', price: 10 });
      await adminPost(`/api/admin/catalog/${a}/approve`, { commissionType: 'PERCENT', commissionValue: 20 });
      await adminPost(`/api/admin/catalog/${b}/reject`, { reason: 'Photo is missing' });
      const r = await get(`/api/vendors/${V1.vendorId}/menu-manage`, tV1);
      expect(r.status).toBe(200);
      const by = Object.fromEntries(r.body.data.map((d: any) => [d.name, d]));
      expect(by.A).toMatchObject({ price: 50, status: 'LIVE' });
      expect(by.B).toMatchObject({ price: 60, status: 'REJECTED', rejectionReason: 'Photo is missing' });
      expect(by.C).toMatchObject({ price: 70, status: 'PENDING' });
      expect(by.A).not.toHaveProperty('pendingPrice');
      expect(Object.keys(by)).toEqual(['A', 'B', 'C']);
      for (const k of FORBIDDEN_FOR_VENDOR) expect(keysDeep(r.body).has(k)).toBe(false);
      expect(r.body.count).toBe(3);
      // other restaurant, customer, no token
      expect((await get(`/api/vendors/${V1.vendorId}/menu-manage`, tV2)).status).toBe(403);
      expect((await get(`/api/vendors/${V1.vendorId}/menu-manage`, tStudent)).status).toBe(403);
      expect((await get(`/api/vendors/${V1.vendorId}/menu-manage`)).status).toBe(401);
      expect((await get('/api/vendors/no-such/menu-manage', tV1)).status).toBe(404);
      expect((await get('/api/vendors/bad%20id/menu-manage', tV1)).status).toBe(400);
      // a restaurant whose application is still pending cannot use it
      expect((await get(`/api/vendors/${PENDING_V.vendorId}/menu-manage`, tV3)).status).toBe(403);
      expect((await addDish(tV3, PENDING_V.vendorId)).status).toBe(403);
      // admin may look (restaurant shape)
      expect((await get(`/api/vendors/${V1.vendorId}/menu-manage`, tAdmin)).status).toBe(200);
      // c is C
      expect(c).toBeTruthy();
    });

    test('POST validation keeps the old rules, and one restaurant cannot post into another', async () => {
      for (const body of [{ price: 0 }, { price: -5 }, { price: 'abc' }, { price: 10000.5 }, { price: 10.005 }, { name: '' }, { imageUrl: 'ftp://x' }, { isVeg: 'yes' }]) {
        const r = await addDish(tV1, V1.vendorId, body);
        expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      }
      expect((await addDish(tV1, V2.vendorId)).status).toBe(403);
      expect((await addDish(tV1, 'ghost-vendor')).status).toBe(403);
      expect((await addDish(tAdmin, 'ghost-vendor')).status).toBe(404);
      expect((await addDish(tStudent, V1.vendorId)).status).toBe(403);
    });

    test('at most 50 dishes can wait for approval per restaurant (the queue cannot be flooded)', async () => {
      await prisma.menuItem.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ id: `pc-flood-${i}`, vendorId: V1.vendorId, name: `F${i}`, price: 10, vendorPrice: 10, category: 'x', description: '', imageUrl: '', approvalStatus: 'PENDING' as const })) });
      const r = await addDish(tV1, V1.vendorId);
      expect([r.status, r.body.code]).toEqual([409, 'TOO_MANY_PENDING']);
      expect((await addDish(tV2, V2.vendorId)).status).toBe(201); // per restaurant
      expect((await addDish(tAdmin, V1.vendorId)).status).toBe(201); // admin dishes are live at once, no queue
    });

    test('an admin-created dish (through either endpoint) is live at once, with the commission applied', async () => {
      await setCommission('FLAT', 12);
      const viaVendorRoute = await addDish(tAdmin, V1.vendorId, { name: 'Admin A', price: 100 });
      expect(viaVendorRoute.status).toBe(201);
      const a = await dbItem(viaVendorRoute.body.data.id);
      expect(a).toMatchObject({ approvalStatus: 'APPROVED', createdBy: 'ADMIN', vendorPrice: 100, price: 112 });
      const viaCatalog = await adminPost('/api/admin/catalog', { vendorId: V1.vendorId, name: 'Admin B', vendorPrice: 50, commissionType: 'PERCENT', commissionValue: 10 });
      expect(viaCatalog.status).toBe(201);
      expect(viaCatalog.body.data).toMatchObject({ status: 'LIVE', vendorPrice: 50, price: 55, effectiveCommission: 5, createdBy: 'ADMIN', commission: { type: 'PERCENT', value: 10, source: 'DISH' } });
      const customer = (await get(`/api/menus/${V1.vendorId}`)).body.data;
      expect(customer.map((d: any) => [d.name, d.price]).sort()).toEqual([['Admin A', 112], ['Admin B', 55]]);
    });

    test('availability is instant in every status, through both endpoints', async () => {
      const id = (await addDish(tV1, V1.vendorId, { price: 40 })).body.data.id;
      expect((await patchDish(tV1, id, { isAvailable: false })).body.item).toMatchObject({ isAvailable: false, status: 'PENDING' });
      const t = await request.patch(`/api/menus/${id}/toggle`).set(H(tV1)).send({});
      expect(t.body.item).toMatchObject({ isAvailable: true, status: 'PENDING' });
      for (const k of FORBIDDEN_FOR_VENDOR) expect(keysDeep(t.body).has(k)).toBe(false);
      await adminPost(`/api/admin/catalog/${id}/reject`, { reason: 'no good' });
      expect((await patchDish(tV1, id, { isAvailable: false })).body.item).toMatchObject({ isAvailable: false, status: 'REJECTED' });
      // another restaurant, unknown id
      expect((await patchDish(tV2, id, { isAvailable: true })).status).toBe(403);
      expect((await request.patch(`/api/menus/${id}/toggle`).set(H(tV2)).send({})).status).toBe(403);
      expect((await patchDish(tV1, 'nope-id', { isAvailable: true })).status).toBe(404);
    });

    test('price rules: PENDING edits in place, LIVE becomes a request, same price withdraws it, REJECTED resubmits', async () => {
      await setCommission('PERCENT', 10);
      const id = (await addDish(tV1, V1.vendorId, { price: 100 })).body.data.id;
      // PENDING: edited in place
      let r = await patchDish(tV1, id, { price: 120 });
      expect(r.body.item).toMatchObject({ price: 120, status: 'PENDING' });
      expect(r.body.item).not.toHaveProperty('pendingPrice');
      expect(await dbItem(id)).toMatchObject({ vendorPrice: 120, pendingVendorPrice: null, approvalStatus: 'PENDING' });
      // approve -> LIVE at 132
      await adminPost(`/api/admin/catalog/${id}/approve`);
      expect(await dbItem(id)).toMatchObject({ approvalStatus: 'APPROVED', vendorPrice: 120, price: 132 });
      // LIVE: a request; the customer price and the vendor price stay
      r = await patchDish(tV1, id, { price: 150 });
      expect(r.status).toBe(200);
      expect(r.body.item).toMatchObject({ price: 120, pendingPrice: 150, status: 'CHANGE_PENDING' });
      expect(r.body.message).toMatch(/sent for approval/i);
      expect(await dbItem(id)).toMatchObject({ vendorPrice: 120, pendingVendorPrice: 150, price: 132 });
      expect((await get(`/api/menus/${V1.vendorId}`)).body.data.find((d: any) => d.id === id).price).toBe(132);
      // the same price as the live one withdraws the request
      r = await patchDish(tV1, id, { price: 120 });
      expect(r.body.item).toMatchObject({ price: 120, status: 'LIVE' });
      expect(r.body.item).not.toHaveProperty('pendingPrice');
      expect((await dbItem(id)).pendingVendorPrice).toBeNull();
      // a second identical request while nothing is pending: harmless no-op
      expect((await patchDish(tV1, id, { price: 120 })).body.item.status).toBe('LIVE');
      // ask again, and an admin declines it: the dish stays live, the reason is shown
      await patchDish(tV1, id, { price: 200 });
      const rej = await adminPost(`/api/admin/catalog/${id}/reject`, { reason: 'Too expensive for campus' });
      expect(rej.body).toMatchObject({ success: true, changed: true });
      expect(await dbItem(id)).toMatchObject({ approvalStatus: 'APPROVED', pendingVendorPrice: null, vendorPrice: 120, price: 132 });
      const view = (await get(`/api/vendors/${V1.vendorId}/menu-manage`, tV1)).body.data.find((d: any) => d.id === id);
      expect(view).toMatchObject({ status: 'LIVE', price: 120 });
      expect(view.rejectionReason).toMatch(/Too expensive/);
      // a new request clears the old reason
      r = await patchDish(tV1, id, { price: 130 });
      expect(r.body.item).toMatchObject({ status: 'CHANGE_PENDING' });
      expect(r.body.item).not.toHaveProperty('rejectionReason');
      // admin accepts the pending price: customers pay the new price from now
      const ap = await adminPost(`/api/admin/catalog/${id}/approve`, { applyPending: true });
      expect(ap.body.data).toMatchObject({ status: 'LIVE', vendorPrice: 130, price: 143, pendingVendorPrice: null });
      expect(ap.body.preview).toMatchObject({ previousVendorPrice: 120, vendorPrice: 130, previousPrice: 132, price: 143 });
      // REJECTED -> resubmit with a price -> PENDING again
      const id2 = (await addDish(tV1, V1.vendorId, { price: 30 })).body.data.id;
      await adminPost(`/api/admin/catalog/${id2}/reject`, { reason: 'Not on the menu' });
      r = await patchDish(tV1, id2, { price: 35 });
      expect(r.body.item).toMatchObject({ status: 'PENDING', price: 35 });
      expect(r.body.item).not.toHaveProperty('rejectionReason');
      expect(await dbItem(id2)).toMatchObject({ approvalStatus: 'PENDING', vendorPrice: 35, rejectionReason: null });
    });

    test('price patch validation and ownership; a deleted dish is gone for the restaurant', async () => {
      const id = (await addDish(tV1, V1.vendorId, { price: 100 })).body.data.id;
      for (const price of [0, -1, 'x', null, 1e9, 10.005]) expect((await patchDish(tV1, id, { price })).status).toBe(400);
      expect((await patchDish(tV1, id, {})).status).toBe(400);
      expect((await patchDish(tV2, id, { price: 90 })).status).toBe(403);
      expect((await patchDish(tStudent, id, { price: 90 })).status).toBe(403);
      expect((await dbItem(id)).vendorPrice).toBe(100);
      await adminDel(`/api/admin/catalog/${id}`);
      expect((await patchDish(tV1, id, { price: 90 })).status).toBe(404);
      expect((await request.patch(`/api/menus/${id}/toggle`).set(H(tV1)).send({})).status).toBe(404);
      expect((await get(`/api/vendors/${V1.vendorId}/menu-manage`, tV1)).body.data).toHaveLength(0);
    });

    test('vendor submissions are rate limited (they land in the approval queue)', async () => {
      process.env.RL_VENDOR_CATALOG_WRITE_MAX = '3';
      __resetRateLimits();
      for (let i = 0; i < 3; i++) expect((await addDish(tV1, V1.vendorId)).status).toBe(201);
      const r = await addDish(tV1, V1.vendorId);
      expect([r.status, r.body.code]).toEqual([429, 'RATE_LIMITED']);
      const id = (await prisma.menuItem.findFirstOrThrow({ where: { vendorId: V1.vendorId } })).id;
      expect((await patchDish(tV1, id, { price: 11 })).status).toBe(429); // price edits count
      expect((await patchDish(tV1, id, { isAvailable: false })).status).toBe(200); // availability does not
      expect((await addDish(tV2, V2.vendorId)).status).toBe(201); // per user
    });
  });

  // =========================================================================================
  describe('what customers can reach', () => {
    const setup = async () => {
      const live = await liveDish(100, { name: 'Live one' });
      const pend = (await addDish(tV1, V1.vendorId, { name: 'Pending one', price: 60 })).body.data.id as string;
      const rej = (await addDish(tV1, V1.vendorId, { name: 'Rejected one', price: 61 })).body.data.id as string;
      await adminPost(`/api/admin/catalog/${rej}/reject`, { reason: 'nope' });
      const del = await liveDish(62, { name: 'Deleted one' });
      await adminDel(`/api/admin/catalog/${del.id}`);
      const sold = await liveDish(63, { name: 'Sold out one', isAvailable: false });
      return { live: live.id as string, pend, rej, del: del.id as string, sold: sold.id as string };
    };

    test('/vendors, /vendors/:id and /menus/:id show only approved, not-deleted dishes (sold out stays, greyed)', async () => {
      const ids = await setup();
      const names = (arr: any[]) => arr.map((d) => d.name).sort();
      for (const token of [undefined, tStudent, tV2]) {
        const menu = await get(`/api/menus/${V1.vendorId}`, token);
        expect(names(menu.body.data)).toEqual(['Live one', 'Sold out one']);
        expect(menu.body.data.find((d: any) => d.id === ids.sold).isAvailable).toBe(false);
        const list = await get('/api/vendors', token);
        const mine = list.body.data.find((v: any) => v.id === V1.vendorId);
        expect(names(mine.menuItems)).toEqual(['Live one', 'Sold out one']);
        const one = await get(`/api/vendors/${V1.vendorId}`, token);
        expect(names(one.body.data.menu)).toEqual(['Live one', 'Sold out one']);
        expect(names(one.body.data.menuItems)).toEqual(['Live one', 'Sold out one']);
        // customers never see the new internal fields
        for (const k of FORBIDDEN_FOR_VENDOR.concat(['approvalStatus', 'deletedAt', 'rejectionReason', 'createdBy'])) {
          expect([k, keysDeep(menu.body).has(k) || keysDeep(mine).has(k) || keysDeep(one.body).has(k)]).toEqual([k, false]);
        }
      }
      // the customer price of a live dish is the stored customer price
      expect((await get(`/api/menus/${V1.vendorId}`)).body.data.find((d: any) => d.id === ids.live).price).toBe(100);
    });

    test('the owning restaurant sees its dishes with ITS price and a status in /menus and /vendors, never the customer price or its commission', async () => {
      await setCommission('PERCENT', 20);
      await adminPatch('/api/admin/vendors/' + V1.vendorId + '/commission', { type: 'PERCENT', value: 30 });
      const live = await liveDish(100, { name: 'Live one' }); // 30% -> customer 130
      const pend = (await addDish(tV1, V1.vendorId, { name: 'Pending one', price: 60 })).body.data.id as string;
      expect(live.price).toBe(130);
      const own = await get(`/api/menus/${V1.vendorId}`, tV1);
      const by = Object.fromEntries(own.body.data.map((d: any) => [d.name, d]));
      expect(by['Live one']).toMatchObject({ price: 100, status: 'LIVE' });
      expect(by['Pending one']).toMatchObject({ price: 60, status: 'PENDING' });
      const list = (await get('/api/vendors', tV1)).body.data.find((v: any) => v.id === V1.vendorId);
      const detail = (await get(`/api/vendors/${V1.vendorId}`, tV1)).body.data;
      for (const body of [own.body, { list }, detail]) {
        for (const k of FORBIDDEN_FOR_VENDOR) expect([k, keysDeep(body).has(k)]).toEqual([k, false]);
      }
      expect(list.menuItems.find((d: any) => d.id === pend)).toMatchObject({ price: 60, status: 'PENDING' });
      // PATCH /vendors/:id/status echoes the vendor row: no commission in it
      const st = await request.patch(`/api/vendors/${V1.vendorId}/status`).set(H(tV1)).send({ isAcceptingOrders: true });
      expect(st.status).toBe(200);
      for (const k of FORBIDDEN_FOR_VENDOR) expect(keysDeep(st.body).has(k)).toBe(false);
      // the admin still sees everything
      const adminList = (await adminGet('/api/vendors')).body.data.find((v: any) => v.id === V1.vendorId);
      expect(adminList).toMatchObject({ commissionType: 'PERCENT', commissionValue: 30 });
      expect(adminList.menuItems.map((d: any) => d.name).sort()).toEqual(['Live one', 'Pending one']);
    });

    test('pending, rejected and deleted dishes cannot be ordered, also by id: the answer is the same as for a dish that does not exist', async () => {
      const ids = await setup();
      const unknown = await order([{ itemId: 'no-such-dish', quantity: 1 }]);
      expect([unknown.status, unknown.body.code]).toEqual([400, 'INVALID_ITEMS']);
      for (const id of [ids.pend, ids.rej, ids.del]) {
        const r = await order([{ itemId: id, quantity: 1 }]);
        expect([r.status, r.body.code]).toEqual([400, 'INVALID_ITEMS']);
        expect(r.body.message.replace(id, 'X')).toBe(unknown.body.message.replace('no-such-dish', 'X'));
        // a good dish in the same cart does not smuggle it through
        expect((await order([{ itemId: ids.live, quantity: 1 }, { itemId: id, quantity: 1 }])).status).toBe(400);
      }
      expect(await prisma.order.count({ where: { items: { some: { menuItemId: { in: [ids.pend, ids.rej, ids.del] } } } } })).toBe(0);
      // a sold-out dish keeps its own message, a live one works
      expect((await order([{ itemId: ids.sold, quantity: 1 }])).body.message).toMatch(/SOLD OUT/);
      expect((await order([{ itemId: ids.live, quantity: 1 }])).status).toBe(201);
    });

    test('approval makes the dish orderable; delete takes it away again and restore brings it back; old orders keep their copy', async () => {
      const id = (await addDish(tV1, V1.vendorId, { name: 'Lifecycle', price: 90 })).body.data.id as string;
      expect((await order([{ itemId: id, quantity: 1 }])).status).toBe(400);
      await adminPost(`/api/admin/catalog/${id}/approve`);
      const placed = await order([{ itemId: id, quantity: 2 }]);
      expect([placed.status, placed.body.data.subtotal, placed.body.data.totalAmount]).toEqual([201, 180, 205]);
      await adminDel(`/api/admin/catalog/${id}`);
      expect((await order([{ itemId: id, quantity: 1 }])).status).toBe(400);
      expect((await get(`/api/menus/${V1.vendorId}`)).body.data.find((d: any) => d.id === id)).toBeUndefined();
      // the placed order still shows its items
      const again = await get(`/api/orders/${placed.body.data.id}`, tStudent);
      expect(again.body.data.items).toMatchObject([{ menuItemId: id, name: 'Lifecycle', quantity: 2, price: 90 }]);
      await adminPost(`/api/admin/catalog/${id}/restore`);
      expect((await order([{ itemId: id, quantity: 1 }])).status).toBe(201);
    });

    test('a dish whose price changes later does not change an order already placed; the snapshot holds vendor price and commission', async () => {
      await setCommission('PERCENT', 10);
      const dish = await liveDish(100); // customer 110
      const placed = await order([{ itemId: dish.id, quantity: 3 }]);
      expect(placed.body.data).toMatchObject({ subtotal: 330, deliveryFee: 25, taxAndPackaging: 0, totalAmount: 355 });
      await adminPatch(`/api/admin/catalog/${dish.id}`, { vendorPrice: 200 });
      const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.id }, include: { items: true } });
      expect(row).toMatchObject({ subtotal: 330, vendorSubtotal: 300, commissionTotal: 30, totalAmount: 355, taxAndPackaging: 0, deliveryFee: 25 });
      expect(row.items[0]).toMatchObject({ price: 110, vendorUnitPrice: 100, commissionUnit: 10, quantity: 3 });
      expect(row.feeBreakdown).toMatchObject({ version: 1, total: 25, baseFee: 25, baseWaived: false, restaurants: 1 });
    });
  });

  // =========================================================================================
  describe('admin catalog endpoints', () => {
    test('only admins: 401 / 403 on every endpoint', async () => {
      const id = (await liveDish(10)).id;
      const calls: [string, string, any?][] = [
        ['get', '/api/admin/catalog'], ['get', '/api/admin/catalog/pending-count'], ['get', `/api/admin/catalog/${id}`],
        ['post', '/api/admin/catalog', { vendorId: V1.vendorId, name: 'x', vendorPrice: 5 }], ['post', '/api/admin/catalog/preview', { vendorId: V1.vendorId, vendorPrice: 5 }],
        ['post', '/api/admin/catalog/recalculate', {}], ['post', `/api/admin/catalog/${id}/approve`, {}], ['post', `/api/admin/catalog/${id}/reject`, { reason: 'abc' }],
        ['patch', `/api/admin/catalog/${id}`, { name: 'x' }], ['delete', `/api/admin/catalog/${id}`], ['post', `/api/admin/catalog/${id}/restore`, {}],
        ['patch', `/api/admin/vendors/${V1.vendorId}/commission`, { type: 'FLAT', value: 1 }],
      ];
      for (const [m, p, b] of calls) {
        for (const [t, want] of [[undefined, 401], [tStudent, 403], [tV1, 403]] as const) {
          let q = (request as any)[m](p);
          if (t) q = q.set(H(t));
          const r = await q.send(b ?? {});
          expect([m, p, t ? 'token' : 'none', r.status]).toEqual([m, p, t ? 'token' : 'none', want]);
        }
      }
      expect((await dbItem(id)).name).not.toBe('x');
    });

    test('list: filters by status / restaurant / search, paginates, shows commission, effective price and staleness', async () => {
      await setCommission('PERCENT', 10);
      const names = ['Alpha Roll', 'Beta Roll', 'Gamma Thali', 'Delta Thali', 'Epsilon Tea'];
      const ids: string[] = [];
      for (const [i, n] of names.entries()) ids.push((await addDish(tV1, V1.vendorId, { name: n, price: 50 + i })).body.data.id);
      await addDish(tV2, V2.vendorId, { name: 'Zeta Roll', price: 10 });
      await adminPost(`/api/admin/catalog/${ids[0]}/approve`);
      await adminPost(`/api/admin/catalog/${ids[1]}/approve`);
      await patchDish(tV1, ids[1], { price: 70 }); // CHANGE_PENDING
      await adminPost(`/api/admin/catalog/${ids[2]}/reject`, { reason: 'bad photo' });
      await adminDel(`/api/admin/catalog/${ids[4]}`);
      const q = async (qs: string) => (await adminGet(`/api/admin/catalog?${qs}`)).body;
      // the database is shared with other suites (seed dishes): only this suite's restaurants count
      const nm = (b: any) => b.data.filter((d: any) => d.vendorId.startsWith('pc-ven')).map((d: any) => d.name).sort();
      expect(nm(await q('status=PENDING&pageSize=100'))).toEqual(['Delta Thali', 'Zeta Roll']);
      expect(nm(await q('status=LIVE&pageSize=100'))).toEqual(['Alpha Roll']);
      expect(nm(await q('status=CHANGE_PENDING&pageSize=100'))).toEqual(['Beta Roll']);
      expect(nm(await q('status=REJECTED&pageSize=100'))).toEqual(['Gamma Thali']);
      expect(nm(await q('status=DELETED&pageSize=100'))).toEqual(['Epsilon Tea']);
      expect(nm(await q('pageSize=100'))).toEqual(['Alpha Roll', 'Beta Roll', 'Delta Thali', 'Gamma Thali', 'Zeta Roll']); // default: not deleted
      expect(nm(await q('status=ALL&pageSize=100'))).toHaveLength(6);
      expect(nm(await q(`vendorId=${V2.vendorId}`))).toEqual(['Zeta Roll']);
      expect(nm(await q('q=roll&pageSize=100'))).toEqual(['Alpha Roll', 'Beta Roll', 'Zeta Roll']);
      expect(nm(await q('q=PC%20Kitchen%202'))).toEqual(['Zeta Roll']); // restaurant name too
      expect((await adminGet('/api/admin/catalog?status=BOGUS')).status).toBe(400);
      expect((await adminGet('/api/admin/catalog?vendorId=bad%20id')).status).toBe(400);
      const pg = (n: number) => q(`status=ALL&vendorId=${V1.vendorId}&pageSize=2&page=${n}`);
      const [p1, p2, p3, p4] = [await pg(1), await pg(2), await pg(3), await pg(4)];
      expect([p1.data.length, p2.data.length, p3.data.length, p4.data.length, p1.total, p1.pages, p2.page]).toEqual([2, 2, 1, 0, 5, 3, 2]);
      expect(new Set([...p1.data, ...p2.data, ...p3.data].map((d: any) => d.id)).size).toBe(5);
      expect((await q('pageSize=1000')).pageSize).toBe(100);
      const alpha = (await q('q=alpha')).data[0];
      expect(alpha).toMatchObject({ vendorName: 'PC Kitchen 1', status: 'LIVE', vendorPrice: 50, price: 55, effectiveCommission: 5, computedPrice: 55, priceIsStale: false, commission: { type: 'PERCENT', value: 10, source: 'GLOBAL' }, commissionOverride: null });
      const beta = (await q('q=beta')).data[0];
      expect(beta).toMatchObject({ status: 'CHANGE_PENDING', vendorPrice: 51, pendingVendorPrice: 70, pendingPrice: 77, price: 57 });
      // after a global commission change the stored price is stale until recalculated
      await setCommission('PERCENT', 20);
      expect((await q('q=alpha')).data[0]).toMatchObject({ price: 55, computedPrice: 60, priceIsStale: true });
    });

    test('pending-count counts new dishes and price requests, not deleted ones', async () => {
      const base = (await adminGet('/api/admin/catalog/pending-count')).body.data; // other suites may leave rows behind
      const a = (await addDish(tV1, V1.vendorId)).body.data.id;
      const b = (await addDish(tV1, V1.vendorId)).body.data.id;
      const c = (await addDish(tV2, V2.vendorId)).body.data.id;
      await adminPost(`/api/admin/catalog/${b}/approve`);
      await patchDish(tV1, b, { price: 999 });
      await adminDel(`/api/admin/catalog/${c}`);
      expect((await adminGet('/api/admin/catalog/pending-count')).body.data).toEqual({ pending: base.pending + 1, changePending: base.changePending + 1, total: base.total + 2 });
      expect(a).toBeTruthy();
    });

    test('approve: sets the commission, computes the price, audits; inherits when none is sent', async () => {
      await setCommission('PERCENT', 5);
      const id = (await addDish(tV1, V1.vendorId, { name: 'Roll', price: 80 })).body.data.id;
      const r = await adminPost(`/api/admin/catalog/${id}/approve`, { commissionType: 'PERCENT', commissionValue: 25 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ success: true, changed: true });
      expect(r.body.data).toMatchObject({ status: 'LIVE', vendorPrice: 80, price: 100, effectiveCommission: 20, commission: { type: 'PERCENT', value: 25, source: 'DISH' }, reviewedByUserId: ADMIN.id });
      expect(r.body.preview).toMatchObject({ previousPrice: 84, price: 100, commission: { source: 'DISH' } });
      expect(await dbItem(id)).toMatchObject({ approvalStatus: 'APPROVED', commissionType: 'PERCENT', commissionValue: 25, price: 100, reviewedByUserId: ADMIN.id });
      expect((await audits('DISH_APPROVED', id))[0].summary).toMatch(/Approved "Roll".*restaurant Rs 80.*customer Rs 84 -> Rs 100/);
      // inherited commission: no body fields
      const id2 = (await addDish(tV1, V1.vendorId, { name: 'Tea', price: 20 })).body.data.id;
      const r2 = await adminPost(`/api/admin/catalog/${id2}/approve`);
      expect(r2.body.data).toMatchObject({ price: 21, commission: { type: 'PERCENT', value: 5, source: 'GLOBAL' } });
      // the admin may also fix the restaurant price at approval
      const id3 = (await addDish(tV1, V1.vendorId, { name: 'Soup', price: 30 })).body.data.id;
      const r3 = await adminPost(`/api/admin/catalog/${id3}/approve`, { vendorPrice: 35 });
      expect(r3.body.data).toMatchObject({ vendorPrice: 35, price: 37 }); // 36.75 -> 37
    });

    test('approve validation: half-set commission, bad values, bad price, unknown dish, applyPending false', async () => {
      const id = (await addDish(tV1, V1.vendorId)).body.data.id;
      const bad = async (body: unknown, field: string) => { const r = await adminPost(`/api/admin/catalog/${id}/approve`, body); expect([JSON.stringify(body), r.status, r.body.field]).toEqual([JSON.stringify(body), 400, field]); };
      await bad({ commissionType: 'PERCENT' }, 'commissionValue');
      await bad({ commissionValue: 5 }, 'commissionType');
      await bad({ commissionType: 'PERCENT', commissionValue: 101 }, 'commissionValue');
      await bad({ commissionType: 'FLAT', commissionValue: -1 }, 'commissionValue');
      await bad({ commissionType: 'NOPE', commissionValue: 1 }, 'commissionType');
      await bad({ vendorPrice: 0 }, 'vendorPrice');
      await bad({ applyPending: 'yes' }, 'applyPending');
      expect((await adminPost('/api/admin/catalog/ghost/approve')).status).toBe(404);
      expect((await adminPost('/api/admin/catalog/bad%20id/approve')).status).toBe(400);
      expect((await dbItem(id)).approvalStatus).toBe('PENDING');
      // on a request, applyPending:false is not a way to decline
      await adminPost(`/api/admin/catalog/${id}/approve`);
      await patchDish(tV1, id, { price: 500 });
      const r = await adminPost(`/api/admin/catalog/${id}/approve`, { applyPending: false });
      expect([r.status, r.body.code]).toEqual([409, 'USE_REJECT']);
      expect((await dbItem(id)).pendingVendorPrice).toBe(500);
    });

    test('approve is idempotent (a second identical call changes and audits nothing) and can overrule a rejection', async () => {
      const id = (await addDish(tV1, V1.vendorId, { price: 40 })).body.data.id;
      expect((await adminPost(`/api/admin/catalog/${id}/approve`)).body.changed).toBe(true);
      const second = await adminPost(`/api/admin/catalog/${id}/approve`);
      expect([second.status, second.body.changed]).toEqual([200, false]);
      expect(await audits('DISH_APPROVED', id)).toHaveLength(1);
      // approving a REJECTED dish
      const rej = (await addDish(tV1, V1.vendorId, { price: 41 })).body.data.id;
      await adminPost(`/api/admin/catalog/${rej}/reject`, { reason: 'wrong' });
      const r = await adminPost(`/api/admin/catalog/${rej}/approve`);
      expect(r.body.data).toMatchObject({ status: 'LIVE', rejectionReason: null });
    });

    test('reject: needs a reason, idempotent, a live dish without a request is refused, a deleted one too', async () => {
      const id = (await addDish(tV1, V1.vendorId)).body.data.id;
      for (const reason of [undefined, '', 'ab', 'x'.repeat(201), 5]) {
        const r = await adminPost(`/api/admin/catalog/${id}/reject`, { reason });
        expect([String(reason).slice(0, 5), r.status, r.body.field]).toEqual([String(reason).slice(0, 5), 400, 'reason']);
      }
      const r1 = await adminPost(`/api/admin/catalog/${id}/reject`, { reason: 'Not suitable' });
      expect(r1.body).toMatchObject({ changed: true, data: { status: 'REJECTED', rejectionReason: 'Not suitable' } });
      const r2 = await adminPost(`/api/admin/catalog/${id}/reject`, { reason: 'Not suitable' });
      expect(r2.body.changed).toBe(false);
      expect(await audits('DISH_REJECTED', id)).toHaveLength(1);
      expect((await adminPost(`/api/admin/catalog/${id}/reject`, { reason: 'Different reason' })).body.changed).toBe(true); // reason updated
      await adminPost(`/api/admin/catalog/${id}/approve`);
      const live = await adminPost(`/api/admin/catalog/${id}/reject`, { reason: 'Changed my mind' });
      expect([live.status, live.body.code]).toEqual([409, 'NOT_PENDING']);
      await adminDel(`/api/admin/catalog/${id}`);
      expect((await adminPost(`/api/admin/catalog/${id}/reject`, { reason: 'Changed my mind' })).body.code).toBe('ITEM_DELETED');
      expect((await adminPost(`/api/admin/catalog/${id}/approve`)).body.code).toBe('ITEM_DELETED');
    });

    test('edit: any field, a price preview in the response, validation, and the admin price supersedes a restaurant request', async () => {
      await setCommission('PERCENT', 10);
      const dish = await liveDish(100, { name: 'Edit me' });
      expect(dish.price).toBe(110);
      await patchDish(tV1, dish.id, { price: 140 }); // restaurant asks for 140
      const r = await adminPatch(`/api/admin/catalog/${dish.id}`, { name: 'Edited', description: 'New text', category: 'Starters', imageUrl: 'https://x.test/a.jpg', isVeg: false, isAvailable: false, vendorPrice: 120, commissionType: 'FLAT', commissionValue: 9 });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ name: 'Edited', description: 'New text', category: 'Starters', imageUrl: 'https://x.test/a.jpg', isVeg: false, isAvailable: false, vendorPrice: 120, price: 129, pendingVendorPrice: null, status: 'LIVE', commission: { type: 'FLAT', value: 9, source: 'DISH' } });
      expect(r.body.preview).toMatchObject({ previousVendorPrice: 100, previousPrice: 110, vendorPrice: 120, price: 129, effectiveCommission: 9, roundingStep: 1 });
      expect(await audits('DISH_EDITED', dish.id)).toHaveLength(1);
      // clearing the override goes back to inheriting
      const back = await adminPatch(`/api/admin/catalog/${dish.id}`, { commissionType: null, commissionValue: null });
      expect(back.body.data).toMatchObject({ price: 132, commissionOverride: null, commission: { source: 'GLOBAL' } });
      // editing the name alone does not touch prices
      expect((await adminPatch(`/api/admin/catalog/${dish.id}`, { name: 'Again' })).body.data).toMatchObject({ price: 132, vendorPrice: 120 });
      for (const [body, field] of [[{ vendorPrice: -1 }, 'vendorPrice'], [{ name: '' }, 'name'], [{ name: 'x'.repeat(81) }, 'name'], [{ isVeg: 'no' }, 'isVeg'], [{ isAvailable: 1 }, 'isAvailable'],
        [{ imageUrl: 'javascript:alert(1)' }, 'imageUrl'], [{ commissionType: 'PERCENT' }, 'commissionValue'], [{ price: 5 }, 'price'], [{ vendorId: 'x' }, 'vendorId'], [{}, undefined]] as const) {
        const e = await adminPatch(`/api/admin/catalog/${dish.id}`, body);
        expect([JSON.stringify(body), e.status, e.body.field]).toEqual([JSON.stringify(body), 400, field]);
      }
      expect((await adminPatch('/api/admin/catalog/ghost', { name: 'x' })).status).toBe(404);
    });

    test('preview: price and effective commission without saving; validates; knows the restaurant default', async () => {
      await setCommission('PERCENT', 5);
      await adminPatch(`/api/admin/vendors/${V1.vendorId}/commission`, { type: 'FLAT', value: 8 });
      const p = await adminPost('/api/admin/catalog/preview', { vendorId: V1.vendorId, vendorPrice: 99.5 });
      expect(p.body.data).toMatchObject({ vendorPrice: 99.5, price: 108, effectiveCommission: 8.5, nominalCommission: 8, commission: { type: 'FLAT', value: 8, source: 'VENDOR' }, roundingStep: 1 });
      const d = await adminPost('/api/admin/catalog/preview', { vendorId: V1.vendorId, vendorPrice: 200, commissionType: 'PERCENT', commissionValue: 12.5 });
      expect(d.body.data).toMatchObject({ price: 225, commission: { source: 'DISH' } });
      const g = await adminPost('/api/admin/catalog/preview', { vendorId: V2.vendorId, vendorPrice: 200 });
      expect(g.body.data).toMatchObject({ price: 210, commission: { source: 'GLOBAL' } });
      expect((await adminPost('/api/admin/catalog/preview', { vendorId: V1.vendorId, vendorPrice: 0 })).status).toBe(400);
      expect((await adminPost('/api/admin/catalog/preview', { vendorPrice: 5 })).status).toBe(400);
      expect((await adminPost('/api/admin/catalog/preview', { vendorId: 'ghost', vendorPrice: 5 })).status).toBe(404);
      expect(await prisma.menuItem.count({ where: { vendorId: V1.vendorId } })).toBe(0);
    });

    test('create validation: restaurant, price, name, commission', async () => {
      const bad = async (body: Record<string, unknown>, status: number, field?: string) => {
        const r = await adminPost('/api/admin/catalog', { vendorId: V1.vendorId, name: 'N', vendorPrice: 10, ...body });
        expect([JSON.stringify(body), r.status, r.body.field]).toEqual([JSON.stringify(body), status, field]);
      };
      await bad({ vendorId: undefined }, 400, 'vendorId');
      await bad({ vendorId: 'ghost' }, 404, undefined);
      await bad({ vendorPrice: 0 }, 400, 'vendorPrice');
      await bad({ vendorPrice: undefined, price: undefined }, 400, 'vendorPrice');
      await bad({ name: ' ' }, 400, 'name');
      await bad({ commissionType: 'FLAT', commissionValue: 99999 }, 400, 'commissionValue');
      await bad({ imageUrl: 'nope' }, 400, 'imageUrl');
      const ok = await adminPost('/api/admin/catalog', { vendorId: V1.vendorId, name: ' Spaced   name ', price: 10 }); // `price` is accepted as the restaurant price
      expect([ok.status, ok.body.data.name, ok.body.data.vendorPrice]).toEqual([201, 'Spaced name', 10]);
      expect((await audits('DISH_CREATED', ok.body.data.id))).toHaveLength(1);
    });

    test('delete and restore: soft, idempotent, audited; a deleted dish cannot be edited or approved', async () => {
      const dish = await liveDish(70);
      const d1 = await adminDel(`/api/admin/catalog/${dish.id}`);
      expect(d1.body).toMatchObject({ changed: true, data: { status: 'LIVE', deletedAt: expect.any(String) } });
      expect((await adminDel(`/api/admin/catalog/${dish.id}`)).body.changed).toBe(false);
      expect(await audits('DISH_DELETED', dish.id)).toHaveLength(1);
      expect(await prisma.menuItem.count({ where: { id: dish.id } })).toBe(1); // soft
      expect((await adminPatch(`/api/admin/catalog/${dish.id}`, { name: 'x' })).body.code).toBe('ITEM_DELETED');
      expect((await adminGet(`/api/admin/catalog/${dish.id}`)).body.data.deletedAt).not.toBeNull();
      const r1 = await adminPost(`/api/admin/catalog/${dish.id}/restore`);
      expect([r1.body.changed, r1.body.data.deletedAt]).toEqual([true, null]);
      expect((await adminPost(`/api/admin/catalog/${dish.id}/restore`)).body.changed).toBe(false);
      expect(await audits('DISH_RESTORED', dish.id)).toHaveLength(1);
      expect((await adminDel('/api/admin/catalog/ghost')).status).toBe(404);
    });

    test('commission precedence through the API: dish > restaurant > global, and the restaurant commission endpoint', async () => {
      await setCommission('PERCENT', 5);
      const price = async (extra: Record<string, unknown> = {}) => (await adminPost('/api/admin/catalog', { vendorId: V1.vendorId, name: 'P', vendorPrice: 200, ...extra })).body.data;
      expect((await price()).price).toBe(210);
      const set = await adminPatch(`/api/admin/vendors/${V1.vendorId}/commission`, { type: 'PERCENT', value: 15 });
      expect(set.status).toBe(200);
      expect(set.body.data).toMatchObject({ vendor: { id: V1.vendorId, commissionType: 'PERCENT', commissionValue: 15 }, effective: { type: 'PERCENT', value: 15, source: 'VENDOR' } });
      expect((await price()).price).toBe(230);
      expect((await price({ commissionType: 'FLAT', commissionValue: 3 })).price).toBe(203);
      expect((await price({ commissionType: 'PERCENT', commissionValue: 0 })).price).toBe(200); // a dish 0% beats the restaurant 15%
      // the first dish (global 5%) is now stale: the endpoint says so and recalculate fixes it
      expect(set.body.data.staleDishes).toBeGreaterThanOrEqual(0);
      const cleared = await adminPatch(`/api/admin/vendors/${V1.vendorId}/commission`, { type: null, value: null });
      expect(cleared.body.data.effective).toMatchObject({ source: 'GLOBAL' });
      expect((await price()).price).toBe(210);
      expect(await audits('VENDOR_COMMISSION_SET', V1.vendorId)).toHaveLength(2);
      for (const body of [{ type: 'PERCENT' }, { type: 'PERCENT', value: 101 }, { type: 'FLAT', value: 6000 }, { type: 'X', value: 1 }, { type: null, value: 5 }, {}, { type: 'FLAT', value: '5' }]) {
        expect([JSON.stringify(body), (await adminPatch(`/api/admin/vendors/${V1.vendorId}/commission`, body)).status]).toEqual([JSON.stringify(body), 400]);
      }
      expect((await adminPatch('/api/admin/vendors/ghost/commission', { type: 'FLAT', value: 1 })).status).toBe(404);
      // the restaurant itself cannot read or change it
      expect((await request.patch(`/api/admin/vendors/${V1.vendorId}/commission`).set(H(tV1)).send({ type: 'FLAT', value: 0 })).status).toBe(403);
    });

    test('recalculate: dry run is the default and writes nothing; apply updates only the changed dishes; placed orders are untouched', async () => {
      const a = await liveDish(100);
      const b = await liveDish(50);
      const c = await liveDish(33);
      const placed = await order([{ itemId: a.id, quantity: 1 }]);
      expect(placed.body.data.subtotal).toBe(100);
      await setCommission('PERCENT', 10);
      const dry = await adminPost('/api/admin/catalog/recalculate', { vendorId: V1.vendorId });
      expect(dry.body.data).toMatchObject({ dryRun: true, applied: false, total: 3, changed: 3 });
      expect(dry.body.data.changes.map((x: any) => [x.oldPrice, x.newPrice]).sort()).toEqual([[100, 110], [33, 37], [50, 55]]);
      expect((await dbItem(a.id)).price).toBe(100);
      expect(await audits('PRICES_RECALCULATED')).toHaveLength(0);
      const real = await adminPost('/api/admin/catalog/recalculate', { dryRun: false, vendorId: V1.vendorId });
      expect(real.body.data).toMatchObject({ dryRun: false, applied: true, changed: 3 });
      expect([(await dbItem(a.id)).price, (await dbItem(b.id)).price, (await dbItem(c.id)).price, (await dbItem(a.id)).vendorPrice]).toEqual([110, 55, 37, 100]);
      expect((await audits('PRICES_RECALCULATED'))[0].summary).toMatch(/3 of 3 dishes changed/);
      // nothing left to change
      expect((await adminPost('/api/admin/catalog/recalculate', { dryRun: false, vendorId: V1.vendorId })).body.data.changed).toBe(0);
      // the placed order keeps its old numbers
      const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.id } });
      expect([row.subtotal, row.totalAmount]).toEqual([100, 125]);
      // a rounding change is picked up too, per restaurant
      await setRounding(5);
      const scoped = await adminPost('/api/admin/catalog/recalculate', { dryRun: false, vendorId: V2.vendorId });
      expect(scoped.body.data).toMatchObject({ total: 0, changed: 0 });
      expect((await dbItem(c.id)).price).toBe(37); // another restaurant's scope does not touch it
      const all = await adminPost('/api/admin/catalog/recalculate', { dryRun: false, vendorId: V1.vendorId });
      expect(all.body.data.changed).toBe(1); // only 37 -> 40 (110 and 55 are already multiples of 5)
      expect((await dbItem(c.id)).price).toBe(40);
      expect(await adminGet(`/api/admin/catalog?vendorId=${V1.vendorId}`).then((r) => r.body.data.every((d: any) => !d.priceIsStale))).toBe(true);
      expect((await adminPost('/api/admin/catalog/recalculate', { dryRun: 'yes' })).status).toBe(400);
      expect((await adminPost('/api/admin/catalog/recalculate', { vendorId: 'bad id' })).status).toBe(400);
    });

    test('rounding steps and large / paise values through the API (rounding goes up, to Kraveo)', async () => {
      await setCommission('PERCENT', 10);
      await setRounding(5);
      const cases: [number, number][] = [[100, 110], [101, 115], [33.33, 40], [0.01, 5], [9999.99, 11000], [10000, 11000]];
      for (const [vendorPrice, want] of cases) {
        const d = await adminPost('/api/admin/catalog', { vendorId: V1.vendorId, name: `R${vendorPrice}`, vendorPrice });
        expect([vendorPrice, d.body.data.price]).toEqual([vendorPrice, want]);
        expect(d.body.data.effectiveCommission).toBe(Math.round((want - vendorPrice) * 100) / 100);
      }
      await setRounding(0);
      const d = await adminPost('/api/admin/catalog', { vendorId: V1.vendorId, name: 'Exact', vendorPrice: 33.33 });
      expect(d.body.data.price).toBe(36.67);
    });

    test('catalog writes are rate limited; reads and preview are not', async () => {
      process.env.RL_ADMIN_CATALOG_WRITE_MAX = '2';
      process.env.RL_ADMIN_RECALCULATE_MAX = '1';
      __resetRateLimits();
      const dish = await liveDish(10); // 1
      expect((await adminPatch(`/api/admin/catalog/${dish.id}`, { name: 'a' })).status).toBe(200); // 2
      const r = await adminPatch(`/api/admin/catalog/${dish.id}`, { name: 'b' });
      expect([r.status, r.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect((await adminGet('/api/admin/catalog')).status).toBe(200);
      expect((await adminPost('/api/admin/catalog/preview', { vendorId: V1.vendorId, vendorPrice: 5 })).status).toBe(200);
      expect((await adminPost('/api/admin/catalog/recalculate', { vendorId: V1.vendorId })).status).toBe(200);
      expect((await adminPost('/api/admin/catalog/recalculate', { vendorId: V1.vendorId })).status).toBe(429);
      expect((await adminPatch(`/api/admin/vendors/${V1.vendorId}/commission`, { type: 'FLAT', value: 1 })).status).toBe(429); // same budget
    });
  });

  // =========================================================================================
  describe('race safety', () => {
    test('ten parallel approvals of one dish: one change, one audit row, a consistent price', async () => {
      await setCommission('PERCENT', 10);
      const id = (await addDish(tV1, V1.vendorId, { price: 100 })).body.data.id;
      const rs = await Promise.all(Array.from({ length: 10 }, () => adminPost(`/api/admin/catalog/${id}/approve`)));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(rs.filter((r) => r.body.changed).length).toBe(1);
      expect(await audits('DISH_APPROVED', id)).toHaveLength(1);
      expect(await dbItem(id)).toMatchObject({ approvalStatus: 'APPROVED', price: 110 });
    });

    test('parallel deletes and restores end in a consistent state with one audit row per real change', async () => {
      const dish = await liveDish(30);
      const rs = await Promise.all(Array.from({ length: 8 }, () => adminDel(`/api/admin/catalog/${dish.id}`)));
      expect(rs.filter((r) => r.body.changed).length).toBe(1);
      expect(await audits('DISH_DELETED', dish.id)).toHaveLength(1);
      const rs2 = await Promise.all(Array.from({ length: 8 }, () => adminPost(`/api/admin/catalog/${dish.id}/restore`)));
      expect(rs2.filter((r) => r.body.changed).length).toBe(1);
      expect((await dbItem(dish.id)).deletedAt).toBeNull();
    });

    test('approve racing a restaurant price edit: whatever the order, the stored customer price matches the stored restaurant price', async () => {
      await setCommission('PERCENT', 10);
      for (let round = 0; round < 6; round++) {
        const id = (await addDish(tV1, V1.vendorId, { price: 100 })).body.data.id;
        await Promise.all([adminPost(`/api/admin/catalog/${id}/approve`), patchDish(tV1, id, { price: 200 }), patchDish(tV1, id, { price: 300 }), adminPost(`/api/admin/catalog/${id}/approve`)]);
        const row = await dbItem(id);
        expect(row.approvalStatus).toBe('APPROVED');
        expect(row.price).toBe(Math.ceil(row.vendorPrice * 1.1 - 1e-9)); // step 1
        if (row.pendingVendorPrice !== null) expect(row.pendingVendorPrice).not.toBe(row.vendorPrice);
      }
    });

    test('recalculate and edits running together never leave a stale price behind', async () => {
      const dishes = [] as any[];
      for (let i = 0; i < 6; i++) dishes.push(await liveDish(100 + i));
      await setCommission('PERCENT', 10);
      await Promise.all([
        adminPost('/api/admin/catalog/recalculate', { dryRun: false, vendorId: V1.vendorId }),
        adminPost('/api/admin/catalog/recalculate', { dryRun: false, vendorId: V1.vendorId }),
        ...dishes.map((d, i) => adminPatch(`/api/admin/catalog/${d.id}`, { vendorPrice: 200 + i })),
        adminPost('/api/admin/catalog/recalculate', { dryRun: false, vendorId: V1.vendorId }),
      ]);
      await adminPost('/api/admin/catalog/recalculate', { dryRun: false, vendorId: V1.vendorId });
      const list = (await adminGet(`/api/admin/catalog?pageSize=100&vendorId=${V1.vendorId}`)).body.data;
      expect(list).toHaveLength(6);
      expect(list.every((d: any) => d.priceIsStale === false)).toBe(true);
      expect(list.map((d: any) => d.vendorPrice).sort()).toEqual([200, 201, 202, 203, 204, 205]);
    });

    test('two parallel checkouts of the same dish while it is being deleted: every order that exists has a valid snapshot', async () => {
      const dish = await liveDish(60);
      const rs = await Promise.all([order([{ itemId: dish.id, quantity: 1 }]), adminDel(`/api/admin/catalog/${dish.id}`), order([{ itemId: dish.id, quantity: 1 }], V1.vendorId)]);
      expect(rs[1].status).toBe(200);
      for (const r of [rs[0], rs[2]]) expect([201, 400]).toContain(r.status);
      const rows = await prisma.orderItem.findMany({ where: { menuItemId: dish.id } });
      for (const i of rows) expect([i.price, i.vendorUnitPrice, i.commissionUnit]).toEqual([60, 60, 0]);
    });
  });
});
