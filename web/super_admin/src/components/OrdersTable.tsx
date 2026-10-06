import React, { useMemo, useState } from 'react';
import { ChevronRight, ClipboardList, Loader2, MapPin, SearchX, TriangleAlert, UserX } from 'lucide-react';
import { Order, OrderStatus } from '../types';
import { inr, timeAgo } from '../lib/tokens';
import { cancelledByLabel, isCriticalFlag, isTerminal, isUnpaidOpen, orderFlags } from '../lib/orders';
import { Avatar } from './ui/Avatar';
import { EmptyState } from './ui/EmptyState';
import { Skeleton } from './ui/Skeleton';
import { StatusPill } from './ui/StatusPill';
import { OtpLockedPill, PaymentPill, RefundPill, TonePill } from './ui/OrderBadges';
import { AdvanceHandler, NextStepControl, shortId } from './OrderControls';

interface OrdersTableProps {
  orders: Order[];
  /** Order ids the server (or the local fallback) lists under "Needs attention". */
  attentionIds: Set<string>;
  onAdvance: AdvanceHandler;
  onOpenOrder: (orderId: string) => void;
  loading?: boolean;
  /** Global search text from the header. */
  query?: string;
  onClearQuery?: () => void;
  /** Clock from the app (ticks every 30 s) so time-based flags such as "not accepted" appear without a reload. */
  now: number;
  /** The server has orders older than the loaded ones. */
  hasMore?: boolean;
  loadingOlder?: boolean;
  /** Fetches the next older page. */
  onLoadOlder?: () => void;
}

type Filter = 'ALL' | 'ATTENTION' | 'UNPAID' | OrderStatus;

const FILTERS: Array<{ id: Filter; label: string; hint?: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'ATTENTION', label: 'Needs attention', hint: 'Failed refunds, locked OTPs, payment problems and stuck orders' },
  { id: 'UNPAID', label: 'Unpaid', hint: 'Open orders the customer has not paid yet (hidden from restaurants and riders)' },
  { id: 'PLACED', label: 'Placed' },
  { id: 'ACCEPTED', label: 'Accepted' },
  { id: 'PREPARING', label: 'Preparing' },
  { id: 'READY_FOR_PICKUP', label: 'Ready' },
  { id: 'PICKED_UP', label: 'On the way' },
  { id: 'ARRIVED_AT_GATE', label: 'At gate' },
  { id: 'DELIVERED', label: 'Delivered' },
  { id: 'CANCELLED', label: 'Cancelled' },
];

