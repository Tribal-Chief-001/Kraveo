// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { BannersPanel } from './BannersPanel';
import { ApiError, apiService } from '../services/api';
import { parseBanner } from '../lib/bannerParse';
import { byText, click, flush, mount, type, unmount } from '../test/dom';
import { BANNER_IMG, banner, rawBanner, rawCopy, rawCreated, rawSecond } from '../test/bannerFixtures';

const SCHEDULED = () => banner();
const LIVE = () => parseBanner(rawSecond())!;
const OFF = () => parseBanner(rawCopy())!;
const EXPIRED = () => parseBanner(rawBanner({ id: 'exp-1', title: 'Old offer', status: 'EXPIRED', startsAt: null, endsAt: '2026-10-01T10:00:00.000Z', viewCount: 200, clickCount: 300, ctr: 150, sortOrder: 40, linkUrl: null }))!;

const render = (over: Record<string, unknown> = {}) => {
  const props = { onAuthError: vi.fn(), ...over };
  return { props, element: <BannersPanel {...(props as any)} /> };
};
const rows = () => Array.from(document.querySelectorAll('li[data-banner-id]')) as HTMLElement[];
const titles = () => rows().map((r) => r.querySelector('[data-testid="banner-title"]')!.textContent);
const rowOf = (title: string) => rows().find((r) => r.querySelector('[data-testid="banner-title"]')!.textContent === title)!;
const sw = (title: string) => document.querySelector(`button[role="switch"][aria-label="${title}: switched on"]`) as HTMLButtonElement;
const btn = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const four = () => [SCHEDULED(), LIVE(), OFF(), EXPIRED()];
const bodyText = () => document.body.textContent ?? '';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('BannersPanel list', () => {
  it('shows thumbnail, title, status chip, IST schedule, views, taps, CTR, switch and actions for each banner', async () => {
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue(four());
    await mount(render().element);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(['One', 'Second', 'Launch (copy)', 'Old offer']);
    const chips = rows().map((r) => r.querySelector('[data-testid="banner-status"]')!.textContent);
    expect(chips).toEqual(['Scheduled', 'Live', 'Off', 'Expired']);
    const one = rowOf('One');
    expect(one.querySelector('img')!.getAttribute('src')).toBe(BANNER_IMG);
    expect(one.querySelector('[data-testid="banner-schedule"]')!.textContent).toBe('1 Nov 2026, 3:20 pm to 1 Nov 2026, 3:40 pm IST');
    expect(one.querySelector('[data-testid="banner-views"]')!.textContent).toBe('40');
    expect(one.querySelector('[data-testid="banner-taps"]')!.textContent).toBe('5');
    expect(one.querySelector('[data-testid="banner-ctr"]')!.textContent).toBe('12.5%');
    expect(one.textContent).toContain('https://forms.gle/x1');
    expect(rowOf('Second').querySelector('[data-testid="banner-schedule"]')!.textContent).toBe('Always on');
    expect(rowOf('Second').querySelector('[data-testid="banner-ctr"]')!.textContent).toBe('-'); // no views: a dash, not 0 or NaN
    expect(rowOf('Second').textContent).toContain('No link (display only)');
    expect(rowOf('Old offer').querySelector('[data-testid="banner-ctr"]')!.textContent).toBe('150%');
    expect(rowOf('Old offer').querySelector('[data-testid="banner-schedule"]')!.textContent).toBe('Until 1 Oct 2026, 3:30 pm IST');
    expect(sw('One').getAttribute('aria-checked')).toBe('true');
    expect(sw('Launch (copy)').getAttribute('aria-checked')).toBe('false');
    for (const name of ['Edit One', 'Duplicate One', 'Delete One', 'Move One down']) expect(btn(name), name).toBeTruthy();
    expect(bodyText()).not.toContain('NaN');
    expect(bodyText()).not.toContain('undefined');
  });

  it('a thumbnail that fails to load (picture on a blocked site) shows a placeholder, not a broken image', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED()]);
    await mount(render().element);
    await flush();
    await act(async () => { rowOf('One').querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(rowOf('One').querySelector('img')).toBeNull();
    expect(rowOf('One').textContent).toContain('Picture cannot be shown here');
  });

  it('explains what banners are, in plain words, and what the chips mean', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED()]);
    await mount(render().element);
    await flush();
    expect(bodyText()).toContain('The pictures that slide across the top of the customer app Home');
    expect(bodyText()).toContain('The app shows at most 10 at once');
    expect(bodyText()).toContain('Live = showing now. Scheduled = waiting for its start. Expired = its end has passed. Off = switched off.');
    expect(bodyText()).toContain('Times are in India time (IST)');
  });

  it('an empty list explains banners and offers the first one', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([]);
    await mount(render().element);
    await flush();
    expect(bodyText()).toContain('No banners yet');
    expect(bodyText()).toContain('Banners are the pictures that slide across the top of the customer app Home');
    expect(document.querySelectorAll('button').length).toBeGreaterThan(0);
    const adds = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === 'Add banner');
    expect(adds.length).toBe(2);
    await click(adds[1]);
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('Add a banner');
  });

  it('shows a loading state, then an error with Try again that reloads; a 401 is handed to the app', async () => {
    let call = 0;
    let fail: (e: unknown) => void = () => {};
    vi.spyOn(apiService, 'fetchBanners').mockImplementation(() => {
      call++;
      if (call === 1) return new Promise((_resolve, reject) => { fail = reject; });
      return Promise.resolve([SCHEDULED()]);
    });
    const { props, element } = render();
    const host = await mount(element);
    expect(host.querySelector('[aria-label="Loading"]')).not.toBeNull();
    await act(async () => { fail(new ApiError(401, 'Please sign in again.', 'UNAUTHORIZED')); });
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Please sign in again.');
    expect(props.onAuthError).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    await click(byText('button', 'Try again', host));
    await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(titles()).toEqual(['One']);
  });

  it('a network failure says so in plain words', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockRejectedValue(new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.', 'NETWORK'));
    const host = await mount(render().element);
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('unreachable');
  });

  it('at 30 banners the Add button is off and the limit is explained; Duplicate is off too', async () => {
    const many = Array.from({ length: 30 }, (_, i) => parseBanner(rawBanner({ id: `b-${i}`, title: `Banner ${i}`, sortOrder: (i + 1) * 10 }))!);
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue(many);
    await mount(render().element);
    await flush();
    const add = byText('button', 'Add banner', document.body) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('aria-describedby')).toBe('banner-limit');
    expect(document.getElementById('banner-limit')!.textContent).toContain('There are already 30 banners, which is the limit.');
    expect(btn('Duplicate Banner 0').disabled).toBe(true);
  });

  it('with 29 banners Add still works', async () => {
    const many = Array.from({ length: 29 }, (_, i) => parseBanner(rawBanner({ id: `b-${i}`, title: `Banner ${i}` }))!);
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue(many);
    await mount(render().element);
    await flush();
    expect((byText('button', 'Add banner', document.body) as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('banner-limit')).toBeNull();
  });
});

