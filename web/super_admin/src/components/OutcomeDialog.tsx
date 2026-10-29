import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import { Outcome, mergeOutcome, refundText } from '../lib/accountParse';
import { adminErrorText } from '../lib/errors';
import { orderCode } from '../lib/orders';
import { Modal } from './ui/Modal';

interface Props {
  title: string;
  headline: string;
  outcome: Outcome;
  onClose: () => void;
  onOpenOrder?: (id: string) => void;
  /**
   * Repeats the same action to cancel the next batch (the server cancels at most 25 orders per request and lists the rest in `remaining`).
   * Returns the next answer. Without it a "remaining" list is explained with `remainingHelp` instead.
   */
  onContinue?: () => Promise<Outcome>;
  /** What to do about the remaining orders when the action cannot be repeated (an owner already detached). */
  remainingHelp?: string;
  onAuthError?: (error: unknown) => void;
}

/** What an action did besides the change itself: orders cancelled (and how each refund went), deliveries handed back, what failed, what is still open. Plain text only. */
export const OutcomeDialog: React.FC<Props> = ({ title, headline, outcome: first, onClose, onOpenOrder, onContinue, remainingHelp, onAuthError }) => {
  const [outcome, setOutcome] = useState<Outcome>(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const next = async () => {
    if (!onContinue || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const more = await onContinue();
      if (mounted.current) setOutcome((current) => mergeOutcome(current, more));
    } catch (e) {
      onAuthError?.(e);
      if (mounted.current) setError(adminErrorText(e));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const failed = outcome.failed.length > 0 || outcome.releaseFailed.length > 0;
  const worry = failed || outcome.remaining.length > 0 || outcome.cancelled.some((c) => c.refund === 'FAILED');
  const open = (id: string) => (onOpenOrder ? <button type="button" className="font-mono font-bold text-kraveo-g300 hover:underline" onClick={() => { onClose(); onOpenOrder(id); }}>{orderCode(id)}</button> : <span className="font-mono font-bold">{orderCode(id)}</span>);
  const n = outcome.remaining.length;
  return (
    <Modal title={title} onClose={onClose} locked={busy} role="alertdialog" footer={<div className="pb-3"><button type="button" className="k-btn-primary w-full" data-autofocus onClick={onClose} disabled={busy}>Close</button></div>}>
      <div className="space-y-4 text-sm text-kraveo-ink">
        <p className={`flex items-start gap-2 font-bold ${worry ? 'text-kraveo-status-placed' : 'text-kraveo-g300'}`}>
          {worry ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
          <span className="break-words">{headline}</span>
        </p>
        {n > 0 && (
          <section aria-label="Orders still open" className="space-y-2 rounded-k-md border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 p-3">
            <p className="font-bold">{n} more order{n === 1 ? ' is' : 's are'} still open: {onContinue ? 'press Continue to cancel the next batch.' : 'they were not cancelled yet.'}</p>
            {onContinue ? (
              <button type="button" className="k-btn-primary w-full sm:w-auto" onClick={() => void next()} disabled={busy} aria-busy={busy}>
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Working…</> : 'Continue'}
              </button>
            ) : remainingHelp ? <p className="text-xs text-kraveo-ink2">{remainingHelp}</p> : null}
            {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-xs">{error}</p>}
          </section>
        )}
        {outcome.cancelled.length > 0 && (
          <section aria-label="Cancelled orders">
            <h3 className="k-label mb-1.5">Cancelled ({outcome.cancelled.length})</h3>
            <ul className="space-y-1.5">
              {outcome.cancelled.map((c) => (
                <li key={c.orderId} className="rounded-k-sm bg-kraveo-night/50 px-3 py-2 text-xs">
                  {open(c.orderId)}
                  <span className="text-kraveo-ink2">{c.cancelledOrders > 1 ? ` · combined order, ${c.cancelledOrders} parts cancelled` : ''} · </span>
                  <span className={c.refund === 'FAILED' ? 'break-words font-semibold text-kraveo-danger' : 'break-words text-kraveo-ink2'}>{refundText(c)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {outcome.released.length > 0 && (
          <section aria-label="Handed back to the pool">
            <h3 className="k-label mb-1.5">Handed back to the pool ({outcome.released.length})</h3>
            <ul className="space-y-1.5">{outcome.released.map((id) => <li key={id} className="rounded-k-sm bg-kraveo-night/50 px-3 py-2 text-xs">{open(id)}<span className="text-kraveo-ink2"> · waiting for another rider</span></li>)}</ul>
          </section>
        )}
        {failed && (
          <section aria-label="Problems" className="rounded-k-md border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 p-3">
            <h3 className="mb-1.5 font-bold">Could not finish ({outcome.failed.length + outcome.releaseFailed.length})</h3>
            <ul className="space-y-1.5">
              {[...outcome.failed, ...outcome.releaseFailed].map((f) => (
                <li key={f.orderId} className="break-words text-xs">{open(f.orderId)}<span className="text-kraveo-ink2"> · {f.message || f.code || 'could not be done'}</span></li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-kraveo-ink2">The change itself was made. Do the same action again to retry the orders that failed; orders that are already done are skipped.</p>
          </section>
        )}
        {outcome.warning && <p className="rounded-k-sm bg-kraveo-surface2 px-3 py-2 text-xs text-kraveo-ink2">{outcome.warning}</p>}
      </div>
    </Modal>
  );
};
