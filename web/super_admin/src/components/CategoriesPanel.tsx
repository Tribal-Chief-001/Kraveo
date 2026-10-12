import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GitMerge, Pencil, Plus, RefreshCw, SearchX, Tags, Trash2 } from 'lucide-react';
import { apiService, ApiError, CategoryInput } from '../services/api';
import { Category, MergePreview, deleteBlockReason, moveItem, usageText } from '../lib/categoryParse';
import { errorText } from '../lib/errors';
import { CategoryDrawer } from './CategoryDrawer';
import { CategoryMergeDrawer } from './CategoryMergeDrawer';
import { CategoryIcon } from './ui/CategoryIcon';
import { EmptyState } from './ui/EmptyState';
import { SkeletonCard } from './ui/Skeleton';
import { Switch } from './ui/Switch';
import { useToast } from './ui/Toast';
import { useConfirm } from './ui/ConfirmDialog';

interface Props {
  /** The header search box. */
  query: string;
  onClearQuery: () => void;
  onAuthError: (error: unknown) => void;
  /** A category was renamed, merged or deleted: restaurant and dish names elsewhere may have changed. */
  onChanged?: () => void;
}

const GRID = 'lg:grid lg:grid-cols-[80px_minmax(0,1fr)_repeat(4,84px)_130px_auto] lg:items-center';

type FlagKey = 'forRestaurants' | 'forDishes' | 'showOnHome' | 'isActive';
const FLAGS: Array<{ key: FlagKey; short: string; label: string; help: string }> = [
  { key: 'forRestaurants', short: 'Restaurants', label: 'can be tagged on restaurants', help: 'Can be picked as a cuisine when adding or editing a restaurant.' },
  { key: 'forDishes', short: 'Dishes', label: 'can be a dish category', help: 'Can be picked as the category of a dish.' },
  { key: 'showOnHome', short: 'Home chip', label: 'shown as a chip on the customer home screen', help: 'Shows as a quick filter on the customer app’s home screen, once a restaurant or dish uses it.' },
  { key: 'isActive', short: 'Active', label: 'active', help: 'Off hides it from pickers and the home screen. Restaurants and dishes that already use it keep it.' },
];

interface RowProps {
  category: Category;
  position: number;
  total: number;
  busy: boolean;
  canMove: boolean;
  onToggle: (category: Category, key: FlagKey) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onEdit: (category: Category) => void;
  onMerge: (category: Category) => void;
  onDelete: (category: Category) => void;
}

