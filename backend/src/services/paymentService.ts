import crypto from 'crypto';
import Razorpay from 'razorpay';
import dotenv from 'dotenv';
import { providerTimeoutMs } from '../config/orderFlow';

dotenv.config();

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';

/** The public key id the checkout needs (never the secret). */
export const razorpayPublicKeyId = () => razorpayKeyId;

let razorpayClient: Razorpay | undefined;
const getRazorpayClient = () => {
  if (!razorpayKeyId || !razorpayKeySecret) return undefined;
  razorpayClient ||= new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret });
  return razorpayClient;
};

// ----------------------------------------------------------------------------
// Provider errors. The Razorpay SDK (2.9.8) rejects with a plain `{ statusCode, error: { description } }` object for
// an HTTP error answer, but a network error / timeout (no HTTP response at all) surfaces as a TypeError about
// "reading 'status'" because its normalizeError assumes err.response exists. Everything the provider layer throws is
// mapped to PaymentProviderError so callers can tell transient (retry, do not count) from permanent (4xx).
// ----------------------------------------------------------------------------
export class PaymentProviderError extends Error {
  constructor(message: string, public statusCode: number | null, public transient: boolean, public providerCode?: string) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

const NETWORK_RE = /socket hang up|network|timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|reading '(status|data|error)'/i;

/** Maps anything thrown by a provider call to a typed error. 429, 408 and 5xx are transient, other 4xx permanent, no HTTP status = network error (transient). */
export const toProviderError = (err: any): PaymentProviderError => {
  if (err instanceof PaymentProviderError) return err;
  const status = typeof err?.statusCode === 'number' ? err.statusCode : typeof err?.response?.status === 'number' ? err.response.status : null;
  const description = err?.error?.description || err?.description;
  const providerCode = typeof err?.error?.code === 'string' ? err.error.code : undefined;
  if (status !== null) {
    const transient = status >= 500 || status === 429 || status === 408 || status < 400;
    return new PaymentProviderError(String(description || `The payment provider answered HTTP ${status}.`).slice(0, 300), status, transient, providerCode);
  }
  if (typeof err?.name === 'string' && err.name.startsWith('PrismaClient')) {
    return new PaymentProviderError('Database error while saving the refund result (will retry).', null, true, 'DATABASE_ERROR');
  }
  if (description) return new PaymentProviderError(String(description).slice(0, 300), null, true, providerCode);
  const raw = String(err?.message ?? '');
  const code = typeof err?.code === 'string' ? err.code : undefined;
  if (code || NETWORK_RE.test(raw) || err instanceof TypeError) {
    return new PaymentProviderError(`Could not reach the payment provider (network error${code ? `: ${code}` : ''}).`, null, true, 'NETWORK_ERROR');
  }
  return new PaymentProviderError(raw.slice(0, 300) || 'Unknown payment provider error', null, true);
};

// ----------------------------------------------------------------------------
// Provider seam. Production talks to Razorpay; NODE_ENV=test uses an in-memory simulator so tests
// never touch the network; tests can inject a failing provider with setPaymentProvider().
// ----------------------------------------------------------------------------
export interface ProviderRefund {
  id: string;
  amountPaise: number;
  status: string; // pending | processed | failed
}

/** The few fields of a Razorpay payment entity Kraveo needs (no card / contact data). */
export interface ProviderPayment {
  id: string;
  orderId: string | null;
  amountPaise: number;
  status: string; // created | authorized | captured | refunded | failed
  createdAtSec?: number;
}

export interface PaymentProvider {
  /** Creates a Razorpay order for `amountPaise`. Throws on provider errors. */
  createOrder(input: { receipt: string; amountPaise: number; notes: Record<string, string> }): Promise<{ id: string }>;
  /** Full or partial refund of a captured payment. Throws on provider errors. */
  refundPayment(input: { paymentId: string; amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<ProviderRefund>;
  /** Refunds that already exist for a payment (used to never refund twice after a crash). */
  listRefunds(paymentId: string): Promise<ProviderRefund[]>;
  /**
   * The methods below are optional ONLY for test doubles that wrap a provider (NODE_ENV=test fills the gaps from the
   * simulator). The Razorpay provider and the simulator implement all of them.
   * `hint` is used by the simulator only (to answer for payments a test never registered); Razorpay ignores it.
   */
  fetchPayment?(paymentId: string, hint?: { razorpayOrderId: string; amountPaise: number }): Promise<ProviderPayment>;
  capturePayment?(paymentId: string, amountPaise: number): Promise<ProviderPayment>;
  fetchOrderPayments?(razorpayOrderId: string): Promise<ProviderPayment[]>;
  listPayments?(input: { fromSec: number; toSec: number; count: number; skip: number }): Promise<ProviderPayment[]>;
}

const toProviderPayment = (p: any): ProviderPayment => ({
  id: String(p.id),
  orderId: typeof p.order_id === 'string' ? p.order_id : null,
  amountPaise: Number(p.amount),
  status: String(p.status),
  ...(typeof p.created_at === 'number' ? { createdAtSec: p.created_at } : {}),
});

/** Every SDK call goes through here: whatever it throws becomes a PaymentProviderError. */
const sdk = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw toProviderError(err);
  }
};
const notConfigured = () => new PaymentProviderError('Razorpay is not configured on this server.', null, false, 'NOT_CONFIGURED');

const razorpayProvider: PaymentProvider = {
  async createOrder({ receipt, amountPaise, notes }) {
    const razorpay = getRazorpayClient();
    if (!razorpay) throw notConfigured();
    // payment_capture: 1 = Razorpay captures the payment itself on success (refunds need a captured payment, and
    // an authorized-but-never-captured payment would be voided by the bank after a few days).
    const order = await sdk(() => razorpay.orders.create({ amount: amountPaise, currency: 'INR', receipt, notes, payment_capture: 1 } as any));
    return { id: order.id };
  },
  async refundPayment({ paymentId, amountPaise, receipt, notes }) {
    const razorpay = getRazorpayClient();
    if (!razorpay) throw notConfigured();
    const refund = await sdk(() => razorpay.payments.refund(paymentId, { amount: amountPaise, speed: 'normal', receipt, notes }));
    return { id: refund.id, amountPaise: Number(refund.amount ?? amountPaise), status: refund.status };
  },
  async listRefunds(paymentId) {
    const razorpay = getRazorpayClient();
    if (!razorpay) throw notConfigured();
    const page = await sdk(() => razorpay.payments.fetchMultipleRefund(paymentId, { count: 100 }));
    return (page.items ?? []).map((r: any) => ({ id: r.id, amountPaise: Number(r.amount ?? 0), status: String(r.status) }));
  },
  async fetchPayment(paymentId) {
    const razorpay = getRazorpayClient();
    if (!razorpay) throw notConfigured();
    return toProviderPayment(await sdk(() => razorpay.payments.fetch(paymentId)));
  },
  async capturePayment(paymentId, amountPaise) {
    const razorpay = getRazorpayClient();
    if (!razorpay) throw notConfigured();
    return toProviderPayment(await sdk(() => razorpay.payments.capture(paymentId, amountPaise, 'INR')));
  },
  async fetchOrderPayments(razorpayOrderId) {
    const razorpay = getRazorpayClient();
    if (!razorpay) throw notConfigured();
    const page: any = await sdk(() => razorpay.orders.fetchPayments(razorpayOrderId));
    return (page.items ?? []).map(toProviderPayment);
  },
  async listPayments({ fromSec, toSec, count, skip }) {
    const razorpay = getRazorpayClient();
    if (!razorpay) throw notConfigured();
    const page: any = await sdk(() => razorpay.payments.all({ from: fromSec, to: toSec, count, skip } as any));
    return (page.items ?? []).map(toProviderPayment);
  },
};

export type SimulatedProvider = PaymentProvider & Required<Pick<PaymentProvider, 'fetchPayment' | 'capturePayment' | 'fetchOrderPayments' | 'listPayments'>> & {
  refunds: Map<string, ProviderRefund[]>;
  payments: Map<string, ProviderPayment>;
  /** Registers a payment the "customer" made at Razorpay (what fetchPayment / fetchOrderPayments / listPayments report). */
  addPayment(p: { id: string; orderId: string; amountPaise: number; status?: string; createdAtSec?: number }): ProviderPayment;
};

/** Test simulator: behaves like a healthy Razorpay (refunds succeed, over-refunds are refused). */
export const createSimulatedProvider = (): SimulatedProvider => {
  const refunds = new Map<string, ProviderRefund[]>();
  const payments = new Map<string, ProviderPayment>();
  const copy = (p: ProviderPayment): ProviderPayment => ({ ...p });
  const notFound = () => new PaymentProviderError('The id provided does not exist', 400, false, 'BAD_REQUEST_ERROR');
  return {
    refunds,
    payments,
    addPayment(p) {
      const entry: ProviderPayment = { id: p.id, orderId: p.orderId, amountPaise: p.amountPaise, status: p.status ?? 'captured', createdAtSec: p.createdAtSec ?? Math.floor(Date.now() / 1000) };
      payments.set(p.id, entry);
      return entry;
    },
    async createOrder() {
      return { id: `rzp_order_sim_${crypto.randomBytes(8).toString('hex')}` };
    },
    async refundPayment({ paymentId, amountPaise }) {
      const existing = refunds.get(paymentId) ?? [];
      const already = existing.filter((r) => r.status !== 'failed').reduce((s, r) => s + r.amountPaise, 0);
      // Kraveo only does full refunds, and Razorpay refuses to refund more than was captured: a second
      // full refund of the same payment fails. Mirror that so a double refund would show up in tests.
      if (already > 0) throw new PaymentProviderError('The total refund amount is greater than the refund payment amount', 400, false, 'BAD_REQUEST_ERROR');
      const refund = { id: `rfnd_sim_${crypto.randomBytes(7).toString('hex')}`, amountPaise, status: 'processed' };
      refunds.set(paymentId, [...existing, refund]);
      const known = payments.get(paymentId);
      if (known && known.status === 'captured' && amountPaise >= known.amountPaise) known.status = 'refunded';
      return refund;
    },
    async listRefunds(paymentId) {
      return refunds.get(paymentId) ?? [];
    },
    async fetchPayment(paymentId, hint) {
      const known = payments.get(paymentId);
      if (known) return copy(known);
      // A payment no test registered: behave like a customer who paid exactly what was asked (keeps older tests simple).
      if (hint) return { id: paymentId, orderId: hint.razorpayOrderId, amountPaise: hint.amountPaise, status: 'captured', createdAtSec: Math.floor(Date.now() / 1000) };
      throw notFound();
    },
    async capturePayment(paymentId, amountPaise) {
      const known = payments.get(paymentId);
      if (!known) throw notFound();
      if (known.status === 'captured') throw new PaymentProviderError('This payment has already been captured', 400, false, 'BAD_REQUEST_ERROR');
      if (known.status !== 'authorized' || known.amountPaise !== amountPaise) throw new PaymentProviderError('The amount must be equal to the authorized amount', 400, false, 'BAD_REQUEST_ERROR');
      known.status = 'captured';
      return copy(known);
    },
    async fetchOrderPayments(razorpayOrderId) {
      return [...payments.values()].filter((p) => p.orderId === razorpayOrderId).map(copy);
    },
    async listPayments({ fromSec, toSec, count, skip }) {
      return [...payments.values()]
        .filter((p) => (p.createdAtSec ?? 0) >= fromSec && (p.createdAtSec ?? 0) <= toSec)
        .sort((a, b) => (b.createdAtSec ?? 0) - (a.createdAtSec ?? 0))
        .slice(skip, skip + count)
        .map(copy);
    },
  };
};

let defaultTestProvider: SimulatedProvider | null = null;
let injectedProvider: PaymentProvider | null = null;
const defaultSim = () => (defaultTestProvider ||= createSimulatedProvider());

/** Tests: swap the provider (pass null to go back to the default). */
export const setPaymentProvider = (provider: PaymentProvider | null) => {
  injectedProvider = provider;
};

export const getPaymentProvider = (): PaymentProvider => {
  if (injectedProvider) {
    // Test doubles written before reconciliation existed only wrap createOrder / refundPayment / listRefunds.
    if (process.env.NODE_ENV === 'test') {
      const sim = defaultSim();
      return { fetchPayment: sim.fetchPayment, capturePayment: sim.capturePayment, fetchOrderPayments: sim.fetchOrderPayments, listPayments: sim.listPayments, ...injectedProvider };
    }
    return injectedProvider;
  }
  if (process.env.NODE_ENV === 'test') return defaultSim();
  return razorpayProvider;
};

/** Every provider call is bounded so a hung HTTP request cannot hold a worker or a lock forever. */
export const withProviderTimeout = <T>(promise: Promise<T>, ms = providerTimeoutMs()): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PaymentProviderError(`Payment provider did not answer within ${ms} ms.`, null, true, 'TIMEOUT')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });

