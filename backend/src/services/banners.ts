import { isIP } from 'net';
import { randomUUID } from 'crypto';
import { HomeBanner, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { ID_RE } from '../utils/http';
import { errSummary } from '../utils/log';
import { writeAudit } from './audit';
import { BAD_SCRIPT_LABEL_CHARS, collapse } from '../utils/labels';

/**
 * Home banners (Docs/25 sections 1-2): the admin-managed promo slideshow on the customer Home.
 *
 * LOCKING: every writer that adds, removes or renumbers rows (create, duplicate, delete, reorder) first takes ONE transaction-level advisory
 * lock (BANNER_LOCK), so the 30-row cap and the 10,20,30 numbering are exact under parallel calls. An edit (PATCH) takes only the row lock
 * (SELECT ... FOR UPDATE) and never the advisory lock, and delete / reorder take the advisory lock BEFORE any row lock, so two writers can never
 * deadlock. The counters (views / clicks) are plain atomic `UPDATE ... SET x = x + 1` statements and take no lock besides the row's own.
 */
type Tx = Prisma.TransactionClient;
export type Actor = { id: string; role: string };

export const MAX_BANNERS = 30;
export const MAX_LIVE_BANNERS = 10;
export const MAX_VIEWS_PER_EVENT = 10;
export const MAX_CLICKS_PER_EVENT = 5;
export const THEMES = ['DARK', 'LIGHT'] as const;
export const SORT_STEP = 10;
const TX_OPTS = { maxWait: 10_000, timeout: 20_000 };
const MAX_URL_LEN = 500;
const INT_MAX = 2_147_483_647;

const bad = (field: string, message: string, code = 'BAD_REQUEST') => new AppError(400, code, message, field);

// ---------------------------------------------------------------------------------------------------------------------
// Clock (injectable: tests move time without waiting)
// ---------------------------------------------------------------------------------------------------------------------
let clock: () => Date = () => new Date();
export const __setBannerClock = (fn: (() => Date) | null) => { clock = fn ?? (() => new Date()); };

// ---------------------------------------------------------------------------------------------------------------------
// Public list cache. Holds the ACTIVE rows of the HOME placement (<= 30); the schedule window is applied on every request with the
// clock, so a banner starts and ends exactly on time even while the cache is warm. Dropped by every banner write. A read that started
// before a write finished never stores its (stale) result: `generation` changed meanwhile.
// Off under NODE_ENV=test unless BANNERS_CACHE_TTL_MS is set, like the categories cache.
// ---------------------------------------------------------------------------------------------------------------------
let cache: { at: number; rows: HomeBanner[] } | null = null;
let generation = 0;
let idsCache: { at: number; ids: Set<string> } | null = null;
export const invalidatePublicBanners = () => { cache = null; idsCache = null; generation += 1; };
const cacheTtlMs = (): number => {
  const raw = process.env.BANNERS_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') { const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : 0; }
  return process.env.NODE_ENV === 'test' ? 0 : 30_000;
};

// ---------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------
const cpLen = (s: string) => Array.from(s).length;

/**
 * Banner text (title, subtitle, button text): NFC, collapsed white space, Hindi and emoji allowed (these are NOT ASCII-only like category
 * names). Rejected: control, bidi and zero-width characters (ZWNJ / ZWJ stay allowed because Devanagari and emoji sequences need them) and
 * `<` / `>` (so no markup can ever be stored, whatever renders it later). Length counts code points, an emoji is one.
 */
export const checkBannerText = (raw: unknown, field: string, min: number, max: number, label: string): string => {
  if (typeof raw !== 'string') throw bad(field, `${label} must be text.`);
  if (raw.length > max * 8) throw bad(field, `${label} can be at most ${max} characters.`); // checked before any normalisation work
  if (BAD_SCRIPT_LABEL_CHARS.test(raw.normalize('NFC'))) throw bad(field, `${label} cannot contain control, hidden or direction-changing characters.`);
  const v = collapse(raw);
  if (/[<>]/.test(v)) throw bad(field, `${label} cannot contain the characters < or >.`);
  const n = cpLen(v);
  if (n < min || n > max) throw bad(field, min > 0 ? `${label} must be ${min} to ${max} characters.` : `${label} can be at most ${max} characters.`);
  return v;
};
const optionalText = (raw: unknown, field: string, max: number, label: string): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && collapse(raw) === '' && !BAD_SCRIPT_LABEL_CHARS.test(raw.normalize('NFC'))) return null;
  return checkBannerText(raw, field, 1, max, label);
};

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * https-only link / image address. The RAW text is checked first (new URL() silently drops tabs and newlines and accepts "https:host"
 * and backslashes), then the parsed result. Returns the normalised form (`new URL().toString()`). Rules: scheme exactly https written as
 * "https://", a real DNS host with a dot (no IP literal in any spelling, no localhost, no port, no credentials), no whitespace / control /
 * hidden / backslash characters, <= 500 characters before and after normalisation.
 */
