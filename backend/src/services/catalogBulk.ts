import { randomUUID } from 'crypto';
import { Category, MenuItem, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { ID_RE } from '../utils/http';
import { priceProblem } from '../utils/catalog';
import { errSummary } from '../utils/log';
import { writeAudit } from './audit';
import { approveDish, lockDish, notFound, priceFor, restoreDish, softDeleteDish, TX_OPTS, Actor } from './catalog';
import { collapse, lockCategories, peekDishCategory, resolveDishCategory, slugOf } from './categories';
import { getSettings } from './settings';
import { ruleFromColumns, toPaise } from './pricing';

/**
 * Admin bulk actions on dishes and the whole-menu import (Docs/23 sections 3.5). Lock order everywhere: category rows (ascending id) ->
 * the restaurant row -> dish rows.
 */
const bad = (field: string, message: string, code = 'BAD_REQUEST') => new AppError(400, code, message, field);

// ---------------------------------------------------------------------------------------------------------------------
// POST /admin/catalog/bulk
// ---------------------------------------------------------------------------------------------------------------------
export const BULK_ACTIONS = ['AVAILABLE', 'UNAVAILABLE', 'DELETE', 'RESTORE', 'APPROVE', 'SET_CATEGORY'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const MAX_BULK_IDS = 100;

const setAvailability = async (itemId: string, value: boolean, actor: Actor) => {
  const out = await prisma.$transaction(async (tx) => {
    const item = await lockDish(tx, itemId);
    if (!item) throw notFound();
    if (item.deletedAt) throw new AppError(409, 'ITEM_DELETED', 'This dish is deleted. Restore it first.');
    if (item.isAvailable === value) return { item, changed: false };
    const updated = await tx.menuItem.update({ where: { id: itemId }, data: { isAvailable: value }, include: { vendor: { select: { name: true } } } });
    return { item: updated, changed: true };
  }, TX_OPTS);
  if (out.changed) await writeAudit('DISH_EDITED', 'MENU_ITEM', itemId, `Admin set "${out.item.name}" (${(out.item as { vendor?: { name: string } }).vendor?.name ?? 'restaurant'}) ${value ? 'available' : 'unavailable'} (bulk)`);
  return { changed: out.changed };
};

const setCategory = async (itemId: string, input: { name?: unknown; id?: unknown }, actor: Actor) => {
  const out = await prisma.$transaction(async (tx) => {
    const current = await tx.menuItem.findUnique({ where: { id: itemId }, select: { categoryId: true, category: true } });
    if (!current) throw notFound();
    const resolved = await resolveDishCategory(tx, input, { admin: true, current }); // category lock first
    const item = await lockDish(tx, itemId);
    if (!item) throw notFound();
    if (item.deletedAt) throw new AppError(409, 'ITEM_DELETED', 'This dish is deleted. Restore it first.');
    if (item.categoryId === resolved.id && item.category === resolved.name) return { item, changed: false, from: item.category };
    const updated = await tx.menuItem.update({ where: { id: itemId }, data: { category: resolved.name, categoryRef: { connect: { id: resolved.id } } }, include: { vendor: { select: { name: true } } } });
    return { item: updated, changed: true, from: item.category };
  }, TX_OPTS);
  if (out.changed) await writeAudit('DISH_EDITED', 'MENU_ITEM', itemId, `Admin moved "${out.item.name}" from category "${out.from}" to "${out.item.category}" (bulk)`);
  return { changed: out.changed };
};

type BulkResult = { id: string; ok: boolean; changed: boolean; code?: string; message?: string };

export const bulkDishAction = async (b: Record<string, unknown>, actor: Actor) => {
  const unknown = Object.keys(b).find((k) => !['ids', 'action', 'category', 'categoryId'].includes(k));
  if (unknown) throw bad(unknown.slice(0, 40), `Unknown field '${unknown.slice(0, 40)}'. Send: ids, action, category or categoryId.`);
  if (!Array.isArray(b.ids) || b.ids.length === 0) throw bad('ids', 'Choose at least one dish.');
  if (b.ids.length > MAX_BULK_IDS) throw bad('ids', `You can change at most ${MAX_BULK_IDS} dishes at a time.`, 'TOO_MANY_ITEMS');
  const ids: string[] = [];
  for (const v of b.ids) {
    if (typeof v !== 'string' || !ID_RE.test(v)) throw bad('ids', 'Every id must be a valid dish id.');
    if (ids.includes(v)) throw bad('ids', 'The same dish is listed twice.');
    ids.push(v);
  }
  if (typeof b.action !== 'string' || !(BULK_ACTIONS as readonly string[]).includes(b.action)) throw bad('action', `action must be one of: ${BULK_ACTIONS.join(', ')}.`);
  const action = b.action as BulkAction;
  const wantsCategory = b.category !== undefined || b.categoryId !== undefined;
  if (action === 'SET_CATEGORY') {
    if (!wantsCategory) throw bad('category', 'Choose the new category.');
    // One check for the whole request: a category nobody may use would fail every item the same way.
    await peekDishCategory({ name: b.category, id: b.categoryId }, { admin: true });
  } else if (wantsCategory) {
    throw bad('category', 'category is only used with SET_CATEGORY.');
  }

  const results: BulkResult[] = [];
  for (const id of ids) {
    try {
      let changed: boolean;
      if (action === 'AVAILABLE' || action === 'UNAVAILABLE') changed = (await setAvailability(id, action === 'AVAILABLE', actor)).changed;
      else if (action === 'DELETE') changed = (await softDeleteDish(id, actor)).changed;
      else if (action === 'RESTORE') changed = (await restoreDish(id, actor)).changed;
      else if (action === 'APPROVE') changed = (await approveDish(id, {}, actor)).changed;
      else changed = (await setCategory(id, { name: b.category, id: b.categoryId }, actor)).changed;
      results.push({ id, ok: true, changed });
    } catch (e) {
      if (e instanceof AppError) results.push({ id, ok: false, changed: false, code: e.code, message: e.message });
      else {
        console.error('bulk dish action failed:', errSummary(e));
        results.push({ id, ok: false, changed: false, code: 'INTERNAL_ERROR', message: 'Something went wrong with this dish. Try it again.' });
      }
    }
  }
  const ok = results.filter((r) => r.ok).length;
  return { results, ok, failed: results.length - ok };
};

// ---------------------------------------------------------------------------------------------------------------------
// POST /admin/vendors/:id/menu-import
// ---------------------------------------------------------------------------------------------------------------------
export const MAX_IMPORT_ROWS = 200;
export const MAX_IMPORT_PRICE = 5000;
const IMPORT_KEYS = ['name', 'category', 'vendorPrice', 'isVeg', 'description', 'imageUrl', 'isAvailable'];
export const DEFAULT_DISH_IMAGE = 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400';
const LABEL_BAD = /[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

type RowError = { field: string; message: string };
export type ImportAction = 'create' | 'update' | 'skip' | 'invalid';
export type ImportRowReport = { index: number; name: string | null; action: ImportAction; errors: RowError[]; computedPrice: number | null; reason?: string; dishId?: string };

type ParsedRow = {
  name: string; category: Category; vendorPrice: number; isVeg?: boolean; description?: string; imageUrl?: string; isAvailable?: boolean;
};
type Existing = Pick<MenuItem, 'id' | 'name' | 'category' | 'categoryId' | 'vendorPrice' | 'price' | 'isVeg' | 'description' | 'imageUrl' | 'isAvailable' | 'commissionType' | 'commissionValue' | 'pendingVendorPrice'>;

type Planned =
  | { kind: 'create'; id: string; row: ParsedRow; price: number }
  | { kind: 'update'; existing: Existing; row: ParsedRow; price: number; data: Prisma.MenuItemUpdateInput }
  | { kind: 'skip' }
  | { kind: 'invalid' };

const parseRow = (raw: unknown, cats: Map<string, Category>, suggest: (typed: string) => string[]): { row?: ParsedRow; errors: RowError[]; name: string | null } => {
  const errors: RowError[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [{ field: 'row', message: 'This row is not a dish.' }], name: null };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!IMPORT_KEYS.includes(k)) errors.push({ field: k.slice(0, 40), message: `Unknown column '${k.slice(0, 40)}'.` });

  let name: string | null = null;
  if (typeof r.name !== 'string') errors.push({ field: 'name', message: 'The dish name is required.' });
  else {
    const n = collapse(r.name);
    if (n.length < 2 || n.length > 60) errors.push({ field: 'name', message: 'The dish name must be 2 to 60 characters.' });
    else if (LABEL_BAD.test(n)) errors.push({ field: 'name', message: 'The dish name cannot contain symbols like < >.' });
    else name = n;
  }

  let category: Category | undefined;
  if (typeof r.category !== 'string' || !collapse(r.category)) errors.push({ field: 'category', message: 'The category is required.' });
  else {
    category = cats.get(slugOf(r.category));
    if (!category) {
      const hint = suggest(r.category);
      errors.push({ field: 'category', message: `Pick a category from the list.${hint.length ? ` Did you mean: ${hint.join(', ')}?` : ''}` });
    }
  }

  let vendorPrice: number | undefined;
  const problem = priceProblem(r.vendorPrice);
  if (problem) errors.push({ field: 'vendorPrice', message: problem.replace(/^Price/, 'The price') });
  else if ((r.vendorPrice as number) > MAX_IMPORT_PRICE) errors.push({ field: 'vendorPrice', message: `The price cannot be more than ₹${MAX_IMPORT_PRICE}.` });
  else vendorPrice = r.vendorPrice as number;

  if (r.isVeg !== undefined && r.isVeg !== null && typeof r.isVeg !== 'boolean') errors.push({ field: 'isVeg', message: 'isVeg must be true or false.' });
  if (r.isAvailable !== undefined && r.isAvailable !== null && typeof r.isAvailable !== 'boolean') errors.push({ field: 'isAvailable', message: 'isAvailable must be true or false.' });
  let description: string | undefined;
  if (r.description !== undefined && r.description !== null) {
    if (typeof r.description !== 'string' || collapse(r.description).length > 300) errors.push({ field: 'description', message: 'The description can be at most 300 characters.' });
    else description = collapse(r.description);
  }
  let imageUrl: string | undefined;
  if (r.imageUrl !== undefined && r.imageUrl !== null && !(typeof r.imageUrl === 'string' && r.imageUrl.trim() === '')) {
    const u = typeof r.imageUrl === 'string' ? r.imageUrl.trim() : '';
    if (!u || u.length > 500 || !/^https?:\/\//i.test(u) || /\s/.test(u)) errors.push({ field: 'imageUrl', message: 'The image must be an http(s) link of up to 500 characters, or empty.' });
    else imageUrl = u;
  }
  if (errors.length || !name || !category || vendorPrice === undefined) return { errors, name };
  return {
    errors,
    name,
    row: {
      name, category, vendorPrice, description, imageUrl,
      isVeg: typeof r.isVeg === 'boolean' ? r.isVeg : undefined,
      isAvailable: typeof r.isAvailable === 'boolean' ? r.isAvailable : undefined,
    },
  };
};

type Plan = { report: ImportRowReport[]; planned: Planned[]; summary: { create: number; update: number; skip: number; invalid: number; total: number } };

/** The one place that decides what happens to each row. Used by the dry run and (again, under locks) by the apply. */
const planImport = (
  rows: unknown[],
  ctx: { cats: Category[]; existing: Existing[]; vendorRule: ReturnType<typeof ruleFromColumns>; settings: Awaited<ReturnType<typeof getSettings>>; onDuplicate: 'SKIP' | 'UPDATE'; suggestFrom: string[] },
): Plan => {
  const cats = new Map(ctx.cats.map((c) => [c.slug, c] as const));
  const byName = new Map<string, Existing[]>();
  for (const e of ctx.existing) {
    const key = collapse(e.name).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), e]);
  }
  const suggest = (typed: string) => {
    const slug = slugOf(typed);
    if (!slug) return [];
    return ctx.suggestFrom.filter((n) => { const s = slugOf(n); return s.includes(slug) || slug.includes(s); }).slice(0, 3);
  };
  const seenInFile = new Map<string, number>();
  const planned: Planned[] = [];
  const report: ImportRowReport[] = [];

  rows.forEach((raw, index) => {
    const parsed = parseRow(raw, cats, suggest);
    const base = { index, name: parsed.name };
    if (!parsed.row) {
      const priceOk = raw && typeof raw === 'object' && priceProblem((raw as Record<string, unknown>).vendorPrice) === null && ((raw as Record<string, unknown>).vendorPrice as number) <= MAX_IMPORT_PRICE;
      report.push({ ...base, action: 'invalid', errors: parsed.errors, computedPrice: priceOk ? priceFor((raw as Record<string, number>).vendorPrice, { dish: null, vendor: ctx.vendorRule }, ctx.settings).price : null });
      planned.push({ kind: 'invalid' });
      return;
    }
    const row = parsed.row;
    const key = collapse(row.name).toLowerCase();
    if (seenInFile.has(key)) {
      report.push({ ...base, action: 'invalid', errors: [{ field: 'name', message: `This dish name is repeated in the file (first at row ${seenInFile.get(key)! + 1}).` }], computedPrice: null });
      planned.push({ kind: 'invalid' });
      return;
    }
    seenInFile.set(key, index);

    const matches = byName.get(key) ?? [];
    if (matches.length > 1) {
      report.push({ ...base, action: 'invalid', errors: [{ field: 'name', message: 'This restaurant already has more than one dish with this name. Fix it in the catalog first.' }], computedPrice: null });
      planned.push({ kind: 'invalid' });
      return;
    }
    if (matches.length === 0) {
      const priced = priceFor(row.vendorPrice, { dish: null, vendor: ctx.vendorRule }, ctx.settings);
      const id = randomUUID();
      report.push({ ...base, action: 'create', errors: [], computedPrice: priced.price });
      planned.push({ kind: 'create', id, row, price: priced.price });
      return;
    }
    const existing = matches[0];
    const priced = priceFor(row.vendorPrice, { dish: ruleFromColumns(existing.commissionType, existing.commissionValue), vendor: ctx.vendorRule }, ctx.settings);
    if (ctx.onDuplicate === 'SKIP') {
      report.push({ ...base, action: 'skip', errors: [], computedPrice: priced.price, reason: 'DUPLICATE_EXISTS', dishId: existing.id });
      planned.push({ kind: 'skip' });
      return;
    }
    // UPDATE: only what the row carries is compared / written; an empty cell keeps the stored value.
    const data: Prisma.MenuItemUpdateInput = {};
    if (existing.categoryId !== row.category.id || existing.category !== row.category.name) Object.assign(data, { category: row.category.name, categoryRef: { connect: { id: row.category.id } } });
    if (toPaise(existing.vendorPrice) !== toPaise(row.vendorPrice) || toPaise(existing.price) !== toPaise(priced.price)) {
      Object.assign(data, { vendorPrice: row.vendorPrice, price: priced.price, pendingVendorPrice: null });
    }
    if (row.isVeg !== undefined && row.isVeg !== existing.isVeg) data.isVeg = row.isVeg;
    if (row.description !== undefined && row.description !== existing.description) data.description = row.description;
    if (row.imageUrl !== undefined && row.imageUrl !== existing.imageUrl) data.imageUrl = row.imageUrl;
    if (row.isAvailable !== undefined && row.isAvailable !== existing.isAvailable) data.isAvailable = row.isAvailable;
    if (Object.keys(data).length === 0) {
      report.push({ ...base, action: 'skip', errors: [], computedPrice: priced.price, reason: 'UNCHANGED', dishId: existing.id });
      planned.push({ kind: 'skip' });
      return;
    }
    report.push({ ...base, action: 'update', errors: [], computedPrice: priced.price, dishId: existing.id });
    planned.push({ kind: 'update', existing, row, price: priced.price, data });
  });

  const count = (a: ImportAction) => report.filter((r) => r.action === a).length;
  return { report, planned, summary: { create: count('create'), update: count('update'), skip: count('skip'), invalid: count('invalid'), total: report.length } };
};

