import { randomUUID } from 'crypto';
import { Category, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { ID_RE } from '../utils/http';
import { writeAudit } from './audit';
import { BAD_LABEL_CHARS, BAD_SCRIPT_LABEL_CHARS, collapse } from '../utils/labels';

/**
 * Managed categories (Docs/23). ONE list for restaurants (0..6 per restaurant, VendorCategory) and dishes (exactly one, MenuItem.categoryId).
 *
 * Denormalised copies that old app builds read: `MenuItem.category` (the category name) and `Vendor.category` (names joined with " • ").
 * They are rewritten in the SAME transaction as the change that makes them stale (rename, merge, restaurant edit).
 *
 * LOCK ORDER (every writer, so two writers can never deadlock): category rows by ascending id (FOR SHARE for a writer that only
 * uses a category, FOR UPDATE for rename / merge / delete) -> restaurant rows by ascending id -> dish rows by ascending id.
 * A writer that holds a FOR SHARE lock on a category cannot see it renamed, merged or deleted underneath it; rename / merge / delete wait for it.
 */
type Tx = Prisma.TransactionClient;
export type Actor = { id: string; role: string };

export const ICON_KEYS = [
  'restaurant', 'thali', 'rice', 'biryani', 'dosa', 'noodles', 'roll', 'burger', 'pizza', 'snack', 'bread', 'tandoor', 'egg', 'chicken', 'fish',
  'veg', 'sweet', 'dessert', 'icecream', 'tea', 'coffee', 'juice', 'shake', 'healthy', 'latenight',
] as const;
export const MAX_CATEGORIES = 300;
export const MAX_CUISINES = 6;
export const MAX_NAME_LEN = 30;
export const DEFAULT_DISH_CATEGORY = 'Main Course';
export const DEFAULT_VENDOR_CATEGORY = 'Campus kitchen';
export const CUISINE_SEPARATOR = ' • ';
export const MAX_DISH_CATEGORY_TEXT = 40;
const TX_OPTS = { maxWait: 10_000, timeout: 20_000 };

/**
 * The six names the OLD restaurant app hard-codes in its add-dish picker (and sends as free text). Renaming, hiding, switching off
 * `forDishes`, merging away or deleting one of them would make every old build fail with CATEGORY_UNKNOWN, so those changes are refused
 * (409 CATEGORY_PROTECTED) until the old builds are gone: set ALLOW_LEGACY_CATEGORY_CHANGES=1 on the server to lift the guard.
 */
export const LEGACY_PROTECTED_SLUGS: readonly string[] = ['main-course', 'breads', 'beverages', 'snacks', 'desserts', 'fast-food'];
const legacyChangesAllowed = () => process.env.ALLOW_LEGACY_CATEGORY_CHANGES === '1';
const assertNotProtected = (c: { slug: string }, what: string) => {
  if (LEGACY_PROTECTED_SLUGS.includes(c.slug) && !legacyChangesAllowed()) {
    throw new AppError(409, 'CATEGORY_PROTECTED', `Older restaurant apps still use this name (${what}). It stays as it is until those builds are gone.`);
  }
};

// Public list cache (GET /api/categories): the grouped counts query is memoised for a short time and dropped by every category write.
// Off under NODE_ENV=test unless CATEGORIES_CACHE_TTL_MS is set, like the settings cache, so suites that edit rows directly stay exact.
let publicCache: { at: number; rows: CategoryWithCounts[] } | null = null;
export const invalidatePublicCategories = () => { publicCache = null; };
const cacheTtlMs = (): number => {
  const raw = process.env.CATEGORIES_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') { const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : 0; }
  return process.env.NODE_ENV === 'test' ? 0 : 30_000;
};

const bad = (field: string, message: string, code = 'BAD_REQUEST') => new AppError(400, code, message, field);

// ---------------------------------------------------------------------------------------------------------------------
// Names and slugs
// ---------------------------------------------------------------------------------------------------------------------
export { collapse };
/** Same rule as the migration: lower case, every run of characters outside a-z0-9 becomes "-", trimmed. Unique per category. */
export const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const NAME_CHARS = /^[A-Za-z0-9 &'\-/+]+$/;

export const checkCategoryName = (raw: unknown, field = 'name'): { name: string; slug: string } => {
  if (typeof raw !== 'string') throw bad(field, 'Enter a name for the category (2 to 30 characters).');
  if (BAD_LABEL_CHARS.test(raw.normalize('NFC'))) throw bad(field, 'The name cannot contain control, hidden or direction-changing characters.');
  const name = collapse(raw);
  if (name.length < 2 || name.length > MAX_NAME_LEN) throw bad(field, `The name must be 2 to ${MAX_NAME_LEN} characters.`);
  if (!NAME_CHARS.test(name)) throw bad(field, "Use only letters, digits, spaces and & - ' / + in the name. Put the Hindi label in the Hindi name field.");
  const slug = slugOf(name);
  if (!slug) throw bad(field, 'The name needs at least one letter or digit.');
  return { name, slug };
};

export const checkNameHi = (raw: unknown): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw bad('nameHi', 'The Hindi name must be text.');
  const v = collapse(raw);
  if (v === '') return null;
  if (v.length > MAX_NAME_LEN || /[<>]/.test(v) || BAD_SCRIPT_LABEL_CHARS.test(raw.normalize('NFC'))) throw bad('nameHi', `The Hindi name can be at most ${MAX_NAME_LEN} characters, without symbols like < > or hidden characters.`);
  return v;
};

export const checkIcon = (raw: unknown): string => {
  if (typeof raw !== 'string' || !(ICON_KEYS as readonly string[]).includes(raw)) throw bad('icon', `Icon must be one of: ${ICON_KEYS.join(', ')}.`);
  return raw;
};

const checkBool = (raw: unknown, field: string): boolean => {
  if (typeof raw !== 'boolean') throw bad(field, `${field} must be true or false.`);
  return raw;
};

/** Keyword -> icon, MUST give the same answers as the CASE in prisma/migrations/20261012_categories (a test compares them). */
const ICON_RULES: [string, RegExp][] = [
  ['biryani', /biryani/], ['thali', /thali/], ['dosa', /(dosa|idli|south)/], ['noodles', /(noodle|chinese|chowmein|momo)/],
  ['roll', /-(roll|wrap)s?-/], ['burger', /burger/], ['pizza', /(pizza|pasta)/], ['tandoor', /(tandoor|tikka|kebab|grill)/],
  ['bread', /(bread|paratha|naan|roti|kulcha)/], ['egg', /-eggs?-/], ['chicken', /chicken/], ['fish', /(fish|seafood)/],
  ['icecream', /-ice-?cream/], ['dessert', /(dessert|sweet|mithai|cake|pastry)/], ['tea', /-(tea|chai)s?-/], ['coffee', /coffee/],
  ['juice', /juice/], ['shake', /(shake|smoothie|lassi)/], ['juice', /(beverage|drink|soda)/], ['healthy', /(healthy|salad|diet)/],
  ['latenight', /night/], ['rice', /(rice|pulao)/], ['veg', /-veg-/], ['snack', /(snack|starter|chaat|street|fast|maggi|sandwich|fries)/],
];
export const guessIcon = (name: string): string => {
  const padded = `-${slugOf(name)}-`;
  for (const [icon, re] of ICON_RULES) if (re.test(padded)) return icon;
  return 'restaurant';
};

// ---------------------------------------------------------------------------------------------------------------------
// Views and lists
// ---------------------------------------------------------------------------------------------------------------------
type CategoryWithCounts = Category & { restaurantCount: number; dishCount: number; restaurantsTotal: number; dishesTotal: number };

const iso = (d: Date) => d.toISOString();

/** What every client may see. */
export const publicCategoryView = (c: CategoryWithCounts) => ({
  id: c.id,
  name: c.name,
  nameHi: c.nameHi ?? null,
  icon: c.icon,
  forRestaurants: c.forRestaurants,
  forDishes: c.forDishes,
  showOnHome: c.showOnHome,
  sortOrder: c.sortOrder,
  restaurantCount: c.restaurantCount,
  dishCount: c.dishCount,
});

/** The admin portal's row: the public fields plus everything needed to explain why a delete is refused. */
export const adminCategoryView = (c: CategoryWithCounts) => ({
  ...publicCategoryView(c),
  slug: c.slug,
  isActive: c.isActive,
  /** Every restaurant / dish that uses it, whatever its state (a pending or deleted dish still blocks a delete). */
  usage: { restaurants: c.restaurantsTotal, dishes: c.dishesTotal },
  inUse: c.restaurantsTotal + c.dishesTotal > 0,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

/** ONE grouped query for the categories and all their counts (no N+1). Visible = approved restaurants / approved, not deleted dishes. */
const withCounts = async (client: Tx | typeof prisma, where: Prisma.Sql): Promise<CategoryWithCounts[]> =>
  client.$queryRaw<CategoryWithCounts[]>`
    SELECT c.*,
           COALESCE(r.visible, 0)::int AS "restaurantCount", COALESCE(r.total, 0)::int AS "restaurantsTotal",
           COALESCE(d.visible, 0)::int AS "dishCount",       COALESCE(d.total, 0)::int AS "dishesTotal"
    FROM "Category" c
    LEFT JOIN (
      SELECT vc."categoryId", COUNT(*) FILTER (WHERE v."approvalStatus" = 'APPROVED') AS visible, COUNT(*) AS total
      FROM "VendorCategory" vc JOIN "Vendor" v ON v."id" = vc."vendorId"
      GROUP BY vc."categoryId"
    ) r ON r."categoryId" = c."id"
    LEFT JOIN (
      SELECT m."categoryId",
             COUNT(*) FILTER (WHERE m."approvalStatus" = 'APPROVED' AND m."deletedAt" IS NULL AND mv."approvalStatus" = 'APPROVED') AS visible,
             COUNT(*) AS total
      FROM "MenuItem" m JOIN "Vendor" mv ON mv."id" = m."vendorId"
      WHERE m."categoryId" IS NOT NULL
      GROUP BY m."categoryId"
    ) d ON d."categoryId" = c."id"
    WHERE ${where}
    ORDER BY c."sortOrder" ASC, c."name" ASC, c."id" ASC
    LIMIT 600`;

export const listPublicCategories = async (filter: unknown) => {
  if (filter !== undefined && filter !== 'restaurants' && filter !== 'dishes' && filter !== 'home') {
    throw bad('for', "'for' must be restaurants, dishes or home.");
  }
  const ttl = cacheTtlMs();
  let rows: CategoryWithCounts[];
  if (ttl > 0 && publicCache && Date.now() - publicCache.at < ttl) rows = publicCache.rows;
  else {
    rows = await withCounts(prisma, Prisma.sql`c."isActive" = true`);
    if (ttl > 0) publicCache = { at: Date.now(), rows };
  }
  const list = rows.filter((c) => {
    if (filter === 'restaurants') return c.forRestaurants;
    if (filter === 'dishes') return c.forDishes;
    if (filter === 'home') return c.showOnHome && (c.restaurantCount > 0 || c.dishCount > 0);
    return true;
  });
  return list.map(publicCategoryView);
};

export const listAdminCategories = async (includeInactive: boolean) =>
  (await withCounts(prisma, includeInactive ? Prisma.sql`TRUE` : Prisma.sql`c."isActive" = true`)).map(adminCategoryView);

const adminViewOf = async (client: Tx | typeof prisma, id: string) => {
  const rows = await withCounts(client, Prisma.sql`c."id" = ${id}`);
  return rows[0] ? adminCategoryView(rows[0]) : null;
};

// ---------------------------------------------------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------------------------------------------------
const uniqueSorted = (ids: string[]) => [...new Set(ids)].sort();

/** Locks category rows in ascending id order. Returns the ids that exist. */
export const lockCategories = async (tx: Tx, ids: string[], mode: 'SHARE' | 'UPDATE'): Promise<string[]> => {
  const list = uniqueSorted(ids);
  if (list.length === 0) return [];
  const rows = mode === 'SHARE'
    ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Category" WHERE "id" = ANY(${list}::text[]) ORDER BY "id" FOR SHARE`
    : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Category" WHERE "id" = ANY(${list}::text[]) ORDER BY "id" FOR UPDATE`;
  return rows.map((r) => r.id);
};

const lockVendors = async (tx: Tx, ids: string[]) => {
  const list = uniqueSorted(ids);
  if (list.length) await tx.$queryRaw`SELECT "id" FROM "Vendor" WHERE "id" = ANY(${list}::text[]) ORDER BY "id" FOR UPDATE`;
};

/** Rewrites Vendor.category (names joined by " • ", in position order; "Campus kitchen" when none) for the given restaurants. */
export const rederiveVendorCategories = async (tx: Tx, vendorIds: string[]) => {
  const list = uniqueSorted(vendorIds);
  if (list.length === 0) return;
  await tx.$executeRaw`
    UPDATE "Vendor" v SET "category" = COALESCE(
      (SELECT string_agg(c."name", ${CUISINE_SEPARATOR} ORDER BY vc."position", vc."categoryId")
         FROM "VendorCategory" vc JOIN "Category" c ON c."id" = vc."categoryId" WHERE vc."vendorId" = v."id"),
      ${DEFAULT_VENDOR_CATEGORY})
    WHERE v."id" = ANY(${list}::text[])`;
};

export const deriveVendorCategory = (names: string[]): string => (names.length ? names.join(CUISINE_SEPARATOR) : DEFAULT_VENDOR_CATEGORY);

// ---------------------------------------------------------------------------------------------------------------------
// Dish category rules (Docs/23 section 3.4)
// ---------------------------------------------------------------------------------------------------------------------
export type DishCategoryInput = { name?: unknown; id?: unknown };
export type ResolvedCategory = { id: string; name: string };
const UNKNOWN_MESSAGE = 'Pick a category from the list.';

const distance = (a: string, b: string, limit = 4): number => {
  if (Math.abs(a.length - b.length) > limit) return Infinity; // cannot be close enough: skip the O(n*m) table
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
};

/** Up to 5 active dish categories closest to what was typed (admin error messages only). */
export const suggestDishCategories = async (client: Tx | typeof prisma, typed: string): Promise<string[]> => {
  const slug = slugOf(typed.slice(0, MAX_DISH_CATEGORY_TEXT));
  if (!slug) return [];
  const all = await client.category.findMany({ where: { isActive: true, forDishes: true }, select: { name: true, slug: true }, take: MAX_CATEGORIES });
  return all
    .map((c) => ({ name: c.name, score: c.slug.includes(slug) || slug.includes(c.slug) ? 0 : distance(slug, c.slug) }))
    .filter((c) => c.score <= Math.max(2, Math.floor(slug.length / 3)))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((c) => c.name);
};

/** Creates 'Main Course' when it does not exist yet (the default of a dish without a category). Race safe (unique slug). */
const ensureDefaultDishCategory = async (tx: Tx) => {
  const slug = slugOf(DEFAULT_DISH_CATEGORY);
  if (await tx.category.findUnique({ where: { slug }, select: { id: true } })) return;
  await tx.$executeRaw`
    INSERT INTO "Category" ("id", "name", "slug", "icon", "sortOrder", "isActive", "forRestaurants", "forDishes", "showOnHome", "createdAt", "updatedAt")
    SELECT ${randomUUID()}, ${DEFAULT_DISH_CATEGORY}, ${slug}, 'restaurant', COALESCE(MAX("sortOrder"), 0) + 1, true, false, true, false, now(), now() FROM "Category"
    ON CONFLICT ("slug") DO NOTHING`;
  invalidatePublicCategories();
};

/**
 * Resolves the category of a dish for ANY writer (restaurant app, admin create / edit, bulk, import): by id or by name (ignoring case and
 * spacing), takes a FOR SHARE lock on it and returns the CANONICAL name. Must run inside the writer's transaction BEFORE it locks the
 * restaurant or the dish (lock order). Rules: the category must exist, be active and be a dish category. A dish that keeps the category it
 * already has never fails because that category was deactivated since (`current`). Nothing given = 'Main Course' (created when missing).
 */
export const resolveDishCategory = async (
  tx: Tx,
  input: DishCategoryInput,
  opts: { admin: boolean; current?: { categoryId: string | null; category: string } | null },
): Promise<ResolvedCategory> => {
  let typed: string | null = null;
  if (input.name !== undefined && input.name !== null) {
    // Checked FIRST, before any normalisation, lookup or suggestion work: no category name is longer than this.
    if (typeof input.name !== 'string' || input.name.length > MAX_DISH_CATEGORY_TEXT * 4) throw bad('category', UNKNOWN_MESSAGE, 'CATEGORY_UNKNOWN');
    typed = collapse(input.name) || null;
    if (typed && typed.length > MAX_DISH_CATEGORY_TEXT) throw bad('category', UNKNOWN_MESSAGE, 'CATEGORY_UNKNOWN');
  }
  let wantedId: string | null = null;
  if (input.id !== undefined && input.id !== null && input.id !== '') {
    if (typeof input.id !== 'string' || !ID_RE.test(input.id)) throw bad('categoryId', UNKNOWN_MESSAGE, 'CATEGORY_UNKNOWN');
    wantedId = input.id;
  }
  if (!typed && !wantedId) {
    await ensureDefaultDishCategory(tx);
    typed = DEFAULT_DISH_CATEGORY;
  }
  const wantedSlug = typed ? slugOf(typed) : null;
  if (typed && !wantedSlug && !wantedId) await unknownCategory(tx, typed, opts.admin);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = wantedId
      ? await tx.category.findUnique({ where: { id: wantedId } })
      : await tx.category.findUnique({ where: { slug: wantedSlug! } });
    if (!candidate) return unknownCategory(tx, typed ?? '', opts.admin);
    if (wantedId && wantedSlug && candidate.slug !== wantedSlug) {
      throw bad('categoryId', 'The category name and categoryId do not belong to the same category.', 'CATEGORY_UNKNOWN');
    }
    const locked = await lockCategories(tx, [candidate.id], 'SHARE');
    if (locked.length === 0) continue; // merged or deleted while we looked: look again
    const fresh = await tx.category.findUnique({ where: { id: candidate.id } });
    if (!fresh) continue;
    if (!wantedId && fresh.slug !== wantedSlug) continue; // renamed while we looked: the name no longer points here
    const unchanged = !!opts.current && (opts.current.categoryId === fresh.id || slugOf(opts.current.category) === fresh.slug);
    if (!unchanged && !(fresh.isActive && fresh.forDishes)) return unknownCategory(tx, typed ?? fresh.name, opts.admin);
    return { id: fresh.id, name: fresh.name };
  }
  return unknownCategory(tx, typed ?? '', opts.admin);
};

/**
 * Resolution for an EDIT of an existing dish. A legacy dish (no categoryId yet) whose category text is sent back unchanged never fails,
 * even when the text has no letters or digits or matches no category (an old dashboard echoes the whole dish): it is linked when a category
 * matches and otherwise left exactly as it is (`null` = keep).
 */
export const resolveDishCategoryForEdit = async (
  tx: Tx,
  input: DishCategoryInput,
  opts: { admin: boolean; current: { categoryId: string | null; category: string } },
): Promise<ResolvedCategory | null> => {
  const typed = typeof input.name === 'string' ? collapse(input.name) : '';
  const noId = input.id === undefined || input.id === null || input.id === '';
  const echo = !opts.current.categoryId && !!typed && noId && typed === collapse(opts.current.category);
  if (!echo) return resolveDishCategory(tx, input, opts);
  try {
    return await resolveDishCategory(tx, input, opts);
  } catch (e) {
    if (e instanceof AppError && e.code === 'CATEGORY_UNKNOWN') return null;
    throw e;
  }
};

const unknownCategory = async (tx: Tx, typed: string, admin: boolean): Promise<never> => {
  const suggestions = admin && typed ? await suggestDishCategories(tx, typed) : [];
  throw new AppError(400, 'CATEGORY_UNKNOWN', UNKNOWN_MESSAGE, 'category', admin ? { suggestions } : {});
};

/** The same check without a transaction (request validation, dry runs): no lock, so only the writer's own resolve is authoritative. */
export const peekDishCategory = (input: DishCategoryInput, opts: { admin: boolean; current?: { categoryId: string | null; category: string } | null }) =>
  prisma.$transaction((tx) => resolveDishCategory(tx, input, opts), TX_OPTS);

// ---------------------------------------------------------------------------------------------------------------------
// Restaurant cuisines
// ---------------------------------------------------------------------------------------------------------------------
export type Cuisine = { id: string; name: string };

/** Validates a `cuisineIds` value: an array of 0..6 distinct category ids. */
export const checkCuisineIds = (raw: unknown, field = 'cuisineIds'): string[] => {
  if (!Array.isArray(raw)) throw bad(field, 'cuisineIds must be a list of category ids.');
  if (raw.length > MAX_CUISINES) throw bad(field, `A restaurant can have at most ${MAX_CUISINES} categories.`, 'TOO_MANY_CATEGORIES');
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !ID_RE.test(v)) throw bad(field, 'Every category id must be a valid id.');
    if (ids.includes(v)) throw bad(field, 'The same category is listed twice.');
    ids.push(v);
  }
  return ids;
};

