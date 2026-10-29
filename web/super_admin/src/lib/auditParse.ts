// Docs/27 B5 + Docs/28 section 6: the Activity log (read only). Parsers, filter -> query mapping and IST date helpers.
// No React here, so everything is unit-tested with real server JSON.
import { num, text } from './accountParse';

export interface AuditRow {
  id: string;
  createdAt: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  /** null = the system (a job or webhook) or a row from before actors were recorded. */
  actorId: string | null;
  actorName: string | null;
  ip: string | null;
}

export interface AuditPage { rows: AuditRow[]; nextCursor: string | null; count: number }
export interface AuditAction { action: string; count: number }

export interface AuditFilters {
  /** Action codes; empty = all. */
  actions: string[];
  targetType: string;
  actorId: string;
  /** 2 to 60 characters, matched inside the summary. Shorter text is not sent. */
  q: string;
  /** IST dates YYYY-MM-DD, '' = open end. */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: AuditFilters = { actions: [], targetType: '', actorId: '', q: '', from: '', to: '' };

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);

export const parseAuditRow = (raw: unknown): AuditRow | null => {
  const o = obj(raw);
  const id = text(o?.id);
  const action = text(o?.action);
  if (!o || !id || !action) return null;
  return {
    id, action,
    createdAt: text(o.createdAt) ?? '',
    targetType: text(o.targetType) ?? '',
    targetId: text(o.targetId) ?? '',
    summary: typeof o.summary === 'string' ? o.summary : '',
    actorId: text(o.actorId), actorName: text(o.actorName), ip: text(o.ip),
  };
};

export const parseAuditPage = (raw: unknown): AuditPage | null => {
  const o = obj(raw);
  if (!o || !Array.isArray(o.data)) return null;
  const rows = o.data.map(parseAuditRow).filter((r: AuditRow | null): r is AuditRow => r !== null);
  return { rows, nextCursor: text(o.nextCursor), count: Math.max(0, num(o.count, rows.length)) };
};

export const parseAuditActions = (raw: unknown): AuditAction[] | null => {
  const o = obj(raw);
  if (!o || !Array.isArray(o.data)) return null;
  return o.data.flatMap((item: unknown) => {
    const a = obj(item);
    const action = text(a?.action);
    return a && action ? [{ action, count: Math.max(0, num(a.count)) }] : [];
  });
};

// ───────────────────────── IST dates ─────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
export const isIstDate = (d: string): boolean => DATE_RE.test(d) && Number.isFinite(dayNumber(d)) && new Date(dayNumber(d) * 86_400_000).toISOString().slice(0, 10) === d;

/** Today's date in India (YYYY-MM-DD), whatever time zone the browser is in. */
export const istToday = (now: number = Date.now()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

export const istDaysAgo = (days: number, now: number = Date.now()): string => new Date((dayNumber(istToday(now)) - days) * 86_400_000).toISOString().slice(0, 10);

/** "29 Oct 2026, 3:42 pm" in Indian time; "-" for a missing or unreadable date. */
export const istDateTime = (iso: string | null | undefined): string => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '-';
  return new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};

/** A problem with the chosen dates, in plain words, or ''. `csv` also enforces the export's 366-day limit. */
export const rangeProblem = (f: Pick<AuditFilters, 'from' | 'to'>, csv = false): string => {
  if (f.from && !isIstDate(f.from)) return 'The "from" date is not a valid date.';
  if (f.to && !isIstDate(f.to)) return 'The "to" date is not a valid date.';
  if (f.from && f.to) {
    if (dayNumber(f.from) > dayNumber(f.to)) return 'The "from" date is after the "to" date.';
    const days = dayNumber(f.to) - dayNumber(f.from) + 1;
    if (csv && days > 366) return 'The file can cover at most 366 days. Choose a shorter range.';
    if (days > 3660) return 'Choose a range shorter than 10 years.';
  }
  return '';
};

/** `q` shorter than 2 characters is not accepted by the server: it is left out and the screen says so. */
export const searchTooShort = (q: string): boolean => q.trim().length === 1;

