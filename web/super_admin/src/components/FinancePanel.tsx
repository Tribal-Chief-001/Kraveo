import React, { memo, useState } from 'react';
import { Vendor, DriverPartner } from '../types';
import { FinanceOverview } from './FinanceOverview';
import { SettlementsPanel } from './SettlementsPanel';
import { RidersPanel } from './RidersPanel';

interface Props {
  vendors: Vendor[];
  driverPartners: DriverPartner[];
  /** PENDING settlements (the sidebar badge number). */
  pendingSettlements: number;
  /** A settlement changed here: refresh the sidebar badge. */
  onSettlementsChanged: () => void;
  onAuthError: (error: unknown) => void;
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'settlements', label: 'Settlements' },
  { id: 'riders', label: 'Riders' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const FinancePanelBase: React.FC<Props> = ({ vendors, driverPartners, pendingSettlements, onSettlementsChanged, onAuthError }) => {
  const [tab, setTab] = useState<TabId>('overview');
  const move = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id);
    document.getElementById(`finance-tab-${next.id}`)?.focus();
  };

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Finance sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:px-0">
        {TABS.map((entry, index) => (
          <button
            key={entry.id}
            id={`finance-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={`finance-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className="k-chip"
            aria-pressed={tab === entry.id}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => move(event, index)}
          >
            {entry.label}
            {entry.id === 'settlements' && pendingSettlements > 0 && <span className="rounded-full bg-kraveo-status-placed/25 px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums text-kraveo-status-placed" aria-label={`${pendingSettlements} pending`}>{pendingSettlements}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`finance-panel-${tab}`} aria-labelledby={`finance-tab-${tab}`}>
        {tab === 'overview' && <FinanceOverview vendors={vendors} onAuthError={onAuthError} />}
        {tab === 'settlements' && <SettlementsPanel vendors={vendors} onChanged={onSettlementsChanged} onAuthError={onAuthError} />}
        {tab === 'riders' && <RidersPanel driverPartners={driverPartners} onAuthError={onAuthError} />}
      </div>
    </div>
  );
};

export const FinancePanel = memo(FinancePanelBase);
