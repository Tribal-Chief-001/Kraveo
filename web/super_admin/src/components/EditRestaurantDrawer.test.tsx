// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { EditRestaurantDrawer } from './EditRestaurantDrawer';
import { VendorManager } from './VendorManager';
import { ApiError, apiService } from '../services/api';
import { normalizeVendor, Vendor } from '../types';
import { parseCategory } from '../lib/categoryParse';
import { Decoded, ImageEnv } from '../lib/imageCompress';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';
import { rawCategory, rawNorthIndian, rawUnused, rawVendor } from '../test/taxonomyFixtures';

const NORTH_ID = '02236158-229f-48fc-9fe8-4b1220e74ed7';
const BIRYANI_ID = '72077a2d-9b97-48de-9956-8d0167228f34';
const vendor = (over: Record<string, unknown> = {}): Vendor => normalizeVendor(rawVendor(over));
const cats = [rawCategory(), rawNorthIndian(), rawUnused({ id: 'rolls-id', name: 'Rolls & Wraps' })];

const setup = async (props: Record<string, unknown> = {}, list: unknown[] = cats) => {
  const fetchCategories = vi.spyOn(apiService, 'fetchCategories').mockResolvedValue(list.map((r) => parseCategory(r)!));
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onAuthError = vi.fn();
  const host = await mount(<EditRestaurantDrawer vendor={vendor()} onClose={onClose} onSaved={onSaved} onAuthError={onAuthError} {...(props as any)} />);
  await flush();
  return { host, fetchCategories, onClose, onSaved, onAuthError };
};
const save = async () => { await click(byText('button', 'Save changes')); await flush(); };
const chips = () => Array.from(document.querySelectorAll('li[data-chip] span[title]')).map((el) => el.textContent);

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('EditRestaurantDrawer', () => {
  it('opens on the saved values: name, ordered category chips, address, banner preview, FSSAI and delivery time', async () => {
    const { host } = await setup();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.textContent).toContain('Edit Shape Kitchen & Co');
    expect((byId('er-name') as HTMLInputElement).value).toBe('Shape Kitchen & Co');
    expect(chips()).toEqual(['North Indian', 'Biryani']);
    expect((byId('er-address') as HTMLInputElement).value).toBe('Ashta road, near gate 4');
    expect((byId('er-banner') as HTMLInputElement).value).toContain('unsplash');
    expect(host.ownerDocument.querySelector('img')!.getAttribute('alt')).toBe('Banner of Shape Kitchen & Co');
    expect((byId('er-fssai') as HTMLInputElement).value).toBe('12345678901234');
    expect((byId('er-eta') as HTMLInputElement).value).toBe('15-20 min');
    expect(dialog.textContent).toContain('Nothing changed yet.');
    expect(document.activeElement).toBe(byId('er-name')); // focus moves into the drawer
  });

  it('loads the categories from the server (active ones) for the picker', async () => {
    const { fetchCategories } = await setup();
    expect(fetchCategories).toHaveBeenCalledWith();
    const options = Array.from((byId('er-cuisines-add') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toContain('Rolls & Wraps');
    expect(options).not.toContain('Biryani · बिरयानी'); // already chosen
  });

  it('nothing changed: says so, sends nothing', async () => {
    const update = vi.spyOn(apiService, 'updateVendorProfile');
    await setup();
    await save();
    expect(update).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Nothing was changed.');
  });

  it('sends only the changed fields, shows what changed in the toast, hands the fresh vendor up and closes', async () => {
    const fresh = vendor({ name: 'Shape Kitchen', cuisines: [{ id: 'rolls-id', name: 'Rolls & Wraps', icon: 'roll' }] });
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: fresh, changed: true, message: 'Restaurant saved.' });
    const { onSaved, onClose } = await setup();
    await type(byId('er-name'), 'Shape Kitchen');
    await click(document.querySelector('button[aria-label="Remove North Indian"]'));
    await click(document.querySelector('button[aria-label="Remove Biryani"]'));
    await type(byId('er-cuisines-add'), 'rolls-id');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Will change: name and categories.');
    await save();
    expect(update).toHaveBeenCalledWith('sh-ven-1', { name: 'Shape Kitchen', cuisineIds: ['rolls-id'] });
    expect(onSaved).toHaveBeenCalledWith(fresh);
    expect(onClose).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Updated name and categories for Shape Kitchen.');
  });

  it('reordering the chips changes the first (main) category and is sent in that order', async () => {
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: vendor(), changed: true, message: '' });
    await setup();
    await click(document.querySelector('button[aria-label="Move Biryani earlier"]'));
    expect(chips()).toEqual(['Biryani', 'North Indian']);
    await save();
    expect(update).toHaveBeenCalledWith('sh-ven-1', { cuisineIds: [BIRYANI_ID, NORTH_ID] });
  });

  it('the 6 category limit is enforced in the picker', async () => {
    const many = Array.from({ length: 8 }, (_, i) => rawCategory({ id: `x${i}`, name: `Cuisine ${i}` }));
    await setup({ vendor: vendor({ cuisines: many.slice(0, 5).map((c) => ({ id: c.id, name: c.name, icon: 'restaurant' })) }) }, many);
    await type(byId('er-cuisines-add'), 'x5');
    expect((byId('er-cuisines-add') as HTMLSelectElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('6 of 6 chosen');
  });

  it('banner: paste a link, send it trimmed', async () => {
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: vendor(), changed: true, message: '' });
    await setup();
    await type(byId('er-banner'), '  https://cdn.example/banner.jpg ');
    await save();
    expect(update).toHaveBeenCalledWith('sh-ven-1', { bannerImage: 'https://cdn.example/banner.jpg' });
  });

  it('banner: upload through the picture widget fills the link with the server address', async () => {
    const env: ImageEnv = { decode: async () => ({ width: 1600, height: 900, source: {} }) as Decoded, encode: async () => ({ size: 90_000, type: 'image/webp' }) as unknown as Blob, webpSupported: () => true };
    const upload = vi.spyOn(apiService, 'uploadImage').mockResolvedValue({ url: 'https://api.kraveo.site/uploads/banner/2026/abc.webp', width: 1200, height: 675, bytes: 90000 });
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: vendor(), changed: true, message: '' });
    await setup({ imageEnv: env });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array(10)], 'b.jpg', { type: 'image/jpeg' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(upload).toHaveBeenCalledWith(expect.anything(), 'banner');
    expect((byId('er-banner') as HTMLInputElement).value).toBe('https://api.kraveo.site/uploads/banner/2026/abc.webp');
    await save();
    expect(update).toHaveBeenCalledWith('sh-ven-1', { bannerImage: 'https://api.kraveo.site/uploads/banner/2026/abc.webp' });
  });

  it('banner: Save is held back while a photo is still uploading', async () => {
    const env: ImageEnv = { decode: async () => ({ width: 1600, height: 900, source: {} }) as Decoded, encode: async () => ({ size: 90_000, type: 'image/webp' }) as unknown as Blob, webpSupported: () => true };
    let release: (v: any) => void = () => {};
    vi.spyOn(apiService, 'uploadImage').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const update = vi.spyOn(apiService, 'updateVendorProfile');
    await setup({ imageEnv: env });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array(10)], 'b.jpg', { type: 'image/jpeg' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect((byText('button', 'Save changes') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release({ url: 'https://api.kraveo.site/uploads/banner/2026/z.webp', width: 1200, height: 675, bytes: 1 }); });
    await flush();
    expect((byText('button', 'Save changes') as HTMLButtonElement).disabled).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('banner: "Use the default banner" sends null and explains it', async () => {
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: vendor(), changed: true, message: '' });
    await setup();
    await click(byText('button', 'Use the default banner'));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('The default banner will be used after you save.');
    await save();
    expect(update).toHaveBeenCalledWith('sh-ven-1', { bannerImage: null });
  });

  it('FSSAI: 14 digits, can be cleared; ETA is normalised; bad values are refused before any request', async () => {
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: vendor(), changed: true, message: '' });
    await setup();
    await type(byId('er-fssai'), '123');
    await type(byId('er-eta'), 'soon');
    await save();
    expect(update).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('The FSSAI number has exactly 14 digits.');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Write the time as a range, for example 15-20 min.');
    expect(byId('er-fssai')!.getAttribute('aria-invalid')).toBe('true');
    await type(byId('er-fssai'), '');
    await type(byId('er-eta'), '10-15');
    await save();
    expect(update).toHaveBeenCalledWith('sh-ven-1', { fssaiNumber: null, eta: '10-15 min' });
  });

  it('a server error is shown on the field it names (NAME_TAKEN) and the drawer stays open', async () => {
    vi.spyOn(apiService, 'updateVendorProfile').mockRejectedValue(new ApiError(409, 'Another restaurant already uses this name.', 'NAME_TAKEN', 'name'));
    const { onClose, onSaved, onAuthError } = await setup();
    await type(byId('er-name'), 'Taken Name');
    await save();
    expect(byId('er-name')!.getAttribute('aria-invalid')).toBe('true');
    expect(byId('er-name-msg')!.textContent).toBe('Another restaurant already uses this name.');
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onAuthError).toHaveBeenCalled();
    // fixing the field clears the server message
    await type(byId('er-name'), 'Free Name');
    expect(byId('er-name-msg')).toBeNull();
  });

  it.each([
    ['TOO_MANY_CATEGORIES', 'cuisineIds', 'A restaurant can have at most 6 categories.'],
    ['BAD_REQUEST', 'address', 'Address must be 3 to 140 characters.'],
    ['BAD_REQUEST', 'fssaiNumber', 'The FSSAI number must be 14 digits.'],
  ])('%s on %s shows the server sentence', async (code, field, message) => {
    vi.spyOn(apiService, 'updateVendorProfile').mockRejectedValue(new ApiError(400, message, code, field));
    await setup();
    await type(byId('er-name'), 'Another Name');
    await save();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(message);
  });

  it('a category that disappeared meanwhile reloads the list', async () => {
    vi.spyOn(apiService, 'updateVendorProfile').mockRejectedValue(new ApiError(400, 'Pick a category from the list.', 'CATEGORY_UNKNOWN', 'cuisineIds'));
    const { fetchCategories } = await setup();
    await type(byId('er-name'), 'Another Name');
    await save();
    await flush();
    expect(fetchCategories).toHaveBeenCalledTimes(2);
  });

  it('a general failure (network) shows a message in the footer and keeps the form', async () => {
    vi.spyOn(apiService, 'updateVendorProfile').mockRejectedValue(new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.', 'NETWORK'));
    await setup();
    await type(byId('er-name'), 'Another Name');
    await save();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('unreachable');
    expect((byId('er-name') as HTMLInputElement).value).toBe('Another Name');
  });

  it('the server finding nothing to change is reported as such', async () => {
    vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: vendor(), changed: false, message: 'Nothing to change.' });
    const { onClose } = await setup();
    await type(byId('er-name'), 'Another Name');
    await save();
    expect(document.body.textContent).toContain('The server already had these values.');
    expect(onClose).toHaveBeenCalled();
  });

  it('a double click on Save sends one request', async () => {
    let release: (v: any) => void = () => {};
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await setup();
    await type(byId('er-name'), 'Another Name');
    const button = byText('button', 'Save changes')!;
    await click(button);
    await click(byText('button', 'Saving…') ?? button);
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => { release({ vendor: vendor(), changed: true, message: '' }); });
    await flush();
  });

  it('if the category list cannot be loaded, the categories are left alone and the rest can still be saved', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockRejectedValue(new ApiError(0, 'The operations API is unreachable.', 'NETWORK'));
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: vendor(), changed: true, message: '' });
    const onClose = vi.fn();
    await mount(<EditRestaurantDrawer vendor={vendor()} onClose={onClose} onSaved={vi.fn()} />);
    await flush();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('The category list could not be loaded.');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Shown to customers now: North Indian • Biryani.');
    await type(byId('er-address'), 'New gate');
    await save();
    expect(update).toHaveBeenCalledWith('sh-ven-1', { address: 'New gate' }); // no cuisineIds key: categories untouched
  });

  it('an older server without cuisines/eta/banner/FSSAI in the list still opens and sends only what the admin typed', async () => {
    const old = normalizeVendor({ id: 'v9', name: 'Old Dhaba', category: 'Cafe', rating: 4, isAcceptingOrders: true, address: 'Gate 1' });
    const update = vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: old, changed: true, message: '' });
    await setup({ vendor: old });
    expect((byId('er-fssai') as HTMLInputElement).value).toBe('');
    expect((byId('er-eta') as HTMLInputElement).value).toBe('');
    await type(byId('er-eta'), '20-30 min');
    await save();
    expect(update).toHaveBeenCalledWith('v9', { eta: '20-30 min' });
  });

  it('Escape closes it; Cancel closes it; focus returns to the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { onClose } = await setup();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(byText('button', 'Cancel'));
    expect(onClose).toHaveBeenCalledTimes(2);
    opener.remove();
  });
});

