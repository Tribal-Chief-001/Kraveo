// "Needs attention" problem catalogue and parser for GET /admin/orders/needs-attention.
// Server shape (backend/ORDER_FLOW_NOTES.md, Docs/fixtures/order_flow_samples.json):
//   { success, count, maxRefundAttempts, data: [{ problem, problems[], detail, since, hint, order: OrderView(admin) }] }
// One entry per order, most urgent first. `hint` is the server's advice; unknown codes still render generically.
import { AttentionEntry, AttentionProblem, Order, normalizeOrder } from '../types';
import { humanize, orderFlags, Tone } from './orders';

export type SuggestedAction = 'cancel' | 'reset-otp' | 'retry-refund' | 'assign' | 'call-vendor' | 'call-rider' | 'call-customer' | 'open';

export interface ProblemMeta {
  code: string;
  label: string;
  tone: Tone;
  /** What happened, in plain words. */
  explain: string;
  /** Fallback advice when the server sends no `hint`. */
  advice: string;
  /** The button shown first on the row. */
  action: SuggestedAction;
  /** Higher sorts first (only used for the local fallback list; the server already sorts). */
  weight: number;
}

/** The codes the backend emits (backend/ORDER_FLOW_NOTES.md "Admin playbook"). */
const CATALOGUE: Record<string, Omit<ProblemMeta, 'code'>> = {
  PAYMENT_MISMATCH: {
    label: 'Payment amount mismatch', tone: 'danger', weight: 100, action: 'cancel',
    explain: 'The captured amount is different from the order total, so the order was not marked paid.',
    advice: 'Refund the payment in the Razorpay dashboard, then cancel the order.',
  },
  DUPLICATE_PAYMENT: {
    label: 'Paid twice', tone: 'danger', weight: 98, action: 'open',
    explain: 'A second payment was captured on an order that was already paid.',
    advice: 'Refund the extra payment in the Razorpay dashboard.',
  },
  REFUND_FAILED: {
    label: 'Refund failed', tone: 'danger', weight: 95, action: 'retry-refund',
    explain: 'The payment provider refused or did not answer the refund. The server retries every minute, up to 10 times.',
    advice: 'Fix the cause, then retry the refund, or refund by hand in Razorpay (the next retry then marks it done).',
  },
  OTP_LOCKED: {
    label: 'Gate OTP locked', tone: 'danger', weight: 90, action: 'reset-otp',
    explain: 'The rider entered a wrong gate OTP 5 times, so delivery is blocked.',
    advice: 'Call the customer. Resetting the lock sends the customer a new gate code; or cancel the order.',
  },
  PAID_AFTER_CANCEL: {
    label: 'Paid after cancellation', tone: 'warning', weight: 80, action: 'open',
    explain: 'Money arrived for an order that was already cancelled. The refund normally clears within a minute.',
    advice: 'If it stays here (old orders), refund it in Razorpay.',
  },
  UNPAID_IN_PROGRESS: {
    label: 'Moving without payment', tone: 'warning', weight: 75, action: 'cancel',
    explain: 'An older order is progressing although it was never marked paid.',
    advice: 'Check Razorpay; cancel the order if it is really unpaid.',
  },
  STUCK_UNACCEPTED: {
    label: 'Restaurant not responding', tone: 'warning', weight: 70, action: 'call-vendor',
    explain: 'A paid order is still waiting for the restaurant to accept it.',
    advice: 'Call the restaurant; otherwise cancel (the refund is automatic).',
  },
  VENDOR_NOT_APPROVED: {
    label: 'Restaurant suspended', tone: 'warning', weight: 68, action: 'cancel',
    explain: 'The restaurant was suspended while this order was open.',
    advice: 'Cancel the order (the refund is automatic) unless the restaurant can still deliver it.',
  },
  RIDER_NOT_APPROVED: {
    label: 'Rider suspended', tone: 'warning', weight: 66, action: 'assign',
    explain: 'The assigned rider was suspended while carrying this order.',
    advice: 'Reassign it to an approved rider, or cancel.',
  },
  DELIVERY_OVERDUE: {
    label: 'Delivery taking too long', tone: 'warning', weight: 64, action: 'call-rider',
    explain: 'The rider picked the order up a long time ago and it is still not delivered.',
    advice: 'Call the rider; reassign if needed.',
  },
  RIDER_NOT_PICKED_UP: {
    label: 'Rider has not picked up', tone: 'warning', weight: 62, action: 'call-rider',
    explain: 'The food is ready but the assigned rider has not collected it.',
    advice: 'Call the rider; reassign if needed.',
  },
  NO_RIDER: {
    label: 'No rider assigned', tone: 'warning', weight: 60, action: 'assign',
    explain: 'The order is paid and moving at the restaurant, but no rider has claimed it.',
    advice: 'Call the riders on duty or assign one.',
  },
  REFUND_PENDING: {
    label: 'Refund still pending', tone: 'warning', weight: 45, action: 'open',
    explain: 'A refund started more than 5 minutes ago and has not finished.',
    advice: 'Check Razorpay before doing anything by hand.',
  },
  PAYMENT_FAILED: {
    label: 'Payment failed', tone: 'neutral', weight: 20, action: 'open',
    explain: 'The customer tried to pay and the payment failed. They can retry on the same order.',
    advice: 'Informational; the order expires by itself.',
  },
};

