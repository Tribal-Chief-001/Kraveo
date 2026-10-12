import { describe, expect, it } from 'vitest';
import {
  deleteBlockReason, dishChoices, iconKeyOf, mergeSummary, moveItem, parseCategory, parseCategoryList, parseCategoryResult, parseMergeResult,
  restaurantChoices, slugOf, usageText, validateCategoryName, validateHindiName,
} from './categoryParse';
import { mergeDryRun, rawCategory, rawCategoryList, rawNorthIndian, rawUnused } from '../test/taxonomyFixtures';

describe('parseCategory / parseCategoryList (real admin shapes)', () => {
  it('reads the admin view row field by field', () => {
    expect(parseCategory(rawCategory())).toEqual({
      id: '72077a2d-9b97-48de-9956-8d0167228f34', name: 'Biryani', nameHi: 'बिरयानी', icon: 'biryani', forRestaurants: true, forDishes: true, showOnHome: true,
      sortOrder: 25, isActive: true, restaurantCount: 1, dishCount: 1, usage: { restaurants: 1, dishes: 1 }, inUse: true,
    });
  });

  it('reads the public row (no usage / isActive): usage falls back to the counts and the category counts as active', () => {
    const { usage, inUse, isActive, slug, createdAt, updatedAt, ...publicRow } = rawNorthIndian();
    void usage; void inUse; void isActive; void slug; void createdAt; void updatedAt;
    const c = parseCategory(publicRow)!;
    expect(c.isActive).toBe(true);
    expect(c.usage).toEqual({ restaurants: 1, dishes: 0 });
    expect(c.inUse).toBe(true);
    expect(c.nameHi).toBeNull();
  });

  it('never gives NaN: missing, null, negative or text counts become 0, a missing name a placeholder', () => {
    const c = parseCategory({ id: 'x', restaurantCount: 'lots', dishCount: -3, usage: { restaurants: null, dishes: undefined }, sortOrder: 'abc' })!;
    expect(c).toMatchObject({ id: 'x', name: 'Unnamed category', restaurantCount: 0, dishCount: 0, sortOrder: 0, usage: { restaurants: 0, dishes: 0 }, inUse: false });
    expect(parseCategory({ id: 'y', restaurantCount: '4', usage: { restaurants: '2', dishes: 1.9 } })).toMatchObject({ restaurantCount: 4, usage: { restaurants: 2, dishes: 1 }, inUse: true });
  });

  it('flags default like the server: only an explicit false switches a flag off, showOnHome needs an explicit true', () => {
    expect(parseCategory({ id: 'a' })).toMatchObject({ forRestaurants: true, forDishes: true, showOnHome: false, isActive: true });
    expect(parseCategory({ id: 'a', forRestaurants: false, forDishes: false, showOnHome: true, isActive: false })).toMatchObject({ forRestaurants: false, forDishes: false, showOnHome: true, isActive: false });
  });

  it('rejects rows without an id and non-objects', () => {
    expect(parseCategory(null)).toBeNull();
    expect(parseCategory('x')).toBeNull();
    expect(parseCategory({ name: 'No id' })).toBeNull();
    expect(parseCategory([])).toBeNull();
  });

  it('list: wrapped or bare, bad rows dropped, non-list is null', () => {
    expect(parseCategoryList(rawCategoryList())!.map((c) => c.name)).toEqual(['Biryani', 'North Indian', 'Rolls & Wraps']);
    expect(parseCategoryList([rawCategory(), null, { name: 'x' }])).toHaveLength(1);
    expect(parseCategoryList({ success: true })).toBeNull();
    expect(parseCategoryList(undefined)).toBeNull();
    expect(parseCategoryList({ data: 'nope' })).toBeNull();
  });

  it('create / patch result carries changed and the message', () => {
    const r = parseCategoryResult({ success: true, changed: false, message: 'Nothing to change.', data: rawUnused() });
    expect(r.changed).toBe(false);
    expect(r.message).toBe('Nothing to change.');
    expect(r.category?.name).toBe('Rolls & Wraps');
    expect(parseCategoryResult(null)).toEqual({ category: null, changed: true, message: '' });
  });
});

