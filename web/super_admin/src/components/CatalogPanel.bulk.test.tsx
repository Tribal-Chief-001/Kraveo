// @vitest-environment jsdom
// Docs/23 in the catalog list: ticking dishes, the bulk bar and its result summary, Duplicate, and the Import menu button.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { CatalogPanel } from './CatalogPanel';
import { ApiError, apiService } from '../services/api';
import { CatalogDish, CatalogPage } from '../lib/catalogParse';
import { parseCategory } from '../lib/categoryParse';
import { parseBulkResult } from '../lib/catalogBulkParse';
import { dish as fixtureDish, preview } from '../test/fixtures';
import { byText, click, flush, mount, type, unmount } from '../test/dom';
import { bulkMixed, rawCategory, rawUnused } from '../test/taxonomyFixtures';

const dish = (id: string, over: Record<string, unknown> = {}): CatalogDish => fixtureDish({ id, name: `Dish ${id}`, price: 112.5, effectiveCommission: 12.5, ...over });
const page = (items: CatalogDish[], over: Partial<CatalogPage> = {}): CatalogPage => ({ items, page: 1, pageSize: 25, total: items.length, totalPages: 1, hasMore: false, ...over });
const vendors = [{ id: 'v1', name: 'Sharma Dhaba' }, { id: 'v2', name: 'Chai Point' }] as any[];
const cats = [rawCategory(), rawUnused({ id: 'rolls-id', name: 'Rolls', forRestaurants: false })].map((r) => parseCategory(r)!);

const render = (over: Record<string, unknown> = {}) => {
  const props = { vendors, query: '', onClearQuery: vi.fn(), onAuthError: vi.fn(), pendingCounts: { pending: 0, changePending: 0, total: 0 }, onPendingChanged: vi.fn(), ...over };
  return { props, element: <CatalogPanel {...(props as any)} /> };
};
const box = (name: string) => document.querySelector(`input[type="checkbox"][aria-label="Select ${name}"]`) as HTMLInputElement;
const boxes = (name: string) => Array.from(document.querySelectorAll(`input[type="checkbox"][aria-label="Select ${name}"]`)) as HTMLInputElement[];
const pageBox = () => Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.includes('Select all dishes on this page'))!.querySelector('input') as HTMLInputElement;
const bar = () => document.querySelector('section[aria-label="Actions for the selected dishes"]') as HTMLElement | null;

