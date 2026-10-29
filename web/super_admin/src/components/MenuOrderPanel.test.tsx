// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { MenuOrderPanel } from './MenuOrderPanel';
import { ApiError, apiService } from '../services/api';
import { parseDishList } from '../lib/catalogParse';
import { parseMenuOrderResult } from '../lib/menuOrder';
import { rawDish, rawList } from '../test/fixtures';
import { ERR_ORDER_INVALID, MENU_ORDER_SAVED, MENU_ORDER_UNCHANGED } from '../test/cutFixtures';
import { byText, click, flush, mount, unmount } from '../test/dom';

const vendor = { id: 'v1', name: 'Cut Kitchen' };
const d = (id: string, category: string, over: Record<string, unknown> = {}) => rawDish({ id, name: `Dish ${id}`, category, ...over });
const MENU = [d('a', 'Main Course'), d('b', 'Main Course'), d('c', 'Main Course'), d('s1', 'Snacks'), d('s2', 'Snacks'), d('x', 'Desserts')];
const page = (data: unknown[], over: Record<string, unknown> = {}) => parseDishList(rawList(data, { pageSize: 100, ...over }), 1)!;

let fetchCatalog: ReturnType<typeof vi.spyOn>;
let saveOrder: ReturnType<typeof vi.spyOn>;
let props: { onClose: ReturnType<typeof vi.fn>; onSaved: ReturnType<typeof vi.fn>; onAuthError: ReturnType<typeof vi.fn> };

