import { errSummary } from './log';
import { Request, Response, NextFunction } from 'express';
import { OrderFlowError } from '../services/orderFlow';

/** Ids in this system are uuids or short seed/test ids: letters, digits, `_` and `-`. Anything else cannot exist. */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The one way a route answers an unexpected error: the cause is logged on the server and the client gets a
 * generic message (never Prisma text, file paths or code excerpts). Known OrderFlowErrors keep their
 * status/code/message. `what` names the operation in the log line.
 */
export const fail = (res: Response, err: unknown, what: string) => {
  if (err instanceof OrderFlowError) return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...err.extra });
  console.error(`${what} failed:`, errSummary(err));
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};

/** 400 for a path parameter that cannot be an id (`%00`, spaces, 500 chars...) instead of a 500 from the database. */
export const validParams = (...names: string[]) => (req: Request, res: Response, next: NextFunction) => {
  for (const name of names) {
    const v = req.params[name];
    if (typeof v !== 'string' || !ID_RE.test(v)) {
      return res.status(400).json({ success: false, code: 'BAD_REQUEST', field: name, message: `Invalid ${name}.` });
    }
  }
  return next();
};
