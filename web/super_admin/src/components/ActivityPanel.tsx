import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Loader2, ScrollText, SearchX } from 'lucide-react';
import { apiService } from '../services/api';
import {
  AuditAction, AuditFilters, AuditRow, EMPTY_FILTERS, TARGET_TYPES, actionLabel, actorText, auditTarget, groupActions, hasFilters, istDateTime, istDaysAgo, istToday,
  rangeProblem, searchTooShort, shortId,
} from '../lib/auditParse';
import { saveBlob } from '../lib/download';
import { adminErrorText } from '../lib/errors';
import { orderCode } from '../lib/orders';
import { TabType } from '../types';
import { EmptyState } from './ui/EmptyState';
import { Field } from './ui/Field';
import { SkeletonCard } from './ui/Skeleton';
import { useToast } from './ui/Toast';

interface Props {
  onAuthError: (error: unknown) => void;
  /** Opens an order in the order drawer. */
  onOpenOrder?: (orderId: string) => void;
  /** Opens the tab a target lives in (restaurants, riders, customers). */
  onNavigate?: (tab: TabType) => void;
}

const PAGE = 50;
const SEARCH_DEBOUNCE_MS = 350;

const TargetCell: React.FC<{ row: AuditRow; onOpenOrder?: (id: string) => void; onNavigate?: (tab: TabType) => void }> = ({ row, onOpenOrder, onNavigate }) => {
  const target = auditTarget(row);
  const label = TARGET_TYPES.find((t) => t.value === row.targetType)?.label ?? (row.targetType ? actionLabel(row.targetType) : 'Item');
  if (target?.kind === 'order' && onOpenOrder) {
    return <button type="button" className="text-left font-bold text-kraveo-g300 hover:underline" onClick={() => onOpenOrder(target.id)} aria-label={`Open order ${orderCode(target.id)}`}>Order <span className="font-mono">{orderCode(target.id)}</span></button>;
  }
  if (target?.kind === 'tab' && onNavigate) {
    return (
      <span className="min-w-0">
        <span className="text-kraveo-ink2">{label} <span className="font-mono text-xs">{shortId(row.targetId)}</span></span>{' '}
        <button type="button" className="text-xs font-bold text-kraveo-g300 hover:underline" onClick={() => onNavigate(target.tab)}>Open {target.label}</button>
      </span>
    );
  }
  return <span className="text-kraveo-ink2">{label}{row.targetId ? <> <span className="font-mono text-xs">{shortId(row.targetId)}</span></> : null}</span>;
};

