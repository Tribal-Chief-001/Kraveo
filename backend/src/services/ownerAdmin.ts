import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { checkConfirmName, id8 } from '../utils/adminInput';
import { NAME_RE } from '../utils/names';
import { badLabel, collapse } from '../utils/labels';
import { canonicalPhone, last10 } from '../utils/phone';
import { dropFromPartnerRooms, disconnectUser } from '../realtime';
import { invalidateAuthCache } from '../middleware/auth';
import { recordSuccess } from './loginLimiter';
import { hashPassword, passwordProblem } from './password';
import { writeAudit } from './audit';
import { revokeUserEverywhere } from './accountControl';
import { CancelFailure, CancelOutcome, cancelOrdersGuarded, findOpenOrders } from './adminOrders';
import { assertVendorOrdersResolved } from './vendorAdmin';
import { OpenOrdersMode } from './customerAdmin';
import { movePayoutAccountInTx } from './payoutAccount';

/**
 * Admin: the owner login of a restaurant (Docs/27 B4, Docs/28 decisions 1 and 3). Rules that hold in every function:
 *  - one owner per restaurant and ONE restaurant per owner login (the vendor app shows one);
 *  - the phone is unique among ALL users, removed ones included (a removed person keeps their number reserved);
 *  - a generated password is returned once by the caller, never stored in plain text, never logged, never put in an audit row;
 *  - every state change takes the Vendor row lock first (then the owner's User row), the order used by vendorAdmin too.
 */
const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new AppError(409, code, message, undefined, extra);
const badReq = (field: string, message: string) => new AppError(400, 'BAD_REQUEST', message, field);

/** Reason written on a login paused by a detach: the only paused logins that can be attached to another restaurant again. */
export const DETACHED_PREFIX = 'Detached from ';
const attachable = (u: { accountStatus: string; statusReason: string | null }) => u.accountStatus === 'ACTIVE' || (u.accountStatus === 'SUSPENDED' && (u.statusReason ?? '').startsWith(DETACHED_PREFIX));

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no 0 O 1 l I: easy to read out over the phone
export const generatePassword = (): string => Array.from({ length: 16 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');

export type OwnerView = { userId: string; name: string; phone: string | null; accountStatus: string; statusReason: string | null; lastLoginAt: Date | null; createdAt: Date; restaurants: number };

const OWNER_SELECT = { id: true, name: true, phone: true, role: true, accountStatus: true, statusReason: true, lastLoginAt: true, createdAt: true, deletedAt: true, _count: { select: { vendorsOwned: true } } } as const;
type OwnerRow = Prisma.UserGetPayload<{ select: typeof OWNER_SELECT }>;
const view = (u: OwnerRow): OwnerView => ({ userId: u.id, name: u.name, phone: u.phone ?? null, accountStatus: u.accountStatus, statusReason: u.statusReason ?? null, lastLoginAt: u.lastLoginAt ?? null, createdAt: u.createdAt, restaurants: u._count.vendorsOwned });

const vendorOrThrow = async (vendorId: string) => {
  const v = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, name: true, userId: true, removedAt: true, isAcceptingOrders: true } });
  if (!v) throw new AppError(404, 'NOT_FOUND', 'Restaurant not found.');
  return v;
};
const loadOwner = async (userId: string) => prisma.user.findUniqueOrThrow({ where: { id: userId }, select: OWNER_SELECT });

/** The restaurant and its owner, or 404 NO_OWNER. */
const vendorWithOwner = async (vendorId: string) => {
  const v = await vendorOrThrow(vendorId);
  if (!v.userId) throw new AppError(404, 'NO_OWNER', 'This restaurant has no owner login.');
  const owner = await loadOwner(v.userId);
  // Only a restaurant owner login is ever changed here: a mislinked admin / customer / rider row is left alone.
  if (owner.role !== 'VENDOR') throw conflict('NOT_A_VENDOR_USER', 'The login linked to this restaurant is not a restaurant owner login.');
  return { vendor: v, owner };
};

