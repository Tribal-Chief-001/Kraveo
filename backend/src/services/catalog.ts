import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { writeAudit } from './audit';
import { getSettings } from './settings';
import { checkCommissionRule, CommissionRule, DishPrice, priceDish, ruleFromColumns, toPaise } from './pricing';
import { dishStatus, DishStatus, priceProblem, text } from '../utils/catalog';
import { SettingsMap } from './pricing';

/**
 * Catalog rules (Docs/21 sections 2-4): who may create / change / approve a dish and what the customer price becomes.
 *
 * Every state change runs in a transaction that first takes a row lock on the dish (SELECT ... FOR UPDATE), re-reads it, decides,
 * writes, commits. Two parallel requests for the same dish (double click on approve, a restaurant editing while an admin approves)
 * therefore run one after the other and the second sees the first one's result; approve / delete / restore are idempotent.
 * Audit rows are written after the commit and only by the caller that actually changed something.
 */
type Tx = Prisma.TransactionClient;
export type Actor = { id: string; role: string };

const notFound = () => new AppError(404, 'NOT_FOUND', 'Menu item not found.');
const round2 = (n: number) => Math.round(n * 100) / 100;

export const MAX_PENDING_DISHES_PER_RESTAURANT = 50;
export const MAX_NAME = 80;

const VENDOR_SELECT = { id: true, name: true, userId: true, commissionType: true, commissionValue: true } as const;
const WITH_VENDOR = { vendor: { select: VENDOR_SELECT } } satisfies Prisma.MenuItemInclude;
export type DishRow = Prisma.MenuItemGetPayload<{ include: typeof WITH_VENDOR }>;

// ---------------------------------------------------------------------------------------------------------------------
// Price computation for a stored dish
// ---------------------------------------------------------------------------------------------------------------------
type Rules = { dish: CommissionRule | null; vendor: CommissionRule | null };

const rulesOf = (item: { commissionType: string | null; commissionValue: number | null; vendor: { commissionType: string | null; commissionValue: number | null } }): Rules => ({
  dish: ruleFromColumns(item.commissionType, item.commissionValue),
  vendor: ruleFromColumns(item.vendor.commissionType, item.vendor.commissionValue),
});

export const priceFor = (vendorPrice: number, rules: Rules, settings: SettingsMap): DishPrice =>
  priceDish({ vendorPrice, dish: rules.dish, vendor: rules.vendor, global: settings.commission, step: settings.rounding.step });

// ---------------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------------
/** The admin portal's row for a dish: everything, including the commission and the price it would get today. */
export const adminDishView = (item: DishRow, settings: SettingsMap) => {
  const rules = rulesOf(item);
  const now = priceFor(item.vendorPrice, rules, settings);
  const pending = item.pendingVendorPrice !== null ? priceFor(item.pendingVendorPrice, rules, settings) : null;
  const status: DishStatus = dishStatus(item);
  return {
    id: item.id,
    vendorId: item.vendorId,
    vendorName: item.vendor.name,
    name: item.name,
    category: item.category,
    description: item.description,
    imageUrl: item.imageUrl,
    isVeg: item.isVeg,
    isAvailable: item.isAvailable,
    rating: item.rating ?? null,
    ratingCount: item.ratingCount ?? null,
    status,
    approvalStatus: item.approvalStatus,
    rejectionReason: item.rejectionReason ?? null,
    vendorPrice: item.vendorPrice,
    pendingVendorPrice: item.pendingVendorPrice ?? null,
    /** The customer price stored (and charged) now. */
    price: item.price,
    /** What the rules give today; differs from `price` after a commission or rounding change until "Recalculate prices" runs. */
    computedPrice: now.price,
    priceIsStale: toPaise(now.price) !== toPaise(item.price),
    /** The customer price the dish would get if the pending change were accepted. */
    pendingPrice: pending ? pending.price : null,
    /** price - vendorPrice: what Kraveo keeps per unit (commission and rounding). */
    effectiveCommission: round2(item.price - item.vendorPrice),
    /** The rule that applies and where it comes from. */
    commission: { type: now.rule.type, value: now.rule.value, source: now.source },
    /** This dish's own override, null = inherits. */
    commissionOverride: rules.dish,
    createdBy: item.createdBy,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    reviewedAt: item.reviewedAt ? item.reviewedAt.toISOString() : null,
    reviewedByUserId: item.reviewedByUserId ?? null,
    deletedAt: item.deletedAt ? item.deletedAt.toISOString() : null,
  };
};