const Row = memo<RowProps>(({ category, position, total, busy, canMove, onToggle, onMove, onEdit, onMerge, onDelete }) => {
  const blocked = deleteBlockReason(category);
  const reasonId = `cat-${category.id}-delete-reason`;
  const used = usageText(category.usage);
  return (
    <li className={`k-card p-4 ${GRID} gap-3 ${category.isActive ? '' : 'opacity-80'}`} data-category-id={category.id}>
      <div className="flex items-center gap-1">
        <button type="button" className="k-icon-btn !h-9 !w-9" data-move={`${category.id}:up`} aria-label={`Move ${category.name} up`} disabled={!canMove || position === 0 || busy} onClick={() => onMove(category.id, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" className="k-icon-btn !h-9 !w-9" data-move={`${category.id}:down`} aria-label={`Move ${category.name} down`} disabled={!canMove || position === total - 1 || busy} onClick={() => onMove(category.id, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
      </div>

      <div className="mt-3 flex min-w-0 items-center gap-3 lg:mt-0">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-k-sm bg-kraveo-g400/15 text-kraveo-g400"><CategoryIcon icon={category.icon} className="h-5 w-5" /></span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-bold text-kraveo-ink"><span className="min-w-0 break-words">{category.name}</span>{!category.isActive && <span className="rounded-full bg-kraveo-line px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-kraveo-ink2">Hidden</span>}</p>
          <p className="break-words text-xs text-kraveo-ink3" lang="hi">{category.nameHi ?? <span lang="en">No Hindi name</span>}</p>
        </div>
      </div>

      {FLAGS.map((flag) => (
        <div key={flag.key} className="mt-3 flex items-center gap-3 lg:mt-0 lg:justify-center">
          <Switch checked={category[flag.key]} onChange={() => onToggle(category, flag.key)} disabled={busy} label={`${category.name}: ${flag.label}`} />
          <span className="text-xs font-semibold text-kraveo-ink2 lg:hidden" aria-hidden="true">{flag.short}</span>
        </div>
      ))}

      <p className="mt-3 text-xs text-kraveo-ink2 lg:mt-0" title="Restaurants and dishes in any state use this category">
        <span className="font-bold tabular-nums text-kraveo-ink">{category.usage.restaurants}</span> {category.usage.restaurants === 1 ? 'restaurant' : 'restaurants'}
        <span aria-hidden="true"> · </span>
        <span className="font-bold tabular-nums text-kraveo-ink">{category.usage.dishes}</span> {category.usage.dishes === 1 ? 'dish' : 'dishes'}
      </p>

      <div className="mt-3 lg:mt-0">
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onEdit(category)} aria-label={`Edit ${category.name}`} disabled={busy}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
          <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onMerge(category)} aria-label={`Merge ${category.name} into another category`} disabled={busy}><GitMerge className="h-3.5 w-3.5" aria-hidden="true" />Merge</button>
          <button type="button" className="k-btn-danger !min-h-[36px] !px-3 text-xs" onClick={() => onDelete(category)} aria-label={`Delete ${category.name}`} aria-describedby={blocked ? reasonId : undefined} disabled={busy || blocked !== null} title={blocked ?? undefined}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete</button>
        </div>
        {blocked && <p id={reasonId} className="mt-1.5 text-[11px] text-kraveo-ink3 lg:text-right">Cannot delete: used by {used}.</p>}
      </div>
    </li>
  );
});
Row.displayName = 'CategoryRow';

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Keeps the admin's unsaved order for ids that still exist; new ids go to the end. */
const mergeOrder = (local: string[], server: string[]): string[] => {
  const present = new Set(server);
  const kept = local.filter((id) => present.has(id));
  const known = new Set(kept);
  return [...kept, ...server.filter((id) => !known.has(id))];
};

