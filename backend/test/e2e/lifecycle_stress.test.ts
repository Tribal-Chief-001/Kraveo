/**
 * Seeded random simulation of a messy campus evening + invariant checks + endpoint fuzzing.
 *
 *   STRESS_SEED=123 STRESS_WAVES=10 npx jest --runInBand test/e2e/lifecycle_stress.test.ts
 *
 * 6 customers, 3 restaurants, 5 riders place ~40 orders. Actions (place, pay by verify / webhook / both,
 * accept, reject, cancel, claim, release, pickup, arrive, right / wrong OTP, admin cancel, job ticks with
 * advancing injected time, socket drops, duty toggles, suspensions, GPS, provider outages) run concurrently
 * in waves. Legitimate 4xx are fine; 5xx never. The invariants I1..I10 are checked against the database,
 * the sockets' event logs and the provider ledger (the fake Razorpay), continuously (a sampler reads the
 * database every ~40 ms while a wave runs) and after every wave. The seed is printed on failure.
 */
import { randomUUID } from 'crypto';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { generateTestToken } from '../harness/auth';
import { setPaymentProvider } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import {
  World, Customer, Vendor, Rider, Watcher, Ledger, Api, createWorld, purgeWorld, createLedger, createApi, keysOf, RAW_KEYS, STATUS_RANK, isTerminal, sleep, minutesFromNow,
} from '../harness/journey';

jest.setTimeout(420_000);

const SEED = Number(process.env.STRESS_SEED ?? 20261002);
const WAVES = Number(process.env.STRESS_WAVES ?? 10);
const ACTIVE = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'];

const mulberry32 = (a: number) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Row = { id: string; status: string; paymentStatus: string; driverId: string | null; customerId: string; vendorId: string; otpCode: string | null; otpLocked: boolean; refundStatus: string | null; paidAt: Date | null; acceptedAt: Date | null; deliveredAt: Date | null; pickedUpAt: Date | null; totalAmount: number; cancelledBy: string | null };
const SEL = { id: true, status: true, paymentStatus: true, driverId: true, customerId: true, vendorId: true, otpCode: true, otpLocked: true, refundStatus: true, paidAt: true, acceptedAt: true, deliveredAt: true, pickedUpAt: true, totalAmount: true, cancelledBy: true } as const;

