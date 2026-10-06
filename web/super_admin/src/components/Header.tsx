import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Clock, LogOut, Menu, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { AdminProfile, TabType } from '../types';
import { timeAgo } from '../lib/tokens';
import { Avatar } from './ui/Avatar';

interface HeaderProps {
  activeTab: TabType;
  isLiveConnected: boolean;
  isLoading: boolean;
  adminProfile?: AdminProfile;
  onRefresh: () => void;
  onLogout: () => void;
  onOpenMenu: () => void;
  query: string;
  onQueryChange: (value: string) => void;
}

const TITLES: Record<TabType, { title: string; subtitle: string; searchHint: string }> = {
  map: { title: 'Live command center', subtitle: 'Dispatch, runners and the delivery pipeline', searchHint: 'Search orders, vendors, hostels, runners' },
  orders: { title: 'Orders', subtitle: 'Latest 100 orders, with payment and live status', searchHint: 'Search order, student, phone, restaurant, rider or payment id' },
  attention: { title: 'Needs attention', subtitle: 'Orders and payments a human has to fix', searchHint: 'Search by order, restaurant, student or problem' },
  applications: { title: 'Applications', subtitle: 'Restaurants and riders waiting for your approval', searchHint: 'Search by name, phone, location or plate' },
  vendors: { title: 'Vendors', subtitle: 'Dhaba network and availability', searchHint: 'Search vendors by name, category or address' },
  drivers: { title: 'Drivers', subtitle: 'Runner partners on campus', searchHint: 'Search runners by name, reg no or code' },
  customers: { title: 'Customers', subtitle: 'Everyone who signed in, with their order history', searchHint: 'Search name, email, phone or hostel' },
  catalog: { title: 'Catalog', subtitle: 'Approve dishes and set what customers pay', searchHint: 'Search dishes by name, category or restaurant' },
  settings: { title: 'Settings', subtitle: 'Fees, default commission and price rounding', searchHint: '' },
  analytics: { title: 'Analytics', subtitle: 'Campus delivery numbers from real orders', searchHint: '' },
};

const useNow = (intervalMs: number): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
};

