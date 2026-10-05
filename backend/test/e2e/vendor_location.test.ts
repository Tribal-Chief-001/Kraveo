/**
 * Restaurant location, auto-detect + manual (Docs/20_vendor_location_contract.md section 1): sign-up with an optional
 * device pin, PUT /api/partner/vendor/location (own vendor only, PENDING / APPROVED, rate limited, audited), the new
 * source / time / accuracy columns on every partner and admin view, and "admin edits are source ADMIN".
 * Runs against a real PostgreSQL.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getAdminToken, getStudentToken, getVendorToken, getDriverToken, getAuthHeader } from '../harness/auth';
import { __resetLoginLimiter } from '../../src/services/loginLimiter';
import { __resetSignupLimiter } from '../../src/routes/partners';
import { __resetRateLimits, rateLimitMiddleware } from '../../src/middleware/rateLimit';
import { CAMPUS_CENTER } from '../../src/config/campus';
import { adminPinData, checkAccuracy, describePin, devicePinData, vendorLocationView } from '../../src/services/vendorLocation';

const PW = 'Sup3rSecret!';
const PREFIX = 'ZZ VLoc';
const PLACEHOLDER = { lat: 23.0768, lng: 76.8524 };
const PIN = { lat: 23.0745, lng: 76.859 };
const adminH = () => getAuthHeader(getAdminToken());
const H = (t: string) => getAuthHeader(t);

describe('Restaurant location (device + admin)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const vendorBody = (phone: string, extra: object = {}) => ({
    role: 'VENDOR', name: 'Ramesh Kumar', phone, password: PW,
    restaurantName: `${PREFIX} Dhaba ${phone}`, category: 'North Indian', address: 'Ashta road, near gate 2', ...extra,
  });
  const signup = (body: object) => request.post('/api/auth/partner-signup').send(body);
  const put = (token: string, body: unknown) => request.put('/api/partner/vendor/location').set(H(token)).send(body as object);
  const setStatus = (id: string, status: string, reason?: string) => request.post(`/api/admin/partners/VENDOR/${id}/status`).set(adminH()).send({ status, reason });

  const resetVen1 = () => prisma.vendor.update({ where: { id: 'ven-1' }, data: { lat: PLACEHOLDER.lat, lng: PLACEHOLDER.lng, locationSource: null, locationSetAt: null, locationAccuracyM: null } });
  const cleanup = async () => {
    await prisma.vendor.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.vendor.deleteMany({ where: { name: { in: ['VLoc Pin Cafe', 'VLoc No Pin Cafe'] } } });
    await prisma.adminAuditLog.deleteMany({});
    await cleanTestUsers();
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanup();
    await seedTestDatabase();
    await resetVen1();
    server = await startTestServer(0);
    request = supertest(server.app);
  });
  afterAll(async () => {
    delete process.env.RL_VENDOR_LOCATION_MAX;
    await resetVen1();
    await cleanTestOrders();
    await cleanup();
    await stopTestServer(server);
    await prisma.$disconnect();
  });
  beforeEach(() => {
    __resetLoginLimiter();
    __resetSignupLimiter();
    __resetRateLimits();
    delete process.env.RL_VENDOR_LOCATION_MAX;
  });

  // ---------------------------------------------------------------------------------------------- helpers
  describe('helpers', () => {
    test('checkAccuracy: absent is null, 0..5000 numbers pass, everything else is rejected', () => {
      expect(checkAccuracy(undefined)).toEqual({ ok: true, value: null });
      expect(checkAccuracy(null)).toEqual({ ok: true, value: null });
      expect(checkAccuracy(0)).toEqual({ ok: true, value: 0 });
      expect(checkAccuracy(12.5)).toEqual({ ok: true, value: 12.5 });
      expect(checkAccuracy(5000)).toEqual({ ok: true, value: 5000 });
      for (const bad of [-1, 5000.01, '12', NaN, Infinity, true, {}, []]) expect(checkAccuracy(bad)).toMatchObject({ ok: false });
    });

    test('vendorLocationView / describePin / pin data', () => {
      expect(vendorLocationView({ lat: PLACEHOLDER.lat, lng: PLACEHOLDER.lng })).toEqual({ hasLocation: false, lat: PLACEHOLDER.lat, lng: PLACEHOLDER.lng, locationSource: null, locationSetAt: null, locationAccuracyM: null });
      const at = new Date();
      expect(vendorLocationView({ ...PIN, locationSource: 'DEVICE', locationSetAt: at, locationAccuracyM: 12 })).toEqual({ hasLocation: true, ...PIN, locationSource: 'DEVICE', locationSetAt: at, locationAccuracyM: 12 });
      expect(describePin(PLACEHOLDER)).toBe('not set');
      expect(describePin({ ...PIN, locationSource: 'ADMIN' })).toBe('23.074500, 76.859000 (admin)');
      expect(adminPinData(PIN.lat, PIN.lng)).toMatchObject({ ...PIN, locationSource: 'ADMIN', locationAccuracyM: null });
      expect(devicePinData(PIN.lat, PIN.lng, 9)).toMatchObject({ ...PIN, locationSource: 'DEVICE', locationAccuracyM: 9 });
    });
  });

  // ---------------------------------------------------------------------------------------------- migration
  describe('migration 20261008_vendor_location_source', () => {
    test('the three columns exist on the test database, nullable, with the right types and no default', async () => {
      const cols = await prisma.$queryRaw<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>`
        SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'Vendor' AND column_name IN ('locationSource', 'locationSetAt', 'locationAccuracyM') ORDER BY column_name`;
      expect(cols).toEqual([
        { column_name: 'locationAccuracyM', data_type: 'double precision', is_nullable: 'YES', column_default: null },
        { column_name: 'locationSetAt', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
        { column_name: 'locationSource', data_type: 'text', is_nullable: 'YES', column_default: null },
      ]);
    });

    test('the SQL file is additive only (ADD COLUMN, no drops, updates or deletes)', () => {
      const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261008_vendor_location_source/migration.sql'), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(sql).toMatch(/ALTER TABLE "Vendor" ADD COLUMN/);
      expect(sql).not.toMatch(/\b(DROP|UPDATE|DELETE|TRUNCATE|SET NOT NULL|RENAME)\b/i);
      expect((sql.match(/ADD COLUMN/g) ?? []).length).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------------------------- sign-up
  describe('POST /api/auth/partner-signup with a location', () => {
    test('without a location it works exactly as before (placeholder pin, nothing recorded)', async () => {
      const res = await signup(vendorBody('9000000401'));
      expect(res.status).toBe(201);
      expect(res.body.vendor).toMatchObject({ hasLocation: false, lat: PLACEHOLDER.lat, lng: PLACEHOLDER.lng, locationSource: null, locationSetAt: null, locationAccuracyM: null });
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: res.body.vendor.id } });
      expect([v.lat, v.lng, v.locationSource, v.locationSetAt, v.locationAccuracyM]).toEqual([PLACEHOLDER.lat, PLACEHOLDER.lng, null, null, null]);
    });

    test('with lat, lng and accuracy it stores them as source DEVICE', async () => {
      const before = Date.now();
      const res = await signup(vendorBody('9000000402', { ...PIN, locationAccuracyM: 12.4 }));
      expect(res.status).toBe(201);
      expect(res.body.approvalStatus).toBe('PENDING');
      expect(res.body.vendor).toMatchObject({ hasLocation: true, ...PIN, locationSource: 'DEVICE', locationAccuracyM: 12.4 });
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: res.body.vendor.id } });
      expect([v.lat, v.lng, v.locationSource, v.locationAccuracyM]).toEqual([PIN.lat, PIN.lng, 'DEVICE', 12.4]);
      expect(v.locationSetAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    test('accuracy is optional; null coordinates count as "no location"', async () => {
      const a = await signup(vendorBody('9000000403', PIN));
      expect(a.status).toBe(201);
      expect(a.body.vendor).toMatchObject({ hasLocation: true, locationSource: 'DEVICE', locationAccuracyM: null });
      const b = await signup(vendorBody('9000000404', { lat: null, lng: null }));
      expect(b.status).toBe(201);
      expect(b.body.vendor).toMatchObject({ hasLocation: false, locationSource: null });
      const c = await signup(vendorBody('9000000405', { locationAccuracyM: 10 })); // accuracy alone is ignored
      expect(c.status).toBe(201);
      expect(c.body.vendor).toMatchObject({ hasLocation: false, locationSource: null, locationAccuracyM: null });
    });

    test('half a location, strings, ranges, off-campus and bad accuracy are 400 with a field, and nothing is created', async () => {
      const cases: Array<[string, object, string]> = [
        ['only lat', { lat: PIN.lat }, 'lng'],
        ['only lng', { lng: PIN.lng }, 'lat'],
        ['string coords', { lat: '23.0745', lng: '76.859' }, 'lat'],
        ['string lng', { lat: PIN.lat, lng: '76.859' }, 'lng'],
        ['lat out of range', { lat: 91, lng: PIN.lng }, 'lat'],
        ['lng out of range', { lat: PIN.lat, lng: 181 }, 'lng'],
        ['Delhi (not near campus)', { lat: 28.6139, lng: 77.209 }, 'location'],
        ['Bhopal city (about 15 km)', { lat: 23.2599, lng: 77.4126 }, 'location'],
        ['0,0', { lat: 0, lng: 0 }, 'location'],
        ['negative accuracy', { ...PIN, locationAccuracyM: -1 }, 'locationAccuracyM'],
        ['huge accuracy', { ...PIN, locationAccuracyM: 6000 }, 'locationAccuracyM'],
        ['string accuracy', { ...PIN, locationAccuracyM: '12' }, 'locationAccuracyM'],
      ];
      for (const [label, extra, field] of cases) {
        const res = await signup(vendorBody('9000000410', extra));
        expect([label, res.status, res.body.field]).toEqual([label, 400, field]);
        expect(typeof res.body.message).toBe('string');
      }
      expect(await prisma.user.findFirst({ where: { phone: '+91 9000000410' } })).toBeNull();
      // bad location input does not use up the 3-per-hour sign-up tries of that number
      expect((await signup(vendorBody('9000000410', PIN))).status).toBe(201);
    });

    test('boundaries: accuracy 0 and 5000 are accepted', async () => {
      expect((await signup(vendorBody('9000000411', { ...PIN, locationAccuracyM: 0 }))).body.vendor.locationAccuracyM).toBe(0);
      expect((await signup(vendorBody('9000000412', { ...PIN, locationAccuracyM: 5000 }))).body.vendor.locationAccuracyM).toBe(5000);
    });

    test('a rider sign-up ignores any location fields', async () => {
      const res = await signup({ role: 'DRIVER', name: 'Sunil Verma', phone: '9000000413', password: PW, vehicleType: 'Bike', vehicleRegNo: 'MP04 AB 1234', emergencyPhone: '9000000999', lat: 'garbage', lng: 1 });
      expect(res.status).toBe(201);
      await prisma.driverPartner.deleteMany({ where: { phone: '+91 9000000413' } });
    });

    test('the pin is visible to the admin on the application, the vendor list and the partner list', async () => {
      const res = await signup(vendorBody('9000000414', { ...PIN, locationAccuracyM: 20 }));
      const id = res.body.vendor.id;
      const apps = await request.get('/api/admin/applications?status=PENDING&kind=VENDOR').set(adminH());
      const row = apps.body.data.find((a: any) => a.id === id);
      expect(row.vendor).toMatchObject({ hasLocation: true, ...PIN, locationSource: 'DEVICE', locationAccuracyM: 20 });
      expect(typeof row.vendor.locationSetAt).toBe('string');
      const none = await signup(vendorBody('9000000415'));
      const apps2 = await request.get('/api/admin/applications?status=PENDING&kind=VENDOR').set(adminH());
      expect(apps2.body.data.find((a: any) => a.id === none.body.vendor.id).vendor).toMatchObject({ hasLocation: false, locationSource: null, locationSetAt: null, locationAccuracyM: null });
      const list = await request.get('/api/vendors').set(adminH());
      expect(list.body.data.find((v: any) => v.id === id)).toMatchObject({ hasLocation: true, locationSource: 'DEVICE', locationAccuracyM: 20 });
      const partners = await request.get('/api/admin/partners').set(adminH());
      const owner = partners.body.data.find((u: any) => u.id === res.body.user.id);
      expect(owner.vendorsOwned[0]).toMatchObject({ id, hasLocation: true, ...PIN, locationSource: 'DEVICE' });
    });
  });

  // ---------------------------------------------------------------------------------------------- PUT
  describe('PUT /api/partner/vendor/location', () => {
    let pendingToken = '';
    let pendingVendorId = '';

    const newPending = async (phone: string) => {
      const res = await signup(vendorBody(phone));
      expect(res.status).toBe(201);
      return { token: res.body.token as string, vendorId: res.body.vendor.id as string, userId: res.body.user.id as string };
    };

    beforeAll(async () => {
      __resetSignupLimiter();
      const p = await newPending('9000000420');
      pendingToken = p.token;
      pendingVendorId = p.vendorId;
    });

    test('needs a login and the VENDOR role (customer, rider, admin get 403)', async () => {
      expect((await request.put('/api/partner/vendor/location').send(PIN)).status).toBe(401);
      for (const t of [getStudentToken(), getDriverToken(), getAdminToken()]) expect((await put(t, PIN)).status).toBe(403);
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } });
      expect([v.lat, v.lng, v.locationSource]).toEqual([PLACEHOLDER.lat, PLACEHOLDER.lng, null]);
    });

    test('happy path for an APPROVED restaurant: saves, answers the documented shape, sets source DEVICE', async () => {
      const before = Date.now();
      const res = await put(getVendorToken(), { ...PIN, accuracyM: 12.4 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { ...PIN, hasLocation: true, locationSource: 'DEVICE', locationAccuracyM: 12.4 } });
      expect(Date.parse(res.body.data.locationSetAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(Object.keys(res.body.data).sort()).toEqual(['hasLocation', 'lat', 'lng', 'locationAccuracyM', 'locationSetAt', 'locationSource']);
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } });
      expect([v.lat, v.lng, v.locationSource, v.locationAccuracyM]).toEqual([PIN.lat, PIN.lng, 'DEVICE', 12.4]);
    });

    test('accuracy is optional and stored as null when omitted', async () => {
      const res = await put(getVendorToken(), { lat: 23.0741, lng: 76.8581 });
      expect(res.status).toBe(200);
      expect(res.body.data.locationAccuracyM).toBeNull();
    });

    test('a PENDING restaurant may set its pin; /partner/me then shows it', async () => {
      const res = await put(pendingToken, { ...PIN, accuracyM: 30 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ hasLocation: true, locationSource: 'DEVICE' });
      const me = await request.get('/api/partner/me').set(H(pendingToken));
      expect(me.status).toBe(200);
      expect(me.body.approvalStatus).toBe('PENDING');
      expect(me.body.vendor).toMatchObject({ id: pendingVendorId, hasLocation: true, ...PIN, locationSource: 'DEVICE', locationAccuracyM: 30 });
      expect(typeof me.body.vendor.locationSetAt).toBe('string');
    });

    test('/partner/me and the login answer carry the fields (also "not set")', async () => {
      const fresh = await newPending('9000000421');
      const me = await request.get('/api/partner/me').set(H(fresh.token));
      expect(me.body.vendor).toMatchObject({ hasLocation: false, lat: PLACEHOLDER.lat, lng: PLACEHOLDER.lng, locationSource: null, locationSetAt: null, locationAccuracyM: null });
      await put(fresh.token, { ...PIN, accuracyM: 8 });
      const login = await request.post('/api/auth/partner-login').send({ phone: '9000000421', password: PW, role: 'VENDOR' });
      expect(login.status).toBe(200);
      expect(login.body.vendor).toMatchObject({ id: fresh.vendorId, hasLocation: true, ...PIN, locationSource: 'DEVICE', locationAccuracyM: 8 });
      expect(login.body.vendor.name).toBeDefined();
      expect(login.body.vendor.isAcceptingOrders).toBe(false);
    });

    test('it only ever acts on the caller\'s own restaurant: ids in the body are ignored', async () => {
      await resetVen1();
      const res = await put(pendingToken, { ...PIN, vendorId: 'ven-1', id: 'ven-1', userId: 'usr-3' });
      expect(res.status).toBe(200);
      const ven1 = await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } });
      expect([ven1.lat, ven1.lng, ven1.locationSource]).toEqual([PLACEHOLDER.lat, PLACEHOLDER.lng, null]);
      const own = await prisma.vendor.findUniqueOrThrow({ where: { id: pendingVendorId } });
      expect(own.locationSource).toBe('DEVICE');
    });

    test('a vendor account without a restaurant row gets 404', async () => {
      const orphan = await prisma.user.create({ data: { name: 'Orphan Owner', phone: '+91 9000000499', role: 'VENDOR' } });
      const { generateTestToken } = await import('../harness/auth');
      const res = await put(generateTestToken({ id: orphan.id, phone: orphan.phone!, role: 'VENDOR' as any }), PIN);
      expect(res.status).toBe(404);
    });

    test('validation: strings, ranges, off-campus, missing fields and bad accuracy are 400 with a field and change nothing', async () => {
      const own = await newPending('9000000422');
      const cases: Array<[string, object, string]> = [
        ['strings', { lat: '23.0745', lng: '76.859' }, 'lat'],
        ['missing lat', { lng: PIN.lng }, 'lat'],
        ['missing lng', { lat: PIN.lat }, 'lng'],
        ['null', { lat: null, lng: null }, 'lat'],
        ['lat too big', { lat: 91, lng: PIN.lng }, 'lat'],
        ['lng too small', { lat: PIN.lat, lng: -181 }, 'lng'],
        ['Delhi', { lat: 28.6139, lng: 77.209 }, 'location'],
        ['0,0', { lat: 0, lng: 0 }, 'location'],
        ['empty body', {}, 'lat'],
        ['negative accuracy', { ...PIN, accuracyM: -5 }, 'accuracyM'],
        ['accuracy over 5000', { ...PIN, accuracyM: 5001 }, 'accuracyM'],
        ['string accuracy', { ...PIN, accuracyM: '12' }, 'accuracyM'],
      ];
      for (const [label, body, field] of cases) {
        const res = await put(own.token, body);
        expect([label, res.status, res.body.field]).toEqual([label, 400, field]);
        expect(typeof res.body.message).toBe('string');
      }
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: own.vendorId } });
      expect([v.lat, v.lng, v.locationSource]).toEqual([PLACEHOLDER.lat, PLACEHOLDER.lng, null]);
      expect((await put(own.token, undefined)).status).toBe(400);
    });

    test('REJECTED and SUSPENDED restaurants are blocked with 403 PARTNER_NOT_APPROVED like the other partner writes', async () => {
      const rej = await newPending('9000000423');
      expect((await setStatus(rej.vendorId, 'REJECTED', 'Photos missing')).status).toBe(200);
      const r = await put(rej.token, PIN);
      expect([r.status, r.body.code, r.body.approvalStatus]).toEqual([403, 'PARTNER_NOT_APPROVED', 'REJECTED']);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: rej.vendorId } })).locationSource).toBeNull();

      const sus = await newPending('9000000424');
      await prisma.vendor.update({ where: { id: sus.vendorId }, data: { approvalStatus: 'SUSPENDED' } }); // direct: keeps the session token valid
      const s = await put(sus.token, PIN);
      expect([s.status, s.body.code, s.body.approvalStatus]).toEqual([403, 'PARTNER_NOT_APPROVED', 'SUSPENDED']);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: sus.vendorId } })).locationSource).toBeNull();
    });

    test('after approval the same restaurant can still update its pin', async () => {
      const p = await newPending('9000000425');
      expect((await put(p.token, PIN)).status).toBe(200);
      expect((await setStatus(p.vendorId, 'APPROVED')).status).toBe(200);
      expect((await put(p.token, { lat: 23.0735, lng: 76.8584, accuracyM: 5 })).status).toBe(200);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: p.vendorId } })).lat).toBe(23.0735);
    });

    test('audit: VENDOR_LOCATION_SET with rounded coordinates, accuracy and the previous pin', async () => {
      await prisma.adminAuditLog.deleteMany({});
      const p = await newPending('9000000426');
      expect((await put(p.token, { ...PIN, accuracyM: 12.4 })).status).toBe(200);
      expect((await put(p.token, { lat: 23.0735, lng: 76.8584 })).status).toBe(200);
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'VENDOR_LOCATION_SET', targetId: p.vendorId }, orderBy: { createdAt: 'asc' } });
      expect(rows).toHaveLength(2);
      expect(rows[0].targetType).toBe('VENDOR');
      expect(rows[0].summary).toContain('23.074500, 76.859000');
      expect(rows[0].summary).toContain('about 12 m');
      expect(rows[0].summary).toContain('previous: not set');
      expect(rows[1].summary).toContain('23.073500, 76.858400');
      expect(rows[1].summary).toContain('previous: 23.074500, 76.859000 (device)');
      const log = await request.get('/api/admin/audit-log').set(adminH());
      expect(log.body.data.some((r: any) => r.action === 'VENDOR_LOCATION_SET')).toBe(true);
      expect(rows.every((r) => r.summary.length <= 300)).toBe(true);
    });

    test('a device update replaces an ADMIN pin (campus validation is the only guard) and the audit shows the admin pin as previous', async () => {
      await prisma.adminAuditLog.deleteMany({});
      await request.patch('/api/admin/vendors/ven-1/location').set(adminH()).send({ lat: 23.0733, lng: 76.8601 });
      expect((await put(getVendorToken(), { ...PIN, accuracyM: 15 })).status).toBe(200);
      const row = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'VENDOR_LOCATION_SET', summary: { contains: 'from the phone' } } });
      expect(row.summary).toContain('previous: 23.073300, 76.860100 (admin)');
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } })).locationSource).toBe('DEVICE');
    });

    test('rate limit: RL_VENDOR_LOCATION_MAX per user; invalid tries count; other users are unaffected', async () => {
      process.env.RL_VENDOR_LOCATION_MAX = '3';
      const t = getVendorToken();
      expect((await put(t, PIN)).status).toBe(200);
      expect((await put(t, { lat: 'x', lng: 'y' })).status).toBe(400);
      expect((await put(t, PIN)).status).toBe(200);
      const fourth = await put(t, PIN);
      expect([fourth.status, fourth.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect(fourth.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(Number(fourth.headers['retry-after'])).toBe(fourth.body.retryAfterSeconds);
      expect((await put(pendingToken, PIN)).status).toBe(200);
      expect((await request.get('/api/partner/me').set(H(t))).status).toBe(200); // other routes are not limited
    });

    test('the default rule outside tests is 10 per hour per user, only for PUT on this path', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const tok = getVendorToken('vl-limit-user', '+91 9777800001');
        const call = (method: string, path: string) => {
          let nexted = false;
          const res: any = { setHeader() {}, status() { return this; }, json() { return this; } };
          rateLimitMiddleware({ method, path, body: {}, headers: { authorization: `Bearer ${tok}` }, ip: '192.0.2.9', socket: {} } as any, res, () => { nexted = true; });
          return nexted;
        };
        const run = Array.from({ length: 11 }, () => call('PUT', '/partner/vendor/location'));
        expect(run).toEqual([...Array(10).fill(true), false]);
        expect(call('GET', '/partner/me')).toBe(true);
        expect(call('PUT', '/partner/application')).toBe(true);
      } finally {
        process.env.NODE_ENV = prev;
        __resetRateLimits();
      }
    });
  });

  // ---------------------------------------------------------------------------------------------- admin = ADMIN
  describe('admin location updates are source ADMIN', () => {
    test('PATCH /api/admin/vendors/:id/location sets ADMIN, a fresh time and clears the accuracy of an earlier device pin', async () => {
      await prisma.vendor.update({ where: { id: 'ven-1' }, data: devicePinData(PIN.lat, PIN.lng, 25) });
      await prisma.adminAuditLog.deleteMany({});
      const before = Date.now();
      const res = await request.patch('/api/admin/vendors/ven-1/location').set(adminH()).send({ lat: 23.0733, lng: 76.8601 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: 'ven-1', lat: 23.0733, lng: 76.8601, hasLocation: true, locationSource: 'ADMIN', locationAccuracyM: null });
      expect(Date.parse(res.body.data.locationSetAt)).toBeGreaterThanOrEqual(before - 1000);
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } });
      expect([v.locationSource, v.locationAccuracyM]).toEqual(['ADMIN', null]);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'VENDOR_LOCATION_SET', targetId: 'ven-1' } });
      expect(audit.summary).toContain('previous: 23.074500, 76.859000 (device)');
      const me = await request.get('/api/partner/me').set(H(getVendorToken()));
      expect(me.body.vendor).toMatchObject({ locationSource: 'ADMIN', locationAccuracyM: null, hasLocation: true });
    });

    test('a rejected admin update leaves the source untouched', async () => {
      const res = await request.patch('/api/admin/vendors/ven-1/location').set(adminH()).send({ lat: 28.6, lng: 77.2 });
      expect(res.status).toBe(400);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } })).locationSource).toBe('ADMIN');
    });

    test('the create paths: with a pin -> ADMIN; without -> no source (placeholder, "not set")', async () => {
      const withPin = await request.post('/api/vendors').set(adminH()).send({ name: 'VLoc Pin Cafe', ...PIN });
      expect(withPin.status).toBe(201);
      expect(withPin.body.data).toMatchObject({ locationSource: 'ADMIN', locationAccuracyM: null });
      expect(withPin.body.data.locationSetAt).toBeTruthy();
      const noPin = await request.post('/api/vendors').set(adminH()).send({ name: 'VLoc No Pin Cafe' });
      expect(noPin.status).toBe(201);
      expect(noPin.body.data).toMatchObject({ locationSource: null, locationSetAt: null });

      const partner = (extra: object, phone: string) => request.post('/api/admin/partners').set(adminH()).send({
        role: 'VENDOR', name: 'Owner Name', phone, password: 'Str0ng-Passw0rd!', restaurantName: `${PREFIX} Kitchen ${phone}`, category: 'Rolls', address: 'Near campus', ...extra,
      });
      const a = await partner(PIN, '9000000431');
      expect(a.status).toBe(201);
      const av = await prisma.vendor.findUniqueOrThrow({ where: { id: a.body.profileId } });
      expect([av.lat, av.lng, av.locationSource, av.locationAccuracyM]).toEqual([PIN.lat, PIN.lng, 'ADMIN', null]);
      expect(av.locationSetAt).not.toBeNull();
      const b = await partner({}, '9000000432');
      expect(b.status).toBe(201);
      const bv = await prisma.vendor.findUniqueOrThrow({ where: { id: b.body.profileId } });
      expect([bv.lat, bv.lng, bv.locationSource, bv.locationSetAt]).toEqual([PLACEHOLDER.lat, PLACEHOLDER.lng, null, null]);
    });

    test('an admin can fix a pending restaurant\'s pin before approving it; the application then shows source ADMIN', async () => {
      const res = await signup(vendorBody('9000000433', { ...PIN, locationAccuracyM: 40 }));
      const id = res.body.vendor.id;
      expect((await request.patch(`/api/admin/vendors/${id}/location`).set(adminH()).send({ lat: 23.0736, lng: 76.8586 })).status).toBe(200);
      expect((await setStatus(id, 'APPROVED')).status).toBe(200);
      const apps = await request.get('/api/admin/applications?status=APPROVED&kind=VENDOR').set(adminH());
      expect(apps.body.data.find((a: any) => a.id === id).vendor).toMatchObject({ lat: 23.0736, lng: 76.8586, locationSource: 'ADMIN', locationAccuracyM: null, hasLocation: true });
    });

    test('a campus-centre pin is a real pin (hasLocation true)', async () => {
      const res = await request.patch('/api/admin/vendors/ven-1/location').set(adminH()).send({ lat: CAMPUS_CENTER.lat, lng: CAMPUS_CENTER.lng });
      expect(res.body.data.hasLocation).toBe(true);
    });
  });
});
