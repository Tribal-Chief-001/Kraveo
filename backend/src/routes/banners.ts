import express, { Router, Request, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { fail, validParams } from '../utils/http';
import { EVENTS_JSON_LIMIT } from '../middleware/bodyLimits';
import {
  createBanner, deleteBanner, duplicateBanner, listAdminBanners, listPublicBanners, patchBanner, recordBannerEvents, reorderBanners,
} from '../services/banners';

/**
 * Home banners (Docs/25 sections 1-2). GET /banners and POST /banners/events are public (customer app, no login, rate limited by IP in
 * middleware/rateLimit.ts); everything under /admin/banners is ADMIN only, audit-logged by the service and rate limited.
 */
export const bannersRouter = Router();

const adminOnly = [requireAuth, requireRole('ADMIN')] as const;
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const actorOf = (req: AuthenticatedRequest) => ({ id: req.user!.id, role: req.user!.role as string });

bannersRouter.get('/banners', async (_req: Request, res: Response) => {
  try {
    const data = await listPublicBanners();
    res.set('Cache-Control', 'public, max-age=30');
    return res.json({ success: true, data });
  } catch (err) {
    return fail(res, err, 'list public banners');
  }
});

// The global json parser skips this path (middleware/bodyLimits.ts): a body over 2 KB is refused here with 413 before it is read.
bannersRouter.post('/banners/events', express.json({ limit: EVENTS_JSON_LIMIT, inflate: false }), async (req: Request, res: Response) => {
  await recordBannerEvents(req.body); // memory only (no database write here), never throws, ignores everything unusable
  return res.json({ success: true });
});

bannersRouter.get('/admin/banners', ...adminOnly, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await listAdminBanners();
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    return fail(res, err, 'list admin banners');
  }
});

bannersRouter.post('/admin/banners', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await createBanner(body(req), actorOf(req));
    return res.status(201).json({ success: true, message: 'Banner created.', data });
  } catch (err) {
    return fail(res, err, 'create banner');
  }
});

// Declared before '/:id' routes so that "reorder" is never read as an id.
bannersRouter.post('/admin/banners/reorder', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await reorderBanners(body(req).ids, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Order saved.' : 'The order was already like this.', data: out.data });
  } catch (err) {
    return fail(res, err, 'reorder banners');
  }
});

bannersRouter.patch('/admin/banners/:id', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await patchBanner(req.params.id, body(req), actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Banner saved.' : 'Nothing to change.', data: out.data });
  } catch (err) {
    return fail(res, err, 'edit banner');
  }
});

bannersRouter.post('/admin/banners/:id/duplicate', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await duplicateBanner(req.params.id, actorOf(req));
    return res.status(201).json({ success: true, message: 'Banner duplicated. The copy is switched off.', data });
  } catch (err) {
    return fail(res, err, 'duplicate banner');
  }
});

bannersRouter.delete('/admin/banners/:id', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await deleteBanner(req.params.id, actorOf(req));
    return res.json({ success: true, message: data.deleted ? 'Banner deleted.' : 'The banner was already deleted.', data });
  } catch (err) {
    return fail(res, err, 'delete banner');
  }
});
