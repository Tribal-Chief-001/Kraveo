import React, { useState } from 'react';
import { CheckCircle2, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { Category } from '../lib/categoryParse';
import { BulkAction, MAX_BULK_IDS } from '../lib/catalogBulkParse';

export interface BulkSummary {
  /** "Mark sold out", "Delete", ... */
  action: string;
  message: string;
  ok: number;
  failed: number;
  failures: Array<{ id: string; name: string; message: string }>;
}

interface Props {
  count: number;
  busy: boolean;
  /** Active dish categories for "Change category". */
  categories: Category[];
  categoriesLoading: boolean;
  categoriesFailed: boolean;
  /** A request-level failure (nothing was changed) to show in the bar. */
  error: string;
  onRun: (action: BulkAction, extra?: { categoryId: string }) => void;
  onClear: () => void;
}

/** Appears when dishes are ticked: one action for all of them. The server answers per dish; the panel shows the summary. */
export const CatalogBulkBar: React.FC<Props> = ({ count, busy, categories, categoriesLoading, categoriesFailed, error, onRun, onClear }) => {
  const [categoryId, setCategoryId] = useState('');
  const tooMany = count > MAX_BULK_IDS;
  const off = busy || tooMany;
  return (
    <section className="sticky top-2 z-10 space-y-2 rounded-k-md border border-kraveo-g400/40 bg-kraveo-surface2 p-3 shadow-k-lift" aria-label="Actions for the selected dishes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-kraveo-ink" aria-live="polite">{count} {count === 1 ? 'dish' : 'dishes'} selected</p>
        <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={onClear} disabled={busy}><X className="h-3.5 w-3.5" aria-hidden="true" />Clear selection</button>
      </div>
      {tooMany && <p role="alert" className="text-xs font-semibold text-kraveo-danger">Select at most {MAX_BULK_IDS} dishes at a time.</p>}
      {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onRun('AVAILABLE')} disabled={off}>Mark available</button>
        <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onRun('UNAVAILABLE')} disabled={off}>Mark sold out</button>
        <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onRun('APPROVE')} disabled={off}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Approve</button>
        <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onRun('RESTORE')} disabled={off}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Restore</button>
        <button type="button" className="k-btn-danger !min-h-[36px] !px-3 text-xs" onClick={() => onRun('DELETE')} disabled={off}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete</button>
        {busy && <span className="flex items-center gap-1.5 text-xs text-kraveo-ink3" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Working…</span>}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="sr-only" htmlFor="bulk-category">Category for the selected dishes</label>
        <select id="bulk-category" className="k-select !min-h-[40px] sm:w-64" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={off || categoriesFailed || categories.length === 0}>
          <option value="">{categoriesFailed ? 'Categories could not be loaded' : categoriesLoading && categories.length === 0 ? 'Loading categories…' : 'Change category to…'}</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="button" className="k-btn-ghost !min-h-[40px] text-xs" onClick={() => { if (categoryId) onRun('SET_CATEGORY', { categoryId }); }} disabled={off || categoryId === ''}>Change category</button>
      </div>
    </section>
  );
};

/** What happened, with every failure and its reason. Stays until dismissed. */
export const BulkResultPanel: React.FC<{ summary: BulkSummary; onDismiss: () => void }> = ({ summary, onDismiss }) => (
  <section className={`rounded-k-md border p-4 text-sm ${summary.failed > 0 ? 'border-kraveo-status-placed/40 bg-kraveo-status-placed/10' : 'border-kraveo-g400/30 bg-kraveo-g400/10'}`} role="status" aria-label="Result of the last bulk action">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-bold text-kraveo-ink">{summary.action}: {summary.message || `${summary.ok} done, ${summary.failed} could not be changed.`}</p>
        {summary.failed > 0 && <p className="mt-1 text-xs text-kraveo-ink2">These stay ticked so you can fix them and try again.</p>}
      </div>
      <button type="button" className="k-icon-btn !h-8 !w-8 shrink-0" aria-label="Dismiss this result" onClick={onDismiss}><X className="h-4 w-4" aria-hidden="true" /></button>
    </div>
    {summary.failures.length > 0 && (
      <ul className="mt-2 list-disc space-y-1 pl-5 text-kraveo-ink">
        {summary.failures.map((f) => <li key={f.id} className="break-words"><b>{f.name}</b>: {f.message}</li>)}
      </ul>
    )}
  </section>
);
