import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, Plus, RefreshCw, SearchX, UtensilsCrossed } from 'lucide-react';
import { Vendor } from '../types';
import { apiService } from '../services/api';
import { CatalogDish, CatalogPage, PendingCounts } from '../lib/catalogParse';
import { commissionLabel, rupees } from '../lib/pricing';
import { CatalogDishDrawer } from './CatalogDishDrawer';
import { StateBadge } from './CatalogStateBadge';
import { EmptyState } from './ui/EmptyState';
import { SkeletonCard } from './ui/Skeleton';
import { Switch } from './ui/Switch';
import { useToast } from './ui/Toast';

interface Props {
  /** Restaurants for the filter and for "Add dish". */
  vendors: Vendor[];
  /** The header search box (sent to the server, debounced). */
  query: string;
  onClearQuery: () => void;
  onAuthError: (error: unknown) => void;
  /** Dishes waiting, from the sidebar badge poll: new dishes and price-change requests. */
  pendingCounts: PendingCounts;
  /** Something changed on the server that can move the pending count: refresh the badge. */
  onPendingChanged: () => void;
}

/** `status` is what is sent to GET /api/admin/catalog?status=. Omitted = every dish that is not deleted (the server default). */
const FILTERS = [
  { id: 'PENDING', label: 'Needs review', status: 'PENDING' },
  { id: 'CHANGE_PENDING', label: 'Price changes', status: 'CHANGE_PENDING' },
  { id: 'LIVE', label: 'Live', status: 'LIVE' },
  { id: 'REJECTED', label: 'Rejected', status: 'REJECTED' },
  { id: 'DELETED', label: 'Deleted', status: 'DELETED' },
  { id: 'ALL', label: 'All dishes', status: '' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

const SEARCH_DEBOUNCE_MS = 350;

const VegMark: React.FC<{ isVeg: boolean }> = ({ isVeg }) => (
  <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border-2 ${isVeg ? 'border-kraveo-g400' : 'border-kraveo-danger'}`} title={isVeg ? 'Vegetarian' : 'Non-vegetarian'}>
    <span className={`h-1.5 w-1.5 rounded-full ${isVeg ? 'bg-kraveo-g400' : 'bg-kraveo-danger'}`} />
    <span className="sr-only">{isVeg ? 'Vegetarian' : 'Non-vegetarian'}</span>
  </span>
);

const Thumb: React.FC<{ url: string | null; name: string; size?: string }> = ({ url, name, size = 'h-11 w-11' }) => {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-k-sm border border-kraveo-line bg-kraveo-surface2 text-kraveo-ink3`}>
      {url && !failed
        ? <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : url ? <ImageOff className="h-4 w-4" aria-label={`No picture for ${name}`} /> : <UtensilsCrossed className="h-4 w-4" aria-hidden="true" />}
    </span>
  );
};

const SOURCE_LABEL = { DISH: 'this dish', VENDOR: 'restaurant', GLOBAL: 'default' } as const;

const commissionText = (dish: CatalogDish): string => {
  const rule = dish.commission ? `${commissionLabel(dish.commission.type, dish.commission.value)} · ${SOURCE_LABEL[dish.commission.source]}` : 'Default';
  return dish.effectiveCommission !== null ? `${rupees(dish.effectiveCommission)} (${rule})` : rule;
};

/** The customer price, with a note when today's rules would give a different one (until "Recalculate prices" runs). */
const CustomerPrice: React.FC<{ dish: CatalogDish }> = ({ dish }) => (
  <>
    {rupees(dish.price)}
    {dish.priceIsStale && dish.computedPrice !== null && <span className="block text-[11px] font-semibold text-kraveo-status-placed" title="Run Recalculate prices in Settings to apply it">now {rupees(dish.computedPrice)}</span>}
  </>
);

interface RowProps {
  dish: CatalogDish;
  busy: boolean;
  onOpen: (dish: CatalogDish) => void;
  onToggle: (dish: CatalogDish) => void;
}

