/**
 * A known, expected failure of an endpoint (validation, not found, conflict): `fail()` in utils/http.ts answers it with its status,
 * code and message instead of the generic 500. Anything that is not an AppError / OrderFlowError is logged and answered with a
 * generic message (never Prisma text).
 */
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
