import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ListOrdered, Loader2, RefreshCw } from 'lucide-react';
import { Vendor } from '../types';
import { ApiError, apiService } from '../services/api';
import type { CatalogDish } from '../lib/catalogParse';
import { MAX_ORDER_DISHES, MenuOrderSection, buildSections, countChanges, countDishes, describeChanges, moveDish, moveSection, orderLimitProblem, sameOrder, toMenuOrderInput } from '../lib/menuOrder';
import { errorText } from '../lib/errors';
import { Drawer } from './ui/Drawer';
import { useConfirm } from './ui/ConfirmDialog';
import { useToast } from './ui/Toast';

interface Props {
  vendor: Pick<Vendor, 'id' | 'name'>;
  onClose: () => void;
  /** The server accepted a new order: the dish list behind this panel should reload. */
  onSaved?: () => void;
  onAuthError: (error: unknown) => void;
}

const PAGE = 100;
/** The server caps the order at MAX_ORDER_DISHES; one page more tells us the menu is bigger than that. */
const MAX_PAGES = Math.ceil(MAX_ORDER_DISHES / PAGE) + 1;

/** Every non-deleted dish of the restaurant, in menu order. */
const loadAllDishes = async (vendorId: string): Promise<CatalogDish[]> => {
  const all: CatalogDish[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await apiService.fetchCatalog({ vendorId, page, pageSize: PAGE });
    all.push(...result.items);
    if (!result.hasMore) break;
  }
  return all;
};

type Pending = { id: string; dir: 'up' | 'down' } | null;

const moveButton = 'k-icon-btn !h-9 !w-9 shrink-0 disabled:opacity-40';

/**
 * Docs/26 section 3: the order of a restaurant's menu sections and of the dishes inside each section. Up / down buttons only
 * (keyboard friendly, no dragging). Nothing reaches customers until "Save order" succeeds.
 */
