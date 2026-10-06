import { Router, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { requireApprovedPartner } from './partners';
import { fail, validParams, ID_RE } from '../utils/http';
import { AppError } from '../utils/appError';
import { parseIstRange, parsePaging } from '../utils/range';
import { addIstDays, isIstDateString, istDayStartOf } from '../utils/time';
import {
  adminAccountView, getAccount, partnerAccountView, partnerUser, revealAccountNumber, saveAccount, setVerified, PartnerType,
} from '../services/payoutAccount';
import {
  addAdjustment, adminSettlementView, cancelSettlement, createSettlements, holdSettlement, listSettlements, listVendorSettlements, markPaid, releaseSettlement,
  settlementCsv, settlementDetail, settlementsCsv, vendorSettlementDetail,
} from '../services/settlement';
import { payoutProviderStatus } from '../services/payoutProvider';
import {
  createRiderPayout, DISH_SORTS, financeByDay, financeByDish, financeByRestaurant, financeRiders, financeSummary, listRiderPayouts, riderPayoutView,
} from '../services/finance';

/**
 * Phase 2 of Docs/21: payout details, settlements, finance analytics and the rider payout ledger.
 *
 *  Partner (restaurant / rider, own data only):  GET/PUT /partner/payout-account (masked), GET /partner/settlements[/:id] (restaurant amounts only)
 *  Admin:  /admin/partners/:userId/payout-account[/verify|/reveal], /admin/settlements*, /admin/finance/*, /admin/rider-payouts, /admin/payout-providers
 * Every admin write is audit-logged by the service and rate limited in middleware/rateLimit.ts.
 */
export const financeRouter = Router();

const adminOnly = [requireAuth, requireRole('ADMIN')] as const;
const body = (req: AuthenticatedRequest): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const actorOf = (req: AuthenticatedRequest) => ({ id: req.user!.id, role: req.user!.role as string });
const idQuery = (v: unknown, field: string): string | undefined => {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new AppError(400, 'BAD_REQUEST', `Invalid ${field}.`, field);
  return v;
};
const intQuery = (v: unknown, field: string, def: number, min: number, max: number): number => {
  if (v === undefined || v === '') return def;
  if (typeof v !== 'string' || !/^\d{1,6}$/.test(v) || Number(v) < min || Number(v) > max) throw new AppError(400, 'BAD_REQUEST', `${field} must be a whole number from ${min} to ${max}.`, field);
  return Number(v);
};
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

// ----------------------------------------------------------------------------
// Payout details: the partner's own account (masked)
// ----------------------------------------------------------------------------
financeRouter.get('/partner/payout-account', requireAuth, requireRole('VENDOR', 'DRIVER'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await getAccount(req.user!.id);
    noStore(res);
    return res.json({ success: true, data: row ? partnerAccountView(row) : null });
  } catch (err) {
    return fail(res, err, 'get payout account');
  }
});

financeRouter.put('/partner/payout-account', requireAuth, requireRole('VENDOR', 'DRIVER'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await saveAccount(req.user!.id, req.user!.role as PartnerType, req.body, actorOf(req));
    noStore(res);
    return res.json({
      success: true,
      changed: out.changed,
      message: out.changed ? 'Payout details saved. Kraveo will check them before the first payout.' : 'These payout details were already saved.',
      data: partnerAccountView(out.row),
    });
  } catch (err) {
    return fail(res, err, 'save payout account');
  }
});

// ----------------------------------------------------------------------------
// Payout details: admin
// ----------------------------------------------------------------------------
financeRouter.get('/admin/partners/:userId/payout-account', ...adminOnly, validParams('userId'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const partner = await partnerUser(req.params.userId);
    const row = await getAccount(partner.id);
    noStore(res);
    return res.json({ success: true, partner: { userId: partner.id, name: partner.name, role: partner.role }, data: row ? adminAccountView(row) : null });
  } catch (err) {
    return fail(res, err, 'admin get payout account');
  }
});

financeRouter.put('/admin/partners/:userId/payout-account', ...adminOnly, validParams('userId'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const partner = await partnerUser(req.params.userId);
    const out = await saveAccount(partner.id, partner.role, req.body, actorOf(req));
    noStore(res);
    return res.json({
      success: true,
      changed: out.changed,
      message: out.changed ? 'Payout details saved. Verification was cleared: verify them again.' : 'These payout details were already saved.',
      partner: { userId: partner.id, name: partner.name, role: partner.role },
      data: adminAccountView(out.row),
    });
  } catch (err) {
    return fail(res, err, 'admin save payout account');
  }
});

financeRouter.patch('/admin/partners/:userId/payout-account/verify', ...adminOnly, validParams('userId'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const partner = await partnerUser(req.params.userId);
    const out = await setVerified(partner.id, body(req).verified, actorOf(req));
    const verified = !!out.row.verifiedAt;
    return res.json({ success: true, changed: out.changed, message: out.changed ? (verified ? 'Marked as verified.' : 'Verification removed.') : `Already ${verified ? 'verified' : 'not verified'}.`, data: adminAccountView(out.row) });
  } catch (err) {
    return fail(res, err, 'verify payout account');
  }
});

