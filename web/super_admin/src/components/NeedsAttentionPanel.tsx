import React, { useMemo, useState } from 'react';
import { Ban, CheckCircle2, ExternalLink, KeyRound, Loader2, MapPin, Phone, RefreshCw, RotateCcw, SearchX, TriangleAlert, UserCheck } from 'lucide-react';
import { AttentionEntry, Order } from '../types';
import { inr, timeAgo } from '../lib/tokens';
import { canCancel, canResetOtpLock } from '../lib/orders';
import { ProblemMeta, TONE_CLASS, problemMeta } from '../lib/orderProblems';
import { EmptyState } from './ui/EmptyState';
import { SkeletonCard } from './ui/Skeleton';
import { StatusPill } from './ui/StatusPill';
import { PaymentPill, TonePill } from './ui/OrderBadges';
import { shortId } from './OrderControls';
import type { DrawerMode } from './OrderDrawer';

interface Props {
  entries: AttentionEntry[];
  /** false = the server has no needs-attention endpoint yet; entries were detected by the dashboard itself. */
  serverAvailable: boolean | null;
  loading: boolean;
  error: string;
  checkedAt: number | null;
  onRefresh: () => void;
  onOpenOrder: (orderId: string, mode?: DrawerMode, fallback?: Order | null) => void;
  onResetOtpLock: (orderId: string) => Promise<boolean>;
  onRetryRefund: (orderId: string) => Promise<boolean>;
  query?: string;
  onClearQuery?: () => void;
}

const matches = (entry: AttentionEntry, q: string): boolean => {
  if (!q) return true;
  const o = entry.order;
  return [entry.orderId, o?.vendorName, o?.customerName, o?.dropoffHostel, o?.driverName, ...entry.problems.map((p) => problemMeta(p.code).label)]
    .some((v) => Boolean(v) && String(v).toLowerCase().includes(q));
};

