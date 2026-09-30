import React, { useMemo, useState } from 'react';
import { ChevronDown, ClipboardList, MapPin, Phone, SearchX, UserX } from 'lucide-react';
import { Order, OrderStatus, PaymentStatus } from '../types';
import { ORDER_STATUS_LABEL, inr, timeAgo } from '../lib/tokens';
import { Avatar } from './ui/Avatar';
import { EmptyState } from './ui/EmptyState';
import { Skeleton } from './ui/Skeleton';
import { StatusPill } from './ui/StatusPill';

interface OrdersTableProps {
  orders: Order[];
  onStatusChange: (orderId: string, status: OrderStatus, otpCode?: string) => void;
  loading?: boolean;
  /** Global search text from the header. */
  query?: string;
  onClearQuery?: () => void;
}

const NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  PLACED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['ARRIVED_AT_GATE', 'CANCELLED'],
  ARRIVED_AT_GATE: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

const FILTERS: Array<{ id: 'ALL' | OrderStatus; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'PLACED', label: 'Placed' },
  { id: 'ACCEPTED', label: 'Accepted' },
  { id: 'PREPARING', label: 'Preparing' },
  { id: 'READY_FOR_PICKUP', label: 'Ready' },
  { id: 'PICKED_UP', label: 'On the way' },
  { id: 'ARRIVED_AT_GATE', label: 'At gate' },
  { id: 'DELIVERED', label: 'Delivered' },
  { id: 'CANCELLED', label: 'Cancelled' },
];

const PAYMENT_STYLE: Record<PaymentStatus, string> = {
  PAID: 'bg-kraveo-g400/15 text-kraveo-g300',
  PENDING: 'bg-kraveo-status-placed/15 text-kraveo-status-placed',
  FAILED: 'bg-kraveo-danger/15 text-kraveo-danger',
  REFUNDED: 'bg-kraveo-status-pickedUp/15 text-kraveo-status-pickedUp',
};

const shortId = (id: string): string => (id.length > 9 ? `#${id.slice(-6).toUpperCase()}` : `#${id}`);