describe('BannersPanel active switch', () => {
  it('is not optimistic: disabled while the request runs, changes only after the server answers', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED(), LIVE()]);
    let release: (v: any) => void = () => {};
    const update = vi.spyOn(apiService, 'updateBanner').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await mount(render().element);
    await flush();
    await click(sw('One'));
    expect(update).toHaveBeenCalledWith(SCHEDULED().id, { isActive: false });
    expect(sw('One').disabled).toBe(true);
    expect(sw('One').getAttribute('aria-checked')).toBe('true'); // still what the server has
    await click(sw('One'));
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => { release({ banner: parseBanner(rawBanner({ isActive: false, status: 'OFF' }))!, changed: true, message: 'Banner saved.' }); });
    await flush();
    expect(sw('One').disabled).toBe(false);
    expect(sw('One').getAttribute('aria-checked')).toBe('false');
    expect(rowOf('One').querySelector('[data-testid="banner-status"]')!.textContent).toBe('Off');
    expect(sw('Second').getAttribute('aria-checked')).toBe('true'); // others untouched
  });

  it('when the server refuses (expired rule) its message is shown and the switch stays as it was', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([EXPIRED(), OFF()]);
    const message = 'This end time has already passed. Choose a later end time (or clear it), or keep the banner switched off.';
    vi.spyOn(apiService, 'updateBanner').mockRejectedValue(new ApiError(400, message, 'BANNER_SCHEDULE_INVALID', 'endsAt'));
    await mount(render().element);
    await flush();
    await click(sw('Launch (copy)'));
    await flush();
    expect(bodyText()).toContain('Not changed');
    expect(bodyText()).toContain(message);
    expect(sw('Launch (copy)').getAttribute('aria-checked')).toBe('false');
    expect(sw('Launch (copy)').disabled).toBe(false);
  });

  it('a 404 (deleted in another tab) reloads the list; a 401 goes to the app', async () => {
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED()]);
    vi.spyOn(apiService, 'updateBanner').mockRejectedValue(new ApiError(404, 'Banner not found (it may have been deleted).', 'NOT_FOUND'));
    const { props, element } = render();
    await mount(element);
    await flush();
    await click(sw('One'));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(props.onAuthError).toHaveBeenCalled();
  });
});

