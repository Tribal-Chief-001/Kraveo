import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_IMAGE_HOSTS, changesOf, checkHttpsAddress, createBody, ctrText, emptyForm, formFromBanner, formatIst, imageHostWarning, instantToIst, istToInstant, parseBanner,
  parseBannerList, parseBannerResult, scheduleText, statusOf, validateCta, validateImageUrl, validateLink, validateSchedule, validateSubtitle, validateTitle,
} from './bannerParse';
import vercelJson from '../../vercel.json?raw';
import { banner, copyAnswer, createAnswer, patchAnswer, rawBanner, rawBannerList, rawCopy, rawCreated, rawSecond } from '../test/bannerFixtures';

const ch = (code: number) => String.fromCharCode(code);
// The project has no Node type definitions (and adds none): reach the process object without them.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

describe('parseBanner / parseBannerList (real admin shapes)', () => {
  it('reads the section 7.2 admin row field by field', () => {
    expect(parseBanner(rawBanner())).toEqual({
      id: 'dd002330-7627-4565-8199-a55a758f1411', title: 'One', subtitle: null, imageUrl: 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg',
      linkUrl: 'https://forms.gle/x1', ctaLabel: 'Go', theme: 'DARK', isActive: true, startsAt: '2026-11-01T09:50:00.000Z', endsAt: '2026-11-01T10:10:00.000Z',
      sortOrder: 10, viewCount: 40, clickCount: 5, ctr: 12.5, status: 'SCHEDULED', rank: null, shown: false,
    });
  });

  it('reads the list answer, drops rows without an id, and says null when the answer is not a list', () => {
    expect(parseBannerList(rawBannerList())!.map((b) => b.title)).toEqual(['One', 'Second']);
    expect(parseBannerList({ data: [rawBanner(), { title: 'no id' }, null, 5] })!).toHaveLength(1);
    expect(parseBannerList([rawBanner()])).toHaveLength(1);
    expect(parseBannerList({ success: true })).toBeNull();
    expect(parseBannerList(null)).toBeNull();
    expect(parseBannerList('x')).toBeNull();
  });

  it('never gives NaN or throws: missing, null, negative or text numbers become 0, missing text a placeholder', () => {
    const b = parseBanner({ id: 'x', viewCount: 'lots', clickCount: -3, sortOrder: 'abc', ctr: 'n/a', title: '  ', imageUrl: 5, theme: 'PINK', startsAt: 'soon', endsAt: 12 })!;
    expect(b).toMatchObject({ id: 'x', title: 'Untitled banner', imageUrl: '', theme: 'DARK', viewCount: 0, clickCount: 0, sortOrder: 0, ctr: null, startsAt: null, endsAt: null, isActive: false, status: 'OFF' });
    for (const value of Object.values(b)) expect(typeof value === 'number' ? Number.isNaN(value) : false).toBe(false);
    expect(parseBanner(undefined)).toBeNull();
    expect(parseBanner([])).toBeNull();
    expect(parseBanner({ id: '' })).toBeNull();
    expect(parseBanner({ id: 7 })!.id).toBe('7');
  });

  it('numbers given as text are read; a missing ctr is derived from the counters, a missing status from the schedule (no invented numbers)', () => {
    expect(parseBanner({ id: 'a', viewCount: '40', clickCount: '5' })!).toMatchObject({ viewCount: 40, clickCount: 5, ctr: 12.5 });
    expect(parseBanner({ id: 'a', viewCount: 0, clickCount: 3 })!.ctr).toBeNull();
    expect(parseBanner({ id: 'a', isActive: true })!.status).toBe('LIVE');
    expect(parseBanner({ id: 'a', isActive: true, status: 'WEIRD', endsAt: '2000-01-01T00:00:00.000Z' })!.status).toBe('EXPIRED');
    expect(parseBanner(rawBanner({ ctr: 150 }))!.ctr).toBe(150); // can pass 100: clicks are counted without a matching view
  });

  it('an unknown theme falls back to DARK, LIGHT is kept, and the text fields are trimmed', () => {
    expect(parseBanner(rawBanner({ theme: 'LIGHT' }))!.theme).toBe('LIGHT');
    expect(parseBanner(rawBanner({ subtitle: '  hi  ', linkUrl: '   ' }))).toMatchObject({ subtitle: 'hi', linkUrl: null });
  });

  it('create, patch and duplicate answers', () => {
    expect(parseBannerResult(createAnswer(rawCreated()))).toMatchObject({ banner: { title: 'Diwali Dhamaka', status: 'LIVE', ctr: null }, changed: true, message: 'Banner created.' });
    expect(parseBannerResult(patchAnswer(rawBanner(), false))).toMatchObject({ changed: false, message: 'Nothing to change.' });
    expect(parseBannerResult(copyAnswer(rawCopy()))).toMatchObject({ banner: { title: 'Launch (copy)', isActive: false, status: 'OFF' } });
    expect(parseBannerResult({})).toEqual({ banner: null, changed: true, message: '' });
    expect(parseBannerResult(null).banner).toBeNull();
  });
});

