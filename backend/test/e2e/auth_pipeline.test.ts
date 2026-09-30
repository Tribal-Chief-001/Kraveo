/**
 * Login / account pipeline: phone OTP, lockouts, role gating, profile, logout, account deletion, demo mode.
 * Runs against a real PostgreSQL (see backend/prisma/README.md). Rate limits are switched on for this file.
 */
process.env.OTP_STRICT_LIMITS = 'true';

import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getAuthHeader } from '../harness/auth';
import * as sms from '../../src/services/smsService';
import { otpStore } from '../../src/routes/api';
import {
  __resetOtpState, canonicalPhone, checkCanSend, issueOtp, checkOtp,
  MAX_WRONG_GUESSES, LOCKOUT_MS, RESEND_COOLDOWN_MS,
} from '../../src/services/otpService';

describe('Auth pipeline (phone OTP -> account -> profile -> logout -> delete)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let spy: jest.SpyInstance;

  const login = async (phone: string, role?: string, extra: Record<string, unknown> = {}) => {
    const sent = await request.post('/api/auth/send-otp').send({ phone });
    expect(sent.status).toBe(200);
    const canon = canonicalPhone(phone)!;
    const code = otpStore.get(canon)!.otp;
    return request.post('/api/auth/verify-otp').send({ phone, otp: code, ...(role ? { role } : {}), ...extra });
  };

  const purgeAuthTestUsers = () =>
    prisma.user.deleteMany({ where: { OR: [{ phone: { startsWith: '+91 9000' } }, { phone: { startsWith: 'deleted:' } }] } });

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await purgeAuthTestUsers();
    await seedTestDatabase();
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  afterAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await purgeAuthTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    __resetOtpState();
    delete process.env.DEMO_MODE;
    delete process.env.DEMO_LOGIN_PHONES;
    delete process.env.DEMO_LOGIN_OTP;
    spy = jest.spyOn(sms, 'dispatchSmsOtp').mockResolvedValue({ success: true, provider: 'test' });
  });

  describe('phone normalisation', () => {
    test.each([
      ['9876543210', '+91 9876543210'],
      ['+91 98765 43210', '+91 9876543210'],
      ['09876543210', '+91 9876543210'],
      ['+919876543210', '+91 9876543210'],
    ])('%s -> %s', (raw, expected) => expect(canonicalPhone(raw)).toBe(expected));

    test.each(['12345', '1234567890', '5876543210', 'abcdefghij', '', null, undefined, 9876543210])('rejects %p', (raw) =>
      expect(canonicalPhone(raw as any)).toBeNull());

    test('API rejects an invalid number with 400', async () => {
      const res = await request.post('/api/auth/send-otp').send({ phone: '12345' });
      expect(res.status).toBe(400);
    });

    test('a seeded account stored as "+91 XXXXXXXXXX" is found from a bare 10-digit login', async () => {
      const res = await login('9876543210', 'STUDENT');
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('usr-1');
      expect(res.body.isNewUser).toBe(false);
    });
  });

  describe('sending codes', () => {
    test('30s cooldown between sends, then 429 with retryAfterSeconds', async () => {
      expect((await request.post('/api/auth/send-otp').send({ phone: '9000000001' })).status).toBe(200);
      const again = await request.post('/api/auth/send-otp').send({ phone: '9000000001' });
      expect(again.status).toBe(429);
      expect(again.body.retryAfterSeconds).toBeGreaterThan(0);
    });

    test('max 5 sends per hour per number (unit, explicit clock)', () => {
      const phone = canonicalPhone('9000000002')!;
      const t0 = 1_000_000;
      for (let i = 0; i < 5; i++) {
        expect(checkCanSend(phone, t0 + i * (RESEND_COOLDOWN_MS + 1)).ok).toBe(true);
        issueOtp(phone, undefined, t0 + i * (RESEND_COOLDOWN_MS + 1));
      }
      const blocked = checkCanSend(phone, t0 + 5 * (RESEND_COOLDOWN_MS + 1));
      expect(blocked.ok).toBe(false);
    });

    test('SMS provider failure -> 503, code is discarded and the send is not counted', async () => {
      spy.mockResolvedValue({ success: false, provider: 'test', error: 'boom' });
      const res = await request.post('/api/auth/send-otp').send({ phone: '9000000003' });
      expect(res.status).toBe(503);
      expect(otpStore.get(canonicalPhone('9000000003')!)).toBeUndefined();
      spy.mockResolvedValue({ success: true, provider: 'test' });
      expect((await request.post('/api/auth/send-otp').send({ phone: '9000000003' })).status).toBe(200);
    });
  });

  describe('brute force protection', () => {
    test('5 wrong guesses lock the number; a resend cannot reset the counter', async () => {
      const phone = '9000000004';
      const canon = canonicalPhone(phone)!;
      await request.post('/api/auth/send-otp').send({ phone });
      const real = otpStore.get(canon)!.otp;
      const wrong = real === '0000' ? '1111' : '0000';
      for (let i = 0; i < MAX_WRONG_GUESSES - 1; i++) {
        const r = await request.post('/api/auth/verify-otp').send({ phone, otp: wrong });
        expect(r.status).toBe(400);
        expect(r.body.attemptsLeft).toBe(MAX_WRONG_GUESSES - 1 - i);
      }
      const locked = await request.post('/api/auth/verify-otp').send({ phone, otp: wrong });
      expect(locked.status).toBe(429);
      // even the correct code no longer works, and a fresh code cannot be requested during the lockout
      expect(otpStore.get(canon)).toBeUndefined();
      expect((await request.post('/api/auth/send-otp').send({ phone })).status).toBe(429);
    });

    test('wrong-guess counter survives re-sending a code (unit, explicit clock)', () => {
      const phone = canonicalPhone('9000000005')!;
      const t0 = 5_000_000;
      issueOtp(phone, '4321', t0);
      for (let i = 0; i < 3; i++) expect(checkOtp(phone, '0000', t0 + i).ok).toBe(false);
      issueOtp(phone, '4321', t0 + 60_000); // "resend"
      const r1 = checkOtp(phone, '0000', t0 + 60_001);
      expect(r1.ok).toBe(false);
      expect((r1 as any).attemptsLeft).toBe(1); // 3 + 1 wrong so far -> one left, not four
      const r2 = checkOtp(phone, '0000', t0 + 60_002);
      expect((r2 as any).status).toBe(429);
      const still = checkOtp(phone, '4321', t0 + LOCKOUT_MS - 1);
      expect(still.ok).toBe(false);
    });

    test('expired code is rejected', () => {
      const phone = canonicalPhone('9000000006')!;
      issueOtp(phone, '4321', 1000);
      expect(checkOtp(phone, '4321', 1000 + 6 * 60 * 1000).ok).toBe(false);
    });
  });

  describe('role gating (was: any caller could register as ADMIN)', () => {
    test('a brand-new number asking for ADMIN / VENDOR / DRIVER is refused, no user row is created', async () => {
      for (const role of ['ADMIN', 'VENDOR', 'DRIVER']) {
        const phone = `90000100${role.length}${role === 'ADMIN' ? 1 : role === 'VENDOR' ? 2 : 3}`.slice(0, 10);
        await request.post('/api/auth/send-otp').send({ phone });
        const code = otpStore.get(canonicalPhone(phone)!)!.otp;
        const res = await request.post('/api/auth/verify-otp').send({ phone, otp: code, role });
        expect(res.status).toBe(403);
        expect(await prisma.user.findFirst({ where: { phone: { endsWith: phone } } })).toBeNull();
      }
    });

    test('an existing partner can sign in only as its own role', async () => {
      expect((await login('9876543212', 'VENDOR')).status).toBe(200);
      __resetOtpState();
      expect((await login('9876543212', 'STUDENT')).status).toBe(403);
      __resetOtpState();
      expect((await login('9876543213', 'DRIVER')).status).toBe(200);
    });

    test('an existing admin account cannot be entered through the phone flow', async () => {
      expect((await login('9876543214', 'STUDENT')).status).toBe(403);
      __resetOtpState();
      expect((await login('9876543214', 'ADMIN')).status).toBe(403);
    });
  });

  describe('account lifecycle', () => {
    const phone = '9000000010';
    let token: string;
    let userId: string;

    test('first login creates a STUDENT that still needs a profile', async () => {
      const res = await login(phone);
      expect(res.status).toBe(200);
      expect(res.body.isNewUser).toBe(true);
      expect(res.body.needsProfile).toBe(true);
      expect(res.body.user.role).toBe('STUDENT');
      expect(res.body.user.phone).toBe('+91 9000000010');
      expect(res.body.user.fcmToken).toBeUndefined(); // never leaked
      token = res.body.token;
      userId = res.body.user.id;
    });

    test('profile validation: bad name / bad hostel are rejected with the offending field', async () => {
      const badName = await request.put('/api/auth/profile').set(getAuthHeader(token)).send({ name: 'A' });
      expect(badName.status).toBe(400);
      expect(badName.body.field).toBe('name');
      const placeholder = await request.put('/api/auth/profile').set(getAuthHeader(token)).send({ name: 'VIT Student' });
      expect(placeholder.status).toBe(400);
      const badHostel = await request.put('/api/auth/profile').set(getAuthHeader(token)).send({ hostelBlock: 'Roof' });
      expect(badHostel.status).toBe(400);
      expect(badHostel.body.field).toBe('hostelBlock');
    });

    test('completing the profile clears needsProfile; role/coins/phone cannot be changed through it', async () => {
      const res = await request.put('/api/auth/profile').set(getAuthHeader(token))
        .send({ name: '  Aarav   Mehta ', hostelBlock: 'Block 3', role: 'ADMIN', kraveoCoins: 9999, phone: '+91 1111111111' });
      expect(res.status).toBe(200);
      expect(res.body.needsProfile).toBe(false);
      expect(res.body.user.name).toBe('Aarav Mehta');
      expect(res.body.user.hostelBlock).toBe('Block 3');
      const row = await prisma.user.findUnique({ where: { id: userId } });
      expect(row?.role).toBe('STUDENT');
      expect(row?.kraveoCoins).toBe(0);
      expect(row?.phone).toBe('+91 9000000010');
    });

    test('GET /auth/profile returns the public shape', async () => {
      const res = await request.get('/api/auth/profile').set(getAuthHeader(token));
      expect(res.status).toBe(200);
      expect(res.body.needsProfile).toBe(false);
      expect(Object.keys(res.body.user).sort()).toEqual(['createdAt', 'hostelBlock', 'id', 'kraveoCoins', 'name', 'phone', 'role', 'upiId']);
    });

    test('logout clears the push token', async () => {
      await request.put('/api/auth/profile').set(getAuthHeader(token)).send({ fcmToken: 'fcm-abc' });
      expect((await prisma.user.findUnique({ where: { id: userId } }))?.fcmToken).toBe('fcm-abc');
      const res = await request.post('/api/auth/logout').set(getAuthHeader(token));
      expect(res.status).toBe(200);
      expect((await prisma.user.findUnique({ where: { id: userId } }))?.fcmToken).toBeNull();
      expect((await request.post('/api/auth/logout')).status).toBe(401);
    });

    test('account deletion is blocked while an order is in progress, then anonymises the row', async () => {
      const vendor = await prisma.vendor.findFirstOrThrow();
      const order = await prisma.order.create({ data: { customerId: userId, vendorId: vendor.id, totalAmount: 100, dropoffHostel: 'Block 3', status: 'PREPARING', paymentStatus: 'PAID' } });
      const blocked = await request.delete('/api/auth/account').set(getAuthHeader(token));
      expect(blocked.status).toBe(409);

      await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
      const ok = await request.delete('/api/auth/account').set(getAuthHeader(token));
      expect(ok.status).toBe(200);
      const row = await prisma.user.findUnique({ where: { id: userId } });
      expect(row?.name).toBe('Deleted user');
      expect(row?.phone).toBe(`deleted:${userId}`);
      expect(await prisma.order.findUnique({ where: { id: order.id } })).not.toBeNull(); // history keeps its FK
    });

    test('the same number can sign up again afterwards as a fresh account', async () => {
      __resetOtpState();
      const res = await login(phone);
      expect(res.status).toBe(200);
      expect(res.body.isNewUser).toBe(true);
      expect(res.body.user.id).not.toBe(userId);
    });

    test('partners cannot use the student delete endpoint', async () => {
      const vendorLogin = await login('9876543212', 'VENDOR');
      const res = await request.delete('/api/auth/account').set(getAuthHeader(vendorLogin.body.token));
      expect(res.status).toBe(403);
    });
  });

  describe('demo mode (pilot demos without an SMS provider)', () => {
    test('off by default: a demo number gets a random code, not 1234', async () => {
      process.env.DEMO_LOGIN_PHONES = '9000000020';
      await request.post('/api/auth/send-otp').send({ phone: '9000000020' });
      const code = otpStore.get(canonicalPhone('9000000020')!)!.otp;
      expect(spy).toHaveBeenCalled(); // real SMS path used
      const guess = code === '1234' ? '4321' : '1234';
      expect((await request.post('/api/auth/verify-otp').send({ phone: '9000000020', otp: guess })).status).toBe(400);
    });

    test('DEMO_MODE=true: only allow-listed numbers get the fixed code and no SMS is sent', async () => {
      process.env.DEMO_MODE = 'true';
      process.env.DEMO_LOGIN_PHONES = '9000000021, 9000000022';
      process.env.DEMO_LOGIN_OTP = '2468';
      const send = await request.post('/api/auth/send-otp').send({ phone: '9000000021' });
      expect(send.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      const ok = await request.post('/api/auth/verify-otp').send({ phone: '9000000021', otp: '2468' });
      expect(ok.status).toBe(200);

      // a number that is NOT on the list is unaffected
      await request.post('/api/auth/send-otp').send({ phone: '9000000023' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await request.post('/api/auth/verify-otp').send({ phone: '9000000023', otp: '2468' })).status).toBe(400);
    });
  });
});
