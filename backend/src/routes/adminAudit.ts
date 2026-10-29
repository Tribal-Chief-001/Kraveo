import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { fail, ID_RE } from '../utils/http';
import { AppError } from '../utils/appError';
import { parseIstRange } from '../utils/range';
import { istDateString } from '../utils/time';

/**
 * Activity log viewer (Docs/27 B5). READ ONLY: the log is append-only, so this router has GET handlers and nothing else.
 *   GET /api/admin/audit-log           filters + keyset paging (newest first)
 *   GET /api/admin/audit-log/actions   distinct action codes of the last 90 days with counts (for the filter drop-down)
 *   GET /api/admin/audit-log/export.csv  same filters, at most 5000 rows, at most 366 days
 * `meta` is never returned (it may hold before/after values); `ip` is returned to every admin until admin roles exist.
 */
export const adminAuditRouter = Router();
const adminOnly = [requireAuth, requireRole('ADMIN')] as const;

const ACTION_RE = /^[A-Z][A-Z0-9_]{1,59}$/;
const TARGET_TYPE_RE = /^[A-Z][A-Z0-9_]{1,29}$/;
const LIST_KEYS = ['action', 'targetType', 'targetId', 'actorId', 'q', 'from', 'to', 'cursor', 'limit'];
const CSV_MAX_ROWS = 5000;

const bad = (field: string, message: string, code = 'BAD_REQUEST') => new AppError(400, code, message, field);
const one = (v: unknown, field: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw bad(field, `${field} must be a single text value.`);
  return v;
};

type Filters = { where: Prisma.AdminAuditLogWhereInput; range: ReturnType<typeof parseIstRange> | null };

const parseFilters = (query: Record<string, unknown>, opts: { csv: boolean }): Filters => {
  const allowed = opts.csv ? LIST_KEYS.filter((k) => k !== 'cursor' && k !== 'limit') : LIST_KEYS;
  const extra = Object.keys(query).find((k) => !allowed.includes(k));
  if (extra) throw bad(extra.slice(0, 40), `Unknown parameter '${extra.slice(0, 40)}'.`);
  const and: Prisma.AdminAuditLogWhereInput[] = [];

  const action = one(query.action, 'action');
  if (action !== undefined && action !== '') {
    const list = action.split(',').map((a) => a.trim());
    if (list.length > 20 || list.some((a) => !ACTION_RE.test(a))) throw bad('action', 'action must be up to 20 action codes (capital letters and _), separated by commas.');
    and.push({ action: { in: [...new Set(list)] } });
  }
  const targetType = one(query.targetType, 'targetType');
  if (targetType !== undefined && targetType !== '') {
    if (!TARGET_TYPE_RE.test(targetType)) throw bad('targetType', 'targetType must be capital letters, for example ORDER or VENDOR.');
    and.push({ targetType });
  }
  const targetId = one(query.targetId, 'targetId');
  if (targetId !== undefined && targetId !== '') {
    if (!ID_RE.test(targetId)) throw bad('targetId', 'targetId is not a valid id.');
    and.push({ targetId });
  }
  const actorId = one(query.actorId, 'actorId');
  if (actorId !== undefined && actorId !== '') {
    if (!ID_RE.test(actorId)) throw bad('actorId', 'actorId is not a valid id.');
    and.push({ actorId });
  }
  const q = one(query.q, 'q');
  if (q !== undefined && q !== '') {
    const t = q.trim();
    if (t.length < 2 || t.length > 60) throw bad('q', 'q must be 2 to 60 characters.');
    // Prisma does NOT escape the LIKE wildcards inside `contains`: do it here (backslash is PostgreSQL's default escape character).
    and.push({ summary: { contains: t.replace(/[\\%_]/g, (c) => `\\${c}`), mode: 'insensitive' } });
  }

  let range: ReturnType<typeof parseIstRange> | null = null;
  const from = one(query.from, 'from');
  const to = one(query.to, 'to');
  if (from !== undefined || to !== undefined || opts.csv) {
    try {
      range = parseIstRange(from, to, { defaultDays: opts.csv ? 31 : 1, maxDays: opts.csv ? 366 : 3660 });
    } catch (err) {
      // The CSV has its own code for a range that is too long.
      if (opts.csv && err instanceof AppError && /longer than/.test(err.message)) throw new AppError(400, 'RANGE_TOO_LARGE', err.message, 'from');
      throw err;
    }
    and.push({ createdAt: { gte: range.start, lt: range.end } });
  }
  return { where: and.length ? { AND: and } : {}, range };
};

