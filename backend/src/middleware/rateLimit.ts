import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

/**
 * Tiny in-memory rate limiting (no dependency). Valid for the single-instance pilot; move to Redis before clustering.
 *
 *  - SlidingWindow: "at most N hits per window", per key.
 *  - FailureLimiter: "at most N FAILED attempts per window", per key (successes are not counted).
 *  - rateLimitMiddleware: the route rules below, mounted by path at the top of the API router, so the
 *    handlers themselves (payments included) do not change.
 *
 * Numbers can be overridden with env RL_<RULE>_MAX / RL_<RULE>_WINDOW_MS (read on every request, so tests can
 * set them at run time). Under NODE_ENV=test a rule is OFF unless its RL_<RULE>_MAX is set, so unrelated
 * suites that place dozens of orders as one user are not throttled.
 */

/** Client IP as seen through nginx (`app.set('trust proxy', 1)`): the right-most X-Forwarded-For entry. */
export const clientIp = (req: Request): string => req.ip || req.socket?.remoteAddress || 'unknown';

const sweepers = new Set<() => void>();
const sweepTimer = setInterval(() => sweepers.forEach((f) => f()), 60_000);
sweepTimer.unref();

export class SlidingWindow {
  private hits = new Map<string, { times: number[]; windowMs: number }>();
  constructor() { sweepers.add(() => this.sweep()); }

  /** Records a hit when allowed. When refused, tells the caller how long to wait. */
  hit(key: string, max: number, windowMs: number, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const entry = this.hits.get(key) ?? { times: [], windowMs };
    entry.windowMs = windowMs;
    entry.times = entry.times.filter((t) => now - t < windowMs);
    if (entry.times.length >= max) {
      this.hits.set(key, entry);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.times[0] + windowMs - now) / 1000)) };
    }
    entry.times.push(now);
    this.hits.set(key, entry);
    return { ok: true };
  }

  sweep(now = Date.now()) {
    for (const [k, v] of this.hits) if (!v.times.some((t) => now - t < v.windowMs)) this.hits.delete(k);
  }
  get size() { return this.hits.size; }
  delete(key: string) { this.hits.delete(key); }
  reset() { this.hits.clear(); }
}

export class FailureLimiter {
  private fails = new Map<string, number[]>();
  constructor(private opts: { maxFails: number; windowMs: number }) { sweepers.add(() => this.sweep()); }

