import { readPin } from './lib/vendorLocation';

export type TabType = 'map' | 'orders' | 'attention' | 'applications' | 'vendors' | 'drivers' | 'customers' | 'analytics' | 'catalog' | 'settings';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type PartnerKind = 'VENDOR' | 'DRIVER';

export type OrderStatus =
  | 'PLACED'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'ARRIVED_AT_GATE'
  | 'DELIVERED'
  | 'CANCELLED';

export type PaymentStatus = 'PAID' | 'PENDING' | 'FAILED' | 'REFUNDED';

/** Who cancelled an order (contract 1.3). Kept as a string so an unknown value from a newer server still renders. */
export type CancelledBy = 'CUSTOMER' | 'VENDOR' | 'ADMIN' | 'SYSTEM';
/** Refund progress for a cancelled paid order (contract 5). */
export type RefundStatus = 'NONE' | 'PENDING' | 'DONE' | 'FAILED';

export interface OrderItem {
  id?: string;
  itemId?: string;
  name: string;
  quantity: number;
  price: number;
}

/** One Razorpay payment attempt. Admin API only; never contains secrets (the server has none to send). */
export interface PaymentRecord {
  id?: string;
  status?: string;
  amount?: number;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  razorpayRefundId?: string | null;
  capturedAmountPaise?: number | null;
  createdAt?: string | null;
  refundedAt?: string | null;
}

export interface Order {
  id: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  customerHostel?: string | null;
  customerEmail?: string | null;
  vendorId?: string;
  vendorName: string;
  vendorAddress?: string | null;
  vendorPhone?: string | null;
  driverId?: string;
  driverName?: string;
  driverPhone?: string;
  items: OrderItem[];
  itemsCount: number;
  totalAmount: number;
  deliveryFee: number;
  /** Contract 2.1 money breakdown. Undefined when the server is older than the order-flow release. */
  subtotal?: number;
  taxAndPackaging?: number;
  discount?: number;
  dropoffHostel: string;
  dropoffNotes?: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  otpCode?: string | null;
  /** 5 wrong gate OTPs lock the order until an admin resets it (contract 4). */
  otpLocked?: boolean;
  otpAttempts?: number;
  createdAt: string;
  updatedAt?: string;
  paidAt?: string | null;
  acceptedAt?: string | null;
  pickedUpAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  cancelledBy?: CancelledBy | string | null;
  cancelReason?: string | null;
  refundStatus?: RefundStatus | string | null;
  refundError?: string | null;
  /** Automatic refund attempts so far (the job gives up after the server's maximum, 10). Admin only. */
  refundAttempts?: number;
  /** Unpaid orders are cancelled after this time (server SLA). */
  payBy?: string | null;
  /** A paid order not accepted by this time is cancelled and refunded (server SLA). */
  acceptBy?: string | null;
  isReviewed?: boolean;
  /** Admin only. */
  payments?: PaymentRecord[];
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  razorpayRefundId?: string | null;
}

export interface Vendor {
  id: string;
  userId?: string;
  name: string;
  category: string;
  rating: number;
  totalRatingsCount?: number;
  isAcceptingOrders: boolean;
  address: string;
  lat?: number;
  lng?: number;
  /** Server flag: false while the restaurant still has the placeholder pin. Undefined on an older server. */
  hasLocation?: boolean;
  /** Who set the pin (DEVICE = the restaurant's phone, ADMIN = typed in the dashboard), when, and the GPS accuracy in metres. Null on older rows / servers. */
  locationSource?: 'DEVICE' | 'ADMIN' | null;
  locationSetAt?: string | null;
  locationAccuracyM?: number | null;
  activeOrdersCount: number;
  menuItems?: MenuItem[];
  approvalStatus?: ApprovalStatus;
  /**
   * The restaurant's own commission (Docs/21). `undefined` = the server did not send the field (unknown),
   * `null` = the restaurant inherits the global default.
   */
  commissionType?: 'PERCENT' | 'FLAT' | null;
  commissionValue?: number | null;
}

export interface MenuItem {
  id: string;
  vendorId: string;
  name: string;
  price: number;
  category: string;
  description?: string;
  imageUrl?: string;
  isAvailable: boolean;
  isVeg?: boolean;
  rating?: number;
  ratingCount?: number;
}