describe('BannersPanel reorder', () => {
  const setup = async () => {
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED(), LIVE(), OFF()]);
    const reorder = vi.spyOn(apiService, 'reorderBanners');
    const view = render();
    await mount(view.element);
    await flush();
    return { fetch, reorder, ...view };
  };

  it('the first row cannot go up and the last cannot go down', async () => {
    await setup();
    expect(btn('Move One up').disabled).toBe(true);
    expect(btn('Move One down').disabled).toBe(false);
    expect(btn('Move Launch (copy) down').disabled).toBe(true);
  });

  it('moving a row shows the Save order / Discard bar, announces the move and keeps keyboard focus on the same button', async () => {
    await setup();
    expect(document.querySelector('[aria-label="Unsaved order"]')).toBeNull();
    btn('Move One down').focus();
    await click(btn('Move One down'));
    expect(titles()).toEqual(['Second', 'One', 'Launch (copy)']);
    expect(document.querySelector('[aria-label="Unsaved order"]')!.textContent).toContain('The order has changed and is not saved yet.');
    expect(byText('button', 'Save order', document.body)).toBeTruthy();
    expect(byText('button', 'Discard', document.body)).toBeTruthy();
    expect(document.activeElement).toBe(btn('Move One down'));
    expect(Array.from(document.querySelectorAll('[aria-live="polite"]')).some((n) => n.textContent === 'One moved to position 2 of 3.')).toBe(true);
    // moving to the end: the "down" button is now disabled, so focus goes to "up"
    await click(btn('Move One down'));
    expect(titles()).toEqual(['Second', 'Launch (copy)', 'One']);
    expect(document.activeElement).toBe(btn('Move One up'));
  });

  it('Discard puts the saved order back, no request', async () => {
    const { reorder } = await setup();
    await click(btn('Move One down'));
    await click(byText('button', 'Discard', document.body));
    expect(titles()).toEqual(['One', 'Second', 'Launch (copy)']);
    expect(document.querySelector('[aria-label="Unsaved order"]')).toBeNull();
    expect(reorder).not.toHaveBeenCalled();
  });

  it('moving a row back to where it was removes the bar', async () => {
    await setup();
    await click(btn('Move One down'));
    await click(btn('Move One up'));
    expect(document.querySelector('[aria-label="Unsaved order"]')).toBeNull();
  });

  it('Save order sends all ids in the new order, shows Saving…, and takes the server\'s list', async () => {
    const { reorder } = await setup();
    let release: (v: any) => void = () => {};
    reorder.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await click(btn('Move One down'));
    await click(byText('button', 'Save order', document.body));
    expect(reorder).toHaveBeenCalledWith([LIVE().id, SCHEDULED().id, OFF().id]);
    expect(byText('button', 'Saving…', document.body)!.getAttribute('aria-busy')).toBe('true');
    expect(btn('Move One up').disabled).toBe(true); // rows are locked while saving
    await click(byText('button', 'Saving…', document.body)); // second click does nothing
    expect(reorder).toHaveBeenCalledTimes(1);
    await act(async () => { release([parseBanner(rawSecond({ sortOrder: 10 }))!, parseBanner(rawBanner({ sortOrder: 20 }))!, OFF()]); });
    await flush();
    expect(document.querySelector('[aria-label="Unsaved order"]')).toBeNull();
    expect(titles()).toEqual(['Second', 'One', 'Launch (copy)']);
    expect(bodyText()).toContain('Order saved');
    expect(Array.from(document.querySelectorAll('[aria-live="polite"]')).some((n) => n.textContent === 'Order saved.')).toBe(true);
  });

  it('a failed save keeps the admin\'s order and the bar, and shows the server message', async () => {
    const { reorder } = await setup();
    reorder.mockRejectedValue(new ApiError(429, 'Too many changes. Wait a few minutes.', 'RATE_LIMITED'));
    await click(btn('Move One down'));
    await click(byText('button', 'Save order', document.body));
    await flush();
    expect(titles()).toEqual(['Second', 'One', 'Launch (copy)']);
    expect(document.querySelector('[aria-label="Unsaved order"]')).not.toBeNull();
    expect(bodyText()).toContain('Order not saved');
    expect(bodyText()).toContain('Too many changes. Wait a few minutes.');
  });

  it('BANNER_UNKNOWN (a banner was deleted meanwhile) reloads the list', async () => {
    const { reorder, fetch } = await setup();
    reorder.mockRejectedValue(new ApiError(400, 'A banner in the list no longer exists. Reload the list.', 'BANNER_UNKNOWN', 'ids'));
    await click(btn('Move One down'));
    await click(byText('button', 'Save order', document.body));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('an unsaved order survives a reload; banners that are gone drop out, new ones go to the end', async () => {
    const { fetch } = await setup();
    await click(btn('Move One down'));
    fetch.mockResolvedValue([SCHEDULED(), LIVE(), parseBanner(rawBanner({ id: 'new-1', title: 'Newest' }))!]);
    await click(document.querySelector('button[aria-label="Reload banners"]'));
    await flush();
    expect(titles()).toEqual(['Second', 'One', 'Newest']);
  });
});