/**
 * Locks the given categories (FOR SHARE, ascending id) and returns them in the REQUESTED order. Every id must exist. A category that is
 * not already linked (`keep`) must also be active and a restaurant category.
 */
export const lockCuisines = async (tx: Tx, ids: string[], keep: Set<string> = new Set(), field = 'cuisineIds'): Promise<Cuisine[]> => {
  if (ids.length === 0) return [];
  const locked = await lockCategories(tx, ids, 'SHARE');
  if (locked.length !== uniqueSorted(ids).length) throw bad(field, 'One of the categories does not exist (it may have been deleted). Reload the list and try again.', 'CATEGORY_UNKNOWN');
  const rows = await tx.category.findMany({ where: { id: { in: ids } } });
  const byId = new Map(rows.map((c) => [c.id, c] as const));
  return ids.map((id) => {
    const c = byId.get(id);
    if (!c) throw bad(field, 'One of the categories does not exist.', 'CATEGORY_UNKNOWN');
    if (!keep.has(id) && !(c.isActive && c.forRestaurants)) throw bad(field, `"${c.name}" cannot be added to a restaurant right now.`, 'CATEGORY_NOT_AVAILABLE');
    return { id: c.id, name: c.name };
  });
};

/** Replaces the cuisines of a restaurant (rows already locked by the caller) and re-derives Vendor.category. Returns the new string. */
export const writeVendorCuisines = async (tx: Tx, vendorId: string, cuisines: Cuisine[]): Promise<string> => {
  await tx.vendorCategory.deleteMany({ where: { vendorId } });
  if (cuisines.length) await tx.vendorCategory.createMany({ data: cuisines.map((c, position) => ({ vendorId, categoryId: c.id, position })) });
  const category = deriveVendorCategory(cuisines.map((c) => c.name));
  await tx.vendor.update({ where: { id: vendorId }, data: { category } });
  return category;
};

