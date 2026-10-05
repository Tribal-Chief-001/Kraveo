import { errSummary } from './utils/log';

/**
 * What the server does when something goes wrong outside a request (src/index.ts installs these at boot).
 *
 *  - uncaughtException and a failed listen() (port in use, ...): the process state is unknown, so log ONE data-free line
 *    and exit with a non-zero code after a short flush; PM2 then restarts it cleanly. Leaving the process alive would
 *    give a "half dead" server (no HTTP, but order maintenance still running) that PM2 reports as online.
 *  - unhandledRejection: a forgotten promise in a non-critical path (push, maintenance, a socket emit) must not take the
 *    whole server down in the middle of the demo; log it and carry on. Request errors are already handled by Express.
 *
 * Logs use errSummary(): Prisma errors embed query arguments (phones, emails) that must not reach the log file.
 */
export const FATAL_EXIT_DELAY_MS = 500;

export interface ProcessGuardDeps {
  exit?: (code: number) => void;
  log?: (line: string) => void;
  /** Time for pending log lines to reach PM2's log file before the process ends. */
  exitDelayMs?: number;
}

export const createProcessGuards = (deps: ProcessGuardDeps = {}) => {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((line: string) => console.error(line));
  const delay = deps.exitDelayMs ?? FATAL_EXIT_DELAY_MS;
  let exiting = false;

  const fatal = (what: string, err: unknown) => {
    log(`[FATAL] ${what}: ${errSummary(err)} - exiting so the process manager restarts the server`);
    if (exiting) return;
    exiting = true;
    setTimeout(() => exit(1), delay); // ref'd on purpose: it must fire even if nothing else keeps the loop alive
  };

  return {
    onUncaughtException: (err: unknown) => fatal('uncaught exception', err),
    onUnhandledRejection: (reason: unknown) => log(`[WARN] unhandled promise rejection (server keeps running): ${errSummary(reason)}`),
    onListenError: (err: unknown) => fatal('the server could not start listening', err),
  };
};

export const installProcessGuards = (deps: ProcessGuardDeps = {}) => {
  const guards = createProcessGuards(deps);
  process.on('uncaughtException', guards.onUncaughtException);
  process.on('unhandledRejection', guards.onUnhandledRejection);
  return guards;
};