describe('BannersPanel add and edit', () => {
  it('Add banner opens the drawer; saving adds the row at the end, toasts and refreshes the list', async () => {
    const created = parseBanner(rawCreated())!;
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValueOnce([SCHEDULED()]).mockResolvedValue([SCHEDULED(), created]);
    vi.spyOn(apiService, 'createBanner').mockResolvedValue(created);
    await mount(render().element);
    await flush();
    await click(byText('button', 'Add banner', document.body));
    const title = document.querySelector('[id$="-title"]') as HTMLInputElement;
    await type(document.querySelector('[id$="-imageUrl"]'), BANNER_IMG);
    await type(title, 'Diwali Dhamaka');
    await click(byText('button', 'Add banner', document.querySelector('footer')!));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(titles()).toEqual(['One', 'Diwali Dhamaka']);
    expect(bodyText()).toContain('Banner added');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Edit opens the drawer for that banner; saving updates the row and shows a toast', async () => {
    const renamed = parseBanner(rawSecond({ title: 'Second!' }))!;
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValueOnce([SCHEDULED(), LIVE()]).mockResolvedValue([SCHEDULED(), renamed]);
    const update = vi.spyOn(apiService, 'updateBanner').mockResolvedValue({ banner: renamed, changed: true, message: 'Banner saved.' });
    await mount(render().element);
    await flush();
    await click(btn('Edit Second'));
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('Edit “Second”');
    await type(document.querySelector('[id$="-title"]'), 'Second!');
    await click(byText('button', 'Save changes', document.querySelector('footer')!));
    await flush();
    expect(update).toHaveBeenCalledWith(LIVE().id, { title: 'Second!' });
    expect(titles()).toContain('Second!');
    expect(bodyText()).toContain('Banner saved');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('an edit that only differs in spaces is "Nothing was changed" inside the drawer: nothing is sent', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([LIVE()]);
    vi.spyOn(apiService, 'updateBanner').mockResolvedValue({ banner: LIVE(), changed: false, message: 'Nothing to change.' });
    await mount(render().element);
    await flush();
    await click(btn('Edit Second'));
    await type(document.querySelector('[id$="-title"]'), 'Second  ');
    await type(document.querySelector('[id$="-subtitle"]'), 'Sub ');
    await type(document.querySelector('[id$="-ctaLabel"]'), 'x');
    await type(document.querySelector('[id$="-ctaLabel"]'), '');
    await click(byText('button', 'Save changes', document.querySelector('footer')!));
    await flush();
    // same values after tidying -> the drawer itself says nothing changed and sends nothing
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(bodyText()).toContain('Nothing was changed.');
  });

  it('focus returns to the button that opened the drawer when it closes', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([LIVE()]);
    await mount(render().element);
    await flush();
    btn('Edit Second').focus();
    await click(btn('Edit Second'));
    await click(byText('button', 'Cancel', document.body));
    expect(document.activeElement).toBe(btn('Edit Second'));
  });
});

