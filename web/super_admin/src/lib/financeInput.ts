// Validation of what an admin types in the Finance forms. The server stays the authority (backend services/settlement.ts,
// finance.ts, payoutAccount.ts, pricing.ts); these rules copy it so an obvious mistake never needs a round trip.
// Every validator returns { ok: true, value } or { ok: false, errors } with one plain message per field.

import { addDays, isDateString, istToday } from './financeParse';

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };
const fail = (errors: Record<string, string>): { ok: false; errors: Record<string, string> } => ({ ok: false, errors });

const clean = (text: string): string => text.trim().replace(/\s+/g, ' ');

export const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\/:#-]{2,63}$/;
const REFERENCE_MESSAGE = 'The reference must be 3 to 64 characters: letters, digits, space and _ . / : # -';

/** A random id so a double click or a retry of the same form is recognised by the server as the same adjustment. */
export const newRequestId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};

// ───────────────────────────── Mark paid ─────────────────────────────

export interface MarkPaidInput { reference: string; paidAt?: string; note?: string }

/**
 * `paidDate` is an India date (YYYY-MM-DD) or empty. Today's date (or empty) lets the server use "now"; an earlier date is sent as
 * noon India time of that day. A future date is refused.
 */
export const validateMarkPaid = (form: { reference: string; paidDate: string; note: string }, nowMs: number = Date.now()): Checked<MarkPaidInput> => {
  const errors: Record<string, string> = {};
  const reference = clean(form.reference);
  if (reference === '') errors.reference = 'Enter the bank or UPI transaction reference (UTR).';
  else if (!REFERENCE_RE.test(reference)) errors.reference = REFERENCE_MESSAGE;
  const value: MarkPaidInput = { reference };
  const date = form.paidDate.trim();
  if (date !== '') {
    if (!isDateString(date)) errors.paidDate = 'Pick a valid paid date.';
    else if (date > istToday(nowMs)) errors.paidDate = 'The paid date cannot be in the future.';
    else if (date < istToday(nowMs)) value.paidAt = `${date}T12:00:00+05:30`;
  }
  const note = form.note.trim();
  if (note.length > 300) errors.note = 'The note can be at most 300 characters.';
  else if (note !== '') value.note = note;
  return Object.keys(errors).length > 0 ? fail(errors) : { ok: true, value };
};

// ───────────────────────────── Hold ─────────────────────────────

export const validateHold = (noteText: string): Checked<{ note?: string }> => {
  const note = clean(noteText);
  if (note.length > 300) return fail({ note: 'The note can be at most 300 characters.' });
  return { ok: true, value: note ? { note } : {} };
};

// ───────────────────────────── Adjustment ─────────────────────────────

export const MAX_ADJUSTMENT = 100_000;
const SIGNED_AMOUNT = /^[+-]?\d{1,6}(\.\d{1,2})?$/;

export interface AdjustmentInput { amount: number; reason: string }

/** `amount` + pays the restaurant more, - deducts. `current` lets us refuse a deduction that would make the payable amount negative. */
export const validateAdjustment = (
  form: { amount: string; reason: string },
  current?: { vendorAmount: number; adjustmentTotal: number },
): Checked<AdjustmentInput> => {
  const errors: Record<string, string> = {};
  const text = form.amount.trim().replace(/^\+\s*/, '+').replace(/^-\s*/, '-');
  let amount = 0;
  if (text === '') errors.amount = 'Enter an amount: + pays the restaurant more, - deducts.';
  else if (/^[+-]?\d+\.\d{3,}$/.test(text)) errors.amount = 'The amount can have at most 2 decimals (paise).';
  else if (!SIGNED_AMOUNT.test(text)) errors.amount = 'The amount must be a plain number like 50 or -25.50.';
  else {
    amount = Math.round(Number(text) * 100) / 100;
    if (amount === 0) errors.amount = 'The amount cannot be 0.';
    else if (Math.abs(amount) > MAX_ADJUSTMENT) errors.amount = `The amount must be between -${MAX_ADJUSTMENT.toLocaleString('en-IN')} and ${MAX_ADJUSTMENT.toLocaleString('en-IN')}.`;
    else if (current) {
      const net = Math.round(current.vendorAmount * 100) + Math.round(current.adjustmentTotal * 100) + Math.round(amount * 100);
      if (net < 0) errors.amount = 'This would make the payable amount negative. Deduct less, or cancel the settlement.';
    }
  }
  const reason = clean(form.reason);
  if (reason === '') errors.reason = 'Enter a reason (3 to 200 characters). It is kept in the audit log.';
  else if (reason.length < 3 || reason.length > 200) errors.reason = 'The reason must be 3 to 200 characters.';
  return Object.keys(errors).length > 0 ? fail(errors) : { ok: true, value: { amount, reason } };
};

// ───────────────────────────── Rider payout ─────────────────────────────

export const MAX_RIDER_PAYOUT = 100_000;
const POSITIVE_AMOUNT = /^\d{1,6}(\.\d{1,2})?$/;

export interface RiderPayoutInput { driverUserId: string; amount: number; method: 'UPI' | 'BANK' | 'CASH'; reference?: string; note?: string }

