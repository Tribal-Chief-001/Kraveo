// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { CategoriesPanel } from './CategoriesPanel';
import { ApiError, apiService } from '../services/api';
import { parseCategory } from '../lib/categoryParse';
import { byText, click, flush, mount, type, unmount } from '../test/dom';
import { mergeDryRun, rawCategory, rawNorthIndian, rawUnused } from '../test/taxonomyFixtures';

const cat = (raw: Record<string, unknown>) => parseCategory(raw)!;
const BIRYANI = () => cat(rawCategory());
const NORTH = () => cat(rawNorthIndian());
const ROLLS = () => cat(rawUnused());
const HIDDEN = () => cat(rawCategory({ id: 'hid-1', name: 'Old Chai', nameHi: null, icon: 'tea', isActive: false, showOnHome: false, sortOrder: 28, restaurantCount: 0, dishCount: 0, usage: { restaurants: 0, dishes: 0 }, inUse: false }));

const render = (over: Record<string, unknown> = {}) => {
  const props = { query: '', onClearQuery: vi.fn(), onAuthError: vi.fn(), onChanged: vi.fn(), ...over };
  return { props, element: <CategoriesPanel {...(props as any)} /> };
};

const sw = (label: string) => document.querySelector(`button[role="switch"][aria-label="${label}"]`) as HTMLButtonElement;
const rowOf = (name: string) => Array.from(document.querySelectorAll('li[data-category-id]')).find((li) => li.querySelector('p')?.textContent?.startsWith(name)) as HTMLElement;
const names = () => Array.from(document.querySelectorAll('li[data-category-id] p:first-child span:first-child')).map((el) => el.textContent);
const btn = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('CategoriesPanel list', () => {
  it('loads every category including hidden ones and shows name, Hindi name, switches and what uses it', async () => {
    const fetch = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH(), HIDDEN()]);
    await mount(render().element);
    await flush();
    expect(fetch).toHaveBeenCalledWith({ includeInactive: true });
    expect(names()).toEqual(['Biryani', 'North Indian', 'Old Chai']);
    const biryani = rowOf('Biryani');
    expect(biryani.textContent).toContain('बिरयानी');
    expect(biryani.textContent).toContain('1 restaurant');
    expect(biryani.textContent).toContain('1 dish');
    expect(rowOf('North Indian').textContent).toContain('No Hindi name');
    expect(rowOf('Old Chai').textContent).toContain('Hidden');
    expect(sw('Biryani: active').getAttribute('aria-checked')).toBe('true');
    expect(sw('Old Chai: active').getAttribute('aria-checked')).toBe('false');
    expect(sw('Biryani: shown as a chip on the customer home screen').getAttribute('aria-checked')).toBe('true');
    expect(sw('Old Chai: shown as a chip on the customer home screen').getAttribute('aria-checked')).toBe('false');
  });

  it('explains the switches in plain words', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    const host = await mount(render().element);
    await flush();
    const text = host.textContent ?? '';
    expect(text).toContain('What the switches mean');
    expect(text).toContain('Can be picked as a cuisine when adding or editing a restaurant.');
    expect(text).toContain('Can be picked as the category of a dish.');
    expect(text).toContain('quick filter on the customer app’s home screen');
    expect(text).toContain('Off hides it from pickers');
  });

  it('shows a loading state, then an error with Try again that reloads', async () => {
    let call = 0;
    let fail: (e: unknown) => void = () => {};
    vi.spyOn(apiService, 'fetchCategories').mockImplementation(() => {
      call++;
      if (call === 1) return new Promise((_resolve, reject) => { fail = reject; });
      return Promise.resolve([BIRYANI()]);
    });
    const { props, element } = render();
    const host = await mount(element);
    expect(host.querySelector('[aria-label="Loading"]')).not.toBeNull();
    await act(async () => { fail(new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.', 'NETWORK')); });
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('unreachable');
    expect(props.onAuthError).toHaveBeenCalled();
    await click(byText('button', 'Try again', host));
    await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(names()).toEqual(['Biryani']);
  });

  it('an empty list says so and offers to add the first category', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    const host = await mount(render().element);
    await flush();
    expect(host.textContent).toContain('No categories yet');
    expect(byText('button', 'Add category', host)).toBeTruthy();
  });

  it('the header search filters by name or Hindi name and can be cleared', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH(), ROLLS()]);
    const { props } = render({ query: 'north' });
    const host = await mount(<CategoriesPanel {...(props as any)} />);
    await flush();
    expect(names()).toEqual(['North Indian']);
    await unmount();
    const hindi = render({ query: 'बिर' });
    await mount(hindi.element);
    await flush();
    expect(names()).toEqual(['Biryani']);
    await unmount();
    const none = render({ query: 'zzz' });
    const h2 = await mount(none.element);
    await flush();
    expect(h2.textContent).toContain('No categories match');
    await click(byText('button', 'Clear search', h2));
    expect(none.props.onClearQuery).toHaveBeenCalled();
  });
});

