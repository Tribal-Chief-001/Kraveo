/**
 * Order flow constants (Docs/16_order_flow_contract.md). One place, env-overridable so tests and
 * operations can change a window without a code change. Read at call time, never cached.
 */
const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** An unpaid order is cancelled by the server after this many minutes. */
export const paymentWindowMin = () => envNumber('PAYMENT_WINDOW_MIN', 15);
/** A paid order the restaurant has not accepted is cancelled (and refunded) after this many minutes. */
export const vendorAcceptWindowMin = () => envNumber('VENDOR_ACCEPT_WINDOW_MIN', 10);

export const MAX_UNPAID_OPEN_ORDERS = 3;
export const MAX_ACTIVE_ORDERS_PER_RIDER = 1;
export const OTP_MAX_ATTEMPTS = 5;
/** `scope=active` also returns orders that finished this recently, so the app can show the final state. */
export const RECENTLY_FINISHED_MIN = 10;
export const POOL_LIMIT = 20;
export const MAINTENANCE_INTERVAL_MS = 60_000;
/** Automatic refund retries stop after this many attempts; the order stays in needs-attention. */
export const MAX_REFUND_ATTEMPTS = 10;
/** A refund worker owns the order for this long; after that another worker (the job) may retry. */
export const REFUND_LEASE_MS = 2 * 60_000;
/** Provider calls (Razorpay) give up after this long so a hung request never blocks a worker forever. */
export const PROVIDER_TIMEOUT_MS = 15_000;

/** needs-attention thresholds (minutes). */
export const READY_NO_RIDER_ALERT_MIN = 10;
export const DELIVERY_STUCK_ALERT_MIN = 60;
export const RIDER_PICKUP_ALERT_MIN = 15;
export const REFUND_PENDING_ALERT_MIN = 5;

/**
 * Campus drop points. The customer app shows `Block 1`..`Block 6`, `Girls Gate 1/2`, `VIT Main Gate`
 * (apps/customer_app/lib/widgets/ui/hostel_pill.dart); older app builds and profiles used the long
 * `Boys Hostel Block N` / `Girls Hostel Gate N` names. The server accepts the union (same as the
 * profile HOSTEL_RE in routes/api.ts).
 */
export const DROP_POINTS = ['Block 1', 'Block 2', 'Block 3', 'Block 4', 'Block 5', 'Block 6', 'Girls Gate 1', 'Girls Gate 2', 'VIT Main Gate'];
export const DROP_POINT_RE = /^(Block [1-6]|Girls Gate [12]|VIT Main Gate|Boys Hostel Block [1-6]|Girls Hostel Gate [12])$/;