const pricePreview = (before: { price: number; vendorPrice: number }, after: DishPrice) => ({
  previousVendorPrice: before.vendorPrice,
  previousPrice: before.price,
  vendorPrice: after.vendorPrice,
  price: after.price,
  effectiveCommission: after.effectiveCommission,
  nominalCommission: after.nominalCommission,
  commission: { type: after.rule.type, value: after.rule.value, source: after.source },
  roundingStep: after.step,
});

// ---------------------------------------------------------------------------------------------------------------------
// Locking helpers
// ---------------------------------------------------------------------------------------------------------------------
const TX_OPTS = { maxWait: 10_000, timeout: 20_000 };

/** Row-locks the dish and returns it with its restaurant, or null when it does not exist. */
const lockDish = async (tx: Tx, id: string): Promise<DishRow | null> => {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MenuItem" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.menuItem.findUnique({ where: { id }, include: WITH_VENDOR });
};

const money = (raw: unknown, field = 'vendorPrice'): number => {
  const problem = priceProblem(raw);
  if (problem) throw new AppError(400, 'BAD_REQUEST', problem.replace(/^Price/, field === 'vendorPrice' ? 'The restaurant price' : 'Price'), field);
  return raw as number;
};

/** `commissionType` + `commissionValue` as sent: both absent = untouched (undefined), both null = inherit (null), both valid = a rule. */
const commissionOverrideFrom = (b: Record<string, unknown>): CommissionRule | null | undefined => {
  const hasType = 'commissionType' in b;
  const hasValue = 'commissionValue' in b;
  if (!hasType && !hasValue) return undefined;
  if (!hasType || !hasValue) throw new AppError(400, 'BAD_REQUEST', 'Send commissionType and commissionValue together (both null = use the restaurant or global default).', hasType ? 'commissionValue' : 'commissionType');
  if (b.commissionType === null && b.commissionValue === null) return null;
  const check = checkCommissionRule(b.commissionType, b.commissionValue);
  if (!check.ok) throw new AppError(400, 'BAD_REQUEST', check.error.message, check.error.field === 'type' ? 'commissionType' : 'commissionValue');
  return check.value;
};

