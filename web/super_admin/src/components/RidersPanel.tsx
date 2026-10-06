import React, { useMemo, useRef, useState } from 'react';
import { Bike, ChevronDown, ChevronUp, Loader2, Wallet } from 'lucide-react';
import { DriverPartner } from '../types';
import { apiService } from '../services/api';
import { DateRange, FinanceRider, FinanceRiders, RIDER_PAYOUT_METHODS, RiderPayoutPage, dateLabel, istDateTime, presetRange } from '../lib/financeParse';
import { validateRiderPayout } from '../lib/financeInput';
import { rupees } from '../lib/pricing';
import { EmptyState } from './ui/EmptyState';
import { Field } from './ui/Field';
import { Skeleton } from './ui/Skeleton';
import { useConfirm } from './ui/ConfirmDialog';
import { useToast } from './ui/Toast';
import { DateRangePicker, ErrorNote, Pager, ReloadButton, ScrollTable, SectionCard, Td, Th, plainError, useLoad } from './FinanceCommon';
import { PayoutAccountPanel } from './PayoutAccountPanel';

interface Props {
  /** Riders known to the dashboard (their `userId` is what payouts are recorded against). */
  driverPartners: DriverPartner[];
  onAuthError: (error: unknown) => void;
}

const MAX_RANGE_DAYS = 366;
const PAGE_SIZE = 25;
const METHOD_LABEL: Record<string, string> = { UPI: 'UPI', BANK: 'Bank', CASH: 'Cash' };

const riderLabel = (name: string | null | undefined, code: string | null | undefined, id: string): string => {
  const base = name || 'Rider';
  return code ? `${base} (${code})` : base === 'Rider' ? `Rider ${id.slice(0, 6)}` : base;
};

