/**
 * Pricing engine (Docs/21 section 3): pure unit tests, no database. Everything is checked in integer paise.
 */
import {
  toPaise, fromPaise, roundUpToStep, priceDish, resolveCommission, ruleFromColumns, computeFees, checkCommissionRule,
  validateFees, validateCommissionSetting, validateRounding, validateSettlement, DEFAULT_SETTINGS, cloneDefaults, priceBeforeStepPaise,
} from '../../src/services/pricing';

const G0 = { type: 'PERCENT' as const, value: 0 };
const price = (vendorPrice: number, o: { dish?: any; vendor?: any; global?: any; step?: number } = {}) =>
  priceDish({ vendorPrice, dish: o.dish ?? null, vendor: o.vendor ?? null, global: o.global ?? G0, step: o.step ?? 1 });

describe('money helpers', () => {
  test('toPaise / fromPaise round trip for float-hostile rupee values', () => {
    for (const r of [0, 0.01, 0.07, 0.1, 0.7, 8.2, 19.99, 33.33, 99.99, 1234.56, 9999.99, 10000]) {
      expect(fromPaise(toPaise(r))).toBe(r);
      expect(Number.isInteger(toPaise(r))).toBe(true);
    }
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(() => toPaise(NaN)).toThrow();
    expect(() => toPaise(Infinity)).toThrow();
  });

  test('roundUpToStep: exact multiples stay, everything else goes UP, step 0 = no rounding', () => {
    expect(roundUpToStep(10000, 5)).toBe(10000);
    expect(roundUpToStep(10001, 5)).toBe(10500);
    expect(roundUpToStep(10499, 5)).toBe(10500);
    expect(roundUpToStep(10500, 5)).toBe(10500);
    expect(roundUpToStep(9901, 1)).toBe(10000);
    expect(roundUpToStep(9900, 1)).toBe(9900);
    expect(roundUpToStep(9999, 0)).toBe(9999);
    expect(roundUpToStep(1, 10)).toBe(1000);
    expect(roundUpToStep(0, 5)).toBe(0);
    expect(roundUpToStep(123, -3)).toBe(123);
  });
});

describe('commission resolution: dish > restaurant > global', () => {
  const dish = { type: 'FLAT' as const, value: 7 };
  const vendor = { type: 'PERCENT' as const, value: 10 };
  const global = { type: 'PERCENT' as const, value: 5 };
  test('most specific wins', () => {
    expect(resolveCommission(dish, vendor, global)).toEqual({ rule: dish, source: 'DISH' });
    expect(resolveCommission(null, vendor, global)).toEqual({ rule: vendor, source: 'VENDOR' });
    expect(resolveCommission(null, null, global)).toEqual({ rule: global, source: 'GLOBAL' });
    expect(resolveCommission(undefined, undefined, global).source).toBe('GLOBAL');
  });
  test('a dish override of 0% still beats a restaurant default (0 is a real value, not "unset")', () => {
    expect(resolveCommission({ type: 'PERCENT', value: 0 }, vendor, global).source).toBe('DISH');
    expect(price(100, { dish: { type: 'PERCENT', value: 0 }, vendor, global }).price).toBe(100);
  });
  test('ruleFromColumns: null / half-set / invalid columns inherit', () => {
    expect(ruleFromColumns(null, null)).toBeNull();
    expect(ruleFromColumns('PERCENT', null)).toBeNull();
    expect(ruleFromColumns(null, 5)).toBeNull();
    expect(ruleFromColumns('BOGUS', 5)).toBeNull();
    expect(ruleFromColumns('FLAT', -1)).toBeNull();
    expect(ruleFromColumns('FLAT', 0)).toEqual({ type: 'FLAT', value: 0 });
  });
  test('the three levels give three different prices for the same dish', () => {
    const o = { vendor, global };
    expect(price(100, { ...o, dish }).price).toBe(107); // flat 7
    expect(price(100, o).price).toBe(110); // restaurant 10%
    expect(price(100, { global }).price).toBe(105); // global 5%
  });
});