const CategoriesPanelBase: React.FC<Props> = ({ query, onClearQuery, onAuthError, onChanged }) => {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [list, setList] = useState<Category[]>([]);
  const [serverOrder, setServerOrder] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const serverOrderRef = useRef<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef<Set<string>>(new Set());
  const [savingOrder, setSavingOrder] = useState(false);
  const [drawer, setDrawer] = useState<{ category: Category | null } | null>(null);
  const [mergeFor, setMergeFor] = useState<Category | null>(null);
  const [announce, setAnnounce] = useState('');
  const focusAfter = useRef<{ id: string; dir: 'up' | 'down' } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    apiService.fetchCategories({ includeInactive: true })
      .then((rows) => {
        if (mine !== seq.current) return;
        const ids = rows.map((r) => r.id);
        // Unsaved order changes survive a reload; an untouched order simply follows the server.
        setOrder((current) => (sameOrder(current, serverOrderRef.current) ? ids : mergeOrder(current, ids)));
        serverOrderRef.current = ids;
        setList(rows); setServerOrder(ids); setError(''); setLoaded(true);
      })
      .catch((failure) => {
        if (mine !== seq.current) return;
        onAuthError(failure);
        setError(errorText(failure, 'The categories could not be loaded.'));
      })
      .finally(() => { if (mine === seq.current) setLoading(false); });
    return () => { seq.current++; };
  }, [reloadKey, onAuthError]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const byId = useMemo(() => new Map(list.map((c) => [c.id, c])), [list]);
  const ordered = useMemo(() => order.map((id) => byId.get(id)).filter((c): c is Category => Boolean(c)), [order, byId]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? ordered.filter((c) => c.name.toLowerCase().includes(q) || (c.nameHi ?? '').toLowerCase().includes(q)) : ordered), [ordered, q]);
  const orderDirty = loaded && !sameOrder(order, serverOrder);
  const searching = q !== '';

  const setBusy = (id: string, on: boolean) => {
    if (on) busyRef.current.add(id); else busyRef.current.delete(id);
    setBusyIds(new Set(busyRef.current));
  };

  const replaceRow = useCallback((next: Category) => setList((current) => current.map((c) => (c.id === next.id ? next : c))), []);

  const toggle = useCallback(async (category: Category, key: FlagKey) => {
    if (busyRef.current.has(category.id)) return;
    setBusy(category.id, true);
    const changes: CategoryInput = { [key]: !category[key] };
    try {
      const out = await apiService.updateCategory(category.id, changes);
      replaceRow(out.category);
    } catch (failure) {
      onAuthError(failure);
      toast.error('Not changed', errorText(failure));
      if (failure instanceof ApiError && failure.status === 409) reload(); // counts may have moved
    } finally {
      setBusy(category.id, false);
    }
  }, [onAuthError, reload, replaceRow, toast]);

  const move = useCallback((id: string, delta: -1 | 1) => {
    const index = order.indexOf(id);
    const next = moveItem(order, index, delta);
    if (next === order) return;
    focusAfter.current = { id, dir: delta < 0 ? 'up' : 'down' };
    setOrder(next);
    setAnnounce(`${byId.get(id)?.name ?? 'Category'} moved to position ${index + delta + 1} of ${order.length}.`);
  }, [order, byId]);

  // After a move the button may have been re-created or disabled (first / last): put the focus back where the admin was working.
  useLayoutEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-move]'));
    const find = (dir: string) => buttons.find((b) => b.dataset.move === `${target.id}:${dir}`);
    const wanted = find(target.dir);
    (wanted && !wanted.disabled ? wanted : find(target.dir === 'up' ? 'down' : 'up'))?.focus();
  }, [order]);

  const saveOrder = async () => {
    if (savingOrder || !orderDirty) return;
    setSavingOrder(true);
    try {
      const rows = await apiService.reorderCategories(order);
      const ids = rows.map((r) => r.id);
      serverOrderRef.current = ids;
      setList(rows); setServerOrder(ids); setOrder(ids);
      toast.success('Order saved', 'Restaurants and the customer app use this order.');
    } catch (failure) {
      onAuthError(failure);
      toast.error('Order not saved', errorText(failure));
      if (failure instanceof ApiError && failure.code === 'CATEGORY_UNKNOWN') reload();
    } finally {
      setSavingOrder(false);
    }
  };

  const discardOrder = () => { setOrder(serverOrder); setAnnounce('Order changes discarded.'); };

  const onSaved = (category: Category, created: boolean, message: string) => {
    setDrawer(null);
    if (created) {
      setList((current) => [...current, category]);
      serverOrderRef.current = [...serverOrderRef.current, category.id];
      setServerOrder(serverOrderRef.current);
      setOrder((current) => [...current, category.id]);
      toast.success('Category added', `“${category.name}” is ready to use.`);
    } else {
      const renamed = byId.get(category.id)?.name !== category.name;
      replaceRow(category);
      toast.success(message === 'Nothing to change.' ? 'Nothing to change' : 'Category saved', message === 'Nothing to change.' ? undefined : `“${category.name}” was updated.`);
      if (renamed) onChanged?.();
    }
  };

  const onDelete = useCallback(async (category: Category) => {
    if (busyRef.current.has(category.id)) return;
    const ok = await confirm({ title: `Delete “${category.name}”?`, message: 'Nothing uses it, so no restaurant or dish is affected. This cannot be undone.', confirmLabel: 'Delete category', danger: true });
    if (!ok) return;
    setBusy(category.id, true);
    try {
      await apiService.deleteCategory(category.id);
      setList((current) => current.filter((c) => c.id !== category.id));
      serverOrderRef.current = serverOrderRef.current.filter((id) => id !== category.id);
      setServerOrder(serverOrderRef.current);
      setOrder((current) => current.filter((id) => id !== category.id));
      toast.success('Category deleted', `“${category.name}” was removed.`);
    } catch (failure) {
      onAuthError(failure);
      toast.error('Not deleted', errorText(failure));
      if (failure instanceof ApiError && failure.status === 409) reload();
    } finally {
      setBusy(category.id, false);
    }
  }, [confirm, onAuthError, reload, toast]);

  const onMerged = (result: MergePreview) => {
    setMergeFor(null);
    toast.success('Categories merged', result.message || 'Everything was moved.');
    reload();
    onChanged?.();
  };

  const edit = useCallback((category: Category) => setDrawer({ category }), []);
  const merge = useCallback((category: Category) => setMergeFor(category), []);
  const initialLoad = loading && !loaded && !error;
  const empty = loaded && !error && list.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-kraveo-ink2">One list for restaurant cuisines and dish categories. Changes reach the apps without a new app version.</p>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className="k-icon-btn" aria-label="Reload categories" title="Reload categories" onClick={reload} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
          <button type="button" className="k-btn-accent" onClick={() => setDrawer({ category: null })}><Plus className="h-4 w-4" aria-hidden="true" />Add category</button>
        </div>
      </div>

      <details className="k-card px-4 py-3 text-sm text-kraveo-ink2" open>
        <summary className="cursor-pointer font-bold text-kraveo-ink">What the switches mean</summary>
        <dl className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {FLAGS.map((flag) => (
            <div key={flag.key}><dt className="inline font-bold text-kraveo-ink">{flag.short}: </dt><dd className="inline">{flag.help}</dd></div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-kraveo-ink3">“Used by” counts every restaurant and dish that has the category, whatever its state. A category can only be deleted when that is zero; otherwise hide it or merge it.</p>
      </details>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" className="k-btn-ghost !min-h-[36px] shrink-0 !px-3 text-xs" onClick={reload}>Try again</button>
        </div>
      )}

      {orderDirty && (
        <div role="region" aria-label="Unsaved order" className="sticky top-2 z-10 flex flex-col gap-2 rounded-k-md border border-kraveo-g400/40 bg-kraveo-surface2 px-4 py-3 shadow-k-lift sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold text-kraveo-ink">The order has changed and is not saved yet.</p>
          <div className="flex gap-2">
            <button type="button" className="k-btn-ghost !min-h-[36px]" onClick={discardOrder} disabled={savingOrder}>Discard</button>
            <button type="button" className="k-btn-primary !min-h-[36px]" onClick={() => void saveOrder()} disabled={savingOrder} aria-busy={savingOrder}>{savingOrder ? 'Saving…' : 'Save order'}</button>
          </div>
        </div>
      )}
      {searching && ordered.length > 1 && <p className="text-xs text-kraveo-ink3">Clear the search to change the order.</p>}
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      {initialLoad && <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} lines={1} />)}</div>}

      {empty && (
        <div className="k-card">
          <EmptyState icon={Tags} title="No categories yet" description="Add the cuisines your restaurants serve and the categories your dishes use." action={<button type="button" className="k-btn-accent" onClick={() => setDrawer({ category: null })}><Plus className="h-4 w-4" aria-hidden="true" />Add category</button>} />
        </div>
      )}

      {loaded && list.length > 0 && visible.length === 0 && (
        <div className="k-card">
          <EmptyState icon={SearchX} title="No categories match" description={`Nothing is called “${query.trim()}”.`} action={<button type="button" className="k-btn-ghost" onClick={onClearQuery}>Clear search</button>} />
        </div>
      )}

      {visible.length > 0 && (
        <div aria-busy={loading} className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
          <div aria-hidden="true" className={`hidden px-4 pb-2 text-[11px] font-bold uppercase tracking-wide text-kraveo-ink3 ${GRID} gap-3`}>
            <span>Order</span><span>Category</span>
            {FLAGS.map((flag) => <span key={flag.key} className="text-center">{flag.short}</span>)}
            <span>Used by</span><span />
          </div>
          <ul className="space-y-3" aria-label="Categories">
            {visible.map((category) => (
              <Row
                key={category.id}
                category={category}
                position={order.indexOf(category.id)}
                total={order.length}
                busy={busyIds.has(category.id) || savingOrder}
                canMove={!searching}
                onToggle={toggle}
                onMove={move}
                onEdit={edit}
                onMerge={merge}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </div>
      )}

      {drawer && <CategoryDrawer category={drawer.category} onClose={() => setDrawer(null)} onSaved={onSaved} onAuthError={onAuthError} />}
      {mergeFor && <CategoryMergeDrawer source={mergeFor} all={list} onClose={() => setMergeFor(null)} onMerged={onMerged} onAuthError={onAuthError} />}
      {dialog}
    </div>
  );
};

export const CategoriesPanel = memo(CategoriesPanelBase);
