/**
 * Admin user management, B4 owner logins (Docs/27 B4, Docs/28 decisions 1 and 3): create for an ownerless restaurant (password shown once),
 * attach a detached login, change phone / name, reset password, disable / enable, detach, remove; one restaurant per login; unique phones;
 * payout details follow the new owner; nothing secret reaches an audit row, a log or a second read. Real PostgreSQL and HTTP.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { __resetLoginLimiter, isLocked, recordFailure } from '../../src/services/loginLimiter';
import { hashPassword } from '../../src/services/password';
import { registerDeviceToken } from '../../src/services/push/deviceTokens';
import { World, Customer, Vendor, Ledger, Api, Watcher, createWorld, purgeWorld, resetWorldState, createLedger, createApi } from '../harness/journey';

jest.setTimeout(180_000);
const P = 'ao';
const PW = 'Sup3rSecret!';
const KEY = Buffer.alloc(32, 7).toString('base64');
const BANK = { method: 'BANK', accountHolder: 'Ram Singh', accountNumber: '50100234567890', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' };
const GEN_RE = /^[A-HJ-NP-Za-km-z2-9]{16}$/;

describe('Admin owner logins', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let request: ReturnType<typeof supertest>;
  const watchers: Watcher[] = [];
  const secrets: string[] = [];
  const admin = () => ({ Authorization: `Bearer ${W.admin.token}` });
  const post = (id: string, path: string, body: object = {}) => request.post(`/api/admin/vendors/${id}/owner${path}`).set(admin()).send(body);
  const patch = (id: string, body: object) => request.patch(`/api/admin/vendors/${id}/owner`).set(admin()).send(body);
  const vrow = (id: string) => prisma.vendor.findUniqueOrThrow({ where: { id } });
  const urow = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
  const login = (phone: string, password: string) => request.post('/api/auth/partner-login').send({ phone, password, role: 'VENDOR' });
  let seq = 0;
  const newPhone = () => `98765${String(43000 + ++seq).slice(-5)}`;
  /** An ownerless restaurant of this suite. */
  const ownerless = async (name = 'AO Imported Kitchen') => {
    const id = `${P}-ven-x${++seq}`;
    await prisma.vendor.create({ data: { id, userId: null, name, category: 'Test', address: 'x', bannerImage: '', isAcceptingOrders: true, approvalStatus: 'APPROVED' } });
    await prisma.menuItem.create({ data: { id: `${id}-i1`, vendorId: id, name: 'Dish', price: 100, vendorPrice: 100, category: 'Test', description: 'd', imageUrl: '', isAvailable: true } });
    return id;
  };
  const paidOrder = async (c: Customer, v: { vendorId: string; items: { id: string }[] }) => {
    const placed = await api.raw('c', 'post', '/api/orders', c.token, { vendorId: v.vendorId, items: [{ itemId: v.items[0].id, quantity: 1 }], dropoffHostel: 'BH2', clientRequestId: randomUUID() });
    expect(placed.status).toBe(201);
    const id = placed.body.data.id as string;
    const cp = await api.createPayment(c, id);
    const payId = `pay_${randomUUID().slice(0, 12)}`;
    ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
    expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
    return { id, payId };
  };

  beforeAll(async () => {
    process.env.PAYOUT_ENC_KEY = KEY;
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    W = await createWorld(P, '6', { customers: 2, vendors: 3, riders: 1 });
    server = await startTestServer(0);
    request = supertest(server.app);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await __waitForBackgroundWork();
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.payoutAccount.deleteMany({ where: { user: { id: { startsWith: `${P}-` } } } });
    await prisma.vendor.deleteMany({ where: { id: { startsWith: `${P}-ven-x` } } });
    await prisma.user.deleteMany({ where: { role: 'VENDOR', phone: { startsWith: '+91 98765' }, NOT: { id: { startsWith: `${P}-` } } } });
    await resetWorldState(W);
    await prisma.vendor.updateMany({ where: { id: { startsWith: `${P}-ven-` } }, data: { removedAt: null, ownerDisabledByRemoval: false } });
    for (const v of W.vendors) await prisma.vendor.update({ where: { id: v.vendorId }, data: { userId: v.id } });
    await prisma.user.updateMany({ where: { id: { startsWith: `${P}-` } }, data: { accountStatus: 'ACTIVE', statusReason: null, deletedAt: null } });
    for (const v of W.vendors) await prisma.user.update({ where: { id: v.id }, data: { phone: v.phone, name: v.name, passwordHash: await hashPassword(PW) } });
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
    delete process.env.PAYOUT_ENC_KEY;
    await stopTestServer(server);
    await prisma.payoutAccount.deleteMany({ where: { user: { id: { startsWith: `${P}-` } } } });
    await prisma.vendor.deleteMany({ where: { id: { startsWith: `${P}-ven-x` } } });
    await prisma.user.deleteMany({ where: { role: 'VENDOR', phone: { startsWith: '+91 98765' }, NOT: { id: { startsWith: `${P}-` } } } });
    await purgeWorld(P);
    await cleanTestOrders();
    // no secret that was ever handed to an admin may be in the audit log
    const log = JSON.stringify(await prisma.adminAuditLog.findMany());
    for (const s of secrets) expect(log).not.toContain(s);
    await prisma.adminAuditLog.deleteMany({});
    await prisma.$disconnect();
  });

  describe('create', () => {
    test('GET owner: null for an ownerless restaurant, the owner block for one with a login, 404 for an unknown restaurant', async () => {
      const x = await ownerless();
      expect((await request.get(`/api/admin/vendors/${x}/owner`).set(admin())).body).toEqual({ success: true, owner: null });
      const v = W.vendors[0];
      const g = await request.get(`/api/admin/vendors/${v.vendorId}/owner`).set(admin());
      expect(g.body.owner).toMatchObject({ userId: v.id, name: v.name, phone: v.phone, accountStatus: 'ACTIVE', statusReason: null, restaurants: 1 });
      expect(JSON.stringify(g.body)).not.toMatch(/passwordHash|scrypt|tokenVersion/);
      expect((await request.get('/api/admin/vendors/ao-none/owner').set(admin())).status).toBe(404);
    });

    test('create with a GENERATED password: 201, shown once (no-store), the restaurant is linked and CLOSED, the owner can sign in, nothing secret is stored, logged or audited', async () => {
      const x = await ownerless();
      const logs: string[] = [];
      const spies = (['log', 'error', 'warn', 'info'] as const).map((m) => jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }));
      const phone = newPhone();
      const res = await post(x, '', { name: 'Ramesh Kumar', phone });
      spies.forEach((s) => s.mockRestore());
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({ success: true, restaurantClosed: true, payoutAccountMoved: false, owner: { name: 'Ramesh Kumar', phone: `+91 ${phone}`, accountStatus: 'ACTIVE', restaurants: 1 } });
      const pw = res.body.generatedPassword as string;
      expect(pw).toMatch(GEN_RE);
      secrets.push(pw);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|scrypt/);
      expect(logs.join('\n')).not.toContain(pw);
      const u = await urow(res.body.owner.userId);
      expect(u).toMatchObject({ role: 'VENDOR', accountStatus: 'ACTIVE' });
      expect(u.passwordHash).toMatch(/^scrypt\$/);
      expect(u.passwordHash).not.toContain(pw);
      expect(await vrow(x)).toMatchObject({ userId: u.id, isAcceptingOrders: false, approvalStatus: 'APPROVED' });
      // it works: the owner signs in with the shown password, once; a second read never contains it
      const sign = await login(phone, pw);
      expect([sign.status, sign.body.vendor?.id, sign.body.approvalStatus]).toEqual([200, x, 'APPROVED']);
      expect(JSON.stringify((await request.get(`/api/admin/vendors/${x}/owner`).set(admin())).body)).not.toContain(pw);
      const adminList = await request.get('/api/vendors').set(admin());
      expect(adminList.body.data.find((v: any) => v.id === x).owner).toMatchObject({ id: u.id, name: 'Ramesh Kumar' });
      const open = await request.patch(`/api/vendors/${x}/status`).set({ Authorization: `Bearer ${sign.body.token}` }).send({ isAcceptingOrders: true });
      expect([open.status, open.body.isAcceptingOrders]).toEqual([200, true]); // the owner opens it on purpose
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'OWNER_CREATED' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: 'VENDOR', targetId: x, actorId: W.admin.id });
      expect(JSON.stringify(rows[0])).not.toContain(pw);
    });

    test('create with a TYPED password: it is not echoed; the policy (8-128) is enforced; unknown fields, bad name / phone are 400', async () => {
      const x = await ownerless();
      const bad: [object, string][] = [
        [{ name: 'R', phone: newPhone() }, 'name'], [{ name: 'Ramesh <b>', phone: newPhone() }, 'name'], [{ name: 'Ramesh Kumar', phone: '12345' }, 'phone'],
        [{ name: 'Ramesh Kumar', phone: newPhone(), password: 'short' }, 'password'], [{ name: 'Ramesh Kumar', phone: newPhone(), password: 'x'.repeat(129) }, 'password'],
        [{ name: 'Ramesh Kumar', phone: newPhone(), role: 'ADMIN' }, 'role'], [{ existingUserId: 'ao-x', name: 'Ramesh Kumar' }, 'existingUserId'], [{}, 'name'],
      ];
      for (const [body, field] of bad) {
        const res = await post(x, '', body);
        expect([JSON.stringify(body), res.status, res.body.field]).toEqual([JSON.stringify(body), 400, field]);
      }
      expect(await prisma.user.count({ where: { phone: { startsWith: '+91 98765' }, role: 'VENDOR' } })).toBe(0);
      const phone = newPhone();
      const ok = await post(x, '', { name: 'Ramesh Kumar', phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`, password: 'MyOwnPass123' });
      expect(ok.status).toBe(201);
      expect(ok.body.generatedPassword).toBeUndefined();
      expect(JSON.stringify(ok.body)).not.toContain('MyOwnPass123');
      expect((await login(phone, 'MyOwnPass123')).status).toBe(200);
    });

    test('a restaurant that already has an owner -> 409 OWNER_EXISTS; a removed restaurant -> 409 VENDOR_REMOVED; unknown -> 404', async () => {
      const v = W.vendors[0];
      const res = await post(v.vendorId, '', { name: 'Ramesh Kumar', phone: newPhone() });
      expect([res.status, res.body.code]).toEqual([409, 'OWNER_EXISTS']);
      const x = await ownerless();
      await prisma.vendor.update({ where: { id: x }, data: { removedAt: new Date(), approvalStatus: 'SUSPENDED' } });
      expect((await post(x, '', { name: 'Ramesh Kumar', phone: newPhone() })).body.code).toBe('VENDOR_REMOVED');
      expect((await post('ao-none', '', { name: 'Ramesh Kumar', phone: newPhone() })).status).toBe(404);
    });

    test('phones are unique among ALL users: another account, a REMOVED user, another format of the same number -> 409 PHONE_TAKEN, nothing created', async () => {
      const x = await ownerless();
      const taken = W.customers[0].phone; // +91 9777...
      for (const p of [taken, taken.replace('+91 ', ''), taken.replace('+91 ', '0')]) {
        const res = await post(x, '', { name: 'Ramesh Kumar', phone: p });
        expect([p, res.status, res.body.code, res.body.field]).toEqual([p, 409, 'PHONE_TAKEN', undefined]);
      }
      await prisma.user.update({ where: { id: W.customers[1].id }, data: { accountStatus: 'REMOVED', deletedAt: new Date() } });
      expect((await post(x, '', { name: 'Ramesh Kumar', phone: W.customers[1].phone })).body.code).toBe('PHONE_TAKEN');
      expect((await vrow(x)).userId).toBeNull();
    });

    test('two admins creating at once: exactly one 201; the loser leaves NO orphan user; two creations with the same phone for different restaurants: one 201, one 409', async () => {
      const x = await ownerless();
      const phoneA = newPhone();
      const phoneB = newPhone();
      const [a, b] = await Promise.all([post(x, '', { name: 'Ramesh Kumar', phone: phoneA }), post(x, '', { name: 'Suresh Kumar', phone: phoneB })]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe('OWNER_EXISTS');
      expect(await prisma.user.count({ where: { phone: { in: [`+91 ${phoneA}`, `+91 ${phoneB}`] } } })).toBe(1);
      const y = await ownerless();
      const z = await ownerless();
      const same = newPhone();
      const [c, d] = await Promise.all([post(y, '', { name: 'Ramesh Kumar', phone: same }), post(z, '', { name: 'Suresh Kumar', phone: same })]);
      expect([c.status, d.status].sort()).toEqual([201, 409]);
      expect([c, d].find((r) => r.status === 409)!.body.code).toBe('PHONE_TAKEN');
      expect(await prisma.user.count({ where: { phone: `+91 ${same}` } })).toBe(1);
    });
  });

  describe('change phone / name, reset password', () => {
    test('PATCH name only: no session change; no change at all -> changed:false and no audit row; empty body and unknown keys -> 400', async () => {
      const v = W.vendors[0];
      const res = await patch(v.vendorId, { name: 'New Owner Name' });
      expect([res.status, res.body.changed, res.body.owner.name]).toEqual([200, true, 'New Owner Name']);
      expect((await urow(v.id)).tokenVersion).toBe(0);
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${v.token}` })).status).toBe(200);
      expect((await patch(v.vendorId, { name: 'New Owner Name' })).body.changed).toBe(false);
      expect(await prisma.adminAuditLog.count({ where: { action: 'OWNER_RENAMED' } })).toBe(1);
      expect((await patch(v.vendorId, {})).status).toBe(400);
      expect((await patch(v.vendorId, { name: 'Abc Def', email: 'a@b.c' })).body.field).toBe('email');
      expect((await patch(v.vendorId, { phone: 'abc' })).body.field).toBe('phone');
    });

    test('PATCH phone: every old session ends, the OLD number stops working, the NEW number works with the SAME password, lockouts are cleared, push tokens stay, audit shows last 4 digits only', async () => {
      const v = W.vendors[0];
      const oldPhone = v.phone;
      const phone = newPhone();
      await registerDeviceToken({ userId: v.id, token: 'ao-dev-1', app: 'VENDOR', platform: 'android', appVersion: '1' });
      const live = await new Watcher(server.baseUrl, v).connect();
      watchers.push(live);
      for (let i = 0; i < 5; i++) recordFailure(oldPhone.replace(/\D/g, '').slice(-10));
      expect(isLocked(oldPhone.replace(/\D/g, '').slice(-10))).toBeGreaterThan(0);
      const res = await patch(v.vendorId, { phone });
      expect([res.status, res.body.changed, res.body.owner.phone]).toEqual([200, true, `+91 ${phone}`]);
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${v.token}` })).status).toBe(401);
      await new Promise((x) => setTimeout(x, 300));
      expect(live.connected).toBe(false);
      expect(isLocked(oldPhone.replace(/\D/g, '').slice(-10))).toBe(0);
      expect((await login(oldPhone, PW)).status).toBe(401);
      const ok = await login(phone, PW);
      expect([ok.status, ok.body.user.phone]).toEqual([200, `+91 ${phone}`]);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: 'ao-dev-1' } })).disabledAt).toBeNull();
      const row = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'OWNER_PHONE_CHANGED' } });
      expect(row.summary).toContain(`...${oldPhone.replace(/\D/g, '').slice(-4)} -> ...${phone.slice(-4)}`);
      expect(row.summary).not.toContain(phone);
      expect(row.actorId).toBe(W.admin.id);
    });

    test('PATCH phone to a number another account has (also a removed user\'s) -> 409 PHONE_TAKEN, sessions untouched; a parallel change to the same number: one wins', async () => {
      const [a, b] = W.vendors;
      const res = await patch(a.vendorId, { phone: b.phone });
      expect([res.status, res.body.code]).toEqual([409, 'PHONE_TAKEN']);
      await prisma.user.update({ where: { id: W.customers[0].id }, data: { accountStatus: 'REMOVED', deletedAt: new Date() } });
      expect((await patch(a.vendorId, { phone: W.customers[0].phone })).body.code).toBe('PHONE_TAKEN');
      expect((await urow(a.id)).tokenVersion).toBe(0);
      const target = newPhone();
      const [p, q] = await Promise.all([patch(a.vendorId, { phone: target }), patch(b.vendorId, { phone: target })]);
      expect([p.status, q.status].sort()).toEqual([200, 409]);
      expect(await prisma.user.count({ where: { phone: `+91 ${target}` } })).toBe(1);
    });

    test('reset password: generated or typed, old password and every session dead, lockout cleared, shown once, audit without the password; a removed owner -> 409 OWNER_REMOVED', async () => {
      const v = W.vendors[1];
      const res = await post(v.vendorId, '/reset-password');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const pw = res.body.generatedPassword as string;
      secrets.push(pw);
      expect(pw).toMatch(GEN_RE);
      expect((await login(v.phone, PW)).status).toBe(401);
      expect((await login(v.phone, pw)).status).toBe(200);
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${v.token}` })).status).toBe(401);
      const typed = await post(v.vendorId, '/reset-password', { password: 'Typed-Pass-99' });
      expect([typed.status, typed.body.generatedPassword, JSON.stringify(typed.body)]).toEqual([200, undefined, '{"success":true}']);
      expect((await login(v.phone, 'Typed-Pass-99')).status).toBe(200);
      expect((await post(v.vendorId, '/reset-password', { password: 'short' })).body.field).toBe('password');
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'PASSWORD_RESET' } });
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${pw}|Typed-Pass-99`));
      await prisma.user.update({ where: { id: v.id }, data: { accountStatus: 'REMOVED', deletedAt: new Date() } });
      expect((await post(v.vendorId, '/reset-password')).body.code).toBe('OWNER_REMOVED');
      const x = await ownerless();
      expect((await post(x, '/reset-password')).body.code).toBe('NO_OWNER');
    });
  });

  describe('disable / enable', () => {
    test('disable: signed out everywhere, login 403 ACCOUNT_SUSPENDED, restaurant closed, running orders untouched; repeat is changed:false; enable brings the LOGIN back and does not reopen the restaurant', async () => {
      const v = W.vendors[0];
      const o = await paidOrder(W.customers[0], v);
      const live = await new Watcher(server.baseUrl, v).connect();
      watchers.push(live);
      const res = await post(v.vendorId, '/disable', { reason: 'Owner not answering' });
      expect([res.status, res.body.changed, res.body.owner.accountStatus, res.body.openOrders, res.body.warning]).toEqual([200, true, 'SUSPENDED', 1, undefined]);
      expect(await vrow(v.vendorId)).toMatchObject({ isAcceptingOrders: false, userId: v.id });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PLACED');
      const sign = await login(v.phone, PW);
      expect([sign.status, sign.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      expect(sign.body.message).toContain('Owner not answering');
      await new Promise((x) => setTimeout(x, 300));
      expect(live.connected).toBe(false);
      expect((await post(v.vendorId, '/disable', { reason: 'Owner not answering' })).body.changed).toBe(false);
      expect(await prisma.adminAuditLog.count({ where: { action: 'OWNER_DISABLED' } })).toBe(1);
      // the admin can still drive the order (ADMIN_TARGETS)
      expect((await api.setStatus(W.admin, o.id, 'ACCEPTED')).status).toBe(200);
      const en = await post(v.vendorId, '/enable');
      expect([en.status, en.body.changed, en.body.owner.accountStatus]).toEqual([200, true, 'ACTIVE']);
      expect((await login(v.phone, PW)).status).toBe(200);
      expect((await vrow(v.vendorId)).isAcceptingOrders).toBe(false);
      expect((await post(v.vendorId, '/enable')).body.changed).toBe(false);
    });

    test('disable without closing the restaurant warns that orders will arrive that only an admin can accept; bad bodies are 400; a removed owner cannot be enabled', async () => {
      const v = W.vendors[1];
      const res = await post(v.vendorId, '/disable', { reason: 'Owner not answering', closeRestaurant: false });
      expect(res.body.warning).toBe('Orders will arrive that only an admin can accept.');
      expect((await vrow(v.vendorId)).isAcceptingOrders).toBe(true);
      for (const [body, field] of [[{}, 'reason'], [{ reason: 'ab' }, 'reason'], [{ reason: 'fine reason', closeRestaurant: 'no' }, 'closeRestaurant'], [{ reason: 'fine reason', x: 1 }, 'x']] as [object, string][]) {
        expect((await post(v.vendorId, '/disable', body)).body.field).toBe(field);
      }
      await prisma.user.update({ where: { id: v.id }, data: { accountStatus: 'REMOVED', deletedAt: new Date() } });
      expect((await post(v.vendorId, '/enable')).body.code).toBe('OWNER_REMOVED');
      expect((await post(v.vendorId, '/disable', { reason: 'fine reason' })).body.code).toBe('OWNER_REMOVED');
    });
  });

  describe('detach / remove / attach', () => {
    test('detach with a running order -> 409 HAS_OPEN_ORDERS; with CANCEL the order is cancelled + refunded once; the login is paused and signed out, the restaurant is ownerless and closed', async () => {
      const v = W.vendors[0];
      const o = await paidOrder(W.customers[0], v);
      const refused = await post(v.vendorId, '/detach', { reason: 'New owner' });
      expect([refused.status, refused.body.code]).toEqual([409, 'HAS_OPEN_ORDERS']);
      expect((await vrow(v.vendorId)).userId).toBe(v.id);
      const res = await post(v.vendorId, '/detach', { reason: 'New owner', openOrders: 'CANCEL' });
      await __waitForBackgroundWork();
      expect([res.status, res.body.owner, res.body.detachedUser]).toEqual([200, null, { id: v.id, name: v.name }]);
      expect(res.body.cancelled).toHaveLength(1);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'CANCELLED', refundStatus: 'DONE' });
      expect(ledger.refundsOf(o.payId)).toHaveLength(1);
      expect(await vrow(v.vendorId)).toMatchObject({ userId: null, isAcceptingOrders: false });
      expect(await urow(v.id)).toMatchObject({ accountStatus: 'SUSPENDED', statusReason: `Detached from ${(await vrow(v.vendorId)).name}`, tokenVersion: 1 });
      expect((await login(v.phone, PW)).body.code).toBe('ACCOUNT_SUSPENDED');
      // now an ownerless restaurant: visible, shown closed, no orders, the second detach is NO_OWNER
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { isAcceptingOrders: true } }); // even if it is flagged open, an ownerless restaurant takes no orders
      expect((await api.place(W.customers[1], v)).body.message).toBe('This restaurant is not taking orders right now.');
      expect((await post(v.vendorId, '/detach', { reason: 'New owner' })).body.code).toBe('NO_OWNER');
    });

    test('re-attach a detached login (existingUserId) to another ownerless restaurant; one restaurant per login; wrong kinds of user are refused', async () => {
      const [a, b] = W.vendors;
      await post(a.vendorId, '/detach', { reason: 'Moving the owner' });
      const x = await ownerless();
      expect((await post(x, '', { existingUserId: b.id })).body.code).toBe('OWNER_HAS_RESTAURANT');
      expect((await post(x, '', { existingUserId: W.customers[0].id })).body.code).toBe('NOT_A_VENDOR_USER');
      expect((await post(x, '', { existingUserId: W.riders[0].id })).body.code).toBe('NOT_A_VENDOR_USER');
      expect((await post(x, '', { existingUserId: 'ao-none' })).status).toBe(404);
      expect((await post(x, '', { existingUserId: '../x' })).body.field).toBe('existingUserId');
      const ok = await post(x, '', { existingUserId: a.id });
      expect([ok.status, ok.body.owner.accountStatus, ok.body.generatedPassword, ok.body.restaurantClosed]).toEqual([201, 'ACTIVE', undefined, true]);
      expect((await vrow(x)).userId).toBe(a.id);
      expect((await login(a.phone, PW)).status).toBe(200); // same password
      // a REMOVED login cannot be attached
      const y = await ownerless();
      await prisma.user.update({ where: { id: W.vendors[2].id }, data: { accountStatus: 'REMOVED', deletedAt: new Date() } });
      await prisma.vendor.update({ where: { id: W.vendors[2].vendorId }, data: { userId: null } });
      expect((await post(y, '', { existingUserId: W.vendors[2].id })).body.code).toBe('OWNER_REMOVED');
    });

    test('one restaurant per login holds under a race: the same detached login attached to two restaurants at once -> one 201, one 409', async () => {
      const a = W.vendors[0];
      await post(a.vendorId, '/detach', { reason: 'Moving the owner' });
      const x = await ownerless();
      const y = await ownerless();
      const [p, q] = await Promise.all([post(x, '', { existingUserId: a.id }), post(y, '', { existingUserId: a.id })]);
      expect([p.status, q.status].sort()).toEqual([201, 409]);
      expect(await prisma.vendor.count({ where: { userId: a.id } })).toBe(1);
    });

    test('payout details follow the new owner: re-encrypted for the new user id, verification cleared, same number on reveal; refused when the new owner has details, or the source still runs a restaurant', async () => {
      const [a, b] = W.vendors;
      const put = await request.put(`/api/admin/partners/${a.id}/payout-account`).set(admin()).send(BANK);
      expect(put.status).toBe(200);
      await request.patch(`/api/admin/partners/${a.id}/payout-account/verify`).set(admin()).send({ verified: true });
      const x = await ownerless();
      expect((await post(x, '', { name: 'Ramesh Kumar', phone: newPhone(), takePayoutAccountFrom: a.id })).body.code).toBe('PAYOUT_SOURCE_IN_USE');
      expect((await vrow(x)).userId).toBeNull(); // the whole create rolled back
      await post(a.vendorId, '/detach', { reason: 'New owner' });
      expect((await post(x, '', { name: 'Ramesh Kumar', phone: newPhone(), takePayoutAccountFrom: 'bad id!' })).body.field).toBe('takePayoutAccountFrom');
      expect((await post(x, '', { name: 'Ramesh Kumar', phone: newPhone(), takePayoutAccountFrom: b.id })).body.code).toBe('PAYOUT_SOURCE_IN_USE');
      const ok = await post(x, '', { name: 'Ramesh Kumar', phone: newPhone(), takePayoutAccountFrom: a.id });
      expect([ok.status, ok.body.payoutAccountMoved]).toEqual([201, true]);
      const owner = ok.body.owner.userId as string;
      expect(await prisma.payoutAccount.findUnique({ where: { userId: a.id } })).toBeNull();
      const moved = await prisma.payoutAccount.findUniqueOrThrow({ where: { userId: owner } });
      expect([moved.verifiedAt, moved.verifiedBy, moved.accountLast4]).toEqual([null, null, '7890']);
      const reveal = await request.post(`/api/admin/partners/${owner}/payout-account/reveal`).set(admin());
      expect(reveal.body.data.accountNumber).toBe('50100234567890');
      expect(await prisma.adminAuditLog.count({ where: { action: 'PAYOUT_ACCOUNT_CHANGED', targetId: owner } })).toBe(1);
      // the new owner already has details -> a second move is refused and nothing is created
      const y = await ownerless();
      await prisma.user.update({ where: { id: b.id }, data: { accountStatus: 'SUSPENDED' } });
      await prisma.vendor.update({ where: { id: b.vendorId }, data: { userId: null } });
      await request.put(`/api/admin/partners/${b.id}/payout-account`).set(admin()).send(BANK);
      // a third login that is detached AND has details of its own cannot take b's details
      const c = W.vendors[2];
      await request.put(`/api/admin/partners/${c.id}/payout-account`).set(admin()).send(BANK);
      await post(c.vendorId, '/detach', { reason: 'Moving the owner' });
      const dup = await post(y, '', { existingUserId: c.id, takePayoutAccountFrom: b.id });
      expect([dup.status, dup.body.code]).toEqual([409, 'OWNER_HAS_PAYOUT_ACCOUNT']);
      expect((await vrow(y)).userId).toBeNull(); // rolled back as a whole
      expect((await urow(c.id)).accountStatus).toBe('SUSPENDED');
      const none = await post(y, '', { name: 'Ramesh Kumar', phone: newPhone(), takePayoutAccountFrom: c.id });
      expect(none.status).toBe(201); // c's details move to a brand-new owner instead
    });

    test('remove owner: the login is REMOVED (never signs in again, phone stays reserved, payout details kept), restaurant ownerless and closed; typed name = restaurant OR owner name; idempotence via NO_OWNER', async () => {
      const v = W.vendors[0];
      await request.put(`/api/admin/partners/${v.id}/payout-account`).set(admin()).send({ method: 'UPI', upiId: 'kitchen@upi' });
      const bad = await post(v.vendorId, '/remove', { reason: 'Left the business', confirmName: 'Nobody' });
      expect([bad.status, bad.body.code]).toEqual([400, 'CONFIRM_MISMATCH']);
      expect((await vrow(v.vendorId)).userId).toBe(v.id);
      const res = await post(v.vendorId, '/remove', { reason: 'Left the business', confirmName: v.name.toUpperCase() });
      expect([res.status, res.body.owner, res.body.detachedUser]).toEqual([200, null, { id: v.id, name: v.name }]);
      const u = await urow(v.id);
      expect(u).toMatchObject({ accountStatus: 'REMOVED', statusReason: 'Left the business' });
      expect(u.deletedAt).not.toBeNull();
      expect((await login(v.phone, PW)).body.code).toBe('ACCOUNT_REMOVED');
      expect((await vrow(v.vendorId))).toMatchObject({ userId: null, isAcceptingOrders: false });
      expect(await prisma.payoutAccount.count({ where: { userId: v.id } })).toBe(1);
      const reuse = await post(v.vendorId, '', { name: 'Ramesh Kumar', phone: v.phone });
      expect([reuse.status, reuse.body.code]).toEqual([409, 'PHONE_TAKEN']);
      expect((await post(v.vendorId, '/remove', { reason: 'Left the business', confirmName: v.name })).body.code).toBe('NO_OWNER');
      const fresh = await post(v.vendorId, '', { name: 'New Person', phone: newPhone(), password: 'BrandNewPass1' });
      expect(fresh.status).toBe(201);
      secrets.push('BrandNewPass1');
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'OWNER_REMOVED' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(W.admin.id);
    });
  });
});
