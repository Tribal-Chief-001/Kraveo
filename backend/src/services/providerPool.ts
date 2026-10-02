import { PROVIDER_BREAKER_FAILURES, PROVIDER_CONCURRENCY } from '../config/orderFlow';

/**
 * Circuit breaker + bounded parallelism for the provider phases of the maintenance tick.
 * A worker stops taking new items once `limit` provider calls in a row failed transiently (network error,
 * timeout, 5xx, 429). Calls already in flight are not cancelled (each has its own timeout).
 */
export type Breaker = { readonly open: boolean; readonly consecutive: number; transientFailure(): void; ok(): void };

export const createBreaker = (limit = PROVIDER_BREAKER_FAILURES): Breaker => {
  let consecutive = 0;
  return {
    get open() { return consecutive >= limit; },
    get consecutive() { return consecutive; },
    transientFailure() { consecutive += 1; },
    ok() { consecutive = 0; }, // any answer from the provider (even a 4xx) means it is alive
  };
};

/** What `fn` reports back: `transient: true` when the provider could not be reached or answered 5xx/429; `neutral: true` when the provider was not asked at all. */
export type PoolResult = { transient?: boolean; neutral?: boolean } | void;

export const runPool = async <T>(items: T[], breaker: Breaker, fn: (item: T) => Promise<PoolResult>, concurrency = PROVIDER_CONCURRENCY): Promise<number> => {
  let next = 0;
  let processed = 0;
  const worker = async () => {
    while (!breaker.open && next < items.length) {
      const item = items[next++];
      processed += 1;
      let r: PoolResult;
      try {
        r = await fn(item);
      } catch (err) {
        console.error('provider task failed:', (err as Error)?.message ?? err);
        continue;
      }
      if (r && r.transient) breaker.transientFailure(); else if (!(r && r.neutral)) breaker.ok();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return processed;
};
