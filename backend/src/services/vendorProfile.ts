import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { CUISINES_INCLUDE, cuisineList } from '../utils/catalog';
import { writeAudit } from './audit';
import { retryStaleRead } from '../utils/prismaRetry';
import { checkCuisineIds, deriveVendorCategory, lockCuisines, writeVendorCuisines } from './categories';
import { BAD_LABEL_CHARS, collapse } from '../utils/labels';
import type { Actor } from './categories';

/**
 * PATCH /admin/vendors/:id/profile (Docs/23 section 3.3): name, categories (cuisines), address, banner, FSSAI, ETA.
 * Location, commission, open / closed and payout details keep their own endpoints. Renaming never touches old orders (they read the live name).
 * Lock order: category rows (FOR SHARE, ascending id) -> the restaurant row -> (nothing else). The same body twice is a no-op (changed:false).
 */
export const DEFAULT_BANNER_URL = 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600';
const PROFILE_KEYS = ['name', 'cuisineIds', 'address', 'bannerImage', 'fssaiNumber', 'eta'];
const TX_OPTS = { maxWait: 10_000, timeout: 20_000 };
const bad = (field: string, message: string, code = 'BAD_REQUEST') => new AppError(400, code, message, field);

const checkText = (raw: unknown, field: string, label: string, min: number, max: number): string => {
  if (typeof raw !== 'string') throw bad(field, `${label} must be text.`);
  const v = collapse(raw);
  if (/[<>]/.test(v) || BAD_LABEL_CHARS.test(raw.normalize('NFC'))) throw bad(field, `${label} cannot contain symbols like < > or hidden, control or direction-changing characters.`);
  if (v.length < min || v.length > max) throw bad(field, `${label} must be ${min} to ${max} characters.`);
  return v;
};

const checkBanner = (raw: unknown): string => {
  if (raw === null) return DEFAULT_BANNER_URL;
  if (typeof raw !== 'string') throw bad('bannerImage', 'The banner must be a link (https://...) or null to use the default banner.');
  const v = raw.trim();
  let ok = v.length > 0 && v.length <= 500 && /^https?:\/\//i.test(v) && !/\s/.test(v);
  if (ok) { try { new URL(v); } catch { ok = false; } }
  if (!ok) throw bad('bannerImage', 'The banner must be an http(s) link of up to 500 characters without spaces, or null for the default banner.');
  return v;
};

const checkFssai = (raw: unknown): string | null => {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw bad('fssaiNumber', 'The FSSAI number must be exactly 14 digits, or null.');
  const v = raw.replace(/\s/g, '');
  if (!/^\d{14}$/.test(v)) throw bad('fssaiNumber', 'The FSSAI number must be exactly 14 digits, or null.');
  return v;
};

const checkEta = (raw: unknown): string => {
  const m = typeof raw === 'string' ? /^(\d{1,3})-(\d{1,3}) min$/.exec(raw) : null;
  if (!m || Number(m[1]) > Number(m[2])) throw bad('eta', "The delivery time must look like '20-30 min' (first number not bigger than the second).");
  return raw as string;
};

const ADMIN_INCLUDE = { menuItems: { where: { deletedAt: null } }, ...CUISINES_INCLUDE } satisfies Prisma.VendorInclude;
export const adminVendorRow = (id: string) => retryStaleRead(() => prisma.vendor.findUnique({ where: { id }, include: ADMIN_INCLUDE }));

