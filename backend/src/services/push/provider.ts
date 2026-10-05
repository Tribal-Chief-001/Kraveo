import * as fs from 'fs';
import { PushMessage, PushProvider } from './types';

/**
 * The push sender is injectable (same style as setPaymentProvider): tests inject a fake and never touch Firebase.
 * Real provider (FCM HTTP v1 through firebase-admin) is built lazily, once, and never when NODE_ENV === 'test'.
 * Credentials: FIREBASE_KEY_PATH (a file, preferred) or FIREBASE_SERVICE_ACCOUNT (the JSON as a string, fallback).
 * Missing / unreadable / invalid credentials = push disabled with ONE warning line; the server keeps working.
 * Neither the path contents nor the JSON are ever logged.
 */
export const noopProvider: PushProvider = { enabled: false, send: async () => undefined };

let injected: PushProvider | null = null;
let resolved: PushProvider | null = null;
let warned = false;

export const setPushProvider = (provider: PushProvider | null) => {
  injected = provider;
};

const warnOnce = (why: string) => {
  if (warned) return;
  warned = true;
  console.warn(`push notifications are OFF: ${why}. Orders, payments and sockets are not affected.`);
};

const readServiceAccount = (): { json: Record<string, unknown> } | { problem: string } => {
  const keyPath = process.env.FIREBASE_KEY_PATH?.trim();
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  let raw: string | null = null;
  if (keyPath) {
    try {
      raw = fs.readFileSync(keyPath, 'utf8');
    } catch {
      // No silent fallback to an inline key: a configured path that cannot be read is a deployment mistake to surface.
      return { problem: 'FIREBASE_KEY_PATH is set but the file cannot be read' };
    }
  }
  if (raw === null) raw = inline || null;
  if (!raw) return { problem: 'FIREBASE_KEY_PATH / FIREBASE_SERVICE_ACCOUNT are not set' };
  try {
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object' || typeof json.private_key !== 'string' || typeof json.client_email !== 'string') {
      return { problem: 'the Firebase credentials are not a service account key' };
    }
    return { json };
  } catch {
    return { problem: 'the Firebase credentials are not valid JSON' };
  }
};

const createFcmProvider = (): PushProvider | null => {
  const found = readServiceAccount();
  if ('problem' in found) {
    warnOnce(found.problem);
    return null;
  }
  try {
    // Lazy require: nothing of firebase-admin is loaded unless push is actually configured.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getMessaging } = require('firebase-admin/messaging');
    const NAME = 'kraveo-push';
    const app = getApps().some((a: { name: string }) => a.name === NAME) ? getApp(NAME) : initializeApp({ credential: cert(found.json) }, NAME);
    const messaging = getMessaging(app);
    return {
      enabled: true,
      async verify() {
        try {
          await messaging.send({ token: 'x'.repeat(152) }, true);
          return { ok: true };
        } catch (err) {
          const kind = classifyPushError(err);
          // A well-formed rejection of the fake token means FCM accepted our credentials and project.
          return { ok: kind.code === 'INVALID_TOKEN' || kind.code === 'UNREGISTERED', code: kind.code };
        }
      },
      async send(m: PushMessage) {
        await messaging.send({
          token: m.token,
          notification: { title: m.title, body: m.body },
          data: m.data,
          android: {
            priority: m.priority,
            ttl: m.ttlSeconds * 1000,
            // No FCM collapse key: FCM allows only a few active collapse keys per device, so a phone that was offline for a
            // while would silently lose pushes. Duplicates are already prevented server-side (PushLog.key).
            // Lock screen shows the real text (it never holds a code or phone); urgent events ask for max heads-up priority.
            // `tag`: a newer push for the same order (a reminder, the next status) replaces the previous banner instead of stacking.
            notification: { channelId: m.channelId, visibility: 'public', priority: m.priority === 'high' ? 'max' : 'default', tag: `order_${m.data.orderId}` },
          },
        });
      },
    };
  } catch {
    warnOnce('the Firebase credentials were rejected');
    return null;
  }
};