export const canonicalCode = (code: string): string => String(code || '').trim().toUpperCase() || 'UNKNOWN';

/** Known code: full guidance. Unknown code: a readable label and "open the order". */
export const problemMeta = (code: string): ProblemMeta => {
  const canonical = canonicalCode(code);
  const known = CATALOGUE[canonical];
  if (known) return { code: canonical, ...known };
  return {
    code: canonical,
    label: humanize(canonical),
    tone: 'warning',
    weight: 40,
    action: 'open',
    explain: 'The server flagged this order for a reason this dashboard does not know yet.',
    advice: 'Open the order and check its status, payment and rider.',
  };
};

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Parses `{ data: [...] }` from the server. `detail`/`since` belong to the primary `problem`. */
export const normalizeAttention = (body: any): AttentionEntry[] => {
  const list: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return list
    .filter((e) => e && typeof e === 'object')
    .map((e, index) => {
      const order: Order | null = e.order && typeof e.order === 'object' && s(e.order.id) ? normalizeOrder(e.order) : null;
      const primary = s(e.problem) ?? 'UNKNOWN';
      const groupId = s(e.groupId) ?? order?.group?.id ?? order?.groupId ?? null;
      const codes: string[] = [primary, ...(Array.isArray(e.problems) ? e.problems.filter((c: unknown) => s(c) !== null) : [])];
      const problems: AttentionProblem[] = [...new Set(codes.map(canonicalCode))].map((code) => (
        code === canonicalCode(primary) ? { code, detail: s(e.detail), since: s(e.since) } : { code }
      ));
      return { key: order?.id ?? `row-${index}`, orderId: order?.id ?? null, order, problems, hint: s(e.hint), ...(groupId ? { groupId } : {}) };
    });
};

const entryWeight = (entry: AttentionEntry): number => Math.max(0, ...entry.problems.map((p) => problemMeta(p.code).weight));

/** Fallback when the server endpoint is missing (server not yet deployed): what the dashboard can see itself. */
export const localAttention = (orders: Order[], now: number): AttentionEntry[] => orders
  .map((order) => ({ order, flags: orderFlags(order, now).filter((flag) => flag.code !== 'REFUND_PENDING') }))
  .filter(({ flags }) => flags.length > 0)
  .map(({ order, flags }) => ({ key: order.id, orderId: order.id, order, problems: flags.map((flag) => ({ code: flag.code })), hint: null }))
  .sort((a, b) => entryWeight(b) - entryWeight(a));

export const TONE_CLASS: Record<Tone, { pill: string; border: string; text: string; dot: string }> = {
  danger: { pill: 'bg-kraveo-danger/15 text-kraveo-danger', border: 'border-kraveo-danger/40', text: 'text-kraveo-danger', dot: 'bg-kraveo-danger' },
  warning: { pill: 'bg-kraveo-status-placed/15 text-kraveo-status-placed', border: 'border-kraveo-status-placed/40', text: 'text-kraveo-status-placed', dot: 'bg-kraveo-status-placed' },
  info: { pill: 'bg-kraveo-status-pickedUp/15 text-kraveo-status-pickedUp', border: 'border-kraveo-status-pickedUp/40', text: 'text-kraveo-status-pickedUp', dot: 'bg-kraveo-status-pickedUp' },
  neutral: { pill: 'bg-kraveo-surface2 text-kraveo-ink2', border: 'border-kraveo-line', text: 'text-kraveo-ink2', dot: 'bg-kraveo-ink3' },
};

/** Problems about the delivery flow stop mattering once the order is finished; money problems never do. */
const FLOW_ONLY = new Set(['STUCK_UNACCEPTED', 'RIDER_NOT_PICKED_UP', 'NO_RIDER', 'DELIVERY_OVERDUE', 'OTP_LOCKED', 'RIDER_NOT_APPROVED', 'VENDOR_NOT_APPROVED', 'UNPAID_IN_PROGRESS']);
export const isStillRelevant = (code: string, order: Order | null): boolean => {
  if (!order) return true;
  const canonical = canonicalCode(code);
  if (canonical === 'OTP_LOCKED' && order.otpLocked === false) return false;
  if (canonical === 'REFUND_FAILED' && order.refundStatus != null && order.refundStatus !== 'FAILED') return false;
  return !(FLOW_ONLY.has(canonical) && (order.status === 'DELIVERED' || order.status === 'CANCELLED'));
};

/** Drops problems the live order has already outgrown (the server list catches up on its next refresh). */
export const pruneWithLiveOrders = (entries: AttentionEntry[]): AttentionEntry[] => entries
  .map((entry) => ({ ...entry, problems: entry.problems.filter((p) => isStillRelevant(p.code, entry.order)) }))
  .filter((entry) => entry.problems.length > 0);
