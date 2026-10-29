import { Router, Response } from 'express';
import { prisma } from '../db';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { fail, validParams } from '../utils/http';
import { enumField, optionalText, strictBody, textField } from '../utils/adminInput';
import { riderImpact, removeRider, restoreRider, RiderChange } from '../services/riderAdmin';
import { applicationRow } from './partners';

/**
 * Admin: riders (Docs/27 B2). The suspend is the existing POST /admin/partners/DRIVER/:id/status (routes/partners.ts), which now
 * delegates to services/riderAdmin; this router adds remove / restore and a read-only impact preview. ADMIN only, rate limited, audited, idempotent.
 */
export const adminDriversRouter = Router();
const adminOnly = [requireAuth, requireRole('ADMIN')] as const;

const row = (idOrUserId: string) => prisma.driverPartner.findFirstOrThrow({ where: { OR: [{ id: idOrUserId }, { userId: idOrUserId }] }, include: { user: { select: { id: true, name: true, phone: true, accountStatus: true } } } });

const answer = async (res: Response, idOrUserId: string, out: RiderChange & { name: string }) => {
  const { name: _n, ...rest } = out;
  return res.json({ success: true, ...rest, data: applicationRow('DRIVER', await row(idOrUserId)) });
};

adminDriversRouter.get('/admin/drivers/:id/impact', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await riderImpact(req.params.id) });
  } catch (err) {
    return fail(res, err, 'rider impact');
  }
});

adminDriversRouter.post('/admin/drivers/:id/remove', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['reason', 'confirmName', 'handover']);
    const reason = textField(b.reason, 'reason', 3, 200, 'Reason');
    const handover = enumField(b.handover, 'handover', ['REFUSE', 'RELEASE'] as const, 'REFUSE');
    return await answer(res, req.params.id, await removeRider({ driverId: req.params.id, adminId: req.user!.id, reason, confirmName: b.confirmName, handover }));
  } catch (err) {
    return fail(res, err, 'remove rider');
  }
});

adminDriversRouter.post('/admin/drivers/:id/restore', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['note']);
    const note = optionalText(b.note, 'note', 200);
    return await answer(res, req.params.id, await restoreRider({ driverId: req.params.id, adminId: req.user!.id, note }));
  } catch (err) {
    return fail(res, err, 'restore rider');
  }
});
