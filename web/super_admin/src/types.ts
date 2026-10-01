export type TabType = 'map' | 'orders' | 'applications' | 'vendors' | 'drivers' | 'customers' | 'analytics';

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

export interface OrderItem {
  id?: string;
  itemId?: string;
  name: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  vendorId?: string;
  vendorName: string;
  driverId?: string;
  driverName?: string;
  driverPhone?: string;
  items: OrderItem[];
  itemsCount: number;
  totalAmount: number;
  deliveryFee: number;
  dropoffHostel: string;
  dropoffNotes?: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  otpCode?: string | null;
  createdAt: string;
  updatedAt?: string;
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
  activeOrdersCount: number;
  menuItems?: MenuItem[];
  approvalStatus?: ApprovalStatus;
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
}

export interface DriverPartner {
  id: string;
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

export const normalizeOrder = (raw: any): Order => {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    id: String(raw?.id || ''),
    customerId: raw?.customerId || raw?.customer?.id,
    customerName: raw?.customerName || raw?.customer?.name || 'Unknown student',
    customerPhone: raw?.customerPhone || raw?.customer?.phone,
    vendorId: raw?.vendorId || raw?.vendor?.id,
    vendorName: raw?.vendorName || raw?.vendor?.name || 'Unknown vendor',
    driverId: raw?.driverId || raw?.driver?.id,
    driverName: raw?.driverName || raw?.driver?.name,
    driverPhone: raw?.driverPhone || raw?.driver?.phone,
    items: items.map((item: any) => ({
      id: item.id,
      itemId: item.itemId || item.menuItemId,
      name: item.name || 'Unnamed item',
      quantity: asNumber(item.quantity, 1),
      price: asNumber(item.price),
    })),
    itemsCount: raw?.itemsCount ?? items.reduce((sum: number, item: any) => sum + asNumber(item.quantity, 1), 0),
    totalAmount: asNumber(raw?.totalAmount),
    deliveryFee: asNumber(raw?.deliveryFee),
    dropoffHostel: raw?.dropoffHostel || 'Unspecified drop-off',
    dropoffNotes: raw?.dropoffNotes,
    status: raw?.status || 'PLACED',
    paymentStatus: raw?.paymentStatus || 'PENDING',
    otpCode: raw?.otpCode,
    createdAt: raw?.createdAt || new Date().toISOString(),
    updatedAt: raw?.updatedAt,
  };
};

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
  activeOrdersCount: asNumber(raw?.activeOrdersCount ?? raw?._count?.orders),
  menuItems: Array.isArray(raw?.menuItems) ? raw.menuItems : undefined,
  approvalStatus: raw?.approvalStatus,
});

export const normalizeDriver = (raw: any): DriverPartner => ({
  id: String(raw?.id || raw?.userId || ''),
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
  vendor?: { name: string; category: string; address: string; fssaiNumber: string | null; isAcceptingOrders: boolean };
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
}
