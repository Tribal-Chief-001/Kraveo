import { useEffect, useRef, useState } from 'react';
import { ApiError, apiService } from '../services/api';
import type { PricePreview } from './catalogParse';
import type { CommissionType } from './pricing';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; last: PricePreview | null }
  | { status: 'ready'; preview: PricePreview }
  | { status: 'error'; message: string; /** Docs/26: PRICE_REQUIRED, MENU_PRICE_NEEDS_CUT_RULE, MENU_PRICE_NOT_EXACT. */ code?: string; nearestPrice?: number };

export const PREVIEW_DEBOUNCE_MS = 400;

interface Inputs {
  /** No preview without a restaurant. */
  vendorId: string;
  /** Already validated numbers: null = the box holds something invalid, so nothing is asked. */
  vendorPrice: number | null;
  /** Docs/26: the price the CUSTOMER pays; when set it is asked instead of `vendorPrice` and the server works out the restaurant's share. */
  menuPrice?: number | null;
  /** null = inherit (no commission fields are sent). */
  commission: { type: CommissionType; value: number } | null;
  /** `true` while the commission box holds something invalid: no request, no stale answer. */
  commissionInvalid?: boolean;
}

/**
 * The customer price for the numbers being typed. Waits 400 ms after the last change, asks the server (the price is never
 * computed here), ignores answers that arrive late, and cancels the request that is no longer wanted.
 */
export const usePricePreview = ({ vendorId, vendorPrice, menuPrice = null, commission, commissionInvalid = false }: Inputs): PreviewState => {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const lastReady = useRef<PricePreview | null>(null);
  const commissionType = commission?.type;
  const commissionValue = commission?.value;

  useEffect(() => {
    if (!vendorId || (vendorPrice === null && menuPrice === null) || commissionInvalid) {
      lastReady.current = null;
      setState({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    setState((current) => (current.status === 'ready' ? { status: 'loading', last: current.preview } : current.status === 'loading' ? current : { status: 'loading', last: lastReady.current }));
    const timer = window.setTimeout(() => {
      (menuPrice !== null
        ? apiService.previewCatalogMenuPrice({ vendorId, menuPrice, ...(commissionType ? { commissionType, commissionValue } : {}) }, controller.signal)
        : apiService.previewCatalogPrice({ vendorId, vendorPrice: vendorPrice as number, ...(commissionType ? { commissionType, commissionValue } : {}) }, controller.signal))
        .then((preview) => {
          if (controller.signal.aborted) return;
          lastReady.current = preview;
          setState({ status: 'ready', preview });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          const nearest = error instanceof ApiError ? Number(error.extra?.nearestPrice) : NaN;
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'The price could not be calculated.',
            ...(error instanceof ApiError && error.code ? { code: error.code } : {}),
            ...(Number.isFinite(nearest) ? { nearestPrice: nearest } : {}),
          });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [vendorId, vendorPrice, menuPrice, commissionType, commissionValue, commissionInvalid]);

  return state;
};
