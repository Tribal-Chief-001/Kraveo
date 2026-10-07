import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { OrderItem } from '../types';
import { getSettings } from '../services/settings';
import { computeFees, FeeBreakdown, splitGroupMoney } from '../services/pricing';

/** What the restaurant earns and Kraveo keeps for one line, copied from the dish at order time (Docs/21 section 2). */
export type PricedItem = OrderItem & { vendorUnitPrice: number; commissionUnit: number };

export interface OrderValidationResult {
  isValid: boolean;
  errorMessage?: string;
  verifiedItems: PricedItem[];
  calculatedSubtotal: number;
  /** The ONE all-in fee (Docs/21): delivery + GST + packaging + restaurant charge. Stored in Order.deliveryFee. */
  calculatedDeliveryFee: number;
  /** Always 0 for new orders (the old separate Rs 15 is gone); the column stays for old orders. */
  calculatedTaxAndPackaging: number;
  /** sum(vendorUnitPrice x qty): what the restaurant earns. */
  calculatedVendorSubtotal: number;
  /** subtotal - vendorSubtotal: what Kraveo keeps (commission and rounding). */
  calculatedCommissionTotal: number;
  feeBreakdown: FeeBreakdown | null;
  calculatedDiscount: number;
  calculatedTotalAmount: number;
  /** The normalised code that produced `calculatedDiscount` (null when no coupon was sent or it gave nothing). */
  appliedCoupon?: string | null;
  /** Set when a coupon WAS sent but gives no discount for this cart (unknown code, cart below the minimum). */
  couponProblem?: string;
}

// ----------------------------------------------------------------------------
// Coupons. Rules (single use per customer; a CANCELLED order releases its code again):
//   VITFIRST  20% off up to Rs 50, cart >= Rs 100, only for a customer with no earlier non-cancelled order.
//   KRAVEO20  Rs 20 off, cart >= Rs 80. Paid for with 50 Kraveo Coins (POST /coupons/redeem-coins): each
//             redemption is one use; the code is refused when the customer has no unused redemption.
//   KRAVEO50  Rs 50 off, cart >= Rs 150, once per customer.
// ----------------------------------------------------------------------------
export const COUPONS: Record<string, { minSubtotal: number; discount: (subtotal: number) => number }> = {
  VITFIRST: { minSubtotal: 100, discount: (sub) => Math.min(sub * 0.2, 50) },
  KRAVEO20: { minSubtotal: 80, discount: () => 20 },
  KRAVEO50: { minSubtotal: 150, discount: () => 50 },
};

/** '', undefined, null and whitespace mean "no coupon". Otherwise upper-case and trimmed. */
export const normaliseCoupon = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return code ? code : null;
};

/**
 * Whether THIS customer may use `code` now. Call it inside the order transaction while the customer's
 * row is locked (so two checkouts cannot both take the same single-use code). Returns a message when not allowed.
 */
export const couponEligibilityProblem = async (tx: Prisma.TransactionClient, customerId: string, code: string): Promise<string | null> => {
  const usedBefore = await tx.order.count({ where: { customerId, couponCode: code, status: { not: 'CANCELLED' } } });
  if (code === 'KRAVEO20') {
    const user = await tx.user.findUnique({ where: { id: customerId }, select: { kraveo20Redeemed: true } });
    if ((user?.kraveo20Redeemed ?? 0) - usedBefore <= 0) return 'KRAVEO20 needs 50 Kraveo Coins: redeem them first, then use the code.';
    return null;
  }
  if (usedBefore > 0) return `You have already used ${code}.`;
  if (code === 'VITFIRST') {
    const earlier = await tx.order.count({ where: { customerId, status: { not: 'CANCELLED' } } });
    if (earlier > 0) return 'VITFIRST is only for your first order.';
  }
  return null;
};

// The fee is no longer a constant: it is the admin setting `fees` (services/settings.ts, defaults in services/pricing.ts).
export const MAX_ITEM_QUANTITY = 20;
export const MAX_CART_LINES = 30;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One restaurant's cart, validated against the database: what the customer pays for the food and what the restaurant earns. */
export type VendorCartResult =
  | { ok: true; verifiedItems: PricedItem[]; subtotal: number; vendorSubtotal: number; commissionTotal: number }
  | { ok: false; errorMessage: string };

/**
 * Item validation and price snapshot of ONE restaurant's cart (shared by single orders and by every restaurant of a group).
 * Only dishes a customer may see count: approved and not deleted. A pending, rejected or deleted dish answers exactly like a dish
 * that does not exist (no hint that it is there).
 */
