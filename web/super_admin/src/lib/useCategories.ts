import { useCallback, useEffect, useRef, useState } from 'react';
import { apiService } from '../services/api';
import type { Category } from './categoryParse';

export interface CategoriesState {
  /** Active categories (hidden ones are left out), in the admin's order. Empty until loaded or when the request failed. */
  categories: Category[];
  loading: boolean;
  /** Plain-words reason the list could not be loaded, '' when fine. Callers fall back to the old free-text behaviour. */
  error: string;
  reload: () => void;
  /** Adds a category the admin just created (so a picker shows it at once, without waiting for a reload). */
  add: (category: Category) => void;
}

/**
 * Loads the managed category list once per `enabled` flip. Pickers use it; the Categories tab has its own fuller loader.
 * A failed load is not fatal: the caller keeps working with the old free-text shape.
 */
export const useCategories = (enabled = true): CategoriesState => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [key, setKey] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    setLoading(true);
    apiService.fetchCategories()
      .then((list) => { if (mine === seq.current) { setCategories(list); setError(''); } })
      .catch((failure) => { if (mine === seq.current) { setCategories([]); setError(failure instanceof Error ? failure.message : 'The categories could not be loaded.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
    return () => { seq.current++; };
  }, [enabled, key]);

  const reload = useCallback(() => setKey((k) => k + 1), []);
  const add = useCallback((category: Category) => setCategories((current) => (current.some((c) => c.id === category.id) ? current : [...current, category])), []);
  return { categories, loading, error, reload, add };
};