/** Free-text category -> tokens, exactly like the migration: split on bullet, comma or pipe; invalid characters dropped; max 6; one per slug. */
export const parseLegacyCategoryText = (text: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[•,|]/)) {
    const name = collapse(part.replace(/[^A-Za-z0-9 &'\-/+]/g, ' ')).slice(0, MAX_NAME_LEN).trim();
    const slug = slugOf(name);
    if (name.length < 2 || !slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(name);
    if (out.length >= MAX_CUISINES) break;
  }
  return out;
};

/**
 * The legacy free-text path of restaurant creation (`category` as typed by old callers): matches existing restaurant categories, creates
 * unknown tokens as restaurant-only categories (not on Home), locks them and returns them in order. Tokens that match a deactivated or
 * dish-only category are skipped. New categories stop being created at MAX_CATEGORIES.
 */
export const cuisinesFromText = async (tx: Tx, text: string): Promise<Cuisine[]> => {
  const tokens = parseLegacyCategoryText(text);
  if (tokens.length === 0) return [];
  const slugs = tokens.map(slugOf);
  let existing = await tx.category.findMany({ where: { slug: { in: slugs } } });
  const missing = tokens.filter((t) => !existing.some((c) => c.slug === slugOf(t)));
  if (missing.length) {
    const total = await tx.category.count();
    for (const name of missing.slice(0, Math.max(0, MAX_CATEGORIES - total))) {
      await tx.$executeRaw`
        INSERT INTO "Category" ("id", "name", "slug", "icon", "sortOrder", "isActive", "forRestaurants", "forDishes", "showOnHome", "createdAt", "updatedAt")
        SELECT ${randomUUID()}, ${name}, ${slugOf(name)}, ${guessIcon(name)}, COALESCE(MAX("sortOrder"), 0) + 1, true, true, false, false, now(), now() FROM "Category"
        ON CONFLICT ("slug") DO NOTHING`;
    }
    existing = await tx.category.findMany({ where: { slug: { in: slugs } } });
    invalidatePublicCategories();
  }
  const bySlug = new Map(existing.map((c) => [c.slug, c] as const));
  const wanted = slugs.map((s) => bySlug.get(s)).filter((c): c is Category => !!c && c.isActive && c.forRestaurants);
  if (wanted.length === 0) return [];
  await lockCategories(tx, wanted.map((c) => c.id), 'SHARE');
  const fresh = await tx.category.findMany({ where: { id: { in: wanted.map((c) => c.id) } } });
  const freshById = new Map(fresh.map((c) => [c.id, c] as const));
  return wanted.flatMap((c) => {
    const f = freshById.get(c.id);
    return f && f.isActive && f.forRestaurants ? [{ id: f.id, name: f.name }] : [];
  });
};

/**
 * Restaurant creation helper (POST /admin/partners and POST /vendors): `cuisineIds` wins; otherwise the free text is parsed. Runs in the
 * caller's transaction BEFORE the restaurant row is created; returns what to store in Vendor.category and the links to create afterwards.
 */
export const prepareNewVendorCuisines = async (
  tx: Tx,
  input: { cuisineIds?: unknown; text?: string | null },
  fallbackText: string,
): Promise<{ category: string; cuisines: Cuisine[] }> => {
  if (input.cuisineIds !== undefined) {
    const cuisines = await lockCuisines(tx, checkCuisineIds(input.cuisineIds));
    return { category: deriveVendorCategory(cuisines.map((c) => c.name)), cuisines };
  }
  // No category given at all: the old default text is kept as it is and NO category rows are created for it.
  const text = input.text ? collapse(input.text) : '';
  if (!text) return { category: fallbackText, cuisines: [] };
  const cuisines = await cuisinesFromText(tx, text);
  return { category: cuisines.length ? deriveVendorCategory(cuisines.map((c) => c.name)) : text.slice(0, 60), cuisines };
};

/**
 * An OWNER path that rewrites the restaurant's category TEXT (PUT /partner/application of a pending or rejected restaurant): the text goes
 * through the same legacy-token parser as creation and the links follow, so Vendor.category, VendorCategory and `tags` always agree. The
 * string is DERIVED from the links (never cut to 60 characters while the links stay longer); text that matches nothing usable clears the
 * links and is kept as typed. Runs in the caller's transaction: categories (FOR SHARE) first, then the restaurant row.
 */
export const applyOwnerCategoryText = async (tx: Tx, vendorId: string, text: string) => {
  const cuisines = await cuisinesFromText(tx, text);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
  if (cuisines.length) await writeVendorCuisines(tx, vendorId, cuisines);
  else {
    await tx.vendorCategory.deleteMany({ where: { vendorId } });
    await tx.vendor.update({ where: { id: vendorId }, data: { category: collapse(text).slice(0, 60) || DEFAULT_VENDOR_CATEGORY } });
  }
};

export const linkNewVendorCuisines = async (tx: Tx, vendorId: string, cuisines: Cuisine[]) => {
  if (cuisines.length) await tx.vendorCategory.createMany({ data: cuisines.map((c, position) => ({ vendorId, categoryId: c.id, position })) });
};

// ---------------------------------------------------------------------------------------------------------------------
// Admin: create / patch / reorder / merge / delete
// ---------------------------------------------------------------------------------------------------------------------
const conflict = async (slug: string) => {
  const row = (await withCounts(prisma, Prisma.sql`c."slug" = ${slug}`))[0];
  return new AppError(409, 'CATEGORY_EXISTS', row ? `There is already a category called "${row.name}".` : 'There is already a category with this name.', 'name', row ? { existing: adminCategoryView(row) } : {});
};
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === 'P2002';

const CREATE_KEYS = ['name', 'nameHi', 'icon', 'forRestaurants', 'forDishes', 'showOnHome'];
const PATCH_KEYS = [...CREATE_KEYS, 'isActive', 'sortOrder'];
const rejectUnknownKeys = (b: Record<string, unknown>, allowed: string[]) => {
  const unknown = Object.keys(b).find((k) => !allowed.includes(k));
  if (unknown) throw bad(unknown.slice(0, 40), `Unknown field '${unknown.slice(0, 40)}'. You can send: ${allowed.join(', ')}.`);
};

export const createCategory = async (b: Record<string, unknown>, actor: Actor) => {
  rejectUnknownKeys(b, CREATE_KEYS);
  const { name, slug } = checkCategoryName(b.name);
  const nameHi = b.nameHi === undefined ? null : checkNameHi(b.nameHi);
  const icon = b.icon === undefined ? guessIcon(name) : checkIcon(b.icon);
  const forRestaurants = b.forRestaurants === undefined ? true : checkBool(b.forRestaurants, 'forRestaurants');
  const forDishes = b.forDishes === undefined ? true : checkBool(b.forDishes, 'forDishes');
  const showOnHome = b.showOnHome === undefined ? false : checkBool(b.showOnHome, 'showOnHome');
  if (!forRestaurants && !forDishes) throw bad('forDishes', 'A category must be usable for restaurants, for dishes, or both.');
  try {
    const created = await prisma.$transaction(async (tx) => {
      if ((await tx.category.count()) >= MAX_CATEGORIES) throw new AppError(409, 'TOO_MANY_CATEGORIES', `There are already ${MAX_CATEGORIES} categories. Delete or merge unused ones first.`);
      const next = (await tx.category.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0;
      return tx.category.create({ data: { name, slug, nameHi, icon, forRestaurants, forDishes, showOnHome, sortOrder: next + 1 } });
    }, TX_OPTS);
    invalidatePublicCategories();
    await writeAudit('CATEGORY_CREATED', 'CATEGORY', created.id, `Admin created category "${name}" (restaurants ${forRestaurants}, dishes ${forDishes}, home ${showOnHome}, icon ${icon})`);
    return (await adminViewOf(prisma, created.id))!;
  } catch (e) {
    if (isUniqueViolation(e)) throw await conflict(slug);
    throw e;
  }
};

type PatchPlan = Partial<Pick<Category, 'name' | 'slug' | 'nameHi' | 'icon' | 'forRestaurants' | 'forDishes' | 'showOnHome' | 'isActive' | 'sortOrder'>>;

export const patchCategory = async (id: string, b: Record<string, unknown>, actor: Actor) => {
  rejectUnknownKeys(b, PATCH_KEYS);
  if (Object.keys(b).length === 0) throw bad('body', `Send at least one of: ${PATCH_KEYS.join(', ')}.`);
  const want: PatchPlan = {};
  // `name` is validated (strict rules) only when it actually CHANGES, inside the transaction: a legacy name that the backfill created
  // ("Rolls (Veg)", a long or non-ASCII word) can be sent back unchanged together with other fields.
  if (b.name !== undefined && typeof b.name !== 'string') throw bad('name', 'Enter a name for the category (2 to 30 characters).');
  if (b.nameHi !== undefined) want.nameHi = checkNameHi(b.nameHi);
  if (b.icon !== undefined) want.icon = checkIcon(b.icon);
  for (const k of ['forRestaurants', 'forDishes', 'showOnHome', 'isActive'] as const) if (b[k] !== undefined) want[k] = checkBool(b[k], k);
  if (b.sortOrder !== undefined) {
    if (typeof b.sortOrder !== 'number' || !Number.isInteger(b.sortOrder) || b.sortOrder < 0 || b.sortOrder > 100_000) throw bad('sortOrder', 'sortOrder must be a whole number from 0 to 100000.');
    want.sortOrder = b.sortOrder;
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      if ((await lockCategories(tx, [id], 'UPDATE')).length === 0) throw new AppError(404, 'NOT_FOUND', 'Category not found.');
      const before = await tx.category.findUniqueOrThrow({ where: { id } });
      if (typeof b.name === 'string' && collapse(b.name) !== collapse(before.name)) {
        const n = checkCategoryName(b.name);
        want.name = n.name;
        want.slug = n.slug;
      }
      const diff: PatchPlan = {};
      for (const [k, v] of Object.entries(want)) if ((before as Record<string, unknown>)[k] !== v) (diff as Record<string, unknown>)[k] = v;
      if (Object.keys(diff).length === 0) return { changed: false, before, renamed: false, moved: { dishes: 0, restaurants: 0 } };
      if (diff.slug !== undefined && diff.slug !== before.slug) assertNotProtected(before, 'rename');
      if (diff.isActive === false) assertNotProtected(before, 'hide');
      if (diff.forDishes === false) assertNotProtected(before, 'dish category off');

      const nextR = diff.forRestaurants ?? before.forRestaurants;
      const nextD = diff.forDishes ?? before.forDishes;
      if (!nextR && !nextD) throw bad('forDishes', 'A category must be usable for restaurants, for dishes, or both.');
      if (diff.forDishes === false) {
        const dishes = await tx.menuItem.count({ where: { categoryId: id } });
        if (dishes > 0) throw new AppError(409, 'CATEGORY_IN_USE', `${dishes} dish${dishes === 1 ? ' uses' : 'es use'} this category, so it cannot stop being a dish category. Merge it into another one first.`, 'forDishes', { dishes });
      }
      if (diff.forRestaurants === false) {
        const restaurants = await tx.vendorCategory.count({ where: { categoryId: id } });
        if (restaurants > 0) throw new AppError(409, 'CATEGORY_IN_USE', `${restaurants} restaurant${restaurants === 1 ? ' uses' : 's use'} this category, so it cannot stop being a restaurant category. Merge it into another one first.`, 'forRestaurants', { restaurants });
      }
      if (diff.slug !== undefined && diff.slug !== before.slug) {
        if (await tx.category.findUnique({ where: { slug: diff.slug }, select: { id: true } })) throw new AppError(409, 'CATEGORY_EXISTS', 'There is already a category with this name.', 'name', { slug: diff.slug });
      }
      await tx.category.update({ where: { id }, data: diff });

      // Rename: every denormalised copy changes in THIS transaction (restaurants first, then dishes: the fixed lock order).
      const renamed = diff.name !== undefined;
      let moved = { dishes: 0, restaurants: 0 };
      if (renamed) {
        const links = await tx.vendorCategory.findMany({ where: { categoryId: id }, select: { vendorId: true }, orderBy: { vendorId: 'asc' } });
        const vendorIds = links.map((l) => l.vendorId);
        await lockVendors(tx, vendorIds);
        await rederiveVendorCategories(tx, vendorIds);
        await tx.$queryRaw`SELECT "id" FROM "MenuItem" WHERE "categoryId" = ${id} ORDER BY "id" FOR UPDATE`;
        const dishes = await tx.$executeRaw`UPDATE "MenuItem" SET "category" = ${diff.name!} WHERE "categoryId" = ${id}`;
        moved = { dishes, restaurants: vendorIds.length };
      }
      return { changed: true, before, diff, renamed, moved };
    }, TX_OPTS);

    if (out.changed) invalidatePublicCategories();
    const data = (await adminViewOf(prisma, id))!;
    if (out.changed && 'diff' in out && out.diff) {
      const parts = Object.entries(out.diff).filter(([k]) => k !== 'slug').map(([k, v]) => `${k} ${JSON.stringify((out.before as Record<string, unknown>)[k])} -> ${JSON.stringify(v)}`);
      await writeAudit('CATEGORY_EDITED', 'CATEGORY', id, `Admin edited category "${out.before.name}": ${parts.join('; ')}${out.renamed ? ` (updated ${out.moved.dishes} dishes, ${out.moved.restaurants} restaurants)` : ''}`);
    }
    return { changed: out.changed, data };
  } catch (e) {
    if (isUniqueViolation(e) && want.slug) throw await conflict(want.slug);
    if (e instanceof AppError && e.code === 'CATEGORY_EXISTS' && typeof e.extra.slug === 'string') throw await conflict(e.extra.slug);
    throw e;
  }
};

/** POST /admin/categories/reorder `{ids}`: those categories get 1..n in that order; the rest follow in their current order. */
export const reorderCategories = async (rawIds: unknown, actor: Actor) => {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_CATEGORIES * 2) throw bad('ids', 'ids must be a list of category ids.');
  const ids: string[] = [];
  for (const v of rawIds) {
    if (typeof v !== 'string' || !ID_RE.test(v)) throw bad('ids', 'Every id must be a valid category id.');
    if (ids.includes(v)) throw bad('ids', 'The same category is listed twice.');
    ids.push(v);
  }
  const out = await prisma.$transaction(async (tx) => {
    const all = await tx.category.findMany({ select: { id: true } });
    await lockCategories(tx, all.map((c) => c.id), 'UPDATE');
    // Read AGAIN after the locks: a category deleted between the first read and the lock is simply not in this list any more,
    // so the request is a clean 400 (reload the list) and never a failed update.
    const current = await tx.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }], select: { id: true, sortOrder: true } });
    const known = new Set(current.map((c) => c.id));
    if (ids.some((i) => !known.has(i))) throw bad('ids', 'One of the categories does not exist (it may have been deleted). Reload the list and try again.', 'CATEGORY_UNKNOWN');
    const listed = new Set(ids);
    const order = [...ids, ...current.filter((c) => !listed.has(c.id)).map((c) => c.id)];
    const bySort = new Map(current.map((c) => [c.id, c.sortOrder] as const));
    const changedIds: string[] = [];
    const newOrders: number[] = [];
    for (const [i, cid] of order.entries()) {
      if (bySort.get(cid) !== i + 1) { changedIds.push(cid); newOrders.push(i + 1); }
    }
    if (changedIds.length) {
      await tx.$executeRaw`
        UPDATE "Category" c SET "sortOrder" = v."so", "updatedAt" = now()
        FROM unnest(${changedIds}::text[], ${newOrders}::int[]) AS v("id", "so") WHERE c."id" = v."id"`;
    }
    return { moved: changedIds.length, total: order.length };
  }, { maxWait: 10_000, timeout: 30_000 });
  if (out.moved > 0) invalidatePublicCategories();
  if (out.moved > 0) await writeAudit('CATEGORY_REORDERED', 'CATEGORY', 'all', `Admin reordered the categories: ${out.moved} of ${out.total} changed position`);
  return { changed: out.moved > 0, moved: out.moved, data: await listAdminCategories(true) };
};