export const checkHttpsUrl = (raw: unknown, field: string, code: string, label: string): string => {
  const fail = (why: string) => bad(field, `${label} ${why}`, code);
  if (typeof raw !== 'string') throw fail('must be a web address starting with https://');
  if (raw.length > MAX_URL_LEN + 64) throw fail(`can be at most ${MAX_URL_LEN} characters.`);
  const text = raw.trim();
  if (text === '') throw fail('must be a web address starting with https://');
  if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\\]/.test(text)) throw fail('cannot contain spaces, hidden characters or backslashes.');
  if (!/^https:\/\//i.test(text)) throw fail('must start with https:// (http, javascript:, data:, intent:, market:, mailto:, tel:, file: and app links are not allowed).');
  let u: URL;
  try { u = new URL(text); } catch { throw fail('is not a valid web address.'); }
  if (u.protocol !== 'https:') throw fail('must start with https://');
  if (u.username || u.password) throw fail('cannot contain a user name or password.');
  if (u.port) throw fail('cannot use a custom port.');
  const host = u.hostname.replace(/\.$/, '');
  if (isIP(host) || host.startsWith('[') || /^[0-9.]+$/.test(host)) throw fail('must use a website name, not an IP address.');
  if (host === 'localhost' || host.endsWith('.localhost') || !HOST_RE.test(host) || host.length > 253) throw fail('must use a real website name, like example.com.');
  const out = u.toString();
  if (out.length > MAX_URL_LEN) throw fail(`can be at most ${MAX_URL_LEN} characters.`);
  return out;
};
/** Optional comma separated host allow-list from the environment, read on every call (empty / unset = any host). */
const hostList = (envName: string): string[] =>
  (process.env[envName] ?? '').split(',').map((h) => h.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
/** Exact host or any subdomain of a listed host. Only used when the env list is set. */
const checkHostAllowed = (url: string, envName: string, field: string, code: string, label: string) => {
  const allowed = hostList(envName);
  if (allowed.length === 0) return;
  const host = new URL(url).hostname.replace(/\.$/, '');
  if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) throw bad(field, `${label} must be on one of these sites: ${allowed.join(', ')}.`, code);
};
const LINK_HOSTS = 'BANNER_LINK_HOSTS';
const IMAGE_HOSTS = 'BANNER_IMAGE_HOSTS';
const checkLinkHost = (url: string | null) => { if (url) checkHostAllowed(url, LINK_HOSTS, 'linkUrl', 'BANNER_LINK_INVALID', 'The link'); };
const checkImageHost = (url: string) => checkHostAllowed(url, IMAGE_HOSTS, 'imageUrl', 'BANNER_IMAGE_INVALID', 'The image address');

const checkLink = (raw: unknown): string | null => {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
  return checkHttpsUrl(raw, 'linkUrl', 'BANNER_LINK_INVALID', 'The link');
};
const checkImage = (raw: unknown): string => checkHttpsUrl(raw, 'imageUrl', 'BANNER_IMAGE_INVALID', 'The image address');

