import React from 'react';
import { ORDER_STATUS_LABEL, statusMeta } from '../../lib/tokens';

interface StatusPillProps {
  /** Backend status string (PLACED, READY_FOR_PICKUP, ...) */
  status: string;
  label?: string;
  compact?: boolean;
  className?: string;
}

/** Shared status language: same colours + wording as KStatusPill in the Flutter apps. */
export const StatusPill: React.FC<StatusPillProps> = ({ status, label, compact = false, className = '' }) => {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-bold ${meta.bg} ${meta.text} ${compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'} ${className}`}
    >
      <span
        className={`k-dot ${meta.dot} ${meta.live ? 'k-dot-live' : ''}`}
        style={{ ['--dot' as string]: `${meta.hex}99` }}
        aria-hidden="true"
      />
      {label ?? (ORDER_STATUS_LABEL[status] ?? meta.label)}
    </span>
  );
};