export const priceVendorCart = async (vendorId: string, items: { itemId: string; quantity: number }[]): Promise<VendorCartResult> => {
  if (!items || !Array.isArray(items) || items.length === 0 || items.length > MAX_CART_LINES) {
    return { ok: false, errorMessage: 'Cart items must be a non-empty array.' };
  }

  const itemIds = items.map((i) => (i && typeof i === 'object' && typeof i.itemId === 'string' ? i.itemId : '')).filter(Boolean);
  const dbMenuItems = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, vendorId, approvalStatus: 'APPROVED', deletedAt: null }
  });

  const menuItemMap = new Map(dbMenuItems.map((item) => [item.id, item]));

  let subtotal = 0;
  let vendorSubtotal = 0;
  const verifiedItems: PricedItem[] = [];

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object' || !Number.isInteger(rawItem.quantity) || rawItem.quantity <= 0 || rawItem.quantity > MAX_ITEM_QUANTITY) {
      return { ok: false, errorMessage: `Invalid quantity '${rawItem?.quantity}' for item ${rawItem?.itemId}.` };
    }

    const menuItem = menuItemMap.get(rawItem.itemId);

    if (!menuItem) {
      return { ok: false, errorMessage: `Item '${rawItem.itemId}' is not available at this dhaba.` };
    }

    if (!menuItem.isAvailable) {
      return { ok: false, errorMessage: `Item '${menuItem.name}' is currently SOLD OUT.` };
    }

    const itemTotal = menuItem.price * rawItem.quantity;
    subtotal += itemTotal;
    vendorSubtotal += menuItem.vendorPrice * rawItem.quantity;

    verifiedItems.push({
      itemId: menuItem.id,
      name: menuItem.name,
      quantity: rawItem.quantity,
      price: menuItem.price,
      vendorUnitPrice: menuItem.vendorPrice,
      // What Kraveo keeps per unit: the stored customer price minus the restaurant's price (commission and rounding).
      commissionUnit: Math.round((menuItem.price - menuItem.vendorPrice) * 100) / 100,
    });
  }

  // Rupee amounts with paise precision, so total = subtotal + fee - discount exactly in paise.
  // The subtotal is rounded BEFORE any threshold is compared (0.7 x 14 + 8.2 x 11 is 99.99999999999999 in floats, i.e. Rs 100.00).
  subtotal = round2(subtotal);
  vendorSubtotal = round2(vendorSubtotal);
  return { ok: true, verifiedItems, subtotal, vendorSubtotal, commissionTotal: round2(subtotal - vendorSubtotal) };
};

/** The coupon rule for a food subtotal (the combined subtotal for a group): the discount, or a message when the code gives nothing. */
export const applyCouponRule = (couponCode: unknown, subtotal: number): { discount: number; appliedCoupon: string | null; couponProblem?: string } => {
  const code = normaliseCoupon(couponCode);
  if (!code) return { discount: 0, appliedCoupon: null };
  const rule = COUPONS[code];
  if (!rule) return { discount: 0, appliedCoupon: null, couponProblem: `The coupon ${code.slice(0, 30)} is not valid.` };
  if (subtotal < rule.minSubtotal) return { discount: 0, appliedCoupon: null, couponProblem: `${code} needs an order of at least ₹${rule.minSubtotal}.` };
  return { discount: round2(rule.discount(subtotal)), appliedCoupon: code };
};

// Recalculates total price on server side to prevent client pricing tampering
export const validateAndCalculateOrder = async (
  vendorId: string, 
  items: { itemId: string; quantity: number }[],
  couponCode?: string
): Promise<OrderValidationResult> => {
  const settings = await getSettings();
  const invalid = {
    calculatedSubtotal: 0,
    calculatedDeliveryFee: settings.fees.baseFee,
    calculatedTaxAndPackaging: 0,
    calculatedVendorSubtotal: 0,
    calculatedCommissionTotal: 0,
    feeBreakdown: null,
    calculatedDiscount: 0,
    calculatedTotalAmount: settings.fees.baseFee,
  };
  const cart = await priceVendorCart(vendorId, items);
  if (!cart.ok) {
    return { isValid: false, errorMessage: cart.errorMessage, verifiedItems: [], ...invalid };
  }
  const { verifiedItems, subtotal, vendorSubtotal, commissionTotal } = cart;

  // The one all-in fee from the admin settings. Thresholds look at the food subtotal BEFORE the coupon (the platform bears coupons).
  const fee = computeFees(settings.fees, subtotal);
  const deliveryFee = fee.total;
  const taxAndPackaging = 0;

  const { discount, appliedCoupon, couponProblem } = applyCouponRule(couponCode, subtotal);

  const totalAmount = round2(Math.max(0, subtotal + deliveryFee + taxAndPackaging - discount));

  return {
    isValid: true,
    verifiedItems,
    calculatedSubtotal: subtotal,
    calculatedDeliveryFee: deliveryFee,
    calculatedTaxAndPackaging: taxAndPackaging,
    calculatedVendorSubtotal: vendorSubtotal,
    calculatedCommissionTotal: commissionTotal,
    feeBreakdown: fee.breakdown,
    calculatedDiscount: discount,
    calculatedTotalAmount: totalAmount,
    appliedCoupon,
    ...(couponProblem ? { couponProblem } : {}),
  };
};

