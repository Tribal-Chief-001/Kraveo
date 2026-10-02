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
}

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

  let discount = 0;
  if (typeof couponCode === 'string' && couponCode) {
    const code = couponCode.trim().toUpperCase();
    if (code === 'VITFIRST' && subtotal >= 100) {
      discount = Math.min(subtotal * 0.20, 50);
    } else if (code === 'KRAVEO20' && subtotal >= 80) {
      discount = 20;
    } else if (code === 'KRAVEO50' && subtotal >= 150) {
      discount = 50;
    }
  }

  // Rupee amounts with paise precision, so total = subtotal + fee + tax - discount exactly in paise.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  subtotal = round2(subtotal);
  discount = round2(discount);
  const totalAmount = round2(Math.max(0, subtotal + deliveryFee + taxAndPackaging - discount));

  return {
    isValid: true,
    verifiedItems,
    calculatedSubtotal: subtotal,
    calculatedDeliveryFee: deliveryFee,
    calculatedTaxAndPackaging: taxAndPackaging,
    calculatedDiscount: discount,
    calculatedTotalAmount: totalAmount
  };
};