beforeEach(() => {
  fetchCatalog = vi.spyOn(apiService, 'fetchCatalog').mockResolvedValue(page(MENU)) as any;
  saveOrder = vi.spyOn(apiService, 'saveMenuOrder').mockResolvedValue(parseMenuOrderResult(MENU_ORDER_SAVED)!) as any;
  props = { onClose: vi.fn(), onSaved: vi.fn(), onAuthError: vi.fn() };
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = async () => { await mount(<MenuOrderPanel vendor={vendor} {...props} />); await flush(); };
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const sectionNames = () => Array.from(dialog().querySelectorAll('ol[aria-label="Menu sections"] > li')).map((li) => li.getAttribute('data-section'));
const dishIds = (section: string) => Array.from(dialog().querySelectorAll(`li[data-section="${section}"] li[data-dish]`)).map((li) => li.getAttribute('data-dish'));
const btn = (label: string) => dialog().querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const status = () => dialog().querySelector('[data-testid="order-status"]')!.textContent!;
const announce = () => dialog().querySelector('[data-testid="order-announce"]')!.textContent!;
const expand = (name: string) => click(byText('button', new RegExp(name), dialog())!.closest('li')!.querySelector('button[aria-expanded]'));
const saveButton = () => byText('button', 'Save order', dialog()) as HTMLButtonElement;

describe('loading', () => {
  it('asks for the restaurant\'s dishes in pages of 100 and lists the sections in the server order', async () => {
    await render();
    expect(fetchCatalog).toHaveBeenCalledWith({ vendorId: 'v1', page: 1, pageSize: 100 });
    expect(sectionNames()).toEqual(['main course', 'snacks', 'desserts']);
    expect(dialog().textContent).toContain('3 sections, 6 dishes');
    expect(status()).toBe('The order shown is the saved order.');
    expect(saveButton().disabled).toBe(true);
  });

  it('reads every page', async () => {
    const second = [d('p2a', 'Extras'), d('p2b', 'Extras')];
    fetchCatalog.mockReset();
    fetchCatalog.mockResolvedValueOnce(page(MENU, { total: 8, pages: 2, page: 1, pageSize: 6 })).mockResolvedValueOnce(page(second, { total: 8, pages: 2, page: 2, pageSize: 6 }));
    await render();
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    expect(fetchCatalog.mock.calls[1][0]).toEqual({ vendorId: 'v1', page: 2, pageSize: 100 });
    expect(sectionNames()).toEqual(['main course', 'snacks', 'desserts', 'extras']);
  });

  it('a failed load shows a plain message and Try again works', async () => {
    fetchCatalog.mockRejectedValueOnce(new Error('The operations API is unreachable.'));
    await render();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('The operations API is unreachable.');
    expect(props.onAuthError).toHaveBeenCalled();
    await click(byText('button', 'Try again', dialog()));
    await flush();
    expect(sectionNames()).toHaveLength(3);
  });

  it('an empty menu says so', async () => {
    fetchCatalog.mockResolvedValue(page([]));
    await render();
    expect(dialog().textContent).toContain('has no dishes yet');
    expect(saveButton().disabled).toBe(true);
  });

  it('a menu over the 400 dish cap cannot be saved from here and says why', async () => {
    const big = Array.from({ length: 100 }, (_, i) => d(`m${i}`, 'Big'));
    fetchCatalog.mockReset();
    for (let p = 1; p <= 5; p++) fetchCatalog.mockResolvedValueOnce(page(big.map((x, i) => ({ ...x, id: `m${p}-${i}` })), { total: 500, pages: 5, page: p }));
    await render();
    expect(dialog().textContent).toContain('This menu has 500 dishes, but the order can be saved for at most 400.');
    await click(btn('Move section Big up'));
    expect(saveButton().disabled).toBe(true);
  });
});

describe('reordering sections', () => {
  it('up and down move a section, update the unsaved line and announce it', async () => {
    await render();
    await click(btn('Move section Desserts up'));
    expect(sectionNames()).toEqual(['main course', 'desserts', 'snacks']);
    expect(announce()).toBe('Desserts moved up to position 2 of 3.');
    expect(status()).toBe('Unsaved changes: 2 sections in a new place.');
    await click(btn('Move section Main Course down'));
    expect(sectionNames()).toEqual(['desserts', 'main course', 'snacks']);
    expect(announce()).toBe('Main Course moved down to position 2 of 3.');
    expect(saveButton().disabled).toBe(false);
  });

  it('the first Up and the last Down are disabled', async () => {
    await render();
    expect(btn('Move section Main Course up').disabled).toBe(true);
    expect(btn('Move section Desserts down').disabled).toBe(true);
    expect(btn('Move section Snacks up').disabled).toBe(false);
  });

  it('focus stays on the moved section\'s button, and jumps to its twin when the end is reached', async () => {
    await render();
    btn('Move section Snacks up').focus();
    await click(btn('Move section Snacks up'));
    // Snacks is now first: its Up is disabled, focus moves to Down
    expect(btn('Move section Snacks up').disabled).toBe(true);
    expect(document.activeElement).toBe(btn('Move section Snacks down'));
  });

  it('moving something back puts the status back to saved', async () => {
    await render();
    await click(btn('Move section Snacks up'));
    await click(btn('Move section Snacks down'));
    expect(sectionNames()).toEqual(['main course', 'snacks', 'desserts']);
    expect(status()).toBe('The order shown is the saved order.');
    expect(saveButton().disabled).toBe(true);
  });
});

describe('reordering dishes', () => {
  it('dishes show when a section is opened; up and down move inside the section only', async () => {
    await render();
    expect(dishIds('main course')).toEqual([]);
    await expand('Main Course');
    expect(dishIds('main course')).toEqual(['a', 'b', 'c']);
    expect(btn('Move Dish a up').disabled).toBe(true);
    expect(btn('Move Dish c down').disabled).toBe(true);
    await click(btn('Move Dish c up'));
    expect(dishIds('main course')).toEqual(['a', 'c', 'b']);
    expect(announce()).toBe('Dish c moved up to position 2 of 3 in Main Course.');
    expect(status()).toBe('Unsaved changes: 2 dishes in a new place.');
    expect(sectionNames()).toEqual(['main course', 'snacks', 'desserts']);
  });

  it('focus follows the moved dish\'s button', async () => {
    await render();
    await expand('Main Course');
    btn('Move Dish c up').focus();
    await click(btn('Move Dish c up'));
    expect(document.activeElement).toBe(btn('Move Dish c up'));
    await click(btn('Move Dish c up'));
    expect(dishIds('main course')).toEqual(['c', 'a', 'b']);
    expect(document.activeElement).toBe(btn('Move Dish c down')); // at the top: Up is off
  });

  it('a section keeps its dishes when it moves', async () => {
    await render();
    await expand('Snacks');
    await click(btn('Move section Snacks up'));
    expect(dishIds('snacks')).toEqual(['s1', 's2']);
  });

  it('a section with 100 dishes: the last dish goes to the top by keyboard-sized steps and is saved with exact ranks', async () => {
    const big = Array.from({ length: 100 }, (_, i) => d(`k${i}`, 'Big'));
    fetchCatalog.mockResolvedValue(page(big));
    await render();
    await expand('Big');
    for (let i = 0; i < 99; i++) await click(btn('Move Dish k99 up'));
    expect(dishIds('big').slice(0, 3)).toEqual(['k99', 'k0', 'k1']);
    await click(saveButton());
    await flush();
    const sent = saveOrder.mock.calls[0][1] as { sections: string[]; dishes: Array<{ id: string; position: number }> };
    expect(sent.sections).toEqual(['Big']);
    expect(sent.dishes).toHaveLength(100);
    expect(sent.dishes[0]).toEqual({ id: 'k99', position: 1 });
    expect(sent.dishes[99]).toEqual({ id: 'k98', position: 100 });
    expect(new Set(sent.dishes.map((x) => x.position)).size).toBe(100);
  });

  it('not live and sold out dishes are marked', async () => {
    fetchCatalog.mockResolvedValue(page([d('a', 'X', { status: 'PENDING', approvalStatus: 'PENDING' }), d('b', 'X', { isAvailable: false })]));
    await render();
    await expand('X');
    expect(dialog().textContent).toContain('not live yet');
    expect(dialog().textContent).toContain('sold out');
  });
});

describe('saving', () => {
  it('sends every section in order and every dish with its place, tells the parent and reloads', async () => {
    await render();
    await click(btn('Move section Desserts up'));
    await click(btn('Move section Desserts up'));
    await expand('Main Course');
    await click(btn('Move Dish b up'));
    await click(saveButton());
    await flush();
    expect(saveOrder).toHaveBeenCalledTimes(1);
    expect(saveOrder.mock.calls[0][0]).toBe('v1');
    expect(saveOrder.mock.calls[0][1]).toEqual({
      sections: ['Desserts', 'Main Course', 'Snacks'],
      dishes: [
        { id: 'x', position: 1 },
        { id: 'b', position: 1 }, { id: 'a', position: 2 }, { id: 'c', position: 3 },
        { id: 's1', position: 1 }, { id: 's2', position: 2 },
      ],
    });
    expect(props.onSaved).toHaveBeenCalledTimes(1);
    expect(fetchCatalog).toHaveBeenCalledTimes(2); // load + refresh after the save
    expect(status()).toBe('The order shown is the saved order.');
    expect(announce()).toBe('Menu order saved.');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('shows what the server has after the save (refresh)', async () => {
    await render();
    await click(btn('Move section Desserts up'));
    fetchCatalog.mockResolvedValue(page([d('s1', 'Snacks'), d('x', 'Desserts'), d('a', 'Main Course')]));
    await click(saveButton());
    await flush();
    expect(sectionNames()).toEqual(['snacks', 'desserts', 'main course']);
  });

  it('is double-submit safe: a second press while the request runs sends nothing, and the arrows are off', async () => {
    let finish: () => void = () => {};
    saveOrder.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(parseMenuOrderResult(MENU_ORDER_SAVED)!); }));
    await render();
    await click(btn('Move section Desserts up'));
    await click(saveButton());
    await click(saveButton());
    expect(saveOrder).toHaveBeenCalledTimes(1);
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    expect(btn('Move section Snacks up').disabled).toBe(true);
    expect((byText('button', 'Discard changes', dialog()) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); });
    await flush();
    expect(saveOrder).toHaveBeenCalledTimes(1);
  });

  it('"nothing to change" from the server is said plainly', async () => {
    saveOrder.mockResolvedValue(parseMenuOrderResult(MENU_ORDER_UNCHANGED)!);
    await render();
    await click(btn('Move section Desserts up'));
    await click(saveButton());
    await flush();
    expect(announce()).toContain('Nothing to change');
  });

  it('MENU_ORDER_INVALID keeps the moves, explains and offers Reload', async () => {
    saveOrder.mockRejectedValue(new ApiError(400, ERR_ORDER_INVALID.message, ERR_ORDER_INVALID.code, ERR_ORDER_INVALID.field, ERR_ORDER_INVALID));
    await render();
    await click(btn('Move section Desserts up'));
    await click(saveButton());
    await flush();
    const alert = dialog().querySelector('[role="alert"]')!.textContent!;
    expect(alert).toContain('This restaurant has no dishes in a section called "Biryani".');
    expect(alert).toContain('Reload the menu and try again');
    expect(sectionNames()).toEqual(['main course', 'desserts', 'snacks']);
    expect(status()).toContain('Unsaved changes');
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false); // can try again
  });

  it('a rate limit or network failure is shown as the server says it, and the session handler is told', async () => {
    saveOrder.mockRejectedValue(new ApiError(429, 'Too many menu order changes. Try again in a few minutes.', 'RATE_LIMITED'));
    await render();
    await click(btn('Move section Desserts up'));
    await click(saveButton());
    await flush();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('Too many menu order changes.');
    expect(props.onAuthError).toHaveBeenCalled();
  });

  it('moving again clears the old error', async () => {
    saveOrder.mockRejectedValue(new Error('boom'));
    await render();
    await click(btn('Move section Desserts up'));
    await click(saveButton());
    await flush();
    expect(dialog().querySelector('[role="alert"]')).not.toBeNull();
    await click(btn('Move section Desserts up'));
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
  });
});

