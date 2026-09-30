import React from 'react';
import { Skeleton } from './Skeleton';

interface KpiTileProps {
  label: string;
  value: React.ReactNode;
  note?: string;
  icon: React.ElementType;
  /** Tailwind text colour class for the icon + tint (literal string). */
  tone?: string;
  toneBg?: string;
  loading?: boolean;
  index?: number;
}

export const KpiTile: React.FC<KpiTileProps> = ({ label, value, note, icon: Icon, tone = 'text-kraveo-g400', toneBg = 'bg-kraveo-g400/15', loading, index = 0 }) => (
  <div className="k-card k-reveal relative overflow-hidden p-4 sm:p-5" style={{ ['--i' as string]: index }}>
    <div className="flex items-start justify-between gap-3">
      <p className="k-label">{label}</p>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-k-sm ${toneBg} ${tone}`}><Icon className="h-[18px] w-[18px]" aria-hidden="true" /></span>
    </div>
    {loading ? (
      <div className="mt-3 space-y-2"><Skeleton className="h-9 w-24" /><Skeleton className="h-3 w-32" /></div>
    ) : (
      <>
        <div className="k-num mt-2 truncate text-3xl text-kraveo-ink sm:text-[34px] sm:leading-[40px]">{value}</div>
        {note && <p className="mt-1 text-xs text-kraveo-ink3">{note}</p>}
      </>
    )}
  </div>
);
