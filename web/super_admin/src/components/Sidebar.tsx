import React, { useEffect, useRef, useState } from 'react';
import { Bike, ClipboardCheck, MapPinned, PanelLeftClose, PanelLeftOpen, ShoppingBag, Store, TrendingUp, Users, X } from 'lucide-react';
import { TabType } from '../types';
import { LogoBadge, LogoMark } from './ui/Logo';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  isLiveConnected: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  /** Optional live counters shown on nav items (only rendered when > 0). */
  badges?: Partial<Record<TabType, number>>;
}

const NAV_ITEMS: Array<{ id: TabType; label: string; hint: string; icon: React.ElementType }> = [
  { id: 'map', label: 'Live map', hint: 'Dispatch and runner positions', icon: MapPinned },
  { id: 'orders', label: 'Orders', hint: 'Every order and its status', icon: ShoppingBag },
  { id: 'applications', label: 'Applications', hint: 'Approve new restaurants and riders', icon: ClipboardCheck },
  { id: 'vendors', label: 'Vendors', hint: 'Dhabas and availability', icon: Store },
  { id: 'drivers', label: 'Drivers', hint: 'Runner partners and duty', icon: Bike },
  { id: 'customers', label: 'Customers', hint: 'Everyone who ordered', icon: Users },
  { id: 'analytics', label: 'Analytics', hint: 'Campus delivery numbers', icon: TrendingUp },
];

const COLLAPSE_KEY = 'kraveo_admin_sidebar_collapsed';

