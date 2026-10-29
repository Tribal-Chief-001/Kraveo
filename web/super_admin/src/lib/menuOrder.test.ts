import { describe, expect, it } from 'vitest';
import { parseDish } from './catalogParse';
import {
  MAX_ORDER_DISHES, MAX_ORDER_SECTIONS, buildSections, countChanges, countDishes, describeChanges, moveDish, moveItem, moveSection, orderLimitProblem, parseMenuOrderResult, sameOrder, sectionKey, toMenuOrderInput,
} from './menuOrder';
import { MENU_ORDER_SAVED, MENU_ORDER_UNCHANGED } from '../test/cutFixtures';
import { rawDish } from '../test/fixtures';

const dishes = (spec: Array<[string, string, Record<string, unknown>?]>) => spec.map(([id, category, over]) => parseDish(rawDish({ id, name: id.toUpperCase(), category, ...(over ?? {}) }))!);
const names = (sections: readonly { category: string; dishes: { id: string }[] }[]) => sections.map((s) => `${s.category}:${s.dishes.map((d) => d.id).join('')}`);

describe('buildSections', () => {
  it('sections follow the first appearance of each category in the server order', () => {
    const s = buildSections(dishes([['a', 'Snacks'], ['b', 'Main Course'], ['c', 'Snacks'], ['d', 'Desserts'], ['e', 'Main Course']]));
    expect(names(s)).toEqual(['Snacks:ac', 'Main Course:be', 'Desserts:d']);
  });
  it('matches section names ignoring case and spacing, like the server', () => {
    const s = buildSections(dishes([['a', 'Main Course'], ['b', ' main   course '], ['c', 'MAIN COURSE']]));
    expect(s).toHaveLength(1);
    expect(s[0].dishes.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(s[0].category).toBe('Main Course');
    expect(sectionKey('  Main   Course ')).toBe('main course');
  });
  it('deleted dishes are left out; pending and rejected ones are marked as not live', () => {
    const s = buildSections(dishes([['a', 'X'], ['b', 'X', { deletedAt: '2026-10-07T00:00:00.000Z' }], ['c', 'X', { status: 'PENDING', approvalStatus: 'PENDING' }], ['d', 'X', { isAvailable: false }]]));
    expect(s[0].dishes.map((d) => [d.id, d.notLive, d.isAvailable])).toEqual([['a', false, true], ['c', true, true], ['d', false, false]]);
  });
  it('dishes without a category go into a last, unnamed section that is never sent by name', () => {
    const s = buildSections(dishes([['a', ''], ['b', 'Rolls']]));
    expect(s.map((x) => x.key)).toEqual(['rolls', '']);
    expect(toMenuOrderInput(s).sections).toEqual(['Rolls']);
    expect(toMenuOrderInput(s).dishes.map((d) => d.id)).toEqual(['b', 'a']);
  });
  it('an empty menu gives no sections', () => { expect(buildSections([])).toEqual([]); });
});

describe('moving', () => {
  const base = () => buildSections(dishes([['a', 'One'], ['b', 'One'], ['c', 'Two'], ['d', 'Three']]));
  it('moveItem swaps neighbours and returns the same list at the ends', () => {
    const list = [1, 2, 3];
    expect(moveItem(list, 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem(list, 1, 1)).toEqual([1, 3, 2]);
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 2, 1)).toBe(list);
    expect(moveItem(list, 9, 1)).toBe(list);
    expect(moveItem(list, -1, 1)).toBe(list);
    expect(moveItem(list, 1.5, 1)).toBe(list);
    expect(list).toEqual([1, 2, 3]);
  });
  it('moveSection does not change the original and keeps dishes with their section', () => {
    const before = base();
    const after = moveSection(before, 'three', -1);
    expect(names(after)).toEqual(['One:ab', 'Three:d', 'Two:c']);
    expect(names(before)).toEqual(['One:ab', 'Two:c', 'Three:d']);
    expect(moveSection(before, 'one', -1)).toBe(before);
    expect(moveSection(before, 'three', 1)).toBe(before);
    expect(moveSection(before, 'nope', 1)).toBe(before);
  });
  it('moveDish moves only inside its own section', () => {
    const before = base();
    const after = moveDish(before, 'one', 'b', -1);
    expect(names(after)).toEqual(['One:ba', 'Two:c', 'Three:d']);
    expect(moveDish(before, 'one', 'a', -1)).toBe(before);
    expect(moveDish(before, 'one', 'b', 1)).toBe(before);
    expect(moveDish(before, 'two', 'a', 1)).toBe(before);
    expect(moveDish(before, 'zzz', 'a', 1)).toBe(before);
  });
  it('the unnamed section stays last', () => {
    const s = buildSections(dishes([['a', ''], ['b', 'Rolls'], ['c', 'Snacks']]));
    expect(s.map((x) => x.key)).toEqual(['rolls', 'snacks', '']);
    expect(moveSection(s, 'snacks', 1)).toBe(s);
    expect(moveSection(s, '', -1)).toBe(s);
  });
  it('a section with 300 dishes: move the last one to the top with 299 steps, the order is exact', () => {
    const many = dishes(Array.from({ length: 300 }, (_, i) => [`d${i}`, 'Big'] as [string, string]));
    let s: readonly ReturnType<typeof buildSections>[number][] = buildSections(many);
    for (let i = 0; i < 299; i++) s = moveDish(s, 'big', 'd299', -1);
    expect(s[0].dishes.slice(0, 3).map((d) => d.id)).toEqual(['d299', 'd0', 'd1']);
    expect(s[0].dishes).toHaveLength(300);
    expect(new Set(s[0].dishes.map((d) => d.id)).size).toBe(300);
    expect(moveDish(s, 'big', 'd299', -1)).toBe(s);
  });
});

