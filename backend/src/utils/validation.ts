import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { OrderItem } from '../types';

export interface OrderValidationResult {
  isValid: boolean;
  errorMessage?: string;
  verifiedItems: OrderItem[];
  calculatedSubtotal: number;
  calculatedDeliveryFee: number;
  calculatedTaxAndPackaging: number;
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

export const DELIVERY_FEE = 25; // ₹25 flat campus drop-off fee
export const TAX_AND_PACKAGING = 15; // ₹15 packaging & GST fee
export const MAX_ITEM_QUANTITY = 20;
export const MAX_CART_LINES = 30;

// Recalculates total price on server side to prevent client pricing tampering
export const validateAndCalculateOrder = async (
  vendorId: string, 
  items: { itemId: string; quantity: number }[],
  couponCode?: string
): Promise<OrderValidationResult> => {
  if (!items || !Array.isArray(items) || items.length === 0 || items.length > MAX_CART_LINES) {
    return {
      isValid: false,
      errorMessage: 'Cart items must be a non-empty array.',
      verifiedItems: [],
      calculatedSubtotal: 0,
      calculatedDeliveryFee: 25,
      calculatedTaxAndPackaging: 0,
      calculatedDiscount: 0,
      calculatedTotalAmount: 25
    };
  }

  const itemIds = items.map((i) => (i && typeof i === 'object' && typeof i.itemId === 'string' ? i.itemId : '')).filter(Boolean);
  const dbMenuItems = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, vendorId }
  });

  const menuItemMap = new Map(dbMenuItems.map((item) => [item.id, item]));

  let subtotal = 0;
  const verifiedItems: OrderItem[] = [];

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object' || !Number.isInteger(rawItem.quantity) || rawItem.quantity <= 0 || rawItem.quantity > MAX_ITEM_QUANTITY) {
      return {
        isValid: false,
        errorMessage: `Invalid quantity '${rawItem?.quantity}' for item ${rawItem?.itemId}.`,
        verifiedItems: [],
        calculatedSubtotal: 0,
        calculatedDeliveryFee: 25,
        calculatedTaxAndPackaging: 0,
        calculatedDiscount: 0,
        calculatedTotalAmount: 25
      };
    }

    const menuItem = menuItemMap.get(rawItem.itemId);

    if (!menuItem) {
      return {
        isValid: false,
        errorMessage: `Item '${rawItem.itemId}' is not available at this dhaba.`,
        verifiedItems: [],
        calculatedSubtotal: 0,
        calculatedDeliveryFee: 25,
        calculatedTaxAndPackaging: 0,
        calculatedDiscount: 0,
        calculatedTotalAmount: 25
      };
    }

    if (!menuItem.isAvailable) {
      return {
        isValid: false,
        errorMessage: `Item '${menuItem.name}' is currently SOLD OUT.`,
        verifiedItems: [],
        calculatedSubtotal: 0,
        calculatedDeliveryFee: 25,
        calculatedTaxAndPackaging: 0,
        calculatedDiscount: 0,
        calculatedTotalAmount: 25
      };
    }

    const itemTotal = menuItem.price * rawItem.quantity;
    subtotal += itemTotal;

    verifiedItems.push({
      itemId: menuItem.id,
      name: menuItem.name,
      quantity: rawItem.quantity,
      price: menuItem.price
    });
  }

  const deliveryFee = DELIVERY_FEE;
  const taxAndPackaging = TAX_AND_PACKAGING;

  // Rupee amounts with paise precision, so total = subtotal + fee + tax - discount exactly in paise.
  // The subtotal is rounded BEFORE any threshold is compared (0.7 x 14 + 8.2 x 11 is 99.99999999999999 in floats, i.e. Rs 100.00).
  const round2 = (n: number) => Math.round(n * 100) / 100;
  subtotal = round2(subtotal);

  let discount = 0;
  let appliedCoupon: string | null = null;
  let couponProblem: string | undefined;
  const code = normaliseCoupon(couponCode);
  if (code) {
    const rule = COUPONS[code];
    if (!rule) couponProblem = `The coupon ${code.slice(0, 30)} is not valid.`;
    else if (subtotal < rule.minSubtotal) couponProblem = `${code} needs an order of at least ₹${rule.minSubtotal}.`;
    else {
      discount = round2(rule.discount(subtotal));
      appliedCoupon = code;
    }
  }

  const totalAmount = round2(Math.max(0, subtotal + deliveryFee + taxAndPackaging - discount));

  return {
    isValid: true,
    verifiedItems,
    calculatedSubtotal: subtotal,
    calculatedDeliveryFee: deliveryFee,
    calculatedTaxAndPackaging: taxAndPackaging,
    calculatedDiscount: discount,
    calculatedTotalAmount: totalAmount,
    appliedCoupon,
    ...(couponProblem ? { couponProblem } : {}),
  };
};