export const MenuOrderPanel: React.FC<Props> = ({ vendor, onClose, onSaved, onAuthError }) => {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [saved, setSaved] = useState<readonly MenuOrderSection[]>([]);
  const [sections, setSections] = useState<readonly MenuOrderSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState('');
  const savingRef = useRef(false);
  const seq = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const pending = useRef<Pending>(null);
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  const load = useCallback(async (silent = false) => {
    const mine = ++seq.current;
    if (!silent) { setLoading(true); setLoadError(''); }
    try {
      const dishes = await loadAllDishes(vendor.id);
      if (mine !== seq.current) return;
      const built = buildSections(dishes);
      setSaved(built); setSections(built);
      setLoadError('');
    } catch (failure) {
      if (mine !== seq.current) return;
      authRef.current(failure);
      if (!silent) setLoadError(errorText(failure, 'The menu could not be loaded. Please try again.'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [vendor.id]);

  useEffect(() => { void load(); return () => { seq.current++; }; }, [load]);

  const dirty = !sameOrder(saved, sections);
  const changes = useMemo(() => countChanges(saved, sections), [saved, sections]);
  const limit = orderLimitProblem(sections);

  // After a move the button that was pressed has moved in the list: give focus back to it (or its twin when it hit the end).
  useLayoutEffect(() => {
    const want = pending.current;
    if (!want) return;
    pending.current = null;
    const find = (dir: string) => panelRef.current?.querySelector<HTMLButtonElement>(`[data-move="${want.id}:${dir}"]`) ?? null;
    const first = find(want.dir);
    const target = first && !first.disabled ? first : find(want.dir === 'up' ? 'down' : 'up');
    target?.focus();
  }, [sections]);

  const moveSectionBy = (section: MenuOrderSection, delta: -1 | 1) => {
    if (savingRef.current) return;
    const next = moveSection(sections, section.key, delta);
    if (next === sections) return;
    pending.current = { id: `s:${section.key}`, dir: delta < 0 ? 'up' : 'down' };
    setSections(next); setSaveError('');
    const place = next.findIndex((s) => s.key === section.key) + 1;
    setAnnounce(`${section.category || 'Unnamed section'} moved ${delta < 0 ? 'up' : 'down'} to position ${place} of ${next.length}.`);
  };

  const moveDishBy = (section: MenuOrderSection, dishId: string, name: string, delta: -1 | 1) => {
    if (savingRef.current) return;
    const next = moveDish(sections, section.key, dishId, delta);
    if (next === sections) return;
    pending.current = { id: `d:${dishId}`, dir: delta < 0 ? 'up' : 'down' };
    setSections(next); setSaveError('');
    const place = (next.find((s) => s.key === section.key)?.dishes.findIndex((d) => d.id === dishId) ?? 0) + 1;
    setAnnounce(`${name} moved ${delta < 0 ? 'up' : 'down'} to position ${place} of ${section.dishes.length} in ${section.category || 'this section'}.`);
  };

  const toggle = (key: string) => setOpen((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  const discard = () => {
    if (savingRef.current || !dirty) return;
    setSections(saved); setSaveError('');
    setAnnounce('Changes discarded. The order is back to what is saved.');
  };

  const save = async () => {
    if (savingRef.current || !dirty || limit) return;
    savingRef.current = true; setSaving(true); setSaveError('');
    const sent = sections;
    try {
      const result = await apiService.saveMenuOrder(vendor.id, toMenuOrderInput(sent));
      setSaved(sent);
      setAnnounce(result.changed ? 'Menu order saved.' : 'Nothing to change: the menu already had this order.');
      if (result.changed) toast.success('Menu order saved', result.message || `${vendor.name}: the new order is live for customers.`);
      else toast.info('Nothing to change', result.message || 'The menu already had this order.');
      onSaved?.();
      void load(true); // show exactly what the server now has
    } catch (failure) {
      onAuthError(failure);
      const invalid = failure instanceof ApiError && failure.code === 'MENU_ORDER_INVALID';
      setSaveError(invalid ? `${errorText(failure)} The menu may have changed meanwhile. Reload the menu and try again.` : errorText(failure, 'The order was not saved. Please try again.'));
    } finally {
      savingRef.current = false; setSaving(false);
    }
  };

  const requestClose = async () => {
    if (savingRef.current) return;
    if (dirty) {
      const leave = await confirm({ title: 'Leave without saving?', message: 'The new order has not been saved. Customers still see the old order.', confirmLabel: 'Leave without saving', cancelLabel: 'Keep editing', danger: true });
      if (!leave) return;
    }
    onClose();
  };

  const reload = async () => {
    if (savingRef.current) return;
    if (dirty) {
      const ok = await confirm({ title: 'Reload and lose your changes?', message: 'Reloading shows the saved order again. Your unsaved moves are lost.', confirmLabel: 'Reload', cancelLabel: 'Keep editing', danger: true });
      if (!ok) return;
    }
    void load();
  };

  const footer = (
    <div className="space-y-2 pb-4">
      <p role="status" className={`text-xs font-semibold ${dirty ? 'text-kraveo-status-placed' : 'text-kraveo-ink3'}`} data-testid="order-status">
        {dirty ? `Unsaved changes: ${describeChanges(changes)}.` : 'The order shown is the saved order.'}
      </p>
      {saveError && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{saveError}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="k-btn-primary flex-1" onClick={() => void save()} disabled={!dirty || saving || Boolean(limit) || loading} aria-busy={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Save order
        </button>
        <button type="button" className="k-btn-ghost" onClick={discard} disabled={!dirty || saving}>Discard changes</button>
        <button type="button" className="k-btn-ghost" onClick={() => void requestClose()} disabled={saving}>Close</button>
      </div>
    </div>
  );

  return (
    <>
      <Drawer open onClose={() => void requestClose()} title="Menu order" subtitle={vendor.name} icon={ListOrdered} wide footer={footer}>
        <div ref={panelRef} className="space-y-4">
          <p className="text-sm text-kraveo-ink2">Customers see the sections in this order, and the dishes in this order inside each section. Use the arrows to move a section or a dish. Nothing changes for customers until you press <b>Save order</b>.</p>
          <div role="status" aria-live="polite" className="sr-only" data-testid="order-announce">{announce}</div>

          {loading && (
            <p className="flex items-center gap-2 text-sm text-kraveo-ink3" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading the menu…</p>
          )}
          {!loading && loadError && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">
              <span className="min-w-0 break-words">{loadError}</span>
              <button type="button" className="k-btn-ghost !min-h-[36px] shrink-0 !px-3 text-xs" onClick={() => void load()}>Try again</button>
            </div>
          )}
          {!loading && !loadError && sections.length === 0 && <p className="rounded-k-sm border border-kraveo-line bg-kraveo-surface2 px-3 py-2 text-sm text-kraveo-ink2">{vendor.name} has no dishes yet, so there is nothing to put in order.</p>}
          {limit && <p role="alert" className="rounded-k-sm border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 px-3 py-2 text-sm text-kraveo-ink">{limit} Delete or merge some dishes first.</p>}

          {sections.length > 0 && (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-kraveo-ink3">{sections.length} {sections.length === 1 ? 'section' : 'sections'}, {countDishes(sections)} {countDishes(sections) === 1 ? 'dish' : 'dishes'}</p>
                <button type="button" className="k-btn-ghost !min-h-[32px] !px-3 text-xs" onClick={() => void reload()} disabled={saving || loading}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Reload</button>
              </div>
              <ol className="space-y-2" aria-label="Menu sections">
                {sections.map((section, index) => {
                  const expanded = open.has(section.key);
                  const name = section.category || 'Dishes without a section';
                  const fixed = section.key === '';
                  const panelId = `order-dishes-${index}`;
                  return (
                    <li key={section.key || '__none'} className="rounded-k-md border border-kraveo-line bg-kraveo-surface2/40" data-section={section.key}>
                      <div className="flex items-center gap-2 p-2">
                        <button type="button" className="flex min-h-[40px] min-w-0 flex-1 items-center gap-2 rounded-k-sm px-2 text-left" aria-expanded={expanded} aria-controls={panelId} onClick={() => toggle(section.key)}>
                          {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-kraveo-ink3" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0 text-kraveo-ink3" aria-hidden="true" />}
                          <span className="min-w-0">
                            <span className="block break-words text-sm font-bold text-kraveo-ink"><span className="mr-1.5 text-xs font-semibold tabular-nums text-kraveo-ink3">{index + 1}.</span>{name}</span>
                            <span className="block text-xs text-kraveo-ink3">{section.dishes.length} {section.dishes.length === 1 ? 'dish' : 'dishes'}{expanded ? '' : ' · show dishes'}</span>
                          </span>
                        </button>
                        <button type="button" className={moveButton} data-move={`s:${section.key}:up`} aria-label={`Move section ${name} up`} disabled={saving || fixed || index === 0} onClick={() => moveSectionBy(section, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
                        <button type="button" className={moveButton} data-move={`s:${section.key}:down`} aria-label={`Move section ${name} down`} disabled={saving || fixed || index >= sections.length - 1 || sections[index + 1].key === ''} onClick={() => moveSectionBy(section, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
                      </div>
                      {expanded && (
                        <ol id={panelId} className="space-y-1 border-t border-kraveo-line/60 p-2" aria-label={`Dishes in ${name}`}>
                          {section.dishes.map((dish, di) => (
                            <li key={dish.id} className="flex items-center gap-2 rounded-k-sm px-1 py-0.5" data-dish={dish.id}>
                              <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-kraveo-ink3">{di + 1}.</span>
                              <span className="min-w-0 flex-1 break-words text-sm text-kraveo-ink">
                                {dish.name}
                                {dish.notLive && <span className="ml-2 text-[11px] font-semibold text-kraveo-status-placed">not live yet</span>}
                                {!dish.isAvailable && <span className="ml-2 text-[11px] font-semibold text-kraveo-ink3">sold out</span>}
                              </span>
                              <button type="button" className={moveButton} data-move={`d:${dish.id}:up`} aria-label={`Move ${dish.name} up`} disabled={saving || di === 0} onClick={() => moveDishBy(section, dish.id, dish.name, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
                              <button type="button" className={moveButton} data-move={`d:${dish.id}:down`} aria-label={`Move ${dish.name} down`} disabled={saving || di >= section.dishes.length - 1} onClick={() => moveDishBy(section, dish.id, dish.name, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
                            </li>
                          ))}
                        </ol>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      </Drawer>
      {dialog}
    </>
  );
};
