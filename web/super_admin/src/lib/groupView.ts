// GET /api/order-groups/:id (Docs/22 section 10.3, backend/src/services/orderGroups.ts groupView) parsed defensively.
// Money fields are `number | null`: a field the server did not send is "unknown" and is shown as such, never as 0.
import { Order, normalizeOrder } from '../types';
import { ORDER_STATUS_LABEL } from './tokens';
import { humanize } from './orders';

export interface GroupView {
  id: string;
  /** Derived by the server: AWAITING_RESTAURANTS, an order status, CANCELLED or DELIVERED. */
  status: string;
  paymentStatus: string;
  total: number | null;
  subtotal: number | null;
  feeTotal: number | null;
  discount: number | null;
  couponCode: string | null;
  restaurantCount: number | null;
  dropoffHostel: string | null;
  createdAt: string | null;
  /** The primary order (carries the payment). */
  payOrderId: string | null;
  /** Every order of the group, in group order (admin view: full OrderViews). */
  orders: Order[];
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/** `{ data }` (or the data itself) -> view, or null when it is not a group (no id). */
export const parseGroupView = (raw: unknown): GroupView | null => {
  const body: any = raw && typeof raw === 'object' ? raw : null;
  const r: any = body && body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
  const id = r ? str(r.id) : null;
  if (!r || !id) return null;
  const orders = (Array.isArray(r.orders) ? r.orders : [])
    .filter((o: any) => o && typeof o === 'object' && str(o.id))
    .map((o: any) => normalizeOrder(o))
    .sort((a: Order, b: Order) => (a.group?.index ?? 0) - (b.group?.index ?? 0));
  return {
    id,
    status: (str(r.status) ?? 'UNKNOWN').toUpperCase(),
    paymentStatus: (str(r.paymentStatus) ?? 'UNKNOWN').toUpperCase(),
    total: num(r.total),
    subtotal: num(r.subtotal),
    feeTotal: num(r.feeTotal),
    discount: num(r.discount),
    couponCode: str(r.couponCode),
    restaurantCount: num(r.restaurantCount),
    dropoffHostel: str(r.dropoffHostel),
    createdAt: str(r.createdAt),
    payOrderId: str(r.payOrderId),
    orders,
  };
};

/** Wording for the derived group status. */
export const groupStatusLabel = (status: string): string => (status === 'AWAITING_RESTAURANTS' ? 'Waiting for restaurants' : ORDER_STATUS_LABEL[status] ?? humanize(status));