financeRouter.post('/admin/partners/:userId/payout-account/reveal', ...adminOnly, validParams('userId'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const partner = await partnerUser(req.params.userId);
    const { row, accountNumber } = await revealAccountNumber(partner.id, actorOf(req));
    noStore(res);
    return res.json({
      success: true,
      data: { userId: partner.id, partnerType: row.partnerType, method: row.method, upiId: row.upiId, accountHolder: row.accountHolder, accountNumber, ifsc: row.ifsc, bankName: row.bankName },
    });
  } catch (err) {
    return fail(res, err, 'reveal payout account');
  }
});

// ----------------------------------------------------------------------------
// Settlements: admin
// ----------------------------------------------------------------------------
financeRouter.get('/admin/payout-providers', ...adminOnly, (_req: AuthenticatedRequest, res: Response) => res.json({ success: true, data: payoutProviderStatus() }));

financeRouter.get('/admin/settlements', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const q = req.query;
    if (q.status !== undefined && typeof q.status !== 'string') throw new AppError(400, 'BAD_REQUEST', 'Invalid status.', 'status');
    const range = q.from !== undefined || q.to !== undefined ? parseIstRange(q.from, q.to, { defaultDays: 31, maxDays: 3660 }) : undefined;
    const out = await listSettlements({ status: q.status as string | undefined, vendorId: idQuery(q.vendorId, 'vendorId'), range, ...parsePaging(q.page, q.pageSize ?? q.limit) });
    return res.json({ success: true, ...out, count: out.data.length });
  } catch (err) {
    return fail(res, err, 'list settlements');
  }
});

// Registered before /:id so "export.csv" is never read as an id.
financeRouter.get('/admin/settlements/export.csv', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await settlementsCsv(parseIstRange(req.query.from, req.query.to, { defaultDays: 31, maxDays: 366 }));
    return sendCsv(res, out);
  } catch (err) {
    return fail(res, err, 'export settlements csv');
  }
});

const sendCsv = (res: Response, out: { filename: string; body: string }) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(out.body);
};

financeRouter.post('/admin/settlements/run', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = body(req);
    const extra = Object.keys(b).find((k) => !['vendorId', 'until'].includes(k));
    if (extra) throw new AppError(400, 'BAD_REQUEST', `Unknown field '${extra.slice(0, 40)}'.`, extra);
    const vendorId = idQuery(b.vendorId, 'vendorId');
    let until: Date | undefined;
    if (b.until !== undefined && b.until !== null && b.until !== '') {
      if (typeof b.until !== 'string') throw new AppError(400, 'BAD_REQUEST', 'until must be a date (YYYY-MM-DD, end of that India day) or an ISO 8601 time.', 'until');
      // A plain date means "up to the end of that India day".
      until = isIstDateString(b.until) ? new Date(istDayStartOf(addIstDays(b.until, 1)).getTime() - 1) : new Date(b.until);
      if (!Number.isFinite(until.getTime()) || until.getFullYear() < 2020) throw new AppError(400, 'BAD_REQUEST', 'until must be a date (YYYY-MM-DD, end of that India day) or an ISO 8601 time.', 'until');
    }
    const out = await createSettlements({ until, vendorId, createdBy: req.user!.id });
    const message = out.created.length > 0 ? `${out.created.length} settlement(s) created for ${out.orderCount} order(s).` : 'Nothing to settle: no delivered, paid order is waiting.';
    return res.json({ success: true, message, data: out });
  } catch (err) {
    return fail(res, err, 'run settlements');
  }
});

financeRouter.get('/admin/settlements/:id', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await settlementDetail(req.params.id) });
  } catch (err) {
    return fail(res, err, 'get settlement');
  }
});

financeRouter.get('/admin/settlements/:id/export.csv', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    return sendCsv(res, await settlementCsv(req.params.id));
  } catch (err) {
    return fail(res, err, 'export settlement csv');
  }
});

financeRouter.post('/admin/settlements/:id/mark-paid', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await markPaid(req.params.id, req.body, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Marked as paid.' : 'Already marked as paid with this reference.', data: adminSettlementView(out.row) });
  } catch (err) {
    return fail(res, err, 'mark settlement paid');
  }
});

financeRouter.post('/admin/settlements/:id/hold', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await holdSettlement(req.params.id, req.body, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Put on hold.' : 'Already on hold.', data: adminSettlementView(out.row) });
  } catch (err) {
    return fail(res, err, 'hold settlement');
  }
});

financeRouter.post('/admin/settlements/:id/release', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await releaseSettlement(req.params.id, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? 'Released.' : 'It was not on hold.', data: adminSettlementView(out.row) });
  } catch (err) {
    return fail(res, err, 'release settlement');
  }
});

