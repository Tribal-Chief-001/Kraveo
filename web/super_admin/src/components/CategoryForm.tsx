import React, { useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ApiError, apiService, CategoryInput } from '../services/api';
import {
  Category, ICON_KEYS, ICON_LABEL, iconKeyOf, parseCategory, usageText, validateCategoryName, validateHindiName,
} from '../lib/categoryParse';
import { errorText, fieldOf } from '../lib/errors';
import { Field } from './ui/Field';
import { Switch } from './ui/Switch';
import { CategoryIcon } from './ui/CategoryIcon';

type FormField = 'name' | 'nameHi' | 'icon';

export interface CategoryPreset { forRestaurants: boolean; forDishes: boolean; showOnHome: boolean }

interface Props {
  /** null = create. */
  category: Category | null;
  /** `full` = every setting (the Categories tab). `quick` = name and icon only, used inside pickers (flags come from `preset`). */
  mode: 'full' | 'quick';
  preset?: CategoryPreset;
  initialName?: string;
  onSaved: (category: Category, created: boolean, message: string) => void;
  onCancel: () => void;
  onAuthError?: (error: unknown) => void;
  /** Quick mode: the name already exists and fits this picker, so offer to use that one instead. */
  canUseExisting?: (existing: Category) => boolean;
  onUseExisting?: (existing: Category) => void;
}

const DEFAULT_PRESET: CategoryPreset = { forRestaurants: true, forDishes: true, showOnHome: false };

