import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, ImageOff, Megaphone, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiService, ApiError } from '../services/api';
import { Banner, BannerStatus, MAX_BANNERS, MAX_SHOWN, ctrText, scheduleText } from '../lib/bannerParse';
import { moveItem } from '../lib/categoryParse';
import { errorText } from '../lib/errors';
import { BannerDrawer } from './BannerDrawer';
import { EmptyState } from './ui/EmptyState';
import { SkeletonCard } from './ui/Skeleton';
import { Switch } from './ui/Switch';
import { useToast } from './ui/Toast';
import { useConfirm } from './ui/ConfirmDialog';
import type { ImageEnv } from '../lib/imageCompress';

interface Props {
  onAuthError: (error: unknown) => void;
  /** Tests inject a fake canvas for the picture upload. */
  imageEnv?: ImageEnv;
}

const STATUS: Record<BannerStatus, { label: string; cls: string; help: string }> = {
  LIVE: { label: 'Live', cls: 'bg-kraveo-g400/15 text-kraveo-g300', help: 'Customers see it now.' },
  SCHEDULED: { label: 'Scheduled', cls: 'bg-kraveo-yellow/15 text-kraveo-yellow', help: 'Switched on, waiting for its start time.' },
  EXPIRED: { label: 'Expired', cls: 'bg-kraveo-danger/10 text-kraveo-danger', help: 'Its end time has passed.' },
  OFF: { label: 'Off', cls: 'bg-kraveo-line text-kraveo-ink2', help: 'Switched off. Customers do not see it.' },
};

/** Chip text and explanation. A LIVE banner past the app's limit of 10 is not shown to customers, so it must not say so. */
const statusInfo = (b: Banner): { label: string; cls: string; help: string; extra: string } => {
  if (b.status === 'LIVE' && !b.shown) {
    return { label: `Live (not shown, limit ${MAX_SHOWN})`, cls: 'bg-kraveo-yellow/15 text-kraveo-yellow', help: `Switched on and inside its dates, but the app shows only the first ${MAX_SHOWN} live banners.`, extra: `The app shows only the first ${MAX_SHOWN} live banners, and this one is number ${b.rank ?? '?'}. Move it up, or switch another banner off, for customers to see it.` };
  }
  const base = STATUS[b.status];
  return { ...base, extra: '' };
};

interface RowProps {
  banner: Banner;
  position: number;
  total: number;
  busy: boolean;
  onToggle: (banner: Banner) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onEdit: (banner: Banner) => void;
  onDuplicate: (banner: Banner) => void;
  onDelete: (banner: Banner) => void;
  atLimit: boolean;
}

const Thumb: React.FC<{ url: string }> = ({ url }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  return (
    <div className="relative aspect-[2/1] w-full max-w-[160px] shrink-0 overflow-hidden rounded-k-sm border border-kraveo-line bg-kraveo-surface2 md:w-40">
      {url && !failed
        ? <img src={url} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} />
        : <span className="flex h-full w-full items-center justify-center text-kraveo-ink3"><ImageOff className="h-4 w-4" aria-hidden="true" /><span className="sr-only">Picture cannot be shown here</span></span>}
    </div>
  );
};

