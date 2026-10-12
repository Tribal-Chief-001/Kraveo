import React, { useId, useState } from 'react';
import { ArrowLeft, ArrowRight, Plus, X } from 'lucide-react';
import { Category, MAX_RESTAURANT_CATEGORIES, moveItem } from '../lib/categoryParse';
import { CategoryForm } from './CategoryForm';
import { CategoryIcon } from './ui/CategoryIcon';
import { Field } from './ui/Field';
import { useToast } from './ui/Toast';

interface Props {
  id: string;
  label: string;
  /** Selected category ids in order, first = main. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Active categories a restaurant may pick. */
  choices: Category[];
  /** Names for selected ids that are not in `choices` (hidden or dish-only categories the restaurant already has). */
  known?: Array<{ id: string; name: string; icon: string }>;
  max?: number;
  disabled?: boolean;
  error?: string;
  hint?: string;
  /** A category was created inline: add it to the shared list. */
  onCreated: (category: Category) => void;
  onAuthError?: (error: unknown) => void;
}

/** Ordered chips + "add from the list" + "Create new category". The first chip is the main category. */
export const CategoryMultiSelect: React.FC<Props> = ({ id, label, value, onChange, choices, known = [], max = MAX_RESTAURANT_CATEGORIES, disabled = false, error, hint, onCreated, onAuthError }) => {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const noteId = useId();
  const meta = new Map<string, { name: string; icon: string; hidden: boolean }>();
  known.forEach((k) => meta.set(k.id, { name: k.name, icon: k.icon, hidden: true }));
  choices.forEach((c) => meta.set(c.id, { name: c.name, icon: c.icon, hidden: false }));
  const available = choices.filter((c) => !value.includes(c.id));
  const full = value.length >= max;

  const add = (categoryId: string) => { if (categoryId && !value.includes(categoryId) && value.length < max) onChange([...value, categoryId]); };

  return (
    <div className="space-y-2">
      <Field label={label} htmlFor={`${id}-add`} error={error} hint={hint}>
        <div className="space-y-2">
          {value.length > 0 ? (
            <ol className="flex flex-wrap gap-2" aria-label={`${label}, in order`}>
              {value.map((categoryId, index) => {
                const info = meta.get(categoryId) ?? { name: 'Unknown category', icon: 'restaurant', hidden: true };
                return (
                  <li key={categoryId} className="flex items-center gap-1 rounded-full border border-kraveo-g400/40 bg-kraveo-g400/10 py-1 pl-3 pr-1 text-xs font-bold text-kraveo-g300" data-chip={categoryId}>
                    <CategoryIcon icon={info.icon} className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-[10rem] truncate" title={info.name}>{info.name}</span>
                    {index === 0 && <span className="rounded-full bg-kraveo-g400/25 px-1.5 text-[10px] font-extrabold uppercase">Main</span>}
                    {info.hidden && <span className="text-[10px] font-semibold text-kraveo-ink3">(hidden)</span>}
                    <span className="ml-1 flex items-center">
                      <button type="button" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-kraveo-g400/20 disabled:opacity-40" aria-label={`Move ${info.name} earlier`} disabled={disabled || index === 0} onClick={() => onChange(moveItem(value, index, -1))}><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>
                      <button type="button" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-kraveo-g400/20 disabled:opacity-40" aria-label={`Move ${info.name} later`} disabled={disabled || index === value.length - 1} onClick={() => onChange(moveItem(value, index, 1))}><ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
                      <button type="button" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-kraveo-danger/20 hover:text-kraveo-danger disabled:opacity-40" aria-label={`Remove ${info.name}`} disabled={disabled} onClick={() => onChange(value.filter((v) => v !== categoryId))}><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : <p className="text-sm text-kraveo-ink3">No category yet. Pick up to {max} below; the first one is the main one.</p>}

          <div className="flex flex-col gap-2 sm:flex-row">
            <select id={`${id}-add`} className="k-select sm:flex-1" value="" disabled={disabled || full || available.length === 0} aria-describedby={noteId}
              onChange={(event) => add(event.target.value)}>
              <option value="">{full ? `Limit of ${max} reached` : available.length === 0 ? 'Every category is already added' : 'Add a category…'}</option>
              {available.map((c) => <option key={c.id} value={c.id}>{c.name}{c.nameHi ? ` · ${c.nameHi}` : ''}</option>)}
            </select>
            <button type="button" className="k-btn-ghost shrink-0" onClick={() => setCreating((open) => !open)} disabled={disabled || full} aria-expanded={creating}>
              <Plus className="h-4 w-4" aria-hidden="true" />Create new category
            </button>
          </div>
          <p id={noteId} className="text-[11px] text-kraveo-ink3">{value.length} of {max} chosen. The first is shown as the main category.</p>
        </div>
      </Field>

      {creating && (
        <div className="k-inset space-y-3 p-4" role="group" aria-label="Create a new category">
          <p className="text-sm font-bold text-kraveo-ink">New category for restaurants</p>
          <CategoryForm
            category={null}
            mode="quick"
            preset={{ forRestaurants: true, forDishes: false, showOnHome: false }}
            canUseExisting={(existing) => existing.isActive && existing.forRestaurants}
            onUseExisting={(existing) => { onCreated(existing); add(existing.id); setCreating(false); }}
            onSaved={(created) => {
              onCreated(created);
              add(created.id);
              setCreating(false);
              toast.success('Category added', `“${created.name}” was created and added. You can change where it is used in the Categories tab.`);
            }}
            onCancel={() => setCreating(false)}
            onAuthError={onAuthError}
          />
        </div>
      )}
    </div>
  );
};
