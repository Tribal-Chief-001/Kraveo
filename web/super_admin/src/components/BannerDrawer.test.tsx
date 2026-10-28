// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { BannerDrawer } from './BannerDrawer';
import { ApiError, apiService } from '../services/api';
import { parseBanner } from '../lib/bannerParse';
import type { Decoded, ImageEnv } from '../lib/imageCompress';
import { byText, click, flush, mount, type, unmount } from '../test/dom';
import { BANNER_IMG, banner, createAnswer, errorAnswer, rawBanner, rawCreated, uploadPromoOk } from '../test/bannerFixtures';

const field = (suffix: string) => document.querySelector(`[id$="-${suffix}"]`) as HTMLInputElement;
const card = () => document.querySelector('[data-testid="banner-phone"] [data-testid="banner-card"]') as HTMLElement;
const longCard = () => document.querySelector('[data-testid="banner-longtext"] [data-testid="banner-card"]') as HTMLElement;
const save = () => byText('button', /^(Add banner|Save changes)$/, document.body) as HTMLButtonElement;
const saveBtn = () => Array.from(document.querySelectorAll('footer button')).find((b) => /Add banner|Save changes|Saving|Wait for the picture/.test(b.textContent ?? '')) as HTMLButtonElement;
const alerts = () => Array.from(document.querySelectorAll('[role="alert"]')).map((a) => a.textContent);

const render = (over: Record<string, unknown> = {}) => {
  const props = { banner: null, onClose: vi.fn(), onSaved: vi.fn(), onAuthError: vi.fn(), ...over };
  return { props, element: <BannerDrawer {...(props as any)} /> };
};
const apiError = (status: number, code: string, message: string, fieldName?: string) => new ApiError(status, message, code, fieldName);

const fakeEnv = (): ImageEnv => ({
  decode: async () => ({ width: 2400, height: 1200, source: {} } as Decoded),
  encode: vi.fn(async (_d: Decoded, w: number, h: number, mime: string) => ({ size: w * h / 20, type: mime }) as unknown as Blob),
  webpSupported: () => true,
});
const choose = async (file: File) => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
};

const fillValid = async () => {
  await type(field('imageUrl'), BANNER_IMG);
  await type(field('title'), 'Diwali Dhamaka');
};

afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await unmount(); });

