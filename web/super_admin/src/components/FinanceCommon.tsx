import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { DateRange, checkRange, dateLabel, presetOf, presetRange } from '../lib/financeParse';
import { Field } from './ui/Field';

export const plainError = (error: unknown): string => (error instanceof Error ? error.message : 'Something went wrong. Please try again.');

/** Loads something for the current filters. A slower, older answer never replaces a newer one. */
export const useLoad = <T,>(fetcher: () => Promise<T>, deps: ReadonlyArray<unknown>, onAuthError?: (error: unknown) => void) => {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string }>({ data: null, loading: true, error: '' });
  const [version, setVersion] = useState(0);
  const seq = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  useEffect(() => {
    const mine = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: '' }));
    fetcherRef.current()
      .then((data) => { if (mine === seq.current) setState({ data, loading: false, error: '' }); })
      .catch((failure) => {
        if (mine !== seq.current) return;
        authRef.current?.(failure);
        setState({ data: null, loading: false, error: plainError(failure) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { ...state, reload };
};

export const ErrorNote: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => (
  <div role="alert" className="flex items-center justify-between gap-3 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">
    <span className="min-w-0 break-words">{message}</span>
    {onRetry && <button type="button" className="k-btn-ghost !min-h-[36px] shrink-0 !px-3 text-xs" onClick={onRetry}>Try again</button>}
  </div>
);

export const SectionCard: React.FC<{ title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode }> = ({ title, description, actions, children }) => (
  <section className="k-card space-y-4 p-4 sm:p-5" aria-label={title}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-display text-lg font-bold text-kraveo-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-kraveo-ink2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
    {children}
  </section>
);

export const ReloadButton: React.FC<{ onClick: () => void; loading: boolean; label: string }> = ({ onClick, loading, label }) => (
  <button type="button" className="k-icon-btn" aria-label={label} title={label} onClick={onClick} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
);

/** A table that scrolls sideways on a phone instead of squashing. */
export const ScrollTable: React.FC<{ caption: string; minWidth?: string; children: React.ReactNode }> = ({ caption, minWidth = 'min-w-[640px]', children }) => (
  <div className="-mx-1 overflow-x-auto px-1" tabIndex={0} role="region" aria-label={`${caption} (scrolls sideways)`}>
    <table className={`w-full ${minWidth} border-separate border-spacing-0 text-left text-sm`}>
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  </div>
);

export const Th: React.FC<{ children?: React.ReactNode; right?: boolean }> = ({ children, right }) => (
  <th scope="col" className={`border-b border-kraveo-line px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide text-kraveo-ink3 ${right ? 'text-right' : ''}`}>{children}</th>
);
export const Td: React.FC<{ children?: React.ReactNode; right?: boolean; className?: string }> = ({ children, right, className = '' }) => (
  <td className={`border-b border-kraveo-line/60 px-3 py-2.5 text-kraveo-ink2 ${right ? 'k-num-cell text-right tabular-nums' : ''} ${className}`}>{children}</td>
);

export const Pager: React.FC<{ page: number; pages: number; loading: boolean; onPage: (page: number) => void }> = ({ page, pages, loading, onPage }) => {
  if (pages <= 1 && page <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-3" aria-label="Pages">
      <button type="button" className="k-btn-ghost" onClick={() => onPage(page - 1)} disabled={page <= 1 || loading}><ChevronLeft className="h-4 w-4" aria-hidden="true" />Previous</button>
      <span className="text-sm text-kraveo-ink2" aria-live="polite">Page {page} of {pages}</span>
      <button type="button" className="k-btn-ghost" onClick={() => onPage(page + 1)} disabled={page >= pages || loading}>Next<ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
    </nav>
  );
};

interface PickerProps {
  /** null = no date limit ("All time"; only when `allowAll`). */
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  /** The server's longest range (finance: 366 days). */
  maxDays: number;
  allowAll?: boolean;
  label?: string;
}

/** Today / 7 days / 30 days / Custom (and All time). Dates are India days written YYYY-MM-DD. */
export const DateRangePicker: React.FC<PickerProps> = ({ value, onChange, maxDays, allowAll = false, label = 'Dates' }) => {
  const uid = useId();
  const preset = value ? presetOf(value) : null;
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(value?.from ?? presetRange('7d').from);
  const [to, setTo] = useState(value?.to ?? presetRange('7d').to);
  const [error, setError] = useState('');
  const showCustom = customOpen || (value !== null && preset === null);

  useEffect(() => { if (value) { setFrom(value.from); setTo(value.to); } }, [value]);

  const pick = (next: DateRange | null) => { setCustomOpen(false); setError(''); onChange(next); };
  const apply = () => {
    const checked = checkRange(from, to, maxDays);
    if (!checked.ok) { setError(checked.message); return; }
    setError('');
    onChange(checked.range);
  };

  return (
    <div className="space-y-3">
      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:px-0" role="group" aria-label={label}>
        {([['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']] as const).map(([id, text]) => (
          <button key={id} type="button" className="k-chip" aria-pressed={!showCustom && preset === id} onClick={() => pick(presetRange(id))}>{text}</button>
        ))}
        {allowAll && <button type="button" className="k-chip" aria-pressed={value === null && !customOpen} onClick={() => pick(null)}>All time</button>}
        <button type="button" className="k-chip" aria-pressed={showCustom} onClick={() => setCustomOpen(true)}>Custom</button>
        {value && <span className="shrink-0 whitespace-nowrap pl-1 text-xs text-kraveo-ink3">{value.from === value.to ? dateLabel(value.from) : `${dateLabel(value.from)} to ${dateLabel(value.to)}`}</span>}
      </div>
      {showCustom && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From" htmlFor={`${uid}-from`}>
            <input id={`${uid}-from`} type="date" className="k-input !min-h-[40px]" value={from} onChange={(event) => { setFrom(event.target.value); setError(''); }} max={to || undefined} />
          </Field>
          <Field label="To" htmlFor={`${uid}-to`}>
            <input id={`${uid}-to`} type="date" className="k-input !min-h-[40px]" value={to} onChange={(event) => { setTo(event.target.value); setError(''); }} min={from || undefined} />
          </Field>
          <button type="button" className="k-btn-ghost" onClick={apply}>Apply dates</button>
        </div>
      )}
      {error && <p role="alert" className="text-xs font-semibold text-kraveo-danger">{error}</p>}
    </div>
  );
};