export interface DriverPin {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heading: number;
  status: 'IDLE' | 'EN_ROUTE_DHABA' | 'DELIVERING_GATE';
  currentOrderId?: string;
  lastUpdated?: string;
  /** From the server since the campus-maps release; undefined on an older server (treated as on duty). */
  dutyStatus?: 'ONLINE' | 'OFFLINE' | 'IN_TRANSIT';
  approvalStatus?: string | null;
}

/**
 * One rider position from `GET /api/drivers/locations` or the `driver_location_update` socket event.
 * The row's key is `driverId` (the rider's user id; the socket event also carries it as `id`). Null when the
 * input has no id or no usable coordinates, so a bad event can never add a ghost marker.
 */
export const normalizeDriverPin = (raw: any): DriverPin | null => {
  const id = String(raw?.driverId ?? raw?.id ?? '');
  const lat = typeof raw?.lat === 'number' ? raw.lat : Number(raw?.lat);
  const lng = typeof raw?.lng === 'number' ? raw.lng : Number(raw?.lng);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const duty = raw?.dutyStatus;
  return {
    id,
    name: raw?.driverName || raw?.name || 'Runner',
    lat,
    lng,
    heading: Number(raw?.heading || 0) || 0,
    status: 'DELIVERING_GATE',
    lastUpdated: typeof raw?.lastUpdated === 'string' ? raw.lastUpdated : undefined,
    dutyStatus: duty === 'ONLINE' || duty === 'OFFLINE' || duty === 'IN_TRANSIT' ? duty : undefined,
    approvalStatus: typeof raw?.approvalStatus === 'string' ? raw.approvalStatus : null,
  };
};

export interface DriverPartner {
  id: string;
  /** The rider's login account id. `Order.driverId` points at this, not at the DriverPartner id. */
  userId?: string;
  name: string;
  phone: string;
  studentRegNo: string;
  runnerCode: string;
  avatarUrl?: string;
  vehicleType: string;
  vehicleRegNo: string;
  emergencyPhone: string;
  dutyStatus: 'ONLINE' | 'OFFLINE' | 'IN_TRANSIT';
  ordersToday: number;
  totalEarningsToday: number;
  avgCompletionTimeMinutes: number;
  onTimeRatePercent: number;
  rating: number;
  upiId?: string;
  createdAt: string;
  approvalStatus?: ApprovalStatus;
}

export interface AnalyticsData {
  range: { from: string; to: string };
  grossOrderVolume: number;
  orderCount: number;
  averageDeliveryMinutes: number;
  activeStudents: number;
  cancellationRate: number;
  hourlyOrders: Array<{ hour: string; orders: number }>;
  hostelOrders: Array<{ hostel: string; orders: number }>;
  topVendor?: { name: string; deliveredOrders: number };
  generatedAt: string;
}

export interface AdminProfile {
  id: string;
  name: string;
  phone?: string;
  role: 'ADMIN';
}

const asNumber = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const has = (raw: any, key: string): boolean => raw != null && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, key);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : typeof value === 'number' ? String(value) : undefined);
const isoOrNull = (value: unknown): string | null => {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
};
const numOrUndefined = (value: unknown): number | undefined => {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const normalizePayment = (p: any): PaymentRecord => ({
  id: str(p?.id),
  status: str(p?.status),
  amount: numOrUndefined(p?.amount),
  razorpayOrderId: str(p?.razorpayOrderId) ?? null,
  razorpayPaymentId: str(p?.razorpayPaymentId) ?? null,
  razorpayRefundId: str(p?.razorpayRefundId) ?? null,
  capturedAmountPaise: numOrUndefined(p?.capturedAmountPaise) ?? null,
  createdAt: isoOrNull(p?.createdAt),
  refundedAt: isoOrNull(p?.refundedAt),
});

/** The payment that matters for support: a captured/refunded one first, otherwise the newest attempt. */
const primaryPayment = (payments: PaymentRecord[]): PaymentRecord | undefined => {
  const settled = payments.filter((p) => p.status === 'PAID' || p.status === 'REFUNDED' || p.razorpayPaymentId);
  const pool = settled.length ? settled : payments;
  return [...pool].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || 0)[0];
};

/**
 * Only the fields the payload actually carries. A missing key means "unknown, keep what you have";
 * an explicit null (e.g. `driver: null`) means "cleared". This is what live merges are built on, so an
 * older/partial socket payload never wipes a name or phone the dashboard already knows.
 */
