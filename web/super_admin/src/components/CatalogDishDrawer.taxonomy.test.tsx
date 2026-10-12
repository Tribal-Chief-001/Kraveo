// @vitest-environment jsdom
// Docs/23 in the dish drawer: category select + inline create, photo upload, Duplicate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { CatalogDishDrawer, copyName } from './CatalogDishDrawer';
import { ApiError, apiService } from '../services/api';
import { CategoriesState } from '../lib/useCategories';
import { parseCategory } from '../lib/categoryParse';
import { Decoded, ImageEnv } from '../lib/imageCompress';
import { dish, preview as previewOf } from '../test/fixtures';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';
import { rawCategory, rawNorthIndian, rawUnused } from '../test/taxonomyFixtures';

const vendors = [{ id: 'v1', name: 'Sharma Dhaba' }, { id: 'v2', name: 'Chai Point' }] as any[];
const cat = (raw: Record<string, unknown>) => parseCategory(raw)!;
const BIRYANI = cat(rawCategory());
const ROLLS = cat(rawUnused({ id: 'rolls-id', name: 'Rolls', forRestaurants: false }));
const RESTAURANT_ONLY = cat(rawNorthIndian({ forDishes: false }));

const state = (over: Partial<CategoriesState> = {}): CategoriesState => ({
  categories: [BIRYANI, ROLLS, RESTAURANT_ONLY], loading: false, error: '', reload: vi.fn(), add: vi.fn(), ...over,
});

const open = (item: ReturnType<typeof dish> | null, over: Record<string, unknown> = {}) => {
  const props = { onClose: vi.fn(), onChanged: vi.fn(), onAuthError: vi.fn(), categoryState: state(), ...over };
  return { props, element: <CatalogDishDrawer open item={item} vendors={vendors} categories={['Rolls']} {...(props as any)} /> };
};