describe('switches', () => {
  it('a switch sends one PATCH with just that key and then shows the server row', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), ROLLS()]);
    const update = vi.spyOn(apiService, 'updateCategory').mockResolvedValue({ category: cat(rawUnused({ showOnHome: true })), changed: true, message: 'Category saved.' });
    await mount(render().element);
    await flush();
    expect(sw('Rolls & Wraps: shown as a chip on the customer home screen').getAttribute('aria-checked')).toBe('false');
    await click(sw('Rolls & Wraps: shown as a chip on the customer home screen'));
    await flush();
    expect(update).toHaveBeenCalledWith('3f19f8c2-09bc-414c-962d-183fc2237e9a', { showOnHome: true });
    expect(sw('Rolls & Wraps: shown as a chip on the customer home screen').getAttribute('aria-checked')).toBe('true');
  });

  it('the switch is disabled while its request runs (no double click)', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([ROLLS()]);
    let release: (v: any) => void = () => {};
    const update = vi.spyOn(apiService, 'updateCategory').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await mount(render().element);
    await flush();
    const s = sw('Rolls & Wraps: active');
    await click(s);
    expect(s.disabled).toBe(true);
    await click(s);
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => { release({ category: cat(rawUnused({ isActive: false })), changed: true, message: '' }); });
    await flush();
    expect(sw('Rolls & Wraps: active').disabled).toBe(false);
    expect(sw('Rolls & Wraps: active').getAttribute('aria-checked')).toBe('false');
  });

  it('a refusal (still in use) keeps the old state, shows the server words and reloads the counts', async () => {
    const fetch = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    vi.spyOn(apiService, 'updateCategory').mockRejectedValue(new ApiError(409, '1 dish uses this category, so it cannot stop being a dish category. Merge it into another one first.', 'CATEGORY_IN_USE', 'forDishes', { dishes: 1 }));
    await mount(render().element);
    await flush();
    await click(sw('Biryani: can be a dish category'));
    await flush();
    expect(sw('Biryani: can be a dish category').getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain('1 dish uses this category');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a 403 tells the app (so it can log out)', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    const failure = new ApiError(403, 'Not allowed.');
    vi.spyOn(apiService, 'updateCategory').mockRejectedValue(failure);
    const { props, element } = render();
    await mount(element);
    await flush();
    await click(sw('Biryani: active'));
    await flush();
    expect(props.onAuthError).toHaveBeenCalledWith(failure);
  });
});

