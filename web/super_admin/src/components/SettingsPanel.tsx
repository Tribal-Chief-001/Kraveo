import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { apiService, SettingsGroup } from '../services/api';
import { parseSettlementSettings, PayoutProvider } from '../lib/financeParse';
import { validateSettlementSettings, MAX_HOLD_DAYS } from '../lib/financeInput';
import { Switch } from './ui/Switch';
import { asNum, parseFeeLines, RecalcResult } from '../lib/catalogParse';
import {
  CommissionType, DEFAULT_RESTAURANTS_PER_ORDER, FeesForm, MAX_EXTRA_RESTAURANT_FEE, MAX_RESTAURANTS_PER_ORDER, MIN_RESTAURANTS_PER_ORDER, ROUNDING_STEPS, RoundingStep, amountText, isRoundingStep, rupees, validateCommissionSetting, validateFees,
} from '../lib/pricing';
import { Field } from './ui/Field';
import { Skeleton } from './ui/Skeleton';
import { useConfirm } from './ui/ConfirmDialog';
import { useToast } from './ui/Toast';

interface Props {
  onAuthError: (error: unknown) => void;
}

type Raw = Record<string, unknown>;
/** What a save tells the panel: did anything change, and does the server recommend recalculating prices. */
interface Outcome { changed: boolean; recalculateRecommended: boolean; message: string }
type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; raw: Raw };

const plain = (error: unknown): string => (error instanceof Error ? error.message : 'Something went wrong. Please try again.');

/** Loads one settings group and saves it back whole. */
const useGroup = (group: SettingsGroup, onAuthError: (error: unknown) => void) => {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    apiService.fetchSettings(group)
      .then((view) => { if (!cancelled) setLoad({ status: 'ready', raw: view.value }); })
      .catch((error) => {
        if (cancelled) return;
        onAuthError(error);
        setLoad({ status: 'error', message: plain(error) });
      });
    return () => { cancelled = true; };
  }, [group, attempt, onAuthError]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const saved = useCallback((raw: Raw) => setLoad({ status: 'ready', raw }), []);
  return { load, retry, saved };
};

const Card: React.FC<{ title: string; description: string; children: React.ReactNode; className?: string }> = ({ title, description, children, className = '' }) => (
  <section className={`k-card space-y-4 p-5 ${className}`} aria-label={title}>
    <header>
      <h2 className="font-display text-lg font-bold text-kraveo-ink">{title}</h2>
      <p className="mt-0.5 text-sm text-kraveo-ink2">{description}</p>
    </header>
    {children}
  </section>
);