const PriceCell: React.FC<{ dish: CatalogDish }> = ({ dish }) => (
  <>
    {rupees(dish.vendorPrice)}
    {dish.pendingVendorPrice !== null && <span className="block text-[11px] font-semibold text-kraveo-status-preparing">asks {rupees(dish.pendingVendorPrice)}</span>}
  </>
);

const DishRow = memo<RowProps>(({ dish, busy, onOpen, onToggle }) => (
  <tr tabIndex={0} onClick={() => onOpen(dish)} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(dish); }}
    className="cursor-pointer outline-none transition-colors hover:bg-kraveo-surface2/60 focus-visible:bg-kraveo-surface2/60" aria-label={`Open ${dish.name}`}>
    <td className="border-b border-kraveo-line/60 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Thumb url={dish.imageUrl} name={dish.name} />
        <div className="min-w-0">
          <p className="flex items-center gap-2 break-words font-bold text-kraveo-ink"><VegMark isVeg={dish.isVeg} /><span className="min-w-0 break-words">{dish.name}</span></p>
          <p className="truncate text-xs text-kraveo-ink3">{dish.category || 'No category'}</p>
        </div>
      </div>
    </td>
    <td className="max-w-[12rem] break-words border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink2">{dish.vendorName}</td>
    <td className="k-num border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink"><PriceCell dish={dish} /></td>
    <td className="border-b border-kraveo-line/60 px-4 py-3 text-xs text-kraveo-ink2">{commissionText(dish)}</td>
    <td className="k-num border-b border-kraveo-line/60 px-4 py-3 text-kraveo-ink"><CustomerPrice dish={dish} /></td>
    <td className="border-b border-kraveo-line/60 px-4 py-3"><StateBadge state={dish.state} /></td>
    <td className="border-b border-kraveo-line/60 px-4 py-3" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <Switch checked={dish.isAvailable} onChange={() => onToggle(dish)} disabled={busy || dish.state === 'DELETED'} label={`${dish.name}: available to order`} />
    </td>
    <td className="border-b border-kraveo-line/60 px-3 py-3"><ChevronRight className="h-4 w-4 text-kraveo-ink3" aria-hidden="true" /></td>
  </tr>
));
DishRow.displayName = 'DishRow';

const DishCard = memo<RowProps & { index: number }>(({ dish, busy, onOpen, onToggle, index }) => (
  <div className="k-card k-reveal p-4" style={{ ['--i' as string]: Math.min(index, 10) }}>
    <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => onOpen(dish)} aria-label={`Open ${dish.name}`}>
      <Thumb url={dish.imageUrl} name={dish.name} size="h-14 w-14" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 break-words font-bold text-kraveo-ink"><VegMark isVeg={dish.isVeg} /><span className="min-w-0 break-words">{dish.name}</span></span>
        <span className="block break-words text-xs text-kraveo-ink3">{dish.vendorName}{dish.category ? ` · ${dish.category}` : ''}</span>
        <span className="mt-1.5 block"><StateBadge state={dish.state} /></span>
      </span>
      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-kraveo-ink3" aria-hidden="true" />
    </button>
    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
      <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Restaurant</p><p className="k-num text-base text-kraveo-ink"><PriceCell dish={dish} /></p></div>
      <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Commission</p><p className="break-words text-xs font-bold text-kraveo-ink">{commissionText(dish)}</p></div>
      <div className="k-inset px-2 py-2"><p className="k-label !text-[10px]">Customer</p><p className="k-num text-base text-kraveo-ink"><CustomerPrice dish={dish} /></p></div>
    </div>
    <div className="mt-3 flex items-center justify-between gap-3">
      <span className="text-xs text-kraveo-ink3">{dish.isAvailable ? 'Available' : 'Sold out'}</span>
      <Switch checked={dish.isAvailable} onChange={() => onToggle(dish)} disabled={busy || dish.state === 'DELETED'} label={`${dish.name}: available to order`} />
    </div>
  </div>
));
DishCard.displayName = 'DishCard';

