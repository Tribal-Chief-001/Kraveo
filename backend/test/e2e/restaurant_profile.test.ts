/**
 * Restaurants and their categories (Docs/23 sections 3.1 and 3.3): PATCH /admin/vendors/:id/profile, the two creation paths
 * (cuisineIds and the old free text), and the payloads (cuisines + tags added, nothing removed, no commission or price data for owners).
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { DEFAULT_BANNER } from '../../src/routes/partners';
import { DEFAULT_BANNER_URL } from '../../src/services/vendorProfile';

jest.setTimeout(120_000);

const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const OWN = { id: 'usr-rp-o1', phone: '+91 9999881111' };
const OWN2 = { id: 'usr-rp-o2', phone: '+91 9999882222' };
const R = 'rp-ven';
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const tStudent = getStudentToken();
const tOwner = getVendorToken(OWN.id, OWN.phone);
const tOwner2 = getVendorToken(OWN2.id, OWN2.phone);
const H = (t: string) => getAuthHeader(t);
const P = 'ZP';
const PW = 'Str0ng-Passw0rd!';
const FORBIDDEN_FOR_OWNER = ['commission', 'commissionType', 'commissionValue', 'effectiveCommission', 'computedPrice', 'vendorPrice', 'pendingVendorPrice', 'priceIsStale', 'commissionOverride'];
const keysDeep = (v: unknown, acc = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); }
  return acc;
};

describe('Restaurant categories and profile edit', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const patchProfile = (id: string, body: unknown, t = tAdmin) => request.patch(`/api/admin/vendors/${id}/profile`).set(H(t)).send(body as any);
  const mkCat = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await request.post('/api/admin/categories').set(H(tAdmin)).send({ name: `${P} ${name}`, ...extra });
    expect([name, r.status]).toEqual([name, 201]);
    return r.body.data as { id: string; name: string };
  };
  const audits = (action: string, targetId?: string) => prisma.adminAuditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) } });
  const row = (id: string) => prisma.vendor.findUniqueOrThrow({ where: { id }, include: { cuisines: { orderBy: { position: 'asc' }, include: { category: true } } } });
  const wipeCats = async () => {
    await prisma.vendorCategory.deleteMany({ where: { category: { name: { startsWith: P } } } });
    await prisma.menuItem.updateMany({ where: { categoryId: { not: null }, categoryRef: { name: { startsWith: P } } }, data: { categoryId: null } });
    await prisma.category.deleteMany({ where: { name: { startsWith: P } } });
  };
  let n = 0;
  const phone = () => `+91 9999883${String(++n).padStart(3, '0')}`;
  const created: string[] = [];

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    for (const u of [{ id: OWN.id, name: 'RP Owner', phone: OWN.phone, role: Role.VENDOR }, { id: OWN2.id, name: 'RP Owner 2', phone: OWN2.phone, role: Role.VENDOR }]) {
      await prisma.user.upsert({ where: { id: u.id }, update: {}, create: u });
    }
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    __resetRateLimits();
    await prisma.vendorCategory.deleteMany({ where: { vendorId: { startsWith: R } } });
    await prisma.vendor.deleteMany({ where: { id: { startsWith: R } } });
    await wipeCats();
    await prisma.vendorCategory.deleteMany({ where: { category: { slug: { startsWith: 'zplegacy' } } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zplegacy' } } });
    await prisma.adminAuditLog.deleteMany({});
    for (const [i, status] of (['APPROVED', 'APPROVED', 'PENDING', 'REJECTED'] as const).entries()) {
      await prisma.vendor.create({
        data: { id: `${R}-${i + 1}`, userId: i === 1 ? OWN2.id : i === 0 ? OWN.id : null, name: `RP Kitchen ${i + 1}`, category: 'Campus kitchen', address: 'Ashta road gate 2', bannerImage: 'https://img.test/old.jpg', approvalStatus: status, eta: '25-35 mins', fssaiNumber: null },
      });
    }
  });

  afterAll(async () => {
    await prisma.vendorCategory.deleteMany({ where: { OR: [{ vendorId: { startsWith: R } }, { vendorId: { in: created } }] } });
    await prisma.vendor.deleteMany({ where: { OR: [{ id: { startsWith: R } }, { id: { in: created } }] } });
    await wipeCats();
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zplegacy' } } });
    await prisma.adminAuditLog.deleteMany({});
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('PATCH /api/admin/vendors/:id/profile', () => {
    test('every field in one call: the response is the admin vendor view with cuisines + tags, Vendor.category is derived, one audit row says what changed', async () => {
      const [a, b, c] = [await mkCat('North'), await mkCat('Thali'), await mkCat('Chai')];
      const r = await patchProfile(`${R}-1`, {
        name: '  RP   Great  Kitchen ', cuisineIds: [b.id, a.id, c.id], address: 'Near   Gate 4, Ashta road', bannerImage: 'https://img.test/new.png', fssaiNumber: '12345678901234', eta: '15-20 min',
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ success: true, changed: true, message: 'Restaurant saved.' });
      const v = r.body.data;
      expect(v).toMatchObject({
        id: `${R}-1`, name: 'RP Great Kitchen', category: `${P} Thali • ${P} North • ${P} Chai`, address: 'Near Gate 4, Ashta road', bannerImage: 'https://img.test/new.png',
        fssaiNumber: '12345678901234', eta: '15-20 min', tags: [`${P} Thali`, `${P} North`, `${P} Chai`], userId: OWN.id, approvalStatus: 'APPROVED', hasLocation: expect.any(Boolean),
      });
      expect(v.cuisines).toEqual([{ id: b.id, name: `${P} Thali`, icon: 'thali' }, { id: a.id, name: `${P} North`, icon: 'restaurant' }, { id: c.id, name: `${P} Chai`, icon: 'tea' }]); // icons are guessed from the name when none is given
      expect(Array.isArray(v.menuItems)).toBe(true);
      expect('commissionType' in v && 'commissionValue' in v).toBe(true); // the admin view keeps the commission fields like GET /vendors does
      const db = await row(`${R}-1`);
      expect(db.cuisines.map((l) => [l.category.name, l.position])).toEqual([[`${P} Thali`, 0], [`${P} North`, 1], [`${P} Chai`, 2]]);
      const rows = await audits('VENDOR_PROFILE_EDITED', `${R}-1`);
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toMatch(/RP Kitchen 1.*name "RP Kitchen 1" -> "RP Great Kitchen".*address changed.*banner changed.*FSSAI none -> 12345678901234.*ETA 25-35 mins -> 15-20 min.*categories \[\] -> \[ZP Thali, ZP North, ZP Chai\]/);
    });

    test('the same body twice is a no-op success (changed:false): nothing is written and no second audit row; moving the first category changes the string', async () => {
      const [a, b] = [await mkCat('A'), await mkCat('B')];
      const body = { name: 'RP Twice', cuisineIds: [a.id, b.id], eta: '10-15 min' };
      expect((await patchProfile(`${R}-1`, body)).body.changed).toBe(true);
      const before = await prisma.vendor.findUniqueOrThrow({ where: { id: `${R}-1` } });
      const again = await patchProfile(`${R}-1`, body);
      expect([again.status, again.body.changed, again.body.message]).toEqual([200, false, 'Nothing to change.']);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: `${R}-1` } })).updatedAt).toEqual(before.updatedAt);
      expect(await audits('VENDOR_PROFILE_EDITED')).toHaveLength(1);
      const swapped = await patchProfile(`${R}-1`, { cuisineIds: [b.id, a.id] });
      expect([swapped.body.changed, swapped.body.data.category]).toEqual([true, `${P} B • ${P} A`]);
      // ten parallel identical requests: one change, one audit row
      await patchProfile(`${R}-2`, { name: 'RP Parallel' });
      const rs = await Promise.all(Array.from({ length: 10 }, () => patchProfile(`${R}-1`, { name: 'RP Same', address: 'Parallel address' })));
      expect(rs.every((x) => x.status === 200)).toBe(true);
      expect(rs.filter((x) => x.body.changed)).toHaveLength(1);
      expect((await audits('VENDOR_PROFILE_EDITED', `${R}-1`)).length).toBe(3);
    });

    test('validation: every field, with the field named; a refused request writes nothing at all (also not the valid fields of the same body)', async () => {
      const cat = await mkCat('V');
      const cases: [string, unknown, string, string?][] = [
        ['empty body', {}, 'body'], ['unknown key', { lat: 1 }, 'lat'], ['unknown key with a valid one', { name: 'RP Valid', commission: 5 }, 'commission'],
        ['name short', { name: 'R' }, 'name'], ['name long', { name: 'x'.repeat(61) }, 'name'], ['name html', { name: 'RP <script>' }, 'name'], ['name type', { name: 5 }, 'name'], ['name null', { name: null }, 'name'],
        ['address short', { address: 'ab' }, 'address'], ['address long', { address: 'x'.repeat(141) }, 'address'], ['address null', { address: null }, 'address'],
        ['banner ftp', { bannerImage: 'ftp://x/y.png' }, 'bannerImage'], ['banner js', { bannerImage: 'javascript:alert(1)' }, 'bannerImage'], ['banner spaces', { bannerImage: 'https://x/a b.png' }, 'bannerImage'],
        ['banner long', { bannerImage: `https://x/${'a'.repeat(500)}` }, 'bannerImage'], ['banner type', { bannerImage: 5 }, 'bannerImage'], ['banner empty', { bannerImage: '' }, 'bannerImage'],
        ['fssai 13', { fssaiNumber: '1234567890123' }, 'fssaiNumber'], ['fssai letters', { fssaiNumber: '1234567890123a' }, 'fssaiNumber'], ['fssai number', { fssaiNumber: 12345678901234 }, 'fssaiNumber'],
        ['eta format', { eta: '20 min' }, 'eta'], ['eta reversed', { eta: '30-20 min' }, 'eta'], ['eta mins', { eta: '20-30 mins' }, 'eta'], ['eta 4 digits', { eta: '1000-2000 min' }, 'eta'], ['eta type', { eta: 25 }, 'eta'],
        ['cuisineIds not list', { cuisineIds: 'x' }, 'cuisineIds'], ['cuisineIds dup', { cuisineIds: [cat.id, cat.id] }, 'cuisineIds'], ['cuisineIds bad id', { cuisineIds: ['bad id!'] }, 'cuisineIds'],
        ['cuisineIds unknown', { cuisineIds: ['does-not-exist'] }, 'cuisineIds', 'CATEGORY_UNKNOWN'],
      ];
      for (const [label, body, field, code] of cases) {
        const r = await patchProfile(`${R}-1`, { ...(body as object), ...(label === 'unknown key with a valid one' ? {} : { }) });
        expect([label, r.status, r.body.success, r.body.field]).toEqual([label, 400, false, field]);
        if (code) expect([label, r.body.code]).toEqual([label, code]);
      }
      const r = await patchProfile(`${R}-1`, { name: 'RP Would Change', eta: 'broken' });
      expect(r.status).toBe(400);
      const db = await prisma.vendor.findUniqueOrThrow({ where: { id: `${R}-1` } });
      expect([db.name, db.eta, db.address, db.fssaiNumber, db.bannerImage]).toEqual(['RP Kitchen 1', '25-35 mins', 'Ashta road gate 2', null, 'https://img.test/old.jpg']);
      expect(await audits('VENDOR_PROFILE_EDITED')).toHaveLength(0);
      expect((await patchProfile('no-such-vendor', { name: 'RP Ghost' })).status).toBe(404);
      expect((await patchProfile('bad%20id', { name: 'RP Ghost' })).status).toBe(400);
    });

    test('boundary values that must be accepted', async () => {
      const ok = await patchProfile(`${R}-1`, { name: 'RP', address: 'abc', fssaiNumber: '00000000000000', eta: '999-999 min', bannerImage: `https://x.test/${'a'.repeat(480)}.png` });
      expect([ok.status, ok.body.changed]).toEqual([200, true]);
      expect((await patchProfile(`${R}-1`, { name: 'R'.repeat(60), address: 'x'.repeat(140), eta: '5-5 min', fssaiNumber: null })).status).toBe(200);
      expect((await row(`${R}-1`)).fssaiNumber).toBeNull();
    });

    test('NAME_TAKEN: unique among APPROVED restaurants ignoring case and spacing; pending / rejected namesakes and the restaurant itself do not count', async () => {
      const r = await patchProfile(`${R}-1`, { name: '  rp   KITCHEN 2' });
      expect([r.status, r.body.code, r.body.field]).toEqual([409, 'NAME_TAKEN', 'name']);
      expect((await patchProfile(`${R}-1`, { name: 'RP Kitchen 3' })).status).toBe(200); // vendor 3 is PENDING: not a conflict
      expect((await patchProfile(`${R}-1`, { name: 'RP Kitchen 4' })).status).toBe(200); // vendor 4 is REJECTED
      expect((await patchProfile(`${R}-1`, { name: 'rp kitchen 4', address: 'Another address' })).body.changed).toBe(true); // own name in other case
      expect((await row(`${R}-1`)).name).toBe('rp kitchen 4');
      // two parallel renames of two restaurants to the same free name: exactly one wins
      const rs = await Promise.all([patchProfile(`${R}-1`, { name: 'RP Contested' }), patchProfile(`${R}-2`, { name: 'rp  contested' })]);
      expect(rs.map((x) => x.status).sort()).toEqual([200, 409]);
      const names = (await prisma.vendor.findMany({ where: { id: { in: [`${R}-1`, `${R}-2`] } } })).map((v) => v.name.toLowerCase().replace(/\s+/g, ' '));
      expect(names.filter((x) => x === 'rp contested')).toHaveLength(1);
    });

    test('categories: max 6, order = position (first is the main one), 0 allowed, only active restaurant categories can be ADDED but existing ones may stay', async () => {
      const cats = await Promise.all(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map((x) => mkCat(x)));
      const six = await patchProfile(`${R}-1`, { cuisineIds: cats.slice(0, 6).map((c) => c.id) });
      expect([six.status, six.body.data.cuisines.length]).toEqual([200, 6]);
      const seven = await patchProfile(`${R}-1`, { cuisineIds: cats.map((c) => c.id) });
      expect([seven.status, seven.body.code, seven.body.field]).toEqual([400, 'TOO_MANY_CATEGORIES', 'cuisineIds']);
      expect((await row(`${R}-1`)).cuisines).toHaveLength(6);
      const none = await patchProfile(`${R}-1`, { cuisineIds: [] });
      expect([none.status, none.body.data.category, none.body.data.cuisines, none.body.data.tags]).toEqual([200, 'Campus kitchen', [], []]);

      // a category that was hidden / made dish-only later: it can stay on the restaurants that have it, nobody can add it
      await patchProfile(`${R}-1`, { cuisineIds: [cats[0].id, cats[1].id] });
      await request.patch(`/api/admin/categories/${cats[0].id}`).set(H(tAdmin)).send({ isActive: false });
      await request.patch(`/api/admin/categories/${cats[2].id}`).set(H(tAdmin)).send({ forRestaurants: false });
      const keep = await patchProfile(`${R}-1`, { cuisineIds: [cats[1].id, cats[0].id], address: 'Kept the hidden one' });
      expect([keep.status, keep.body.data.tags]).toEqual([200, [`${P} C2`, `${P} C1`]]);
      const addHidden = await patchProfile(`${R}-2`, { cuisineIds: [cats[0].id] });
      expect([addHidden.status, addHidden.body.code]).toEqual([400, 'CATEGORY_NOT_AVAILABLE']);
      const addDishOnly = await patchProfile(`${R}-1`, { cuisineIds: [cats[1].id, cats[2].id] });
      expect([addDishOnly.status, addDishOnly.body.code]).toEqual([400, 'CATEGORY_NOT_AVAILABLE']);
      expect((await row(`${R}-2`)).cuisines).toHaveLength(0);
      // a deleted category (an unknown id) is refused with a message that says what to do
      const gone = await mkCat('Gone');
      await request.delete(`/api/admin/categories/${gone.id}`).set(H(tAdmin));
      const unk = await patchProfile(`${R}-2`, { cuisineIds: [gone.id] });
      expect([unk.status, unk.body.code]).toEqual([400, 'CATEGORY_UNKNOWN']);
      expect(unk.body.message).toMatch(/Reload the list/);
    });

    test('banner: null resets to the default banner (and sending the default again is a no-op)', async () => {
      expect(DEFAULT_BANNER_URL).toBe(DEFAULT_BANNER); // the two copies of the constant must never drift
      const r = await patchProfile(`${R}-1`, { bannerImage: null });
      expect([r.status, r.body.changed, r.body.data.bannerImage]).toEqual([200, true, DEFAULT_BANNER]);
      expect((await patchProfile(`${R}-1`, { bannerImage: null })).body.changed).toBe(false);
      expect((await audits('VENDOR_PROFILE_EDITED'))[0].summary).toContain('banner reset to the default');
    });

    test('an old ETA spelling ("25-35 mins") that is sent back unchanged does not fail the save; a changed one must match the format', async () => {
      const r = await patchProfile(`${R}-1`, { name: 'RP Keeps ETA', eta: '25-35 mins' });
      expect([r.status, r.body.changed]).toEqual([200, true]);
      expect((await row(`${R}-1`)).eta).toBe('25-35 mins');
      expect((await patchProfile(`${R}-1`, { eta: '25-36 mins' })).status).toBe(400);
    });

    test('only ADMIN: no token 401, student / restaurant owner (also of this very restaurant) 403, nothing changes; orders are not touched by a rename', async () => {
      const body = { name: 'RP Hijacked' };
      expect((await request.patch(`/api/admin/vendors/${R}-1/profile`).send(body)).status).toBe(401);
      for (const t of [tStudent, tOwner, tOwner2]) expect((await patchProfile(`${R}-1`, body, t)).status).toBe(403);
      expect((await row(`${R}-1`)).name).toBe('RP Kitchen 1');
      const order = await prisma.order.create({ data: { id: `rp-o-${randomUUID().slice(0, 6)}`, customerId: 'usr-1', vendorId: `${R}-1`, totalAmount: 100, dropoffHostel: 'BH2', status: 'DELIVERED', paymentStatus: 'PAID' } });
      await patchProfile(`${R}-1`, { name: 'RP Renamed After Order' });
      const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after).toEqual(order);
      await prisma.order.delete({ where: { id: order.id } });
    });

    test('rate limited per admin (rule ADMIN_VENDOR_PROFILE_WRITE)', async () => {
      process.env.RL_ADMIN_VENDOR_PROFILE_WRITE_MAX = '3';
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await patchProfile(`${R}-1`, { eta: `${i + 1}0-${i + 2}0 min` })).status);
      expect(codes).toEqual([200, 200, 200, 429]);
    });
  });

  // =========================================================================================
  describe('creating a restaurant: cuisineIds, the old free text, or nothing', () => {
    const adminCreate = (extra: Record<string, unknown>) =>
      request.post('/api/admin/partners').set(H(tAdmin)).send({ role: 'VENDOR', name: 'Owner Person', phone: phone().replace('+91 ', ''), password: PW, restaurantName: `RP New ${randomUUID().slice(0, 5)}`, address: 'Ashta road, near gate 2', ...extra });
    const track = (r: supertest.Response) => { if (r.body.profileId) created.push(r.body.profileId); return r; };

    test('POST /admin/partners with cuisineIds: linked in order, Vendor.category derived (the free text is ignored)', async () => {
      const [a, b] = [await mkCat('Roll'), await mkCat('Wrap')];
      const r = track(await adminCreate({ cuisineIds: [b.id, a.id], category: 'Ignored text' }));
      expect(r.status).toBe(201);
      const v = await row(r.body.profileId);
      expect([v.category, v.cuisines.map((l) => l.category.name), v.approvalStatus]).toEqual([`${P} Wrap • ${P} Roll`, [`${P} Wrap`, `${P} Roll`], 'APPROVED']);
    });

    test('bad cuisineIds are a 400 BEFORE anything is created (no orphan owner account), also for a hidden category', async () => {
      const hidden = await mkCat('Hidden');
      await request.patch(`/api/admin/categories/${hidden.id}`).set(H(tAdmin)).send({ isActive: false });
      const ph = phone().replace('+91 ', '');
      for (const cuisineIds of ['x', ['no-such'], [hidden.id], Array.from({ length: 7 }, (_, i) => `id${i}`)]) {
        const r = await adminCreate({ cuisineIds, phone: ph });
        expect([JSON.stringify(cuisineIds).slice(0, 20), r.status]).toEqual([JSON.stringify(cuisineIds).slice(0, 20), 400]);
      }
      expect(await prisma.user.count({ where: { phone: { endsWith: ph.slice(-10) } } })).toBe(0);
    });

    test('the old free text still works: known words are matched ignoring case, unknown words become restaurant-only categories (not on Home), the string is tidied', async () => {
      const known = await mkCat('Known', { showOnHome: true });
      const r = track(await adminCreate({ category: `${P.toLowerCase()} known • ZPlegacy one, ZPlegacy two | zplegacy ONE ` }));
      expect(r.status).toBe(201);
      const v = await row(r.body.profileId);
      expect(v.category).toBe(`${P} Known • ZPlegacy one • ZPlegacy two`);
      expect(v.cuisines.map((l) => l.category.name)).toEqual([`${P} Known`, 'ZPlegacy one', 'ZPlegacy two']);
      expect(v.cuisines[0].categoryId).toBe(known.id);
      const made = await prisma.category.findFirstOrThrow({ where: { name: 'ZPlegacy one' } });
      expect(made).toMatchObject({ forRestaurants: true, forDishes: false, showOnHome: false, isActive: true, slug: 'zplegacy-one' });
      expect((await prisma.category.findFirstOrThrow({ where: { name: `${P} Known` } })).showOnHome).toBe(true); // untouched
      // the same text again reuses the categories (no second "ZPlegacy one")
      track(await adminCreate({ category: 'ZPlegacy one' }));
      expect(await prisma.category.count({ where: { slug: 'zplegacy-one' } })).toBe(1);
    });

    test('no category at all keeps the old default text and creates no category; text that matches only hidden categories is kept as typed', async () => {
      const total = await prisma.category.count();
      const r = track(await adminCreate({}));
      expect((await row(r.body.profileId)).category).toBe('Campus kitchen');
      expect((await row(r.body.profileId)).cuisines).toHaveLength(0);
      expect(await prisma.category.count()).toBe(total);
      const hid = await mkCat('Hid');
      await request.patch(`/api/admin/categories/${hid.id}`).set(H(tAdmin)).send({ isActive: false });
      const t = track(await adminCreate({ category: `${P} Hid` }));
      expect([(await row(t.body.profileId)).category, (await row(t.body.profileId)).cuisines.length]).toEqual([`${P} Hid`, 0]);
    });

    test('POST /vendors (the older admin endpoint): cuisineIds, the free text and the default, with cuisines + tags in the answer', async () => {
      const [a, b] = [await mkCat('Pizza'), await mkCat('Pasta')];
      const mk = async (body: Record<string, unknown>) => {
        const r = await request.post('/api/vendors').set(H(tAdmin)).send({ name: `RP Legacy ${randomUUID().slice(0, 5)}`, ...body });
        if (r.body.data?.id) created.push(r.body.data.id);
        return r;
      };
      const byIds = await mk({ cuisineIds: [b.id, a.id], category: 'ignored' });
      expect(byIds.status).toBe(201);
      expect(byIds.body.data).toMatchObject({ category: `${P} Pasta • ${P} Pizza`, tags: [`${P} Pasta`, `${P} Pizza`] });
      expect(byIds.body.data.cuisines.map((c: any) => c.id)).toEqual([b.id, a.id]);
      expect(Array.isArray(byIds.body.data.menuItems)).toBe(true);
      const text = await mk({ category: `${P} pizza • ${P} Pasta` });
      expect(text.body.data.category).toBe(`${P} Pizza • ${P} Pasta`);
      const none = await mk({});
      expect([none.body.data.category, none.body.data.cuisines, none.body.data.tags]).toEqual(['North Indian • Campus Dhaba', [], []]); // the old default text, as before
      expect((await mk({ cuisineIds: ['nope'] })).status).toBe(400);
      expect((await mk({ category: 5 })).status).toBe(400);
      expect((await mk({ category: 'x'.repeat(61) })).status).toBe(400);
    });
  });

  // =========================================================================================
  describe('payloads: cuisines + tags added, every old field still there, owners never see commission or price data', () => {
    test('GET /vendors and /vendors/:id for a customer, the owner and the admin', async () => {
      const [a, b] = [await mkCat('Pay1'), await mkCat('Pay2')];
      await patchProfile(`${R}-1`, { cuisineIds: [a.id, b.id], fssaiNumber: '12345678901234' });
      await request.patch(`/api/admin/catalog/x`).set(H(tAdmin)).send({}); // (route exists; just a warm-up)
      const dish = await request.post('/api/admin/catalog').set(H(tAdmin)).send({ vendorId: `${R}-1`, name: 'RP Dish', vendorPrice: 100, commissionType: 'PERCENT', commissionValue: 10 });
      expect(dish.status).toBe(201);

      const OLD_PUBLIC = ['id', 'name', 'category', 'rating', 'totalRatingsCount', 'eta', 'bannerImage', 'address', 'isAcceptingOrders', 'lat', 'lng', 'menuItems'];
      for (const t of [undefined, tStudent]) {
        const list = await (t ? request.get('/api/vendors').set(H(t)) : request.get('/api/vendors'));
        const mine = list.body.data.find((v: any) => v.id === `${R}-1`);
        expect(Object.keys(mine).sort()).toEqual([...OLD_PUBLIC, 'cuisines', 'tags'].sort());
        expect(mine.cuisines).toEqual([{ id: a.id, name: `${P} Pay1`, icon: 'restaurant' }, { id: b.id, name: `${P} Pay2`, icon: 'restaurant' }]);
        expect(mine.tags).toEqual([`${P} Pay1`, `${P} Pay2`]);
        expect(mine.category).toBe(`${P} Pay1 • ${P} Pay2`);
        expect(Object.keys(mine.menuItems[0]).sort()).toEqual(['id', 'vendorId', 'name', 'price', 'category', 'categoryId', 'description', 'imageUrl', 'isAvailable', 'isVeg', 'rating', 'ratingCount'].sort());
        expect(mine.menuItems[0].price).toBe(110); // the customer price, as before
        const one = await (t ? request.get(`/api/vendors/${R}-1`).set(H(t)) : request.get(`/api/vendors/${R}-1`));
        expect(one.body.data.tags).toEqual(mine.tags);
        expect(one.body.data.menu).toEqual(one.body.data.menuItems);
        expect(JSON.stringify(list.body)).not.toMatch(/commission|vendorPrice|fssaiNumber|userId/);
      }
      // another restaurant's owner sees the public shape of this one
      const other = (await request.get('/api/vendors').set(H(tOwner2))).body.data.find((v: any) => v.id === `${R}-1`);
      expect(Object.keys(other).sort()).toEqual([...OLD_PUBLIC, 'cuisines', 'tags'].sort());
      // restaurants without categories still carry the two fields
      const bare = (await request.get('/api/vendors')).body.data.find((v: any) => v.id === `${R}-2`);
      expect([bare.cuisines, bare.tags]).toEqual([[], []]);

      // the owner: own full row with cuisines + tags, still no commission or customer price anywhere
      for (const path of [`/api/vendors/${R}-1`, '/api/vendors', `/api/menus/${R}-1`]) {
        const r = await request.get(path).set(H(tOwner));
        expect([path, r.status]).toEqual([path, 200]);
        const keys = keysDeep(r.body);
        for (const f of FORBIDDEN_FOR_OWNER) expect([path, f, keys.has(f)]).toEqual([path, f, false]);
      }
      const own = (await request.get(`/api/vendors/${R}-1`).set(H(tOwner))).body.data;
      expect(own).toMatchObject({ userId: OWN.id, fssaiNumber: '12345678901234', tags: [`${P} Pay1`, `${P} Pay2`] });
      expect(own.menuItems[0]).toMatchObject({ price: 100, status: 'LIVE' }); // ITS price, not 110
      expect(own.menuItems[0].categoryId).toEqual(expect.any(String));

      // the admin keeps the commission fields
      const adminView = (await request.get(`/api/vendors/${R}-1`).set(H(tAdmin))).body.data;
      expect(adminView).toHaveProperty('commissionType');
      expect(adminView.cuisines).toHaveLength(2);
      expect(adminView.menuItems[0]).toHaveProperty('vendorPrice');
    });

    test('partner sessions carry cuisines + tags too (login, /partner/me); the other fields are unchanged and no commission leaks', async () => {
      const a = await mkCat('Sess');
      const ph = phone().replace('+91 ', '');
      const cr = await request.post('/api/admin/partners').set(H(tAdmin)).send({ role: 'VENDOR', name: 'Session Owner', phone: ph, password: PW, restaurantName: `RP Session ${randomUUID().slice(0, 5)}`, address: 'Ashta road, near gate 2', cuisineIds: [a.id] });
      created.push(cr.body.profileId);
      const login = await request.post('/api/auth/partner-login').send({ phone: ph, password: PW, role: 'VENDOR' });
      expect(login.status).toBe(200);
      expect(login.body.vendor).toMatchObject({ id: cr.body.profileId, category: `${P} Sess`, tags: [`${P} Sess`], cuisines: [{ id: a.id, name: `${P} Sess`, icon: 'restaurant' }] });
      for (const k of ['id', 'name', 'isAcceptingOrders', 'approvalStatus', 'rejectionReason', 'category', 'address', 'fssaiNumber', 'hasLocation', 'lat', 'lng']) expect(login.body.vendor).toHaveProperty(k);
      expect(keysDeep(login.body).has('commissionType')).toBe(false);
      const me = await request.get('/api/partner/me').set('Authorization', `Bearer ${login.body.token}`);
      expect(me.body.vendor).toMatchObject({ tags: [`${P} Sess`] });
      expect(keysDeep(me.body).has('commissionValue')).toBe(false);
      const apps = await request.get('/api/admin/applications?status=ALL').set(H(tAdmin));
      expect(apps.body.data.find((x: any) => x.id === cr.body.profileId).vendor.tags).toEqual([`${P} Sess`]);
    });
  });
});
