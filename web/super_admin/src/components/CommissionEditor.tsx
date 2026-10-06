import React, { useRef, useState } from 'react';
import { Loader2, Percent } from 'lucide-react';
import { apiService } from '../services/api';
import { VendorCommission } from '../lib/catalogParse';
import { CommissionType, amountText, commissionLabel, parseCommissionValue } from '../lib/pricing';
import { Field } from './ui/Field';
import { useToast } from './ui/Toast';

interface Props {
  id: string;
  name: string;
  /** `undefined` = the server did not send the field. `null` = inherits the global default. */
  commissionType: CommissionType | null | undefined;
  commissionValue: number | null | undefined;
  onSaved: (vendorId: string, commission: VendorCommission) => void;
  onAuthError?: (error: unknown) => void;
}

type Mode = 'INHERIT' | CommissionType;

/** A restaurant's own commission (percent or flat). "Use default" clears it so the global default applies. */
export const CommissionEditor: React.FC<Props> = ({ id, name, commissionType, commissionValue, onSaved, onAuthError }) => {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<Mode>('INHERIT');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');

  const unknown = commissionType === undefined;
  const summary = unknown ? 'Not reported by the server' : commissionType ? `${commissionLabel(commissionType, commissionValue)} (this restaurant)` : 'Default (global setting)';
  const parsed = mode === 'INHERIT' ? null : parseCommissionValue(mode, value);
  const invalid = parsed !== null && !parsed.ok;

  const open = () => {
    setMode(commissionType ?? 'INHERIT');
    setValue(commissionType ? amountText(commissionValue) : '');
    setTouched(false); setError(''); setEditing(true);
  };

  const save = async () => {
    setTouched(true);
    if (invalid || savingRef.current) return;
    const input: VendorCommission = mode === 'INHERIT' || !parsed || !parsed.ok ? { type: null, value: null } : { type: mode, value: parsed.value };
    savingRef.current = true; setSaving(true); setError('');
    try {
      const result = await apiService.setVendorCommission(id, input);
      onSaved(id, result.commission);
      setEditing(false);
      // The server says whether dish prices are now out of date ("N dish prices are out of date: run Recalculate prices").
      toast.success('Commission saved', `${name}: ${result.commission.type ? commissionLabel(result.commission.type, result.commission.value) : 'default commission'}. ${result.message || 'Saved.'}`);
    } catch (failure) {
      onAuthError?.(failure);
      setError(failure instanceof Error ? failure.message : 'The commission was not saved. Please try again.');
    } finally { savingRef.current = false; setSaving(false); }
  };

  return (
    <div className="mt-3 rounded-k-md border border-kraveo-line bg-kraveo-night/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-xs text-kraveo-ink2"><Percent className="h-3.5 w-3.5 shrink-0 text-kraveo-ink3" aria-hidden="true" /><span className="min-w-0 break-words"><span className="font-bold text-kraveo-ink">Commission:</span> {summary}</span></p>
        {!editing && <button type="button" className="k-btn-ghost !min-h-[32px] shrink-0 !px-3 text-xs" onClick={open} aria-label={`Change commission for ${name}`}>Change</button>}
      </div>
      {editing && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Commission" htmlFor={`commission-mode-${id}`}>
              <select id={`commission-mode-${id}`} className="k-select" value={mode} onChange={(e) => { setMode(e.target.value as Mode); setError(''); }} disabled={saving}>
                <option value="INHERIT">Use the default</option>
                <option value="PERCENT">Percent</option>
                <option value="FLAT">Flat rupees per dish</option>
              </select>
            </Field>
            {mode !== 'INHERIT' && (
              <Field label={mode === 'PERCENT' ? 'Percent (%)' : 'Amount (₹)'} htmlFor={`commission-value-${id}`} required error={touched && parsed && !parsed.ok ? parsed.message : undefined}>
                <input id={`commission-value-${id}`} className="k-input" inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); setError(''); }} aria-invalid={touched && invalid} aria-describedby={`commission-value-${id}-msg`} disabled={saving} autoComplete="off" />
              </Field>
            )}
          </div>
          {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-xs text-kraveo-ink">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="k-btn-primary !min-h-[36px] text-xs" onClick={save} disabled={saving} aria-busy={saving}>{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}Save commission</button>
            <button type="button" className="k-btn-ghost !min-h-[36px] text-xs" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};