/** Create or edit one category. Renders its own buttons (it may sit inside another form, so it is not a <form> itself). */
export const CategoryForm: React.FC<Props> = ({ category, mode, preset = DEFAULT_PRESET, initialName = '', onSaved, onCancel, onAuthError, canUseExisting, onUseExisting }) => {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const editing = category !== null;
  const start = category
    ? { name: category.name, nameHi: category.nameHi ?? '', icon: iconKeyOf(category.icon), forRestaurants: category.forRestaurants, forDishes: category.forDishes, showOnHome: category.showOnHome, isActive: category.isActive }
    : { name: initialName, nameHi: '', icon: 'restaurant' as string, forRestaurants: preset.forRestaurants, forDishes: preset.forDishes, showOnHome: preset.showOnHome, isActive: true };
  const [form, setForm] = useState(start);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverField, setServerField] = useState<{ field: FormField; message: string } | null>(null);
  const [banner, setBanner] = useState('');
  const [existing, setExisting] = useState<Category | null>(null);
  const busy = useRef(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => { setForm((c) => ({ ...c, [key]: value })); setServerField(null); setBanner(''); setExisting(null); };

  const nameError = validateCategoryName(form.name);
  const hiError = validateHindiName(form.nameHi);
  const error = (field: FormField): string => {
    if (serverField?.field === field) return serverField.message;
    if (!touched) return '';
    return field === 'name' ? nameError : field === 'nameHi' ? hiError : '';
  };

  const changes = (): CategoryInput => {
    const out: CategoryInput = {};
    const name = form.name.trim().replace(/\s+/g, ' ');
    if (!category || name !== category.name) out.name = name;
    if (mode === 'full' || category) {
      const hi = form.nameHi.trim();
      if ((category?.nameHi ?? '') !== hi) out.nameHi = hi === '' ? null : hi;
    }
    if (!category || form.icon !== iconKeyOf(category.icon)) out.icon = form.icon;
    if (!category || form.forRestaurants !== category.forRestaurants) out.forRestaurants = form.forRestaurants;
    if (!category || form.forDishes !== category.forDishes) out.forDishes = form.forDishes;
    if (!category || form.showOnHome !== category.showOnHome) out.showOnHome = form.showOnHome;
    if (category && form.isActive !== category.isActive) out.isActive = form.isActive;
    return out;
  };

  const submit = async () => {
    if (busy.current) return;
    setTouched(true);
    if (nameError || hiError) return;
    const body = changes();
    if (category && Object.keys(body).length === 0) { setBanner('Nothing was changed.'); return; }
    busy.current = true;
    setSaving(true); setBanner(''); setServerField(null); setExisting(null);
    try {
      if (category) {
        const out = await apiService.updateCategory(category.id, body);
        onSaved(out.category, false, out.changed ? 'Category saved.' : 'Nothing to change.');
      } else {
        const created = await apiService.createCategory(body);
        onSaved(created, true, 'Category added.');
      }
    } catch (failure) {
      onAuthError?.(failure);
      const field = fieldOf(failure, ['name', 'nameHi', 'icon'] as const);
      if (field) setServerField({ field, message: errorText(failure) });
      else setBanner(errorText(failure));
      if (failure instanceof ApiError && failure.code === 'CATEGORY_EXISTS') {
        setExisting(parseCategory(failure.extra?.existing));
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const flagRow = (key: 'forRestaurants' | 'forDishes' | 'showOnHome', title: string, help: string) => (
    <div className="k-inset flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0"><p className="text-sm font-bold text-kraveo-ink">{title}</p><p className="text-[11px] text-kraveo-ink3">{help}</p></div>
      <Switch checked={form[key]} onChange={() => set(key, !form[key])} label={title} disabled={saving} />
    </div>
  );

  return (
    <div className="space-y-4" onKeyDown={(event) => { if (event.key === 'Enter' && (event.target as HTMLInputElement).tagName === 'INPUT' && (event.target as HTMLInputElement).type === 'text') { event.preventDefault(); void submit(); } }}>
      {banner && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{banner}</p>}

      <Field label="Name" htmlFor={id('name')} required error={error('name')} hint="Shown to customers. Letters, digits, spaces and & - ' / + only (2 to 30 characters).">
        <input id={id('name')} className="k-input" value={form.name} maxLength={40} autoComplete="off" disabled={saving} onChange={(e) => set('name', e.target.value)} aria-invalid={Boolean(error('name'))} aria-describedby={`${id('name')}-msg`} />
      </Field>
      {existing && canUseExisting?.(existing) && onUseExisting && (
        <button type="button" className="k-btn-ghost w-full" onClick={() => onUseExisting(existing)}>Use the existing “{existing.name}” instead</button>
      )}

      {mode === 'full' && (
        <Field label="Hindi name (optional)" htmlFor={id('hi')} error={error('nameHi')} hint="Shown next to the English name in the restaurant app.">
          <input id={id('hi')} className="k-input" lang="hi" value={form.nameHi} maxLength={40} autoComplete="off" disabled={saving} onChange={(e) => set('nameHi', e.target.value)} aria-invalid={Boolean(error('nameHi'))} aria-describedby={`${id('hi')}-msg`} />
        </Field>
      )}

      {mode === 'full' ? (
        <fieldset className="space-y-2" disabled={saving}>
          <legend className="k-label mb-2">Icon</legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Icon">
            {ICON_KEYS.map((key) => (
              <label key={key} className="relative cursor-pointer">
                <input type="radio" name={id('icon')} value={key} checked={form.icon === key} onChange={() => set('icon', key)} className="peer sr-only" />
                <span className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-k-sm border border-kraveo-line bg-kraveo-surface2 px-1 py-2 text-[10px] font-bold text-kraveo-ink2 transition-colors peer-checked:border-kraveo-g400 peer-checked:bg-kraveo-g400/15 peer-checked:text-kraveo-g300 peer-focus-visible:ring-2 peer-focus-visible:ring-kraveo-g400/60">
                  <CategoryIcon icon={key} className="h-5 w-5" />
                  <span className="max-w-full truncate">{ICON_LABEL[key]}</span>
                </span>
              </label>
            ))}
          </div>
          {error('icon') && <p role="alert" className="text-xs font-semibold text-kraveo-danger">{error('icon')}</p>}
        </fieldset>
      ) : (
        <Field label="Icon" htmlFor={id('icon')}>
          <select id={id('icon')} className="k-select" value={form.icon} disabled={saving} onChange={(e) => set('icon', e.target.value)}>
            {ICON_KEYS.map((key) => <option key={key} value={key}>{ICON_LABEL[key]}</option>)}
          </select>
        </Field>
      )}

      {mode === 'full' && (
        <div className="space-y-2">
          <p className="k-label">Where it is used</p>
          {flagRow('forRestaurants', 'Restaurants', 'Can be picked as a cuisine when adding or editing a restaurant.')}
          {flagRow('forDishes', 'Dishes', 'Can be picked as the category of a dish.')}
          {flagRow('showOnHome', 'Home chip', 'Shows as a quick filter on the customer app’s home screen, once a restaurant or dish uses it.')}
          {editing && (
            <div className="k-inset flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0"><p className="text-sm font-bold text-kraveo-ink">Active</p><p className="text-[11px] text-kraveo-ink3">Off hides it from pickers and the home screen. Restaurants and dishes that already use it keep it.</p></div>
              <Switch checked={form.isActive} onChange={() => set('isActive', !form.isActive)} label="Active" disabled={saving} />
            </div>
          )}
          {editing && category && usageText(category.usage) && form.name.trim() !== category.name && (
            <p className="text-xs text-kraveo-ink3">Renaming also updates the name shown on {usageText(category.usage)}.</p>
          )}
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <button type="button" className="k-btn-ghost flex-1" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="k-btn-primary flex-1" onClick={() => void submit()} disabled={saving} aria-busy={saving}>
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Saving…</> : editing ? 'Save changes' : 'Add category'}
        </button>
      </div>
    </div>
  );
};