describe('BannersPanel duplicate and delete', () => {
  it('Duplicate adds the switched-off copy at the end and tells the admin it is off', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED()]);
    const dup = vi.spyOn(apiService, 'duplicateBanner').mockResolvedValue(OFF());
    await mount(render().element);
    await flush();
    await click(btn('Duplicate One'));
    await flush();
    expect(dup).toHaveBeenCalledWith(SCHEDULED().id);
    expect(titles()).toEqual(['One', 'Launch (copy)']);
    expect(rowOf('Launch (copy)').querySelector('[data-testid="banner-status"]')!.textContent).toBe('Off');
    expect(bodyText()).toContain('It is switched off until you turn it on.');
  });

  it('Duplicate while busy does nothing twice; BANNER_LIMIT is explained and the list reloads', async () => {
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED()]);
    const dup = vi.spyOn(apiService, 'duplicateBanner').mockRejectedValue(new ApiError(409, 'There are already 30 banners. Delete one you no longer need first.', 'BANNER_LIMIT'));
    await mount(render().element);
    await flush();
    await click(btn('Duplicate One'));
    await flush();
    expect(dup).toHaveBeenCalledTimes(1);
    expect(bodyText()).toContain('Not copied');
    expect(bodyText()).toContain('There are already 30 banners.');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Delete asks first (Cancel is focused, says it cannot be undone); Cancel deletes nothing', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED(), LIVE()]);
    const del = vi.spyOn(apiService, 'deleteBanner').mockResolvedValue();
    await mount(render().element);
    await flush();
    await click(btn('Delete One'));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Delete “One”?');
    expect(dialog.textContent).toContain('This cannot be undone.');
    expect(dialog.textContent).toContain('switch it off instead');
    expect(document.activeElement!.textContent).toBe('Cancel');
    expect(del).not.toHaveBeenCalled();
    await click(byText('button', 'Cancel', dialog));
    expect(del).not.toHaveBeenCalled();
    expect(titles()).toEqual(['One', 'Second']);
  });

  it('confirming deletes the banner and removes the row', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED(), LIVE()]);
    const del = vi.spyOn(apiService, 'deleteBanner').mockResolvedValue();
    await mount(render().element);
    await flush();
    await click(btn('Delete One'));
    await click(byText('button', 'Delete banner', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(del).toHaveBeenCalledWith(SCHEDULED().id);
    expect(titles()).toEqual(['Second']);
    expect(bodyText()).toContain('Banner deleted');
  });

  it('a failed delete keeps the row and shows why', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([SCHEDULED()]);
    vi.spyOn(apiService, 'deleteBanner').mockRejectedValue(new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.', 'NETWORK'));
    await mount(render().element);
    await flush();
    await click(btn('Delete One'));
    await click(byText('button', 'Delete banner', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(titles()).toEqual(['One']);
    expect(bodyText()).toContain('Not deleted');
    expect(bodyText()).toContain('unreachable');
    expect(sw('One').disabled).toBe(false);
  });
});

describe('BannersPanel at phone width (360 px)', () => {
  it('rows stack into one column, controls keep a tappable size, nothing is a fixed wide box, and the long text wraps', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    const long = parseBanner(rawBanner({ id: 'long', title: 'W'.repeat(60), subtitle: 'S'.repeat(120), linkUrl: `https://example.com/${'p'.repeat(300)}` }))!;
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([long, LIVE()]);
    await mount(render().element);
    await flush();
    const li = rows()[0];
    expect(li.className).toContain('flex-col');
    expect(li.className).toContain('md:flex-row'); // row layout only from 768 px up
    expect(li.querySelector('[data-testid="banner-title"]')!.className).toContain('break-words');
    expect(li.querySelector('p.break-all')).not.toBeNull(); // the long link wraps instead of pushing the page sideways
    const all = Array.from(document.querySelectorAll('[class]')) as HTMLElement[];
    const wide = all.filter((el) => /(^|\s)(w|min-w)-\[(\d+)px\]/.test(el.className) && Number(/(^|\s)(?:w|min-w)-\[(\d+)px\]/.exec(el.className)![2]) > 340);
    expect(wide.map((el) => el.className)).toEqual([]);
    for (const b of Array.from(li.querySelectorAll('button')) as HTMLButtonElement[]) expect(b.className).toMatch(/k-btn|k-icon-btn|rounded-full/);
  });

  it('the drawer is a full-width bottom sheet on a phone and the preview is capped at 300 px', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([LIVE()]);
    await mount(render().element);
    await flush();
    await click(btn('Edit Second'));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain('w-full');
    expect(dialog.className).toContain('max-h-[92vh]');
    expect(document.querySelector('[data-testid="banner-phone"]')!.className).toContain('max-w-[300px]');
    expect(document.querySelector('[data-testid="banner-longtext"]')!.className).toContain('max-w-[200px]');
    expect(document.querySelector('footer')).not.toBeNull(); // Save / Cancel stay visible outside the scrolling area
  });
});
