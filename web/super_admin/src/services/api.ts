/// <reference types="vite/client" />
import {
  AdminProfile,
  AnalyticsData,
  AttentionEntry,
  Application,
  ApplicationCounts,
  ApprovalStatus,
  CustomerDetail,
  CustomerRow,
  NewPartnerInput,
  PartnerKind,
  DriverPartner,
  DriverPin,
  Order,
  OrderStatus,
  Vendor,
  normalizeDriver,
  normalizeDriverPin,
  normalizeOrder,
  normalizeVendor,
} from '../types';
import { normalizeAttention } from '../lib/orderProblems';
import { CancelOutcome, parseCancelOutcome } from '../lib/orderGroups';
import { GroupView, parseGroupView } from '../lib/groupView';
import {
  CatalogDish, CatalogPage, PendingCounts, PricePreview, RecalcResult, SettingSaveResult, SettingView, VendorCommission, VendorCommissionResult,
  parseDishList, parseDishResponse, parsePendingCounts, parsePreview, parseRecalc, parseSettingSave, parseSettingView, parseVendorCommission,
} from '../lib/catalogParse';
import {
  DateRange, DishSort, FinanceRiders, FinanceSummary, PayoutAccountResult, PayoutProvider, RevealedAccount, RiderPayout, RiderPayoutPage, RunResult, SettlementAction,
  SettlementDetail, SettlementPage, parseByDay, parseByDish, parseByRestaurant, parseFinanceSummary, parsePayoutAccountResult, parsePendingSettlementCount, parseProviders,
  parseReveal, parseRiderPayoutPage, parseRiderPayoutResult, parseRiders, parseRunResult, parseSettlementAction, parseSettlementDetail, parseSettlementPage,
} from '../lib/financeParse';
import type { AdjustmentInput, MarkPaidInput, PayoutAccountInput, RiderPayoutInput } from '../lib/financeInput';
import type { CommissionType } from '../lib/pricing';
import type { DropPointInfo } from '../lib/campus';
import type { SavedPin } from '../lib/vendorLocation';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? 'https://api.kraveo.site' : 'http://localhost:5000');
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || (import.meta.env.PROD ? 'https://api.kraveo.site' : 'http://localhost:5000');

export class ApiError extends Error {
  /** `code` / `field` come from the server's `{ success:false, message, code?, field? }` error body (contract 2). */
  constructor(public status: number, message: string, public code?: string, public field?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** No request may spin forever (contract 6): give up after this long and show a clear message. */
const REQUEST_TIMEOUT_MS = 20_000;

async function send(path: string, init: RequestInit): Promise<{ response: Response; body: any }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // A caller's own signal (a stale price preview) cancels this request too.
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, signal: controller.signal, headers: { ...getHeaders(), ...(init.headers || {}) } });
  } catch (error) {
    if (init.signal?.aborted) throw new ApiError(0, 'Cancelled.', 'ABORTED');
    if (controller.signal.aborted) throw new ApiError(0, 'The server took too long to answer. Check the connection and try again.', 'TIMEOUT');
    throw new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.', 'NETWORK');
  } finally {
    window.clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, body?.message || `Request failed (${response.status}).`, typeof body?.code === 'string' ? body.code : undefined, typeof body?.field === 'string' ? body.field : undefined);
  }
  return { response, body };
}

// Storage can be blocked (private window, strict cookie settings): never let that throw into the UI.
// A token that could not be written is kept in memory so this tab still works until it is closed.
let memoryToken = '';
let storageWriteFailed = false;

export const getAuthToken = (): string => {
  try {
    const stored = localStorage.getItem('kraveo_admin_token') || '';
    return stored || (storageWriteFailed ? memoryToken : '');
  } catch {
    return memoryToken;
  }
};

export const setAuthToken = (token: string, adminProfile?: AdminProfile) => {
  const clean = token.replace(/^Bearer\s+/i, '');
  memoryToken = clean;
  try {
    localStorage.setItem('kraveo_admin_token', clean);
    storageWriteFailed = false;
    if (adminProfile) localStorage.setItem('kraveo_admin_profile', JSON.stringify(adminProfile));
  } catch {
    storageWriteFailed = true;
  }
};

