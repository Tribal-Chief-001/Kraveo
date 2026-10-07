import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Layers, Loader2, RefreshCw } from 'lucide-react';
import { Order } from '../types';
import { GroupView, groupStatusLabel } from '../lib/groupView';
import { OrderGroupInfo } from '../lib/orderGroups';
import { inr } from '../lib/tokens';
import { StatusPill } from './ui/StatusPill';
import { PaymentPill } from './ui/OrderBadges';
import { GroupBadge } from './ui/GroupBadge';
import { shortId } from './OrderControls';

export type GroupFetcher = (groupId: string, signal?: AbortSignal) => Promise<GroupView>;

export type GroupState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; group: GroupView };

/** How often an open drawer re-reads the group, so a sibling's status stays current (the order feed only updates the order itself). */
const REFRESH_MS = 20_000;

/**
 * Loads GET /api/order-groups/:id when a combined order is opened. Lazy: nothing is fetched for a single order.
 * Re-reads when `refreshKey` changes (e.g. the order's updatedAt) and on a slow timer; a failed silent re-read keeps the data already shown.
 */
export const useOrderGroup = (fetchGroup: GroupFetcher, groupId: string | undefined, refreshKey?: string): { state: GroupState; reload: () => void } => {
  const [state, setState] = useState<GroupState>({ status: groupId ? 'loading' : 'idle' });
  const [attempt, setAttempt] = useState(0);
  const loadedFor = useRef<string | undefined>(undefined);
  const fetchRef = useRef(fetchGroup);
  fetchRef.current = fetchGroup;

  useEffect(() => {
    if (!groupId) { loadedFor.current = undefined; setState({ status: 'idle' }); return undefined; }
    const controller = new AbortController();
    let alive = true;
    const run = (silent: boolean) => {
      // Only show the spinner when there is nothing for this group yet.
      if (!silent && loadedFor.current !== groupId) setState({ status: 'loading' });
      fetchRef.current(groupId, controller.signal)
        .then((group) => { if (alive) { loadedFor.current = groupId; setState({ status: 'ready', group }); } })
        .catch((error) => {
          if (!alive || controller.signal.aborted) return;
          // A silent re-read that fails keeps the numbers already on screen.
          if (silent && loadedFor.current === groupId) return;
          setState({ status: 'error', message: error instanceof Error ? error.message : 'The combined order could not be loaded.' });
        });
    };
    run(false);
    const timer = window.setInterval(() => run(true), REFRESH_MS);
    return () => { alive = false; controller.abort(); window.clearInterval(timer); };
  }, [groupId, refreshKey, attempt]);

  const reload = useCallback(() => { loadedFor.current = undefined; setAttempt((n) => n + 1); }, []);
  return { state, reload };
};

interface Row {
  orderId: string;
  index: number;
  vendorName: string;
  status: string;
  itemCount: number | null;
  /** Only known once the group has loaded (the order's own share of the group total). */
  share: number | null;
}

/** Sibling rows: the freshly loaded orders when we have them, otherwise the stops that came with the order. */
const rowsFor = (group: OrderGroupInfo, state: GroupState): Row[] => {
  const stops: Row[] = group.stops.map((stop) => ({ orderId: stop.orderId, index: stop.index, vendorName: stop.vendorName, status: stop.status, itemCount: stop.itemCount, share: null }));
  if (state.status !== 'ready' || state.group.orders.length === 0) return stops;
  const fresh = new Map<string, Order>(state.group.orders.map((o) => [o.id, o]));
  const merged = stops.map((row) => {
    const o = fresh.get(row.orderId);
    return o ? { ...row, status: o.status, vendorName: o.vendorName || row.vendorName, itemCount: o.itemsCount || row.itemCount, share: Number.isFinite(o.totalAmount) ? o.totalAmount : null } : row;
  });
  // An order the stops did not list (should not happen) is still shown.
  state.group.orders.forEach((o) => {
    if (!merged.some((row) => row.orderId === o.id)) merged.push({ orderId: o.id, index: o.group?.index ?? merged.length, vendorName: o.vendorName, status: o.status, itemCount: o.itemsCount, share: o.totalAmount });
  });
  return merged.sort((a, b) => a.index - b.index);
};

