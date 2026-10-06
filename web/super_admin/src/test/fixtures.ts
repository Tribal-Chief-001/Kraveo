// JSON fixtures in the exact shape the real backend sends (backend/src/services/catalog.ts adminDishView, previewPrice, pendingCount,
// recalculatePrices, setVendorCommission; backend/src/routes/catalog.ts settings views). Component tests build their data from these.
import { CatalogDish, PricePreview, parseDish } from '../lib/catalogParse';

/** `adminDishView(...)` of a live, approved dish: restaurant Rs 100, 12% global commission, customer Rs 112. */
export const rawDish = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'd1', vendorId: 'v1', vendorName: 'Sharma Dhaba', name: 'Paneer Roll', category: 'Rolls', description: '', imageUrl: 'https://img.example/roll.jpg',
  isVeg: true, isAvailable: true, rating: null, ratingCount: null,
  status: 'LIVE', approvalStatus: 'APPROVED', rejectionReason: null,
  vendorPrice: 100, pendingVendorPrice: null, price: 112, computedPrice: 112, priceIsStale: false, pendingPrice: null, effectiveCommission: 12,
  commission: { type: 'PERCENT', value: 12, source: 'GLOBAL' }, commissionOverride: null,
  createdBy: 'VENDOR', createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z', reviewedAt: null, reviewedByUserId: null, deletedAt: null,
  ...over,
});

export const pendingRaw = (over: Record<string, unknown> = {}) => rawDish({ status: 'PENDING', approvalStatus: 'PENDING', ...over });
export const changePendingRaw = (over: Record<string, unknown> = {}) => rawDish({ status: 'CHANGE_PENDING', pendingVendorPrice: 120, pendingPrice: 134, ...over });
export const deletedRaw = (over: Record<string, unknown> = {}) => rawDish({ deletedAt: '2026-10-07T00:00:00.000Z', ...over });

export const dish = (over: Record<string, unknown> = {}): CatalogDish => parseDish(rawDish(over))!;
export const pendingDish = (over: Record<string, unknown> = {}): CatalogDish => parseDish(pendingRaw(over))!;
export const changePendingDish = (over: Record<string, unknown> = {}): CatalogDish => parseDish(changePendingRaw(over))!;
export const deletedDish = (over: Record<string, unknown> = {}): CatalogDish => parseDish(deletedRaw(over))!;

/** `POST /admin/catalog/preview` data. */
export const rawPreview = (vendorPrice: number, over: Record<string, unknown> = {}) => ({
  vendorPrice, price: vendorPrice + 12, effectiveCommission: 12, nominalCommission: 12, commission: { type: 'PERCENT', value: 12, source: 'GLOBAL' }, roundingStep: 1, ...over,
});
export const preview = (vendorPrice: number, over: Partial<PricePreview> = {}): PricePreview => ({
  price: vendorPrice + 12, commission: 12, nominalCommission: 12, roundingStep: 1, rule: { type: 'PERCENT', value: 12, source: 'GLOBAL' }, ...over,
});

/** `GET /admin/catalog` envelope. */
export const rawList = (data: unknown[], over: Record<string, unknown> = {}) => ({ success: true, total: data.length, page: 1, pageSize: 25, pages: 1, data, count: data.length, ...over });

/** `GET/PUT /admin/settings/:group` data. */
export const settingView = (group: string, value: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ group, value, isDefault: false, updatedAt: '2026-10-06T10:00:00.000Z', updatedBy: 'admin1', ...over });
export const FEES_DEFAULT = { baseFee: 25, lines: [], extraRestaurantFee: 15, freeFeeAbove: 0, smallOrderBelow: 0, smallOrderFee: 0, gstOnFeesPercent: 18, gstOnFoodPercent: 5 };