describe('merge answers', () => {
  it('reads the real dry run', () => {
    const m = parseMergeResult(mergeDryRun)!;
    expect(m).toMatchObject({ dryRun: true, dishes: 0, restaurants: 1, from: { name: 'North Indian' }, into: { name: 'Biryani' }, category: null });
    expect(mergeSummary(m)).toBe('Moves 1 restaurant.');
  });
  it('reads an applied merge with the target category', () => {
    const m = parseMergeResult({ success: true, message: 'Merged. Moved 0 dishes and 0 restaurants.', data: { dryRun: false, from: { id: 'a', name: 'Street Snacks' }, into: { id: 'b', name: 'Chai' }, dishes: 0, restaurants: 0, category: rawCategory({ id: 'b', name: 'Chai' }) } })!;
    expect(m.dryRun).toBe(false);
    expect(m.category?.name).toBe('Chai');
    expect(mergeSummary(m)).toBe('Nothing uses it, so nothing moves.');
  });
  it('plural wording and unusable input', () => {
    expect(mergeSummary({ dishes: 5, restaurants: 2 })).toBe('Moves 2 restaurants and 5 dishes.');
    expect(mergeSummary({ dishes: 1, restaurants: 0 })).toBe('Moves 1 dish.');
    expect(parseMergeResult({ success: true })).toBeNull();
    expect(parseMergeResult(undefined)).toBeNull();
  });
});

describe('usage text and delete reasons', () => {
  it('describes what uses a category', () => {
    expect(usageText({ restaurants: 1, dishes: 2 })).toBe('1 restaurant and 2 dishes');
    expect(usageText({ restaurants: 0, dishes: 0 })).toBe('');
  });
  it('a used category cannot be deleted and says why; an unused one can', () => {
    expect(deleteBlockReason(parseCategory(rawCategory())!)).toBe('Used by 1 restaurant and 1 dish. Hide it, or merge it into another category.');
    expect(deleteBlockReason(parseCategory(rawUnused())!)).toBeNull();
  });
});

describe('name validation mirrors the server', () => {
  it.each([
    ['Biryani', ''], ['Rolls & Wraps', ''], ["Mom's Kitchen", ''], ['Chai/Coffee', ''], ['A+', ''], ['  South   Indian ', ''],
  ])('accepts %s', (name, expected) => expect(validateCategoryName(name)).toBe(expected));
  it.each([
    ['', /at least 2/], ['a', /at least 2/], ['x'.repeat(31), /30 characters/], ['Chai <b>', /Use only letters/], ['बिरयानी', /Use only letters/], ['&&', /Use only letters/], ['Café', /Use only letters/],
  ])('rejects %s', (name, pattern) => expect(validateCategoryName(name)).toMatch(pattern));
  it('Hindi name: optional, 30 max, no angle brackets', () => {
    expect(validateHindiName('')).toBe('');
    expect(validateHindiName('बिरयानी')).toBe('');
    expect(validateHindiName('x'.repeat(31))).toMatch(/30/);
    expect(validateHindiName('a<b')).toMatch(/cannot contain/);
  });
  it('slugOf ignores case, spaces and punctuation', () => {
    expect(slugOf(' Breads & Tandoor ')).toBe('breads-tandoor');
    expect(slugOf('breads   tandoor')).toBe('breads-tandoor');
  });
});

describe('helpers', () => {
  it('moveItem moves one step and refuses to leave the list', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    const same = ['a', 'b'];
    expect(moveItem(same, 0, -1)).toBe(same);
    expect(moveItem(same, 1, 1)).toBe(same);
    expect(moveItem(same, 5, 1)).toBe(same);
  });
  it('icon keys: unknown or missing means the generic icon', () => {
    expect(iconKeyOf('biryani')).toBe('biryani');
    expect(iconKeyOf('rocket')).toBe('restaurant');
    expect(iconKeyOf(undefined)).toBe('restaurant');
  });
  it('picker lists keep only active categories of the right kind', () => {
    const all = [rawCategory(), rawCategory({ id: '2', name: 'Dish only', forRestaurants: false }), rawCategory({ id: '3', name: 'Hidden', isActive: false }), rawCategory({ id: '4', name: 'Rest only', forDishes: false })].map((r) => parseCategory(r)!);
    expect(restaurantChoices(all).map((c) => c.name)).toEqual(['Biryani', 'Rest only']);
    expect(dishChoices(all).map((c) => c.name)).toEqual(['Biryani', 'Dish only']);
  });
});