const setup = async (items = [dish('a'), dish('b'), dish('c')]) => {
  const fetchCatalog = vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page(items));
  const fetchCategories = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(cats);
  const r = render();
  const host = await mount(r.element);
  await flush();
  return { fetchCatalog, fetchCategories, host, ...r };
};

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('selecting dishes', () => {
  it('every dish has a checkbox; ticking shows the bulk bar with the count; categories load only then', async () => {
    const { fetchCategories } = await setup();
    expect(boxes('Dish a').length).toBeGreaterThan(0);
    expect(bar()).toBeNull();
    expect(fetchCategories).not.toHaveBeenCalled();
    await click(boxes('Dish a')[0]);
    await flush();
    expect(bar()!.textContent).toContain('1 dish selected');
    expect(fetchCategories).toHaveBeenCalledTimes(1);
    await click(boxes('Dish b')[0]);
    expect(bar()!.textContent).toContain('2 dishes selected');
  });

  it('Select all on this page ticks every dish (with a half-ticked state), Clear selection empties it', async () => {
    await setup();
    await click(boxes('Dish a')[0]);
    expect(pageBox().indeterminate).toBe(true);
    await click(pageBox());
    expect(bar()!.textContent).toContain('3 dishes selected');
    expect(pageBox().checked).toBe(true);
    await click(byText('button', 'Clear selection', bar()!));
    expect(bar()).toBeNull();
    expect(pageBox().checked).toBe(false);
  });

  it('ticking a box does not open the dish', async () => {
    await setup();
    await click(boxes('Dish a')[0]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a different filter starts with nothing ticked', async () => {
    await setup();
    await click(boxes('Dish a')[0]);
    expect(bar()).not.toBeNull();
    await click(byText('button', 'Live'));
    await flush();
    expect(bar()).toBeNull();
  });
});

describe('bulk actions', () => {
  it('Mark sold out sends the ticked ids with the action, then reloads the list and the badge', async () => {
    const { fetchCatalog, props } = await setup();
    const bulk = vi.spyOn(apiService, 'bulkCatalog').mockResolvedValue({ results: [{ id: 'a', ok: true, changed: true, code: null, message: null }, { id: 'b', ok: true, changed: true, code: null, message: null }], ok: 2, failed: 0, message: '2 done.' });
    await click(boxes('Dish a')[0]);
    await click(boxes('Dish b')[0]);
    await click(byText('button', 'Mark sold out', bar()!));
    await flush();
    expect(bulk).toHaveBeenCalledWith(['a', 'b'], 'UNAVAILABLE', undefined);
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    expect(props.onPendingChanged).toHaveBeenCalled();
    expect(bar()).toBeNull(); // all done: nothing stays ticked
    expect(document.body.textContent).toContain('Mark sold out: 2 done.');
  });

  it('a mixed result lists every failed dish with the server’s reason, and only those stay ticked', async () => {
    const result = parseBulkResult({ ...bulkMixed, data: { ...bulkMixed.data, results: [
      { id: 'a', ok: true, changed: true },
      { id: 'b', ok: false, changed: false, code: 'ITEM_DELETED', message: 'This dish is deleted. Restore it first.' },
      { id: 'c', ok: false, changed: false, code: 'NOT_FOUND', message: 'Menu item not found.' },
    ], ok: 1, failed: 2 }, message: '1 done, 2 could not be changed.' })!;
    vi.spyOn(apiService, 'bulkCatalog').mockResolvedValue(result);
    await setup();
    await click(pageBox());
    await click(byText('button', 'Mark available', bar()!));
    await flush();
    const panel = document.querySelector('section[aria-label="Result of the last bulk action"]')!;
    expect(panel.textContent).toContain('Mark available: 1 done, 2 could not be changed.');
    expect(panel.textContent).toContain('Dish b: This dish is deleted. Restore it first.');
    expect(panel.textContent).toContain('Dish c: Menu item not found.');
    expect(panel.textContent).not.toContain('Dish a:');
    expect(bar()!.textContent).toContain('2 dishes selected');
    expect(box('Dish a')).toBeTruthy();
    expect(boxes('Dish a')[0].checked).toBe(false);
    expect(boxes('Dish b')[0].checked).toBe(true);
    await click(panel.querySelector('button[aria-label="Dismiss this result"]'));
    expect(document.querySelector('section[aria-label="Result of the last bulk action"]')).toBeNull();
  });

  it('Delete asks first; No changes nothing, Yes sends DELETE', async () => {
    await setup();
    const bulk = vi.spyOn(apiService, 'bulkCatalog').mockResolvedValue({ results: [{ id: 'a', ok: true, changed: true, code: null, message: null }], ok: 1, failed: 0, message: '' });
    await click(boxes('Dish a')[0]);
    await click(byText('button', 'Delete', bar()!));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Delete 1 dish?');
    expect(dialog.textContent).toContain('you can restore them later');
    await click(byText('button', 'Cancel', dialog as HTMLElement));
    expect(bulk).not.toHaveBeenCalled();
    expect(bar()).not.toBeNull();
    await click(byText('button', 'Delete', bar()!));
    await click(byText('button', 'Delete', document.querySelector('[role="alertdialog"]') as HTMLElement));
    await flush();
    expect(bulk).toHaveBeenCalledWith(['a'], 'DELETE', undefined);
  });

  it('Approve asks first and sends APPROVE; Restore needs no question', async () => {
    await setup();
    const bulk = vi.spyOn(apiService, 'bulkCatalog').mockResolvedValue({ results: [], ok: 0, failed: 0, message: '' });
    await click(boxes('Dish a')[0]);
    await click(byText('button', 'Approve', bar()!));
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Approve 1 dish?');
    await click(byText('button', 'Approve', document.querySelector('[role="alertdialog"]') as HTMLElement));
    await flush();
    expect(bulk).toHaveBeenLastCalledWith(['a'], 'APPROVE', undefined);
    await click(boxes('Dish a')[0]);
    await click(byText('button', 'Restore', bar()!));
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(bulk).toHaveBeenLastCalledWith(['a'], 'RESTORE', undefined);
  });

  it('Change category: pick an active dish category, then apply it to the ticked dishes by id', async () => {
    await setup();
    const bulk = vi.spyOn(apiService, 'bulkCatalog').mockResolvedValue({ results: [], ok: 0, failed: 0, message: '' });
    await click(boxes('Dish a')[0]);
    await flush();
    const select = document.getElementById('bulk-category') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Change category to…', 'Biryani', 'Rolls']);
    expect((byText('button', 'Change category', bar()!) as HTMLButtonElement).disabled).toBe(true); // nothing chosen yet
    await type(select, 'rolls-id');
    await click(byText('button', 'Change category', bar()!));
    await flush();
    expect(bulk).toHaveBeenCalledWith(['a'], 'SET_CATEGORY', { categoryId: 'rolls-id' });
  });

  it('when the categories cannot be loaded the category change is switched off, the other actions still work', async () => {
    vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page([dish('a')]));
    vi.spyOn(apiService, 'fetchCategories').mockRejectedValue(new ApiError(0, 'unreachable', 'NETWORK'));
    await mount(render().element);
    await flush();
    await click(boxes('Dish a')[0]);
    await flush();
    expect((document.getElementById('bulk-category') as HTMLSelectElement).disabled).toBe(true);
    expect(document.getElementById('bulk-category')!.textContent).toContain('Categories could not be loaded');
    expect((byText('button', 'Mark sold out', bar()!) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a request-level refusal says nothing was changed, keeps the ticks and offers the suggestion', async () => {
    const { fetchCategories } = await setup();
    vi.spyOn(apiService, 'bulkCatalog').mockRejectedValue(new ApiError(400, 'Pick a category from the list.', 'CATEGORY_UNKNOWN', 'categoryId', { suggestions: ['Biryani'] }));
    await click(boxes('Dish a')[0]);
    await flush();
    await type(document.getElementById('bulk-category'), 'rolls-id');
    await click(byText('button', 'Change category', bar()!));
    await flush();
    expect(bar()!.querySelector('[role="alert"]')!.textContent).toBe('Pick a category from the list. Did you mean Biryani? Nothing was changed.');
    expect(bar()!.textContent).toContain('1 dish selected');
    expect(fetchCategories).toHaveBeenCalledTimes(2); // the list was refreshed
  });

  it('a 403 is passed up so the app can log out; the buttons are locked while the request runs', async () => {
    const { props } = await setup();
    const failure = new ApiError(403, 'Not allowed.');
    let fail: (e: unknown) => void = () => {};
    const bulk = vi.spyOn(apiService, 'bulkCatalog').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await click(boxes('Dish a')[0]);
    await click(byText('button', 'Mark sold out', bar()!));
    expect((byText('button', 'Mark available', bar()!) as HTMLButtonElement).disabled).toBe(true);
    await click(byText('button', 'Mark sold out', bar()!));
    expect(bulk).toHaveBeenCalledTimes(1);
    await act(async () => { fail(failure); });
    await flush();
    expect(props.onAuthError).toHaveBeenCalledWith(failure);
    expect((byText('button', 'Mark available', bar()!) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the real mixed answer from the server is shown with each failure’s message', async () => {
    const real = parseBulkResult(bulkMixed)!;
    const items = real.results.map((r, i) => dish(r.id, { name: ['Chicken Biryani', 'Veg Biryani', 'Old Roll', 'Ghost Dish'][i] }));
    vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page(items));
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(cats);
    vi.spyOn(apiService, 'bulkCatalog').mockResolvedValue(real);
    await mount(render().element);
    await flush();
    await click(pageBox());
    await click(byText('button', 'Mark sold out', bar()!));
    await flush();
    const text = document.querySelector('section[aria-label="Result of the last bulk action"]')!.textContent!;
    expect(text).toContain('2 done, 2 could not be changed.');
    expect(text).toContain('Old Roll: This dish is deleted. Restore it first.');
    expect(text).toContain('Ghost Dish: Menu item not found.');
  });
});

describe('duplicate and import entry points', () => {
  it('Duplicate on an opened dish switches to Add dish prefilled with the copy', async () => {
    vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page([dish('a', { name: 'Paneer Roll', category: 'Rolls', vendorPrice: 100 })]));
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(cats);
    vi.spyOn(apiService, 'previewCatalogPrice').mockImplementation(async (input) => preview(input.vendorPrice));
    const create = vi.spyOn(apiService, 'createCatalogItem').mockResolvedValue(null);
    const { props } = render();
    await mount(<CatalogPanel {...(props as any)} />);
    await flush();
    await click(document.querySelector('button[aria-label="Open Paneer Roll"]'));
    await flush();
    await click(byText('button', 'Duplicate', document.querySelector('[role="dialog"]') as HTMLElement));
    await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Duplicate dish');
    expect((document.getElementById('dish-name') as HTMLInputElement).value).toBe('Paneer Roll (copy)');
    expect((document.getElementById('dish-image') as HTMLInputElement).value).toBe('https://img.example/roll.jpg');
    await click(byText('button', 'Add dish', dialog as HTMLElement));
    await flush();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ vendorId: 'v1', name: 'Paneer Roll (copy)', categoryId: 'rolls-id', imageUrl: 'https://img.example/roll.jpg', vendorPrice: 100 }));
    expect(props.onPendingChanged).toHaveBeenCalled();
  });

  it('Import menu opens the wizard with the restaurant filter already chosen', async () => {
    vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page([dish('a')]));
    const { props } = render();
    const host = await mount(<CatalogPanel {...(props as any)} />);
    await flush();
    const select = host.querySelector('#catalog-vendor-filter') as HTMLSelectElement;
    await type(select, 'v2');
    await flush();
    await click(byText('button', 'Import menu', host));
    expect((document.getElementById('import-vendor') as HTMLSelectElement).value).toBe('v2');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Chai Point');
  });

  it('Import menu and Add dish are off when no restaurants are loaded', async () => {
    vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page([]));
    const { props } = render({ vendors: [] });
    const host = await mount(<CatalogPanel {...(props as any)} />);
    await flush();
    expect((byText('button', 'Import menu', host) as HTMLButtonElement).disabled).toBe(true);
  });
});
