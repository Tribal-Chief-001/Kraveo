import { prisma } from '../db';

/**
 * Append-only admin activity log (GET /admin/audit-log). Never throws: a failed log line must not
 * undo the action it describes. Never put secrets or raw provider payloads in `summary`.
 */
export const writeAudit = (action: string, targetType: string, targetId: string, summary: string) =>
  prisma.adminAuditLog
    .create({ data: { action, targetType, targetId, summary: summary.slice(0, 300) } })
    .catch((e) => console.error('audit log failed:', e));