describe('order', () => {
  const setup = async () => {
    const fetch = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH(), ROLLS()]);
    const reorder = vi.spyOn(apiService, 'reorderCategories');
    const r = render();
    const host = await mount(r.element);
    await flush();
    return { fetch, reorder, host, ...r };
  };

  it('up / down buttons move a row, show an unsaved bar, and the first up / last down are disabled', async () => {
    await setup();
    expect(btn('Move Biryani up').disabled).toBe(true);
    expect(btn('Move Rolls & Wraps down').disabled).toBe(true);
    await click(btn('Move North Indian up'));
    expect(names()).toEqual(['North Indian', 'Biryani', 'Rolls & Wraps']);
    expect(document.body.textContent).toContain('The order has changed and is not saved yet.');
    expect(document.querySelector('[role="status"]')!.textContent).toContain('North Indian moved to position 1 of 3.');
  });

  it('keeps keyboard focus on the moved row’s button (or its twin at the end)', async () => {
    await setup();
    await click(btn('Move North Indian up'));
    // it is now first: "up" is disabled, so focus goes to "down" of the same row
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Move North Indian down');
    await click(btn('Move North Indian down'));
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Move North Indian down');
  });

  it('Save order sends every id in the new order and then clears the bar', async () => {
    const { reorder } = await setup();
    await click(btn('Move Rolls & Wraps up'));
    await click(btn('Move Rolls & Wraps up'));
    expect(names()).toEqual(['Rolls & Wraps', 'Biryani', 'North Indian']);
    reorder.mockResolvedValue([ROLLS(), BIRYANI(), NORTH()]);
    await click(byText('button', 'Save order'));
    await flush();
    expect(reorder).toHaveBeenCalledWith(['3f19f8c2-09bc-414c-962d-183fc2237e9a', '72077a2d-9b97-48de-9956-8d0167228f34', '02236158-229f-48fc-9fe8-4b1220e74ed7']);
    expect(document.body.textContent).not.toContain('not saved yet');
    expect(names()).toEqual(['Rolls & Wraps', 'Biryani', 'North Indian']);
  });

  it('Discard puts the saved order back without calling the server', async () => {
    const { reorder } = await setup();
    await click(btn('Move North Indian up'));
    await click(byText('button', 'Discard'));
    expect(names()).toEqual(['Biryani', 'North Indian', 'Rolls & Wraps']);
    expect(reorder).not.toHaveBeenCalled();
  });

  it('a failed save keeps the admin’s order and says why', async () => {
    const { reorder, props } = await setup();
    await click(btn('Move North Indian up'));
    reorder.mockRejectedValue(new ApiError(400, 'One of the categories no longer exists.', 'CATEGORY_UNKNOWN', 'ids'));
    await click(byText('button', 'Save order'));
    await flush();
    expect(document.body.textContent).toContain('One of the categories no longer exists.');
    expect(props.onAuthError).toHaveBeenCalled();
    expect(names()[0]).toBe('North Indian');
  });

  it('moving is switched off while a search is active', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH(), ROLLS()]);
    await mount(render({ query: 'i' }).element);
    await flush();
    expect(btn('Move North Indian up').disabled).toBe(true);
    expect(document.body.textContent).toContain('Clear the search to change the order.');
  });

  it('an unsaved order survives a reload of the list', async () => {
    const { fetch } = await setup();
    await click(btn('Move North Indian up'));
    await click(btn('Reload categories'));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(names()).toEqual(['North Indian', 'Biryani', 'Rolls & Wraps']);
  });
});