describe('dish price = roundUp(vendorPrice + commission, step)', () => {
  test('PERCENT and FLAT', () => {
    expect(price(80, { global: { type: 'PERCENT', value: 10 } })).toMatchObject({ price: 88, effectiveCommission: 8, nominalCommission: 8 });
    expect(price(80, { global: { type: 'FLAT', value: 12 } })).toMatchObject({ price: 92, effectiveCommission: 12 });
    expect(price(80, { global: { type: 'FLAT', value: 0 } }).price).toBe(80);
  });
  test('rounding goes UP and the difference is Kraveo\'s (effective commission = price - vendor price)', () => {
    const r = price(33.33, { global: { type: 'PERCENT', value: 10 }, step: 1 }); // 36.663 -> 36.67 -> 37
    expect(r.price).toBe(37);
    expect(r.nominalCommission).toBe(3.34);
    expect(r.effectiveCommission).toBe(3.67);
    expect(price(33.33, { global: { type: 'PERCENT', value: 10 }, step: 0 }).price).toBe(36.67); // next paisa, never down
    expect(price(33.33, { global: { type: 'PERCENT', value: 10 }, step: 5 }).price).toBe(40);
    expect(price(99.5, { step: 1 }).price).toBe(100); // 0% commission still rounds up
    expect(price(100, { step: 5 }).price).toBe(100);
    expect(price(101, { step: 5 }).price).toBe(105);
  });
  test('no float drift: values that are 1 paisa off in floating point stay exact', () => {
    // 0.1 * 3 style traps: 29.99 at 10% = 32.989 -> 32.99 (step 0)
    expect(price(29.99, { global: { type: 'PERCENT', value: 10 }, step: 0 }).price).toBe(32.99);
    // exactly representable-in-paise results do not get bumped a paisa by float noise
    expect(price(70, { global: { type: 'PERCENT', value: 15 }, step: 0 }).price).toBe(80.5);
    expect(price(0.7, { global: { type: 'PERCENT', value: 10 }, step: 0 }).price).toBe(0.77);
    expect(priceBeforeStepPaise(1999, { type: 'PERCENT', value: 12.5 })).toBe(2249); // 2248.875 -> ceil
    expect(priceBeforeStepPaise(2000, { type: 'PERCENT', value: 12.5 })).toBe(2250); // exact
  });
  test('fractional percent (2 decimals) is exact', () => {
    expect(price(200, { global: { type: 'PERCENT', value: 7.5 }, step: 0 }).price).toBe(215);
    expect(price(200, { global: { type: 'PERCENT', value: 0.01 }, step: 0 }).price).toBe(200.02);
    expect(price(1, { global: { type: 'PERCENT', value: 0.01 }, step: 0 }).price).toBe(1.01); // 1.0001 -> next paisa
  });
  test('0 and large values', () => {
    expect(price(0, { global: { type: 'PERCENT', value: 50 } }).price).toBe(0);
    expect(price(0.01, { step: 0 }).price).toBe(0.01);
    expect(price(0.01, { step: 1 }).price).toBe(1);
    expect(price(10000, { global: { type: 'PERCENT', value: 100 }, step: 10 }).price).toBe(20000);
    expect(price(10000, { global: { type: 'FLAT', value: 5000 }, step: 5 }).price).toBe(15000);
    expect(price(9999.99, { global: { type: 'PERCENT', value: 99.99 }, step: 0 }).price).toBe(19998.99); // 9999.99 x 1.9999 = 19998.980001 -> next paisa
    expect(Number.isInteger(toPaise(price(9999.99, { global: { type: 'PERCENT', value: 99.99 }, step: 0 }).price))).toBe(true);
  });
  test('property: price >= vendor, effective >= nominal, price is a multiple of the step, for 5000 pseudo-random inputs', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 5000; i++) {
      const v = Math.round(rnd() * 1_000_000) / 100;
      const pct = Math.round(rnd() * 10000) / 100;
      const step = [0, 1, 2, 5, 10][Math.floor(rnd() * 5)];
      const flat = Math.round(rnd() * 500000) / 100;
      for (const rule of [{ type: 'PERCENT' as const, value: pct }, { type: 'FLAT' as const, value: flat }]) {
        const r = price(v, { global: rule, step });
        const p = toPaise(r.price);
        expect(p).toBeGreaterThanOrEqual(toPaise(v));
        expect(toPaise(r.effectiveCommission)).toBe(p - toPaise(v));
        expect(toPaise(r.effectiveCommission)).toBeGreaterThanOrEqual(toPaise(r.nominalCommission));
        if (step > 0) expect(p % (step * 100)).toBe(0);
        if (step === 0 && rule.type === 'FLAT') expect(p).toBe(toPaise(v) + toPaise(flat));
        // never more than one step (or one paisa) above the exact figure
        const exact = rule.type === 'FLAT' ? toPaise(v) + toPaise(flat) : toPaise(v) * (1 + pct / 100);
        expect(p - exact).toBeLessThan(Math.max(step * 100, 1) + 1e-6);
      }
    }
  });
});

