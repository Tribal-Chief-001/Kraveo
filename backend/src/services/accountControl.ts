import { prisma } from '../db';
import { bumpTokenVersion } from '../middleware/auth';
import { disableUserTokens } from './push/deviceTokens';
import { disconnectUser } from '../realtime';
import { errSummary } from '../utils/log';

/**
 * End every way a person can still reach Kraveo (Docs/27 B0): all tokens (tokenVersion + the auth cache), every push token of every
 * device, the legacy User.fcmToken, and the live sockets. Call it AFTER the account row was changed (the status check in
 * accountMatchesToken is what refuses a token even if one of these steps fails). Never throws.
 */
export const revokeUserEverywhere = async (userId: string, reason: string): Promise<void> => {
  try {
    await bumpTokenVersion(userId);
    await disableUserTokens(userId, reason);
    await prisma.user.update({ where: { id: userId }, data: { fcmToken: null } });
  } catch (err) {
    console.error('revokeUserEverywhere failed:', errSummary(err));
  }
  // A socket whose handshake passed just before the commit and that joins after this sweep is caught by the re-check in realtime.ts.
  disconnectUser(userId);
};