describe('delete', () => {
  it('is disabled for a category in use, with the reason', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    await mount(render().element);
    await flush();
    const del = btn('Delete Biryani');
    expect(del.disabled).toBe(true);
    expect(del.title).toBe('Used by 1 restaurant and 1 dish. Hide it, or merge it into another category.');
    expect(rowOf('Biryani').textContent).toContain('Cannot delete: used by 1 restaurant and 1 dish.');
    expect(del.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('asks first; cancel does nothing, confirm deletes and removes the row', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), ROLLS()]);
    const del = vi.spyOn(apiService, 'deleteCategory').mockResolvedValue(undefined);
    await mount(render().element);
    await flush();
    await click(btn('Delete Rolls & Wraps'));
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Delete “Rolls & Wraps”?');
    await click(byText('button', 'Cancel', document.querySelector('[role="alertdialog"]')!));
    expect(del).not.toHaveBeenCalled();
    await click(btn('Delete Rolls & Wraps'));
    await click(byText('button', 'Delete category'));
    await flush();
    expect(del).toHaveBeenCalledWith('3f19f8c2-09bc-414c-962d-183fc2237e9a');
    expect(names()).toEqual(['Biryani']);
  });

  it('a delete the server refuses shows its words and reloads', async () => {
    const fetch = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([ROLLS()]);
    vi.spyOn(apiService, 'deleteCategory').mockRejectedValue(new ApiError(409, 'This category is used by 1 restaurant and 1 dish. Hide it, or merge it into another category.', 'CATEGORY_IN_USE', undefined, { restaurants: 1, dishes: 1 }));
    await mount(render().element);
    await flush();
    await click(btn('Delete Rolls & Wraps'));
    await click(byText('button', 'Delete category'));
    await flush();
    expect(document.body.textContent).toContain('This category is used by 1 restaurant and 1 dish.');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('merge', () => {
  it('choosing a target shows a dry run first; Merge asks to confirm; only then it merges and reloads', async () => {
    const fetch = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH(), HIDDEN()]);
    const merge = vi.spyOn(apiService, 'mergeCategory').mockImplementation(async (_id, _into, dryRun) => (dryRun
      ? { dryRun: true, from: { id: NORTH().id, name: 'North Indian' }, into: { id: BIRYANI().id, name: 'Biryani' }, dishes: 5, restaurants: 2, message: '', category: null }
      : { dryRun: false, from: { id: NORTH().id, name: 'North Indian' }, into: { id: BIRYANI().id, name: 'Biryani' }, dishes: 5, restaurants: 2, message: 'Merged. Moved 5 dishes and 2 restaurants.', category: BIRYANI() }));
    const { props, element } = render();
    await mount(element);
    await flush();
    await click(btn('Merge North Indian into another category'));
    const select = document.getElementById('merge-into') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toContain('Biryani');
    expect(options).toContain('Old Chai (hidden)');
    expect(options).not.toContain('North Indian');
    expect((byText('button', 'Merge…') as HTMLButtonElement).disabled).toBe(true);
    await type(select, BIRYANI().id);
    await flush();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith(NORTH().id, BIRYANI().id, true);
    expect(document.querySelector('[data-testid="merge-preview"]')!.textContent).toContain('Moves 2 restaurants and 5 dishes.');
    expect(document.querySelector('[data-testid="merge-preview"]')!.textContent).toContain('Nothing has been changed yet.');
    await click(byText('button', 'Merge…'));
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Merge “North Indian” into “Biryani”?');
    expect(merge).toHaveBeenCalledTimes(1); // still only the dry run
    await click(byText('button', 'Merge and delete'));
    await flush();
    expect(merge).toHaveBeenLastCalledWith(NORTH().id, BIRYANI().id, false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(props.onChanged).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Merged. Moved 5 dishes and 2 restaurants.');
    expect(document.getElementById('merge-into')).toBeNull();
  });

  it('declining the confirm merges nothing', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH()]);
    const merge = vi.spyOn(apiService, 'mergeCategory').mockResolvedValue({ dryRun: true, from: null, into: null, dishes: 0, restaurants: 1, message: '', category: null });
    await mount(render().element);
    await flush();
    await click(btn('Merge North Indian into another category'));
    await type(document.getElementById('merge-into'), BIRYANI().id);
    await flush();
    await click(byText('button', 'Merge…'));
    await click(byText('button', 'Cancel', document.querySelector('[role="alertdialog"]')!));
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('targets that cannot hold the moved items are disabled with the reason', async () => {
    const dishOnly = cat(rawCategory({ id: 'd-only', name: 'Dish Only', forRestaurants: false, usage: { restaurants: 0, dishes: 0 } }));
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), dishOnly]);
    await mount(render().element);
    await flush();
    await click(btn('Merge Biryani into another category'));
    const option = Array.from((document.getElementById('merge-into') as HTMLSelectElement).options).find((o) => o.textContent?.startsWith('Dish Only'))!;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toBe('Dish Only (not a restaurant category)');
  });

  it('a server refusal of the dry run is shown and Merge stays off', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH()]);
    vi.spyOn(apiService, 'mergeCategory').mockRejectedValue(new ApiError(404, 'Category not found.', 'NOT_FOUND'));
    await mount(render().element);
    await flush();
    await click(btn('Merge North Indian into another category'));
    await type(document.getElementById('merge-into'), BIRYANI().id);
    await flush();
    expect(document.querySelector('[data-testid="merge-preview"] [role="alert"]')!.textContent).toBe('Category not found.');
    expect((byText('button', 'Merge…') as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses the real dry run fixture shape end to end', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH()]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(mergeDryRun), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await mount(render().element);
    await flush();
    await click(btn('Merge North Indian into another category'));
    await type(document.getElementById('merge-into'), BIRYANI().id);
    await flush();
    expect(document.querySelector('[data-testid="merge-preview"]')!.textContent).toContain('Moves 1 restaurant.');
    vi.unstubAllGlobals();
  });
});