describe('rank / shown (the app shows only the first 10 live banners)', () => {
  it('reads rank and shown from the real rows around the cut line', () => {
    expect(parseBanner(rawBanner({ status: 'LIVE', rank: 10, shown: true }))).toMatchObject({ rank: 10, shown: true });
    expect(parseBanner(rawBanner({ status: 'LIVE', rank: 11, shown: false }))).toMatchObject({ rank: 11, shown: false });
    expect(parseBanner(rawBanner({ status: 'OFF', rank: null, shown: false }))).toMatchObject({ rank: null, shown: false });
  });
  it('an older server without these fields: live counts as shown, others do not; junk never gives NaN', () => {
    const { rank, shown, ...old } = rawBanner({ status: 'LIVE' });
    void rank; void shown;
    expect(parseBanner(old)).toMatchObject({ rank: null, shown: true });
    expect(parseBanner({ ...old, status: 'SCHEDULED' })).toMatchObject({ rank: null, shown: false });
    expect(parseBanner(rawBanner({ rank: 'x', shown: 'yes', status: 'LIVE' }))).toMatchObject({ rank: null, shown: true });
    expect(parseBanner(rawBanner({ rank: -2 }))!.rank).toBeNull();
    expect(parseBanner(rawBanner({ rank: 3.9 }))!.rank).toBe(3);
  });
});

describe('statusOf / ctrText', () => {
  const now = Date.parse('2026-11-01T10:00:00.000Z');
  it('OFF beats everything, then EXPIRED, SCHEDULED, LIVE; start inclusive, end exclusive', () => {
    expect(statusOf({ isActive: false, startsAt: null, endsAt: '2000-01-01T00:00:00.000Z' }, now)).toBe('OFF');
    expect(statusOf({ isActive: true, startsAt: null, endsAt: '2026-11-01T10:00:00.000Z' }, now)).toBe('EXPIRED');
    expect(statusOf({ isActive: true, startsAt: '2026-11-01T10:00:00.001Z', endsAt: null }, now)).toBe('SCHEDULED');
    expect(statusOf({ isActive: true, startsAt: '2026-11-01T10:00:00.000Z', endsAt: '2026-11-01T10:00:00.001Z' }, now)).toBe('LIVE');
  });
  it('ctr shows a dash while there are no views', () => {
    expect(ctrText(banner({ ctr: null, viewCount: 0, clickCount: 0 }))).toBe('-');
    expect(ctrText(banner({ ctr: 12.5 }))).toBe('12.5%');
    expect(ctrText(banner({ ctr: 0 }))).toBe('0%');
  });
});

