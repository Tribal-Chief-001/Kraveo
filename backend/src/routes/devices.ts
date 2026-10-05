import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { fail } from '../utils/http';
import { appForRole, registerDeviceToken, removeDeviceToken } from '../services/push/deviceTokens';
import { PushApp } from '../services/push/types';

/**
 * Push device registration (Docs/18_push_notifications_contract.md section 3). Mounted under /api, so the apps call
 * POST /api/devices and DELETE /api/devices. The caller is always the token's owner; the server never takes a user id from the body.
 */
export const deviceRouter = Router();

// FCM registration tokens are ~160 characters of [A-Za-z0-9_:-]. The contract allows up to 4096, but the token column is
// uniquely indexed and a Postgres btree entry cannot be larger than ~2.7 KB, so 2048 is the hard limit here.
const TOKEN_MIN = 20;
const TOKEN_MAX = 2048;
const TOKEN_RE = /^[\x21-\x7E]+$/; // visible ASCII, no spaces or control characters
const APPS = new Set<string>(['CUSTOMER', 'VENDOR', 'DRIVER']);
const VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;

const bad = (res: Response, field: string, message: string) => res.status(400).json({ success: false, code: 'BAD_REQUEST', field, message });

const tokenProblem = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return 'token is required.';
  if (raw.length < TOKEN_MIN || raw.length > TOKEN_MAX || !TOKEN_RE.test(raw)) return `token must be ${TOKEN_MIN}-${TOKEN_MAX} visible characters.`;
  return null;
};

deviceRouter.post('/devices', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token, app, platform, appVersion } = req.body ?? {};
    const problem = tokenProblem(token);
    if (problem) return bad(res, 'token', problem);
    if (typeof app !== 'string' || !APPS.has(app)) return bad(res, 'app', 'app must be CUSTOMER, VENDOR or DRIVER.');
    if (platform !== undefined && platform !== null && platform !== 'android') return bad(res, 'platform', 'platform must be android.');
    if (appVersion !== undefined && appVersion !== null && (typeof appVersion !== 'string' || !VERSION_RE.test(appVersion))) {
      return bad(res, 'appVersion', 'appVersion must be at most 32 characters.');
    }
    // The app must match the account: a customer account cannot register as the restaurant's device (and so receive its orders).
    if (appForRole(req.user!.role) !== app) {
      return res.status(403).json({ success: false, code: 'ROLE_NOT_ALLOWED', message: 'This app cannot register for notifications with this account.' });
    }
    await registerDeviceToken({ userId: req.user!.id, token, app: app as PushApp, platform: 'android', appVersion: typeof appVersion === 'string' ? appVersion : null });
    return res.json({ success: true });
  } catch (err) {
    return fail(res, err, 'register device');
  }
});

deviceRouter.delete('/devices', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const problem = tokenProblem(req.body?.token);
    if (problem) return bad(res, 'token', problem);
    await removeDeviceToken(req.user!.id, req.body.token);
    return res.json({ success: true });
  } catch (err) {
    return fail(res, err, 'remove device');
  }
});
