// @vitest-environment jsdom
// Review L7: the result of a save that belongs to an OLDER opening of the drawer must not close a drawer opened since.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const opened: any[] = [];
vi.mock('./BannerDrawer', () => ({
  BannerDrawer: (props: any) => { opened.push(props); return <div data-testid="fake-drawer">{props.banner ? `edit ${props.banner.title}` : 'new banner'}</div>; },
}));

import { BannersPanel } from './BannersPanel';
import { apiService } from '../services/api';
import { parseBanner } from '../lib/bannerParse';
import { act } from 'react';
import { byText, click, flush, mount, unmount } from '../test/dom';
import { rawBanner } from '../test/bannerFixtures';

afterEach(async () => { vi.restoreAllMocks(); opened.length = 0; await unmount(); });

describe('BannersPanel drawer sessions (L7)', () => {
  it('a stale onSaved updates the list and toasts but leaves the newer drawer open', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([parseBanner(rawBanner())!]);
    await mount(<BannersPanel onAuthError={vi.fn()} />);
    await flush();
    await click(document.querySelector('button[aria-label="Edit One"]'));
    const first = opened[opened.length - 1];
    expect(document.querySelector('[data-testid="fake-drawer"]')!.textContent).toBe('edit One');
    await act(async () => { first.onClose(); });
    expect(document.querySelector('[data-testid="fake-drawer"]')).toBeNull();
    await click(byText('button', 'Add banner', document.body));
    expect(document.querySelector('[data-testid="fake-drawer"]')!.textContent).toBe('new banner');
    // the old save finishes now
    await act(async () => { first.onSaved(parseBanner(rawBanner({ title: 'One renamed' }))!, false, 'Banner saved.'); });
    expect(document.querySelector('[data-testid="fake-drawer"]')!.textContent).toBe('new banner');
    expect(document.body.textContent).toContain('Banner saved');
  });

  it('the save of the CURRENT drawer closes it', async () => {
    vi.spyOn(apiService, 'fetchBanners').mockResolvedValue([parseBanner(rawBanner())!]);
    await mount(<BannersPanel onAuthError={vi.fn()} />);
    await flush();
    await click(document.querySelector('button[aria-label="Edit One"]'));
    const current = opened[opened.length - 1];
    await act(async () => { current.onSaved(parseBanner(rawBanner())!, false, 'Nothing to change.'); });
    expect(document.querySelector('[data-testid="fake-drawer"]')).toBeNull();
  });
});