describe('link validator: parity with backend/test/e2e/home_banners.test.ts', () => {
  // Copied from the server test's BAD_LINKS (the text ones; numbers, booleans, arrays and objects cannot be typed into a text box).
  const BAD_LINKS: string[] = [
    'http://example.com/', 'HTTP://example.com/', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'intent://scan/#Intent;scheme=zxing;package=com.google.zxing;end', 'market://details?id=com.kraveo.customer', 'mailto:a@b.com', 'tel:+911234567890',
    'file:///etc/passwd', 'ftp://example.com/x', 'myapp://open', 'blob:https://example.com/x', 'about:blank', 'vbscript:x', 'sms:+911234567890',
    'https://127.0.0.1/', 'https://10.0.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://[2001:db8::1]/', 'https://localhost/', 'https://localhost./',
    'https://app.localhost/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://0177.0.0.1/', 'https://127.1/', 'https://example/', 'https://example.com:8443/',
    'https://user:pass@example.com/', 'https://user@example.com/', 'https://:pass@example.com/', 'https://exa mple.com/', 'https://example.com/a b',
    'https://example.com/\nx', 'https://example.com/a\tb', `https://example.com/a${ch(0)}b`, `https://example.com/${ch(0x200b)}`, `https://example.com/${ch(0x202e)}`, 'https://example.com/\\evil',
    'https:example.com', 'https:/example.com', 'https:\\\\example.com', '//example.com', 'example.com', 'www.example.com', 'https://', 'https://.com',
    'https://exa..mple.com', 'https://-bad.com', 'https://a.com/' + 'x'.repeat(500),
  ];

  it.each(BAD_LINKS.map((l) => [l.slice(0, 50), l]))('refuses %j with a plain reason', (_name, link) => {
    // Outer white space is trimmed by the server too, so "\n" inside the text is what matters; a trailing-only newline case is in GOOD below.
    const message = validateLink(link);
    expect(message).not.toBe('');
    expect(message).toMatch(/^The link /);
    expect(message).not.toMatch(/undefined|NaN|\[object/);
  });

  const GOOD: Array<[string, string]> = [
    ['https://play.google.com/store/apps/details?id=com.kraveo.customer', 'https://play.google.com/store/apps/details?id=com.kraveo.customer'],
    ['https://forms.gle/AbC123xyz', 'https://forms.gle/AbC123xyz'],
    ['https://docs.google.com/forms/d/e/1FAIpQLSx_y-z/viewform?usp=sf_link', 'https://docs.google.com/forms/d/e/1FAIpQLSx_y-z/viewform?usp=sf_link'],
    ['https://example.com', 'https://example.com/'],
    ['HTTPS://Example.COM/Path?A=1#frag', 'https://example.com/Path?A=1#frag'],
    ['  https://example.com/x  ', 'https://example.com/x'],
    ['https://example.com/y\n', 'https://example.com/y'],
    ['https://example.com:443/x', 'https://example.com/x'],
    ['https://münchen.de/ä', 'https://xn--mnchen-3ya.de/%C3%A4'],
    ['https://a.b.c.example.co.in/x', 'https://a.b.c.example.co.in/x'],
  ];
  it.each(GOOD)('accepts %s and normalises it like the server', (input, normalised) => {
    expect(validateLink(input)).toBe('');
    expect(checkHttpsAddress(input, 'The link')).toEqual({ url: normalised, error: '' });
  });

  it('an empty link is fine (display-only banner); an empty picture is not', () => {
    expect(validateLink('')).toBe('');
    expect(validateLink('   ')).toBe('');
    expect(validateImageUrl('')).toMatch(/Add a picture/);
    expect(validateImageUrl('http://example.com/a.jpg')).toMatch(/^The image address must start with https:\/\//);
    expect(validateImageUrl('https://api.kraveo.site/uploads/promo/2026/a.webp')).toBe('');
  });

  it('gives a different plain reason for each kind of mistake', () => {
    expect(validateLink('http://example.com')).toMatch(/must start with https:\/\//);
    expect(validateLink('https://127.0.0.1/')).toMatch(/not an IP address/);
    expect(validateLink('https://[::1]/')).toMatch(/not an IP address/);
    expect(validateLink('https://localhost/')).toMatch(/real website name/);
    expect(validateLink('https://example.com:8443/')).toMatch(/custom port/);
    expect(validateLink('https://u:p@example.com/')).toMatch(/user name or password/);
    expect(validateLink('https://example.com/a b')).toMatch(/spaces/);
    expect(validateLink('https://a.com/' + 'x'.repeat(500))).toMatch(/at most 500/);
  });
});

describe('text rules', () => {
  it('title 2..60 characters after tidying, emoji and Hindi count as one each', () => {
    expect(validateTitle('')).toMatch(/2 to 60/);
    expect(validateTitle('a')).toMatch(/2 to 60/);
    expect(validateTitle(' ab ')).toBe('');
    expect(validateTitle('x'.repeat(60))).toBe('');
    expect(validateTitle('x'.repeat(61))).toMatch(/2 to 60/);
    expect(validateTitle('😀'.repeat(60))).toBe('');
    expect(validateTitle('😀'.repeat(61))).not.toBe('');
    expect(validateTitle('दिवाली धमाका 🎉')).toBe('');
    expect(validateTitle('a      b')).toBe('');
  });
  it('subtitle up to 120 and button text up to 20 are optional', () => {
    expect(validateSubtitle('')).toBe('');
    expect(validateSubtitle('   ')).toBe('');
    expect(validateSubtitle('y'.repeat(120))).toBe('');
    expect(validateSubtitle('y'.repeat(121))).toMatch(/at most 120/);
    expect(validateCta('Order now')).toBe('');
    expect(validateCta('z'.repeat(21))).toMatch(/at most 20/);
  });
  it('markup characters and hidden / direction characters are refused', () => {
    expect(validateTitle('Big <b>sale</b>')).toMatch(/< or >/);
    expect(validateSubtitle('a > b')).toMatch(/< or >/);
    expect(validateTitle(`Sale${ch(0x202e)}`)).toMatch(/control, hidden/);
    expect(validateTitle(`Sale${ch(0x200b)}`)).toMatch(/control, hidden/);
    expect(validateTitle(`Sale${ch(7)}!`)).toMatch(/control, hidden/);
    expect(validateTitle(`Say${ch(0x200d)}hi`)).toBe(''); // ZWJ is allowed (emoji sequences, Devanagari)
  });
});

describe('IST <-> UTC', () => {
  it('converts India wall-clock time to the UTC instant (UTC+05:30)', () => {
    expect(istToInstant('2026-11-01T18:30')).toBe('2026-11-01T13:00:00.000Z');
    expect(istToInstant('2026-11-01T12:00')).toBe('2026-11-01T06:30:00.000Z');
    expect(istToInstant('2026-11-01T18:30:15')).toBe('2026-11-01T13:00:15.000Z');
  });

  it('midnight and the first minutes of a day land on the PREVIOUS UTC day', () => {
    expect(istToInstant('2026-11-01T00:00')).toBe('2026-10-31T18:30:00.000Z');
    expect(istToInstant('2026-11-01T05:29')).toBe('2026-10-31T23:59:00.000Z');
    expect(istToInstant('2026-11-01T05:30')).toBe('2026-11-01T00:00:00.000Z');
    expect(istToInstant('2026-11-01T23:59')).toBe('2026-11-01T18:29:00.000Z');
  });

  it('year, month and leap-day boundaries', () => {
    expect(istToInstant('2026-01-01T00:00')).toBe('2025-12-31T18:30:00.000Z');
    expect(istToInstant('2026-12-31T23:59')).toBe('2026-12-31T18:29:00.000Z');
    expect(istToInstant('2028-03-01T00:00')).toBe('2028-02-29T18:30:00.000Z');
    expect(istToInstant('2028-02-29T10:00')).toBe('2028-02-29T04:30:00.000Z');
    expect(istToInstant('2000-01-01T00:00')).toBe('1999-12-31T18:30:00.000Z');
  });

  it('shows a UTC instant as India wall-clock time, with the same edges', () => {
    expect(instantToIst('2026-11-01T13:00:00.000Z')).toBe('2026-11-01T18:30');
    expect(instantToIst('2026-10-31T18:30:00.000Z')).toBe('2026-11-01T00:00');
    expect(instantToIst('2026-10-31T18:29:59.999Z')).toBe('2026-10-31T23:59');
    expect(instantToIst('2025-12-31T18:30:00.000Z')).toBe('2026-01-01T00:00');
    expect(instantToIst('2028-02-29T18:30:00.000Z')).toBe('2028-03-01T00:00');
    expect(instantToIst('2026-11-01T10:10:00+05:30')).toBe('2026-11-01T10:10'); // an offset in the input is understood
  });

  it('round-trips every 15 minutes across a day boundary and a leap day', () => {
    for (const day of ['2026-10-31', '2026-11-01', '2028-02-29', '2026-12-31']) {
      for (let h = 0; h < 24; h++) for (const m of ['00', '15', '30', '45']) {
        const local = `${day}T${String(h).padStart(2, '0')}:${m}`;
        expect(instantToIst(istToInstant(local))).toBe(local);
      }
    }
  });

  it('refuses things that are not real dates', () => {
    for (const bad of ['', 'tomorrow', '2026-11-01', '2026-13-01T10:00', '2026-02-30T10:00', '2027-02-29T10:00', '2026-11-31T10:00', '2026-11-01T24:00', '2026-11-01T10:60', '1999-12-31T23:59', '2101-01-01T00:00', '2026-11-01 10:00', '2026-11-01T10:00Z']) {
      expect(istToInstant(bad)).toBeNull();
    }
    expect(instantToIst('nonsense')).toBe('');
    expect(instantToIst(null)).toBe('');
    expect(instantToIst(undefined)).toBe('');
  });

  it('does not depend on the browser time zone (India has none to change, the computer might)', () => {
    const before = env.TZ;
    try {
      const results = ['America/New_York', 'Pacific/Auckland', 'UTC', 'Asia/Kolkata'].map((tz) => {
        env.TZ = tz;
        return [istToInstant('2026-03-08T02:30'), istToInstant('2026-10-25T01:30'), instantToIst('2026-03-07T21:00:00.000Z'), formatIst('2026-11-01T13:00:00.000Z')].join('|');
      });
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe('2026-03-07T21:00:00.000Z|2026-10-24T20:00:00.000Z|2026-03-08T02:30|1 Nov 2026, 6:30 pm');
    } finally {
      if (before === undefined) delete env.TZ; else env.TZ = before;
    }
  });

  it('formats for the list: 12-hour clock with am / pm, noon and midnight', () => {
    expect(formatIst('2026-11-01T13:00:00.000Z')).toBe('1 Nov 2026, 6:30 pm');
    expect(formatIst('2026-10-31T18:30:00.000Z')).toBe('1 Nov 2026, 12:00 am');
    expect(formatIst('2026-11-01T06:30:00.000Z')).toBe('1 Nov 2026, 12:00 pm');
    expect(formatIst('2026-12-31T18:29:00.000Z')).toBe('31 Dec 2026, 11:59 pm');
    expect(formatIst(null)).toBe('');
    expect(formatIst('junk')).toBe('');
  });

  it('describes the schedule in words with the IST label', () => {
    expect(scheduleText({ startsAt: null, endsAt: null })).toBe('Always on');
    expect(scheduleText({ startsAt: '2026-11-01T13:00:00.000Z', endsAt: null })).toBe('From 1 Nov 2026, 6:30 pm IST');
    expect(scheduleText({ startsAt: null, endsAt: '2026-11-01T13:00:00.000Z' })).toBe('Until 1 Nov 2026, 6:30 pm IST');
    expect(scheduleText({ startsAt: '2026-11-01T09:50:00.000Z', endsAt: '2026-11-01T10:10:00.000Z' })).toBe('1 Nov 2026, 3:20 pm to 1 Nov 2026, 3:40 pm IST');
  });

  it('end must be after start; the same minute is not after; bad dates are explained; empty is fine', () => {
    expect(validateSchedule('', '')).toEqual({ start: '', end: '' });
    expect(validateSchedule('2026-11-01T10:00', '')).toEqual({ start: '', end: '' });
    expect(validateSchedule('2026-11-01T10:00', '2026-11-01T10:01')).toEqual({ start: '', end: '' });
    expect(validateSchedule('2026-11-01T10:00', '2026-11-01T10:00').end).toBe('The end must be after the start.');
    expect(validateSchedule('2026-11-01T10:00', '2026-10-31T23:59').end).toBe('The end must be after the start.');
    expect(validateSchedule('2026-02-30T10:00', '').start).toMatch(/real date and time/);
    expect(validateSchedule('', '2101-01-01T00:00').end).toMatch(/real date and time/);
    // midnight crossing: 00:00 IST on the 2nd is after 23:30 IST on the 1st even though the UTC dates are the same
    expect(validateSchedule('2026-11-01T23:30', '2026-11-02T00:00').end).toBe('');
  });
});

describe('form <-> request bodies', () => {
  it('a new banner sends only what is filled; dates go as UTC instants', () => {
    expect(createBody({ ...emptyForm(), title: '  Diwali   Dhamaka ', imageUrl: ' https://api.kraveo.site/uploads/promo/2026/a.jpg ' })).toEqual({
      title: 'Diwali Dhamaka', imageUrl: 'https://api.kraveo.site/uploads/promo/2026/a.jpg', theme: 'DARK', isActive: true,
    });
    expect(createBody({
      ...emptyForm(), title: 'Launch', imageUrl: 'https://kraveo.site/a.png', subtitle: 'Sub', linkUrl: 'https://forms.gle/AbC', ctaLabel: 'Join', theme: 'LIGHT', isActive: false,
      startLocal: '2026-11-01T00:00', endLocal: '2026-11-01T23:59',
    })).toEqual({
      title: 'Launch', imageUrl: 'https://kraveo.site/a.png', subtitle: 'Sub', linkUrl: 'https://forms.gle/AbC', ctaLabel: 'Join', theme: 'LIGHT', isActive: false,
      startsAt: '2026-10-31T18:30:00.000Z', endsAt: '2026-11-01T18:29:00.000Z',
    });
  });

  it('an untouched form sends nothing', () => {
    for (const row of [rawBanner(), rawCreated(), rawSecond(), rawCopy()]) {
      const b = parseBanner(row)!;
      expect(changesOf(formFromBanner(b), b)).toEqual({});
    }
  });

  it('only the changed fields are sent; clearing sends null; a link typed without the trailing slash is not a change', () => {
    const b = banner({ subtitle: 'Old', linkUrl: 'https://example.com/', startsAt: '2026-10-31T18:30:00.000Z' });
    const f = formFromBanner(b);
    expect(changesOf({ ...f, title: '  New   title ' }, b)).toEqual({ title: 'New title' });
    expect(changesOf({ ...f, subtitle: '' }, b)).toEqual({ subtitle: null });
    expect(changesOf({ ...f, linkUrl: '' }, b)).toEqual({ linkUrl: null });
    expect(changesOf({ ...f, linkUrl: 'https://example.com' }, b)).toEqual({});
    expect(changesOf({ ...f, linkUrl: 'https://example.org' }, b)).toEqual({ linkUrl: 'https://example.org/' });
    expect(changesOf({ ...f, ctaLabel: '' }, b)).toEqual({ ctaLabel: null });
    expect(changesOf({ ...f, theme: 'LIGHT', isActive: false }, b)).toEqual({ theme: 'LIGHT', isActive: false });
    expect(changesOf({ ...f, startLocal: '' }, b)).toEqual({ startsAt: null });
    expect(changesOf({ ...f, endLocal: '2026-11-02T00:00' }, b)).toEqual({ endsAt: '2026-11-01T18:30:00.000Z' });
    expect(changesOf({ ...f, imageUrl: 'https://kraveo.site/new.jpg' }, b)).toEqual({ imageUrl: 'https://kraveo.site/new.jpg' });
  });

  it('a start time with seconds in the saved banner is not reported as changed by the minute-only picker', () => {
    const b = banner({ startsAt: '2026-11-01T09:50:30.000Z' });
    expect(changesOf(formFromBanner(b), b)).toEqual({});
  });
});

describe('picture host vs the dashboard Content-Security-Policy', () => {
  it('vercel.json img-src allows exactly the hosts the warning knows about (no wildcard)', () => {
    const vercel = JSON.parse(vercelJson);
    const csp: string = vercel.headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
    const imgSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src'))!;
    expect(imgSrc).not.toMatch(/\*/);
    expect(imgSrc).not.toMatch(/(^|\s)https:(\s|$)/);
    for (const host of DASHBOARD_IMAGE_HOSTS) expect(imgSrc).toContain(`https://${host}`);
  });

  it('warns when the picture is on a host the dashboard blocks, not for our own or allowed hosts', () => {
    expect(imageHostWarning('https://api.kraveo.site/uploads/promo/2026/a.jpg')).toBe('');
    expect(imageHostWarning('https://images.unsplash.com/photo-1')).toBe('');
    expect(imageHostWarning('https://kraveo.site/a.png')).toBe('');
    expect(imageHostWarning('')).toBe('');
    expect(imageHostWarning('not a url')).toBe('');
    const w = imageHostWarning('https://cdn.example.com/a.jpg');
    expect(w).toContain('cdn.example.com');
    expect(w).toContain('Upload photo');
    expect(imageHostWarning('https://Images.Unsplash.com.evil.com/a.jpg')).toContain('evil.com');
  });
});
