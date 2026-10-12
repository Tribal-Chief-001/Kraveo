/**
 * Shared hygiene for every human-readable label an admin or a restaurant can type (category, restaurant, dish names, descriptions, import rows).
 * Text is normalised to NFC first, then checked. Rejected: control characters, line / paragraph separators, bidirectional overrides and
 * isolates (U+202A-202E, U+2066-2069), the direction marks (U+200E, U+200F) and zero-width characters (U+200B-200D, U+2060, U+FEFF), which
 * allow visual spoofing and make "Dosa" and "Dosa<zero width>" two different dishes.
 */
export const BAD_LABEL_CHARS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
/** The same set without ZWNJ / ZWJ (U+200C, U+200D), which Devanagari and other scripts really need (Hindi labels only). */
export const BAD_SCRIPT_LABEL_CHARS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u2028\u2029\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
/** Characters removed before two names are compared for "the same dish" (belt and braces for rows already stored). */
export const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** NFC + trim + collapse every run of white space (tabs, newlines, NBSP ...) to one space. */
export const collapse = (s: string): string => s.normalize('NFC').trim().replace(/\s+/g, ' ');
/** The key two names are compared by in duplicate checks: normalised, invisible characters dropped, lower case. */
export const nameKey = (s: string): string => collapse(s.replace(INVISIBLE_CHARS, '')).toLowerCase();
/**
 * True when `raw` is text with hidden / control / direction-changing characters. Always test the RAW text (after NFC): collapsing white space
 * first would turn U+FEFF and U+2028 into ordinary spaces. Tab, line feed and the other white-space controls are allowed: they collapse to a space.
 */
export const badLabel = (raw: unknown): boolean => typeof raw === 'string' && BAD_LABEL_CHARS.test(raw.normalize('NFC'));
export const BAD_LABEL_MESSAGE = 'cannot contain control, hidden or direction-changing characters';
