import { OrderStatus } from '../types';

// State transition map enforcing strictly valid order state flows
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PLACED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['ARRIVED_AT_GATE', 'CANCELLED'],
  ARRIVED_AT_GATE: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: []
};

export const isValidStateTransition = (currentStatus: OrderStatus, newStatus: OrderStatus): boolean => {
  if (currentStatus === newStatus) return true; // Idempotent
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  return allowed.includes(newStatus);
};

export const getNextAllowedStates = (currentStatus: OrderStatus): OrderStatus[] => {
  return VALID_TRANSITIONS[currentStatus] || [];
};
