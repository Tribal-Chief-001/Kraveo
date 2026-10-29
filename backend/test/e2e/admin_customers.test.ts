/**
 * Admin user management, B1 customers (Docs/27 B1, Docs/28): suspend / restore / remove with open orders, refunds, sessions, validation,
 * idempotency, the audit trail with actor, and the list / detail extensions. Real PostgreSQL and HTTP, the payment provider is a ledger.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { setGoogleVerifier } from '../../src/services/googleAuth';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { registerDeviceToken } from '../../src/services/push/deviceTokens';
import { World, Customer, Vendor, Rider, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi, cartOf, reissue } from '../harness/journey';

jest.setTimeout(180_000);
const P = 'ac';

describe('Admin customers: suspend / restore / remove', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let request: ReturnType<typeof supertest>;
  const admin = () => ({ Authorization: `Bearer ${W.admin.token}` });
  const act = (id: string, verb: 'suspend' | 'restore' | 'remove', body: object = {}) => request.post(`/api/admin/customers/${id}/${verb}`).set(admin()).send(body);
  const user = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
  const audits = (action: string, targetId: string) => prisma.adminAuditLog.findMany({ where: { action, targetId } });

  /** A paid order of `c` at `v` (the customer paid at the fake Razorpay and the server verified it). */
  const paidOrder = async (c: Customer, v: Vendor) => {
    const placed = await api.place(c, v);
    expect(placed.status).toBe(201);
    const id = placed.body.data.id as string;
    const cp = await api.createPayment(c, id);
    const payId = `pay_${randomUUID().slice(0, 12)}`;
    ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
    expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
    return { id, payId };
  };
  const toPickedUp = async (orderId: string, v: Vendor, r: Rider) => {
    for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) expect((await api.setStatus(v, orderId, st)).status).toBe(200);
    expect((await api.claim(r, orderId)).status).toBe(200);
    expect((await api.setStatus(r, orderId, 'PICKED_UP')).status).toBe(200);
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    W = await createWorld(P, '6', { customers: 6, vendors: 2, riders: 2 });
    server = await startTestServer(0);
    request = supertest(server.app);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await __waitForBackgroundWork();
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await resetWorldState(W);
    await prisma.user.updateMany({ where: { id: { in: W.customers.map((c) => c.id) } }, data: { accountStatus: 'ACTIVE', statusReason: null, deletedAt: null, name: 'Cust Tester', phone: undefined } });
    for (const c of W.customers) await prisma.user.update({ where: { id: c.id }, data: { phone: c.phone, kraveoCoins: 25, email: null, googleSub: null, hostelBlock: 'BH2' } });
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    __resetRateLimits();
    api.calls.length = 0;
  });
  afterEach(async () => {
    await __waitForBackgroundWork();
    setPaymentProvider(null);
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]);
  });
  afterAll(async () => {
    setGoogleVerifier(null);
    await stopTestServer(server);
    await purgeWorld(P);
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.$disconnect();
  });

  describe('input and target checks', () => {
    test('strict bodies: bad reason, unknown key, wrong types, array body, bad id -> 400 with the field; the customer is untouched', async () => {
      const id = W.customers[0].id;
      const cases: [string, object | unknown[], string][] = [
        ['suspend', {}, 'reason'],
        ['suspend', { reason: 'ab' }, 'reason'],
        ['suspend', { reason: 'x'.repeat(201) }, 'reason'],
        ['suspend', { reason: 'bad ‮ reason' }, 'reason'],
        ['suspend', { reason: 123 }, 'reason'],
        ['suspend', { reason: 'fine reason', extra: 1 }, 'extra'],
        ['suspend', { reason: 'fine reason', openOrders: 'MAYBE' }, 'openOrders'],
        ['suspend', ['reason'], 'body'],
        ['remove', { reason: 'fine reason', confirmName: 'x', scrub: 'yes' }, 'scrub'],
        ['remove', { reason: 'fine reason', confirmName: 'x', openOrders: 'ALL' }, 'openOrders'],
        ['restore', { note: 5 }, 'note'],
        ['restore', { note: 'x'.repeat(201) }, 'note'],
        ['restore', { whatever: true }, 'whatever'],
      ];
      for (const [verb, body, field] of cases) {
        const res = await act(id, verb as any, body as object);
        expect([verb, res.status, res.body.field]).toEqual([verb, 400, field]);
      }
      expect((await request.post('/api/admin/customers/%00bad/suspend').set(admin()).send({ reason: 'abc def' })).status).toBe(400);
      expect(await user(id)).toMatchObject({ accountStatus: 'ACTIVE', deletedAt: null });
    });

    test('remove needs the typed name (case and spacing ignored): wrong -> 400 CONFIRM_MISMATCH; nothing changes', async () => {
      const c = W.customers[0];
      await prisma.user.update({ where: { id: c.id }, data: { name: 'Asha  Verma' } });
      const wrong = await act(c.id, 'remove', { reason: 'abuse of coupons', confirmName: 'Asha' });
      expect([wrong.status, wrong.body.code, wrong.body.field]).toEqual([400, 'CONFIRM_MISMATCH', 'confirmName']);
      expect((await act(c.id, 'remove', { reason: 'abuse of coupons' })).body.code).toBe('CONFIRM_MISMATCH');
      expect((await user(c.id)).accountStatus).toBe('ACTIVE');
      const ok = await act(c.id, 'remove', { reason: 'abuse of coupons', confirmName: '  asha verma ' });
      expect([ok.status, ok.body.changed]).toEqual([200, true]);
    });

    test('only customers: a restaurant owner, a rider, an admin and an unknown id are 404 on every verb (never "exists but not yours")', async () => {
      for (const id of [W.vendors[0].id, W.riders[0].id, W.admin.id, 'ac-nobody']) {
        for (const verb of ['suspend', 'restore', 'remove'] as const) {
          const res = await act(id, verb, verb === 'remove' ? { reason: 'abc def', confirmName: 'x' } : verb === 'suspend' ? { reason: 'abc def' } : {});
          expect([id, verb, res.status]).toEqual([id, verb, 404]);
        }
      }
      expect((await user(W.vendors[0].id)).accountStatus).toBe('ACTIVE');
    });
  });

  describe('suspend / restore', () => {
    test('suspend: state written, every session / push token / socket ended, audited with the acting admin, never leaks secrets; the exact JSON is stable', async () => {
      const c = W.customers[0];
      await prisma.user.update({ where: { id: c.id }, data: { email: 'asha@kraveo.test', googleSub: 'sub-ac-0', fcmToken: 'legacy' } });
      await registerDeviceToken({ userId: c.id, token: 'ac-dev-1', app: 'CUSTOMER', platform: 'android', appVersion: '1' });
      const res = await act(c.id, 'suspend', { reason: 'Abuse of coupons' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, changed: true, data: { id: c.id, accountStatus: 'SUSPENDED', statusReason: 'Abuse of coupons', openOrders: [], refundsOwed: [] } });
      expect(res.body.cancelled).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|googleSub|tokenVersion|sub-ac-0|scrypt/);
      const row = await user(c.id);
      expect(row).toMatchObject({ accountStatus: 'SUSPENDED', statusReason: 'Abuse of coupons', statusChangedBy: W.admin.id, fcmToken: null, deletedAt: null });
      expect(row.statusChangedAt).not.toBeNull();
      expect(row.tokenVersion).toBe(1);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: 'ac-dev-1' } })).disabledReason).toBe('ACCOUNT_SUSPENDED');
      // the old token and the checkout
      const old = await request.get('/api/auth/profile').set({ Authorization: `Bearer ${c.token}` });
      expect([old.status, old.body.code, old.body.reason]).toEqual([401, 'TOKEN_REVOKED', 'ACCOUNT_SUSPENDED']);
      setGoogleVerifier(async () => ({ sub: 'sub-ac-0', email: 'asha@kraveo.test', emailVerified: true, name: 'Asha' }));
      const g = await request.post('/api/auth/google').send({ idToken: 'x'.repeat(30) });
      expect([g.status, g.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      // audit: one row, with actor, no phone / e-mail
      const rows = await audits('CUSTOMER_SUSPENDED', c.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: 'USER', actorId: W.admin.id, actorName: W.admin.name });
      expect(rows[0].summary).toContain('Abuse of coupons');
      expect(rows[0].summary).toContain(c.id.slice(0, 8));
      expect(rows[0].summary + JSON.stringify(rows[0].meta)).not.toMatch(/asha@|\+91|9777/);
      expect(rows[0].meta).toMatchObject({ before: { accountStatus: 'ACTIVE' }, after: { accountStatus: 'SUSPENDED' } });
    });

    test('repeating suspend is a 200 changed:false and writes no second audit row; a live socket is closed', async () => {
      const c = W.customers[1];
      const first = await act(c.id, 'suspend', { reason: 'Fake orders' });
      const second = await act(c.id, 'suspend', { reason: 'Fake orders again' });
      expect([first.body.changed, second.status, second.body.changed]).toEqual([true, 200, false]);
      expect((await user(c.id)).statusReason).toBe('Fake orders'); // the first reason stays
      expect(await audits('CUSTOMER_SUSPENDED', c.id)).toHaveLength(1);
    });

    test('restore: the account is ACTIVE again, the OLD token stays dead, a new Google sign-in works, push tokens are not switched back on; repeat is changed:false', async () => {
      const c = W.customers[2];
      await prisma.user.update({ where: { id: c.id }, data: { email: 'rest@kraveo.test', googleSub: 'sub-ac-2' } });
      await registerDeviceToken({ userId: c.id, token: 'ac-dev-2', app: 'CUSTOMER', platform: 'android', appVersion: '1' });
      await act(c.id, 'suspend', { reason: 'Harassing riders' });
      const res = await act(c.id, 'restore', { note: 'Spoke to them' });
      expect([res.status, res.body.changed, res.body.data.accountStatus, res.body.data.statusReason]).toEqual([200, true, 'ACTIVE', null]);
      expect(await user(c.id)).toMatchObject({ accountStatus: 'ACTIVE', statusReason: null, deletedAt: null });
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${c.token}` })).status).toBe(401); // old session stays dead
      setGoogleVerifier(async () => ({ sub: 'sub-ac-2', email: 'rest@kraveo.test', emailVerified: true, name: 'Asha' }));
      const g = await request.post('/api/auth/google').send({ idToken: 'x'.repeat(30) });
      expect([g.status, g.body.isNewUser]).toEqual([200, false]);
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${g.body.token}` })).status).toBe(200);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: 'ac-dev-2' } })).disabledAt).not.toBeNull();
      const again = await act(c.id, 'restore', {});
      expect([again.status, again.body.changed]).toEqual([200, false]);
      const rows = await audits('CUSTOMER_RESTORED', c.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toContain('Spoke to them');
    });

    test('a restored customer can order again (and the order is a normal one)', async () => {
      const c = W.customers[3];
      await act(c.id, 'suspend', { reason: 'Fake orders' });
      expect((await api.place(c, W.vendors[0])).status).toBe(401); // old token
      await act(c.id, 'restore');
      const fresh = await reissue(c);
      const placed = await api.place(fresh, W.vendors[0]);
      expect(placed.status).toBe(201);
    });

    test('a customer who deleted their own account cannot be suspended (409 ALREADY_DELETED) or restored (409 NOT_RESTORABLE)', async () => {
      const c = W.customers[4];
      await prisma.user.update({ where: { id: c.id }, data: { name: 'Deleted user', phone: null, email: null, googleSub: null, deletedAt: new Date() } });
      const s = await act(c.id, 'suspend', { reason: 'abc def' });
      expect([s.status, s.body.code]).toEqual([409, 'ALREADY_DELETED']);
      expect((await act(c.id, 'remove', { reason: 'abc def', confirmName: 'Deleted user' })).body.code).toBe('ALREADY_DELETED');
      const r = await act(c.id, 'restore');
      expect([r.status, r.body.code]).toEqual([409, 'NOT_RESTORABLE']);
      expect((await user(c.id)).accountStatus).toBe('ACTIVE');
    });
  });

  describe('remove', () => {
    test('remove (no scrub): deletedAt set, e-mail and Google id KEPT as the block key, sessions dead, Google answers 403 ACCOUNT_REMOVED and creates no second row, suspend after remove is 409', async () => {
      const c = W.customers[0];
      await prisma.user.update({ where: { id: c.id }, data: { name: 'Remove Me', email: 'rm@kraveo.test', googleSub: 'sub-ac-rm' } });
      const res = await act(c.id, 'remove', { reason: 'Fraud', confirmName: 'Remove Me' });
      expect([res.status, res.body.changed, res.body.data.accountStatus]).toEqual([200, true, 'REMOVED']);
      const row = await user(c.id);
      expect(row).toMatchObject({ accountStatus: 'REMOVED', statusReason: 'Fraud', email: 'rm@kraveo.test', googleSub: 'sub-ac-rm', name: 'Remove Me', phone: c.phone });
      expect(row.deletedAt).not.toBeNull();
      setGoogleVerifier(async () => ({ sub: 'sub-ac-rm', email: 'rm@kraveo.test', emailVerified: true, name: 'Remove Me' }));
      const g = await request.post('/api/auth/google').send({ idToken: 'x'.repeat(30) });
      expect([g.status, g.body.code]).toEqual([403, 'ACCOUNT_REMOVED']);
      expect(await prisma.user.count({ where: { OR: [{ googleSub: 'sub-ac-rm' }, { email: 'rm@kraveo.test' }] } })).toBe(1);
      const sus = await act(c.id, 'suspend', { reason: 'abc def' });
      expect([sus.status, sus.body.code]).toEqual([409, 'INVALID_STATE']);
      const again = await act(c.id, 'remove', { reason: 'Fraud', confirmName: 'whatever' });
      expect([again.status, again.body.changed]).toEqual([200, false]);
      expect(await audits('CUSTOMER_REMOVED', c.id)).toHaveLength(1);
      // restore brings exactly the state back: the account, not the sessions
      const back = await act(c.id, 'restore');
      expect([back.body.changed, back.body.data.accountStatus]).toEqual([true, 'ACTIVE']);
      expect(await user(c.id)).toMatchObject({ accountStatus: 'ACTIVE', deletedAt: null, email: 'rm@kraveo.test', statusReason: null });
    });

    test('remove with scrub: name / phone / hostel / coins erased, the phone is free for someone else, e-mail + Google id stay, restore gives an empty profile (needsProfile)', async () => {
      const c = W.customers[1];
      await prisma.user.update({ where: { id: c.id }, data: { name: 'Scrub Me', email: 'sc@kraveo.test', googleSub: 'sub-ac-sc', avatarId: 3, isStudent: true, upiId: 'me@upi' } });
      const res = await act(c.id, 'remove', { reason: 'Right to erasure', confirmName: 'scrub me', scrub: true });
      expect(res.status).toBe(200);
      expect(await user(c.id)).toMatchObject({ name: 'Removed user', phone: null, avatarId: null, isStudent: null, hostelBlock: null, upiId: null, kraveoCoins: 0, email: 'sc@kraveo.test', googleSub: 'sub-ac-sc', accountStatus: 'REMOVED' });
      const taker = await prisma.user.create({ data: { id: `${P}-taker`, name: 'Taker One', phone: c.phone, role: 'STUDENT' } });
      expect(taker.phone).toBe(c.phone);
      await prisma.user.delete({ where: { id: taker.id } });
      const audit = (await audits('CUSTOMER_REMOVED', c.id))[0];
      expect(audit.summary).toContain('profile erased');
      expect(audit.summary).not.toContain('Scrub Me'.toLowerCase());
      await act(c.id, 'restore');
      setGoogleVerifier(async () => ({ sub: 'sub-ac-sc', email: 'sc@kraveo.test', emailVerified: true, name: 'Scrub Me' }));
      const g = await request.post('/api/auth/google').send({ idToken: 'x'.repeat(30) });
      expect([g.status, g.body.needsProfile]).toEqual([200, true]);
    });

    test('scrub is refused (409 REFUND_NOT_SETTLED) while a refund of this customer is PENDING or FAILED; without scrub the removal goes through', async () => {
      const c = W.customers[2];
      const o = await paidOrder(c, W.vendors[0]);
      await api.adminCancel(W.admin as any, o.id);
      await __waitForBackgroundWork();
      await prisma.order.update({ where: { id: o.id }, data: { refundStatus: 'FAILED' } });
      const refused = await act(c.id, 'remove', { reason: 'abc def', confirmName: 'Cust Tester', scrub: true });
      expect([refused.status, refused.body.code]).toEqual([409, 'REFUND_NOT_SETTLED']);
      expect(refused.body.orders).toEqual([o.id]);
      expect((await user(c.id)).accountStatus).toBe('ACTIVE');
      const plain = await act(c.id, 'remove', { reason: 'abc def', confirmName: 'Cust Tester' });
      expect(plain.status).toBe(200);
      expect(plain.body.data.refundsOwed).toEqual([expect.objectContaining({ orderId: o.id, refundStatus: 'FAILED' })]);
    });

    test('a removal escalates from SUSPENDED (allowed) and the second admin racing the first gets changed:false, one audit row', async () => {
      const c = W.customers[3];
      await act(c.id, 'suspend', { reason: 'Fake orders' });
      const [a, b] = await Promise.all([act(c.id, 'remove', { reason: 'Fraud', confirmName: 'Cust Tester' }), act(c.id, 'remove', { reason: 'Fraud', confirmName: 'Cust Tester' })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.changed, b.body.changed].sort()).toEqual([false, true]);
      expect(await audits('CUSTOMER_REMOVED', c.id)).toHaveLength(1);
      expect((await user(c.id)).accountStatus).toBe('REMOVED');
    });
  });

  describe('open orders', () => {
    test('REFUSE (default): 409 HAS_OPEN_ORDERS with the exact orders; nothing changed, no token revoked', async () => {
      const c = W.customers[0];
      const o = await paidOrder(c, W.vendors[0]);
      for (const [verb, body] of [['suspend', { reason: 'abc def' }], ['remove', { reason: 'abc def', confirmName: 'Cust Tester' }]] as const) {
        const res = await act(c.id, verb, body);
        expect([verb, res.status, res.body.code]).toEqual([verb, 409, 'HAS_OPEN_ORDERS']);
        expect(res.body.openOrders).toEqual([expect.objectContaining({ id: o.id, status: 'PLACED', paymentStatus: 'PAID' })]);
      }
      expect(await user(c.id)).toMatchObject({ accountStatus: 'ACTIVE', tokenVersion: 0 });
      expect((await api.get(c, o.id)).status).toBe(200);
      expect(await audits('CUSTOMER_SUSPENDED', c.id)).toHaveLength(0);
    });

    test('CANCEL: a PAID order is cancelled through the normal cancel path, refunded exactly once, reported; an unpaid one is cancelled without a refund; the customer is blocked', async () => {
      const c = W.customers[0];
      const paid = await paidOrder(c, W.vendors[0]);
      const unpaid = await api.place(c, W.vendors[1]);
      expect(unpaid.status).toBe(201);
      const res = await act(c.id, 'suspend', { reason: 'Fake orders', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      expect([res.status, res.body.changed]).toEqual([200, true]);
      expect(res.body.failed).toEqual([]);
      expect(res.body.cancelled).toHaveLength(2);
      expect(res.body.cancelled).toEqual(expect.arrayContaining([
        expect.objectContaining({ orderId: paid.id, cancelledOrders: 1, refund: 'STARTED' }),
        expect.objectContaining({ orderId: unpaid.body.data.id, cancelledOrders: 1, refund: 'NONE' }),
      ]));
      const o1 = await prisma.order.findUniqueOrThrow({ where: { id: paid.id } });
      expect(o1).toMatchObject({ status: 'CANCELLED', cancelledBy: 'ADMIN', cancelReason: 'Account suspended by Kraveo', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      const o2 = await prisma.order.findUniqueOrThrow({ where: { id: unpaid.body.data.id } });
      expect([o2.status, o2.refundStatus]).toEqual(['CANCELLED', null]);
      expect(ledger.refundsOf(paid.payId)).toHaveLength(1);
      expect(ledger.totalRefunded()).toBe(ledger.totalCaptured());
      expect(res.body.data.openOrders).toEqual([]);
      expect((await audits('CUSTOMER_SUSPENDED', c.id))[0].summary).toContain('2 open order(s) cancelled');
      // repeating the call is idempotent: nothing more to cancel, no second refund
      const again = await act(c.id, 'suspend', { reason: 'Fake orders', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      expect([again.body.changed, again.body.cancelled]).toEqual([false, []]);
      expect(ledger.refundsOf(paid.payId)).toHaveLength(1);
    });

    test('CANCEL on a combined order cancels the WHOLE group (also the other restaurant), one refund of the group total; the response counts both orders', async () => {
      const c = W.customers[1];
      const g = await api.placeGroup(c, [cartOf(W.vendors[0]), cartOf(W.vendors[1])]);
      expect(g.status).toBe(201);
      const cp = await api.createPayment(c, g.body.data.payOrderId);
      ledger.capture(cp.body.razorpayOrderId, 'pay_ac_grp', cp.body.amountInPaise);
      expect((await api.verify(c, cp.body.razorpayOrderId, 'pay_ac_grp')).status).toBe(200);
      const res = await act(c.id, 'remove', { reason: 'Fraud', confirmName: 'Cust Tester', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      expect(res.status).toBe(200);
      expect(res.body.cancelled).toEqual([expect.objectContaining({ groupId: g.body.data.id, cancelledOrders: 2, refund: 'STARTED' })]);
      const kids = await prisma.order.findMany({ where: { groupId: g.body.data.id }, orderBy: { groupIndex: 'asc' } });
      expect(kids.map((k) => k.status)).toEqual(['CANCELLED', 'CANCELLED']);
      expect(ledger.refundsOf('pay_ac_grp')).toEqual([expect.objectContaining({ amountPaise: cp.body.amountInPaise })]);
    });

    test('food already with the rider: 409 ORDER_IN_DELIVERY in BOTH modes, nothing changed; a delivered order is not "open"', async () => {
      const c = W.customers[2];
      const o = await paidOrder(c, W.vendors[0]);
      await toPickedUp(o.id, W.vendors[0], W.riders[0]);
      for (const openOrders of ['REFUSE', 'CANCEL']) {
        const res = await act(c.id, 'suspend', { reason: 'abc def', openOrders });
        expect([openOrders, res.status, res.body.code]).toEqual([openOrders, 409, 'ORDER_IN_DELIVERY']);
        expect(res.body.orders).toEqual([expect.objectContaining({ id: o.id, status: 'PICKED_UP' })]);
      }
      expect(await user(c.id)).toMatchObject({ accountStatus: 'ACTIVE', tokenVersion: 0 });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PICKED_UP');
      await prisma.order.update({ where: { id: o.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
      expect((await act(c.id, 'suspend', { reason: 'abc def' })).status).toBe(200);
    });

    test('a payment that completes AFTER the block (the customer was mid-Razorpay) is refunded by the existing late-payment path, once', async () => {
      const c = W.customers[3];
      const placed = await api.place(c, W.vendors[0]);
      const cp = await api.createPayment(c, placed.body.data.id);
      const res = await act(c.id, 'suspend', { reason: 'Fake orders', openOrders: 'CANCEL' });
      expect(res.body.cancelled).toHaveLength(1);
      ledger.capture(cp.body.razorpayOrderId, 'pay_ac_late', cp.body.amountInPaise);
      const hook = await api.webhookCaptured(cp.body.razorpayOrderId, 'pay_ac_late', cp.body.amountInPaise);
      expect(hook.status).toBe(200);
      await __waitForBackgroundWork();
      expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.id } })).status).toBe('CANCELLED');
      expect(ledger.refundsOf('pay_ac_late')).toHaveLength(1);
      expect(ledger.totalRefunded()).toBe(ledger.totalCaptured());
    });
  });

  describe('list and detail', () => {
    test('status filter, openOrders count, default hides removed and self-deleted, includeDeleted shows self-deleted, bad status -> 400', async () => {
      const [a, b, c, d] = W.customers;
      await prisma.user.updateMany({ where: { id: { in: [a.id, b.id, c.id] } }, data: { name: 'AC Listed' } });
      await act(b.id, 'suspend', { reason: 'Fake orders' });
      await act(c.id, 'remove', { reason: 'Fraud', confirmName: 'AC Listed' });
      await prisma.user.update({ where: { id: d.id }, data: { name: 'Deleted user', phone: null, email: null, googleSub: null, deletedAt: new Date() } });
      await paidOrder(a, W.vendors[0]);
      const list = async (q: string) => (await request.get(`/api/admin/customers?limit=100&search=${encodeURIComponent('AC Listed')}${q}`).set(admin())).body.data.map((x: any) => x.id).filter((id: string) => id.startsWith(`${P}-`));
      expect((await list('')).sort()).toEqual([a.id, b.id].sort());
      expect(await list('&status=ACTIVE')).toEqual([a.id]);
      expect(await list('&status=SUSPENDED')).toEqual([b.id]);
      expect(await list('&status=REMOVED')).toEqual([c.id]);
      expect((await list('&status=ALL')).sort()).toEqual([a.id, b.id, c.id].sort());
      const all = (await request.get('/api/admin/customers?limit=100&includeDeleted=1&status=ALL').set(admin())).body.data.map((x: any) => x.id);
      expect(all).toEqual(expect.arrayContaining([a.id, b.id, c.id, d.id]));
      const row = (await request.get('/api/admin/customers?limit=100&status=ACTIVE').set(admin())).body.data.find((x: any) => x.id === a.id);
      expect(row).toMatchObject({ accountStatus: 'ACTIVE', openOrders: 1, statusReason: null });
      const bad = await request.get('/api/admin/customers?status=BANNED').set(admin());
      expect([bad.status, bad.body.field]).toEqual([400, 'status']);
      const deletedRow = (await request.get('/api/admin/customers?limit=100&includeDeleted=1&status=REMOVED').set(admin())).body.data.find((x: any) => x.id === d.id);
      expect(deletedRow.deleted).toBe(true);
    });

    test('detail carries account state, statusChangedBy, open orders and refunds owed; unknown / non-customer ids are 404', async () => {
      const c = W.customers[4];
      const o = await paidOrder(c, W.vendors[0]);
      const before = await request.get(`/api/admin/customers/${c.id}`).set(admin());
      expect(before.body.data).toMatchObject({ accountStatus: 'ACTIVE', statusChangedBy: null, openOrders: [expect.objectContaining({ id: o.id })], refundsOwed: [] });
      await act(c.id, 'suspend', { reason: 'Fake orders', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      await prisma.order.update({ where: { id: o.id }, data: { refundStatus: 'PENDING' } });
      const after = await request.get(`/api/admin/customers/${c.id}`).set(admin());
      expect(after.body.data).toMatchObject({ accountStatus: 'SUSPENDED', statusReason: 'Fake orders', statusChangedBy: W.admin.id, openOrders: [] });
      expect(after.body.data.refundsOwed).toEqual([{ orderId: o.id, refundStatus: 'PENDING', amount: expect.any(Number) }]);
      expect((await request.get(`/api/admin/customers/${W.vendors[0].id}`).set(admin())).status).toBe(404);
      expect(JSON.stringify(after.body)).not.toMatch(/passwordHash|tokenVersion|googleSub/);
    });
  });
});
