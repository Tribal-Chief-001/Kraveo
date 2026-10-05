import React, { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { apiService } from '../services/api';
import { formatLatLng, parseLocationInput, vendorHasRealPin } from '../lib/campus';
import { PinInfo, PinKind, SavedPin, googleMapsUrl, pinSourceInfo } from '../lib/vendorLocation';
import { Field } from './ui/Field';
import { useToast } from './ui/Toast';

const BADGE_CLASS: Record<PinKind, string> = {
  DEVICE: 'bg-kraveo-g400/15 text-kraveo-g300',
  ADMIN: 'bg-kraveo-surface2 text-kraveo-ink2',
  LEGACY: 'bg-kraveo-surface2 text-kraveo-ink2',
  NONE: 'bg-kraveo-status-placed/15 text-kraveo-status-placed',
};

/** "Set by the restaurant on 5 Oct 2026, about 12 m" / "Set by admin" / "Not set". */
export const PinSourceBadge: React.FC<{ pin: PinInfo; notSetLabel?: string; className?: string }> = ({ pin, notSetLabel, className = '' }) => {
  const info = pinSourceInfo(pin);
  return <span data-pin-kind={info.kind} className={`inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${BADGE_CLASS[info.kind]} ${className}`}>{info.kind === 'NONE' && notSetLabel ? notSetLabel : info.label}</span>;
};

interface Props {
  /** Restaurant id (vendor row id). */
  id: string;
  name: string;
  pin: PinInfo;
  /** Called after the server accepted the new pin, so the lists and the live map use it at once. */
  onSaved?: (id: string, saved: SavedPin) => void;
  /** Wording of the heading; the Applications card calls it "Map pin". */
  heading?: string;
  /** Badge text while there is no pin (the Applications card says "Not provided"). */
  notSetLabel?: string;
}

/** Map pin of a restaurant: coordinates + "Open in Google Maps", the source badge, and the inline editor (paste from Google Maps). The server checks again. */
export const VendorLocationEditor: React.FC<Props> = ({ id, name, pin, onSaved, heading = 'Map location', notSetLabel }) => {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const has = vendorHasRealPin(pin);
  const inputId = `vloc-${id}`;

  const open = () => { setText(has && typeof pin.lat === 'number' && typeof pin.lng === 'number' ? formatLatLng(pin.lat, pin.lng) : ''); setError(''); setEditing(true); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseLocationInput(text);
    if (!parsed.ok) { setError(parsed.message); return; }
    setSaving(true); setError('');
    try {
      const saved = await apiService.setVendorLocation(id, parsed.lat, parsed.lng);
      onSaved?.(id, saved);
      toast.success('Location saved', `${name} is now on the map.`);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The location could not be saved.');
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-3 border-t border-kraveo-line pt-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="k-label">{heading}</p>
          {has && typeof pin.lat === 'number' && typeof pin.lng === 'number' && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-kraveo-ink2">
              <span className="font-mono">{formatLatLng(pin.lat, pin.lng)}</span>
              <a href={googleMapsUrl(pin.lat, pin.lng)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-kraveo-g300 hover:underline" aria-label={`Open ${name} in Google Maps`}>
                <ExternalLink className="h-3 w-3" aria-hidden="true" />Open in Google Maps
              </a>
            </p>
          )}
          <PinSourceBadge pin={pin} notSetLabel={notSetLabel} />
        </div>
        {!editing && <button type="button" className="k-btn-ghost !min-h-[36px] shrink-0 !px-3 text-xs" onClick={open} aria-label={`${has ? 'Change' : 'Set'} map location of ${name}`}>{has ? 'Change' : 'Set location'}</button>}
      </div>
      {editing && (
        <form onSubmit={save} className="mt-3 space-y-2" noValidate>
          <Field label="Location (paste from Google Maps, e.g. 23.0745, 76.8590)" htmlFor={inputId} error={error}>
            <input id={inputId} className="k-input" inputMode="decimal" autoComplete="off" autoFocus value={text} onChange={(e) => { setText(e.target.value); setError(''); }} placeholder="23.0745, 76.8590" aria-invalid={Boolean(error)} aria-describedby={error ? `${inputId}-msg` : undefined} />
          </Field>
          <div className="flex gap-2">
            <button type="button" className="k-btn-ghost flex-1 !min-h-[36px] text-xs" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            <button type="submit" className="k-btn-primary flex-1 !min-h-[36px] text-xs" disabled={saving} aria-busy={saving}>{saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Saving…</> : 'Save location'}</button>
          </div>
        </form>
      )}
    </div>
  );
};