const checkTheme = (raw: unknown): string => {
  if (typeof raw !== 'string' || !(THEMES as readonly string[]).includes(raw)) throw bad('theme', `theme must be ${THEMES.join(' or ')}.`);
  return raw;
};
const checkBool = (raw: unknown, field: string): boolean => {
  if (typeof raw !== 'boolean') throw bad(field, `${field} must be true or false.`);
  return raw;
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** An ISO 8601 date-time WITH a zone ("2026-11-01T18:30:00.000Z" or "+05:30"), year 2000..2100. null clears. */
const checkInstant = (raw: unknown, field: string): Date | null => {
  if (raw === null) return null;
  if (typeof raw !== 'string' || !ISO_RE.test(raw)) throw bad(field, `${field} must be a date and time like 2026-11-01T18:30:00.000Z, or null.`, 'BANNER_SCHEDULE_INVALID');
  const [, y, mo, da, hh, mi, ss] = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/)!.map(Number);
  // Date.parse rolls "February 30" over to March 2: refuse impossible calendar values instead of guessing.
  if (mo < 1 || mo > 12 || da < 1 || da > new Date(Date.UTC(y, mo, 0)).getUTCDate() || hh > 23 || mi > 59 || (ss ?? 0) > 59) throw bad(field, `${field} is not a valid date and time.`, 'BANNER_SCHEDULE_INVALID');
  const t = Date.parse(raw);
  const d = new Date(t);
  if (Number.isNaN(t) || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) throw bad(field, `${field} is not a valid date and time.`, 'BANNER_SCHEDULE_INVALID');
  return d;
};

const sameInstant = (a: Date | null, b: Date | null) => (a ? a.getTime() : null) === (b ? b.getTime() : null);

/**
 * Schedule rules on the RESULTING row. endsAt must be after startsAt. An ACTIVE banner whose endsAt is already past is refused, but only when
 * this request turns it on or sets that endsAt (`touched`): editing the title of a banner that simply expired while still switched on is fine.
 */
const checkSchedule = (startsAt: Date | null, endsAt: Date | null, isActive: boolean, touched: boolean) => {
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) throw bad('endsAt', 'The end must be after the start.', 'BANNER_SCHEDULE_INVALID');
  if (touched && isActive && endsAt && endsAt.getTime() <= clock().getTime()) {
    throw bad('endsAt', 'This end time has already passed. Choose a later end time (or clear it), or keep the banner switched off.', 'BANNER_SCHEDULE_INVALID');
  }
};

const rejectUnknownKeys = (b: Record<string, unknown>, allowed: string[]) => {
  const unknown = Object.keys(b).find((k) => !allowed.includes(k));
  if (unknown) throw bad(unknown.slice(0, 40), `Unknown field '${unknown.slice(0, 40)}'. You can send: ${allowed.join(', ')}.`);
};
const CREATE_KEYS = ['title', 'subtitle', 'imageUrl', 'linkUrl', 'ctaLabel', 'theme', 'placement', 'isActive', 'startsAt', 'endsAt'];
const checkPlacement = (raw: unknown) => { if (raw !== 'HOME') throw bad('placement', "placement must be 'HOME'."); };

// ---------------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------------
export type BannerStatus = 'LIVE' | 'SCHEDULED' | 'EXPIRED' | 'OFF';

/** What every customer app may see: nothing but what the card shows. */
export const publicBannerView = (b: HomeBanner) => ({
  id: b.id, title: b.title, subtitle: b.subtitle, imageUrl: b.imageUrl, linkUrl: b.linkUrl, ctaLabel: b.ctaLabel, theme: b.theme,
});

export const isLive = (b: Pick<HomeBanner, 'isActive' | 'placement' | 'startsAt' | 'endsAt'>, now: Date): boolean =>
  b.isActive && b.placement === 'HOME' && (!b.startsAt || b.startsAt.getTime() <= now.getTime()) && (!b.endsAt || b.endsAt.getTime() > now.getTime());

