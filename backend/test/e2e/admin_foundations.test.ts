/**
 * Admin user management, B0 foundations (Docs/27 B0, Docs/28): the audit actor, the account guard on EVERY way in (Google, partner login,
 * a token, a socket, push), revokeUserEverywhere, the checkout guards (suspended customer, ownerless / removed restaurant), the open-toggle
 * rule NO_OWNER, rate limit and the ADMIN-only rule of every new endpoint. Real PostgreSQL, real HTTP and sockets.
 */
import supertest from 'supertest';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { generateTestToken } from '../harness/auth';
import { setGoogleVerifier } from '../../src/services/googleAuth';
import { hashPassword } from '../../src/services/password';
import { __resetLoginLimiter } from '../../src/services/loginLimiter';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { writeAudit } from '../../src/services/audit';
import { runWithActor } from '../../src/services/actorContext';
import { revokeUserEverywhere } from '../../src/services/accountControl';
import { activeTokensFor, registerDeviceToken } from '../../src/services/push/deviceTokens';
import { placeOrder } from '../../src/services/orderFlow';
import { placeGroup } from '../../src/services/orderGroups';
import { World, Watcher, createWorld, createApi, Api, purgeWorld, cartOf, reissue } from '../harness/journey';

jest.setTimeout(120_000);
const P = 'af';
const PW = 'Sup3rSecret!';