const Loading: React.FC<{ load: Load; onRetry: () => void; children: (raw: Raw) => React.ReactNode }> = ({ load, onRetry, children }) => {
  if (load.status === 'loading') return <div role="status" aria-label="Loading" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div>;
  if (load.status === 'error') {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">
        <span className="min-w-0 break-words">{load.message}</span>
        <button type="button" className="k-btn-ghost !min-h-[36px] shrink-0 !px-3 text-xs" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  return <>{children(load.raw)}</>;
};

const SaveBar: React.FC<{ dirty: boolean; saving: boolean; error: string; onSave: () => void; onUndo: () => void; note?: string }> = ({ dirty, saving, error, onSave, onUndo, note }) => (
  <div className="space-y-2">
    {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{error}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="k-btn-primary" onClick={onSave} disabled={!dirty || saving} aria-busy={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Save</button>
      <button type="button" className="k-btn-ghost" onClick={onUndo} disabled={!dirty || saving}>Undo changes</button>
      {dirty && !saving && <span className="text-xs font-semibold text-kraveo-status-placed">Unsaved changes</span>}
      {!dirty && note && <span className="text-xs text-kraveo-ink3">{note}</span>}
    </div>
  </div>
);

// ───────────────────────────── Fees ─────────────────────────────

let rowCounter = 0;
const newRowId = () => { rowCounter += 1; return rowCounter; };

const feesFormFrom = (raw: Raw): FeesForm => ({
  baseFee: amountText(asNum(raw.baseFee)),
  lines: parseFeeLines(raw.lines).map((line) => ({ rowId: newRowId(), key: line.key, label: line.label, amount: amountText(line.amount) })),
  extraRestaurantFee: amountText(asNum(raw.extraRestaurantFee)),
  freeFeeAbove: amountText(asNum(raw.freeFeeAbove)),
  smallOrderBelow: amountText(asNum(raw.smallOrderBelow)),
  smallOrderFee: amountText(asNum(raw.smallOrderFee)),
  gstOnFeesPercent: amountText(asNum(raw.gstOnFeesPercent)),
  gstOnFoodPercent: amountText(asNum(raw.gstOnFoodPercent)),
  // A stored row from before Docs/22 has no value: the server then uses 3, so the form shows 3.
  maxRestaurantsPerOrder: raw.maxRestaurantsPerOrder === undefined || raw.maxRestaurantsPerOrder === null ? String(DEFAULT_RESTAURANTS_PER_ORDER) : amountText(asNum(raw.maxRestaurantsPerOrder)),
});

const MAX_OPTIONS = Array.from({ length: MAX_RESTAURANTS_PER_ORDER - MIN_RESTAURANTS_PER_ORDER + 1 }, (_, i) => String(MIN_RESTAURANTS_PER_ORDER + i));

/** Plain explanation under the "most restaurants" field, for the value currently chosen. */
const maxRestaurantsHint = (text: string): string => {
  const n = Number(text);
  if (n === 1) return 'Off: customers can order from one restaurant at a time. Orders already placed are not affected.';
  if (Number.isInteger(n) && n > 1 && n <= MAX_RESTAURANTS_PER_ORDER) {
    return `Customers can combine up to ${n} restaurants in one checkout: one payment, one rider, one gate code. If any restaurant cannot accept, the whole order is cancelled and fully refunded. 1 turns this off.`;
  }
  return `Choose a whole number from ${MIN_RESTAURANTS_PER_ORDER} to ${MAX_RESTAURANTS_PER_ORDER}. 1 turns combined orders off.`;
};

const feesKey = (form: FeesForm): string => JSON.stringify({ ...form, lines: form.lines.map(({ label, amount }) => [label, amount]) });

const FeesCard: React.FC<{ raw: Raw; onSaved: (raw: Raw, outcome: Outcome) => void; onDirty: (dirty: boolean) => void; onAuthError: (error: unknown) => void }> = ({ raw, onSaved, onDirty, onAuthError }) => {
  const toast = useToast();
  const [form, setForm] = useState<FeesForm>(() => feesFormFrom(raw));
  const [baseline, setBaseline] = useState(() => feesKey(feesFormFrom(raw)));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const result = useMemo(() => validateFees(form), [form]);
  const dirty = feesKey(form) !== baseline;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const maxHint = maxRestaurantsHint(form.maxRestaurantsPerOrder);

  const field = (key: keyof Omit<FeesForm, 'lines'>) => (event: React.ChangeEvent<HTMLInputElement>) => { setForm((f) => ({ ...f, [key]: event.target.value })); setError(''); };
  const err = (key: keyof Omit<FeesForm, 'lines'>) => (touched ? (result.errors[key] as string | undefined) : undefined);
  const input = (key: keyof Omit<FeesForm, 'lines'>, id: string) => (
    <input id={id} className="k-input" inputMode="decimal" value={form[key]} onChange={field(key)} aria-invalid={Boolean(err(key))} aria-describedby={`${id}-msg`} autoComplete="off" />
  );
  const setLine = (rowId: number, patch: Partial<{ label: string; amount: string }>) => { setForm((f) => ({ ...f, lines: f.lines.map((line) => (line.rowId === rowId ? { ...line, ...patch } : line)) })); setError(''); };

  const save = async () => {
    setTouched(true);
    if (!result.ok || !result.value || savingRef.current) { if (!result.ok) setError('Fix the highlighted fields first.'); return; }
    savingRef.current = true; setSaving(true); setError('');
    try {
      const saved = await apiService.saveSettings('fees', { ...raw, ...result.value });
      const next = feesFormFrom(saved.value);
      setForm(next); setBaseline(feesKey(next)); setTouched(false);
      onSaved(saved.value, saved);
      toast.success('Fees saved', 'New orders use these fees.');
    } catch (failure) {
      onAuthError(failure);
      setError(plain(failure));
    } finally { savingRef.current = false; setSaving(false); }
  };
  const undo = () => { const original = feesFormFrom(raw); setForm(original); setBaseline(feesKey(original)); setTouched(false); setError(''); };

  const linesTotalLabel = form.lines.length > 0 ? `Lines add up to ${rupees(result.lineTotal)}` : '';

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="All-in fee per order (₹)" htmlFor="fee-base" required error={err('baseFee')} hint="One line for the customer: delivery, GST, packaging and the restaurant charge together.">{input('baseFee', 'fee-base')}</Field>
        <Field label="Extra fee for each additional restaurant (₹)" htmlFor="fee-extra" required error={err('extraRestaurantFee')} hint={`Added once for every restaurant after the first in a combined order (0 to ${MAX_EXTRA_RESTAURANT_FEE}). Example: ₹15 and 3 restaurants adds ₹30 on top of the all-in fee. Not used while combined orders are off.`}>{input('extraRestaurantFee', 'fee-extra')}</Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Most restaurants in one order" htmlFor="fee-max-restaurants" required error={err('maxRestaurantsPerOrder')} hint={maxHint}>
          <select
            id="fee-max-restaurants"
            className="k-select"
            value={form.maxRestaurantsPerOrder}
            onChange={(event) => { setForm((f) => ({ ...f, maxRestaurantsPerOrder: event.target.value })); setError(''); }}
            aria-invalid={Boolean(err('maxRestaurantsPerOrder'))}
            aria-describedby="fee-max-restaurants-msg"
          >
            {/* A stored value outside 1-5 stays visible (and fails validation) instead of silently showing another number. */}
            {!MAX_OPTIONS.includes(form.maxRestaurantsPerOrder) && <option value={form.maxRestaurantsPerOrder}>{form.maxRestaurantsPerOrder || 'Not set'} (not allowed)</option>}
            {MAX_OPTIONS.map((value) => <option key={value} value={value}>{value === '1' ? '1 (combined orders off)' : value}</option>)}
          </select>
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="k-label mb-1">Named lines (optional, for the records)</legend>
        <p className="text-xs text-kraveo-ink3">The customer still sees one fee. If you add lines, they must add up to the all-in fee exactly.</p>
        {form.lines.map((line, index) => {
          const lineErr = touched ? result.errors.lineErrors?.[line.rowId] : undefined;
          return (
            <div key={line.rowId} className="grid grid-cols-[1fr_7rem_auto] items-start gap-2">
              <Field label={`Line ${index + 1} name`} htmlFor={`fee-line-label-${line.rowId}`} error={lineErr?.label}>
                <input id={`fee-line-label-${line.rowId}`} className="k-input" value={line.label} maxLength={40} onChange={(e) => setLine(line.rowId, { label: e.target.value })} aria-invalid={Boolean(lineErr?.label)} aria-describedby={`fee-line-label-${line.rowId}-msg`} autoComplete="off" />
              </Field>
              <Field label="₹" htmlFor={`fee-line-amount-${line.rowId}`} error={lineErr?.amount}>
                <input id={`fee-line-amount-${line.rowId}`} className="k-input" inputMode="decimal" value={line.amount} onChange={(e) => setLine(line.rowId, { amount: e.target.value })} aria-invalid={Boolean(lineErr?.amount)} aria-describedby={`fee-line-amount-${line.rowId}-msg`} autoComplete="off" />
              </Field>
              <button type="button" className="k-icon-btn mt-[1.45rem]" aria-label={`Remove line ${index + 1}`} onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.rowId !== line.rowId) }))}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="k-btn-ghost !min-h-[36px] text-xs" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, { rowId: newRowId(), label: '', amount: '' }] }))}><Plus className="h-4 w-4" aria-hidden="true" />Add a line</button>
          {linesTotalLabel && <span className={`text-xs font-semibold ${touched && result.errors.lines ? 'text-kraveo-danger' : 'text-kraveo-ink2'}`} aria-live="polite">{linesTotalLabel}</span>}
        </div>
        {touched && result.errors.lines && <p role="alert" className="text-xs font-semibold text-kraveo-danger">{result.errors.lines}</p>}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Free delivery above (₹, 0 = off)" htmlFor="fee-free" error={err('freeFeeAbove')} hint="Orders with food worth at least this pay no fee.">{input('freeFeeAbove', 'fee-free')}</Field>
        <div className="hidden sm:block" />
        <Field label="Small order below (₹, 0 = off)" htmlFor="fee-small-below" error={err('smallOrderBelow')}>{input('smallOrderBelow', 'fee-small-below')}</Field>
        <Field label="Small order fee (₹)" htmlFor="fee-small" error={err('smallOrderFee')} hint="Added when the food total is under the limit.">{input('smallOrderFee', 'fee-small')}</Field>
        <Field label="GST on fees (%) – for records" htmlFor="fee-gst-fees" error={err('gstOnFeesPercent')} hint="Information only until the accountant decides.">{input('gstOnFeesPercent', 'fee-gst-fees')}</Field>
        <Field label="GST on food (%) – for records" htmlFor="fee-gst-food" error={err('gstOnFoodPercent')} hint="Information only.">{input('gstOnFoodPercent', 'fee-gst-food')}</Field>
      </div>
      <SaveBar dirty={dirty} saving={saving} error={error} onSave={save} onUndo={undo} />
    </div>
  );
};

