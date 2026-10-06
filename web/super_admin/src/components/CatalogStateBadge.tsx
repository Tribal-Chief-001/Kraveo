import React from 'react';
import type { DishState } from '../lib/catalogParse';

const STATE: Record<DishState, { label: string; tone: string }> = {
  LIVE: { label: 'Live', tone: 'bg-kraveo-g400/15 text-kraveo-g300' },
  PENDING: { label: 'Pending approval', tone: 'bg-kraveo-status-placed/15 text-kraveo-status-placed' },
  CHANGE_PENDING: { label: 'Price change pending', tone: 'bg-kraveo-status-preparing/15 text-kraveo-status-preparing' },
  REJECTED: { label: 'Rejected', tone: 'bg-kraveo-danger/15 text-kraveo-danger' },
  DELETED: { label: 'Deleted', tone: 'bg-kraveo-surface2 text-kraveo-ink2' },
};

export const stateLabel = (state: DishState): string => STATE[state].label;

export const StateBadge: React.FC<{ state: DishState }> = ({ state }) => (
  <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${STATE[state].tone}`}>{STATE[state].label}</span>
);