/** POST /admin/categories/:id/merge `{ intoId, dryRun? }` (dry run is the default). */
export const mergeCategory = async (fromId: string, b: Record<string, unknown>, actor: Actor) => {
  rejectUnknownKeys(b, ['intoId', 'dryRun']);
  if (typeof b.intoId !== 'string' || !ID_RE.test(b.intoId)) throw bad('intoId', 'Choose the category to merge into.');
  if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw bad('dryRun', 'dryRun must be true or false.');
  const intoId = b.intoId;
  if (intoId === fromId) throw bad('intoId', 'A category cannot be merged into itself.');
  const dryRun = b.dryRun !== false;

  const plan = async (tx: Tx) => {
    const rows = await tx.category.findMany({ where: { id: { in: [fromId, intoId] } } });
    const from = rows.find((c) => c.id === fromId);
    const into = rows.find((c) => c.id === intoId);
    if (!from) throw new AppError(404, 'NOT_FOUND', 'The category to merge was not found (it may already be merged or deleted).');
    if (!into) throw new AppError(404, 'NOT_FOUND', 'The category to merge into was not found.', 'intoId');
    assertNotProtected(from, 'merge away'); // the preview refuses it too, so the admin never sees a merge that would fail on apply
    const [dishes, links] = await Promise.all([
      tx.menuItem.count({ where: { categoryId: fromId } }),
      tx.vendorCategory.findMany({ where: { categoryId: fromId }, select: { vendorId: true } }),
    ]);
    if (!into.isActive) throw new AppError(409, 'CATEGORY_INACTIVE', `"${into.name}" is hidden. Choose an active category to merge into.`, 'intoId');
    if (dishes > 0 && !into.forDishes) throw new AppError(409, 'CATEGORY_INCOMPATIBLE', `"${into.name}" is not a dish category, but ${dishes} dishes would move into it.`, 'intoId', { dishes });
    if (links.length > 0 && !into.forRestaurants) throw new AppError(409, 'CATEGORY_INCOMPATIBLE', `"${into.name}" is not a restaurant category, but ${links.length} restaurants would move into it.`, 'intoId', { restaurants: links.length });
    return { from, into, dishes, vendorIds: links.map((l) => l.vendorId) };
  };

  if (dryRun) {
    const p = await prisma.$transaction((tx) => plan(tx), TX_OPTS);
    return { dryRun: true, from: { id: p.from.id, name: p.from.name }, into: { id: p.into.id, name: p.into.name }, dishes: p.dishes, restaurants: p.vendorIds.length };
  }

  const done = await prisma.$transaction(async (tx) => {
    // Both rows, ascending id, before anything is read: nobody can rename, delete or tag them while we move things.
    const locked = await lockCategories(tx, [fromId, intoId], 'UPDATE');
    if (!locked.includes(fromId)) throw new AppError(404, 'NOT_FOUND', 'The category to merge was not found (it may already be merged or deleted).');
    if (!locked.includes(intoId)) throw new AppError(404, 'NOT_FOUND', 'The category to merge into was not found.', 'intoId');
    const p = await plan(tx);
    const bothLinks = await tx.vendorCategory.findMany({ where: { categoryId: { in: [fromId, intoId] } }, select: { vendorId: true } });
    const vendorIds = uniqueSorted(bothLinks.map((l) => l.vendorId));
    await lockVendors(tx, vendorIds);
    await tx.$queryRaw`SELECT "id" FROM "MenuItem" WHERE "categoryId" = ${fromId} ORDER BY "id" FOR UPDATE`;

    // Restaurants: a restaurant that has both keeps ONE link at the better (smaller) position; a restaurant that has only the source moves it.
    await tx.$executeRaw`
      UPDATE "VendorCategory" t SET "position" = LEAST(t."position", s."position")
      FROM "VendorCategory" s WHERE s."categoryId" = ${fromId} AND t."categoryId" = ${intoId} AND t."vendorId" = s."vendorId"`;
    await tx.$executeRaw`
      DELETE FROM "VendorCategory" s WHERE s."categoryId" = ${fromId}
        AND EXISTS (SELECT 1 FROM "VendorCategory" t WHERE t."vendorId" = s."vendorId" AND t."categoryId" = ${intoId})`;
    await tx.$executeRaw`UPDATE "VendorCategory" SET "categoryId" = ${intoId} WHERE "categoryId" = ${fromId}`;
    // Tidy positions 0..n-1 of the touched restaurants (keeps the order).
    if (vendorIds.length) {
      await tx.$executeRaw`
        UPDATE "VendorCategory" vc SET "position" = r.rn - 1
        FROM (SELECT "vendorId", "categoryId", ROW_NUMBER() OVER (PARTITION BY "vendorId" ORDER BY "position", "categoryId") AS rn
                FROM "VendorCategory" WHERE "vendorId" = ANY(${vendorIds}::text[])) r
        WHERE vc."vendorId" = r."vendorId" AND vc."categoryId" = r."categoryId" AND vc."position" <> r.rn - 1`;
    }
    await rederiveVendorCategories(tx, vendorIds);
    const dishes = await tx.$executeRaw`UPDATE "MenuItem" SET "categoryId" = ${intoId}, "category" = ${p.into.name} WHERE "categoryId" = ${fromId}`;
    await tx.category.delete({ where: { id: fromId } });
    return { from: p.from, into: p.into, dishes, restaurants: p.vendorIds.length };
  }, { maxWait: 10_000, timeout: 30_000 });

  invalidatePublicCategories();
  await writeAudit('CATEGORY_MERGED', 'CATEGORY', fromId, `Admin merged category "${done.from.name}" into "${done.into.name}": ${done.dishes} dishes and ${done.restaurants} restaurants moved; "${done.from.name}" was removed`);
  return {
    dryRun: false,
    from: { id: done.from.id, name: done.from.name },
    into: { id: done.into.id, name: done.into.name },
    dishes: done.dishes,
    restaurants: done.restaurants,
    category: await adminViewOf(prisma, done.into.id),
  };
};