// ───────────────────────────── Commission ─────────────────────────────

const CommissionCard: React.FC<{ raw: Raw; onSaved: (raw: Raw, outcome: Outcome) => void; onDirty: (dirty: boolean) => void; onAuthError: (error: unknown) => void }> = ({ raw, onSaved, onDirty, onAuthError }) => {
  const toast = useToast();
  const initialType: CommissionType = raw.type === 'FLAT' ? 'FLAT' : 'PERCENT';
  const [type, setType] = useState<CommissionType>(initialType);
  const [value, setValue] = useState(amountText(asNum(raw.value)));
  const [baseline, setBaseline] = useState(`${initialType}|${amountText(asNum(raw.value))}`);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const checked = validateCommissionSetting(type, value);
  const dirty = `${type}|${value.trim()}` !== baseline;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const save = async () => {
    setTouched(true);
    if (!checked.ok || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      const saved = await apiService.saveSettings('commission', { ...raw, type: checked.value.type, value: checked.value.value });
      const stored = saved.value;
      const t: CommissionType = stored.type === 'FLAT' ? 'FLAT' : stored.type === 'PERCENT' ? 'PERCENT' : checked.value.type;
      const v = amountText(asNum(stored.value) ?? checked.value.value);
      setType(t); setValue(v); setBaseline(`${t}|${v}`); setTouched(false);
      onSaved(stored, saved);
      toast.success('Commission saved', saved.message || 'Dish prices change when you run Recalculate prices below.');
    } catch (failure) {
      onAuthError(failure);
      setError(plain(failure));
    } finally { savingRef.current = false; setSaving(false); }
  };
  const undo = () => { const t: CommissionType = initialType; setType(t); setValue(amountText(asNum(raw.value))); setBaseline(`${t}|${amountText(asNum(raw.value))}`); setTouched(false); setError(''); };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Commission type" htmlFor="commission-type">
          <select id="commission-type" className="k-select" value={type} onChange={(e) => { setType(e.target.value as CommissionType); setError(''); }}>
            <option value="PERCENT">Percent of the restaurant price</option>
            <option value="FLAT">Flat rupee amount per dish</option>
          </select>
        </Field>
        <Field label={type === 'PERCENT' ? 'Percent (%)' : 'Amount per dish (₹)'} htmlFor="commission-value" required error={touched && !checked.ok ? checked.message : undefined}>
          <input id="commission-value" className="k-input" inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); setError(''); }} aria-invalid={touched && !checked.ok} aria-describedby="commission-value-msg" autoComplete="off" />
        </Field>
      </div>
      <p className="text-xs text-kraveo-ink3">A restaurant or a single dish can have its own commission; the most specific one wins. This is the default for everything else.</p>
      <SaveBar dirty={dirty} saving={saving} error={error} onSave={save} onUndo={undo} />
    </div>
  );
};

