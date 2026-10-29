import React from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
  /** Tooltip, and the reason a disabled switch is disabled. */
  title?: string;
  /** Id of the text that explains the switch (read after its name). */
  describedBy?: string;
}

/** Accessible toggle (role=switch). `label` is the accessible name. */
export const Switch: React.FC<SwitchProps> = ({ checked, onChange, label, disabled, title, describedBy }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    title={title}
    aria-describedby={describedBy}
    onClick={onChange}
    className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:cursor-wait disabled:opacity-60 duration-base ease-emphasized ${checked ? 'border-kraveo-g400/60 bg-kraveo-g400' : 'border-kraveo-line bg-kraveo-surface2'}`}
  >
    <span className={`inline-block h-5 w-5 rounded-full shadow-md transition-transform duration-base ease-spring ${checked ? 'translate-x-[24px] bg-kraveo-g950' : 'translate-x-[3px] bg-kraveo-ink3'}`} />
  </button>
);
