import React, { useMemo, useRef, useState } from 'react';
import { Loader2, Store } from 'lucide-react';
import { Vendor } from '../types';
import { ApiError, apiService } from '../services/api';
import { MAX_RESTAURANT_CATEGORIES, restaurantChoices } from '../lib/categoryParse';
import { useCategories } from '../lib/useCategories';
import { ProfileField, PROFILE_FIELDS, changedFieldsText, formFromVendor, profileChanges, validateProfile, ProfileForm } from '../lib/vendorProfile';
import { errorText, fieldOf } from '../lib/errors';
import { CategoryMultiSelect } from './CategoryMultiSelect';
import { ImageUploadField } from './ImageUploadField';
import { OwnerLoginSection, OwnerPatch } from './OwnerLoginSection';
import { Drawer } from './ui/Drawer';
import { Field } from './ui/Field';
import { useToast } from './ui/Toast';
import type { ImageEnv } from '../lib/imageCompress';

interface Props {
  vendor: Vendor;
  onClose: () => void;
  /** The server accepted the change; `vendor` is the fresh admin view. The list should refresh. */
  onSaved: (vendor: Vendor) => void;
  onAuthError?: (error: unknown) => void;
  /** Docs/28: the owner login or the open flag changed (the Owner login section acts at once, without Save). */
  onOwnerChanged?: (vendorId: string, patch: OwnerPatch) => void;
  onOpenOrder?: (orderId: string) => void;
  /** Tests inject a fake canvas. */
  imageEnv?: ImageEnv;
}

