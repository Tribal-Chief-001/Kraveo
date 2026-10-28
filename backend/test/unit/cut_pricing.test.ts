/**
 * "Cut from sale" commission (Docs/26 section 1): pure unit tests, no database, everything in integer paise.
 * Includes the exactness property test with 100,000+ random cases.
 */
import {
  priceDish, priceBeforeStepPaise, roundUpToStep, toPaise, fromPaise, checkCommissionRule, ruleFromColumns, resolveCommission,
  validateCommissionSetting, vendorPaiseForMenuPrice, customerPaiseFor, CommissionRule,
} from '../../src/services/pricing';
import { describeRule, vendorPriceForMenuPrice } from '../../src/services/catalog';

const cut = (value: number): CommissionRule => ({ type: 'CUT', value });
const G0 = { type: 'PERCENT' as const, value: 0 };

/** Small seeded PRNG so a failure is reproducible. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('CUT: the worked example of the contract', () => {
  test('menu Rs 115, cut 30%: restaurant gets 80.50, Kraveo keeps 34.50', () => {
    const v = vendorPaiseForMenuPrice(11500, cut(30), 1);
    expect(v).toMatchObject({ vendorPaise: 8050, exact: true, lower: 11500, higher: 11600, nearest: 11500 });
    const p = priceDish({ vendorPrice: 80.5, dish: cut(30), global: G0, step: 1 });
    expect(p.price).toBe(115);
    expect(p.effectiveCommission).toBe(34.5);
    expect(p.nominalCommission).toBe(34.5);
    expect(p.rule).toEqual(cut(30));
    expect(p.source).toBe('DISH');
  });

  test('cut 0 changes nothing, cut 90 gives 10x', () => {
    expect(priceDish({ vendorPrice: 77.77, dish: cut(0), global: G0, step: 0 }).price).toBe(77.77);
    expect(priceDish({ vendorPrice: 10, dish: cut(90), global: G0, step: 0 }).price).toBe(100);
  });

  test('CUT resolves like the other types: dish > restaurant > global', () => {
    const r = resolveCommission(null, cut(25), G0);
    expect(r).toEqual({ rule: cut(25), source: 'VENDOR' });
    expect(resolveCommission(null, null, cut(20))).toEqual({ rule: cut(20), source: 'GLOBAL' });
    expect(priceDish({ vendorPrice: 80, vendor: cut(20), global: G0, step: 1 }).price).toBe(100);
  });

  test('the doc text for a rule', () => {
    expect(describeRule(cut(30))).toBe('30% of the sale');
    expect(describeRule({ type: 'PERCENT', value: 5 })).toBe('5%');
    expect(describeRule({ type: 'FLAT', value: 7 })).toBe('Rs 7 flat');
    expect(describeRule(null)).toBe('inherited');
  });
});

describe('CUT: validation 0..90 with two decimals', () => {
  test.each([0, 0.01, 12.5, 30, 89.99, 90])('accepts %p', (v) => {
    expect(checkCommissionRule('CUT', v)).toEqual({ ok: true, value: { type: 'CUT', value: v } });
  });
  test.each([90.01, 91, 99.99, 100, 101, -1, -0.01, 12.345, NaN, Infinity, '30', null, undefined])('refuses %p', (v) => {
    const r = checkCommissionRule('CUT', v as any);
    expect(r.ok).toBe(false);
  });
  test('the message for 100 names the ceiling', () => {
    const r = checkCommissionRule('CUT', 100);
    expect(r.ok === false && r.error.message).toMatch(/cannot be more than 90%/);
    expect(r.ok === false && r.error.field).toBe('value');
  });
  test('PERCENT and FLAT limits are unchanged', () => {
    expect(checkCommissionRule('PERCENT', 100).ok).toBe(true);
    expect(checkCommissionRule('PERCENT', 100.01).ok).toBe(false);
    expect(checkCommissionRule('FLAT', 5000).ok).toBe(true);
    expect(checkCommissionRule('FLAT', 5000.01).ok).toBe(false);
    expect(checkCommissionRule('NOPE', 5).ok).toBe(false);
  });
  test('the global setting may be CUT', () => {
    expect(validateCommissionSetting({ type: 'CUT', value: 20 })).toEqual({ ok: true, value: { type: 'CUT', value: 20 } });
    expect(validateCommissionSetting({ type: 'CUT', value: 95 }).ok).toBe(false);
    expect(validateCommissionSetting({ type: 'CUT', value: 20, extra: 1 }).ok).toBe(false);
  });
  test('ruleFromColumns reads CUT, and a corrupt stored CUT above 90 is read as "inherit" (never a division by zero)', () => {
    expect(ruleFromColumns('CUT', 30)).toEqual(cut(30));
    expect(ruleFromColumns('CUT', 90)).toEqual(cut(90));
    expect(ruleFromColumns('CUT', 100)).toBeNull();
    expect(ruleFromColumns('CUT', 250)).toBeNull();
    expect(ruleFromColumns('CUT', -1)).toBeNull();
    expect(ruleFromColumns('CUT', null)).toBeNull();
    expect(ruleFromColumns('PERCENT', 100)).toEqual({ type: 'PERCENT', value: 100 });
    expect(ruleFromColumns('WHAT', 5)).toBeNull();
  });
});

describe('PERCENT and FLAT results are byte-identical to the old formulas', () => {
  const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);
  test('50,000 random PERCENT and FLAT prices equal the pre-CUT formulas', () => {
    const r = rng(7);
    for (let i = 0; i < 50_000; i++) {
      const vendorPaise = 1 + Math.floor(r() * 1_000_000);
      const pct = Math.round(r() * 10_000) / 100;
      const flat = Math.round(r() * 500_000) / 100;
      expect(priceBeforeStepPaise(vendorPaise, { type: 'PERCENT', value: pct })).toBe(ceilDiv(vendorPaise * (10_000 + toPaise(pct)), 10_000));
      expect(priceBeforeStepPaise(vendorPaise, { type: 'FLAT', value: flat })).toBe(vendorPaise + toPaise(flat));
    }
  });
});

describe('CUT exactness property (Docs/26 section 1)', () => {
  test('100,000 random cases: whole-percent cuts split every whole-rupee menu price exactly and price back to the same menu price', () => {
    const r = rng(2026);
    const failures: string[] = []; // plain ifs, one expect at the end: 100k x several expects would take minutes in jest
    for (let i = 0; i < 100_000; i++) {
      const step = [0, 1, 5][Math.floor(r() * 3)];
      let m = 1 + Math.floor(r() * 5000); // integer rupees 1..5000
      if (step === 5) m = Math.max(5, m - (m % 5)); // a step-5 shop can only sell multiples of 5
      const pct = 1 + Math.floor(r() * 90); // integer percent 1..90
      const rule = cut(pct);
      const vendorPaise = (m * 100 * (10_000 - pct * 100)) / 10_000;
      const tag = `m=${m} pct=${pct} step=${step}`;
      if (!Number.isInteger(vendorPaise)) failures.push(`${tag}: share not a whole paisa`);
      const h = vendorPaiseForMenuPrice(m * 100, rule, step);
      if (h.vendorPaise !== vendorPaise || !h.exact) failures.push(`${tag}: helper ${h.vendorPaise} exact=${h.exact}, want ${vendorPaise}`);
      // pricing that vendor price with the same rule gives back exactly the menu price
      if (customerPaiseFor(vendorPaise, rule, step) !== m * 100) failures.push(`${tag}: customerPaiseFor`);
      if (priceDish({ vendorPrice: fromPaise(vendorPaise), dish: rule, global: G0, step }).price !== m) failures.push(`${tag}: priceDish`);
      // and the cut is exactly pct% of the sale, the restaurant gets exactly the rest
      if (m * 100 - vendorPaise !== (m * 100 * pct) / 100) failures.push(`${tag}: commission not exactly ${pct}%`);
      if (failures.length > 20) break;
    }
    expect(failures).toEqual([]);
  });

  test('50,000 random cases with two-decimal percents and paise prices: largest vendor share not above the menu price, exact whenever any share is, never rounded up', () => {
    const r = rng(99);
    const failures: string[] = [];
    let exactSeen = 0;
    let inexactSeen = 0;
    for (let i = 0; i < 50_000; i++) {
      const menuPaise = 100 + Math.floor(r() * 499_900);
      const pBp = Math.floor(r() * 9001); // 0.00% .. 90.00%
      const step = [0, 1, 2, 5, 10][Math.floor(r() * 5)];
      const rule = cut(pBp / 100);
      const h = vendorPaiseForMenuPrice(menuPaise, rule, step);
      const at = (v: number) => customerPaiseFor(v, rule, step);
      const tag = `menu=${menuPaise} bp=${pBp} step=${step}`;
      if (h.vendorPaise > 0 && (at(h.vendorPaise) > menuPaise || h.lower !== at(h.vendorPaise))) failures.push(`${tag}: derived price above the menu price`);
      if (!(at(h.vendorPaise + 1) > menuPaise) || h.higher !== at(h.vendorPaise + 1)) failures.push(`${tag}: not the largest share`);
      // never overpay the restaurant: its share is at most (menu x (100 - cut)%) exactly
      if (h.vendorPaise * 10_000 > menuPaise * (10_000 - pBp)) failures.push(`${tag}: restaurant overpaid`);
      // exact iff SOME share gives the menu price: scan the neighbourhood
      let any = false;
      for (let v = Math.max(1, h.vendorPaise - 3); v <= h.vendorPaise + 3; v++) if (at(v) === menuPaise) any = true;
      if (h.exact !== any) failures.push(`${tag}: exact=${h.exact} but a share ${any ? 'does' : 'does not'} give it`);
      if (h.exact) exactSeen++; else inexactSeen++;
      // nearest is one of the two neighbours and no further away than the other
      if (!h.exact && h.lower > 0) {
        if (![h.lower, h.higher].includes(h.nearest) || Math.abs(h.nearest - menuPaise) !== Math.min(menuPaise - h.lower, h.higher - menuPaise)) failures.push(`${tag}: nearest`);
      }
      if (failures.length > 20) break;
    }
    expect(failures).toEqual([]);
    expect(exactSeen).toBeGreaterThan(1000);
    expect(inexactSeen).toBeGreaterThan(1000);
  });

  test('two-decimal percents: documented examples', () => {
    // 12.5% of Rs 100 = 12.50 -> restaurant 87.50, exact
    expect(vendorPaiseForMenuPrice(10000, cut(12.5), 1)).toMatchObject({ vendorPaise: 8750, exact: true });
    // 12.5% of Rs 101 = 12.625: the restaurant would get 88.375 -> rounded DOWN to 88.37, and the price rounds UP to 101.00: exact,
    // Kraveo keeps 12.63 (half a paisa more than 12.5%), the restaurant is never overpaid
    const odd = vendorPaiseForMenuPrice(10100, cut(12.5), 0);
    expect(odd).toMatchObject({ vendorPaise: 8837, exact: true });
    expect(10100 - odd.vendorPaise).toBe(1263);
  });

  test('rounding direction: the restaurant is never paid more than menu x (100 - cut)%', () => {
    // 33.33% cut of Rs 10: the restaurant share is 6.667 exactly -> 6.66 (down), never 6.67
    const h = vendorPaiseForMenuPrice(1000, cut(33.33), 0);
    expect(h.vendorPaise).toBe(666);
    expect(h).toMatchObject({ exact: false, lower: 999, higher: 1001, nearest: 999 }); // a tie goes to the lower price
    expect(h.vendorPaise * 10_000).toBeLessThanOrEqual(1000 * (10_000 - 3333));
  });

  test('a menu price below the rounding step or too small to split is not exact and says so', () => {
    const tiny = vendorPaiseForMenuPrice(300, cut(30), 5); // Rs 3 with a Rs 5 step: nothing sells for Rs 3
    expect(tiny.exact).toBe(false);
    expect(tiny.vendorPaise).toBe(0);
    expect(tiny.nearest).toBe(500);
    const step5 = vendorPaiseForMenuPrice(11700, cut(30), 5); // Rs 117 is not a multiple of 5
    expect(step5.exact).toBe(false);
    expect(step5.lower).toBe(11500);
    expect(step5.higher).toBe(12000);
    expect(step5.nearest).toBe(11500);
  });

  test('vendorPaiseForMenuPrice refuses a non-CUT rule', () => {
    expect(() => vendorPaiseForMenuPrice(10000, { type: 'PERCENT', value: 10 })).toThrow(RangeError);
    expect(() => vendorPaiseForMenuPrice(10000, { type: 'FLAT', value: 10 })).toThrow(RangeError);
  });

  test('vendorPriceForMenuPrice (rupees): rule check, exactness, plain messages', () => {
    expect(vendorPriceForMenuPrice(115, cut(30), 1)).toEqual({ ok: true, vendorPrice: 80.5, price: 115 });
    const wrong = vendorPriceForMenuPrice(115, { type: 'PERCENT', value: 10 }, 1);
    expect(wrong).toMatchObject({ ok: false, code: 'MENU_PRICE_NEEDS_CUT_RULE' });
    const odd = vendorPriceForMenuPrice(117, cut(30), 5);
    expect(odd).toMatchObject({ ok: false, code: 'MENU_PRICE_NOT_EXACT', nearestPrice: 115 });
    expect(odd.ok === false && odd.message).toMatch(/nearest price that works is Rs 115/);
  });

  test('roundUpToStep stays the single rounding rule', () => {
    expect(roundUpToStep(customerPaiseFor(8050, cut(30), 5), 5)).toBe(11500);
  });
});