export const statusOf = (b: Pick<HomeBanner, 'isActive' | 'startsAt' | 'endsAt'>, now: Date): BannerStatus => {
  if (!b.isActive) return 'OFF';
  if (b.endsAt && b.endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (b.startsAt && b.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  return 'LIVE';
};
/** Click-through rate in percent with one decimal (12.5 = 12.5 %), null while there are no views. */
export const ctrOf = (views: number, clicks: number): number | null => (views > 0 ? Math.round((clicks / views) * 1000) / 10 : null);

export const adminBannerView = (b: HomeBanner, now: Date, rank: number | null = null) => ({
  id: b.id,
  title: b.title,
  subtitle: b.subtitle,
  imageUrl: b.imageUrl,
  linkUrl: b.linkUrl,
  ctaLabel: b.ctaLabel,
  theme: b.theme,
  placement: b.placement,
  isActive: b.isActive,
  startsAt: b.startsAt ? b.startsAt.toISOString() : null,
  endsAt: b.endsAt ? b.endsAt.toISOString() : null,
  sortOrder: b.sortOrder,
  viewCount: b.viewCount,
  clickCount: b.clickCount,
  ctr: ctrOf(b.viewCount, b.clickCount),
  status: statusOf(b, now),
  /** Position among the LIVE banners (1 = first card), null when not live. The app shows only the first 10. */
  rank,
  shown: rank !== null && rank <= MAX_LIVE_BANNERS,
  createdByUserId: b.createdByUserId,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
});

const ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const;

// ---------------------------------------------------------------------------------------------------------------------
// Public reads and events
// ---------------------------------------------------------------------------------------------------------------------
/** BANNERS_ENABLED=false (also 0 / no / off) hides the whole slideshow at once. Read on every request; the cache keeps rows, so no restart or wait is needed. */
export const bannersEnabled = (): boolean => !['false', '0', 'no', 'off'].includes((process.env.BANNERS_ENABLED ?? '').trim().toLowerCase());

export const listPublicBanners = async () => {
  if (!bannersEnabled()) return [];
  const ttl = cacheTtlMs();
  let rows: HomeBanner[];
  if (ttl > 0 && cache && Date.now() - cache.at < ttl) rows = cache.rows;
  else {
    const gen = generation;
    rows = await prisma.homeBanner.findMany({ where: { placement: 'HOME', isActive: true }, orderBy: [...ORDER], take: MAX_BANNERS });
    if (ttl > 0 && gen === generation) cache = { at: Date.now(), rows };
  }
  const now = clock();
  return rows.filter((b) => isLive(b, now)).slice(0, MAX_LIVE_BANNERS).map(publicBannerView);
};

// ---------------------------------------------------------------------------------------------------------------------
// Events: counted in memory, written every few seconds
// ---------------------------------------------------------------------------------------------------------------------
/**
 * POST /banners/events never touches the database in the request path and never locks a row: the increments are added to `pending`
 * (bounded: only ids of switched-on banners are accepted, so at most 30 entries, each capped per flush interval) and `flushBannerEvents()`
 * writes them every BANNER_EVENTS_FLUSH_MS (5 s), on shutdown and in tests. One UPDATE per banner, rows in ascending id order (no deadlocks).
 * The counters are therefore APPROXIMATE: they lag by up to ~5 s, and a hard crash loses at most one interval of counts.
 * A failed write puts its counts back and retries at the next interval; it never throws and never crashes the process.
 */
export const MAX_PENDING_VIEWS = 2000;
export const MAX_PENDING_CLICKS = 500;
const pending = new Map<string, { v: number; c: number }>();
let flushTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

const flushIntervalMs = (): number => {
  const n = Number(process.env.BANNER_EVENTS_FLUSH_MS);
  return Number.isFinite(n) && n >= 50 ? n : 5000;
};

const idList = (raw: unknown, max: number): string[] => {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw.slice(0, max * 4)) {
    if (typeof v === 'string' && ID_RE.test(v)) out.add(v);
    if (out.size >= max) break;
  }
  return [...out];
};

/**
 * Ids of switched-on banners. Served from memory (30 s, dropped by every banner write); a stale set is used while a refresh runs in the
 * background, so only the very first call after a start / write (or every call when the cache is off, as under tests) waits for the database.
 */
let idsRefresh: Promise<Set<string>> | null = null;
const refreshIds = (): Promise<Set<string>> => {
  if (!idsRefresh) {
    const gen = generation;
    idsRefresh = prisma.homeBanner.findMany({ where: { isActive: true }, select: { id: true }, take: MAX_BANNERS * 2 })
      .then((rows) => {
        const ids = new Set(rows.map((r) => r.id));
        if (gen === generation) idsCache = { at: Date.now(), ids };
        return ids;
      })
      .finally(() => { idsRefresh = null; });
  }
  return idsRefresh;
};
const knownIds = async (): Promise<Set<string>> => {
  const ttl = cacheTtlMs();
  if (ttl > 0 && idsCache) {
    if (Date.now() - idsCache.at >= ttl) refreshIds().catch(() => undefined);
    return idsCache.ids;
  }
  return refreshIds();
};

const bump = (id: string, field: 'v' | 'c', by: number, cap: number) => {
  const e = pending.get(id) ?? { v: 0, c: 0 };
  e[field] = Math.min(cap, e[field] + by);
  pending.set(id, e);
};

export const recordBannerEvents = async (body: unknown): Promise<void> => {
  try {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const views = idList(b.views, MAX_VIEWS_PER_EVENT);
    const clicks = idList(b.clicks, MAX_CLICKS_PER_EVENT);
    if (views.length === 0 && clicks.length === 0) return;
    const known = await knownIds();
    for (const id of views) if (known.has(id)) bump(id, 'v', 1, MAX_PENDING_VIEWS);
    for (const id of clicks) if (known.has(id)) bump(id, 'c', 1, MAX_PENDING_CLICKS);
    if (!flushTimer && pending.size > 0) {
      flushTimer = setInterval(() => { void flushBannerEvents(); }, flushIntervalMs());
      flushTimer.unref();
    }
  } catch (e) {
    console.error('banner events failed:', errSummary(e));
  }
};

/** Writes everything counted so far. Never throws. Calls overlap safely (a second call waits for the running one, then writes what arrived meanwhile). */
export const flushBannerEvents = async (): Promise<void> => {
  while (flushing) await flushing;
  if (pending.size === 0) return;
  const run = (async () => {
    const batch = [...pending.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    pending.clear();
    let i = 0;
    try {
      for (; i < batch.length; i += 1) {
        const [id, { v, c }] = batch[i];
        await prisma.$executeRaw`
          UPDATE "HomeBanner" SET "viewCount" = LEAST("viewCount" + ${v}, ${INT_MAX}), "clickCount" = LEAST("clickCount" + ${c}, ${INT_MAX})
          WHERE "id" = ${id} AND "isActive" = true`;
      }
    } catch (e) {
      console.error('banner events flush failed (will retry):', errSummary(e));
      // Put back everything not written yet (the failed row included), bounded to ten intervals' worth.
      for (const [id, { v, c }] of batch.slice(i)) {
        const e2 = pending.get(id) ?? { v: 0, c: 0 };
        pending.set(id, { v: Math.min(MAX_PENDING_VIEWS * 10, e2.v + v), c: Math.min(MAX_PENDING_CLICKS * 10, e2.c + c) });
      }
    }
  })();
  flushing = run.finally(() => { flushing = null; });
  await flushing;
};

/** Stops the timer and writes the last counts. Called by the SIGTERM / SIGINT handler (installBannerShutdownFlush) and by tests. */
export const shutdownBannerEvents = async (): Promise<void> => {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  await flushBannerEvents();
};

/** src/index.ts only: on SIGTERM / SIGINT (PM2 restart) write the pending counts, then exit (at most 3 s later whatever happens). */
export const installBannerShutdownFlush = () => {
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => process.exit(0), 3000).unref();
      shutdownBannerEvents().finally(() => process.exit(0));
    });
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------------------------------
const lockOrder = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('kraveo-home-banner-order'))`;
const lockRow = async (tx: Tx, id: string): Promise<boolean> =>
  (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "HomeBanner" WHERE "id" = ${id} FOR UPDATE`).length > 0;

