// ONE place that turns the backend's catalog / settings responses into the shapes the dashboard uses (Docs/21 section 4).
// The shapes below are the REAL ones from backend/src/routes/catalog.ts and services/catalog.ts. Parsers still never throw:
// they return null (or null fields) when an answer cannot be understood, and the caller then shows a plain message.

import type { CommissionType, FeeLine } from './pricing';

export type CommissionSource = 'DISH' | 'VENDOR' | 'GLOBAL';

export type DishState = 'LIVE' | 'PENDING' | 'CHANGE_PENDING' | 'REJECTED' | 'DELETED';

export interface CatalogDish {
  id: string;
  name: string;
  description: string;
  category: string;
  imageUrl: string | null;
  isVeg: boolean;
  isAvailable: boolean;
  vendorId: string;
  vendorName: string;
  /** What the restaurant asked for (its own price). */
  vendorPrice: number | null;
  /** The final price the customer pays (`price` on the server). */
  price: number | null;
  /** The customer price today's rules would give; differs from `price` until "Recalculate prices" runs. */
  computedPrice: number | null;
  priceIsStale: boolean;
  /** The dish's own commission override (`commissionOverride`); null = inherits the restaurant or global default. */
  commissionOverride: { type: CommissionType; value: number } | null;
  /** The rule that applies now and where it comes from. */
  commission: { type: CommissionType; value: number; source: CommissionSource } | null;
  /** price - vendorPrice, so it already includes rounding. */
  effectiveCommission: number | null;
  /** A restaurant's requested new price for a live dish, and the customer price it would get. */
  pendingVendorPrice: number | null;
  pendingPrice: number | null;
  approvalStatus: string;
  state: DishState;
  rejectionReason: string | null;
  deletedAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CatalogPage {
  items: CatalogDish[];
  page: number;
  pageSize: number | null;
  total: number | null;
  totalPages: number | null;
  hasMore: boolean;
}

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const asNum = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const asStr = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

const commissionType = (value: unknown): CommissionType | null => {
  const text = typeof value === 'string' ? value.toUpperCase() : '';
  return text === 'PERCENT' || text === 'FLAT' ? text : null;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** `{ data: X }` or X. */
export const unwrap = (body: unknown): unknown => (isObject(body) && 'data' in body && body.data !== undefined && body.data !== null ? body.data : body);

const stateOf = (raw: Record<string, any>, pending: number | null): DishState => {
  if (asStr(raw.deletedAt)) return 'DELETED';
  const status = String(raw.status ?? '').toUpperCase();
  if (status === 'PENDING' || status === 'REJECTED' || status === 'CHANGE_PENDING' || status === 'LIVE') return status;
  const approval = String(raw.approvalStatus ?? '').toUpperCase();
  if (approval === 'PENDING') return 'PENDING';
  if (approval === 'REJECTED') return 'REJECTED';
  return pending !== null ? 'CHANGE_PENDING' : 'LIVE';
};

const parseRule = (raw: unknown): { type: CommissionType; value: number } | null => {
  if (!isObject(raw)) return null;
  const type = commissionType(raw.type);
  const value = asNum(raw.value);
  return type && value !== null ? { type, value } : null;
};

const SOURCES: CommissionSource[] = ['DISH', 'VENDOR', 'GLOBAL'];

export const parseDish = (raw: unknown): CatalogDish | null => {
  if (!isObject(raw) || (typeof raw.id !== 'string' && typeof raw.id !== 'number')) return null;
  const vendor = isObject(raw.vendor) ? raw.vendor : {};
  const vendorPrice = asNum(raw.vendorPrice);
  const price = asNum(raw.price);
  const pendingVendorPrice = asNum(raw.pendingVendorPrice);
  const rule = parseRule(raw.commission);
  const source = isObject(raw.commission) && SOURCES.includes(raw.commission.source) ? (raw.commission.source as CommissionSource) : null;
  return {
    id: String(raw.id),
    name: asStr(raw.name) ?? 'Unnamed dish',
    description: typeof raw.description === 'string' ? raw.description : '',
    category: asStr(raw.category) ?? '',
    imageUrl: asStr(raw.imageUrl),
    isVeg: raw.isVeg === true,
    isAvailable: raw.isAvailable !== false,
    vendorId: String(raw.vendorId ?? vendor.id ?? ''),
    vendorName: asStr(raw.vendorName ?? vendor.name) ?? 'Unknown restaurant',
    vendorPrice,
    price,
    computedPrice: asNum(raw.computedPrice),
    priceIsStale: raw.priceIsStale === true,
    commissionOverride: parseRule(raw.commissionOverride),
    commission: rule && source ? { ...rule, source } : null,
    effectiveCommission: asNum(raw.effectiveCommission) ?? (price !== null && vendorPrice !== null ? round2(price - vendorPrice) : null),
    pendingVendorPrice,
    pendingPrice: asNum(raw.pendingPrice),
    approvalStatus: String(raw.approvalStatus ?? ''),
    state: stateOf(raw, pendingVendorPrice),
    rejectionReason: asStr(raw.rejectionReason),
    deletedAt: asStr(raw.deletedAt),
    createdBy: asStr(raw.createdBy),
    createdAt: asStr(raw.createdAt),
    updatedAt: asStr(raw.updatedAt),
  };
};

/** One dish from a create / update / approve response: `{data:{...}}`, `{data:{item|dish:{...}}}` or bare. Null when there is none. */
export const parseDishResponse = (body: unknown): CatalogDish | null => {
  const data = unwrap(body);
  if (isObject(data)) {
    const direct = parseDish(data);
    if (direct) return direct;
  }
  return null;
};

/** `{ success, total, page, pageSize, pages, data: [...], count }` (`limit` is accepted as another name for `pageSize`). */
export const parseDishList = (body: unknown, requestedPage: number): CatalogPage | null => {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  const items = body.data.map(parseDish).filter((dish): dish is CatalogDish => dish !== null);
  const page = asNum(body.page) ?? requestedPage;
  const pageSize = asNum(body.pageSize ?? body.limit);
  const total = asNum(body.total);
  let totalPages = asNum(body.pages ?? body.totalPages);
  if (totalPages === null && total !== null && pageSize) totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasMore = totalPages !== null ? page < totalPages : false;
  return { items, page, pageSize, total, totalPages, hasMore };
};

export interface PendingCounts { pending: number; changePending: number; total: number }

/** `{ data: { pending, changePending, total } }`. The sidebar badge uses `total`. */
export const parsePendingCounts = (body: unknown): PendingCounts | null => {
  const data = unwrap(body);
  if (!isObject(data)) return null;
  const pending = asNum(data.pending);
  const changePending = asNum(data.changePending);
  const total = asNum(data.total) ?? (pending !== null && changePending !== null ? pending + changePending : null);
  if (total === null) return null;
  return { pending: pending ?? total, changePending: changePending ?? 0, total };
};

export interface PricePreview {
  price: number;
  /** price - vendorPrice (includes rounding). */
  commission: number;
  /** The commission before rounding. */
  nominalCommission: number | null;
  roundingStep: number | null;
  /** The rule used and where it comes from. */
  rule: { type: CommissionType; value: number; source: CommissionSource } | null;
}

/** `{ data: { vendorPrice, price, effectiveCommission, nominalCommission, commission:{type,value,source}, roundingStep } }` */
export const parsePreview = (body: unknown, vendorPrice: number): PricePreview | null => {
  const data = unwrap(body);
  if (!isObject(data)) return null;
  const price = asNum(data.price);
  if (price === null) return null;
  const rule = parseRule(data.commission);
  const source = isObject(data.commission) && SOURCES.includes(data.commission.source) ? (data.commission.source as CommissionSource) : null;
  return {
    price,
    commission: asNum(data.effectiveCommission) ?? round2(price - vendorPrice),
    nominalCommission: asNum(data.nominalCommission),
    roundingStep: asNum(data.roundingStep),
    rule: rule && source ? { ...rule, source } : null,
  };
};

export interface SettingView {
  group: string;
  value: Record<string, unknown>;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** `{ data: { group, value, isDefault, updatedAt, updatedBy } }`. */
export const parseSettingView = (body: unknown): SettingView | null => {
  const data = unwrap(body);
  if (!isObject(data) || !isObject(data.value)) return null;
  return { group: asStr(data.group) ?? '', value: data.value, isDefault: data.isDefault === true, updatedAt: asStr(data.updatedAt), updatedBy: asStr(data.updatedBy) };
};

export interface SettingSaveResult { view: SettingView | null; changed: boolean; recalculateRecommended: boolean; message: string }

/** PUT answer: `{ success, changed, message, recalculateRecommended?, data: <view> }`. */
export const parseSettingSave = (body: unknown): SettingSaveResult => ({
  view: parseSettingView(body),
  changed: isObject(body) ? body.changed !== false : true,
  recalculateRecommended: isObject(body) && body.recalculateRecommended === true,
  message: isObject(body) && typeof body.message === 'string' ? body.message : '',
});

export const parseFeeLines = (raw: unknown): FeeLine[] => (Array.isArray(raw)
  ? raw.filter(isObject).map((line, index) => ({ key: asStr(line.key) ?? `line_${index + 1}`, label: asStr(line.label) ?? '', amount: asNum(line.amount) ?? 0 }))
  : []);

export interface RecalcResult {
  dryRun: boolean;
  applied: boolean;
  changed: number | null;
  total: number | null;
  /** The server lists at most 500 changes; `truncated` says the list is cut (the count is still complete). */
  truncated: boolean;
  samples: Array<{ name: string; vendorName: string; from: number | null; to: number | null }>;
}

/** `{ data: { dryRun, applied, total, changed, changes: [{id,name,vendorName,vendorPrice,oldPrice,newPrice,deleted}], truncated } }` */
export const parseRecalc = (body: unknown): RecalcResult => {
  const data = unwrap(body);
  if (!isObject(data)) return { dryRun: true, applied: false, changed: null, total: null, truncated: false, samples: [] };
  const list = Array.isArray(data.changes) ? data.changes : [];
  return {
    dryRun: data.dryRun !== false,
    applied: data.applied === true,
    changed: asNum(data.changed),
    total: asNum(data.total),
    truncated: data.truncated === true,
    samples: list.filter(isObject).slice(0, 5).map((row) => ({
      name: asStr(row.name) ?? 'Dish', vendorName: asStr(row.vendorName) ?? '', from: asNum(row.oldPrice), to: asNum(row.newPrice),
    })),
  };
};

export interface VendorCommission { type: CommissionType | null; value: number | null }

export interface VendorCommissionResult {
  commission: VendorCommission;
  /** Dishes of this restaurant whose stored price no longer matches the rules (run Recalculate prices). */
  staleDishes: number | null;
  dishCount: number | null;
  message: string;
}

/** `{ message, data: { vendor: { id, name, commissionType, commissionValue }, effective: {type,value,source}, dishCount, staleDishes } }` */
export const parseVendorCommission = (body: unknown, sent: VendorCommission): VendorCommissionResult => {
  const data = unwrap(body);
  let commission = sent;
  let staleDishes: number | null = null;
  let dishCount: number | null = null;
  if (isObject(data)) {
    const vendor = isObject(data.vendor) ? data.vendor : null;
    if (vendor && 'commissionType' in vendor) {
      const type = commissionType(vendor.commissionType);
      const value = asNum(vendor.commissionValue);
      commission = type && value !== null ? { type, value } : { type: null, value: null };
    }
    staleDishes = asNum(data.staleDishes);
    dishCount = asNum(data.dishCount);
  }
  return { commission, staleDishes, dishCount, message: isObject(body) && typeof body.message === 'string' ? body.message : '' };
};
