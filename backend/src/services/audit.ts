import { prisma } from '../db';
import { errSummary } from '../utils/log';
import { Actor, currentActor } from './actorContext';

/**
 * Keys that must never reach the log, at any depth (a safety net: callers are not supposed to pass secrets at all). Only REAL secret names: a flag
 * such as `passwordGenerated` or a counter such as `tokenVersion` is harmless and stays readable.
 */
const SECRET_KEY = /^(otp|pin)$|(password|passwordhash|passwd|token|secret|accountnumber|otpcode|authorization|cookie|apikey|privatekey)$/i;
const scrubMeta = (v: unknown, depth = 0): unknown => {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? v.slice(0, 300) : v;
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubMeta(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) out[k] = SECRET_KEY.test(k) ? '[hidden]' : scrubMeta(x, depth + 1);
  return out;
};

// Admin display names change rarely; one lookup per admin per 5 minutes is plenty.
const nameCache = new Map<string, { name: string; until: number }>();
const actorName = async (actor: Actor): Promise<string | null> => {
  if (actor.name) return actor.name.slice(0, 60);
  const hit = nameCache.get(actor.id);
  if (hit && hit.until > Date.now()) return hit.name;
  try {
    const u = await prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } });
    if (!u) return null;
    nameCache.set(actor.id, { name: u.name, until: Date.now() + 5 * 60_000 });
    return u.name.slice(0, 60);
  } catch {
    return null;
  }
};

export type AuditOptions = {
  /** {before, after} or counts. Never secrets (keys that look secret are replaced anyway). */
  meta?: unknown;
  /** Overrides the request's actor; `null` forces "system". */
  actor?: Actor | null;
};

/**
 * Append-only admin activity log (GET /admin/audit-log). Never throws: a failed log line must not
 * undo the action it describes. Never put secrets or raw provider payloads in `summary`.
 * The actor is the admin of the current request (actorContext); maintenance jobs and webhooks have none, so their rows say "system".
 */
export const writeAudit = async (action: string, targetType: string, targetId: string, summary: string, opts: AuditOptions = {}): Promise<void> => {
  try {
    const actor = opts.actor === undefined ? currentActor() : (opts.actor ?? undefined);
    await prisma.adminAuditLog.create({
      data: {
        action,
        targetType,
        targetId,
        summary: summary.slice(0, 300),
        ...(actor ? { actorId: actor.id, actorName: await actorName(actor), ip: actor.ip ? actor.ip.slice(0, 64) : null } : {}),
        ...(opts.meta !== undefined ? { meta: scrubMeta(opts.meta) as object } : {}),
      },
    });
  } catch (e) {
    console.error('audit log failed:', errSummary(e));
  }
};
