import { errSummary } from '../utils/log';
import { Request, Response, NextFunction } from 'express';

/**
 * Global Express error handler (shared by src/index.ts and the test harness).
 * body-parser errors keep their meaning (413 too large, 400 bad JSON); any other 4xx an error carries
 * is kept; everything else is logged here and answered with a generic 500 (no internals to the client).
 */
export const globalErrorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
    return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' });
  }
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && ((err as any).status === 400 || 'body' in err))) {
    return res.status(400).json({ success: false, code: 'BAD_REQUEST', message: 'Invalid or malformed JSON payload.' });
  }
  const status = Number(err?.status ?? err?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    const message = status === 403 && err?.code === 'CORS_NOT_ALLOWED' ? 'Origin is not allowed.' : 'The request could not be processed.';
    return res.status(status).json({ success: false, code: err?.code === 'CORS_NOT_ALLOWED' ? 'CORS_NOT_ALLOWED' : 'BAD_REQUEST', message });
  }
  console.error(`unhandled error on ${req.method} ${req.path}:`, errSummary(err));
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};