/** Every banner as an admin row, with `rank` among the live ones (same order and filter as the public list). */
export const listAdminBanners = async () => {
  const now = clock();
  const rows = await prisma.homeBanner.findMany({ orderBy: [...ORDER], take: MAX_BANNERS * 2 });
  let rank = 0;
  return rows.map((b) => adminBannerView(b, now, isLive(b, now) ? (rank += 1) : null));
};
/** One banner as an admin row (create / patch / duplicate answers), ranked against the others. */
const adminRowOf = async (b: HomeBanner) => (await listAdminBanners()).find((r) => r.id === b.id) ?? adminBannerView(b, clock());

/**
 * Audit text: WHO first, then the addresses (what an investigation of a stolen session needs), prose last, because writeAudit cuts at 300
 * characters. Every address is shown up to 120 characters; when several do not fit together the long ones share what is left.
 */
const urlsFit = (values: (string | null)[], budget: number): string[] => {
  const items = values.map((v) => v ?? 'none');
  const lim = items.map(() => 0);
  let left = Math.max(0, budget);
  let open = items.map((_, i) => i);
  while (open.length) {
    const share = Math.min(120, Math.floor(left / open.length));
    const fits = open.filter((i) => items[i].length <= share);
    if (fits.length === 0) { open.forEach((i) => { lim[i] = share; }); break; }
    fits.forEach((i) => { lim[i] = items[i].length; left -= items[i].length; });
    open = open.filter((i) => !fits.includes(i));
  }
  return items.map((v, i) => (v.length <= lim[i] ? v : `${v.slice(0, Math.max(1, lim[i] - 3))}...`));
};
const auditText = (head: string, urls: [string, string | null][], tail: string): string => {
  const overhead = head.length + urls.reduce((n, [label]) => n + label.length + 4, 0);
  const fitted = urlsFit(urls.map(([, v]) => v), 300 - overhead - 30);
  return `${head}${urls.map(([label], i) => ` | ${label} ${fitted[i]}`).join('')} | ${tail}`;
};
const q = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s);

