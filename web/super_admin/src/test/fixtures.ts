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
