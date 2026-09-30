import React from 'react';

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon: Icon, title, description, action, className = '' }) => (
  <div className={`flex flex-col items-center justify-center px-6 py-12 text-center ${className}`}>
    <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-k-lg border border-kraveo-line bg-kraveo-surface2 text-kraveo-g400">
      <Icon className="h-6 w-6" aria-hidden="true" />
    </span>
    <h3 className="text-base font-bold text-kraveo-ink">{title}</h3>
    {description && <p className="mt-1 max-w-sm text-sm text-kraveo-ink2">{description}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);
