/**
 * Helpers for the lifecycle journey / stress suites (test/e2e/lifecycle_*.test.ts).
 * Self-contained "world": its own customers, restaurants, menu items, riders and admin, all with ids
 * starting with `<prefix>-`, so setup / teardown never depends on (or damages) the shared seed rows.
 * Reuses the existing harness (app, auth tokens, socket client) and the provider seam of the backend.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { io, Socket } from 'socket.io-client';
import { Role } from '@prisma/client';
import { prisma } from './db';
import { generateTestToken } from './auth';
import { createSimulatedProvider, PaymentProvider } from '../../src/services/paymentService';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const until = async (fn: () => boolean | Promise<boolean>, ms = 4000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`${what} not met within ${ms} ms`);
};
export const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------
export interface Person { id: string; phone: string; name: string; role: Role; token: string }
export interface Customer extends Person {}
export interface Vendor extends Person { vendorId: string; items: { id: string; price: number }[] }
export interface Rider extends Person { profileId: string }
export interface World { prefix: string; customers: Customer[]; vendors: Vendor[]; riders: Rider[]; admin: Person }

const ROLE_DIGIT: Record<string, string> = { STUDENT: '1', VENDOR: '2', DRIVER: '3', ADMIN: '4' };

export const purgeWorld = async (prefix: string) => {
  const p = `${prefix}-`;
  await prisma.payment.deleteMany({ where: { order: { OR: [{ customerId: { startsWith: p } }, { vendorId: { startsWith: p } }] } } });
  await prisma.order.deleteMany({ where: { OR: [{ customerId: { startsWith: p } }, { vendorId: { startsWith: p } }, { driverId: { startsWith: p } }] } });
  await prisma.orderGroup.deleteMany({ where: { customerId: { startsWith: p } } });
  await prisma.driverLocation.deleteMany({ where: { driverId: { startsWith: p } } });
  await prisma.menuItem.deleteMany({ where: { vendorId: { startsWith: p } } });
  await prisma.vendor.deleteMany({ where: { id: { startsWith: p } } });
  await prisma.driverPartner.deleteMany({ where: { id: { startsWith: p } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: p } } });
};

/** `digit` is a single digit that keeps phone numbers of different suites apart. */
export const createWorld = async (prefix: string, digit: string, size: { customers: number; vendors: number; riders: number }): Promise<World> => {
  await purgeWorld(prefix);
  const phone = (role: string, i: number) => `+91 9777${digit}${ROLE_DIGIT[role]}${String(i).padStart(4, '0')}`;
  const person = (role: Role, kind: string, i: number, name: string): Person => {
    const id = `${prefix}-${kind}-${i}`;
    return { id, phone: phone(role, i), name, role, token: generateTestToken({ id, phone: phone(role, i), role }) };
  };
  const world: World = { prefix, customers: [], vendors: [], riders: [], admin: person(Role.ADMIN, 'admin', 0, 'Admin Jy') };
  await prisma.user.create({ data: { id: world.admin.id, phone: world.admin.phone, name: world.admin.name, role: Role.ADMIN } });

  for (let i = 1; i <= size.customers; i++) {
    const c = person(Role.STUDENT, 'cust', i, `Cust${i} Tester`);
    await prisma.user.create({ data: { id: c.id, phone: c.phone, name: c.name, role: Role.STUDENT, hostelBlock: 'Block 3' } });
    world.customers.push(c);
  }
  for (let i = 1; i <= size.vendors; i++) {
    const u = person(Role.VENDOR, 'vown', i, `Owner${i} Kitchen`);
    await prisma.user.create({ data: { id: u.id, phone: u.phone, name: u.name, role: Role.VENDOR } });
    const vendorId = `${prefix}-ven-${i}`;
    await prisma.vendor.create({ data: { id: vendorId, userId: u.id, name: `Kitchen ${i}`, category: 'Test', address: `Gate ${i}`, bannerImage: '', isAcceptingOrders: true, approvalStatus: 'APPROVED' } });
    const items = [{ id: `${vendorId}-i1`, price: 180 }, { id: `${vendorId}-i2`, price: 90 }];
    for (const it of items) {
      await prisma.menuItem.create({ data: { id: it.id, vendorId, name: `Item ${it.price}`, price: it.price, vendorPrice: it.price, category: 'Test', description: 'd', imageUrl: '', isAvailable: true } });
    }
    world.vendors.push({ ...u, vendorId, items });
  }
  for (let i = 1; i <= size.riders; i++) {
    const r = person(Role.DRIVER, 'rider', i, `Rider${i} Runner`);
    await prisma.user.create({ data: { id: r.id, phone: r.phone, name: r.name, role: Role.DRIVER } });
    const profileId = `${prefix}-dp-${i}`;
    await prisma.driverPartner.create({ data: { id: profileId, userId: r.id, name: r.name, phone: r.phone, runnerCode: `RUN-${prefix.toUpperCase()}${i}`.slice(0, 20), vehicleType: 'Bike', dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' } });
    world.riders.push({ ...r, profileId });
  }
  return world;
};

/** Everything back to a clean slate between journeys (keeps users, vendors, riders). */
/** The person "signs in again": same user, a token carrying the CURRENT tokenVersion (after a suspension / password reset). */
export const reissue = async <P extends Person>(p: P): Promise<P> => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
  return { ...p, token: generateTestToken({ id: p.id, phone: p.phone, role: p.role, tv: u.tokenVersion }) };
};

export const resetWorldState = async (w: World) => {
  const p = `${w.prefix}-`;
  await prisma.payment.deleteMany({ where: { order: { OR: [{ customerId: { startsWith: p } }, { vendorId: { startsWith: p } }] } } });
  await prisma.order.deleteMany({ where: { OR: [{ customerId: { startsWith: p } }, { vendorId: { startsWith: p } }, { driverId: { startsWith: p } }] } });
  await prisma.orderGroup.deleteMany({ where: { customerId: { startsWith: p } } });
  await prisma.vendor.updateMany({ where: { id: { startsWith: p } }, data: { approvalStatus: 'APPROVED', isAcceptingOrders: true } });
  await prisma.driverPartner.updateMany({ where: { id: { startsWith: p } }, data: { approvalStatus: 'APPROVED', dutyStatus: 'ONLINE' } });
  await prisma.menuItem.updateMany({ where: { vendorId: { startsWith: p } }, data: { isAvailable: true } });
  // Suspending a partner / resetting a password revokes their tokens (tokenVersion); the world's tokens carry tv 0.
  await prisma.user.updateMany({ where: { id: { startsWith: p } }, data: { tokenVersion: 0 } });
};

// ---------------------------------------------------------------------------------------------
// Payment provider ledger: the "fake Razorpay" as the source of truth for money
// ---------------------------------------------------------------------------------------------
export interface Ledger {
  provider: PaymentProvider;
  sim: ReturnType<typeof createSimulatedProvider>;
  /** The customer paid at Razorpay (money captured), whatever Kraveo's server later does with it. */
  capture(rzpOrderId: string, paymentId: string, amountPaise: number): void;
  captured: Map<string, { rzpOrderId: string; amountPaise: number }>;
  totalCaptured(): number;
  totalRefunded(): number;
  refundsOf(paymentId: string): { id: string; amountPaise: number; status: string }[];
  mode: {
    createDown: boolean;
    createHang: boolean;
    refundDown: boolean;
    /** Refund succeeds at the provider but the answer is lost (error thrown). */
    refundLostAnswer: boolean;
    /** Refund succeeds at the provider but the call never returns (needs the 15 s provider timeout). */
    refundHangAfterSuccess: boolean;
    /** Deterministic partial outage: return true to fail this refund call. */
    refundFailWhen: ((paymentId: string, attempt: number) => boolean) | null;
  };
  calls: { createOrder: number; refundPayment: number };
}

export const createLedger = (): Ledger => {
  const sim = createSimulatedProvider();
  const captured = new Map<string, { rzpOrderId: string; amountPaise: number }>();
  const attempts = new Map<string, number>();
  const calls = { createOrder: 0, refundPayment: 0 };
  const mode: Ledger['mode'] = { createDown: false, createHang: false, refundDown: false, refundLostAnswer: false, refundHangAfterSuccess: false, refundFailWhen: null };
  const provider: PaymentProvider = {
    async createOrder(input) {
      calls.createOrder += 1;
      if (mode.createHang) await new Promise(() => undefined);
      if (mode.createDown) throw Object.assign(new Error('503'), { error: { description: 'Razorpay is down' } });
      return sim.createOrder(input);
    },
    async refundPayment(input) {
      calls.refundPayment += 1;
      const n = (attempts.get(input.paymentId) ?? 0) + 1;
      attempts.set(input.paymentId, n);
      if (mode.refundDown) throw Object.assign(new Error('503'), { error: { description: 'Razorpay is down' } });
      if (mode.refundFailWhen?.(input.paymentId, n)) throw Object.assign(new Error('502'), { error: { description: 'Bad gateway (injected)' } });
      const refund = await sim.refundPayment(input);
      if (mode.refundLostAnswer) throw new Error('socket hang up');
      if (mode.refundHangAfterSuccess) await new Promise(() => undefined);
      return refund;
    },
    listRefunds: (paymentId) => sim.listRefunds(paymentId),
  };
  return {
    provider, sim, captured, mode, calls,
    capture(rzpOrderId, paymentId, amountPaise) { captured.set(paymentId, { rzpOrderId, amountPaise }); },
    totalCaptured: () => [...captured.values()].reduce((s, c) => s + c.amountPaise, 0),
    totalRefunded: () => [...sim.refunds.values()].flat().filter((r) => r.status !== 'failed').reduce((s, r) => s + r.amountPaise, 0),
    refundsOf: (paymentId) => (sim.refunds.get(paymentId) ?? []).filter((r) => r.status !== 'failed'),
  };
};

// ---------------------------------------------------------------------------------------------
// HTTP client that remembers every call (for the "never 5xx" invariant)
// ---------------------------------------------------------------------------------------------
export interface CallLog { method: string; url: string; status: number; body?: unknown; who: string }

export const createApi = (baseUrl: string, calls: CallLog[] = []) => {
  const request = supertest(baseUrl);
  const send = async (who: string, method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    let r = (request as any)[method](url);
    if (token) r = r.set('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    if (body !== undefined && method !== 'get') r = r.send(body as any);
    const res = await r;
    calls.push({ method, url: url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':uuid'), status: res.status, who, ...(res.status >= 500 ? { body: res.body } : {}) });
    return res as supertest.Response;
  };
  const T = (p: Person | string | null) => (p === null ? null : typeof p === 'string' ? p : p.token);
  const W = (p: Person | string | null) => (p === null ? 'anon' : typeof p === 'string' ? 'token' : `${p.role}:${p.id}`);
  const api = {
    calls,
    raw: send,
    place: (c: Person, vendor: Vendor, extra: Record<string, unknown> = {}, itemIdx = 0, qty = 1) =>
      send(W(c), 'post', '/api/orders', c.token, {
        vendorId: vendor.vendorId, items: [{ itemId: vendor.items[itemIdx].id, quantity: qty }], dropoffHostel: 'Block 2', dropoffNotes: 'Room 214', clientRequestId: randomUUID(), ...extra,
      }),
    createPayment: (c: Person, orderId: string) => send(W(c), 'post', '/api/payments/create-order', c.token, { orderId }),
    verify: (c: Person, rzpOrderId: string, paymentId: string) =>
      send(W(c), 'post', '/api/payments/verify-signature', c.token, { razorpayOrderId: rzpOrderId, razorpayPaymentId: paymentId, razorpaySignature: 'sim' }),
    webhook: (body: unknown) => send('razorpay', 'post', '/api/payments/webhook', null, body, { 'x-razorpay-signature': 'valid_test_wh_signature' }),
    webhookCaptured: (rzpOrderId: string, paymentId: string, amountPaise: number, event = 'payment.captured') =>
      api.webhook({ event, payload: { payment: { entity: { id: paymentId, order_id: rzpOrderId, amount: amountPaise, status: 'captured', notes: {} } } } }),
    webhookFailed: (rzpOrderId: string, paymentId: string, amountPaise: number) =>
      api.webhook({ event: 'payment.failed', payload: { payment: { entity: { id: paymentId, order_id: rzpOrderId, amount: amountPaise, status: 'failed' } } } }),
    get: (p: Person | string, id: string) => send(W(p), 'get', `/api/orders/${id}`, T(p)),
    list: (p: Person | string, query = '') => send(W(p), 'get', `/api/orders${query}`, T(p)),
    available: (p: Person) => send(W(p), 'get', '/api/orders/available', p.token),
    setStatus: (p: Person, id: string, status: string, extra: object = {}) => send(W(p), 'patch', `/api/orders/${id}/status`, p.token, { status, ...extra }),
    cancel: (p: Person, id: string, reason?: string) => send(W(p), 'post', `/api/orders/${id}/cancel`, p.token, reason ? { reason } : {}),
    reject: (p: Person, id: string, reason: string) => send(W(p), 'post', `/api/orders/${id}/reject`, p.token, { reason }),
    claim: (p: Person, id: string) => send(W(p), 'post', `/api/orders/${id}/accept-driver`, p.token, {}),
    release: (p: Person, id: string) => send(W(p), 'post', `/api/orders/${id}/release`, p.token, {}),
    otp: (p: Person, id: string, otpCode: unknown) => send(W(p), 'post', `/api/orders/${id}/verify-gate-otp`, p.token, { otpCode }),
    location: (p: Person, lat: number, lng: number) => send(W(p), 'post', '/api/drivers/location', p.token, { lat, lng, heading: 10 }),
    duty: (p: Person, isOnline: boolean) => send(W(p), 'post', '/api/drivers/duty-status', p.token, { isOnline }),
    reassign: (admin: Person, id: string, driverId: string | null, force?: boolean) => send(W(admin), 'patch', `/api/orders/${id}/reassign`, admin.token, force === undefined ? { driverId } : { driverId, force }),
    adminCancel: (admin: Person, id: string, reason = 'Admin decision') => send(W(admin), 'post', `/api/admin/orders/${id}/cancel`, admin.token, { reason }),
    resetOtp: (admin: Person, id: string) => send(W(admin), 'post', `/api/admin/orders/${id}/reset-otp-lock`, admin.token, {}),
    retryRefund: (admin: Person, id: string) => send(W(admin), 'post', `/api/admin/orders/${id}/retry-refund`, admin.token, {}),
    needsAttention: (admin: Person) => send(W(admin), 'get', '/api/admin/orders/needs-attention', admin.token),
    // Docs/22 multi-restaurant orders
    quote: (c: Person, restaurants: unknown, couponCode?: string) => send(W(c), 'post', '/api/orders/quote', c.token, couponCode === undefined ? { restaurants } : { restaurants, couponCode }),
    placeGroup: (c: Person, restaurants: unknown, extra: Record<string, unknown> = {}) =>
      send(W(c), 'post', '/api/order-groups', c.token, { restaurants, dropoffHostel: 'BH2', dropoffNotes: 'Room 214', clientRequestId: randomUUID(), ...extra }),
    getGroup: (p: Person | string, id: string) => send(W(p), 'get', `/api/order-groups/${id}`, T(p)),
    listGroups: (p: Person | string, query = '') => send(W(p), 'get', `/api/order-groups${query}`, T(p)),
    availableGroups: (p: Person) => send(W(p), 'get', '/api/orders/available?groups=1', p.token),
    partnerStatus: (admin: Person, kind: 'vendor' | 'driver', id: string, status: string, reason = 'Testing suspension') =>
      send(W(admin), 'post', `/api/admin/partners/${kind}/${id}/status`, admin.token, { status, reason }),
  };
  return api;
};
export type Api = ReturnType<typeof createApi>;

/** One restaurant's part of a combined order request: `lines` = [item index, quantity] pairs of that restaurant's two seeded dishes (180 and 90). */
export const cartOf = (v: Vendor, lines: [number, number][] = [[0, 1]]) => ({ vendorId: v.vendorId, items: lines.map(([i, q]) => ({ itemId: v.items[i].id, quantity: q })) });

// ---------------------------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------------------------
export interface Ev { seq: number; event: string; data: any; at: number }
let seqCounter = 0;

/** One person's socket connection(s): every event over its whole life, surviving disconnect / reconnect. */
export class Watcher {
  events: Ev[] = [];
  rooms = new Set<string>();
  socket: Socket | null = null;
  /** `authExtra`: more handshake auth fields, e.g. `{ groups: 1 }` for a rider app that understands combined orders (Docs/22). */
  constructor(public baseUrl: string, public who: Person, public authExtra: Record<string, unknown> = {}) {}

  async connect(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const s = io(this.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: this.who.token, ...this.authExtra } });
      const timer = setTimeout(() => { s.disconnect(); reject(new Error(`socket connect timeout for ${this.who.id}`)); }, 5000);
      s.on('connect', () => { clearTimeout(timer); resolve(); });
      s.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
      s.onAny((event: string, data: unknown) => { this.events.push({ seq: ++seqCounter, event, data, at: Date.now() }); });
      this.socket = s;
    });
    return this;
  }
  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
  }
  get connected() { return !!this.socket?.connected; }
  /**
   * Round trip on this socket: when the ack arrives, every event the server emitted to this socket
   * before the call has been delivered (one ordered websocket). Replaces sleeps in "nothing arrived" checks.
   */
  async flush(): Promise<void> {
    if (this.socket?.connected) await this.socket.timeout(5000).emitWithAck('join_room', '__flush__');
  }
  /** Reconnect (new socket id, automatic rooms only) and re-join the given rooms. */
  async reconnect(rejoin = true): Promise<this> {
    this.disconnect();
    await this.connect();
    if (rejoin) for (const r of [...this.rooms]) await this.join(r);
    return this;
  }
  async join(room: string): Promise<boolean> {
    if (!this.socket) return false;
    const ack = await this.socket.timeout(5000).emitWithAck('join_room', room);
    if (ack.ok) this.rooms.add(room); else this.rooms.delete(room);
    return ack.ok as boolean;
  }
  of(event: string, orderId?: string): any[] {
    return this.events.filter((e) => e.event === event && (orderId === undefined || e.data?.id === orderId || e.data?.orderId === orderId)).map((e) => e.data);
  }
  count(event: string, orderId?: string) { return this.of(event, orderId).length; }
  /** Index to remember "now" so `since(mark)` only looks at later events. */
  mark() { return this.events.length; }
  since(mark: number, event?: string, orderId?: string): any[] {
    return this.events.slice(mark).filter((e) => (!event || e.event === event) && (orderId === undefined || e.data?.id === orderId || e.data?.orderId === orderId)).map((e) => e.data);
  }
  last(event: string, orderId?: string): any { const l = this.of(event, orderId); return l[l.length - 1]; }
}

export const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};

/** Raw User / Vendor / Rider columns and payment internals that must never reach a restaurant or rider. */
export const RAW_KEYS = ['passwordHash', 'googleSub', 'fcmToken', 'email', 'upiId', 'kraveoCoins', 'avatarId', 'isStudent', 'userId', 'approvalStatus', 'rejectionReason',
  'fssaiNumber', 'bannerImage', 'isAcceptingOrders', 'studentRegNo', 'emergencyPhone', 'vehicleRegNo', 'refundLeaseUntil', 'role', 'rating', 'totalRatingsCount', 'category', 'eta', 'user',
  'payments', 'razorpayOrderId', 'razorpayPaymentId', 'razorpayRefundId', 'capturedAmountPaise', 'refundError', 'refundAttempts', 'otpAttempts', 'otpLocked', 'customerId', 'runnerCode', 'dutyStatus'];

export const STATUS_RANK: Record<string, number> = { PLACED: 0, ACCEPTED: 1, PREPARING: 2, READY_FOR_PICKUP: 3, PICKED_UP: 4, ARRIVED_AT_GATE: 5, DELIVERED: 6 };
export const isTerminal = (s: string) => s === 'DELIVERED' || s === 'CANCELLED';
