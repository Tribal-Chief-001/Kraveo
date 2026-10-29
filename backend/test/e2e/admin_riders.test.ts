/**
 * Admin user management, B2 riders (Docs/27 B2, Docs/28): remove / restore a rider, the active-delivery guard (also on the old status route),
 * handover RELEASE through the existing reassign code, payouts to a removed rider, the claim-vs-remove race. Real PostgreSQL, HTTP and sockets.
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
import { World, Customer, Vendor, Rider, Ledger, Api, Watcher, createWorld, purgeWorld, resetWorldState, createLedger, createApi, cartOf, reissue } from '../harness/journey';
import { istDateString } from '../../src/utils/time';

jest.setTimeout(180_000);
const P = 'ar';
const PW = 'Sup3rSecret!';

describe('Admin riders: remove / restore / suspend guard', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let request: ReturnType<typeof supertest>;
  const watchers: Watcher[] = [];
  const admin = () => ({ Authorization: `Bearer ${W.admin.token}` });
  const remove = (id: string, body: object = {}) => request.post(`/api/admin/drivers/${id}/remove`).set(admin()).send(body);
  const restore = (id: string, body: object = {}) => request.post(`/api/admin/drivers/${id}/restore`).set(admin()).send(body);
  const rmBody = (r: Rider, extra: object = {}) => ({ reason: 'Left the company', confirmName: r.name, ...extra });
  const userOf = (r: Rider) => prisma.user.findUniqueOrThrow({ where: { id: r.id } });
  const profile = (r: Rider) => prisma.driverPartner.findUniqueOrThrow({ where: { id: r.profileId } });
  const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

  const paidOrder = async (c: Customer, v: Vendor) => {
    const placed = await api.place(c, v);
    expect(placed.status).toBe(201);
    const id = placed.body.data.id as string;
    const cp = await api.createPayment(c, id);
    const payId = `pay_${randomUUID().slice(0, 12)}`;
    ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
    expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
    return id;
  };
  const cook = async (id: string, v: Vendor, upTo: 'ACCEPTED' | 'READY_FOR_PICKUP' = 'READY_FOR_PICKUP') => {
    for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) {
      expect((await api.setStatus(v, id, st)).status).toBe(200);
      if (st === upTo) return;
    }
  };
  /** A paid order claimed by `r`, cooked up to READY_FOR_PICKUP (not picked up). */
  const claimed = async (c: Customer, v: Vendor, r: Rider) => {
    const id = await paidOrder(c, v);
    await cook(id, v);
    expect((await api.claim(r, id)).status).toBe(200);
    return id;
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    W = await createWorld(P, '6', { customers: 3, vendors: 2, riders: 3 });
    server = await startTestServer(0);
    request = supertest(server.app);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await __waitForBackgroundWork();
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await resetWorldState(W);
    await prisma.user.updateMany({ where: { id: { in: W.riders.map((r) => r.id) } }, data: { accountStatus: 'ACTIVE', statusReason: null, deletedAt: null, tokenVersion: 0 } });
    await prisma.driverPartner.updateMany({ where: { id: { in: W.riders.map((r) => r.profileId) } }, data: { approvalStatus: 'APPROVED', dutyStatus: 'ONLINE', rejectionReason: null } });
    await prisma.driverLocation.deleteMany({ where: { driverId: { startsWith: `${P}-` } } });
    await prisma.riderPayout.deleteMany({ where: { driverUserId: { startsWith: `${P}-` } } });
    await prisma.payoutAccount.deleteMany({ where: { userId: { startsWith: `${P}-` } } });
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    __resetRateLimits();
    __resetLoginLimiter();
    api.calls.length = 0;
  });
  afterEach(async () => {
    await __waitForBackgroundWork();
    while (watchers.length) watchers.pop()!.disconnect();
    setPaymentProvider(null);
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]);
  });
  afterAll(async () => {
    await stopTestServer(server);
    await prisma.riderPayout.deleteMany({ where: { driverUserId: { startsWith: `${P}-` } } });
    await prisma.payoutAccount.deleteMany({ where: { userId: { startsWith: `${P}-` } } });
    await purgeWorld(P);
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.$disconnect();
  });

  describe('remove / restore of an idle rider', () => {
    test('validation and targets: strict body, CONFIRM_MISMATCH, 404 for a customer / owner / unknown id', async () => {
      const [r] = W.riders;
      const cases: [object, string][] = [[{}, 'reason'], [{ reason: 'ab', confirmName: r.name }, 'reason'], [{ reason: 'fine reason', confirmName: r.name, handover: 'MAYBE' }, 'handover'], [{ reason: 'fine reason', confirmName: r.name, x: 1 }, 'x']];
      for (const [body, field] of cases) expect([(await remove(r.profileId, body)).status, (await remove(r.profileId, body)).body.field]).toEqual([400, field]);
      const mismatch = await remove(r.profileId, { reason: 'fine reason', confirmName: 'Someone Else' });
      expect([mismatch.status, mismatch.body.code]).toEqual([400, 'CONFIRM_MISMATCH']);
      for (const id of [W.customers[0].id, W.vendors[0].id, 'ar-nobody']) {
        expect((await remove(id, rmBody(r))).status).toBe(404);
        expect((await restore(id)).status).toBe(404);
        expect((await request.get(`/api/admin/drivers/${id}/impact`).set(admin())).status).toBe(404);
      }
      expect(await userOf(r)).toMatchObject({ accountStatus: 'ACTIVE', deletedAt: null });
    });

    test('remove: login and sessions dead, OFFLINE, map location deleted, payout records untouched, audited with actor; repeat is changed:false with one audit row', async () => {
      const r = W.riders[0];
      await prisma.driverLocation.create({ data: { driverId: r.id, driverName: r.name, lat: 23.07, lng: 76.85 } });
      await prisma.riderPayout.create({ data: { driverUserId: r.id, amount: 500, method: 'CASH', reference: 'ar-ref-1', createdBy: W.admin.id } });
      await prisma.payoutAccount.create({ data: { userId: r.id, partnerType: 'DRIVER', method: 'UPI', upiId: 'rider@upi' } });
      await prisma.user.update({ where: { id: r.id }, data: { passwordHash: await hashPassword(PW) } });
      const live = await new Watcher(server.baseUrl, r).connect();
      watchers.push(live);

      const res = await remove(r.profileId, rmBody(r));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, changed: true, data: { id: r.profileId, kind: 'DRIVER', status: 'SUSPENDED', accountStatus: 'REMOVED', userId: r.id } });
      const list = await request.get('/api/drivers').set(admin());
      expect(list.body.data.find((d: any) => d.id === r.profileId).user).toMatchObject({ accountStatus: 'REMOVED' });
      expect(await userOf(r)).toMatchObject({ accountStatus: 'REMOVED', statusReason: 'Left the company', statusChangedBy: W.admin.id });
      expect((await userOf(r)).deletedAt).not.toBeNull();
      expect(await profile(r)).toMatchObject({ approvalStatus: 'SUSPENDED', dutyStatus: 'OFFLINE' });
      expect(await prisma.driverLocation.count({ where: { driverId: r.id } })).toBe(0);
      expect(await prisma.riderPayout.count({ where: { driverUserId: r.id } })).toBe(1);
      expect(await prisma.payoutAccount.count({ where: { userId: r.id } })).toBe(1);
      const old = await request.get('/api/auth/profile').set({ Authorization: `Bearer ${r.token}` });
      expect([old.status, old.body.reason]).toEqual([401, 'ACCOUNT_REMOVED']);
      const login = await request.post('/api/auth/partner-login').send({ phone: r.phone, password: PW, role: 'DRIVER' });
      expect([login.status, login.body.code]).toEqual([403, 'ACCOUNT_REMOVED']);
      const wrong = await request.post('/api/auth/partner-login').send({ phone: r.phone, password: 'Wr0ngPassword', role: 'DRIVER' });
      expect(wrong.status).toBe(401);
      await new Promise((x) => setTimeout(x, 300));
      expect(live.connected).toBe(false);
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'DRIVER_REMOVED' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: 'DRIVER', targetId: r.profileId, actorId: W.admin.id });
      const again = await remove(r.profileId, rmBody(r));
      expect([again.status, again.body.changed]).toEqual([200, false]);
      expect(await prisma.adminAuditLog.count({ where: { action: 'DRIVER_REMOVED' } })).toBe(1);
      // the removed rider is not an assignable runner
      const id = await paidOrder(W.customers[0], W.vendors[0]);
      await cook(id, W.vendors[0]);
      const assign = await api.reassign(W.admin, id, r.id);
      expect([assign.status, assign.body.code]).toEqual([400, 'RIDER_NOT_APPROVED']);
    });

    test('restore: the login comes back (same password), the rider stays SUSPENDED until reactivated on purpose; repeat is changed:false; old tokens stay dead', async () => {
      const r = W.riders[1];
      await prisma.user.update({ where: { id: r.id }, data: { passwordHash: await hashPassword(PW) } });
      await remove(r.profileId, rmBody(r));
      const res = await restore(r.profileId, { note: 'Back from leave' });
      expect([res.status, res.body.changed, res.body.data.accountStatus, res.body.data.status]).toEqual([200, true, 'ACTIVE', 'SUSPENDED']);
      expect(await userOf(r)).toMatchObject({ accountStatus: 'ACTIVE', deletedAt: null, statusReason: null });
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${r.token}` })).status).toBe(401);
      const login = await request.post('/api/auth/partner-login').send({ phone: r.phone, password: PW, role: 'DRIVER' });
      expect([login.status, login.body.approvalStatus]).toEqual([200, 'SUSPENDED']);
      const re = await restore(r.profileId);
      expect([re.status, re.body.changed]).toEqual([200, false]);
      expect(await prisma.adminAuditLog.count({ where: { action: 'DRIVER_RESTORED' } })).toBe(1);
      const approve = await request.post(`/api/admin/partners/driver/${r.profileId}/status`).set(admin()).send({ status: 'APPROVED' });
      expect([approve.status, approve.body.data.status]).toEqual([200, 'APPROVED']);
    });

    test('a removed rider cannot be re-approved by the old status route (409 ACCOUNT_NOT_ACTIVE) and a self-deleted account is not restorable', async () => {
      const [r, s] = W.riders;
      await remove(r.profileId, rmBody(r));
      const approve = await request.post(`/api/admin/partners/driver/${r.profileId}/status`).set(admin()).send({ status: 'APPROVED' });
      expect([approve.status, approve.body.code]).toEqual([409, 'ACCOUNT_NOT_ACTIVE']);
      await prisma.user.update({ where: { id: s.id }, data: { deletedAt: new Date(), name: 'Deleted user' } });
      const rest = await restore(s.profileId);
      expect([rest.status, rest.body.code]).toEqual([409, 'NOT_RESTORABLE']);
      const rm = await remove(s.profileId, rmBody(s, { confirmName: 'Deleted user' }));
      expect([rm.status, rm.body.code]).toEqual([409, 'ALREADY_DELETED']);
    });
  });

  describe('deliveries in hand', () => {
    test('REFUSE (default): 409 HAS_ACTIVE_DELIVERY with the orders, rider and order unchanged; the same guard on the OLD status route', async () => {
      const r = W.riders[0];
      const id = await claimed(W.customers[0], W.vendors[0], r);
      const res = await remove(r.profileId, rmBody(r));
      expect([res.status, res.body.code]).toEqual([409, 'HAS_ACTIVE_DELIVERY']);
      expect(res.body.orders).toEqual([{ id, status: 'READY_FOR_PICKUP' }]);
      const old = await request.post(`/api/admin/partners/driver/${r.profileId}/status`).set(admin()).send({ status: 'SUSPENDED', reason: 'No-show' });
      expect([old.status, old.body.code]).toEqual([409, 'HAS_ACTIVE_DELIVERY']);
      expect(await userOf(r)).toMatchObject({ accountStatus: 'ACTIVE', tokenVersion: 0 });
      expect(await profile(r)).toMatchObject({ approvalStatus: 'APPROVED', dutyStatus: expect.stringMatching(/ONLINE|IN_TRANSIT/) });
      expect((await orderRow(id)).driverId).toBe(r.id);
      expect((await api.get(r, id)).status).toBe(200);
    });

    test('RELEASE: the order goes back to the pool through the normal reassign code (driverId null, audited, offered to other riders) and the rider is removed', async () => {
      const [r, other] = W.riders;
      const id = await claimed(W.customers[0], W.vendors[0], r);
      const w = await new Watcher(server.baseUrl, other).connect();
      watchers.push(w);
      const res = await remove(r.profileId, rmBody(r, { handover: 'RELEASE' }));
      expect([res.status, res.body.changed, res.body.released, res.body.releaseFailed]).toEqual([200, true, [id], []]);
      expect((await orderRow(id)).driverId).toBeNull();
      expect(await prisma.adminAuditLog.count({ where: { action: 'ORDER_REASSIGNED', targetId: id } })).toBe(1);
      await w.flush();
      expect(w.count('order_available', id)).toBe(1);
      const pool = await api.available(other);
      expect(pool.body.data.map((o: any) => o.id)).toContain(id);
      expect(await userOf(r)).toMatchObject({ accountStatus: 'REMOVED' });
      // the old status route releases the same way
      const [, r2] = W.riders;
      const id2 = await claimed(W.customers[1], W.vendors[1], r2);
      const sus = await request.post(`/api/admin/partners/driver/${r2.profileId}/status`).set(admin()).send({ status: 'SUSPENDED', reason: 'No-show', handover: 'RELEASE' });
      expect([sus.status, sus.body.released]).toEqual([200, [id2]]);
      expect((await orderRow(id2)).driverId).toBeNull();
      expect((await profile(r2)).approvalStatus).toBe('SUSPENDED');
    });

    test('RELEASE of a combined order releases the whole group once', async () => {
      const r = W.riders[0];
      const c = W.customers[0];
      const g = await api.placeGroup(c, [cartOf(W.vendors[0]), cartOf(W.vendors[1])]);
      const cp = await api.createPayment(c, g.body.data.payOrderId);
      ledger.capture(cp.body.razorpayOrderId, 'pay_ar_grp', cp.body.amountInPaise);
      await api.verify(c, cp.body.razorpayOrderId, 'pay_ar_grp');
      for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) for (let i = 0; i < 2; i++) expect((await api.setStatus(W.vendors[i], g.body.data.orders[i].id, st)).status).toBe(200);
      expect((await api.claim(r, g.body.data.orders[0].id)).status).toBe(200);
      const res = await remove(r.profileId, rmBody(r, { handover: 'RELEASE' }));
      expect([res.status, res.body.released?.length]).toEqual([200, 1]);
      const kids = await prisma.order.findMany({ where: { groupId: g.body.data.id } });
      expect(kids.map((k) => k.driverId)).toEqual([null, null]);
    });

    test('food already picked up: 409 FOOD_WITH_RIDER in BOTH modes, nothing changed (not even a partial release); reassigning the order first unblocks the removal', async () => {
      const [r, other] = W.riders;
      const id = await claimed(W.customers[0], W.vendors[0], r);
      expect((await api.setStatus(r, id, 'PICKED_UP')).status).toBe(200);
      const second = await claimed(W.customers[1], W.vendors[1], r).catch(() => null); // a rider carries one delivery at a time: this claim is refused
      expect(second).toBeNull();
      for (const handover of ['REFUSE', 'RELEASE']) {
        const res = await remove(r.profileId, rmBody(r, { handover }));
        expect([handover, res.status, res.body.code]).toEqual([handover, 409, 'FOOD_WITH_RIDER']);
        expect(res.body.orders).toEqual([{ id, status: 'PICKED_UP' }]);
      }
      const sus = await request.post(`/api/admin/partners/driver/${r.profileId}/status`).set(admin()).send({ status: 'SUSPENDED', reason: 'No-show', handover: 'RELEASE' });
      expect([sus.status, sus.body.code]).toEqual([409, 'FOOD_WITH_RIDER']);
      expect((await orderRow(id)).driverId).toBe(r.id);
      expect(await userOf(r)).toMatchObject({ accountStatus: 'ACTIVE' });
      expect((await api.reassign(W.admin, id, other.id, true)).status).toBe(200);
      expect((await remove(r.profileId, rmBody(r))).status).toBe(200);
    });

    test('race: a claim and a removal at the same moment never leave a removed rider holding a delivery (12 rounds)', async () => {
      const [r] = W.riders;
      const outcomes = { removed: 0, blocked: 0 };
      for (let i = 0; i < 12; i++) {
        await prisma.user.update({ where: { id: r.id }, data: { accountStatus: 'ACTIVE', deletedAt: null, tokenVersion: 0 } });
        await prisma.driverPartner.update({ where: { id: r.profileId }, data: { approvalStatus: 'APPROVED', dutyStatus: 'ONLINE' } });
        const id = await paidOrder(W.customers[0], W.vendors[0]);
        await cook(id, W.vendors[0]);
        const [c, d] = await Promise.all([api.claim(r, id), remove(r.profileId, rmBody(r))]);
        const row = await orderRow(id);
        const u = await userOf(r);
        if (u.accountStatus === 'REMOVED') {
          outcomes.removed += 1;
          expect(d.status).toBe(200);
          expect(row.driverId).toBeNull(); // the claim was refused (or came first and then blocked the removal)
          expect(c.status).not.toBe(200);
        } else {
          outcomes.blocked += 1;
          expect([c.status, d.status, d.body.code]).toEqual([200, 409, 'HAS_ACTIVE_DELIVERY']);
          expect(row.driverId).toBe(r.id);
        }
        await prisma.order.update({ where: { id }, data: { driverId: null } });
        await api.adminCancel(W.admin as any, id);
        await __waitForBackgroundWork();
      }
      expect(outcomes.removed + outcomes.blocked).toBe(12);
    });
  });

  describe('money and records of a removed rider', () => {
    test('a removed rider can still be paid and looked up by an admin, and still shows in the rider report; a self-deleted one cannot', async () => {
      const [r, s] = W.riders;
      const id = await claimed(W.customers[0], W.vendors[0], r);
      await prisma.order.update({ where: { id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
      await prisma.payoutAccount.create({ data: { userId: r.id, partnerType: 'DRIVER', method: 'UPI', upiId: 'rider@upi' } });
      expect((await remove(r.profileId, rmBody(r))).status).toBe(200);
      const payout = await request.post('/api/admin/rider-payouts').set(admin()).send({ driverUserId: r.id, amount: 120.5, method: 'CASH', reference: 'ar-final-1' });
      expect([payout.status, payout.body.data?.driverUserId ?? payout.body.driverUserId]).toEqual([201, r.id]);
      const acct = await request.get(`/api/admin/partners/${r.id}/payout-account`).set(admin());
      expect([acct.status, acct.body.data?.upiId]).toEqual([200, 'rider@upi']);
      const today = istDateString(new Date());
      const report = await request.get(`/api/admin/finance/riders?from=${today}&to=${today}`).set(admin());
      const line = report.body.data.find((x: any) => x.driverUserId === r.id);
      expect(line).toMatchObject({ deliveries: 1, payouts: { count: 1, total: 120.5 } });
      expect(report.body.data.find((x: any) => x.driverUserId === r.id).name).toBe(r.name);
      // a self-deleted rider stays unreachable
      await prisma.user.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
      const no = await request.post('/api/admin/rider-payouts').set(admin()).send({ driverUserId: s.id, amount: 10, method: 'CASH' });
      expect(no.status).toBe(404);
      expect((await request.get(`/api/admin/partners/${s.id}/payout-account`).set(admin())).status).toBe(404);
    });

    test('the impact preview lists deliveries in hand and food with the rider', async () => {
      const r = W.riders[0];
      const id = await claimed(W.customers[0], W.vendors[0], r);
      const a = await request.get(`/api/admin/drivers/${r.profileId}/impact`).set(admin());
      expect(a.body.data).toMatchObject({ driverId: r.profileId, userId: r.id, activeDeliveries: [{ id, status: 'READY_FOR_PICKUP' }], foodWithRider: [] });
      await api.setStatus(r, id, 'PICKED_UP');
      const b = await request.get(`/api/admin/drivers/${r.profileId}/impact`).set(admin());
      expect(b.body.data.foodWithRider).toEqual([{ id, status: 'PICKED_UP' }]);
    });
  });
});