const PaymentBadge: React.FC<{ status: PaymentStatus }> = ({ status }) => (
  <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold capitalize ${PAYMENT_STYLE[status] ?? 'bg-kraveo-surface2 text-kraveo-ink2'}`}>{String(status).toLowerCase()}</span>
);

interface ActionsProps {
  order: Order;
  otp: string;
  onOtpChange: (value: string) => void;
  onStatusChange: OrdersTableProps['onStatusChange'];
  stacked?: boolean;
}

const OrderActions: React.FC<ActionsProps> = ({ order, otp, onOtpChange, onStatusChange, stacked }) => {
  const options = NEXT_STATUSES[order.status] ?? [];
  const terminal = options.length === 0;
  return (
    <div className={`flex gap-2 ${stacked ? 'flex-col' : 'flex-col items-end'}`} data-no-row-click>
      {order.status === 'ARRIVED_AT_GATE' && (
        <input
          aria-label={`Gate OTP for order ${shortId(order.id)}`}
          value={otp}
          onChange={(e) => onOtpChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="Gate OTP"
          inputMode="numeric"
          autoComplete="one-time-code"
          className={`k-input !min-h-[40px] text-center font-mono tracking-[0.4em] ${stacked ? '' : 'w-32'}`}
        />
      )}
      <select
        aria-label={`Change status for order ${shortId(order.id)}`}
        value={order.status}
        disabled={terminal}
        onChange={(e) => onStatusChange(order.id, e.target.value as OrderStatus, otp || undefined)}
        className={`k-select !min-h-[40px] text-xs font-bold ${stacked ? '' : 'w-44'}`}
      >
        <option value={order.status}>{ORDER_STATUS_LABEL[order.status] ?? order.status}</option>
        {options.map((next) => <option key={next} value={next}>{next === 'CANCELLED' ? 'Cancel order' : `Move to ${ORDER_STATUS_LABEL[next] ?? next}`}</option>)}
      </select>
    </div>
  );
};

const OrderDetails: React.FC<{ order: Order }> = ({ order }) => (
  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
    <div className="k-inset p-4">
      <p className="k-label mb-2">Items ({order.itemsCount})</p>
      {order.items.length === 0
        ? <p className="text-sm text-kraveo-ink3">No line items in the feed.</p>
        : (
          <ul className="space-y-1.5 text-sm">
            {order.items.map((item, index) => (
              <li key={item.id ?? `${item.name}-${index}`} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-kraveo-ink"><span className="font-bold tabular-nums text-kraveo-g300">{item.quantity}×</span> {item.name}</span>
                <span className="shrink-0 tabular-nums text-kraveo-ink2">{inr(item.price * item.quantity)}</span>
              </li>
            ))}
          </ul>
        )}
      <div className="mt-3 flex items-center justify-between border-t border-kraveo-line pt-2 text-xs text-kraveo-ink2">
        <span>Delivery fee</span><span className="tabular-nums">{inr(order.deliveryFee)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between text-sm font-bold text-kraveo-ink">
        <span>Total</span><span className="k-num">{inr(order.totalAmount)}</span>
      </div>
    </div>
    <div className="k-inset p-4 text-sm">
      <p className="k-label mb-2">Drop-off</p>
      <p className="flex items-center gap-1.5 font-bold text-kraveo-ink"><MapPin className="h-3.5 w-3.5 text-kraveo-g400" aria-hidden="true" />{order.dropoffHostel}</p>
      <p className="mt-2 text-kraveo-ink2">{order.dropoffNotes ? order.dropoffNotes : <span className="text-kraveo-ink3">No drop-off notes.</span>}</p>
      <p className="k-label mb-1 mt-4">Student</p>
      <p className="font-bold text-kraveo-ink">{order.customerName}</p>
      {order.customerPhone
        ? <a href={`tel:${order.customerPhone}`} className="mt-1 inline-flex items-center gap-1.5 text-kraveo-g300 hover:underline"><Phone className="h-3.5 w-3.5" aria-hidden="true" />{order.customerPhone}</a>
        : <p className="text-kraveo-ink3">No phone on file.</p>}
    </div>
    <div className="k-inset p-4 text-sm sm:col-span-2 xl:col-span-1">
      <p className="k-label mb-2">Runner and timing</p>
      {order.driverName
        ? <p className="font-bold text-kraveo-ink">{order.driverName}</p>
        : <p className="text-kraveo-ink3">No runner assigned yet.</p>}
      {order.driverPhone && <a href={`tel:${order.driverPhone}`} className="mt-1 inline-flex items-center gap-1.5 text-kraveo-g300 hover:underline"><Phone className="h-3.5 w-3.5" aria-hidden="true" />{order.driverPhone}</a>}
      <dl className="mt-4 space-y-1 text-xs text-kraveo-ink2">
        <div className="flex justify-between gap-3"><dt>Placed</dt><dd className="text-right text-kraveo-ink">{new Date(order.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd></div>
        {order.updatedAt && <div className="flex justify-between gap-3"><dt>Last update</dt><dd className="text-right text-kraveo-ink">{new Date(order.updatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd></div>}
        <div className="flex justify-between gap-3"><dt>Order ID</dt><dd className="break-all text-right font-mono text-kraveo-ink">{order.id}</dd></div>
      </dl>
    </div>
  </div>
);

const RunnerCell: React.FC<{ name?: string }> = ({ name }) => name
  ? <span className="flex items-center gap-2"><Avatar name={name} size="sm" /><span className="truncate font-bold text-kraveo-ink">{name}</span></span>
  : <span className="inline-flex items-center gap-1.5 rounded-full bg-kraveo-status-placed/15 px-2.5 py-1 text-[11px] font-bold text-kraveo-status-placed"><UserX className="h-3 w-3" aria-hidden="true" />Unassigned</span>;

export const OrdersTable: React.FC<OrdersTableProps> = ({ orders, onStatusChange, loading = false, query = '', onClearQuery }) => {
  const [statusFilter, setStatusFilter] = useState<'ALL' | OrderStatus>('ALL');
  const [otpByOrder, setOtpByOrder] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const counts = useMemo(() => {
    const map: Record<string, number> = { ALL: orders.length };
    orders.forEach((order) => { map[order.status] = (map[order.status] ?? 0) + 1; });
    return map;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      const matchesSearch = !q || [o.id, o.customerName, o.vendorName, o.dropoffHostel, o.driverName]
        .some((value) => Boolean(value) && String(value).toLowerCase().includes(q));
      return matchesSearch && (statusFilter === 'ALL' || o.status === statusFilter);
    });
  }, [orders, query, statusFilter]);

  const setOtp = (orderId: string) => (value: string) => setOtpByOrder((current) => ({ ...current, [orderId]: value }));
  const toggle = (orderId: string) => setExpanded((current) => (current === orderId ? null : orderId));
  const initialLoad = loading && orders.length === 0;
  const isFiltered = statusFilter !== 'ALL' || query.trim().length > 0;

  const emptyState = orders.length === 0
    ? <EmptyState icon={ClipboardList} title="No orders yet" description="Orders placed by students show up here in real time." />
    : (
      <EmptyState
        icon={SearchX}
        title="No orders match"
        description="Nothing matches the current filter and search."
        action={<button className="k-btn-ghost" onClick={() => { setStatusFilter('ALL'); onClearQuery?.(); }}>Clear filters</button>}
      />
    );

  return (
    <div className="space-y-4">
      {/* Filter chips */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0" role="group" aria-label="Filter by status">
        {FILTERS.map((filter) => {
          const active = statusFilter === filter.id;
          const count = counts[filter.id] ?? 0;
          return (
            <button key={filter.id} className="k-chip" aria-pressed={active} onClick={() => setStatusFilter(filter.id)}>
              {filter.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${active ? 'bg-kraveo-g400/25' : 'bg-kraveo-line/70'}`}>{count}</span>
            </button>
          );
        })}
      </div>

      <p className="px-1 text-xs text-kraveo-ink3" aria-live="polite">
        Showing <span className="font-bold text-kraveo-ink">{filteredOrders.length}</span> of {orders.length} orders{isFiltered ? ' (filtered)' : ''}
      </p>

      {/* Desktop table */}
      <div className="k-card hidden max-h-[calc(100vh-15rem)] overflow-auto md:block">
        <table className="w-full min-w-[980px] border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr>
              {['Order', 'Student and drop-off', 'Vendor', 'Runner', 'Amount', 'Payment', 'Status'].map((heading) => (
                <th key={heading} scope="col" className="k-label sticky top-0 z-10 border-b border-kraveo-line bg-kraveo-surface px-4 py-3.5 first:rounded-tl-k-xl">{heading}</th>
              ))}
              <th scope="col" className="k-label sticky top-0 z-10 border-b border-kraveo-line bg-kraveo-surface px-4 py-3.5 text-right last:rounded-tr-k-xl">Update status</th>
            </tr>
          </thead>
          <tbody>
            {initialLoad && Array.from({ length: 6 }).map((_, index) => (
              <tr key={index}><td colSpan={8} className="border-b border-kraveo-line/60 px-4 py-3"><Skeleton className="h-10 w-full" /></td></tr>
            ))}
            {!initialLoad && filteredOrders.length === 0 && <tr><td colSpan={8}>{emptyState}</td></tr>}
            {filteredOrders.map((order, index) => {
              const isOpen = expanded === order.id;
              return (
                <React.Fragment key={order.id}>
                  <tr
                    className={`k-reveal group cursor-pointer transition-colors hover:bg-kraveo-surface2/60 ${isOpen ? 'bg-kraveo-surface2/60' : ''}`}
                    style={{ ['--i' as string]: Math.min(index, 12) }}
                    onClick={(event) => { if (!(event.target as HTMLElement).closest('[data-no-row-click]')) toggle(order.id); }}
                  >
                    <td className="border-b border-kraveo-line/60 px-4 py-3.5 align-middle">
                      <button
                        aria-expanded={isOpen}
                        aria-controls={`order-details-${order.id}`}
                        aria-label={`${isOpen ? 'Hide' : 'Show'} details for order ${shortId(order.id)}`}
                        onClick={(event) => { event.stopPropagation(); toggle(order.id); }}
                        className="flex items-center gap-2 rounded-lg text-left"
                      >
                        <ChevronDown className={`h-4 w-4 shrink-0 text-kraveo-ink3 transition-transform duration-base ease-emphasized ${isOpen ? 'rotate-180 text-kraveo-g400' : ''}`} aria-hidden="true" />
                        <span>
                          <span className="block font-mono text-xs font-bold text-kraveo-ink" title={order.id}>{shortId(order.id)}</span>
                          <span className="block text-[11px] text-kraveo-ink3">{timeAgo(order.createdAt)}</span>
                        </span>
                      </button>
                    </td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3.5 align-middle">
                      <div className="font-bold text-kraveo-ink">{order.customerName}</div>
                      <div className="flex items-center gap-1 text-xs text-kraveo-ink2"><MapPin className="h-3 w-3 text-kraveo-ink3" aria-hidden="true" />{order.dropoffHostel}</div>
                    </td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3.5 align-middle font-semibold text-kraveo-ink2">{order.vendorName}</td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3.5 align-middle"><RunnerCell name={order.driverName} /></td>
                    <td className="k-num border-b border-kraveo-line/60 px-4 py-3.5 align-middle text-base text-kraveo-ink">{inr(order.totalAmount)}</td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3.5 align-middle"><PaymentBadge status={order.paymentStatus} /></td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3.5 align-middle"><StatusPill status={order.status} compact /></td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3.5 align-middle text-right">
                      <OrderActions order={order} otp={otpByOrder[order.id] || ''} onOtpChange={setOtp(order.id)} onStatusChange={onStatusChange} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr id={`order-details-${order.id}`}>
                      <td colSpan={8} className="animate-fade-in border-b border-kraveo-line/60 bg-kraveo-night/40 px-4 py-4"><OrderDetails order={order} /></td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {initialLoad && Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-40 w-full !rounded-k-xl" />)}
        {!initialLoad && filteredOrders.length === 0 && <div className="k-card">{emptyState}</div>}
        {filteredOrders.map((order, index) => {
          const isOpen = expanded === order.id;
          return (
            <article key={order.id} className="k-card k-reveal p-4" style={{ ['--i' as string]: Math.min(index, 10) }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-bold text-kraveo-ink" title={order.id}>{shortId(order.id)} <span className="font-sans font-medium text-kraveo-ink3">· {timeAgo(order.createdAt)}</span></p>
                  <p className="mt-1 truncate font-bold text-kraveo-ink">{order.customerName}</p>
                  <p className="flex items-center gap-1 text-xs text-kraveo-ink2"><MapPin className="h-3 w-3 text-kraveo-ink3" aria-hidden="true" /><span className="truncate">{order.dropoffHostel}</span></p>
                </div>
                <StatusPill status={order.status} compact />
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-kraveo-ink2">{order.vendorName}</span>
                <span className="k-num shrink-0 text-lg text-kraveo-ink">{inr(order.totalAmount)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <RunnerCell name={order.driverName} />
                <PaymentBadge status={order.paymentStatus} />
              </div>
              <div className="mt-3"><OrderActions order={order} otp={otpByOrder[order.id] || ''} onOtpChange={setOtp(order.id)} onStatusChange={onStatusChange} stacked /></div>
              <button
                aria-expanded={isOpen}
                aria-controls={`order-details-m-${order.id}`}
                onClick={() => toggle(order.id)}
                className="mt-3 flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-k-sm text-xs font-bold text-kraveo-g300 hover:bg-kraveo-surface2"
              >
                {isOpen ? 'Hide details' : 'Show details'}<ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
              {isOpen && <div id={`order-details-m-${order.id}`} className="mt-2 animate-fade-in"><OrderDetails order={order} /></div>}
            </article>
          );
        })}
      </div>
    </div>
  );
};