describe(`Lifecycle stress (seed ${SEED})`, () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let rng: () => number;
  const watchers = new Map<string, Watcher>();
  const mine = () => ({ customerId: { startsWith: 'st-' } });
  const unhandled: string[] = [];
  const onRej = (e: unknown) => unhandled.push(String((e as Error)?.stack ?? e).slice(0, 300));

  const cust = (id: string) => W.customers.find((c) => c.id === id)!;
  const vend = (vendorId: string) => W.vendors.find((v) => v.vendorId === vendorId)!;
  const rider = (userId: string | null) => W.riders.find((r) => r.id === userId);
  const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)];
  const rows = () => prisma.order.findMany({ where: mine(), select: SEL }) as Promise<Row[]>;
  const rowOf = (id: string) => prisma.order.findUnique({ where: { id }, select: SEL }) as Promise<Row | null>;
  const ok = (r: { status: number }) => r.status >= 200 && r.status < 300;
  const swallow = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { const m = String((e as Error)?.message ?? e); if (/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/.test(m)) requestErrors.push(m.slice(0, 200)); } };
  const requestErrors: string[] = [];

  // ---- simulated customer-at-Razorpay state ------------------------------------------------------
  type PayState = { rzp?: string; amount?: number; payId: string; payFailId: string };
  const pays = new Map<string, PayState>();
  const payOf = (id: string) => { let p = pays.get(id); if (!p) { p = { payId: `pay_${SEED}_${id.slice(0, 8)}`, payFailId: `payf_${SEED}_${id.slice(0, 8)}` }; pays.set(id, p); } return p; };

  /** The customer pays at Razorpay (money captured whatever happens next), then the server hears by verify and/or webhook. */
  const doPay = async (c: Customer, id: string, via: string) => {
    const p = payOf(id);
    if (!p.rzp) {
      const cp = await api.createPayment(c, id);
      if (!ok(cp)) return false;
      p.rzp = cp.body.razorpayOrderId; p.amount = cp.body.amountInPaise;
    }
    if (via === 'fail') { await api.webhookFailed(p.rzp!, p.payFailId, p.amount!); return true; }
    ledger.capture(p.rzp!, p.payId, p.amount!);
    if (via === 'verify') await api.verify(c, p.rzp!, p.payId);
    else if (via === 'webhook') await api.webhookCaptured(p.rzp!, p.payId, p.amount!);
    else await Promise.all([api.verify(c, p.rzp!, p.payId), api.webhookCaptured(p.rzp!, p.payId, p.amount!), api.webhookCaptured(p.rzp!, p.payId, p.amount!, 'order.paid')]);
    return true;
  };

  /** Advance one order as far as the dice allow, one real API call at a time, reading the database before each step. */
  const chain = async (id: string, dice: number[]) => {
    for (let k = 0; k < dice.length; k++) {
      const d = dice[k];
      const o = await rowOf(id);
      if (!o || isTerminal(o.status)) return;
      const c = cust(o.customerId); const v = d < 0.04 ? pick(W.vendors) : vend(o.vendorId);
      const r = rider(o.driverId) ?? W.riders[Math.floor(d * 1000) % W.riders.length];
      if (o.status === 'PLACED' && o.paymentStatus !== 'PAID') {
        if (d < 0.05) { await api.cancel(c, id); return; }
        if (d < 0.12 && payOf(id).rzp) await doPay(c, id, 'fail');
        await doPay(c, id, d < 0.45 ? 'verify' : d < 0.75 ? 'webhook' : 'both');
      } else if (o.status === 'PLACED') {
        if (d < 0.1) await api.reject(v, id, 'Out of stock today');
        else if (d < 0.18) await api.cancel(c, id, 'changed my mind');
        else await api.setStatus(v, id, 'ACCEPTED');
      } else if (o.status === 'ACCEPTED' || o.status === 'PREPARING') {
        if (!o.driverId && d < 0.5) await api.claim(r, id);
        else if (o.driverId && d > 0.93) await api.release(r, id);
        else await api.setStatus(v, id, o.status === 'ACCEPTED' ? 'PREPARING' : 'READY_FOR_PICKUP');
      } else if (o.status === 'READY_FOR_PICKUP') {
        if (!o.driverId) await api.claim(r, id);
        else if (d > 0.95) await api.release(r, id);
        else await api.setStatus(r, id, 'PICKED_UP');
      } else if (o.status === 'PICKED_UP') {
        if (d < 0.3) await api.location(r, 23 + d / 10, 76 + d / 10);
        await api.setStatus(r, id, 'ARRIVED_AT_GATE');
      } else if (o.status === 'ARRIVED_AT_GATE') {
        if (o.otpLocked) { if (d < 0.5) await api.resetOtp(W.admin, id); else return; continue; }
        if (d < 0.2) { for (let i = 0; i < 6; i++) await api.otp(r, id, String(1000 + i * 111)); return; }
        const otp = (await api.get(c, id)).body?.data?.otpCode; // the customer reads the code out
        await api.otp(r, id, otp ?? '0000');
      }
    }
  };

  const wave = async (w: number) => {
    const snap = await rows();
    const live = snap.filter((o) => !isTerminal(o.status));
    const actions: (() => Promise<unknown>)[] = [];
    const add = (fn: () => Promise<unknown>) => actions.push(() => swallow(fn));
    const dice = (n = 3 + Math.floor(rng() * 7)) => Array.from({ length: n }, () => rng());

    // new orders (each one chains straight away so it can run ahead of the others)
    if (w < 8) {
      for (let i = 0; i < 5; i++) {
        const c = pick(W.customers); const v = pick(W.vendors); const itemIdx = rng() < 0.5 ? 0 : 1; const qty = 1 + Math.floor(rng() * 2); const dd = dice(); const dup = rng() < 0.15;
        add(async () => {
          const key = randomUUID();
          const body = (extra = {}) => api.place(c, v, { clientRequestId: key, ...extra }, itemIdx, qty);
          const r = dup ? (await Promise.all([body(), body()]))[0] : await body();
          if (!ok(r)) return;
          const id = r.body.data.id as string;
          const wc = watchers.get(c.id)!;
          await swallow(() => wc.join(`order_${id}`));
          await chain(id, dd);
        });
      }
    }
    // existing orders move on (about 80% of them each wave)
    for (const o of live) if (rng() < 0.8) { const dd = dice(); add(() => chain(o.id, dd)); }
    // pokes
    const nPokes = 6 + Math.floor(rng() * 4);
    for (let i = 0; i < nPokes; i++) {
      const kind = Math.floor(rng() * 12);
      const target = live.length ? pick(live) : undefined;
      const rd = pick(W.riders); const cu = pick(W.customers); const ve = pick(W.vendors); const flip = rng() < 0.5;
      if (kind === 0 && target) add(() => api.adminCancel(W.admin, target.id, 'Admin stress cancel'));
      else if (kind === 1 && target) add(() => api.cancel(pick([cu, cust(target.customerId)]), target.id));            // often the wrong customer: must be 404
      else if (kind === 2 && target) add(() => api.claim(rd, target.id));
      else if (kind === 3 && target) add(() => api.setStatus(rd, target.id, pick(['PICKED_UP', 'ARRIVED_AT_GATE', 'ACCEPTED', 'DELIVERED'])));
      else if (kind === 4 && target) add(() => api.otp(rd, target.id, '1234'));
      else if (kind === 5) add(() => api.duty(rd, flip));
      else if (kind === 6) add(() => api.location(rd, 23.07 + rng() / 100, 76.85));
      else if (kind === 7 && target) add(() => api.reject(ve, target.id, 'Closing early'));
      else if (kind === 8) { const wid = pick([...watchers.keys()]); add(() => watchers.get(wid)!.reconnect(true)); }
      else if (kind === 9 && target) add(() => api.resetOtp(W.admin, target.id));
      else if (kind === 10) { const burst = rng() < 0.5; add(async () => { await Promise.all(Array.from({ length: burst ? 6 : 2 }, () => api.place(cu, ve))); }); }
      else if (kind === 11 && target) add(() => api.release(rd, target.id));
    }
    if (rng() < 0.35) { const r = pick(W.riders); add(() => api.partnerStatus(W.admin, 'driver', r.profileId, 'SUSPENDED')); }
    if (rng() < 0.2) { const v = pick(W.vendors); add(() => api.partnerStatus(W.admin, 'vendor', v.vendorId, 'SUSPENDED')); }
    // time: the job runs with an advancing injected clock
    const offset = pick([0, 0, 0, 5, 11, 16]);
    add(() => runOrderMaintenance(minutesFromNow(offset)));
    if (rng() < 0.4) add(() => runOrderMaintenance(minutesFromNow(offset)));
    // some waves have a refund outage that heals at the end
    const outage = w % 3 === 1;
    if (outage) ledger.mode.refundDown = true;
    if (w === 5) ledger.mode.refundFailWhen = (_pid, attempt) => attempt % 2 === 1;
    // shuffle so the interleaving differs from the build order
    for (let i = actions.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [actions[i], actions[j]] = [actions[j], actions[i]]; }
    await Promise.all(actions.map((a) => a()));
    return { outage, n: actions.length };
  };

  /** Everything the real world would eventually deliver, then a quiet system. */
  const settle = async () => {
    ledger.mode.refundDown = false; ledger.mode.refundFailWhen = null; ledger.mode.createDown = false;
    await __waitForBackgroundWork();
    // Razorpay re-sends webhooks until it gets a 200: any captured payment the server does not know yet arrives now.
    for (const [payId, c] of ledger.captured) {
      const p = await prisma.payment.findUnique({ where: { razorpayOrderId: c.rzpOrderId } });
      if (p && p.status !== 'PAID' && p.status !== 'REFUNDED') await api.webhookCaptured(c.rzpOrderId, payId, c.amountPaise);
    }
    await __waitForBackgroundWork();
    for (let i = 0; i < 2; i++) { await runOrderMaintenance(new Date()); await __waitForBackgroundWork(); }
    // partners come back so the next wave can make progress
    for (const r of W.riders) await api.partnerStatus(W.admin, 'driver', r.profileId, 'APPROVED');
    for (const v of W.vendors) await api.partnerStatus(W.admin, 'vendor', v.vendorId, 'APPROVED');
    await prisma.vendor.updateMany({ where: { id: { startsWith: 'st-' } }, data: { isAcceptingOrders: true } });
    // A suspension revoked their sessions (tokenVersion); in the real world they sign in again, here the world's tokens are valid again.
    await prisma.user.updateMany({ where: { id: { startsWith: 'st-' } }, data: { tokenVersion: 0 } });
    for (const r of W.riders) await api.duty(r, true);
    await Promise.all([...watchers.values()].map((x) => (x.connected ? x.flush() : x.reconnect(true))));
  };

  // ---- invariants --------------------------------------------------------------------------------
  const violations: string[] = [];
  const viol = (s: string) => { if (violations.length < 40) violations.push(s); };
  let prevSnap = new Map<string, Row>();
  /** I7 / I8 / I9 / I2 on one consistent read; run by the sampler during waves and after them. */
  const sampleOnce = async (label: string) => {
    const now = await rows();
    const unpaid = new Map<string, number>(); const active = new Map<string, number>();
    for (const o of now) {
      const old = prevSnap.get(o.id);
      if (old) {
        if (isTerminal(old.status) && old.status !== o.status) viol(`[I7 ${label}] terminal order ${o.id} changed ${old.status} -> ${o.status}`);
        else if (o.status !== 'CANCELLED' && old.status !== 'CANCELLED' && STATUS_RANK[o.status] < STATUS_RANK[old.status]) viol(`[I7 ${label}] order ${o.id} moved backwards ${old.status} -> ${o.status}`);
        if (old.paymentStatus === 'REFUNDED' && o.paymentStatus !== 'REFUNDED') viol(`[I3 ${label}] order ${o.id} left REFUNDED (${o.paymentStatus})`);
      }
      if (!isTerminal(o.status) && (o.paymentStatus === 'PENDING' || o.paymentStatus === 'FAILED')) unpaid.set(o.customerId, (unpaid.get(o.customerId) ?? 0) + 1);
      if (o.driverId && ACTIVE.includes(o.status)) active.set(o.driverId, (active.get(o.driverId) ?? 0) + 1);
      if (STATUS_RANK[o.status] >= 1 && o.status !== 'CANCELLED' && (o.paymentStatus !== 'PAID' || !o.paidAt)) viol(`[I2 ${label}] ${o.status} order ${o.id} is not paid (${o.paymentStatus}, paidAt ${o.paidAt})`);
      if (o.status === 'DELIVERED' && (o.otpCode !== 'USED' || !o.driverId || !o.deliveredAt || !o.pickedUpAt || !o.acceptedAt)) viol(`[I2 ${label}] DELIVERED order ${o.id} ${JSON.stringify(o)}`);
      if ((o.status === 'PICKED_UP' || o.status === 'ARRIVED_AT_GATE') && !o.driverId) viol(`[I2 ${label}] ${o.status} order ${o.id} has no rider`);
      if (o.status !== 'ARRIVED_AT_GATE' && o.status !== 'DELIVERED' && o.otpCode && /^\d{4}$/.test(o.otpCode) ) viol(`[I2 ${label}] live OTP on ${o.status} order ${o.id}`);
    }
    for (const [cid, n] of unpaid) if (n > 3) viol(`[I9 ${label}] ${cid} has ${n} unpaid open orders`);
    for (const [rid, n] of active) if (n > 1) viol(`[I8 ${label}] rider ${rid} has ${n} active orders`);
    prevSnap = new Map(now.map((o) => [o.id, o]));
  };
  const startSampler = (label: string) => {
    let stop = false;
    const loop = (async () => { while (!stop) { try { await sampleOnce(label); } catch (e) { viol(`[sampler ${label}] ${(e as Error).message}`); } await sleep(40); } })();
    return async () => { stop = true; await loop; };
  };

  const checked = new Map<string, number>();
  const checkEvents = async (label: string) => {
    const map = new Map((await rows()).map((o) => [o.id, o]));
    const ORDER_EVENTS = new Set(['order_updated', 'new_order_alert', 'order_available', 'order_unavailable', 'rider_location', 'driver_location_update']);
    for (const w of watchers.values()) {
      const from = checked.get(w.who.id) ?? 0;
      for (const ev of w.events.slice(from)) {
        if (!ORDER_EVENTS.has(ev.event)) continue;
        const oid: string | undefined = ev.data?.id ?? ev.data?.orderId;
        const o = oid ? map.get(oid) : undefined;
        const role = w.who.role;
        const tag = `[${label} ${role}:${w.who.id} ${ev.event} ${oid}]`;
        if (role === 'VENDOR' || role === 'DRIVER') {
          const allowed = role === 'VENDOR' ? ['new_order_alert', 'order_updated'] : ['order_available', 'order_unavailable', 'order_updated'];
          if (!allowed.includes(ev.event)) viol(`[I6] ${tag} event type not for this role`);
          const leaked = [...keysOf(ev.data)].filter((k) => RAW_KEYS.includes(k));
          if (leaked.length) viol(`[I6] ${tag} raw keys ${leaked.join(',')}`);
          if (ev.data?.otpCode) viol(`[I6] ${tag} carries otpCode`);
          if (role === 'VENDOR' && ev.data?.customer?.phone) viol(`[I6] ${tag} carries a customer phone`);
          if (role === 'DRIVER' && ev.event === 'order_available' && (ev.data?.customer || ev.data?.dropoffNotes)) viol(`[I6] ${tag} pool view leaks the customer`);
          if (!o || !o.paidAt) viol(`[I5] ${tag} an order that was never paid-live reached a ${role}`);
          if (ev.data?.paymentStatus && !['PAID', 'REFUNDED'].includes(ev.data.paymentStatus)) viol(`[I5] ${tag} paymentStatus ${ev.data.paymentStatus}`);
          if (o && role === 'VENDOR' && vend(o.vendorId).id !== w.who.id) viol(`[I5] ${tag} restaurant ${vend(o.vendorId).id} order reached ${w.who.id}`);
          if (role === 'DRIVER' && ev.event === 'order_updated' && ev.data?.driver?.id !== w.who.id) viol(`[I5] ${tag} rider got an update of an order assigned to ${ev.data?.driver?.id}`);
        } else if (role === 'STUDENT') {
          if (o && o.customerId !== w.who.id) viol(`[I6] ${tag} customer got another customer's order`);
          if (ev.data?.otpCode && ev.data.status !== 'ARRIVED_AT_GATE') viol(`[I6] ${tag} OTP outside ARRIVED_AT_GATE`);
          if (ev.event === 'driver_location_update' || ev.event === 'new_order_alert' || ev.event === 'order_available') viol(`[I6] ${tag} event type not for customers`);
        }
      }
      checked.set(w.who.id, w.events.length);
    }
    // I7 from the admin's event stream: ordered by the order's own updatedAt, status never goes backwards.
    const adm = watchers.get(W.admin.id)!;
    const byOrder = new Map<string, { s: string; u: string; seq: number }[]>();
    for (const ev of adm.events) if (ev.event === 'order_updated') (byOrder.get(ev.data.id) ?? byOrder.set(ev.data.id, []).get(ev.data.id)!).push({ s: ev.data.status, u: ev.data.updatedAt, seq: ev.seq });
    for (const [oid, list] of byOrder) {
      const sorted = [...list].sort((a, b) => a.u.localeCompare(b.u) || a.seq - b.seq);
      let maxRank = -1; let terminal: string | null = null;
      for (const e of sorted) {
        if (terminal && e.s !== terminal) viol(`[I7 events] order ${oid} left terminal ${terminal} -> ${e.s}`);
        if (e.s !== 'CANCELLED' && STATUS_RANK[e.s] < maxRank) viol(`[I7 events] order ${oid} status went backwards to ${e.s}`);
        if (e.s !== 'CANCELLED') maxRank = Math.max(maxRank, STATUS_RANK[e.s]);
        if (isTerminal(e.s)) terminal = e.s;
      }
    }
  };
  const inversions = () => {
    const adm = watchers.get(W.admin.id)!; let n = 0; const last = new Map<string, string>();
    for (const ev of adm.events) if (ev.event === 'order_updated') { const p = last.get(ev.data.id); if (p && ev.data.updatedAt < p) n++; last.set(ev.data.id, ev.data.updatedAt); }
    return n;
  };

  /** The money invariants. `quiescent` = provider healthy, background work drained, late webhooks delivered. */
  const checkMoney = async (label: string, quiescent: boolean) => {
    const orders = await rows();
    const byId = new Map(orders.map((o) => [o.id, o]));
    const pays = await prisma.payment.findMany({ where: { order: mine() } });
    const orderOfRzp = new Map(pays.map((p) => [p.razorpayOrderId, p.orderId]));
    const capturedByOrder = new Map<string, string[]>();
    for (const [payId, c] of ledger.captured) { const oid = orderOfRzp.get(c.rzpOrderId); if (oid) capturedByOrder.set(oid, [...(capturedByOrder.get(oid) ?? []), payId]); else viol(`[I3 ${label}] captured payment ${payId} has no Kraveo payment row`); }
    for (const [payId, list] of ledger.sim.refunds) {
      const real = list.filter((r) => r.status !== 'failed');
      const c = ledger.captured.get(payId);
      if (!c) { viol(`[I3 ${label}] refund of a payment that was never captured: ${payId}`); continue; }
      if (real.length > 1) viol(`[I3 ${label}] payment ${payId} refunded ${real.length} times`);
      const o = byId.get(orderOfRzp.get(c.rzpOrderId) ?? '');
      if (o && o.status !== 'CANCELLED') viol(`[I3 ${label}] ${o.status} order ${o.id} was refunded`);
    }
    for (const o of orders) {
      const caps = capturedByOrder.get(o.id) ?? [];
      const refunds = caps.flatMap((p) => ledger.refundsOf(p));
      if (o.status === 'CANCELLED' && caps.length === 0 && refunds.length) viol(`[I3 ${label}] unpaid-cancelled ${o.id} has refunds`);
      if (quiescent) {
        if (o.status === 'CANCELLED' && caps.length > 0 && refunds.length !== 1) viol(`[I3 ${label}] CANCELLED paid order ${o.id} has ${refunds.length} refunds (refundStatus ${o.refundStatus}, ${o.paymentStatus})`);
        if (o.status === 'CANCELLED' && caps.length > 0 && (o.paymentStatus !== 'REFUNDED' || o.refundStatus !== 'DONE')) viol(`[I3 ${label}] CANCELLED paid order ${o.id} db says ${o.paymentStatus}/${o.refundStatus}`);
        if (o.status === 'CANCELLED' && caps.length === 0 && o.paymentStatus === 'REFUNDED') viol(`[I3 ${label}] ${o.id} REFUNDED in db but nothing was captured`);
        if (caps.length > 0 && o.status !== 'CANCELLED' && o.paymentStatus !== 'PAID') viol(`[I4 ${label}] captured order ${o.id} (${o.status}) is ${o.paymentStatus} after all webhooks`);
      }
    }
    if (quiescent) {
      const toPaise = (o: Row) => Math.round(o.totalAmount * 100);
      const delivered = orders.filter((o) => o.status === 'DELIVERED').reduce((s, o) => s + toPaise(o), 0);
      const inFlight = orders.filter((o) => !isTerminal(o.status) && o.paymentStatus === 'PAID').reduce((s, o) => s + toPaise(o), 0);
      const net = ledger.totalCaptured() - ledger.totalRefunded();
      if (net !== delivered + inFlight) viol(`[I4 ${label}] captured-refunded=${net} but delivered=${delivered} + in-flight=${inFlight}`);
      // I10: a rider's duty status matches their load.
      for (const r of W.riders) {
        const d = await prisma.driverPartner.findUniqueOrThrow({ where: { id: r.profileId } });
        const n = orders.filter((o) => o.driverId === r.id && ACTIVE.includes(o.status)).length;
        if (d.dutyStatus === 'IN_TRANSIT' && n === 0) viol(`[I10 ${label}] rider ${r.id} IN_TRANSIT with no active order`);
        if (d.dutyStatus === 'ONLINE' && n > 0) viol(`[I10 ${label}] rider ${r.id} ONLINE while carrying ${n}`);
      }
    }
  };
  const checkLists = async (label: string) => {
    for (const v of W.vendors) {
      for (const q of ['', '?scope=active', '?scope=history']) {
        const r = await api.list(v, q);
        for (const o of r.body.data ?? []) {
          const row = await rowOf(o.id);
          if (!row?.paidAt) viol(`[I5 ${label}] vendor ${v.id} list${q} shows never-paid order ${o.id}`);
          if (o.otpCode) viol(`[I6 ${label}] vendor list shows otpCode`);
          if (o.customer?.phone) viol(`[I6 ${label}] vendor list shows a phone`);
        }
      }
    }
    for (const r of W.riders) {
      const av = await api.available(r);
      for (const o of av.body.data ?? []) if (o.paymentStatus !== 'PAID' || o.driver || o.customer || !['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(o.status)) viol(`[I5 ${label}] pool for ${r.id} shows ${o.id} ${o.status}/${o.paymentStatus}`);
      const mineList = await api.list(r, '?scope=active');
      for (const o of mineList.body.data ?? []) { if (o.otpCode) viol(`[I6 ${label}] rider list shows otpCode`); if (o.driver?.id !== r.id) viol(`[I5 ${label}] rider ${r.id} list shows an order of ${o.driver?.id}`); }
    }
    for (const c of W.customers) {
      for (const o of (await api.list(c, '?scope=active')).body.data ?? []) {
        if (o.customer?.id !== c.id) viol(`[I6 ${label}] customer ${c.id} list shows ${o.customer?.id}'s order`);
        if (o.otpCode && o.status !== 'ARRIVED_AT_GATE') viol(`[I6 ${label}] customer list otp outside the gate`);
      }
    }
  };
  const fail5xx = () => api.calls.filter((c) => c.status >= 500 && !(c.status === 503 && (c.body as any)?.code === 'PROVIDER_UNAVAILABLE'));

  const assertClean = (where: string) => {
    const problems = [
      ...fail5xx().slice(0, 10).map((c) => `[I1] ${c.status} ${c.method} ${c.url} by ${c.who}: ${JSON.stringify(c.body).slice(0, 160)}`),
      ...unhandled.map((u) => `[I1] unhandled rejection/exception: ${u}`),
      ...requestErrors.slice(0, 5).map((e) => `[I1] request failed to complete: ${e}`),
      ...violations,
    ];
    if (problems.length) {
      console.error(`STRESS FAILURE (seed=${SEED}, ${where}) rerun: STRESS_SEED=${SEED} npx jest --runInBand test/e2e/lifecycle_stress.test.ts\n${problems.join('\n')}`);
    }
    expect({ seed: SEED, where, problems }).toEqual({ seed: SEED, where, problems: [] });
  };

  beforeAll(async () => {
    process.on('unhandledRejection', onRej);
    process.on('uncaughtException', onRej);
    await cleanTestOrders();
    W = await createWorld('st', '2', { customers: 6, vendors: 3, riders: 5 });
    server = await startTestServer(0);
    api = createApi(server.baseUrl);
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    for (const p of [...W.customers, ...W.vendors, ...W.riders, W.admin]) watchers.set(p.id, await new Watcher(server.baseUrl, p).connect());
  });
  afterAll(async () => {
    process.off('unhandledRejection', onRej);
    process.off('uncaughtException', onRej);
    for (const w of watchers.values()) w.disconnect();
    setPaymentProvider(null);
    await __waitForBackgroundWork();
    await stopTestServer(server);
    await purgeWorld('st');
    await cleanTestOrders();
    await prisma.$disconnect();
  });

  test('self-check: the invariant checkers really fire on planted violations (so a green simulation means something)', async () => {
    const [c1] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
    const mk = (data: Record<string, unknown>) => prisma.order.create({ data: { customerId: c1.id, vendorId: v1.vendorId, totalAmount: 220, dropoffHostel: 'Block 1', ...data } as any });
    const now = new Date();
    const deliveredNoOtp = await mk({ status: 'DELIVERED', paymentStatus: 'PAID', paidAt: now, deliveredAt: now });
    const acceptedUnpaid = await mk({ status: 'ACCEPTED' });
    const carrying = [await mk({ status: 'PICKED_UP', paymentStatus: 'PAID', paidAt: now, driverId: r1.id }), await mk({ status: 'PREPARING', paymentStatus: 'PAID', paidAt: now, driverId: r1.id })];
    const unpaid = [await mk({}), await mk({}), await mk({}), await mk({})];
    violations.length = 0; prevSnap = new Map();
    await sampleOnce('meta');
    const text = () => violations.join('\n');
    expect(text()).toMatch(new RegExp(`I2 meta\\] DELIVERED order ${deliveredNoOtp.id}`));
    expect(text()).toMatch(new RegExp(`I2 meta\\] ACCEPTED order ${acceptedUnpaid.id} is not paid`));
    expect(text()).toMatch(/I8 meta\] rider st-rider-1 has 2 active/);
    expect(text()).toMatch(/I9 meta\] st-cust-1 has \d+ unpaid/);
    // I7: backwards and out of a terminal state.
    violations.length = 0;
    await prisma.order.update({ where: { id: carrying[1].id }, data: { status: 'PLACED' } });
    await prisma.order.update({ where: { id: deliveredNoOtp.id }, data: { status: 'ACCEPTED' } });
    await sampleOnce('meta2');
    expect(text()).toMatch(new RegExp(`I7 meta2\\] order ${carrying[1].id} moved backwards`));
    expect(text()).toMatch(new RegExp(`I7 meta2\\] terminal order ${deliveredNoOtp.id} changed`));
    // I3 / I4: a refund of a delivered order, a double refund, an uncaptured refund, money that does not add up.
    violations.length = 0;
    await prisma.order.update({ where: { id: deliveredNoOtp.id }, data: { status: 'DELIVERED', otpCode: 'USED' } });
    await prisma.payment.create({ data: { orderId: deliveredNoOtp.id, razorpayOrderId: 'rzp_meta_1', razorpayPaymentId: 'pay_meta_1', amount: 220, status: 'PAID' } });
    ledger.capture('rzp_meta_1', 'pay_meta_1', 22000);
    ledger.sim.refunds.set('pay_meta_1', [{ id: 'r1', amountPaise: 22000, status: 'processed' }, { id: 'r2', amountPaise: 22000, status: 'processed' }]);
    ledger.sim.refunds.set('pay_meta_never', [{ id: 'r3', amountPaise: 100, status: 'processed' }]);
    await checkMoney('meta3', true);
    expect(text()).toMatch(/I3 meta3\] payment pay_meta_1 refunded 2 times/);
    expect(text()).toMatch(/I3 meta3\] DELIVERED order .* was refunded/);
    expect(text()).toMatch(/I3 meta3\] refund of a payment that was never captured: pay_meta_never/);
    expect(text()).toMatch(/I4 meta3\] captured-refunded=/);
    // I5 / I6 on the event logs: an unpaid order reaching a restaurant and a rider, with an OTP and raw columns.
    violations.length = 0;
    const vw = watchers.get(v1.id)!; const rw = watchers.get(r1.id)!; const other = watchers.get(v2.id)!;
    const m0 = [vw.events.length, rw.events.length, other.events.length]; const k = checked.get(v1.id) ?? 0; void k;
    vw.events.push({ seq: 1e9, event: 'new_order_alert', at: Date.now(), data: { id: unpaid[0].id, paymentStatus: 'PENDING', otpCode: '1234', customer: { phone: '+91 1' }, passwordHash: 'x' } });
    rw.events.push({ seq: 1e9 + 1, event: 'order_available', at: Date.now(), data: { id: unpaid[1].id, paymentStatus: 'PENDING', customer: { name: 'x' } } });
    other.events.push({ seq: 1e9 + 2, event: 'order_updated', at: Date.now(), data: { id: carrying[0].id, paymentStatus: 'PAID' } });
    await checkEvents('meta4');
    expect(text()).toMatch(/I5\] \[meta4 VENDOR:st-vown-1 new_order_alert .*never paid-live/);
    expect(text()).toMatch(/I6\] \[meta4 VENDOR:st-vown-1 new_order_alert .*carries otpCode/);
    expect(text()).toMatch(/I6\] \[meta4 VENDOR:st-vown-1 new_order_alert .*raw keys passwordHash/);
    expect(text()).toMatch(/I5\] \[meta4 DRIVER:st-rider-1 order_available .*never paid-live/);
    expect(text()).toMatch(/I5\] \[meta4 VENDOR:st-vown-2 order_updated .*restaurant st-vown-1 order reached st-vown-2/);
    void m0;
    // Clean slate for the real simulation.
    vw.events.length = m0[0]; rw.events.length = m0[1]; other.events.length = m0[2];
    await prisma.payment.deleteMany({ where: { razorpayOrderId: 'rzp_meta_1' } });
    await prisma.order.deleteMany({ where: mine() });
    ledger.captured.clear(); ledger.sim.refunds.clear();
    violations.length = 0; prevSnap = new Map(); checked.clear();
  });

  test(`seeded simulation: ${WAVES} waves, ~40 orders, invariants I1-I10 after every wave`, async () => {
    rng = mulberry32(SEED);
    let totalActions = 0;
    try {
      for (let w = 0; w < WAVES; w++) {
        const stop = startSampler(`wave ${w}`);
        const info = await wave(w);
        await stop();
        totalActions += info.n;
        await sampleOnce(`wave ${w} end`);
        // Non-quiescent checks (provider may still be down inside this wave's refunds): safety invariants only.
        await checkMoney(`wave ${w} (live)`, false);
        await checkEvents(`wave ${w}`);
        await settle();
        await checkMoney(`wave ${w} (settled)`, true);
        await checkEvents(`wave ${w} settled`);
        await checkLists(`wave ${w}`);
        await sampleOnce(`wave ${w} settled`);
        assertClean(`after wave ${w}`);
      }
      // Final: finish the evening. Everything still open is cancelled by admin (refund exactly once) and the books must close.
      let open = (await rows()).filter((o) => !isTerminal(o.status));
      const stats = { inFlightAtEnd: open.length };
      await runOrderMaintenance(minutesFromNow(30));
      for (const o of (await rows()).filter((x) => !isTerminal(x.status))) await api.adminCancel(W.admin, o.id, 'End of evening');
      await settle();
      open = (await rows()).filter((o) => !isTerminal(o.status));
      expect(open).toEqual([]);
      await checkMoney('final', true);
      await checkEvents('final');
      await checkLists('final');
      await sampleOnce('final');
      const all = await rows();
      const by = (s: string) => all.filter((o) => o.status === s).length;
      const refundedN = all.filter((o) => o.paymentStatus === 'REFUNDED').length;
      console.log(`stress seed=${SEED}: ${all.length} orders, ${by('DELIVERED')} delivered, ${by('CANCELLED')} cancelled (${refundedN} refunded), ${totalActions} actions, ${api.calls.length} HTTP calls (4xx ${api.calls.filter((c) => c.status >= 400 && c.status < 500).length}), event-order inversions seen by admin: ${inversions()}, in flight before wrap-up: ${stats.inFlightAtEnd}`);
      // The simulation must actually exercise the lifecycle, not just bounce off 4xx.
      expect(all.length).toBeGreaterThanOrEqual(25);
      expect(by('DELIVERED')).toBeGreaterThanOrEqual(3);
      expect(refundedN).toBeGreaterThanOrEqual(3);
      assertClean('final');
    } catch (e) {
      console.error(`STRESS test failed with seed=${SEED}: ${(e as Error).message.slice(0, 400)}`);
      throw e;
    }
  });

  // =========================================================================================
  // Fuzz: malformed everything, expect 4xx, never 5xx, server alive afterwards
  // =========================================================================================
  describe('fuzz', () => {
    const fuzzCalls: { method: string; url: string; status: number; note: string }[] = [];
    const base = () => server.baseUrl;
    const STUDENT = () => W.customers[0].token; const VENDOR = () => W.vendors[0].token; const RIDER = () => W.riders[0].token; const ADMIN = () => W.admin.token;

    const raw = async (method: string, url: string, token: string | null, body: string | undefined, headers: Record<string, string> = {}) => {
      const res = await fetch(`${base()}${url}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
      await res.text();
      fuzzCalls.push({ method, url: url.slice(0, 90), status: res.status, note: body ? body.slice(0, 40) : '' });
      return res.status;
    };
    const HUGE = 'A'.repeat(300_000);
    const BODIES: [string, string | undefined][] = [
      ['none', undefined], ['null', 'null'], ['array', '[]'], ['array of objects', '[{"a":1},{"b":2}]'], ['string', '"hello"'], ['number', '123'], ['bool', 'true'], ['empty object', '{}'],
      ['nested', '{"a":{"b":{"c":[[[[]]]]}}}'], ['proto pollution', '{"__proto__":{"role":"ADMIN","isAdmin":true},"constructor":{"prototype":{"x":1}}}'],
      ['wrong types', '{"vendorId":{"$ne":1},"items":"lots","orderId":["x"],"status":["ACCEPTED"],"reason":{"a":1},"otpCode":{"x":1},"driverId":42,"dropoffHostel":false,"clientRequestId":[1]}'],
      ['negative/NaN-ish numbers', '{"lat":-1e999,"lng":"NaN","amount":-5,"quantity":-3,"otpCode":-1,"items":[{"itemId":"x","quantity":-1}]}'],
      ['huge numbers', '{"lat":1e999,"lng":1e308,"items":[{"itemId":"x","quantity":1e999}],"otpCode":99999999999999999999}'],
      ['unicode', '{"reason":"\\u0000\\ud800 \\u202e","status":"ACCEPTED\\u0000","orderId":"\\ud83c\\udf55"}'],
      ['truncated json', '{"a":'], ['not json', 'hello world'], ['deep nesting', '['.repeat(5000) + ']'.repeat(5000)],
      ['long field', JSON.stringify({ reason: 'x'.repeat(5000), dropoffNotes: 'y'.repeat(5000), couponCode: 'z'.repeat(5000), orderId: 'q'.repeat(5000), razorpayOrderId: 'r'.repeat(5000) })],
      ['items flood', JSON.stringify({ vendorId: 'st-ven-1', dropoffHostel: 'Block 2', items: Array.from({ length: 1500 }, () => ({ itemId: 'st-ven-1-i1', quantity: 1 })) })],
    ];
    const BAD_IDS = ['%00', '..%2F..%2Fetc%2Fpasswd', "%27%3B%20DROP%20TABLE%20%22Order%22%3B--", 'a'.repeat(3000), '%F0%9F%8D%95', 'null', 'undefined', '-1', 'NaN', '0', '00000000-0000-0000-0000-000000000000', '__proto__', 'constructor', '%', '%ZZ', 'x'.repeat(65), '%3Cscript%3E', '%0d%0aX-Injected:1', 'true', '1e999'];
    const ID_ROUTES: [string, string, () => string, boolean][] = [
      ['get', '/api/orders/:id', STUDENT, false], ['post', '/api/orders/:id/cancel', STUDENT, true], ['patch', '/api/orders/:id/status', VENDOR, true], ['post', '/api/orders/:id/reject', VENDOR, true],
      ['post', '/api/orders/:id/accept-driver', RIDER, true], ['post', '/api/orders/:id/release', RIDER, true], ['post', '/api/orders/:id/verify-gate-otp', RIDER, true], ['patch', '/api/orders/:id/status', RIDER, true],
      ['patch', '/api/orders/:id/reassign', ADMIN, true], ['post', '/api/admin/orders/:id/cancel', ADMIN, true], ['post', '/api/admin/orders/:id/reset-otp-lock', ADMIN, true], ['post', '/api/admin/orders/:id/retry-refund', ADMIN, true],
      ['get', '/api/orders/:id', ADMIN, false], ['get', '/api/orders/:id', RIDER, false], ['get', '/api/orders/:id', VENDOR, false],
    ];
    const NOID_ROUTES: [string, string, () => string][] = [
      ['post', '/api/orders', STUDENT], ['post', '/api/payments/create-order', STUDENT], ['post', '/api/payments/verify-signature', STUDENT], ['post', '/api/drivers/location', RIDER], ['post', '/api/drivers/duty-status', RIDER],
      ['post', '/api/admin/partners/driver/st-dp-1/status', ADMIN], ['post', '/api/admin/partners/vendor/st-ven-1/status', ADMIN], ['post', '/api/coupons/redeem-coins', STUDENT], ['post', '/api/notifications/register-token', STUDENT], ['put', '/api/auth/profile', STUDENT],
    ];

    afterEach(async () => {
      // The server must still answer and still do real work after any amount of abuse.
      expect(await raw('GET', '/health', null, undefined)).toBe(200);
    });

    test('malformed ids on every id route: never 5xx, never 2xx for a missing/garbage id', async () => {
      const bad: string[] = [];
      for (const [method, tpl, tok, mutating] of ID_ROUTES) {
        for (const id of BAD_IDS) {
          const body = mutating ? '{"status":"ACCEPTED","reason":"abc def","otpCode":"1234","driverId":"x"}' : undefined;
          const s = await raw(method.toUpperCase(), tpl.replace(':id', id), tok(), body);
          if (s >= 500 || (s >= 200 && s < 300)) bad.push(`${s} ${method} ${tpl} id=${id.slice(0, 20)}`);
        }
      }
      expect(bad).toEqual([]);
    });

    test('malformed bodies on every mutating route (missing order id so nothing can legitimately succeed): 4xx, never 5xx', async () => {
      const bad: string[] = [];
      const routes = [...ID_ROUTES.filter((r) => r[3]).map(([m, t, k]) => [m, t.replace(':id', 'does-not-exist'), k] as [string, string, () => string]), ...NOID_ROUTES];
      for (const [method, url, tok] of routes) {
        for (const [name, body] of BODIES) {
          const s = await raw(method.toUpperCase(), url, tok(), body);
          if (s >= 500 || (s >= 200 && s < 300 && /^\/api\/(orders|payments|admin\/orders|drivers\/location)/.test(url))) bad.push(`${s} ${method} ${url} body=${name}`);
        }
      }
      expect(bad).toEqual([]);
    });

    test('PROVE: a request body over 100 kB is answered 413, not 500', async () => {
      const s = await raw('POST', '/api/orders', STUDENT(), JSON.stringify({ vendorId: 'x', items: [], dropoffNotes: HUGE }));
      expect(s).toBe(413);
    });

    test('PROVE: POST /reviews with a non-string orderId is 400, not 500', async () => {
      const bad: string[] = [];
      for (const body of ['{"orderId":["x"]}', '{"orderId":{"a":1}}', '{"orderId":{"$ne":"x"}}', '{"orderId":123}', '{"orderId":true}', '{"orderId":"x","driverRating":{"a":1},"dishReviews":"lots"}']) {
        const s = await raw('POST', '/api/reviews', STUDENT(), body);
        if (s !== 400) bad.push(`${s} ${body}`);
      }
      expect(bad).toEqual([]);
    });

    test('malformed query strings on lists: 200 or 400, never 5xx', async () => {
      const qs = ['?limit=-5', '?limit=NaN', '?limit=1e9', '?limit=99999999999999999999', '?limit[]=1', '?limit[a]=1', '?scope[]=active', '?scope[a]=b', '?scope=', '?scope=ACTIVE', '?cursor=%00', '?cursor=' + 'a'.repeat(2000),
        '?cursor=00000000-0000-0000-0000-000000000000', '?cursor[]=x', '?status[]=PLACED', '?status=NOPE', '?paymentStatus[$ne]=PAID', '?vendorId[]=a&driverId[]=b&customerId[]=c', '?limit=5&limit=6&limit=7', '?%00=1', '?a=' + 'b'.repeat(8000)];
      const bad: string[] = [];
      for (const tok of [STUDENT(), VENDOR(), RIDER(), ADMIN()]) {
        for (const q of qs) for (const path of ['/api/orders', '/api/orders/available', '/api/admin/orders/needs-attention']) {
          const s = await raw('GET', path + q, tok, undefined);
          if (s >= 500) bad.push(`${s} GET ${path}${q.slice(0, 30)}`);
        }
      }
      expect(bad).toEqual([]);
    });

    test('auth abuse: garbage / oversized / wrong-role / tampered tokens never reach 5xx', async () => {
      const bad: string[] = [];
      const forged = (payload: object) => generateTestToken(payload as any);
      const tokens: (string | null)[] = [null, '', 'x', 'a.b.c', 'A'.repeat(20_000), forged({ id: 'st-cust-1', role: 'HACKER' }), forged({ id: 'st-cust-1', role: ['ADMIN'] }), forged({ role: 'STUDENT' }), forged({ id: 'st-cust-1' }), forged({ id: 'x'.repeat(5000), role: 'DRIVER' })];
      for (const t of tokens) {
        for (const [m, u] of [['GET', '/api/orders'], ['POST', '/api/orders'], ['GET', '/api/orders/available'], ['POST', '/api/orders/x/accept-driver'], ['POST', '/api/payments/create-order'], ['POST', '/api/drivers/location'], ['GET', '/api/admin/orders/needs-attention'], ['POST', '/api/orders/x/cancel']] as const) {
          const s = await raw(m, u, t, m === 'POST' ? '{}' : undefined);
          if (s >= 500) bad.push(`${s} ${m} ${u} token#${tokens.indexOf(t)}`);
        }
      }
      for (const h of ['Bearer', 'Bearer ', 'bearer x', 'Basic abc', 'Bearer ' + 'z'.repeat(9000)]) {
        const s = await raw('GET', '/api/orders', null, undefined, { authorization: h });
        if (s >= 500) bad.push(`${s} authorization=${h.slice(0, 12)}`);
      }
      expect(bad).toEqual([]);
    });

    test('webhook abuse: garbage signed bodies are 200/400, never 5xx', async () => {
      const bad: string[] = [];
      for (const [name, body] of BODIES) {
        for (const sig of ['valid_test_wh_signature', 'nope', '', 'a'.repeat(10_000)]) {
          const s = await raw('POST', '/api/payments/webhook', null, body, { 'x-razorpay-signature': sig });
          if (s >= 500) bad.push(`${s} webhook sig=${sig.slice(0, 8)} body=${name}`);
        }
      }
      expect(bad).toEqual([]);
    });

    test('socket abuse: garbage events and join_room payloads never crash the server or the connection', async () => {
      const w = await new Watcher(base(), W.customers[1]).connect();
      const s = w.socket!;
      const junk: unknown[] = [null, undefined, 0, -1, NaN, true, [], [1, 2], {}, { a: 1 }, 'x'.repeat(200_000), 'order_' + 'y'.repeat(500), 'vendor_%00', 'order_../..', 'user_x', 'admins', ['order_x'], { toString: 1 }, 'order_' + 'a'.repeat(64), 'drivers'];
      for (const j of junk) {
        s.emit('join_room', j);
        s.emit('join_room', j, 'not-a-function');
        s.emit('leave_room', j);
        s.emit('update_driver_location', j);
        s.emit('update_driver_location', { lat: j, lng: j, heading: j });
      }
      for (const j of junk.slice(0, 8)) { try { await s.timeout(2000).emitWithAck('join_room', j); } catch { /* an unanswered ack for garbage is acceptable */ } }
      await sleep(300);
      expect(s.connected).toBe(true);
      expect(await w.join(`order_nope`)).toBe(false);
      const rider = await new Watcher(base(), W.riders[1]).connect();
      for (const j of junk) { rider.socket!.emit('update_driver_location', j); rider.socket!.emit('update_driver_location', { lat: j, lng: 1 }); rider.socket!.emit('update_driver_location', { lat: 95, lng: 200 }); }
      await sleep(300);
      expect(rider.connected).toBe(true);
      w.disconnect(); rider.disconnect();
      expect(unhandled).toEqual([]);
    });

    test('after the abuse the system still does a complete order', async () => {
      const [c] = W.customers; const [v] = W.vendors; const [r] = W.riders;
      const placed = await api.place(c, v);
      expect(placed.status).toBe(201);
      const id = placed.body.data.id as string;
      expect(await doPay(c, id, 'verify')).toBe(true);
      expect((await api.setStatus(v, id, 'ACCEPTED')).status).toBe(200);
      expect((await api.claim(r, id)).status).toBe(200);
      expect((await api.setStatus(v, id, 'PREPARING')).status).toBe(200);
      expect((await api.setStatus(v, id, 'READY_FOR_PICKUP')).status).toBe(200);
      expect((await api.setStatus(r, id, 'PICKED_UP')).status).toBe(200);
      expect((await api.setStatus(r, id, 'ARRIVED_AT_GATE')).status).toBe(200);
      const otp = (await api.get(c, id)).body.data.otpCode;
      expect((await api.otp(r, id, otp)).body.data.status).toBe('DELIVERED');
      expect(fuzzCalls.length).toBeGreaterThan(500);
    });
  });
});