// ----------------------------------------------------------------------------
// Docs/22: the price of a multi-restaurant order
// ----------------------------------------------------------------------------
export type GroupRestaurantInput = { vendorId: string; items: { itemId: string; quantity: number }[] };

export interface GroupChildPricing {
  vendorId: string;
  verifiedItems: PricedItem[];
  subtotal: number;
  vendorSubtotal: number;
  commissionTotal: number;
  /** Child 0: base fee part, every other child: the extra-restaurant fee. */
  deliveryFee: number;
  discount: number;
  totalAmount: number;
  feeBreakdown: FeeBreakdown;
}

export interface GroupValidationResult {
  isValid: boolean;
  errorMessage?: string;
  /** The restaurant whose cart is invalid (for the message). */
  errorVendorId?: string;
  children: GroupChildPricing[];
  subtotal: number;
  feeTotal: number;
  discount: number;
  totalAmount: number;
  /** The fee of the whole group (computeFees on the COMBINED subtotal). */
  feeBreakdown: FeeBreakdown | null;
  appliedCoupon: string | null;
  couponProblem?: string;
}

/**
 * Prices 2..N restaurants as ONE checkout: every restaurant's cart is validated like a single order, the fee (free-fee and small-order
 * rules included) and the coupon (minimum, VITFIRST) look at the COMBINED food subtotal, and the money is split over the children
 * in paise so that the children add up to the group total exactly (services/pricing.ts splitGroupMoney).
 * The caller has already checked the number of restaurants and that they are distinct.
 */
export const validateAndCalculateGroup = async (restaurants: GroupRestaurantInput[], couponCode?: string): Promise<GroupValidationResult> => {
  const settings = await getSettings();
  const empty: GroupValidationResult = { isValid: false, children: [], subtotal: 0, feeTotal: 0, discount: 0, totalAmount: 0, feeBreakdown: null, appliedCoupon: null };
  const carts: Extract<VendorCartResult, { ok: true }>[] = [];
  for (const r of restaurants) {
    const cart = await priceVendorCart(r.vendorId, r.items);
    if (!cart.ok) return { ...empty, errorMessage: cart.errorMessage, errorVendorId: r.vendorId };
    carts.push(cart);
  }
  const combined = round2(carts.reduce((sum, c) => sum + c.subtotal, 0));
  const { discount, appliedCoupon, couponProblem } = applyCouponRule(couponCode, combined);
  const money = splitGroupMoney(settings.fees, carts.map((c) => c.subtotal), discount);
  const children = carts.map((c, i): GroupChildPricing => {
    const m = money.children[i];
    const extra = i > 0;
    return {
      vendorId: restaurants[i].vendorId,
      verifiedItems: c.verifiedItems,
      subtotal: c.subtotal,
      vendorSubtotal: c.vendorSubtotal,
      commissionTotal: c.commissionTotal,
      deliveryFee: m.fee,
      discount: m.discount,
      totalAmount: m.total,
      // Records only: child 0 = the base-fee part (free-fee / small-order rules applied to the combined subtotal), the others = the flat extra fee.
      feeBreakdown: extra
        ? { version: 1, total: m.fee, baseFee: 0, baseWaived: false, smallOrderFee: 0, restaurants: 1, extraRestaurantFee: m.fee, extraRestaurants: 1, lines: [] }
        : { ...money.breakdown, total: m.fee, restaurants: 1, extraRestaurantFee: 0, extraRestaurants: 0 },
    };
  });
  return {
    isValid: true,
    children,
    subtotal: money.subtotal,
    feeTotal: money.feeTotal,
    discount: money.discount,
    totalAmount: money.total,
    feeBreakdown: money.breakdown,
    appliedCoupon,
    ...(couponProblem ? { couponProblem } : {}),
  };
};
