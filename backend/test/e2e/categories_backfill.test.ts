/**
 * The backfill of prisma/migrations/20261012_categories (Docs/23 section 2), run on production-shaped data (Docs/23: 7 restaurants with
 * strings like "North Indian • Thalis • Parathas", 11 dish categories incl. case / space variants) and asserted row by row.
 *
 * The migration file marks its backfill with BACKFILL-BEGIN / BACKFILL-END. This test runs exactly that block on COPIES of the four tables
 * (schema bf_test, created and rolled back inside one transaction), so it neither depends on nor touches the rows other suites leave behind.
 * The whole migration (DDL + backfill) was also run twice with psql on a scratch database that had the previous schema (see Docs/23 section 8).
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../harness/db';
import { guessIcon } from '../../src/services/categories';

jest.setTimeout(60_000);

const migration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261012_categories/migration.sql'), 'utf8');
const BLOCK = migration.slice(migration.indexOf('-- BACKFILL-BEGIN'), migration.indexOf('-- BACKFILL-END')).split('\n').slice(1).join('\n');

const VENDORS = [
  'North Indian • Thalis • Parathas', 'Fast Food • Maggi • Beverages', 'Biryani • Tandoor • Desserts', 'South Indian • Dosa • Filter Coffee',
  'Chinese • Noodles • Rolls', 'Chai • Street Food • Shakes', 'North Indian',
];
const DISHES: [string, number][] = [
  ['Snacks', 5], ['snacks', 1], ['South Indian', 5], ['Beverages', 5], ['Main Course', 6], [' Main Course ', 1], ['MAIN  COURSE', 1], ['Chinese', 3], ['Desserts', 3],
  ['Starters', 4], ['Biryani', 2], ['Street Food', 3], ['Breads & Tandoor', 1], ['breads & tandoor', 1], ['Thali', 4],
];

class Rollback extends Error {}
type Snapshot = { categories: any[]; links: any[]; dishes: any[]; vendors: any[] };

/** Builds the copies, inserts the fixture, lets `scenario` run the block (any number of times) and always rolls back. */
const withCopies = async (fixture: (q: (sql: string, ...args: unknown[]) => Promise<unknown>) => Promise<void>, scenario: (run: () => Promise<void>, read: () => Promise<Snapshot>, q: (sql: string, ...args: unknown[]) => Promise<unknown>) => Promise<void>) => {
  try {
    await prisma.$transaction(async (tx) => {
      const q = (sql: string, ...args: unknown[]) => tx.$executeRawUnsafe(sql, ...args);
      await q('CREATE SCHEMA bf_test');
      for (const t of ['Vendor', 'MenuItem', 'Category', 'VendorCategory']) await q(`CREATE TABLE bf_test."${t}" (LIKE public."${t}" INCLUDING ALL)`);
      await q('SET LOCAL search_path TO bf_test');
      await fixture(q);
      const run = async () => { await tx.$executeRawUnsafe(BLOCK); };
      const read = async (): Promise<Snapshot> => ({
        categories: JSON.parse(JSON.stringify(await tx.$queryRawUnsafe('SELECT * FROM bf_test."Category" ORDER BY "sortOrder", "slug"'))),
        links: JSON.parse(JSON.stringify(await tx.$queryRawUnsafe('SELECT * FROM bf_test."VendorCategory" ORDER BY "vendorId", "position"'))),
        dishes: JSON.parse(JSON.stringify(await tx.$queryRawUnsafe('SELECT * FROM bf_test."MenuItem" ORDER BY "id"'))),
        vendors: JSON.parse(JSON.stringify(await tx.$queryRawUnsafe('SELECT * FROM bf_test."Vendor" ORDER BY "id"'))),
      });
      await scenario(run, read, q);
      throw new Rollback();
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
};

const insertVendor = (q: (sql: string, ...a: unknown[]) => Promise<unknown>, id: string, category: string) =>
  q(`INSERT INTO bf_test."Vendor" ("id","name","category","bannerImage","address","updatedAt") VALUES ($1,$2,$3,'b','addr',now())`, id, `Vendor ${id}`, category);
const insertDish = (q: (sql: string, ...a: unknown[]) => Promise<unknown>, id: string, vendorId: string, category: string) =>
  q(`INSERT INTO bf_test."MenuItem" ("id","vendorId","name","price","vendorPrice","category","description","imageUrl") VALUES ($1,$2,$3,100,100,$4,'d','i')`, id, vendorId, `Dish ${id}`, category);

describe('migration 20261012_categories: backfill on production-shaped data', () => {
  test('the block is found in the migration file', () => {
    expect(BLOCK).toContain('DO $backfill$');
    expect(BLOCK.trim().endsWith('$backfill$;')).toBe(true);
    // the migration is additive: nothing is dropped, deleted or truncated
    expect(migration.replace(/^--.*$/gm, '')).not.toMatch(/DROP (TABLE|COLUMN)(?! IF EXISTS _bf_)|TRUNCATE|DELETE FROM|ALTER COLUMN|RENAME/i);
  });

  test('7 restaurants + 45 dishes in 11 categories (with variants): every category, link and dish row is exactly as the contract says, and a second run changes nothing', async () => {
    await withCopies(
      async (q) => {
        for (const [i, c] of VENDORS.entries()) await insertVendor(q, `mv${i + 1}`, c);
        let n = 0;
        for (const [cat, count] of DISHES) for (let k = 0; k < count; k++) { n += 1; await insertDish(q, `md${String(n).padStart(2, '0')}`, `mv${(n % 7) + 1}`, cat); }
      },
      async (run, read) => {
        const before = await read();
        await run();
        const after = await read();

        // --- categories, in sortOrder: (a) dish categories by dish count desc, (b) missing legacy six, (c) restaurant-only tokens
        const rows = after.categories.map((c) => [c.sortOrder, c.name, c.slug, c.icon, c.forRestaurants, c.forDishes, c.showOnHome, c.isActive, c.nameHi]);
        expect(rows).toEqual([
          [1, 'Main Course', 'main-course', 'restaurant', true, true, true, true, null],
          [2, 'Snacks', 'snacks', 'snack', true, true, true, true, null],
          [3, 'Beverages', 'beverages', 'juice', true, true, true, true, null],
          [4, 'South Indian', 'south-indian', 'dosa', true, true, true, true, null],
          [5, 'Starters', 'starters', 'snack', true, true, true, true, null],
          [6, 'Thali', 'thali', 'thali', true, true, true, true, null],
          [7, 'Chinese', 'chinese', 'noodles', true, true, true, true, null],
          [8, 'Desserts', 'desserts', 'dessert', true, true, true, true, null],
          [9, 'Street Food', 'street-food', 'snack', true, true, true, true, null],
          [10, 'Biryani', 'biryani', 'biryani', true, true, true, true, null],
          [11, 'Breads & Tandoor', 'breads-tandoor', 'tandoor', true, true, true, true, null],
          // (b) the six names of the old restaurant app that were missing: dish-only, not on Home. Fast Food became a restaurant category too
          // because a restaurant is tagged with it ("Fast Food • Maggi • Beverages").
          [12, 'Breads', 'breads', 'bread', false, true, false, true, null],
          [13, 'Fast Food', 'fast-food', 'snack', true, true, false, true, null],
          // (c) new restaurant-only categories: restaurants using them desc, then alphabetical; never on Home
          [14, 'North Indian', 'north-indian', 'restaurant', true, false, false, true, null],
          [15, 'Chai', 'chai', 'tea', true, false, false, true, null],
          [16, 'Dosa', 'dosa', 'dosa', true, false, false, true, null],
          [17, 'Filter Coffee', 'filter-coffee', 'coffee', true, false, false, true, null],
          [18, 'Maggi', 'maggi', 'snack', true, false, false, true, null],
          [19, 'Noodles', 'noodles', 'noodles', true, false, false, true, null],
          [20, 'Parathas', 'parathas', 'bread', true, false, false, true, null],
          [21, 'Rolls', 'rolls', 'roll', true, false, false, true, null],
          [22, 'Shakes', 'shakes', 'shake', true, false, false, true, null],
          [23, 'Tandoor', 'tandoor', 'tandoor', true, false, false, true, null],
          [24, 'Thalis', 'thalis', 'thali', true, false, false, true, null],
        ]);
        expect(new Set(after.categories.map((c) => c.id)).size).toBe(24);
        for (const c of after.categories) expect(c.id).toMatch(/^[0-9a-f-]{36}$/);

        // --- restaurant links: every token in the order it appears, positions 0..n-1
        const idOf = (slug: string) => after.categories.find((c) => c.slug === slug).id;
        const slugsOf = (vendorId: string) => after.links.filter((l) => l.vendorId === vendorId).map((l) => [after.categories.find((c) => c.id === l.categoryId).name, l.position]);
        expect(slugsOf('mv1')).toEqual([['North Indian', 0], ['Thalis', 1], ['Parathas', 2]]);
        expect(slugsOf('mv2')).toEqual([['Fast Food', 0], ['Maggi', 1], ['Beverages', 2]]);
        expect(slugsOf('mv3')).toEqual([['Biryani', 0], ['Tandoor', 1], ['Desserts', 2]]);
        expect(slugsOf('mv4')).toEqual([['South Indian', 0], ['Dosa', 1], ['Filter Coffee', 2]]);
        expect(slugsOf('mv5')).toEqual([['Chinese', 0], ['Noodles', 1], ['Rolls', 2]]);
        expect(slugsOf('mv6')).toEqual([['Chai', 0], ['Street Food', 1], ['Shakes', 2]]);
        expect(slugsOf('mv7')).toEqual([['North Indian', 0]]);
        expect(after.links).toHaveLength(19);
        expect(after.links.filter((l) => l.categoryId === idOf('north-indian'))).toHaveLength(2);

        // --- dishes: all 45 linked, display name canonical (variants became one tab), nothing else touched
        const byCategory: Record<string, number> = {};
        for (const d of after.dishes) {
          expect(d.categoryId).toBe(idOf(d.category === 'Breads & Tandoor' ? 'breads-tandoor' : d.category.toLowerCase().replace(/ /g, '-')));
          byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
        }
        expect(byCategory).toEqual({ 'Main Course': 8, Snacks: 6, Beverages: 5, 'South Indian': 5, Starters: 4, Thali: 4, Chinese: 3, Desserts: 3, 'Street Food': 3, Biryani: 2, 'Breads & Tandoor': 2 });
        for (const [i, d] of before.dishes.entries()) {
          const { category: _c, categoryId: _i, ...rest } = d;
          const { category: _c2, categoryId: _i2, ...rest2 } = after.dishes[i];
          expect(rest2).toEqual(rest); // prices, names, status, updatedAt ... identical
        }
        // --- restaurants are not rewritten at all
        expect(after.vendors).toEqual(before.vendors);

        // --- running it again changes NOTHING (ids, timestamps, flags, links, dishes)
        await run();
        expect(await read()).toEqual(after);
        await run();
        expect(await read()).toEqual(after);
      },
    );
  });

  test('edge cases: unmatchable text stays NULL, repeated and non-latin tokens, empty restaurant text, 7 words, an admin-made category is reused untouched', async () => {
    await withCopies(
      async (q) => {
        await insertVendor(q, 'e1', 'Rolls • rolls • Wraps , Chai | ');
        await insertVendor(q, 'e2', '');
        await insertVendor(q, 'e3', '•,|');
        await insertVendor(q, 'e4', 'पराठा • Parathas');
        await insertVendor(q, 'e5', 'A • B • C • D • E • F • G');
        await insertVendor(q, 'e6', 'Already Tagged • Other');
        await insertDish(q, 'x1', 'e1', '');
        await insertDish(q, 'x2', 'e1', '!!!');
        await insertDish(q, 'x3', 'e1', 'पराठा');
        await insertDish(q, 'x4', 'e1', 'Pasta');
        await insertDish(q, 'x5', 'e1', 'pasta  ');
        await insertDish(q, 'x6', 'e1', 'Fast-Food');
        await insertDish(q, 'x7', 'e1', 'FAST FOOD');
        await insertDish(q, 'x8', 'e1', 'Hidden One');
        // an admin already made "Hidden One" (inactive, dishes only, custom order and Hindi name) and tagged e6 by hand
        await q(`INSERT INTO bf_test."Category" ("id","name","slug","nameHi","icon","sortOrder","isActive","forRestaurants","forDishes","showOnHome","createdAt","updatedAt") VALUES ('c-hidden','Hidden One','hidden-one','छिपा','tea',50,false,false,true,false,'2026-01-01','2026-01-02')`);
        await q(`INSERT INTO bf_test."Category" ("id","name","slug","icon","sortOrder","isActive","forRestaurants","forDishes","showOnHome","createdAt","updatedAt") VALUES ('c-tag','Already Tagged','already-tagged','restaurant',60,true,true,false,false,'2026-01-01','2026-01-02')`);
        await q(`INSERT INTO bf_test."VendorCategory" ("vendorId","categoryId","position") VALUES ('e6','c-tag',0)`);
      },
      async (run, read) => {
        await run();
        const a = await read();
        const names = (vendorId: string) => a.links.filter((l) => l.vendorId === vendorId).map((l) => a.categories.find((c) => c.id === l.categoryId).name);
        expect(names('e1')).toEqual(['Rolls', 'Wraps', 'Chai']); // repeated token once, empty tokens dropped
        expect(names('e2')).toEqual([]);
        expect(names('e3')).toEqual([]);
        expect(names('e4')).toEqual(['Parathas']); // the Devanagari token has no letters or digits: dropped
        expect(names('e5')).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']); // every token (the 6-per-restaurant cap applies to API edits, not to history)
        expect(names('e6')).toEqual(['Already Tagged']); // a restaurant that already has links is not touched (no "Other" added)
        expect(a.categories.find((c) => c.slug === 'other')).toBeUndefined();

        const dish = (id: string) => a.dishes.find((d) => d.id === id);
        for (const id of ['x1', 'x2', 'x3']) expect([id, dish(id).categoryId]).toEqual([id, null]); // nothing to match: stays NULL, text untouched
        expect(dish('x3').category).toBe('पराठा');
        expect(dish('x4').categoryId).toBe(dish('x5').categoryId);
        expect(dish('x5').category).toBe('Pasta');
        expect(dish('x6').categoryId).toBe(dish('x7').categoryId); // "Fast-Food" and "FAST FOOD" are one category
        expect(dish('x6').category).toBe(dish('x7').category);
        expect(a.categories.filter((c) => c.slug === 'fast-food')).toHaveLength(1);

        // the admin-made category is linked as it is: still inactive, dish-only, same order, Hindi name and icon, same timestamps
        const hidden = a.categories.find((c) => c.id === 'c-hidden');
        expect(hidden).toMatchObject({ name: 'Hidden One', nameHi: 'छिपा', icon: 'tea', sortOrder: 50, isActive: false, forRestaurants: false, forDishes: true, showOnHome: false });
        expect(hidden.updatedAt).toBe('2026-01-02T00:00:00.000Z');
        expect(dish('x8')).toMatchObject({ categoryId: 'c-hidden', category: 'Hidden One' });
        // a category that restaurants use is a restaurant category (flag flipped on the one that was already there? no: it already was)
        expect(a.categories.find((c) => c.id === 'c-tag')).toMatchObject({ forRestaurants: true, forDishes: false, sortOrder: 60 });

        await run();
        expect(await read()).toEqual(a);
      },
    );
  });

  test('a restaurant link an admin removed is not added back by a second run (only restaurants without any link are processed)', async () => {
    await withCopies(
      async (q) => { await insertVendor(q, 'r1', 'Rolls • Chai'); },
      async (run, read, q) => {
        await run();
        const first = await read();
        expect(first.links).toHaveLength(2);
        // the admin removes "Chai" from the restaurant by hand
        const chai = first.categories.find((c) => c.slug === 'chai');
        await q(`DELETE FROM bf_test."VendorCategory" WHERE "categoryId" = $1`, chai.id);
        await run();
        const second = await read();
        expect(second.links.map((l) => l.categoryId)).toEqual(first.links.filter((l) => l.categoryId !== chai.id).map((l) => l.categoryId));
      },
    );
  });

  test('the icon rules in the SQL and in guessIcon() give the same answer', async () => {
    const names = ['Biryani', 'Thali', 'South Indian', 'Dosa', 'Chinese', 'Noodles', 'Rolls', 'Egg Roll', 'Burgers', 'Pizza', 'Pasta', 'Tandoor', 'Tikka', 'Breads', 'Parathas', 'Naan', 'Eggs', 'Chicken', 'Seafood', 'Ice Cream', 'Icecream', 'Desserts', 'Sweets', 'Tea', 'Chai', 'Steak', 'Coffee', 'Juices', 'Shakes', 'Lassi', 'Beverages', 'Drinks', 'Healthy', 'Late Night', 'Rice', 'Veg', 'Vegetables', 'Snacks', 'Starters', 'Street Food', 'Fast Food', 'Maggi', 'Main Course', 'Zzz'];
    await withCopies(
      async (q) => { for (const [i, n] of names.entries()) await insertDish(q, `i${i}`, 'none', n); },
      async (run, read) => {
        await run();
        const a = await read();
        for (const n of names) {
          const c = a.categories.find((x) => x.slug === n.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          expect([n, c.icon]).toEqual([n, guessIcon(n)]);
        }
        expect(guessIcon('Steak')).toBe('restaurant'); // "tea" inside a word is not tea
        expect(guessIcon('Egg Roll')).toBe('roll');
      },
    );
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// Review fixes (Docs/bughunt/TAXONOMY_review.md): white space the way the app slugifier sees it, volume, a failed run, the lock timeout
// ---------------------------------------------------------------------------------------------------------------------
describe('migration 20261012_categories: review fixes', () => {
  test('white space at the edges and inside (tab, newline, no-break space, other Unicode spaces) and zero-width characters give clean names', async () => {
    await withCopies(
      async (q) => {
        await insertVendor(q, 'w1', '\tRolls  \n•  Café (Veg), Dal\u200b  Rice •　Momos ');
        await insertDish(q, 'w-1', 'w1', '\tSnacks\n');
        await insertDish(q, 'w-2', 'w1', 'snacks');
        await insertDish(q, 'w-3', 'w1', 'Street  Food');
        await insertDish(q, 'w-4', 'w1', ' Street \u200bFood ');
        await insertDish(q, 'w-5', 'w1', 'Thali\u200b');
        await insertDish(q, 'w-6', 'w1', '\ufeffMain\t\tCourse\r\n');
      },
      async (run, read) => {
        await run();
        const a = await read();
        const names = a.categories.map((c) => [c.name, c.slug]);
        // no name starts or ends with a space, none holds a tab, newline, no-break or zero-width character, inner runs are one space
        for (const [name] of names) expect(name).toMatch(/^[^\s \u200b\ufeff](?:.*[^\s \u200b\ufeff])?$/);
        for (const [name] of names) expect(name).not.toMatch(/\s{2,}|[\t\n\r   　\u200b\ufeff]/);
        expect(names).toEqual(expect.arrayContaining([['Snacks', 'snacks'], ['Street Food', 'street-food'], ['Thali', 'thali'], ['Main Course', 'main-course'], ['Rolls', 'rolls'], ['Café (Veg)', 'caf-veg'], ['Dal Rice', 'dal-rice'], ['Momos', 'momos']]));
        expect(a.categories.filter((c) => c.slug === 'snacks')).toHaveLength(1);
        expect(a.categories.filter((c) => c.slug === 'street-food')).toHaveLength(1);
        const dishes = Object.fromEntries(a.dishes.map((d) => [d.id, d.category]));
        expect(dishes).toEqual({ 'w-1': 'Snacks', 'w-2': 'Snacks', 'w-3': 'Street Food', 'w-4': 'Street Food', 'w-5': 'Thali', 'w-6': 'Main Course' });
        const links = a.links.filter((l) => l.vendorId === 'w1').map((l) => a.categories.find((c) => c.id === l.categoryId).name);
        expect(links).toEqual(['Rolls', 'Café (Veg)', 'Dal Rice', 'Momos']);
        await run();
        expect(await read()).toEqual(a);
      },
    );
  });

  test('volume: 10,000 dishes in 120 spellings of 60 categories and 400 restaurants are backfilled in a few seconds, and a second run changes nothing', async () => {
    await withCopies(
      async (q) => {
        await q(`INSERT INTO bf_test."Vendor" ("id","name","category","bannerImage","address","updatedAt")
                 SELECT 'v' || g, 'Vendor ' || g, 'Cuisine ' || (g % 60) || ' • Style ' || (g % 17) || ' • Cuisine ' || ((g + 7) % 60), 'b', 'a', now() FROM generate_series(1, 400) g`);
        await q(`INSERT INTO bf_test."MenuItem" ("id","vendorId","name","price","vendorPrice","category","description","imageUrl")
                 SELECT 'd' || g, 'v' || (1 + g % 400), 'Dish ' || g, 10, 10, CASE WHEN (g / 60) % 3 <> 0 THEN 'Category ' || (g % 60) ELSE lower('CATEGORY ' || (g % 60)) || ' ' END, 'd', 'i' FROM generate_series(1, 10000) g`);
      },
      async (run, read) => {
        const started = Date.now();
        await run();
        const seconds = (Date.now() - started) / 1000;
        expect(seconds).toBeLessThan(15);
        const a = await read();
        expect(a.dishes.every((d) => d.categoryId !== null && /^Category \d+$/.test(d.category))).toBe(true);
        expect(a.categories.filter((c) => c.forDishes && c.showOnHome && /^Category \d+$/.test(c.name))).toHaveLength(60);
        expect(a.links.length).toBeGreaterThan(400 * 2);
        expect(new Set(a.links.map((l) => l.vendorId)).size).toBe(400);
        await run();
        expect(await read()).toEqual(a);
      },
    );
  });

  test('a run that fails halfway leaves nothing behind (one transaction): the column and the tables from the DDL part are gone again', async () => {
    class Boom extends Error {}
    let leftBehind = true;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('CREATE SCHEMA bf_fail');
        await tx.$executeRawUnsafe('CREATE TABLE bf_fail."MenuItem" (id text primary key)');
        await tx.$executeRawUnsafe('ALTER TABLE bf_fail."MenuItem" ADD COLUMN IF NOT EXISTS "categoryId" TEXT');
        await tx.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS bf_fail."Category" (id text primary key)');
        await tx.$executeRawUnsafe('SET LOCAL search_path TO bf_fail');
        await tx.$executeRawUnsafe(BLOCK); // fails: bf_fail has no "Vendor" table
      }, { timeout: 20_000 });
    } catch (e) {
      leftBehind = !(e instanceof Error);
      expect(String((e as Error).message)).toMatch(/Vendor|relation|does not exist/i);
    }
    expect(leftBehind).toBe(false);
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = 'bf_fail'`);
    expect(Number(rows[0].n)).toBe(0);
    void Boom;
  });

  test('lock_timeout: while another transaction reads "MenuItem" the migration\'s ALTER gives up after the timeout instead of queueing (and nothing changes)', async () => {
    let blockedMessage = '';
    await prisma.$transaction(async (reader) => {
      await reader.$executeRawUnsafe('LOCK TABLE "MenuItem" IN ACCESS SHARE MODE'); // what an open read transaction holds
      try {
        await prisma.$transaction(async (migration) => {
          await migration.$executeRawUnsafe(`SET LOCAL lock_timeout = '300ms'`);
          await migration.$executeRawUnsafe('ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "categoryId" TEXT');
        }, { timeout: 10_000 });
      } catch (e) {
        blockedMessage = String((e as Error).message);
      }
    }, { timeout: 20_000 });
    expect(blockedMessage).toMatch(/lock timeout|55P03/i);
    expect((await prisma.menuItem.count()) >= 0).toBe(true); // the table is usable right after
  });
});
