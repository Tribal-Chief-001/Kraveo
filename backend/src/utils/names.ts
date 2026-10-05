/**
 * Person-name rule shared by the profile save, partner sign-up / re-apply and admin partner creation.
 *
 * Accepts: a first character that is a letter in ANY script, then 1-59 more characters that are letters, combining
 * marks (Devanagari / Tamil vowel signs), decimal digits (Google names such as "RAHUL SHARMA 22BCE10123"), a plain
 * space, a full stop, a straight or curly apostrophe, or a hyphen. Callers collapse whitespace first, so only the
 * plain space is allowed. Control characters, angle brackets, emoji and other symbols are rejected.
 */
export const NAME_RE = /^[\p{L}][\p{L}\p{M}\p{Nd} .'\u2019\-]{1,59}$/u;
