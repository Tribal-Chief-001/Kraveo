import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { ID_RE } from '../utils/http';
import { MENU_ORDER_BY } from '../utils/catalog';
import { collapse } from '../utils/labels';
import { writeAudit } from './audit';
import { slugOf } from './categories';

/**
 * Per-restaurant menu order (Docs/26 section 3). `MenuItem.sortOrder` is the position; every dish list sorts by
 * sortOrder ASC, createdAt ASC, id ASC (utils/catalog.ts MENU_ORDER_BY). A section (customer-app tab) is a category; the sections
 * of a restaurant are ordered by the FIRST appearance of each category in that dish order.
 *
 * Lock order (shared with dish create, import and the position edit): the restaurant row first, then dish rows by ascending id.
 * Everything that changes positions of a restaurant runs under that restaurant lock, so two writers can never interleave.
 */
type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: string };

export const SORT_STEP = 10;
export const MAX_SECTIONS = 60;
export const MAX_ORDER_DISHES = 400;
export const MAX_POSITION = 10_000;

const invalid = (field: string, message: string) => new AppError(400, 'MENU_ORDER_INVALID', message, field);

type Entry = { id: string; category: string };
export type Section = { key: string; label: string; ids: string[] };

const sectionKey = (category: string): string => slugOf(category) || category.trim().toLowerCase();

/** Groups dishes (already in menu order) into sections by first appearance; dishes keep their relative order inside a section. */
export const layoutSections = (dishesInOrder: Entry[]): Section[] => {
  const sections: Section[] = [];
  const byKey = new Map<string, Section>();
  for (const d of dishesInOrder) {
    const key = sectionKey(d.category);
    let s = byKey.get(key);
    if (!s) { s = { key, label: d.category, ids: [] }; byKey.set(key, s); sections.push(s); }
    s.ids.push(d.id);
  }
  return sections;
};

/** sortOrder 10, 20, 30 ... over the sections in order, dishes in order inside each. */
export const assignSortOrder = (sections: Section[]): Map<string, number> => {
  const out = new Map<string, number>();
  let n = 0;
  for (const s of sections) for (const id of s.ids) out.set(id, ++n * SORT_STEP);
  return out;
};

const lockVendor = async (tx: Tx, vendorId: string): Promise<{ name: string }> => {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
  return tx.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { name: true } });
};