export const clearAuthToken = () => {
  memoryToken = '';
  storageWriteFailed = false;
  try {
    localStorage.removeItem('kraveo_admin_token');
    localStorage.removeItem('kraveo_admin_profile');
  } catch { /* storage blocked: nothing stored to clear */ }
};

export const isAuthenticated = (): boolean => getAuthToken().trim().length > 10;

const getHeaders = (extraHeaders: Record<string, string> = {}) => {
  const token = getAuthToken().replace(/^Bearer\s+/i, '');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  };
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { body } = await send(path, init);
  return body?.data ?? body;
}

/** Like request(), but keeps the whole body (counts, cursors, totals) instead of only `data`. */
async function requestFull<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { body } = await send(path, init);
  return body as T;
}

/** Downloads a file with the admin's auth header (a plain link cannot send it). Returns the bytes and the file name the server chose. */
async function download(path: string): Promise<{ blob: Blob; filename: string }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { signal: controller.signal, headers: getHeaders({ Accept: 'text/csv' }) });
  } catch {
    if (controller.signal.aborted) throw new ApiError(0, 'The server took too long to answer. Check the connection and try again.', 'TIMEOUT');
    throw new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.', 'NETWORK');
  } finally {
    window.clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body?.message || `The download failed (${response.status}).`, typeof body?.code === 'string' ? body.code : undefined);
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return { blob: await response.blob(), filename: match ? match[1] : 'kraveo-export.csv' };
}

/** What the catalog API accepts to create or change a dish (only fields that changed are sent on an update). */
export interface DishWrite {
  vendorId?: string;
  name?: string;
  description?: string;
  category?: string;
  imageUrl?: string | null;
  isVeg?: boolean;
  isAvailable?: boolean;
  vendorPrice?: number;
  /** `null` clears the dish's own commission so it inherits the restaurant / global default. */
  commissionType?: CommissionType | null;
  commissionValue?: number | null;
}

export type SettingsGroup = 'fees' | 'commission' | 'rounding' | 'settlement';