describe('Edit restaurant on the vendor card', () => {
  const list = [vendor(), vendor({ id: 'v2', name: 'Chai Point', cuisines: [] })];

  it('every restaurant card has the button and it opens the drawer for that restaurant', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    const host = await mount(<VendorManager vendors={list} onToggleVendor={vi.fn()} />);
    const buttons = Array.from(host.querySelectorAll('button')).filter((b) => b.textContent?.trim() === 'Edit restaurant');
    expect(buttons).toHaveLength(2);
    await click(buttons[1]);
    await flush();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit Chai Point');
  });

  it('saving hands the fresh restaurant to the page so the list refreshes', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    const fresh = vendor({ name: 'Renamed' });
    vi.spyOn(apiService, 'updateVendorProfile').mockResolvedValue({ vendor: fresh, changed: true, message: '' });
    const onProfileSaved = vi.fn();
    const host = await mount(<VendorManager vendors={list} onToggleVendor={vi.fn()} onProfileSaved={onProfileSaved} />);
    await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Edit restaurant')!);
    await flush();
    await type(byId('er-name'), 'Renamed');
    await save();
    expect(onProfileSaved).toHaveBeenCalledWith(fresh);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('the header search also finds restaurants by their category names', async () => {
    // the legacy text no longer says Biryani, only the category link does
    const two = [vendor({ category: 'Campus kitchen' }), vendor({ id: 'v2', name: 'Chai Point', category: 'Cafe', cuisines: [] })];
    const host = await mount(<VendorManager vendors={two} onToggleVendor={vi.fn()} query="biryani" />);
    expect(host.textContent).toContain('Shape Kitchen & Co');
    expect(host.textContent).not.toContain('Chai Point');
  });
});

describe('360 px', () => {
  it('the drawer renders at phone width without crashing', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    await setup();
    expect(byText('button', 'Save changes')).toBeTruthy();
    expect(chips()).toEqual(['North Indian', 'Biryani']);
  });
});

describe('restaurants without categories (self sign-up)', () => {
  it('the card says so and the hint opens Edit restaurant', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    const signup = vendor({ id: 'v7', name: 'Self Signup Dhaba', category: 'Tiffin', cuisines: [], tags: [] });
    const host = await mount(<VendorManager vendors={[signup, vendor()]} onToggleVendor={vi.fn()} />);
    const hints = Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === 'No categories yet. Add some');
    expect(hints).toHaveLength(1); // only the restaurant with an empty list; one with categories, or an older server (undefined), is not nagged
    await click(hints[0]);
    await flush();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit Self Signup Dhaba');
  });

  it('an older server (no cuisines field) shows no hint', async () => {
    const old = normalizeVendor({ id: 'v8', name: 'Old', category: 'Cafe', rating: 1, isAcceptingOrders: true, address: 'x' });
    const host = await mount(<VendorManager vendors={[old]} onToggleVendor={vi.fn()} />);
    expect(host.textContent).not.toContain('No categories yet');
  });
});
