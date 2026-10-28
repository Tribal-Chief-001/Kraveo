// Home banners (Docs/25). ONE place for: turning the backend's banner answers into dashboard shapes (REAL shapes, Docs/25 section 7),
// mirroring the server's input rules so mistakes are caught before the request, and the India time (IST) maths for the schedule.
// Parsers never throw and never give NaN: a missing field becomes a safe default, an unusable row is dropped.

export type BannerStatus = 'LIVE' | 'SCHEDULED' | 'EXPIRED' | 'OFF';
export type BannerTheme = 'DARK' | 'LIGHT';

export const MAX_BANNERS = 30;
export const TITLE_MIN = 2;
export const TITLE_MAX = 60;
export const SUBTITLE_MAX = 120;
export const CTA_MAX = 20;
export const URL_MAX = 500;

export interface Banner {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  linkUrl: string | null;
  ctaLabel: string | null;
  theme: BannerTheme;
  isActive: boolean;
  /** UTC instants as ISO strings, or null (= no limit). */
  startsAt: string | null;
  endsAt: string | null;
  sortOrder: number;
  viewCount: number;
  clickCount: number;
  /** Percent with one decimal (12.5 = 12.5 %); null while there are no views. */
  ctr: number | null;
  status: BannerStatus;
  /** Position among the LIVE banners (1 = first card); null when not live. */
  rank: number | null;
  /** The app shows only the first MAX_SHOWN live banners: false = live but cut off (or not live). */
  shown: boolean;
}

/** The app shows at most this many live banners at once (Docs/25 section 1). */
export const MAX_SHOWN = 10;

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const instant = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const STATUSES: readonly string[] = ['LIVE', 'SCHEDULED', 'EXPIRED', 'OFF'];

/** The server's status rule, used only when an answer has no usable `status`. */
export const statusOf = (b: Pick<Banner, 'isActive' | 'startsAt' | 'endsAt'>, now: number = Date.now()): BannerStatus => {
  if (!b.isActive) return 'OFF';
  if (b.endsAt && Date.parse(b.endsAt) <= now) return 'EXPIRED';
  if (b.startsAt && Date.parse(b.startsAt) > now) return 'SCHEDULED';
  return 'LIVE';
};

/** One admin row. Null when it has no id. */
export const parseBanner = (raw: unknown): Banner | null => {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : '';
  if (!id) return null;
  const viewCount = count(raw.viewCount);
  const clickCount = count(raw.clickCount);
  const sort = Number(raw.sortOrder);
  const base = {
    isActive: raw.isActive === true,
    startsAt: instant(raw.startsAt),
    endsAt: instant(raw.endsAt),
  };
  const rankRaw = Number(raw.rank);
  const rank = raw.rank !== null && raw.rank !== undefined && Number.isFinite(rankRaw) && rankRaw >= 1 ? Math.floor(rankRaw) : null;
  const ctrRaw = typeof raw.ctr === 'number' && Number.isFinite(raw.ctr) && raw.ctr >= 0 ? raw.ctr : null;
  const status: BannerStatus = typeof raw.status === 'string' && STATUSES.includes(raw.status) ? (raw.status as BannerStatus) : statusOf(base);
  return {
    id,
    title: text(raw.title) ?? 'Untitled banner',
    subtitle: text(raw.subtitle),
    imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : '',
    linkUrl: text(raw.linkUrl),
    ctaLabel: text(raw.ctaLabel),
    theme: raw.theme === 'LIGHT' ? 'LIGHT' : 'DARK',
    ...base,
    sortOrder: Number.isFinite(sort) ? sort : 0,
    viewCount,
    clickCount,
    ctr: ctrRaw ?? (viewCount > 0 ? Math.round((clickCount / viewCount) * 1000) / 10 : null),
    status,
    rank,
    // An older server sends no `shown`: a live banner then counts as shown (nothing is claimed that the server did not say).
    shown: typeof raw.shown === 'boolean' ? raw.shown : status === 'LIVE',
  };
};

/** `{ data: [...] }` or a bare array. Rows without an id are dropped; null when the answer is not a list at all. */
export const parseBannerList = (body: unknown): Banner[] | null => {
  const data = isObject(body) && 'data' in body ? body.data : body;
  if (!Array.isArray(data)) return null;
  return data.map(parseBanner).filter((row): row is Banner => row !== null);
};

/** create / patch / duplicate answer: `{ data: banner, changed?, message? }`. */
export const parseBannerResult = (body: unknown): { banner: Banner | null; changed: boolean; message: string } => {
  const b = isObject(body) ? body : {};
  return { banner: parseBanner(b.data), changed: b.changed !== false, message: typeof b.message === 'string' ? b.message : '' };
};

// ───────────────────────────── text and link rules (mirror backend/src/services/banners.ts) ─────────────────────────────

const BAD_TEXT_CHARS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u2028\u2029\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
export const collapse = (s: string): string => s.normalize('NFC').trim().replace(/\s+/g, ' ');
const length = (s: string) => Array.from(s).length;