/** DELETE /admin/categories/:id: only when nothing uses it (any dish in any state, any restaurant). */
export const deleteCategory = async (id: string, actor: Actor) => {
  const gone = await prisma.$transaction(async (tx) => {
    if ((await lockCategories(tx, [id], 'UPDATE')).length === 0) throw new AppError(404, 'NOT_FOUND', 'Category not found (it may already be deleted).');
    const row = await tx.category.findUniqueOrThrow({ where: { id }, select: { slug: true } });
    assertNotProtected(row, 'delete');
    const [dishes, restaurants] = await Promise.all([tx.menuItem.count({ where: { categoryId: id } }), tx.vendorCategory.count({ where: { categoryId: id } })]);
    if (dishes + restaurants > 0) {
      throw new AppError(409, 'CATEGORY_IN_USE', `This category is used by ${restaurants} restaurant${restaurants === 1 ? '' : 's'} and ${dishes} dish${dishes === 1 ? '' : 'es'}. Hide it, or merge it into another category.`, undefined, { restaurants, dishes });
    }
    return tx.category.delete({ where: { id } });
  }, TX_OPTS).catch((e) => {
    // The foreign keys are the last line of defence if a writer ever slips past the lock.
    if ((e as { code?: string })?.code === 'P2003') throw new AppError(409, 'CATEGORY_IN_USE', 'This category is in use. Hide it, or merge it into another category.');
    throw e;
  });
  invalidatePublicCategories();
  await writeAudit('CATEGORY_DELETED', 'CATEGORY', id, `Admin deleted the unused category "${gone.name}"`);
  return { id, name: gone.name };
};