const ActionButton: React.FC<{ meta: ProblemMeta; entry: AttentionEntry; busy: boolean; onOpen: Props['onOpenOrder']; onReset: (id: string) => void; onRetry: (id: string) => void }> = ({ meta, entry, busy, onOpen, onReset, onRetry }) => {
  const o = entry.order;
  const id = entry.orderId;
  if (!id) return null;
  switch (meta.action) {
    case 'reset-otp':
      if (o && !canResetOtpLock(o)) return null;
      return (
        <button type="button" className="k-btn-accent !min-h-[38px] text-xs" onClick={() => onReset(id)} disabled={busy} aria-busy={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}Reset OTP lock
        </button>
      );
    case 'retry-refund':
      if (o && o.refundStatus !== 'FAILED') return null;
      return (
        <button type="button" className="k-btn-accent !min-h-[38px] text-xs" onClick={() => onRetry(id)} disabled={busy} aria-busy={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-4 w-4" aria-hidden="true" />}Retry refund
        </button>
      );
    case 'cancel':
      if (o && !canCancel(o)) return null;
      return <button type="button" className="k-btn-danger !min-h-[38px] text-xs" onClick={() => onOpen(id, 'cancel', o)}><Ban className="h-4 w-4" aria-hidden="true" />Cancel order</button>;
    case 'assign':
      return <button type="button" className="k-btn-primary !min-h-[38px] text-xs" onClick={() => onOpen(id, 'view', o)}><UserCheck className="h-4 w-4" aria-hidden="true" />Assign rider</button>;
    case 'call-rider':
    case 'call-vendor':
    case 'call-customer': {
      const phone = meta.action === 'call-rider' ? o?.driverPhone : meta.action === 'call-vendor' ? o?.vendorPhone : o?.customerPhone;
      const who = meta.action === 'call-rider' ? 'rider' : meta.action === 'call-vendor' ? 'restaurant' : 'customer';
      // No phone in the payload (OrderView has no restaurant phone): offer the next sensible action instead.
      if (!phone) {
        const fallback = meta.action === 'call-vendor' ? 'cancel' : meta.action === 'call-rider' ? 'assign' : null;
        return fallback ? <ActionButton meta={{ ...meta, action: fallback }} entry={entry} busy={busy} onOpen={onOpen} onReset={onReset} onRetry={onRetry} /> : null;
      }
      return <a href={`tel:${phone.replace(/\s+/g, '')}`} className="k-btn-primary !min-h-[38px] text-xs" aria-label={`Call the ${who} on ${phone}`}><Phone className="h-4 w-4" aria-hidden="true" />Call {who}</a>;
    }
    default:
      return null;
  }
};

export const NeedsAttentionPanel: React.FC<Props> = ({ entries, serverAvailable, loading, error, checkedAt, onRefresh, onOpenOrder, onResetOtpLock, onRetryRefund, query = '', onClearQuery }) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => entries.filter((entry) => matches(entry, q)), [entries, q]);
  const critical = entries.filter((entry) => entry.problems.some((p) => problemMeta(p.code).tone === 'danger')).length;

  const runBusy = (action: (orderId: string) => Promise<boolean>) => async (orderId: string) => {
    setBusyId(orderId);
    try { await action(orderId); } finally { setBusyId(null); }
  };
  const reset = runBusy(onResetOtpLock);
  const retry = runBusy(onRetryRefund);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
          <TonePill tone="danger">{critical} urgent</TonePill>
          <TonePill tone="warning">{entries.length - critical} to check</TonePill>
          <span className="text-kraveo-ink3">{checkedAt ? `Checked ${timeAgo(checkedAt)}` : 'Not checked yet'} · refreshes on every order event</span>
        </div>
        <button type="button" className="k-btn-ghost !min-h-[38px] self-start text-xs sm:self-auto" onClick={onRefresh} disabled={loading} aria-busy={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />Check now
        </button>
      </div>

      {serverAvailable === false && (
        <div role="status" className="rounded-k-md border border-kraveo-status-placed/30 bg-kraveo-status-placed/10 px-4 py-3 text-sm text-kraveo-ink">
          This server does not have the needs-attention list yet. Showing only what the dashboard can see in the loaded orders (failed refunds, locked OTPs, paid orders not accepted in time).
        </div>
      )}
      {error && <div role="alert" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">{error}</div>}

      <div className="grid grid-cols-1 items-start gap-3 sm:gap-4 xl:grid-cols-2">
        {loading && entries.length === 0 && Array.from({ length: 2 }).map((_, i) => <SkeletonCard key={i} lines={3} />)}
        {!loading && visible.length === 0 && (
          <div className="k-card xl:col-span-2">
            {entries.length === 0
              ? <EmptyState icon={CheckCircle2} title="Nothing needs you right now" description="Failed refunds, locked gate OTPs, payment mismatches and stuck orders show up here as soon as they happen." />
              : <EmptyState icon={SearchX} title="No problems match" description="Nothing matches the current search." action={<button className="k-btn-ghost" onClick={onClearQuery}>Clear search</button>} />}
          </div>
        )}
        {visible.map((entry, index) => {
          const o = entry.order;
          const metas = entry.problems.map((p) => ({ p, meta: problemMeta(p.code) }));
          const top = metas[0]; // the server puts the primary (most urgent) problem first
          const tone = TONE_CLASS[top.meta.tone];
          return (
            <article key={entry.key} className={`k-card k-reveal border-l-4 ${tone.border} p-4`} style={{ ['--i' as string]: Math.min(index, 10) }} aria-label={`${top.meta.label}${entry.orderId ? `, order ${shortId(entry.orderId)}` : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-bold text-kraveo-ink" title={entry.orderId ?? undefined}>
                    {entry.orderId ? shortId(entry.orderId) : 'No order id'}
                    {o && <span className="font-sans font-medium text-kraveo-ink3"> · placed {timeAgo(o.createdAt)}</span>}
                  </p>
                  {o && (
                    <>
                      <p className="mt-1 truncate font-bold text-kraveo-ink">{o.vendorName} <span className="font-normal text-kraveo-ink3">for</span> {o.customerName}</p>
                      <p className="flex items-center gap-1 text-xs text-kraveo-ink2"><MapPin className="h-3 w-3 shrink-0 text-kraveo-ink3" aria-hidden="true" /><span className="truncate">{o.dropoffHostel}</span><span className="k-num ml-auto shrink-0 text-sm text-kraveo-ink">{inr(o.totalAmount)}</span></p>
                    </>
                  )}
                </div>
                {o && <div className="flex shrink-0 flex-col items-end gap-1.5"><StatusPill status={o.status} compact /><PaymentPill status={o.paymentStatus} /></div>}
              </div>

              <ul className="mt-3 space-y-2.5">
                {metas.map(({ p, meta }) => (
                  <li key={meta.code} className="k-inset px-3 py-2.5 text-sm">
                    <TonePill tone={meta.tone} icon={TriangleAlert}>{meta.label}</TonePill>
                    <p className="mt-1.5 text-kraveo-ink2">{meta.explain}</p>
                    {p.detail && <p className="mt-1 break-words text-kraveo-ink">{p.detail}</p>}
                    <p className="mt-1 font-semibold text-kraveo-ink">{p.code === entry.problems[0]?.code && entry.hint ? entry.hint : meta.advice}</p>
                    {p.since && <p className="mt-1 text-[11px] text-kraveo-ink3">Since {timeAgo(p.since)}</p>}
                  </li>
                ))}
              </ul>

              {entry.orderId && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton meta={top.meta} entry={entry} busy={busyId === entry.orderId} onOpen={onOpenOrder} onReset={reset} onRetry={retry} />
                  <button type="button" className="k-btn-ghost !min-h-[38px] text-xs" onClick={() => onOpenOrder(entry.orderId!, 'view', o)} aria-haspopup="dialog">
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />Open order
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
};
