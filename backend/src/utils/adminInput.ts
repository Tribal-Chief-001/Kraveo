import { Request } from 'express';
import { AppError } from './appError';
import { badLabel, collapse } from './labels';

/** Strict body checks shared by the admin account endpoints (Docs/27 B0: types, lengths, unknown keys). All throw AppError 400 BAD_REQUEST. */
export const badField = (field: string, message: string, code = 'BAD_REQUEST') => new AppError(400, code, message, field);

/** The JSON body as a plain object with ONLY the allowed keys (an unknown key is a 400, so typos never get silently ignored). */
export const strictBody = (req: Request, allowed: readonly string[]): Record<string, unknown> => {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw badField('body', 'The request body must be a JSON object.');
  const extra = Object.keys(b).find((k) => !allowed.includes(k));
  if (extra) throw badField(extra.slice(0, 40), `Unknown field '${extra.slice(0, 40)}'.`);
  return b as Record<string, unknown>;
};

/** Required text of min..max characters after trimming and collapsing white space, without hidden / control characters. */
export const textField = (v: unknown, field: string, min: number, max: number, what = field): string => {
  if (typeof v !== 'string' || badLabel(v)) throw badField(field, `${what} must be text of ${min} to ${max} characters.`);
  const t = collapse(v);
  if (t.length < min || t.length > max) throw badField(field, `${what} must be ${min} to ${max} characters.`);
  return t;
};

export const optionalText = (v: unknown, field: string, max: number): string | null => {
  if (v === undefined || v === null || v === '') return null;
  return textField(v, field, 1, max);
};

export const boolField = (v: unknown, field: string, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw badField(field, `${field} must be true or false.`);
  return v;
};

export const enumField = <T extends string>(v: unknown, field: string, allowed: readonly T[], fallback: T): T => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw badField(field, `${field} must be ${allowed.join(' or ')}.`);
  return v as T;
};

/** The typed-name confirmation of every REMOVE: equal to the target's current name ignoring case and spacing (CONFIRM_MISMATCH otherwise). */
export const checkConfirmName = (given: unknown, ...names: (string | null | undefined)[]): void => {
  if (typeof given !== 'string' || badLabel(given)) throw badField('confirmName', 'Type the name to confirm.', 'CONFIRM_MISMATCH');
  const g = collapse(given).toLowerCase();
  if (!g || !names.some((n) => !!n && collapse(n).toLowerCase() === g)) throw badField('confirmName', 'The name you typed does not match.', 'CONFIRM_MISMATCH');
};

export const id8 = (id: string) => id.slice(0, 8);