export const editVendorProfile = async (vendorId: string, b: Record<string, unknown>, actor: Actor) => {
  const unknown = Object.keys(b).find((k) => !PROFILE_KEYS.includes(k));
  if (unknown) throw bad(unknown.slice(0, 40), `Unknown field '${unknown.slice(0, 40)}'. You can change: ${PROFILE_KEYS.join(', ')}.`);
  if (Object.keys(b).length === 0) throw bad('body', `Send at least one of: ${PROFILE_KEYS.join(', ')}.`);
  const wantIds = b.cuisineIds !== undefined ? checkCuisineIds(b.cuisineIds) : undefined;

  const out = await prisma.$transaction(async (tx) => {
    // 1. categories first (ascending id, FOR SHARE), then the restaurant row (the fixed lock order).
    const linksBefore = await tx.vendorCategory.findMany({ where: { vendorId }, orderBy: [{ position: 'asc' }, { categoryId: 'asc' }], select: { categoryId: true } });
    const cuisines = wantIds ? await lockCuisines(tx, wantIds, new Set(linksBefore.map((l) => l.categoryId))) : undefined;
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
    if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
    const before = await tx.vendor.findUniqueOrThrow({ where: { id: vendorId }, include: { cuisines: { orderBy: [{ position: 'asc' }, { categoryId: 'asc' }], select: { categoryId: true, category: { select: { name: true } } } } } });

    const data: Prisma.VendorUpdateInput = {};
    const notes: string[] = [];
    if (b.name !== undefined) {
      const name = checkText(b.name, 'name', 'The restaurant name', 2, 60);
      if (name !== before.name) {
        // Names of APPROVED restaurants are unique ignoring case and spacing. The advisory lock makes two parallel renames to the same name safe.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vendor-name-unique'))`;
        const taken = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Vendor" WHERE "id" <> ${vendorId} AND "approvalStatus" = 'APPROVED'
            AND lower(regexp_replace(btrim("name"), '\\s+', ' ', 'g')) = lower(${name}) LIMIT 1`;
        if (taken.length) throw new AppError(409, 'NAME_TAKEN', 'Another restaurant already uses this name.', 'name');
        data.name = name;
        notes.push(`name "${before.name}" -> "${name}"`);
      }
    }
    if (b.address !== undefined) {
      const address = checkText(b.address, 'address', 'The address', 3, 140);
      if (address !== before.address) { data.address = address; notes.push('address changed'); }
    }
    if (b.bannerImage !== undefined && b.bannerImage !== before.bannerImage) {
      const banner = checkBanner(b.bannerImage);
      if (banner !== before.bannerImage) { data.bannerImage = banner; notes.push(b.bannerImage === null ? 'banner reset to the default' : 'banner changed'); }
    }
    if (b.fssaiNumber !== undefined) {
      const fssai = checkFssai(b.fssaiNumber);
      if (fssai !== before.fssaiNumber) { data.fssaiNumber = fssai; notes.push(`FSSAI ${before.fssaiNumber ?? 'none'} -> ${fssai ?? 'none'}`); }
    }
    if (b.eta !== undefined && b.eta !== before.eta) {
      const eta = checkEta(b.eta);
      data.eta = eta;
      notes.push(`ETA ${before.eta} -> ${eta}`);
    }

    let categoriesChanged = false;
    if (cuisines) {
      const nowIds = before.cuisines.map((c) => c.categoryId);
      const derived = deriveVendorCategory(cuisines.map((c) => c.name));
      const sameLinks = nowIds.length === cuisines.length && nowIds.every((id, i) => id === cuisines[i].id);
      if (!sameLinks || derived !== before.category) {
        categoriesChanged = true;
        notes.push(`categories [${before.cuisines.map((c) => c.category.name).join(', ')}] -> [${cuisines.map((c) => c.name).join(', ')}]`);
      }
    }
    if (Object.keys(data).length === 0 && !categoriesChanged) return { changed: false, before, notes };
    if (Object.keys(data).length) await tx.vendor.update({ where: { id: vendorId }, data });
    if (categoriesChanged && cuisines) await writeVendorCuisines(tx, vendorId, cuisines);
    return { changed: true, before, notes };
  }, TX_OPTS);

  const vendor = (await adminVendorRow(vendorId))!;
  if (out.changed) await writeAudit('VENDOR_PROFILE_EDITED', 'VENDOR', vendorId, `Admin edited restaurant "${out.before.name}": ${out.notes.join('; ')}`);
  return { changed: out.changed, vendor, cuisines: cuisineList(vendor) };
};
