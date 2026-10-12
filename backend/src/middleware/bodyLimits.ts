import express, { Express } from 'express';

/**
 * Route-specific JSON size limits that must be mounted BEFORE the global `express.json()` (which keeps its 100 KB default for everything
 * else): a body-parser that already read a body marks the request as parsed, so the global one skips it.
 *  - POST /api/admin/vendors/:id/menu-import: up to 200 dishes with descriptions and image links can pass 100 KB (Docs/23 section 3.5).
 * A spelling of the URL that this mount does not match simply falls back to the global 100 KB limit (413), never to "unlimited".
 */
export const IMPORT_JSON_LIMIT = '400kb';

export const mountBodyLimits = (app: Express) => {
  app.post('/api/admin/vendors/:id/menu-import', express.json({ limit: IMPORT_JSON_LIMIT }));
};