/** Title / subtitle / button text. Returns a plain message or '' when fine. `min` 0 = optional. Hindi and emoji are fine. */
export const validateBannerText = (raw: string, min: number, max: number, label: string): string => {
  if (BAD_TEXT_CHARS.test(raw.normalize('NFC'))) return `${label} cannot contain control, hidden or direction-changing characters.`;
  const v = collapse(raw);
  if (/[<>]/.test(v)) return `${label} cannot contain the characters < or >.`;
  const n = length(v);
  if (n === 0 && min === 0) return '';
  if (n < min || n > max) return min > 0 ? `${label} must be ${min} to ${max} characters.` : `${label} can be at most ${max} characters.`;
  return '';
};
export const validateTitle = (raw: string) => validateBannerText(raw, TITLE_MIN, TITLE_MAX, 'The title');
export const validateSubtitle = (raw: string) => validateBannerText(raw, 0, SUBTITLE_MAX, 'The subtitle');
export const validateCta = (raw: string) => validateBannerText(raw, 0, CTA_MAX, 'The button text');

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// eslint-disable-next-line no-control-regex
const HIDDEN_OR_SPACE = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\\]/;

/**
 * https-only address check, same rules and wording as the server (checkHttpsUrl). Returns `{ error }` (plain words) or `{ url }`
 * (normalised like the server: `new URL().toString()`). Empty text is `{ url: '' }`: callers decide whether empty is allowed.
 */
export const checkHttpsAddress = (raw: string, label: string): { url: string; error: '' } | { url?: undefined; error: string } => {
  const fail = (why: string) => ({ error: `${label} ${why}` });
  const textIn = raw.trim();
  if (textIn === '') return { url: '', error: '' };
  if (raw.length > URL_MAX + 64) return fail(`can be at most ${URL_MAX} characters.`);
  if (HIDDEN_OR_SPACE.test(textIn)) return fail('cannot contain spaces, hidden characters or backslashes.');
  if (!/^https:\/\//i.test(textIn)) return fail('must start with https:// (http, javascript:, data:, intent:, market:, mailto:, tel:, file: and app links are not allowed).');
  let u: URL;
  try { u = new URL(textIn); } catch { return fail('is not a valid web address.'); }
  if (u.protocol !== 'https:') return fail('must start with https://');
  if (u.username || u.password) return fail('cannot contain a user name or password.');
  if (u.port) return fail('cannot use a custom port.');
  const host = u.hostname.replace(/\.$/, '');
  if (host.startsWith('[') || host.includes(':') || /^[0-9.]+$/.test(host)) return fail('must use a website name, not an IP address.');
  if (host === 'localhost' || host.endsWith('.localhost') || !HOST_RE.test(host) || host.length > 253) return fail('must use a real website name, like example.com.');
  const out = u.toString();
  if (out.length > URL_MAX) return fail(`can be at most ${URL_MAX} characters.`);
  return { url: out, error: '' };
};

/** The link is optional: '' = display-only banner. Returns a message or ''. */
export const validateLink = (raw: string): string => checkHttpsAddress(raw, 'The link').error;
export const validateImageUrl = (raw: string): string => (raw.trim() === '' ? 'Add a picture: upload one or paste its https:// address.' : checkHttpsAddress(raw, 'The image address').error);

/**
 * Hosts the dashboard's Content-Security-Policy lets it load pictures from (web/super_admin/vercel.json `img-src`). A picture from any other
 * https host is fine for the app but the browser blocks it here, so the preview would stay empty: warn instead of loosening the policy.
 */
export const DASHBOARD_IMAGE_HOSTS = ['api.kraveo.site', 'kraveo.site', 'images.unsplash.com'] as const;
export const imageHostWarning = (raw: string): string => {
  const r = checkHttpsAddress(raw, 'x');
  if (!r.url) return '';
  const host = new URL(r.url).hostname;
  if ((DASHBOARD_IMAGE_HOSTS as readonly string[]).includes(host)) return '';
  return `This picture is hosted on ${host}. The customer app can show it, but this dashboard blocks pictures from that site, so you will not see it in the preview here. Use Upload photo to keep it on Kraveo.`;
};

// ───────────────────────────── IST (UTC+05:30, no daylight saving) ─────────────────────────────

const IST_OFFSET_MIN = 330;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "2026-11-01T18:30" typed as India time -> the UTC instant "2026-11-01T13:00:00.000Z". Null for anything that is not a real date (year 2000..2100). */
export const istToInstant = (local: string): string | null => {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - IST_OFFSET_MIN * 60_000).toISOString();
};