// ───────────────────────────── Rounding ─────────────────────────────

const STEP_LABEL: Record<RoundingStep, string> = { 0: 'No rounding', 1: 'Round up to the next ₹1', 2: 'Round up to the next ₹2', 5: 'Round up to the next ₹5', 10: 'Round up to the next ₹10' };

const RoundingCard: React.FC<{ raw: Raw; onSaved: (raw: Raw, outcome: Outcome) => void; onDirty: (dirty: boolean) => void; onAuthError: (error: unknown) => void }> = ({ raw, onSaved, onDirty, onAuthError }) => {
  const toast = useToast();
  const current = isRoundingStep(raw.step) ? raw.step : null;
  const [step, setStep] = useState<RoundingStep | null>(current);
  const [baseline, setBaseline] = useState<RoundingStep | null>(current);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const dirty = step !== baseline;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const save = async () => {
    if (step === null || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      const saved = await apiService.saveSettings('rounding', { ...raw, step });
      const next = isRoundingStep(saved.value.step) ? saved.value.step : step;
      setStep(next); setBaseline(next);
      onSaved(saved.value, saved);
      toast.success('Rounding saved', saved.message || 'Dish prices change when you run Recalculate prices below.');
    } catch (failure) {
      onAuthError(failure);
      setError(plain(failure));
    } finally { savingRef.current = false; setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Rounding step" className="space-y-2">
        {ROUNDING_STEPS.map((option) => (
          <label key={option} className={`k-inset flex cursor-pointer items-center gap-3 px-4 py-3 text-sm font-bold ${step === option ? 'border-kraveo-g400/60 text-kraveo-g300' : 'text-kraveo-ink'}`}>
            <input type="radio" name="rounding-step" className="h-4 w-4 accent-kraveo-g400" checked={step === option} onChange={() => { setStep(option); setError(''); }} />
            {STEP_LABEL[option]}
          </label>
        ))}
      </div>
      {step === null && <p className="text-xs text-kraveo-danger">The server did not report a rounding step. Pick one and save.</p>}
      <p className="text-xs text-kraveo-ink3">The customer price is rounded up to this step. The extra rupees count as Kraveo commission.</p>
      <SaveBar dirty={dirty} saving={saving} error={error} onSave={save} onUndo={() => { setStep(baseline); setError(''); }} />
    </div>
  );
};

// ───────────────────────────── Recalculate ─────────────────────────────

const RecalcCard: React.FC<{ settingsVersion: number; recommended: boolean; onSettled: () => void; unsaved: boolean; onAuthError: (error: unknown) => void }> = ({ settingsVersion, recommended, onSettled, unsaved, onAuthError }) => {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [preview, setPreview] = useState<RecalcResult | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'apply'>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState('');

  // Settings changed after the preview: the number on screen is no longer true.
  useEffect(() => { setPreview(null); setError(''); }, [settingsVersion]);

  const runPreview = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy('preview'); setError('');
    try {
      const result = await apiService.recalculatePrices(true);
      setPreview(result);
      if (result.changed === 0) onSettled(); // nothing is out of date any more
      if (result.changed === null) setError('The server did not say how many dishes would change, so prices cannot be recalculated from here.');
    } catch (failure) {
      onAuthError(failure);
      setPreview(null);
      setError(plain(failure));
    } finally { busyRef.current = false; setBusy(null); }
  };

  const apply = async () => {
    if (busyRef.current || !preview || preview.changed === null || preview.changed <= 0) return;
    const count = preview.changed;
    const ok = await confirm({
      title: `Change the price of ${count} ${count === 1 ? 'dish' : 'dishes'}?`,
      message: 'Customers see the new prices at once. Orders already placed keep the prices they were placed with. This cannot be undone with one click.',
      confirmLabel: 'Recalculate prices',
      danger: true,
    });
    if (!ok || busyRef.current) return;
    busyRef.current = true; setBusy('apply'); setError('');
    try {
      const result = await apiService.recalculatePrices(false);
      toast.success('Prices recalculated', result.changed !== null ? `${result.changed} ${result.changed === 1 ? 'dish' : 'dishes'} updated.` : 'The server did not say how many dishes changed.');
      setPreview(null);
      onSettled();
    } catch (failure) {
      onAuthError(failure);
      setError(plain(failure));
    } finally { busyRef.current = false; setBusy(null); }
  };

  const changed = preview?.changed ?? null;
  return (
    <div className="space-y-4">
      {recommended && !unsaved && <p role="status" className="rounded-k-sm border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 px-3 py-2 text-sm text-kraveo-ink">Existing dish prices keep their old value until you recalculate. Preview the change below.</p>}
      {unsaved && <p className="rounded-k-sm border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 px-3 py-2 text-sm text-kraveo-ink">Save your commission or rounding changes first. The recalculation uses the saved settings.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="k-btn-ghost" onClick={runPreview} disabled={busy !== null || unsaved} aria-busy={busy === 'preview'}>{busy === 'preview' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Preview changes</button>
        <button type="button" className="k-btn-danger" onClick={apply} disabled={busy !== null || unsaved || changed === null || changed <= 0} aria-busy={busy === 'apply'}>{busy === 'apply' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Recalculate prices{changed ? ` (${changed})` : ''}</button>
      </div>
      {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{error}</p>}
      {preview && changed !== null && (
        <div className="k-inset space-y-2 p-4" aria-live="polite" data-testid="recalc-preview">
          <p className="text-sm text-kraveo-ink">
            {changed === 0 ? 'No dish would change. Prices already match the settings.' : <><b className="tabular-nums">{changed}</b>{preview.total !== null ? <> of <b className="tabular-nums">{preview.total}</b></> : null} {changed === 1 && preview.total === null ? 'dish' : 'dishes'} would change price.</>}
          </p>
          {preview.truncated && <p className="text-xs font-semibold text-kraveo-status-placed">Only the first changes are listed. The count above is complete.</p>}
          {preview.samples.length > 0 && (
            <ul className="space-y-1 text-xs text-kraveo-ink2">
              {preview.samples.map((sample, index) => <li key={index} className="flex justify-between gap-3"><span className="min-w-0 break-words">{sample.name}{sample.vendorName ? ` (${sample.vendorName})` : ''}</span><span className="shrink-0 tabular-nums">{rupees(sample.from)} → {rupees(sample.to)}</span></li>)}
            </ul>
          )}
        </div>
      )}
      <p className="text-xs text-kraveo-ink3">Preview first: nothing changes until you confirm. Dishes also get the right price when they are approved or edited.</p>
      {dialog}
    </div>
  );
};

// ───────────────────────────── Settlements ─────────────────────────────

type Providers = { status: 'loading' } | { status: 'error' } | { status: 'ready'; list: PayoutProvider[] };

const SettlementCard: React.FC<{ raw: Raw; onSaved: (raw: Raw) => void; onAuthError: (error: unknown) => void }> = ({ raw, onSaved, onAuthError }) => {
  const toast = useToast();
  const initial = parseSettlementSettings(raw);
  const toForm = (v: ReturnType<typeof parseSettlementSettings>) => ({ time: v.time ?? '', mode: v.mode ?? '', autoCreate: v.autoCreate ?? false, holdDays: v.holdDays === null ? '' : String(v.holdDays) });
  const [form, setForm] = useState(() => toForm(initial));
  const [baseline, setBaseline] = useState(() => JSON.stringify(toForm(initial)));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState<Providers>({ status: 'loading' });
  const checked = validateSettlementSettings(form);
  const errors = !checked.ok ? checked.errors : {};
  const dirty = JSON.stringify(form) !== baseline;

  useEffect(() => {
    let cancelled = false;
    apiService.fetchPayoutProviders()
      .then((list) => { if (!cancelled) setProviders({ status: 'ready', list }); })
      .catch((failure) => { if (cancelled) return; onAuthError(failure); setProviders({ status: 'error' }); });
    return () => { cancelled = true; };
  }, [onAuthError]);

  const razorpayx = providers.status === 'ready' ? providers.list.find((p) => p.name === 'razorpayx') : undefined;
  // Automatic payout is only offered when the server says a provider that can send money is switched on.
  const autoBlocked = providers.status === 'ready' && !razorpayx?.enabled;

  const save = async () => {
    setTouched(true);
    if (!checked.ok || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      const saved = await apiService.saveSettings('settlement', { ...checked.value });
      const next = toForm(parseSettlementSettings(saved.value));
      setForm(next); setBaseline(JSON.stringify(next)); setTouched(false);
      onSaved(saved.value);
      toast.success('Settlement settings saved', saved.message || 'The daily job uses these settings from now on.');
    } catch (failure) {
      onAuthError(failure);
      setError(plain(failure)); // the server's own words, e.g. "Automatic payout is not available yet"
    } finally { savingRef.current = false; setSaving(false); }
  };
  const undo = () => { setForm(JSON.parse(baseline)); setTouched(false); setError(''); };
  const shown = (key: 'time' | 'mode' | 'holdDays') => (touched ? (errors as Record<string, string>)[key] : undefined);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Daily settlement time (India time, HH:MM)" htmlFor="settle-time" required error={shown('time')} hint="Orders delivered up to this time are grouped into that day's settlements.">
          <input id="settle-time" className="k-input" inputMode="numeric" placeholder="22:00" value={form.time} onChange={(e) => { setForm((f) => ({ ...f, time: e.target.value })); setError(''); }} aria-invalid={Boolean(shown('time'))} aria-describedby="settle-time-msg" autoComplete="off" />
        </Field>
        <Field label={`Hold days (0 to ${MAX_HOLD_DAYS})`} htmlFor="settle-hold" required error={shown('holdDays')} hint="Orders must be at least this many days old before they are settled.">
          <input id="settle-hold" className="k-input" inputMode="numeric" value={form.holdDays} onChange={(e) => { setForm((f) => ({ ...f, holdDays: e.target.value })); setError(''); }} aria-invalid={Boolean(shown('holdDays'))} aria-describedby="settle-hold-msg" autoComplete="off" />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="k-label mb-1">How settlements are paid</legend>
        <div role="radiogroup" aria-label="Payout mode" className="space-y-2">
          <label className={`k-inset flex cursor-pointer items-start gap-3 px-4 py-3 text-sm ${form.mode === 'MANUAL_PAYOUT' ? 'border-kraveo-g400/60' : ''}`}>
            <input type="radio" name="settle-mode" className="mt-0.5 h-4 w-4 accent-kraveo-g400" checked={form.mode === 'MANUAL_PAYOUT'} onChange={() => { setForm((f) => ({ ...f, mode: 'MANUAL_PAYOUT' })); setError(''); }} />
            <span><b className="text-kraveo-ink">Manual payout</b><span className="block text-xs text-kraveo-ink3">You pay by bank or UPI and record the reference on each settlement.</span></span>
          </label>
          <label className={`k-inset flex items-start gap-3 px-4 py-3 text-sm ${autoBlocked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'} ${form.mode === 'AUTO_PAYOUT' ? 'border-kraveo-g400/60' : ''}`}>
            <input type="radio" name="settle-mode" className="mt-0.5 h-4 w-4 accent-kraveo-g400" checked={form.mode === 'AUTO_PAYOUT'} disabled={autoBlocked} aria-describedby="settle-auto-note" onChange={() => { setForm((f) => ({ ...f, mode: 'AUTO_PAYOUT' })); setError(''); }} />
            <span><b className="text-kraveo-ink">Automatic payout</b><span className="block text-xs text-kraveo-ink3">Money is sent through a payout provider.</span></span>
          </label>
        </div>
        <p id="settle-auto-note" className={`text-xs ${autoBlocked ? 'font-semibold text-kraveo-status-placed' : 'text-kraveo-ink3'}`}>
          {providers.status === 'loading' && 'Checking which payout providers are available.'}
          {providers.status === 'error' && 'The payout providers could not be checked. If automatic payout is not available the server will refuse to save it.'}
          {providers.status === 'ready' && (autoBlocked ? `Automatic payout is not available: ${razorpayx?.reason ?? 'no payout provider is configured.'} Use manual payout until the provider is connected.` : 'A payout provider is connected.')}
        </p>
        {shown('mode') && <p role="alert" className="text-xs font-semibold text-kraveo-danger">{shown('mode')}</p>}
      </fieldset>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-kraveo-ink">Create settlements every day</p>
          <p className="text-xs text-kraveo-ink3">When off, nothing is created until you press Create settlements now in Finance.</p>
        </div>
        <Switch checked={form.autoCreate} onChange={() => { setForm((f) => ({ ...f, autoCreate: !f.autoCreate })); setError(''); }} label="Create settlements every day" />
      </div>
      <SaveBar dirty={dirty} saving={saving} error={error} onSave={save} onUndo={undo} />
    </div>
  );
};

// ───────────────────────────── Panel ─────────────────────────────

export const SettingsPanel: React.FC<Props> = ({ onAuthError }) => {
  const fees = useGroup('fees', onAuthError);
  const commission = useGroup('commission', onAuthError);
  const rounding = useGroup('rounding', onAuthError);
  const settlement = useGroup('settlement', onAuthError);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [pricingChanged, setPricingChanged] = useState(0);
  const [recommended, setRecommended] = useState(false);
  const markDirty = (group: string) => (value: boolean) => setDirty((current) => (current[group] === value ? current : { ...current, [group]: value }));
  const dirtyFees = useMemo(() => markDirty('fees'), []);
  const dirtyCommission = useMemo(() => markDirty('commission'), []);
  const dirtyRounding = useMemo(() => markDirty('rounding'), []);

  const onPricingSaved = (save: (raw: Raw) => void) => (raw: Raw, outcome: Outcome) => {
    save(raw);
    if (outcome.changed) setPricingChanged((n) => n + 1); // an older preview no longer describes the new settings
    if (outcome.recalculateRecommended) setRecommended(true);
  };
  const settled = useCallback(() => setRecommended(false), []);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Card title="Fees" description="What the customer pays on top of the food. All amounts come from here, not from the app code.">
        <Loading load={fees.load} onRetry={fees.retry}>{(raw) => <FeesCard raw={raw} onSaved={fees.saved} onDirty={dirtyFees} onAuthError={onAuthError} />}</Loading>
      </Card>
      <Card title="Default commission" description="Kraveo's share on top of the restaurant's price, unless the restaurant or the dish has its own.">
        <Loading load={commission.load} onRetry={commission.retry}>{(raw) => <CommissionCard raw={raw} onSaved={onPricingSaved(commission.saved)} onDirty={dirtyCommission} onAuthError={onAuthError} />}</Loading>
      </Card>
      <Card title="Price rounding" description="Customer prices are rounded up to a tidy number.">
        <Loading load={rounding.load} onRetry={rounding.retry}>{(raw) => <RoundingCard raw={raw} onSaved={onPricingSaved(rounding.saved)} onDirty={dirtyRounding} onAuthError={onAuthError} />}</Loading>
      </Card>
      <Card title="Recalculate prices" description="After changing the default commission, a restaurant's commission or the rounding, apply the new prices to the dishes already on the menu.">
        <RecalcCard settingsVersion={pricingChanged} recommended={recommended} onSettled={settled} unsaved={Boolean(dirty.commission || dirty.rounding)} onAuthError={onAuthError} />
      </Card>
      <Card title="Settlements" description="When restaurant settlements are created and how they are paid. Changes apply from the next daily run.">
        <Loading load={settlement.load} onRetry={settlement.retry}>{(raw) => <SettlementCard raw={raw} onSaved={settlement.saved} onAuthError={onAuthError} />}</Loading>
      </Card>
    </div>
  );
};

