import { Router, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { fail, validParams } from '../utils/http';
import { boolField, enumField, strictBody, textField } from '../utils/adminInput';
import { createOrAttachOwner, detachOwner, disableOwner, enableOwner, getOwner, patchOwner, resetOwnerPassword } from '../services/ownerAdmin';

/**
 * Admin: the owner login of a restaurant (Docs/27 B4). ADMIN only, rate limited (ADMIN_ACCOUNT_WRITE), audited with the acting admin,
 * strictly validated. A password is only ever in the answer of a POST here (Cache-Control: no-store), once, and nowhere else.
 */
export const adminOwnersRouter = Router();
const adminOnly = [requireAuth, requireRole('ADMIN')] as const;
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

adminOwnersRouter.get('/admin/vendors/:id/owner', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, owner: await getOwner(req.params.id) });
  } catch (err) {
    return fail(res, err, 'get owner');
  }
});

adminOwnersRouter.post('/admin/vendors/:id/owner', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    noStore(res);
    const b = strictBody(req, ['name', 'phone', 'password', 'existingUserId', 'takePayoutAccountFrom']);
    const out = await createOrAttachOwner({ vendorId: req.params.id, adminId: req.user!.id, ...b });
    return res.status(201).json({ success: true, ...out });
  } catch (err) {
    return fail(res, err, 'create owner');
  }
});

adminOwnersRouter.patch('/admin/vendors/:id/owner', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['name', 'phone']);
    if (b.name === undefined && b.phone === undefined) return res.status(400).json({ success: false, code: 'BAD_REQUEST', field: 'name', message: 'Send a name or a phone to change.' });
    return res.json({ success: true, ...(await patchOwner({ vendorId: req.params.id, ...b })) });
  } catch (err) {
    return fail(res, err, 'patch owner');
  }
});

adminOwnersRouter.post('/admin/vendors/:id/owner/reset-password', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    noStore(res);
    const b = strictBody(req, ['password']);
    return res.json({ success: true, ...(await resetOwnerPassword({ vendorId: req.params.id, password: b.password })) });
  } catch (err) {
    return fail(res, err, 'reset owner password');
  }
});

adminOwnersRouter.post('/admin/vendors/:id/owner/disable', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['reason', 'closeRestaurant']);
    const reason = textField(b.reason, 'reason', 3, 200, 'Reason');
    const closeRestaurant = boolField(b.closeRestaurant, 'closeRestaurant', true);
    return res.json({ success: true, ...(await disableOwner({ vendorId: req.params.id, adminId: req.user!.id, reason, closeRestaurant })) });
  } catch (err) {
    return fail(res, err, 'disable owner');
  }
});

adminOwnersRouter.post('/admin/vendors/:id/owner/enable', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    strictBody(req, []);
    return res.json({ success: true, ...(await enableOwner({ vendorId: req.params.id, adminId: req.user!.id })) });
  } catch (err) {
    return fail(res, err, 'enable owner');
  }
});

adminOwnersRouter.post('/admin/vendors/:id/owner/detach', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['reason', 'openOrders', 'closeRestaurant']);
    const reason = textField(b.reason, 'reason', 3, 200, 'Reason');
    const openOrders = enumField(b.openOrders, 'openOrders', ['REFUSE', 'CANCEL'] as const, 'REFUSE');
    const closeRestaurant = boolField(b.closeRestaurant, 'closeRestaurant', true);
    const out = await detachOwner({ vendorId: req.params.id, adminId: req.user!.id, reason, openOrders, closeRestaurant, removeUser: false });
    return res.json({ success: true, owner: null, ...out });
  } catch (err) {
    return fail(res, err, 'detach owner');
  }
});

adminOwnersRouter.post('/admin/vendors/:id/owner/remove', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['reason', 'confirmName', 'openOrders', 'closeRestaurant']);
    const reason = textField(b.reason, 'reason', 3, 200, 'Reason');
    const openOrders = enumField(b.openOrders, 'openOrders', ['REFUSE', 'CANCEL'] as const, 'REFUSE');
    const closeRestaurant = boolField(b.closeRestaurant, 'closeRestaurant', true);
    const out = await detachOwner({ vendorId: req.params.id, adminId: req.user!.id, reason, openOrders, closeRestaurant, removeUser: true, confirmName: b.confirmName });
    return res.json({ success: true, owner: null, ...out });
  } catch (err) {
    return fail(res, err, 'remove owner');
  }
});