describe('Admin user management: foundations', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let request: ReturnType<typeof supertest>;
  const admin = () => ({ Authorization: `Bearer ${W.admin.token}` });
  const setStatus = (id: string, accountStatus: 'ACTIVE' | 'SUSPENDED' | 'REMOVED', statusReason: string | null = null) =>
    prisma.user.update({ where: { id }, data: { accountStatus, statusReason, ...(accountStatus === 'REMOVED' ? { deletedAt: new Date() } : { deletedAt: null }) } });

  beforeAll(async () => {
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    W = await createWorld(P, '6', { customers: 3, vendors: 2, riders: 2 });
    server = await startTestServer(0);
    request = supertest(server.app);
    api = createApi(server.baseUrl);
  });
  beforeEach(() => {
    __resetLoginLimiter();
    __resetRateLimits();
  });
  afterAll(async () => {
    setGoogleVerifier(null);
    await stopTestServer(server);
    await prisma.user.deleteMany({ where: { email: { endsWith: '@af.kraveo.test' } } });
    await purgeWorld(P);
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.$disconnect();
  });

  describe('audit actor (actorContext + writeAudit)', () => {
    test('a row written outside a request has no actor; inside runWithActor it carries the admin; the old 4-argument call still works', async () => {
      await writeAudit('T_SYSTEM', 'TEST', 'af-t1', 'maintenance job');
      await runWithActor({ id: W.admin.id, ip: '10.1.2.3' }, () => writeAudit('T_ACTOR', 'TEST', 'af-t2', 'by an admin'));
      const sys = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'T_SYSTEM' } });
      const act = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'T_ACTOR' } });
      expect([sys.actorId, sys.actorName, sys.ip, sys.meta]).toEqual([null, null, null, null]);
      expect([act.actorId, act.actorName, act.ip]).toEqual([W.admin.id, W.admin.name, '10.1.2.3']);
    });

    test('meta is stored without anything that looks like a secret, and summary is cut at 300 characters', async () => {
      await writeAudit('T_META', 'TEST', 'af-t3', 'x'.repeat(500), { meta: { before: { a: 1 }, password: 'hunter2hunter2', nested: { token: 'abc', passwordHash: 'scrypt$', ok: 'fine' } } });
      const row = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'T_META' } });
      expect(row.summary).toHaveLength(300);
      expect(JSON.stringify(row.meta)).not.toMatch(/hunter2|scrypt|abc/);
      expect(row.meta).toMatchObject({ before: { a: 1 }, nested: { ok: 'fine' } });
    });

    test('a real admin request writes the acting admin (id, name, ip) on its audit row; a customer-side action writes none', async () => {
      await prisma.adminAuditLog.deleteMany({ where: { action: 'VENDOR_LOCATION_SET' } });
      const res = await request.patch(`/api/admin/vendors/${W.vendors[0].vendorId}/location`).set(admin()).send({ lat: 23.0745, lng: 76.859 });
      expect(res.status).toBe(200);
      const row = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'VENDOR_LOCATION_SET' } });
      expect(row).toMatchObject({ actorId: W.admin.id, actorName: W.admin.name });
      expect(row.ip).toBeTruthy();
    });
  });

  describe('a blocked account has no session at all', () => {
    test('token of a SUSPENDED / REMOVED user -> 401 TOKEN_REVOKED with the reason and message; restored -> the same (unrevoked) token works', async () => {
      const c = W.customers[0];
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${c.token}` })).status).toBe(200);
      await setStatus(c.id, 'SUSPENDED', 'Fake orders');
      const s = await request.get('/api/auth/profile').set({ Authorization: `Bearer ${c.token}` });
      expect(s.status).toBe(401);
      expect(s.body).toMatchObject({ code: 'TOKEN_REVOKED', reason: 'ACCOUNT_SUSPENDED' });
      expect(s.body.message).toContain('Fake orders');
      await setStatus(c.id, 'REMOVED');
      const r = await request.get('/api/auth/profile').set({ Authorization: `Bearer ${c.token}` });
      expect([r.status, r.body.code, r.body.reason]).toEqual([401, 'TOKEN_REVOKED', 'ACCOUNT_REMOVED']);
      await setStatus(c.id, 'ACTIVE');
      expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${c.token}` })).status).toBe(200);
    });

    test('a ghost token (no such account) still gets the plain revoked answer, without a reason', async () => {
      const ghost = generateTestToken({ id: 'af-ghost', phone: '+91 9777699999', role: 'STUDENT' as any });
      const res = await request.get('/api/auth/profile').set({ Authorization: `Bearer ${ghost}` });
      expect([res.status, res.body.code, res.body.reason]).toEqual([401, 'TOKEN_REVOKED', undefined]);
    });

    test('sockets: a blocked account cannot connect, and revokeUserEverywhere closes a live socket', async () => {
      const c = W.customers[1];
      const live = await new Watcher(server.baseUrl, c).connect();
      expect(live.connected).toBe(true);
      await setStatus(c.id, 'SUSPENDED', 'x y z');
      await expect(new Watcher(server.baseUrl, c).connect()).rejects.toBeTruthy();
      await setStatus(c.id, 'ACTIVE');
      const again = await reissue(c);
      const w2 = await new Watcher(server.baseUrl, again).connect();
      expect(w2.connected).toBe(true);
      await revokeUserEverywhere(c.id, 'ACCOUNT_SUSPENDED');
      await new Promise((r) => setTimeout(r, 300));
      expect(w2.connected).toBe(false);
      live.disconnect();
      w2.disconnect();
    });

    test('a socket that connects while the account is being blocked never survives (handshake, sweep or re-check); a restored person can reconnect at once (no delayed kick)', async () => {
      const c = W.customers[0];
      const { accountMatchesToken } = await import('../../src/middleware/auth');
      // the handshake passed (account was ACTIVE), then the block landed before the join: simulate by blocking right after the connect call starts
      const connecting = new Watcher(server.baseUrl, c).connect().catch(() => null);
      await setStatus(c.id, 'SUSPENDED', 'racing');
      await revokeUserEverywhere(c.id, 'ACCOUNT_SUSPENDED');
      const w = await connecting;
      await new Promise((r) => setTimeout(r, 400));
      expect(w === null || !w.connected).toBe(true); // refused at the handshake, disconnected by the sweep, or closed by the re-check
      expect(await accountMatchesToken(c.id, 0)).toBe(false);
      await setStatus(c.id, 'ACTIVE');
      const again = await new Watcher(server.baseUrl, await reissue(c)).connect();
      await new Promise((r) => setTimeout(r, 3000)); // longer than any delayed sweep could be
      expect(again.connected).toBe(true);
      again.disconnect();
      await prisma.user.update({ where: { id: c.id }, data: { tokenVersion: 0 } }); // the other tests of this file use this customer's original token
    });

    test('revokeUserEverywhere: tokenVersion bumped, every push token off, fcmToken wiped; activeTokensFor also refuses a blocked user', async () => {
      const c = W.customers[2];
      await prisma.user.update({ where: { id: c.id }, data: { fcmToken: 'legacy-token-af' } });
      await registerDeviceToken({ userId: c.id, token: 'af-tok-1', app: 'CUSTOMER', platform: 'android', appVersion: '1' });
      await registerDeviceToken({ userId: c.id, token: 'af-tok-2', app: 'CUSTOMER', platform: 'android', appVersion: '1' });
      expect(await activeTokensFor(c.id, 'CUSTOMER')).toHaveLength(2);
      const before = (await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).tokenVersion;
      await revokeUserEverywhere(c.id, 'ACCOUNT_SUSPENDED');
      const after = await prisma.user.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.tokenVersion).toBe(before + 1);
      expect(after.fcmToken).toBeNull();
      const toks = await prisma.deviceToken.findMany({ where: { userId: c.id } });
      expect(toks.every((t) => t.disabledAt !== null && t.disabledReason === 'ACCOUNT_SUSPENDED')).toBe(true);
      // a token somehow left enabled is still not used for a blocked account
      await prisma.deviceToken.updateMany({ where: { userId: c.id }, data: { disabledAt: null, disabledReason: null } });
      await setStatus(c.id, 'SUSPENDED', 'because');
      expect(await activeTokensFor(c.id, 'CUSTOMER')).toEqual([]);
      await setStatus(c.id, 'ACTIVE');
      expect(await activeTokensFor(c.id, 'CUSTOMER')).toHaveLength(2);
      await prisma.deviceToken.deleteMany({ where: { userId: c.id } });
    });
  });

  describe('admin sign-in (passcode)', () => {
    test('a blocked admin row gets the plain 403 and no token; an active one signs in and lastLoginAt is recorded', async () => {
      const keep = process.env.ADMIN_PASSCODE;
      process.env.ADMIN_PASSCODE = 'af-passcode-123';
      const before = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true, accountStatus: true, statusReason: true } });
      try {
        await prisma.user.updateMany({ where: { role: 'ADMIN' }, data: { accountStatus: 'SUSPENDED', statusReason: 'Locked out' } });
        const blocked = await request.post('/api/auth/admin-login').send({ passcode: 'af-passcode-123' });
        expect([blocked.status, blocked.body.code, blocked.body.token]).toEqual([403, 'ACCOUNT_SUSPENDED', undefined]);
        await prisma.user.updateMany({ where: { role: 'ADMIN' }, data: { accountStatus: 'ACTIVE', statusReason: null } });
        const ok = await request.post('/api/auth/admin-login').send({ passcode: 'af-passcode-123' });
        expect(ok.status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: ok.body.admin.id } })).lastLoginAt).not.toBeNull();
      } finally {
        for (const a of before) await prisma.user.update({ where: { id: a.id }, data: { accountStatus: a.accountStatus, statusReason: a.statusReason } });
        if (keep === undefined) delete process.env.ADMIN_PASSCODE; else process.env.ADMIN_PASSCODE = keep;
      }
    });
  });

  describe('sign-in paths', () => {
    const identity = (n: string) => ({ sub: `sub-af-${n}`, email: `${n}@af.kraveo.test`, emailVerified: true, name: `AF Person ${n}` });
    const google = (n: string) => { setGoogleVerifier(async () => identity(n)); return request.post('/api/auth/google').send({ idToken: 'x'.repeat(30) }); };

    test('Google: new account works and records lastLoginAt; a REMOVED account answers 403 ACCOUNT_REMOVED (never a 500, never a second User row); SUSPENDED answers 403 with the reason', async () => {
      const first = await google('one');
      expect([first.status, first.body.isNewUser]).toEqual([200, true]);
      const u = await prisma.user.findUniqueOrThrow({ where: { email: 'one@af.kraveo.test' } });
      expect(u.lastLoginAt).not.toBeNull();
      const count = () => prisma.user.count({ where: { OR: [{ googleSub: 'sub-af-one' }, { email: 'one@af.kraveo.test' }] } });

      await prisma.user.update({ where: { id: u.id }, data: { accountStatus: 'REMOVED', deletedAt: new Date(), statusReason: 'abuse' } });
      const removed = await google('one');
      expect([removed.status, removed.body.code]).toEqual([403, 'ACCOUNT_REMOVED']);
      expect(removed.body.message).toContain('removed');
      expect(removed.body.token).toBeUndefined();
      expect(await count()).toBe(1);

      await prisma.user.update({ where: { id: u.id }, data: { accountStatus: 'SUSPENDED', deletedAt: null, statusReason: 'Fake orders' } });
      const sus = await google('one');
      expect([sus.status, sus.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      expect(sus.body.message).toContain('Fake orders');
      expect(sus.body.token).toBeUndefined();

      await prisma.user.update({ where: { id: u.id }, data: { accountStatus: 'ACTIVE', statusReason: null } });
      const back = await google('one');
      expect([back.status, back.body.isNewUser]).toEqual([200, false]);
      expect(await count()).toBe(1);
    });

    test('Google: matching only by e-mail (sub changed) of a removed account is also a plain 403, and a self-deleted account still gets a fresh account', async () => {
      const a = await google('two');
      const u = await prisma.user.findUniqueOrThrow({ where: { email: 'two@af.kraveo.test' } });
      expect(a.status).toBe(200);
      await prisma.user.update({ where: { id: u.id }, data: { accountStatus: 'REMOVED', deletedAt: new Date() } });
      const res = await google('two');
      expect([res.status, res.body.code]).toEqual([403, 'ACCOUNT_REMOVED']);
      // self-delete: anonymised, no email / sub, accountStatus ACTIVE -> never matches, a new account is created
      await prisma.user.update({ where: { id: u.id }, data: { accountStatus: 'ACTIVE', email: null, googleSub: null, name: 'Deleted user', deletedAt: new Date() } });
      const fresh = await google('two');
      expect([fresh.status, fresh.body.isNewUser]).toEqual([200, true]);
      expect(fresh.body.user.id).not.toBe(u.id);
    });

    test('partner login: a removed / suspended account with the RIGHT password -> 403 + code; a wrong password -> the same 401 as an unknown number; an active one works and records lastLoginAt', async () => {
      const owner = W.vendors[0];
      const rider = W.riders[0];
      await prisma.user.updateMany({ where: { id: { in: [owner.id, rider.id] } }, data: { passwordHash: await hashPassword(PW) } });
      const login = (u: { phone: string }, password: string, role: string) => request.post('/api/auth/partner-login').send({ phone: u.phone, password, role });

      const ok = await login(owner, PW, 'VENDOR');
      expect(ok.status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).lastLoginAt).not.toBeNull();

      await setStatus(rider.id, 'REMOVED', 'left the company');
      const removed = await login(rider, PW, 'DRIVER');
      expect([removed.status, removed.body.code]).toEqual([403, 'ACCOUNT_REMOVED']);
      expect(removed.body.token).toBeUndefined();
      const wrong = await login(rider, 'not-the-password', 'DRIVER');
      const unknown = await login({ phone: '+91 9777699998' }, 'not-the-password', 'DRIVER');
      expect([wrong.status, wrong.body.message]).toEqual([unknown.status, unknown.body.message]);
      expect(wrong.status).toBe(401);

      await setStatus(owner.id, 'SUSPENDED', 'Disabled by Kraveo');
      const sus = await login(owner, PW, 'VENDOR');
      expect([sus.status, sus.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      expect(sus.body.message).toContain('Disabled by Kraveo');
      await setStatus(owner.id, 'ACTIVE');
      await setStatus(rider.id, 'ACTIVE');
      expect((await login(owner, PW, 'VENDOR')).status).toBe(200);
      expect((await login(rider, PW, 'DRIVER')).status).toBe(200);
    });
  });

  describe('checkout guards', () => {
    test('placeOrder refuses a SUSPENDED customer with 403 ACCOUNT_SUSPENDED and a REMOVED one with 401 ACCOUNT_UNAVAILABLE (no order row is created)', async () => {
      const c = W.customers[0];
      const v = W.vendors[0];
      const input = { vendorId: v.vendorId, items: [{ itemId: v.items[0].id, quantity: 1 }], dropoffHostel: 'BH2', dropoffNotes: null, clientRequestId: 'af-cr-1' };
      await setStatus(c.id, 'SUSPENDED', 'because');
      await expect(placeOrder(c.id, input)).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_SUSPENDED' });
      await setStatus(c.id, 'REMOVED');
      await expect(placeOrder(c.id, input)).rejects.toMatchObject({ status: 401, code: 'ACCOUNT_UNAVAILABLE' });
      // the combined-order path has the same guards
      const groupInput = { restaurants: [cartOf(W.vendors[0]), cartOf(W.vendors[1])], dropoffHostel: 'BH2', dropoffNotes: null, clientRequestId: 'af-cr-g1' } as any;
      await setStatus(c.id, 'SUSPENDED', 'because');
      await expect(placeGroup(c.id, groupInput)).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_SUSPENDED' });
      await setStatus(c.id, 'REMOVED');
      await expect(placeGroup(c.id, groupInput)).rejects.toMatchObject({ status: 401, code: 'ACCOUNT_UNAVAILABLE' });
      await setStatus(c.id, 'ACTIVE');
      expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0);
      expect(await prisma.orderGroup.count({ where: { customerId: c.id } })).toBe(0);
    });

    describe('a restaurant without an owner login (Docs/28 decision 1)', () => {
      const ownerless = 'af-ven-ownerless';
      beforeAll(async () => {
        await prisma.vendor.create({ data: { id: ownerless, userId: null, name: 'AF Imported Kitchen', category: 'Test', address: 'Gate 9', bannerImage: '', isAcceptingOrders: true, approvalStatus: 'APPROVED' } });
        await prisma.menuItem.create({ data: { id: `${ownerless}-i1`, vendorId: ownerless, name: 'Imported Dish', price: 100, vendorPrice: 100, category: 'Test', description: 'd', imageUrl: '', isAvailable: true } });
      });

      test('it stays VISIBLE with its menu to customers but is shown closed, whatever isAcceptingOrders says', async () => {
        const list = await request.get('/api/vendors').set({ Authorization: `Bearer ${W.customers[0].token}` });
        const v = list.body.data.find((x: any) => x.id === ownerless);
        expect(v).toBeTruthy();
        expect(v.isAcceptingOrders).toBe(false);
        expect(v.menuItems.map((m: any) => m.name)).toContain('Imported Dish');
        expect(v.owner).toBeUndefined();
        expect(v.userId).toBeUndefined();
        const one = await request.get(`/api/vendors/${ownerless}`);
        expect(one.body.data.isAcceptingOrders).toBe(false);
        expect((await request.get(`/api/menus/${ownerless}`)).body.count).toBe(1);
        // the admin list shows the raw flag, the owner block (null) and no password fields
        const adminList = await request.get('/api/vendors').set(admin());
        const av = adminList.body.data.find((x: any) => x.id === ownerless);
        expect(av.owner).toBeNull();
        const withOwner = adminList.body.data.find((x: any) => x.id === W.vendors[0].vendorId);
        expect(withOwner.owner).toMatchObject({ id: W.vendors[0].id, name: W.vendors[0].name, accountStatus: 'ACTIVE' });
        expect(JSON.stringify(adminList.body)).not.toMatch(/passwordHash|tokenVersion|googleSub/);
      });

      test('single order, quote and combined order are refused with the plain message, nothing is created', async () => {
        const c = W.customers[0];
        const one = await api.raw('c', 'post', '/api/orders', c.token, { vendorId: ownerless, items: [{ itemId: `${ownerless}-i1`, quantity: 1 }], dropoffHostel: 'BH2', clientRequestId: 'af-cr-ownerless' });
        expect([one.status, one.body.code, one.body.message]).toEqual([400, 'VENDOR_CLOSED', 'This restaurant is not taking orders right now.']);
        const quote = await api.quote(c, [{ vendorId: ownerless, items: [{ itemId: `${ownerless}-i1`, quantity: 1 }] }]);
        expect([quote.status, quote.body.code]).toEqual([400, 'VENDOR_CLOSED']);
        const group = await api.placeGroup(c, [cartOf(W.vendors[0]), { vendorId: ownerless, items: [{ itemId: `${ownerless}-i1`, quantity: 1 }] }]);
        expect([group.status, group.body.code, group.body.vendorId]).toEqual([400, 'VENDOR_CLOSED', ownerless]);
        expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0);
        expect(await prisma.orderGroup.count({ where: { customerId: c.id } })).toBe(0);
      });

      test('the open toggle refuses to OPEN it (409 NO_OWNER, both routes), closing is always allowed, and a restaurant with an owner opens normally', async () => {
        const a = await request.patch(`/api/vendors/${ownerless}/status`).set(admin()).send({ isAcceptingOrders: true });
        expect([a.status, a.body.code, a.body.message]).toEqual([409, 'NO_OWNER', 'Add an owner login first.']);
        await prisma.vendor.update({ where: { id: ownerless }, data: { isAcceptingOrders: false } });
        const b = await request.patch(`/api/vendors/${ownerless}/toggle`).set(admin());
        expect([b.status, b.body.code]).toEqual([409, 'NO_OWNER']);
        expect((await prisma.vendor.findUniqueOrThrow({ where: { id: ownerless } })).isAcceptingOrders).toBe(false);
        await prisma.vendor.update({ where: { id: ownerless }, data: { isAcceptingOrders: true } });
        const close = await request.patch(`/api/vendors/${ownerless}/status`).set(admin()).send({ isAcceptingOrders: false });
        expect([close.status, close.body.isAcceptingOrders]).toEqual([200, false]);
        const v = W.vendors[0].vendorId;
        await prisma.vendor.update({ where: { id: v }, data: { isAcceptingOrders: false } });
        const open = await request.patch(`/api/vendors/${v}/status`).set(admin()).send({ isAcceptingOrders: true });
        expect([open.status, open.body.isAcceptingOrders]).toEqual([200, true]);
      });

      test('POST /vendors (admin, no owner) now creates the restaurant CLOSED', async () => {
        const res = await request.post('/api/vendors').set(admin()).send({ name: 'AF New Ownerless Kitchen' });
        expect(res.status).toBe(201);
        expect(res.body.data.isAcceptingOrders).toBe(false);
        await prisma.vendor.delete({ where: { id: res.body.data.id } });
      });
    });

    test('a REMOVED restaurant is hidden from customers, its owner and category lists, but visible to admins with includeRemoved; placeOrder refuses it', async () => {
      const v = W.vendors[1];
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { removedAt: new Date(), approvalStatus: 'SUSPENDED', isAcceptingOrders: false } });
      const asStudent = await request.get('/api/vendors').set({ Authorization: `Bearer ${W.customers[0].token}` });
      expect(asStudent.body.data.some((x: any) => x.id === v.vendorId)).toBe(false);
      const asOwner = await request.get('/api/vendors').set({ Authorization: `Bearer ${v.token}` });
      expect(asOwner.body.data.some((x: any) => x.id === v.vendorId)).toBe(false);
      expect((await request.get(`/api/vendors/${v.vendorId}`).set({ Authorization: `Bearer ${v.token}` })).status).toBe(404);
      expect((await request.get(`/api/menus/${v.vendorId}`).set({ Authorization: `Bearer ${v.token}` })).body.count).toBe(0);
      expect((await request.get('/api/vendors').set(admin())).body.data.some((x: any) => x.id === v.vendorId)).toBe(false);
      const inc = await request.get('/api/vendors?includeRemoved=1').set(admin());
      expect(inc.body.data.find((x: any) => x.id === v.vendorId)?.removedAt).toBeTruthy();
      expect((await request.get(`/api/vendors/${v.vendorId}`).set(admin())).status).toBe(200);
      const order = await api.place(W.customers[0], v);
      expect([order.status, order.body.code]).toEqual([400, 'VENDOR_UNAVAILABLE']);
      // a REMOVED restaurant cannot be opened by the toggle either
      const open = await request.patch(`/api/vendors/${v.vendorId}/status`).set(admin()).send({ isAcceptingOrders: true });
      expect([open.status, open.body.code]).toEqual([409, 'VENDOR_REMOVED']);
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { removedAt: null, approvalStatus: 'APPROVED', isAcceptingOrders: true } });
    });
  });

  describe('an admin can never be removed or paused through these endpoints', () => {
    test('customer / rider / owner routes treat an ADMIN row as "not found" or "not that kind of login", even when a restaurant or rider profile is wrongly linked to it', async () => {
      const a = W.admin.id;
      for (const verb of ['suspend', 'restore', 'remove'] as const) {
        const res = await request.post(`/api/admin/customers/${a}/${verb}`).set(admin()).send(verb === 'remove' ? { reason: 'abc def', confirmName: W.admin.name } : verb === 'suspend' ? { reason: 'abc def' } : {});
        expect([verb, res.status]).toEqual([verb, 404]);
      }
      // a mislinked restaurant owner and rider profile (a data error that must not turn into "remove the admin")
      const v = W.vendors[1];
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { userId: a } });
      for (const [path, body] of [['', undefined], ['/disable', { reason: 'abc def' }], ['/detach', { reason: 'abc def' }], ['/remove', { reason: 'abc def', confirmName: v.vendorId }], ['/reset-password', {}]] as [string, object | undefined][]) {
        const res = body ? await request.post(`/api/admin/vendors/${v.vendorId}/owner${path}`).set(admin()).send(body) : await request.patch(`/api/admin/vendors/${v.vendorId}/owner`).set(admin()).send({ name: 'Abc Def' });
        expect([path, res.status, res.body.code]).toEqual([path, 409, 'NOT_A_VENDOR_USER']);
      }
      await prisma.vendor.update({ where: { id: v.vendorId }, data: { userId: v.id } });
      const r = W.riders[1];
      await prisma.driverPartner.update({ where: { id: r.profileId }, data: { userId: a } });
      const rm = await request.post(`/api/admin/drivers/${r.profileId}/remove`).set(admin()).send({ reason: 'abc def', confirmName: r.name });
      expect([rm.status, rm.body.code]).toEqual([409, 'NOT_A_RIDER_USER']);
      await prisma.driverPartner.update({ where: { id: r.profileId }, data: { userId: r.id } });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ accountStatus: 'ACTIVE', deletedAt: null, tokenVersion: 0 });
      expect((await request.get('/api/auth/profile').set(admin())).status).toBe(200);
    });
  });

  describe('every new admin endpoint is ADMIN only and rate limited', () => {
    const vid = () => W.vendors[0].vendorId;
    const endpoints = (): [string, string, object][] => [
      ['post', `/api/admin/customers/${W.customers[0].id}/suspend`, { reason: 'abc def' }],
      ['post', `/api/admin/customers/${W.customers[0].id}/restore`, {}],
      ['post', `/api/admin/customers/${W.customers[0].id}/remove`, { reason: 'abc def', confirmName: 'x' }],
      ['post', `/api/admin/drivers/${W.riders[0].profileId}/remove`, { reason: 'abc def', confirmName: 'x' }],
      ['post', `/api/admin/drivers/${W.riders[0].profileId}/restore`, {}],
      ['get', `/api/admin/drivers/${W.riders[0].profileId}/impact`, {}],
      ['post', `/api/admin/vendors/${vid()}/suspend`, { reason: 'abc def' }],
      ['post', `/api/admin/vendors/${vid()}/reinstate`, {}],
      ['post', `/api/admin/vendors/${vid()}/remove`, { reason: 'abc def', confirmName: 'x' }],
      ['post', `/api/admin/vendors/${vid()}/restore`, {}],
      ['get', `/api/admin/vendors/${vid()}/impact`, {}],
      ['get', `/api/admin/vendors/${vid()}/owner`, {}],
      ['post', `/api/admin/vendors/${vid()}/owner`, { name: 'Abc Def', phone: '9876543299' }],
      ['patch', `/api/admin/vendors/${vid()}/owner`, { name: 'Abc Def' }],
      ['post', `/api/admin/vendors/${vid()}/owner/reset-password`, {}],
      ['post', `/api/admin/vendors/${vid()}/owner/disable`, { reason: 'abc def' }],
      ['post', `/api/admin/vendors/${vid()}/owner/enable`, {}],
      ['post', `/api/admin/vendors/${vid()}/owner/detach`, { reason: 'abc def' }],
      ['post', `/api/admin/vendors/${vid()}/owner/remove`, { reason: 'abc def', confirmName: 'x' }],
      ['get', '/api/admin/audit-log', {}],
      ['get', '/api/admin/audit-log/actions', {}],
      ['get', '/api/admin/audit-log/export.csv', {}],
    ];
    test('anonymous -> 401; customer, restaurant owner and rider -> 403; nothing is changed by them', async () => {
      const before = await prisma.user.findMany({ where: { id: { startsWith: `${P}-` } }, select: { id: true, accountStatus: true, tokenVersion: true, phone: true } });
      for (const [method, url, body] of endpoints()) {
        const anon = await (request as any)[method](url).send(body);
        expect([method, url, anon.status]).toEqual([method, url, 401]);
        for (const who of [W.customers[0], W.vendors[0], W.riders[0]]) {
          const res = await (request as any)[method](url).set({ Authorization: `Bearer ${who.token}` }).send(body);
          expect([method, url, who.role, res.status]).toEqual([method, url, who.role, 403]);
        }
      }
      const after = await prisma.user.findMany({ where: { id: { startsWith: `${P}-` } }, select: { id: true, accountStatus: true, tokenVersion: true, phone: true } });
      expect(after).toEqual(before);
    });

    test('ADMIN_ACCOUNT_WRITE: the limit is per admin and answers 429 RATE_LIMITED; reads are not limited', async () => {
      const keep = { max: process.env.RL_ADMIN_ACCOUNT_WRITE_MAX };
      process.env.RL_ADMIN_ACCOUNT_WRITE_MAX = '3';
      try {
        __resetRateLimits();
        const codes: number[] = [];
        for (let i = 0; i < 5; i++) codes.push((await request.post(`/api/admin/customers/${W.customers[0].id}/restore`).set(admin()).send({})).status);
        expect(codes).toEqual([200, 200, 200, 429, 429]);
        const limited = await request.post(`/api/admin/customers/${W.customers[0].id}/restore`).set(admin()).send({});
        expect(limited.body.code).toBe('RATE_LIMITED');
        expect((await request.get('/api/admin/audit-log').set(admin())).status).toBe(200);
      } finally {
        if (keep.max === undefined) delete process.env.RL_ADMIN_ACCOUNT_WRITE_MAX; else process.env.RL_ADMIN_ACCOUNT_WRITE_MAX = keep.max;
        __resetRateLimits();
      }
    });
  });
});