beforeEach(() => {
  vi.spyOn(apiService, 'previewCatalogPrice').mockImplementation(async (input) => previewOf(input.vendorPrice)) as any;
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('category select', () => {
  it('lists only active DISH categories (not restaurant-only ones), with the Hindi name', async () => {
    await mount(open(null).element);
    const select = byId('dish-category') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Choose a category…', 'Biryani · बिरयानी', 'Rolls']);
  });

  it('create sends the chosen category by id (not typed text)', async () => {
    const create = vi.spyOn(apiService, 'createCatalogItem').mockResolvedValue(null);
    await mount(open(null).element);
    await click(byText('button', 'Add dish'));
    expect(document.body.textContent).toContain('Choose a category from the list, or create a new one.');
    await type(byId('dish-vendor'), 'v2');
    await type(byId('dish-name'), 'Egg Roll');
    await type(byId('dish-category'), 'Rolls');
    await type(byId('dish-price'), '40');
    await click(byText('button', 'Add dish'));
    await flush();
    expect(create).toHaveBeenCalledWith({ vendorId: 'v2', name: 'Egg Roll', categoryId: 'rolls-id', isVeg: true, isAvailable: true, vendorPrice: 40 });
  });

  it('editing: the dish’s current category is selected; an unchanged category is not sent', async () => {
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(dish({ category: 'Rolls' })).element);
    expect((byId('dish-category') as HTMLSelectElement).value).toBe('Rolls');
    await type(byId('dish-name'), 'Paneer Roll Special');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith('d1', { name: 'Paneer Roll Special' });
  });

  it('editing: a different category is sent as categoryId', async () => {
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(dish({ category: 'Rolls' })).element);
    await type(byId('dish-category'), 'Biryani');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith('d1', { categoryId: BIRYANI.id });
  });

  it('a dish whose category is hidden / spelled differently still opens, shows it, and saves other edits without touching it', async () => {
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(dish({ category: 'Old Specials' })).element);
    const select = byId('dish-category') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('Old Specials (not in the active list)');
    expect(select.value).toBe('Old Specials');
    await type(byId('dish-name'), 'Renamed Dish');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith('d1', { name: 'Renamed Dish' });
  });

  it('a case difference (snacks vs Snacks) is the same category and is not a change', async () => {
    const snacks = cat(rawCategory({ id: 'sn', name: 'Snacks' }));
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(dish({ category: 'snacks' }), { categoryState: state({ categories: [snacks] }) }).element);
    expect((byId('dish-category') as HTMLSelectElement).value).toBe('Snacks');
    expect((byText('button', 'Save changes') as HTMLButtonElement).disabled).toBe(true); // nothing dirty
    await type(byId('dish-name'), 'x1');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith('d1', { name: 'x1' });
  });

  it('the server rejecting the category shows its sentence with the suggestions and reloads the list', async () => {
    const reload = vi.fn();
    vi.spyOn(apiService, 'updateCatalogItem').mockRejectedValue(new ApiError(400, 'Pick a category from the list.', 'CATEGORY_UNKNOWN', 'category', { suggestions: ['Biryani'] }));
    await mount(open(dish({ category: 'Rolls' }), { categoryState: state({ reload }) }).element);
    await type(byId('dish-category'), 'Biryani');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Pick a category from the list. Did you mean Biryani?');
    expect(reload).toHaveBeenCalled();
  });

  it('inline create: a small form adds a dishes-only category and selects it', async () => {
    const add = vi.fn();
    const created = cat(rawUnused({ id: 'new-cat', name: 'Wraps', forRestaurants: false }));
    const create = vi.spyOn(apiService, 'createCategory').mockResolvedValue(created);
    await mount(open(null, { categoryState: state({ add }) }).element);
    await click(byText('button', 'Create new category'));
    const group = document.querySelector('[role="group"][aria-label="Create a new category"]') as HTMLElement;
    expect(group.textContent).toContain('New category for dishes');
    await type(group.querySelector('input'), 'Wraps');
    await click(byText('button', 'Add category', group));
    await flush();
    expect(create).toHaveBeenCalledWith({ name: 'Wraps', icon: 'restaurant', forRestaurants: false, forDishes: true, showOnHome: false });
    expect(add).toHaveBeenCalledWith(created);
    expect((byId('dish-category') as HTMLInputElement).value).toBe('Wraps');
  });

  it('while the list loads the select says so; if it failed the old free-text field comes back', async () => {
    await mount(open(null, { categoryState: state({ categories: [], loading: true }) }).element);
    expect(byId('dish-category')!.textContent).toContain('Loading categories…');
    await unmount();
    await mount(open(null, { categoryState: state({ error: 'The operations API is unreachable.' }) }).element);
    expect(byId('dish-category')!.tagName).toBe('INPUT');
    expect(document.getElementById('dish-categories')).not.toBeNull();
  });
});

describe('photo', () => {
  const env: ImageEnv = { decode: async () => ({ width: 1800, height: 1200, source: {} }) as Decoded, encode: async () => ({ size: 80_000, type: 'image/webp' }) as unknown as Blob, webpSupported: () => true };
  const choose = async (file: File) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
  };

  it('an uploaded photo fills the address field and is saved as imageUrl', async () => {
    const upload = vi.spyOn(apiService, 'uploadImage').mockResolvedValue({ url: 'https://api.kraveo.site/uploads/dish/2026/p1.webp', width: 1200, height: 800, bytes: 80000 });
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(dish(), { imageEnv: env }).element);
    expect(byText('button', 'Replace photo')).toBeTruthy();
    await choose(new File([new Uint8Array(20)], 'dosa.jpg', { type: 'image/jpeg' }));
    expect(upload).toHaveBeenCalledWith(expect.anything(), 'dish');
    expect((byId('dish-image') as HTMLInputElement).value).toBe('https://api.kraveo.site/uploads/dish/2026/p1.webp');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith('d1', { imageUrl: 'https://api.kraveo.site/uploads/dish/2026/p1.webp' });
  });

  it('while a photo uploads, the action buttons are off', async () => {
    let release: (v: any) => void = () => {};
    vi.spyOn(apiService, 'uploadImage').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await mount(open(null, { imageEnv: env }).element);
    await choose(new File([new Uint8Array(20)], 'dosa.jpg', { type: 'image/jpeg' }));
    expect((byText('button', 'Add dish') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release({ url: 'https://api.kraveo.site/uploads/dish/2026/p2.webp', width: 1, height: 1, bytes: 1 }); });
    await flush();
    expect((byText('button', 'Add dish') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a new dish can remove the photo it picked; a saved dish can only replace it', async () => {
    await mount(open(null).element);
    await type(byId('dish-image'), 'https://x.test/a.jpg');
    expect(byText('button', 'Remove photo')).toBeTruthy();
    await unmount();
    await mount(open(dish()).element);
    expect(byText('button', 'Remove photo')).toBeUndefined();
    expect(byText('button', 'Replace photo')).toBeTruthy();
  });
});