// ───────────────────────────── Finance (Docs/21 section 5) ─────────────────────────────
// Shapes copied from backend/src/routes/finance.ts and services/{settlement,finance,payoutAccount,payoutProvider}.ts
// (and what backend/test/e2e/{settlement,finance,payout_accounts}.test.ts assert).

export const RANGE = { from: '2026-10-01', to: '2026-10-07', days: 7 };
const rawMoney = (over: Record<string, unknown> = {}) => ({ orders: 4, foodGross: 1000, vendorAmount: 900, commission: 100, feesCollected: 100, discounts: 30.5, platformRevenue: 169.5, ...over });

/** `financeSummary` */
export const rawSummary = (over: Record<string, unknown> = {}) => ({
  range: RANGE, ...rawMoney(), customerPaid: 1069.5, refunds: { count: 1, amount: 120 }, settledAmount: 600, unsettledAmount: 300, paidOutAmount: 450, ...over,
});
/** `financeByDay` (one row for every day, zeros included) */
export const rawByDay = () => ({
  success: true, range: RANGE,
  data: [
    { date: '2026-10-06', ...rawMoney({ orders: 0, foodGross: 0, vendorAmount: 0, commission: 0, feesCollected: 0, discounts: 0, platformRevenue: 0 }), refunds: { count: 0, amount: 0 } },
    { date: '2026-10-07', ...rawMoney(), refunds: { count: 1, amount: 120 } },
  ],
});
/** `financeByRestaurant` */
export const rawByRestaurant = () => ({
  success: true, range: RANGE, limit: 100,
  data: [{ vendorId: 'v1', vendorName: 'Sharma Dhaba', ...rawMoney(), unsettledAmount: 300, refunds: { count: 0, amount: 0 } }],
});
/** `financeByDish` */
export const rawByDish = (sort = 'units') => ({
  success: true, range: RANGE, top: 20, sort,
  data: [{ menuItemId: 'd1', name: 'Paneer Roll', vendorId: 'v1', vendorName: 'Sharma Dhaba', units: 12, customerRevenue: 1344, vendorRevenue: 1200, commission: 144 }],
});
/** `financeRiders` */
export const rawRiders = () => ({
  success: true, range: RANGE, limit: 100, totals: { riders: 2, deliveries: 7, payoutTotal: 250.5 },
  data: [
    { driverUserId: 'u-rider1', name: 'Ravi Kumar', runnerCode: 'R101', deliveries: 5, byDay: [{ date: '2026-10-06', deliveries: 2 }, { date: '2026-10-07', deliveries: 3 }], payouts: { count: 1, total: 250.5, lastAt: '2026-10-07T08:00:00.000Z' } },
    { driverUserId: 'u-rider2', name: null, runnerCode: null, deliveries: 2, byDay: [{ date: '2026-10-07', deliveries: 2 }], payouts: { count: 0, total: 0, lastAt: null } },
  ],
});

