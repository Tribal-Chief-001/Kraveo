/**
 * Fixes from the independent review of Docs/23 (Docs/bughunt/TAXONOMY_review.md): legacy names that cannot be re-saved (#1), re-application of a
 * restaurant that has cuisines (#4), cheap 400 for a huge category text (#5), the six names of the old restaurant app (#8), hidden / direction
 * characters and NFC in labels (#9), legacy dishes without categoryId (#10), reorder racing a delete, the import body parsed only after
 * authentication, the public list cache / counts / limiter (#12), and the storm without a single deadlock.
 * Real PostgreSQL, real HTTP. Every category made here starts with "ZR".
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers, ensureTestCategories } from '../harness/db';
import { getStudentToken, getVendorToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { invalidatePublicCategories, LEGACY_PROTECTED_SLUGS } from '../../src/services/categories';

jest.setTimeout(180_000);

const OWN1 = { id: 'usr-rf-o1', phone: '+91 9999851111' };
const OWN3 = { id: 'usr-rf-o3', phone: '+91 9999853333' };
const V = ['rf-ven-1', 'rf-ven-2', 'rf-ven-3', 'rf-ven-4'];
const P = 'ZR';
const tAdmin = getAdminToken();
const tStudent = getStudentToken();
const tOwner1 = getVendorToken(OWN1.id, OWN1.phone);
const tOwner3 = getVendorToken(OWN3.id, OWN3.phone);
const H = (t: string) => getAuthHeader(t);
const SIX = ['Main Course', 'Breads', 'Beverages', 'Snacks', 'Desserts', 'Fast Food'];

describe('Review fixes for the managed categories', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const post = (path: string, body: unknown = {}, t = tAdmin) => request.post(path).set(H(t)).send(body as any);
  const patch = (path: string, body: unknown = {}, t = tAdmin) => request.patch(path).set(H(t)).send(body as any);
  const del = (path: string, t = tAdmin) => request.delete(path).set(H(t));
  const mk = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await post('/api/admin/categories', { name: `${P} ${name}`, ...extra });
    expect([name, r.status]).toEqual([name, 201]);
    return r.body.data as any;
  };
  const bySlug = (slug: string) => prisma.category.findUniqueOrThrow({ where: { slug } });
  const audits = (action: string) => prisma.adminAuditLog.findMany({ where: { action } });
  const tag = async (vendorId: string, cats: { id: string; name: string }[]) => {
    await prisma.vendorCategory.deleteMany({ where: { vendorId } });
    for (const [position, c] of cats.entries()) await prisma.vendorCategory.create({ data: { vendorId, categoryId: c.id, position } });
    await prisma.vendor.update({ where: { id: vendorId }, data: { category: cats.map((c) => c.name).join(' • ') || 'Campus kitchen' } });
  };
  let n = 0;
  const dish = (vendorId: string, cat: { id: string; name: string } | null, extra: Record<string, unknown> = {}) =>
    prisma.menuItem.create({ data: { id: `rf-d-${++n}-${randomUUID().slice(0, 6)}`, vendorId, name: `ZR Dish ${n}`, price: 100, vendorPrice: 100, category: cat?.name ?? 'Legacy words', categoryId: cat?.id ?? null, description: '', imageUrl: '', ...extra } });
  const wipe = async () => {
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: V } } });
    await prisma.vendorCategory.deleteMany({ where: { OR: [{ vendorId: { in: V } }, { category: { name: { startsWith: P } } }] } });
    await prisma.menuItem.updateMany({ where: { category: { startsWith: P } }, data: { categoryId: null } });
    await prisma.category.deleteMany({ where: { name: { startsWith: P } } });
    await prisma.vendor.updateMany({ where: { id: { in: V } }, data: { category: 'Test', name: undefined } });
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    for (const u of [{ id: OWN1.id, name: 'RF Owner 1', phone: OWN1.phone, role: Role.VENDOR }, { id: OWN3.id, name: 'RF Owner 3', phone: OWN3.phone, role: Role.VENDOR }]) {
      await prisma.user.upsert({ where: { id: u.id }, update: {}, create: u });
    }
    for (const [i, id] of V.entries()) {
      const status = (['APPROVED', 'APPROVED', 'PENDING', 'SUSPENDED'] as const)[i];
      await prisma.vendor.upsert({
        where: { id },
        update: { approvalStatus: status, userId: i === 0 ? OWN1.id : i === 2 ? OWN3.id : null },
        create: { id, userId: i === 0 ? OWN1.id : i === 2 ? OWN3.id : null, name: `RF Kitchen ${i + 1}`, category: 'Test', address: 'Gate', bannerImage: '', approvalStatus: status },
      });
    }
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    delete process.env.ALLOW_LEGACY_CATEGORY_CHANGES;
    delete process.env.CATEGORIES_CACHE_TTL_MS;
    invalidatePublicCategories();
    __resetRateLimits();
    await wipe();
    await ensureTestCategories();
    await prisma.vendor.updateMany({ where: { id: 'rf-ven-3' }, data: { approvalStatus: 'PENDING' } });
    await prisma.adminAuditLog.deleteMany({});
  });

  afterAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    delete process.env.ALLOW_LEGACY_CATEGORY_CHANGES;
    delete process.env.CATEGORIES_CACHE_TTL_MS;
    invalidatePublicCategories();
    await wipe();
    await prisma.vendor.deleteMany({ where: { id: { in: V } } });
    await ensureTestCategories();
    await prisma.adminAuditLog.deleteMany({});
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('#1 a legacy name that the backfill made can be sent back unchanged', () => {
    test('long, non-ASCII, bracketed names: other fields can be saved with `name` in the body; only a CHANGED name is held to the strict rules', async () => {
      const legacyName = 'ZR Rolls (Veg) & Café, extra long legacy name 123';
      expect(legacyName.length).toBeGreaterThan(30);
      const c = await prisma.category.create({ data: { name: legacyName, slug: 'zr-rolls-veg-caf-extra-long-legacy-name-123', sortOrder: 900, forDishes: true, forRestaurants: true } });
      await dish('rf-ven-1', c);
      const same = await patch(`/api/admin/categories/${c.id}`, { name: legacyName, showOnHome: true, icon: 'roll', nameHi: 'रोल', sortOrder: 5 });
      expect([same.status, same.body.changed, same.body.data.name]).toEqual([200, true, legacyName]);
      expect(same.body.data).toMatchObject({ showOnHome: true, icon: 'roll', nameHi: 'रोल', sortOrder: 5 });
      // spacing-only differences are the same name too (no cascade, no rename audit)
      const spaced = await patch(`/api/admin/categories/${c.id}`, { name: `  ZR  Rolls (Veg) & Café,  extra long legacy name 123 `, icon: 'roll' });
      expect([spaced.status, spaced.body.changed]).toEqual([200, false]);
      expect(await audits('CATEGORY_EDITED')).toHaveLength(1); // only the first call changed anything
      // a CHANGED name is validated strictly
      for (const name of ['ZR Café!', 'ZR ' + 'x'.repeat(40), 'Z', 5]) {
        const r = await patch(`/api/admin/categories/${c.id}`, { name, showOnHome: false });
        expect([String(name).slice(0, 12), r.status, r.body.field]).toEqual([String(name).slice(0, 12), 400, 'name']);
      }
      expect((await prisma.category.findUniqueOrThrow({ where: { id: c.id } })).showOnHome).toBe(true); // the refused calls changed nothing
      const renamed = await patch(`/api/admin/categories/${c.id}`, { name: 'ZR Rolls Veg' });
      expect([renamed.status, renamed.body.changed]).toEqual([200, true]);
      expect((await prisma.menuItem.findFirstOrThrow({ where: { categoryId: c.id } })).category).toBe('ZR Rolls Veg');
    });
  });

  // =========================================================================================
  describe('#4 an owner who re-sends the application keeps Vendor.category, the links and the tags in step', () => {
    const putApp = (body: unknown, t = tOwner3) => request.put('/api/partner/application').set(H(t)).send(body as any);
    const vendor = () => prisma.vendor.findUniqueOrThrow({ where: { id: 'rf-ven-3' }, include: { cuisines: { orderBy: { position: 'asc' }, include: { category: true } } } });
    const adminTags = async () => (await request.get('/api/vendors/rf-ven-3').set(H(tAdmin))).body.data.tags as string[];

    test('the string shown to the owner is longer than 60 characters: sending it back (cut to 60 by the old app, or whole) never cuts the stored string and keeps the links', async () => {
      const cats = [await mk('North Indian Classics'), await mk('South Indian Specials'), await mk('Chinese Street Food'), await mk('Frozen Desserts')];
      await tag('rf-ven-3', cats);
      const full = (await vendor()).category;
      expect(full.length).toBeGreaterThan(60);
      for (const echo of [full.slice(0, 60), full]) {
        const r = await putApp({ category: echo, address: 'Ashta road, new gate' });
        expect(r.status).toBe(200);
        const v = await vendor();
        expect([v.category, v.cuisines.map((l) => l.category.name), v.address]).toEqual([full, cats.map((c) => c.name), 'Ashta road, new gate']);
        expect(await adminTags()).toEqual(cats.map((c) => c.name));
      }
      const noText = await putApp({ address: 'Ashta road, gate 3' });
      expect(noText.status).toBe(200);
      expect((await vendor()).category).toBe(full);
      expect(noText.body.vendor.category).toBe(full);
      expect(noText.body.vendor.tags).toEqual(cats.map((c) => c.name));
    });

    test('changed text goes through the same parser as creation: known words link (ignoring case), unknown words become restaurant-only categories, the string is derived from the links', async () => {
      const pizza = await mk('Pizza');
      await tag('rf-ven-3', [await mk('Old One'), await mk('Old Two')]);
      const r = await putApp({ category: `${P.toLowerCase()} pizza, ZR Calzone | zr PIZZA` });
      expect(r.status).toBe(200);
      const v = await vendor();
      expect(v.cuisines.map((l) => l.category.name)).toEqual([`${P} Pizza`, 'ZR Calzone']);
      expect(v.cuisines[0].categoryId).toBe(pizza.id);
      expect(v.category).toBe(`${P} Pizza • ZR Calzone`);
      expect(await adminTags()).toEqual([`${P} Pizza`, 'ZR Calzone']);
      expect(r.body.vendor).toMatchObject({ category: `${P} Pizza • ZR Calzone`, tags: [`${P} Pizza`, 'ZR Calzone'] });
      expect(await prisma.category.findFirstOrThrow({ where: { name: 'ZR Calzone' } })).toMatchObject({ forRestaurants: true, forDishes: false, showOnHome: false });
    });

    test('text that matches nothing usable (only a hidden category) clears the links and is kept as typed: string and links still agree', async () => {
      const hidden = await mk('Hidden');
      await patch(`/api/admin/categories/${hidden.id}`, { isActive: false });
      await tag('rf-ven-3', [await mk('Was Linked')]);
      const r = await putApp({ category: 'ZR Hidden' });
      expect(r.status).toBe(200);
      const v = await vendor();
      expect([v.category, v.cuisines.length, await adminTags()]).toEqual(['ZR Hidden', 0, []]);
    });

    test('a restaurant with no links yet whose text changes gets links from the new text; unchanged text writes nothing to the categories', async () => {
      await prisma.vendor.update({ where: { id: 'rf-ven-3' }, data: { category: 'ZR Plain' } });
      const total = await prisma.category.count();
      expect((await putApp({ category: 'ZR Plain' })).status).toBe(200);
      expect(await prisma.category.count()).toBe(total);
      expect((await vendor()).cuisines).toHaveLength(0);
      expect((await putApp({ category: 'ZR Plain, ZR Spicy' })).status).toBe(200);
      expect((await vendor()).cuisines.map((l) => l.category.name)).toEqual(['ZR Plain', 'ZR Spicy']);
    });

    test('the application call is limited per owner (rule PARTNER_APPLICATION_WRITE), so it cannot be used to fill the category table', async () => {
      process.env.RL_PARTNER_APPLICATION_WRITE_MAX = '2';
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await putApp({ category: `ZR Flood ${i}` })).status);
      expect(codes).toEqual([200, 200, 429]);
    });
  });

  // =========================================================================================
  describe('#5 a huge or non-text category is a cheap 400 in every writer', () => {
    test('bulk SET_CATEGORY with a 95 KB category answers 400 at once (no Levenshtein over 95,000 characters x every category)', async () => {
      const d = await dish('rf-ven-1', await mk('Target'));
      const started = Date.now();
      const r = await post('/api/admin/catalog/bulk', { ids: [d.id], action: 'SET_CATEGORY', category: 'x'.repeat(95_000) });
      expect(Date.now() - started).toBeLessThan(1500);
      expect([r.status, r.body.code, r.body.field]).toEqual([400, 'CATEGORY_UNKNOWN', 'category']);
      for (const category of [123, ['a'], { a: 1 }, true]) {
        const x = await post('/api/admin/catalog/bulk', { ids: [d.id], action: 'SET_CATEGORY', category });
        expect([JSON.stringify(category), x.status]).toEqual([JSON.stringify(category), 400]);
      }
      expect((await post('/api/admin/catalog/bulk', { ids: [d.id], action: 'SET_CATEGORY', categoryId: 5 })).status).toBe(400);
      const long41 = await post('/api/admin/catalog/bulk', { ids: [d.id], action: 'SET_CATEGORY', category: 'y'.repeat(41) });
      expect([long41.status, long41.body.code]).toEqual([400, 'CATEGORY_UNKNOWN']);
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: d.id } })).category).toBe('ZR Target');
    });

    test('the single writers (admin create / edit, restaurant app) and an import row refuse it just as fast', async () => {
      const big = 'z'.repeat(95_000);
      const t0 = Date.now();
      const a = await post('/api/admin/catalog', { vendorId: 'rf-ven-1', name: 'Big', vendorPrice: 10, category: big });
      const b = await request.post('/api/vendors/rf-ven-1/items').set(H(tOwner1)).send({ name: 'Big', price: 10, category: big });
      const d = await dish('rf-ven-1', await mk('Edit'));
      const c = await patch(`/api/admin/catalog/${d.id}`, { category: big });
      const imp = await post('/api/admin/vendors/rf-ven-1/menu-import', { rows: [{ name: 'Big dish', category: big, vendorPrice: 10 }] });
      expect(Date.now() - t0).toBeLessThan(3000);
      expect([a.status, b.status, c.status]).toEqual([400, 400, 400]);
      expect(imp.body.data.rows[0]).toMatchObject({ action: 'invalid', errors: [{ field: 'category' }] });
    });
  });

  // =========================================================================================
  describe('#8 the six names of the old restaurant app are protected', () => {
    test('rename, hide, dishes-off, merge-away and delete are 409 CATEGORY_PROTECTED; sortOrder / icon / nameHi / showOnHome / forRestaurants / case-only edits stay allowed', async () => {
      const spare = await mk('Spare');
      for (const name of SIX) {
        const slug = name.toLowerCase().replace(/ /g, '-');
        expect(LEGACY_PROTECTED_SLUGS).toContain(slug);
        const c = await bySlug(slug);
        const protectedCall = async (label: string, r: supertest.Response) => {
          expect([name, label, r.status, r.body.code]).toEqual([name, label, 409, 'CATEGORY_PROTECTED']);
          expect(r.body.message).toMatch(/Older restaurant apps still use this name/);
        };
        await protectedCall('rename', await patch(`/api/admin/categories/${c.id}`, { name: `${name} Renamed` }));
        await protectedCall('hide', await patch(`/api/admin/categories/${c.id}`, { isActive: false }));
        await protectedCall('dishes off', await patch(`/api/admin/categories/${c.id}`, { forDishes: false, forRestaurants: true }));
        await protectedCall('merge dry run', await post(`/api/admin/categories/${c.id}/merge`, { intoId: spare.id }));
        await protectedCall('merge', await post(`/api/admin/categories/${c.id}/merge`, { intoId: spare.id, dryRun: false }));
        await protectedCall('delete', await del(`/api/admin/categories/${c.id}`));
        // what is still allowed
        const ok = await patch(`/api/admin/categories/${c.id}`, { sortOrder: c.sortOrder, icon: 'snack', nameHi: 'हिंदी', showOnHome: true, forRestaurants: true });
        expect([name, ok.status]).toEqual([name, 200]);
        const caseOnly = await patch(`/api/admin/categories/${c.id}`, { name: name.toUpperCase() });
        expect([name, caseOnly.status, caseOnly.body.data.slug]).toEqual([name, 200, slug]); // same slug: the old apps still match it
        expect((await patch(`/api/admin/categories/${c.id}`, { name })).status).toBe(200);
        const after = await bySlug(slug);
        expect([after.name, after.isActive, after.forDishes]).toEqual([name, true, true]);
      }
      // merging INTO one of them is fine; hiding / renaming other categories is unaffected
      const x = await mk('Mergeable');
      expect((await post(`/api/admin/categories/${x.id}/merge`, { intoId: (await bySlug('snacks')).id, dryRun: false })).status).toBe(200);
      const y = await mk('Plain');
      expect((await patch(`/api/admin/categories/${y.id}`, { name: 'ZR Plainer', isActive: false })).status).toBe(200);
      // an old restaurant app can still add a dish in each of the six
      for (const name of SIX) expect([name, (await request.post('/api/vendors/rf-ven-1/items').set(H(tOwner1)).send({ name: `ZR ${name}`, price: 10, category: name })).status]).toEqual([name, 201]);
    });

    test('with ALLOW_LEGACY_CATEGORY_CHANGES=1 the same changes are allowed (and are audited); restore afterwards', async () => {
      process.env.ALLOW_LEGACY_CATEGORY_CHANGES = '1';
      let restoreId = '';
      try {
        const c = await bySlug('desserts');
        restoreId = c.id;
        const r = await patch(`/api/admin/categories/${c.id}`, { name: 'Sweet Things' });
        expect([r.status, r.body.code, r.body.data?.name]).toEqual([200, undefined, 'Sweet Things']);
        expect((await patch(`/api/admin/categories/${c.id}`, { isActive: false })).status).toBe(200);
        expect((await patch(`/api/admin/categories/${c.id}`, { isActive: true, forDishes: true })).status).toBe(200);
        expect((await audits('CATEGORY_EDITED')).some((a) => /Sweet Things/.test(a.summary))).toBe(true);
        const gone = await del(`/api/admin/categories/${(await bySlug('fast-food')).id}`);
        expect([gone.body.code === 'CATEGORY_PROTECTED', [200, 409].includes(gone.status)]).toEqual([false, true]); // gone, or refused only because it is in use
      } finally {
        delete process.env.ALLOW_LEGACY_CATEGORY_CHANGES;
        // put the shared test category back by id (its slug was changed by the rename)
        if (restoreId) {
          await prisma.category.update({ where: { id: restoreId }, data: { name: 'Desserts', slug: 'desserts', isActive: true, forDishes: true } });
          await prisma.menuItem.updateMany({ where: { categoryId: restoreId }, data: { category: 'Desserts' } });
        }
        await ensureTestCategories();
      }
      const back = await patch(`/api/admin/categories/${(await bySlug('desserts')).id}`, { name: 'Desserts Again' });
      expect([back.status, back.body.code]).toEqual([409, 'CATEGORY_PROTECTED']); // the guard is back
    });
  });

  // =========================================================================================
  describe('#9 labels: control, zero-width and direction characters are refused, text is NFC, duplicates compare after the same normalisation', () => {
    const BAD = ['a\u200bb', 'a\u202eb', 'a\u2066b', 'a\u200eb', 'a\u2060b', 'a\ufeffb', 'a\u0007b', 'a\u2028b'];

    test('category names (strict) and Hindi names (ZWJ / ZWNJ allowed, the rest refused)', async () => {
      for (const bad of BAD) {
        const r = await post('/api/admin/categories', { name: `ZR ${bad}` });
        expect([JSON.stringify(bad), r.status, r.body.field]).toEqual([JSON.stringify(bad), 400, 'name']);
        const h = await post('/api/admin/categories', { name: 'ZR Hindi', nameHi: `हि${bad}` });
        if (bad === 'a\u200bb' || bad === 'a\u202eb' || bad === 'a\u2066b' || bad === 'a\u200eb' || bad === 'a\u2060b' || bad === 'a\ufeffb' || bad === 'a\u0007b' || bad === 'a\u2028b') expect([JSON.stringify(bad), h.status, h.body.field]).toEqual([JSON.stringify(bad), 400, 'nameHi']);
      }
      const ok = await post('/api/admin/categories', { name: 'ZR Hindi', nameHi: 'क्\u200dष क\u200cा' });
      expect([ok.status, ok.body.data?.nameHi]).toEqual([201, 'क्\u200dष क\u200cा']);
    });

    test('restaurant names and addresses (profile edit and sign-up) refuse them and store NFC', async () => {
      for (const bad of BAD) {
        const r = await patch('/api/admin/vendors/rf-ven-2/profile', { name: `RF ${bad}` });
        expect([JSON.stringify(bad), r.status, r.body.field]).toEqual([JSON.stringify(bad), 400, 'name']);
        expect((await patch('/api/admin/vendors/rf-ven-2/profile', { address: `Gate ${bad}` })).body.field).toBe('address');
      }
      const r = await patch('/api/admin/vendors/rf-ven-2/profile', { name: 'RF Cafe\u0301 Kitchen' });
      expect([r.status, r.body.data.name]).toEqual([200, 'RF Café Kitchen']);
      const signup = await request.post('/api/auth/partner-signup').send({ role: 'VENDOR', name: 'Some Owner', phone: '9999854444', password: 'Str0ng-Passw0rd!', restaurantName: 'Dosa\u202e Hut', category: 'Rolls', address: 'Ashta road, near gate 2' });
      expect([signup.status, signup.body.field]).toEqual([400, 'restaurantName']);
    });

    test('dish names / descriptions / categories on every writer: admin create and edit, restaurant app, import rows', async () => {
      const main = await mk('Main');
      for (const bad of BAD) {
        const a = await post('/api/admin/catalog', { vendorId: 'rf-ven-1', name: `ZR ${bad}`, vendorPrice: 10, category: main.name });
        expect([JSON.stringify(bad), a.status, a.body.field]).toEqual([JSON.stringify(bad), 400, 'name']);
        const b = await request.post('/api/vendors/rf-ven-1/items').set(H(tOwner1)).send({ name: 'ZR ok', price: 10, category: main.name, description: `d ${bad}` });
        expect([JSON.stringify(bad), b.status, b.body.field]).toEqual([JSON.stringify(bad), 400, 'description']);
      }
      const d = await dish('rf-ven-1', main);
      expect((await patch(`/api/admin/catalog/${d.id}`, { name: 'ZR a\u200bb' })).status).toBe(400);
      expect((await patch(`/api/admin/catalog/${d.id}`, { description: 'x\u202ey' })).status).toBe(400);
      const nfc = await post('/api/admin/catalog', { vendorId: 'rf-ven-1', name: 'ZR Cafe\u0301 dish', vendorPrice: 10, category: main.name });
      expect([nfc.status, nfc.body.data.name]).toEqual([201, 'ZR Café dish']);
      const imp = await post('/api/admin/vendors/rf-ven-1/menu-import', { rows: BAD.map((bad) => ({ name: `ZR Row ${bad}`, category: main.name, vendorPrice: 10, description: 'ok' })).concat([{ name: 'ZR Row ok', category: main.name, vendorPrice: 10, description: 'a\u200bb' }]) });
      expect(imp.body.data.rows.map((r: any) => [r.action, r.errors[0]?.field])).toEqual([...BAD.map(() => ['invalid', 'name']), ['invalid', 'description']]);
    });

    test('import duplicates are found after the same normalisation: a stored name with a zero-width character, a decomposed accent, other case and spacing', async () => {
      const main = await mk('Main');
      await dish('rf-ven-2', main, { name: 'ZR Dosa\u200b' }); // stored before the rule existed
      await dish('rf-ven-2', main, { name: 'ZR Café' });
      await dish('rf-ven-2', main, { name: 'ZR  Tea   House' });
      const r = await post('/api/admin/vendors/rf-ven-2/menu-import', { rows: [{ name: 'zr dosa', category: main.name, vendorPrice: 10 }, { name: 'ZR Cafe\u0301', category: main.name, vendorPrice: 10 }, { name: 'zr TEA house', category: main.name, vendorPrice: 10 }, { name: 'ZR Fresh', category: main.name, vendorPrice: 10 }] });
      expect(r.body.data.rows.map((x: any) => [x.action, x.reason ?? null])).toEqual([['skip', 'DUPLICATE_EXISTS'], ['skip', 'DUPLICATE_EXISTS'], ['skip', 'DUPLICATE_EXISTS'], ['create', null]]);
      // inside the file: decomposed and composed spellings of one name are the same dish
      const inFile = await post('/api/admin/vendors/rf-ven-2/menu-import', { rows: [{ name: 'ZR Cre\u0301pe', category: main.name, vendorPrice: 10 }, { name: 'ZR Cr\u00e9pe', category: main.name, vendorPrice: 10 }] });
      expect(inFile.body.data.rows.map((x: any) => x.action)).toEqual(['create', 'invalid']);
    });
  });

  // =========================================================================================
  describe('#10 an old dashboard that sends the whole legacy dish back', () => {
    test('categoryId NULL + the same category text never fails: slug-less text, text no category matches, text of a hidden category', async () => {
      const hidden = await mk('HiddenOne');
      await patch(`/api/admin/categories/${hidden.id}`, { isActive: false });
      const cases: [string, string, string | null][] = [['मुख्य', 'मुख्य', null], ['Some Old Words', 'Some Old Words', null], ['!!!', '!!!', null], ['ZR HiddenOne', 'ZR HiddenOne', hidden.id]];
      for (const [text, expectText, linked] of cases) {
        const d = await prisma.menuItem.create({ data: { id: `rf-leg-${randomUUID().slice(0, 6)}`, vendorId: 'rf-ven-1', name: 'ZR Legacy', price: 50, vendorPrice: 50, category: text, description: '', imageUrl: '' } });
        const r = await patch(`/api/admin/catalog/${d.id}`, { name: 'ZR Legacy edited', category: text, isVeg: false });
        expect([text, r.status]).toEqual([text, 200]);
        const row = await prisma.menuItem.findUniqueOrThrow({ where: { id: d.id } });
        expect([text, row.category, row.categoryId, row.name]).toEqual([text, expectText, linked, 'ZR Legacy edited']);
        // sending ANOTHER text is still held to the rule
        expect((await patch(`/api/admin/catalog/${d.id}`, { category: 'Nonexistent Words' })).body.code).toBe('CATEGORY_UNKNOWN');
      }
      // a legacy dish whose text matches an active category gets linked
      const main = await mk('MainLink');
      const d2 = await prisma.menuItem.create({ data: { id: `rf-leg-${randomUUID().slice(0, 6)}`, vendorId: 'rf-ven-1', name: 'ZR Legacy 2', price: 50, vendorPrice: 50, category: ' zr mainlink', description: '', imageUrl: '' } });
      const r2 = await patch(`/api/admin/catalog/${d2.id}`, { category: ' zr mainlink' });
      expect([r2.status, r2.body.data.categoryId, r2.body.data.category]).toEqual([200, main.id, 'ZR MainLink']);
    });
  });

  // =========================================================================================
  describe('#12 reorder / import / public list', () => {
    test('reorder racing deletes of the categories it lists: 200 or a clean 400 / 404, never a 500; the order that results is consistent', async () => {
      for (let round = 0; round < 5; round++) {
        const cats = [await mk(`R${round}a`), await mk(`R${round}b`), await mk(`R${round}c`), await mk(`R${round}d`)];
        const rs = await Promise.all([
          ...Array.from({ length: 4 }, (_, i) => post('/api/admin/categories/reorder', { ids: [...cats].reverse().map((c) => c.id).slice(0, 4 - (i % 2)) })),
          del(`/api/admin/categories/${cats[0].id}`), del(`/api/admin/categories/${cats[3].id}`),
          ...Array.from({ length: 2 }, () => post('/api/admin/categories/reorder', { ids: cats.map((c) => c.id) })),
        ]);
        expect(rs.filter((r) => ![200, 400, 404, 409].includes(r.status)).map((r) => [r.status, r.body])).toEqual([]);
        expect(rs.filter((r) => r.status === 400).every((r) => r.body.code === 'CATEGORY_UNKNOWN')).toBe(true);
        const left = await prisma.category.findMany({ where: { name: { startsWith: `ZR R${round}` } }, orderBy: { sortOrder: 'asc' } });
        expect(left.length).toBe(2);
        expect(new Set(left.map((c) => c.sortOrder)).size).toBe(2);
      }
    });

    test('the menu import checks authentication BEFORE reading its 400 KB body: an anonymous or non-admin caller is refused cheaply', async () => {
      const body = { rows: [{ name: 'x', category: 'Main Course', vendorPrice: 5, description: 'd'.repeat(250_000) }] };
      expect(JSON.stringify(body).length).toBeGreaterThan(250_000);
      const t0 = Date.now();
      const anon = await request.post('/api/admin/vendors/rf-ven-1/menu-import').send(body);
      const student = await request.post('/api/admin/vendors/rf-ven-1/menu-import').set(H(tStudent)).send(body);
      const owner = await request.post('/api/admin/vendors/rf-ven-1/menu-import').set(H(tOwner1)).send(body);
      expect([anon.status, student.status, owner.status]).toEqual([401, 403, 403]);
      expect(Date.now() - t0).toBeLessThan(3000);
      // and the admin still gets the 400 KB parser (413 above it, success below it)
      expect((await post('/api/admin/vendors/rf-ven-1/menu-import', { rows: [{ name: 'ZR Big', category: 'Main Course', vendorPrice: 5, description: 'd'.repeat(280) }], pad: 'p'.repeat(150_000) })).status).toBe(400); // unknown key `pad`, but PARSED
      expect((await post('/api/admin/vendors/rf-ven-1/menu-import', { rows: [], pad: 'p'.repeat(450_000) })).status).toBe(413);
      // other JSON routes keep the global 100 KB limit, also before authentication
      expect((await request.post('/api/admin/catalog/bulk').send({ pad: 'p'.repeat(150_000) })).status).toBe(413);
    });

    test('GET /api/categories: a short server cache that EVERY category write drops; counts are of APPROVED restaurants and their customer-visible dishes only', async () => {
      process.env.CATEGORIES_CACHE_TTL_MS = '30000';
      invalidatePublicCategories();
      const list = async () => ((await request.get('/api/categories')).body.data as any[]).filter((c) => c.name.startsWith(P));
      const a = await mk('CacheA');
      expect((await list()).map((c) => c.name)).toEqual(['ZR CacheA']);
      // a direct database edit is not seen while the cache is fresh ...
      await prisma.category.update({ where: { id: a.id }, data: { icon: 'egg' } });
      expect((await list())[0].icon).not.toBe('egg');
      // ... but every category write drops it
      const b = await mk('CacheB');
      expect((await list()).map((c) => c.name)).toEqual(['ZR CacheA', 'ZR CacheB']);
      expect((await list())[0].icon).toBe('egg');
      await prisma.category.update({ where: { id: a.id }, data: { icon: 'tea' } });
      await patch(`/api/admin/categories/${a.id}`, { sortOrder: 9999 });
      expect((await list()).map((c) => c.name)).toEqual(['ZR CacheB', 'ZR CacheA']);
      await post('/api/admin/categories/reorder', { ids: [a.id, b.id] });
      expect((await list()).map((c) => c.name)).toEqual(['ZR CacheA', 'ZR CacheB']);
      await post(`/api/admin/categories/${b.id}/merge`, { intoId: a.id, dryRun: false });
      expect((await list()).map((c) => c.name)).toEqual(['ZR CacheA']);
      await del(`/api/admin/categories/${a.id}`);
      expect(await list()).toEqual([]);
      delete process.env.CATEGORIES_CACHE_TTL_MS;

      // counts
      const c = await mk('Counted', { showOnHome: true });
      await tag('rf-ven-1', [c]);
      await tag('rf-ven-4', [c]); // SUSPENDED restaurant
      await dish('rf-ven-1', c); // counts
      await dish('rf-ven-3', c); // dish of a PENDING restaurant: does not count
      await dish('rf-ven-4', c); // dish of a SUSPENDED restaurant: does not count
      await dish('rf-ven-1', c, { approvalStatus: 'PENDING' });
      await dish('rf-ven-1', c, { deletedAt: new Date() });
      const row = (await list())[0];
      expect([row.restaurantCount, row.dishCount]).toEqual([1, 1]);
      const only = await mk('OnlySuspended', { showOnHome: true });
      await dish('rf-ven-4', only);
      expect(((await request.get('/api/categories?for=home')).body.data as any[]).map((x) => x.name)).not.toContain('ZR OnlySuspended');
      const adminRow = ((await request.get('/api/admin/categories?includeInactive=1').set(H(tAdmin))).body.data as any[]).find((x) => x.name === 'ZR Counted');
      expect(adminRow.usage).toEqual({ restaurants: 2, dishes: 5 }); // the admin still sees everything that uses it
    });

    test('GET /api/categories is limited per network address (rule CATEGORIES_PUBLIC, 600 per minute by default)', async () => {
      process.env.RL_CATEGORIES_PUBLIC_MAX = '3';
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await request.get('/api/categories')).status);
      expect(codes).toEqual([200, 200, 200, 429]);
    });
  });

  // =========================================================================================
  describe('restaurants with more than 6 categories (history) can still be saved', () => {
    test('a profile save that does not touch the categories works; sending the same 7 again is the documented 400', async () => {
      const cats = await Promise.all(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map((x) => mk(x)));
      await tag('rf-ven-2', cats);
      const ok = await patch('/api/admin/vendors/rf-ven-2/profile', { address: 'Gate with seven categories', eta: '10-15 min' });
      expect([ok.status, ok.body.data.cuisines.length]).toEqual([200, 7]);
      const again = await patch('/api/admin/vendors/rf-ven-2/profile', { cuisineIds: cats.map((c) => c.id) });
      expect([again.status, again.body.code]).toEqual([400, 'TOO_MANY_CATEGORIES']);
      const six = await patch('/api/admin/vendors/rf-ven-2/profile', { cuisineIds: cats.slice(0, 6).map((c) => c.id) });
      expect([six.status, six.body.data.cuisines.length]).toEqual([200, 6]);
    });
  });

  // =========================================================================================
  describe('reads that include the cuisines while a category is merged away', () => {
    test('GET /vendors, /vendors/:id, the owner session and the admin list never answer 500 while merges move the links under them', async () => {
      const bad: unknown[] = [];
      for (let round = 0; round < 8; round++) {
        const a = await mk(`Rd${round}a`);
        const b = await mk(`Rd${round}b`);
        await tag('rf-ven-1', [a, b]);
        await tag('rf-ven-2', [a]);
        const reads: Promise<supertest.Response>[] = [];
        for (let i = 0; i < 12; i++) {
          reads.push(request.get('/api/vendors'), request.get('/api/vendors/rf-ven-1'), request.get('/api/vendors/rf-ven-2').set(H(tAdmin)), request.get('/api/partner/me').set(H(tOwner1)), request.get('/api/admin/partners').set(H(tAdmin)), request.get('/api/admin/applications?status=ALL').set(H(tAdmin)));
        }
        const merge = (async () => { await new Promise((r) => setTimeout(r, 15)); return post(`/api/admin/categories/${a.id}/merge`, { intoId: b.id, dryRun: false }); })();
        const results = await Promise.all([...reads, merge]);
        for (const r of results) if (![200, 201].includes(r.status)) bad.push([r.status, r.body]);
      }
      expect(bad).toEqual([]);
    });
  });

  // =========================================================================================
  describe('the storm leaves no deadlock behind', () => {
    test('Postgres deadlock counter before and after a parallel storm of rename / merge / delete / dish create / restaurant edit / import is the same', async () => {
      const deadlocks = async () => Number((await prisma.$queryRaw<{ d: bigint }[]>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`)[0].d);
      await new Promise((r) => setTimeout(r, 1200));
      const before = await deadlocks();
      for (let round = 0; round < 3; round++) {
        const [s1, s2, s3] = [await mk(`D1 r${round}`), await mk(`D2 r${round}`), await mk(`D3 r${round}`)];
        await tag('rf-ven-1', [s1, s2]);
        await tag('rf-ven-2', [s2, s3]);
        const reqs: Promise<supertest.Response>[] = [];
        for (let i = 0; i < 3; i++) reqs.push(post(`/api/admin/categories/${s1.id}/merge`, { intoId: s2.id, dryRun: false }));
        reqs.push(patch(`/api/admin/categories/${s2.id}`, { name: `ZR D2 renamed${round}` }), patch(`/api/admin/categories/${s3.id}`, { name: `ZR D3 renamed${round}` }), post(`/api/admin/categories/${s3.id}/merge`, { intoId: s2.id, dryRun: false }));
        reqs.push(del(`/api/admin/categories/${s1.id}`), del(`/api/admin/categories/${s3.id}`), post('/api/admin/categories/reorder', { ids: [s3.id, s2.id, s1.id] }));
        for (let i = 0; i < 5; i++) for (const c of [s1, s2, s3]) reqs.push(post('/api/admin/catalog', { vendorId: V[i % 2], name: `ZR Storm ${randomUUID().slice(0, 6)}`, vendorPrice: 20, categoryId: c.id }));
        for (const v of [V[0], V[1]]) reqs.push(patch(`/api/admin/vendors/${v}/profile`, { cuisineIds: [s2.id, s1.id, s3.id] }), patch(`/api/admin/vendors/${v}/profile`, { cuisineIds: [s3.id] }));
        reqs.push(post(`/api/admin/vendors/${V[0]}/menu-import`, { dryRun: false, rows: [1, 2, 3].map((k) => ({ name: `ZR Imp ${round}-${k}`, category: s2.name, vendorPrice: 10 })) }));
        const results = await Promise.all(reqs);
        expect(results.filter((r) => ![200, 201, 400, 404, 409].includes(r.status)).map((r) => [r.status, r.body])).toEqual([]);
      }
      await new Promise((r) => setTimeout(r, 1500)); // Postgres publishes its counters with a short delay
      expect(await deadlocks()).toBe(before);
    });
  });
});