// ---------------------------------------------------------------------------------------------------------------------
// Restaurant side
// ---------------------------------------------------------------------------------------------------------------------
export const vendorDishes = (vendorId: string) =>
  prisma.menuItem.findMany({ where: { vendorId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

/**
 * POST /vendors/:id/items. A restaurant's dish starts PENDING (vendorPrice = what it typed, customers do not see it until an admin
 * approves); an admin-created dish is APPROVED at once and `price` of the request is the restaurant price either way.
 */
export const createDish = async (
  vendorId: string,
  input: { name: string; price: number; category: string; description: string; imageUrl: string; isVeg: boolean; isAvailable?: boolean; commission?: CommissionRule | null },
  actor: Actor,
) => {
  const settings = await getSettings();
  const byAdmin = actor.role === 'ADMIN';
  const created = await prisma.$transaction(async (tx) => {
    // Lock the restaurant row: the pending cap below cannot be raced by parallel posts.
    const vendorRows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
    if (vendorRows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
    const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: VENDOR_SELECT });
    if (!byAdmin) {
      const pending = await tx.menuItem.count({ where: { vendorId, approvalStatus: 'PENDING', deletedAt: null } });
      if (pending >= MAX_PENDING_DISHES_PER_RESTAURANT) {
        throw new AppError(409, 'TOO_MANY_PENDING', `You already have ${pending} dishes waiting for approval. Wait for Kraveo to review them before adding more.`);
      }
    }
    const rules: Rules = { dish: input.commission ?? null, vendor: ruleFromColumns(vendor.commissionType, vendor.commissionValue) };
    const priced = priceFor(input.price, rules, settings);
    const now = new Date();
    const row = await tx.menuItem.create({
      data: {
        vendorId,
        name: input.name,
        price: priced.price,
        vendorPrice: input.price,
        category: input.category,
        description: input.description,
        imageUrl: input.imageUrl,
        isVeg: input.isVeg,
        isAvailable: input.isAvailable ?? true,
        createdBy: byAdmin ? 'ADMIN' : 'VENDOR',
        approvalStatus: byAdmin ? 'APPROVED' : 'PENDING',
        ...(byAdmin ? { reviewedAt: now, reviewedByUserId: actor.id } : {}),
        ...(input.commission ? { commissionType: input.commission.type, commissionValue: input.commission.value } : {}),
      },
      include: WITH_VENDOR,
    });
    return { row, priced, vendor };
  }, TX_OPTS);
  if (byAdmin) {
    await writeAudit('DISH_CREATED', 'MENU_ITEM', created.row.id, `Admin added "${created.row.name}" to ${created.vendor.name}: restaurant Rs ${created.row.vendorPrice}, customer Rs ${created.row.price} (live)`);
  }
  return created.row;
};

export type VendorEditResult = { item: DishRow; kind: 'AVAILABILITY' | 'EDITED_IN_PLACE' | 'CHANGE_REQUESTED' | 'CHANGE_WITHDRAWN' | 'RESUBMITTED' | 'UNCHANGED' | 'ADMIN_EDIT' };

/**
 * PATCH /vendors/items/:itemId as the restaurant: `isAvailable` is instant; `price` is a request unless the dish has not gone live yet:
 *   PENDING   -> the price is edited in place (still waiting for approval)
 *   LIVE      -> pendingVendorPrice is set (CHANGE_PENDING); customers keep the old price until an admin accepts. Asking for the
 *                current price again withdraws the request.
 *   REJECTED  -> the price is replaced and the dish goes back to PENDING (resubmitted)
 * As an ADMIN the same endpoint edits the restaurant price directly (immediate, price recomputed).
 */
export const vendorEditDish = async (itemId: string, actor: Actor, patch: { isAvailable?: boolean; price?: number }): Promise<VendorEditResult & { audit?: string }> => {
  const settings = await getSettings();
  const out = await prisma.$transaction(async (tx): Promise<VendorEditResult & { audit?: string }> => {
    const item = await lockDish(tx, itemId);
    if (!item || (item.deletedAt && actor.role !== 'ADMIN')) throw notFound();
    if (actor.role !== 'ADMIN' && item.vendor.userId !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Forbidden. You do not own this vendor.');
    if (item.deletedAt) throw new AppError(409, 'ITEM_DELETED', 'This dish was deleted. Restore it first.');

    const data: Prisma.MenuItemUpdateInput = {};
    let kind: VendorEditResult['kind'] = 'AVAILABILITY';
    let audit: string | undefined;
    if (typeof patch.isAvailable === 'boolean') data.isAvailable = patch.isAvailable;

    if (patch.price !== undefined) {
      const price = patch.price;
      if (actor.role === 'ADMIN') {
        const priced = priceFor(price, rulesOf(item), settings);
        Object.assign(data, { vendorPrice: price, price: priced.price, pendingVendorPrice: null });
        kind = 'ADMIN_EDIT';
        audit = `Admin set the restaurant price of "${item.name}" (${item.vendor.name}) from Rs ${item.vendorPrice} to Rs ${price}; customer price Rs ${item.price} -> Rs ${priced.price}`;
      } else if (item.approvalStatus === 'PENDING') {
        const priced = priceFor(price, rulesOf(item), settings);
        Object.assign(data, { vendorPrice: price, price: priced.price });
        kind = 'EDITED_IN_PLACE';
      } else if (item.approvalStatus === 'REJECTED') {
        const priced = priceFor(price, rulesOf(item), settings);
        Object.assign(data, { vendorPrice: price, price: priced.price, approvalStatus: 'PENDING', rejectionReason: null, reviewedAt: null, reviewedByUserId: null, pendingVendorPrice: null });
        kind = 'RESUBMITTED';
      } else if (toPaise(price) === toPaise(item.vendorPrice)) {
        // LIVE and asking for the price it already has: withdraws an open request, otherwise nothing to do.
        if (item.pendingVendorPrice !== null) {
          Object.assign(data, { pendingVendorPrice: null, rejectionReason: null });
          kind = 'CHANGE_WITHDRAWN';
        } else {
          kind = typeof patch.isAvailable === 'boolean' ? 'AVAILABILITY' : 'UNCHANGED';
        }
      } else {
        Object.assign(data, { pendingVendorPrice: price, rejectionReason: null });
        kind = 'CHANGE_REQUESTED';
      }
    }
    if (Object.keys(data).length === 0) return { item, kind: kind === 'AVAILABILITY' ? 'UNCHANGED' : kind };
    const updated = await tx.menuItem.update({ where: { id: itemId }, data, include: WITH_VENDOR });
    return { item: updated, kind, audit };
  }, TX_OPTS);
  if (out.audit) await writeAudit('DISH_EDITED', 'MENU_ITEM', itemId, out.audit);
  return out;
};

/** PATCH /menus/:itemId/toggle: availability flips instantly for any status; an unknown / deleted dish is 404 for a restaurant. */
export const toggleAvailability = async (itemId: string, actor: Actor): Promise<DishRow> =>
  prisma.$transaction(async (tx) => {
    const item = await lockDish(tx, itemId);
    if (!item || item.deletedAt) throw notFound();
    if (actor.role !== 'ADMIN' && item.vendor.userId !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Forbidden. You do not own this vendor.');
    return tx.menuItem.update({ where: { id: itemId }, data: { isAvailable: !item.isAvailable }, include: WITH_VENDOR });
  }, TX_OPTS);

// ---------------------------------------------------------------------------------------------------------------------
// Admin: list, count, preview
// ---------------------------------------------------------------------------------------------------------------------
export const CATALOG_FILTERS = ['PENDING', 'LIVE', 'REJECTED', 'CHANGE_PENDING', 'DELETED', 'ALL'] as const;

export const listCatalog = async (q: { status?: string; vendorId?: string; q?: string; page?: number; pageSize?: number }) => {
  const where: Prisma.MenuItemWhereInput[] = [];
  const status = q.status ? q.status.toUpperCase() : undefined;
  if (status && !(CATALOG_FILTERS as readonly string[]).includes(status)) {
    throw new AppError(400, 'BAD_REQUEST', `status must be one of ${CATALOG_FILTERS.join(', ')}.`, 'status');
  }
  switch (status) {
    case 'PENDING': where.push({ approvalStatus: 'PENDING', deletedAt: null }); break;
    case 'REJECTED': where.push({ approvalStatus: 'REJECTED', deletedAt: null }); break;
    case 'LIVE': where.push({ approvalStatus: 'APPROVED', pendingVendorPrice: null, deletedAt: null }); break;
    case 'CHANGE_PENDING': where.push({ approvalStatus: 'APPROVED', pendingVendorPrice: { not: null }, deletedAt: null }); break;
    case 'DELETED': where.push({ deletedAt: { not: null } }); break;
    case 'ALL': break;
    default: where.push({ deletedAt: null });
  }
  if (q.vendorId) where.push({ vendorId: q.vendorId });
  const term = (q.q ?? '').trim().slice(0, 60);
  if (term) where.push({ OR: [{ name: { contains: term, mode: 'insensitive' } }, { vendor: { name: { contains: term, mode: 'insensitive' } } }] });

  const pageSize = Math.min(Math.max(Math.floor(q.pageSize ?? 25) || 25, 1), 100);
  const page = Math.min(Math.max(Math.floor(q.page ?? 1) || 1, 1), 100_000);
  const queue = status === 'PENDING' || status === 'CHANGE_PENDING';
  const [total, rows, settings] = await Promise.all([
    prisma.menuItem.count({ where: { AND: where } }),
    prisma.menuItem.findMany({
      where: { AND: where },
      include: WITH_VENDOR,
      orderBy: queue ? [{ updatedAt: 'asc' }, { id: 'asc' }] : [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    getSettings(),
  ]);
  return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), data: rows.map((r) => adminDishView(r, settings)) };
};

export const pendingCount = async () => {
  const [pending, changePending] = await Promise.all([
    prisma.menuItem.count({ where: { approvalStatus: 'PENDING', deletedAt: null } }),
    prisma.menuItem.count({ where: { approvalStatus: 'APPROVED', pendingVendorPrice: { not: null }, deletedAt: null } }),
  ]);
  return { pending, changePending, total: pending + changePending };
};

/** POST /admin/catalog/preview: the customer price a restaurant price + commission would give, nothing is saved. */
export const previewPrice = async (b: Record<string, unknown>) => {
  const vendorPrice = money(b.vendorPrice);
  if (typeof b.vendorId !== 'string') throw new AppError(400, 'BAD_REQUEST', 'vendorId is required.', 'vendorId');
  const vendor = await prisma.vendor.findUnique({ where: { id: b.vendorId }, select: VENDOR_SELECT });
  if (!vendor) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
  const dish = commissionOverrideFrom(b) ?? null;
  const settings = await getSettings();
  const out = priceFor(vendorPrice, { dish, vendor: ruleFromColumns(vendor.commissionType, vendor.commissionValue) }, settings);
  return {
    vendorPrice: out.vendorPrice,
    price: out.price,
    effectiveCommission: out.effectiveCommission,
    nominalCommission: out.nominalCommission,
    commission: { type: out.rule.type, value: out.rule.value, source: out.source },
    roundingStep: out.step,
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Admin: approve / reject
// ---------------------------------------------------------------------------------------------------------------------
const describeRule = (r: CommissionRule | null) => (r ? (r.type === 'PERCENT' ? `${r.value}%` : `Rs ${r.value} flat`) : 'inherited');

/**
 * POST /admin/catalog/:id/approve `{ commissionType?, commissionValue?, vendorPrice?, applyPending? }`
 *   - a PENDING (or REJECTED) dish becomes APPROVED and live at the computed customer price;
 *   - a LIVE dish with a requested price change gets that price (pendingVendorPrice -> vendorPrice), unless `vendorPrice` is sent
 *     (the admin's own number wins over the request); `applyPending: false` is refused (use reject to decline the change);
 *   - commission fields, when sent, set the dish override (both null = inherit again);
 *   - the stored customer price is recomputed. Nothing to change = changed:false (a double click is a no-op).
 */
export const approveDish = async (itemId: string, b: Record<string, unknown>, actor: Actor) => {
  const settings = await getSettings();
  const override = commissionOverrideFrom(b);
  const explicitVendorPrice = b.vendorPrice !== undefined ? money(b.vendorPrice) : undefined;
  if (b.applyPending !== undefined && typeof b.applyPending !== 'boolean') throw new AppError(400, 'BAD_REQUEST', 'applyPending must be true or false.', 'applyPending');
  const out = await prisma.$transaction(async (tx) => {
    const item = await lockDish(tx, itemId);
    if (!item) throw notFound();
    if (item.deletedAt) throw new AppError(409, 'ITEM_DELETED', 'This dish is deleted. Restore it first.');
    if (b.applyPending === false && item.pendingVendorPrice !== null) {
      throw new AppError(409, 'USE_REJECT', 'To decline the requested price change, use reject with a reason.', 'applyPending');
    }

    const newVendorPrice = explicitVendorPrice ?? (item.pendingVendorPrice !== null ? item.pendingVendorPrice : item.vendorPrice);
    const newOverride = override === undefined ? ruleFromColumns(item.commissionType, item.commissionValue) : override;
    const priced = priceFor(newVendorPrice, { dish: newOverride, vendor: ruleFromColumns(item.vendor.commissionType, item.vendor.commissionValue) }, settings);

    const wasLive = item.approvalStatus === 'APPROVED';
    const data: Prisma.MenuItemUpdateInput = {
      approvalStatus: 'APPROVED',
      rejectionReason: null,
      pendingVendorPrice: null,
      vendorPrice: newVendorPrice,
      price: priced.price,
      commissionType: newOverride ? newOverride.type : null,
      commissionValue: newOverride ? newOverride.value : null,
    };
    const unchanged =
      wasLive &&
      item.pendingVendorPrice === null &&
      item.rejectionReason === null &&
      toPaise(newVendorPrice) === toPaise(item.vendorPrice) &&
      toPaise(priced.price) === toPaise(item.price) &&
      (newOverride?.type ?? null) === item.commissionType &&
      (newOverride?.value ?? null) === item.commissionValue;
    if (unchanged) return { item, changed: false, wasLive, priced, before: item };
    Object.assign(data, wasLive ? {} : { reviewedAt: new Date(), reviewedByUserId: actor.id });
    if (wasLive && item.pendingVendorPrice !== null) Object.assign(data, { reviewedAt: new Date(), reviewedByUserId: actor.id });
    const updated = await tx.menuItem.update({ where: { id: itemId }, data, include: WITH_VENDOR });
    return { item: updated, changed: true, wasLive, priced, before: item };
  }, TX_OPTS);

  if (out.changed) {
    const what = !out.wasLive ? 'Approved' : out.before.pendingVendorPrice !== null ? 'Accepted the price change of' : 'Updated';
    await writeAudit(
      'DISH_APPROVED',
      'MENU_ITEM',
      itemId,
      `${what} "${out.item.name}" (${out.item.vendor.name}): restaurant Rs ${out.before.vendorPrice} -> Rs ${out.item.vendorPrice}, commission ${describeRule(out.priced.rule)} (${out.priced.source.toLowerCase()}), customer Rs ${out.before.price} -> Rs ${out.item.price}`,
    );
  }
  return { item: out.item, changed: out.changed, settings, preview: pricePreview(out.before, out.priced) };
};

/**
 * POST /admin/catalog/:id/reject `{ reason }`
 *   PENDING -> REJECTED (the restaurant sees the reason and may resubmit); REJECTED -> reason updated (idempotent);
 *   LIVE with a requested price change -> the change is declined, the dish stays live at the old price, the reason is kept for the restaurant;
 *   LIVE without a request -> 409 (hide or delete it instead).
 */
export const rejectDish = async (itemId: string, reasonRaw: unknown, actor: Actor) => {
  const reason = text(reasonRaw, 200);
  if (!reason || reason.length < 3) throw new AppError(400, 'BAD_REQUEST', 'Give the restaurant a reason (3 to 200 characters).', 'reason');
  const out = await prisma.$transaction(async (tx) => {
    const item = await lockDish(tx, itemId);
    if (!item) throw notFound();
    if (item.deletedAt) throw new AppError(409, 'ITEM_DELETED', 'This dish is deleted. Restore it first.');
    if (item.approvalStatus === 'APPROVED' && item.pendingVendorPrice === null) {
      throw new AppError(409, 'NOT_PENDING', 'This dish is live and has no change waiting. To take it off the menu, hide it (isAvailable) or delete it.');
    }
    if (item.approvalStatus === 'REJECTED' && item.rejectionReason === reason) return { item, changed: false, declinedChange: false };
    const declinedChange = item.approvalStatus === 'APPROVED';
    const updated = await tx.menuItem.update({
      where: { id: itemId },
      data: declinedChange
        ? { pendingVendorPrice: null, rejectionReason: `Price change declined: ${reason}`.slice(0, 200), reviewedAt: new Date(), reviewedByUserId: actor.id }
        : { approvalStatus: 'REJECTED', rejectionReason: reason, reviewedAt: new Date(), reviewedByUserId: actor.id },
      include: WITH_VENDOR,
    });
    return { item: updated, changed: true, declinedChange };
  }, TX_OPTS);
  if (out.changed) {
    await writeAudit('DISH_REJECTED', 'MENU_ITEM', itemId, `${out.declinedChange ? 'Declined the price change of' : 'Rejected'} "${out.item.name}" (${out.item.vendor.name}): ${reason}`);
  }
  return { item: out.item, changed: out.changed, settings: await getSettings() };
};

// ---------------------------------------------------------------------------------------------------------------------
// Admin: edit / create / delete / restore
// ---------------------------------------------------------------------------------------------------------------------
const requireNonEmptyText = (raw: unknown, max: number, field: string, label: string): string => {
  const t = text(raw, max);
  if (!t) throw new AppError(400, 'BAD_REQUEST', `${label} is required (up to ${max} characters).`, field);
  return t;
};
const optionalText = (raw: unknown, max: number, field: string, label: string): string | undefined => {
  if (raw === undefined) return undefined;
  const t = text(raw, max);
  if (t === false) throw new AppError(400, 'BAD_REQUEST', `${label} can be at most ${max} characters.`, field);
  return t ?? '';
};
const checkImageUrl = (raw: unknown): string => {
  const t = text(raw, 500);
  if (t === false || !t || !/^https?:\/\//i.test(t)) throw new AppError(400, 'BAD_REQUEST', 'Image must be an http(s) link (up to 500 characters).', 'imageUrl');
  return t;
};

const EDIT_KEYS = ['name', 'description', 'category', 'imageUrl', 'isVeg', 'isAvailable', 'vendorPrice', 'commissionType', 'commissionValue'];

/** PATCH /admin/catalog/:id. Any change of the restaurant price or the commission recomputes the customer price. */
export const adminEditDish = async (itemId: string, b: Record<string, unknown>, actor: Actor) => {
  const unknown = Object.keys(b).find((k) => !EDIT_KEYS.includes(k));
  if (unknown) throw new AppError(400, 'BAD_REQUEST', `Unknown field '${unknown.slice(0, 40)}'. You can change: ${EDIT_KEYS.join(', ')}.`, unknown.slice(0, 40));
  const data: Prisma.MenuItemUpdateInput = {};
  if (b.name !== undefined) data.name = requireNonEmptyText(b.name, MAX_NAME, 'name', 'Name');
  const description = optionalText(b.description, 300, 'description', 'Description');
  if (description !== undefined) data.description = description;
  const category = optionalText(b.category, 40, 'category', 'Category');
  if (category !== undefined) data.category = category || 'Main Course';
  if (b.imageUrl !== undefined) data.imageUrl = checkImageUrl(b.imageUrl);
  if (b.isVeg !== undefined) {
    if (typeof b.isVeg !== 'boolean') throw new AppError(400, 'BAD_REQUEST', 'isVeg must be true or false.', 'isVeg');
    data.isVeg = b.isVeg;
  }
  if (b.isAvailable !== undefined) {
    if (typeof b.isAvailable !== 'boolean') throw new AppError(400, 'BAD_REQUEST', 'isAvailable must be true or false.', 'isAvailable');
    data.isAvailable = b.isAvailable;
  }
  const newVendorPrice = b.vendorPrice !== undefined ? money(b.vendorPrice) : undefined;
  const override = commissionOverrideFrom(b);
  if (Object.keys(data).length === 0 && newVendorPrice === undefined && override === undefined) throw new AppError(400, 'BAD_REQUEST', `Send at least one of: ${EDIT_KEYS.join(', ')}.`);

  const settings = await getSettings();
  const out = await prisma.$transaction(async (tx) => {
    const item = await lockDish(tx, itemId);
    if (!item) throw notFound();
    if (item.deletedAt) throw new AppError(409, 'ITEM_DELETED', 'This dish is deleted. Restore it first.');
    const vendorPrice = newVendorPrice ?? item.vendorPrice;
    const rule = override === undefined ? ruleFromColumns(item.commissionType, item.commissionValue) : override;
    const priced = priceFor(vendorPrice, { dish: rule, vendor: ruleFromColumns(item.vendor.commissionType, item.vendor.commissionValue) }, settings);
    const full: Prisma.MenuItemUpdateInput = { ...data };
    const repriced = newVendorPrice !== undefined || override !== undefined;
    if (repriced) {
      Object.assign(full, { vendorPrice, price: priced.price });
      // The admin's own number supersedes a request the restaurant had open.
      if (newVendorPrice !== undefined) Object.assign(full, { pendingVendorPrice: null });
      if (override !== undefined) Object.assign(full, { commissionType: override ? override.type : null, commissionValue: override ? override.value : null });
    }
    const updated = await tx.menuItem.update({ where: { id: itemId }, data: full, include: WITH_VENDOR });
    return { item: updated, before: item, priced };
  }, TX_OPTS);
  const changedKeys = Object.keys(b).join(', ');
  await writeAudit(
    'DISH_EDITED',
    'MENU_ITEM',
    itemId,
    `Admin edited "${out.item.name}" (${out.item.vendor.name}): ${changedKeys}; restaurant Rs ${out.before.vendorPrice} -> Rs ${out.item.vendorPrice}, customer Rs ${out.before.price} -> Rs ${out.item.price}`,
  );
  return { item: out.item, settings, preview: pricePreview(out.before, out.priced) };
};

/** POST /admin/catalog: a dish for any restaurant, APPROVED at once. */
export const adminCreateDish = async (b: Record<string, unknown>, actor: Actor) => {
  if (typeof b.vendorId !== 'string' || !b.vendorId) throw new AppError(400, 'BAD_REQUEST', 'vendorId is required.', 'vendorId');
  const priceRaw = b.vendorPrice !== undefined ? b.vendorPrice : b.price;
  const price = money(priceRaw);
  const name = requireNonEmptyText(b.name, MAX_NAME, 'name', 'Name');
  const category = optionalText(b.category, 40, 'category', 'Category') || 'Main Course';
  const description = optionalText(b.description, 300, 'description', 'Description') ?? '';
  const imageUrl = b.imageUrl === undefined || b.imageUrl === null || b.imageUrl === '' ? 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400' : checkImageUrl(b.imageUrl);
  if (b.isVeg !== undefined && typeof b.isVeg !== 'boolean') throw new AppError(400, 'BAD_REQUEST', 'isVeg must be true or false.', 'isVeg');
  if (b.isAvailable !== undefined && typeof b.isAvailable !== 'boolean') throw new AppError(400, 'BAD_REQUEST', 'isAvailable must be true or false.', 'isAvailable');
  const commission = commissionOverrideFrom(b);
  const settings = await getSettings();
  const row = await createDish(b.vendorId, { name, price, category, description, imageUrl, isVeg: b.isVeg !== false, isAvailable: b.isAvailable !== false, commission: commission ?? null }, actor);
  return { item: row, settings };
};

/** DELETE /admin/catalog/:id: soft delete. A second call is a no-op (changed:false). Old orders keep their own copies of the dish. */
export const softDeleteDish = async (itemId: string, actor: Actor) => {
  const out = await prisma.$transaction(async (tx) => {
    const item = await lockDish(tx, itemId);
    if (!item) throw notFound();
    if (item.deletedAt) return { item, changed: false };
    const updated = await tx.menuItem.update({ where: { id: itemId }, data: { deletedAt: new Date() }, include: WITH_VENDOR });
    return { item: updated, changed: true };
  }, TX_OPTS);
  if (out.changed) await writeAudit('DISH_DELETED', 'MENU_ITEM', itemId, `Admin deleted "${out.item.name}" (${out.item.vendor.name})`);
  return { ...out, settings: await getSettings() };
};

export const restoreDish = async (itemId: string, actor: Actor) => {
  const out = await prisma.$transaction(async (tx) => {
    const item = await lockDish(tx, itemId);
    if (!item) throw notFound();
    if (!item.deletedAt) return { item, changed: false };
    const updated = await tx.menuItem.update({ where: { id: itemId }, data: { deletedAt: null }, include: WITH_VENDOR });
    return { item: updated, changed: true };
  }, TX_OPTS);
  if (out.changed) await writeAudit('DISH_RESTORED', 'MENU_ITEM', itemId, `Admin restored "${out.item.name}" (${out.item.vendor.name})`);
  return { ...out, settings: await getSettings() };
};

// ---------------------------------------------------------------------------------------------------------------------
// Admin: restaurant commission, recalculate
// ---------------------------------------------------------------------------------------------------------------------
/** PATCH /admin/vendors/:id/commission `{ type, value }` (both null = inherit the global default again). Prices are NOT recomputed here: run recalculate. */
export const setVendorCommission = async (vendorId: string, b: Record<string, unknown>) => {
  let rule: CommissionRule | null;
  if (b.type === null && b.value === null) rule = null;
  else {
    const check = checkCommissionRule(b.type, b.value);
    if (!check.ok) throw new AppError(400, 'BAD_REQUEST', check.error.message, check.error.field);
    rule = check.value;
  }
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
    if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
    const before = await tx.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: VENDOR_SELECT });
    const row = await tx.vendor.update({ where: { id: vendorId }, data: { commissionType: rule ? rule.type : null, commissionValue: rule ? rule.value : null }, select: VENDOR_SELECT });
    return { before, row };
  }, TX_OPTS);
  const settings = await getSettings();
  const dishes = await prisma.menuItem.findMany({ where: { vendorId, deletedAt: null }, include: WITH_VENDOR });
  const staleDishes = dishes.filter((d) => toPaise(priceFor(d.vendorPrice, rulesOf(d), settings).price) !== toPaise(d.price)).length;
  await writeAudit('VENDOR_COMMISSION_SET', 'VENDOR', vendorId, `Admin set the commission of ${updated.row.name}: ${describeRule(ruleFromColumns(updated.before.commissionType, updated.before.commissionValue))} -> ${describeRule(rule)}`);
  return {
    vendor: { id: updated.row.id, name: updated.row.name, commissionType: updated.row.commissionType, commissionValue: updated.row.commissionValue },
    effective: rule ? { ...rule, source: 'VENDOR' as const } : { ...settings.commission, source: 'GLOBAL' as const },
    dishCount: dishes.length,
    staleDishes,
  };
};

/**
 * POST /admin/catalog/recalculate `{ dryRun?, vendorId? }`: recomputes the stored customer price of every dish (deleted ones too, so a
 * restore is correct) from the restaurant price, the commission rules and the rounding step. dryRun only reports. The apply step
 * locks all dishes (ordered by id, so it cannot deadlock with the single-row locks), so a restaurant or admin edit cannot be overwritten by a stale number.
 * Placed orders are never touched (they keep their own price copies).
 */
export const recalculatePrices = async (opts: { dryRun: boolean; vendorId?: string }, actor: Actor) => {
  const scope = opts.vendorId ? Prisma.sql`WHERE "vendorId" = ${opts.vendorId}` : Prisma.empty;
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "MenuItem" ${scope} ORDER BY "id" FOR UPDATE`;
    const settings = await getSettings();
    const items = await tx.menuItem.findMany({ where: opts.vendorId ? { vendorId: opts.vendorId } : {}, include: WITH_VENDOR, orderBy: { id: 'asc' } });
    const changes: { id: string; name: string; vendorName: string; vendorPrice: number; oldPrice: number; newPrice: number; deleted: boolean }[] = [];
    for (const item of items) {
      const next = priceFor(item.vendorPrice, rulesOf(item), settings).price;
      if (toPaise(next) !== toPaise(item.price)) {
        changes.push({ id: item.id, name: item.name, vendorName: item.vendor.name, vendorPrice: item.vendorPrice, oldPrice: item.price, newPrice: next, deleted: item.deletedAt !== null });
        if (!opts.dryRun) await tx.menuItem.update({ where: { id: item.id }, data: { price: next } });
      }
    }
    return { total: items.length, changes };
  }, { maxWait: 10_000, timeout: 60_000 });
  if (!opts.dryRun && out.changes.length > 0) {
    await writeAudit('PRICES_RECALCULATED', 'MENU_ITEM', opts.vendorId ?? 'all', `Admin recalculated customer prices: ${out.changes.length} of ${out.total} dishes changed${opts.vendorId ? ' (one restaurant)' : ''}`);
  } else if (!opts.dryRun) {
    await writeAudit('PRICES_RECALCULATED', 'MENU_ITEM', opts.vendorId ?? 'all', `Admin recalculated customer prices: nothing to change (${out.total} dishes)`);
  }
  const SAMPLE = 500;
  return {
    dryRun: opts.dryRun,
    applied: !opts.dryRun,
    total: out.total,
    changed: out.changes.length,
    changes: out.changes.slice(0, SAMPLE),
    truncated: out.changes.length > SAMPLE,
  };
};