/** A short, log-safe description of a provider error (never the request or the keys). */
export const providerErrorMessage = (err: any): string => toProviderError(err).message;

export interface CreatePaymentOrderResult {
  success: boolean;
  razorpayOrderId?: string;
  amountInPaise?: number;
  currency?: string;
  keyId?: string;
  error?: string;
}

// Creates an official Razorpay payment order for UPI checkout
export const createRazorpayOrder = async (orderId: string, amountInRupees: number): Promise<CreatePaymentOrderResult> => {
  const amountInPaise = Math.round(amountInRupees * 100);
  if (!Number.isFinite(amountInRupees) || amountInPaise < 100) {
    return { success: false, error: 'Payment amount must be at least ₹1.00.' };
  }
  try {
    const rzpOrder = await withProviderTimeout(getPaymentProvider().createOrder({
      amountPaise: amountInPaise,
      receipt: `rcpt_${orderId}`.slice(0, 40),
      notes: { orderId, platform: 'Kraveo VIT Bhopal Campus Delivery' },
    }));
    return { success: true, razorpayOrderId: rzpOrder.id, amountInPaise, currency: 'INR', keyId: razorpayKeyId };
  } catch (err: any) {
    console.error('Razorpay order creation failed:', providerErrorMessage(err));
    return { success: false, error: 'Payment provider is unavailable. Please try again.' };
  }
};