const unexpected = (what: string) => new ApiError(502, `The server answered, but not in the shape the dashboard expects (${what}). Refresh and try again; if it keeps happening the server and dashboard versions do not match.`, 'UNEXPECTED_RESPONSE');
const json = (value: unknown) => JSON.stringify(value);
const dishPath = (id: string) => `/api/admin/catalog/${encodeURIComponent(id)}`;
const rangeQuery = (range: DateRange) => `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
const settlementPath = (id: string) => `/api/admin/settlements/${encodeURIComponent(id)}`;
const accountPath = (userId: string) => `/api/admin/partners/${encodeURIComponent(userId)}/payout-account`;

/** An order from an action response, or null when the server answered without one (e.g. `{ success: true }`). */
const orderOrNull = (raw: any): Order | null => {
  return raw && typeof raw === 'object' && raw.id ? normalizeOrder(raw) : null;
};

export const apiService = {
  async adminLogin(passcode: string, username?: string): Promise<{ token: string; admin: AdminProfile }> {
    if (!passcode.trim()) throw new ApiError(400, 'Please enter the admin passcode.');
    const response = await request<{ token: string; admin: AdminProfile }>('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: passcode.trim(), username: username?.trim() || 'Campus Dispatch Admin' }),
    });
    if (!response?.token || response.admin?.role !== 'ADMIN') throw new ApiError(401, 'The server did not return a valid admin session.');
    setAuthToken(response.token, response.admin);
    return response;
  },

  async validateSession(): Promise<AdminProfile> {
    const profile = await request<any>('/api/auth/profile');
    const user = profile?.user || profile;
    if (user?.role !== 'ADMIN') throw new ApiError(403, 'This session is not authorized for the admin console.');
    return { id: user.id, name: user.name, phone: user.phone, role: 'ADMIN' };
  },

  async fetchOrders(): Promise<Order[]> {
    return (await apiService.fetchOrderPage()).orders;
  },

  /** One page of orders, newest first (the server default is 100). `cursor` = the id of the last order already loaded. */
  async fetchOrderPage(cursor?: string | null, limit?: number): Promise<{ orders: Order[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    const body = await requestFull<any>(`/api/orders${query ? `?${query}` : ''}`);
    const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    return { orders: data.map(normalizeOrder), nextCursor: typeof body?.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null };
  },

  async fetchVendors(): Promise<Vendor[]> {
    const data = await request<any[]>('/api/vendors');
    return (Array.isArray(data) ? data : []).map(normalizeVendor);
  },

  async fetchDrivers(): Promise<DriverPartner[]> {
    const data = await request<any[]>('/api/drivers');
    return (Array.isArray(data) ? data : []).map(normalizeDriver);
  },

  async fetchDriverLocations(): Promise<DriverPin[]> {
    const data = await request<any[]>('/api/drivers/locations');
    return (Array.isArray(data) ? data : []).map(normalizeDriverPin).filter((pin): pin is DriverPin => pin !== null);
  },

  /** Campus drop points and map centre. Never throws: the map falls back to its built-in copy (older server, offline). */
  async fetchCampus(): Promise<{ center: { lat: number; lng: number }; dropPoints: DropPointInfo[] } | null> {
    try {
      const data = await request<any>('/api/campus');
      const points: DropPointInfo[] = (Array.isArray(data?.dropPoints) ? data.dropPoints : [])
        .filter((p: any) => p && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p: any) => ({ id: String(p.id ?? p.name), name: p.name, group: p.group === 'girls' ? 'girls' : 'boys', lat: p.lat, lng: p.lng }));
      const c = data?.center;
      if (points.length === 0 || !c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return null;
      return { center: { lat: c.lat, lng: c.lng }, dropPoints: points };
    } catch {
      return null;
    }
  },

  /** Sets a restaurant's map pin (admin only; the server checks ranges and that the point is on campus). */
  async setVendorLocation(vendorId: string, lat: number, lng: number): Promise<SavedPin> {
    const data = await request<any>(`/api/admin/vendors/${encodeURIComponent(vendorId)}/location`, {
      method: 'PATCH',
      body: JSON.stringify({ lat, lng }),
    });
    return {
      lat: Number(data?.lat ?? lat), lng: Number(data?.lng ?? lng), hasLocation: data?.hasLocation !== false,
      // an admin save is always source ADMIN with no accuracy; an older server does not say, so fill it in
      locationSource: data?.locationSource === 'DEVICE' ? 'DEVICE' : 'ADMIN',
      locationSetAt: typeof data?.locationSetAt === 'string' ? data.locationSetAt : new Date().toISOString(),
      locationAccuracyM: typeof data?.locationAccuracyM === 'number' ? data.locationAccuracyM : null,
    };
  },

  async fetchAnalytics(range: 'today' | '7d' | '30d' = '7d'): Promise<AnalyticsData> {
    return request<AnalyticsData>(`/api/analytics?range=${range}`);
  },

  async updateOrderStatus(orderId: string, status: OrderStatus, otpCode?: string): Promise<Order> {
    return normalizeOrder(await request<any>(`/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...(otpCode ? { otpCode } : {}) }),
    }));
  },

  async toggleVendorStatus(vendorId: string, isAcceptingOrders: boolean): Promise<Vendor> {
    return normalizeVendor(await request<any>(`/api/vendors/${encodeURIComponent(vendorId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isAcceptingOrders }),
    }));
  },

  async createVendor(vendor: Pick<Vendor, 'name' | 'category' | 'address' | 'lat' | 'lng'>): Promise<Vendor> {
    return normalizeVendor(await request<any>('/api/vendors', {
      method: 'POST',
      body: JSON.stringify(vendor),
    }));
  },

  /** `force` assigns a rider who is offline (the server still refuses a rider who already has an active order). */
  async reassignOrderDriver(orderId: string, driverId: string | null, force = false): Promise<Order | null> {
    return orderOrNull(await request<any>(`/api/orders/${encodeURIComponent(orderId)}/reassign`, {
      method: 'PATCH',
      body: JSON.stringify({ driverId, ...(force ? { force: true } : {}) }),
    }));
  },

  async fetchOrder(orderId: string): Promise<Order> {
    const order = orderOrNull(await request<any>(`/api/orders/${encodeURIComponent(orderId)}`));
    if (!order) throw new ApiError(404, 'Order not found.');
    return order;
  },

  // ── Order-flow admin actions (Docs/16_order_flow_contract.md 2.5) ──
  /** Cancels any non-terminal order; the server refunds it when it was paid. For a combined order this cancels the WHOLE group. */
  async cancelOrder(orderId: string, reason: string): Promise<Order | null> {
    return (await apiService.cancelOrderWithResult(orderId, reason)).order;
  },

  /**
   * Same call, but also keeps what the server says about a combined order (Docs/22 10.5):
   * `{ message, groupId, cancelledOrders, data }` (`cancelledOrders: 0` when it was already cancelled; single orders have neither field).
   */
  async cancelOrderWithResult(orderId: string, reason: string): Promise<{ order: Order | null; outcome: CancelOutcome }> {
    const body = await requestFull<any>(`/api/admin/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    return { order: orderOrNull(body?.data ?? body), outcome: parseCancelOutcome(body) };
  },

  /** One combined order with its totals and all its orders (admin may read any group; 404 for an unknown id). */
  async fetchOrderGroup(groupId: string, signal?: AbortSignal): Promise<GroupView> {
    const view = parseGroupView(await requestFull<any>(`/api/order-groups/${encodeURIComponent(groupId)}`, { signal }));
    if (!view) throw unexpected('combined order');
    return view;
  },

  /** Asks the server to try a FAILED refund again right now (409 NO_FAILED_REFUND if there is none). */
  async retryRefund(orderId: string): Promise<Order | null> {
    return orderOrNull(await request<any>(`/api/admin/orders/${encodeURIComponent(orderId)}/retry-refund`, { method: 'POST', body: '{}' }));
  },

  /** Clears the 5-wrong-OTP lock; the server sends the customer a new gate code. */
  async resetOtpLock(orderId: string): Promise<Order | null> {
    return orderOrNull(await request<any>(`/api/admin/orders/${encodeURIComponent(orderId)}/reset-otp-lock`, { method: 'POST', body: '{}' }));
  },

  /**
   * Orders the server says need a human: `{ data: [{ problem, problems[], detail, since, hint, order }] }`.
   * `available: false` only when the server predates the order-flow release (404/405/501), so the dashboard
   * can fall back to what it detects itself and say so.
   */
  async fetchNeedsAttention(): Promise<{ available: boolean; entries: AttentionEntry[] }> {
    try {
      const body = await requestFull<any>('/api/admin/orders/needs-attention');
      return { available: true, entries: normalizeAttention(body) };
    } catch (error) {
      if (error instanceof ApiError && [404, 405, 501].includes(error.status)) return { available: false, entries: [] };
      throw error;
    }
  },

  // ── Partner applications and accounts ──
  async fetchApplications(status: ApprovalStatus | 'ALL' = 'PENDING', kind?: PartnerKind): Promise<{ counts: ApplicationCounts; data: Application[] }> {
    const params = new URLSearchParams({ status });
    if (kind) params.set('kind', kind);
    const body = await requestFull<{ counts: ApplicationCounts; data: Application[] }>(`/api/admin/applications?${params.toString()}`);
    return { counts: body.counts, data: Array.isArray(body.data) ? body.data : [] };
  },

  async setPartnerStatus(kind: PartnerKind, id: string, status: ApprovalStatus, reason?: string): Promise<Application> {
    return request<Application>(`/api/admin/partners/${kind.toLowerCase()}/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
    });
  },

  async resetPartnerPassword(userId: string, password: string): Promise<void> {
    await request<unknown>(`/api/admin/partners/${encodeURIComponent(userId)}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
  },

  async createPartner(input: NewPartnerInput): Promise<{ profileId: string | null }> {
    const body = await requestFull<{ profileId: string | null }>('/api/admin/partners', { method: 'POST', body: JSON.stringify(input) });
    return { profileId: body.profileId ?? null };
  },

  // ── Customers ──
  async fetchCustomers(search: string, cursor?: string | null): Promise<{ total: number; nextCursor: string | null; data: CustomerRow[] }> {
    const params = new URLSearchParams({ limit: '30' });
    if (search.trim()) params.set('search', search.trim());
    if (cursor) params.set('cursor', cursor);
    const body = await requestFull<{ total: number; nextCursor: string | null; data: CustomerRow[] }>(`/api/admin/customers?${params.toString()}`);
    return { total: body.total ?? 0, nextCursor: body.nextCursor ?? null, data: Array.isArray(body.data) ? body.data : [] };
  },

  async fetchCustomer(id: string): Promise<CustomerDetail> {
    return request<CustomerDetail>(`/api/admin/customers/${encodeURIComponent(id)}`);
  },
  // ── Catalog, pricing and settings (Docs/21 section 4). Response parsing lives in lib/catalogParse.ts ──
  async fetchCatalog(filter: { status?: string; vendorId?: string; q?: string; page?: number }): Promise<CatalogPage> {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.vendorId) params.set('vendorId', filter.vendorId);
    if (filter.q?.trim()) params.set('q', filter.q.trim());
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    params.set('page', String(page));
    const parsed = parseDishList(await requestFull<any>(`/api/admin/catalog?${params.toString()}`), page);
    if (!parsed) throw unexpected('dish list');
    return parsed;
  },

  /** `{ pending, changePending, total }`: the sidebar badge shows `total`. */
  async fetchCatalogPendingCounts(): Promise<PendingCounts> {
    const counts = parsePendingCounts(await requestFull<any>('/api/admin/catalog/pending-count'));
    if (!counts) throw unexpected('pending count');
    return { pending: Math.max(0, Math.round(counts.pending)), changePending: Math.max(0, Math.round(counts.changePending)), total: Math.max(0, Math.round(counts.total)) };
  },

  /** Approves a new dish, or accepts a restaurant's price change (`applyPending`). Returns the dish view the server sends back. */
  async approveCatalogItem(id: string, input: { commissionType?: CommissionType; commissionValue?: number; vendorPrice?: number; applyPending?: boolean }): Promise<CatalogDish | null> {
    return parseDishResponse(await requestFull<any>(`${dishPath(id)}/approve`, { method: 'POST', body: json(input) }));
  },

  /** Rejects a PENDING dish, or declines the price change of a CHANGE_PENDING dish (the dish stays live at its old price). 3-200 letters. */
  async rejectCatalogItem(id: string, reason: string): Promise<CatalogDish | null> {
    return parseDishResponse(await requestFull<any>(`${dishPath(id)}/reject`, { method: 'POST', body: json({ reason }) }));
  },

  async updateCatalogItem(id: string, changes: DishWrite): Promise<CatalogDish | null> {
    return parseDishResponse(await requestFull<any>(dishPath(id), { method: 'PATCH', body: json(changes) }));
  },

  /** Soft delete: the dish is hidden from customers and can be restored. */
  async deleteCatalogItem(id: string): Promise<CatalogDish | null> {
    return parseDishResponse(await requestFull<any>(dishPath(id), { method: 'DELETE' }));
  },

  async restoreCatalogItem(id: string): Promise<CatalogDish | null> {
    return parseDishResponse(await requestFull<any>(`${dishPath(id)}/restore`, { method: 'POST', body: '{}' }));
  },

  /** An admin-created dish is live at once. */
  async createCatalogItem(input: DishWrite & { vendorId: string; name: string; vendorPrice: number }): Promise<CatalogDish | null> {
    return parseDishResponse(await requestFull<any>('/api/admin/catalog', { method: 'POST', body: json(input) }));
  },

  /** Customer price and effective commission for a typed vendor price (no commission fields = the inherited one). */
  async previewCatalogPrice(input: { vendorId: string; vendorPrice: number; commissionType?: CommissionType; commissionValue?: number }, signal?: AbortSignal): Promise<PricePreview> {
    const preview = parsePreview(await requestFull<any>('/api/admin/catalog/preview', { method: 'POST', body: json(input), signal }), input.vendorPrice);
    if (!preview) throw unexpected('price preview');
    return preview;
  },

  /** `dryRun: true` only counts; `false` rewrites the stored prices. Always sent explicitly. */
  async recalculatePrices(dryRun: boolean): Promise<RecalcResult> {
    return parseRecalc(await requestFull<any>('/api/admin/catalog/recalculate', { method: 'POST', body: json({ dryRun }) }));
  },

  async fetchSettings(group: SettingsGroup): Promise<SettingView> {
    const view = parseSettingView(await requestFull<any>(`/api/admin/settings/${group}`));
    if (!view) throw unexpected(`${group} settings`);
    return view;
  },

  /** Saves a group. The body is the group's object itself; keys left out keep their value on the server. */
  async saveSettings(group: SettingsGroup, value: Record<string, unknown>): Promise<SettingSaveResult & { value: Record<string, unknown> }> {
    const result = parseSettingSave(await requestFull<any>(`/api/admin/settings/${group}`, { method: 'PUT', body: json(value) }));
    return { ...result, value: result.view?.value ?? value };
  },

  /** A restaurant's own commission. `{ type: null, value: null }` clears it so the restaurant inherits the global default. */
  async setVendorCommission(vendorId: string, input: VendorCommission): Promise<VendorCommissionResult> {
    const body = await requestFull<any>(`/api/admin/vendors/${encodeURIComponent(vendorId)}/commission`, { method: 'PATCH', body: json(input) });
    return parseVendorCommission(body, input);
  },

  // ── Finance, settlements, payout accounts (Docs/21 section 5). Response parsing lives in lib/financeParse.ts ──
  async fetchFinanceSummary(range: DateRange): Promise<FinanceSummary> {
    const parsed = parseFinanceSummary(await requestFull<any>(`/api/admin/finance/summary?${rangeQuery(range)}`), range);
    if (!parsed) throw unexpected('finance summary');
    return parsed;
  },

  async fetchFinanceByDay(range: DateRange) {
    const parsed = parseByDay(await requestFull<any>(`/api/admin/finance/by-day?${rangeQuery(range)}`), range);
    if (!parsed) throw unexpected('finance by day');
    return parsed;
  },

  async fetchFinanceByRestaurant(range: DateRange, limit = 100) {
    const parsed = parseByRestaurant(await requestFull<any>(`/api/admin/finance/by-restaurant?${rangeQuery(range)}&limit=${limit}`), range);
    if (!parsed) throw unexpected('finance by restaurant');
    return parsed;
  },

  async fetchFinanceByDish(range: DateRange, opts: { sort: DishSort; top: number; vendorId?: string }) {
    const vendor = opts.vendorId ? `&vendorId=${encodeURIComponent(opts.vendorId)}` : '';
    const parsed = parseByDish(await requestFull<any>(`/api/admin/finance/by-dish?${rangeQuery(range)}&sort=${opts.sort}&top=${opts.top}${vendor}`), range);
    if (!parsed) throw unexpected('finance by dish');
    return parsed;
  },

  async fetchFinanceRiders(range: DateRange, limit = 100): Promise<FinanceRiders> {
    const parsed = parseRiders(await requestFull<any>(`/api/admin/finance/riders?${rangeQuery(range)}&limit=${limit}`), range);
    if (!parsed) throw unexpected('rider finance');
    return parsed;
  },

  /** `range: null` = every settlement ever created. `status` and `vendorId` are left out when empty. */
  async fetchSettlements(filter: { status?: string; vendorId?: string; range?: DateRange | null; page?: number; pageSize?: number }): Promise<SettlementPage> {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.vendorId) params.set('vendorId', filter.vendorId);
    if (filter.range) { params.set('from', filter.range.from); params.set('to', filter.range.to); }
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    params.set('page', String(page));
    params.set('pageSize', String(filter.pageSize ?? 25));
    const parsed = parseSettlementPage(await requestFull<any>(`/api/admin/settlements?${params.toString()}`), page);
    if (!parsed) throw unexpected('settlement list');
    return parsed;
  },

  /** Number of PENDING settlements (sidebar badge). */
  async fetchPendingSettlementCount(): Promise<number> {
    const count = parsePendingSettlementCount(await requestFull<any>('/api/admin/settlements?status=PENDING&page=1&pageSize=1'));
    if (count === null) throw unexpected('pending settlements');
    return Math.max(0, Math.round(count));
  },

  async fetchSettlement(id: string): Promise<SettlementDetail> {
    const parsed = parseSettlementDetail(await requestFull<any>(settlementPath(id)));
    if (!parsed) throw unexpected('settlement');
    return parsed;
  },

  async markSettlementPaid(id: string, input: MarkPaidInput): Promise<SettlementAction> {
    return parseSettlementAction(await requestFull<any>(`${settlementPath(id)}/mark-paid`, { method: 'POST', body: json(input) }));
  },

  async holdSettlement(id: string, input: { note?: string } = {}): Promise<SettlementAction> {
    return parseSettlementAction(await requestFull<any>(`${settlementPath(id)}/hold`, { method: 'POST', body: json(input) }));
  },

  async releaseSettlement(id: string): Promise<SettlementAction> {
    return parseSettlementAction(await requestFull<any>(`${settlementPath(id)}/release`, { method: 'POST', body: '{}' }));
  },

  /** `requestId` makes a double click or a retry add the adjustment once. */
  async addSettlementAdjustment(id: string, input: AdjustmentInput & { requestId?: string }): Promise<SettlementAction> {
    return parseSettlementAction(await requestFull<any>(`${settlementPath(id)}/adjustments`, { method: 'POST', body: json(input) }));
  },

  /** Frees the settlement's orders so the next run settles them again. A paid settlement is refused by the server. */
  async cancelSettlement(id: string): Promise<SettlementAction> {
    return parseSettlementAction(await requestFull<any>(`${settlementPath(id)}/cancel`, { method: 'POST', body: '{}' }));
  },

  /** "Create settlements now" for every restaurant with delivered, paid, unsettled orders. Idempotent on the server. */
  async runSettlements(): Promise<RunResult> {
    return parseRunResult(await requestFull<any>('/api/admin/settlements/run', { method: 'POST', body: '{}' }));
  },

  downloadSettlementCsv(id: string) {
    return download(`${settlementPath(id)}/export.csv`);
  },

  downloadSettlementsCsv(range: DateRange | null) {
    return download(`/api/admin/settlements/export.csv${range ? `?${rangeQuery(range)}` : ''}`);
  },

  async fetchRiderPayouts(filter: { driverUserId?: string; range?: DateRange | null; page?: number; pageSize?: number }): Promise<RiderPayoutPage> {
    const params = new URLSearchParams();
    if (filter.driverUserId) params.set('driverUserId', filter.driverUserId);
    if (filter.range) { params.set('from', filter.range.from); params.set('to', filter.range.to); }
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    params.set('page', String(page));
    params.set('pageSize', String(filter.pageSize ?? 25));
    const parsed = parseRiderPayoutPage(await requestFull<any>(`/api/admin/rider-payouts?${params.toString()}`), page);
    if (!parsed) throw unexpected('rider payouts');
    return parsed;
  },

  /** Records a payout that was made outside the app. The same reference twice for one rider is the same payment (`changed: false`). */
  async recordRiderPayout(input: RiderPayoutInput): Promise<{ payout: RiderPayout | null; changed: boolean; message: string }> {
    return parseRiderPayoutResult(await requestFull<any>('/api/admin/rider-payouts', { method: 'POST', body: json(input) }));
  },

  async fetchPayoutProviders(): Promise<PayoutProvider[]> {
    const parsed = parseProviders(await requestFull<any>('/api/admin/payout-providers'));
    if (!parsed) throw unexpected('payout providers');
    return parsed;
  },

  /** The partner's payout details, masked. `account: null` = nothing saved yet. */
  async fetchPayoutAccount(userId: string): Promise<PayoutAccountResult> {
    const parsed = parsePayoutAccountResult(await requestFull<any>(accountPath(userId)), userId);
    if (!parsed) throw unexpected('payout account');
    return parsed;
  },

  async savePayoutAccount(userId: string, input: PayoutAccountInput): Promise<PayoutAccountResult> {
    const parsed = parsePayoutAccountResult(await requestFull<any>(accountPath(userId), { method: 'PUT', body: json(input) }), userId);
    if (!parsed) throw unexpected('payout account');
    return parsed;
  },

  async setPayoutVerified(userId: string, verified: boolean): Promise<PayoutAccountResult> {
    const parsed = parsePayoutAccountResult(await requestFull<any>(`${accountPath(userId)}/verify`, { method: 'PATCH', body: json({ verified }) }), userId);
    if (!parsed) throw unexpected('payout account');
    return parsed;
  },

  /** The full account number. The server writes an audit row first. The caller must not keep the result after the dialog closes. */
  async revealPayoutAccount(userId: string): Promise<RevealedAccount> {
    const parsed = parseReveal(await requestFull<any>(`${accountPath(userId)}/reveal`, { method: 'POST', body: '{}' }));
    if (!parsed) throw unexpected('payout account reveal');
    return parsed;
  },
};