describe('discard and leaving', () => {
  it('Discard puts the saved order back and says so', async () => {
    await render();
    await click(btn('Move section Desserts up'));
    await expand('Snacks');
    await click(btn('Move Dish s2 up'));
    await click(byText('button', 'Discard changes', dialog()));
    expect(sectionNames()).toEqual(['main course', 'snacks', 'desserts']);
    expect(dishIds('snacks')).toEqual(['s1', 's2']);
    expect(status()).toBe('The order shown is the saved order.');
    expect(announce()).toContain('Changes discarded');
    expect(saveOrder).not.toHaveBeenCalled();
  });

  it('Close with unsaved changes asks first; Keep editing stays, Leave closes', async () => {
    await render();
    await click(btn('Move section Desserts up'));
    await click(byText('button', 'Close', dialog()));
    const confirmBox = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(confirmBox.textContent).toContain('The new order has not been saved');
    await click(byText('button', 'Keep editing', confirmBox));
    expect(props.onClose).not.toHaveBeenCalled();
    await click(byText('button', 'Close', dialog()));
    await click(byText('button', 'Leave without saving', document.querySelector('[role="alertdialog"]') as HTMLElement));
    await flush();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('Close without changes closes at once; Escape asks too when there are changes', async () => {
    await render();
    await click(byText('button', 'Close', dialog()));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    props.onClose.mockClear();
    await click(btn('Move section Desserts up'));
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('Reload with unsaved changes asks before throwing them away', async () => {
    await render();
    await click(btn('Move section Desserts up'));
    await click(byText('button', 'Reload', dialog()));
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Your unsaved moves are lost');
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
  });
});

describe('accessibility and a 360 px screen', () => {
  it('every control has a name, the sections and dishes are lists, the live region is polite, and nothing has a fixed wide size', async () => {
    await render();
    await expand('Main Course');
    const unnamed = Array.from(dialog().querySelectorAll('button')).filter((b) => !(b.getAttribute('aria-label') || b.textContent || '').trim());
    expect(unnamed).toHaveLength(0);
    expect(dialog().querySelector('ol[aria-label="Dishes in Main Course"]')).not.toBeNull();
    expect(dialog().querySelector('[aria-live="polite"][role="status"]')).not.toBeNull();
    expect(dialog().querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    // 360 px: the drawer is a bottom sheet at full width; long names wrap instead of widening the page
    const html = dialog().outerHTML;
    expect(html).not.toMatch(/\bw-\[(?:[4-9]\d\d|\d{4,})px\]/);
    expect(html).not.toMatch(/\bmin-w-\[/);
    expect(dialog().className).toContain('w-full');
    expect(dialog().querySelector('li[data-section] .break-words')).not.toBeNull();
  });

  it('a very long dish name and a 360 px viewport do not break the layout or the text', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    const long = 'Extra Long Hyderabadi Dum Biryani With Boneless Chicken And Special Masala '.repeat(3).trim();
    fetchCatalog.mockResolvedValue(page([d('a', 'Biryani & Co', { name: long }), d('b', 'Biryani & Co', { name: '<img src=x onerror=alert(1)>' })]));
    await render();
    await expand('Biryani');
    expect(dialog().textContent).toContain(long);
    expect(dialog().querySelector('img')).toBeNull(); // names are text, never HTML
    expect(dialog().textContent).toContain('<img src=x onerror=alert(1)>');
    expect(btn(`Move ${long} up`)).not.toBeNull();
    expect(dialog().textContent).not.toContain('NaN');
  });
});
