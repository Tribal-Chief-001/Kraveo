// Answers of the admin user-management API (Docs/28 "Implementation notes", backend commit 95af6bc), written from the notes' real
// JSON examples and from the backend serializers (services/customerAdmin.ts, riderAdmin.ts, vendorAdmin.ts, ownerAdmin.ts,
// routes/adminAudit.ts, routes/partners.ts applicationRow). Ids are shortened but keep the real shape. Tests build their data from these.

export const CUSTOMER_ID = 'zc-cust-1';
export const ORDER_ID = '6aa89843-3c5b-4f49-9a41-0f2f9d1c7a10';

/** One row of GET /api/admin/customers. `openOrders` is a COUNT on a row. */
export const rawCustomerRow = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: CUSTOMER_ID, name: 'Cust1 Tester', email: 'cust1@example.com', phone: '+91 9876500001', isStudent: true, hostelBlock: 'BH1', avatarId: 3, kraveoCoins: 40,
  createdAt: '2026-10-02T08:00:00.000Z', deleted: false, accountStatus: 'ACTIVE', statusReason: null, statusChangedAt: null, lastLoginAt: '2026-10-28T17:30:00.000Z',
  ordersCount: 4, totalSpent: 820, lastOrderAt: '2026-10-28T12:10:00.000Z', openOrders: 0, ...over,
});

export const rawCustomerList = (rows: Record<string, unknown>[] = [rawCustomerRow()], over: Record<string, unknown> = {}) => ({ success: true, total: rows.length, nextCursor: null, data: rows, ...over });

/** The order shown under "in progress" and in 409 HAS_OPEN_ORDERS (real shape from the notes). */
export const rawOpenOrder = (over: Record<string, unknown> = {}) => ({ id: ORDER_ID, status: 'PLACED', paymentStatus: 'PAID', totalAmount: 205, ...over });

/** GET /api/admin/customers/:id (and the `data` of suspend / restore / remove). */
export const rawCustomerDetail = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: CUSTOMER_ID, name: 'Cust1 Tester', email: 'cust1@example.com', phone: '+91 9876500001', isStudent: true, hostelBlock: 'BH1', avatarId: 3, kraveoCoins: 40,
  createdAt: '2026-10-02T08:00:00.000Z', deleted: false, accountStatus: 'ACTIVE', statusReason: null, statusChangedAt: null, lastLoginAt: '2026-10-28T17:30:00.000Z',
  statusChangedBy: null, openOrders: [], refundsOwed: [],
  stats: { ordersCount: 4, deliveredCount: 3, cancelledCount: 1, activeCount: 0, paidOrdersCount: 3, totalSpent: 820, firstOrderAt: '2026-10-03T08:00:00.000Z', lastOrderAt: '2026-10-28T12:10:00.000Z' },
  orders: [{
    id: 'ord-delivered-1', status: 'DELIVERED', paymentStatus: 'PAID', totalAmount: 205, deliveryFee: 15, dropoffHostel: 'BH1', dropoffNotes: null, createdAt: '2026-10-28T12:10:00.000Z',
    vendor: { id: 'v1', name: 'Sharma Dhaba' }, driver: { id: 'u-rider-1', name: 'Ravi', phone: '+91 9000000001' },
    items: [{ name: 'Paneer roll', quantity: 2, price: 80 }], payments: [{ id: 'pay1', razorpayPaymentId: 'pay_abc123', amount: 205, status: 'PAID', createdAt: '2026-10-28T12:11:00.000Z' }],
  }],
  ...over,
});

export const rawSuspendedDetail = (over: Record<string, unknown> = {}) => rawCustomerDetail({ accountStatus: 'SUSPENDED', statusReason: 'Fake orders', statusChangedAt: '2026-10-29T06:00:00.000Z', statusChangedBy: 'zc-admin-0', ...over });
export const rawRemovedDetail = (over: Record<string, unknown> = {}) => rawCustomerDetail({ accountStatus: 'REMOVED', statusReason: 'Fraud', statusChangedAt: '2026-10-29T06:00:00.000Z', statusChangedBy: 'zc-admin-0', ...over });
export const rawSelfDeletedDetail = () => rawCustomerDetail({ name: 'Deleted user', email: null, phone: null, deleted: true });

/** Success answer of suspend / remove / restore. */
export const rawCustomerAction = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ success: true, changed: true, data, ...extra });

/** Real answer of a suspend with a paid order and openOrders:'CANCEL' (Docs/28 section 2). */
export const rawCancelled = () => ({ cancelled: [{ orderId: ORDER_ID, groupId: null, cancelledOrders: 1, refund: 'STARTED' }], failed: [] });