const EXISTING_SELECT = { id: true, name: true, category: true, categoryId: true, vendorPrice: true, price: true, isVeg: true, description: true, imageUrl: true, isAvailable: true, commissionType: true, commissionValue: true, pendingVendorPrice: true } as const;

class Retry extends Error {}

export const importMenu = async (vendorId: string, b: Record<string, unknown>, actor: Actor) => {
  const unknown = Object.keys(b).find((k) => !['rows', 'dryRun', 'onDuplicate'].includes(k));
  if (unknown) throw bad(unknown.slice(0, 40), `Unknown field '${unknown.slice(0, 40)}'. Send: rows, dryRun, onDuplicate.`);
  if (!Array.isArray(b.rows) || b.rows.length === 0) throw bad('rows', 'Send at least one dish row.');
  if (b.rows.length > MAX_IMPORT_ROWS) throw bad('rows', `You can import at most ${MAX_IMPORT_ROWS} dishes at a time.`, 'TOO_MANY_ROWS');
  if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw bad('dryRun', 'dryRun must be true or false.');
  if (b.onDuplicate !== undefined && b.onDuplicate !== 'SKIP' && b.onDuplicate !== 'UPDATE') throw bad('onDuplicate', "onDuplicate must be 'SKIP' or 'UPDATE'.");
  const dryRun = b.dryRun !== false;
  const onDuplicate = b.onDuplicate === 'UPDATE' ? 'UPDATE' : 'SKIP';
  const rows = b.rows as unknown[];

  const settings = await getSettings();
  const vendorNameOf = (v: { name: string }) => v.name;

  if (dryRun) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, name: true, commissionType: true, commissionValue: true } });
    if (!vendor) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
    const [cats, existing] = await Promise.all([
      prisma.category.findMany({ where: { isActive: true, forDishes: true }, take: 600 }),
      prisma.menuItem.findMany({ where: { vendorId, deletedAt: null }, select: EXISTING_SELECT }),
    ]);
    const plan = planImport(rows, { cats, existing, vendorRule: ruleFromColumns(vendor.commissionType, vendor.commissionValue), settings, onDuplicate, suggestFrom: cats.map((c) => c.name) });
    return { dryRun: true, applied: false, summary: plan.summary, rows: plan.report };
  }

  // Apply: ONE transaction, all or nothing. Retried (at most twice more) only when a category changed between reading and locking it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const out = await prisma.$transaction(async (tx) => {
        const cats = await tx.category.findMany({ where: { isActive: true, forDishes: true }, take: 600 });
        const bySlug = new Map(cats.map((c) => [c.slug, c] as const));
        // 1. categories the rows use (ascending id, FOR SHARE), then 2. the restaurant row (also serialises two imports of the same file)
        const wanted = new Set<string>();
        for (const r of rows) {
          const slug = r && typeof r === 'object' && typeof (r as Record<string, unknown>).category === 'string' ? slugOf((r as Record<string, string>).category) : '';
          const c = slug ? bySlug.get(slug) : undefined;
          if (c) wanted.add(c.id);
        }
        const lockedIds = await lockCategories(tx, [...wanted], 'SHARE');
        const fresh = wanted.size ? await tx.category.findMany({ where: { id: { in: [...wanted] } } }) : [];
        const changedMeanwhile = lockedIds.length !== wanted.size || fresh.some((f) => { const old = cats.find((c) => c.id === f.id); return !old || old.name !== f.name || old.slug !== f.slug || !f.isActive || !f.forDishes; });
        if (changedMeanwhile) throw new Retry();

        const lockedVendor = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
        if (lockedVendor.length === 0) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
        const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { id: true, name: true, commissionType: true, commissionValue: true } });
        const existing = await tx.menuItem.findMany({ where: { vendorId, deletedAt: null }, select: EXISTING_SELECT });
        const plan = planImport(rows, { cats, existing, vendorRule: ruleFromColumns(vendor.commissionType, vendor.commissionValue), settings, onDuplicate, suggestFrom: cats.map((c) => c.name) });
        if (plan.summary.invalid > 0) {
          throw new AppError(400, 'IMPORT_INVALID', `${plan.summary.invalid} row${plan.summary.invalid === 1 ? ' is' : 's are'} not valid. Nothing was imported. Fix them and try again.`, 'rows', {
            data: { dryRun: false, applied: false, summary: plan.summary, rows: plan.report },
          });
        }

        const now = new Date();
        const creates = plan.planned.flatMap((p) => (p.kind === 'create' ? [p] : []));
        if (creates.length) {
          await tx.menuItem.createMany({
            data: creates.map((p) => ({
              id: p.id,
              vendorId,
              name: p.row.name,
              price: p.price,
              vendorPrice: p.row.vendorPrice,
              category: p.row.category.name,
              categoryId: p.row.category.id,
              description: p.row.description ?? '',
              imageUrl: p.row.imageUrl ?? DEFAULT_DISH_IMAGE,
              isVeg: p.row.isVeg !== false,
              isAvailable: p.row.isAvailable !== false,
              createdBy: 'ADMIN',
              approvalStatus: 'APPROVED' as const,
              reviewedAt: now,
              reviewedByUserId: actor.id,
            })),
          });
        }
        // Dish rows in ascending id order (the fixed lock order), then the updates.
        const updates = plan.planned.flatMap((p) => (p.kind === 'update' ? [p] : [])).sort((a, c) => (a.existing.id < c.existing.id ? -1 : 1));
        if (updates.length) await tx.$queryRaw`SELECT "id" FROM "MenuItem" WHERE "id" = ANY(${updates.map((u) => u.existing.id)}::text[]) ORDER BY "id" FOR UPDATE`;
        for (const u of updates) await tx.menuItem.update({ where: { id: u.existing.id }, data: u.data });
        plan.planned.forEach((p, i) => { if (p.kind === 'create') plan.report[i].dishId = p.id; });
        return { plan, vendorName: vendorNameOf(vendor) };
      }, { maxWait: 10_000, timeout: 60_000 });

      const { summary } = out.plan;
      if (summary.create + summary.update > 0) {
        await writeAudit('MENU_IMPORTED', 'VENDOR', vendorId, `Admin imported a menu into ${out.vendorName}: ${summary.create} added, ${summary.update} updated, ${summary.skip} skipped (${summary.total} rows)`);
      }
      return { dryRun: false, applied: true, summary, rows: out.plan.report };
    } catch (e) {
      if (e instanceof Retry && attempt < 2) continue;
      if (e instanceof Retry) throw new AppError(409, 'CATEGORIES_CHANGED', 'The categories were being changed while the import ran. Try the import again.');
      throw e;
    }
  }
  throw new AppError(409, 'CATEGORIES_CHANGED', 'The categories were being changed while the import ran. Try the import again.');
};

