/**
 * One answer for "this account is blocked by an admin" (Docs/27 B0, Docs/28 decision 7). Used by every way in: Google sign-in,
 * partner login, admin login, and requireAuth (a token of a blocked account). The apps show `message` as it is.
 */
export const SUPPORT_EMAIL = 'kraveo.contact@gmail.com';

export type BlockedAnswer = { status: 403; code: 'ACCOUNT_SUSPENDED' | 'ACCOUNT_REMOVED'; message: string };

export const blockedLogin = (u: { accountStatus?: string | null; statusReason?: string | null }): BlockedAnswer | null => {
  if (u.accountStatus === 'SUSPENDED') {
    const reason = (u.statusReason ?? '').trim().replace(/[.\s]+$/, '');
    return { status: 403, code: 'ACCOUNT_SUSPENDED', message: `Your Kraveo account is paused${reason ? `: ${reason}` : ''}. Contact ${SUPPORT_EMAIL}.` };
  }
  if (u.accountStatus === 'REMOVED') {
    return { status: 403, code: 'ACCOUNT_REMOVED', message: `This Kraveo account was removed. Contact ${SUPPORT_EMAIL} if you think this is a mistake.` };
  }
  return null;
};