const CatalogPanelBase: React.FC<Props> = ({ vendors, query, onClearQuery, onAuthError, pendingCounts, onPendingChanged }) => {
  const toast = useToast();
  const [filter, setFilter] = useState<FilterId>('PENDING');
  const [vendorId, setVendorId] = useState('');
  const [pageState, setPageState] = useState<{ key: string; page: number }>({ key: '', page: 1 });
  const [data, setData] = useState<CatalogPage | null>(null);
  const [items, setItems] = useState<CatalogDish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(() => new Set());
  const togglingRef = useRef<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<{ kind: 'edit'; dish: CatalogDish } | { kind: 'create' } | null>(null);
  const seq = useRef(0);

  const status = FILTERS.find((entry) => entry.id === filter)?.status ?? '';
  const filterKey = `${filter}|${vendorId}|${query.trim()}`;
  const page = pageState.key === filterKey ? pageState.page : 1;

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await apiService.fetchCatalog({ status, vendorId, q: query, page });
        if (mine !== seq.current) return;
        setData(result);
        setItems(result.items);
        setError('');
      } catch (failure) {
        if (mine !== seq.current) return;
        onAuthError(failure);
        setError(failure instanceof Error ? failure.message : 'The dishes could not be loaded.');
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, query.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [status, vendorId, query, page, reloadKey, onAuthError]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const handleChanged = useCallback(() => { reload(); onPendingChanged(); }, [reload, onPendingChanged]);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const openDish = useCallback((dish: CatalogDish) => setDrawer({ kind: 'edit', dish }), []);

  /** The availability switch: flips at once and goes back if the server says no. */
  const toggleAvailability = useCallback(async (dish: CatalogDish) => {
    if (togglingRef.current.has(dish.id)) return;
    togglingRef.current.add(dish.id);
    setTogglingIds(new Set(togglingRef.current));
    const next = !dish.isAvailable;
    const apply = (value: boolean) => setItems((current) => current.map((row) => (row.id === dish.id ? { ...row, isAvailable: value } : row)));
    apply(next);
    try {
      await apiService.updateCatalogItem(dish.id, { isAvailable: next });
    } catch (failure) {
      apply(dish.isAvailable);
      onAuthError(failure);
      toast.error('Availability not changed', failure instanceof Error ? failure.message : 'Please try again.');
    } finally {
      togglingRef.current.delete(dish.id);
      setTogglingIds(new Set(togglingRef.current));
    }
  }, [onAuthError, toast]);

  const sortedVendors = useMemo(() => [...vendors].sort((a, b) => a.name.localeCompare(b.name)), [vendors]);
  const categories = useMemo(() => Array.from(new Set(items.map((dish) => dish.category).filter(Boolean))).sort(), [items]);

  const initialLoad = loading && items.length === 0 && !error;
  const empty = !loading && !error && items.length === 0;
  const totalPages = data?.totalPages ?? null;
  const showPager = data !== null && (page > 1 || data.hasMore);
  const counts = (id: FilterId): number | null => {
    const n = id === 'PENDING' ? pendingCounts.pending : id === 'CHANGE_PENDING' ? pendingCounts.changePending : 0;
    return n > 0 ? n : null;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none lg:mx-0 lg:px-0" role="group" aria-label="Filter dishes">
          {FILTERS.map((entry) => {
            const count = counts(entry.id);
            return (
              <button key={entry.id} type="button" className="k-chip" aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>
                {entry.label}
                {count !== null && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${filter === entry.id ? 'bg-kraveo-g400/25' : 'bg-kraveo-status-placed/25 text-kraveo-status-placed'}`}>{count}</span>}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="catalog-vendor-filter">Restaurant</label>
          <select id="catalog-vendor-filter" className="k-select !min-h-[40px] w-full sm:w-56" value={vendorId} onChange={(event) => setVendorId(event.target.value)}>
            <option value="">All restaurants</option>
            {sortedVendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
          </select>
          <button type="button" className="k-icon-btn" aria-label="Reload dishes" title="Reload dishes" onClick={reload} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
          <button type="button" className="k-btn-accent" onClick={() => setDrawer({ kind: 'create' })} disabled={vendors.length === 0} title={vendors.length === 0 ? 'No restaurants loaded yet' : undefined}><Plus className="h-4 w-4" aria-hidden="true" />Add dish</button>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" className="k-btn-ghost !min-h-[36px] shrink-0 !px-3 text-xs" onClick={reload}>Try again</button>
        </div>
      )}

      {data && data.total !== null && !error && <p className="text-xs text-kraveo-ink3" aria-live="polite">{data.total} {data.total === 1 ? 'dish' : 'dishes'}{query.trim() ? ` match “${query.trim()}”` : ''}</p>}

      {empty && (
        <div className="k-card">
          <EmptyState
            icon={query.trim() ? SearchX : UtensilsCrossed}
            title={query.trim() ? 'No dishes match' : filter === 'PENDING' ? 'Nothing is waiting for approval' : 'No dishes here'}
            description={query.trim() ? 'Try a dish name, category or restaurant.' : filter === 'PENDING' ? 'New dishes from restaurants appear here for you to approve.' : 'Nothing matches this filter.'}
            action={query.trim() ? <button type="button" className="k-btn-ghost" onClick={onClearQuery}>Clear search</button> : filter !== 'ALL' ? <button type="button" className="k-btn-ghost" onClick={() => setFilter('ALL')}>Show all dishes</button> : undefined}
          />
        </div>
      )}

      {items.length > 0 && (
        <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={loading}>
          <div className="k-card hidden max-h-[calc(100vh-24rem)] overflow-auto xl:block">
            <table className="w-full min-w-[980px] border-separate border-spacing-0 text-left text-sm">
              <caption className="sr-only">Dishes</caption>
              <thead>
                <tr className="sticky top-0 z-10 bg-kraveo-surface text-[11px] uppercase tracking-wide text-kraveo-ink3">
                  {['Dish', 'Restaurant', 'Restaurant price', 'Commission', 'Customer price', 'Status', 'Available', ''].map((heading) => <th key={heading || 'open'} scope="col" className="border-b border-kraveo-line px-4 py-3 font-bold">{heading}{heading === '' && <span className="sr-only">Open</span>}</th>)}
                </tr>
              </thead>
              <tbody>
                {items.map((dish) => <DishRow key={dish.id} dish={dish} busy={togglingIds.has(dish.id)} onOpen={openDish} onToggle={toggleAvailability} />)}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:hidden">
            {items.map((dish, index) => <DishCard key={dish.id} dish={dish} index={index} busy={togglingIds.has(dish.id)} onOpen={openDish} onToggle={toggleAvailability} />)}
          </div>
        </div>
      )}
      {initialLoad && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, index) => <SkeletonCard key={index} lines={2} />)}</div>}

      {showPager && (
        <nav className="flex items-center justify-center gap-3" aria-label="Pages">
          <button type="button" className="k-btn-ghost" onClick={() => setPageState({ key: filterKey, page: page - 1 })} disabled={page <= 1 || loading}><ChevronLeft className="h-4 w-4" aria-hidden="true" />Previous</button>
          <span className="text-sm text-kraveo-ink2" aria-live="polite">Page {page}{totalPages ? ` of ${totalPages}` : ''}</span>
          <button type="button" className="k-btn-ghost" onClick={() => setPageState({ key: filterKey, page: page + 1 })} disabled={!data?.hasMore || loading}>Next<ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
        </nav>
      )}

      {drawer && (
        <CatalogDishDrawer
          key={drawer.kind === 'edit' ? drawer.dish.id : 'new'}
          open
          item={drawer.kind === 'edit' ? drawer.dish : null}
          vendors={sortedVendors}
          categories={categories}
          onClose={closeDrawer}
          onChanged={handleChanged}
          onAuthError={onAuthError}
        />
      )}
    </div>
  );
};

/** Memoised: a live order event re-renders the app but not this table (its props only change when its own data does). */
export const CatalogPanel = memo(CatalogPanelBase);
