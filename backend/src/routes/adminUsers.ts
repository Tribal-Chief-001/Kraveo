import { Router, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { fail, validParams } from '../utils/http';
import { AppError } from '../utils/appError';
import { enumField, boolField, optionalText, strictBody, textField } from '../utils/adminInput';
import { BlockResult, blockCustomer, loadCustomerDetail, restoreCustomer } from '../services/customerAdmin';

/**
 * Admin: customers (Docs/27 B1). All routes are ADMIN only (401 / 403 otherwise), rate limited (ADMIN_ACCOUNT_WRITE), audited with the acting
 * admin, idempotent (the same transition again answers 200 { changed: false } and writes no second audit row) and strictly validated.
 * The list and detail GETs live in routes/partners.ts next to the other customer reads.
 */
export const adminUsersRouter = Router();
const adminOnly = [requireAuth, requireRole('ADMIN')] as const;

const send = async (res: Response, userId: string, out: BlockResult | { changed: boolean }) => {
  const data = await loadCustomerDetail(userId);
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Customer not found.');
  const b = out as BlockResult;
  return res.json({ success: true, changed: out.changed, data, ...(b.cancelled ? { cancelled: b.cancelled } : {}), ...(b.failed ? { failed: b.failed } : {}) });
};

adminUsersRouter.post('/admin/customers/:id/suspend', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['reason', 'openOrders']);
    const reason = textField(b.reason, 'reason', 3, 200, 'Reason');
    const openOrders = enumField(b.openOrders, 'openOrders', ['REFUSE', 'CANCEL'] as const, 'REFUSE');
    const out = await blockCustomer({ userId: req.params.id, adminId: req.user!.id, target: 'SUSPENDED', reason, scrub: false, openOrders });
    return await send(res, req.params.id, out);
  } catch (err) {
    return fail(res, err, 'suspend customer');
  }
});

adminUsersRouter.post('/admin/customers/:id/restore', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['note']);
    const note = optionalText(b.note, 'note', 200);
    const out = await restoreCustomer({ userId: req.params.id, adminId: req.user!.id, note });
    return await send(res, req.params.id, out);
  } catch (err) {
    return fail(res, err, 'restore customer');
  }
});

adminUsersRouter.post('/admin/customers/:id/remove', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['reason', 'confirmName', 'scrub', 'openOrders']);
    const reason = textField(b.reason, 'reason', 3, 200, 'Reason');
    const scrub = boolField(b.scrub, 'scrub', false);
    const openOrders = enumField(b.openOrders, 'openOrders', ['REFUSE', 'CANCEL'] as const, 'REFUSE');
    const out = await blockCustomer({ userId: req.params.id, adminId: req.user!.id, target: 'REMOVED', reason, confirmName: b.confirmName, scrub, openOrders });
    return await send(res, req.params.id, out);
  } catch (err) {
    return fail(res, err, 'remove customer');
  }
});
