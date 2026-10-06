import React, { useRef, useState } from 'react';
import { Download, Landmark, Loader2, Pause, Play, Plus, Wallet, XCircle } from 'lucide-react';
import { apiService } from '../services/api';
import { Settlement, SettlementAction, SettlementDetail, STATUS_LABEL, isSettlementStatus, istDateTime, istToday, rupeesSigned } from '../lib/financeParse';
import { MarkPaidInput, newRequestId, validateAdjustment, validateHold, validateMarkPaid } from '../lib/financeInput';
import { saveBlob } from '../lib/download';
import { rupees } from '../lib/pricing';
import { Drawer } from './ui/Drawer';
import { Field } from './ui/Field';
import { Skeleton } from './ui/Skeleton';
import { useConfirm } from './ui/ConfirmDialog';
import { useToast } from './ui/Toast';
import { ErrorNote, ScrollTable, Td, Th, plainError, useLoad } from './FinanceCommon';
import { PayoutAccountPanel } from './PayoutAccountPanel';

const BADGE: Record<string, string> = {
  PENDING: 'bg-kraveo-status-placed/15 text-kraveo-status-placed',
  ON_HOLD: 'bg-kraveo-ink3/20 text-kraveo-ink2',
  PAID: 'bg-kraveo-g400/15 text-kraveo-g300',
  CANCELLED: 'bg-kraveo-danger/15 text-kraveo-danger',
};