export const Header: React.FC<HeaderProps> = ({ activeTab, isLiveConnected, isLoading, adminProfile, onRefresh, onLogout, onOpenMenu, query, onQueryChange }) => {
  const meta = TITLES[activeTab];
  const searchEnabled = activeTab !== 'analytics' && activeTab !== 'settings';
  const now = useNow(10_000);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const wasLoading = useRef(false);
  const desktopSearch = useRef<HTMLInputElement>(null);
  const mobileSearch = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wasLoading.current && !isLoading) setLastSynced(Date.now());
    wasLoading.current = isLoading;
  }, [isLoading]);

  // "/" or Ctrl/Cmd+K focuses whichever search field is visible.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const wantsSearch = (event.key === '/' && !typing) || (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey));
      if (!wantsSearch || !searchEnabled) return;
      event.preventDefault();
      const desktopVisible = desktopSearch.current && desktopSearch.current.offsetParent !== null;
      (desktopVisible ? desktopSearch.current : mobileSearch.current)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchEnabled]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const adminName = adminProfile?.name || 'Admin';
  const clock = new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const syncLabel = isLoading ? 'Syncing' : lastSynced ? `Synced ${timeAgo(lastSynced, now)}` : 'Not synced yet';

  const searchField = (ref: React.RefObject<HTMLInputElement>, id: string, className: string) => (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-kraveo-ink3" aria-hidden="true" />
      <input
        ref={ref}
        id={id}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={meta.searchHint}
        aria-label="Search"
        autoComplete="off"
        className="k-input !min-h-[42px] truncate pl-10 pr-16 [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button aria-label="Clear search" onClick={() => onQueryChange('')} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-kraveo-ink3 hover:bg-kraveo-line hover:text-kraveo-ink"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
      ) : (
        <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-kraveo-line bg-kraveo-surface2 px-1.5 py-0.5 font-sans text-[10px] font-bold text-kraveo-ink3 md:block">/</kbd>
      )}
    </div>
  );

  return (
    <header className="sticky top-0 z-30 border-b border-kraveo-line bg-kraveo-night/85 backdrop-blur-xl">
      <div className="flex min-h-[72px] items-center gap-3 px-4 sm:px-6">
        <button aria-label="Open navigation" onClick={onOpenMenu} className="k-icon-btn lg:hidden"><Menu className="h-5 w-5" aria-hidden="true" /></button>

        <div className="min-w-0 flex-1 lg:flex-none">
          <h1 className="truncate font-display text-lg font-bold leading-tight tracking-tight text-kraveo-ink sm:text-xl">{meta.title}</h1>
          <p className="hidden truncate text-xs text-kraveo-ink3 sm:block">{meta.subtitle}</p>
        </div>

        {searchEnabled ? searchField(desktopSearch, 'global-search', 'ml-4 hidden max-w-xl flex-1 md:block') : <div className="hidden flex-1 md:block" />}

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden items-center gap-3 rounded-k-sm border border-kraveo-line bg-kraveo-surface px-3 py-2 xl:flex" aria-live="off">
            <Clock className="h-4 w-4 text-kraveo-ink3" aria-hidden="true" />
            <div className="leading-tight">
              <p className="k-num text-sm text-kraveo-ink">{clock}</p>
              <p className="text-[11px] text-kraveo-ink3">{syncLabel}</p>
            </div>
          </div>
          <span
            className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold sm:flex ${isLiveConnected ? 'border-kraveo-g400/30 bg-kraveo-g400/10 text-kraveo-g300' : 'border-kraveo-danger/30 bg-kraveo-danger/10 text-kraveo-danger'}`}
            role="status"
          >
            <span className={`k-dot ${isLiveConnected ? 'bg-kraveo-g400 k-dot-live' : 'bg-kraveo-danger'}`} aria-hidden="true" />
            {isLiveConnected ? 'Live' : 'Offline'}
          </span>
          <button aria-label="Refresh data" title="Refresh data" onClick={onRefresh} disabled={isLoading} className="k-icon-btn">
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>

          <div className="relative" ref={menuRef}>
            <button
              aria-label="Admin menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="flex h-10 items-center gap-2 rounded-k-sm border border-kraveo-line bg-kraveo-surface2 pl-1.5 pr-2 transition-colors hover:border-kraveo-g400/40 sm:pr-3"
            >
              <Avatar name={adminName} size="sm" />
              <span className="hidden max-w-[9rem] truncate text-sm font-bold text-kraveo-ink sm:inline">{adminName}</span>
              <ChevronDown className={`hidden h-4 w-4 text-kraveo-ink3 transition-transform sm:block ${menuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div role="menu" aria-label="Admin" className="absolute right-0 top-12 z-40 w-64 animate-scale-in overflow-hidden rounded-k-md border border-kraveo-line bg-kraveo-surface2 shadow-k-lift">
                <div className="flex items-center gap-3 border-b border-kraveo-line p-4">
                  <Avatar name={adminName} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-kraveo-ink">{adminName}</p>
                    <p className="flex items-center gap-1 text-xs text-kraveo-ink3"><ShieldCheck className="h-3 w-3 text-kraveo-g400" aria-hidden="true" /> Administrator</p>
                  </div>
                </div>
                <div className="border-b border-kraveo-line px-4 py-3 text-xs text-kraveo-ink3 xl:hidden">
                  <p className="k-num text-sm text-kraveo-ink">{clock}</p>
                  <p>{syncLabel}</p>
                </div>
                <button role="menuitem" onClick={() => { setMenuOpen(false); onLogout(); }} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-bold text-kraveo-danger transition-colors hover:bg-kraveo-danger/10">
                  <LogOut className="h-4 w-4" aria-hidden="true" /> Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {searchEnabled && <div className="px-4 pb-3 md:hidden">{searchField(mobileSearch, 'global-search-mobile', '')}</div>}
    </header>
  );
};
