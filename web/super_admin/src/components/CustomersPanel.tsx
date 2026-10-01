import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Coins, GraduationCap, Loader2, Mail, MapPin, Phone, Receipt, SearchX, ShoppingBag, UserX, Users, Wallet } from 'lucide-react';
import { CustomerDetail, CustomerOrder, CustomerRow } from '../types';
import { apiService } from '../services/api';
import { inr, timeAgo } from '../lib/tokens';
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
}

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

export const CustomersPanel: React.FC<Props> = ({ query, onClearQuery, onAuthError }) => {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const loadFirst = useCallback(async (search: string) => {
    const seq = ++requestSeq.current;
    setLoading(true); setError('');
    try {
      const page = await apiService.fetchCustomers(search);
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
    const timer = window.setTimeout(() => loadFirst(query), query ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [query, loadFirst]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await apiService.fetchCustomers(query, cursor);
      setRows((current) => [...current, ...page.data.filter((p) => !current.some((c) => c.id === p.id))]);
      setCursor(page.nextCursor);
    } catch (e) {
      onAuthError(e);
    } finally { setLoadingMore(false); }
  };

  const totalSpentLoaded = rows.reduce((sum, r) => sum + r.totalSpent, 0);
  const withOrders = rows.filter((r) => r.ordersCount > 0).length;
  const initialLoad = loading && rows.length === 0;
  const empty = !loading && rows.length === 0;

  return (
    <div className="space-y-5">
      <section aria-label="Customer summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiTile index={0} loading={initialLoad} label={query ? 'Matching customers' : 'Customers'} icon={Users} value={<AnimatedNumber value={total} />} note={query ? `Searching “${query}”` : 'Signed in with Google'} />
        <KpiTile index={1} loading={initialLoad} label="Have ordered" icon={ShoppingBag} tone="text-kraveo-status-pickedUp" toneBg="bg-kraveo-status-pickedUp/15" value={<AnimatedNumber value={withOrders} />} note={`Of ${rows.length} shown`} />
        <KpiTile index={2} loading={initialLoad} label="Paid by these" icon={Wallet} tone="text-kraveo-status-ready" toneBg="bg-kraveo-status-ready/15" value={<AnimatedNumber value={totalSpentLoaded} prefix="₹" />} note="Paid orders, customers shown" />
        <KpiTile index={3} loading={initialLoad} label="Loaded" icon={Receipt} tone="text-kraveo-status-atGate" toneBg="bg-kraveo-status-atGate/15" value={<>{rows.length}<span className="text-xl text-kraveo-ink3"> / {total}</span></>} note={cursor ? 'More available below' : 'All loaded'} />
      </section>

      {error && <div role="alert" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">{error}</div>}

      {empty && (
        <div className="k-card">
          <EmptyState icon={query ? SearchX : Users} title={query ? 'No customers match' : 'No customers yet'} description={query ? 'Try a name, email, phone number or hostel block.' : 'Customers appear here after they sign in to the Kraveo app.'}
            action={query ? <button className="k-btn-ghost" onClick={onClearQuery}>Clear search</button> : undefined} />
        </div>
      )}

      {/* Wide screens: a real table */}
      {rows.length > 0 && (
        <div className="k-card hidden max-h-[calc(100vh-22rem)] overflow-auto xl:block">
          <table className="w-full min-w-[960px] border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr className="sticky top-0 z-10 bg-kraveo-surface text-[11px] uppercase tracking-wide text-kraveo-ink3">
                {['Customer', 'Phone', 'Hostel', 'Orders', 'Paid', 'Last order', 'Joined', ''].map((h) => <th key={h} scope="col" className="border-b border-kraveo-line px-4 py-3 font-bold">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} tabIndex={0} onClick={() => setSelectedId(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(c.id); }}
                  className="cursor-pointer outline-none transition-colors hover:bg-kraveo-surface2/60 focus-visible:bg-kraveo-surface2/60" aria-label={`Open ${c.name}`}>
                  <td className="border-b border-kraveo-line/60 px-4 py-3">
                    <div className="flex items-center gap-3"><Avatar name={c.name} size="sm" /><div className="min-w-0"><p className="truncate font-bold text-kraveo-ink">{c.name}</p><p className="truncate text-xs text-kraveo-ink3">{c.email ?? (c.deleted ? 'Deleted account' : 'No email')}</p></div></div>
                  </td>
                  <td className="border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{c.phone ?? '—'}</td>
                  <td className="border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{where(c)}</td>
                  <td className="k-num border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink">{c.ordersCount}</td>
                  <td className="k-num border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink">{inr(c.totalSpent)}</td>
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
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Orders</p><p className="k-num text-lg text-kraveo-ink">{c.ordersCount}</p></div>
              <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Paid</p><p className="k-num text-lg text-kraveo-ink">{inr(c.totalSpent)}</p></div>
              <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Last</p><p className="k-num text-sm leading-7 text-kraveo-ink">{c.lastOrderAt ? timeAgo(c.lastOrderAt) : 'Never'}</p></div>
            </div>
            <p className="mt-2 truncate text-xs text-kraveo-ink3">{where(c)} · Joined {dateOnly(c.createdAt)}</p>
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

      <CustomerDrawer id={selectedId} onClose={() => setSelectedId(null)} onAuthError={onAuthError} />
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
          <p className="font-mono text-[11px] text-kraveo-ink3">#{o.id.slice(0, 8)} · {dateTime(o.createdAt)}</p>
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

const CustomerDrawer: React.FC<{ id: string | null; onClose: () => void; onAuthError: (e: unknown) => void }> = ({ id, onClose, onAuthError }) => {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setDetail(null); setError(''); setLoading(true);
    apiService.fetchCustomer(id)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) { onAuthError(e); setError(e instanceof Error ? e.message : 'Could not load this customer.'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, onAuthError]);

  return (
    <Drawer open={Boolean(id)} onClose={onClose} wide title={detail?.name ?? 'Customer'} subtitle={detail ? `Joined ${dateOnly(detail.createdAt)}` : 'Loading…'} icon={Users}
      footer={<button onClick={onClose} className="k-btn-ghost mb-1 w-full">Close</button>}>
      {loading && <div className="space-y-3" role="status" aria-label="Loading customer"><SkeletonCard lines={2} /><SkeletonCard lines={3} /></div>}
      {error && <div role="alert" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">{error}</div>}
      {detail && (
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            <Avatar name={detail.name} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-display text-xl font-bold text-kraveo-ink">{detail.name}</p>
              <p className="text-xs text-kraveo-ink3">{detail.deleted ? 'This customer deleted their account' : detail.avatarId ? `App avatar #${detail.avatarId}` : 'No avatar chosen yet'}</p>
            </div>
          </div>

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
    </Drawer>
  );
};