/** The query string of the list and of the CSV (the CSV takes no cursor or limit). Empty filters are left out. */
export const auditQuery = (f: AuditFilters, opts: { cursor?: string | null; limit?: number } = {}): string => {
  const p = new URLSearchParams();
  if (f.actions.length) p.set('action', f.actions.join(','));
  if (f.targetType.trim()) p.set('targetType', f.targetType.trim());
  if (f.actorId.trim()) p.set('actorId', f.actorId.trim());
  const q = f.q.trim().slice(0, 60);
  if (q.length >= 2) p.set('q', q);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.cursor) p.set('cursor', opts.cursor);
  return p.toString();
};

export const hasFilters = (f: AuditFilters): boolean => f.actions.length > 0 || Boolean(f.targetType.trim() || f.actorId.trim() || f.q.trim() || f.from || f.to);

// ───────────────────────── wording ─────────────────────────
/** CUSTOMER_SUSPENDED -> "Customer suspended". */
export const actionLabel = (code: string): string => {
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
};

const GROUPS: Array<[string, RegExp]> = [
  ['Customers', /^CUSTOMER_/],
  ['Orders', /^(ORDER|REFUND|PAYMENT)/],
  ['Owner logins', /^OWNER_/],
  ['Restaurants and riders', /^(PARTNER|VENDOR|DRIVER|PASSWORD)/],
  ['Catalog', /^(DISH|CATALOG|MENU|CATEGORY|CUISINE)/],
  ['Finance', /^(SETTLEMENT|PAYOUT|RIDER_PAYOUT|FINANCE|ADJUSTMENT)/],
  ['Settings and banners', /^(SETTING|PRICING|BANNER|COMMISSION)/],
];
export const actionGroup = (code: string): string => GROUPS.find(([, re]) => re.test(code))?.[0] ?? 'Other';

/** The actions grouped for the picker, groups in a fixed order, codes alphabetical. */
export const groupActions = (actions: AuditAction[]): Array<{ group: string; items: AuditAction[] }> => {
  const order = [...GROUPS.map(([g]) => g), 'Other'];
  const map = new Map<string, AuditAction[]>();
  for (const a of actions) {
    const g = actionGroup(a.action);
    map.set(g, [...(map.get(g) ?? []), a]);
  }
  return order.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)!.slice().sort((a, b) => a.action.localeCompare(b.action)) }));
};

export const TARGET_TYPES: Array<{ value: string; label: string }> = [
  { value: 'ORDER', label: 'Order' },
  { value: 'VENDOR', label: 'Restaurant' },
  { value: 'DRIVER', label: 'Rider' },
  { value: 'USER', label: 'Person (customer or login)' },
  { value: 'SETTING', label: 'Setting' },
];

export type AuditTarget = { kind: 'order'; id: string } | { kind: 'tab'; tab: 'vendors' | 'drivers' | 'customers'; label: string } | null;

/** Where a target can be opened from: an order opens the order drawer, the others open their tab. */
export const auditTarget = (row: Pick<AuditRow, 'targetType' | 'targetId'>): AuditTarget => {
  if (!row.targetId) return null;
  switch (row.targetType) {
    case 'ORDER': return { kind: 'order', id: row.targetId };
    case 'VENDOR': return { kind: 'tab', tab: 'vendors', label: 'Restaurants' };
    case 'DRIVER': return { kind: 'tab', tab: 'drivers', label: 'Riders' };
    case 'USER': return { kind: 'tab', tab: 'customers', label: 'Customers' };
    default: return null;
  }
};

export const shortId = (id: string): string => id.slice(0, 8);

/** Who did it: the admin's name, "System" for a job, or the plain note for a row written before actors existed. */
export const actorText = (row: Pick<AuditRow, 'actorId' | 'actorName'>): string => (row.actorName ? row.actorName : row.actorId ? `Admin ${shortId(row.actorId)}` : 'System or before admin names were recorded');