/** "Edit restaurant": name, categories, address, banner, FSSAI and delivery time. Only the fields that changed are sent. */
export const EditRestaurantDrawer: React.FC<Props> = ({ vendor, onClose, onSaved, onAuthError, onOwnerChanged, onOpenOrder, imageEnv }) => {
  const toast = useToast();
  const base = useMemo(() => formFromVendor(vendor), [vendor]);
  const [form, setForm] = useState<ProfileForm>(base);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [banner, setBanner] = useState('');
  const [serverErrors, setServerErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const busy = useRef(false);
  const cats = useCategories();

  const set = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => { setForm((c) => ({ ...c, [key]: value })); setServerErrors({}); setBanner(''); };

  const errors = validateProfile(form, base, MAX_RESTAURANT_CATEGORIES);
  const shown = (field: ProfileField): string => serverErrors[field] ?? (touched ? errors[field] ?? '' : '');
  const changes = profileChanges(form, base);
  const dirty = Object.keys(changes).length > 0;
  const choices = restaurantChoices(cats.categories);

  const save = async () => {
    if (busy.current || uploading) return;
    setTouched(true);
    if (Object.keys(errors).length > 0) { setBanner('Fix the highlighted fields first.'); return; }
    if (!dirty) { setBanner('Nothing was changed.'); return; }
    busy.current = true;
    setSaving(true); setBanner(''); setServerErrors({});
    try {
      const out = await apiService.updateVendorProfile(vendor.id, changes);
      if (out.changed) toast.success('Restaurant saved', `Updated ${changedFieldsText(changes) || 'the restaurant'} for ${out.vendor.name}.`);
      else toast.info('Nothing to change', 'The server already had these values.');
      onSaved(out.vendor);
      onClose();
    } catch (failure) {
      onAuthError?.(failure);
      const field = fieldOf(failure, PROFILE_FIELDS);
      if (field) { setServerErrors({ [field]: errorText(failure) }); setBanner('Fix the highlighted field and save again.'); }
      else setBanner(errorText(failure));
      // A category deleted or hidden meanwhile: refresh the list so the chips and the picker match the server.
      if (failure instanceof ApiError && (failure.code === 'CATEGORY_UNKNOWN' || failure.code === 'CATEGORY_NOT_AVAILABLE')) cats.reload();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const disabled = saving;
  const bannerNote = form.resetBanner ? 'The default banner will be used after you save.' : 'No banner yet. The default one is shown.';

  return (
    <Drawer
      open
      onClose={() => { if (!saving) onClose(); }}
      title={`Edit ${vendor.name}`}
      subtitle="Name, categories, address, banner, FSSAI and delivery time"
      icon={Store}
      wide
      footer={(
        <div className="space-y-2 pb-4">
          {banner && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{banner}</p>}
          <div className="flex gap-3">
            <button type="button" className="k-btn-ghost flex-1" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="button" className="k-btn-primary flex-1" onClick={() => void save()} disabled={saving || uploading} aria-busy={saving}>
              {saving ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Saving…</> : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    >
      <div className="space-y-5" onKeyDown={(event) => { if (event.key === 'Enter' && (event.target as HTMLInputElement).tagName === 'INPUT' && (event.target as HTMLInputElement).type === 'text' && !(event.target as HTMLInputElement).closest('[role="group"]')) { event.preventDefault(); void save(); } }}>
        <OwnerLoginSection vendor={vendor} onChanged={(patch) => onOwnerChanged?.(vendor.id, patch)} onAuthError={onAuthError} onOpenOrder={onOpenOrder} />

        <Field label="Restaurant name" htmlFor="er-name" required error={shown('name')}>
          <input id="er-name" className="k-input" value={form.name} maxLength={80} autoComplete="off" disabled={disabled} onChange={(e) => set('name', e.target.value)} aria-invalid={Boolean(shown('name'))} aria-describedby={shown('name') ? 'er-name-msg' : undefined} />
        </Field>

        {cats.loading && cats.categories.length === 0 && <p className="text-sm text-kraveo-ink3" role="status">Loading categories…</p>}
        {cats.error ? (
          <div className="rounded-k-md border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 p-3 text-sm text-kraveo-ink" role="alert">
            <p className="font-semibold">The category list could not be loaded.</p>
            <p className="mt-1 break-words text-kraveo-ink2">{cats.error}</p>
            <button type="button" className="k-btn-ghost mt-2 !min-h-[36px] text-xs" onClick={cats.reload}>Try again</button>
            <p className="mt-2 text-xs text-kraveo-ink3">Shown to customers now: {vendor.category}. Categories are left as they are until the list loads.</p>
          </div>
        ) : (
          <CategoryMultiSelect
            id="er-cuisines"
            label="Categories"
            hint={`Shown to customers as: ${vendor.category}. Pick up to ${MAX_RESTAURANT_CATEGORIES}; the first is the main one.`}
            value={form.cuisineIds}
            onChange={(ids) => set('cuisineIds', ids)}
            choices={choices}
            known={vendor.cuisines}
            disabled={disabled}
            error={shown('cuisineIds')}
            onCreated={cats.add}
            onAuthError={onAuthError}
          />
        )}

        <Field label="Where is the kitchen?" htmlFor="er-address" required error={shown('address')}>
          <input id="er-address" className="k-input" value={form.address} maxLength={160} autoComplete="off" disabled={disabled} onChange={(e) => set('address', e.target.value)} aria-invalid={Boolean(shown('address'))} aria-describedby={shown('address') ? 'er-address-msg' : undefined} />
        </Field>

        <ImageUploadField
          id="er-banner"
          label="Banner photo (web address)"
          purpose="banner"
          value={form.resetBanner ? '' : form.banner}
          onChange={(url) => { setForm((c) => ({ ...c, banner: url, resetBanner: false })); setServerErrors({}); setBanner(''); }}
          disabled={disabled}
          error={shown('bannerImage')}
          hint="Paste a link, or upload a photo. Wide pictures look best."
          previewAlt={`Banner of ${vendor.name}`}
          removeLabel="Use the default banner"
          onRemove={() => { setForm((c) => ({ ...c, banner: '', resetBanner: true })); setServerErrors({}); setBanner(''); }}
          emptyNote={bannerNote}
          onBusyChange={setUploading}
          onAuthError={onAuthError}
          env={imageEnv}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="FSSAI licence number" htmlFor="er-fssai" error={shown('fssaiNumber')} hint="14 digits. Leave empty to remove it.">
            <input id="er-fssai" className="k-input" inputMode="numeric" autoComplete="off" value={form.fssai} disabled={disabled} onChange={(e) => set('fssai', e.target.value)} aria-invalid={Boolean(shown('fssaiNumber'))} aria-describedby="er-fssai-msg" />
          </Field>
          <Field label="Delivery time" htmlFor="er-eta" error={shown('eta')} hint="For example 15-20 min.">
            <input id="er-eta" className="k-input" autoComplete="off" value={form.eta} disabled={disabled} onChange={(e) => set('eta', e.target.value)} aria-invalid={Boolean(shown('eta'))} aria-describedby="er-eta-msg" placeholder="15-20 min" />
          </Field>
        </div>

        <p className="text-xs text-kraveo-ink3" aria-live="polite">
          {dirty ? `Will change: ${changedFieldsText(changes)}.` : 'Nothing changed yet. Open status, map pin, commission and payout details have their own controls on the restaurant card.'}
        </p>
      </div>
    </Drawer>
  );
};