export const SettlementStatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${BADGE[status] ?? 'bg-kraveo-surface2 text-kraveo-ink2'}`}>{isSettlementStatus(status) ? STATUS_LABEL[status] : status}</span>
);

interface Props {
  settlementId: string;
  /** The row that was clicked: gives the drawer a title while the detail loads. */
  preview: Settlement;
  onClose: () => void;
  /** Something changed on the server: reload the list and the sidebar badge. */
  onChanged: () => void;
  onAuthError: (error: unknown) => void;
}

type Mode = null | 'pay' | 'hold' | 'adjust';

const Total: React.FC<{ label: string; value: string; strong?: boolean }> = ({ label, value, strong }) => (
  <div className={`k-inset px-3 py-2.5 ${strong ? 'border-kraveo-g400/50' : ''}`}>
    <p className="k-label !text-[10px]">{label}</p>
    <p className={`k-num break-words ${strong ? 'text-xl text-kraveo-g300' : 'text-lg text-kraveo-ink'}`}>{value}</p>
  </div>
);

export const SettlementDrawer: React.FC<Props> = ({ settlementId, preview, onClose, onChanged, onAuthError }) => {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const detail = useLoad<SettlementDetail>(() => apiService.fetchSettlement(settlementId), [settlementId], onAuthError);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const [payForm, setPayForm] = useState({ reference: '', paidDate: '', note: '' });
  const [holdNote, setHoldNote] = useState('');
  const [adjForm, setAdjForm] = useState({ amount: '', reason: '' });
  const requestId = useRef(newRequestId());

  const s = detail.data?.settlement ?? preview;
  const status = s.status;
  const canPay = status === 'PENDING' && s.netPayable > 0;
  const open = (next: Mode) => { setMode(next); setTouched(false); setError(''); };

  /** Runs one action once (double clicks are ignored), then reloads the detail and the list. */
  const run = async (name: string, action: () => Promise<SettlementAction>, done: (result: SettlementAction) => { title: string; text?: string }): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(name); setError('');
    try {
      const result = await action();
      const note = done(result);
      toast.success(note.title, note.text || result.message || undefined);
      detail.reload();
      onChanged();
      return true;
    } catch (failure) {
      onAuthError(failure);
      setError(plainError(failure));
      return false;
    } finally { busyRef.current = false; setBusy(null); }
  };

  const payCheck = validateMarkPaid(payForm);
  const submitPay = async () => {
    setTouched(true);
    if (!payCheck.ok || busyRef.current) return;
    const input: MarkPaidInput = payCheck.value;
    const ok = await confirm({
      title: `Mark ${rupees(s.netPayable)} as paid?`,
      message: `You are saying ${s.vendorName} was paid ${rupees(s.netPayable)} with reference ${input.reference}. The restaurant sees it as paid. A paid settlement cannot be undone or cancelled.`,
      confirmLabel: 'Mark as paid',
    });
    if (!ok) return;
    const done = await run('pay', () => apiService.markSettlementPaid(settlementId, input), (r) => ({ title: r.changed ? 'Marked as paid' : 'Already paid', text: `Reference ${r.settlement?.paymentReference ?? input.reference}. ${r.message}` }));
    if (done) { setMode(null); setPayForm({ reference: '', paidDate: '', note: '' }); }
  };

  const holdCheck = validateHold(holdNote);
  const submitHold = async () => {
    setTouched(true);
    if (!holdCheck.ok) return;
    const input = holdCheck.value;
    const done = await run('hold', () => apiService.holdSettlement(settlementId, input), (r) => ({ title: r.changed ? 'Put on hold' : 'Already on hold' }));
    if (done) { setMode(null); setHoldNote(''); }
  };

  const adjCheck = validateAdjustment(adjForm, detail.data ? { vendorAmount: s.vendorAmount, adjustmentTotal: s.adjustmentTotal } : undefined);
  const submitAdjust = async () => {
    setTouched(true);
    if (!adjCheck.ok) return;
    const input = { ...adjCheck.value, requestId: requestId.current };
    const done = await run('adjust', () => apiService.addSettlementAdjustment(settlementId, input), (r) => ({ title: r.changed ? 'Adjustment added' : 'Adjustment was already added' }));
    if (done) { setMode(null); setAdjForm({ amount: '', reason: '' }); requestId.current = newRequestId(); }
  };

  const release = () => { run('release', () => apiService.releaseSettlement(settlementId), (r) => ({ title: r.changed ? 'Released' : 'It was not on hold' })); };

  const cancel = async () => {
    if (busyRef.current) return;
    const ok = await confirm({
      title: 'Cancel this settlement?',
      message: `The ${s.orderCount} ${s.orderCount === 1 ? 'order' : 'orders'} in it go back to unsettled and are picked up by the next settlement run (or Create settlements now). Adjustments stay on this cancelled record and are not carried over. Nothing is paid.`,
      confirmLabel: 'Cancel settlement',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    await run('cancel', () => apiService.cancelSettlement(settlementId), (r) => ({ title: r.changed ? 'Settlement cancelled' : 'Already cancelled', text: r.freedOrders !== null ? `${r.freedOrders} ${r.freedOrders === 1 ? 'order is' : 'orders are'} unsettled again.` : r.message }));
  };

  const exportCsv = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy('csv'); setError('');
    try {
      const file = await apiService.downloadSettlementCsv(settlementId);
      saveBlob(file.blob, file.filename);
      toast.success('CSV downloaded', file.filename);
    } catch (failure) {
      onAuthError(failure);
      setError(plainError(failure));
    } finally { busyRef.current = false; setBusy(null); }
  };

  const d = detail.data;
  const snap = s.payoutSnapshot;
  const anyBusy = busy !== null;
  const showError = (key: string, errors: Record<string, string> | null) => (touched && errors ? errors[key] : undefined);
  const payErrors = payCheck.ok ? null : payCheck.errors;
  const holdErrors = holdCheck.ok ? null : holdCheck.errors;
  const adjErrors = adjCheck.ok ? null : adjCheck.errors;

  return (
    <Drawer
      open
      onClose={onClose}
      title={s.vendorName}
      subtitle={`Settlement ${s.id.slice(0, 8)} · ${s.orderCount} ${s.orderCount === 1 ? 'order' : 'orders'}`}
      icon={Wallet}
      wide
      focusFirstField={false}
      footer={(
        <div className="flex flex-wrap items-center gap-2 pb-4" role="group" aria-label="Settlement actions">
          {status === 'PENDING' && <button type="button" className="k-btn-primary" onClick={() => open('pay')} disabled={anyBusy || !canPay} title={canPay ? undefined : 'The payable amount is not above 0'}><Wallet className="h-4 w-4" aria-hidden="true" />Mark paid</button>}
          {status === 'PENDING' && <button type="button" className="k-btn-ghost" onClick={() => open('hold')} disabled={anyBusy}><Pause className="h-4 w-4" aria-hidden="true" />Hold</button>}
          {status === 'ON_HOLD' && <button type="button" className="k-btn-primary" onClick={release} disabled={anyBusy} aria-busy={busy === 'release'}>{busy === 'release' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}Release</button>}
          {(status === 'PENDING' || status === 'ON_HOLD') && <button type="button" className="k-btn-ghost" onClick={() => open('adjust')} disabled={anyBusy}><Plus className="h-4 w-4" aria-hidden="true" />Add adjustment</button>}
          {(status === 'PENDING' || status === 'ON_HOLD') && <button type="button" className="k-btn-danger" onClick={cancel} disabled={anyBusy} aria-busy={busy === 'cancel'}><XCircle className="h-4 w-4" aria-hidden="true" />Cancel settlement</button>}
          <button type="button" className="k-btn-ghost" onClick={exportCsv} disabled={anyBusy} aria-busy={busy === 'csv'}>{busy === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}Download CSV</button>
        </div>
      )}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <SettlementStatusBadge status={status} />
          <span className="text-xs text-kraveo-ink3">Created {istDateTime(s.createdAt) || '—'}{s.createdBy === 'AUTO' ? ' by the daily job' : ''}</span>
        </div>

        {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{error}</p>}
        {status === 'ON_HOLD' && <p role="status" className="rounded-k-sm border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 px-3 py-2 text-sm text-kraveo-ink">On hold. Release it before marking it paid.{s.note ? ` Note: ${s.note}` : ''}</p>}

        {mode === 'pay' && (
          <form className="k-inset space-y-3 p-4" aria-label="Mark as paid" noValidate onSubmit={(event) => { event.preventDefault(); submitPay(); }}>
            <p className="text-sm text-kraveo-ink2">Pay {s.vendorName} {rupees(s.netPayable)} by bank or UPI first, then record the transaction reference here.</p>
            <Field label="Bank or UPI reference (UTR)" htmlFor="settle-reference" required error={showError('reference', payErrors)} hint="3 to 64 characters.">
              <input id="settle-reference" className="k-input" value={payForm.reference} onChange={(e) => setPayForm((f) => ({ ...f, reference: e.target.value }))} maxLength={80} aria-invalid={Boolean(showError('reference', payErrors))} aria-describedby="settle-reference-msg" autoComplete="off" />
            </Field>
            <Field label="Paid on (optional, India date)" htmlFor="settle-paid-date" error={showError('paidDate', payErrors)} hint="Leave empty for now.">
              <input id="settle-paid-date" type="date" className="k-input" value={payForm.paidDate} max={istToday()} onChange={(e) => setPayForm((f) => ({ ...f, paidDate: e.target.value }))} aria-invalid={Boolean(showError('paidDate', payErrors))} aria-describedby="settle-paid-date-msg" />
            </Field>
            <Field label="Note (optional)" htmlFor="settle-note" error={showError('note', payErrors)}>
              <textarea id="settle-note" className="k-input min-h-[72px] py-2" value={payForm.note} onChange={(e) => setPayForm((f) => ({ ...f, note: e.target.value }))} aria-invalid={Boolean(showError('note', payErrors))} aria-describedby="settle-note-msg" />
            </Field>
            <div className="flex gap-2">
              <button type="submit" className="k-btn-primary" disabled={anyBusy} aria-busy={busy === 'pay'}>{busy === 'pay' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Review and mark paid</button>
              <button type="button" className="k-btn-ghost" onClick={() => setMode(null)} disabled={anyBusy}>Close form</button>
            </div>
          </form>
        )}

        {mode === 'hold' && (
          <form className="k-inset space-y-3 p-4" aria-label="Put on hold" noValidate onSubmit={(event) => { event.preventDefault(); submitHold(); }}>
            <p className="text-sm text-kraveo-ink2">A settlement on hold cannot be paid until you release it.</p>
            <Field label="Why (optional)" htmlFor="settle-hold-note" error={showError('note', holdErrors)}>
              <input id="settle-hold-note" className="k-input" value={holdNote} onChange={(e) => setHoldNote(e.target.value)} aria-invalid={Boolean(showError('note', holdErrors))} aria-describedby="settle-hold-note-msg" autoComplete="off" />
            </Field>
            <div className="flex gap-2">
              <button type="submit" className="k-btn-primary" disabled={anyBusy} aria-busy={busy === 'hold'}>{busy === 'hold' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Put on hold</button>
              <button type="button" className="k-btn-ghost" onClick={() => setMode(null)} disabled={anyBusy}>Close form</button>
            </div>
          </form>
        )}

        {mode === 'adjust' && (
          <form className="k-inset space-y-3 p-4" aria-label="Add adjustment" noValidate onSubmit={(event) => { event.preventDefault(); submitAdjust(); }}>
            <p className="text-sm text-kraveo-ink2">+ pays the restaurant more, - deducts. It changes the payable amount ({rupees(s.netPayable)} now).</p>
            <Field label="Amount (₹, + or -)" htmlFor="settle-adj-amount" required error={showError('amount', adjErrors)}>
              <input id="settle-adj-amount" className="k-input" inputMode="decimal" value={adjForm.amount} onChange={(e) => setAdjForm((f) => ({ ...f, amount: e.target.value }))} placeholder="-50 or 25.50" aria-invalid={Boolean(showError('amount', adjErrors))} aria-describedby="settle-adj-amount-msg" autoComplete="off" />
            </Field>
            <Field label="Reason" htmlFor="settle-adj-reason" required error={showError('reason', adjErrors)} hint="3 to 200 characters. Kept in the audit log.">
              <input id="settle-adj-reason" className="k-input" value={adjForm.reason} onChange={(e) => setAdjForm((f) => ({ ...f, reason: e.target.value }))} maxLength={240} aria-invalid={Boolean(showError('reason', adjErrors))} aria-describedby="settle-adj-reason-msg" autoComplete="off" />
            </Field>
            <div className="flex gap-2">
              <button type="submit" className="k-btn-primary" disabled={anyBusy} aria-busy={busy === 'adjust'}>{busy === 'adjust' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Add adjustment</button>
              <button type="button" className="k-btn-ghost" onClick={() => setMode(null)} disabled={anyBusy}>Close form</button>
            </div>
          </form>
        )}

        <section aria-label="Totals" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Total label="Orders" value={String(s.orderCount)} />
          <Total label="Customers paid for food" value={rupees(s.foodGross)} />
          <Total label="Restaurant amount" value={rupees(s.vendorAmount)} />
          <Total label="Commission" value={rupees(s.commissionAmount)} />
          <Total label="Adjustments" value={rupeesSigned(s.adjustmentTotal)} />
          <Total label="Net payable" value={rupees(s.netPayable)} strong />
        </section>

        {status === 'PAID' && (
          <section className="rounded-k-md border border-kraveo-g400/40 bg-kraveo-g400/10 px-4 py-3" aria-label="Payment">
            <p className="k-label">Paid</p>
            <p className="mt-1 text-sm text-kraveo-ink">{s.paidAt ? istDateTime(s.paidAt) : 'Date not recorded'}</p>
            <p className="mt-1 text-sm text-kraveo-ink">UTR / reference: <b className="break-all" data-testid="payment-reference">{s.paymentReference ?? 'not recorded'}</b></p>
            {s.note && <p className="mt-1 text-xs text-kraveo-ink2">Note: {s.note}</p>}
          </section>
        )}

        <section aria-label="Payout destination" className="space-y-3">
          <h3 className="flex items-center gap-2 font-display text-base font-bold text-kraveo-ink"><Landmark className="h-4 w-4 text-kraveo-ink3" aria-hidden="true" />Where to pay</h3>
          {snap ? (
            <div className="k-inset space-y-1 px-3 py-2.5 text-sm">
              <p className="k-label">When this settlement was created</p>
              <p className="break-words text-kraveo-ink"><b>{snap.method === 'UPI' ? 'UPI' : snap.method === 'BANK' ? 'Bank account' : snap.method}</b> {snap.destination ?? ''}{snap.accountHolder ? ` · ${snap.accountHolder}` : ''}{snap.ifsc ? ` · ${snap.ifsc}` : ''}{snap.bankName ? ` · ${snap.bankName}` : ''}</p>
              <p className="text-xs text-kraveo-ink3">{snap.verified ? 'Verified at that time' : 'Not verified at that time'}</p>
            </div>
          ) : (
            <p role="status" className="rounded-k-sm border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 px-3 py-2 text-sm text-kraveo-ink">No payout details were saved when this settlement was created. Ask the restaurant to add them, or add them below.</p>
          )}
          {detail.loading && !d && <Skeleton className="h-20 w-full" />}
          {d && <PayoutAccountPanel userId={d.vendor.userId} name={d.vendor.name} kind="restaurant" initial={d.payoutAccount} onAuthError={onAuthError} />}
        </section>

        {detail.error && <ErrorNote message={detail.error} onRetry={detail.reload} />}
        {detail.loading && !d && !detail.error && <div role="status" aria-label="Loading settlement" className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div>}

        {d && (
          <>
            <section aria-label="Adjustments" className="space-y-2">
              <h3 className="font-display text-base font-bold text-kraveo-ink">Adjustments</h3>
              {d.adjustments.length === 0 ? <p className="text-sm text-kraveo-ink2">No adjustments.</p> : (
                <ul className="space-y-1.5">
                  {d.adjustments.map((a) => (
                    <li key={a.id} className="k-inset flex items-start justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 break-words text-kraveo-ink2">{a.reason}<span className="block text-[11px] text-kraveo-ink3">{istDateTime(a.createdAt)}</span></span>
                      <b className={`shrink-0 tabular-nums ${a.amount < 0 ? 'text-kraveo-danger' : 'text-kraveo-g300'}`}>{a.amount > 0 ? '+' : ''}{rupeesSigned(a.amount)}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Dishes" className="space-y-2">
              <h3 className="font-display text-base font-bold text-kraveo-ink">Dishes</h3>
              {d.dishes.length === 0 ? <p className="text-sm text-kraveo-ink2">No dish lines.</p> : (
                <ScrollTable caption="Dish lines of this settlement" minWidth="min-w-[420px]">
                  <thead><tr><Th>Dish</Th><Th right>Units</Th><Th right>Restaurant revenue</Th><Th right>Commission</Th></tr></thead>
                  <tbody>{d.dishes.map((dish, index) => <tr key={`${dish.menuItemId ?? dish.name}-${index}`}><Td className="break-words font-bold text-kraveo-ink">{dish.name}</Td><Td right>{dish.units}</Td><Td right>{rupees(dish.vendorRevenue)}</Td><Td right>{rupees(dish.commission)}</Td></tr>)}</tbody>
                </ScrollTable>
              )}
            </section>

            <section aria-label="Orders" className="space-y-2">
              <h3 className="font-display text-base font-bold text-kraveo-ink">Orders</h3>
              {d.orders.length === 0 ? <p className="text-sm text-kraveo-ink2">No orders are in this settlement{status === 'CANCELLED' ? ' (they were released when it was cancelled)' : ''}.</p> : (
                <ScrollTable caption="Orders of this settlement" minWidth="min-w-[560px]">
                  <thead><tr><Th>Order</Th><Th>Delivered</Th><Th right>Food</Th><Th right>Restaurant</Th><Th right>Commission</Th></tr></thead>
                  <tbody>{d.orders.map((o) => <tr key={o.id}><Td className="font-mono text-xs text-kraveo-ink">{o.id.slice(0, 8)}</Td><Td className="whitespace-nowrap">{istDateTime(o.deliveredAt)}</Td><Td right>{rupees(o.subtotal)}</Td><Td right>{rupees(o.vendorSubtotal)}</Td><Td right>{rupees(o.commissionTotal)}</Td></tr>)}</tbody>
                </ScrollTable>
              )}
              {d.ordersTruncated && <p className="text-xs font-semibold text-kraveo-status-placed">Only the first {d.orders.length} orders are listed. The totals above count all {s.orderCount}; the CSV has every order.</p>}
            </section>
          </>
        )}
      </div>
      {dialog}
    </Drawer>
  );
};
