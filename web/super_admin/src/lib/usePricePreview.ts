import { useEffect, useRef, useState } from 'react';
import { apiService } from '../services/api';
import type { PricePreview } from './catalogParse';
import type { CommissionType } from './pricing';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; last: PricePreview | null }
  | { status: 'ready'; preview: PricePreview }
  | { status: 'error'; message: string };

export const PREVIEW_DEBOUNCE_MS = 400;

interface Inputs {
  /** No preview without a restaurant. */
  vendorId: string;
  /** Already validated numbers: null = the box holds something invalid, so nothing is asked. */
  vendorPrice: number | null;
  /** null = inherit (no commission fields are sent). */
  commission: { type: CommissionType; value: number } | null;
  /** `true` while the commission box holds something invalid: no request, no stale answer. */
  commissionInvalid?: boolean;
}

/**
 * The customer price for the numbers being typed. Waits 400 ms after the last change, asks the server (the price is never
 * computed here), ignores answers that arrive late, and cancels the request that is no longer wanted.
 */
export const usePricePreview = ({ vendorId, vendorPrice, commission, commissionInvalid = false }: Inputs): PreviewState => {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const lastReady = useRef<PricePreview | null>(null);
  const commissionType = commission?.type;
  const commissionValue = commission?.value;

  useEffect(() => {
    if (!vendorId || vendorPrice === null || commissionInvalid) {
      lastReady.current = null;
      setState({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    setState((current) => (current.status === 'ready' ? { status: 'loading', last: current.preview } : current.status === 'loading' ? current : { status: 'loading', last: lastReady.current }));
    const timer = window.setTimeout(() => {
      apiService.previewCatalogPrice({ vendorId, vendorPrice, ...(commissionType ? { commissionType, commissionValue } : {}) }, controller.signal)
        .then((preview) => {
          if (controller.signal.aborted) return;
          lastReady.current = preview;
          setState({ status: 'ready', preview });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setState({ status: 'error', message: error instanceof Error ? error.message : 'The price could not be calculated.' });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [vendorId, vendorPrice, commissionType, commissionValue, commissionInvalid]);

  return state;
};
