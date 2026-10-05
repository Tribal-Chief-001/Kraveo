import { prisma } from '../../db';
import { OrderWithRelations, ORDER_VIEW_INCLUDE } from '../orderView';
import { activeTokensFor, disableToken } from './deviceTokens';
import { MAX_PUSH_ATTEMPTS, buildCopy, eventDef, resolveRecipients, stillUseful } from './events';
import { classifyPushError, getPushProvider } from './provider';
import { PUSH_EVENTS, PushEvent, PushMessage, PushOptions, PushProvider } from './types';

/**
 * Sends order pushes (Docs/18_push_notifications_contract.md). Rules this file keeps:
 *  - Fire-and-forget AFTER the order transaction committed. Nothing in here ever throws into a caller.
 *  - Idempotent in the database: PushLog.key = `${orderId}:${event}:${userId}` is unique, the insert is the claim.
 *  - A dead token is disabled at once; a transient failure is retried by the 60 s maintenance job (backoff, 5 attempts,
 *    10 min for NEW_ORDER / NEW_DELIVERY, 30 min for the rest).
 *  - Logs carry event, order id and an error code only: never a token, title, body, phone or OTP.
 *  - If no provider is configured (or NODE_ENV=test without an injected fake) this does no work at all.
 */
const LEASE_MS = 2 * 60_000; // a PENDING row is owned by its sender for this long; after that the job may take it over
const CONCURRENCY = 10;
const backoffMs = (attempts: number) => Math.min(8 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
const sendTimeoutMs = () => {
  const n = Number(process.env.PUSH_SEND_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
};

const logError = (what: string, event: string, orderId: string, err: unknown) => {
  const e = err as { code?: unknown; name?: unknown } | null | undefined;
  console.error(`push ${what} failed (${event}, order ${orderId}): ${String(e?.code ?? e?.name ?? 'error').slice(0, 60)}`);
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('push send timed out'), { code: 'TIMEOUT' })), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

const inChunks = async <T>(items: T[], fn: (item: T) => Promise<void>) => {
  for (let i = 0; i < items.length; i += CONCURRENCY) await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
};

type LogRow = { id: string; orderId: string; userId: string; event: string; attempts: number; createdAt: Date };

const loadOrderForPush = (orderId: string) => prisma.order.findUnique({ where: { id: orderId }, include: ORDER_VIEW_INCLUDE });

/** Send to every active device of the log's user and record the outcome. */
const deliver = async (provider: PushProvider, row: LogRow, order: OrderWithRelations, now: Date): Promise<void> => {
  const event = row.event as PushEvent;
  const def = eventDef(event);
  const finish = (data: Record<string, unknown>) => prisma.pushLog.updateMany({ where: { id: row.id, status: 'PENDING' }, data });

  const tokens = await activeTokensFor(row.userId, def.app);
  if (tokens.length === 0) {
    await finish({ status: 'SKIPPED', lastError: 'NO_DEVICE', nextAttemptAt: null });
    return;
  }
  const copy = buildCopy(event, order);
  const results = await Promise.all(
    tokens.map(async ({ token }) => {
      const message: PushMessage = {
        token,
        title: copy.title,
        body: copy.body,
        channelId: def.channelId,
        priority: def.priority,
        ttlSeconds: def.ttlSeconds,
        collapseKey: `${event}:${order.id}`,
        data: { event, orderId: order.id, v: '1' },
      };
      try {
        await withTimeout(Promise.resolve().then(() => provider.send(message)), sendTimeoutMs());
        return { ok: true as const };
      } catch (err) {
        const kind = classifyPushError(err);
        if (kind.deadToken) await disableToken(token, kind.code).catch(() => undefined);
        return { ok: false as const, ...kind };
      }
    }),
  );

  const attempts = row.attempts + 1;
  if (results.some((r) => r.ok)) {
    await finish({ status: 'SENT', attempts, sentAt: new Date(), lastError: null, nextAttemptAt: null });
    return;
  }
  const failures = results.filter((r): r is Exclude<typeof r, { ok: true }> => !r.ok);
  const transient = failures.find((f) => f.transient);
  if (!transient) {
    await finish({ status: 'FAILED', attempts, lastError: failures[0]?.code ?? 'FAILED', nextAttemptAt: null });
    return;
  }
  const next = new Date(now.getTime() + backoffMs(attempts));
  const expired = next.getTime() > row.createdAt.getTime() + def.usefulMinutes * 60_000;
  if (attempts >= MAX_PUSH_ATTEMPTS || expired) {
    await finish({ status: 'FAILED', attempts, lastError: transient.code, nextAttemptAt: null });
    return;
  }
  await finish({ status: 'PENDING', attempts, lastError: transient.code, nextAttemptAt: next });
};

/**
 * Resolve the recipients of `event` for the order, claim one PushLog row per (order, event, user) and send.
 * Resolves when done; never rejects.
 */
export const notifyOrderEvent = async (orderId: string, event: PushEvent, opts: PushOptions = {}): Promise<void> => {
  try {
    const provider = getPushProvider();
    if (!provider.enabled) return;
    const order = await loadOrderForPush(orderId);
    if (!order) return;
    const userIds = [...new Set(await resolveRecipients(event, order, opts))];
    const now = new Date();
    await inChunks(userIds, async (userId) => {
      try {
        let row: LogRow;
        try {
          row = await prisma.pushLog.create({
            data: { key: `${orderId}:${event}:${userId}`, orderId, userId, event, status: 'PENDING', attempts: 0, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
            select: { id: true, orderId: true, userId: true, event: true, attempts: true, createdAt: true },
          });
        } catch (err) {
          if ((err as { code?: string })?.code === 'P2002') return; // this exact push was already claimed: never twice
          throw err;
        }
        await deliver(provider, row, order, now);
      } catch (err) {
        logError('delivery', event, orderId, err);
      }
    });
  } catch (err) {
    logError('dispatch', event, orderId, err);
  }
};

// Fire-and-forget work that tests (and shutdown) can still wait for.
const inFlight = new Set<Promise<unknown>>();

/** The call used by the order code: schedules the push and returns immediately. */
export const queuePush = (orderId: string, event: PushEvent, opts: PushOptions = {}): void => {
  try {
    const p: Promise<unknown> = notifyOrderEvent(orderId, event, opts)
      .catch(() => undefined)
      .finally(() => { inFlight.delete(p); });
    inFlight.add(p);
  } catch (err) {
    logError('queue', event, orderId, err);
  }
};

export const __waitForPushWork = async () => {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
};

/** Maintenance job (every 60 s): retry transient failures whose backoff has passed. Returns how many rows were tried. */
export const retryDuePushes = async (now: Date = new Date()): Promise<number> => {
  const provider = getPushProvider();
  if (!provider.enabled) return 0;
  const due = await prisma.pushLog.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: 100,
    select: { id: true, orderId: true, userId: true, event: true, attempts: true, createdAt: true },
  });
  let tried = 0;
  await inChunks(due, async (row) => {
    try {
      const claim = await prisma.pushLog.updateMany({
        where: { id: row.id, status: 'PENDING', nextAttemptAt: { lte: now } },
        data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
      });
      if (claim.count === 0) return; // another worker took it
      const finish = (status: string, lastError: string) =>
        prisma.pushLog.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status, lastError, nextAttemptAt: null } });
      const event = row.event as PushEvent;
      if (!(PUSH_EVENTS as readonly string[]).includes(event)) {
        await finish('FAILED', 'UNKNOWN_EVENT');
        return;
      }
      if (row.attempts >= MAX_PUSH_ATTEMPTS) return void (await finish('FAILED', 'MAX_ATTEMPTS'));
      if (now.getTime() > row.createdAt.getTime() + eventDef(event).usefulMinutes * 60_000) return void (await finish('FAILED', 'EXPIRED'));
      const order = await loadOrderForPush(row.orderId);
      if (!order) return void (await finish('SKIPPED', 'ORDER_GONE'));
      if (!stillUseful(event, order)) return void (await finish('SKIPPED', 'STALE'));
      const recipients = await resolveRecipients(event, order, { userId: row.userId });
      if (!recipients.includes(row.userId)) return void (await finish('SKIPPED', 'NOT_RECIPIENT'));
      tried += 1;
      await deliver(provider, row, order, now);
    } catch (err) {
      logError('retry', row.event, row.orderId, err);
    }
  });
  return tried;
};

/** PushLog older than 14 days and device tokens disabled for more than 60 days are deleted. Returns the row counts. */
export const pruneOldPushData = async (now: Date = new Date()): Promise<{ logs: number; tokens: number }> => {
  const day = 24 * 60 * 60_000;
  const logs = await prisma.pushLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 14 * day) } } });
  const tokens = await prisma.deviceToken.deleteMany({ where: { disabledAt: { lt: new Date(now.getTime() - 60 * day) } } });
  return { logs: logs.count, tokens: tokens.count };
};
