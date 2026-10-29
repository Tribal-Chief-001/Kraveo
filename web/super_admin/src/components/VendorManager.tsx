import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Landmark, MapPin, Pencil, Plus, SearchX, Star, Store } from 'lucide-react';
import { Order, Vendor } from '../types';
import { activeOrderCountByVendor } from '../lib/dashboardStats';
import type { SavedPin } from '../lib/vendorLocation';
import { VendorLocationEditor } from './VendorLocationEditor';
import { CommissionEditor } from './CommissionEditor';
import type { VendorCommission } from '../lib/catalogParse';
import { AddPartnerDrawer } from './AddPartnerDrawer';
import { EditRestaurantDrawer } from './EditRestaurantDrawer';
import { NO_OWNER_EXPLAIN, NoOwnerChip, OwnerPatch, OwnerStatusChip } from './OwnerLoginSection';
import { VendorAction, VendorActionDialogs } from './VendorActions';
import { apiService } from '../services/api';
import { adminErrorText } from '../lib/errors';
import { PayoutAccountPanel } from './PayoutAccountPanel';
import { ApprovalPill } from './ui/ApprovalPill';
import { Avatar } from './ui/Avatar';
import { EmptyState } from './ui/EmptyState';
import { SkeletonCard } from './ui/Skeleton';
import { Switch } from './ui/Switch';

interface VendorManagerProps {
  vendors: Vendor[];
  /** The loaded orders: "Active orders" per restaurant is counted from them (the vendors API does not send it). */
  orders?: Order[];
  /** Restaurants whose open/close request is still running: their switch is disabled. */
  busyVendorIds?: ReadonlySet<string>;
  onToggleVendor: (vendorId: string) => void;
  /** Called after a restaurant (with its owner login) was created, so the list reloads. */
  onCreated?: () => void;
  /** Called after an admin saved a restaurant's map pin, so the list (and the live map) use it at once. */
  onLocationSaved?: (vendorId: string, saved: SavedPin) => void;
  /** Called after an admin saved a restaurant's commission, so the list uses it at once. */
  onCommissionSaved?: (vendorId: string, commission: VendorCommission) => void;
  /** Called after an admin saved the restaurant's profile (name, categories, address, banner, FSSAI, ETA); `vendor` is the fresh admin view. */
  onProfileSaved?: (vendor: Vendor) => void;
  /** Session errors from the commission save (logs out on 401/403). */
  onAuthError?: (error: unknown) => void;
  /** Docs/28: a restaurant was suspended, reinstated, removed or restored (`vendor` = the fresh admin view). The list should reload. */
  onVendorChanged?: (vendor: Vendor) => void;
  /** Docs/28: the owner login or the open flag of a restaurant changed. */
  onOwnerChanged?: (vendorId: string, patch: OwnerPatch) => void;
  /** Opens an order in the order drawer (the blocking orders in the dialogs are links). */
  onOpenOrder?: (orderId: string) => void;
  loading?: boolean;
  query?: string;
  onClearQuery?: () => void;
}

type VendorFilter = 'ALL' | 'OPEN' | 'CLOSED' | 'NO_OWNER' | 'REMOVED';

/** Payout details (UPI / bank) of an approved restaurant's owner. Closed by default so the list does not call the server per card. */
const VendorPayout: React.FC<{ vendor: Vendor; onAuthError?: (error: unknown) => void }> = ({ vendor, onAuthError }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button type="button" className="k-btn-ghost !min-h-[36px] w-full justify-between text-xs" aria-expanded={open} onClick={() => setOpen((v) => !v)} aria-label={`Payout details of ${vendor.name}`}>
        <span className="flex items-center gap-2"><Landmark className="h-3.5 w-3.5" aria-hidden="true" />Payout details</span>
        {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      {open && <div className="mt-2"><PayoutAccountPanel userId={vendor.userId} name={vendor.name} kind="restaurant" onAuthError={onAuthError} /></div>}
    </div>
  );
};

/** The server refuses to OPEN a restaurant without an owner login (409 NO_OWNER). Closing one always works, so only the closed switch is off. */
const cannotOpen = (v: Vendor): boolean => v.owner === null && !v.isAcceptingOrders;
const OPEN_NEEDS_OWNER = 'Add an owner login first, then it can be opened.';

