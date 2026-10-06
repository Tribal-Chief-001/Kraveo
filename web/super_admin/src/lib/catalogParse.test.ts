import { describe, expect, it } from 'vitest';
import { asNum, parseDish, parseDishList, parseDishResponse, parseFeeLines, parsePendingCounts, parsePreview, parseRecalc, parseSettingSave, parseSettingView, parseVendorCommission } from './catalogParse';
import { changePendingRaw, deletedRaw, pendingRaw, rawDish, rawList, rawPreview, settingView } from '../test/fixtures';

describe('parseDish (admin dish view)', () => {
  it('reads every field of a live dish', () => {
    expect(parseDish(rawDish())).toMatchObject({
      id: 'd1', vendorId: 'v1', vendorName: 'Sharma Dhaba', name: 'Paneer Roll', state: 'LIVE', approvalStatus: 'APPROVED',
      vendorPrice: 100, price: 112, computedPrice: 112, priceIsStale: false, effectiveCommission: 12, pendingVendorPrice: null, pendingPrice: null,
      commission: { type: 'PERCENT', value: 12, source: 'GLOBAL' }, commissionOverride: null, isVeg: true, isAvailable: true, deletedAt: null,
    });
  });
  it('the dish-level override is `commissionOverride`, not commissionType/commissionValue', () => {
    expect(parseDish(rawDish({ commissionOverride: { type: 'FLAT', value: 7.5 }, commission: { type: 'FLAT', value: 7.5, source: 'DISH' } }))).toMatchObject({
      commissionOverride: { type: 'FLAT', value: 7.5 }, commission: { type: 'FLAT', value: 7.5, source: 'DISH' },
    });
    expect(parseDish(rawDish({ commissionType: 'FLAT', commissionValue: 9 }))!.commissionOverride).toBeNull();
  });
  it('states come from `status`; a deleted dish is DELETED whatever its status', () => {
    expect(parseDish(pendingRaw())!.state).toBe('PENDING');
    expect(parseDish(rawDish({ status: 'REJECTED', approvalStatus: 'REJECTED', rejectionReason: 'Photo missing' }))).toMatchObject({ state: 'REJECTED', rejectionReason: 'Photo missing' });
    expect(parseDish(changePendingRaw())).toMatchObject({ state: 'CHANGE_PENDING', pendingVendorPrice: 120, pendingPrice: 134 });
    expect(parseDish(deletedRaw())!.state).toBe('DELETED');
  });
  it('a stale price keeps both numbers', () => {
    expect(parseDish(rawDish({ price: 110, computedPrice: 112, priceIsStale: true }))).toMatchObject({ price: 110, computedPrice: 112, priceIsStale: true });
  });
  it('a missing isVeg is not claimed as veg; extra fields are ignored', () => {
    expect(parseDish(rawDish({ isVeg: undefined, brandNew: 1 }))!.isVeg).toBe(false);
  });
  it('without status falls back to approvalStatus and the pending price', () => {
    expect(parseDish(rawDish({ status: undefined, approvalStatus: 'PENDING' }))!.state).toBe('PENDING');
    expect(parseDish(rawDish({ status: undefined, pendingVendorPrice: 5 }))!.state).toBe('CHANGE_PENDING');
  });
  it('null without an id', () => {
    expect(parseDish({ name: 'x' })).toBeNull();
    expect(parseDish(null)).toBeNull();
  });
});

