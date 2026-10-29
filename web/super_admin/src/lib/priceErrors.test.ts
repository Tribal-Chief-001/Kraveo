import { describe, expect, it } from 'vitest';
import { ApiError } from '../services/api';
import { priceFieldError, priceFieldErrorOf } from './priceErrors';
import { ERR_NEEDS_CUT, ERR_NOT_EXACT, ERR_PRICE_REQUIRED } from '../test/cutFixtures';

const asError = (body: Record<string, any>, status = 400) => new ApiError(status, body.message, body.code, body.field, body);

describe('menu price errors become plain field messages (Docs/26 section 7.3)', () => {
  it('PRICE_REQUIRED and MENU_PRICE_NEEDS_CUT_RULE keep the server words', () => {
    expect(priceFieldErrorOf(asError(ERR_PRICE_REQUIRED))).toEqual({ message: ERR_PRICE_REQUIRED.message, nearestPrice: null });
    expect(priceFieldErrorOf(asError(ERR_NEEDS_CUT))!.message).toContain('Cut from sale');
  });
  it('MENU_PRICE_NOT_EXACT carries the nearest price', () => {
    expect(priceFieldErrorOf(asError(ERR_NOT_EXACT))).toEqual({ message: ERR_NOT_EXACT.message, nearestPrice: 9.99 });
  });
  it('adds the nearest price to the sentence when the server message forgot it', () => {
    expect(priceFieldError('MENU_PRICE_NOT_EXACT', 'Cannot split.', 'menuPrice', { nearestPrice: 115 })!.message).toBe('Cannot split. The nearest price that works is ₹115.');
  });
  it('falls back to a plain sentence when the message is empty', () => {
    expect(priceFieldError('MENU_PRICE_NEEDS_CUT_RULE', '', undefined, {})!.message).toContain('Cut from sale');
  });
  it('a bad price value (BAD_REQUEST on the price field) is a field error too', () => {
    expect(priceFieldError('BAD_REQUEST', 'The menu price must be more than 0.', 'menuPrice')!.message).toBe('The menu price must be more than 0.');
  });
  it('other failures are not price errors; nonsense nearest prices are ignored', () => {
    expect(priceFieldErrorOf(new Error('boom'))).toBeNull();
    expect(priceFieldErrorOf(new ApiError(429, 'Too many', 'RATE_LIMITED'))).toBeNull();
    expect(priceFieldError('MENU_PRICE_NOT_EXACT', 'x', 'menuPrice', { nearestPrice: 'abc' })!.nearestPrice).toBeNull();
    expect(priceFieldError('MENU_PRICE_NOT_EXACT', 'x', 'menuPrice', { nearestPrice: -3 })!.nearestPrice).toBeNull();
  });
});