const lockVendorRow = async (tx: Prisma.TransactionClient, vendorId: string) => {
  const rows = await tx.$queryRaw<{ userId: string | null; removedAt: Date | null; isAcceptingOrders: boolean }[]>`SELECT "userId", "removedAt", "isAcceptingOrders" FROM "Vendor" WHERE "id" = ${vendorId} FOR NO KEY UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Restaurant not found.');
  return rows[0];
};

const sameOwner = (row: { userId: string | null }, ownerId: string) => {
  if (row.userId !== ownerId) throw conflict('OWNER_CHANGED', 'The owner of this restaurant changed in the meantime. Reload and try again.');
};

export const getOwner = async (vendorId: string): Promise<OwnerView | null> => {
  const v = await vendorOrThrow(vendorId);
  return v.userId ? view(await loadOwner(v.userId)) : null;
};

const checkPassword = (raw: unknown): string | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  const problem = passwordProblem(raw);
  if (problem) throw badReq('password', problem);
  return raw as string;
};

const phoneTaken = async (phone: string, exceptUserId?: string) =>
  !!(await prisma.user.findFirst({ where: { phone: { endsWith: last10(phone) }, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) }, select: { id: true } }));

export type CreateOwnerInput = { vendorId: string; adminId: string; name?: unknown; phone?: unknown; password?: unknown; existingUserId?: unknown; takePayoutAccountFrom?: unknown };

/** Create a new owner login for an ownerless restaurant, or re-attach a detached owner login. Returns the generated password when the server made one. */
export const createOrAttachOwner = async (input: CreateOwnerInput): Promise<{ owner: OwnerView; generatedPassword?: string; restaurantClosed: boolean; payoutAccountMoved: boolean }> => {
  const { vendorId, adminId } = input;
  const v = await vendorOrThrow(vendorId);
  if (v.removedAt) throw conflict('VENDOR_REMOVED', 'This restaurant was removed. Restore it first.');
  if (v.userId) throw conflict('OWNER_EXISTS', 'This restaurant already has an owner login.');

  const existing = input.existingUserId;
  const from = input.takePayoutAccountFrom;
  if (from !== undefined && (typeof from !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(from))) throw badReq('takePayoutAccountFrom', 'takePayoutAccountFrom must be the id of a detached owner login.');
  let ownerId: string;
  let generatedPassword: string | undefined;
  let moved = false;

  if (existing !== undefined) {
    if (input.name !== undefined || input.phone !== undefined || input.password !== undefined) throw badReq('existingUserId', 'Send either existingUserId or name + phone, not both.');
    if (typeof existing !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(existing)) throw badReq('existingUserId', 'existingUserId is not a valid id.');
    const u = await prisma.user.findUnique({ where: { id: existing }, select: OWNER_SELECT });
    if (!u) throw new AppError(404, 'NOT_FOUND', 'That owner login does not exist.');
    if (u.role !== 'VENDOR') throw conflict('NOT_A_VENDOR_USER', 'Only a restaurant owner login can be attached.');
    if (u.accountStatus === 'REMOVED' || u.deletedAt) throw conflict('OWNER_REMOVED', 'That owner login was removed and cannot be attached.');
    // A login an admin paused for another reason stays paused: attaching must not silently un-pause it. Only a login paused by a detach is attachable.
    if (!attachable(u)) throw conflict('LOGIN_NOT_ACTIVE', 'That owner login is paused. Enable it first, or create a new owner login.');
    if (u._count.vendorsOwned > 0) throw conflict('OWNER_HAS_RESTAURANT', 'That owner login already runs a restaurant. One login runs one restaurant.');
    ownerId = u.id;
  } else {
    const name = typeof input.name === 'string' && !badLabel(input.name) ? collapse(input.name) : '';
    if (!NAME_RE.test(name.replace(/[()]/g, ''))) throw badReq('name', 'Enter the owner name (2 to 60 characters, no symbols).');
    const phone = canonicalPhone(input.phone);
    if (!phone) throw badReq('phone', 'Enter a valid 10-digit Indian mobile number.');
    const typed = checkPassword(input.password);
    if (await phoneTaken(phone)) throw conflict('PHONE_TAKEN', 'This number already belongs to another account.');
    generatedPassword = typed ? undefined : generatePassword();
    const passwordHash = await hashPassword(typed ?? generatedPassword!);
    try {
      ownerId = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({ data: { name, phone, role: 'VENDOR', passwordHash, accountStatus: 'ACTIVE' }, select: { id: true } });
        const linked = await tx.vendor.updateMany({ where: { id: vendorId, userId: null, removedAt: null }, data: { userId: created.id, isAcceptingOrders: false } });
        if (linked.count !== 1) throw conflict('OWNER_EXISTS', 'This restaurant already has an owner login.'); // a parallel create won: this transaction rolls back
        if (typeof from === 'string') {
          await assertDetached(tx, from);
          const m = await movePayoutAccountInTx(tx, from, created.id);
          moved = !!m;
        }
        return created.id;
      }, { maxWait: 15_000, timeout: 30_000 });
    } catch (err: any) {
      if (err?.code === 'P2002') throw conflict('PHONE_TAKEN', 'This number already belongs to another account.');
      throw err;
    }
  }

  if (existing !== undefined) {
    ownerId = existing as string;
    await prisma.$transaction(async (tx) => {
      // One restaurant per login: attaches of the SAME login run one after the other (an advisory lock, not a row lock: the vendor update
      // below takes a key-share lock on the user row, and two of them waiting for a row lock would deadlock), then the count decides.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owner-attach:${ownerId}`}))`;
      const linked = await tx.vendor.updateMany({ where: { id: vendorId, userId: null, removedAt: null }, data: { userId: ownerId, isAcceptingOrders: false } });
      if (linked.count !== 1) throw conflict('OWNER_EXISTS', 'This restaurant already has an owner login.');
      const n = await tx.vendor.count({ where: { userId: ownerId } });
      if (n > 1) throw conflict('OWNER_HAS_RESTAURANT', 'That owner login already runs a restaurant. One login runs one restaurant.');
      const awake = await tx.user.updateMany({
        where: { id: ownerId, OR: [{ accountStatus: 'ACTIVE' }, { accountStatus: 'SUSPENDED', statusReason: { startsWith: DETACHED_PREFIX } }] },
        data: { accountStatus: 'ACTIVE', statusReason: null, statusChangedAt: new Date(), statusChangedBy: adminId },
      });
      if (awake.count !== 1) throw conflict('LOGIN_NOT_ACTIVE', 'That owner login is paused. Enable it first, or create a new owner login.');
      if (typeof from === 'string') {
        await assertDetached(tx, from);
        await movePayoutAccountInTx(tx, from, ownerId);
        moved = true;
      }
    }, { maxWait: 15_000, timeout: 30_000 });
  }

  const owner = view(await loadOwner(ownerId!));
  await writeAudit('OWNER_CREATED', 'VENDOR', vendorId, `${existing !== undefined ? 'Attached' : 'Created'} owner login for ${v.name} (owner ${owner.name}, ${id8(owner.userId)})`, {
    meta: { userId: owner.userId, attachedExisting: existing !== undefined, passwordGenerated: !!generatedPassword, payoutAccountMoved: moved, restaurantClosed: true },
  });
  if (moved) await writeAudit('PAYOUT_ACCOUNT_CHANGED', 'USER', owner.userId, `Payout details of ${v.name} moved to its new owner login ${id8(owner.userId)} (verification cleared)`);
  return { owner, ...(generatedPassword ? { generatedPassword } : {}), restaurantClosed: true, payoutAccountMoved: moved };
};

/** The login whose payout details move must not run a restaurant any more (it was detached). */
const assertDetached = async (tx: Prisma.TransactionClient, userId: string) => {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { role: true, _count: { select: { vendorsOwned: true } } } });
  if (!u) throw new AppError(404, 'NOT_FOUND', 'The login to take the payout details from does not exist.');
  if (u.role !== 'VENDOR') throw conflict('NOT_A_VENDOR_USER', 'Payout details can only be taken from a restaurant owner login.');
  if (u._count.vendorsOwned > 0) throw conflict('PAYOUT_SOURCE_IN_USE', 'That login still runs a restaurant. Detach it first.');
};

export const patchOwner = async (input: { vendorId: string; name?: unknown; phone?: unknown }): Promise<{ changed: boolean; owner: OwnerView }> => {
  const { vendor, owner } = await vendorWithOwner(input.vendorId);
  if (owner.accountStatus === 'REMOVED' || owner.deletedAt) throw conflict('OWNER_REMOVED', 'This owner login was removed.');
  const data: Prisma.UserUpdateInput = {};
  let nameChanged = false;
  let phoneChanged = false;
  let newPhone: string | null = null;
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' && !badLabel(input.name) ? collapse(input.name) : '';
    if (!NAME_RE.test(name.replace(/[()]/g, ''))) throw badReq('name', 'Enter the owner name (2 to 60 characters, no symbols).');
    if (name !== owner.name) { data.name = name; nameChanged = true; }
  }
  if (input.phone !== undefined) {
    newPhone = canonicalPhone(input.phone);
    if (!newPhone) throw badReq('phone', 'Enter a valid 10-digit Indian mobile number.');
    if (last10(newPhone) !== last10(owner.phone ?? '')) {
      if (await phoneTaken(newPhone, owner.id)) throw conflict('PHONE_TAKEN', 'This number already belongs to another account.');
      data.phone = newPhone;
      data.tokenVersion = { increment: 1 }; // the number is the login: every session of the old number ends
      phoneChanged = true;
    }
  }
  if (!nameChanged && !phoneChanged) return { changed: false, owner: view(owner) };
  try {
    await prisma.$transaction(async (tx) => {
      sameOwner(await lockVendorRow(tx, vendor.id), owner.id);
      await tx.user.update({ where: { id: owner.id }, data });
    });
  } catch (err: any) {
    if (err?.code === 'P2002') throw conflict('PHONE_TAKEN', 'This number already belongs to another account.');
    throw err;
  }
  if (phoneChanged) {
    invalidateAuthCache(owner.id);
    disconnectUser(owner.id); // push tokens stay: same person, same phone device
    if (owner.phone) recordSuccess(last10(owner.phone));
    recordSuccess(last10(newPhone!));
    const tail = (p: string | null) => `...${(p ?? '').replace(/\D/g, '').slice(-4)}`;
    await writeAudit('OWNER_PHONE_CHANGED', 'VENDOR', vendor.id, `Owner phone of ${vendor.name} changed ${tail(owner.phone)} -> ${tail(newPhone)} (owner ${id8(owner.id)}); sessions ended`);
  }
  if (nameChanged) await writeAudit('OWNER_RENAMED', 'VENDOR', vendor.id, `Owner of ${vendor.name} renamed (owner ${id8(owner.id)})`);
  return { changed: true, owner: view(await loadOwner(owner.id)) };
};

/**
 * Reset the owner's password. Resets of the same restaurant run one after the other (Vendor row lock, then the owner's User row): the
 * password that works is always the one stored last, and every answer carries `issuedAt` (the commit time of ITS password) so a screen that
 * receives two answers out of order keeps the newest.
 */
export const resetOwnerPassword = async (input: { vendorId: string; password?: unknown }): Promise<{ generatedPassword?: string; issuedAt: string }> => {
  const { vendor, owner } = await vendorWithOwner(input.vendorId);
  if (owner.accountStatus === 'REMOVED' || owner.deletedAt) throw conflict('OWNER_REMOVED', 'This owner login was removed.');
  const typed = checkPassword(input.password);
  let generatedPassword: string | undefined;
  const issuedAt = await prisma.$transaction(async (tx) => {
    sameOwner(await lockVendorRow(tx, vendor.id), owner.id);
    const u = await tx.$queryRaw<{ accountStatus: string; deletedAt: Date | null }[]>`SELECT "accountStatus"::text AS "accountStatus", "deletedAt" FROM "User" WHERE "id" = ${owner.id} FOR UPDATE`;
    if (u.length === 0 || u[0].accountStatus === 'REMOVED' || u[0].deletedAt) throw conflict('OWNER_REMOVED', 'This owner login was removed.');
    generatedPassword = typed ? undefined : generatePassword(); // chosen under the lock, so it is the one that gets stored
    const passwordHash = await hashPassword(typed ?? generatedPassword!);
    await tx.user.update({ where: { id: owner.id }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    return new Date();
  }, { maxWait: 15_000, timeout: 30_000 });
  invalidateAuthCache(owner.id); // every session of this login ends; the old password stops working now
  disconnectUser(owner.id);
  if (owner.phone) recordSuccess(last10(owner.phone));
  await writeAudit('PASSWORD_RESET', 'USER', owner.id, `Reset the owner password of ${vendor.name} (owner ${id8(owner.id)}); ${generatedPassword ? 'generated' : 'typed'} by the admin`, { meta: { passwordGenerated: !!generatedPassword, vendorId: vendor.id } });
  return { ...(generatedPassword ? { generatedPassword } : {}), issuedAt: issuedAt.toISOString() };
};

export const disableOwner = async (input: { vendorId: string; adminId: string; reason: string; closeRestaurant: boolean }): Promise<{ changed: boolean; owner: OwnerView; warning?: string; openOrders: number }> => {
  const { vendor, owner } = await vendorWithOwner(input.vendorId);
  if (owner.accountStatus === 'REMOVED' || owner.deletedAt) throw conflict('OWNER_REMOVED', 'This owner login was removed.');
  let changed = false;
  if (owner.accountStatus === 'ACTIVE') {
    changed = await prisma.$transaction(async (tx) => {
      sameOwner(await lockVendorRow(tx, vendor.id), owner.id);
      const r = await tx.user.updateMany({ where: { id: owner.id, accountStatus: 'ACTIVE' }, data: { accountStatus: 'SUSPENDED', statusReason: input.reason, statusChangedAt: new Date(), statusChangedBy: input.adminId } });
      if (r.count === 1 && input.closeRestaurant) await tx.vendor.update({ where: { id: vendor.id }, data: { isAcceptingOrders: false } });
      return r.count === 1;
    });
    if (changed) {
      await revokeUserEverywhere(owner.id, 'OWNER_DISABLED');
      await dropFromPartnerRooms(owner.id, [`vendor_${vendor.id}`]);
      await writeAudit('OWNER_DISABLED', 'VENDOR', vendor.id, `Disabled the owner login of ${vendor.name} (owner ${id8(owner.id)}): ${input.reason}${input.closeRestaurant ? '; restaurant closed' : ''}`, { meta: { before: { accountStatus: 'ACTIVE' }, after: { accountStatus: 'SUSPENDED' }, closeRestaurant: input.closeRestaurant } });
    }
  }
  const { open } = await findOpenOrders(prisma, { vendorId: vendor.id });
  const fresh = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id }, select: { isAcceptingOrders: true } });
  const warning = !input.closeRestaurant && (fresh.isAcceptingOrders || open.length > 0) ? 'Orders will arrive that only an admin can accept.' : undefined;
  return { changed, owner: view(await loadOwner(owner.id)), openOrders: open.length, ...(warning ? { warning } : {}) };
};

export const enableOwner = async (input: { vendorId: string; adminId: string }): Promise<{ changed: boolean; owner: OwnerView }> => {
  const { vendor, owner } = await vendorWithOwner(input.vendorId);
  if (owner.accountStatus === 'REMOVED' || owner.deletedAt) throw conflict('OWNER_REMOVED', 'This owner login was removed.');
  let changed = false;
  if (owner.accountStatus === 'SUSPENDED') {
    // Only the login comes back. The restaurant stays as it is (closed if the disable closed it): the owner opens it after signing in.
    changed = await prisma.$transaction(async (tx) => {
      sameOwner(await lockVendorRow(tx, vendor.id), owner.id);
      const r = await tx.user.updateMany({ where: { id: owner.id, accountStatus: 'SUSPENDED' }, data: { accountStatus: 'ACTIVE', statusReason: null, statusChangedAt: new Date(), statusChangedBy: input.adminId } });
      if (r.count === 1) await tx.vendor.update({ where: { id: vendor.id }, data: { ownerDisabledByRemoval: false } });
      return r.count === 1;
    });
    if (changed) await writeAudit('OWNER_ENABLED', 'VENDOR', vendor.id, `Enabled the owner login of ${vendor.name} (owner ${id8(owner.id)})`, { meta: { before: { accountStatus: 'SUSPENDED' }, after: { accountStatus: 'ACTIVE' } } });
  }
  return { changed, owner: view(await loadOwner(owner.id)) };
};

/**
 * Detach (the login is paused and no longer linked) or, with `removeUser`, also REMOVE the login (accountStatus REMOVED + deletedAt; its
 * payout details stay for the settlements). Open orders: refused with the exact list, or cancelled through the normal cancel code.
 */
export const detachOwner = async (input: { vendorId: string; adminId: string; reason: string; openOrders: OpenOrdersMode; closeRestaurant: boolean; removeUser: boolean; confirmName?: unknown }): Promise<{ changed: boolean; detachedUser: { id: string; name: string } | null; cancelled?: CancelOutcome[]; failed?: CancelFailure[]; remaining?: string[] }> => {
  const { vendorId, adminId, reason, openOrders } = input;
  const { vendor, owner } = await vendorWithOwner(vendorId);
  if (input.removeUser) checkConfirmName(input.confirmName, vendor.name, owner.name);
  await assertVendorOrdersResolved(prisma, vendorId, openOrders);
  const now = new Date();
  const res = await prisma.$transaction(async (tx) => {
    const row = await lockVendorRow(tx, vendorId);
    sameOwner(row, owner.id);
    await assertVendorOrdersResolved(tx, vendorId, openOrders);
    await tx.vendor.update({ where: { id: vendorId }, data: { userId: null, ownerDisabledByRemoval: false, ...(input.closeRestaurant ? { isAcceptingOrders: false } : {}) } });
    await tx.user.update({
      where: { id: owner.id },
      data: input.removeUser
        ? { accountStatus: 'REMOVED', statusReason: reason, statusChangedAt: now, statusChangedBy: adminId, deletedAt: now }
        : { accountStatus: 'SUSPENDED', statusReason: `${DETACHED_PREFIX}${vendor.name}`.slice(0, 200), statusChangedAt: now, statusChangedBy: adminId },
    });
    return true;
  }, { maxWait: 15_000, timeout: 30_000 });
  await revokeUserEverywhere(owner.id, input.removeUser ? 'ACCOUNT_REMOVED' : 'OWNER_DETACHED');
  await dropFromPartnerRooms(owner.id, [`vendor_${vendorId}`]);
  let out: { cancelled?: CancelOutcome[]; failed?: CancelFailure[]; remaining?: string[] } = {};
  if (openOrders === 'CANCEL') {
    const { open } = await findOpenOrders(prisma, { vendorId });
    out = await cancelOrdersGuarded(open, { id: adminId }, 'Restaurant is no longer available');
  }
  const n = out.cancelled?.reduce((a, c) => a + c.cancelledOrders, 0) ?? 0;
  await writeAudit(input.removeUser ? 'OWNER_REMOVED' : 'OWNER_DETACHED', 'VENDOR', vendorId, `${input.removeUser ? 'Removed' : 'Detached'} the owner login of ${vendor.name} (owner ${owner.name}, ${id8(owner.id)}): ${reason}; ${n} open order(s) cancelled`, {
    meta: { before: { ownerUserId: owner.id, accountStatus: owner.accountStatus }, after: { ownerUserId: null, accountStatus: input.removeUser ? 'REMOVED' : 'SUSPENDED' }, openOrders: { mode: openOrders, cancelled: n } },
  });
  return { changed: res, detachedUser: { id: owner.id, name: owner.name }, ...out };
};
