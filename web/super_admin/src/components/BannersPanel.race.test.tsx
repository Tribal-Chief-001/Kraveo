// @vitest-environment jsdom
// Reload races (review L8): an older list answer must never undo a delete, a duplicate or a reorder, and the unsaved order is rebuilt outside
// state updaters (React.StrictMode runs updaters twice, which exposes any hidden side effect).
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { BannersPanel } from './BannersPanel';
import { ApiError, apiService } from '../services/api';
import { parseBanner } from '../lib/bannerParse';
import { byText, click, flush, mount, unmount } from '../test/dom';
import { rawBanner, rawCopy, rawSecond } from '../test/bannerFixtures';

const A = () => parseBanner(rawBanner({ id: 'a', title: 'Alpha', sortOrder: 10, status: 'LIVE', rank: 1, shown: true }))!;
const B = () => parseBanner(rawSecond({ id: 'b', title: 'Bravo', sortOrder: 20 }))!;
const C = () => parseBanner(rawBanner({ id: 'c', title: 'Charlie', sortOrder: 30 }))!;
const D = () => parseBanner(rawBanner({ id: 'd', title: 'Delta', sortOrder: 40 }))!;

const titles = () => (Array.from(document.querySelectorAll('li[data-banner-id] [data-testid="banner-title"]')) as HTMLElement[]).map((e) => e.textContent);
const btn = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const reloadBtn = () => btn('Reload banners');
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const panel = (strict = false) => {
  const el = <BannersPanel onAuthError={vi.fn()} />;
  return strict ? <React.StrictMode>{el}</React.StrictMode> : el;
};
const confirmDelete = async (name: string) => {
  await click(btn(`Delete ${name}`));
  await click(byText('button', 'Delete banner', document.querySelector('[role="alertdialog"]')!));
};

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('BannersPanel: a slow earlier list answer does not undo later changes (L8)', () => {
  it('a reload that started before a delete cannot bring the deleted row back', async () => {
    const slow = deferred<ReturnType<typeof A>[]>();
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValueOnce([A(), B()]).mockReturnValueOnce(slow.promise);
    vi.spyOn(apiService, 'deleteBanner').mockResolvedValue();
    await mount(panel());
    await flush();
    await click(reloadBtn()); // fetch #2 is on its way with a snapshot that still has Alpha
    await confirmDelete('Alpha');
    await flush();
    expect(titles()).toEqual(['Bravo']);
    await act(async () => { slow.resolve([A(), B()]); });
    await flush();
    expect(titles()).toEqual(['Bravo']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(reloadBtn().disabled).toBe(false); // the discarded answer still ends the loading state
  });

  it('while the delete request is still running, a fresh list already leaves the row out (it is being deleted); the delete finishing keeps it gone', async () => {
    const del = deferred<void>();
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([A(), B()]);
    vi.spyOn(apiService, 'deleteBanner').mockReturnValue(del.promise);
    await mount(panel());
    await flush();
    await confirmDelete('Alpha');
    expect(titles()).toEqual(['Alpha', 'Bravo']); // still shown until the server answers
    await click(reloadBtn());
    await flush();
    expect(titles()).toEqual(['Bravo']);
    await act(async () => { del.resolve(); });
    await flush();
    expect(titles()).toEqual(['Bravo']);
  });

  it('after a failed delete the row is shown (the failure triggers a reload)', async () => {
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([A(), B()]);
    vi.spyOn(apiService, 'deleteBanner').mockRejectedValue(new Error('nope'));
    await mount(panel());
    await flush();
    await confirmDelete('Alpha');
    await flush();
    expect(titles()).toEqual(['Alpha', 'Bravo']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Not deleted');
  });

  it('a reload that started before a duplicate cannot drop the new copy', async () => {
    const slow = deferred<ReturnType<typeof A>[]>();
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValueOnce([A(), B()]).mockReturnValueOnce(slow.promise);
    vi.spyOn(apiService, 'duplicateBanner').mockResolvedValue(parseBanner(rawCopy({ id: 'copy', title: 'Alpha (copy)', sortOrder: 50 }))!);
    await mount(panel());
    await flush();
    await click(reloadBtn());
    await click(btn('Duplicate Alpha'));
    await flush();
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Alpha (copy)']);
    await act(async () => { slow.resolve([A(), B()]); });
    await flush();
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Alpha (copy)']);
  });

  it('a reload that started before a reorder was saved cannot put the old order back', async () => {
    const slow = deferred<ReturnType<typeof A>[]>();
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValueOnce([A(), B()]).mockReturnValueOnce(slow.promise);
    vi.spyOn(apiService, 'reorderBanners').mockResolvedValue([B(), A()]);
    await mount(panel());
    await flush();
    await click(reloadBtn());
    await click(btn('Move Alpha down'));
    await click(byText('button', 'Save order', document.body));
    await flush();
    expect(titles()).toEqual(['Bravo', 'Alpha']);
    await act(async () => { slow.resolve([A(), B()]); });
    await flush();
    expect(titles()).toEqual(['Bravo', 'Alpha']);
    expect(document.querySelector('[aria-label="Unsaved order"]')).toBeNull();
  });

  it('only the newest of two overlapping reloads is applied', async () => {
    const first = deferred<ReturnType<typeof A>[]>();
    const second = deferred<ReturnType<typeof A>[]>();
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValueOnce([A(), B()]).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.spyOn(apiService, 'updateBanner').mockRejectedValue(new ApiError(404, 'Banner not found (it may have been deleted).', 'NOT_FOUND'));
    await mount(panel());
    await flush();
    await click(reloadBtn()); // reload #1 (slow)
    await click(document.querySelector('button[role="switch"][aria-label="Bravo: switched on"]')); // 404 -> reload #2
    await flush();
    await act(async () => { second.resolve([A(), B(), C()]); });
    await flush();
    await act(async () => { first.resolve([A()]); }); // the older answer arrives last
    await flush();
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

describe('BannersPanel: unsaved order is rebuilt outside state updaters (L8, StrictMode)', () => {
  it('keeps the admin\'s unsaved order across a reload, drops gone rows, appends new ones - even when React runs updaters twice', async () => {
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([A(), B(), C()]);
    await mount(panel(true));
    await flush();
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await click(btn('Move Alpha down'));
    expect(titles()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    fetch.mockResolvedValue([A(), B(), C(), D()]); // Delta is new
    await click(reloadBtn());
    await flush();
    expect(titles()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
    expect(document.querySelector('[aria-label="Unsaved order"]')).not.toBeNull();
    fetch.mockResolvedValue([A(), C(), D()]); // Bravo was deleted elsewhere: it drops out of the unsaved order
    await click(reloadBtn());
    await flush();
    expect(titles()).toEqual(['Alpha', 'Charlie', 'Delta']);
    expect(document.querySelector('[aria-label="Unsaved order"]')).toBeNull(); // now identical to the server's order
  });

  it('an untouched order follows the server on reload (StrictMode)', async () => {
    const fetch = vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([A(), B()]);
    await mount(panel(true));
    await flush();
    fetch.mockResolvedValue([B(), A(), C()]);
    await click(reloadBtn());
    await flush();
    expect(titles()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(document.querySelector('[aria-label="Unsaved order"]')).toBeNull();
  });

  it('move, discard and save keep working in StrictMode', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([A(), B(), C()]);
    const reorder = vi.spyOn(apiService, 'reorderBanners').mockResolvedValue([B(), C(), A()]);
    await mount(panel(true));
    await flush();
    await click(btn('Move Alpha down'));
    await click(btn('Move Alpha down'));
    expect(titles()).toEqual(['Bravo', 'Charlie', 'Alpha']);
    await click(byText('button', 'Discard', document.body));
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await click(btn('Move Alpha down'));
    await click(btn('Move Alpha down'));
    await click(byText('button', 'Save order', document.body));
    await flush();
    expect(reorder).toHaveBeenCalledWith(['b', 'c', 'a']);
    expect(titles()).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });
});
