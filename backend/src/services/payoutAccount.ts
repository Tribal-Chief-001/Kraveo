import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { writeAudit } from './audit';
import { decryptSecret, encryptSecret, last4, maskAccount } from './payoutCrypto';

/**
 * Where a restaurant or rider gets paid (Docs/21 section 5). One PayoutAccount per user.
 *
 * Secrets: the full bank account number exists only as AES-256-GCM ciphertext in `accountNumberEnc`. Every view carries `accountLast4`;
 * the only way to read the full number is `revealAccountNumber` (admin, audit row written BEFORE the number leaves, so a failed audit
 * write means no reveal). Nothing in this file logs a value or puts one in an error or an audit line (only method, last 4, UPI id).
 *
 * Writes run under a row lock so a save and an admin "verify" at the same moment cannot interleave (a verify can never survive a change
 * of details that happened a moment before it).
 */
export type PartnerType = 'VENDOR' | 'DRIVER';
export type Actor = { id: string; role: string };

export const UPI_RE = /^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,31}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_NUMBER_RE = /^\d{6,20}$/;
const HOLDER_RE = /^[\p{L}][\p{L}\p{M}\s.'-]*$/u;

export type PayoutInput =
  | { method: 'UPI'; upiId: string; accountHolder: string | null }
  | { method: 'BANK'; accountHolder: string; accountNumber: string; ifsc: string; bankName: string | null };

const bad = (field: string, message: string) => new AppError(400, 'BAD_REQUEST', message, field);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ALLOWED = ['method', 'upiId', 'accountHolder', 'accountNumber', 'ifsc', 'bankName'];

const optionalText = (raw: unknown, field: string, min: number, max: number, label: string): string | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw bad(field, `${label} must be text.`);
  const s = raw.trim().replace(/\s+/g, ' ');
  if (s.length < min || s.length > max) throw bad(field, `${label} must be ${min} to ${max} characters.`);
  return s;
};

const holder = (raw: unknown, required: boolean): string | null => {
  const s = optionalText(raw, 'accountHolder', 2, 80, 'Account holder name');
  if (s === null) {
    if (required) throw bad('accountHolder', 'Account holder name is required (2 to 80 characters).');
    return null;
  }
  if (!HOLDER_RE.test(s)) throw bad('accountHolder', 'Account holder name can only have letters, spaces and . \' -');
  return s;
};

/** Strict validation of the body of every payout-account write. Unknown fields are refused, account numbers must be JSON strings. */
export const parsePayoutInput = (raw: unknown): PayoutInput => {
  if (!isObj(raw)) throw bad('body', 'Send the payout details as a JSON object.');
  const extra = Object.keys(raw).find((k) => !ALLOWED.includes(k));
  if (extra) throw bad(extra, `Unknown field '${extra.slice(0, 40)}'.`);
  if (raw.method !== 'UPI' && raw.method !== 'BANK') throw bad('method', 'Method must be UPI or BANK.');
  if (raw.method === 'UPI') {
    if (typeof raw.upiId !== 'string') throw bad('upiId', 'UPI id is required, for example name@okhdfcbank.');
    const upiId = raw.upiId.trim().toLowerCase();
    if (!UPI_RE.test(upiId)) throw bad('upiId', 'That does not look like a UPI id (for example name@okhdfcbank).');
    for (const k of ['accountNumber', 'ifsc', 'bankName']) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') throw bad(k, `${k} is only for BANK accounts.`);
    return { method: 'UPI', upiId, accountHolder: holder(raw.accountHolder, false) };
  }
  if (raw.upiId !== undefined && raw.upiId !== null && raw.upiId !== '') throw bad('upiId', 'upiId is only for UPI accounts.');
  const accountHolder = holder(raw.accountHolder, true)!;
  if (typeof raw.accountNumber !== 'string') throw bad('accountNumber', 'Account number is required (send it as text, 6 to 20 digits).');
  const accountNumber = raw.accountNumber.replace(/[\s-]/g, '');
  if (!ACCOUNT_NUMBER_RE.test(accountNumber)) throw bad('accountNumber', 'Account number must be 6 to 20 digits.');
  if (typeof raw.ifsc !== 'string') throw bad('ifsc', 'IFSC is required, for example HDFC0001234.');
  const ifsc = raw.ifsc.trim().toUpperCase();
  if (!IFSC_RE.test(ifsc)) throw bad('ifsc', 'That does not look like an IFSC code (4 letters, 0, then 6 letters or digits).');
  return { method: 'BANK', accountHolder, accountNumber, ifsc, bankName: optionalText(raw.bankName, 'bankName', 2, 60, 'Bank name') };
};

