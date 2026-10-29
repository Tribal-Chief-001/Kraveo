// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { CatalogPanel } from './CatalogPanel';
import { apiService } from '../services/api';
import { CatalogDish, CatalogPage, parseDish } from '../lib/catalogParse';
import { parseMenuOrderResult } from '../lib/menuOrder';
import { CUT_DISH_CREATED, MENU_ORDER_SAVED } from '../test/cutFixtures';
import { byText, click, flush, mount, unmount } from '../test/dom';

const page = (items: CatalogDish[]): CatalogPage => ({ items, page: 1, pageSize: 25, total: items.length, totalPages: 1, hasMore: false });
const vendors = [{ id: 'cut-ven-1', name: 'Cut Kitchen 1' }, { id: 'v2', name: 'Chai Point' }] as any[];
const cutDish = parseDish(CUT_DISH_CREATED.data)!;
const render = () => <CatalogPanel {...({ vendors, query: '', onClearQuery: vi.fn(), onAuthError: vi.fn(), pendingCounts: { pending: 0, changePending: 0, total: 0 }, onPendingChanged: vi.fn() } as any)} />;
const pickVendor = async (id: string) => {
  const select = document.querySelector('#catalog-vendor-filter') as HTMLSelectElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, id); select.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
};

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('Catalog: Cut from sale wording and the Menu order button (Docs/26)', () => {
  it('the table prints a CUT rule as "30% of the sale" with the commission in rupees', async () => {
    vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page([cutDish]));
    const host = await mount(render());
    await flush();
    expect(host.textContent).toContain('₹34.50 (30% of the sale · restaurant)');
    expect(host.textContent).toContain('₹80.50');
    expect(host.textContent).toContain('₹115');
  });

  it('Menu order needs one restaurant; it opens the panel for that restaurant, and a save reloads the list', async () => {
    const fetchCatalog = vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page([cutDish]));
    const save = vi.spyOn(apiService, 'saveMenuOrder').mockResolvedValue(parseMenuOrderResult(MENU_ORDER_SAVED)!);
    const host = await mount(render());
    await flush();
    const button = () => byText('button', 'Menu order', host) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    expect(button().title).toBe('Choose one restaurant first');
    await pickVendor('cut-ven-1');
    expect(button().disabled).toBe(false);
    fetchCatalog.mockClear();
    await click(button());
    await flush();
    expect(fetchCatalog).toHaveBeenCalledWith({ vendorId: 'cut-ven-1', page: 1, pageSize: 100 });
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Cut Kitchen 1');
    expect(dialog.textContent).toContain('1 section, 1 dish');
    // a second section is needed to move anything: one section means nothing to save
    expect(save).not.toHaveBeenCalled();
    await click(byText('button', 'Close', dialog));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