describe('parseDishList: { success, total, page, pageSize, pages, data, count }', () => {
  it('uses pages / pageSize / total / page', () => {
    const p = parseDishList(rawList([rawDish(), rawDish({ id: 'd2' })], { total: 60, page: 2, pageSize: 25, pages: 3 }), 1)!;
    expect(p.items.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(p).toMatchObject({ page: 2, pageSize: 25, total: 60, totalPages: 3, hasMore: true });
  });
  it('last page has no more; limit is another name for pageSize', () => {
    expect(parseDishList(rawList([rawDish()], { total: 51, page: 3, pages: 3 }), 3)!.hasMore).toBe(false);
    expect(parseDishList({ data: [rawDish()], total: 30, page: 1, limit: 10 }, 1)).toMatchObject({ pageSize: 10, totalPages: 3, hasMore: true });
  });
  it('skips rows without an id; garbage is null (a bare array is not the real shape)', () => {
    expect(parseDishList(rawList([rawDish(), { nope: 1 }]), 1)!.items).toHaveLength(1);
    expect(parseDishList({ success: true }, 1)).toBeNull();
    expect(parseDishList('<html>', 1)).toBeNull();
    expect(parseDishList([rawDish()], 1)).toBeNull();
  });
});

describe('parseDishResponse: data = admin dish view (+ changed, preview)', () => {
  it('reads data', () => {
    expect(parseDishResponse({ success: true, changed: true, message: 'Dish approved.', data: rawDish(), preview: rawPreview(100) })!.id).toBe('d1');
    expect(parseDishResponse({ success: true })).toBeNull();
  });
});

describe('parsePendingCounts: data { pending, changePending, total }', () => {
  it('uses total for the badge', () => {
    expect(parsePendingCounts({ success: true, data: { pending: 3, changePending: 2, total: 5 } })).toEqual({ pending: 3, changePending: 2, total: 5 });
  });
  it('derives total when missing; null for nonsense', () => {
    expect(parsePendingCounts({ data: { pending: 3, changePending: 2 } })!.total).toBe(5);
    expect(parsePendingCounts({ ok: true })).toBeNull();
    expect(parsePendingCounts({ data: 4 })).toBeNull();
  });
});

describe('parsePreview: data { vendorPrice, price, effectiveCommission, nominalCommission, commission, roundingStep }', () => {
  it('reads the real answer', () => {
    expect(parsePreview({ success: true, data: rawPreview(100, { price: 115, effectiveCommission: 15, nominalCommission: 12, roundingStep: 5 }) }, 100)).toEqual({
      price: 115, commission: 15, nominalCommission: 12, roundingStep: 5, rule: { type: 'PERCENT', value: 12, source: 'GLOBAL' },
    });
  });
  it('null when there is no price', () => {
    expect(parsePreview({ data: {} }, 100)).toBeNull();
    expect(parsePreview(null, 100)).toBeNull();
  });
});

describe('settings views', () => {
  it('GET/PUT data: { group, value, isDefault, updatedAt, updatedBy }', () => {
    expect(parseSettingView({ success: true, data: settingView('rounding', { step: 5 }) })).toEqual({ group: 'rounding', value: { step: 5 }, isDefault: false, updatedAt: '2026-10-06T10:00:00.000Z', updatedBy: 'admin1' });
    expect(parseSettingView({ data: settingView('fees', { baseFee: 25 }, { isDefault: true, updatedAt: null, updatedBy: null }) })).toMatchObject({ isDefault: true, updatedAt: null });
  });
  it('a bare acknowledgement is not a settings view', () => {
    expect(parseSettingView({ success: true })).toBeNull();
    expect(parseSettingView('nope')).toBeNull();
  });
  it('PUT answer: changed, message, recalculateRecommended', () => {
    const r = parseSettingSave({ success: true, changed: true, message: 'Saved. Existing dish prices keep their old value until you run "Recalculate prices".', recalculateRecommended: true, data: settingView('commission', { type: 'FLAT', value: 3 }) });
    expect(r).toMatchObject({ changed: true, recalculateRecommended: true, view: { value: { type: 'FLAT', value: 3 } } });
    expect(r.message).toContain('Recalculate prices');
    expect(parseSettingSave({ success: true, changed: false, message: 'Saved.', data: settingView('fees', {}) })).toMatchObject({ changed: false, recalculateRecommended: false });
  });
  it('fee lines', () => {
    expect(parseFeeLines([{ key: 'a', label: 'Delivery', amount: 15 }, { label: 'Pack', amount: '10' }])).toEqual([{ key: 'a', label: 'Delivery', amount: 15 }, { key: 'line_2', label: 'Pack', amount: 10 }]);
    expect(parseFeeLines(undefined)).toEqual([]);
  });
});

describe('parseRecalc: data { dryRun, applied, total, changed, changes[], truncated }', () => {
  const change = (n: number) => ({ id: `d${n}`, name: `Dish ${n}`, vendorName: 'Sharma Dhaba', vendorPrice: 100, oldPrice: 112, newPrice: 110, deleted: false });
  it('reads the counts, the flags and the first 5 changes', () => {
    const r = parseRecalc({ success: true, message: '7 of 80 dishes would change.', data: { dryRun: true, applied: false, total: 80, changed: 7, changes: Array.from({ length: 7 }, (_, i) => change(i)), truncated: false } });
    expect(r).toMatchObject({ dryRun: true, applied: false, total: 80, changed: 7, truncated: false });
    expect(r.samples).toHaveLength(5);
    expect(r.samples[0]).toEqual({ name: 'Dish 0', vendorName: 'Sharma Dhaba', from: 112, to: 110 });
  });
  it('truncated and applied', () => {
    expect(parseRecalc({ data: { dryRun: false, applied: true, total: 900, changed: 600, changes: [], truncated: true } })).toMatchObject({ dryRun: false, applied: true, truncated: true, changed: 600 });
  });
  it('an unknown answer has no count (the UI then refuses to apply)', () => {
    expect(parseRecalc({ ok: true })).toMatchObject({ changed: null, total: null });
  });
});

describe('parseVendorCommission: data { vendor, effective, dishCount, staleDishes }', () => {
  const ok = { success: true, message: 'Saved. 3 dish prices are out of date: run "Recalculate prices".', data: { vendor: { id: 'v1', name: 'Sharma Dhaba', commissionType: 'FLAT', commissionValue: 4 }, effective: { type: 'FLAT', value: 4, source: 'VENDOR' }, dishCount: 10, staleDishes: 3 } };
  it('uses the stored vendor values and reports the stale dishes and the message', () => {
    const r = parseVendorCommission(ok, { type: 'PERCENT', value: 1 });
    expect(r).toMatchObject({ commission: { type: 'FLAT', value: 4 }, staleDishes: 3, dishCount: 10 });
    expect(r.message).toContain('Recalculate prices');
  });
  it('a cleared override comes back as nulls', () => {
    expect(parseVendorCommission({ message: 'Saved.', data: { vendor: { id: 'v1', name: 'X', commissionType: null, commissionValue: null }, effective: { type: 'PERCENT', value: 0, source: 'GLOBAL' }, dishCount: 0, staleDishes: 0 } }, { type: null, value: null }).commission).toEqual({ type: null, value: null });
  });
  it('an answer without the vendor falls back to what was sent', () => {
    expect(parseVendorCommission({ success: true }, { type: 'PERCENT', value: 9 }).commission).toEqual({ type: 'PERCENT', value: 9 });
  });
});

describe('asNum', () => {
  it('only finite numbers', () => {
    expect(asNum('12')).toBe(12);
    expect(asNum('')).toBeNull();
    expect(asNum(NaN)).toBeNull();
    expect(asNum(null)).toBeNull();
  });
});
