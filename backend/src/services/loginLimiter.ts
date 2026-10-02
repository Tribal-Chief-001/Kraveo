import { FailureLimiter } from '../middleware/rateLimit';

/**
 * Wrong-password lockout per key (phone). 5 wrong tries lock the key for 15 minutes.
 * In-memory: valid for the single-instance pilot; move to Postgres/Redis before clustering.
 */
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const state = new Map<string, { fails: number; lockedUntil: number; lastAt: number }>();

export const isLocked = (key: string, now = Date.now()): number => {
  const s = state.get(key);
  return s && s.lockedUntil > now ? Math.ceil((s.lockedUntil - now) / 1000) : 0;
};

export const recordFailure = (key: string, now = Date.now()): number => {
  const prev = state.get(key);
  const s = prev && (prev.lockedUntil === 0 || prev.lockedUntil <= now) ? prev : { fails: 0, lockedUntil: 0, lastAt: now };
  s.fails += 1;
  s.lastAt = now;
  if (s.fails >= MAX_FAILS) {
    s.fails = 0;
    s.lockedUntil = now + LOCK_MS;
  }
  state.set(key, s);
  return s.lockedUntil > now ? Math.ceil(LOCK_MS / 1000) : 0;
};

export const recordSuccess = (key: string) => state.delete(key);

// A whole network trying many different phone numbers is not stopped by the per-phone lock:
// per client IP, 30 wrong partner logins in 15 minutes block that IP only (successes do not reset it).
const ipFailures = new FailureLimiter({ maxFails: 30, windowMs: LOCK_MS });
export const ipLockedFor = (ip: string) => ipFailures.blockedFor(ip);
export const recordIpFailure = (ip: string) => ipFailures.fail(ip);

export const __resetLoginLimiter = () => { state.clear(); ipFailures.reset(); };
export const __loginLimiterSize = () => state.size;

/** Drops locks that ended AND idle counters (a few typos long ago) so the map cannot grow forever. */
export const sweepLoginLimiter = (now = Date.now()) => {
  for (const [k, v] of state) {
    const idle = v.lockedUntil === 0 && now - v.lastAt > LOCK_MS;
    const lockOver = v.lockedUntil !== 0 && v.lockedUntil <= now;
    if (idle || lockOver) state.delete(k);
  }
};
setInterval(() => sweepLoginLimiter(), 60_000).unref();