export const RidersPanel: React.FC<Props> = ({ driverPartners, onAuthError }) => {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [range, setRange] = useState<DateRange>(() => presetRange('7d'));
  const [ledgerRider, setLedgerRider] = useState('');
  const [ledgerPage, setLedgerPage] = useState({ key: '', page: 1 });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [daysOpen, setDaysOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ driverUserId: '', method: 'UPI', amount: '', reference: '', note: '' });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [formError, setFormError] = useState('');
  const [formNote, setFormNote] = useState('');
  const formRef = useRef<HTMLElement>(null);

  const ledgerKey = `${ledgerRider}|${range.from}..${range.to}`;
  const page = ledgerPage.key === ledgerKey ? ledgerPage.page : 1;
  const riders = useLoad<FinanceRiders>(() => apiService.fetchFinanceRiders(range), [range], onAuthError);
  const ledger = useLoad<RiderPayoutPage>(() => apiService.fetchRiderPayouts({ driverUserId: ledgerRider, range, page, pageSize: PAGE_SIZE }), [ledgerKey, page], onAuthError);

  const options = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of driverPartners) if (d.userId) map.set(d.userId, riderLabel(d.name, d.runnerCode, d.userId));
    for (const r of riders.data?.rows ?? []) if (!map.has(r.driverUserId)) map.set(r.driverUserId, riderLabel(r.name, r.runnerCode, r.driverUserId));
    return Array.from(map, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [driverPartners, riders.data]);
  const nameOf = (id: string) => options.find((o) => o.id === id)?.label ?? `Rider ${id.slice(0, 6)}`;

  const check = validateRiderPayout(form);
  const err = (key: string): string | undefined => (touched && !check.ok ? check.errors[key] : undefined);
  const setField = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => { setForm((f) => ({ ...f, [key]: event.target.value })); setFormError(''); setFormNote(''); };

  const startPayout = (rider: FinanceRider) => {
    setForm((f) => ({ ...f, driverUserId: rider.driverUserId }));
    setTouched(false); setFormError(''); setFormNote('');
    formRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const submit = async () => {
    setTouched(true);
    if (!check.ok || savingRef.current) return;
    const input = check.value;
    const ok = await confirm({
      title: `Record ${rupees(input.amount)} paid to ${nameOf(input.driverUserId)}?`,
      message: `This only writes a record in the payout ledger (${METHOD_LABEL[input.method]}${input.reference ? `, reference ${input.reference}` : ', no reference'}). It does not send any money. Make the payment first, then record it.`,
      confirmLabel: 'Record payout',
    });
    if (!ok || savingRef.current) return;
    savingRef.current = true; setSaving(true); setFormError(''); setFormNote('');
    try {
      const result = await apiService.recordRiderPayout(input);
      setFormNote(result.message || (result.changed ? 'Payout recorded.' : 'This payout was already recorded.'));
      toast.success(result.changed ? 'Payout recorded' : 'Already recorded', result.message || undefined);
      setForm((f) => ({ ...f, amount: '', reference: '', note: '' }));
      setTouched(false);
      riders.reload(); ledger.reload();
    } catch (failure) {
      onAuthError(failure);
      setFormError(plainError(failure));
    } finally { savingRef.current = false; setSaving(false); }
  };

  const r = riders.data;
  const l = ledger.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <DateRangePicker value={range} onChange={(next) => next && setRange(next)} maxDays={MAX_RANGE_DAYS} label="Date range" />
        <ReloadButton onClick={() => { riders.reload(); ledger.reload(); }} loading={riders.loading || ledger.loading} label="Reload riders" />
      </div>

      <SectionCard title="Riders" description="Deliveries completed (delivered and paid orders) and payouts recorded in the range.">
        {riders.loading && !r && <div role="status" aria-label="Loading riders" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div>}
        {riders.error && <ErrorNote message={riders.error} onRetry={riders.reload} />}
        {r && !riders.error && (
          <>
            <div className="grid grid-cols-3 gap-3" data-testid="rider-totals">
              <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">Riders</p><p className="k-num text-xl text-kraveo-ink">{r.totals.riders}</p></div>
              <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">Deliveries</p><p className="k-num text-xl text-kraveo-ink">{r.totals.deliveries}</p></div>
              <div className="k-inset px-3 py-2.5"><p className="k-label !text-[10px]">Paid out</p><p className="k-num break-words text-xl text-kraveo-ink">{rupees(r.totals.payoutTotal)}</p></div>
            </div>
            {r.rows.length === 0 ? (
              <EmptyState icon={Bike} title="No rider activity" description="No rider delivered an order or received a payout in this range." />
            ) : (
              <div className={riders.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={riders.loading}>
                <ScrollTable caption="Riders" minWidth="min-w-[760px]">
                  <thead><tr><Th>Rider</Th><Th right>Deliveries</Th><Th right>Payouts</Th><Th>Last payout</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                  <tbody>
                    {r.rows.map((rider) => {
                      const label = riderLabel(rider.name, rider.runnerCode, rider.driverUserId);
                      return (
                        <React.Fragment key={rider.driverUserId}>
                          <tr>
                            <Td className="max-w-[14rem] break-words font-bold text-kraveo-ink">{label}</Td>
                            <Td right>
                              {rider.deliveries}
                              {rider.byDay.length > 0 && (
                                <button type="button" className="ml-2 inline-flex items-center text-[11px] font-bold text-kraveo-g300 underline" aria-expanded={daysOpen === rider.driverUserId} aria-label={`Deliveries per day of ${label}`} onClick={() => setDaysOpen(daysOpen === rider.driverUserId ? null : rider.driverUserId)}>by day</button>
                              )}
                            </Td>
                            <Td right>{rupees(rider.payouts.total)}{rider.payouts.count > 0 && <span className="block text-[11px] text-kraveo-ink3">{rider.payouts.count} {rider.payouts.count === 1 ? 'payout' : 'payouts'}</span>}</Td>
                            <Td className="whitespace-nowrap text-xs">{rider.payouts.lastAt ? istDateTime(rider.payouts.lastAt) : 'None in this range'}</Td>
                            <Td>
                              <span className="flex flex-wrap justify-end gap-2">
                                <button type="button" className="k-btn-ghost !min-h-[32px] !px-3 text-xs" onClick={() => startPayout(rider)} aria-label={`Record payout for ${label}`}><Wallet className="h-3.5 w-3.5" aria-hidden="true" />Record payout</button>
                                <button type="button" className="k-btn-ghost !min-h-[32px] !px-3 text-xs" aria-expanded={expanded === rider.driverUserId} onClick={() => setExpanded(expanded === rider.driverUserId ? null : rider.driverUserId)} aria-label={`Payout details of ${label}`}>
                                  Payout details{expanded === rider.driverUserId ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                                </button>
                              </span>
                            </Td>
                          </tr>
                          {daysOpen === rider.driverUserId && (
                            <tr><td colSpan={5} className="border-b border-kraveo-line/60 bg-kraveo-night/40 px-3 py-2.5">
                              <ul className="flex flex-wrap gap-2 text-xs text-kraveo-ink2" aria-label={`Deliveries per day of ${label}`}>
                                {rider.byDay.map((day) => <li key={day.date} className="k-inset px-2.5 py-1"><span className="text-kraveo-ink3">{dateLabel(day.date)}</span> <b className="text-kraveo-ink">{day.deliveries}</b></li>)}
                              </ul>
                            </td></tr>
                          )}
                          {expanded === rider.driverUserId && (
                            <tr><td colSpan={5} className="border-b border-kraveo-line/60 bg-kraveo-night/40 px-3 py-3">
                              <PayoutAccountPanel userId={rider.driverUserId} name={label} kind="rider" onAuthError={onAuthError} />
                            </td></tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </ScrollTable>
              </div>
            )}
          </>
        )}
      </SectionCard>

      <section ref={formRef} aria-label="Record a rider payout" className="k-card space-y-4 p-4 sm:p-5">
        <header>
          <h2 className="font-display text-lg font-bold text-kraveo-ink">Record a payout</h2>
          <p className="mt-0.5 text-sm text-kraveo-ink2">A ledger entry for money you already paid a rider outside the app. It sends no money.</p>
        </header>
        <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Rider" htmlFor="payout-rider" required error={err('driverUserId')}>
              <select id="payout-rider" className="k-select" value={form.driverUserId} onChange={setField('driverUserId')} aria-invalid={Boolean(err('driverUserId'))} aria-describedby="payout-rider-msg" disabled={saving}>
                <option value="">Choose a rider</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Method" htmlFor="payout-method" required error={err('method')}>
              <select id="payout-method" className="k-select" value={form.method} onChange={setField('method')} disabled={saving}>
                {RIDER_PAYOUT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
              </select>
            </Field>
            <Field label="Amount (₹)" htmlFor="payout-amount" required error={err('amount')}>
              <input id="payout-amount" className="k-input" inputMode="decimal" value={form.amount} onChange={setField('amount')} aria-invalid={Boolean(err('amount'))} aria-describedby="payout-amount-msg" autoComplete="off" disabled={saving} />
            </Field>
            <Field label="Reference (UTR, optional)" htmlFor="payout-reference" error={err('reference')} hint="Recommended: the same reference twice is recognised as the same payment.">
              <input id="payout-reference" className="k-input" value={form.reference} onChange={setField('reference')} maxLength={80} aria-invalid={Boolean(err('reference'))} aria-describedby="payout-reference-msg" autoComplete="off" disabled={saving} />
            </Field>
          </div>
          <Field label="Note (optional)" htmlFor="payout-note" error={err('note')}>
            <input id="payout-note" className="k-input" value={form.note} onChange={setField('note')} aria-invalid={Boolean(err('note'))} aria-describedby="payout-note-msg" autoComplete="off" disabled={saving} />
          </Field>
          {formError && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{formError}</p>}
          {formNote && !formError && <p role="status" className="break-words rounded-k-sm border border-kraveo-g400/40 bg-kraveo-g400/10 px-3 py-2 text-sm text-kraveo-ink">{formNote}</p>}
          <button type="submit" className="k-btn-primary" disabled={saving} aria-busy={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Record payout</button>
        </form>
      </section>

      <SectionCard
        title="Payout ledger"
        description="Every payout recorded in the range, newest first."
        actions={(
          <>
            <label className="sr-only" htmlFor="ledger-rider">Rider</label>
            <select id="ledger-rider" className="k-select !min-h-[40px] w-full sm:w-56" value={ledgerRider} onChange={(event) => setLedgerRider(event.target.value)}>
              <option value="">All riders</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </>
        )}
      >
        {ledger.loading && !l && <div role="status" aria-label="Loading payouts" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div>}
        {ledger.error && <ErrorNote message={ledger.error} onRetry={ledger.reload} />}
        {l && !ledger.error && l.items.length === 0 && <p className="text-sm text-kraveo-ink2">No payouts were recorded in this range.</p>}
        {l && !ledger.error && l.items.length > 0 && (
          <div className={ledger.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={ledger.loading}>
            <p className="mb-2 text-xs text-kraveo-ink3" aria-live="polite">{l.total} {l.total === 1 ? 'payout' : 'payouts'}, {rupees(l.totalAmount)} in total</p>
            <ScrollTable caption="Rider payout ledger" minWidth="min-w-[720px]">
              <thead><tr><Th>When</Th><Th>Rider</Th><Th>Method</Th><Th right>Amount</Th><Th>Reference</Th><Th>Note</Th></tr></thead>
              <tbody>
                {l.items.map((p) => (
                  <tr key={p.id}>
                    <Td className="whitespace-nowrap text-xs">{istDateTime(p.createdAt)}</Td>
                    <Td className="max-w-[12rem] break-words font-bold text-kraveo-ink">{p.driverName ?? nameOf(p.driverUserId)}</Td>
                    <Td>{METHOD_LABEL[p.method] ?? p.method}</Td>
                    <Td right><b className="text-kraveo-ink">{rupees(p.amount)}</b></Td>
                    <Td className="max-w-[10rem] break-all text-xs">{p.reference ?? '—'}</Td>
                    <Td className="max-w-[14rem] break-words text-xs">{p.note ?? ''}</Td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </div>
        )}
        {l && <Pager page={page} pages={l.pages} loading={ledger.loading} onPage={(next) => setLedgerPage({ key: ledgerKey, page: next })} />}
      </SectionCard>
      {dialog}
    </div>
  );
};
