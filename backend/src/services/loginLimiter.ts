/**
 * Wrong-password lockout per key (phone). 5 wrong tries lock the key for 15 minutes.
 * In-memory: valid for the single-instance pilot; move to Postgres/Redis before clustering.
 */
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const state = new Map<string, { fails: number; lockedUntil: number }>();

export const isLocked = (key: string, now = Date.now()): number => {
  const s = state.get(key);
  return s && s.lockedUntil > now ? Math.ceil((s.lockedUntil - now) / 1000) : 0;
};

export const recordFailure = (key: string, now = Date.now()): number => {
  const s = state.get(key) && (state.get(key)!.lockedUntil === 0 || state.get(key)!.lockedUntil <= now) ? state.get(key)! : { fails: 0, lockedUntil: 0 };
  s.fails += 1;
  if (s.fails >= MAX_FAILS) {
    s.fails = 0;
    s.lockedUntil = now + LOCK_MS;
  }
  state.set(key, s);
  return s.lockedUntil > now ? Math.ceil(LOCK_MS / 1000) : 0;
};

export const recordSuccess = (key: string) => state.delete(key);
export const __resetLoginLimiter = () => state.clear();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of state) if (v.lockedUntil !== 0 && v.lockedUntil <= now) state.delete(k);
}, 60_000).unref();
