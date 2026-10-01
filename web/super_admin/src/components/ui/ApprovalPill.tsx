import React from 'react';
import { ApprovalStatus } from '../../types';

const META: Record<ApprovalStatus, { label: string; cls: string; dot: string }> = {
  PENDING: { label: 'Pending approval', cls: 'bg-kraveo-status-placed/15 text-kraveo-status-placed', dot: 'bg-kraveo-status-placed' },
  APPROVED: { label: 'Approved', cls: 'bg-kraveo-g400/15 text-kraveo-g300', dot: 'bg-kraveo-g400' },
  REJECTED: { label: 'Rejected', cls: 'bg-kraveo-danger/15 text-kraveo-danger', dot: 'bg-kraveo-danger' },
  SUSPENDED: { label: 'Suspended', cls: 'bg-kraveo-status-atGate/15 text-kraveo-status-atGate', dot: 'bg-kraveo-status-atGate' },
};

/** Approval state of a restaurant or rider. Renders nothing for APPROVED unless `showApproved` is set. */
export const ApprovalPill: React.FC<{ status?: ApprovalStatus; showApproved?: boolean; className?: string }> = ({ status, showApproved = false, className = '' }) => {
  if (!status || (status === 'APPROVED' && !showApproved)) return null;
  const m = META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${m.cls} ${className}`}>
      <span className={`k-dot ${m.dot} ${status === 'PENDING' ? 'k-dot-live' : ''}`} aria-hidden="true" />
      {m.label}
    </span>
  );
};
