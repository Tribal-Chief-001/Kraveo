import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, FileUp, Loader2 } from 'lucide-react';
import { Vendor } from '../types';
import { ApiError, ImportInvalidError, apiService } from '../services/api';
import { IMPORT_ERROR_HINT, ImportReport, ImportRowReport, importableCount, skipReasonText } from '../lib/catalogBulkParse';
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, MENU_PRICE_TEMPLATE_FILENAME, MenuCsvResult, PricesAre, TEMPLATE_FILENAME, menuTemplateCsv, parseMenuCsv } from '../lib/menuCsv';
import { useGlobalCommission } from '../lib/useGlobalCommission';
import { saveBlob } from '../lib/download';
import { commissionLabel, rupees } from '../lib/pricing';
import { errorText } from '../lib/errors';
import { Drawer } from './ui/Drawer';
import { Field } from './ui/Field';
import { useToast } from './ui/Toast';

interface Props {
  vendors: Vendor[];
  /** The restaurant filter of the page, when one is chosen. */
  initialVendorId?: string;
  onClose: () => void;
  /** Dishes were created or updated: the list should reload. */
  onImported: (report: ImportReport) => void;
  onAuthError: (error: unknown) => void;
}

type Duplicate = 'SKIP' | 'UPDATE';
type Step = 'file' | 'preview' | 'done';

/** What the preview shows for one row: the server's verdict, overridden to "invalid" when the dashboard itself found a problem. */
interface ViewRow {
  index: number;
  line: number;
  name: string;
  category: string;
  vendorPrice: string;
  /** Docs/26: the menu price typed in the file (the customer's price), or null when the row uses a restaurant price. */
  menuPrice: string | null;
  /** The place on the menu typed in the file, or null. */
  position: string | null;
  /** The restaurant's share the server worked out (or was given), null when the row is not valid. */
  restaurantGets: number | null;
  hints: string[];
  action: ImportRowReport['action'];
  reason: string | null;
  computedPrice: number | null;
  problems: string[];
}

const ACTION_LABEL: Record<ImportRowReport['action'], string> = { create: 'Add', update: 'Update', skip: 'Skip', invalid: 'Not valid' };
const ACTION_STYLE: Record<ImportRowReport['action'], string> = {
  create: 'bg-kraveo-g400/15 text-kraveo-g300',
  update: 'bg-kraveo-status-pickedUp/15 text-kraveo-status-pickedUp',
  skip: 'bg-kraveo-line text-kraveo-ink2',
  invalid: 'bg-kraveo-danger/15 text-kraveo-danger',
};

/** Merges what was read from the file with the server's dry-run report, row by row. */
export const buildViewRows = (parsed: MenuCsvResult, report: ImportReport): ViewRow[] => parsed.rows.map((row, index) => {
  const server = report.rows.find((r) => r.index === index);
  const problems: string[] = row.issues.map((i) => i.message);
  const hints: string[] = [];
  (server?.errors ?? []).forEach((e) => {
    if (!problems.includes(e.message)) problems.push(e.message);
    const hint = e.code ? IMPORT_ERROR_HINT[e.code] : undefined;
    if (hint && !hints.includes(hint)) hints.push(hint);
  });
  const shownNumber = (value: number | string | undefined): string | null => (value === undefined ? null : typeof value === 'number' ? rupees(value) : String(value));
  const locallyBad = row.issues.length > 0;
  return {
    index,
    line: row.line,
    name: row.input.name || '(no name)',
    category: row.input.category || '-',
    vendorPrice: shownNumber(row.input.vendorPrice) ?? '-',
    menuPrice: shownNumber(row.input.menuPrice),
    position: row.input.position === undefined ? null : String(row.input.position),
    restaurantGets: locallyBad ? null : server?.vendorPrice ?? null,
    hints,
    action: locallyBad || !server ? 'invalid' : server.action,
    reason: server?.reason ?? null,
    computedPrice: locallyBad ? null : server?.computedPrice ?? null,
    problems: problems.length === 0 && (locallyBad || !server) ? ['This row could not be checked.'] : problems,
  };
});