describe('fees', () => {
  const fees = DEFAULT_SETTINGS.fees;
  test('default: one all-in Rs 25, no extras, nothing else', () => {
    const r = computeFees(fees, 100);
    expect(r.total).toBe(25);
    expect(r.breakdown).toMatchObject({ version: 1, total: 25, baseFee: 25, baseWaived: false, smallOrderFee: 0, restaurants: 1, extraRestaurantFee: 0, lines: [] });
    expect(computeFees(fees, 0).total).toBe(25);
    expect(computeFees(fees, 100000).total).toBe(25);
  });
  test('free fee at or above the limit, off when 0', () => {
    const f = { ...fees, freeFeeAbove: 300 };
    expect(computeFees(f, 299.99).total).toBe(25);
    expect(computeFees(f, 300).total).toBe(0);
    expect(computeFees(f, 300).breakdown.baseWaived).toBe(true);
    expect(computeFees({ ...fees, freeFeeAbove: 0 }, 99999).total).toBe(25);
  });
  test('small-order fee below the limit only', () => {
    const f = { ...fees, smallOrderBelow: 100, smallOrderFee: 10 };
    expect(computeFees(f, 99.99).total).toBe(35);
    expect(computeFees(f, 100).total).toBe(25);
    expect(computeFees({ ...f, freeFeeAbove: 500 }, 99).total).toBe(35);
    expect(computeFees({ ...f, freeFeeAbove: 500 }, 500).total).toBe(0);
  });
  test('extra restaurants (phase 3) add the flat extra fee each, even when the base fee is waived', () => {
    expect(computeFees(fees, 100, 2).total).toBe(40);
    expect(computeFees(fees, 100, 3).total).toBe(55);
    expect(computeFees({ ...fees, freeFeeAbove: 50 }, 100, 3).total).toBe(30);
    expect(computeFees(fees, 100, 0).total).toBe(25); // garbage count = 1 restaurant
    expect(computeFees(fees, 100, 2.5).total).toBe(25);
  });
  test('paise precision and a breakdown that adds up', () => {
    const f = { ...fees, baseFee: 24.99, smallOrderBelow: 50, smallOrderFee: 0.01, lines: [{ key: 'delivery', label: 'Delivery', amount: 20 }, { key: 'packing', label: 'Packing', amount: 4.99 }] };
    const r = computeFees(f, 10);
    expect(r.total).toBe(25);
    expect(r.breakdown.lines.reduce((s, l) => s + toPaise(l.amount), 0)).toBe(toPaise(24.99));
    expect(computeFees(f, 60).breakdown.lines).toHaveLength(2);
    expect(computeFees({ ...f, freeFeeAbove: 40 }, 60).breakdown.lines).toEqual([]);
  });
});

