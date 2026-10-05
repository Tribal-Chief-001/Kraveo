import { Request, Response, NextFunction } from 'express';

/**
 * Small set of defensive response headers for the JSON API (no dependency on helmet).
 *  - X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy: no-referrer
 *  - Strict-Transport-Security (6 months) ONLY when the request arrived over https. Production sits behind nginx, which sets
 *    X-Forwarded-Proto; `app.set('trust proxy', 1)` makes `req.secure` honour it. Plain-http requests (local dev, health
 *    checks on the box itself) never get HSTS.
 *  - X-Powered-By is removed.
 * Does not touch CORS headers, and socket.io answers its own handshake requests before Express runs, so neither is affected.
 */
export const HSTS_VALUE = 'max-age=15552000';

export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure) res.setHeader('Strict-Transport-Security', HSTS_VALUE);
  next();
};
