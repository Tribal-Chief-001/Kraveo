// Docs/26 section 7.3: the single-dish answers about a menu price, turned into one plain sentence for the price field.
import { ApiError } from '../services/api';
import { rupees } from './pricing';

export const MENU_PRICE_CODES = ['PRICE_REQUIRED', 'MENU_PRICE_NEEDS_CUT_RULE', 'MENU_PRICE_NOT_EXACT'] as const;

export interface PriceFieldError {
  message: string;
  /** MENU_PRICE_NOT_EXACT: the closest price that can be sold exactly (rupees). */
  nearestPrice: number | null;
}

const FALLBACK: Record<string, string> = {
  PRICE_REQUIRED: 'Give either the restaurant price or the menu price, not both.',
  MENU_PRICE_NEEDS_CUT_RULE: 'A menu price can only be used when the commission is "Cut from sale". Enter the restaurant price instead, or change the commission first.',
  MENU_PRICE_NOT_EXACT: 'This menu price cannot be split exactly at this cut.',
};

const finite = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The price-field message for a menu-price error code, or a bad `menuPrice` / `vendorPrice` value. Null for any other failure. */
export const priceFieldError = (code: string | undefined, message: string | undefined, field: string | undefined, extra?: Record<string, any>): PriceFieldError | null => {
  const known = code !== undefined && (MENU_PRICE_CODES as readonly string[]).includes(code);
  if (!known && field !== 'menuPrice' && field !== 'vendorPrice') return null;
  const nearest = code === 'MENU_PRICE_NOT_EXACT' ? finite(extra?.nearestPrice) : null;
  let text = message && message.trim() !== '' ? message.trim() : (code && FALLBACK[code]) || 'This price is not valid.';
  if (nearest !== null && !text.includes(String(nearest))) text = `${text} The nearest price that works is ${rupees(nearest)}.`;
  return { message: text, nearestPrice: nearest };
};

export const priceFieldErrorOf = (error: unknown): PriceFieldError | null =>
  (error instanceof ApiError ? priceFieldError(error.code, error.message, error.field, error.extra) : null);