describe('BannerDrawer: live phone preview', () => {
  it('starts with placeholders, then follows what the admin types (title, subtitle, colour)', async () => {
    await mount(render().element);
    expect(card().querySelector('[data-testid="banner-card-title"]')!.textContent).toBe('Your title');
    expect(card().querySelector('[data-testid="banner-card-subtitle"]')).toBeNull();
    await type(field('title'), 'Free  delivery   weekend');
    await type(field('subtitle'), 'On orders above 199');
    expect(card().querySelector('[data-testid="banner-card-title"]')!.textContent).toBe('Free  delivery   weekend'.trim());
    expect(card().querySelector('[data-testid="banner-card-subtitle"]')!.textContent).toBe('On orders above 199');
    expect(card().dataset.theme).toBe('DARK');
    const light = document.querySelector('input[type="radio"][value="LIGHT"]') as HTMLInputElement;
    await click(light);
    expect(card().dataset.theme).toBe('LIGHT');
    expect(card().querySelector('.from-white\\/95')).not.toBeNull();
    await click(document.querySelector('input[type="radio"][value="DARK"]'));
    expect(card().querySelector('.from-black\\/85')).not.toBeNull();
  });

  it('draws the 2:1 card with rounded corners, a cover-cropped picture and title / subtitle cut at two lines', async () => {
    await mount(render().element);
    await type(field('imageUrl'), BANNER_IMG);
    await type(field('title'), 'A title');
    await type(field('subtitle'), 'A subtitle');
    expect(card().className).toContain('aspect-[2/1]');
    expect(card().className).toContain('rounded-k-lg');
    const img = card().querySelector('img')!;
    expect(img.getAttribute('src')).toBe(BANNER_IMG);
    expect(img.className).toContain('object-cover');
    expect(card().querySelector('[data-testid="banner-card-title"]')!.className).toContain('line-clamp-2');
    expect(card().querySelector('[data-testid="banner-card-subtitle"]')!.className).toContain('line-clamp-2');
  });

  it('the button pill shows only when there is a link AND button text', async () => {
    await mount(render().element);
    await type(field('ctaLabel'), 'Order now');
    expect(card().querySelector('[data-testid="banner-card-cta"]')).toBeNull();
    await type(field('linkUrl'), 'https://forms.gle/AbC');
    expect(card().querySelector('[data-testid="banner-card-cta"]')!.textContent).toBe('Order now');
    await type(field('ctaLabel'), '');
    expect(card().querySelector('[data-testid="banner-card-cta"]')).toBeNull();
    await type(field('ctaLabel'), 'Order now');
    await type(field('linkUrl'), '');
    expect(card().querySelector('[data-testid="banner-card-cta"]')).toBeNull();
  });

  it('a second small card shows the longest allowed text, with the admin\'s picture and colour', async () => {
    await mount(render().element);
    await type(field('imageUrl'), BANNER_IMG);
    await click(document.querySelector('input[type="radio"][value="LIGHT"]'));
    expect(longCard().dataset.theme).toBe('LIGHT');
    expect(longCard().querySelector('img')!.getAttribute('src')).toBe(BANNER_IMG);
    expect(Array.from(longCard().querySelector('[data-testid="banner-card-title"]')!.textContent!).length).toBe(60);
    expect(Array.from(longCard().querySelector('[data-testid="banner-card-subtitle"]')!.textContent!).length).toBe(120);
    expect(document.querySelector('[data-testid="banner-longtext"]')!.textContent).toContain('sample words, not yours');
  });

  it('a picture that cannot load shows a fallback with a screen-reader note instead of a broken image', async () => {
    await mount(render().element);
    await type(field('imageUrl'), 'https://cdn.example.com/a.jpg');
    await act(async () => { card().querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(card().querySelector('img')).toBeNull();
    expect(card().querySelector('[data-testid="banner-card-nopicture"]')!.textContent).toContain('could not be shown here');
  });

  it('what the admin types is only ever text: markup is shown as typed (and refused on save), never rendered', async () => {
    await mount(render().element);
    await type(field('title'), '<img src=x onerror=alert(1)>');
    await type(field('subtitle'), '<b>bold</b>');
    expect(card().querySelector('img')).toBeNull();
    expect(card().querySelector('b')).toBeNull();
    expect(card().querySelector('[data-testid="banner-card-title"]')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.body.textContent).toContain('The title cannot contain the characters < or >.');
    expect(document.body.textContent).toContain('The subtitle cannot contain the characters < or >.');
  });
});

describe('BannerDrawer: fields and inline validation', () => {
  it('opens as a labelled dialog with the title field focused or the first field; every field has a label', async () => {
    await mount(render().element);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (const suffix of ['imageUrl', 'title', 'subtitle', 'linkUrl', 'ctaLabel', 'startsAt', 'endsAt']) {
      const el = field(suffix);
      expect(document.querySelector(`label[for="${el.id}"]`), suffix).not.toBeNull();
    }
    expect(document.body.textContent).toContain('1200 x 600');
  });

  it('title: counts characters, explains 2 to 60, and clears the message when fixed', async () => {
    await mount(render().element);
    await type(field('title'), 'a');
    expect(document.getElementById(`${field('title').id}-msg`)!.textContent).toBe('The title must be 2 to 60 characters.');
    expect(field('title').getAttribute('aria-invalid')).toBe('true');
    await type(field('title'), 'x'.repeat(61));
    expect(field('title').getAttribute('aria-invalid')).toBe('true');
    await type(field('title'), 'Hello 🎉');
    expect(field('title').getAttribute('aria-invalid')).toBe('false');
    expect(document.getElementById(`${field('title').id}-msg`)!.textContent).toContain('7 of 60 characters');
  });

  it('link: plain reasons while typing (http, javascript:, IP), and Test link only opens a valid https address in a new tab safely', async () => {
    await mount(render().element);
    const test = () => Array.from(document.querySelectorAll('a,button')).find((el) => el.textContent?.startsWith('Test link')) as HTMLElement;
    expect(test().tagName).toBe('BUTTON');
    expect((test() as HTMLButtonElement).disabled).toBe(true);
    await type(field('linkUrl'), 'http://example.com');
    expect(document.getElementById(`${field('linkUrl').id}-msg`)!.textContent).toMatch(/^The link must start with https:\/\//);
    expect(test().tagName).toBe('BUTTON');
    await type(field('linkUrl'), 'javascript:alert(1)');
    expect(field('linkUrl').getAttribute('aria-invalid')).toBe('true');
    expect(test().tagName).toBe('BUTTON');
    await type(field('linkUrl'), 'https://192.168.1.1/x');
    expect(document.getElementById(`${field('linkUrl').id}-msg`)!.textContent).toContain('not an IP address');
    await type(field('linkUrl'), 'https://forms.gle/AbC123');
    expect(field('linkUrl').getAttribute('aria-invalid')).toBe('false');
    expect(test().tagName).toBe('A');
    expect(test().getAttribute('href')).toBe('https://forms.gle/AbC123');
    expect(test().getAttribute('target')).toBe('_blank');
    expect(test().getAttribute('rel')).toBe('noopener noreferrer');
    expect(test().textContent).toContain('opens in a new tab');
    await type(field('linkUrl'), 'https://example.com');
    expect(test().getAttribute('href')).toBe('https://example.com/'); // the address the server will store
  });

  it('button text: up to 20 characters', async () => {
    await mount(render().element);
    await type(field('ctaLabel'), 'z'.repeat(21));
    expect(document.getElementById(`${field('ctaLabel').id}-msg`)!.textContent).toBe('The button text can be at most 20 characters.');
  });

  it('warns (without blocking) when the picture is on a site the dashboard CSP blocks, and not for our own host', async () => {
    await mount(render().element);
    await type(field('imageUrl'), 'https://cdn.example.com/a.jpg');
    const warn = () => Array.from(document.querySelectorAll('[role="status"]')).find((s) => s.textContent?.includes('cdn.example.com'));
    expect(warn()).toBeTruthy();
    expect(warn()!.textContent).toContain('blocks pictures from that site');
    expect(field('imageUrl').getAttribute('aria-invalid')).toBe('false');
    await type(field('imageUrl'), BANNER_IMG);
    expect(warn()).toBeUndefined();
  });

  it('a picture address that is not https is explained', async () => {
    await mount(render().element);
    await type(field('imageUrl'), 'http://example.com/a.jpg');
    expect(document.getElementById(`${field('imageUrl').id}-msg`)!.textContent).toMatch(/^The image address must start with https:\/\//);
  });
});

describe('BannerDrawer: schedule in IST', () => {
  it('labels both pickers with IST, explains empty, and summarises the times in words', async () => {
    await mount(render().element);
    expect(document.body.textContent).toContain('When it shows (India time, IST)');
    expect(document.querySelector(`label[for="${field('startsAt').id}"]`)!.textContent).toBe('Starts (IST)');
    expect(document.querySelector(`label[for="${field('endsAt').id}"]`)!.textContent).toBe('Ends (IST)');
    expect(document.querySelector('[data-testid="banner-when"]')!.textContent).toBe('Always on');
    await type(field('startsAt'), '2026-11-01T18:30');
    expect(document.querySelector('[data-testid="banner-when"]')!.textContent).toBe('From 1 Nov 2026, 6:30 pm IST');
    await type(field('endsAt'), '2026-11-02T00:00');
    expect(document.querySelector('[data-testid="banner-when"]')!.textContent).toBe('1 Nov 2026, 6:30 pm to 2 Nov 2026, 12:00 am IST');
  });

  it('end not after start shows a message at the end field; Clear buttons empty a picker', async () => {
    await mount(render().element);
    await type(field('startsAt'), '2026-11-01T10:00');
    await type(field('endsAt'), '2026-11-01T09:00');
    expect(document.getElementById(`${field('endsAt').id}-msg`)!.textContent).toBe('The end must be after the start.');
    expect(field('endsAt').getAttribute('aria-invalid')).toBe('true');
    await click(document.querySelector('button[aria-label="Clear Ends (IST)"]'));
    expect(field('endsAt').value).toBe('');
    expect(field('endsAt').getAttribute('aria-invalid')).toBe('false');
    expect((document.querySelector('button[aria-label="Clear Ends (IST)"]') as HTMLButtonElement).disabled).toBe(true);
    await click(document.querySelector('button[aria-label="Clear Starts (IST)"]'));
    expect(field('startsAt').value).toBe('');
  });

  it('sends the times as UTC instants: midnight IST is 18:30 UTC the day before', async () => {
    const create = vi.spyOn(apiService, 'createBanner').mockResolvedValue(banner(rawCreated()));
    const { props, element } = render();
    await mount(element);
    await fillValid();
    await type(field('startsAt'), '2026-11-01T00:00');
    await type(field('endsAt'), '2026-11-01T23:59');
    await click(saveBtn());
    await flush();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ startsAt: '2026-10-31T18:30:00.000Z', endsAt: '2026-11-01T18:29:00.000Z' }));
    expect(props.onSaved).toHaveBeenCalled();
  });

  it('editing shows the saved UTC instants as India time', async () => {
    const b = banner({ startsAt: '2026-10-31T18:30:00.000Z', endsAt: '2026-11-01T13:00:00.000Z' });
    await mount(render({ banner: b }).element);
    expect(field('startsAt').value).toBe('2026-11-01T00:00');
    expect(field('endsAt').value).toBe('2026-11-01T18:30');
  });
});

describe('BannerDrawer: saving a new banner', () => {
  it('will not send an empty form: marks the fields, focuses the first one, tells the admin in an alert', async () => {
    const create = vi.spyOn(apiService, 'createBanner');
    await mount(render().element);
    await click(saveBtn());
    expect(create).not.toHaveBeenCalled();
    expect(alerts()).toContain('Some fields need fixing. They are marked below.');
    expect(document.getElementById(`${field('imageUrl').id}-msg`)!.textContent).toContain('Add a picture');
    expect(field('title').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('imageUrl'));
  });

  it('sends only what is filled with defaults (DARK, switched on), then reports the new banner', async () => {
    const create = vi.spyOn(apiService, 'createBanner').mockResolvedValue(banner(rawCreated()));
    const { props, element } = render();
    await mount(element);
    await fillValid();
    await click(saveBtn());
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ title: 'Diwali Dhamaka', imageUrl: BANNER_IMG, theme: 'DARK', isActive: true });
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ title: 'Diwali Dhamaka' }), true, 'Banner added.');
  });

  it('sends every field when all are filled (link normalised like the server, text tidied)', async () => {
    const create = vi.spyOn(apiService, 'createBanner').mockResolvedValue(banner(rawCreated()));
    await mount(render().element);
    await fillValid();
    await type(field('title'), '  Diwali    Dhamaka ');
    await type(field('subtitle'), 'Sweet  deals');
    await type(field('linkUrl'), 'https://example.com');
    await type(field('ctaLabel'), 'Order now');
    await click(document.querySelector('input[type="radio"][value="LIGHT"]'));
    await click(document.querySelector('button[role="switch"][aria-label="Switched on"]'));
    await click(saveBtn());
    await flush();
    expect(create).toHaveBeenCalledWith({ title: 'Diwali Dhamaka', imageUrl: BANNER_IMG, subtitle: 'Sweet deals', linkUrl: 'https://example.com/', ctaLabel: 'Order now', theme: 'LIGHT', isActive: false });
  });

  it('is double-submit safe: the button is disabled and busy while the request runs, a second click sends nothing', async () => {
    let release: (b: any) => void = () => {};
    const create = vi.spyOn(apiService, 'createBanner').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await mount(render().element);
    await fillValid();
    await click(saveBtn());
    await click(saveBtn());
    await act(async () => { field('title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(saveBtn().disabled).toBe(true);
    expect(saveBtn().getAttribute('aria-busy')).toBe('true');
    expect(saveBtn().textContent).toContain('Saving…');
    expect(field('title').closest('fieldset, div')).not.toBeNull();
    await act(async () => { release(banner(rawCreated())); });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('Enter in a text field saves', async () => {
    const create = vi.spyOn(apiService, 'createBanner').mockResolvedValue(banner(rawCreated()));
    await mount(render().element);
    await fillValid();
    await act(async () => { field('title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('BannerDrawer: server errors', () => {
  const cases: Array<[string, string, string, string]> = [
    ['BANNER_LINK_INVALID', 'linkUrl', 'The link must start with https:// (http, javascript:, data:, intent:, market:, mailto:, tel:, file: and app links are not allowed).', 'linkUrl'],
    ['BANNER_IMAGE_INVALID', 'imageUrl', 'The image address must use a real website name, like example.com.', 'imageUrl'],
    ['BANNER_SCHEDULE_INVALID', 'endsAt', 'This end time has already passed. Choose a later end time (or clear it), or keep the banner switched off.', 'endsAt'],
    ['BANNER_SCHEDULE_INVALID', 'startsAt', 'startsAt must be a date and time like 2026-11-01T18:30:00.000Z, or null.', 'startsAt'],
    ['BAD_REQUEST', 'title', 'The title must be 2 to 60 characters.', 'title'],
    ['BAD_REQUEST', 'subtitle', 'The subtitle cannot contain the characters < or >.', 'subtitle'],
    ['BAD_REQUEST', 'ctaLabel', 'The button text can be at most 20 characters.', 'ctaLabel'],
  ];
  it.each(cases)('%s on %s is shown at that field, keeps what was typed and moves focus there', async (code, fieldName, message, suffix) => {
    vi.spyOn(apiService, 'createBanner').mockRejectedValue(apiError(400, code, message, fieldName));
    const { props, element } = render();
    await mount(element);
    await fillValid();
    await click(saveBtn());
    await flush();
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(document.getElementById(`${field(suffix).id}-msg`)!.textContent).toBe(message);
    expect(field(suffix).getAttribute('aria-invalid')).toBe('true');
    expect(field('title').value).toBe('Diwali Dhamaka');
    expect(document.activeElement).toBe(field(suffix));
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onAuthError).toHaveBeenCalled();
    expect(saveBtn().disabled).toBe(false); // can try again
  });

  it('typing again clears the server message of that field', async () => {
    vi.spyOn(apiService, 'createBanner').mockRejectedValue(apiError(400, 'BANNER_LINK_INVALID', 'The link must start with https://', 'linkUrl'));
    await mount(render().element);
    await fillValid();
    await type(field('linkUrl'), 'https://example.com');
    await click(saveBtn());
    await flush();
    expect(field('linkUrl').getAttribute('aria-invalid')).toBe('true');
    await type(field('linkUrl'), 'https://example.org');
    expect(field('linkUrl').getAttribute('aria-invalid')).toBe('false');
  });

  it('BANNER_LIMIT, a lost connection and a 404 appear as one alert at the top, with the server wording', async () => {
    const create = vi.spyOn(apiService, 'createBanner');
    await mount(render().element);
    await fillValid();
    create.mockRejectedValueOnce(apiError(409, 'BANNER_LIMIT', 'There are already 30 banners. Delete one you no longer need first.'));
    await click(saveBtn()); await flush();
    expect(alerts()).toContain('There are already 30 banners. Delete one you no longer need first.');
    create.mockRejectedValueOnce(new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.', 'NETWORK'));
    await click(saveBtn()); await flush();
    expect(alerts()).toEqual(['The operations API is unreachable. Check the network connection and try again.']);
    create.mockRejectedValueOnce(apiError(429, 'RATE_LIMITED', 'Too many changes. Wait a few minutes.'));
    await click(saveBtn()); await flush();
    expect(alerts()).toEqual(['Too many changes. Wait a few minutes.']);
  });

  it('a session problem (401) is handed to the app so it can sign out', async () => {
    vi.spyOn(apiService, 'createBanner').mockRejectedValue(apiError(401, 'UNAUTHORIZED', 'Please sign in again.'));
    const { props, element } = render();
    await mount(element);
    await fillValid();
    await click(saveBtn()); await flush();
    expect(props.onAuthError).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });
});

describe('BannerDrawer: editing', () => {
  it('is filled from the banner, shows the counters as read-only text and has no input for them', async () => {
    const b = banner({ subtitle: 'Sub', linkUrl: 'https://forms.gle/x1', ctaLabel: 'Go', theme: 'LIGHT' });
    await mount(render({ banner: b }).element);
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('Edit “One”');
    expect(field('title').value).toBe('One');
    expect(field('subtitle').value).toBe('Sub');
    expect(field('linkUrl').value).toBe('https://forms.gle/x1');
    expect(field('ctaLabel').value).toBe('Go');
    expect((document.querySelector('input[type="radio"][value="LIGHT"]') as HTMLInputElement).checked).toBe(true);
    expect(card().dataset.theme).toBe('LIGHT');
    expect(document.body.textContent).toContain('Views 40, taps 5. These counters are read-only.');
    expect(document.querySelector('input[name*="view" i], input[id*="view" i], input[id*="click" i]')).toBeNull();
    expect(saveBtn().textContent).toBe('Save changes');
  });

  it('"Nothing was changed" when nothing differs: no request', async () => {
    const update = vi.spyOn(apiService, 'updateBanner');
    const { props, element } = render({ banner: banner() });
    await mount(element);
    await click(saveBtn());
    expect(update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Nothing was changed.');
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('sends only the changed fields', async () => {
    const b = banner();
    const update = vi.spyOn(apiService, 'updateBanner').mockResolvedValue({ banner: parseBanner(rawBanner({ title: 'One!' }))!, changed: true, message: 'Banner saved.' });
    const { props, element } = render({ banner: b });
    await mount(element);
    await type(field('title'), 'One!');
    await click(saveBtn());
    await flush();
    expect(update).toHaveBeenCalledWith(b.id, { title: 'One!' });
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ title: 'One!' }), false, 'Banner saved.');
  });

  it('clearing the subtitle, link and dates sends null for exactly those', async () => {
    const b = banner({ subtitle: 'Sub' });
    const update = vi.spyOn(apiService, 'updateBanner').mockResolvedValue({ banner: b, changed: true, message: 'Banner saved.' });
    await mount(render({ banner: b }).element);
    await type(field('subtitle'), '');
    await type(field('linkUrl'), '');
    await click(document.querySelector('button[aria-label="Clear Starts (IST)"]'));
    await click(document.querySelector('button[aria-label="Clear Ends (IST)"]'));
    await click(saveBtn());
    await flush();
    expect(update).toHaveBeenCalledWith(b.id, { subtitle: null, linkUrl: null, startsAt: null, endsAt: null });
  });

  it('when the server says nothing changed, that is reported as such', async () => {
    const b = banner();
    vi.spyOn(apiService, 'updateBanner').mockResolvedValue({ banner: b, changed: false, message: 'Nothing to change.' });
    const { props, element } = render({ banner: b });
    await mount(element);
    await type(field('title'), 'One ');
    await type(field('subtitle'), 'x');
    await click(saveBtn()); await flush();
    expect(props.onSaved).toHaveBeenCalledWith(expect.anything(), false, 'Nothing to change.');
  });

  it('turning on an expired banner: the server sentence appears at the end field', async () => {
    const b = banner({ isActive: false, status: 'OFF', startsAt: null, endsAt: '2026-10-01T00:00:00.000Z' });
    vi.spyOn(apiService, 'updateBanner').mockRejectedValue(apiError(400, 'BANNER_SCHEDULE_INVALID', 'This end time has already passed. Choose a later end time (or clear it), or keep the banner switched off.', 'endsAt'));
    await mount(render({ banner: b }).element);
    await click(document.querySelector('button[role="switch"][aria-label="Switched on"]'));
    await click(saveBtn()); await flush();
    expect(document.getElementById(`${field('endsAt').id}-msg`)!.textContent).toContain('already passed');
  });
});

describe('BannerDrawer: picture upload', () => {
  it('compresses, uploads with purpose=promo, fills the address and updates the preview; Save waits while it works', async () => {
    let release: (v: any) => void = () => {};
    const upload = vi.spyOn(apiService, 'uploadImage').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const env = fakeEnv();
    await mount(render({ imageEnv: env }).element);
    await choose(new File([new Uint8Array(3000)], 'diwali.jpg', { type: 'image/jpeg' }));
    await flush();
    expect(env.encode).toHaveBeenCalledWith(expect.anything(), 1200, 600, 'image/webp', 0.82);
    expect(upload).toHaveBeenCalledWith(expect.anything(), 'promo');
    expect(saveBtn().disabled).toBe(true);
    expect(saveBtn().textContent).toBe('Wait for the picture…');
    await act(async () => { release({ url: uploadPromoOk.data.url, width: 1200, height: 600, bytes: 68 }); });
    await flush();
    expect(field('imageUrl').value).toBe(uploadPromoOk.data.url);
    expect(card().querySelector('img')!.getAttribute('src')).toBe(uploadPromoOk.data.url);
    expect(saveBtn().disabled).toBe(false);
    expect(document.body.textContent).toContain('Photo uploaded (1200 x 600');
    expect(document.querySelectorAll('[role="dialog"] img').length).toBe(2); // phone + long-text card only: the field's own small preview is hidden
  });

  it('an upload failure is explained in the picture field, with the server wording; a 401 goes to the app', async () => {
    vi.spyOn(apiService, 'uploadImage').mockRejectedValue(apiError(401, 'UNAUTHORIZED', 'Please sign in again.'));
    const { props, element } = render({ imageEnv: fakeEnv() });
    await mount(element);
    await choose(new File([new Uint8Array(3000)], 'diwali.jpg', { type: 'image/jpeg' }));
    await flush();
    expect(props.onAuthError).toHaveBeenCalled();
    expect(alerts()).toContain('Please sign in again.');
  });

  it('the picture cannot be removed from a banner (it is required), only replaced', async () => {
    await mount(render({ banner: banner() }).element);
    expect(byText('button', 'Replace photo', document.body)).toBeTruthy();
    expect(byText('button', 'Remove photo', document.body)).toBeUndefined();
  });
});

describe('BannerDrawer: keyboard and focus', () => {
  it('Escape closes it, Cancel closes it, and nothing is sent', async () => {
    const create = vi.spyOn(apiService, 'createBanner');
    const { props, element } = render();
    await mount(element);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await click(byText('button', 'Cancel', document.body));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });

  it('the notice region announces problems politely and the save outcome is reachable by screen readers', async () => {
    await mount(render({ banner: banner() }).element);
    await click(saveBtn());
    const notice = Array.from(document.querySelectorAll('[aria-live="polite"]')).find((n) => n.textContent === 'Nothing was changed.');
    expect(notice).toBeTruthy();
    expect(notice!.getAttribute('role')).toBe('status');
  });
});
