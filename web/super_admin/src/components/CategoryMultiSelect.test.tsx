// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { CategoryMultiSelect } from './CategoryMultiSelect';
import { ApiError, apiService } from '../services/api';
import { Category, parseCategory } from '../lib/categoryParse';
import { byText, click, flush, mount, type, unmount } from '../test/dom';
import { rawCategory, rawNorthIndian, rawUnused } from '../test/taxonomyFixtures';

const cat = (raw: Record<string, unknown>) => parseCategory(raw)!;
const CHOICES = [cat(rawCategory()), cat(rawNorthIndian()), cat(rawUnused())];

const Harness: React.FC<{ start?: string[]; max?: number; known?: any[]; onCreated?: (c: Category) => void; choices?: Category[] }> = ({ start = [], max, known, onCreated = () => {}, choices = CHOICES }) => {
  const [value, setValue] = React.useState(start);
  return <><CategoryMultiSelect id="cm" label="Categories" value={value} onChange={setValue} choices={choices} known={known} max={max} onCreated={onCreated} /><output data-testid="value">{value.join(',')}</output></>;
};
const value = () => document.querySelector('[data-testid="value"]')!.textContent;
const chips = () => Array.from(document.querySelectorAll('li[data-chip]')).map((li) => li.querySelector('span[title]')!.textContent);
const addSelect = () => document.getElementById('cm-add') as HTMLSelectElement;

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('CategoryMultiSelect', () => {
  it('adds from the list in order, the first is marked Main, and the picked one leaves the list', async () => {
    await mount(<Harness />);
    expect(document.body.textContent).toContain('0 of 6 chosen');
    await type(addSelect(), cat(rawNorthIndian()).id);
    await type(addSelect(), cat(rawCategory()).id);
    expect(chips()).toEqual(['North Indian', 'Biryani']);
    expect(document.querySelector('li[data-chip]')!.textContent).toContain('Main');
    expect(Array.from(addSelect().options).map((o) => o.textContent)).not.toContain('Biryani · बिरयानी');
    expect(document.body.textContent).toContain('2 of 6 chosen');
  });

  it('shows the Hindi name next to the English one in the list', async () => {
    await mount(<Harness />);
    expect(Array.from(addSelect().options).map((o) => o.textContent)).toContain('Biryani · बिरयानी');
  });

  it('remove, move earlier and move later work and keep a sensible disabled state at the ends', async () => {
    await mount(<Harness start={[CHOICES[0].id, CHOICES[1].id, CHOICES[2].id]} />);
    const b = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
    expect(b('Move Biryani earlier').disabled).toBe(true);
    expect(b('Move Rolls & Wraps later').disabled).toBe(true);
    await click(b('Move Rolls & Wraps earlier'));
    expect(chips()).toEqual(['Biryani', 'Rolls & Wraps', 'North Indian']);
    await click(b('Move Biryani later'));
    expect(chips()).toEqual(['Rolls & Wraps', 'Biryani', 'North Indian']);
    await click(b('Remove Biryani'));
    expect(chips()).toEqual(['Rolls & Wraps', 'North Indian']);
    expect(document.querySelector('li[data-chip]')!.textContent).toContain('Main');
  });

  it('stops at the maximum: the list and the create button switch off with a clear label', async () => {
    const six = Array.from({ length: 7 }, (_, i) => cat(rawCategory({ id: `c${i}`, name: `Cat ${i}` })));
    await mount(<Harness choices={six} start={six.slice(0, 6).map((c) => c.id)} />);
    expect(addSelect().disabled).toBe(true);
    expect(addSelect().options[0].textContent).toBe('Limit of 6 reached');
    expect((byText('button', 'Create new category') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('6 of 6 chosen');
  });

  it('a hidden category the restaurant already has stays, labelled hidden, and can be removed', async () => {
    await mount(<Harness start={['old-1']} known={[{ id: 'old-1', name: 'Old Chai', icon: 'tea' }]} />);
    expect(chips()).toEqual(['Old Chai']);
    expect(document.querySelector('li[data-chip]')!.textContent).toContain('(hidden)');
    await click(document.querySelector('button[aria-label="Remove Old Chai"]'));
    expect(value()).toBe('');
  });

  it('an id with no known name shows a placeholder instead of crashing', async () => {
    await mount(<Harness start={['mystery']} />);
    expect(chips()).toEqual(['Unknown category']);
  });

  it('Create new category opens a small form; saving adds the new category as a chip and tells the parent', async () => {
    const created = cat(rawUnused({ id: 'new-1', name: 'Korean' }));
    const create = vi.spyOn(apiService, 'createCategory').mockResolvedValue(created);
    const onCreated = vi.fn();
    await mount(<Harness onCreated={onCreated} />);
    await click(byText('button', 'Create new category'));
    const group = document.querySelector('[role="group"][aria-label="Create a new category"]') as HTMLElement;
    expect(group.textContent).toContain('New category for restaurants');
    await type(group.querySelector('input'), 'Korean');
    await click(byText('button', 'Add category', group));
    await flush();
    // a restaurant picker creates a restaurant-only category that is not on the home screen
    expect(create).toHaveBeenCalledWith({ name: 'Korean', icon: 'restaurant', forRestaurants: true, forDishes: false, showOnHome: false });
    expect(onCreated).toHaveBeenCalledWith(created);
    expect(value()).toBe('new-1');
    expect(document.querySelector('[role="group"][aria-label="Create a new category"]')).toBeNull();
    expect(document.body.textContent).toContain('“Korean” was created and added.');
  });

  it('a name that already exists offers to use the existing category', async () => {
    const existing = rawNorthIndian();
    vi.spyOn(apiService, 'createCategory').mockRejectedValue(new ApiError(409, 'There is already a category called "North Indian".', 'CATEGORY_EXISTS', 'name', { existing }));
    await mount(<Harness choices={[]} />);
    await click(byText('button', 'Create new category'));
    const group = document.querySelector('[role="group"]') as HTMLElement;
    await type(group.querySelector('input'), 'north indian');
    await click(byText('button', 'Add category', group));
    await flush();
    expect(group.textContent).toContain('There is already a category called "North Indian".');
    await click(byText('button', /Use the existing/, group));
    expect(value()).toBe(cat(existing).id);
  });

  it('Enter in the new-name field saves the small form and does not submit a form around it', async () => {
    const create = vi.spyOn(apiService, 'createCategory').mockResolvedValue(cat(rawUnused({ id: 'n2', name: 'Thai' })));
    const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
    await mount(<form onSubmit={submit}><Harness /></form>);
    await click(byText('button', 'Create new category'));
    const input = document.querySelector('[role="group"] input') as HTMLInputElement;
    await type(input, 'Thai');
    const { act } = await import('react');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('disabled disables every control', async () => {
    await mount(<CategoryMultiSelect id="cm" label="Categories" value={[CHOICES[0].id]} onChange={() => {}} choices={CHOICES} disabled onCreated={() => {}} />);
    expect(addSelect().disabled).toBe(true);
    expect((document.querySelector('button[aria-label="Remove Biryani"]') as HTMLButtonElement).disabled).toBe(true);
    expect((byText('button', 'Create new category') as HTMLButtonElement).disabled).toBe(true);
  });
});