/** A UTC instant -> the India wall-clock value for a datetime-local input ("2026-11-01T18:30"). '' when unusable. */
export const instantToIst = (iso: string | null | undefined): string => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const d = new Date(t + IST_OFFSET_MIN * 60_000);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "1 Nov 2026, 6:30 pm" in India time (without the IST label: the caller adds it). '' when unusable. */
export const formatIst = (iso: string | null | undefined): string => {
  const local = instantToIst(iso);
  const m = LOCAL_RE.exec(local);
  if (!m) return '';
  const h = Number(m[4]);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${h % 12 === 0 ? 12 : h % 12}:${m[5]} ${h < 12 ? 'am' : 'pm'}`;
};

/** "Always on", "From 1 Nov 2026, 6:30 pm IST", "Until ... IST" or "A to B IST". */
export const scheduleText = (b: Pick<Banner, 'startsAt' | 'endsAt'>): string => {
  const s = formatIst(b.startsAt);
  const e = formatIst(b.endsAt);
  if (s && e) return `${s} to ${e} IST`;
  if (s) return `From ${s} IST`;
  if (e) return `Until ${e} IST`;
  return 'Always on';
};

/** Field messages for the two pickers (values are the datetime-local texts). */
export const validateSchedule = (startLocal: string, endLocal: string): { start: string; end: string } => {
  const s = startLocal.trim() === '' ? null : istToInstant(startLocal);
  const e = endLocal.trim() === '' ? null : istToInstant(endLocal);
  const out = { start: '', end: '' };
  if (startLocal.trim() !== '' && !s) out.start = 'Enter a real date and time between the years 2000 and 2100.';
  if (endLocal.trim() !== '' && !e) out.end = 'Enter a real date and time between the years 2000 and 2100.';
  if (s && e && Date.parse(e) <= Date.parse(s)) out.end = 'The end must be after the start.';
  return out;
};

export const ctrText = (b: Pick<Banner, 'ctr'>): string => (b.ctr === null ? '-' : `${b.ctr}%`);

// ───────────────────────────── form <-> request bodies ─────────────────────────────

export interface BannerForm {
  title: string;
  subtitle: string;
  imageUrl: string;
  linkUrl: string;
  ctaLabel: string;
  theme: BannerTheme;
  isActive: boolean;
  /** India wall-clock text from the date-time pickers ('' = none). */
  startLocal: string;
  endLocal: string;
}

export const emptyForm = (): BannerForm => ({ title: '', subtitle: '', imageUrl: '', linkUrl: '', ctaLabel: '', theme: 'DARK', isActive: true, startLocal: '', endLocal: '' });
export const formFromBanner = (b: Banner): BannerForm => ({
  title: b.title, subtitle: b.subtitle ?? '', imageUrl: b.imageUrl, linkUrl: b.linkUrl ?? '', ctaLabel: b.ctaLabel ?? '', theme: b.theme, isActive: b.isActive,
  startLocal: instantToIst(b.startsAt), endLocal: instantToIst(b.endsAt),
});

export interface BannerWrite {
  title?: string;
  subtitle?: string | null;
  imageUrl?: string;
  linkUrl?: string | null;
  ctaLabel?: string | null;
  theme?: BannerTheme;
  isActive?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

const normLink = (raw: string): string => {
  const r = checkHttpsAddress(raw, 'x');
  return r.url ?? raw.trim();
};
const orNull = (v: string): string | null => (v === '' ? null : v);

/** Everything a new banner needs (optional parts only when filled). */
export const createBody = (f: BannerForm): BannerWrite => {
  const body: BannerWrite = { title: collapse(f.title), imageUrl: f.imageUrl.trim(), theme: f.theme, isActive: f.isActive };
  if (collapse(f.subtitle)) body.subtitle = collapse(f.subtitle);
  if (f.linkUrl.trim()) body.linkUrl = normLink(f.linkUrl);
  if (collapse(f.ctaLabel)) body.ctaLabel = collapse(f.ctaLabel);
  const s = f.startLocal.trim() ? istToInstant(f.startLocal) : null;
  const e = f.endLocal.trim() ? istToInstant(f.endLocal) : null;
  if (s) body.startsAt = s;
  if (e) body.endsAt = e;
  return body;
};

/** Only the fields that differ from the saved banner (an empty object = nothing changed). Dates compare as India wall-clock text. */
export const changesOf = (f: BannerForm, saved: Banner): BannerWrite => {
  const out: BannerWrite = {};
  const title = collapse(f.title);
  if (title !== saved.title) out.title = title;
  const sub = collapse(f.subtitle);
  if (sub !== (saved.subtitle ?? '')) out.subtitle = orNull(sub);
  if (f.imageUrl.trim() !== saved.imageUrl) out.imageUrl = f.imageUrl.trim();
  if (f.linkUrl.trim() !== '' ? normLink(f.linkUrl) !== (saved.linkUrl ?? '') : (saved.linkUrl ?? '') !== '') out.linkUrl = f.linkUrl.trim() === '' ? null : normLink(f.linkUrl);
  const cta = collapse(f.ctaLabel);
  if (cta !== (saved.ctaLabel ?? '')) out.ctaLabel = orNull(cta);
  if (f.theme !== saved.theme) out.theme = f.theme;
  if (f.isActive !== saved.isActive) out.isActive = f.isActive;
  if (f.startLocal.trim() !== instantToIst(saved.startsAt)) out.startsAt = f.startLocal.trim() === '' ? null : istToInstant(f.startLocal);
  if (f.endLocal.trim() !== instantToIst(saved.endsAt)) out.endsAt = f.endLocal.trim() === '' ? null : istToInstant(f.endLocal);
  return out;
};