const Row = memo<RowProps>(({ banner, position, total, busy, onToggle, onMove, onEdit, onDuplicate, onDelete, atLimit }) => {
  const st = statusInfo(banner);
  const name = banner.title;
  return (
    <li className={`k-card flex flex-col gap-3 p-4 md:flex-row md:items-center ${banner.status === 'OFF' || banner.status === 'EXPIRED' ? 'opacity-90' : ''}`} data-banner-id={banner.id}>
      <div className="flex items-center gap-1 md:flex-col">
        <button type="button" className="k-icon-btn !h-9 !w-9" data-move={`${banner.id}:up`} aria-label={`Move ${name} up`} disabled={position === 0 || busy} onClick={() => onMove(banner.id, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" className="k-icon-btn !h-9 !w-9" data-move={`${banner.id}:down`} aria-label={`Move ${name} down`} disabled={position === total - 1 || busy} onClick={() => onMove(banner.id, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
      </div>

      <Thumb url={banner.imageUrl} />

      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-bold text-kraveo-ink">
          <span className="min-w-0 break-words" data-testid="banner-title">{banner.title}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${st.cls}`} title={st.help} data-testid="banner-status">{st.label}</span>
        </p>
        {st.extra && <p className="break-words text-xs font-semibold text-kraveo-yellow" data-testid="banner-notshown">{st.extra}</p>}
        {banner.subtitle && <p className="line-clamp-2 break-words text-xs text-kraveo-ink2">{banner.subtitle}</p>}
        <p className="text-xs text-kraveo-ink2" data-testid="banner-schedule">{scheduleText(banner)}</p>
        <p className="break-all text-[11px] text-kraveo-ink3">{banner.linkUrl ? `Link: ${banner.linkUrl}` : 'No link (display only)'}</p>
      </div>

      <dl className="grid shrink-0 grid-cols-3 gap-3 text-center md:w-[168px]">
        {([['Views', String(banner.viewCount)], ['Taps', String(banner.clickCount)], ['CTR', ctrText(banner)]] as const).map(([label, value]) => (
          <div key={label}><dt className="text-[10px] font-bold uppercase tracking-wide text-kraveo-ink3">{label}</dt><dd className="font-bold tabular-nums text-kraveo-ink" data-testid={`banner-${label.toLowerCase()}`}>{value}</dd></div>
        ))}
      </dl>

      <div className="flex items-center gap-2 md:w-[96px] md:justify-center">
        <Switch checked={banner.isActive} onChange={() => onToggle(banner)} disabled={busy} label={`${name}: switched on`} />
        <span className="text-xs font-semibold text-kraveo-ink2" aria-hidden="true">{banner.isActive ? 'On' : 'Off'}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onEdit(banner)} aria-label={`Edit ${name}`} disabled={busy}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
        <button type="button" className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => onDuplicate(banner)} aria-label={`Duplicate ${name}`} disabled={busy || atLimit} title={atLimit ? `The limit is ${MAX_BANNERS} banners.` : undefined}><Copy className="h-3.5 w-3.5" aria-hidden="true" />Duplicate</button>
        <button type="button" className="k-btn-danger !min-h-[36px] !px-3 text-xs" onClick={() => onDelete(banner)} aria-label={`Delete ${name}`} disabled={busy}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete</button>
      </div>
    </li>
  );
});
Row.displayName = 'BannerRow';

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const mergeOrder = (local: string[], server: string[]): string[] => {
  const present = new Set(server);
  const kept = local.filter((id) => present.has(id));
  const known = new Set(kept);
  return [...kept, ...server.filter((id) => !known.has(id))];
};

const BannersPanelBase: React.FC<Props> = ({ onAuthError, imageEnv }) => {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [list, setList] = useState<Banner[]>([]);
  const [serverOrder, setServerOrder] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const serverOrderRef = useRef<string[]>([]);
  const orderRef = useRef<string[]>([]);
  // Both orders are changed ONLY through these two, always with a value computed outside any state updater.
  const commitOrder = (next: string[]) => { orderRef.current = next; setOrder(next); };
  const commitServerOrder = (next: string[]) => { serverOrderRef.current = next; setServerOrder(next); };
  // Reload race guards: a list fetched before a delete / duplicate / reorder / edit finished must never overwrite it.
  const requestId = useRef(0); // grows with every fetch; only the newest may be applied
  const mutationGen = useRef(0); // bumped when a change starts and when it finishes; a fetch that overlapped one is stale
  const removedIds = useRef<Set<string>>(new Set()); // ids deleted (or being deleted) here: never shown again, even by a stale answer
  const bumpMutation = () => { mutationGen.current += 1; };
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef<Set<string>>(new Set());
  const [savingOrder, setSavingOrder] = useState(false);
  const [drawer, setDrawer] = useState<{ banner: Banner | null; session: number } | null>(null);
  const drawerRef = useRef<typeof drawer>(null);
  const sessionCounter = useRef(0);
  const openDrawer = (banner: Banner | null) => { sessionCounter.current += 1; const next = { banner, session: sessionCounter.current }; drawerRef.current = next; setDrawer(next); };
  const closeDrawer = () => { drawerRef.current = null; setDrawer(null); };
  const [announce, setAnnounce] = useState('');
  const focusAfter = useRef<{ id: string; dir: 'up' | 'down' } | null>(null);

  useEffect(() => {
    const mine = ++requestId.current;
    const gen = mutationGen.current;
    setLoading(true);
    apiService.fetchBanners()
      .then((fetched) => {
        if (mine !== requestId.current || gen !== mutationGen.current) return; // superseded, or a change happened while it was on the way
        const rows = fetched.filter((r) => !removedIds.current.has(r.id));
        const ids = rows.map((r) => r.id);
        // Unsaved order changes survive a reload; an untouched order simply follows the server.
        const nextOrder = sameOrder(orderRef.current, serverOrderRef.current) ? ids : mergeOrder(orderRef.current, ids);
        commitOrder(nextOrder); commitServerOrder(ids);
        setList(rows); setError(''); setLoaded(true);
      })
      .catch((failure) => {
        if (mine !== requestId.current) return;
        onAuthError(failure);
        setError(errorText(failure, 'The banners could not be loaded.'));
      })
      .finally(() => { if (mine === requestId.current) setLoading(false); });
    return () => { requestId.current++; };
  }, [reloadKey, onAuthError]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const byId = useMemo(() => new Map(list.map((b) => [b.id, b])), [list]);
  const ordered = useMemo(() => order.map((id) => byId.get(id)).filter((b): b is Banner => Boolean(b)), [order, byId]);
  const orderDirty = loaded && !sameOrder(order, serverOrder);
  const atLimit = list.length >= MAX_BANNERS;

  const setBusy = (id: string, on: boolean) => {
    if (on) busyRef.current.add(id); else busyRef.current.delete(id);
    setBusyIds(new Set(busyRef.current));
  };
  const replaceRow = useCallback((next: Banner) => setList((current) => current.map((b) => (b.id === next.id ? next : b))), []);
  const addRow = (banner: Banner) => {
    setList((current) => [...current, banner]);
    commitServerOrder([...serverOrderRef.current, banner.id]);
    commitOrder([...orderRef.current, banner.id]);
  };
  const dropRow = (id: string) => {
    setList((current) => current.filter((b) => b.id !== id));
    commitServerOrder(serverOrderRef.current.filter((x) => x !== id));
    commitOrder(orderRef.current.filter((x) => x !== id));
  };

  // Not optimistic: the switch shows what the server has. It is disabled while the request runs, and the server may refuse
  // (for example "this end time has already passed"): its own sentence is shown.
  const toggle = useCallback(async (banner: Banner) => {
    if (busyRef.current.has(banner.id)) return;
    setBusy(banner.id, true);
    bumpMutation();
    try {
      const out = await apiService.updateBanner(banner.id, { isActive: !banner.isActive });
      replaceRow(out.banner);
      setAnnounce(`${out.banner.title} is now ${out.banner.isActive ? 'switched on' : 'switched off'}.`);
    } catch (failure) {
      onAuthError(failure);
      toast.error('Not changed', errorText(failure));
      if (failure instanceof ApiError && failure.status === 404) reload();
    } finally {
      bumpMutation();
      setBusy(banner.id, false);
    }
  }, [onAuthError, reload, replaceRow, toast]);

  const move = useCallback((id: string, delta: -1 | 1) => {
    const index = order.indexOf(id);
    const next = moveItem(order, index, delta);
    if (next === order) return;
    focusAfter.current = { id, dir: delta < 0 ? 'up' : 'down' };
    commitOrder(next);
    setAnnounce(`${byId.get(id)?.title ?? 'Banner'} moved to position ${index + delta + 1} of ${order.length}.`);
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
    bumpMutation();
    try {
      const rows = (await apiService.reorderBanners(order)).filter((r) => !removedIds.current.has(r.id));
      const ids = rows.map((r) => r.id);
      commitServerOrder(ids); commitOrder(ids);
      setList(rows);
      toast.success('Order saved', 'The app shows live banners in this order.');
      setAnnounce('Order saved.');
    } catch (failure) {
      onAuthError(failure);
      toast.error('Order not saved', errorText(failure));
      setAnnounce('The order could not be saved.');
      if (failure instanceof ApiError && failure.code === 'BANNER_UNKNOWN') reload(); // a banner was deleted meanwhile
    } finally {
      bumpMutation();
      setSavingOrder(false);
    }
  };
  const discardOrder = () => { commitOrder(serverOrder); setAnnounce('Order changes discarded.'); };

  // `session` = which opening of the drawer made the save. A save that finishes for an older opening still updates the list (it happened on
  // the server) but never closes a drawer the admin has opened since.
  const onSaved = (session: number, banner: Banner, created: boolean, message: string) => {
    if (drawerRef.current?.session === session) closeDrawer();
    bumpMutation();
    if (created) {
      addRow(banner);
      toast.success('Banner added', `“${banner.title}” was added to the end of the list.`);
      setAnnounce('Banner added.');
    } else {
      replaceRow(banner);
      toast.success(message === 'Nothing to change.' ? 'Nothing to change' : 'Banner saved', message === 'Nothing to change.' ? undefined : `“${banner.title}” was updated.`);
      setAnnounce(message === 'Nothing to change.' ? 'Nothing to change.' : 'Banner saved.');
    }
    // The server's answer is only that one banner: a quiet reload keeps views, taps and statuses of all rows fresh.
    reload();
  };

  const duplicate = useCallback(async (banner: Banner) => {
    if (busyRef.current.has(banner.id)) return;
    setBusy(banner.id, true);
    bumpMutation();
    try {
      const copy = await apiService.duplicateBanner(banner.id);
      addRow(copy);
      toast.success('Banner copied', `“${copy.title}” was added at the end. It is switched off until you turn it on.`);
      setAnnounce('Banner copied.');
    } catch (failure) {
      onAuthError(failure);
      toast.error('Not copied', errorText(failure));
      if (failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) reload();
    } finally {
      bumpMutation();
      setBusy(banner.id, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAuthError, reload, toast]);

  const remove = useCallback(async (banner: Banner) => {
    if (busyRef.current.has(banner.id)) return;
    const ok = await confirm({ title: `Delete “${banner.title}”?`, message: 'Customers stop seeing it and its view and tap counts are lost. This cannot be undone. To hide it for a while, switch it off instead.', confirmLabel: 'Delete banner', danger: true });
    if (!ok) return;
    setBusy(banner.id, true);
    bumpMutation();
    removedIds.current.add(banner.id); // from now on no (older) list answer may bring the row back
    try {
      await apiService.deleteBanner(banner.id);
      dropRow(banner.id);
      toast.success('Banner deleted', `“${banner.title}” was removed.`);
      setAnnounce('Banner deleted.');
    } catch (failure) {
      removedIds.current.delete(banner.id); // the delete did not happen: the row belongs back
      onAuthError(failure);
      toast.error('Not deleted', errorText(failure));
      reload(); // a list answer in the meantime may have left the row out
    } finally {
      bumpMutation();
      setBusy(banner.id, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, onAuthError, reload, toast]);

  const edit = useCallback((banner: Banner) => openDrawer(banner), []);
  const initialLoad = loading && !loaded && !error;
  const empty = loaded && !error && list.length === 0;
  const add = () => openDrawer(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-kraveo-ink2">The pictures that slide across the top of the customer app Home. Use them for launches, offers and events. Customers see changes the next time they open or refresh the app (and within about 10 minutes while the app stays open), without a new app version. Views and taps are approximate and update within seconds.</p>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className="k-icon-btn" aria-label="Reload banners" title="Reload banners" onClick={reload} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
          <button type="button" className="k-btn-accent" onClick={add} disabled={atLimit} aria-describedby={atLimit ? 'banner-limit' : undefined}><Plus className="h-4 w-4" aria-hidden="true" />Add banner</button>
        </div>
      </div>
      {atLimit && <p id="banner-limit" role="status" className="rounded-k-sm border border-kraveo-yellow/30 bg-kraveo-yellow/10 px-3 py-2 text-sm text-kraveo-ink">There are already {MAX_BANNERS} banners, which is the limit. Delete one you no longer need to add another.</p>}

      <details className="k-card px-4 py-3 text-sm text-kraveo-ink2">
        <summary className="cursor-pointer font-bold text-kraveo-ink">How banners work</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
          <li>Customers see banners that are switched on and inside their dates, in the order below. The app shows at most 10 at once.</li>
          <li>Live = showing now. Scheduled = waiting for its start. Expired = its end has passed. Off = switched off.</li>
          <li>Times are in India time (IST). Views and taps are counted by the app, are approximate and cannot be edited. CTR is taps divided by views.</li>
          <li>Tapping a banner opens its link (a web page, a Play Store page or a Google Form). A banner without a link only shows.</li>
        </ul>
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
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      {initialLoad && <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} lines={1} />)}</div>}

      {empty && (
        <div className="k-card">
          <EmptyState icon={Megaphone} title="No banners yet" description="Banners are the pictures that slide across the top of the customer app Home. Add one for a launch, an offer or an event; it can link to a web page, the Play Store or a Google Form." action={<button type="button" className="k-btn-accent" onClick={add}><Plus className="h-4 w-4" aria-hidden="true" />Add banner</button>} />
        </div>
      )}

      {ordered.length > 0 && (
        <div aria-busy={loading} className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
          <ul className="space-y-3" aria-label="Banners">
            {ordered.map((banner) => (
              <Row
                key={banner.id}
                banner={banner}
                position={order.indexOf(banner.id)}
                total={order.length}
                busy={busyIds.has(banner.id) || savingOrder}
                onToggle={toggle}
                onMove={move}
                onEdit={edit}
                onDuplicate={duplicate}
                onDelete={remove}
                atLimit={atLimit}
              />
            ))}
          </ul>
        </div>
      )}

      {drawer && <BannerDrawer key={drawer.session} banner={drawer.banner} onClose={closeDrawer} onSaved={(b, c, m) => onSaved(drawer.session, b, c, m)} onAuthError={onAuthError} imageEnv={imageEnv} />}
      {dialog}
    </div>
  );
};

export const BannersPanel = memo(BannersPanelBase);
