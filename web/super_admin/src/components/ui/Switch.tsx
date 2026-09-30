import React from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}

/** Accessible toggle (role=switch). `label` is the accessible name. */
export const Switch: React.FC<SwitchProps> = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={onChange}
    className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-base ease-emphasized ${checked ? 'border-kraveo-g400/60 bg-kraveo-g400' : 'border-kraveo-line bg-kraveo-surface2'}`}
  >
    <span className={`inline-block h-5 w-5 rounded-full shadow-md transition-transform duration-base ease-spring ${checked ? 'translate-x-[24px] bg-kraveo-g950' : 'translate-x-[3px] bg-kraveo-ink3'}`} />
  </button>
);
