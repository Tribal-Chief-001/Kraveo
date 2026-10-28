import express from 'express';

/**
 * JSON size limits (Docs/23 section 3.5 and review #12). The global parser keeps its 100 KB default for everything, EXCEPT the menu import:
 * up to 200 dishes with descriptions and image links can pass 100 KB, so that one route has a 400 KB parser of its own. To keep it from
 * reading 400 KB for anonymous callers, the global parser skips that path (`jsonUnlessMenuImport`) and the route runs authentication and the
 * ADMIN check BEFORE its own parser (routes/catalog.ts). A spelling of the URL that the skip does not match is simply parsed by the global
 * parser with the 100 KB limit (413), never with a bigger one.
 */
export const IMPORT_JSON_LIMIT = '400kb';
const IMPORT_PATH_RE = /^\/api\/admin\/vendors\/[^/]+\/menu-import\/?$/i;
/** Docs/25: the public banner events call has its own 2 KB parser (routes/banners.ts); the global 100 KB parser skips it. */
export const EVENTS_JSON_LIMIT = '2kb';
const EVENTS_PATH_RE = /^\/api\/banners\/events\/?$/i;

export const menuImportJson = express.json({ limit: IMPORT_JSON_LIMIT });

/** `type` option of the global express.json(): JSON bodies, except those of the menu import. */
export const jsonUnlessMenuImport = (req: unknown): boolean => {
  const r = req as { url?: string; is?: (t: string) => string | false | null };
  const pathOnly = String(r.url ?? '').split('?')[0];
  if (IMPORT_PATH_RE.test(pathOnly) || EVENTS_PATH_RE.test(pathOnly)) return false;
  return !!r.is?.('application/json');
};