financeRouter.post('/admin/settlements/:id/adjustments', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await addAdjustment(req.params.id, req.body, actorOf(req));
    const a = out.adjustment;
    return res.status(out.changed ? 201 : 200).json({
      success: true,
      changed: out.changed,
      message: out.changed ? 'Adjustment added.' : 'This adjustment was already added.',
      data: adminSettlementView(out.row),
      adjustment: { id: a.id, amount: a.amount, reason: a.reason, createdBy: a.createdBy, createdAt: a.createdAt.toISOString() },
    });
  } catch (err) {
    return fail(res, err, 'adjust settlement');
  }
});

financeRouter.post('/admin/settlements/:id/cancel', ...adminOnly, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await cancelSettlement(req.params.id, actorOf(req));
    return res.json({ success: true, changed: out.changed, message: out.changed ? `Cancelled. ${out.freed} order(s) will be settled again by the next run.` : 'Already cancelled.', freedOrders: out.freed, data: adminSettlementView(out.row) });
  } catch (err) {
    return fail(res, err, 'cancel settlement');
  }
});

// ----------------------------------------------------------------------------
// Settlements: the restaurant's own, read only (restaurant amounts only)
// ----------------------------------------------------------------------------
financeRouter.get('/partner/settlements', requireAuth, requireRole('VENDOR'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await listVendorSettlements(req.user!.id, parsePaging(req.query.page, req.query.pageSize ?? req.query.limit));
    return res.json({ success: true, ...out, count: out.data.length });
  } catch (err) {
    return fail(res, err, 'list partner settlements');
  }
});

financeRouter.get('/partner/settlements/:id', requireAuth, requireRole('VENDOR'), requireApprovedPartner, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await vendorSettlementDetail(req.user!.id, req.params.id) });
  } catch (err) {
    return fail(res, err, 'get partner settlement');
  }
});

// ----------------------------------------------------------------------------
// Finance analytics (admin, Asia/Kolkata days, default last 7, at most 366)
// ----------------------------------------------------------------------------
const financeRange = (req: AuthenticatedRequest) => parseIstRange(req.query.from, req.query.to, { defaultDays: 7, maxDays: 366 });

financeRouter.get('/admin/finance/summary', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await financeSummary(financeRange(req)) });
  } catch (err) {
    return fail(res, err, 'finance summary');
  }
});

financeRouter.get('/admin/finance/by-restaurant', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const range = financeRange(req);
    return res.json({ success: true, ...(await financeByRestaurant(range, intQuery(req.query.limit, 'limit', 100, 1, 200))) });
  } catch (err) {
    return fail(res, err, 'finance by restaurant');
  }
});

financeRouter.get('/admin/finance/by-dish', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const range = financeRange(req);
    const sort = req.query.sort === undefined || req.query.sort === '' ? 'units' : req.query.sort;
    if (typeof sort !== 'string' || !(DISH_SORTS as readonly string[]).includes(sort)) throw new AppError(400, 'BAD_REQUEST', `sort must be one of ${DISH_SORTS.join(', ')}.`, 'sort');
    const out = await financeByDish(range, { top: intQuery(req.query.top ?? req.query.limit, 'top', 20, 1, 200), sort: sort as (typeof DISH_SORTS)[number], vendorId: idQuery(req.query.vendorId, 'vendorId') });
    return res.json({ success: true, ...out });
  } catch (err) {
    return fail(res, err, 'finance by dish');
  }
});

financeRouter.get('/admin/finance/by-day', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, ...(await financeByDay(financeRange(req))) });
  } catch (err) {
    return fail(res, err, 'finance by day');
  }
});

financeRouter.get('/admin/finance/riders', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const range = financeRange(req);
    return res.json({ success: true, ...(await financeRiders(range, intQuery(req.query.limit, 'limit', 100, 1, 200))) });
  } catch (err) {
    return fail(res, err, 'finance riders');
  }
});

// ----------------------------------------------------------------------------
// Rider payout ledger (records only)
// ----------------------------------------------------------------------------
financeRouter.get('/admin/rider-payouts', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const q = req.query;
    const range = q.from !== undefined || q.to !== undefined ? parseIstRange(q.from, q.to, { defaultDays: 31, maxDays: 3660 }) : undefined;
    const out = await listRiderPayouts({ driverUserId: idQuery(q.driverUserId, 'driverUserId'), range, ...parsePaging(q.page, q.pageSize ?? q.limit) });
    return res.json({ success: true, ...out, count: out.data.length });
  } catch (err) {
    return fail(res, err, 'list rider payouts');
  }
});

financeRouter.post('/admin/rider-payouts', ...adminOnly, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const out = await createRiderPayout(req.body, actorOf(req));
    return res.status(out.changed ? 201 : 200).json({ success: true, changed: out.changed, message: out.changed ? 'Payout recorded.' : 'This payout was already recorded.', data: riderPayoutView(out.row, out.driverName) });
  } catch (err) {
    return fail(res, err, 'record rider payout');
  }
});