// ── 4xx / 409 bodies (real shapes) ──
export const rawHasOpenOrders = (orders: unknown[] = [rawOpenOrder()]) => ({
  success: false, code: 'HAS_OPEN_ORDERS', message: 'This customer has 1 order(s) in progress. Cancel them first, or choose to cancel them with this action.', openOrders: orders,
});
export const rawOrderInDelivery = (orders: unknown[] = [rawOpenOrder({ status: 'PICKED_UP' })]) => ({
  success: false, code: 'ORDER_IN_DELIVERY', message: 'An order is with a rider right now. Wait until it is delivered, or have the rider return it, then try again.', orders,
});
export const rawRefundNotSettled = () => ({ success: false, code: 'REFUND_NOT_SETTLED', message: 'A refund for this customer has not reached them yet. Settle it before erasing their details.', orders: [ORDER_ID] });
export const rawConfirmMismatch = () => ({ success: false, code: 'CONFIRM_MISMATCH', field: 'confirmName', message: 'The name you typed does not match.' });
export const rawBadReason = () => ({ success: false, code: 'BAD_REQUEST', field: 'reason', message: 'Reason must be 3 to 200 characters.' });
export const rawRateLimited = () => ({ success: false, code: 'RATE_LIMITED', message: 'Too many admin changes in a short time. Try again in a few minutes.' });
export const rawTokenRevoked = () => ({ success: false, code: 'TOKEN_REVOKED', message: 'Please sign in again.' });
export const rawHasActiveDelivery = (orders: unknown[] = [{ id: 'ord-active-1', status: 'ACCEPTED' }]) => ({
  success: false, code: 'HAS_ACTIVE_DELIVERY', message: 'The rider has 1 delivery(ies) in hand. Reassign them first, or release them back to the pool with this action.', orders,
});
export const rawFoodWithRider = (orders: unknown[] = [{ id: 'ord-picked-1', status: 'PICKED_UP' }]) => ({
  success: false, code: 'FOOD_WITH_RIDER', message: 'The rider is carrying food right now. Reassign the order to another rider or cancel it first.', orders,
});
export const rawVendorHasOpenOrders = (orders: unknown[] = [rawOpenOrder()]) => ({
  success: false, code: 'HAS_OPEN_ORDERS', message: 'This restaurant has 1 order(s) in progress. Cancel them first, or choose to cancel them with this action.', orders,
});
export const rawNoOwner = () => ({ success: false, code: 'NO_OWNER', message: 'Add an owner login first.' });

// ── riders ──
export const rawRiderImpact = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { driverId: 'drv-1', userId: 'u-rider-1', name: 'Ravi', approvalStatus: 'APPROVED', accountStatus: 'ACTIVE', activeDeliveries: [], foodWithRider: [], ...over },
});

/** The applicationRow answer of remove / restore (real, Docs/28 section 3). */
export const rawRiderApplication = (over: Record<string, unknown> = {}) => ({
  id: 'drv-1', kind: 'DRIVER', userId: 'u-rider-1', name: 'Ravi', phone: '+91 9000000001', status: 'SUSPENDED', rejectionReason: 'Left the company', selfSignup: false,
  appliedAt: '2026-10-02T08:00:00.000Z', reviewedAt: '2026-10-29T06:00:00.000Z', createdAt: '2026-10-02T08:00:00.000Z', accountStatus: 'REMOVED', removedAt: null,
  driver: { runnerCode: 'R1', vehicleType: 'Bike', vehicleRegNo: 'MP04AB1234', emergencyPhone: null, upiId: null }, ...over,
});

/** A row of GET /api/drivers (DriverPartner with the user block). */
export const rawDriverRow = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: 'drv-1', userId: 'u-rider-1', name: 'Ravi', phone: '+91 9000000001', studentRegNo: '', runnerCode: 'R1', vehicleType: 'Bike', vehicleRegNo: 'MP04AB1234', emergencyPhone: '',
  dutyStatus: 'OFFLINE', approvalStatus: 'APPROVED', createdAt: '2026-10-02T08:00:00.000Z',
  user: { id: 'u-rider-1', name: 'Ravi', phone: '+91 9000000001', role: 'DRIVER', avatarId: null, createdAt: '2026-10-02T08:00:00.000Z', accountStatus: 'ACTIVE', lastLoginAt: '2026-10-28T17:30:00.000Z' }, ...over,
});

// ── restaurants and owners ──
export const rawOwner = (over: Record<string, unknown> = {}) => ({ id: 'zc-vown-2', name: 'Owner2 Kitchen', phone: '+91 9777620002', accountStatus: 'ACTIVE', statusReason: null, lastLoginAt: null, ...over });

