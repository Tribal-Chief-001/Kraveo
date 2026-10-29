import { ApiError } from '../services/api';

/** The message to show for any failure: the server's plain wording when there is one, otherwise a safe sentence. */
export const errorText = (error: unknown, fallback = 'Something went wrong. Please try again.'): string => {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

export const isAuthError = (error: unknown): boolean => error instanceof ApiError && (error.status === 401 || error.status === 403);

/** The form field a server error belongs to, when it named one this form has. */
export const fieldOf = <K extends string>(error: unknown, fields: readonly K[]): K | null => {
  if (!(error instanceof ApiError) || !error.field) return null;
  return (fields as readonly string[]).includes(error.field) ? (error.field as K) : null;
};

/** Like errorText, but a 429 whose body had no message of its own (the generic "Request failed (429)") gets a plain sentence. */
export const adminErrorText = (error: unknown, fallback = 'Something went wrong. Please try again.'): string => {
  if (error instanceof ApiError && error.status === 429 && (!error.message || /^Request failed/.test(error.message))) return 'Too many changes in a short time. Wait a few minutes, then try again.';
  return errorText(error, fallback);
};
