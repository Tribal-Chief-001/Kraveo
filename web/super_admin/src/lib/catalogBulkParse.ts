// Bulk dish actions, menu import and image upload answers (Docs/23 sections 3.5, 3.6 and 8.4).
// Shapes are copied from backend/test/e2e/dish_categories_bulk_import.test.ts and uploads.test.ts. Parsers never throw.

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const int = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};
const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

// ───────────────────────────── bulk ─────────────────────────────

export type BulkAction = 'AVAILABLE' | 'UNAVAILABLE' | 'DELETE' | 'RESTORE' | 'APPROVE' | 'SET_CATEGORY';
/** The server takes at most this many dishes per bulk call. */
export const MAX_BULK_IDS = 100;

export interface BulkItemResult { id: string; ok: boolean; changed: boolean; code: string | null; message: string | null }
export interface BulkResult { results: BulkItemResult[]; ok: number; failed: number; message: string }

/** `{ message, data: { results:[{id, ok, changed, code?, message?}], ok, failed } }`. Null when there is no results list. */
export const parseBulkResult = (body: unknown): BulkResult | null => {
  const b = isObject(body) ? body : {};
  const d = isObject(b.data) ? b.data : null;
  if (!d || !Array.isArray(d.results)) return null;
  const results: BulkItemResult[] = d.results
    .filter(isObject)
    .map((r) => ({ id: String(r.id ?? ''), ok: r.ok === true, changed: r.changed === true, code: str(r.code), message: str(r.message) }));
  const ok = results.filter((r) => r.ok).length;
  return { results, ok: int(d.ok) ?? ok, failed: int(d.failed) ?? results.length - ok, message: typeof b.message === 'string' ? b.message : '' };
};

export const BULK_ACTION_LABEL: Record<BulkAction, string> = {
  AVAILABLE: 'Mark available',
  UNAVAILABLE: 'Mark sold out',
  DELETE: 'Delete',
  RESTORE: 'Restore',
  APPROVE: 'Approve',
  SET_CATEGORY: 'Change category',
};

const FAILURE_FALLBACK: Record<string, string> = {
  ITEM_DELETED: 'This dish is deleted. Restore it first.',
  NOT_FOUND: 'This dish no longer exists.',
};

/** Failed rows with the dish name (from the ids the admin picked) and the server's reason in plain words. */
export const bulkFailures = (result: BulkResult, nameOf: (id: string) => string): Array<{ id: string; name: string; message: string }> =>
  result.results.filter((r) => !r.ok).map((r) => ({
    id: r.id,
    name: nameOf(r.id),
    message: r.message ?? (r.code && FAILURE_FALLBACK[r.code]) ?? 'This dish could not be changed.',
  }));

// ───────────────────────────── menu import ─────────────────────────────

export type ImportAction = 'create' | 'update' | 'skip' | 'invalid';
export interface ImportRowReport {
  /** Position in the `rows` that were sent (0-based). */
  index: number;
  name: string;
  action: ImportAction;
  errors: Array<{ field: string; message: string }>;
  /** The customer price from the pricing engine; null when the price itself is not valid. */
  computedPrice: number | null;
  reason: string | null;
  dishId: string | null;
}
export interface ImportSummary { create: number; update: number; skip: number; invalid: number; total: number }
export interface ImportReport { dryRun: boolean; applied: boolean; summary: ImportSummary; rows: ImportRowReport[]; message: string }

const ACTIONS: ImportAction[] = ['create', 'update', 'skip', 'invalid'];

const parseImportRow = (raw: unknown, position: number): ImportRowReport => {
  const r = isObject(raw) ? raw : {};
  const action = ACTIONS.includes(r.action) ? (r.action as ImportAction) : 'invalid';
  const errors = (Array.isArray(r.errors) ? r.errors : [])
    .filter(isObject)
    .map((e) => ({ field: typeof e.field === 'string' ? e.field : 'row', message: str(e.message) ?? 'This row is not valid.' }));
  if (action === 'invalid' && errors.length === 0) errors.push({ field: 'row', message: 'This row is not valid.' });
  return {
    index: int(r.index) ?? position,
    name: typeof r.name === 'string' ? r.name : '',
    action,
    errors,
    computedPrice: num(r.computedPrice),
    reason: str(r.reason),
    dishId: str(r.dishId),
  };
};

/** The report of a dry run or an applied import (`data` of the success answer, or of an IMPORT_INVALID error). Null when it has no rows list. */
export const parseImportReport = (body: unknown): ImportReport | null => {
  const b = isObject(body) ? body : {};
  const d = isObject(b.data) ? b.data : isObject(body) && Array.isArray(b.rows) ? b : null;
  if (!d || !Array.isArray(d.rows)) return null;
  const rows = d.rows.map(parseImportRow);
  const tally = (action: ImportAction) => rows.filter((r) => r.action === action).length;
  const s = isObject(d.summary) ? d.summary : {};
  const summary: ImportSummary = {
    create: int(s.create) ?? tally('create'),
    update: int(s.update) ?? tally('update'),
    skip: int(s.skip) ?? tally('skip'),
    invalid: int(s.invalid) ?? tally('invalid'),
    total: int(s.total) ?? rows.length,
  };
  return { dryRun: d.dryRun !== false, applied: d.applied === true, summary, rows, message: typeof b.message === 'string' ? b.message : '' };
};

export const SKIP_REASON_TEXT: Record<string, string> = {
  DUPLICATE_EXISTS: 'Already on the menu, left as it is',
  UNCHANGED: 'Same as the current dish, nothing to change',
};
export const skipReasonText = (reason: string | null): string => (reason ? SKIP_REASON_TEXT[reason] ?? 'Skipped' : 'Skipped');

/** Counts shown in the wizard: what "Import N dishes" will do. N = rows that create or update a dish. */
export const importableCount = (report: ImportReport): number => report.summary.create + report.summary.update;

// ───────────────────────────── upload ─────────────────────────────

export interface UploadResult { url: string; width: number | null; height: number | null; bytes: number | null }

/** `{ data: { url, width, height, bytes } }`. The url must be an http(s) link, otherwise null. */
export const parseUploadResult = (body: unknown): UploadResult | null => {
  const b = isObject(body) ? body : {};
  const d = isObject(b.data) ? b.data : null;
  const url = d && typeof d.url === 'string' ? d.url.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  return { url, width: num(d!.width), height: num(d!.height), bytes: num(d!.bytes) };
};
