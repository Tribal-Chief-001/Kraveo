import { describe, expect, it } from 'vitest';
import { LINE_KEY_RE, ROUNDING_STEPS, amountText, commissionLabel, FeesForm, isHttpUrl, parseAmount, parseCommissionValue, parseVendorPrice, rupees, validateCommissionSetting, validateFees } from './pricing';

describe('rupees', () => {
  it('shows paise only when present', () => {
    expect(rupees(120)).toBe('₹120');
    expect(rupees(120.5)).toBe('₹120.50');
    expect(rupees(1234.05)).toBe('₹1,234.05');
    expect(rupees(0)).toBe('₹0');
  });
  it('shows a dash for missing or broken numbers', () => {
    expect(rupees(null)).toBe('—');
    expect(rupees(undefined)).toBe('—');
    expect(rupees(NaN)).toBe('—');
  });
});

describe('parseVendorPrice never lets a bad number through', () => {
  it.each(['', '  ', '-5', '-0.5', 'abc', '1e9', '12.345', '1,200', '0', '0.00', '10000.01', '99999999', 'NaN', 'Infinity', '12 .5', '.5'])('rejects %j', (text) => {
    expect(parseVendorPrice(text).ok).toBe(false);
  });
  it.each([['120', 120], ['120.5', 120.5], [' 99.99 ', 99.99], ['10000', 10000], ['0.01', 0.01]])('accepts %j', (text, value) => {
    expect(parseVendorPrice(text)).toEqual({ ok: true, value });
  });
  it('messages are plain words', () => {
    const r = parseVendorPrice('12.345');
    expect(!r.ok && r.message).toMatch(/2 decimals/);
    const n = parseVendorPrice('-1');
    expect(!n.ok && n.message).toMatch(/negative/);
  });
});

describe('commission values', () => {
  it('percent is 0 to 100', () => {
    expect(parseCommissionValue('PERCENT', '12.5')).toEqual({ ok: true, value: 12.5 });
    expect(parseCommissionValue('PERCENT', '0')).toEqual({ ok: true, value: 0 });
    expect(parseCommissionValue('PERCENT', '100.01').ok).toBe(false);
    expect(parseCommissionValue('PERCENT', '-1').ok).toBe(false);
  });
  it('flat is an exact rupee amount with at most 2 decimals', () => {
    expect(parseCommissionValue('FLAT', '7.5')).toEqual({ ok: true, value: 7.5 });
    expect(parseCommissionValue('FLAT', '7.555').ok).toBe(false);
    expect(parseCommissionValue('FLAT', '5000')).toEqual({ ok: true, value: 5000 });
    expect(parseCommissionValue('FLAT', '5001').ok).toBe(false); // server LIMITS.maxFlatCommission
  });
  it('labels', () => {
    expect(commissionLabel('PERCENT', 10)).toBe('10%');
    expect(commissionLabel('FLAT', 5)).toBe('₹5 flat');
    expect(commissionLabel(null, null)).toBe('Default');
  });
});

