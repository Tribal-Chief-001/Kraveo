/**
 * Docs/22 section 1: the money of a combined order, in integer paise. Pure functions, no database.
 * Property: whatever the carts, fee rules and coupon, the children's totals add up to the group total to the paisa.
 */
import { DEFAULT_SETTINGS, FeesSettings, computeFees, fromPaise, largestRemainderSplit, splitGroupMoney, toPaise, validateFees } from '../../src/services/pricing';

// A tiny deterministic PRNG so a failure is reproducible.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const fees = (over: Partial<FeesSettings> = {}): FeesSettings => ({ ...DEFAULT_SETTINGS.fees, lines: [], ...over });

describe('largestRemainderSplit', () => {
  test('parts are integers, never negative and add up exactly (10000 random splits)', () => {
    const r = rng(7);
    for (let k = 0; k < 10_000; k++) {
      const n = 1 + Math.floor(r() * 5);
      const weights = Array.from({ length: n }, () => Math.floor(r() * 50_000));
      const total = Math.floor(r() * 20_000);
      const parts = largestRemainderSplit(total, weights);
      expect(parts).toHaveLength(n);
      expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      // never more than the exact share rounded up
      const sum = weights.reduce((a, b) => a + b, 0);
      if (sum > 0) parts.forEach((p, i) => expect(p).toBeLessThanOrEqual(Math.ceil((total * weights[i]) / sum)));
    }
  });

  test('known cases: ties go to the lowest index, zero weights get nothing, all-zero weights give the first part everything', () => {
    expect(largestRemainderSplit(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainderSplit(5000, [18000, 9000])).toEqual([3333, 1667]);
    expect(largestRemainderSplit(1, [0, 5, 5])).toEqual([0, 1, 0]);
    expect(largestRemainderSplit(7, [0, 0])).toEqual([7, 0]);
    expect(largestRemainderSplit(0, [3, 4])).toEqual([0, 0]);
    expect(largestRemainderSplit(10, [])).toEqual([]);
  });
});

describe('splitGroupMoney', () => {
  test('fee: child 0 = the base fee, every other child = extraRestaurantFee, the total is computeFees on the COMBINED subtotal', () => {
    const f = fees();
    const m = splitGroupMoney(f, [180, 90, 60], 0);
    expect(m.children.map((c) => c.fee)).toEqual([25, 15, 15]);
    expect(m.feeTotal).toBe(55);
    expect(m.feeTotal).toBe(computeFees(f, 330, 3).total);
    expect(m.total).toBe(385);
    expect(m.children.map((c) => c.total)).toEqual([205, 105, 75]);
  });

  test('free-fee-above and the small-order fee look at the COMBINED subtotal (and only touch child 0)', () => {
    const free = splitGroupMoney(fees({ freeFeeAbove: 300 }), [180, 150], 0); // 330 >= 300: base waived, extra stays
    expect(free.children.map((c) => c.fee)).toEqual([0, 15]);
    expect(free.feeTotal).toBe(15);
    const alone = splitGroupMoney(fees({ freeFeeAbove: 300 }), [180, 100], 0); // 280 < 300: not waived (each below, combined below)
    expect(alone.children.map((c) => c.fee)).toEqual([25, 15]);
    const small = splitGroupMoney(fees({ smallOrderBelow: 200, smallOrderFee: 10 }), [90, 90], 0); // 180 < 200
    expect(small.children.map((c) => c.fee)).toEqual([35, 15]);
    const notSmall = splitGroupMoney(fees({ smallOrderBelow: 200, smallOrderFee: 10 }), [100, 100], 0); // 200 is not below 200
    expect(notSmall.children.map((c) => c.fee)).toEqual([25, 15]);
    const zeroExtra = splitGroupMoney(fees({ extraRestaurantFee: 0 }), [50, 50, 50], 0);
    expect(zeroExtra.children.map((c) => c.fee)).toEqual([25, 0, 0]);
  });

  test('coupon: split proportionally to child subtotal, largest remainder, parts add up to the discount exactly', () => {
    const m = splitGroupMoney(fees(), [180, 90, 90], 50); // 50.00 over 360: 25.00, 12.50, 12.50
    expect(m.children.map((c) => c.discount)).toEqual([25, 12.5, 12.5]);
    const odd = splitGroupMoney(fees(), [100, 100, 100], 0.01); // one paisa goes to the first
    expect(odd.children.map((c) => c.discount)).toEqual([0.01, 0, 0]);
    const thirds = splitGroupMoney(fees(), [100, 100, 100], 50); // 5000 paise / 3
    expect(thirds.children.map((c) => toPaise(c.discount))).toEqual([1667, 1667, 1666]);
  });

  test('PROPERTY: 20000 random carts, fee rules and coupons, 2..5 restaurants: children add up to the group total in paise, nothing is negative', () => {
    const r = rng(2026);
    const coupons: ((sub: number) => number)[] = [() => 0, (s) => Math.min(Math.round(s * 20) / 100, 50), () => 20, () => 50];
    for (let k = 0; k < 20_000; k++) {
      const n = 2 + Math.floor(r() * 4);
      const subs = Array.from({ length: n }, () => fromPaise(100 + Math.floor(r() * 90_000))); // 1.00 .. 901.00 with random paise
      const combined = fromPaise(subs.reduce((a, s) => a + toPaise(s), 0));
      const f = fees({
        baseFee: Math.floor(r() * 60),
        extraRestaurantFee: Math.floor(r() * 40),
        freeFeeAbove: r() < 0.4 ? 100 + Math.floor(r() * 500) : 0,
        ...(r() < 0.4 ? { smallOrderBelow: 50, smallOrderFee: 7 } : {}),
      });
      const discount = fromPaise(Math.min(toPaise(coupons[Math.floor(r() * coupons.length)](combined)), toPaise(combined)));
      const m = splitGroupMoney(f, subs, discount);
      const expectedTotal = toPaise(combined) + toPaise(computeFees(f, combined, n).total) - toPaise(discount);
      expect(toPaise(m.total)).toBe(expectedTotal);
      expect(m.children.reduce((a, c) => a + toPaise(c.total), 0)).toBe(expectedTotal);
      expect(m.children.reduce((a, c) => a + toPaise(c.discount), 0)).toBe(toPaise(discount));
      expect(m.children.reduce((a, c) => a + toPaise(c.fee), 0)).toBe(toPaise(m.feeTotal));
      expect(m.children.reduce((a, c) => a + toPaise(c.subtotal), 0)).toBe(toPaise(combined));
      for (const c of m.children) {
        expect(c.total).toBeGreaterThanOrEqual(0);
        expect(c.fee).toBeGreaterThanOrEqual(0);
        expect(c.discount).toBeLessThanOrEqual(c.subtotal);
      }
    }
  });
});

describe('fees settings: maxRestaurantsPerOrder and the extra-restaurant fee range', () => {
  test('default is 3; 1..5 whole numbers are accepted, everything else refused', () => {
    expect(DEFAULT_SETTINGS.fees.maxRestaurantsPerOrder).toBe(3);
    for (const v of [1, 2, 3, 4, 5]) expect(validateFees({ ...DEFAULT_SETTINGS.fees, maxRestaurantsPerOrder: v })).toMatchObject({ ok: true });
    for (const v of [0, 6, -1, 2.5, '3', null, NaN, Infinity]) {
      const r = validateFees({ ...DEFAULT_SETTINGS.fees, maxRestaurantsPerOrder: v });
      expect(r).toMatchObject({ ok: false, error: { field: 'maxRestaurantsPerOrder' } });
    }
  });

  test('a value stored before Docs/22 (key missing) still validates and means 3', () => {
    const { maxRestaurantsPerOrder: _drop, ...old } = DEFAULT_SETTINGS.fees;
    const r = validateFees(old);
    expect(r).toMatchObject({ ok: true, value: { maxRestaurantsPerOrder: 3 } });
  });

  test('extraRestaurantFee is allowed from 0 to 200 (2 decimals), not above', () => {
    expect(validateFees({ ...DEFAULT_SETTINGS.fees, extraRestaurantFee: 0 })).toMatchObject({ ok: true });
    expect(validateFees({ ...DEFAULT_SETTINGS.fees, extraRestaurantFee: 200 })).toMatchObject({ ok: true });
    expect(validateFees({ ...DEFAULT_SETTINGS.fees, extraRestaurantFee: 200.01 })).toMatchObject({ ok: false, error: { field: 'extraRestaurantFee' } });
    expect(validateFees({ ...DEFAULT_SETTINGS.fees, extraRestaurantFee: -1 })).toMatchObject({ ok: false, error: { field: 'extraRestaurantFee' } });
    expect(validateFees({ ...DEFAULT_SETTINGS.fees, extraRestaurantFee: 15.005 })).toMatchObject({ ok: false, error: { field: 'extraRestaurantFee' } });
  });
});
