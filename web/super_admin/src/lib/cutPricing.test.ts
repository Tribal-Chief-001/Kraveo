import { describe, expect, it } from 'vitest';
import { MAX_CUT_PERCENT, asCommissionType, commissionLabel, cutExample, cutExampleText, parseCommissionValue, parseMenuPrice, validateCommissionSetting } from './pricing';
import { parseDish, parsePreview, parseVendorCommission, parseSettingSave } from './catalogParse';
import { normalizeVendor } from '../types';
import { parseImportReport } from './catalogBulkParse';
import { CUT_DISH_CREATED, CUT_PREVIEW_MENU, CUT_PREVIEW_VENDOR, CUT_SETTING_SAVED, CUT_VENDOR_SAVED, IMPORT_DRY_CUT, IMPORT_INVALID_CUT, IMPORT_ROW_NOT_EXACT } from '../test/cutFixtures';

describe('cut from sale: value validation mirrors the server (0..90, two decimals)', () => {
  it.each([['0', 0], ['30', 30], ['12.5', 12.5], ['33.33', 33.33], ['90', 90]])('accepts %s', (text, value) => {
    expect(parseCommissionValue('CUT', text)).toEqual({ ok: true, value });
  });
  it.each(['', '-1', '90.01', '91', '100', '12.345', 'abc', '1e2', '30%'])('refuses %j', (text) => {
    expect(parseCommissionValue('CUT', text).ok).toBe(false);
  });
  it('says plainly that 90 is the limit', () => {
    expect(parseCommissionValue('CUT', '95')).toEqual({ ok: false, message: 'A cut from the sale cannot be more than 90%.' });
    expect(parseCommissionValue('CUT', '100')).toEqual({ ok: false, message: 'A cut from the sale cannot be more than 90%.' });
  });
  it('PERCENT still allows 100 and FLAT is unchanged', () => {
    expect(parseCommissionValue('PERCENT', '100')).toEqual({ ok: true, value: 100 });
    expect(parseCommissionValue('FLAT', '7.5')).toEqual({ ok: true, value: 7.5 });
  });
  it('validateCommissionSetting carries the CUT type', () => {
    expect(validateCommissionSetting('CUT', '20')).toEqual({ ok: true, value: { type: 'CUT', value: 20 } });
    expect(validateCommissionSetting('CUT', '91').ok).toBe(false);
  });
  it('menu price: 0 < x <= 5000, two decimals', () => {
    expect(parseMenuPrice('115')).toEqual({ ok: true, value: 115 });
    expect(parseMenuPrice('99.9')).toEqual({ ok: true, value: 99.9 });
    for (const bad of ['0', '', '-5', '5000.01', '5001', '1.234', 'x']) expect(parseMenuPrice(bad).ok).toBe(false);
    expect(parseMenuPrice('5000')).toEqual({ ok: true, value: 5000 });
  });
});

describe('cut from sale: wording', () => {
  it('labels', () => {
    expect(commissionLabel('CUT', 30)).toBe('30% of the sale');
    expect(commissionLabel('CUT', 12.5)).toBe('12.5% of the sale');
    expect(commissionLabel('PERCENT', 12)).toBe('12%');
    expect(commissionLabel('FLAT', 7)).toBe('₹7 flat');
    expect(commissionLabel('CUT', null)).toBe('Default');
    expect(commissionLabel('CUT', Number.NaN)).toBe('Default');
    expect(commissionLabel(null, 5)).toBe('Default');
  });
  it('asCommissionType accepts the three types in any case and nothing else', () => {
    expect(asCommissionType('cut')).toBe('CUT');
    expect(asCommissionType(' PERCENT ')).toBe('PERCENT');
    expect(asCommissionType('FLAT')).toBe('FLAT');
    for (const bad of ['PERCENTAGE', '', null, undefined, 3, {}]) expect(asCommissionType(bad)).toBeNull();
  });
});

describe('cut from sale: the live example (same integer math as the server)', () => {
  it('the contract example: menu price 115, cut 30% -> restaurant 80.50, Kraveo 34.50', () => {
    expect(cutExample(30)).toEqual({ menuPrice: 115, restaurantGets: 80.5, kraveoKeeps: 34.5 });
    expect(cutExampleText(30)).toBe('Menu price ₹115, cut 30%: the restaurant gets ₹80.50, Kraveo keeps ₹34.50.');
  });
  it('edges: 0% and 90%', () => {
    expect(cutExample(0)).toEqual({ menuPrice: 115, restaurantGets: 115, kraveoKeeps: 0 });
    expect(cutExample(90)).toEqual({ menuPrice: 115, restaurantGets: 11.5, kraveoKeeps: 103.5 });
  });
  it('never NaN: an unusable percent gives no example', () => {
    for (const bad of [Number.NaN, -1, 90.5, 100, Infinity]) { expect(cutExample(bad)).toBeNull(); expect(cutExampleText(bad)).toBe(''); }
    expect(cutExample(30, 0)).toBeNull();
  });
  it('the two parts always add up to the menu price, to the paisa (20,000 random cases)', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let i = 0; i < 20_000; i++) {
      const menu = Math.round(rnd() * 500_000) / 100 + 0.01;
      const percent = Math.round(rnd() * MAX_CUT_PERCENT * 100) / 100;
      const e = cutExample(percent, menu)!;
      expect(Number.isFinite(e.restaurantGets) && Number.isFinite(e.kraveoKeeps)).toBe(true);
      expect(Math.round((e.restaurantGets + e.kraveoKeeps) * 100)).toBe(Math.round(menu * 100));
      expect(e.kraveoKeeps).toBeGreaterThanOrEqual(0);
    }
  });
  it('whole percents of whole rupees are exact: Kraveo keeps exactly that percent', () => {
    for (const pct of [5, 10, 20, 25, 30, 40]) for (const menu of [100, 115, 250, 999]) {
      const e = cutExample(pct, menu)!;
      expect(Math.round(e.kraveoKeeps * 100)).toBe(Math.round(menu * pct));
    }
  });
});