describe('what is sent and what changed', () => {
  it('toMenuOrderInput: all sections in order and every dish with a 1-based rank inside its section', () => {
    const s = moveSection(buildSections(dishes([['a', 'One'], ['b', 'One'], ['c', 'Two']])), 'two', -1);
    expect(toMenuOrderInput(s)).toEqual({ sections: ['Two', 'One'], dishes: [{ id: 'c', position: 1 }, { id: 'a', position: 1 }, { id: 'b', position: 2 }] });
  });
  it('sameOrder and countChanges', () => {
    const saved = buildSections(dishes([['a', 'One'], ['b', 'One'], ['c', 'Two'], ['d', 'Three']]));
    expect(sameOrder(saved, saved)).toBe(true);
    expect(countChanges(saved, saved)).toEqual({ sections: 0, dishes: 0 });
    const moved = moveDish(moveSection(saved, 'three', -1), 'one', 'b', -1);
    expect(sameOrder(saved, moved)).toBe(false);
    expect(countChanges(saved, moved)).toEqual({ sections: 2, dishes: 2 });
    expect(sameOrder(moved, moveDish(moved, 'one', 'b', 1))).toBe(false);
    expect(sameOrder(moved, moveDish(moved, 'one', 'a', 1))).toBe(true); // already last: no move
  });
  it('describeChanges uses plain numbers', () => {
    expect(describeChanges({ sections: 0, dishes: 0 })).toBe('No changes');
    expect(describeChanges({ sections: 1, dishes: 0 })).toBe('1 section in a new place');
    expect(describeChanges({ sections: 2, dishes: 3 })).toBe('2 sections and 3 dishes in a new place');
  });
  it('limits mirror the server caps', () => {
    expect(orderLimitProblem([])).toBeNull();
    const tooManySections = Array.from({ length: MAX_ORDER_SECTIONS + 1 }, (_, i) => ({ key: `s${i}`, category: `S${i}`, dishes: [] }));
    expect(orderLimitProblem(tooManySections)).toContain('60');
    const bigSection = [{ key: 'x', category: 'X', dishes: Array.from({ length: MAX_ORDER_DISHES + 1 }, (_, i) => ({ id: `d${i}`, name: 'n', isAvailable: true, notLive: false })) }];
    expect(countDishes(bigSection)).toBe(401);
    expect(orderLimitProblem(bigSection)).toContain('400');
  });
});

describe('parseMenuOrderResult (real answer, Docs/26 section 7.4)', () => {
  it('reads the section list and the changed flag', () => {
    expect(parseMenuOrderResult(MENU_ORDER_SAVED)).toEqual({ changed: true, message: 'Menu order saved.', sections: [{ category: 'Desserts', dishCount: 1 }, { category: 'Snacks', dishCount: 2 }, { category: 'Main Course', dishCount: 3 }] });
    expect(parseMenuOrderResult(MENU_ORDER_UNCHANGED)!.changed).toBe(false);
  });
  it('null without a list; odd rows never produce NaN', () => {
    expect(parseMenuOrderResult({ success: true })).toBeNull();
    expect(parseMenuOrderResult(null)).toBeNull();
    expect(parseMenuOrderResult('x')).toBeNull();
    expect(parseMenuOrderResult({ data: [{ category: 4, dishCount: 'many' }, 'junk', null] })!.sections).toEqual([{ category: '', dishCount: 0 }]);
  });
});
