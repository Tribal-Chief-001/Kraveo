import { useEffect, useState } from 'react';
import { apiService } from '../services/api';
import { asNum } from './catalogParse';
import { asCommissionType, type CommissionType } from './pricing';

export interface GlobalRule { type: CommissionType; value: number }

/**
 * The default commission rule (Settings), asked of the server once when `enabled`. It tells the dish form and the import
 * wizard whether a restaurant WITHOUT its own rule is on "Cut from sale". Null while loading, when not enabled, or when it
 * cannot be read: the callers then simply do not offer the menu-price entry (the server still decides).
 */
export const useGlobalCommission = (enabled: boolean): GlobalRule | null => {
  const [rule, setRule] = useState<GlobalRule | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    apiService.fetchSettings('commission')
      .then((view) => {
        const type = asCommissionType(view.value.type);
        const value = asNum(view.value.value);
        if (current && type && value !== null) setRule({ type, value });
      })
      .catch(() => { /* unknown rule: nothing changes */ });
    return () => { current = false; };
  }, [enabled]);
  return rule;
};