export const createBanner = async (b: Record<string, unknown>, actor: Actor) => {
  rejectUnknownKeys(b, CREATE_KEYS);
  const title = checkBannerText(b.title, 'title', 2, 60, 'The title');
  const subtitle = optionalText(b.subtitle, 'subtitle', 120, 'The subtitle');
  const imageUrl = checkImage(b.imageUrl);
  const linkUrl = checkLink(b.linkUrl);
  checkLinkHost(linkUrl);
  checkImageHost(imageUrl);
  const ctaLabel = optionalText(b.ctaLabel, 'ctaLabel', 20, 'The button text');
  const theme = b.theme === undefined ? 'DARK' : checkTheme(b.theme);
  if (b.placement !== undefined) checkPlacement(b.placement);
  const isActive = b.isActive === undefined ? true : checkBool(b.isActive, 'isActive');
  const startsAt = b.startsAt === undefined ? null : checkInstant(b.startsAt, 'startsAt');
  const endsAt = b.endsAt === undefined ? null : checkInstant(b.endsAt, 'endsAt');
  checkSchedule(startsAt, endsAt, isActive, true);

  const created = await prisma.$transaction(async (tx) => {
    await lockOrder(tx);
    if ((await tx.homeBanner.count()) >= MAX_BANNERS) throw new AppError(409, 'BANNER_LIMIT', `There are already ${MAX_BANNERS} banners. Delete one you no longer need first.`);
    const max = (await tx.homeBanner.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0;
    return tx.homeBanner.create({
      data: { id: randomUUID(), title, subtitle, imageUrl, linkUrl, ctaLabel, theme, isActive, startsAt, endsAt, sortOrder: max + SORT_STEP, createdByUserId: actor.id },
    });
  }, TX_OPTS);
  invalidatePublicBanners();
  await writeAudit('BANNER_CREATED', 'BANNER', created.id, auditText(`admin ${actor.id} created banner`, [['link', linkUrl], ['image', imageUrl]], `${q(title)} (${isActive ? 'on' : 'off'}, ${theme}${startsAt || endsAt ? ', scheduled' : ''})`));
  return adminRowOf(created);
};

type Plan = Partial<Pick<HomeBanner, 'title' | 'subtitle' | 'imageUrl' | 'linkUrl' | 'ctaLabel' | 'theme' | 'isActive' | 'startsAt' | 'endsAt'>>;

export const patchBanner = async (id: string, b: Record<string, unknown>, actor: Actor) => {
  rejectUnknownKeys(b, CREATE_KEYS);
  if (Object.keys(b).length === 0) throw bad('body', `Send at least one of: ${CREATE_KEYS.join(', ')}.`);
  const want: Plan = {};
  if (b.title !== undefined) want.title = checkBannerText(b.title, 'title', 2, 60, 'The title');
  if (b.subtitle !== undefined) want.subtitle = optionalText(b.subtitle, 'subtitle', 120, 'The subtitle');
  if (b.imageUrl !== undefined) want.imageUrl = checkImage(b.imageUrl);
  if (b.linkUrl !== undefined) want.linkUrl = checkLink(b.linkUrl);
  if (b.ctaLabel !== undefined) want.ctaLabel = optionalText(b.ctaLabel, 'ctaLabel', 20, 'The button text');
  if (b.theme !== undefined) want.theme = checkTheme(b.theme);
  if (b.placement !== undefined) checkPlacement(b.placement);
  if (b.isActive !== undefined) want.isActive = checkBool(b.isActive, 'isActive');
  if (b.startsAt !== undefined) want.startsAt = checkInstant(b.startsAt, 'startsAt');
  if (b.endsAt !== undefined) want.endsAt = checkInstant(b.endsAt, 'endsAt');

  const out = await prisma.$transaction(async (tx) => {
    if (!(await lockRow(tx, id))) throw new AppError(404, 'NOT_FOUND', 'Banner not found (it may have been deleted).');
    const before = await tx.homeBanner.findUniqueOrThrow({ where: { id } });
    const diff: Plan = {};
    for (const [k, v] of Object.entries(want) as [keyof Plan, unknown][]) {
      const old = before[k];
      const same = v instanceof Date || old instanceof Date ? sameInstant(v instanceof Date ? v : null, old instanceof Date ? old : null) : v === old;
      if (!same) (diff as Record<string, unknown>)[k] = v;
    }
    // Allow-lists apply to values this request CHANGES: a stored link on a host that was allowed earlier never blocks an unrelated edit.
    if (diff.linkUrl !== undefined) checkLinkHost(diff.linkUrl);
    if (diff.imageUrl !== undefined) checkImageHost(diff.imageUrl);
    const startsAt = diff.startsAt !== undefined ? diff.startsAt : before.startsAt;
    const endsAt = diff.endsAt !== undefined ? diff.endsAt : before.endsAt;
    const isActive = diff.isActive ?? before.isActive;
    checkSchedule(startsAt, endsAt, isActive, diff.isActive === true || diff.endsAt !== undefined);
    if (Object.keys(diff).length === 0) return { changed: false as const, row: before };
    const row = await tx.homeBanner.update({ where: { id }, data: diff });
    return { changed: true as const, row, before, diff };
  }, TX_OPTS);

  if (out.changed) {
    invalidatePublicBanners();
    const parts = Object.keys(out.diff).filter((k) => k !== 'linkUrl' && k !== 'imageUrl').map((k) => {
      const key = k as keyof Plan;
      if (key === 'title') return `title ${q(out.before.title)} -> ${q(out.row.title)}`;
      if (key === 'isActive' || key === 'theme') return `${key} ${String(out.before[key])} -> ${String(out.row[key])}`;
      return `${key} changed`;
    });
    const urls: [string, string | null][] = [['link', out.row.linkUrl]];
    if (out.diff.linkUrl !== undefined) urls.push(['was', out.before.linkUrl]);
    urls.push(['image', out.row.imageUrl]);
    await writeAudit('BANNER_EDITED', 'BANNER', id, auditText(`admin ${actor.id} edited banner`, urls, `${q(out.before.title)}${parts.length ? `: ${parts.join('; ')}` : ''}`));
  }
  return { changed: out.changed, data: await adminRowOf(out.row) };
};

/** DELETE is idempotent: a banner that is already gone answers 200 with `deleted:false` (two tabs, a double click). */
export const deleteBanner = async (id: string, actor: Actor) => {
  const gone = await prisma.$transaction(async (tx) => {
    await lockOrder(tx);
    if (!(await lockRow(tx, id))) return null;
    return tx.homeBanner.delete({ where: { id } });
  }, TX_OPTS);
  if (!gone) return { id, deleted: false as const };
  invalidatePublicBanners();
  await writeAudit('BANNER_DELETED', 'BANNER', id, auditText(`admin ${actor.id} deleted banner`, [['link', gone.linkUrl], ['image', gone.imageUrl]], `${q(gone.title)} (${gone.viewCount} views, ${gone.clickCount} clicks)`));
  return { id, title: gone.title, deleted: true as const };
};

/** POST /admin/banners/reorder `{ids}`: the listed banners get 10, 20, 30 ... in that order, the others follow in their current order. */
export const reorderBanners = async (rawIds: unknown, actor: Actor) => {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_BANNERS) throw bad('ids', 'ids must be a list of banner ids.');
  const ids: string[] = [];
  for (const v of rawIds) {
    if (typeof v !== 'string' || !ID_RE.test(v)) throw bad('ids', 'Every id must be a valid banner id.');
    if (ids.includes(v)) throw bad('ids', 'The same banner is listed twice.');
    ids.push(v);
  }
  const out = await prisma.$transaction(async (tx) => {
    await lockOrder(tx);
    await tx.$queryRaw`SELECT "id" FROM "HomeBanner" ORDER BY "id" FOR UPDATE`;
    const current = await tx.homeBanner.findMany({ orderBy: [...ORDER], select: { id: true, sortOrder: true } });
    const known = new Set(current.map((c) => c.id));
    if (ids.some((i) => !known.has(i))) throw bad('ids', 'One of the banners does not exist (it may have been deleted). Reload the list and try again.', 'BANNER_UNKNOWN');
    const listed = new Set(ids);
    const order = [...ids, ...current.filter((c) => !listed.has(c.id)).map((c) => c.id)];
    const bySort = new Map(current.map((c) => [c.id, c.sortOrder] as const));
    const changedIds: string[] = [];
    const newOrders: number[] = [];
    for (const [i, bid] of order.entries()) {
      if (bySort.get(bid) !== (i + 1) * SORT_STEP) { changedIds.push(bid); newOrders.push((i + 1) * SORT_STEP); }
    }
    if (changedIds.length) {
      await tx.$executeRaw`
        UPDATE "HomeBanner" t SET "sortOrder" = v."so", "updatedAt" = now()
        FROM unnest(${changedIds}::text[], ${newOrders}::int[]) AS v("id", "so") WHERE t."id" = v."id"`;
    }
    return { moved: changedIds.length, total: order.length };
  }, { maxWait: 10_000, timeout: 30_000 });
  if (out.moved > 0) {
    invalidatePublicBanners();
    await writeAudit('BANNER_REORDERED', 'BANNER', 'all', `admin ${actor.id} reordered the banners: ${out.moved} of ${out.total} changed position`);
  }
  return { changed: out.moved > 0, moved: out.moved, data: await listAdminBanners() };
};

