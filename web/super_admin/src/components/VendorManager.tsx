import React, { useMemo, useState } from 'react';
import { MapPin, Plus, SearchX, Star, Store } from 'lucide-react';
import { Vendor } from '../types';
import type { SavedPin } from '../lib/vendorLocation';
import { VendorLocationEditor } from './VendorLocationEditor';
import { AddPartnerDrawer } from './AddPartnerDrawer';
import { ApprovalPill } from './ui/ApprovalPill';
import { Avatar } from './ui/Avatar';
import { EmptyState } from './ui/EmptyState';
import { SkeletonCard } from './ui/Skeleton';
import { Switch } from './ui/Switch';

interface VendorManagerProps {
  vendors: Vendor[];
  onToggleVendor: (vendorId: string) => void;
  /** Called after a restaurant (with its owner login) was created, so the list reloads. */
  onCreated?: () => void;
  /** Called after an admin saved a restaurant's map pin, so the list (and the live map) use it at once. */
  onLocationSaved?: (vendorId: string, saved: SavedPin) => void;
  loading?: boolean;
  query?: string;
  onClearQuery?: () => void;
}

type VendorFilter = 'ALL' | 'OPEN' | 'CLOSED';

export const VendorManager: React.FC<VendorManagerProps> = ({ vendors, onToggleVendor, onCreated, onLocationSaved, loading = false, query = '', onClearQuery }) => {
  const [showDrawer, setShowDrawer] = useState(false);
  const [filter, setFilter] = useState<VendorFilter>('ALL');

  const counts = useMemo(() => ({
    ALL: vendors.length,
    OPEN: vendors.filter((v) => v.isAcceptingOrders).length,
    CLOSED: vendors.filter((v) => !v.isAcceptingOrders).length,
  }), [vendors]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vendors.filter((v) => {
      const matches = !q || [v.name, v.category, v.address].some((value) => value.toLowerCase().includes(q));
      const status = filter === 'ALL' || (filter === 'OPEN' ? v.isAcceptingOrders : !v.isAcceptingOrders);
      return matches && status;
    });
  }, [vendors, query, filter]);

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
          {([['ALL', 'All'], ['OPEN', 'Open'], ['CLOSED', 'Closed']] as const).map(([id, label]) => (
            <button key={id} className="k-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${filter === id ? 'bg-kraveo-g400/25' : 'bg-kraveo-line/70'}`}>{counts[id]}</span>
            </button>
          ))}
        </div>
        {onboardButton}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 2xl:grid-cols-3">
        {initialLoad && Array.from({ length: 6 }).map((_, index) => <SkeletonCard key={index} lines={3} />)}
        {!initialLoad && vendors.length === 0 && (
          <div className="k-card sm:col-span-2 2xl:col-span-3">
            <EmptyState icon={Store} title="No vendors yet" description="Add a restaurant here, or approve one that applied in the Applications tab." action={onboardButton} />
          </div>
        )}
        {!initialLoad && vendors.length > 0 && visible.length === 0 && (
          <div className="k-card sm:col-span-2 2xl:col-span-3">
            <EmptyState icon={SearchX} title="No vendors match" description="Nothing matches the current filter and search." action={<button className="k-btn-ghost" onClick={() => { setFilter('ALL'); onClearQuery?.(); }}>Clear filters</button>} />
          </div>
        )}
        {visible.map((v, index) => (
          <article key={v.id} className="k-card k-card-hover k-reveal flex flex-col p-5" style={{ ['--i' as string]: Math.min(index, 10) }}>
            <div className="flex items-start gap-3.5">
              <Avatar name={v.name} size="lg" className="!rounded-k-md" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-display text-lg font-bold leading-tight text-kraveo-ink">{v.name}</h3>
                <p className="truncate text-xs font-semibold text-kraveo-g300">{v.category}</p>
                <ApprovalPill status={v.approvalStatus} className="mt-1.5" />
                <p className="mt-1.5 flex items-center gap-1 text-xs text-kraveo-ink3"><MapPin className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{v.address}</span></p>
              </div>
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-kraveo-surface2 px-2.5 py-1 text-xs font-bold text-kraveo-ink" title={v.totalRatingsCount ? `${v.totalRatingsCount} ratings` : 'No ratings yet'}>
                <Star className={`h-3.5 w-3.5 ${v.rating > 0 ? 'fill-kraveo-yellow text-kraveo-yellow' : 'text-kraveo-ink3'}`} aria-hidden="true" />
                {v.rating > 0 ? v.rating.toFixed(1) : 'New'}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="k-inset px-3 py-2.5">
                <p className="k-label">Menu items</p>
                <p className="k-num text-xl text-kraveo-ink">{v.menuItems ? v.menuItems.length : '-'}</p>
              </div>
              <div className="k-inset px-3 py-2.5">
                <p className="k-label">Active orders</p>
                <p className="k-num text-xl text-kraveo-ink">{v.activeOrdersCount}</p>
              </div>
            </div>

            <VendorLocationEditor id={v.id} name={v.name} pin={v} onSaved={onLocationSaved} />

            <div className="mt-4 flex items-center justify-between gap-3 border-t border-kraveo-line pt-4">
              <div className="flex items-center gap-2">
                <span className={`k-dot ${v.isAcceptingOrders ? 'bg-kraveo-g400 k-dot-live' : 'bg-kraveo-danger'}`} aria-hidden="true" />
                <div>
                  <p className={`text-sm font-bold ${v.isAcceptingOrders ? 'text-kraveo-g300' : 'text-kraveo-danger'}`}>{v.isAcceptingOrders ? 'Open for orders' : 'Closed'}</p>
                  <p className="text-[11px] text-kraveo-ink3">Accepting orders</p>
                </div>
              </div>
              <Switch checked={v.isAcceptingOrders} onChange={() => onToggleVendor(v.id)} label={`${v.name}: accepting orders`} />
            </div>
          </article>
        ))}
      </div>

      <AddPartnerDrawer open={showDrawer} kind="VENDOR" onClose={() => setShowDrawer(false)} onCreated={() => onCreated?.()} />
    </div>
  );
};