describe('parsers accept CUT defensively (real shapes from Docs/26 section 7.4)', () => {
  it('a CUT dish: effective rule, no override, menu position', () => {
    const dish = parseDish(CUT_DISH_CREATED.data)!;
    expect(dish).toMatchObject({ vendorPrice: 80.5, price: 115, effectiveCommission: 34.5, sortOrder: 10, commission: { type: 'CUT', value: 30, source: 'VENDOR' }, commissionOverride: null });
  });
  it('a CUT dish override', () => {
    expect(parseDish({ ...CUT_DISH_CREATED.data, commissionOverride: { type: 'CUT', value: 25 } })!.commissionOverride).toEqual({ type: 'CUT', value: 25 });
  });
  it('an unknown rule type is "no rule", a missing or odd sortOrder is 0, nothing is NaN', () => {
    const dish = parseDish({ ...CUT_DISH_CREATED.data, commission: { type: 'MYSTERY', value: 5, source: 'GLOBAL' }, commissionOverride: { type: 'WAT', value: 1 }, sortOrder: 'abc' })!;
    expect(dish.commission).toBeNull();
    expect(dish.commissionOverride).toBeNull();
    expect(dish.sortOrder).toBe(0);
    expect(parseDish({ id: 'x', sortOrder: -4 })!.sortOrder).toBe(0);
    expect(parseDish({ id: 'x', sortOrder: '20' })!.sortOrder).toBe(20);
    expect(parseDish({ id: 'x' })!.sortOrder).toBe(0);
  });
  it('preview asked with menuPrice carries the restaurant share; asked with vendorPrice it does not add keys', () => {
    expect(parsePreview(CUT_PREVIEW_MENU, null)).toEqual({ price: 115, commission: 34.5, nominalCommission: 34.5, roundingStep: 1, rule: { type: 'CUT', value: 30, source: 'DISH' }, vendorPrice: 80.5 });
    expect(parsePreview(CUT_PREVIEW_VENDOR, 80)).toEqual({ price: 100, commission: 20, nominalCommission: 20, roundingStep: 1, rule: { type: 'CUT', value: 20, source: 'VENDOR' } });
  });
  it('a menu preview without effectiveCommission still gets a sane commission', () => {
    const p = parsePreview({ data: { menuPrice: 115, vendorPrice: 80.5, price: 115 } }, null)!;
    expect(p.commission).toBe(34.5);
    expect(parsePreview({ data: { price: 100 } }, null)!.commission).toBe(0);
  });
  it('settings view and save, vendor commission, vendor list', () => {
    expect(parseSettingSave(CUT_SETTING_SAVED).view!.value).toEqual({ type: 'CUT', value: 20 });
    expect(parseVendorCommission(CUT_VENDOR_SAVED, { type: null, value: null }).commission).toEqual({ type: 'CUT', value: 30 });
    const vendor = normalizeVendor({ id: 'v', name: 'N', commissionType: 'CUT', commissionValue: 30 });
    expect(vendor).toMatchObject({ commissionType: 'CUT', commissionValue: 30 });
    expect(normalizeVendor({ id: 'v', name: 'N', commissionType: 'SOMETHING', commissionValue: 3 })).toMatchObject({ commissionType: null, commissionValue: null });
  });
  it('import report: vendorPrice, sortOrder and error codes', () => {
    const ok = parseImportReport(IMPORT_DRY_CUT)!;
    expect(ok.rows[2]).toMatchObject({ computedPrice: 99, vendorPrice: 69.3, sortOrder: 30, errors: [] });
    const bad = parseImportReport(IMPORT_INVALID_CUT)!;
    expect(bad.summary.invalid).toBe(2);
    expect(bad.rows[1]).toMatchObject({ action: 'invalid', vendorPrice: null, sortOrder: null });
    expect(bad.rows[1].errors[0]).toEqual({ field: 'menuPrice', code: 'PRICE_REQUIRED', message: 'Give either the restaurant price (vendorPrice) or the customer menu price (menuPrice), not both.' });
    const exact = parseImportReport({ data: { rows: [IMPORT_ROW_NOT_EXACT] } })!;
    expect(exact.rows[0].errors[0]).toMatchObject({ code: 'MENU_PRICE_NOT_EXACT', nearestPrice: 9.99 });
  });
  it('import rows with missing or odd numbers do not crash', () => {
    const r = parseImportReport({ data: { rows: [{ index: 0, name: 'A', action: 'create', vendorPrice: 'x', sortOrder: {}, errors: [{ nearestPrice: 'no' }] }] } })!;
    expect(r.rows[0]).toMatchObject({ vendorPrice: null, sortOrder: null });
    expect(r.rows[0].errors[0].nearestPrice).toBeUndefined();
  });
});