/** POST /admin/banners/:id/duplicate: a copy switched OFF at the end of the list, title + " (copy)" (cut to fit 60 characters), counters at 0. */
export const duplicateBanner = async (id: string, actor: Actor) => {
  const created = await prisma.$transaction(async (tx) => {
    await lockOrder(tx);
    const src = await tx.homeBanner.findUnique({ where: { id } });
    if (!src) throw new AppError(404, 'NOT_FOUND', 'Banner not found (it may have been deleted).');
    if ((await tx.homeBanner.count()) >= MAX_BANNERS) throw new AppError(409, 'BANNER_LIMIT', `There are already ${MAX_BANNERS} banners. Delete one you no longer need first.`);
    const suffix = ' (copy)';
    const base = Array.from(src.title);
    const title = (base.length + suffix.length > 60 ? base.slice(0, 60 - suffix.length).join('').trimEnd() : src.title) + suffix;
    const max = (await tx.homeBanner.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0;
    return {
      src,
      row: await tx.homeBanner.create({
        data: {
          id: randomUUID(), title, subtitle: src.subtitle, imageUrl: src.imageUrl, linkUrl: src.linkUrl, ctaLabel: src.ctaLabel, theme: src.theme,
          placement: src.placement, isActive: false, startsAt: src.startsAt, endsAt: src.endsAt, sortOrder: max + SORT_STEP, createdByUserId: actor.id,
        },
      }),
    };
  }, TX_OPTS);
  invalidatePublicBanners();
  await writeAudit('BANNER_DUPLICATED', 'BANNER', created.row.id, auditText(`admin ${actor.id} duplicated banner`, [['link', created.row.linkUrl], ['image', created.row.imageUrl]], `${q(created.src.title)} (copy is off)`));
  return adminRowOf(created.row);
};
