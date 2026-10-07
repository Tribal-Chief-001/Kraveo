import React from 'react';
import { Layers } from 'lucide-react';
import { OrderGroupInfo, groupBadgeLabel, groupBadgeText, groupPositionText } from '../../lib/orderGroups';

/**
 * "Combined order · 3 restaurants" with this order's place in it ("1 of 3"). Renders nothing for a single order,
 * so it can be dropped next to any order without a check. Wraps instead of overflowing on a 360 px phone.
 */
export const GroupBadge: React.FC<{ group?: OrderGroupInfo | null; className?: string }> = ({ group, className = '' }) => {
  if (!group) return null;
  return (
    <span
      className={`inline-flex max-w-full flex-wrap items-center gap-x-1.5 rounded-full bg-kraveo-status-atGate/15 px-2.5 py-1 text-[11px] font-bold text-kraveo-status-atGate ${className}`}
      aria-label={groupBadgeLabel(group)}
      title={group.stops.length ? `Restaurants: ${group.stops.map((stop) => stop.vendorName).join(', ')}` : undefined}
      data-testid="group-badge"
    >
      <Layers className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span aria-hidden="true">{groupBadgeText(group)}</span>
      <span className="rounded-full bg-kraveo-night/40 px-1.5 text-[10px] tabular-nums" aria-hidden="true">{groupPositionText(group)}</span>
    </span>
  );
};
