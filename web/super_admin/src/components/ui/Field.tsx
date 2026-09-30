import React from 'react';

interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}

/** Label + control + inline validation message. The control should set aria-invalid / aria-describedby using `${htmlFor}-msg`. */
export const Field: React.FC<FieldProps> = ({ label, htmlFor, error, hint, required, children }) => (
  <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="k-label flex items-center gap-1">
      {label}
      {required && <span className="text-kraveo-g400" aria-hidden="true">*</span>}
    </label>
    {children}
    {(error || hint) && (
      <p id={`${htmlFor}-msg`} className={`text-xs ${error ? 'font-semibold text-kraveo-danger' : 'text-kraveo-ink3'}`} role={error ? 'alert' : undefined}>
        {error || hint}
      </p>
    )}
  </div>
);