const rowView = (r: { id: string; createdAt: Date; action: string; targetType: string; targetId: string; summary: string; actorId: string | null; actorName: string | null; ip: string | null }) => ({
  id: r.id, createdAt: r.createdAt, action: r.action, targetType: r.targetType, targetId: r.targetId, summary: r.summary, actorId: r.actorId, actorName: r.actorName, ip: r.ip,
});
const SELECT = { id: true, createdAt: true, action: true, targetType: true, targetId: true, summary: true, actorId: true, actorName: true, ip: true } as const;

const encodeCursor = (r: { createdAt: Date; id: string }) => Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString('base64url');
const decodeCursor = (raw: string): { at: Date; id: string } => {
  const text = Buffer.from(raw.slice(0, 200), 'base64url').toString('utf8');
  const [iso, id] = text.split('|');
  const at = new Date(iso ?? '');
  if (!iso || !id || !ID_RE.test(id) || !Number.isFinite(at.getTime())) throw bad('cursor', 'cursor is not valid.');
  return { at, id };
};

adminAuditRouter.get('/admin/audit-log', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { where } = parseFilters(req.query as Record<string, unknown>, { csv: false });
    // limit: the old endpoint allowed up to 200; anything above the new maximum is lowered to it, junk falls back to the default.
    const rawLimit = one(req.query.limit, 'limit');
    const parsed = (rawLimit !== undefined && /^\d{1,6}$/.test(rawLimit) ? Number.parseInt(rawLimit, 10) : 0) || 50;
    const limit = Math.min(Math.max(parsed, 1), 100);
    const rawCursor = one(req.query.cursor, 'cursor');
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    const page = await prisma.adminAuditLog.findMany({
      where: cursor ? { AND: [where, { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: SELECT,
    });
    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    return res.json({ success: true, count: rows.length, nextCursor: hasMore ? encodeCursor(rows[rows.length - 1]) : null, data: rows.map(rowView) });
  } catch (err) {
    return fail(res, err, 'list audit log');
  }
});

let actionsCache: { at: number; data: { action: string; count: number }[] } | null = null;
export const __resetAuditActionsCache = () => { actionsCache = null; };

adminAuditRouter.get('/admin/audit-log/actions', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (Object.keys(req.query).length) throw bad(Object.keys(req.query)[0].slice(0, 40), 'This endpoint takes no parameters.');
    if (!actionsCache || Date.now() - actionsCache.at > 60_000) {
      const groups = await prisma.adminAuditLog.groupBy({ by: ['action'], where: { createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) } }, _count: { _all: true }, orderBy: { action: 'asc' } });
      actionsCache = { at: Date.now(), data: groups.map((g) => ({ action: g.action, count: g._count._all })) };
    }
    return res.json({ success: true, data: actionsCache.data });
  } catch (err) {
    return fail(res, err, 'list audit actions');
  }
});

/** A spreadsheet runs a cell that starts with = + - @ (or a tab / CR) as a formula: neutralise it, then quote when needed. */
export const csvCell = (v: unknown): string => {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

adminAuditRouter.get('/admin/audit-log/export.csv', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { where, range } = parseFilters(req.query as Record<string, unknown>, { csv: true });
    const rows = await prisma.adminAuditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: CSV_MAX_ROWS, select: SELECT });
    const header = ['time', 'action', 'targetType', 'targetId', 'summary', 'by', 'actorId', 'ip'];
    const lines = [header.join(',')];
    for (const r of rows) lines.push([r.createdAt.toISOString(), r.action, r.targetType, r.targetId, r.summary, r.actorName ?? '', r.actorId ?? '', r.ip ?? ''].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${range?.from ?? istDateString(new Date())}-${range?.to ?? istDateString(new Date())}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(lines.join('\n') + '\n');
  } catch (err) {
    return fail(res, err, 'export audit log');
  }
});