export const normalizeOrderPartial = (input: any): Partial<Order> & { id: string } => {
  const raw = input && typeof input === 'object' ? input : {};
  const out: Partial<Order> & { id: string } = { id: String(raw?.id ?? '') };
  const put = <K extends keyof Order>(key: K, value: Order[K]) => { out[key] = value; };

  const customer = raw.customer && typeof raw.customer === 'object' ? raw.customer : undefined;
  if (has(raw, 'customerId') || customer?.id) put('customerId', str(raw.customerId) ?? str(customer?.id));
  if (str(raw.customerName) || str(customer?.name)) put('customerName', (str(raw.customerName) ?? str(customer?.name))!);
  if (has(raw, 'customerPhone') || (customer && has(customer, 'phone'))) put('customerPhone', str(raw.customerPhone) ?? str(customer?.phone));
  if (customer && has(customer, 'hostelBlock')) put('customerHostel', str(customer.hostelBlock) ?? null);
  if (customer && has(customer, 'email')) put('customerEmail', str(customer.email) ?? null);

  const vendor = raw.vendor && typeof raw.vendor === 'object' ? raw.vendor : undefined;
  if (has(raw, 'vendorId') || vendor?.id) put('vendorId', str(raw.vendorId) ?? str(vendor?.id));
  if (str(raw.vendorName) || str(vendor?.name)) put('vendorName', (str(raw.vendorName) ?? str(vendor?.name))!);
  if (vendor && has(vendor, 'address')) put('vendorAddress', str(vendor.address) ?? null);
  if (vendor && has(vendor, 'phone')) put('vendorPhone', str(vendor.phone) ?? null);

  // driver: null (or driverId: null) is an explicit "no rider".
  if (has(raw, 'driver') || has(raw, 'driverId')) {
    const driver = raw.driver && typeof raw.driver === 'object' ? raw.driver : undefined;
    const explicitlyNone = (has(raw, 'driverId') && raw.driverId == null && !driver) || (has(raw, 'driver') && raw.driver == null && !str(raw.driverId));
    put('driverId', explicitlyNone ? undefined : str(raw.driverId) ?? str(driver?.id));
    put('driverName', explicitlyNone ? undefined : str(raw.driverName) ?? str(driver?.name));
    put('driverPhone', explicitlyNone ? undefined : str(raw.driverPhone) ?? str(driver?.phone));
  }

  if (Array.isArray(raw.items)) {
    const items: OrderItem[] = raw.items.map((item: any) => ({
      id: str(item?.id),
      itemId: str(item?.itemId) ?? str(item?.menuItemId),
      name: str(item?.name) ?? 'Unnamed item',
      quantity: asNumber(item?.quantity, 1),
      price: asNumber(item?.price),
    }));
    put('items', items);
    put('itemsCount', numOrUndefined(raw.itemsCount) ?? items.reduce((sum, item) => sum + item.quantity, 0));
  } else if (numOrUndefined(raw.itemsCount) !== undefined) {
    put('itemsCount', numOrUndefined(raw.itemsCount)!);
  }

  if (has(raw, 'totalAmount')) put('totalAmount', asNumber(raw.totalAmount));
  if (has(raw, 'deliveryFee')) put('deliveryFee', asNumber(raw.deliveryFee));
  if (has(raw, 'subtotal')) put('subtotal', numOrUndefined(raw.subtotal));
  if (has(raw, 'taxAndPackaging')) put('taxAndPackaging', numOrUndefined(raw.taxAndPackaging));
  if (has(raw, 'discount')) put('discount', numOrUndefined(raw.discount));
  if (str(raw.dropoffHostel)) put('dropoffHostel', raw.dropoffHostel);
  if (has(raw, 'dropoffNotes')) put('dropoffNotes', str(raw.dropoffNotes));
  if (str(raw.status)) put('status', String(raw.status).toUpperCase() as OrderStatus);
  if (str(raw.paymentStatus)) put('paymentStatus', String(raw.paymentStatus).toUpperCase() as PaymentStatus);
  if (has(raw, 'otpCode')) put('otpCode', str(raw.otpCode) ?? null);
  if (has(raw, 'otpLocked')) put('otpLocked', raw.otpLocked === true || raw.otpLocked === 'true');
  if (has(raw, 'otpAttempts')) put('otpAttempts', numOrUndefined(raw.otpAttempts));
  if (str(raw.createdAt) || raw.createdAt instanceof Date) put('createdAt', isoOrNull(raw.createdAt)!);
  if (str(raw.updatedAt) || raw.updatedAt instanceof Date) put('updatedAt', isoOrNull(raw.updatedAt)!);
  (['paidAt', 'acceptedAt', 'pickedUpAt', 'deliveredAt', 'cancelledAt'] as const).forEach((key) => {
    if (has(raw, key)) put(key, isoOrNull(raw[key]));
  });
  if (has(raw, 'cancelledBy')) put('cancelledBy', str(raw.cancelledBy)?.toUpperCase() ?? null);
  if (has(raw, 'cancelReason')) put('cancelReason', str(raw.cancelReason) ?? null);
  if (has(raw, 'refundStatus')) put('refundStatus', str(raw.refundStatus)?.toUpperCase() ?? null);
  if (has(raw, 'refundError')) put('refundError', str(raw.refundError) ?? null);
  if (has(raw, 'refundAttempts')) put('refundAttempts', numOrUndefined(raw.refundAttempts));
  if (has(raw, 'payBy')) put('payBy', isoOrNull(raw.payBy));
  if (has(raw, 'acceptBy')) put('acceptBy', isoOrNull(raw.acceptBy));
  if (has(raw, 'isReviewed')) put('isReviewed', raw.isReviewed === true);

  // Payment ids: admin OrderView only (`payments[]`). The headline ids come from the captured/refunded payment.
  if (Array.isArray(raw.payments)) {
    const payments: PaymentRecord[] = raw.payments.map(normalizePayment);
    const primary = primaryPayment(payments);
    put('payments', payments);
    put('razorpayOrderId', primary?.razorpayOrderId ?? null);
    put('razorpayPaymentId', primary?.razorpayPaymentId ?? null);
    put('razorpayRefundId', primary?.razorpayRefundId ?? null);
  }
  return out;
};