type Row = Prisma.PayoutAccountGetPayload<{}>;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** What a restaurant or rider app gets back about its own account: masked, never the full number. */
export const partnerAccountView = (r: Row) => ({
  method: r.method as 'UPI' | 'BANK',
  upiId: r.upiId,
  accountHolder: r.accountHolder,
  accountLast4: r.accountLast4,
  ifsc: r.ifsc,
  bankName: r.bankName,
  verifiedAt: iso(r.verifiedAt),
  updatedAt: r.updatedAt.toISOString(),
});

/** The admin portal's (still masked) view: the same fields plus who it belongs to. */
export const adminAccountView = (r: Row) => ({
  userId: r.userId,
  partnerType: r.partnerType as PartnerType,
  ...partnerAccountView(r),
  accountMasked: maskAccount(r.accountLast4),
  verifiedBy: r.verifiedBy,
});

/** Masked payout destination copied onto a settlement when it is created (no full number, ever). */
export const payoutSnapshotOf = (r: Row | null) =>
  r
    ? {
        method: r.method,
        destination: r.method === 'UPI' ? r.upiId : maskAccount(r.accountLast4),
        accountHolder: r.accountHolder,
        ifsc: r.method === 'BANK' ? r.ifsc : null,
        bankName: r.method === 'BANK' ? r.bankName : null,
        verified: !!r.verifiedAt,
      }
    : null;

export const getAccount = (userId: string) => prisma.payoutAccount.findUnique({ where: { userId } });

/** The user an admin route points at: must be a restaurant owner or a rider. */
export const partnerUser = async (userId: string): Promise<{ id: string; name: string; role: PartnerType }> => {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, deletedAt: true } });
  if (!u || u.deletedAt || (u.role !== 'VENDOR' && u.role !== 'DRIVER')) throw new AppError(404, 'NOT_FOUND', 'No restaurant or rider account with this id.');
  return { id: u.id, name: u.name, role: u.role };
};

const lockRow = (tx: Prisma.TransactionClient, userId: string) => tx.$queryRaw`SELECT "id" FROM "PayoutAccount" WHERE "userId" = ${userId} FOR UPDATE`;

const describe = (input: PayoutInput, last: string | null) =>
  input.method === 'UPI' ? `UPI ${input.upiId}` : `bank account ending ${last}${input.ifsc ? ` (${input.ifsc})` : ''}`;

/**
 * Save (create or replace) the account of `userId`. Returns the stored row and whether the details changed (a change clears
 * `verifiedAt`; saving the same details again changes nothing, so a double tap keeps a verified account verified).
 */
