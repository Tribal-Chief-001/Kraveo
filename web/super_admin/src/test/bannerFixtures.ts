// JSON copied from REAL backend answers (Docs/25 section 7.2, produced by backend/test/e2e/home_banners.test.ts against PostgreSQL).
import { parseBanner } from '../lib/bannerParse';

const IMG = 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg';

/** One row of GET /api/admin/banners (the sample in section 7.2: scheduled, with link, counters and ctr). */
export const rawBanner = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: 'dd002330-7627-4565-8199-a55a758f1411',
  title: 'One',
  subtitle: null,
  imageUrl: IMG,
  linkUrl: 'https://forms.gle/x1',
  ctaLabel: 'Go',
  theme: 'DARK',
  placement: 'HOME',
  isActive: true,
  startsAt: '2026-11-01T09:50:00.000Z',
  endsAt: '2026-11-01T10:10:00.000Z',
  sortOrder: 10,
  viewCount: 40,
  clickCount: 5,
  ctr: 12.5,
  status: 'SCHEDULED',
  createdByUserId: 'usr-5',
  createdAt: '2026-10-28T17:30:38.940Z',
  updatedAt: '2026-10-28T17:30:38.954Z',
  ...over,
});

/** The create answer: always-on, no link, no counters (section 7.2 "Create"). */
export const rawCreated = (over: Record<string, unknown> = {}) => rawBanner({
  id: '33341894-b6d3-4f67-91fa-a908eca24823', title: 'Diwali Dhamaka', linkUrl: null, ctaLabel: null, startsAt: null, endsAt: null, viewCount: 0, clickCount: 0, ctr: null,
  status: 'LIVE', createdAt: '2026-10-28T17:30:38.920Z', updatedAt: '2026-10-28T17:30:38.920Z', ...over,
});

/** The duplicate answer (section 7.2 "Duplicate"): switched off, counters 0, "(copy)". */
export const rawCopy = (over: Record<string, unknown> = {}) => rawBanner({
  id: 'f380a834-5b4e-4fa1-b906-45b2dc91f99f', title: 'Launch (copy)', subtitle: 'Sub', linkUrl: 'https://forms.gle/z', ctaLabel: 'Join', theme: 'LIGHT', isActive: false,
  startsAt: '2026-11-01T11:00:00.000Z', endsAt: '2026-11-01T12:00:00.000Z', sortOrder: 30, viewCount: 0, clickCount: 0, ctr: null, status: 'OFF', ...over,
});

export const rawSecond = (over: Record<string, unknown> = {}) => rawBanner({
  id: '3a6fef14-70ff-47de-b0c2-1d328e4b597e', title: 'Second', subtitle: 'Sub', linkUrl: null, ctaLabel: null, theme: 'LIGHT', startsAt: null, endsAt: null, sortOrder: 20,
  viewCount: 0, clickCount: 0, ctr: null, status: 'LIVE', ...over,
});

export const rawBannerList = (rows: Record<string, unknown>[] = [rawBanner(), rawSecond()]) => ({ success: true, count: rows.length, data: rows });
export const patchAnswer = (row: Record<string, unknown>, changed = true) => ({ success: true, changed, message: changed ? 'Banner saved.' : 'Nothing to change.', data: row });
export const reorderAnswer = (rows: Record<string, unknown>[], changed = true) => ({ success: true, changed, message: changed ? 'Order saved.' : 'The order was already like this.', data: rows });
export const createAnswer = (row: Record<string, unknown>) => ({ success: true, message: 'Banner created.', data: row });
export const copyAnswer = (row: Record<string, unknown>) => ({ success: true, message: 'Banner duplicated. The copy is switched off.', data: row });
export const deleteAnswer = (id: string, deleted = true) => ({ success: true, message: deleted ? 'Banner deleted.' : 'The banner was already deleted.', data: { id, title: 'Doomed', deleted } });
export const uploadPromoOk = { success: true, data: { url: 'https://api.kraveo.site/uploads/promo/2026/e04403271c142510261d74e738ff1852.png', width: 1200, height: 600, bytes: 68 } };
export const errorAnswer = (code: string, message: string, field?: string) => ({ success: false, code, message, ...(field ? { field } : {}) });

export const banner = (over: Record<string, unknown> = {}) => parseBanner(rawBanner(over))!;
export const BANNER_IMG = IMG;