const ORDER_DEFAULTS: Omit<Order, 'id' | 'createdAt'> = {
  customerName: 'Unknown student',
  vendorName: 'Unknown vendor',
  items: [],
  itemsCount: 0,
  totalAmount: 0,
  deliveryFee: 0,
  dropoffHostel: 'Unspecified drop-off',
  status: 'PLACED',
  paymentStatus: 'PENDING',
};

/** Fills placeholders around a partial order (used when a live event introduces an order we have not seen). */
export const orderFromPartial = (partial: Partial<Order> & { id: string }): Order =>
  ({ ...ORDER_DEFAULTS, createdAt: new Date().toISOString(), ...partial }) as Order;

/** Full order with safe placeholders for anything the server did not send (old or new server). */
export const normalizeOrder = (raw: any): Order => orderFromPartial(normalizeOrderPartial(raw));

/** One problem the server (or, as a fallback, the dashboard) found on an order. `code` is free-form; unknown codes render generically. */
export interface AttentionProblem {
  code: string;
  detail?: string | null;
  since?: string | null;
}

/** One row of the "Needs attention" list: an order (when known) and everything wrong with it. */
export interface AttentionEntry {
  key: string;
  orderId: string | null;
  order: Order | null;
  problems: AttentionProblem[];
  /** The server's advice for this entry (null for the dashboard's own fallback list). */
  hint?: string | null;
}

export const normalizeVendor = (raw: any): Vendor => ({
  id: String(raw?.id || ''),
  userId: raw?.userId,
  name: raw?.name || 'Unnamed vendor',
  category: raw?.category || 'Uncategorized',
  rating: asNumber(raw?.rating, 0),
  totalRatingsCount: asNumber(raw?.totalRatingsCount),
  isAcceptingOrders: Boolean(raw?.isAcceptingOrders),
  address: raw?.address || 'Address unavailable',
  lat: raw?.lat,
  lng: raw?.lng,
  ...readPin(raw),
  activeOrdersCount: asNumber(raw?.activeOrdersCount ?? raw?._count?.orders),
  menuItems: Array.isArray(raw?.menuItems) ? raw.menuItems : undefined,
  approvalStatus: raw?.approvalStatus,
  ...(raw && typeof raw === 'object' && 'commissionType' in raw
    ? {
      commissionType: raw.commissionType === 'PERCENT' || raw.commissionType === 'FLAT' ? raw.commissionType : null,
      commissionValue: raw.commissionType === 'PERCENT' || raw.commissionType === 'FLAT' ? asNumber(raw.commissionValue, 0) : null,
    }
    : {}),
});

