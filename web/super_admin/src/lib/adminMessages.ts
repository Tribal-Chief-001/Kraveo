// Plain-language messages and small decisions for failure and success paths (no React).
import type { Application, ApprovalStatus } from '../types';

/** What the admin reads when assigning a rider fails. Server codes that are jargon become sentences; others pass through. */
export const reassignFailureMessage = (code: string | undefined, serverMessage: string): string => {
  if (code === 'RIDER_OFFLINE') return 'That rider is offline. Ask them to go on duty, or assign them anyway.';
  if (code === 'RIDER_BUSY') return 'That rider already has an active order. Finish or move that order first.';
  return serverMessage;
};

/** Toast shown after a partner decision. Reactivating a suspended restaurant leaves it closed (the server does not reopen it). */
export const decisionToast = (app: Pick<Application, 'kind' | 'status'>, next: ApprovalStatus, who: string): [string, string] => {
  if (next === 'APPROVED' && app.status === 'SUSPENDED') {
    return app.kind === 'VENDOR'
      ? ['Reactivated', `${who} is reactivated. It is closed until the restaurant opens it.`]
      : ['Reactivated', `${who} can work again. They go on duty from the app.`];
  }
  const messages: Record<ApprovalStatus, [string, string]> = {
    APPROVED: ['Approved', `${who} can start working now.`],
    REJECTED: ['Rejected', `${who} will see your reason in the app.`],
    SUSPENDED: ['Suspended', `${who} is blocked until you reactivate.`],
    PENDING: ['Updated', who],
  };
  return messages[next];
};

/** Only a rejected token (401/403) ends the stored session; a network blip, 5xx or 429 must not. */
export const isSessionRejected = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
};

/** Wait before the next session re-check: 2 s, 4 s, 8 s ... up to 30 s. */
export const sessionRetryDelayMs = (attempt: number): number => Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt));