/** `adminSettlementView` */
export const rawSettlement = (over: Record<string, unknown> = {}) => ({
  id: 's1111111-aaaa', vendorId: 'v1', vendorName: 'Sharma Dhaba', batchKey: '2026-10-07', periodStart: '2026-10-06T10:00:00.000Z', periodEnd: '2026-10-07T16:30:00.000Z',
  status: 'PENDING', orderCount: 3, foodGross: 400, vendorAmount: 360, commissionAmount: 40, adjustmentTotal: 0, netPayable: 360,
  payoutSnapshot: { method: 'UPI', destination: 'kitchen1@upi', accountHolder: 'Kitchen One', ifsc: null, bankName: null, verified: false }, hasPayoutDetails: true,
  paidAt: null, paymentReference: null, paidBy: null, note: null, createdBy: 'AUTO', createdAt: '2026-10-07T16:31:00.000Z', updatedAt: '2026-10-07T16:31:00.000Z', ...over,
});
/** `listSettlements` envelope */
export const rawSettlementList = (data: unknown[], summary: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  success: true, total: data.length, page: 1, pageSize: 25, pages: 1,
  summary: { PENDING: { count: data.length, netPayable: 360 }, ON_HOLD: { count: 0, netPayable: 0 }, PAID: { count: 0, netPayable: 0 }, CANCELLED: { count: 0, netPayable: 0 }, ...summary },
  data, count: data.length, ...over,
});
/** `adminAccountView` (masked) */
export const rawAccount = (over: Record<string, unknown> = {}) => ({
  userId: 'u-owner1', partnerType: 'VENDOR', method: 'BANK', upiId: null, accountHolder: 'Ram Singh', accountLast4: '7890', ifsc: 'HDFC0001234', bankName: 'HDFC Bank',
  verifiedAt: null, updatedAt: '2026-10-06T10:00:00.000Z', accountMasked: 'XXXXXX7890', verifiedBy: null, ...over,
});
/** `settlementDetail` data */
export const rawSettlementDetail = (over: Record<string, unknown> = {}) => ({
  settlement: rawSettlement(),
  vendor: { id: 'v1', name: 'Sharma Dhaba', userId: 'u-owner1' },
  payoutAccount: rawAccount(),
  orders: [{ id: 'order-aaaa-1111', deliveredAt: '2026-10-07T10:00:00.000Z', subtotal: 200, vendorSubtotal: 180, commissionTotal: 20, deliveryFee: 25, taxAndPackaging: 0, discount: 0, totalAmount: 225, couponCode: null }],
  ordersTruncated: false,
  adjustments: [{ id: 'a1', amount: -10.5, reason: 'Late handover', createdBy: 'admin1', createdAt: '2026-10-07T17:00:00.000Z' }],
  dishes: [{ menuItemId: 'd1', name: 'Paneer Roll', units: 4, vendorRevenue: 360, commission: 40 }],
  ...over,
});
/** Action answer (mark-paid, hold, release, adjustments, cancel) */
export const rawAction = (settlement: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ success: true, changed: true, message: 'Done.', data: settlement, ...over });
/** `createSettlements` answer of POST /admin/settlements/run */
export const rawRun = (created: unknown[] = [rawSettlement()]) => ({
  success: true, message: `${created.length} settlement(s) created for 3 order(s).`,
  data: { cutoff: '2026-10-07T17:00:00.000Z', holdDays: 0, deliveredBy: '2026-10-07T17:00:00.000Z', created, skipped: [], failed: [], orderCount: 3, netPayable: 360 },
});
/** `riderPayoutView` */
export const rawRiderPayout = (over: Record<string, unknown> = {}) => ({
  id: 'p1', driverUserId: 'u-rider1', driverName: 'Ravi Kumar', amount: 250.5, method: 'UPI', reference: 'UTR123456', periodStart: null, periodEnd: null, note: null, createdBy: 'admin1', createdAt: '2026-10-07T08:00:00.000Z', ...over,
});
export const rawRiderPayoutList = (data: unknown[] = [rawRiderPayout()]) => ({ success: true, total: data.length, page: 1, pageSize: 25, pages: 1, totalAmount: 250.5, data, count: data.length });
/** `payoutProviderStatus` */
export const rawProviders = (razorpayxEnabled = false) => ({
  success: true,
  data: [{ name: 'manual', enabled: true, reason: null }, { name: 'razorpayx', enabled: razorpayxEnabled, reason: razorpayxEnabled ? null : 'RazorpayX payouts are not configured.' }],
});
/** GET /admin/partners/:userId/payout-account */
export const rawAccountResponse = (account: unknown = rawAccount()) => ({ success: true, partner: { userId: 'u-owner1', name: 'PA Owner One', role: 'VENDOR' }, data: account });
/** POST .../reveal */
export const rawReveal = () => ({ success: true, data: { userId: 'u-owner1', partnerType: 'VENDOR', method: 'BANK', upiId: null, accountHolder: 'Ram Singh', accountNumber: '50100234567890', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' } });