describe('validation of the setting groups', () => {
  const ok = (r: any) => expect(r.ok).toBe(true);
  const bad = (r: any, field?: string) => { expect(r.ok).toBe(false); if (field) expect(r.error.field).toBe(field); };

  test('defaults are valid', () => {
    for (const g of ['fees', 'commission', 'rounding', 'settlement'] as const) {
      const check = ({ fees: validateFees, commission: validateCommissionSetting, rounding: validateRounding, settlement: validateSettlement })[g](cloneDefaults(g));
      ok(check);
    }
  });
  test('fees: strict types, ranges, decimals and unknown keys', () => {
    const f = DEFAULT_SETTINGS.fees;
    ok(validateFees({ ...f, baseFee: 0 }));
    ok(validateFees({ ...f, baseFee: 500 }));
    bad(validateFees({ ...f, baseFee: 500.01 }), 'baseFee');
    bad(validateFees({ ...f, baseFee: -1 }), 'baseFee');
    bad(validateFees({ ...f, baseFee: '25' }), 'baseFee');
    bad(validateFees({ ...f, baseFee: NaN }), 'baseFee');
    bad(validateFees({ ...f, baseFee: Infinity }), 'baseFee');
    bad(validateFees({ ...f, baseFee: 25.005 }), 'baseFee');
    bad(validateFees({ ...f, baseFee: null }), 'baseFee');
    bad(validateFees({ ...f, extraRestaurantFee: 501 }), 'extraRestaurantFee');
    bad(validateFees({ ...f, freeFeeAbove: 10001 }), 'freeFeeAbove');
    bad(validateFees({ ...f, gstOnFeesPercent: 101 }), 'gstOnFeesPercent');
    bad(validateFees({ ...f, mystery: 1 }), 'mystery');
    bad(validateFees(null), 'fees');
    bad(validateFees([]), 'fees');
    bad(validateFees({ baseFee: 25 }), 'extraRestaurantFee'); // a full object is required by the validator (the service merges first)
  });
  test('fees: lines must sum to the base fee, keys unique and well formed', () => {
    const f = DEFAULT_SETTINGS.fees;
    ok(validateFees({ ...f, lines: [{ key: 'delivery', label: 'Delivery', amount: 15 }, { key: 'gst', label: 'GST', amount: 10 }] }));
    bad(validateFees({ ...f, lines: [{ key: 'delivery', label: 'Delivery', amount: 15 }] }), 'lines');
    bad(validateFees({ ...f, lines: [{ key: 'a', label: 'A', amount: 15 }, { key: 'a', label: 'B', amount: 10 }] }), 'lines[1].key');
    bad(validateFees({ ...f, lines: [{ key: 'Bad Key', label: 'A', amount: 25 }] }), 'lines[0].key');
    bad(validateFees({ ...f, lines: [{ key: 'a', label: '', amount: 25 }] }), 'lines[0].label');
    bad(validateFees({ ...f, lines: [{ key: 'a', label: 'A', amount: -5 }, { key: 'b', label: 'B', amount: 30 }] }), 'lines[0].amount');
    bad(validateFees({ ...f, lines: [{ key: 'a', label: 'A', amount: 25, extra: 1 }] }), 'lines[0].extra');
    bad(validateFees({ ...f, lines: 'x' }), 'lines');
    bad(validateFees({ ...f, lines: Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, label: 'L', amount: 0 })) }), 'lines');
    // 0.1 + 0.2 style sums are compared in paise, so these are equal
    ok(validateFees({ ...f, baseFee: 0.3, lines: [{ key: 'a', label: 'A', amount: 0.1 }, { key: 'b', label: 'B', amount: 0.2 }] }));
  });
  test('fees: threshold consistency', () => {
    const f = DEFAULT_SETTINGS.fees;
    bad(validateFees({ ...f, freeFeeAbove: 100, smallOrderBelow: 200, smallOrderFee: 5 }), 'smallOrderBelow');
    bad(validateFees({ ...f, smallOrderBelow: 100, smallOrderFee: 0 }), 'smallOrderFee');
    ok(validateFees({ ...f, freeFeeAbove: 300, smallOrderBelow: 100, smallOrderFee: 5 }));
  });
  test('commission: PERCENT 0-100, FLAT 0-5000, 2 decimals, type required', () => {
    ok(validateCommissionSetting({ type: 'PERCENT', value: 100 }));
    ok(validateCommissionSetting({ type: 'FLAT', value: 5000 }));
    ok(validateCommissionSetting({ type: 'PERCENT', value: 0 }));
    bad(validateCommissionSetting({ type: 'PERCENT', value: 100.01 }), 'value');
    bad(validateCommissionSetting({ type: 'FLAT', value: 5000.01 }), 'value');
    bad(validateCommissionSetting({ type: 'PERCENT', value: -0.01 }), 'value');
    bad(validateCommissionSetting({ type: 'PERCENT', value: 1.234 }), 'value');
    bad(validateCommissionSetting({ type: 'percent', value: 5 }), 'type');
    bad(validateCommissionSetting({ type: 'PERCENT', value: '5' }), 'value');
    bad(validateCommissionSetting({ type: 'PERCENT', value: 5, extra: 1 }), 'extra');
    bad(checkCommissionRule('FLAT', Infinity), 'value');
  });
  test('rounding: only the allowed steps', () => {
    for (const step of [0, 1, 2, 5, 10]) ok(validateRounding({ step }));
    for (const step of [3, -1, 0.5, '1', null, NaN]) bad(validateRounding({ step }), 'step');
  });
  test('settlement: HH:MM, mode, holdDays; AUTO_PAYOUT refused until a provider exists', () => {
    const s = DEFAULT_SETTINGS.settlement;
    ok(validateSettlement({ ...s, time: '00:00' }));
    ok(validateSettlement({ ...s, time: '23:59', holdDays: 30 }));
    for (const time of ['24:00', '9:30', '22:60', '22', 2200, null]) bad(validateSettlement({ ...s, time }), 'time');
    bad(validateSettlement({ ...s, holdDays: 31 }), 'holdDays');
    bad(validateSettlement({ ...s, holdDays: 1.5 }), 'holdDays');
    bad(validateSettlement({ ...s, autoCreate: 'yes' }), 'autoCreate');
    bad(validateSettlement({ ...s, mode: 'INSTANT' }), 'mode');
    const auto = validateSettlement({ ...s, mode: 'AUTO_PAYOUT' });
    bad(auto, 'mode');
    expect((auto as any).error.message).toMatch(/not available/i);
  });
});