// Validates HMAC SHA256 payment signature returned by Razorpay UPI app
export const verifyRazorpayPaymentSignature = (
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: string
): boolean => {
  if (process.env.NODE_ENV === 'test' && razorpayOrderId.startsWith('rzp_order_sim_')) {
    return true; // Auto-pass simulation signatures in development mode
  }
  if (!razorpayKeySecret) return false; // never verify against an empty key: anyone could compute that HMAC

  const generatedSignature = crypto
    .createHmac('sha256', razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  const bufGen = Buffer.from(generatedSignature, 'utf8');
  const bufSig = Buffer.from(signature, 'utf8');
  if (bufGen.length !== bufSig.length) return false;
  return crypto.timingSafeEqual(bufGen, bufSig);
};

const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';

// Validates HMAC SHA256 webhook signature sent in x-razorpay-signature header
export const verifyRazorpayWebhookSignature = (
  rawBody: Buffer | string,
  signature: string
): boolean => {
  if (!signature || typeof signature !== 'string') return false;

  if (process.env.NODE_ENV === 'test' && signature === 'valid_test_wh_signature') {
    return true; // Test suite compatibility in non-production environments
  }

  if (!razorpayWebhookSecret) return false;
  const expectedSignature = crypto
    .createHmac('sha256', razorpayWebhookSecret)
    .update(rawBody)
    .digest('hex');

  const bufExp = Buffer.from(expectedSignature, 'utf8');
  const bufSig = Buffer.from(signature, 'utf8');
  if (bufExp.length !== bufSig.length) return false;
  return crypto.timingSafeEqual(bufExp, bufSig);
};