export const normalizeDriver = (raw: any): DriverPartner => ({
  id: String(raw?.id || raw?.userId || ''),
  userId: raw?.userId || raw?.user?.id || undefined,
  name: raw?.name || raw?.user?.name || 'Unnamed runner',
  phone: raw?.phone || raw?.user?.phone || '',
  studentRegNo: raw?.studentRegNo || '',
  runnerCode: raw?.runnerCode || '',
  avatarUrl: raw?.avatarUrl,
  vehicleType: raw?.vehicleType || 'Not registered',
  vehicleRegNo: raw?.vehicleRegNo || 'Not registered',
  emergencyPhone: raw?.emergencyPhone || '',
  dutyStatus: raw?.dutyStatus || 'OFFLINE',
  ordersToday: asNumber(raw?.ordersToday),
  totalEarningsToday: asNumber(raw?.totalEarningsToday),
  avgCompletionTimeMinutes: asNumber(raw?.avgCompletionTimeMinutes),
  onTimeRatePercent: asNumber(raw?.onTimeRatePercent),
  rating: asNumber(raw?.rating),
  upiId: raw?.upiId,
  createdAt: raw?.createdAt || new Date().toISOString(),
  approvalStatus: raw?.approvalStatus,
});

/** One restaurant or rider account, as the Applications tab shows it. */
export interface Application {
  id: string;
  kind: PartnerKind;
  userId: string | null;
  name: string;
  phone: string | null;
  status: ApprovalStatus;
  rejectionReason: string | null;
  /** true = they created the account themselves in the app; false = an admin added them. */
  selfSignup: boolean;
  appliedAt: string;
  reviewedAt: string | null;
  createdAt: string;
  vendor?: {
    name: string; category: string; address: string; fssaiNumber: string | null; isAcceptingOrders: boolean;
    /** The pin the restaurant sent (or the admin set); absent on an older server. */
    lat?: number | null; lng?: number | null; hasLocation?: boolean;
    locationSource?: 'DEVICE' | 'ADMIN' | null; locationSetAt?: string | null; locationAccuracyM?: number | null;
  };
  driver?: { runnerCode: string; vehicleType: string; vehicleRegNo: string | null; emergencyPhone: string | null; upiId: string | null };
}

export type ApplicationCounts = Record<ApprovalStatus, number>;

export interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isStudent: boolean | null;
  hostelBlock: string | null;
  avatarId: number | null;
  kraveoCoins: number;
  createdAt: string;
  deleted: boolean;
  ordersCount: number;
  totalSpent: number;
  lastOrderAt: string | null;
}

export interface CustomerOrder {
  id: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  totalAmount: number;
  deliveryFee: number;
  dropoffHostel: string;
  dropoffNotes: string | null;
  createdAt: string;
  vendor: { id: string; name: string } | null;
  driver: { id: string; name: string; phone: string | null } | null;
  items: Array<{ name: string; quantity: number; price: number }>;
  payments: Array<{ id: string; razorpayPaymentId: string | null; amount: number; status: PaymentStatus; createdAt: string }>;
}

export interface CustomerDetail extends Omit<CustomerRow, 'ordersCount' | 'totalSpent' | 'lastOrderAt'> {
  stats: {
    ordersCount: number;
    deliveredCount: number;
    cancelledCount: number;
    activeCount: number;
    paidOrdersCount: number;
    totalSpent: number;
    firstOrderAt: string | null;
    lastOrderAt: string | null;
  };
  orders: CustomerOrder[];
}

export interface NewPartnerInput {
  role: PartnerKind;
  name: string;
  phone: string;
  password: string;
  restaurantName?: string;
  category?: string;
  address?: string;
  fssaiNumber?: string;
  vehicleType?: string;
  vehicleRegNo?: string;
  emergencyPhone?: string;
  upiId?: string;
  /** Vendor only, optional: the restaurant's map pin (validated by the server: on campus). */
  lat?: number;
  lng?: number;
}
