/**
 * Fixes from the adversarial review of the admin user management (Docs/bughunt/ADMIN_MGMT_review.md): typed-name normalisation, self-delete vs an
 * admin block, a rider holding a PLACED order, the per-request cancel cap and real refund outcomes, audit meta masking, serialised password
 * resets, attaching a paused login, rate limits of the older routes, the PASSWORD_RESET audit target. Real PostgreSQL and HTTP.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { __resetLoginLimiter } from '../../src/services/loginLimiter';
import { hashPassword } from '../../src/services/password';
import { writeAudit } from '../../src/services/audit';
import { MAX_CANCELS_PER_REQUEST } from '../../src/services/adminOrders';
import { World, Customer, Vendor, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi } from '../harness/journey';

jest.setTimeout(180_000);
const P = 'rf';
const PW = 'Sup3rSecret!';

describe('Admin user management: review fixes', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let request: ReturnType<typeof supertest>;
  const admin = () => ({ Authorization: `Bearer ${W.admin.token}` });
  const urow = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
  const login = (phone: string, password: string) => request.post('/api/auth/partner-login').send({ phone, password, role: 'VENDOR' });

  const paidOrder = async (c: Customer, v: Vendor) => {
    const placed = await api.place(c, v);
    const id = placed.body.data.id as string;
    const cp = await api.createPayment(c, id);
    const payId = `pay_${randomUUID().slice(0, 12)}`;
    ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
    expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
    return { id, payId };
  };
  /** n unpaid open orders of `c` at `v`, written directly (checkout limits unpaid orders to a few). */
  const manyOpen = async (c: Customer, v: Vendor, n: number) => {
    for (let i = 0; i < n; i++) await prisma.order.create({ data: { customerId: c.id, vendorId: v.vendorId, totalAmount: 50, dropoffHostel: 'BH2', status: 'PLACED', paymentStatus: 'PENDING', items: { create: [{ menuItemId: v.items[0].id, name: 'x', quantity: 1, price: 50 }] } } });
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    W = await createWorld(P, '6', { customers: 3, vendors: 3, riders: 2 });
    server = await startTestServer(0);
    request = supertest(server.app);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await __waitForBackgroundWork();
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await resetWorldState(W);
    await prisma.user.updateMany({ where: { id: { startsWith: `${P}-` } }, data: { accountStatus: 'ACTIVE', statusReason: null, deletedAt: null } });
    for (const u of [...W.customers, ...W.vendors, ...W.riders]) await prisma.user.update({ where: { id: u.id }, data: { name: u.name, phone: u.phone, email: null, googleSub: null, passwordHash: await hashPassword(PW) } });
    await prisma.vendor.deleteMany({ where: { id: { startsWith: `${P}-ven-x` } } });
    for (const v of W.vendors) await prisma.vendor.update({ where: { id: v.vendorId }, data: { userId: v.id, removedAt: null, approvalStatus: 'APPROVED', isAcceptingOrders: true } });
    await prisma.driverPartner.updateMany({ where: { id: { startsWith: `${P}-dp` } }, data: { approvalStatus: 'APPROVED', dutyStatus: 'ONLINE' } });
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    __resetRateLimits();
    __resetLoginLimiter();
    api.calls.length = 0;
  });
  afterEach(async () => {
    await __waitForBackgroundWork();
    setPaymentProvider(null);
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]);
  });
  afterAll(async () => {
    await stopTestServer(server);
    await prisma.vendor.deleteMany({ where: { id: { startsWith: `${P}-ven-x` } } });
    await purgeWorld(P);
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------------------------
  test('#5 typed name: both sides are normalised (ZWJ / ZWNJ / LRM / RLO / controls, spacing, case), so a name with invisible characters can be removed; garbage still mismatches', async () => {
    const c = W.customers[0];
    const stored = 'Asha‍ Ver‌ma‎';
    await prisma.user.update({ where: { id: c.id }, data: { name: stored } });
    const url = `/api/admin/customers/${c.id}/remove`;
    const body = (confirmName: unknown) => ({ reason: 'Fraud case', confirmName });
    for (const bad of ['', '‍‎', 'Asha', 'Asha Verma X', 5, null]) {
      const res = await request.post(url).set(admin()).send(body(bad));
      expect([JSON.stringify(bad), res.status, res.body.code]).toEqual([JSON.stringify(bad), 400, 'CONFIRM_MISMATCH']);
    }
    expect((await urow(c.id)).accountStatus).toBe('ACTIVE');
    // pasted with the invisible characters, typed without them, with a right-to-left override and a control character, in other case
    expect((await request.post(url).set(admin()).send(body('  aSHA   verma‮\u0007 '))).status).toBe(200);
    // restaurant and rider names
    const v = W.vendors[0];
    await prisma.vendor.update({ where: { id: v.vendorId }, data: { name: 'Dhaba​ Sharma⁠' } });
    expect((await request.post(`/api/admin/vendors/${v.vendorId}/remove`).set(admin()).send({ reason: 'Hygiene failure', confirmName: 'dhaba sharma' })).status).toBe(200);
    const r = W.riders[0];
    await prisma.driverPartner.update({ where: { id: r.profileId }, data: { name: 'Ravi‍ Kumar' } });
    expect((await request.post(`/api/admin/drivers/${r.profileId}/remove`).set(admin()).send({ reason: 'Left the company', confirmName: 'RAVI KUMAR' })).status).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  test('#6 self-delete racing an admin block: a request already past the token check answers the block (403) and does NOT erase the e-mail / Google id; a normal delete still works', async () => {
    const c = W.customers[1];
    await prisma.user.update({ where: { id: c.id }, data: { email: 'keep@rf.kraveo.test', googleSub: 'sub-rf-keep' } });
    // The "admin" transaction holds the user lock, the customer's DELETE passes requireAuth (still ACTIVE) and queues on the lock.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => { locked = r; });
    const admin_ = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${c.id} FOR UPDATE`;
      await tx.user.update({ where: { id: c.id }, data: { accountStatus: 'SUSPENDED', statusReason: 'Fake orders' } });
      locked();
      await gate;
    });
    await hasLock;
    const del = request.delete('/api/auth/account').set({ Authorization: `Bearer ${c.token}` }).then((r) => r);
    await new Promise((r) => setTimeout(r, 300)); // the DELETE is now waiting for the lock
    release();
    await admin_;
    const res = await del;
    expect([res.status, res.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
    expect(await urow(c.id)).toMatchObject({ accountStatus: 'SUSPENDED', email: 'keep@rf.kraveo.test', googleSub: 'sub-rf-keep', deletedAt: null, name: c.name });
    // a customer who is not blocked can still delete the account
    const other = W.customers[2];
    const ok = await request.delete('/api/auth/account').set({ Authorization: `Bearer ${other.token}` });
    expect([ok.status, ok.body.success]).toEqual([200, true]);
    expect((await urow(other.id)).deletedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------------------------
  test('#7 a rider holding a PLACED order (pre-assigned by an admin): removal and the status route see it (409) and RELEASE gives it back', async () => {
    const [r] = W.riders;
    const o = await paidOrder(W.customers[0], W.vendors[0]);
    expect((await api.reassign(W.admin, o.id, r.id, true)).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PLACED');
    const body = { reason: 'Left the company', confirmName: r.name };
    const refused = await request.post(`/api/admin/drivers/${r.profileId}/remove`).set(admin()).send(body);
    expect([refused.status, refused.body.code, refused.body.orders]).toEqual([409, 'HAS_ACTIVE_DELIVERY', [{ id: o.id, status: 'PLACED' }]]);
    const old = await request.post(`/api/admin/partners/driver/${r.profileId}/status`).set(admin()).send({ status: 'SUSPENDED', reason: 'No-show' });
    expect([old.status, old.body.code]).toEqual([409, 'HAS_ACTIVE_DELIVERY']);
    const impact = await request.get(`/api/admin/drivers/${r.profileId}/impact`).set(admin());
    expect(impact.body.data.activeDeliveries).toEqual([{ id: o.id, status: 'PLACED' }]);
    const ok = await request.post(`/api/admin/drivers/${r.profileId}/remove`).set(admin()).send({ ...body, handover: 'RELEASE' });
    expect([ok.status, ok.body.released]).toEqual([200, [o.id]]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).driverId).toBeNull();
  });

  // ---------------------------------------------------------------------------------------------
  describe('#8 cancel with refunds: cap per request and the real refund outcome', () => {
    test(`at most ${MAX_CANCELS_PER_REQUEST} orders per call, the rest listed in remaining (untouched, no 409); calling again continues; a combined order counts once`, async () => {
      const c = W.customers[0];
      await manyOpen(c, W.vendors[0], MAX_CANCELS_PER_REQUEST + 5);
      const first = await request.post(`/api/admin/customers/${c.id}/suspend`).set(admin()).send({ reason: 'Fake orders', openOrders: 'CANCEL' });
      expect([first.status, first.body.changed, first.body.cancelled.length, first.body.remaining.length, first.body.failed]).toEqual([200, true, MAX_CANCELS_PER_REQUEST, 5, []]);
      expect(first.body.data.openOrders).toHaveLength(5);
      expect(await prisma.order.count({ where: { id: { in: first.body.remaining } , status: 'PLACED' } })).toBe(5);
      const second = await request.post(`/api/admin/customers/${c.id}/suspend`).set(admin()).send({ reason: 'Fake orders', openOrders: 'CANCEL' });
      expect([second.status, second.body.changed, second.body.cancelled.length, second.body.remaining]).toEqual([200, false, 5, []]);
      expect(await prisma.order.count({ where: { customerId: c.id, status: { notIn: ['CANCELLED', 'DELIVERED'] } } })).toBe(0);
      // the restaurant routes report the same way (suspend; the second call continues although the restaurant is already suspended)
      const v = W.vendors[1];
      await manyOpen(W.customers[1], v, MAX_CANCELS_PER_REQUEST + 2);
      const s1 = await request.post(`/api/admin/vendors/${v.vendorId}/suspend`).set(admin()).send({ reason: 'Hygiene failure', openOrders: 'CANCEL' });
      expect([s1.body.cancelled.length, s1.body.remaining.length]).toEqual([MAX_CANCELS_PER_REQUEST, 2]);
      const s2 = await request.post(`/api/admin/vendors/${v.vendorId}/suspend`).set(admin()).send({ reason: 'Hygiene failure', openOrders: 'CANCEL' });
      expect([s2.body.changed, s2.body.cancelled.length, s2.body.remaining]).toEqual([false, 2, []]);
    });

    test('a refund that fails is reported as FAILED with a message (never "started"); a done one as DONE; unpaid as NONE; the order stays cancelled and the refund is retried later, once', async () => {
      const c = W.customers[0];
      const paid = await paidOrder(c, W.vendors[0]);
      const unpaid = await api.place(W.customers[0], W.vendors[1]);
      ledger.mode.refundDown = true;
      const res = await request.post(`/api/admin/customers/${c.id}/suspend`).set(admin()).send({ reason: 'Fake orders', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      ledger.mode.refundDown = false;
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.cancelled.map((x: any) => [x.orderId, x]));
      expect(byId[unpaid.body.data.id].refund).toBe('NONE');
      expect(byId[paid.id]).toMatchObject({ refund: 'FAILED', refundMessage: expect.stringContaining('Razorpay is down') }); // the real outcome, not a promise
      const row = await prisma.order.findUniqueOrThrow({ where: { id: paid.id } });
      expect(row.status).toBe('CANCELLED');
      expect(row.refundStatus).toBe('FAILED'); // retried by the automatic sweep and by the admin button
      expect(ledger.refundsOf(paid.payId)).toHaveLength(0);
      // the provider is back: the admin retry (existing endpoint) refunds exactly once
      await prisma.order.updateMany({ where: { id: paid.id, refundStatus: 'PENDING' }, data: { refundStatus: 'FAILED' } });
      expect((await api.retryRefund(W.admin, paid.id)).status).toBe(200);
      await __waitForBackgroundWork();
      expect(ledger.refundsOf(paid.payId)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  test('#9 audit meta keeps harmless keys (passwordGenerated, tokenVersion, footprint) and still hides real secrets', async () => {
    await writeAudit('RF_META', 'TEST', 'rf-1', 'x', { meta: { passwordGenerated: true, tokenVersion: 3, footprint: 'a', password: 'p', newPassword: 'p', passwordHash: 'h', accessToken: 't', secret: 's', accountNumber: '123', otp: '1', nested: { apiKey: 'k', ok: 1 } } });
    const row = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'RF_META' } });
    expect(row.meta).toEqual({ passwordGenerated: true, tokenVersion: 3, footprint: 'a', password: '[hidden]', newPassword: '[hidden]', passwordHash: '[hidden]', accessToken: '[hidden]', secret: '[hidden]', accountNumber: '[hidden]', otp: '[hidden]', nested: { apiKey: '[hidden]', ok: 1 } });
    const x = await prisma.vendor.create({ data: { id: `${P}-ven-x1`, userId: null, name: 'RF Kitchen', category: 'Test', address: 'x', bannerImage: '', approvalStatus: 'APPROVED' } });
    const created = await request.post(`/api/admin/vendors/${x.id}/owner`).set(admin()).send({ name: 'Ramesh Kumar', phone: '9876543801' });
    expect(created.status).toBe(201);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'OWNER_CREATED' } });
    expect(audit.meta).toMatchObject({ passwordGenerated: true, attachedExisting: false });
    expect(JSON.stringify(audit)).not.toContain(created.body.generatedPassword);
    await prisma.user.deleteMany({ where: { phone: '+91 9876543801' } });
  });

  // ---------------------------------------------------------------------------------------------
  test('#10 / #17 password resets of one owner run one after the other: the answer with the newest issuedAt is the password that works; the audit row targets the owner USER', async () => {
    const v = W.vendors[0];
    const answers = await Promise.all(Array.from({ length: 5 }, () => request.post(`/api/admin/vendors/${v.vendorId}/owner/reset-password`).set(admin()).send({})));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    const stamps = answers.map((a) => a.body.issuedAt as string);
    expect(new Set(stamps).size).toBe(5); // serialised: five distinct commits
    const newest = answers.reduce((a, b) => (a.body.issuedAt > b.body.issuedAt ? a : b));
    expect((await login(v.phone, newest.body.generatedPassword)).status).toBe(200);
    for (const a of answers.filter((x) => x !== newest)) expect((await login(v.phone, a.body.generatedPassword)).status).toBe(401);
    const rows = await prisma.adminAuditLog.findMany({ where: { action: 'PASSWORD_RESET' } });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.targetType === 'USER' && r.targetId === v.id)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(newest.body.generatedPassword);
  });

  // ---------------------------------------------------------------------------------------------
  test('#11 attaching an existing login: a login paused for another reason or removed is refused (LOGIN_NOT_ACTIVE / OWNER_REMOVED) and stays paused; one paused by a detach is attachable', async () => {
    const [a, b] = W.vendors;
    const x = await prisma.vendor.create({ data: { id: `${P}-ven-x2`, userId: null, name: 'RF Kitchen 2', category: 'Test', address: 'x', bannerImage: '', approvalStatus: 'APPROVED' } });
    // b: disabled by an admin, then its restaurant is taken away by other means (no restaurant left)
    await request.post(`/api/admin/vendors/${b.vendorId}/owner/disable`).set(admin()).send({ reason: 'Owner not answering' });
    await prisma.vendor.update({ where: { id: b.vendorId }, data: { userId: null } });
    const refused = await request.post(`/api/admin/vendors/${x.id}/owner`).set(admin()).send({ existingUserId: b.id });
    expect([refused.status, refused.body.code]).toEqual([409, 'LOGIN_NOT_ACTIVE']);
    expect(await urow(b.id)).toMatchObject({ accountStatus: 'SUSPENDED', statusReason: 'Owner not answering' });
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: x.id } })).userId).toBeNull();
    // a removed login
    await prisma.user.update({ where: { id: b.id }, data: { accountStatus: 'REMOVED', deletedAt: new Date() } });
    expect((await request.post(`/api/admin/vendors/${x.id}/owner`).set(admin()).send({ existingUserId: b.id })).status).toBe(409);
    // a login paused by a detach is the normal way to move an owner
    await request.post(`/api/admin/vendors/${a.vendorId}/owner/detach`).set(admin()).send({ reason: 'Moving the owner' });
    const ok = await request.post(`/api/admin/vendors/${x.id}/owner`).set(admin()).send({ existingUserId: a.id });
    expect([ok.status, ok.body.owner.accountStatus]).toEqual([201, 'ACTIVE']);
  });

  // ---------------------------------------------------------------------------------------------
  test('#14 the older partner status route and the partner password reset are rate limited with the account actions (429 RATE_LIMITED)', async () => {
    process.env.RL_ADMIN_ACCOUNT_WRITE_MAX = '3';
    try {
      __resetRateLimits();
      const v = W.vendors[2];
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await request.post(`/api/admin/partners/vendor/${v.vendorId}/status`).set(admin()).send({ status: 'APPROVED' })).status);
      expect(codes).toEqual([409, 409, 409, 429, 429]); // already approved (409) until the limit
      __resetRateLimits();
      const rc: number[] = [];
      for (let i = 0; i < 5; i++) rc.push((await request.post(`/api/admin/partners/${v.id}/reset-password`).set(admin()).send({ password: 'Another-Pass-1' })).status);
      expect(rc).toEqual([200, 200, 200, 429, 429]);
    } finally {
      delete process.env.RL_ADMIN_ACCOUNT_WRITE_MAX;
      __resetRateLimits();
    }
  });
});
