import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Clock, Coins, GraduationCap, Loader2, Mail, MapPin, Phone, Receipt, SearchX, ShoppingBag, UserX, Users, Wallet } from 'lucide-react';
import { CustomerDetail, CustomerOrder, CustomerRow } from '../types';
import { apiService } from '../services/api';
import { inr, timeAgo } from '../lib/tokens';
import { orderCode } from '../lib/orders';
import { CustomerState, CustomerStatusFilter, customerState } from '../lib/accountParse';
import { CustomerAction, CustomerActionDialogs } from './CustomerActions';
import { AnimatedNumber } from './ui/AnimatedNumber';
import { Avatar } from './ui/Avatar';
import { Drawer } from './ui/Drawer';
import { EmptyState } from './ui/EmptyState';
import { KpiTile } from './ui/KpiTile';
import { SkeletonCard } from './ui/Skeleton';
import { StatusPill } from './ui/StatusPill';

interface Props {
  /** The header search box. Sent to the server (debounced) so every customer is searchable, not just the loaded page. */
  query: string;
  onClearQuery: () => void;
  onAuthError: (error: unknown) => void;
  /** Opens an order in the order drawer (the blocking orders in the dialogs are links). */
  onOpenOrder?: (orderId: string) => void;
}

const STATUS_FILTERS: Array<{ id: CustomerStatusFilter; label: string }> = [
  { id: 'ACTIVE', label: 'Active' },
  { id: 'SUSPENDED', label: 'Suspended' },
  { id: 'REMOVED', label: 'Removed' },
  { id: 'ALL', label: 'All' },
];

const STATE_META: Record<CustomerState, { label: string; cls: string }> = {
  ACTIVE: { label: 'Active', cls: 'bg-kraveo-g400/15 text-kraveo-g300' },
  SUSPENDED: { label: 'Suspended', cls: 'bg-kraveo-status-placed/20 text-kraveo-status-placed' },
  REMOVED: { label: 'Removed', cls: 'bg-kraveo-danger/15 text-kraveo-danger' },
  DELETED: { label: 'Deleted by user', cls: 'bg-kraveo-surface2 text-kraveo-ink2' },
};

export const CustomerStatusChip: React.FC<{ customer: Pick<CustomerRow, 'accountStatus' | 'deleted'> }> = ({ customer }) => {
  const meta = STATE_META[customerState(customer)];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.cls}`}>{meta.label}</span>;
};

const EMPTY_BY_FILTER: Record<CustomerStatusFilter, { title: string; text: string }> = {
  ACTIVE: { title: 'No customers yet', text: 'Customers appear here after they sign in to the Kraveo app.' },
  SUSPENDED: { title: 'Nobody is suspended.', text: 'Suspended customers are listed here until you restore them.' },
  REMOVED: { title: 'Nobody has been removed.', text: 'Removed customers, and accounts customers deleted themselves, are listed here.' },
  ALL: { title: 'No customers yet', text: 'Customers appear here after they sign in to the Kraveo app.' },
};

const dateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const dateOnly = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const where = (c: Pick<CustomerRow, 'isStudent' | 'hostelBlock'>) => (c.isStudent === false ? 'Not a hosteller' : c.hostelBlock || '—');

const PAYMENT_TONE: Record<string, string> = {
  PAID: 'bg-kraveo-g400/15 text-kraveo-g300',
  PENDING: 'bg-kraveo-status-placed/15 text-kraveo-status-placed',
  FAILED: 'bg-kraveo-danger/15 text-kraveo-danger',
  REFUNDED: 'bg-kraveo-status-pickedUp/15 text-kraveo-status-pickedUp',
};
const PayPill: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${PAYMENT_TONE[status] ?? 'bg-kraveo-surface2 text-kraveo-ink2'}`}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>
);

