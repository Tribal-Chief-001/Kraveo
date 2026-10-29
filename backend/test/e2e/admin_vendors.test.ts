/**
 * Admin user management, B3 restaurants (Docs/27 B3, Docs/28): suspend / reinstate / remove / restore, ownerless restaurants, open orders and
 * refunds through the normal cancel path, combined orders, settlements and dishes kept, the owner login rules of a removal, and the
 * removal-vs-checkout race. Real PostgreSQL and HTTP, the payment provider is a ledger.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { createSettlements } from '../../src/services/settlement';
import { World, Customer, Vendor, Ledger, Api, Watcher, createWorld, purgeWorld, resetWorldState, createLedger, createApi, cartOf } from '../harness/journey';

jest.setTimeout(180_000);
const P = 'av';

const sleepThen = async <T,>(ms: number, fn: () => Promise<T>): Promise<T> => { await new Promise((r) => setTimeout(r, ms)); return fn(); };

describe('Admin restaurants: suspend / reinstate / remove / restore', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let request: ReturnType<typeof supertest>;
  const watchers: Watcher[] = [];
  const admin = () => ({ Authorization: `Bearer ${W.admin.token}` });
  const post = (id: string, verb: string, body: object = {}) => request.post(`/api/admin/vendors/${id}/${verb}`).set(admin()).send(body);
  const vrow = (id: string) => prisma.vendor.findUniqueOrThrow({ where: { id } });
  const urow = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
  const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const rmBody = (v: Vendor, extra: object = {}) => ({ reason: 'Hygiene failure', confirmName: `Kitchen ${v.vendorId.slice(-1)}`, ...extra });

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
    await cleanSettlements();
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await resetWorldState(W);
    await prisma.vendor.updateMany({ where: { id: { startsWith: `${P}-` } }, data: { removedAt: null, removedReason: null, ownerDisabledByRemoval: false, rejectionReason: null } });
    await prisma.user.updateMany({ where: { id: { startsWith: `${P}-` } }, data: { accountStatus: 'ACTIVE', statusReason: null, deletedAt: null } });
    for (const v of W.vendors) await prisma.vendor.update({ where: { id: v.vendorId }, data: { userId: v.id, name: `Kitchen ${v.vendorId.slice(-1)}` } });
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    __resetRateLimits();
    api.calls.length = 0;
  });
  const cleanSettlements = async () => {
    await prisma.settlementAdjustment.deleteMany({ where: { settlement: { vendorId: { startsWith: `${P}-` } } } });
    await prisma.settlement.deleteMany({ where: { vendorId: { startsWith: `${P}-` } } });
  };
  afterEach(async () => {
    await __waitForBackgroundWork();
    while (watchers.length) watchers.pop()!.disconnect();
    setPaymentProvider(null);
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]);
  });
  afterAll(async () => {
    await stopTestServer(server);
    await cleanSettlements();
    await purgeWorld(P);
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.$disconnect();
  });

  describe('input and targets', () => {
    test('strict bodies, CONFIRM_MISMATCH against the RESTAURANT name, 404 for unknown ids', async () => {
      const v = W.vendors[0];
      const bad: [string, object, string][] = [
        ['suspend', {}, 'reason'], ['suspend', { reason: 'fine reason', extra: 1 }, 'extra'], ['suspend', { reason: 'fine reason', openOrders: 'X' }, 'openOrders'],
        ['remove', { reason: 'fine reason', confirmName: 'x', disableOwner: 'yes' }, 'disableOwner'], ['remove', { reason: 'fine reason', confirmName: 'x', openOrders: 1 }, 'openOrders'],
        ['reinstate', { reason: 'x' }, 'reason'], ['restore', { a: 1 }, 'a'],
      ];
      for (const [verb, body, field] of bad) {
        const res = await post(v.vendorId, verb, body);
        expect([verb, res.status, res.body.field]).toEqual([verb, 400, field]);
      }
      const wrong = await post(v.vendorId, 'remove', { reason: 'fine reason', confirmName: 'Sharma Dhaba' });
      expect([wrong.status, wrong.body.code]).toEqual([400, 'CONFIRM_MISMATCH']);
      expect((await post('av-none', 'restore')).status).toBe(404);
      expect((await request.get('/api/admin/vendors/av-none/impact').set(admin())).status).toBe(404);
      expect(await vrow(v.vendorId)).toMatchObject({ approvalStatus: 'APPROVED', removedAt: null });
    });
  });

  describe('suspend', () => {
    test('an ownerless restaurant can be suspended (the old Applications route could not), idempotently, with the audit row and actor', async () => {
      await prisma.vendor.create({ data: { id: `${P}-ven-nobody`, userId: null, name: 'AV Nobody Kitchen', category: 'Test', address: 'x', bannerImage: '', isAcceptingOrders: true, approvalStatus: 'APPROVED' } });
      const res = await post(`${P}-ven-nobody`, 'suspend', { reason: 'Imported by mistake' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, changed: true, data: { id: `${P}-ven-nobody`, approvalStatus: 'SUSPENDED', isAcceptingOrders: false, owner: null } });
      const again = await post(`${P}-ven-nobody`, 'suspend', { reason: 'Imported by mistake' });
      expect([again.status, again.body.changed]).toEqual([200, false]);
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'PARTNER_SUSPENDED', targetId: `${P}-ven-nobody` } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: 'VENDOR', actorId: W.admin.id });
    });

    test('only an APPROVED restaurant can be suspended (INVALID_STATE for pending / rejected)', async () => {
      const v = W.vendors[2];
      for (const st of ['PENDING', 'REJECTED'] as const) {
        await prisma.vendor.update({ where: { id: v.vendorId }, data: { approvalStatus: st } });
        const res = await post(v.vendorId, 'suspend', { reason: 'fine reason' });
        expect([st, res.status, res.body.code]).toEqual([st, 409, 'INVALID_STATE']);
      }
    });

    test('REFUSE: 409 HAS_OPEN_ORDERS with the exact orders and nothing changes; the owner keeps working', async () => {
      const v = W.vendors[0];
      const o = await paidOrder(W.customers[0], v);
      const unpaid = await api.place(W.customers[1], v);
      const res = await post(v.vendorId, 'suspend', { reason: 'Hygiene failure' });
      expect([res.status, res.body.code]).toEqual([409, 'HAS_OPEN_ORDERS']);
      expect(res.body.orders.map((x: any) => x.id).sort()).toEqual([o.id, unpaid.body.data.id].sort());
      expect(await vrow(v.vendorId)).toMatchObject({ approvalStatus: 'APPROVED', isAcceptingOrders: true });
      expect((await api.setStatus(v, o.id, 'ACCEPTED')).status).toBe(200);
      expect((await urow(v.id)).tokenVersion).toBe(0);
    });

    test('CANCEL: paid and unpaid orders are cancelled through the normal path, refunded once, owner sessions end, vendor hidden and closed', async () => {
      const v = W.vendors[0];
      const o = await paidOrder(W.customers[0], v);
      const unpaid = await api.place(W.customers[1], v);
      const w = await new Watcher(server.baseUrl, v).connect();
      watchers.push(w);
      const res = await post(v.vendorId, 'suspend', { reason: 'Hygiene failure', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      expect([res.status, res.body.changed, res.body.failed]).toEqual([200, true, []]);
      expect(res.body.cancelled).toHaveLength(2);
      expect(await orderRow(o.id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'ADMIN', cancelReason: 'Restaurant is no longer available', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect((await orderRow(unpaid.body.data.id)).status).toBe('CANCELLED');
      expect(ledger.refundsOf(o.payId)).toHaveLength(1);
      expect(ledger.totalRefunded()).toBe(ledger.totalCaptured());
      expect(await vrow(v.vendorId)).toMatchObject({ approvalStatus: 'SUSPENDED', isAcceptingOrders: false, rejectionReason: 'Hygiene failure' });
      expect((await urow(v.id)).tokenVersion).toBe(1);
      await new Promise((x) => setTimeout(x, 300));
      expect(w.connected).toBe(false);
      const list = await request.get('/api/vendors').set({ Authorization: `Bearer ${W.customers[0].token}` });
      expect(list.body.data.some((x: any) => x.id === v.vendorId)).toBe(false);
      const refused = await api.place(W.customers[2], v);
      expect(refused.status).toBe(400);
    });

    test('a combined order is cancelled as a whole (the OTHER restaurant\'s part too), one refund of the group total, the count says so', async () => {
      const [v1, v2] = W.vendors;
      const c = W.customers[0];
      const g = await api.placeGroup(c, [cartOf(v1), cartOf(v2)]);
      const cp = await api.createPayment(c, g.body.data.payOrderId);
      ledger.capture(cp.body.razorpayOrderId, 'pay_av_grp', cp.body.amountInPaise);
      await api.verify(c, cp.body.razorpayOrderId, 'pay_av_grp');
      const res = await post(v1.vendorId, 'suspend', { reason: 'Hygiene failure', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      expect(res.body.cancelled).toEqual([expect.objectContaining({ groupId: g.body.data.id, cancelledOrders: 2, refund: 'DONE' })]);
      expect((await prisma.order.findMany({ where: { groupId: g.body.data.id } })).map((k) => k.status)).toEqual(['CANCELLED', 'CANCELLED']);
      expect((await vrow(v2.vendorId)).approvalStatus).toBe('APPROVED'); // the other restaurant is not suspended, only its part was cancelled
      expect(ledger.refundsOf('pay_av_grp')).toEqual([expect.objectContaining({ amountPaise: cp.body.amountInPaise })]);
    });

    test('food already on the way: 409 ORDER_IN_DELIVERY in both modes (also when it is the OTHER restaurant\'s part of the same combined order)', async () => {
      const [v1, v2] = W.vendors;
      const o = await paidOrder(W.customers[0], v1);
      for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) await api.setStatus(v1, o.id, st);
      await api.claim(W.riders[0], o.id);
      await api.setStatus(W.riders[0], o.id, 'PICKED_UP');
      for (const openOrders of ['REFUSE', 'CANCEL']) {
        const res = await post(v1.vendorId, 'suspend', { reason: 'Hygiene failure', openOrders });
        expect([openOrders, res.status, res.body.code]).toEqual([openOrders, 409, 'ORDER_IN_DELIVERY']);
      }
      expect(await vrow(v1.vendorId)).toMatchObject({ approvalStatus: 'APPROVED' });
      expect((await orderRow(o.id)).status).toBe('PICKED_UP');
      // combined: v2 has an unpaid part of a group whose v1 part is ... (ORDER_IN_DELIVERY comes from any child of the group)
      await prisma.order.update({ where: { id: o.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
      const c = W.customers[1];
      const g = await api.placeGroup(c, [cartOf(v1), cartOf(v2)]);
      const cp = await api.createPayment(c, g.body.data.payOrderId);
      ledger.capture(cp.body.razorpayOrderId, 'pay_av_grp2', cp.body.amountInPaise);
      await api.verify(c, cp.body.razorpayOrderId, 'pay_av_grp2');
      for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) for (const [i, v] of [v1, v2].entries()) await api.setStatus(v, g.body.data.orders[i].id, st);
      await api.claim(W.riders[1], g.body.data.orders[0].id);
      await api.setStatus(W.riders[1], g.body.data.orders[0].id, 'PICKED_UP');
      const res = await post(v2.vendorId, 'suspend', { reason: 'Hygiene failure', openOrders: 'CANCEL' });
      expect([res.status, res.body.code]).toEqual([409, 'ORDER_IN_DELIVERY']);
      expect((await prisma.order.findMany({ where: { groupId: g.body.data.id } })).every((k) => k.status !== 'CANCELLED')).toBe(true);
    });

    test('the OLD status route has the same guard and the same wording of the answer, and keeps its response shape', async () => {
      const v = W.vendors[1];
      const o = await paidOrder(W.customers[0], v);
      const refused = await request.post(`/api/admin/partners/vendor/${v.vendorId}/status`).set(admin()).send({ status: 'SUSPENDED', reason: 'Hygiene failure' });
      expect([refused.status, refused.body.code]).toEqual([409, 'HAS_OPEN_ORDERS']);
      const ok = await request.post(`/api/admin/partners/vendor/${v.vendorId}/status`).set(admin()).send({ status: 'SUSPENDED', reason: 'Hygiene failure', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ id: v.vendorId, kind: 'VENDOR', status: 'SUSPENDED', accountStatus: 'ACTIVE' });
      expect(ok.body.cancelled).toHaveLength(1);
      expect((await orderRow(o.id)).status).toBe('CANCELLED');
      const bad = await request.post(`/api/admin/partners/vendor/${v.vendorId}/status`).set(admin()).send({ status: 'APPROVED', openOrders: 'CANCEL' });
      expect(bad.status).toBe(200); // reinstating through the old route still works and ignores openOrders
    });

    test('reinstate: SUSPENDED -> APPROVED but still CLOSED; a removed one is refused; a pending one is INVALID_STATE; ownerless warns', async () => {
      const v = W.vendors[0];
      await post(v.vendorId, 'suspend', { reason: 'Hygiene failure' });
      const res = await post(v.vendorId, 'reinstate');
      expect([res.status, res.body.changed, res.body.data.approvalStatus, res.body.data.isAcceptingOrders]).toEqual([200, true, 'APPROVED', false]);
      expect(res.body.warning).toBeUndefined();
      expect((await post(v.vendorId, 'reinstate')).body.changed).toBe(false);
      expect((await prisma.adminAuditLog.findMany({ where: { action: 'PARTNER_APPROVED', targetId: v.vendorId } }))).toHaveLength(1);
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { approvalStatus: 'PENDING' } });
      expect((await post(v.vendorId, 'reinstate')).body.code).toBe('INVALID_STATE');
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { approvalStatus: 'SUSPENDED', removedAt: new Date() } });
      expect((await post(v.vendorId, 'reinstate')).body.code).toBe('VENDOR_REMOVED');
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { removedAt: null, approvalStatus: 'SUSPENDED', userId: null } });
      const ownerless = await post(v.vendorId, 'reinstate');
      expect(ownerless.body.warning).toMatch(/no owner login/);
    });
  });

  describe('remove / restore', () => {
    test('remove: hidden, closed, dishes / orders / settlements KEPT, owner login disabled and signed out, audited; the exact JSON; idempotent', async () => {
      const [v, other] = W.vendors;
      const delivered = await paidOrder(W.customers[0], v);
      await prisma.order.update({ where: { id: delivered.id }, data: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - 10 * 86_400_000), driverId: W.riders[0].id } });
      const dishes = await prisma.menuItem.count({ where: { vendorId: v.vendorId } });
      const settle = await prisma.settlement.create({ data: { vendorId: v.vendorId, batchKey: '2026-01-01', periodStart: new Date(), periodEnd: new Date(), orderCount: 1, foodGross: 100, vendorAmount: 90, commissionAmount: 10, netPayable: 90, createdBy: 'AUTO' } });
      const w = await new Watcher(server.baseUrl, v).connect();
      watchers.push(w);
      const res = await post(v.vendorId, 'remove', rmBody(v));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, changed: true, ownerDisabled: true, data: { id: v.vendorId, approvalStatus: 'SUSPENDED', isAcceptingOrders: false, removedReason: 'Hygiene failure', owner: { id: v.id, accountStatus: 'SUSPENDED', statusReason: 'Restaurant removed' } } });
      expect(res.body.data.removedAt).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenVersion/);
      expect(await prisma.menuItem.count({ where: { vendorId: v.vendorId, deletedAt: null } })).toBe(dishes);
      expect((await orderRow(delivered.id)).status).toBe('DELIVERED');
      expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settle.id } })).status).toBe('PENDING');
      expect(await vrow(v.vendorId)).toMatchObject({ userId: v.id, ownerDisabledByRemoval: true });
      expect(await urow(v.id)).toMatchObject({ accountStatus: 'SUSPENDED', statusReason: 'Restaurant removed', statusChangedBy: W.admin.id, tokenVersion: 1 });
      await new Promise((x) => setTimeout(x, 300));
      expect(w.connected).toBe(false);
      // customers, categories, the owner and the order path do not see it; admins see it with includeRemoved
      expect((await request.get('/api/vendors').set({ Authorization: `Bearer ${W.customers[0].token}` })).body.data.some((x: any) => x.id === v.vendorId)).toBe(false);
      expect((await request.get(`/api/vendors/${v.vendorId}`)).status).toBe(404);
      expect((await request.get(`/api/menus/${v.vendorId}`)).body.count).toBe(0);
      expect((await api.place(W.customers[0], v)).body.code).toBe('VENDOR_UNAVAILABLE');
      const inc = await request.get('/api/vendors?includeRemoved=1').set(admin());
      expect(inc.body.data.find((x: any) => x.id === v.vendorId)).toMatchObject({ removedAt: expect.any(String), owner: { accountStatus: 'SUSPENDED' } });
      // the other restaurant is untouched
      expect(await vrow(other.vendorId)).toMatchObject({ approvalStatus: 'APPROVED', removedAt: null });
      // idempotent; one audit row
      const again = await post(v.vendorId, 'remove', rmBody(v));
      expect([again.status, again.body.changed]).toEqual([200, false]);
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'VENDOR_REMOVED' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: 'VENDOR', targetId: v.vendorId, actorId: W.admin.id });
      expect(rows[0].summary).toContain('owner login disabled');
    });

    test('settlements: the daily job still settles the delivered orders of a REMOVED restaurant, the batch stays for the admin to pay, the payout account of the owner stays', async () => {
      const v = W.vendors[0];
      const o = await paidOrder(W.customers[0], v);
      await prisma.order.update({ where: { id: o.id }, data: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - 10 * 86_400_000), vendorSubtotal: 150, commissionTotal: 30 } });
      await prisma.payoutAccount.deleteMany({ where: { userId: v.id } });
      await prisma.payoutAccount.create({ data: { userId: v.id, partnerType: 'VENDOR', method: 'UPI', upiId: 'kitchen@upi' } });
      expect((await post(v.vendorId, 'remove', rmBody(v))).status).toBe(200);
      const run = await createSettlements({ createdBy: 'AUTO', vendorId: v.vendorId });
      expect(run.created).toHaveLength(1);
      expect(run.created[0]).toMatchObject({ vendorId: v.vendorId, netPayable: 150 });
      expect(run.created[0].payoutSnapshot).toMatchObject({ method: 'UPI', destination: 'kitchen@upi' });
      const acct = await request.get(`/api/admin/partners/${v.id}/payout-account`).set(admin());
      expect([acct.status, acct.body.data.upiId]).toEqual([200, 'kitchen@upi']);
      const impact = await request.get(`/api/admin/vendors/${v.vendorId}/impact`).set(admin());
      expect(impact.body.data).toMatchObject({ removed: true, hasOwner: true, unpaidSettlements: { count: 1, amount: 150 } });
      await prisma.payoutAccount.deleteMany({ where: { userId: v.id } });
    });

    test('remove with disableOwner:false keeps the owner login ACTIVE (but their old sessions end); restore re-enables ONLY what the removal disabled', async () => {
      const [a, b] = W.vendors;
      // a: removal disables the owner; restore brings it back
      await post(a.vendorId, 'remove', rmBody(a));
      const ra = await post(a.vendorId, 'restore');
      expect([ra.status, ra.body.changed, ra.body.ownerRestored]).toEqual([200, true, true]);
      expect(ra.body.data).toMatchObject({ removedAt: null, approvalStatus: 'SUSPENDED', isAcceptingOrders: false, owner: { accountStatus: 'ACTIVE', statusReason: null } });
      expect(await vrow(a.vendorId)).toMatchObject({ removedReason: null, ownerDisabledByRemoval: false });
      expect((await post(a.vendorId, 'restore')).body.changed).toBe(false);
      // b: owner kept active; the old token is dead anyway
      const rb = await post(b.vendorId, 'remove', rmBody(b, { disableOwner: false }));
      expect([rb.body.ownerDisabled, rb.body.data.owner.accountStatus]).toEqual([false, 'ACTIVE']);
      expect((await urow(b.id)).tokenVersion).toBe(1);
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${b.token}` })).status).toBe(401);
      // c: the owner was disabled separately BEFORE the removal -> restore must not re-enable it
      await prisma.user.update({ where: { id: b.id }, data: { accountStatus: 'SUSPENDED', statusReason: 'Disabled by Kraveo' } });
      await post(b.vendorId, 'restore');
      expect((await urow(b.id)).accountStatus).toBe('SUSPENDED');
      // reinstating and opening is a separate, deliberate step
      const re = await post(a.vendorId, 'reinstate');
      expect(re.body.data).toMatchObject({ approvalStatus: 'APPROVED', isAcceptingOrders: false });
      expect(await prisma.adminAuditLog.count({ where: { action: 'VENDOR_RESTORED' } })).toBe(2);
    });

    test('a pending / rejected restaurant keeps its own approval state when removed; an ownerless one can be removed', async () => {
      const v = W.vendors[2];
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { approvalStatus: 'PENDING', userId: null } });
      const res = await post(v.vendorId, 'remove', rmBody(v));
      expect([res.status, res.body.ownerDisabled]).toEqual([200, false]);
      expect(await vrow(v.vendorId)).toMatchObject({ approvalStatus: 'PENDING', removedAt: expect.any(Date), isAcceptingOrders: false });
    });

    test('a removed restaurant cannot be approved again by the old status route, and the applications list shows it as removed', async () => {
      const v = W.vendors[0];
      await post(v.vendorId, 'remove', rmBody(v));
      const approve = await request.post(`/api/admin/partners/vendor/${v.vendorId}/status`).set(admin()).send({ status: 'APPROVED' });
      expect([approve.status, approve.body.code]).toEqual([409, 'VENDOR_REMOVED']);
      const list = await request.get('/api/admin/applications?status=SUSPENDED&kind=VENDOR').set(admin());
      expect(list.body.data.find((x: any) => x.id === v.vendorId)).toMatchObject({ removedAt: expect.any(String), accountStatus: 'SUSPENDED' });
    });

    test('open orders at removal: REFUSE lists them and changes nothing; CANCEL cancels and refunds once; the typed name is checked first', async () => {
      const v = W.vendors[0];
      const o = await paidOrder(W.customers[0], v);
      const refused = await post(v.vendorId, 'remove', rmBody(v));
      expect([refused.status, refused.body.code]).toEqual([409, 'HAS_OPEN_ORDERS']);
      expect(await vrow(v.vendorId)).toMatchObject({ removedAt: null });
      const noName = await post(v.vendorId, 'remove', { reason: 'Hygiene failure', confirmName: 'nope', openOrders: 'CANCEL' });
      expect(noName.body.code).toBe('CONFIRM_MISMATCH');
      expect((await orderRow(o.id)).status).toBe('PLACED');
      const ok = await post(v.vendorId, 'remove', rmBody(v, { openOrders: 'CANCEL' }));
      await __waitForBackgroundWork();
      expect([ok.status, ok.body.cancelled?.length]).toEqual([200, 1]);
      expect(await orderRow(o.id)).toMatchObject({ status: 'CANCELLED', refundStatus: 'DONE' });
      expect(ledger.refundsOf(o.payId)).toHaveLength(1);
      expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'VENDOR_REMOVED' } })).summary).toContain('1 open order(s) cancelled');
    });
  });

  describe('races with checkout', () => {
    test('removal (REFUSE) vs a customer placing an order at the same moment: either the order exists and the removal was refused, or the restaurant is removed and no order exists (20 rounds, the removal starts 0-19 ms after the checkout)', async () => {
      const v = W.vendors[0];
      const c = W.customers[0];
      let removedRounds = 0;
      let refusedRounds = 0;
      for (let i = 0; i < 20; i++) {
        await prisma.vendor.update({ where: { id: v.vendorId }, data: { removedAt: null, approvalStatus: 'APPROVED', isAcceptingOrders: true, ownerDisabledByRemoval: false } });
        await prisma.user.update({ where: { id: v.id }, data: { accountStatus: 'ACTIVE', tokenVersion: 0 } });
        await prisma.order.deleteMany({ where: { vendorId: v.vendorId } });
        // the removal starts a little later each round, so the two requests meet at every point of the checkout
        const [placed, removed] = await Promise.all([api.place(c, v), sleepThen(i, () => post(v.vendorId, 'remove', rmBody(v)))]);
        const orders = await prisma.order.count({ where: { vendorId: v.vendorId } });
        const row = await vrow(v.vendorId);
        if (row.removedAt) {
          removedRounds += 1;
          expect([removed.status, orders]).toEqual([200, 0]);
          expect(placed.status).toBe(400);
        } else {
          refusedRounds += 1;
          expect([removed.status, removed.body.code, placed.status, orders]).toEqual([409, 'HAS_OPEN_ORDERS', 201, 1]);
        }
      }
      expect(removedRounds + refusedRounds).toBe(20);
    });

    test('removal (CANCEL) vs checkout at the same moment: whatever was placed is cancelled, nothing open is left on a removed restaurant, no double refund', async () => {
      const v = W.vendors[1];
      const c = W.customers[1];
      for (let i = 0; i < 14; i++) {
        await prisma.vendor.update({ where: { id: v.vendorId }, data: { removedAt: null, approvalStatus: 'APPROVED', isAcceptingOrders: true } });
        await prisma.order.deleteMany({ where: { vendorId: v.vendorId } });
        const [placed, removed] = await Promise.all([api.place(c, v), sleepThen(i * 2, () => post(v.vendorId, 'remove', rmBody(v, { openOrders: 'CANCEL' })))]);
        expect(removed.status).toBe(200);
        await __waitForBackgroundWork();
        const open = await prisma.order.count({ where: { vendorId: v.vendorId, status: { notIn: ['DELIVERED', 'CANCELLED'] } } });
        expect(open).toBe(0);
        expect([201, 400]).toContain(placed.status);
        if (placed.status === 201) expect((await orderRow(placed.body.data.id)).status).toBe('CANCELLED');
      }
    });

    test('removal vs a payment that lands at the same moment: the order is refunded exactly once', async () => {
      const v = W.vendors[2];
      const c = W.customers[2];
      for (let i = 0; i < 5; i++) {
        await prisma.vendor.update({ where: { id: v.vendorId }, data: { removedAt: null, approvalStatus: 'APPROVED', isAcceptingOrders: true } });
        const placed = await api.place(c, v);
        const id = placed.body.data.id as string;
        const cp = await api.createPayment(c, id);
        const payId = `pay_av_race_${i}`;
        ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
        await Promise.all([api.verify(c, cp.body.razorpayOrderId, payId), sleepThen(i * 3, () => post(v.vendorId, 'remove', rmBody(v, { openOrders: 'CANCEL' })))]);
        await api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
        await __waitForBackgroundWork();
        const row = await orderRow(id);
        if (row.status === 'CANCELLED') expect(ledger.refundsOf(payId)).toHaveLength(1);
        else expect(row.paymentStatus).toBe('PAID'); // the removal was refused because the paid order was already live
        await prisma.order.update({ where: { id }, data: { status: 'CANCELLED' } });
      }
    });
  });
});