const NO_ORDERS: Order[] = [];
const NOT_BUSY: ReadonlySet<string> = new Set();

export const VendorManager: React.FC<VendorManagerProps> = ({ vendors, orders = NO_ORDERS, busyVendorIds = NOT_BUSY, onToggleVendor, onCreated, onLocationSaved, onCommissionSaved, onProfileSaved, onAuthError, onVendorChanged, onOwnerChanged, onOpenOrder, loading = false, query = '', onClearQuery }) => {
  const [showDrawer, setShowDrawer] = useState(false);
  const [filter, setFilter] = useState<VendorFilter>('ALL');
  const [editing, setEditing] = useState<Vendor | null>(null);
  // The dialogs stay mounted after the first action so a result notice (orders cancelled / failed) can outlive the dialog that sent it.
  const [acting, setActing] = useState<{ vendor: Vendor; action: VendorAction | null } | null>(null);
  // Removed restaurants are not in the normal list: they are fetched when the "Removed" filter is chosen.
  const [removed, setRemoved] = useState<{ status: 'idle' | 'loading' | 'ready' | 'failed'; rows: Vendor[]; error: string }>({ status: 'idle', rows: [], error: '' });
  const removedSeq = useRef(0);

  const loadRemoved = useCallback(async () => {
    const seq = ++removedSeq.current;
    setRemoved((c) => ({ ...c, status: 'loading', error: '' }));
    try {
      const rows = await apiService.fetchRemovedVendors();
      if (seq === removedSeq.current) setRemoved({ status: 'ready', rows, error: '' });
    } catch (e) {
      onAuthError?.(e);
      if (seq === removedSeq.current) setRemoved((c) => ({ ...c, status: 'failed', error: adminErrorText(e, 'Removed restaurants could not be loaded.') }));
    }
  }, [onAuthError]);
  useEffect(() => { if (filter === 'REMOVED') void loadRemoved(); }, [filter, loadRemoved]);

  const counts = useMemo(() => ({
    ALL: vendors.length,
    OPEN: vendors.filter((v) => v.isAcceptingOrders).length,
    CLOSED: vendors.filter((v) => !v.isAcceptingOrders).length,
    // owner === null is the server saying "no owner"; undefined (older server) is not counted.
    NO_OWNER: vendors.filter((v) => v.owner === null).length,
  }), [vendors]);

  const activeByVendor = useMemo(() => activeOrderCountByVendor(orders), [orders]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = filter === 'REMOVED' ? removed.rows : vendors;
    return source.filter((v) => {
      const matches = !q || [v.name, v.category, v.address, ...(v.cuisines ?? []).map((c) => c.name)].some((value) => value.toLowerCase().includes(q));
      const status = filter === 'ALL' || filter === 'REMOVED' || (filter === 'OPEN' ? v.isAcceptingOrders : filter === 'CLOSED' ? !v.isAcceptingOrders : v.owner === null);
      return matches && status;
    });
  }, [vendors, removed.rows, query, filter]);

  const initialLoad = loading && vendors.length === 0;
  const onboardButton = (
    <button onClick={() => setShowDrawer(true)} className="k-btn-accent">
      <Plus className="h-4 w-4" aria-hidden="true" /> Add restaurant
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:px-0" role="group" aria-label="Filter vendors">
          {([['ALL', 'All'], ['OPEN', 'Open'], ['CLOSED', 'Closed'], ...(counts.NO_OWNER > 0 || filter === 'NO_OWNER' ? [['NO_OWNER', 'No owner'] as const] : []), ['REMOVED', 'Removed']] as const).map(([id, label]) => (
            <button key={id} className="k-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
              {id !== 'REMOVED' && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${filter === id ? 'bg-kraveo-g400/25' : 'bg-kraveo-line/70'}`}>{counts[id]}</span>}
            </button>
          ))}
        </div>
        {onboardButton}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 2xl:grid-cols-3">
        {initialLoad && Array.from({ length: 6 }).map((_, index) => <SkeletonCard key={index} lines={3} />)}
        {filter === 'REMOVED' && removed.status === 'loading' && Array.from({ length: 2 }).map((_, index) => <SkeletonCard key={index} lines={2} />)}
        {filter === 'REMOVED' && removed.status === 'failed' && (
          <div className="k-card sm:col-span-2 2xl:col-span-3" role="alert">
            <EmptyState icon={Store} title="Removed restaurants could not be loaded" description={removed.error} action={<button className="k-btn-ghost" onClick={() => void loadRemoved()}>Try again</button>} />
          </div>
        )}
        {filter === 'REMOVED' && removed.status === 'ready' && removed.rows.length === 0 && (
          <div className="k-card sm:col-span-2 2xl:col-span-3"><EmptyState icon={Store} title="No restaurant has been removed." description="Removed restaurants are listed here, and can be restored." /></div>
        )}
        {filter !== 'REMOVED' && !initialLoad && vendors.length === 0 && (
          <div className="k-card sm:col-span-2 2xl:col-span-3">
            <EmptyState icon={Store} title="No vendors yet" description="Add a restaurant here, or approve one that applied in the Applications tab." action={onboardButton} />
          </div>
        )}
        {filter !== 'REMOVED' && !initialLoad && vendors.length > 0 && visible.length === 0 && (
          <div className="k-card sm:col-span-2 2xl:col-span-3">
            <EmptyState icon={SearchX} title="No vendors match" description="Nothing matches the current filter and search." action={<button className="k-btn-ghost" onClick={() => { setFilter('ALL'); onClearQuery?.(); }}>Clear filters</button>} />
          </div>
        )}
        {visible.map((v, index) => (
          <article key={v.id} className="k-card k-card-hover k-reveal flex flex-col p-5" style={{ ['--i' as string]: Math.min(index, 10) }}>
            <div className="flex items-start gap-3.5">
              <Avatar name={v.name} size="lg" className="!rounded-k-md" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-display text-lg font-bold leading-tight text-kraveo-ink" title={v.name}>{v.name}</h3>
                <p className="truncate text-xs font-semibold text-kraveo-g300">{v.category}</p>
                {!v.removedAt && v.cuisines && v.cuisines.length === 0 && (
                  <button type="button" className="mt-1 text-[11px] font-bold text-kraveo-status-placed underline-offset-2 hover:underline" onClick={() => setEditing(v)} aria-label={`${v.name} has no categories yet. Add categories`}>No categories yet. Add some</button>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {v.removedAt ? <span className="inline-flex whitespace-nowrap rounded-full bg-kraveo-danger/15 px-2.5 py-1 text-[11px] font-bold text-kraveo-danger">Removed</span> : <ApprovalPill status={v.approvalStatus} />}
                  {v.owner === null && !v.removedAt && <NoOwnerChip />}
                  {v.owner && v.owner.accountStatus !== 'ACTIVE' && <OwnerStatusChip owner={v.owner} />}
                </div>
                {v.owner === null && !v.removedAt && (
                  <p className="mt-1.5 text-[11px] leading-snug text-kraveo-ink3">
                    {NO_OWNER_EXPLAIN}{' '}
                    <button type="button" className="font-bold text-kraveo-g300 underline-offset-2 hover:underline" onClick={() => setEditing(v)} aria-label={`Add an owner login for ${v.name}`}>Add an owner login</button>
                  </p>
                )}
                {v.owner && <p className="mt-1.5 break-words text-[11px] text-kraveo-ink3">Owner: <span className="font-semibold text-kraveo-ink2">{v.owner.name}</span>{v.owner.phone ? ` · ${v.owner.phone}` : ''}</p>}
                {v.removedAt && <p className="mt-1.5 break-words text-[11px] text-kraveo-ink3">Removed{v.removedReason ? `: ${v.removedReason}` : ''}</p>}
                <p className="mt-1.5 flex items-center gap-1 text-xs text-kraveo-ink3"><MapPin className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{v.address}</span></p>
              </div>
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-kraveo-surface2 px-2.5 py-1 text-xs font-bold text-kraveo-ink" title={v.totalRatingsCount ? `${v.totalRatingsCount} ratings` : 'No ratings yet'}>
                <Star className={`h-3.5 w-3.5 ${v.rating > 0 ? 'fill-kraveo-yellow text-kraveo-yellow' : 'text-kraveo-ink3'}`} aria-hidden="true" />
                {v.rating > 0 ? v.rating.toFixed(1) : 'New'}
              </span>
            </div>

            {v.removedAt ? (
              <button type="button" className="k-btn-primary mt-4 w-full" onClick={() => setActing({ vendor: v, action: 'restore' })} aria-label={`Restore ${v.name}`}>Restore restaurant</button>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <div className="k-inset px-3 py-2.5">
                    <p className="k-label">Menu items</p>
                    <p className="k-num text-xl text-kraveo-ink">{v.menuItems ? v.menuItems.length : '-'}</p>
                  </div>
                  <div className="k-inset px-3 py-2.5">
                    <p className="k-label">Active orders</p>
                    <p className="k-num text-xl text-kraveo-ink">{activeByVendor.get(v.id) ?? 0}</p>
                  </div>
                </div>

                <button type="button" className="k-btn-ghost mt-3 w-full" onClick={() => setEditing(v)} aria-label={`Edit restaurant ${v.name}`}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />Edit restaurant
                </button>

                <VendorLocationEditor id={v.id} name={v.name} pin={v} onSaved={onLocationSaved} />
                {onCommissionSaved && <CommissionEditor id={v.id} name={v.name} commissionType={v.commissionType} commissionValue={v.commissionValue} onSaved={onCommissionSaved} onAuthError={onAuthError} />}
                {v.approvalStatus === 'APPROVED' && <VendorPayout vendor={v} onAuthError={onAuthError} />}

                <div className="mt-3 grid grid-cols-2 gap-2">
                  {v.approvalStatus === 'SUSPENDED'
                    ? <button type="button" className="k-btn-ghost !min-h-[40px] text-xs" onClick={() => setActing({ vendor: v, action: 'reinstate' })} aria-label={`Reinstate ${v.name}`}>Reinstate</button>
                    : <button type="button" className="k-btn-ghost !min-h-[40px] text-xs" disabled={v.approvalStatus !== undefined && v.approvalStatus !== 'APPROVED'} onClick={() => setActing({ vendor: v, action: 'suspend' })} aria-label={`Suspend ${v.name}`}>Suspend</button>}
                  <button type="button" className="k-btn-danger !min-h-[40px] text-xs" onClick={() => setActing({ vendor: v, action: 'remove' })} aria-label={`Remove ${v.name}`}>Remove</button>
                </div>

                <div className="mt-4 border-t border-kraveo-line pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className={`k-dot ${v.isAcceptingOrders ? 'bg-kraveo-g400 k-dot-live' : 'bg-kraveo-danger'}`} aria-hidden="true" />
                      <div>
                        <p className={`text-sm font-bold ${v.isAcceptingOrders ? 'text-kraveo-g300' : 'text-kraveo-danger'}`}>{v.isAcceptingOrders ? 'Open for orders' : 'Closed'}</p>
                        <p className="text-[11px] text-kraveo-ink3">Accepting orders</p>
                      </div>
                    </div>
                    <Switch
                      checked={v.isAcceptingOrders}
                      onChange={() => onToggleVendor(v.id)}
                      disabled={busyVendorIds.has(v.id) || cannotOpen(v)}
                      label={`${v.name}: accepting orders`}
                      title={cannotOpen(v) ? OPEN_NEEDS_OWNER : undefined}
                      describedBy={cannotOpen(v) ? `no-owner-hint-${v.id}` : undefined}
                    />
                  </div>
                  {cannotOpen(v) && <p id={`no-owner-hint-${v.id}`} className="mt-2 text-[11px] text-kraveo-status-placed">{OPEN_NEEDS_OWNER}</p>}
                </div>
              </>
            )}
          </article>
        ))}
      </div>

      {editing && <EditRestaurantDrawer key={editing.id} vendor={editing} onClose={() => setEditing(null)} onSaved={(saved) => onProfileSaved?.(saved)} onAuthError={onAuthError} onOwnerChanged={onOwnerChanged} onOpenOrder={onOpenOrder} />}
      {acting && (
        <VendorActionDialogs
          action={acting.action}
          vendor={acting.vendor}
          onClose={() => setActing((current) => (current ? { ...current, action: null } : current))}
          onDone={(fresh) => { onVendorChanged?.(fresh); if (removed.status !== 'idle') void loadRemoved(); }}
          onAuthError={(e) => onAuthError?.(e)}
          onOpenOrder={onOpenOrder}
        />
      )}
      <AddPartnerDrawer open={showDrawer} kind="VENDOR" onClose={() => setShowDrawer(false)} onCreated={() => onCreated?.()} />
    </div>
  );
};
