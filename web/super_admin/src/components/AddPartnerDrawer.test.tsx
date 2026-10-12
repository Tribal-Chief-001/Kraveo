// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { AddPartnerDrawer } from './AddPartnerDrawer';
import { ApiError, apiService } from '../services/api';
import { parseCategory } from '../lib/categoryParse';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';
import { rawCategory, rawNorthIndian, rawUnused } from '../test/taxonomyFixtures';

const NORTH_ID = '02236158-229f-48fc-9fe8-4b1220e74ed7';
const list = () => [rawCategory(), rawNorthIndian(), rawUnused({ forRestaurants: false })].map((r) => parseCategory(r)!);

const fillOwner = async () => {
  await type(byId('ap-restaurant'), 'Chai Point');
  await type(byId('ap-address'), 'Near gate 4');
  await type(byId('ap-name'), 'Ravi Kumar');
  await type(byId('ap-phone'), '9876543210');
};
const submit = async () => { await click(byText('button', 'Add restaurant', document.querySelector('[role="dialog"]') as HTMLElement)); await flush(); };

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('AddPartnerDrawer: categories', () => {
  it('offers only restaurant categories as a multi-select and sends cuisineIds in order (no free-text category)', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(list());
    const create = vi.spyOn(apiService, 'createPartner').mockResolvedValue({ profileId: 'p1' });
    const onCreated = vi.fn();
    await mount(<AddPartnerDrawer open kind="VENDOR" onClose={vi.fn()} onCreated={onCreated} />);
    await flush();
    const options = Array.from((byId('ap-cuisines-add') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options.some((o) => o?.startsWith('Biryani'))).toBe(true);
    expect(options.some((o) => o?.startsWith('Rolls'))).toBe(false); // dish-only category is not offered
    expect(byId('ap-category')).toBeNull();
    await fillOwner();
    await type(byId('ap-cuisines-add'), NORTH_ID);
    await type(byId('ap-cuisines-add'), '72077a2d-9b97-48de-9956-8d0167228f34');
    await submit();
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0] as any;
    expect(body.cuisineIds).toEqual([NORTH_ID, '72077a2d-9b97-48de-9956-8d0167228f34']);
    expect('category' in body).toBe(false);
    expect(body).toMatchObject({ role: 'VENDOR', restaurantName: 'Chai Point', address: 'Near gate 4', phone: '9876543210' });
    expect(onCreated).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Chai Point can log in now.');
  });

  it('no category chosen keeps the old default text, as before', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(list());
    const create = vi.spyOn(apiService, 'createPartner').mockResolvedValue({ profileId: 'p1' });
    await mount(<AddPartnerDrawer open kind="VENDOR" onClose={vi.fn()} onCreated={vi.fn()} />);
    await flush();
    await fillOwner();
    await submit();
    const body = create.mock.calls[0][0] as any;
    expect(body.category).toBe('Campus kitchen');
    expect('cuisineIds' in body).toBe(false);
  });

  it('quick create inside the drawer adds the new category and sends its id', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(list());
    vi.spyOn(apiService, 'createCategory').mockResolvedValue(parseCategory(rawUnused({ id: 'korean-id', name: 'Korean' }))!);
    const create = vi.spyOn(apiService, 'createPartner').mockResolvedValue({ profileId: 'p1' });
    await mount(<AddPartnerDrawer open kind="VENDOR" onClose={vi.fn()} onCreated={vi.fn()} />);
    await flush();
    await fillOwner();
    await click(byText('button', 'Create new category'));
    const group = document.querySelector('[role="group"][aria-label="Create a new category"]') as HTMLElement;
    await type(group.querySelector('input'), 'Korean');
    await click(byText('button', 'Add category', group));
    await flush();
    expect(document.querySelector('li[data-chip]')!.textContent).toContain('Korean');
    await submit();
    expect((create.mock.calls[0][0] as any).cuisineIds).toEqual(['korean-id']);
  });

  it('pressing Enter in the quick-create name does not submit the add-restaurant form', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(list());
    const create = vi.spyOn(apiService, 'createPartner').mockResolvedValue({ profileId: 'p1' });
    const createCategory = vi.spyOn(apiService, 'createCategory').mockResolvedValue(parseCategory(rawUnused({ id: 'k', name: 'Thai' }))!);
    await mount(<AddPartnerDrawer open kind="VENDOR" onClose={vi.fn()} onCreated={vi.fn()} />);
    await flush();
    await fillOwner();
    await click(byText('button', 'Create new category'));
    const input = document.querySelector('[role="group"] input') as HTMLInputElement;
    await type(input, 'Thai');
    const { act } = await import('react');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await flush();
    expect(createCategory).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('if the categories request fails it falls back to the old free-text field and the old request shape', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockRejectedValue(new ApiError(404, 'Not found'));
    const create = vi.spyOn(apiService, 'createPartner').mockResolvedValue({ profileId: 'p1' });
    await mount(<AddPartnerDrawer open kind="VENDOR" onClose={vi.fn()} onCreated={vi.fn()} />);
    await flush();
    expect(byId('ap-category')).not.toBeNull();
    expect(byId('ap-cuisines-add')).toBeNull();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('The category list could not be loaded');
    await fillOwner();
    await type(byId('ap-category'), 'North Indian');
    await submit();
    const body = create.mock.calls[0][0] as any;
    expect(body.category).toBe('North Indian');
    expect('cuisineIds' in body).toBe(false);
  });

  it('a rider drawer does not ask for categories at all', async () => {
    const fetch = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(list());
    await mount(<AddPartnerDrawer open kind="DRIVER" onClose={vi.fn()} onCreated={vi.fn()} />);
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(byId('ap-cuisines-add')).toBeNull();
  });

  it('a closed drawer does not load anything', async () => {
    const fetch = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(list());
    await mount(<AddPartnerDrawer open={false} kind="VENDOR" onClose={vi.fn()} onCreated={vi.fn()} />);
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a server refusal of the category ids is shown and keeps the form', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(list());
    vi.spyOn(apiService, 'createPartner').mockRejectedValue(new ApiError(400, 'Pick a category from the list.', 'CATEGORY_UNKNOWN', 'cuisineIds'));
    await mount(<AddPartnerDrawer open kind="VENDOR" onClose={vi.fn()} onCreated={vi.fn()} />);
    await flush();
    await fillOwner();
    await type(byId('ap-cuisines-add'), NORTH_ID);
    await submit();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Pick a category from the list.');
    expect((byId('ap-restaurant') as HTMLInputElement).value).toBe('Chai Point');
    expect(document.querySelector('li[data-chip]')).not.toBeNull();
  });
});
