import { prisma } from '../../db';
import { PushApp } from './types';

export const MAX_ACTIVE_TOKENS_PER_USER = 10;

const APP_OF_ROLE: Record<string, PushApp> = { STUDENT: 'CUSTOMER', VENDOR: 'VENDOR', DRIVER: 'DRIVER' };
/** The app a role may register for (ADMIN has none). */
export const appForRole = (role: string): PushApp | null => APP_OF_ROLE[role] ?? null;

export type RegisterInput = { userId: string; token: string; app: PushApp; platform: string; appVersion: string | null };

/**
 * Upsert by token. A token that exists for another user MOVES to the caller (shared phone / re-login) and is re-enabled.
 * A user keeps at most MAX_ACTIVE_TOKENS_PER_USER active tokens: the least recently seen ones are disabled.
 */
export const registerDeviceToken = async (input: RegisterInput): Promise<void> => {
  const now = new Date();
  await prisma.deviceToken.upsert({
    where: { token: input.token },
    create: { userId: input.userId, token: input.token, app: input.app, platform: input.platform, appVersion: input.appVersion, lastSeenAt: now },
    update: { userId: input.userId, app: input.app, platform: input.platform, appVersion: input.appVersion, lastSeenAt: now, disabledAt: null, disabledReason: null },
  });
  const active = await prisma.deviceToken.findMany({
    where: { userId: input.userId, disabledAt: null },
    orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, token: true },
  });
  const excess = active.filter((t) => t.token !== input.token).slice(MAX_ACTIVE_TOKENS_PER_USER - 1);
  if (excess.length > 0) {
    await prisma.deviceToken.updateMany({ where: { id: { in: excess.map((t) => t.id) }, disabledAt: null }, data: { disabledAt: now, disabledReason: 'LIMIT' } });
  }
};

/** Logout: only the owner can switch a token off; an unknown token (or somebody else's) is a quiet success. */
export const removeDeviceToken = async (userId: string, token: string): Promise<void> => {
  await prisma.deviceToken.updateMany({ where: { userId, token, disabledAt: null }, data: { disabledAt: new Date(), disabledReason: 'LOGOUT' } });
};

/** Account deleted, partner suspended / rejected: no more pushes to any device of this user. Never throws. */
export const disableUserTokens = async (userId: string, reason: string): Promise<void> => {
  try {
    await prisma.deviceToken.updateMany({ where: { userId, disabledAt: null }, data: { disabledAt: new Date(), disabledReason: reason.slice(0, 40) } });
  } catch (err) {
    console.error('could not disable device tokens:', (err as Error)?.name ?? 'error');
  }
};

/** FCM said the token is dead (UNREGISTERED, ...): off at once, reason = the FCM code. */
export const disableToken = async (token: string, reason: string): Promise<void> => {
  await prisma.deviceToken.updateMany({ where: { token, disabledAt: null }, data: { disabledAt: new Date(), disabledReason: reason.slice(0, 40) } });
};

export const activeTokensFor = (userId: string, app: PushApp) =>
  prisma.deviceToken.findMany({ where: { userId, app, disabledAt: null }, select: { token: true }, orderBy: { lastSeenAt: 'desc' } });
