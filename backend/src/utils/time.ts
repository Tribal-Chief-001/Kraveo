/**
 * Campus time. Kraveo runs in Asia/Kolkata (UTC+05:30, no daylight saving), but the server may run in UTC, so anything a
 * human reads as "today" or "14:00" is computed with this fixed offset instead of the server's local time zone.
 */
export const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant at which the Asia/Kolkata calendar day containing `d` started. */
export const startOfIstDay = (d: Date): Date => new Date(Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);

/** The hour of day (0-23) on the Asia/Kolkata clock. */
export const istHour = (d: Date): number => new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` on the Asia/Kolkata calendar for the instant `d`. */
export const istDateString = (d: Date): string => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** True for a real calendar date written as `YYYY-MM-DD` (2026-02-30 is not). */
export const isIstDateString = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, da));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === da;
};

/** The instant at which the IST calendar day `YYYY-MM-DD` starts (00:00 IST). Call isIstDateString first. */
export const istDayStartOf = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
};

/** The instant of `HH:MM` IST on the IST day `YYYY-MM-DD`. */
export const istInstant = (date: string, hhmm: string): Date => {
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(istDayStartOf(date).getTime() + (h * 60 + mi) * 60_000);
};

/** `date` plus `days` calendar days, as `YYYY-MM-DD` (pure calendar arithmetic, no daylight saving in India). */
export const addIstDays = (date: string, days: number): string => istDateString(new Date(istDayStartOf(date).getTime() + days * 86_400_000 + 12 * 3_600_000));
