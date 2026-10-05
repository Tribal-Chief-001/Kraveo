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