/** The provider to use now: the injected one, else the (cached) real one, else the no-op. */
export const getPushProvider = (): PushProvider => {
  if (injected) return injected;
  if (process.env.NODE_ENV === 'test') return noopProvider;
  if (!resolved) resolved = createFcmProvider() ?? noopProvider;
  return resolved;
};

/** Called once at boot so the warning (if any) shows up in the first log lines, not at the first order. */
export const initPushProvider = (): boolean => getPushProvider().enabled;

export const __resetPushProvider = () => {
  injected = null;
  resolved = null;
  warned = false;
};

// ----------------------------------------------------------------------------
// Error classification
// ----------------------------------------------------------------------------
export type PushErrorKind = { code: string; transient: boolean; deadToken: boolean };

// SENDER_ID_MISMATCH is deliberately NOT dead: it means OUR credentials/project are wrong, and it must not disable every device.
const DEAD = new Set(['UNREGISTERED', 'INVALID_TOKEN']);
const TRANSIENT = new Set(['UNAVAILABLE', 'INTERNAL', 'QUOTA_EXCEEDED', 'TIMEOUT', 'NETWORK']);
const ALIASES: Record<string, string> = {
  REGISTRATION_TOKEN_NOT_REGISTERED: 'UNREGISTERED',
  INVALID_REGISTRATION_TOKEN: 'INVALID_TOKEN',
  MISMATCHED_CREDENTIAL: 'SENDER_ID_MISMATCH',
  SERVER_UNAVAILABLE: 'UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL',
  UNKNOWN_ERROR: 'INTERNAL',
  MESSAGE_RATE_EXCEEDED: 'QUOTA_EXCEEDED',
  DEVICE_MESSAGE_RATE_EXCEEDED: 'QUOTA_EXCEEDED',
  TOPICS_MESSAGE_RATE_EXCEEDED: 'QUOTA_EXCEEDED',
  NETWORK_ERROR: 'NETWORK',
  NETWORK_TIMEOUT: 'NETWORK',
  ECONNRESET: 'NETWORK',
  ECONNREFUSED: 'NETWORK',
  ETIMEDOUT: 'NETWORK',
  ENOTFOUND: 'NETWORK',
  EAI_AGAIN: 'NETWORK',
};

/**
 * dead token  : UNREGISTERED / INVALID_TOKEN (INVALID_ARGUMENT whose message says registration token) -> disable the token, no retry.
 * INVALID_PAYLOAD (INVALID_ARGUMENT about the message itself) is permanent for that push but keeps the token.
 * transient   : UNAVAILABLE / INTERNAL / QUOTA_EXCEEDED / network / our own timeout -> retry with backoff.
 * anything else (an unrecognised FCM code) is a permanent failure of this message; an error without any code is treated as a network problem.
 */
export const classifyPushError = (err: unknown): PushErrorKind => {
  const e = err as { code?: unknown; errorInfo?: { code?: unknown } } | null | undefined;
  const rawCode = typeof e?.code === 'string' ? e.code : typeof e?.errorInfo?.code === 'string' ? e.errorInfo.code : '';
  if (!rawCode) return { code: 'NETWORK', transient: true, deadToken: false };
  const norm = rawCode.replace(/^(messaging|app)\//i, '').replace(/[-\s]/g, '_').toUpperCase();
  let code = ALIASES[norm] ?? norm;
  // FCM answers INVALID_ARGUMENT both for a malformed device token ("not a valid FCM registration token") and for a malformed MESSAGE.
  // Only the first means the device is gone; a message bug must never disable every device, so it is a permanent failure of this push only.
  if (code === 'INVALID_ARGUMENT') {
    const msg = String((err as { message?: unknown } | null | undefined)?.message ?? '');
    code = /registration token/i.test(msg) ? 'INVALID_TOKEN' : 'INVALID_PAYLOAD';
  }
  return { code: code.slice(0, 60), transient: TRANSIENT.has(code), deadToken: DEAD.has(code) };
};