const Money: React.FC<{ label: string; value: number | null | undefined; negative?: boolean; strong?: boolean }> = ({ label, value, negative, strong }) => (
  <div className={`flex justify-between gap-3 ${strong ? 'pt-1 text-sm font-bold text-kraveo-ink' : ''}`}>
    <dt>{label}</dt>
    <dd className="tabular-nums">{value === null || value === undefined ? 'Not available' : `${negative && value ? '−' : ''}${inr(value)}`}</dd>
  </div>
);

/**
 * Drawer section for a combined order: the restaurants (status, link to open each order) and the group total.
 * Group numbers come only from the server's GroupView; while loading or after an error nothing is invented.
 */
export const OrderGroupPanel: React.FC<{ order: Order; state: GroupState; onReload: () => void; onOpenOrder?: (orderId: string) => void }> = ({ order, state, onReload, onOpenOrder }) => {
  const group = order.group;
  if (!group) return null;
  // A group loaded for another order (the drawer just switched to a sibling of a different group) is not this one's data.
  if (state.status === 'ready' && state.group.id !== group.id) state = { status: 'loading' };
  const rows = rowsFor(group, state);
  const view = state.status === 'ready' ? state.group : null;
  return (
    <section className="k-inset p-4" aria-label="Combined order" data-testid="group-panel">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="k-label flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" aria-hidden="true" />Combined order</h3>
        <GroupBadge group={group} />
      </div>
      <p className="mb-3 text-xs text-kraveo-ink2">
        The customer ordered from {group.size} restaurants in one checkout: one payment, one rider, one gate code. If one restaurant cannot take its part, the whole order is cancelled and refunded.
        This is order {group.index + 1} of {group.size}{group.primary ? ' (it carries the payment)' : ''}.
      </p>

      <ul className="divide-y divide-kraveo-line" aria-label="Restaurants in this combined order">
        {rows.map((row) => {
          const current = row.orderId === order.id;
          return (
            <li key={row.orderId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2" aria-current={current ? 'true' : undefined}>
              <div className="min-w-0 flex-1 basis-40">
                <p className="break-words text-sm font-bold text-kraveo-ink [overflow-wrap:anywhere]">
                  <span className="mr-1.5 inline-block min-w-[1.25rem] text-kraveo-ink3 tabular-nums">{row.index + 1}.</span>{row.vendorName}
                  {current && <span className="ml-2 rounded-full bg-kraveo-g400/15 px-2 py-0.5 text-[10px] font-bold text-kraveo-g300">This order</span>}
                </p>
                <p className="text-[11px] text-kraveo-ink3">
                  <span className="font-mono">{shortId(row.orderId)}</span>
                  {row.itemCount ? ` · ${row.itemCount} item${row.itemCount === 1 ? '' : 's'}` : ''}
                  {row.share !== null ? ` · share ${inr(row.share)}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={row.status} compact />
                {!current && onOpenOrder && (
                  <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onOpenOrder(row.orderId)} aria-label={`Open order ${shortId(row.orderId)} from ${row.vendorName}`}>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 border-t border-kraveo-line pt-3" aria-live="polite">
        {(state.status === 'loading' || state.status === 'idle') && (
          <div role="status" aria-label="Loading combined order totals" className="flex items-center gap-2 text-xs text-kraveo-ink3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading the total for the whole combined order…
          </div>
        )}
        {state.status === 'error' && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-xs text-kraveo-ink">
            <span className="min-w-0 break-words">The group total could not be loaded: {state.message}</span>
            <button type="button" className="k-btn-ghost !min-h-[32px] shrink-0 !px-3 text-xs" onClick={onReload}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Try again</button>
          </div>
        )}
        {view && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-kraveo-ink2">Whole order:</span>
              <StatusPill status={view.status} label={groupStatusLabel(view.status)} compact />
              <PaymentPill status={view.paymentStatus} />
            </div>
            <dl className="space-y-1 text-xs text-kraveo-ink2" aria-label="Combined order total">
              <Money label="Food (all restaurants)" value={view.subtotal} />
              <Money label="Fees (delivery and extra restaurants)" value={view.feeTotal} />
              {view.discount ? <Money label={`Discount${view.couponCode ? ` (${view.couponCode})` : ''}`} value={view.discount} negative /> : null}
              <Money label="Group total paid by the customer" value={view.total} strong />
            </dl>
            {view.payOrderId && view.payOrderId !== order.id && (
              <p className="mt-2 text-[11px] text-kraveo-ink3">The single payment is recorded on order <span className="font-mono">{shortId(view.payOrderId)}</span>.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
};