  /** Seconds until this key may try again, or 0 when it is not blocked. */
  blockedFor(key: string, now = Date.now()): number {
    const times = (this.fails.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
    if (times.length < this.opts.maxFails) return 0;
    return Math.max(1, Math.ceil((times[times.length - this.opts.maxFails] + this.opts.windowMs - now) / 1000));
  }
  /** Records a failed attempt; returns the block time in seconds when this failure tripped the limit, else 0. */
  fail(key: string, now = Date.now()): number {
    const times = (this.fails.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
    times.push(now);
    this.fails.set(key, times);
    return this.blockedFor(key, now);
  }
  clear(key: string) { this.fails.delete(key); }
  sweep(now = Date.now()) {
    for (const [k, v] of this.fails) if (!v.some((t) => now - t < this.opts.windowMs)) this.fails.delete(k);
  }
  get size() { return this.fails.size; }
  reset() { this.fails.clear(); }
}

// ---------------------------------------------------------------------------------------------
// Route rules
// ---------------------------------------------------------------------------------------------
type Rule = {
  name: string;
  scope: 'user' | 'ip';
  max: number;
  windowMs: number;
  /** `p` is the NORMALISED path (see normalizedPath): lower case, no duplicate or trailing slashes. */
  applies: (req: Request, p: string) => boolean;
  message: string;
};

/**
 * Express routes are case-insensitive and ignore a trailing slash, so `/orders/`, `/ORDERS` and `/orders//` reach the
 * same handler as `/orders`. Every rule below therefore matches on this normalised form, never on `req.path` directly,
 * otherwise a client could skip a limit just by changing the spelling of the URL.
 */
export const normalizedPath = (rawPath: string): string => (rawPath || '/').toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

const MIN = 60_000;
const RULES: Rule[] = [
  { name: 'ORDER_CREATE', scope: 'user', max: 8, windowMs: 10 * MIN, applies: (r, p) => r.method === 'POST' && p === '/orders', message: 'You are placing orders too fast. Please wait a few minutes.' },
  // Docs/22: a combined order is placed (and priced) through its own endpoints; same budget as a single order, and a quote is a read-only price check.
  { name: 'ORDER_GROUP_CREATE', scope: 'user', max: 8, windowMs: 10 * MIN, applies: (r, p) => r.method === 'POST' && p === '/order-groups', message: 'You are placing orders too fast. Please wait a few minutes.' },
  { name: 'ORDER_QUOTE', scope: 'user', max: 60, windowMs: 10 * MIN, applies: (r, p) => r.method === 'POST' && p === '/orders/quote', message: 'Too many price checks. Please wait a minute.' },
  {
    name: 'ORDER_CANCEL', scope: 'user', max: 5, windowMs: 10 * MIN,
    applies: (r, p) => (r.method === 'POST' && /^\/orders\/[^/]+\/cancel$/.test(p)) || (r.method === 'PATCH' && /^\/orders\/[^/]+\/status$/.test(p) && r.body?.status === 'CANCELLED'),
    message: 'Too many cancellations. Please wait a few minutes.',
  },
  { name: 'PAYMENT_CREATE', scope: 'user', max: 10, windowMs: 10 * MIN, applies: (r, p) => r.method === 'POST' && p === '/payments/create-order', message: 'Too many payment attempts. Please wait a few minutes.' },
  // Push device registration happens at app start / token refresh / logout: generous, but a loop cannot hammer the database.
  { name: 'DEVICE_WRITE', scope: 'user', max: 30, windowMs: 10 * MIN, applies: (r, p) => (r.method === 'POST' || r.method === 'DELETE') && /^\/devices$/.test(p), message: 'Too many device updates. Please wait a few minutes.' },
  // A restaurant re-detecting its pin: a few tries (GPS retries, a correction) per hour, not a loop.
  { name: 'VENDOR_LOCATION', scope: 'user', max: 10, windowMs: 60 * MIN, applies: (r, p) => r.method === 'PUT' && /^\/partner\/vendor\/location$/.test(p), message: 'You changed the location too many times. Please try again in an hour.' },
  // Docs/21: admin catalog and settings writes, and restaurant dish submissions (each one lands in the admin's approval queue).
  // Generous for real work (bulk editing a menu), but a script or a stuck client loop cannot hammer the database or flood the queue.
  {
    name: 'ADMIN_CATALOG_WRITE', scope: 'user', max: 300, windowMs: 10 * MIN,
    applies: (r, p) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method) && ((/^\/admin\/catalog(\/|$)/.test(p) && p !== '/admin/catalog/preview' && p !== '/admin/catalog/recalculate') || /^\/admin\/vendors\/[^/]+\/commission$/.test(p)),
    message: 'Too many catalog changes. Please wait a few minutes.',
  },
  { name: 'ADMIN_RECALCULATE', scope: 'user', max: 20, windowMs: 10 * MIN, applies: (r, p) => r.method === 'POST' && p === '/admin/catalog/recalculate', message: 'Too many price recalculations. Please wait a few minutes.' },
  { name: 'ADMIN_SETTINGS_WRITE', scope: 'user', max: 30, windowMs: 10 * MIN, applies: (r, p) => r.method === 'PUT' && /^\/admin\/settings\/[^/]+$/.test(p), message: 'Too many settings changes. Please wait a few minutes.' },
  // Docs/21 phase 2: payout details, settlement actions and the rider ledger. Money endpoints: tight enough that a stuck loop or a
  // script cannot hammer them, loose enough for a real end-of-day session (many restaurants to mark paid).
  { name: 'PARTNER_PAYOUT_WRITE', scope: 'user', max: 10, windowMs: 10 * MIN, applies: (r, p) => r.method === 'PUT' && p === '/partner/payout-account', message: 'You changed the payout details too many times. Please wait a few minutes.' },
  { name: 'ADMIN_PAYOUT_WRITE', scope: 'user', max: 60, windowMs: 10 * MIN, applies: (r, p) => (r.method === 'PUT' || r.method === 'PATCH') && /^\/admin\/partners\/[^/]+\/payout-account(\/verify)?$/.test(p), message: 'Too many payout detail changes. Please wait a few minutes.' },
  { name: 'ADMIN_PAYOUT_REVEAL', scope: 'user', max: 20, windowMs: 10 * MIN, applies: (r, p) => r.method === 'POST' && /^\/admin\/partners\/[^/]+\/payout-account\/reveal$/.test(p), message: 'Too many account number reveals. Please wait a few minutes.' },
  { name: 'ADMIN_SETTLEMENT_RUN', scope: 'user', max: 10, windowMs: 10 * MIN, applies: (r, p) => r.method === 'POST' && p === '/admin/settlements/run', message: 'Too many settlement runs. Please wait a few minutes.' },
  {
    name: 'ADMIN_SETTLEMENT_WRITE', scope: 'user', max: 120, windowMs: 10 * MIN,
    applies: (r, p) => r.method === 'POST' && (/^\/admin\/settlements\/[^/]+\/(mark-paid|hold|release|adjustments|cancel)$/.test(p) || p === '/admin/rider-payouts'),
    message: 'Too many settlement changes. Please wait a few minutes.',
  },
  {
    name: 'VENDOR_CATALOG_WRITE', scope: 'user', max: 60, windowMs: 10 * MIN,
    applies: (r, p) => (r.method === 'POST' && /^\/vendors\/[^/]+\/items$/.test(p)) || (r.method === 'PATCH' && /^\/vendors\/items\/[^/]+$/.test(p) && r.body?.price !== undefined),
    message: 'You are changing the menu too fast. Please wait a few minutes.',
  },
  {
    name: 'AUTH_IP', scope: 'ip', max: 60, windowMs: MIN,
    applies: (r, p) => r.method === 'POST' && ['/auth/google', '/auth/partner-login', '/auth/admin-login', '/auth/partner-signup'].includes(p),
    message: 'Too many requests from this network. Please try again in a minute.',
  },
];

const envInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const limitsOf = (rule: Rule): { max: number; windowMs: number } | null => {
  const max = envInt(`RL_${rule.name}_MAX`) ?? (process.env.NODE_ENV === 'test' ? undefined : rule.max);
  if (max === undefined) return null;
  return { max, windowMs: envInt(`RL_${rule.name}_WINDOW_MS`) ?? rule.windowMs };
};

const windows = new SlidingWindow();
export const __resetRateLimits = () => windows.reset();
export const __rateLimitKeyCount = () => windows.size;

/** Who is calling, from the signature alone (no database): the handler's own requireAuth still decides about access. */
const userKey = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const secret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'test' ? 'kraveo_vit_bhopal_super_secret_jwt_key_2026' : '');
    const decoded = jwt.verify(header.split(' ')[1], secret) as { id?: unknown };
    return typeof decoded?.id === 'string' ? decoded.id : null;
  } catch {
    return null;
  }
};

export const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const p = normalizedPath(req.path);
  for (const rule of RULES) {
    if (!rule.applies(req, p)) continue;
    const limits = limitsOf(rule);
    if (!limits) continue;
    const who = rule.scope === 'user' ? userKey(req) : clientIp(req);
    if (!who) continue; // not authenticated: the handler answers 401 (cheap, nothing to protect)
    const r = windows.hit(`${rule.name}:${who}`, limits.max, limits.windowMs);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSeconds));
      return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: rule.message, retryAfterSeconds: r.retryAfterSeconds });
    }
  }
  return next();
};