export const validateRiderPayout = (form: { driverUserId: string; method: string; amount: string; reference: string; note: string }): Checked<RiderPayoutInput> => {
  const errors: Record<string, string> = {};
  if (!form.driverUserId) errors.driverUserId = 'Choose the rider.';
  if (form.method !== 'UPI' && form.method !== 'BANK' && form.method !== 'CASH') errors.method = 'Choose UPI, bank or cash.';
  const text = form.amount.trim();
  let amount = 0;
  if (text === '') errors.amount = 'Enter the amount paid.';
  else if (/^\d+\.\d{3,}$/.test(text)) errors.amount = 'The amount can have at most 2 decimals (paise).';
  else if (!POSITIVE_AMOUNT.test(text)) errors.amount = 'The amount must be a plain number like 250 or 250.50.';
  else {
    amount = Math.round(Number(text) * 100) / 100;
    if (amount <= 0) errors.amount = 'The amount must be more than 0.';
    else if (amount > MAX_RIDER_PAYOUT) errors.amount = `The amount cannot be more than ${MAX_RIDER_PAYOUT.toLocaleString('en-IN')}.`;
  }
  const reference = clean(form.reference);
  if (reference !== '' && !REFERENCE_RE.test(reference)) errors.reference = REFERENCE_MESSAGE;
  const note = form.note.trim();
  if (note.length > 300) errors.note = 'The note can be at most 300 characters.';
  if (Object.keys(errors).length > 0) return fail(errors);
  return {
    ok: true,
    value: { driverUserId: form.driverUserId, amount, method: form.method as 'UPI' | 'BANK' | 'CASH', ...(reference ? { reference } : {}), ...(note ? { note } : {}) },
  };
};

// ───────────────────────────── Payout account ─────────────────────────────

export const UPI_RE = /^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,31}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_NUMBER_RE = /^\d{6,20}$/;
const HOLDER_RE = /^[\p{L}][\p{L}\p{M}\s.'-]*$/u;

export type PayoutAccountInput =
  | { method: 'UPI'; upiId: string; accountHolder?: string }
  | { method: 'BANK'; accountHolder: string; accountNumber: string; ifsc: string; bankName?: string };

export const validatePayoutAccount = (form: { method: string; upiId: string; accountHolder: string; accountNumber: string; ifsc: string; bankName: string }): Checked<PayoutAccountInput> => {
  const errors: Record<string, string> = {};
  const holder = clean(form.accountHolder);
  const holderError = (required: boolean): string | undefined => {
    if (holder === '') return required ? 'Enter the account holder name (2 to 80 characters).' : undefined;
    if (holder.length < 2 || holder.length > 80) return 'The account holder name must be 2 to 80 characters.';
    if (!HOLDER_RE.test(holder)) return "The account holder name can only have letters, spaces and . ' -";
    return undefined;
  };
  if (form.method === 'UPI') {
    const upiId = form.upiId.trim().toLowerCase();
    if (upiId === '') errors.upiId = 'Enter the UPI id, for example name@okhdfcbank.';
    else if (!UPI_RE.test(upiId)) errors.upiId = 'That does not look like a UPI id (for example name@okhdfcbank).';
    const he = holderError(false);
    if (he) errors.accountHolder = he;
    return Object.keys(errors).length > 0 ? fail(errors) : { ok: true, value: { method: 'UPI', upiId, ...(holder ? { accountHolder: holder } : {}) } };
  }
  if (form.method !== 'BANK') return fail({ method: 'Choose UPI or bank account.' });
  const he = holderError(true);
  if (he) errors.accountHolder = he;
  const accountNumber = form.accountNumber.replace(/[\s-]/g, '');
  if (accountNumber === '') errors.accountNumber = 'Enter the full account number (6 to 20 digits).';
  else if (!ACCOUNT_NUMBER_RE.test(accountNumber)) errors.accountNumber = 'The account number must be 6 to 20 digits.';
  const ifsc = form.ifsc.trim().toUpperCase();
  if (ifsc === '') errors.ifsc = 'Enter the IFSC code, for example HDFC0001234.';
  else if (!IFSC_RE.test(ifsc)) errors.ifsc = 'That does not look like an IFSC code (4 letters, 0, then 6 letters or digits).';
  const bankName = clean(form.bankName);
  if (bankName !== '' && (bankName.length < 2 || bankName.length > 60)) errors.bankName = 'The bank name must be 2 to 60 characters.';
  return Object.keys(errors).length > 0 ? fail(errors) : { ok: true, value: { method: 'BANK', accountHolder: holder, accountNumber, ifsc, ...(bankName ? { bankName } : {}) } };
};

// ───────────────────────────── Settlement settings ─────────────────────────────

export const MAX_HOLD_DAYS = 30;

export interface SettlementSettingsInput { time: string; mode: 'MANUAL_PAYOUT' | 'AUTO_PAYOUT'; autoCreate: boolean; holdDays: number }

export const validateSettlementSettings = (form: { time: string; mode: string; autoCreate: boolean; holdDays: string }): Checked<SettlementSettingsInput> => {
  const errors: Record<string, string> = {};
  const time = form.time.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.time = 'Use HH:MM, 24 hour, India time, for example 22:00.';
  if (form.mode !== 'MANUAL_PAYOUT' && form.mode !== 'AUTO_PAYOUT') errors.mode = 'Choose how settlements are paid.';
  const hold = form.holdDays.trim();
  if (!/^\d{1,2}$/.test(hold) || Number(hold) > MAX_HOLD_DAYS) errors.holdDays = `Hold days must be a whole number from 0 to ${MAX_HOLD_DAYS}.`;
  if (Object.keys(errors).length > 0) return fail(errors);
  return { ok: true, value: { time, mode: form.mode as SettlementSettingsInput['mode'], autoCreate: form.autoCreate, holdDays: Number(hold) } };
};

// Re-exported so a form can default a "paid date" input to today without importing two modules.
export { addDays, istToday };
