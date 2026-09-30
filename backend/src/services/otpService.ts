import { randomInt } from 'crypto';

/**
 * Phone-OTP state for customer / partner login.
 *
 * Deliberately in-memory: the API runs as a single PM2 instance for the pilot. Lockout counters are kept
 * apart from the OTP record so that requesting a new code can NOT reset the wrong-guess counter
 * (the old code reset it on every send, which made a 4-digit code brute-forceable).
 * If the API ever runs in cluster mode this must move to Postgres/Redis.
 */
export const OTP_TTL_MS = 5 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 30 * 1000;
export const MAX_SENDS_PER_PHONE_PER_HOUR = 5;
export const MAX_WRONG_GUESSES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface OtpRecord { otp: string; expiresAt: number; attempts: number }

/** Keyed by canonical phone (`+91 XXXXXXXXXX`). Exported for tests. */
export const otpStore = new Map<string, OtpRecord>();
const sendLog = new Map<string, number[]>();
const failState = new Map<string, { fails: number; lockedUntil: number }>();
let globalSendLog: number[] = [];

const strictLimits = () => process.env.NODE_ENV !== 'test' || process.env.OTP_STRICT_LIMITS === 'true';
const globalHourlyCap = () => Number(process.env.OTP_GLOBAL_HOURLY_CAP || 400);

/** `+91 98765 43210`, `09876543210`, `9876543210` -> `+91 9876543210`; null when not a valid Indian mobile. */
export const canonicalPhone = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (digits.length < 10 || digits.length > 13 || !/^[6-9]\d{9}$/.test(last10)) return null;
  return `+91 ${last10}`;
};

export const last10 = (canonical: string) => canonical.replace(/\D/g, '').slice(-10);
export const maskPhone = (canonical: string) => `+91 ${last10(canonical).slice(0, 2)}••••••${last10(canonical).slice(-2)}`;

export const secureOtp = () => randomInt(1000, 10000).toString();

/** Demo login: only when DEMO_MODE=true AND the number is on DEMO_LOGIN_PHONES. Never affects other numbers. */
export const isDemoLogin = (canonical: string): boolean => {
  if (process.env.DEMO_MODE !== 'true') return false;
  const list = (process.env.DEMO_LOGIN_PHONES || '').split(',').map((p) => canonicalPhone(p.trim())).filter(Boolean);
  return list.includes(canonical);
};
export const demoOtp = (): string => {
  const code = String(process.env.DEMO_LOGIN_OTP || '1234').trim();
  return /^\d{4}$/.test(code) ? code : '1234';
};

export type SendGate = { ok: true } | { ok: false; status: 429 | 503; message: string; retryAfterSeconds?: number };

export const checkCanSend = (phone: string, now = Date.now()): SendGate => {
  if (!strictLimits()) return { ok: true };

  const lock = failState.get(phone);
  if (lock && lock.lockedUntil > now) {
    const retry = Math.ceil((lock.lockedUntil - now) / 1000);
    return { ok: false, status: 429, message: 'Too many wrong codes. Please try again later.', retryAfterSeconds: retry };
  }

  const recent = (sendLog.get(phone) || []).filter((t) => now - t < HOUR_MS);
  const last = recent[recent.length - 1];
  if (last && now - last < RESEND_COOLDOWN_MS) {
    const retry = Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000);
    return { ok: false, status: 429, message: `Please wait ${retry}s before requesting another code.`, retryAfterSeconds: retry };
  }
  if (recent.length >= MAX_SENDS_PER_PHONE_PER_HOUR) {
    const retry = Math.ceil((HOUR_MS - (now - recent[0])) / 1000);
    return { ok: false, status: 429, message: 'Too many codes requested for this number. Try again later.', retryAfterSeconds: retry };
  }

  globalSendLog = globalSendLog.filter((t) => now - t < HOUR_MS);
  if (globalSendLog.length >= globalHourlyCap()) {
    return { ok: false, status: 503, message: 'Login is very busy right now. Please try again in a few minutes.', retryAfterSeconds: 300 };
  }
  return { ok: true };
};

/** Stores a fresh code. Pass `fixedCode` for demo numbers. Records the send for rate limiting. */
export const issueOtp = (phone: string, fixedCode?: string, now = Date.now()): string => {
  const otp = fixedCode ?? secureOtp();
  // attempts intentionally NOT tied to failState: a resend never wipes the wrong-guess counter.
  otpStore.set(phone, { otp, expiresAt: now + OTP_TTL_MS, attempts: 0 });
  const recent = (sendLog.get(phone) || []).filter((t) => now - t < HOUR_MS);
  recent.push(now);
  sendLog.set(phone, recent);
  globalSendLog.push(now);
  return otp;
};

/** SMS provider failed: forget the code and give the send back so the student is not penalised. */
export const discardOtp = (phone: string) => {
  otpStore.delete(phone);
  const log = sendLog.get(phone);
  if (log?.length) log.pop();
  globalSendLog.pop();
};

export type VerifyGate =
  | { ok: true }
  | { ok: false; status: 400 | 429; message: string; attemptsLeft?: number; retryAfterSeconds?: number };

export const checkOtp = (phone: string, code: string, now = Date.now()): VerifyGate => {
  const lock = failState.get(phone);
  if (lock && lock.lockedUntil > now) {
    return { ok: false, status: 429, message: 'Too many wrong codes. Please try again later.', retryAfterSeconds: Math.ceil((lock.lockedUntil - now) / 1000) };
  }

  const record = otpStore.get(phone);
  if (!record || now >= record.expiresAt) {
    otpStore.delete(phone);
    return { ok: false, status: 400, message: 'That code has expired. Request a new one.' };
  }

  if (record.otp !== String(code).trim()) {
    const state = failState.get(phone) && (failState.get(phone)!.lockedUntil === 0 || failState.get(phone)!.lockedUntil <= now) ? failState.get(phone)! : { fails: 0, lockedUntil: 0 };
    state.fails += 1;
    record.attempts = state.fails;
    if (state.fails >= MAX_WRONG_GUESSES) {
      state.lockedUntil = now + LOCKOUT_MS;
      state.fails = 0;
      otpStore.delete(phone);
      failState.set(phone, state);
      return { ok: false, status: 429, message: 'Too many wrong codes. Please try again in 15 minutes.', retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000) };
    }
    failState.set(phone, state);
    const attemptsLeft = MAX_WRONG_GUESSES - state.fails;
    return { ok: false, status: 400, message: `Wrong code. ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.`, attemptsLeft };
  }

  otpStore.delete(phone);
  failState.delete(phone);
  return { ok: true };
};

/** Test helper: wipe all counters. */
export const __resetOtpState = () => {
  otpStore.clear();
  sendLog.clear();
  failState.clear();
  globalSendLog = [];
};

// Purge expired codes and stale counters so the maps cannot grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of otpStore) if (now >= value.expiresAt) otpStore.delete(key);
  for (const [key, value] of failState) if (value.lockedUntil !== 0 && value.lockedUntil <= now && !otpStore.has(key)) failState.delete(key);
  for (const [key, log] of sendLog) if (!log.some((t) => now - t < HOUR_MS)) sendLog.delete(key);
}, 60_000).unref();
