/** Push notifications (Docs/18_push_notifications_contract.md). Shared types. */

export type PushApp = 'CUSTOMER' | 'VENDOR' | 'DRIVER';

export const PUSH_EVENTS = [
  'NEW_ORDER',
  'ORDER_CANCELLED_VENDOR',
  'NEW_DELIVERY',
  'DELIVERY_ASSIGNED',
  'DELIVERY_CANCELLED',
  'ORDER_ACCEPTED',
  'ORDER_READY',
  'ORDER_PICKED_UP',
  'RIDER_AT_GATE',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'REFUND_PROCESSED',
] as const;
export type PushEvent = (typeof PUSH_EVENTS)[number];

export type PushLogStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

/** Exactly what is handed to the provider for one device. `data` carries strings only: event, orderId, v. */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  channelId: string;
  priority: 'high' | 'normal';
  ttlSeconds: number;
  collapseKey: string;
  data: { event: string; orderId: string; v: '1' };
}

/**
 * Sends one message to one device. Resolves when FCM accepted it; throws when it did not. The thrown error should carry
 * the FCM error code in `.code` (firebase-admin does: `messaging/registration-token-not-registered`, ...).
 * `enabled` is false for the no-op provider (nothing configured): the push code then does no work at all.
 */
export interface PushProvider {
  readonly enabled: boolean;
  send(message: PushMessage): Promise<void>;
  /** Optional boot-time self test: a dry-run send that proves FCM accepts our credentials. Never delivers anything. */
  verify?(): Promise<{ ok: boolean; code?: string }>;
}

export interface PushOptions {
  /** Specific recipient for DELIVERY_ASSIGNED / DELIVERY_CANCELLED (the rider); ignored by the other events. */
  userId?: string;
}