const readCollapsed = (): boolean => {
  try { return window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
};

interface BodyProps extends Pick<SidebarProps, 'activeTab' | 'setActiveTab' | 'isLiveConnected' | 'badges'> {
  expanded: boolean;
  onNavigate?: () => void;
}

const SidebarBody: React.FC<BodyProps> = ({ activeTab, setActiveTab, isLiveConnected, badges, expanded, onNavigate }) => (
  <>
    <nav aria-label="Primary" className="flex-1 space-y-1 px-3 py-2">
      {expanded && <p className="k-label px-3 pb-2 pt-1">Operations</p>}
      {NAV_ITEMS.map((item, index) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        const count = badges?.[item.id] ?? 0;
        return (
          <button
            key={item.id}
            onClick={() => { setActiveTab(item.id); onNavigate?.(); }}
            aria-label={item.label}
            aria-current={isActive ? 'page' : undefined}
            title={expanded ? undefined : item.label}
            style={{ ['--i' as string]: index }}
            className={`k-reveal group relative flex w-full items-center gap-3 rounded-k-sm px-3 py-2.5 text-left text-sm font-bold transition-all duration-fast ease-emphasized ${expanded ? '' : 'justify-center'} ${isActive ? 'bg-kraveo-g400/15 text-kraveo-g300' : 'text-kraveo-ink2 hover:bg-kraveo-surface2 hover:text-kraveo-ink'}`}
          >
            {isActive && <span className="absolute -left-3 top-2 h-[calc(100%-1rem)] w-1 rounded-r-full bg-kraveo-g400" aria-hidden="true" />}
            <Icon className={`h-5 w-5 shrink-0 transition-transform duration-base ease-spring ${isActive ? 'scale-110' : 'group-hover:scale-105'}`} aria-hidden="true" />
            {expanded && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
            {count > 0 && (
              expanded
                ? <span className="rounded-full bg-kraveo-g400/20 px-2 py-0.5 text-[11px] font-extrabold tabular-nums text-kraveo-g300">{count}</span>
                : <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-kraveo-g400" aria-hidden="true" />
            )}
            {!expanded && (
              <span role="tooltip" className="pointer-events-none absolute left-full z-50 ml-3 hidden whitespace-nowrap rounded-k-sm border border-kraveo-line bg-kraveo-surface2 px-3 py-1.5 text-xs font-bold text-kraveo-ink shadow-k-lift group-hover:block group-focus-visible:block">
                {item.label}{count > 0 ? ` (${count})` : ''}
              </span>
            )}
          </button>
        );
      })}
    </nav>

    <div className="px-3 pb-3">
      <div className={`flex items-center gap-3 rounded-k-md border border-kraveo-line bg-kraveo-night/60 p-3 ${expanded ? '' : 'justify-center'}`} role="status" aria-live="polite" title={isLiveConnected ? 'Live connection active' : 'Live connection lost'}>
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
          {isLiveConnected && <span className="absolute inset-0 animate-ring-out rounded-full bg-kraveo-g400" />}
          <span className={`relative h-2.5 w-2.5 rounded-full ${isLiveConnected ? 'bg-kraveo-g400' : 'bg-kraveo-danger'}`} />
        </span>
        {expanded ? (
          <div className="min-w-0">
            <p className={`text-xs font-bold ${isLiveConnected ? 'text-kraveo-ink' : 'text-kraveo-danger'}`}>{isLiveConnected ? 'Live connection' : 'Disconnected'}</p>
            <p className="truncate text-[11px] text-kraveo-ink3">{isLiveConnected ? 'Receiving order and runner updates' : 'Trying to reconnect to the server'}</p>
          </div>
        ) : <span className="sr-only">{isLiveConnected ? 'Live connection active' : 'Live connection lost'}</span>}
      </div>
    </div>
  </>
);

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, isLiveConnected, mobileOpen, onCloseMobile, badges }) => {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const closeRef = useRef<HTMLButtonElement>(null);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try { window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* preference is optional */ }
      return next;
    });
  };

  // Mobile drawer: Esc to close, lock page scroll, move focus in.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseMobile(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      {/* Desktop icon rail */}
      <aside
        aria-label="Sidebar"
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-kraveo-line bg-kraveo-surface transition-[width] duration-base ease-emphasized lg:flex ${collapsed ? 'w-[76px]' : 'w-64'}`}
      >
        <div className={`flex h-[72px] items-center border-b border-kraveo-line ${collapsed ? 'justify-center px-2' : 'px-4'}`}>
          {collapsed ? <LogoMark size={44} /> : (
            <div className="flex min-w-0 items-center gap-3">
              <LogoMark size={44} />
              <div className="min-w-0">
                <p className="truncate font-display text-base font-extrabold leading-tight tracking-tight text-kraveo-ink">Kraveo</p>
                <p className="truncate text-[11px] font-semibold text-kraveo-ink3">Ops console · VIT Bhopal</p>
              </div>
            </div>
          )}
        </div>
        <SidebarBody activeTab={activeTab} setActiveTab={setActiveTab} isLiveConnected={isLiveConnected} badges={badges} expanded={!collapsed} />
        <div className="border-t border-kraveo-line p-3">
          <button
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`flex w-full items-center gap-3 rounded-k-sm px-3 py-2.5 text-sm font-bold text-kraveo-ink3 transition-colors hover:bg-kraveo-surface2 hover:text-kraveo-ink ${collapsed ? 'justify-center' : ''}`}
          >
            {collapsed ? <PanelLeftOpen className="h-5 w-5" aria-hidden="true" /> : <PanelLeftClose className="h-5 w-5" aria-hidden="true" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={onCloseMobile} aria-hidden="true" />
          <aside role="dialog" aria-modal="true" aria-label="Navigation" className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] animate-slide-in-left flex-col border-r border-kraveo-line bg-kraveo-surface shadow-k-lift">
            <div className="flex h-[72px] items-center justify-between gap-3 border-b border-kraveo-line px-4">
              <LogoBadge imgClassName="h-9" />
              <button ref={closeRef} aria-label="Close navigation" onClick={onCloseMobile} className="k-icon-btn"><X className="h-4 w-4" aria-hidden="true" /></button>
            </div>
            <SidebarBody activeTab={activeTab} setActiveTab={setActiveTab} isLiveConnected={isLiveConnected} badges={badges} expanded onNavigate={onCloseMobile} />
          </aside>
        </div>
      )}
    </>
  );
};