describe('create and edit', () => {
  const openCreate = async () => {
    await click(byText('button', 'Add category'));
    return document.querySelector('[role="dialog"]') as HTMLElement;
  };
  const nameInput = (dialog: HTMLElement) => dialog.querySelector('input[maxlength="40"]:not([lang])') as HTMLInputElement;

  it('Add category: validates the name, sends the whole form, and the new row appears', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    const create = vi.spyOn(apiService, 'createCategory').mockResolvedValue(ROLLS());
    await mount(render().element);
    await flush();
    const dialog = await openCreate();
    expect(dialog.textContent).toContain('Add a category');
    expect(document.activeElement).toBe(nameInput(dialog)); // focus lands in the first field
    await click(byText('button', 'Add category', dialog));
    expect(dialog.textContent).toContain('Enter a name of at least 2 letters.');
    expect(create).not.toHaveBeenCalled();
    await type(nameInput(dialog), 'Rolls & Wraps');
    await type(dialog.querySelector('input[lang="hi"]'), 'रोल');
    await click(dialog.querySelector('input[type="radio"][value="roll"]'));
    await click(byText('button', 'Add category', dialog));
    await flush();
    expect(create).toHaveBeenCalledWith({ name: 'Rolls & Wraps', nameHi: 'रोल', icon: 'roll', forRestaurants: true, forDishes: true, showOnHome: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(names()).toEqual(['Biryani', 'Rolls & Wraps']);
  });

  it('the icon picker is a native radio group: all 25 icons, one selected, reachable by keyboard', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    await mount(render().element);
    await flush();
    const dialog = await openCreate();
    const radios = Array.from(dialog.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(radios).toHaveLength(25);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(['restaurant']);
    expect(dialog.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Icon');
    expect(radios.every((r) => r.name === radios[0].name)).toBe(true);
  });

  it('a name the server already has shows its sentence on the name field', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    vi.spyOn(apiService, 'createCategory').mockRejectedValue(new ApiError(409, 'There is already a category called "North Indian".', 'CATEGORY_EXISTS', 'name', { existing: rawNorthIndian() }));
    await mount(render().element);
    await flush();
    const dialog = await openCreate();
    await type(nameInput(dialog), 'north indian');
    await click(byText('button', 'Add category', dialog));
    await flush();
    expect(nameInput(dialog).getAttribute('aria-invalid')).toBe('true');
    expect(dialog.textContent).toContain('There is already a category called "North Indian".');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull(); // stays open so the name can be fixed
  });

  it('refuses a bad name before any request (characters the server rejects)', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    const create = vi.spyOn(apiService, 'createCategory');
    await mount(render().element);
    await flush();
    const dialog = await openCreate();
    await type(nameInput(dialog), 'Chai <b>');
    await click(byText('button', 'Add category', dialog));
    expect(dialog.textContent).toContain('Use only letters, digits, spaces');
    expect(create).not.toHaveBeenCalled();
  });

  it('Edit starts from the saved values and sends only what changed; the rename note names what is affected', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    const update = vi.spyOn(apiService, 'updateCategory').mockResolvedValue({ category: cat(rawCategory({ name: 'Biryani & Pulao' })), changed: true, message: 'Category saved.' });
    const { props, element } = render();
    await mount(element);
    await flush();
    await click(btn('Edit Biryani'));
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(nameInput(dialog).value).toBe('Biryani');
    expect((dialog.querySelector('input[lang="hi"]') as HTMLInputElement).value).toBe('बिरयानी');
    expect((dialog.querySelector('input[type="radio"][value="biryani"]') as HTMLInputElement).checked).toBe(true);
    await click(byText('button', 'Save changes', dialog));
    expect(dialog.textContent).toContain('Nothing was changed.');
    expect(update).not.toHaveBeenCalled();
    await type(nameInput(dialog), 'Biryani & Pulao');
    expect(dialog.textContent).toContain('Renaming also updates the name shown on 1 restaurant and 1 dish.');
    await click(byText('button', 'Save changes', dialog));
    await flush();
    expect(update).toHaveBeenCalledWith('72077a2d-9b97-48de-9956-8d0167228f34', { name: 'Biryani & Pulao' });
    expect(names()).toEqual(['Biryani & Pulao']);
    expect(props.onChanged).toHaveBeenCalled(); // vendor and dish names elsewhere were rewritten
  });

  it('Edit: clearing the Hindi name sends null; the Active switch is only in the edit form', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    const update = vi.spyOn(apiService, 'updateCategory').mockResolvedValue({ category: cat(rawCategory({ nameHi: null, isActive: false })), changed: true, message: 'Category saved.' });
    await mount(render().element);
    await flush();
    await click(btn('Edit Biryani'));
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await type(dialog.querySelector('input[lang="hi"]'), '');
    await click(dialog.querySelector('button[role="switch"][aria-label="Active"]'));
    await click(byText('button', 'Save changes', dialog));
    await flush();
    expect(update).toHaveBeenCalledWith('72077a2d-9b97-48de-9956-8d0167228f34', { nameHi: null, isActive: false });
    await unmount();
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    await mount(render().element);
    await flush();
    const created = await openCreate();
    expect(created.querySelector('button[role="switch"][aria-label="Active"]')).toBeNull();
  });

  it('Escape closes the drawer and focus returns to the button that opened it', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI()]);
    await mount(render().element);
    await flush();
    const opener = btn('Edit Biryani');
    opener.focus();
    await click(opener);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('small screens', () => {
  it('renders and works at 360 px wide (no crash, every control still reachable)', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([BIRYANI(), NORTH(), ROLLS(), HIDDEN()]);
    const host = await mount(render().element);
    await flush();
    expect(host.querySelectorAll('li[data-category-id]')).toHaveLength(4);
    expect(btn('Edit Biryani')).toBeTruthy();
    expect(sw('Old Chai: active')).toBeTruthy();
    // nothing forces a width: no fixed-width table, the list is a normal block that wraps
    expect(host.querySelector('table')).toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
  });
});
