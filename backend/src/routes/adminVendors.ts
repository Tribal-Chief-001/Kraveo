import { Router, Response } from 'express';
import { prisma } from '../db';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { fail, validParams } from '../utils/http';
import { AppError } from '../utils/appError';
import { enumField, boolField, strictBody, textField } from '../utils/adminInput';
import { CUISINES_INCLUDE, LIVE_MENU_INCLUDE, OWNER_VIEW_SELECT, ownerView, withCuisines } from '../utils/catalog';
import { vendorHasLocation } from '../config/campus';
import { VendorChange, reinstateVendor, removeVendor, restoreVendor, suspendVendor, vendorImpact } from '../services/vendorAdmin';

/**
 * Admin: restaurants (Docs/27 B3). Works for restaurants without an owner login too. ADMIN only, rate limited (ADMIN_ACCOUNT_WRITE),
 * audited with the acting admin, idempotent, strictly validated. Nothing is ever deleted: removing only hides and closes the restaurant.
 */
export const adminVendorsRouter = Router();
const adminOnly = [requireAuth, requireRole('ADMIN')] as const;

/** The restaurant exactly as GET /api/vendors shows it to an admin (owner block included). */
export const adminVendorData = async (id: string) => {
  const row = await prisma.vendor.findUnique({ where: { id }, include: { ...LIVE_MENU_INCLUDE, ...CUISINES_INCLUDE, user: { select: OWNER_VIEW_SELECT } } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Restaurant not found.');
  const { user, ...rest } = row;
  return { ...withCuisines(rest), owner: ownerView(user), hasLocation: vendorHasLocation(row.lat, row.lng) };
};

const answer = async (res: Response, id: string, out: VendorChange & { name?: string }) => {
  const { name: _n, ...rest } = out;
  return res.json({ success: true, ...rest, data: await adminVendorData(id) });
};

adminVendorsRouter.get('/admin/vendors/:id/impact', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await vendorImpact(req.params.id) });
  } catch (err) {
    return fail(res, err, 'vendor impact');
  }
});

adminVendorsRouter.post('/admin/vendors/:id/suspend', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['reason', 'openOrders']);
    const reason = textField(b.reason, 'reason', 3, 200, 'Reason');
    const openOrders = enumField(b.openOrders, 'openOrders', ['REFUSE', 'CANCEL'] as const, 'REFUSE');
    return await answer(res, req.params.id, await suspendVendor({ vendorId: req.params.id, adminId: req.user!.id, reason, openOrders }));
  } catch (err) {
    return fail(res, err, 'suspend vendor');
  }
});

adminVendorsRouter.post('/admin/vendors/:id/reinstate', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    strictBody(req, []);
    return await answer(res, req.params.id, await reinstateVendor({ vendorId: req.params.id }));
  } catch (err) {
    return fail(res, err, 'reinstate vendor');
  }
});

adminVendorsRouter.post('/admin/vendors/:id/remove', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = strictBody(req, ['reason', 'confirmName', 'openOrders', 'disableOwner']);
    const reason = textField(b.reason, 'reason', 3, 200, 'Reason');
    const openOrders = enumField(b.openOrders, 'openOrders', ['REFUSE', 'CANCEL'] as const, 'REFUSE');
    const disableOwner = boolField(b.disableOwner, 'disableOwner', true);
    return await answer(res, req.params.id, await removeVendor({ vendorId: req.params.id, adminId: req.user!.id, reason, confirmName: b.confirmName, openOrders, disableOwner }));
  } catch (err) {
    return fail(res, err, 'remove vendor');
  }
});

adminVendorsRouter.post('/admin/vendors/:id/restore', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    strictBody(req, []);
    return await answer(res, req.params.id, await restoreVendor({ vendorId: req.params.id, adminId: req.user!.id }));
  } catch (err) {
    return fail(res, err, 'restore vendor');
  }
});