/** Row-locks the restaurant row, then ALL its non-deleted dishes by ascending id (the lock order of every position writer). Call BEFORE locking any single dish. */
export const lockVendorAndDishes = async (tx: Tx, vendorId: string, alsoDishId = '') => {
  await tx.$queryRaw`SELECT "id" FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
  // `alsoDishId` (the dish being edited, even when deleted) is locked in the same ascending pass, never after it.
  await tx.$queryRaw`SELECT "id" FROM "MenuItem" WHERE "vendorId" = ${vendorId} AND ("deletedAt" IS NULL OR "id" = ${alsoDishId}) ORDER BY "id" FOR UPDATE`;
};

/** Row-locks the restaurant's non-deleted dishes in ascending id order and returns them in MENU ORDER. */
const lockAndReadDishes = async (tx: Tx, vendorId: string) => {
  await tx.$queryRaw`SELECT "id" FROM "MenuItem" WHERE "vendorId" = ${vendorId} AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE`;
  return tx.menuItem.findMany({ where: { vendorId, deletedAt: null }, orderBy: MENU_ORDER_BY, select: { id: true, category: true, sortOrder: true } });
};

/** Writes only the rows whose position really changes, in ONE statement (no updatedAt bump: reordering is not a dish edit). Returns the number of rows written. */
const writeSortOrders = async (tx: Tx, current: { id: string; sortOrder: number }[], next: Map<string, number>): Promise<number> => {
  const changed = current.filter((d) => next.get(d.id) !== undefined && next.get(d.id) !== d.sortOrder).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (changed.length === 0) return 0;
  await tx.$executeRaw`
    UPDATE "MenuItem" AS m SET "sortOrder" = v."so"
    FROM (SELECT unnest(${changed.map((d) => d.id)}::text[]) AS "id", unnest(${changed.map((d) => next.get(d.id)!)}::int[]) AS "so") AS v
    WHERE m."id" = v."id"`;
  return changed.length;
};

/** Highest sortOrder of the restaurant (deleted dishes included, so a restore never lands before a newer dish) + one step. Call under the restaurant lock. */
export const nextSortOrder = async (tx: Tx, vendorId: string): Promise<number> => {
  const agg = await tx.menuItem.aggregate({ where: { vendorId }, _max: { sortOrder: true } });
  return Math.max(0, agg._max.sortOrder ?? 0) + SORT_STEP;
};

/**
 * Admin dish edit with `position` (1-based, within the dish's section; larger than the section = last). Call inside the dish-edit transaction
 * AFTER the restaurant row and the dish row are locked. `category` is the dish's category after the edit. The whole menu is renumbered
 * from its current order, so the other sections keep their order and the dish lands exactly at `position`.
 */
export const moveDishInSection = async (tx: Tx, vendorId: string, dishId: string, category: string, position: number): Promise<number> => {
  const current = await lockAndReadDishes(tx, vendorId);
  if (!current.some((d) => d.id === dishId)) return 0;
  const sections = layoutSections(current.map((d) => (d.id === dishId ? { id: d.id, category } : { id: d.id, category: d.category })));
  const home = sections.find((s) => s.ids.includes(dishId))!;
  home.ids = home.ids.filter((id) => id !== dishId);
  home.ids.splice(Math.min(Math.max(position, 1), home.ids.length + 1) - 1, 0, dishId);
  return writeSortOrders(tx, current, assignSortOrder(sections));
};

// ---------------------------------------------------------------------------------------------------------------------
// PUT /admin/vendors/:id/menu-order
// ---------------------------------------------------------------------------------------------------------------------
export type MenuOrderSection = { category: string; dishCount: number };

const parseBody = (b: Record<string, unknown>) => {
  const extra = Object.keys(b).find((k) => k !== 'sections' && k !== 'dishes');
  if (extra) throw invalid(extra.slice(0, 40), `Unknown field '${extra.slice(0, 40)}'. Send: sections, dishes.`);
  if (!Array.isArray(b.sections)) throw invalid('sections', 'sections must be a list of category names (it can be empty).');
  if (b.sections.length > MAX_SECTIONS) throw invalid('sections', `At most ${MAX_SECTIONS} sections.`);
  const sectionKeys: string[] = [];
  for (const [i, raw] of b.sections.entries()) {
    if (typeof raw !== 'string' || raw.length > 200 || !collapse(raw)) throw invalid(`sections[${i}]`, 'Every section is a category name (text).');
    const key = sectionKey(collapse(raw));
    if (sectionKeys.includes(key)) throw invalid(`sections[${i}]`, `The section "${collapse(raw).slice(0, 40)}" is listed twice.`);
    sectionKeys.push(key);
  }
  const positions = new Map<string, number>();
  if (b.dishes !== undefined) {
    if (!Array.isArray(b.dishes)) throw invalid('dishes', 'dishes must be a list of { id, position }.');
    if (b.dishes.length > MAX_ORDER_DISHES) throw invalid('dishes', `At most ${MAX_ORDER_DISHES} dishes.`);
    for (const [i, raw] of b.dishes.entries()) {
      const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      if (!d || Object.keys(d).some((k) => k !== 'id' && k !== 'position')) throw invalid(`dishes[${i}]`, 'Every entry is { id, position }.');
      if (typeof d.id !== 'string' || !ID_RE.test(d.id)) throw invalid(`dishes[${i}].id`, 'Every dish id must be a valid id.');
      if (typeof d.position !== 'number' || !Number.isInteger(d.position) || d.position < 1 || d.position > MAX_POSITION) {
        throw invalid(`dishes[${i}].position`, `position is a whole number from 1 to ${MAX_POSITION}.`);
      }
      if (positions.has(d.id)) throw invalid(`dishes[${i}].id`, 'The same dish is listed twice.');
      positions.set(d.id, d.position);
    }
  }
  return { sectionKeys, positions };
};

export const setMenuOrder = async (vendorId: string, b: Record<string, unknown>, _actor: Actor) => {
  const { sectionKeys, positions } = parseBody(b);
  const out = await prisma.$transaction(async (tx) => {
    const vendor = await lockVendor(tx, vendorId);
    const current = await lockAndReadDishes(tx, vendorId);
    const sections = layoutSections(current);
    const byKey = new Map(sections.map((s) => [s.key, s] as const));
    for (const [i, key] of sectionKeys.entries()) {
      if (!byKey.has(key)) throw invalid(`sections[${i}]`, `This restaurant has no dishes in a section called "${String((b.sections as string[])[i]).slice(0, 40)}".`);
    }
    const index = new Map(current.map((d, i) => [d.id, i] as const));
    for (const id of positions.keys()) if (!index.has(id)) throw invalid('dishes', 'A dish in the list does not belong to this restaurant (or was deleted).');

    const listed = sectionKeys.map((k) => byKey.get(k)!);
    const ordered = [...listed, ...sections.filter((s) => !sectionKeys.includes(s.key))];
    for (const s of ordered) {
      const withPos = s.ids.filter((id) => positions.has(id)).sort((a, c) => positions.get(a)! - positions.get(c)! || index.get(a)! - index.get(c)!);
      s.ids = [...withPos, ...s.ids.filter((id) => !positions.has(id))];
    }
    const written = await writeSortOrders(tx, current, assignSortOrder(ordered));
    return { vendor, ordered, written, total: current.length };
  }, { maxWait: 10_000, timeout: 30_000 });

  if (out.written > 0) {
    await writeAudit('MENU_ORDER_SET', 'VENDOR', vendorId, `Admin changed the menu order of ${out.vendor.name}: ${out.total} dishes in ${out.ordered.length} sections (${out.written} positions rewritten)`);
  }
  const data: MenuOrderSection[] = out.ordered.map((s) => ({ category: s.label, dishCount: s.ids.length }));
  return { changed: out.written > 0, sections: data };
};
