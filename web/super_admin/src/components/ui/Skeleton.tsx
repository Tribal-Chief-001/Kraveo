import React from 'react';

export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div aria-hidden="true" className={`k-skeleton ${className}`} />
);

export const SkeletonCard: React.FC<{ lines?: number; className?: string }> = ({ lines = 3, className = '' }) => (
  <div role="status" aria-label="Loading" className={`k-card space-y-3 p-5 ${className}`}>
    <div className="flex items-center gap-3">
      <Skeleton className="h-11 w-11 !rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
    {Array.from({ length: lines }).map((_, index) => <Skeleton key={index} className="h-3 w-full" />)}
  </div>
);