const RunnerCell: React.FC<{ name?: string; unpaid: boolean; finished?: boolean }> = ({ name, unpaid, finished }) => (!name && finished)
  ? <span className="text-xs text-kraveo-ink3">No rider</span>
  : name
  ? <span className="flex min-w-0 items-center gap-2"><Avatar name={name} size="sm" /><span className="truncate font-bold text-kraveo-ink">{name}</span></span>
  : <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${unpaid ? 'bg-kraveo-surface2 text-kraveo-ink3' : 'bg-kraveo-status-placed/15 text-kraveo-status-placed'}`}><UserX className="h-3 w-3" aria-hidden="true" />{unpaid ? 'Not offered yet' : 'Unassigned'}</span>;

/** Status pill plus the "why" for cancelled orders and any problem badges. */
const StatusCell: React.FC<{ order: Order; now: number; attention: boolean }> = ({ order, now, attention }) => {
  const flags = orderFlags(order, now).filter((f) => f.code !== 'OTP_LOCKED' && f.code !== 'REFUND_FAILED' && f.code !== 'REFUND_PENDING');
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusPill status={order.status} compact />
      {order.status === 'CANCELLED' && (
        <p className="max-w-[10rem] truncate text-[11px] text-kraveo-ink3" title={order.cancelReason ?? undefined}>
          by <span className="font-bold text-kraveo-ink2">{cancelledByLabel(order.cancelledBy)}</span>{order.cancelReason ? ` · ${order.cancelReason}` : ''}
        </p>
      )}
      <OtpLockedPill order={order} />
      {flags.map((f) => <TonePill key={f.code} tone={f.tone}>{f.label}</TonePill>)}
      {attention && flags.length === 0 && !order.otpLocked && order.refundStatus !== 'FAILED' && <TonePill tone="warning" icon={TriangleAlert}>Needs attention</TonePill>}
    </div>
  );
};

const PaymentCell: React.FC<{ order: Order }> = ({ order }) => (
  <div className="flex flex-col items-start gap-1">
    <PaymentPill status={order.paymentStatus} />
    <RefundPill order={order} />
  </div>
);

export const OrdersTable: React.FC<OrdersTableProps> = ({ orders, attentionIds, onAdvance, onOpenOrder, loading = false, query = '', onClearQuery, now, hasMore = false, loadingOlder = false, onLoadOlder }) => {
  const [filter, setFilter] = useState<Filter>('ALL');

  const needsAttention = useMemo(() => {
    const ids = new Set(attentionIds);
    orders.forEach((order) => { if (orderFlags(order, now).some(isCriticalFlag)) ids.add(order.id); });
    return ids;
  }, [orders, attentionIds, now]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { ALL: orders.length, ATTENTION: 0, UNPAID: 0 };
    orders.forEach((order) => {
      map[order.status] = (map[order.status] ?? 0) + 1;
      if (isUnpaidOpen(order)) map.UNPAID += 1;
      if (needsAttention.has(order.id)) map.ATTENTION += 1;
    });
    return map;
  }, [orders, needsAttention]);

  const filteredOrders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      const matchesSearch = !q || [o.id, o.customerName, o.customerPhone, o.vendorName, o.dropoffHostel, o.driverName, o.razorpayPaymentId, o.razorpayOrderId, o.cancelReason]
        .some((value) => Boolean(value) && String(value).toLowerCase().includes(q));
      if (!matchesSearch) return false;
      if (filter === 'ALL') return true;
      if (filter === 'ATTENTION') return needsAttention.has(o.id);
      if (filter === 'UNPAID') return isUnpaidOpen(o);
      return o.status === filter;
    });
  }, [orders, query, filter, needsAttention]);

  const initialLoad = loading && orders.length === 0;
  const isFiltered = filter !== 'ALL' || query.trim().length > 0;
  const open = (event: React.MouseEvent, id: string) => {
    if (!(event.target as HTMLElement).closest('[data-no-row-click]')) onOpenOrder(id);
  };

  const emptyState = orders.length === 0
    ? <EmptyState icon={ClipboardList} title="No orders yet" description="Orders placed by students show up here in real time." />
    : (
      <EmptyState
        icon={SearchX}
        title={filter === 'ATTENTION' && !query.trim() ? 'Nothing needs attention' : 'No orders match'}
        description={filter === 'ATTENTION' && !query.trim() ? 'No loaded order has a known problem right now.' : 'Nothing matches the current filter and search.'}
        action={<button className="k-btn-ghost" onClick={() => { setFilter('ALL'); onClearQuery?.(); }}>Clear filters</button>}
      />
    );

  return (
    <div className="space-y-4">
      {/* Filter chips */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0" role="group" aria-label="Filter orders">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          const count = counts[f.id] ?? 0;
          const alert = f.id === 'ATTENTION' && count > 0;
          return (
            <button key={f.id} className={`k-chip ${alert && !active ? '!border-kraveo-danger/40 !text-kraveo-danger' : ''}`} aria-pressed={active} title={f.hint} onClick={() => setFilter(f.id)}>
              {f.id === 'ATTENTION' && <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />}
              {f.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${active ? 'bg-kraveo-g400/25' : alert ? 'bg-kraveo-danger/20' : 'bg-kraveo-line/70'}`}>{count}</span>
            </button>
          );
        })}
      </div>

      <p className="px-1 text-xs text-kraveo-ink3" aria-live="polite">
        Showing <span className="font-bold text-kraveo-ink">{filteredOrders.length}</span> of {orders.length} loaded orders{isFiltered ? ' (filtered)' : ''}{hasMore ? ', newest first. Older orders are not loaded yet' : ''}. Select an order for details and admin actions.
      </p>

      {/* Desktop table (1280 px and up) */}
      <div className="k-card hidden max-h-[calc(100vh-15rem)] overflow-auto xl:block">
        <table className="w-full min-w-[1000px] border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr>
              {['Order', 'Student and drop-off', 'Restaurant', 'Rider', 'Amount', 'Payment', 'Status'].map((heading) => (
                <th key={heading} scope="col" className="k-label sticky top-0 z-10 border-b border-kraveo-line bg-kraveo-surface px-4 py-3.5 first:rounded-tl-k-xl">{heading}</th>
              ))}
              <th scope="col" className="k-label sticky top-0 z-10 border-b border-kraveo-line bg-kraveo-surface px-4 py-3.5 text-right last:rounded-tr-k-xl">Next step</th>
            </tr>
          </thead>
          <tbody>
            {initialLoad && Array.from({ length: 6 }).map((_, index) => (
              <tr key={index}><td colSpan={8} className="border-b border-kraveo-line/60 px-4 py-3"><Skeleton className="h-10 w-full" /></td></tr>
            ))}
            {!initialLoad && filteredOrders.length === 0 && <tr><td colSpan={8}>{emptyState}</td></tr>}
            {filteredOrders.map((order, index) => {
              const attention = needsAttention.has(order.id);
              const cell = 'border-b border-kraveo-line/60 px-4 py-3.5 align-top';
              return (
                <tr
                  key={order.id}
                  className={`k-reveal group cursor-pointer transition-colors hover:bg-kraveo-surface2/60 ${attention ? 'bg-kraveo-danger/[0.04]' : ''}`}
                  style={{ ['--i' as string]: Math.min(index, 12) }}
                  onClick={(event) => open(event, order.id)}
                >
                  <td className={cell}>
                    <button
                      aria-haspopup="dialog"
                      aria-label={`Open order ${shortId(order.id)}`}
                      onClick={(event) => { event.stopPropagation(); onOpenOrder(order.id); }}
                      className="flex items-center gap-2 rounded-lg text-left"
                    >
                      {attention ? <TriangleAlert className="h-4 w-4 shrink-0 text-kraveo-danger" aria-label="Needs attention" /> : <ChevronRight className="h-4 w-4 shrink-0 text-kraveo-ink3 group-hover:text-kraveo-g400" aria-hidden="true" />}
                      <span>
                        <span className="block font-mono text-xs font-bold text-kraveo-ink" title={order.id}>{shortId(order.id)}</span>
                        <span className="block text-[11px] text-kraveo-ink3">{timeAgo(order.createdAt)}</span>
                      </span>
                    </button>
                  </td>
                  <td className={`${cell} min-w-[10rem] max-w-[18rem]`}>
                    <div className="font-bold text-kraveo-ink [overflow-wrap:anywhere]">{order.customerName}</div>
                    <div className="flex items-center gap-1 text-xs text-kraveo-ink2 [overflow-wrap:anywhere]"><MapPin className="h-3 w-3 shrink-0 text-kraveo-ink3" aria-hidden="true" />{order.dropoffHostel}</div>
                  </td>
                  <td className={`${cell} font-semibold text-kraveo-ink2 [overflow-wrap:anywhere]`}>{order.vendorName}</td>
                  <td className={cell}><RunnerCell name={order.driverName} unpaid={order.paymentStatus !== 'PAID'} finished={isTerminal(order.status)} /></td>
                  <td className={`k-num ${cell} text-base text-kraveo-ink`}>{inr(order.totalAmount)}</td>
                  <td className={cell}><PaymentCell order={order} /></td>
                  <td className={cell}><StatusCell order={order} now={now} attention={attention} /></td>
                  <td className={`${cell} text-right`}>
                    <NextStepControl order={order} onAdvance={onAdvance} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Cards below 1280 px */}
      <div className="grid items-start gap-3 md:grid-cols-2 xl:hidden">
        {initialLoad && Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-40 w-full !rounded-k-xl" />)}
        {!initialLoad && filteredOrders.length === 0 && <div className="k-card md:col-span-2">{emptyState}</div>}
        {filteredOrders.map((order, index) => {
          const attention = needsAttention.has(order.id);
          return (
            <article key={order.id} className={`k-card k-reveal min-w-0 p-4 ${attention ? '!border-kraveo-danger/40' : ''}`} style={{ ['--i' as string]: Math.min(index, 10) }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-bold text-kraveo-ink" title={order.id}>{shortId(order.id)} <span className="font-sans font-medium text-kraveo-ink3">· {timeAgo(order.createdAt)}</span></p>
                  <p className="mt-1 truncate font-bold text-kraveo-ink">{order.customerName}</p>
                  <p className="flex items-center gap-1 text-xs text-kraveo-ink2"><MapPin className="h-3 w-3 text-kraveo-ink3" aria-hidden="true" /><span className="truncate">{order.dropoffHostel}</span></p>
                </div>
                <StatusCell order={order} now={now} attention={attention} />
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-kraveo-ink2">{order.vendorName}</span>
                <span className="k-num shrink-0 text-lg text-kraveo-ink">{inr(order.totalAmount)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <RunnerCell name={order.driverName} unpaid={order.paymentStatus !== 'PAID'} finished={isTerminal(order.status)} />
                <div className="flex flex-wrap justify-end gap-1"><PaymentPill status={order.paymentStatus} /><RefundPill order={order} /></div>
              </div>
              <div className="mt-3"><NextStepControl order={order} onAdvance={onAdvance} stacked /></div>
              <button
                aria-haspopup="dialog"
                onClick={() => onOpenOrder(order.id)}
                className="mt-3 flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-k-sm text-xs font-bold text-kraveo-g300 hover:bg-kraveo-surface2"
              >
                {isTerminal(order.status) ? 'Details' : order.paymentStatus === 'PAID' ? 'Details, cancel and refund' : 'Details and cancel'}<ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </article>
          );
        })}
      </div>

      {hasMore && onLoadOlder && (
        <div className="flex justify-center pt-1">
          <button type="button" className="k-btn-ghost" onClick={onLoadOlder} disabled={loadingOlder} aria-busy={loadingOlder}>
            {loadingOlder ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Load older orders
          </button>
        </div>
      )}
    </div>
  );
};
