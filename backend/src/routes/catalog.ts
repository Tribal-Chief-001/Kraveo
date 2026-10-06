import { Router, Response } from 'express';
import { prisma } from '../db';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { requireApprovedPartner } from './partners';
import { fail, validParams, ID_RE } from '../utils/http';
import { AppError } from '../utils/appError';
import { vendorMenuItemView } from '../utils/catalog';
import {
  adminCreateDish, adminDishView, adminEditDish, approveDish, listCatalog, pendingCount, previewPrice, recalculatePrices, rejectDish,
  restoreDish, setVendorCommission, softDeleteDish, vendorDishes,
} from '../services/catalog';
import { getSettingGroup, getSettings, updateSettingGroup } from '../services/settings';
import { isSettingGroup, SETTING_GROUPS } from '../services/pricing';

/**
 * Catalog, pricing and settings endpoints (Docs/21 section 4). Restaurant side: GET /vendors/:id/menu-manage (the restaurant's own
 * price and a status, never the customer price or the commission). Admin side: /admin/catalog*, /admin/settings*, /admin/vendors/:id/commission.
 * Every admin write is audit-logged by the service and rate limited in middleware/rateLimit.ts.
 */
export const catalogRouter = Router();

const adminOnly = [requireAuth, requireRole('ADMIN')] as const;
const body = (req: AuthenticatedRequest): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const actorOf = (req: AuthenticatedRequest) => ({ id: req.user!.id, role: req.user!.role as string });
const intParam = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) return undefined;
  return Number.parseInt(v, 10);
};

// ----------------------------------------------------------------------------
// Restaurant: its own menu with approval status
// ----------------------------------------------------------------------------
catalogRouter.get('/vendors/:id/menu-manage', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { id: true, userId: true } });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    if (req.user!.role !== 'ADMIN' && vendor.userId !== req.user!.id) return res.status(403).json({ success: false, message: 'Forbidden. You do not own this vendor.' });
    const rows = await vendorDishes(vendor.id);
    const data = rows.map(vendorMenuItemView);
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    return fail(res, err, 'menu-manage');
  }
});

// ----------------------------------------------------------------------------
// Admin: catalog
// ----------------------------------------------------------------------------
catalogRouter.get('/admin/catalog', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const q = req.query;
    if (q.vendorId !== undefined && (typeof q.vendorId !== 'string' || !ID_RE.test(q.vendorId))) throw new AppError(400, 'BAD_REQUEST', 'Invalid vendorId.', 'vendorId');
    const out = await listCatalog({
      status: typeof q.status === 'string' ? q.status : undefined,
      vendorId: typeof q.vendorId === 'string' ? q.vendorId : undefined,
      q: typeof q.q === 'string' ? q.q : undefined,
      page: intParam(q.page),
      pageSize: intParam(q.pageSize) ?? intParam(q.limit),
    });
    return res.json({ success: true, ...out, count: out.data.length });
  } catch (err) {
    return fail(res, err, 'list catalog');
  }
});

catalogRouter.get('/admin/catalog/pending-count', ...adminOnly, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await pendingCount() });
  } catch (err) {
    return fail(res, err, 'catalog pending count');
  }
});

catalogRouter.post('/admin/catalog/preview', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await previewPrice(body(req)) });
  } catch (err) {
    return fail(res, err, 'catalog preview');
  }
});

catalogRouter.post('/admin/catalog/recalculate', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = body(req);
    if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw new AppError(400, 'BAD_REQUEST', 'dryRun must be true or false.', 'dryRun');
    if (b.vendorId !== undefined && (typeof b.vendorId !== 'string' || !ID_RE.test(b.vendorId))) throw new AppError(400, 'BAD_REQUEST', 'Invalid vendorId.', 'vendorId');
    // Safe by default: nothing is written unless the admin explicitly sends dryRun:false.
    const out = await recalculatePrices({ dryRun: b.dryRun !== false, vendorId: b.vendorId as string | undefined }, actorOf(req));
    return res.json({ success: true, message: out.dryRun ? `${out.changed} of ${out.total} dishes would change.` : `${out.changed} of ${out.total} dishes updated.`, data: out });
  } catch (err) {
    return fail(res, err, 'recalculate prices');
  }
});

catalogRouter.post('/admin/catalog', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await adminCreateDish(body(req), actorOf(req));
    return res.status(201).json({ success: true, message: 'Dish created and live.', data: adminDishView(out.item, out.settings) });
  } catch (err) {
    return fail(res, err, 'create catalog dish');
  }
});

