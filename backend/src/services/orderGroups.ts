import { OrderGroup, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { MAX_UNPAID_OPEN_ORDERS } from '../config/orderFlow';
import { normalizeDropPoint } from '../config/campus';
import { couponEligibilityProblem, normaliseCoupon, validateAndCalculateGroup, validateAndCalculateOrder, GroupRestaurantInput, GroupValidationResult } from '../utils/validation';
import { getSettings } from './settings';
import { ORDER_VIEW_INCLUDE, OrderWithRelations, orderView } from './orderView';
import { publishOrderChange } from '../realtime';
import {
  ChangeResult, OrderFlowError, REPLACED_REASON, auditCancel, cancelInTx, countUnpaidOpen, finishChange, isAbandonedOrder, loadGroupChildren,
  lockOrderInTx, mismatch, sameItems,
} from './orderFlow';

/**
 * Multi-restaurant orders (Docs/22): quote, place, and the group view. The state changes of a placed group (paid, cancel, claim, release,
 * arrive, deliver) live in orderFlow.ts next to the single-order ones and share its locking.
 */
export const MAX_GROUP_RESTAURANTS_HARD = 10; // request shape guard only; the real limit is the admin setting fees.maxRestaurantsPerOrder (1..5)

// ----------------------------------------------------------------------------
// Shared checks of quote and place
// ----------------------------------------------------------------------------
/** The restaurant count rules (Docs/22 4.2). `forPlace` = a group order (2 or more); a quote also accepts exactly one restaurant. */
const checkCount = (restaurants: GroupRestaurantInput[], max: number, forPlace: boolean) => {
  const n = restaurants.length;
  if (n < 1) throw new OrderFlowError(400, 'BAD_REQUEST', 'Choose at least one restaurant.', { field: 'restaurants' });
  if (n === 1 && forPlace) throw new OrderFlowError(400, 'USE_SINGLE_ORDER', 'One restaurant is a normal order: use POST /api/orders.', { field: 'restaurants' });
  if (n > 1 && max <= 1) throw new OrderFlowError(400, 'MULTI_DISABLED', 'Ordering from several restaurants at once is switched off right now.', { field: 'restaurants' });
  if (n > max) throw new OrderFlowError(400, 'TOO_MANY_RESTAURANTS', `You can order from at most ${max} restaurants at once.`, { field: 'restaurants', maxRestaurants: max });
  if (new Set(restaurants.map((r) => r.vendorId)).size !== n) throw new OrderFlowError(400, 'DUPLICATE_RESTAURANT', 'Each restaurant can appear only once in a combined order.', { field: 'restaurants' });
};

/** Every restaurant must be approved and open (same messages as a single order). Returns them by id. */
const loadOpenVendors = async (restaurants: GroupRestaurantInput[]) => {
  const vendors = await prisma.vendor.findMany({ where: { id: { in: restaurants.map((r) => r.vendorId) } } });
  const byId = new Map(vendors.map((v) => [v.id, v]));
  for (const r of restaurants) {
    const v = byId.get(r.vendorId);
    if (!v || v.approvalStatus !== 'APPROVED') throw new OrderFlowError(400, 'VENDOR_UNAVAILABLE', 'This restaurant is not available right now.', { vendorId: r.vendorId });
    if (!v.isAcceptingOrders) throw new OrderFlowError(400, 'VENDOR_CLOSED', 'This Dhaba is currently CLOSED for new orders.', { vendorId: r.vendorId });
  }
  return byId;
};

// ----------------------------------------------------------------------------
// Quote
// ----------------------------------------------------------------------------
export type Quote = {
  restaurantCount: number;
  subtotal: number;
  fees: { total: number; base: number; baseWaived: boolean; extraRestaurants: number; extraRestaurantFee: number; extraTotal: number };
  discount: number;
  couponCode: string | null;
  total: number;
  perRestaurant: { vendorId: string; vendorName: string; subtotal: number; fee: number }[];
  maxRestaurants: number;
};

/**
 * What a cart would be charged, written nowhere (POST /api/orders/quote). Uses exactly the code that places the order, so quote == charge.
 * One restaurant = a normal single-order price; several = the combined price.
 */
export const quoteOrder = async (customerId: string, input: { restaurants: GroupRestaurantInput[]; couponCode?: string }): Promise<Quote> => {
  const settings = await getSettings();
  const max = settings.fees.maxRestaurantsPerOrder;
  checkCount(input.restaurants, max, false);
  const vendors = await loadOpenVendors(input.restaurants);
  const extraEach = settings.fees.extraRestaurantFee;
  const n = input.restaurants.length;

  let quote: Quote;
  if (n === 1) {
    const r = input.restaurants[0];
    const priced = await validateAndCalculateOrder(r.vendorId, r.items, input.couponCode);
    if (!priced.isValid) throw new OrderFlowError(400, 'INVALID_ITEMS', priced.errorMessage || 'Some items are not available.', { field: 'items' });
    if (priced.couponProblem) throw new OrderFlowError(400, 'COUPON_NOT_APPLICABLE', priced.couponProblem, { field: 'couponCode' });
    quote = {
      restaurantCount: 1,
      subtotal: priced.calculatedSubtotal,
      fees: { total: priced.calculatedDeliveryFee, base: priced.calculatedDeliveryFee, baseWaived: !!priced.feeBreakdown?.baseWaived, extraRestaurants: 0, extraRestaurantFee: extraEach, extraTotal: 0 },
      discount: priced.calculatedDiscount,
      couponCode: priced.appliedCoupon ?? null,
      total: priced.calculatedTotalAmount,
      perRestaurant: [{ vendorId: r.vendorId, vendorName: vendors.get(r.vendorId)!.name, subtotal: priced.calculatedSubtotal, fee: priced.calculatedDeliveryFee }],
      maxRestaurants: max,
    };
  } else {
    const priced = await validateAndCalculateGroup(input.restaurants, input.couponCode);
    assertGroupPriced(priced);
    quote = {
      restaurantCount: n,
      subtotal: priced.subtotal,
      fees: {
        total: priced.feeTotal,
        base: priced.children[0].deliveryFee,
        baseWaived: !!priced.feeBreakdown?.baseWaived,
        extraRestaurants: n - 1,
        extraRestaurantFee: extraEach,
        extraTotal: Math.round(extraEach * 100 * (n - 1)) / 100,
      },
      discount: priced.discount,
      couponCode: priced.appliedCoupon,
      total: priced.totalAmount,
      perRestaurant: priced.children.map((c) => ({ vendorId: c.vendorId, vendorName: vendors.get(c.vendorId)!.name, subtotal: c.subtotal, fee: c.deliveryFee })),
      maxRestaurants: max,
    };
  }
  // Coupon eligibility for THIS customer (single use, VITFIRST only for a first order): a clear error now instead of a surprise at checkout.
  if (quote.couponCode) {
    const problem = await couponEligibilityProblem(prisma, customerId, quote.couponCode);
    if (problem) throw new OrderFlowError(400, 'COUPON_NOT_APPLICABLE', problem, { field: 'couponCode' });
  }
  return quote;
};

function assertGroupPriced(priced: GroupValidationResult): void {
  if (!priced.isValid) throw new OrderFlowError(400, 'INVALID_ITEMS', priced.errorMessage || 'Some items are not available.', { field: 'items', ...(priced.errorVendorId ? { vendorId: priced.errorVendorId } : {}) });
  // A coupon that was sent but gives nothing is an error the customer must see, not a silently ignored field.
  if (priced.couponProblem) throw new OrderFlowError(400, 'COUPON_NOT_APPLICABLE', priced.couponProblem, { field: 'couponCode' });
}

// ----------------------------------------------------------------------------
// Place a group
// ----------------------------------------------------------------------------
export type PlaceGroupInput = {
  restaurants: GroupRestaurantInput[];
  dropoffHostel: string;
  dropoffNotes: string | null;
  couponCode?: string;
  clientRequestId: string;
};

export type GroupBundle = { group: OrderGroup; orders: OrderWithRelations[] };

const GROUP_WITH_ORDERS = { include: { orders: { include: ORDER_VIEW_INCLUDE, orderBy: { groupIndex: 'asc' } } } } as const;
type GroupWithOrders = Prisma.OrderGroupGetPayload<typeof GROUP_WITH_ORDERS>;

const toBundle = (g: GroupWithOrders): GroupBundle => {
  const { orders, ...group } = g;
  return { group, orders };
};

export const loadGroupBundle = async (groupId: string): Promise<GroupBundle | null> => {
  const g = await prisma.orderGroup.findUnique({ where: { id: groupId }, ...GROUP_WITH_ORDERS });
  return g ? toBundle(g) : null;
};

/** Same checkout attempt = same request: the same restaurants with the same items, drop point, notes and coupon. */
const sameGroupRequest = (g: GroupWithOrders, input: PlaceGroupInput): boolean => {
  if (g.restaurantCount !== input.restaurants.length || g.orders.length !== input.restaurants.length) return false;
  if ((normalizeDropPoint(g.dropoffHostel) ?? g.dropoffHostel) !== (normalizeDropPoint(input.dropoffHostel) ?? input.dropoffHostel)) return false;
  if ((g.dropoffNotes ?? '') !== (input.dropoffNotes ?? '')) return false;
  if ((g.couponCode ?? null) !== normaliseCoupon(input.couponCode)) return false;
  const byVendor = new Map(g.orders.map((o) => [o.vendorId, o]));
  if (byVendor.size !== g.orders.length) return false;
  return input.restaurants.every((r) => {
    const child = byVendor.get(r.vendorId);
    return !!child && sameItems(child, r.items);
  });
};

const childRequestId = (clientRequestId: string, index: number) => `g:${clientRequestId}:${index}`;

/**
 * Docs/22 section 4.2: one checkout for 2..max restaurants. Idempotent by clientRequestId exactly like POST /orders. One transaction:
 * customer row locked, the customer's own abandoned unpaid checkouts at these restaurants replaced (single orders and whole groups,
 * through the normal cancel code), coupon and unpaid-limit rules (a group counts as ONE open order), then the group and all its children
 * are created with the money split of services/pricing.ts splitGroupMoney (children add up to the group total to the paisa).
 */
export const placeGroup = async (customerId: string, input: PlaceGroupInput): Promise<GroupBundle & { replay: boolean }> => {
  const findReplay = () =>
    prisma.orderGroup.findUnique({ where: { customerId_clientRequestId: { customerId, clientRequestId: input.clientRequestId } }, ...GROUP_WITH_ORDERS });

  const existing = await findReplay();
  if (existing) {
    if (!sameGroupRequest(existing, input)) throw mismatch();
    return { ...toBundle(existing), replay: true };
  }

  const customer = await prisma.user.findUnique({ where: { id: customerId }, select: { id: true, deletedAt: true } });
  if (!customer || customer.deletedAt) throw new OrderFlowError(401, 'ACCOUNT_UNAVAILABLE', 'This account is no longer available. Please sign in again.');

  const settings = await getSettings();
  checkCount(input.restaurants, settings.fees.maxRestaurantsPerOrder, true);
  await loadOpenVendors(input.restaurants);
  const priced = await validateAndCalculateGroup(input.restaurants, input.couponCode);
  assertGroupPriced(priced);

  const replaced: ChangeResult[] = [];
  try {
    const outcome = await prisma.$transaction(
      async (tx): Promise<GroupBundle & { replay: boolean }> => {
        // One checkout at a time per customer, so the unpaid-orders limit and single-use coupons cannot be raced.
        const locked = await tx.$queryRaw<{ deletedAt: Date | null }[]>`SELECT "deletedAt" FROM "User" WHERE "id" = ${customerId} FOR UPDATE`;
        if (locked.length === 0 || locked[0].deletedAt) throw new OrderFlowError(401, 'ACCOUNT_UNAVAILABLE', 'This account is no longer available. Please sign in again.');

        // The same checkout again that overlapped the first request: that request has committed by now (we waited for the lock).
        const twin = await tx.orderGroup.findUnique({ where: { customerId_clientRequestId: { customerId, clientRequestId: input.clientRequestId } }, ...GROUP_WITH_ORDERS });
        if (twin) {
          if (!sameGroupRequest(twin, input)) throw mismatch();
          return { ...toBundle(twin), replay: true };
        }

        // Replace this customer's own abandoned, never-paid checkouts at these restaurants (single orders and whole groups).
        const stale = await tx.order.findMany({
          where: { customerId, vendorId: { in: input.restaurants.map((r) => r.vendorId) }, status: 'PLACED', paymentStatus: { in: ['PENDING', 'FAILED'] }, paidAt: null },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: 10,
        });
        for (const { id } of stale) {
          const l = await lockOrderInTx(tx, id).catch((e) => (e instanceof OrderFlowError && e.status === 404 ? null : Promise.reject(e)));
          if (!l || l.order.customerId !== customerId) continue;
          const r = await cancelInTx(tx, l.order, { id: 'system', role: 'SYSTEM' }, 'SYSTEM', REPLACED_REASON, { guard: (o, g) => isAbandonedOrder(o, g) }, l.group);
          if (r.changed) replaced.push(r);
        }

        if (priced.appliedCoupon) {
          const problem = await couponEligibilityProblem(tx, customerId, priced.appliedCoupon);
          if (problem) throw new OrderFlowError(400, 'COUPON_NOT_APPLICABLE', problem, { field: 'couponCode' });
        }
        const unpaid = await countUnpaidOpen(tx, customerId); // a combined order counts as ONE
        if (unpaid >= MAX_UNPAID_OPEN_ORDERS) {
          throw new OrderFlowError(429, 'TOO_MANY_UNPAID_ORDERS', `You already have ${unpaid} unpaid orders. Pay for one or cancel it before placing another.`);
        }

        const group = await tx.orderGroup.create({
          data: {
            customerId,
            clientRequestId: input.clientRequestId,
            dropoffHostel: input.dropoffHostel,
            dropoffNotes: input.dropoffNotes,
            couponCode: priced.appliedCoupon,
            discount: priced.discount,
            subtotal: priced.subtotal,
            feeTotal: priced.feeTotal,
            totalAmount: priced.totalAmount,
            restaurantCount: priced.children.length,
            feeBreakdown: (priced.feeBreakdown ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });
        for (let i = 0; i < priced.children.length; i++) {
          const c = priced.children[i];
          await tx.order.create({
            data: {
              customerId,
              vendorId: c.vendorId,
              groupId: group.id,
              groupIndex: i,
              clientRequestId: childRequestId(input.clientRequestId, i),
              subtotal: c.subtotal,
              deliveryFee: c.deliveryFee,
              taxAndPackaging: 0,
              vendorSubtotal: c.vendorSubtotal,
              commissionTotal: c.commissionTotal,
              feeBreakdown: c.feeBreakdown as unknown as Prisma.InputJsonValue,
              discount: c.discount,
              couponCode: i === 0 ? priced.appliedCoupon : null, // single-use rules count the coupon once
              totalAmount: c.totalAmount,
              dropoffHostel: input.dropoffHostel,
              dropoffNotes: input.dropoffNotes,
              status: 'PLACED',
              paymentStatus: 'PENDING',
              items: { create: c.verifiedItems.map((it) => ({ menuItemId: it.itemId, name: it.name, quantity: it.quantity, price: it.price, vendorUnitPrice: it.vendorUnitPrice, commissionUnit: it.commissionUnit })) },
            },
          });
        }
        const orders = await loadGroupChildren(tx, group.id);
        return { group, orders, replay: false };
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
    if (outcome.replay) return outcome;
    // The replaced checkouts are cancelled for good only now that the new group is committed (a failed checkout rolled them back).
    for (const r of replaced) {
      await auditCancel(r, 'SYSTEM', REPLACED_REASON);
      await finishChange(r, { awaitRefund: false });
    }
    // Unpaid: admins see them; the restaurants and riders do not (orderView filters them out anyway).
    for (const o of outcome.orders) await publishOrderChange(o);
    return outcome;
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Two identical requests raced: the other one created the group.
      const again = await findReplay();
      if (again) {
        if (!sameGroupRequest(again, input)) throw mismatch();
        return { ...toBundle(again), replay: true };
      }
    }
    throw err;
  }
};

// ----------------------------------------------------------------------------
// GroupView
// ----------------------------------------------------------------------------
const STATUS_RANK: Record<string, number> = { PLACED: 0, ACCEPTED: 1, PREPARING: 2, READY_FOR_PICKUP: 3, PICKED_UP: 4, ARRIVED_AT_GATE: 5, DELIVERED: 6 };

/**
 * Derived, never stored: CANCELLED when every child is, DELIVERED when every child is, otherwise AWAITING_RESTAURANTS while any child
 * is still PLACED, else the status of the LEAST advanced child that is not cancelled. (An unpaid group is also AWAITING_RESTAURANTS:
 * read `paymentStatus` to know whether it still has to be paid.)
 */
export const deriveGroupStatus = (orders: { status: string }[]): string => {
  if (orders.every((o) => o.status === 'CANCELLED')) return 'CANCELLED';
  if (orders.every((o) => o.status === 'DELIVERED')) return 'DELIVERED';
  const live = orders.filter((o) => o.status !== 'CANCELLED');
  if (live.some((o) => o.status === 'PLACED')) return 'AWAITING_RESTAURANTS';
  return live.reduce((least, o) => ((STATUS_RANK[o.status] ?? 0) < (STATUS_RANK[least.status] ?? 0) ? o : least)).status;
};

export const groupView = (bundle: GroupBundle, viewerRole: string, viewerId: string) => {
  const { group, orders } = bundle;
  const primary = orders[0];
  return {
    id: group.id,
    status: deriveGroupStatus(orders),
    paymentStatus: primary.paymentStatus as string,
    total: group.totalAmount,
    subtotal: group.subtotal,
    feeTotal: group.feeTotal,
    discount: group.discount,
    couponCode: group.couponCode ?? null,
    restaurantCount: group.restaurantCount,
    dropoffHostel: group.dropoffHostel,
    dropoffNotes: group.dropoffNotes ?? null,
    createdAt: group.createdAt.toISOString(),
    payOrderId: primary.id,
    orders: orders.map((o) => orderView(o, viewerRole, viewerId)).filter((v): v is Record<string, unknown> => v !== null),
  };
};