describe('helpers', () => {
  it('amountText has no trailing zeros', () => {
    expect(amountText(120)).toBe('120');
    expect(amountText(120.5)).toBe('120.5');
    expect(amountText(null)).toBe('');
  });
  it('parseAmount supports custom ranges', () => {
    expect(parseAmount('5', { label: 'x', max: 4 }).ok).toBe(false);
    expect(parseAmount('0', { label: 'x', max: 4, allowZero: false }).ok).toBe(false);
  });
  it('isHttpUrl accepts only http(s)', () => {
    expect(isHttpUrl('https://a.b/c.jpg')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

const form = (over: Partial<FeesForm> = {}): FeesForm => ({
  baseFee: '25', lines: [], extraRestaurantFee: '15', freeFeeAbove: '0', smallOrderBelow: '0', smallOrderFee: '0', gstOnFeesPercent: '18', gstOnFoodPercent: '5', ...over,
});

describe('validateFees', () => {
  it('accepts the defaults and returns numbers', () => {
    const r = validateFees(form());
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ baseFee: 25, lines: [], extraRestaurantFee: 15, freeFeeAbove: 0, gstOnFeesPercent: 18 });
  });
  it('named lines must add up to the all-in fee (paise exact)', () => {
    const bad = validateFees(form({ lines: [{ rowId: 1, label: 'Delivery', amount: '15' }, { rowId: 2, label: 'Packaging', amount: '9.99' }] }));
    expect(bad.ok).toBe(false);
    expect(bad.errors.lines).toMatch(/must be equal/);
    const good = validateFees(form({ baseFee: '25.10', lines: [{ rowId: 1, label: 'Delivery', amount: '15.05' }, { rowId: 2, label: 'Packaging & GST', amount: '10.05' }] }));
    expect(good.ok).toBe(true);
    expect(good.value?.lines.map((l) => l.key)).toEqual(['delivery', 'packaging_gst']);
  });
  it('0.1 + 0.2 style float noise does not break the sum', () => {
    const r = validateFees(form({ baseFee: '0.30', lines: [{ rowId: 1, label: 'One', amount: '0.10' }, { rowId: 2, label: 'Two', amount: '0.20' }] }));
    expect(r.ok).toBe(true);
  });
  it('flags empty, negative and over-limit fields, and line problems', () => {
    const r = validateFees(form({ baseFee: '', extraRestaurantFee: '-1', gstOnFeesPercent: '101', lines: [{ rowId: 7, label: '', amount: 'x' }] }));
    expect(r.ok).toBe(false);
    expect(r.errors.baseFee).toBeTruthy();
    expect(r.errors.extraRestaurantFee).toBeTruthy();
    expect(r.errors.gstOnFeesPercent).toBeTruthy();
    expect(r.errors.lineErrors?.[7]).toEqual({ label: expect.any(String), amount: expect.any(String) });
  });
  it('limits match the server: fee up to 500, limits up to 10000', () => {
    expect(validateFees(form({ baseFee: '500' })).ok).toBe(true);
    expect(validateFees(form({ baseFee: '501' })).ok).toBe(false);
    expect(validateFees(form({ freeFeeAbove: '10000' })).ok).toBe(true);
    expect(validateFees(form({ freeFeeAbove: '10001' })).ok).toBe(false);
  });
  it('line keys satisfy the server rule (lower case, start with a letter, up to 30), and kept keys survive a rename', () => {
    const r = validateFees(form({ baseFee: '25', lines: [{ rowId: 1, label: '18% GST!', amount: '10' }, { rowId: 2, key: 'delivery_fee', label: 'Rider charge', amount: '15' }] }));
    expect(r.value?.lines.map((l) => l.key)).toEqual(['l_18_gst', 'delivery_fee']);
    for (const l of r.value!.lines) expect(LINE_KEY_RE.test(l.key)).toBe(true);
    const long = validateFees(form({ baseFee: '5', lines: [{ rowId: 1, label: 'a'.repeat(40), amount: '5' }] }));
    expect(LINE_KEY_RE.test(long.value!.lines[0].key)).toBe(true);
  });
  it('more than 10 lines is refused', () => {
    const lines = Array.from({ length: 11 }, (_, i) => ({ rowId: i, label: `Line ${i}`, amount: '1' }));
    expect(validateFees(form({ baseFee: '11', lines })).ok).toBe(false);
  });
  it('two lines with the same name get different keys', () => {
    const r = validateFees(form({ baseFee: '10', lines: [{ rowId: 1, label: 'Fee', amount: '5' }, { rowId: 2, label: 'Fee', amount: '5' }] }));
    expect(r.value?.lines.map((l) => l.key)).toEqual(['fee', 'fee_2']);
  });
});

describe('validateCommissionSetting', () => {
  it('returns the typed setting', () => {
    expect(validateCommissionSetting('PERCENT', '8')).toEqual({ ok: true, value: { type: 'PERCENT', value: 8 } });
    expect(validateCommissionSetting('FLAT', 'abc').ok).toBe(false);
  });
});

describe('rounding steps match the server', () => {
  it('0, 1, 2, 5 and 10', () => { expect([...ROUNDING_STEPS]).toEqual([0, 1, 2, 5, 10]); });
});