export const tally = (rows: ViewRow[]) => ({
  create: rows.filter((r) => r.action === 'create').length,
  update: rows.filter((r) => r.action === 'update').length,
  skip: rows.filter((r) => r.action === 'skip').length,
  invalid: rows.filter((r) => r.action === 'invalid').length,
});

export const ImportMenuWizard: React.FC<Props> = ({ vendors, initialVendorId = '', onClose, onImported, onAuthError }) => {
  const toast = useToast();
  const [step, setStep] = useState<Step>('file');
  const [vendorId, setVendorId] = useState(initialVendorId);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [duplicate, setDuplicate] = useState<Duplicate>('SKIP');
  const [parsed, setParsed] = useState<MenuCsvResult | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [applied, setApplied] = useState<ImportReport | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [showOnly, setShowOnly] = useState<'all' | 'problems'>('all');
  const busyRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const seq = useRef(0);
  const sorted = useMemo(() => [...vendors].sort((a, b) => a.name.localeCompare(b.name)), [vendors]);
  const vendor = vendors.find((v) => v.id === vendorId) ?? null;
  // Docs/26: is this restaurant on "Cut from sale"? Its own rule, else the default in Settings (asked only when needed). A dish can still have its own rule: the server checks every row.
  const globalRule = useGlobalCommission(vendor !== null && vendor.commissionType === null);
  const rule = vendor === null || vendor.commissionType === undefined ? null : vendor.commissionType ?? globalRule?.type ?? null;
  const ruleValue = vendor?.commissionType ? vendor.commissionValue : globalRule?.value;
  const isCut = rule === 'CUT';
  const [pricesChoice, setPricesChoice] = useState<PricesAre | null>(null);
  const pricesAre: PricesAre = pricesChoice ?? (isCut ? 'menu' : 'vendor');

  useEffect(() => { headingRef.current?.focus(); }, [step]);

  const download = (kind: 'vendor' | 'menu' = 'vendor') => saveBlob(new Blob([`﻿${menuTemplateCsv(kind)}`], { type: 'text/csv;charset=utf-8' }), kind === 'menu' ? MENU_PRICE_TEMPLATE_FILENAME : TEMPLATE_FILENAME);

  const readFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(''); setProblems([]);
    if (file.size > MAX_IMPORT_FILE_BYTES) { setError(`That file is ${Math.round(file.size / 1024)} KB. A menu file can be at most ${MAX_IMPORT_FILE_BYTES / 1024} KB, which is far more than ${MAX_IMPORT_ROWS} dishes need. Check that it is the right file.`); return; }
    try {
      const content = await file.text();
      setText(content); setFileName(file.name);
    } catch {
      setError('That file could not be read. Try saving it as CSV (UTF-8) again, or paste the rows instead.');
    }
  };

  /** Reads the text and asks the server for a dry run (nothing is written). */
  const check = async (policy: Duplicate = duplicate) => {
    if (busyRef.current) return;
    if (!vendorId) { setError('Choose the restaurant this menu belongs to.'); return; }
    const result = parseMenuCsv(text, isCut ? { pricesAre } : {});
    setError(''); setProblems(result.fileProblems);
    if (result.fileProblems.length > 0) { setParsed(null); return; }
    busyRef.current = true;
    setBusy('preview');
    const mine = ++seq.current;
    try {
      const dry = await apiService.importMenu(vendorId, result.rows.map((r) => r.input), { dryRun: true, onDuplicate: policy });
      if (mine !== seq.current) return;
      setParsed(result); setReport(dry); setStep('preview'); setShowOnly('all');
    } catch (failure) {
      onAuthError(failure);
      setError(errorText(failure));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const changePolicy = (policy: Duplicate) => {
    setDuplicate(policy);
    if (step === 'preview') void check(policy);
  };

  const view = useMemo(() => (parsed && report ? buildViewRows(parsed, report) : []), [parsed, report]);
  const counts = tally(view);
  const importable = counts.create + counts.update;
  // The server's own count and the merged view must agree before the button is offered: a mismatch means something changed under us.
  const canImport = step === 'preview' && report !== null && counts.invalid === 0 && report.summary.invalid === 0 && importable > 0 && importableCount(report) === importable;

  const apply = async () => {
    if (!canImport || !parsed || busyRef.current) return;
    busyRef.current = true;
    setBusy('import'); setError('');
    try {
      const done = await apiService.importMenu(vendorId, parsed.rows.map((r) => r.input), { dryRun: false, onDuplicate: duplicate });
      setApplied(done); setStep('done');
      onImported(done);
      toast.success('Menu imported', done.message || `${done.summary.create} added, ${done.summary.update} updated.`);
    } catch (failure) {
      onAuthError(failure);
      if (failure instanceof ImportInvalidError) {
        // Nothing was written. Show what the server found now so the admin can fix the file.
        if (failure.report) setReport(failure.report);
        setError(failure.message);
      } else {
        setError(errorText(failure));
      }
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const shownRows = showOnly === 'problems' ? view.filter((r) => r.action === 'invalid') : view;
  const title = step === 'done' ? 'Import finished' : 'Import menu';
  const subtitle = vendor ? vendor.name : 'Add many dishes from a spreadsheet file';

  const footer = step === 'file' ? (
    <div className="flex gap-3 pb-4">
      <button type="button" className="k-btn-ghost flex-1" onClick={onClose} disabled={busy !== null}>Cancel</button>
      <button type="button" className="k-btn-primary flex-1" onClick={() => void check()} disabled={busy !== null || text.trim() === ''} aria-busy={busy === 'preview'}>
        {busy === 'preview' ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Checking…</> : 'Check the menu'}
      </button>
    </div>
  ) : step === 'preview' ? (
    <div className="space-y-2 pb-4">
      {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{error}</p>}
      <div className="flex gap-3">
        <button type="button" className="k-btn-ghost" onClick={() => { setStep('file'); setError(''); }} disabled={busy !== null}><ArrowLeft className="h-4 w-4" aria-hidden="true" />Back</button>
        <button type="button" className="k-btn-primary flex-1" onClick={() => void apply()} disabled={!canImport || busy !== null} aria-busy={busy === 'import'}>
          {busy === 'import' ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Importing…</> : importable > 0 ? `Import ${importable} ${importable === 1 ? 'dish' : 'dishes'}` : 'Nothing to import'}
        </button>
      </div>
    </div>
  ) : (
    <div className="pb-4"><button type="button" className="k-btn-primary w-full" onClick={onClose}>Done</button></div>
  );

  return (
    <Drawer open onClose={() => { if (busy === null) onClose(); }} title={title} subtitle={subtitle} icon={FileUp} wide footer={footer}>
      <div className="space-y-5">
        <ol className="flex flex-wrap gap-2 text-xs font-bold text-kraveo-ink3" aria-label="Steps">
          {(['file', 'preview', 'done'] as Step[]).map((s, i) => (
            <li key={s} aria-current={step === s ? 'step' : undefined} className={`rounded-full border px-3 py-1 ${step === s ? 'border-kraveo-g400/60 bg-kraveo-g400/15 text-kraveo-g300' : 'border-kraveo-line'}`}>{i + 1}. {s === 'file' ? 'Choose the file' : s === 'preview' ? 'Check' : 'Done'}</li>
          ))}
        </ol>

        {step === 'file' && (
          <>
            <h3 ref={headingRef} tabIndex={-1} className="sr-only">Step 1 of 3: choose the restaurant and the menu file</h3>
            {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{error}</p>}
            {problems.length > 0 && (
              <div role="alert" className="space-y-1 rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">
                <p className="font-bold">This file cannot be imported yet:</p>
                <ul className="list-disc pl-5">{problems.map((p) => <li key={p} className="break-words">{p}</li>)}</ul>
              </div>
            )}
            <Field label="Restaurant" htmlFor="import-vendor" required>
              <select id="import-vendor" className="k-select" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">Choose a restaurant…</option>
                {sorted.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>

            <section className="k-inset space-y-3 p-4" aria-label="The file">
              <p className="text-sm text-kraveo-ink2">One dish per line. Columns: <b>name</b>, <b>category</b>, <b>vendorPrice</b> (what the restaurant gets), and optionally <b>isVeg</b>, <b>description</b>, <b>imageUrl</b>, <b>isAvailable</b>. At most {MAX_IMPORT_ROWS} dishes at a time. The category must already exist in the Categories tab.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="k-btn-ghost" onClick={() => download('vendor')}><Download className="h-4 w-4" aria-hidden="true" />Download the template</button>
                {rule !== 'PERCENT' && rule !== 'FLAT' && <button type="button" className="k-btn-ghost" onClick={() => download('menu')}><Download className="h-4 w-4" aria-hidden="true" />Template with menuPrice</button>}
                <label className="k-btn-ghost cursor-pointer focus-within:ring-2 focus-within:ring-kraveo-g400/60">
                  <FileUp className="h-4 w-4" aria-hidden="true" />Choose a CSV file
                  <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values" className="sr-only" onChange={readFile} data-testid="import-file" />
                </label>
              </div>
              <div className="space-y-2 rounded-k-sm border border-kraveo-line bg-kraveo-surface2/60 px-3 py-2 text-xs text-kraveo-ink2" data-testid="price-column-help">
                <p className="font-bold text-kraveo-ink">Which price column?</p>
                {isCut && <p>{vendor?.name} is on <b>{commissionLabel('CUT', ruleValue)}</b> ("Cut from sale"). Put the price the customer pays in a <b>menuPrice</b> column and Kraveo works out what the restaurant gets. A <b>vendorPrice</b> column (what the restaurant gets) also works.</p>}
                {rule === 'PERCENT' || rule === 'FLAT' ? <p>{vendor?.name} is on <b>{commissionLabel(rule, ruleValue)}</b>. Use the <b>vendorPrice</b> column (what the restaurant gets). A menuPrice column only works for restaurants on "Cut from sale".</p> : null}
                {rule === null && <p>Use <b>vendorPrice</b> (what the restaurant gets), or <b>menuPrice</b> (what the customer pays) if the restaurant or the dish is on "Cut from sale". Never both in one row.</p>}
                <p>Optional <b>position</b> column (1, 2, 3 ...): the dish's place on the menu. Without it, dishes keep the order of the file.</p>
              </div>
              {isCut && (
                <fieldset className="space-y-1.5">
                  <legend className="k-label mb-1">In my file the price column is</legend>
                  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="What the price column holds">
                    {([['menu', 'What the customer pays', 'The menu price. Kraveo works out the restaurant\'s share.'], ['vendor', 'What the restaurant gets', 'The restaurant\'s own price. Kraveo adds its cut on top.']] as const).map(([id, label, help]) => (
                      <label key={id} className="relative cursor-pointer">
                        <input type="radio" name="import-prices-are" value={id} checked={pricesAre === id} onChange={() => setPricesChoice(id)} className="peer sr-only" />
                        <span className="block rounded-k-md border border-kraveo-line bg-kraveo-surface2 p-3 text-sm peer-checked:border-kraveo-g400 peer-checked:bg-kraveo-g400/10 peer-focus-visible:ring-2 peer-focus-visible:ring-kraveo-g400/60">
                          <span className="block font-bold text-kraveo-ink">{label}</span>
                          <span className="block text-xs text-kraveo-ink3">{help}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[11px] text-kraveo-ink3">Only applies to a column called price, rate, cost and similar. A column named menuPrice or vendorPrice is always read as named.</p>
                </fieldset>
              )}
              <p className="text-xs text-kraveo-ink3">The template has two sample lines: replace or delete them. Commas, semicolons and tabs all work, so you can also paste rows copied from Excel or Google Sheets.</p>
              {fileName && <p className="text-xs font-semibold text-kraveo-ink2" role="status">Loaded “{fileName}”. You can still edit the text below.</p>}
              <Field label="Or paste the rows here (first line = column names)" htmlFor="import-text">
                <textarea id="import-text" className="k-input min-h-[140px] py-2 font-mono text-xs" value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); setProblems([]); setError(''); }} />
              </Field>
            </section>

            <fieldset className="space-y-2">
              <legend className="k-label mb-1">If a dish with the same name is already on the menu</legend>
              <DuplicateChoice value={duplicate} onChange={changePolicy} />
            </fieldset>
          </>
        )}

        {step === 'preview' && report && (
          <>
            <h3 ref={headingRef} tabIndex={-1} className="font-display text-base font-bold text-kraveo-ink">Step 2 of 3: check what will happen</h3>
            <p className="text-sm text-kraveo-ink2">Nothing has been saved yet. This is a preview for <b>{vendor?.name ?? 'the restaurant'}</b>.</p>
            {parsed && parsed.ignoredColumns.length > 0 && <p className="rounded-k-sm border border-kraveo-line bg-kraveo-surface2 px-3 py-2 text-xs text-kraveo-ink2">Columns that are not used and were ignored: {parsed.ignoredColumns.join(', ')}.</p>}
            <div className="flex flex-wrap gap-2" role="group" aria-label="Summary" data-testid="import-summary">
              <Pill label="To add" value={counts.create} tone="create" />
              <Pill label="To update" value={counts.update} tone="update" />
              <Pill label="Skipped" value={counts.skip} tone="skip" />
              <Pill label="Not valid" value={counts.invalid} tone="invalid" />
            </div>
            {counts.invalid > 0 && <p role="alert" className="rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{counts.invalid} {counts.invalid === 1 ? 'row is' : 'rows are'} not valid, so nothing can be imported yet. Go back, fix the file and check again.</p>}
            {counts.invalid === 0 && importable === 0 && <p className="rounded-k-sm border border-kraveo-line bg-kraveo-surface2 px-3 py-2 text-sm text-kraveo-ink2">Every dish is already on the menu, so there is nothing to import.</p>}
            <fieldset className="space-y-2">
              <legend className="k-label mb-1">If a dish with the same name is already on the menu</legend>
              <DuplicateChoice value={duplicate} onChange={changePolicy} disabled={busy !== null} />
            </fieldset>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1" role="group" aria-label="Show">
              <button type="button" className="k-chip" aria-pressed={showOnly === 'all'} onClick={() => setShowOnly('all')}>All rows ({view.length})</button>
              <button type="button" className="k-chip" aria-pressed={showOnly === 'problems'} onClick={() => setShowOnly('problems')} disabled={counts.invalid === 0}>Not valid ({counts.invalid})</button>
            </div>
            <ul className="space-y-2" aria-label="Rows" aria-busy={busy === 'preview'}>
              {shownRows.map((row) => (
                <li key={row.index} className={`rounded-k-md border p-3 text-sm ${row.action === 'invalid' ? 'border-kraveo-danger/40 bg-kraveo-danger/5' : 'border-kraveo-line bg-kraveo-surface2/40'}`} data-row-action={row.action}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 break-words font-bold text-kraveo-ink"><span className="mr-2 text-xs font-semibold text-kraveo-ink3">Row {row.line}</span>{row.name}</p>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide ${ACTION_STYLE[row.action]}`}>{ACTION_LABEL[row.action]}</span>
                  </div>
                  <p className="mt-1 break-words text-xs text-kraveo-ink2">
                    {row.category}
                    {row.menuPrice !== null
                      ? <> · menu price {row.menuPrice} · restaurant gets <b className="tabular-nums text-kraveo-ink" data-testid="row-restaurant">{row.restaurantGets === null ? '-' : rupees(row.restaurantGets)}</b></>
                      : <> · restaurant price {row.vendorPrice}</>}
                    {' '}· customer pays <b className="tabular-nums text-kraveo-ink">{row.computedPrice === null ? '-' : rupees(row.computedPrice)}</b>
                    {row.position !== null && <> · position {row.position}</>}
                  </p>
                  {row.action === 'skip' && <p className="mt-1 text-xs text-kraveo-ink3">{skipReasonText(row.reason)}</p>}
                  {row.problems.length > 0 && <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs font-semibold text-kraveo-danger">{row.problems.map((p) => <li key={p} className="break-words">{p}</li>)}</ul>}
                  {row.hints.map((hint) => <p key={hint} className="mt-1 break-words text-xs text-kraveo-ink3">{hint}</p>)}
                </li>
              ))}
            </ul>
          </>
        )}

        {step === 'done' && applied && (
          <>
            <h3 ref={headingRef} tabIndex={-1} className="sr-only">Step 3 of 3: the import is finished</h3>
            <div className="flex items-start gap-3 rounded-k-md border border-kraveo-g400/30 bg-kraveo-g400/10 p-4" role="status">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-kraveo-g400" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-bold text-kraveo-ink">{applied.message || 'The menu was imported.'}</p>
                <p className="mt-1 text-sm text-kraveo-ink2">{vendor?.name ?? 'The restaurant'}: {applied.summary.create} added, {applied.summary.update} updated, {applied.summary.skip} skipped. New dishes are live at once.</p>
              </div>
            </div>
            <ul className="space-y-1.5" aria-label="What was imported">
              {applied.rows.filter((r) => r.action === 'create' || r.action === 'update').map((r) => (
                <li key={r.index} className="flex items-center justify-between gap-2 text-sm"><span className="min-w-0 break-words text-kraveo-ink">{r.name}</span><span className="shrink-0 text-xs font-bold text-kraveo-ink2">{ACTION_LABEL[r.action]}{r.computedPrice !== null ? ` · ${rupees(r.computedPrice)}` : ''}</span></li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Drawer>
  );
};

const Pill: React.FC<{ label: string; value: number; tone: ImportRowReport['action'] }> = ({ label, value, tone }) => (
  <span className={`rounded-full px-3 py-1 text-xs font-bold ${ACTION_STYLE[tone]}`}><span className="tabular-nums">{value}</span> {label.toLowerCase()}</span>
);

const DuplicateChoice: React.FC<{ value: Duplicate; onChange: (v: Duplicate) => void; disabled?: boolean }> = ({ value, onChange, disabled }) => (
  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Same name already on the menu">
    {([['SKIP', 'Skip it', 'Leave the existing dish exactly as it is.'], ['UPDATE', 'Update it', 'Change the existing dish to the values in the file (only the columns that are filled in).']] as const).map(([id, label, help]) => (
      <label key={id} className="relative cursor-pointer">
        <input type="radio" name="import-duplicate" value={id} checked={value === id} disabled={disabled} onChange={() => onChange(id)} className="peer sr-only" />
        <span className="block rounded-k-md border border-kraveo-line bg-kraveo-surface2 p-3 text-sm peer-checked:border-kraveo-g400 peer-checked:bg-kraveo-g400/10 peer-focus-visible:ring-2 peer-focus-visible:ring-kraveo-g400/60 peer-disabled:opacity-60">
          <span className="block font-bold text-kraveo-ink">{label}</span>
          <span className="block text-xs text-kraveo-ink3">{help}</span>
        </span>
      </label>
    ))}
  </div>
);