describe('duplicate', () => {
  it('Duplicate is offered on a saved dish and hands it to the page', async () => {
    const onDuplicate = vi.fn();
    const d = dish();
    await mount(open(d, { onDuplicate }).element);
    await click(byText('button', 'Duplicate'));
    expect(onDuplicate).toHaveBeenCalledWith(d);
    await unmount();
    await mount(open(null, { onDuplicate }).element);
    expect(byText('button', 'Duplicate')).toBeUndefined(); // not while adding
  });

  it('Add dish opens prefilled: name + " (copy)", same restaurant, category, price, photo, flags; nothing is saved until Add dish', async () => {
    const original = dish({ name: 'Paneer Roll', category: 'Rolls', description: 'Spicy', isVeg: false, isAvailable: false, vendorPrice: 100, imageUrl: 'https://img.example/roll.jpg' });
    const create = vi.spyOn(apiService, 'createCatalogItem').mockResolvedValue(null);
    await mount(open(null, { prefill: original }).element);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Duplicate dish');
    expect(dialog.textContent).toContain('Copied from Paneer Roll');
    expect((byId('dish-vendor') as HTMLSelectElement).value).toBe('v1');
    expect((byId('dish-name') as HTMLInputElement).value).toBe('Paneer Roll (copy)');
    expect((byId('dish-category') as HTMLSelectElement).value).toBe('Rolls');
    expect((byId('dish-price') as HTMLInputElement).value).toBe('100');
    expect((byId('dish-image') as HTMLInputElement).value).toBe('https://img.example/roll.jpg');
    expect((byId('dish-description') as HTMLTextAreaElement).value).toBe('Spicy');
    expect(create).not.toHaveBeenCalled();
    await click(byText('button', 'Add dish'));
    await flush();
    expect(create).toHaveBeenCalledWith({ vendorId: 'v1', name: 'Paneer Roll (copy)', categoryId: 'rolls-id', description: 'Spicy', imageUrl: 'https://img.example/roll.jpg', isVeg: false, isAvailable: false, vendorPrice: 100 });
  });

  it('the copy’s name stays inside the 80 letter limit', () => {
    expect(copyName('Roll')).toBe('Roll (copy)');
    const long = 'x'.repeat(80);
    expect(copyName(long).length).toBeLessThanOrEqual(80);
    expect(copyName(long).endsWith(' (copy)')).toBe(true);
  });

  it('a copy of a dish with its own commission keeps that rule in the form', async () => {
    const original = dish({ commissionOverride: { type: 'FLAT', value: 7 }, commission: { type: 'FLAT', value: 7, source: 'DISH' } });
    const create = vi.spyOn(apiService, 'createCatalogItem').mockResolvedValue(null);
    await mount(open(null, { prefill: original }).element);
    expect((byId('dish-commission-mode') as HTMLSelectElement).value).toBe('FLAT');
    await click(byText('button', 'Add dish'));
    await flush();
    expect(create.mock.calls[0][0]).toMatchObject({ commissionType: 'FLAT', commissionValue: 7 });
  });
});