export const saveAccount = async (userId: string, partnerType: PartnerType, raw: unknown, actor: Actor) => {
  const input = parsePayoutInput(raw);
  const encrypted = input.method === 'BANK' ? encryptSecret(input.accountNumber, userId) : null; // 503 here when the key is missing
  const data = {
    partnerType,
    method: input.method,
    upiId: input.method === 'UPI' ? input.upiId : null,
    accountHolder: input.accountHolder,
    accountNumberEnc: encrypted,
    accountLast4: input.method === 'BANK' ? last4(input.accountNumber) : null,
    ifsc: input.method === 'BANK' ? input.ifsc : null,
    bankName: input.method === 'BANK' ? input.bankName : null,
  };
  const run = () =>
    prisma.$transaction(
      async (tx) => {
        await lockRow(tx, userId);
        const existing = await tx.payoutAccount.findUnique({ where: { userId } });
        if (!existing) return { row: await tx.payoutAccount.create({ data: { userId, ...data } }), changed: true, created: true };
        let sameNumber = true;
        if (input.method === 'BANK') {
          try {
            sameNumber = !!existing.accountNumberEnc && decryptSecret(existing.accountNumberEnc, userId) === input.accountNumber;
          } catch {
            sameNumber = false;
          }
        }
        const changed =
          existing.method !== data.method || existing.upiId !== data.upiId || existing.accountHolder !== data.accountHolder ||
          existing.ifsc !== data.ifsc || existing.bankName !== data.bankName || existing.partnerType !== data.partnerType || !sameNumber;
        if (!changed) return { row: existing, changed: false, created: false };
        // `accountNumberEnc` is re-encrypted (fresh IV) only when the details changed.
        return { row: await tx.payoutAccount.update({ where: { userId }, data: { ...data, verifiedAt: null, verifiedBy: null } }), changed: true, created: false };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  let out;
  try {
    out = await run();
  } catch (err: any) {
    if (err?.code === 'P2002') out = await run(); // two first saves raced on the INSERT: the loser now sees the winner's row
    else throw err;
  }
  if (out.changed) {
    await writeAudit('PAYOUT_ACCOUNT_CHANGED', 'USER', userId, `${actor.role === 'ADMIN' ? 'Admin' : 'Partner'} ${actor.id} ${out.created ? 'added' : 'changed'} the payout details of ${partnerType} ${userId}: ${describe(input, out.row.accountLast4)}. Verification cleared.`);
  }
  return out;
};

/** Admin: mark the account verified (or not). Idempotent. */
export const setVerified = async (userId: string, verified: unknown, actor: Actor) => {
  if (typeof verified !== 'boolean') throw bad('verified', 'verified must be true or false.');
  const out = await prisma.$transaction(
    async (tx) => {
      await lockRow(tx, userId);
      const existing = await tx.payoutAccount.findUnique({ where: { userId } });
      if (!existing) throw new AppError(404, 'NO_PAYOUT_ACCOUNT', 'This partner has not saved payout details yet.');
      if (verified === !!existing.verifiedAt) return { row: existing, changed: false };
      const row = await tx.payoutAccount.update({
        where: { userId },
        data: verified ? { verifiedAt: new Date(), verifiedBy: actor.id } : { verifiedAt: null, verifiedBy: null },
      });
      return { row, changed: true };
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
  if (out.changed) await writeAudit(verified ? 'PAYOUT_ACCOUNT_VERIFIED' : 'PAYOUT_ACCOUNT_UNVERIFIED', 'USER', userId, `Admin ${actor.id} marked the payout details of ${out.row.partnerType} ${userId} as ${verified ? 'verified' : 'not verified'}.`);
  return out;
};

/**
 * Admin: the full account number, once per call. The audit row is written first and a failure to write it aborts the reveal.
 * The row never says what the number was.
 */
export const revealAccountNumber = async (userId: string, actor: Actor) => {
  const row = await getAccount(userId);
  if (!row) throw new AppError(404, 'NO_PAYOUT_ACCOUNT', 'This partner has not saved payout details yet.');
  let accountNumber: string | null = null;
  if (row.method === 'BANK') {
    if (!row.accountNumberEnc) throw new AppError(500, 'PAYOUT_DECRYPT_FAILED', 'The stored account number could not be read.');
    accountNumber = decryptSecret(row.accountNumberEnc, userId); // before the audit row: a 503/500 here reveals nothing and logs nothing
  }
  await prisma.adminAuditLog.create({
    data: { action: 'PAYOUT_ACCOUNT_REVEALED', targetType: 'USER', targetId: userId, summary: `Admin ${actor.id} revealed the full ${row.method === 'BANK' ? `bank account number (ending ${row.accountLast4})` : 'UPI id'} of ${row.partnerType} ${userId}.` },
  });
  return { row, accountNumber };
};
