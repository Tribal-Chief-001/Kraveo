import { menuItems } from '../store';
import { OrderItem } from '../types';

export interface OrderValidationResult {
  isValid: boolean;
  errorMessage?: string;
  verifiedItems: OrderItem[];
  calculatedSubtotal: number;
  calculatedDeliveryFee: number;
  calculatedTotalAmount: number;
}

// Recalculates total price on server side to prevent client pricing tampering
export const validateAndCalculateOrder = (vendorId: string, items: { itemId: string; quantity: number }[]): OrderValidationResult => {
  if (!items || items.length === 0) {
    return {
      isValid: false,
      errorMessage: 'Cart cannot be empty.',
      verifiedItems: [],
      calculatedSubtotal: 0,
      calculatedDeliveryFee: 30,
      calculatedTotalAmount: 30
    };
  }

  let subtotal = 0;
  const verifiedItems: OrderItem[] = [];

  for (const rawItem of items) {
    if (!rawItem.quantity || rawItem.quantity <= 0) {
      return {
        isValid: false,
        errorMessage: `Invalid quantity '${rawItem.quantity}' for item ${rawItem.itemId}.`,
        verifiedItems: [],
        calculatedSubtotal: 0,
        calculatedDeliveryFee: 30,
        calculatedTotalAmount: 30
      };
    }

    const menuItem = menuItems.find((i) => i.id === rawItem.itemId && i.vendorId === vendorId);

    if (!menuItem) {
      return {
        isValid: false,
        errorMessage: `Item '${rawItem.itemId}' is not available at this dhaba.`,
        verifiedItems: [],
        calculatedSubtotal: 0,
        calculatedDeliveryFee: 30,
        calculatedTotalAmount: 30
      };
    }

    if (!menuItem.isAvailable) {
      return {
        isValid: false,
        errorMessage: `Item '${menuItem.name}' is currently SOLD OUT.`,
        verifiedItems: [],
        calculatedSubtotal: 0,
        calculatedDeliveryFee: 30,
        calculatedTotalAmount: 30
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

  const deliveryFee = 30; // ₹30 flat campus drop-off fee
  const totalAmount = subtotal + deliveryFee;

  return {
    isValid: true,
    verifiedItems,
    calculatedSubtotal: subtotal,
    calculatedDeliveryFee: deliveryFee,
    calculatedTotalAmount: totalAmount
  };
};