/** Activity log: who changed what. Read only, newest first, filters, "load more", CSV. Everything from the server is shown as plain text. */
export const ActivityPanel: React.FC<Props> = ({ onAuthError, onOpenOrder, onNavigate }) => {
  const toast = useToast();
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  // The search text is applied after a short pause; every other filter applies at once.
  const [debouncedQ, setDebouncedQ] = useState('');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [actions, setActions] = useState<{ status: 'loading' | 'ready' | 'failed'; list: AuditAction[] }>({ status: 'loading', list: [] });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const seq = useRef(0);
  const downloadingRef = useRef(false);

  const dateProblem = rangeProblem(filters);
  const csvProblem = rangeProblem(filters, true);

  const loadActions = useCallback(() => {
    setActions((c) => ({ ...c, status: 'loading' }));
    apiService.fetchAuditActions()
      .then((list) => setActions({ status: 'ready', list }))
      .catch((e) => { onAuthError(e); setActions({ status: 'failed', list: [] }); });
  }, [onAuthError]);
  useEffect(() => { loadActions(); }, [loadActions]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(filters.q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filters.q]);
  const applied = useMemo<AuditFilters>(
    () => ({ actions: filters.actions, targetType: filters.targetType, actorId: filters.actorId, from: filters.from, to: filters.to, q: debouncedQ }),
    [filters.actions, filters.targetType, filters.actorId, filters.from, filters.to, debouncedQ],
  );

  const loadFirst = useCallback(async (f: AuditFilters) => {
    const mine = ++seq.current;
    if (rangeProblem(f)) { setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const page = await apiService.fetchAuditLog(f, null, PAGE);
      if (mine !== seq.current) return;
      setRows(page.rows); setCursor(page.nextCursor);
    } catch (e) {
      if (mine !== seq.current) return;
      onAuthError(e);
      setRows([]); setCursor(null);
      setError(adminErrorText(e, 'The activity log could not be loaded.'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [onAuthError]);
  useEffect(() => { void loadFirst(applied); }, [applied, loadFirst]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const page = await apiService.fetchAuditLog(applied, cursor, PAGE);
      // The filters changed while this page was loading: it belongs to a list that is gone.
      if (mine !== seq.current) return;
      setRows((current) => [...current, ...page.rows.filter((r) => !current.some((c) => c.id === r.id))]);
      setCursor(page.nextCursor);
    } catch (e) {
      onAuthError(e);
      if (mine === seq.current) toast.error('More entries not loaded', adminErrorText(e));
    } finally { setLoadingMore(false); }
  };

  const set = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => setFilters((c) => ({ ...c, [key]: value }));
  const toggleAction = (code: string) => set('actions', filters.actions.includes(code) ? filters.actions.filter((a) => a !== code) : [...filters.actions, code]);
  const clear = () => { setFilters(EMPTY_FILTERS); setDebouncedQ(''); };

  const download = async () => {
    if (downloadingRef.current || csvProblem) return;
    downloadingRef.current = true; setDownloading(true);
    try {
      const { blob, filename } = await apiService.downloadAuditCsv(filters);
      saveBlob(blob, filename);
      toast.success('Download ready', `${filename} was saved.`);
    } catch (e) {
      onAuthError(e);
      toast.error('Download failed', adminErrorText(e));
    } finally { downloadingRef.current = false; setDownloading(false); }
  };

  // People seen in the loaded rows, so "By" can be narrowed to one admin.
  const actorOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.actorId) seen.set(r.actorId, actorText(r));
    if (filters.actorId && !seen.has(filters.actorId)) seen.set(filters.actorId, `Admin ${shortId(filters.actorId)}`);
    return [...seen.entries()];
  }, [rows, filters.actorId]);

  const grouped = useMemo(() => groupActions(actions.list), [actions.list]);
  const filtered = hasFilters(filters);
  const empty = !loading && !error && rows.length === 0 && !dateProblem;
  const initial = loading && rows.length === 0;

  return (
    <div className="space-y-5">
      <section aria-label="Filters" className="k-card space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Search the summary" htmlFor="au-q" error={searchTooShort(filters.q) ? 'Type at least 2 characters.' : undefined}>
            <input id="au-q" type="search" className="k-input" value={filters.q} maxLength={60} autoComplete="off" placeholder="A name, a restaurant, a reason" onChange={(e) => set('q', e.target.value)} aria-invalid={searchTooShort(filters.q)} aria-describedby={searchTooShort(filters.q) ? 'au-q-msg' : undefined} />
          </Field>
          <Field label="What happened to" htmlFor="au-type">
            <select id="au-type" className="k-select" value={filters.targetType} onChange={(e) => set('targetType', e.target.value)}>
              <option value="">Anything</option>
              {TARGET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Done by" htmlFor="au-actor">
            <select id="au-actor" className="k-select" value={filters.actorId} onChange={(e) => set('actorId', e.target.value)}>
              <option value="">Anyone</option>
              {actorOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </Field>
          <div className="space-y-1.5">
            <span className="k-label block">Action</span>
            <button type="button" className="k-btn-ghost w-full justify-between" aria-expanded={pickerOpen} aria-controls={pickerOpen ? 'au-actions' : undefined} onClick={() => setPickerOpen((v) => !v)} disabled={actions.status !== 'ready'}>
              <span>{actions.status === 'loading' ? 'Loading actions…' : actions.status === 'failed' ? 'Actions unavailable' : filters.actions.length ? `${filters.actions.length} selected` : 'Any action'}</span>
              {pickerOpen ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
            </button>
            {actions.status === 'failed' && <button type="button" className="text-xs font-bold text-kraveo-g300 hover:underline" onClick={loadActions}>The action list could not be loaded. Try again</button>}
          </div>
        </div>

        {pickerOpen && actions.status === 'ready' && (
          <div id="au-actions" className="max-h-72 space-y-4 overflow-y-auto rounded-k-md border border-kraveo-line p-3">
            {grouped.length === 0 && <p className="text-sm text-kraveo-ink3">No actions were recorded in the last 90 days.</p>}
            {grouped.map((g) => (
              <fieldset key={g.group}>
                <legend className="k-label mb-1.5">{g.group}</legend>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {g.items.map((a) => (
                    <label key={a.action} className="flex cursor-pointer items-center gap-2 text-sm text-kraveo-ink">
                      <input type="checkbox" className="h-4 w-4" checked={filters.actions.includes(a.action)} onChange={() => toggleAction(a.action)} />
                      <span className="min-w-0 break-words">{actionLabel(a.action)} <span className="text-xs text-kraveo-ink3">({a.count})</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="grid flex-1 grid-cols-2 gap-3">
            <Field label="From (India date)" htmlFor="au-from" error={dateProblem && filters.from ? dateProblem : undefined}>
              <input id="au-from" type="date" className="k-input" value={filters.from} max={filters.to || undefined} onChange={(e) => set('from', e.target.value)} aria-invalid={Boolean(dateProblem)} aria-describedby={dateProblem ? 'au-from-msg' : undefined} />
            </Field>
            <Field label="To (India date)" htmlFor="au-to" error={dateProblem && !filters.from ? dateProblem : undefined}>
              <input id="au-to" type="date" className="k-input" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} aria-invalid={Boolean(dateProblem)} aria-describedby={dateProblem && !filters.from ? 'au-to-msg' : undefined} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick dates">
            <button type="button" className="k-chip" onClick={() => setFilters((c) => ({ ...c, from: istToday(), to: istToday() }))}>Today</button>
            <button type="button" className="k-chip" onClick={() => setFilters((c) => ({ ...c, from: istDaysAgo(6), to: istToday() }))}>Last 7 days</button>
            <button type="button" className="k-chip" onClick={() => setFilters((c) => ({ ...c, from: istDaysAgo(30), to: istToday() }))}>Last 31 days</button>
          </div>
        </div>
        {dateProblem && filters.from && filters.to && <p role="alert" className="text-xs font-semibold text-kraveo-danger">{dateProblem}</p>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kraveo-line pt-3">
          <p className="text-xs text-kraveo-ink3" aria-live="polite">
            {loading ? 'Loading…' : error ? '' : `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} shown${cursor ? ', more available' : ''}.`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {filtered && <button type="button" className="k-btn-ghost !min-h-[40px] text-xs" onClick={clear}>Clear filters</button>}
            <button type="button" className="k-btn-ghost !min-h-[40px] text-xs" onClick={() => void download()} disabled={downloading || loading || Boolean(csvProblem)} aria-busy={downloading} title={csvProblem || (filters.from || filters.to ? undefined : 'Without dates the file covers the last 31 days.')}>
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}Download CSV
            </button>
          </div>
        </div>
        {!filters.from && !filters.to && <p className="-mt-2 text-[11px] text-kraveo-ink3">The CSV covers the last 31 days unless you choose dates (at most 366 days, 5000 rows).</p>}
      </section>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" className="k-btn-ghost !min-h-[36px] text-xs" onClick={() => void loadFirst(applied)}>Try again</button>
        </div>
      )}

      {initial && <div className="grid grid-cols-1 gap-3" role="status" aria-label="Loading activity">{Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} lines={2} />)}</div>}

      {empty && (
        <div className="k-card">
          <EmptyState icon={filtered ? SearchX : ScrollText} title={filtered ? 'No activity matches these filters.' : 'No activity yet'} description={filtered ? 'Try fewer filters or a wider date range.' : 'Changes made in the dashboard appear here.'}
            action={filtered ? <button type="button" className="k-btn-ghost" onClick={clear}>Clear filters</button> : undefined} />
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="k-card hidden overflow-x-auto xl:block">
            <table className="w-full min-w-[960px] border-separate border-spacing-0 text-left text-sm">
              <caption className="sr-only">Activity log, newest first</caption>
              <thead>
                <tr className="bg-kraveo-surface text-[11px] uppercase tracking-wide text-kraveo-ink3">
                  {['Time (IST)', 'Action', 'Target', 'What happened', 'By'].map((h) => <th key={h} scope="col" className="border-b border-kraveo-line px-4 py-3 font-bold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{istDateTime(r.createdAt)}</td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3"><p className="font-bold text-kraveo-ink">{actionLabel(r.action)}</p><p className="font-mono text-[10px] text-kraveo-ink3">{r.action}</p></td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3"><TargetCell row={r} onOpenOrder={onOpenOrder} onNavigate={onNavigate} /></td>
                    <td className="max-w-md break-words border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink">{r.summary || '—'}</td>
                    <td className="border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{actorText(r)}{r.ip ? <span className="block font-mono text-[10px] text-kraveo-ink3">{r.ip}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:hidden" aria-label="Activity log, newest first">
            {rows.map((r) => (
              <li key={r.id} className="k-card space-y-1.5 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="font-bold text-kraveo-ink">{actionLabel(r.action)}</p>
                  <p className="text-xs text-kraveo-ink3">{istDateTime(r.createdAt)}</p>
                </div>
                <p className="break-words text-sm text-kraveo-ink">{r.summary || '—'}</p>
                <p className="text-xs text-kraveo-ink3">By {actorText(r)}</p>
                <p className="text-xs"><TargetCell row={r} onOpenOrder={onOpenOrder} onNavigate={onNavigate} /></p>
              </li>
            ))}
          </ul>
        </>
      )}

      {cursor && (
        <div className="flex justify-center pt-1">
          <button type="button" className="k-btn-ghost" onClick={() => void loadMore()} disabled={loadingMore} aria-busy={loadingMore}>
            {loadingMore ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</> : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
};