const InfoRow: React.FC<{ icon: React.ElementType; label: string; children: React.ReactNode }> = ({ icon: Icon, label, children }) => (
  <div className="k-inset flex items-start gap-3 px-4 py-3">
    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-kraveo-ink3" aria-hidden="true" />
    <div className="min-w-0"><p className="k-label">{label}</p><div className="mt-0.5 break-words text-sm font-bold text-kraveo-ink">{children}</div></div>
  </div>
);

export const CustomersPanel: React.FC<Props> = ({ query, onClearQuery, onAuthError, onOpenOrder }) => {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<CustomerStatusFilter>('ACTIVE');
  const requestSeq = useRef(0);

  const loadFirst = useCallback(async (search: string, filter: CustomerStatusFilter) => {
    const seq = ++requestSeq.current;
    setLoading(true); setError('');
    try {
      const page = await apiService.fetchCustomers(search, null, { status: filter });
      if (seq !== requestSeq.current) return;
      setRows(page.data); setTotal(page.total); setCursor(page.nextCursor);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      onAuthError(e);
      setError(e instanceof Error ? e.message : 'Customers could not be loaded.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => {
    const timer = window.setTimeout(() => loadFirst(query, status), query ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [query, status, loadFirst]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await apiService.fetchCustomers(query, cursor, { status });
      // The filter or search changed while this page was loading: it belongs to a list that is gone.
      if (seq !== requestSeq.current) return;
      setRows((current) => [...current, ...page.data.filter((p) => !current.some((c) => c.id === p.id))]);
      setCursor(page.nextCursor);
    } catch (e) {
      onAuthError(e);
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : 'More customers could not be loaded.');
    } finally { setLoadingMore(false); }
  };

  const totalSpentLoaded = rows.reduce((sum, r) => sum + r.totalSpent, 0);
  const withOrders = rows.filter((r) => r.ordersCount > 0).length;
  const filtered = status !== 'ACTIVE' || query !== '';
  const emptyText = EMPTY_BY_FILTER[status];
  const initialLoad = loading && rows.length === 0;
  const empty = !loading && rows.length === 0;

  return (
    <div className="space-y-5">
      <section aria-label="Customer summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiTile index={0} loading={initialLoad} label={query ? 'Matching customers' : 'Customers'} icon={Users} value={<AnimatedNumber value={total} />} note={query ? `Searching “${query}”` : status === 'ALL' ? 'All accounts' : 'Signed in with Google'} />
        <KpiTile index={1} loading={initialLoad} label="Have ordered" icon={ShoppingBag} tone="text-kraveo-status-pickedUp" toneBg="bg-kraveo-status-pickedUp/15" value={<AnimatedNumber value={withOrders} />} note={`Of ${rows.length} shown`} />
        <KpiTile index={2} loading={initialLoad} label="Paid by these" icon={Wallet} tone="text-kraveo-status-ready" toneBg="bg-kraveo-status-ready/15" value={<AnimatedNumber value={totalSpentLoaded} prefix="₹" />} note="Paid orders, customers shown" />
        <KpiTile index={3} loading={initialLoad} label="Loaded" icon={Receipt} tone="text-kraveo-status-atGate" toneBg="bg-kraveo-status-atGate/15" value={<>{rows.length}<span className="text-xl text-kraveo-ink3"> / {total}</span></>} note={cursor ? 'More available below' : 'All loaded'} />
      </section>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0" role="group" aria-label="Filter by account status">
        {STATUS_FILTERS.map((f) => <button key={f.id} className="k-chip" aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>{f.label}</button>)}
      </div>

      {error && <div role="alert" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">{error}</div>}

      {empty && !error && (
        <div className="k-card">
          <EmptyState icon={query ? SearchX : Users} title={query ? 'No customers match' : emptyText.title} description={query ? 'Try a name, email, phone number or hostel block.' : emptyText.text}
            action={query ? <button className="k-btn-ghost" onClick={onClearQuery}>Clear search</button> : filtered ? <button className="k-btn-ghost" onClick={() => setStatus('ACTIVE')}>Show active customers</button> : undefined} />
        </div>
      )}
      {empty && error && <div className="k-card"><EmptyState icon={Users} title="Customers could not be loaded" description="Check the connection and try again." action={<button className="k-btn-ghost" onClick={() => void loadFirst(query, status)}>Try again</button>} /></div>}

      {/* Wide screens: a real table */}
      {rows.length > 0 && (
        <div className="k-card hidden max-h-[calc(100vh-22rem)] overflow-auto xl:block">
          <table className="w-full min-w-[1100px] border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr className="sticky top-0 z-10 bg-kraveo-surface text-[11px] uppercase tracking-wide text-kraveo-ink3">
                {['Customer', 'Status', 'Phone', 'Hostel', 'Orders', 'Paid', 'Last sign-in', 'Last order', 'Joined', ''].map((h) => <th key={h} scope="col" className="border-b border-kraveo-line px-4 py-3 font-bold">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} tabIndex={0} onClick={() => setSelectedId(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(c.id); }}
                  className="cursor-pointer outline-none transition-colors hover:bg-kraveo-surface2/60 focus-visible:bg-kraveo-surface2/60" aria-label={`Open ${c.name}`}>
                  <td className="border-b border-kraveo-line/60 px-4 py-3">
                    <div className="flex items-center gap-3"><Avatar name={c.name} size="sm" /><div className="min-w-0"><p className="truncate font-bold text-kraveo-ink">{c.name}</p><p className="truncate text-xs text-kraveo-ink3">{c.email ?? (c.deleted ? 'Deleted account' : 'No email')}</p></div></div>
                  </td>
                  <td className="border-b border-kraveo-line/60 px-4 py-3"><CustomerStatusChip customer={c} /></td>
                  <td className="border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{c.phone ?? '—'}</td>
                  <td className="border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{where(c)}</td>
                  <td className="k-num border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink">{c.ordersCount}{c.openOrders > 0 && <span className="ml-1.5 rounded-full bg-kraveo-status-placed/20 px-1.5 py-0.5 text-[10px] font-extrabold text-kraveo-status-placed" title="Orders in progress">{c.openOrders} open</span>}</td>
                  <td className="k-num border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink">{inr(c.totalSpent)}</td>
                  <td className="border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{c.lastLoginAt ? timeAgo(c.lastLoginAt) : 'Not recorded'}</td>
                  <td className="border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{c.lastOrderAt ? timeAgo(c.lastOrderAt) : 'Never'}</td>
                  <td className="border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{dateOnly(c.createdAt)}</td>
                  <td className="border-b border-kraveo-line/60 px-3 py-3"><ChevronRight className="h-4 w-4 text-kraveo-ink3" aria-hidden="true" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Narrower screens: cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:hidden">
        {initialLoad && Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} lines={2} />)}
        {rows.map((c, index) => (
          <div key={c.id} role="button" tabIndex={0} aria-label={`Open ${c.name}`} onClick={() => setSelectedId(c.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(c.id); } }}
            className="k-card k-card-hover k-reveal cursor-pointer p-4" style={{ ['--i' as string]: Math.min(index, 10) }}>
            <div className="flex items-center gap-3">
              <Avatar name={c.name} size="md" />
              <div className="min-w-0 flex-1"><p className="truncate font-bold text-kraveo-ink">{c.name}</p><p className="truncate text-xs text-kraveo-ink3">{c.email ?? c.phone ?? (c.deleted ? 'Deleted account' : '—')}</p></div>
              <ChevronRight className="h-4 w-4 shrink-0 text-kraveo-ink3" aria-hidden="true" />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5"><CustomerStatusChip customer={c} />{c.openOrders > 0 && <span className="rounded-full bg-kraveo-status-placed/20 px-2 py-1 text-[11px] font-bold text-kraveo-status-placed">{c.openOrders} order{c.openOrders === 1 ? '' : 's'} in progress</span>}</div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Orders</p><p className="k-num text-lg text-kraveo-ink">{c.ordersCount}</p></div>
              <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Paid</p><p className="k-num text-lg text-kraveo-ink">{inr(c.totalSpent)}</p></div>
              <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Last</p><p className="k-num text-sm leading-7 text-kraveo-ink">{c.lastOrderAt ? timeAgo(c.lastOrderAt) : 'Never'}</p></div>
            </div>
            <p className="mt-2 truncate text-xs text-kraveo-ink3">{where(c)} · Joined {dateOnly(c.createdAt)} · {c.lastLoginAt ? `Signed in ${timeAgo(c.lastLoginAt)}` : 'Sign-in not recorded'}</p>
          </div>
        ))}
      </div>

      {cursor && (
        <div className="flex justify-center pt-1">
          <button className="k-btn-ghost" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore}>
            {loadingMore ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</> : `Load more (${total - rows.length} left)`}
          </button>
        </div>
      )}

      <CustomerDrawer id={selectedId} onClose={() => setSelectedId(null)} onAuthError={onAuthError} onOpenOrder={onOpenOrder} onChanged={() => void loadFirst(query, status)} />
    </div>
  );
};

// ─────────────────────────── Detail drawer ───────────────────────────
const OrderBlock: React.FC<{ o: CustomerOrder }> = ({ o }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="k-inset">
      <button type="button" className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-kraveo-ink">{o.vendor?.name ?? 'Unknown restaurant'}</p>
          <p className="font-mono text-[11px] text-kraveo-ink3">{orderCode(o.id)} · {dateTime(o.createdAt)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5"><StatusPill status={o.status} compact /><PayPill status={o.paymentStatus} /></div>
        </div>
        <div className="shrink-0 text-right"><p className="k-num text-lg text-kraveo-ink">{inr(o.totalAmount)}</p><p className="text-[11px] text-kraveo-g300">{open ? 'Hide' : 'Details'}</p></div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-kraveo-line px-4 py-3 text-sm">
          <ul className="space-y-1">
            {o.items.length === 0 && <li className="text-kraveo-ink3">No items recorded.</li>}
            {o.items.map((i, n) => <li key={n} className="flex justify-between gap-3"><span className="min-w-0 truncate text-kraveo-ink2"><b className="text-kraveo-g300">{i.quantity}×</b> {i.name}</span><span className="tabular-nums text-kraveo-ink">{inr(i.price * i.quantity)}</span></li>)}
            <li className="flex justify-between text-kraveo-ink3"><span>Delivery</span><span className="tabular-nums">{inr(o.deliveryFee)}</span></li>
          </ul>
          <p className="flex items-start gap-1.5 text-kraveo-ink2"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-kraveo-ink3" aria-hidden="true" />{o.dropoffHostel}{o.dropoffNotes ? ` — ${o.dropoffNotes}` : ''}</p>
          {o.driver && <p className="text-kraveo-ink2">Rider: <b className="text-kraveo-ink">{o.driver.name}</b>{o.driver.phone ? <> · <a className="text-kraveo-g300 hover:underline" href={`tel:${o.driver.phone}`}>{o.driver.phone}</a></> : null}</p>}
          {o.payments.length > 0 && (
            <div className="rounded-k-sm bg-kraveo-night/60 p-2.5 font-mono text-[11px] text-kraveo-ink2">
              {o.payments.map((p) => <p key={p.id} className="break-all">{p.status} · {inr(p.amount)} · {p.razorpayPaymentId ?? 'no payment id yet'}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const CustomerDrawer: React.FC<{ id: string | null; onClose: () => void; onAuthError: (e: unknown) => void; onOpenOrder?: (orderId: string) => void; onChanged: () => void }> = ({ id, onClose, onAuthError, onOpenOrder, onChanged }) => {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState<CustomerAction | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback((customerId: string) => {
    const seq = ++loadSeq.current;
    setError(''); setLoading(true);
    apiService.fetchCustomer(customerId)
      .then((d) => { if (seq === loadSeq.current) setDetail(d); })
      .catch((e) => { if (seq === loadSeq.current) { onAuthError(e); setError(e instanceof Error ? e.message : 'Could not load this customer.'); } })
      .finally(() => { if (seq === loadSeq.current) setLoading(false); });
  }, [onAuthError]);

  useEffect(() => {
    setAction(null);
    if (!id) { loadSeq.current += 1; return undefined; }
    setDetail(null);
    load(id);
    return () => { loadSeq.current += 1; };
  }, [id, load]);

  const state: CustomerState | null = detail ? customerState(detail) : null;

  const footer = (
    <div className="flex flex-wrap gap-2 pb-4">
      {detail && state === 'ACTIVE' && <button type="button" className="k-btn-ghost min-w-[7rem] flex-1" onClick={() => setAction('suspend')}>Suspend</button>}
      {detail && state === 'SUSPENDED' && <button type="button" className="k-btn-primary min-w-[7rem] flex-1" onClick={() => setAction('restore')}>Restore</button>}
      {detail && state === 'REMOVED' && <button type="button" className="k-btn-primary min-w-[7rem] flex-1" onClick={() => setAction('restore')}>Restore</button>}
      {detail && (state === 'ACTIVE' || state === 'SUSPENDED') && <button type="button" className="k-btn-danger min-w-[7rem] flex-1" onClick={() => setAction('remove')}>Remove</button>}
      <button type="button" onClick={onClose} className="k-btn-ghost min-w-[7rem] flex-1">Close</button>
    </div>
  );

  return (
    <Drawer open={Boolean(id)} onClose={onClose} wide title={detail?.name ?? 'Customer'} subtitle={detail ? `Joined ${dateOnly(detail.createdAt)}` : 'Loading…'} icon={Users} focusFirstField={false} footer={footer}>
      {loading && !detail && <div className="space-y-3" role="status" aria-label="Loading customer"><SkeletonCard lines={2} /><SkeletonCard lines={3} /></div>}
      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink"><span className="min-w-0 break-words">{error}</span>{id && <button type="button" className="k-btn-ghost !min-h-[36px] text-xs" onClick={() => load(id)}>Try again</button>}</div>}
      {detail && state && (
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            <Avatar name={detail.name} size="lg" />
            <div className="min-w-0">
              <p className="break-words font-display text-xl font-bold text-kraveo-ink">{detail.name}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2"><CustomerStatusChip customer={detail} /><span className="text-xs text-kraveo-ink3">{detail.deleted ? 'This customer deleted their account' : detail.avatarId ? `App avatar #${detail.avatarId}` : 'No avatar chosen yet'}</span></div>
            </div>
          </div>

          {state === 'SUSPENDED' && (
            <div role="status" className="rounded-k-md border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 p-3 text-sm text-kraveo-ink">
              <p className="font-bold">Suspended{detail.statusChangedAt ? ` on ${dateTime(detail.statusChangedAt)}` : ''}</p>
              <p className="mt-0.5 break-words text-kraveo-ink2">Reason shown to them: {detail.statusReason ?? 'not recorded'}</p>
            </div>
          )}
          {state === 'REMOVED' && (
            <div role="status" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 p-3 text-sm text-kraveo-ink">
              <p className="font-bold">Removed{detail.statusChangedAt ? ` on ${dateTime(detail.statusChangedAt)}` : ''}</p>
              <p className="mt-0.5 break-words text-kraveo-ink2">Reason: {detail.statusReason ?? 'not recorded'}</p>
            </div>
          )}
          {state === 'DELETED' && <p role="status" className="k-inset px-4 py-3 text-sm text-kraveo-ink2">The customer deleted this account themselves. It cannot be restored.</p>}

          {detail.openOrders.length > 0 && (
            <section aria-label="Orders in progress" className="rounded-k-md border border-kraveo-line p-3">
              <h3 className="k-label mb-2">In progress ({detail.openOrders.length})</h3>
              <ul className="space-y-1.5">
                {detail.openOrders.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span><span className="font-mono font-bold text-kraveo-ink">{orderCode(o.id)}</span> <span className="text-kraveo-ink2">· {o.status ?? 'In progress'}{o.totalAmount !== null ? ` · ${inr(o.totalAmount)}` : ''}</span></span>
                    {onOpenOrder && <button type="button" className="font-bold text-kraveo-g300 hover:underline" onClick={() => onOpenOrder(o.id)} aria-label={`Open order ${orderCode(o.id)}`}>Open order</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail.refundsOwed.length > 0 && (
            <section aria-label="Refunds owed" className="rounded-k-md border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 p-3 text-sm text-kraveo-ink">
              <h3 className="font-bold">Refunds owed: {inr(detail.refundsOwed.reduce((sum, r) => sum + r.amount, 0))}</h3>
              <ul className="mt-1.5 space-y-1 text-xs text-kraveo-ink2">
                {detail.refundsOwed.map((r) => <li key={r.orderId}><span className="font-mono font-bold text-kraveo-ink">{orderCode(r.orderId)}</span> · {inr(r.amount)} · {r.refundStatus === 'FAILED' ? 'the refund failed, retry it from Needs attention' : 'refund in progress'}</li>)}
              </ul>
            </section>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">Orders</p><p className="k-num text-xl text-kraveo-ink">{detail.stats.ordersCount}</p></div>
            <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">Paid in total</p><p className="k-num text-xl text-kraveo-ink">{inr(detail.stats.totalSpent)}</p></div>
            <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">Delivered</p><p className="k-num text-xl text-kraveo-ink">{detail.stats.deliveredCount}</p></div>
            <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">Cancelled</p><p className="k-num text-xl text-kraveo-ink">{detail.stats.cancelledCount}</p></div>
            <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">In progress</p><p className="k-num text-xl text-kraveo-ink">{detail.stats.activeCount}</p></div>
            <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">Kraveo coins</p><p className="k-num flex items-center gap-1 text-xl text-kraveo-ink"><Coins className="h-4 w-4 text-kraveo-yellow" aria-hidden="true" />{detail.kraveoCoins}</p></div>
          </div>

          <div className="space-y-2.5">
            <InfoRow icon={Mail} label="Email (Google)">{detail.email ?? '—'}</InfoRow>
            <InfoRow icon={Phone} label="Phone">{detail.phone ? <a className="text-kraveo-g300 hover:underline" href={`tel:${detail.phone}`}>{detail.phone}</a> : '—'}</InfoRow>
            <InfoRow icon={detail.isStudent === false ? UserX : GraduationCap} label="Student status">{detail.isStudent === null ? 'Not answered yet' : detail.isStudent ? `Hosteller · ${detail.hostelBlock ?? 'block not set'}` : 'Not a hosteller — enters a drop point at checkout'}</InfoRow>
            <InfoRow icon={Clock} label="Last sign-in">{detail.lastLoginAt ? dateTime(detail.lastLoginAt) : 'Not recorded yet'}</InfoRow>
            <InfoRow icon={ShoppingBag} label="First and latest order">{detail.stats.firstOrderAt ? `${dateTime(detail.stats.firstOrderAt)} → ${dateTime(detail.stats.lastOrderAt)}` : 'No orders yet'}</InfoRow>
          </div>

          <div>
            <h3 className="k-label mb-2.5">Orders {detail.stats.ordersCount > detail.orders.length ? `(latest ${detail.orders.length} of ${detail.stats.ordersCount})` : `(${detail.orders.length})`}</h3>
            <div className="space-y-2.5">
              {detail.orders.length === 0 && <p className="k-inset px-4 py-6 text-center text-sm text-kraveo-ink3">This customer has not placed an order yet.</p>}
              {detail.orders.map((o) => <OrderBlock key={o.id} o={o} />)}
            </div>
          </div>
        </div>
      )}
      {detail && (
        <CustomerActionDialogs
          action={action}
          detail={detail}
          onClose={() => setAction(null)}
          onDone={(next) => { setDetail(next); onChanged(); }}
          onAuthError={onAuthError}
          onOpenOrder={onOpenOrder}
        />
      )}
    </Drawer>
  );
};
