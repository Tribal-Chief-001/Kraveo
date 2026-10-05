/**
 * Campus drop points, maps and live rider tracking (Docs/19_campus_maps_contract.md sections 1 and 2):
 * normalisation table, order create / replay, profile update, OrderView dropoff + vendor.hasLocation, GET /api/campus,
 * the data migration SQL against the test database, the admin vendor location endpoint, rider locations, and who
 * gets to see a rider's position. Real PostgreSQL, real socket.io clients.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Socket } from 'socket.io-client';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { connectTestSocket, disconnectTestSocket } from '../harness/socket';
import {
  DROP_POINTS, CAMPUS_CENTER, normalizeDropPoint, dropPointCoords, isNearCampus, vendorHasLocation, distanceKm, checkVendorLocation,
} from '../../src/config/campus';

jest.setTimeout(30_000);

const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const CAMPUS_STUDENT = { id: 'usr-campus-stu', phone: '+91 9999877001' };
const VENDOR = { id: 'usr-3', phone: '+91 9876543212' };
const RIDER = { id: 'usr-4', phone: '+91 9876543213' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tCampusStudent = getStudentToken(CAMPUS_STUDENT.id, CAMPUS_STUDENT.phone);
const tVendor = getVendorToken(VENDOR.id, VENDOR.phone);
const tRider = getDriverToken(RIDER.id, RIDER.phone);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const H = getAuthHeader;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CANON = ['BH1', 'BH2', 'BH3', 'BH4', 'BH5', 'Special Block', 'BH6', 'BH7', 'BH8', 'GH1', 'GH2'];

// ---------------------------------------------------------------------------------------------------------------
describe('campus.ts (pure)', () => {
  test('the drop point list is exactly the contract table, in order', () => {
    expect(DROP_POINTS.map((p) => p.name)).toEqual(CANON);
    expect(DROP_POINTS.every((p) => p.id === p.name)).toBe(true);
    expect(DROP_POINTS.filter((p) => p.group === 'girls').map((p) => p.name)).toEqual(['GH1', 'GH2']);
    expect(DROP_POINTS.filter((p) => p.group === 'boys')).toHaveLength(9);
    expect(dropPointCoords('BH1')).toEqual({ lat: 23.074861, lng: 76.859889 });
    expect(dropPointCoords('BH4')).toEqual(dropPointCoords('Special Block'));
    expect(dropPointCoords('GH2')).toEqual({ lat: 23.074917, lng: 76.853194 });
    expect(dropPointCoords('VIT Main Gate')).toBeNull();
  });

  test('campus centre is the mean of the 7 distinct pins', () => {
    const pins = [[23.074861, 76.859889], [23.073556, 76.859861], [23.073361, 76.858389], [23.07275, 76.86], [23.072889, 76.859222], [23.074778, 76.851972], [23.074917, 76.853194]];
    expect(CAMPUS_CENTER.lat).toBeCloseTo(pins.reduce((s, p) => s + p[0], 0) / 7, 9);
    expect(CAMPUS_CENTER.lng).toBeCloseTo(pins.reduce((s, p) => s + p[1], 0) / 7, 9);
  });

  const accepted: [unknown, string][] = [
    // canonical
    ...CANON.map((n) => [n, n] as [unknown, string]),
    ['bh2', 'BH2'], ['Bh8', 'BH8'], ['gh1', 'GH1'], ['special block', 'Special Block'], ['SPECIAL   BLOCK', 'Special Block'], ['  BH5  ', 'BH5'],
    // legacy short
    ['Block 1', 'BH1'], ['Block 2', 'BH2'], ['Block 3', 'BH3'], ['Block 4', 'BH4'], ['Block 5', 'BH5'], ['Block 6', 'BH6'],
    ['block 3', 'BH3'], ['BLOCK 3', 'BH3'], ['  Block   3 ', 'BH3'], ['Block\t3', 'BH3'],
    // legacy long
    ['Boys Hostel Block 1', 'BH1'], ['Boys Hostel Block 6', 'BH6'], ['boys hostel block 4', 'BH4'], ['  Boys   Hostel  Block  2 ', 'BH2'],
    // girls
    ['Girls Gate 1', 'GH1'], ['Girls Gate 2', 'GH2'], ['girls gate 2', 'GH2'], ['GIRLS GATE 1', 'GH1'],
    ['Girls Hostel Gate 1', 'GH1'], ['Girls Hostel Gate 2', 'GH2'], ['girls   hostel gate 2', 'GH2'],
  ];
  test.each(accepted)('accepts %j -> %j', (raw, canonical) => {
    expect(normalizeDropPoint(raw)).toBe(canonical);
    expect(normalizeDropPoint(canonical)).toBe(canonical); // idempotent
  });

  const rejected: unknown[] = [
    'VIT Main Gate', 'vit main gate', 'Block 0', 'Block 7', 'Block 12', 'Boys Hostel Block 7', 'Girls Gate 0', 'Girls Gate 3', 'Girls Hostel Gate 3',
    'BH0', 'BH9', 'BH10', 'GH0', 'GH3', 'BH 2', 'Block', 'Block2', 'Special', 'Main Gate', '', '   ', 'Library', 'Block 1; DROP TABLE', 'Block 1\nBlock 2',
    'x'.repeat(500), null, undefined, 2, true, {}, ['BH1'],
  ];
  test.each(rejected.map((r) => [typeof r === 'string' ? r.slice(0, 30) : r, r]))('rejects %j', (_label, raw) => {
    expect(normalizeDropPoint(raw)).toBeNull();
    expect(dropPointCoords(raw)).toBeNull();
  });

  test('isNearCampus: 3 km around the centre, only real numbers', () => {
    expect(isNearCampus(23.0745, 76.859)).toBe(true);
    expect(isNearCampus(CAMPUS_CENTER.lat, CAMPUS_CENTER.lng)).toBe(true);
    for (const p of DROP_POINTS) expect(isNearCampus(p.lat, p.lng)).toBe(true);
    expect(isNearCampus(23.0768, 76.8524)).toBe(true); // the old placeholder pin is on campus (it is just not "real")
    expect(isNearCampus(23.2599, 77.4126)).toBe(false); // Bhopal city
    expect(isNearCampus(28.6139, 77.209)).toBe(false); // Delhi
    expect(isNearCampus(0, 0)).toBe(false);
    // ~2.9 km north is in, ~3.1 km north is out (1 deg lat ~ 111.19 km)
    expect(isNearCampus(CAMPUS_CENTER.lat + 2.9 / 111.19, CAMPUS_CENTER.lng)).toBe(true);
    expect(isNearCampus(CAMPUS_CENTER.lat + 3.1 / 111.19, CAMPUS_CENTER.lng)).toBe(false);
    expect(distanceKm(CAMPUS_CENTER, { lat: CAMPUS_CENTER.lat + 1 / 111.19, lng: CAMPUS_CENTER.lng })).toBeCloseTo(1, 1);
    for (const bad of [NaN, Infinity, '23.07', null, undefined, 91, -91]) expect(isNearCampus(bad, 76.859)).toBe(false);
    expect(isNearCampus(23.07, 181)).toBe(false);
  });

  test('vendorHasLocation: the schema placeholder and non-numbers are not a real pin', () => {
    expect(vendorHasLocation(23.0768, 76.8524)).toBe(false);
    expect(vendorHasLocation(0, 0)).toBe(false);
    expect(vendorHasLocation(NaN, 76.85)).toBe(false);
    expect(vendorHasLocation(null, null)).toBe(false);
    expect(vendorHasLocation(23.0785, 76.855)).toBe(true);
    expect(vendorHasLocation(23.0768, 76.8525)).toBe(true);
  });

  test('checkVendorLocation reports the failing field', () => {
    expect(checkVendorLocation(23.0745, 76.859)).toEqual({ ok: true, lat: 23.0745, lng: 76.859 });
    expect(checkVendorLocation('23.07', 76.85)).toMatchObject({ ok: false, field: 'lat' });
    expect(checkVendorLocation(91, 76.85)).toMatchObject({ ok: false, field: 'lat' });
    expect(checkVendorLocation(23.07, 'x')).toMatchObject({ ok: false, field: 'lng' });
    expect(checkVendorLocation(23.07, 181)).toMatchObject({ ok: false, field: 'lng' });
    expect(checkVendorLocation(28.61, 77.2)).toMatchObject({ ok: false, field: 'location' });
    expect(checkVendorLocation(undefined, undefined)).toMatchObject({ ok: false, field: 'lat' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Campus maps API', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  const sockets: Socket[] = [];
  const connect = async (token: string) => {
    const s = await connectTestSocket(server.baseUrl, { auth: { token } });
    sockets.push(s);
    return s;
  };

  const place = (extra: Record<string, unknown> = {}, token = tStudent) =>
    request.post('/api/orders').set(H(token)).send({ vendorId: 'ven-1', items: [{ itemId: 'item-1', quantity: 1 }], clientRequestId: randomUUID(), ...extra });
  const setPin = (lat: number, lng: number) => prisma.vendor.update({ where: { id: 'ven-1' }, data: { lat, lng } });
  const PLACEHOLDER = { lat: 23.0768, lng: 76.8524 };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.user.update({ where: { id: STUDENT.id }, data: { hostelBlock: 'Boys Hostel Block 3', isStudent: true } });
    await prisma.user.upsert({
      where: { id: CAMPUS_STUDENT.id },
      update: { hostelBlock: 'Block 5', isStudent: true },
      create: { id: CAMPUS_STUDENT.id, name: 'Meera Campus', phone: CAMPUS_STUDENT.phone, role: Role.STUDENT, isStudent: true, avatarId: 3, hostelBlock: 'Block 5' },
    });
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    await prisma.order.updateMany({ where: { status: 'PLACED', paymentStatus: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await setPin(PLACEHOLDER.lat, PLACEHOLDER.lng);
    await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' } });
  });

  afterEach(() => {
    while (sockets.length) disconnectTestSocket(sockets.pop()!);
  });

  afterAll(async () => {
    await setPin(PLACEHOLDER.lat, PLACEHOLDER.lng);
    await prisma.user.update({ where: { id: STUDENT.id }, data: { hostelBlock: 'Boys Hostel Block 3' } });
    await stopTestServer(server);
  });

  // ------------------------------------------------------------------------------------------ GET /api/campus
  describe('GET /api/campus', () => {
    test('needs a login', async () => {
      expect((await request.get('/api/campus')).status).toBe(401);
    });

    test.each([['student', tStudent], ['vendor', tVendor], ['rider', tRider], ['admin', tAdmin]])('%s gets the 11 drop points and the centre', async (_r, token) => {
      const res = await request.get('/api/campus').set(H(token));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.headers['cache-control']).toMatch(/max-age=300/);
      expect(res.body.data.center).toEqual({ lat: CAMPUS_CENTER.lat, lng: CAMPUS_CENTER.lng });
      expect(res.body.data.dropPoints).toHaveLength(11);
      expect(res.body.data.dropPoints.map((p: any) => p.name)).toEqual(CANON);
      expect(res.body.data.dropPoints[0]).toEqual({ id: 'BH1', name: 'BH1', group: 'boys', lat: 23.074861, lng: 76.859889 });
      expect(res.body.data.dropPoints[10]).toEqual({ id: 'GH2', name: 'GH2', group: 'girls', lat: 23.074917, lng: 76.853194 });
    });
  });

  // ------------------------------------------------------------------------------------------ order create
  describe('order creation stores the canonical drop point', () => {
    test.each([
      ['Block 2', 'BH2'], ['Boys Hostel Block 6', 'BH6'], ['  block   4 ', 'BH4'], ['Girls Gate 1', 'GH1'], ['Girls Hostel Gate 2', 'GH2'],
      ['BH7', 'BH7'], ['Special Block', 'Special Block'], ['gh2', 'GH2'],
    ])('%j is saved as %j', async (input, canonical) => {
      const res = await place({ dropoffHostel: input });
      expect(res.status).toBe(201);
      expect(res.body.data.dropoffHostel).toBe(canonical);
      expect(res.body.data.dropoff).toEqual({ name: canonical, ...dropPointCoords(canonical)! });
      const row = await prisma.order.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(row.dropoffHostel).toBe(canonical);
    });

    test.each(['VIT Main Gate', 'Block 7', 'Girls Gate 3', 'Library', '', 'BH9'])('%j is refused with the same message and field as before', async (input) => {
      const res = await place({ dropoffHostel: input });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('dropoffHostel');
      expect(res.body.message).toBe('Choose one of the campus drop points.');
    });

    test('a non-string drop point is refused', async () => {
      for (const v of [5, {}, ['BH1'], true]) expect((await place({ dropoffHostel: v })).status).toBe(400);
    });

    test('no drop point in the request falls back to the profile one (legacy text normalised)', async () => {
      const res = await place({}); // usr-1 profile: "Boys Hostel Block 3"
      expect(res.status).toBe(201);
      expect(res.body.data.dropoffHostel).toBe('BH3');
      const r2 = await place({}, tCampusStudent); // "Block 5"
      expect(r2.body.data.dropoffHostel).toBe('BH5');
    });

    test('a profile without a usable drop point cannot order without choosing one', async () => {
      await prisma.user.update({ where: { id: CAMPUS_STUDENT.id }, data: { hostelBlock: 'VIT Main Gate' } });
      try {
        const res = await place({}, tCampusStudent);
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('dropoffHostel');
      } finally {
        await prisma.user.update({ where: { id: CAMPUS_STUDENT.id }, data: { hostelBlock: 'Block 5' } });
      }
    });

    test('idempotent replay compares canonical names (legacy and canonical are the same place)', async () => {
      const clientRequestId = randomUUID();
      const first = await place({ dropoffHostel: 'Block 2', clientRequestId });
      expect(first.status).toBe(201);
      const again = await place({ dropoffHostel: 'BH2', clientRequestId });
      expect(again.status).toBe(200);
      expect(again.body.idempotentReplay).toBe(true);
      expect(again.body.data.id).toBe(first.body.data.id);
      const third = await place({ dropoffHostel: 'Boys Hostel Block 2', clientRequestId });
      expect(third.status).toBe(200);
      expect(third.body.data.id).toBe(first.body.data.id);
    });

    test('replay of an order stored before the migration (legacy text in the row) still matches', async () => {
      const clientRequestId = randomUUID();
      const first = await place({ dropoffHostel: 'BH2', clientRequestId });
      await prisma.order.update({ where: { id: first.body.data.id }, data: { dropoffHostel: 'Block 2' } });
      const again = await place({ dropoffHostel: 'BH2', clientRequestId });
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(first.body.data.id);
      const legacy = await place({ dropoffHostel: 'Block 2', clientRequestId });
      expect(legacy.status).toBe(200);
      expect(legacy.body.data.id).toBe(first.body.data.id);
    });

    test('the same request id with a DIFFERENT drop point is still a mismatch', async () => {
      const clientRequestId = randomUUID();
      expect((await place({ dropoffHostel: 'Block 2', clientRequestId })).status).toBe(201);
      const other = await place({ dropoffHostel: 'BH3', clientRequestId });
      expect(other.status).toBe(409);
      expect(other.body.code).toBe('CLIENT_REQUEST_MISMATCH');
      // BH2 and BH3 share a pin, but they are different names: still different requests.
    });
  });

  // ------------------------------------------------------------------------------------------ profile
  describe('profile update stores the canonical drop point', () => {
    const put = (body: object, token = tCampusStudent) => request.put('/api/auth/profile').set(H(token)).send(body);
    afterEach(async () => { await prisma.user.update({ where: { id: CAMPUS_STUDENT.id }, data: { hostelBlock: 'Block 5', isStudent: true } }); });

    test.each([['Block 3', 'BH3'], ['Boys Hostel Block 1', 'BH1'], ['Girls Gate 2', 'GH2'], ['Girls Hostel Gate 1', 'GH1'], [' special   block ', 'Special Block'], ['BH8', 'BH8']])('%j -> %j', async (input, canonical) => {
      const res = await put({ hostelBlock: input });
      expect(res.status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: CAMPUS_STUDENT.id } })).hostelBlock).toBe(canonical);
    });

    test.each(['VIT Main Gate', 'Block 9', 'Nowhere', ''])('%j is refused (field hostelBlock)', async (input) => {
      const res = await put({ hostelBlock: input });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('hostelBlock');
      expect(res.body.message).toBe('Choose one of the campus drop points.');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: CAMPUS_STUDENT.id } })).hostelBlock).toBe('Block 5'); // untouched
    });

    test('a non-student cannot set one (unchanged rule)', async () => {
      const res = await put({ isStudent: false, hostelBlock: 'BH1' });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('hostelBlock');
    });
  });

  // ------------------------------------------------------------------------------------------ OrderView
  describe('OrderView: dropoff and vendor.hasLocation', () => {
    test('every viewer sees dropoff exactly where they see dropoffHostel; hasLocation follows the vendor pin', async () => {
      const placed = await place({ dropoffHostel: 'Girls Gate 1' });
      const id = placed.body.data.id as string;
      const want = { name: 'GH1', lat: 23.074778, lng: 76.851972 };
      expect(placed.body.data.dropoff).toEqual(want);
      expect(placed.body.data.vendor.hasLocation).toBe(false); // placeholder pin
      expect(placed.body.data.vendor.lat).toBe(PLACEHOLDER.lat);

      // pay it so the vendor and the rider pool can see it (direct DB, the payment flow has its own tests)
      await prisma.order.update({ where: { id }, data: { paymentStatus: 'PAID', paidAt: new Date(), status: 'ACCEPTED' } });
      const asAdmin = await request.get(`/api/orders/${id}`).set(H(tAdmin));
      const asVendor = await request.get(`/api/orders/${id}`).set(H(tVendor));
      const asPoolRider = await request.get(`/api/orders/${id}`).set(H(tRider));
      for (const r of [asAdmin, asVendor, asPoolRider]) {
        expect(r.status).toBe(200);
        expect(r.body.data.dropoff).toEqual(want);
        expect(r.body.data.dropoffHostel).toBe('GH1');
        expect(r.body.data.vendor.hasLocation).toBe(false);
      }
      expect(asAdmin.body.data.vendor).toHaveProperty('hasLocation', false);

      await setPin(23.0745, 76.859);
      for (const t of [tStudent, tAdmin, tVendor, tRider]) {
        const r = await request.get(`/api/orders/${id}`).set(H(t));
        expect(r.body.data.vendor).toMatchObject({ lat: 23.0745, lng: 76.859, hasLocation: true });
      }
      // the list endpoint uses the same view
      const list = await request.get('/api/orders').set(H(tStudent));
      const row = list.body.data.find((o: any) => o.id === id);
      expect(row.dropoff).toEqual(want);
      expect(row.vendor.hasLocation).toBe(true);
    });

    test('a stored value that cannot be normalised gives dropoff null (and the text is still shown)', async () => {
      const placed = await place({ dropoffHostel: 'BH1' });
      const id = placed.body.data.id as string;
      await prisma.order.update({ where: { id }, data: { dropoffHostel: 'VIT Main Gate' } });
      const r = await request.get(`/api/orders/${id}`).set(H(tStudent));
      expect(r.status).toBe(200);
      expect(r.body.data.dropoffHostel).toBe('VIT Main Gate');
      expect(r.body.data.dropoff).toBeNull();
    });

    test('a legacy stored value is normalised in dropoff (not rewritten in dropoffHostel)', async () => {
      const placed = await place({ dropoffHostel: 'BH6' });
      const id = placed.body.data.id as string;
      await prisma.order.update({ where: { id }, data: { dropoffHostel: 'Block 6' } });
      const r = await request.get(`/api/orders/${id}`).set(H(tStudent));
      expect(r.body.data.dropoffHostel).toBe('Block 6');
      expect(r.body.data.dropoff).toEqual({ name: 'BH6', lat: 23.07275, lng: 76.86 });
    });

    test('another customer still cannot see the order', async () => {
      const placed = await place({ dropoffHostel: 'BH1' });
      expect((await request.get(`/api/orders/${placed.body.data.id}`).set(H(tCampusStudent))).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------ migration
  describe('migration 20261006_campus_dropoints', () => {
    const file = path.resolve(__dirname, '../../prisma/migrations/20261006_campus_dropoints/migration.sql');
    const sql = fs.readFileSync(file, 'utf8');
    const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);

    test('is data-only, short and uses a lock timeout', () => {
      expect(statements[0]).toBe('BEGIN');
      expect(statements[statements.length - 1]).toBe('COMMIT');
      expect(sql).toMatch(/SET LOCAL lock_timeout/);
      expect(statements.join(";")).not.toMatch(/\b(ALTER|DROP|CREATE|TRUNCATE|DELETE|INSERT)\b/i);
      expect(statements.filter((s) => s.startsWith('UPDATE'))).toHaveLength(2);
    });

    test('rewrites legacy rows, leaves everything else (and updatedAt) alone, and can run twice', async () => {
      const marker = 'campus-mig-';
      const legacyUsers: [string, string | null, string | null][] = [
        ['a1', 'Block 3', 'BH3'], ['a2', 'Boys Hostel Block 1', 'BH1'], ['a3', 'Girls Gate 2', 'GH2'], ['a4', 'Girls Hostel Gate 1', 'GH1'],
        ['a5', 'VIT Main Gate', 'VIT Main Gate'], ['a6', 'BH5', 'BH5'], ['a7', '  boys   HOSTEL block  6 ', 'BH6'], ['a8', 'Block 7', 'Block 7'],
        ['a9', null, null], ['b1', 'Special Block', 'Special Block'], ['b2', 'Girls Gate 3', 'Girls Gate 3'], ['b3', 'GIRLS gate 1', 'GH1'],
        ['b4', 'Block 12', 'Block 12'], ['b5', 'block 2', 'BH2'], ['b6', 'Unknown', 'Unknown'],
      ];
      const old = new Date('2026-01-01T00:00:00Z');
      await prisma.user.createMany({ data: legacyUsers.map(([k, hb], i) => ({ id: marker + k, name: `Mig ${k}`, phone: `+91 99998${String(80000 + i)}`, role: Role.STUDENT, hostelBlock: hb })) });
      const orderRows = legacyUsers.filter(([, hb]) => hb !== null);
      await prisma.order.createMany({
        data: orderRows.map(([k, hb]) => ({ id: marker + 'o-' + k, customerId: STUDENT.id, vendorId: 'ven-1', dropoffHostel: hb as string, totalAmount: 100, status: 'CANCELLED' as const, createdAt: old, updatedAt: old })),
      });
      try {
        const run = () => prisma.$transaction(statements.filter((s) => s.startsWith('UPDATE')).map((s) => prisma.$executeRawUnsafe(s)));
        const [u1, o1] = await run();
        expect(u1).toBeGreaterThanOrEqual(9); // the 9 legacy users above (other rows in this DB may match too)
        expect(o1).toBeGreaterThanOrEqual(9);
        for (const [k, , want] of legacyUsers) {
          const u = await prisma.user.findUniqueOrThrow({ where: { id: marker + k } });
          expect([k, u.hostelBlock]).toEqual([k, want]);
        }
        for (const [k, , want] of orderRows) {
          const o = await prisma.order.findUniqueOrThrow({ where: { id: marker + 'o-' + k } });
          expect([k, o.dropoffHostel]).toEqual([k, want]);
          expect(o.updatedAt.toISOString()).toBe(old.toISOString());
        }
        const [u2, o2] = await run();
        expect([u2, o2]).toEqual([0, 0]); // second run changes nothing
      } finally {
        await prisma.order.deleteMany({ where: { id: { startsWith: marker } } });
        await prisma.user.deleteMany({ where: { id: { startsWith: marker } } });
      }
    });
  });

  // ------------------------------------------------------------------------------------------ vendor location
  describe('PATCH /api/admin/vendors/:id/location', () => {
    const patch = (body: unknown, id = 'ven-1', token = tAdmin) => request.patch(`/api/admin/vendors/${id}/location`).set(H(token)).send(body as object);

    test('needs an admin', async () => {
      expect((await request.patch('/api/admin/vendors/ven-1/location').send({ lat: 23.0745, lng: 76.859 })).status).toBe(401);
      for (const t of [tStudent, tVendor, tRider]) expect((await patch({ lat: 23.0745, lng: 76.859 }, 'ven-1', t)).status).toBe(403);
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } });
      expect([v.lat, v.lng]).toEqual([PLACEHOLDER.lat, PLACEHOLDER.lng]);
    });

    test('sets the pin, answers hasLocation and writes an audit entry', async () => {
      const res = await patch({ lat: 23.0745, lng: 76.859 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { id: 'ven-1', lat: 23.0745, lng: 76.859, hasLocation: true } });
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } });
      expect([v.lat, v.lng]).toEqual([23.0745, 76.859]);
      const audit = await prisma.adminAuditLog.findFirst({ where: { action: 'VENDOR_LOCATION_SET', targetId: 'ven-1' }, orderBy: { createdAt: 'desc' } });
      expect(audit).not.toBeNull();
      expect(audit!.targetType).toBe('VENDOR');
      expect(audit!.summary).toContain('23.074500');
      // the admin vendor list carries hasLocation
      const list = await request.get('/api/vendors').set(H(tAdmin));
      expect(list.body.data.find((x: any) => x.id === 'ven-1')).toMatchObject({ lat: 23.0745, lng: 76.859, hasLocation: true });
    });

    test('setting the placeholder pin back reports hasLocation false', async () => {
      const res = await patch(PLACEHOLDER);
      expect(res.status).toBe(200);
      expect(res.body.data.hasLocation).toBe(false);
    });

    test.each([
      ['strings', { lat: '23.0745', lng: '76.859' }, 'lat'],
      ['missing lat', { lng: 76.859 }, 'lat'],
      ['missing lng', { lat: 23.0745 }, 'lng'],
      ['null', { lat: null, lng: null }, 'lat'],
      ['lat too big', { lat: 91, lng: 76.859 }, 'lat'],
      ['lat too small', { lat: -91, lng: 76.859 }, 'lat'],
      ['lng too big', { lat: 23.0745, lng: 181 }, 'lng'],
      ['lng too small', { lat: 23.0745, lng: -181 }, 'lng'],
      ['Delhi (not near campus)', { lat: 28.6139, lng: 77.209 }, 'location'],
      ['Bhopal city (about 15 km)', { lat: 23.2599, lng: 77.4126 }, 'location'],
      ['0,0', { lat: 0, lng: 0 }, 'location'],
      ['empty body', {}, 'lat'],
    ])('rejects %s', async (_n, body, field) => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe(field);
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } });
      expect([v.lat, v.lng]).toEqual([PLACEHOLDER.lat, PLACEHOLDER.lng]);
    });

    test('an array / non-object body or unknown / malformed id is refused', async () => {
      expect((await patch([1, 2])).status).toBe(400);
      expect((await patch({ lat: 23.0745, lng: 76.859 }, 'no-such-vendor')).status).toBe(404);
      expect((await patch({ lat: 23.0745, lng: 76.859 }, 'bad%20id')).status).toBe(400);
    });

    test('creating a vendor validates the same way (POST /api/vendors and POST /api/admin/partners)', async () => {
      const bad = await request.post('/api/vendors').set(H(tAdmin)).send({ name: 'Far Cafe', lat: 28.61, lng: 77.2 });
      expect(bad.status).toBe(400);
      expect(bad.body.field).toBe('location');
      expect((await request.post('/api/vendors').set(H(tAdmin)).send({ name: 'Half Cafe', lat: 23.0745 })).status).toBe(400);
      expect((await request.post('/api/vendors').set(H(tAdmin)).send({ name: 'Str Cafe', lat: '23.0745', lng: '76.859' })).status).toBe(400);
      const ok = await request.post('/api/vendors').set(H(tAdmin)).send({ name: 'Campus Cafe', lat: 23.0745, lng: 76.859 });
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ lat: 23.0745, lng: 76.859 });
      const noPin = await request.post('/api/vendors').set(H(tAdmin)).send({ name: 'No Pin Cafe' });
      expect(noPin.status).toBe(201);
      expect(noPin.body.data).toMatchObject({ lat: 23.0768, lng: 76.8524 });

      const partner = (extra: object, phone: string) => request.post('/api/admin/partners').set(H(tAdmin)).send({
        role: 'VENDOR', name: 'Owner Name', phone, password: 'Str0ng-Passw0rd!', restaurantName: 'Pin Kitchen', category: 'Rolls', address: 'Near campus', ...extra,
      });
      const farPartner = await partner({ lat: 28.61, lng: 77.2 }, '9999877101');
      expect(farPartner.status).toBe(400);
      expect(farPartner.body.field).toBe('location');
      const okPartner = await partner({ lat: 23.0745, lng: 76.859 }, '9999877102');
      expect(okPartner.status).toBe(201);
      const created = await prisma.vendor.findUniqueOrThrow({ where: { id: okPartner.body.profileId } });
      expect([created.lat, created.lng]).toEqual([23.0745, 76.859]);
      const plain = await partner({}, '9999877103');
      expect(plain.status).toBe(201);
      const plainV = await prisma.vendor.findUniqueOrThrow({ where: { id: plain.body.profileId } });
      expect([plainV.lat, plainV.lng]).toEqual([PLACEHOLDER.lat, PLACEHOLDER.lng]);

      await prisma.vendor.deleteMany({ where: { id: { in: [ok.body.data.id, noPin.body.data.id, okPartner.body.profileId, plain.body.profileId] } } });
    });
  });

  // ------------------------------------------------------------------------------------------ rider locations
  describe('rider locations', () => {
    const postLoc = (lat = 23.0735, lng = 76.859, token = tRider) => request.post('/api/drivers/location').set(H(token)).send({ lat, lng, heading: 45 });

    test('GET /api/drivers/locations (admin) returns duty status, approval status and lastUpdated', async () => {
      expect((await postLoc()).status).toBe(200);
      const res = await request.get('/api/drivers/locations').set(H(tAdmin));
      expect(res.status).toBe(200);
      const row = res.body.data.find((r: any) => r.driverId === RIDER.id);
      expect(row).toMatchObject({ driverId: RIDER.id, lat: 23.0735, lng: 76.859, heading: 45, dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' });
      expect(typeof row.lastUpdated).toBe('string');
      expect(Number.isNaN(Date.parse(row.lastUpdated))).toBe(false);

      await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'OFFLINE' } });
      const off = await request.get('/api/drivers/locations').set(H(tAdmin));
      expect(off.body.data.find((r: any) => r.driverId === RIDER.id).dutyStatus).toBe('OFFLINE');
    });

    test('a rider only gets their own row; students and vendors get none of anyone elses', async () => {
      await postLoc();
      const own = await request.get('/api/drivers/locations').set(H(tRider));
      expect(own.body.data.every((r: any) => r.driverId === RIDER.id)).toBe(true);
      const stu = await request.get('/api/drivers/locations').set(H(tStudent));
      expect(stu.body.data).toEqual([]);
      expect((await request.get('/api/drivers/locations')).status).toBe(401);
    });

    test('admins see a position broadcast while the rider is on duty (event now also carries id + duty status)', async () => {
      const admin = await connect(tAdmin);
      expect((await admin.emitWithAck('join_room', 'admins')).ok).toBe(true);
      const got: any[] = [];
      admin.on('driver_location_update', (d: any) => got.push(d));
      expect((await postLoc(23.0736, 76.8591)).status).toBe(200);
      await sleep(300);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ driverId: RIDER.id, id: RIDER.id, lat: 23.0736, lng: 76.8591, dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' });

      await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'IN_TRANSIT' } });
      expect((await postLoc(23.0737, 76.8592)).status).toBe(200);
      await sleep(300);
      expect(got).toHaveLength(2);
      expect(got[1].dutyStatus).toBe('IN_TRANSIT');
    });

    test('a position that arrives after going OFFLINE is stored but not broadcast to admins', async () => {
      const admin = await connect(tAdmin);
      await admin.emitWithAck('join_room', 'admins');
      const got: any[] = [];
      admin.on('driver_location_update', (d: any) => got.push(d));
      await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'OFFLINE' } });
      const res = await postLoc(23.0731, 76.8581);
      expect(res.status).toBe(200);
      await sleep(400);
      expect(got).toHaveLength(0);
      const stored = await prisma.driverLocation.findUniqueOrThrow({ where: { driverId: RIDER.id } });
      expect([stored.lat, stored.lng]).toEqual([23.0731, 76.8581]);

      // the socket path behaves the same
      const riderSock = await connect(tRider);
      riderSock.emit('update_driver_location', { lat: 23.0732, lng: 76.8582, heading: 1 });
      await sleep(400);
      expect(got).toHaveLength(0);
      expect((await prisma.driverLocation.findUniqueOrThrow({ where: { driverId: RIDER.id } })).lat).toBe(23.0732);
    });

    test('tracking visibility is unchanged: the customer of an active order still gets rider_location, other customers and vendors never', async () => {
      const placed = await place({ dropoffHostel: 'BH2' });
      const id = placed.body.data.id as string;
      await prisma.order.update({ where: { id }, data: { paymentStatus: 'PAID', paidAt: new Date(), status: 'PICKED_UP', driverId: RIDER.id } });
      const owner = await connect(tStudent);
      const other = await connect(tCampusStudent);
      const vend = await connect(tVendor);
      const ownerGot: any[] = [];
      const otherGot: any[] = [];
      const vendGot: any[] = [];
      owner.on('rider_location', (d: any) => ownerGot.push(d));
      other.on('rider_location', (d: any) => otherGot.push(d));
      vend.on('rider_location', (d: any) => vendGot.push(d));
      expect((await owner.emitWithAck('join_room', `order_${id}`)).ok).toBe(true);
      expect((await other.emitWithAck('join_room', `order_${id}`)).ok).toBe(false);
      await vend.emitWithAck('join_room', `order_${id}`);
      expect((await postLoc(23.0734, 76.8590)).status).toBe(200);
      await sleep(400);
      expect(ownerGot).toHaveLength(1);
      expect(ownerGot[0]).toMatchObject({ orderId: id, driverId: RIDER.id, lat: 23.0734, lng: 76.859 });
      expect(otherGot).toHaveLength(0);
      expect(vendGot).toHaveLength(0);
    });
  });
});