catalogRouter.get('/admin/catalog/:id', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const item = await prisma.menuItem.findUnique({ where: { id: req.params.id }, include: { vendor: { select: { id: true, name: true, userId: true, commissionType: true, commissionValue: true } } } });
    if (!item) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Menu item not found.' });
    return res.json({ success: true, data: adminDishView(item, await getSettings()) });
  } catch (err) {
    return fail(res, err, 'get catalog dish');
  }
});

catalogRouter.post('/admin/catalog/:id/approve', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await approveDish(req.params.id, body(req), actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Dish approved.' : 'Nothing to change: the dish is already approved with these values.', data: adminDishView(out.item, out.settings), preview: out.preview });
  } catch (err) {
    return fail(res, err, 'approve dish');
  }
});

catalogRouter.post('/admin/catalog/:id/reject', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await rejectDish(req.params.id, body(req).reason, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Dish rejected.' : 'Already rejected with this reason.', data: adminDishView(out.item, out.settings) });
  } catch (err) {
    return fail(res, err, 'reject dish');
  }
});

catalogRouter.patch('/admin/catalog/:id', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await adminEditDish(req.params.id, body(req), actorOf(req));
    return res.json({ success: true, message: 'Dish updated.', data: adminDishView(out.item, out.settings), preview: out.preview });
  } catch (err) {
    return fail(res, err, 'edit dish');
  }
});

catalogRouter.delete('/admin/catalog/:id', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await softDeleteDish(req.params.id, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Dish deleted.' : 'Dish was already deleted.', data: adminDishView(out.item, out.settings) });
  } catch (err) {
    return fail(res, err, 'delete dish');
  }
});

catalogRouter.post('/admin/catalog/:id/restore', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await restoreDish(req.params.id, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Dish restored.' : 'Dish was not deleted.', data: adminDishView(out.item, out.settings) });
  } catch (err) {
    return fail(res, err, 'restore dish');
  }
});

// ----------------------------------------------------------------------------
// Admin: restaurant commission and settings
// ----------------------------------------------------------------------------
catalogRouter.patch('/admin/vendors/:id/commission', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await setVendorCommission(req.params.id, body(req));
    return res.json({ success: true, message: out.staleDishes > 0 ? `Saved. ${out.staleDishes} dish prices are out of date: run "Recalculate prices".` : 'Saved.', data: out });
  } catch (err) {
    return fail(res, err, 'set vendor commission');
  }
});

const settingView = (group: string, value: unknown, meta: { isDefault: boolean; updatedAt: string | null; updatedBy: string | null }) => ({ group, value, ...meta });

catalogRouter.get('/admin/settings', ...adminOnly, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await Promise.all(SETTING_GROUPS.map(async (g) => { const s = await getSettingGroup(g); return settingView(g, s.value, s.meta); }));
    return res.json({ success: true, data });
  } catch (err) {
    return fail(res, err, 'list settings');
  }
});

catalogRouter.get('/admin/settings/:group', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const group = req.params.group;
    if (!isSettingGroup(group)) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: `Unknown settings group. Use one of: ${SETTING_GROUPS.join(', ')}.` });
    const s = await getSettingGroup(group);
    return res.json({ success: true, data: settingView(group, s.value, s.meta) });
  } catch (err) {
    return fail(res, err, 'get settings');
  }
});

// The body IS the group (for example {"baseFee":30}); keys left out keep their value, unknown keys and invalid values are refused as a whole.
catalogRouter.put('/admin/settings/:group', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const group = req.params.group;
    if (!isSettingGroup(group)) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: `Unknown settings group. Use one of: ${SETTING_GROUPS.join(', ')}.` });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new AppError(400, 'BAD_REQUEST', 'Send the settings as a JSON object.', group);
    const out = await updateSettingGroup(group, req.body, req.user!.id);
    const needsRecalc = out.changed && (group === 'commission' || group === 'rounding');
    return res.json({
      success: true,
      changed: out.changed,
      message: needsRecalc ? 'Saved. Existing dish prices keep their old value until you run "Recalculate prices".' : 'Saved.',
      ...(needsRecalc ? { recalculateRecommended: true } : {}),
      data: settingView(group, out.value, out.meta),
    });
  } catch (err) {
    return fail(res, err, 'update settings');
  }
});
