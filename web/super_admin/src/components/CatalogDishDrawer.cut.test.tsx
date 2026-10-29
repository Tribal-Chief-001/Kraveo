// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { CatalogDishDrawer } from './CatalogDishDrawer';
import { ApiError, apiService } from '../services/api';
import { parseDish, parsePreview } from '../lib/catalogParse';
import { dish, pendingDish, preview as previewOf, settingView } from '../test/fixtures';
import { CUT_DISH_CREATED, CUT_PREVIEW_MENU, ERR_NEEDS_CUT, ERR_NOT_EXACT, ERR_PRICE_REQUIRED } from '../test/cutFixtures';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';

const vendors = [
  { id: 'cv', name: 'Cut Kitchen', commissionType: 'CUT', commissionValue: 30 },
  { id: 'pv', name: 'Percent Point', commissionType: 'PERCENT', commissionValue: 10 },
  { id: 'gv', name: 'Inherit House', commissionType: null, commissionValue: null },
] as any[];

const open = (item: ReturnType<typeof dish> | null, over: Record<string, unknown> = {}) => {
  const props = { onClose: vi.fn(), onChanged: vi.fn(), onAuthError: vi.fn(), ...over };
  return { props, element: <CatalogDishDrawer open item={item} vendors={vendors} categories={['Rolls']} {...props} /> };
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
const priceLabel = () => document.querySelector('label[for="dish-price"]')?.textContent ?? '';
const priceMessage = () => document.getElementById('dish-price-msg')?.textContent ?? '';
const cutDish = () => parseDish(CUT_DISH_CREATED.data)!;

let menuPreview: ReturnType<typeof vi.spyOn>;
let vendorPreview: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // The fake server: a menu price under the typed rule, like the real preview (30% unless the box says otherwise).
  menuPreview = vi.spyOn(apiService, 'previewCatalogMenuPrice').mockImplementation(async (input) => {
    const pct = input.commissionType === 'CUT' ? input.commissionValue! : 30;
    const vendor = Math.floor(input.menuPrice * (100 - pct)) / 100;
    return parsePreview({ data: { menuPrice: input.menuPrice, vendorPrice: vendor, price: input.menuPrice, effectiveCommission: Math.round((input.menuPrice - vendor) * 100) / 100, nominalCommission: Math.round((input.menuPrice - vendor) * 100) / 100, commission: { type: 'CUT', value: pct, source: input.commissionType ? 'DISH' : 'VENDOR' }, roundingStep: 1 } }, null)!;
  }) as any;
  vendorPreview = vi.spyOn(apiService, 'previewCatalogPrice').mockImplementation(async (input) => previewOf(input.vendorPrice)) as any;
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const fillCreate = async (vendorId: string, price: string) => {
  await type(byId('dish-vendor'), vendorId);
  await type(byId('dish-name'), 'Paneer Roll');
  await type(byId('dish-category'), 'Rolls');
  await type(byId('dish-price'), price);
};

describe('create: which price box?', () => {
  it('restaurant on Cut from sale: "Menu price (customer pays)", preview asks with menuPrice and shows what the restaurant gets', async () => {
    await mount(open(null).element);
    expect(priceLabel()).toContain('Restaurant price');
    await type(byId('dish-vendor'), 'cv');
    expect(priceLabel()).toContain('Menu price (customer pays)');
    await type(byId('dish-price'), '115');
    await settle();
    expect(menuPreview).toHaveBeenCalledTimes(1);
    expect(menuPreview.mock.calls[0][0]).toEqual({ vendorId: 'cv', menuPrice: 115 });
    expect(vendorPreview).not.toHaveBeenCalled();
    expect(text('preview-restaurant')).toBe('₹80.50');
    expect(text('preview-price')).toBe('₹115');
    expect(text('preview-commission')).toBe('₹34.50');
    expect(text('price-preview')).toContain('the restaurant gets');
    expect(text('preview-rule')).toContain('30% of the sale');
  });

  it('Add dish sends menuPrice and never vendorPrice', async () => {
    const create = vi.spyOn(apiService, 'createCatalogItem').mockResolvedValue(null);
    const { props, element } = open(null);
    await mount(element);
    await fillCreate('cv', '115');
    await click(byText('button', 'Add dish'));
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(body).toMatchObject({ vendorId: 'cv', name: 'Paneer Roll', menuPrice: 115 });
    expect('vendorPrice' in body).toBe(false);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('restaurant on Percent: the old restaurant price flow, vendorPrice is sent', async () => {
    const create = vi.spyOn(apiService, 'createCatalogItem').mockResolvedValue(null);
    await mount(open(null).element);
    await fillCreate('pv', '100');
    expect(priceLabel()).toContain('Restaurant price');
    await settle();
    expect(menuPreview).not.toHaveBeenCalled();
    expect(vendorPreview.mock.calls[0][0]).toEqual({ vendorId: 'pv', vendorPrice: 100 });
    await click(byText('button', 'Add dish'));
    await flush();
    const body = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(body).toMatchObject({ vendorId: 'pv', vendorPrice: 100 });
    expect('menuPrice' in body).toBe(false);
  });

  it('restaurant without its own rule: asks Settings once and follows a default of Cut from sale', async () => {
    const fetchSettings = vi.spyOn(apiService, 'fetchSettings').mockResolvedValue(settingView('commission', { type: 'CUT', value: 25 }) as any);
    await mount(open(null).element);
    expect(fetchSettings).not.toHaveBeenCalled(); // no restaurant chosen yet
    await type(byId('dish-vendor'), 'gv');
    await flush();
    expect(fetchSettings).toHaveBeenCalledTimes(1);
    expect(fetchSettings).toHaveBeenCalledWith('commission');
    expect(priceLabel()).toContain('Menu price (customer pays)');
  });

  it('a default of Percent keeps the restaurant price; an unreadable default does too (the server decides)', async () => {
    vi.spyOn(apiService, 'fetchSettings').mockResolvedValue(settingView('commission', { type: 'PERCENT', value: 12 }) as any);
    await mount(open(null).element);
    await type(byId('dish-vendor'), 'gv');
    await flush();
    expect(priceLabel()).toContain('Restaurant price');
    await unmount();
    vi.spyOn(apiService, 'fetchSettings').mockRejectedValue(new Error('offline'));
    await mount(open(null).element);
    await type(byId('dish-vendor'), 'gv');
    await flush();
    expect(priceLabel()).toContain('Restaurant price');
  });

  it('a Cut from sale override on the dish switches the box even when the restaurant is on Percent, and is sent with the preview', async () => {
    await mount(open(null).element);
    await type(byId('dish-vendor'), 'pv');
    await type(byId('dish-commission-mode'), 'CUT');
    await type(byId('dish-commission-value'), '20');
    expect(priceLabel()).toContain('Menu price (customer pays)');
    expect(document.querySelector('[data-testid="cut-example"]')?.textContent).toContain('cut 20%');
    await type(byId('dish-price'), '100');
    await settle();
    expect(menuPreview.mock.calls[menuPreview.mock.calls.length - 1][0]).toEqual({ vendorId: 'pv', menuPrice: 100, commissionType: 'CUT', commissionValue: 20 });
    expect(text('preview-restaurant')).toBe('₹80');
  });

  it('the commission list has the third option, and 91 percent is refused before anything is sent', async () => {
    const create = vi.spyOn(apiService, 'createCatalogItem').mockResolvedValue(null);
    await mount(open(null).element);
    const options = Array.from((byId('dish-commission-mode') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toContain('Cut from sale (%)');
    await fillCreate('pv', '100');
    await type(byId('dish-commission-mode'), 'CUT');
    await type(byId('dish-commission-value'), '91');
    await click(byText('button', 'Add dish'));
    expect(create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('A cut from the sale cannot be more than 90%.');
  });

  it.each(['0', '-5', '5001', '1.234', 'abc', '1e3', ''])('never sends the menu price %j', async (bad) => {
    const create = vi.spyOn(apiService, 'createCatalogItem').mockResolvedValue(null);
    await mount(open(null).element);
    await fillCreate('cv', bad);
    await click(byText('button', 'Add dish'));
    expect(create).not.toHaveBeenCalled();
    expect(menuPreview).not.toHaveBeenCalled();
    expect(priceMessage()).not.toBe('');
  });
});

describe('create: the new error codes are plain field errors', () => {
  const failWith = (body: Record<string, any>) => vi.spyOn(apiService, 'createCatalogItem').mockRejectedValue(new ApiError(400, body.message, body.code, body.field, body));

  it.each([[ERR_PRICE_REQUIRED], [ERR_NEEDS_CUT], [ERR_NOT_EXACT]])('$code shows under the price box, keeps the drawer open and the typed price', async (body) => {
    failWith(body);
    const o = open(null);
    await mount(o.element);
    await fillCreate('cv', '10');
    await click(byText('button', 'Add dish'));
    await flush();
    expect(priceMessage()).toBe(body.message);
    expect(byId('dish-price')?.getAttribute('aria-invalid')).toBe('true');
    expect((byId('dish-price') as HTMLInputElement).value).toBe('10');
    expect(o.props.onClose).not.toHaveBeenCalled();
    expect(o.props.onAuthError).toHaveBeenCalled();
  });

  it('MENU_PRICE_NOT_EXACT offers the nearest price and one click puts it in the box; typing clears the error', async () => {
    failWith(ERR_NOT_EXACT);
    await mount(open(null).element);
    await fillCreate('cv', '10');
    await click(byText('button', 'Add dish'));
    await flush();
    expect(priceMessage()).toContain('The nearest price that works is Rs 9.99.');
    await click(byText('button', 'Use ₹9.99 instead'));
    expect((byId('dish-price') as HTMLInputElement).value).toBe('9.99');
    expect(priceMessage()).not.toContain('nearest');
  });

  it('a failure that is not about the price stays a banner', async () => {
    vi.spyOn(apiService, 'createCatalogItem').mockRejectedValue(new ApiError(429, 'Too many changes. Try again in a few minutes.', 'RATE_LIMITED'));
    await mount(open(null).element);
    await fillCreate('cv', '115');
    await click(byText('button', 'Add dish'));
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Too many changes');
    expect(priceMessage()).not.toContain('Too many');
  });

  it('the live preview turns a menu-price error into the same field message, not a second alert', async () => {
    menuPreview.mockRejectedValue(new ApiError(400, ERR_NOT_EXACT.message, ERR_NOT_EXACT.code, 'menuPrice', ERR_NOT_EXACT));
    await mount(open(null).element);
    await type(byId('dish-vendor'), 'cv');
    await type(byId('dish-price'), '10');
    await settle();
    expect(priceMessage()).toBe(ERR_NOT_EXACT.message);
    expect(text('price-preview')).toContain('See the message under the price field');
    expect(document.querySelectorAll('[data-testid="price-preview"] [role="alert"]')).toHaveLength(0);
    expect(byText('button', 'Use ₹9.99 instead')).toBeDefined();
  });
});

describe('edit', () => {
  it('a dish that is on Cut from sale shows its menu price; saving another field sends no price', async () => {
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(cutDish()).element);
    expect(priceLabel()).toContain('Menu price (customer pays)');
    expect((byId('dish-price') as HTMLInputElement).value).toBe('115');
    await settle();
    expect(vendorPreview.mock.calls.length + menuPreview.mock.calls.length).toBeGreaterThan(0);
    expect(menuPreview).not.toHaveBeenCalled(); // price untouched: the restaurant price is previewed
    expect(vendorPreview.mock.calls[0][0]).toEqual({ vendorId: 'cut-ven-1', vendorPrice: 80.5 });
    await type(byId('dish-name'), 'Renamed');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith(CUT_DISH_CREATED.data.id, { name: 'Renamed' });
  });

  it('changing the menu price sends menuPrice only', async () => {
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(cutDish()).element);
    await type(byId('dish-price'), '200');
    await settle();
    expect(menuPreview.mock.calls[menuPreview.mock.calls.length - 1][0]).toEqual({ vendorId: 'cut-ven-1', menuPrice: 200 });
    expect(text('preview-restaurant')).toBe('₹140');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith(CUT_DISH_CREATED.data.id, { menuPrice: 200 });
  });

  it('server error on save appears under the price', async () => {
    vi.spyOn(apiService, 'updateCatalogItem').mockRejectedValue(new ApiError(400, ERR_NOT_EXACT.message, ERR_NOT_EXACT.code, 'menuPrice', ERR_NOT_EXACT));
    await mount(open(cutDish()).element);
    await type(byId('dish-price'), '10');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(priceMessage()).toBe(ERR_NOT_EXACT.message);
  });

  it('a Percent dish switched to Cut from sale: the menu price box starts empty, an untouched box keeps the restaurant price, only the commission is sent', async () => {
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(dish()).element);
    expect(priceLabel()).toContain('Restaurant price');
    await type(byId('dish-commission-mode'), 'CUT');
    await type(byId('dish-commission-value'), '30');
    expect(priceLabel()).toContain('Menu price (customer pays)');
    expect((byId('dish-price') as HTMLInputElement).value).toBe('');
    expect(priceMessage()).toContain('keep the restaurant price ₹100');
    await settle();
    expect(vendorPreview.mock.calls[vendorPreview.mock.calls.length - 1][0]).toEqual({ vendorId: 'v1', vendorPrice: 100, commissionType: 'CUT', commissionValue: 30 });
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith('d1', { commissionType: 'CUT', commissionValue: 30 });
  });

  it('...and typing a menu price with it sends both in one request', async () => {
    const update = vi.spyOn(apiService, 'updateCatalogItem').mockResolvedValue(null);
    await mount(open(dish()).element);
    await type(byId('dish-commission-mode'), 'CUT');
    await type(byId('dish-commission-value'), '30');
    await type(byId('dish-price'), '115');
    await click(byText('button', 'Save changes'));
    await flush();
    expect(update).toHaveBeenCalledWith('d1', { menuPrice: 115, commissionType: 'CUT', commissionValue: 30 });
  });

  it('a dish waiting for approval keeps the restaurant price even on Cut from sale (approval never takes a menu price)', async () => {
    const approve = vi.spyOn(apiService, 'approveCatalogItem').mockResolvedValue(null);
    await mount(open(pendingDish({ commission: { type: 'CUT', value: 30, source: 'VENDOR' } })).element);
    expect(priceLabel()).toContain('Restaurant price');
    await click(byText('button', /^Approve/));
    expect(approve).toHaveBeenCalledWith('d1', {});
  });

  it('nothing is NaN or crashes for a dish without prices', async () => {
    await mount(open(parseDish({ id: 'x', name: 'Odd', vendorId: 'cv', commission: { type: 'CUT', value: 30, source: 'VENDOR' } })).element);
    expect((byId('dish-price') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('removing a dish-level Cut from sale override explains it; the explanation block is shown for CUT only', async () => {
    await mount(open(dish({ commissionOverride: { type: 'CUT', value: 25 }, commission: { type: 'CUT', value: 25, source: 'DISH' } })).element);
    expect((byId('dish-commission-mode') as HTMLSelectElement).value).toBe('CUT');
    expect(document.querySelector('[data-testid="cut-explain"]')).not.toBeNull();
    await type(byId('dish-commission-mode'), 'INHERIT');
    expect(document.body.textContent).toContain('This dish had its own commission (25% of the sale); saving removes it.');
    expect(document.querySelector('[data-testid="cut-explain"]')).toBeNull();
  });
});