/** A restaurant as GET /api/vendors shows it to an admin (Docs/28 section 4). `owner: null` = ownerless. */
export const rawAdminVendor = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: 'ven-1', userId: 'zc-vown-2', name: 'Sharma Dhaba', category: 'North Indian', rating: 4.5, totalRatingsCount: 12, isAcceptingOrders: true, address: 'Ashta road, gate 4',
  lat: 23.0745, lng: 76.859, hasLocation: true, approvalStatus: 'APPROVED', menuItems: [], cuisines: [], owner: rawOwner(), removedAt: null, removedReason: null, ownerDisabledByRemoval: false, ...over,
});
export const rawOwnerlessVendor = (over: Record<string, unknown> = {}) => rawAdminVendor({ id: 'ven-2', userId: null, name: 'Imported Biryani House', isAcceptingOrders: false, owner: null, ...over });
export const rawRemovedVendor = (over: Record<string, unknown> = {}) => rawAdminVendor({ id: 'ven-3', name: 'Closed Canteen', isAcceptingOrders: false, approvalStatus: 'SUSPENDED', removedAt: '2026-10-29T05:00:00.000Z', removedReason: 'Closed for good', ...over });

export const rawVendorImpact = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { vendorId: 'ven-1', name: 'Sharma Dhaba', approvalStatus: 'APPROVED', removed: false, isAcceptingOrders: true, hasOwner: true, openOrders: [], inDelivery: [], unpaidSettlements: { count: 0, amount: 0 }, ...over },
});

export const rawVendorAction = (vendor: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ success: true, changed: true, data: vendor, ...extra });

/** ownerView (real, Docs/28 section 5). */
export const rawOwnerView = (over: Record<string, unknown> = {}) => ({ userId: 'zc-vown-9', name: 'New Owner', phone: '+91 9876543299', accountStatus: 'ACTIVE', statusReason: null, lastLoginAt: null, createdAt: '2026-10-29T06:00:00.000Z', restaurants: 1, ...over });
export const GENERATED = 'pZq7NwEu3KxT9sBd';
/** Real create answer: 201 { success, owner, generatedPassword, restaurantClosed, payoutAccountMoved }. */
export const rawOwnerCreate = (over: Record<string, unknown> = {}) => ({ success: true, owner: rawOwnerView(), generatedPassword: GENERATED, restaurantClosed: true, payoutAccountMoved: false, ...over });

// ── activity log ──
export const rawAuditRow = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: 'aud-1', createdAt: '2026-10-29T06:00:00.000Z', action: 'CUSTOMER_SUSPENDED', targetType: 'USER', targetId: 'zc-cust-1abcdef',
  summary: 'Suspended customer Cust1 Tester (zc-cust-): Fake orders; 1 open order(s) cancelled', actorId: 'zc-admin-0', actorName: 'Campus Dispatch Admin', ip: '203.0.113.9', ...over,
});
export const rawAuditPage = (rows: Record<string, unknown>[] = [rawAuditRow()], nextCursor: string | null = null) => ({ success: true, count: rows.length, nextCursor, data: rows });
export const rawAuditActions = () => ({ success: true, data: [{ action: 'CUSTOMER_SUSPENDED', count: 3 }, { action: 'ORDER_CANCELLED', count: 11 }, { action: 'OWNER_CREATED', count: 2 }, { action: 'PARTNER_SUSPENDED', count: 1 }, { action: 'SOMETHING_NEW', count: 1 }] });

// ── Docs/28 section 9 (review fixes, backend b32c265) ──
/** Bounded cancel: the first batch is done, the rest is listed in `remaining`; refunds report their real state. */
export const rawCancelBatch = (over: Record<string, unknown> = {}) => ({
  cancelled: [
    { orderId: 'ord-done-111111', groupId: null, cancelledOrders: 1, refund: 'DONE' },
    { orderId: 'ord-started-22222', groupId: null, cancelledOrders: 1, refund: 'STARTED' },
    { orderId: 'ord-failed-333333', groupId: null, cancelledOrders: 1, refund: 'FAILED', refundMessage: 'Razorpay is not reachable.' },
    { orderId: 'ord-unpaid-444444', groupId: 'g1', cancelledOrders: 2, refund: 'NONE' },
  ],
  failed: [],
  remaining: ['ord-rem-555555', 'ord-rem-666666'],
  ...over,
});
export const ISSUED_1 = '2026-10-29T08:00:00.000Z';
export const ISSUED_2 = '2026-10-29T08:00:05.000Z';
/** Real reset answer: { success, generatedPassword?, issuedAt }. */
export const rawResetPassword = (password = GENERATED, issuedAt = ISSUED_1) => ({ success: true, generatedPassword: password, issuedAt });
export const rawLoginNotActive = () => ({ success: false, code: 'LOGIN_NOT_ACTIVE', message: 'That owner login is paused for another reason, so it cannot be attached. It stays paused.' });
