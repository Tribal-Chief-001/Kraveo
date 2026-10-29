import { AsyncLocalStorage } from 'async_hooks';

/** The admin behind the current request (Docs/27 B0). Set by requireAuth for ADMIN tokens; writeAudit reads it. No store = the system. */
export type Actor = { id: string; name?: string | null; ip?: string | null };

const store = new AsyncLocalStorage<Actor>();

export const currentActor = (): Actor | undefined => store.getStore();

/** Runs `fn` (and everything it starts, awaited or not) with `actor` as the audit actor. */
export const runWithActor = <T>(actor: Actor, fn: () => T): T => store.run(actor, fn);
