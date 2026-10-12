import { Router, Request, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { fail, validParams } from '../utils/http';
import {
  createCategory, deleteCategory, listAdminCategories, listPublicCategories, mergeCategory, patchCategory, reorderCategories,
} from '../services/categories';

/**
 * Managed categories (Docs/23 sections 3.1 and 3.2). GET /categories is public (customer and restaurant apps, no login);
 * everything under /admin/categories is ADMIN only, audit-logged by the service and rate limited in middleware/rateLimit.ts.
 */
export const categoriesRouter = Router();

const adminOnly = [requireAuth, requireRole('ADMIN')] as const;
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const actorOf = (req: AuthenticatedRequest) => ({ id: req.user!.id, role: req.user!.role as string });

categoriesRouter.get('/categories', async (req: Request, res: Response) => {
  try {
    const data = await listPublicCategories(typeof req.query.for === 'string' ? req.query.for : req.query.for === undefined ? undefined : '?');
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    return fail(res, err, 'list public categories');
  }
});

categoriesRouter.get('/admin/categories', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const flag = req.query.includeInactive;
    const data = await listAdminCategories(flag === '1' || flag === 'true');
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    return fail(res, err, 'list admin categories');
  }
});

categoriesRouter.post('/admin/categories', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await createCategory(body(req), actorOf(req));
    return res.status(201).json({ success: true, message: 'Category created.', data });
  } catch (err) {
    return fail(res, err, 'create category');
  }
});

// Declared before '/:id' routes so that "reorder" is never read as an id.
categoriesRouter.post('/admin/categories/reorder', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await reorderCategories(body(req).ids, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Order saved.' : 'The order was already like this.', data: out.data });
  } catch (err) {
    return fail(res, err, 'reorder categories');
  }
});

categoriesRouter.patch('/admin/categories/:id', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await patchCategory(req.params.id, body(req), actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Category saved.' : 'Nothing to change.', data: out.data });
  } catch (err) {
    return fail(res, err, 'edit category');
  }
});

categoriesRouter.post('/admin/categories/:id/merge', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await mergeCategory(req.params.id, body(req), actorOf(req));
    const message = out.dryRun
      ? `Merging would move ${out.dishes} dish${out.dishes === 1 ? '' : 'es'} and ${out.restaurants} restaurant${out.restaurants === 1 ? '' : 's'}. Nothing was changed.`
      : `Merged. Moved ${out.dishes} dish${out.dishes === 1 ? '' : 'es'} and ${out.restaurants} restaurant${out.restaurants === 1 ? '' : 's'}.`;
    return res.json({ success: true, message, data: out });
  } catch (err) {
    return fail(res, err, 'merge category');
  }
});

categoriesRouter.delete('/admin/categories/:id', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await deleteCategory(req.params.id, actorOf(req));
    return res.json({ success: true, message: 'Category deleted.', data: out });
  } catch (err) {
    return fail(res, err, 'delete category');
  }
});
