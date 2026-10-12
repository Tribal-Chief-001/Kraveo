import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { Router, Request, Response, NextFunction, Express } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { fail } from '../utils/http';
import { AppError } from '../utils/appError';
import { ImageError, probeImage } from '../utils/imageProbe';
import { writeAudit } from '../services/audit';

/**
 * Admin image upload (Docs/23 section 3.6) and the static serving of the stored files.
 *
 *  POST /api/admin/uploads/image?purpose=banner|dish   ADMIN only, raw body (image/jpeg | image/png | image/webp), <= 1 MB,
 *                                                      60 per hour per admin (middleware/rateLimit.ts, rule ADMIN_UPLOAD).
 *  GET  /uploads/<purpose>/<yyyy>/<32 hex>.<jpg|png|webp>   immutable, nosniff, CORP cross-origin (mountUploads below).
 *
 * The file type is decided by its MAGIC BYTES (utils/imageProbe.ts), never by the header or a client file name; the stored name is random.
 * Files live in UPLOAD_DIR (env, default /home/ubuntu/kraveo-uploads), OUTSIDE the git checkout, and must be part of the nightly backup.
 * Orphans (a banner or dish photo that no row points to any more) are NOT cleaned up automatically: a deliberate choice, a file is a few
 * hundred KB and deleting something an old app build or an old order may still show is worse than keeping it.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024;
export const MIN_SIDE_PX = 200;
export const MAX_SIDE_PX = 4000;
export const UPLOAD_PURPOSES = ['banner', 'dish'] as const;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FILE_PATH_RE = /^\/(banner|dish)\/\d{4}\/[0-9a-f]{32}\.(jpg|png|webp)$/;

/** Read on every call (tests and deployments set it at run time). */
export const uploadDir = (): string => path.resolve(process.env.UPLOAD_DIR || '/home/ubuntu/kraveo-uploads');
const publicBase = (): string => (process.env.PUBLIC_BASE_URL || 'https://api.kraveo.site').replace(/\/+$/, '');

export const uploadRouter = Router();

uploadRouter.post(
  '/admin/uploads/image',
  requireAuth,
  requireRole('ADMIN'),
  // The body parser runs only for an authenticated admin (the rate limiter in front of the router has already counted the call).
  express.raw({ type: ALLOWED_TYPES, limit: MAX_UPLOAD_BYTES }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const purpose = typeof req.query.purpose === 'string' ? req.query.purpose : '';
      if (!(UPLOAD_PURPOSES as readonly string[]).includes(purpose)) throw new AppError(400, 'BAD_REQUEST', "purpose must be 'banner' or 'dish'.", 'purpose');
      const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_TYPES.includes(declared)) {
        throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Only JPEG, PNG or WebP photos can be uploaded.');
      }
      const file = req.body;
      if (!Buffer.isBuffer(file) || file.length === 0) throw new AppError(400, 'EMPTY_FILE', 'No image was received.');

      let info;
      try {
        info = probeImage(file);
      } catch (e) {
        if (e instanceof ImageError) throw new AppError(e.code === 'NOT_AN_IMAGE' ? 415 : 400, e.code, e.message);
        throw e;
      }
      if (info.mime !== declared) throw new AppError(415, 'IMAGE_TYPE_MISMATCH', 'The file is not the kind of image its type says. Choose the photo again.');
      if (Math.min(info.width, info.height) < MIN_SIDE_PX) {
        throw new AppError(400, 'IMAGE_TOO_SMALL', `The photo is too small (${info.width}x${info.height}). The shorter side must be at least ${MIN_SIDE_PX} pixels.`);
      }
      if (Math.max(info.width, info.height) > MAX_SIDE_PX) {
        throw new AppError(400, 'IMAGE_DIMENSIONS_TOO_LARGE', `The photo is too big (${info.width}x${info.height}). The longer side can be at most ${MAX_SIDE_PX} pixels.`);
      }

      const year = String(new Date().getUTCFullYear());
      const name = `${randomBytes(16).toString('hex')}.${info.ext}`;
      const relative = `${purpose}/${year}/${name}`;
      const dir = path.join(uploadDir(), purpose, year);
      try {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
        // Written under a dot-name first and renamed: a half-written file is never served (dotfiles are ignored by the static handler).
        const tmp = path.join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
        await fs.promises.writeFile(tmp, file, { flag: 'wx', mode: 0o644 });
        await fs.promises.rename(tmp, path.join(dir, name));
      } catch (e) {
        console.error('image upload could not be stored:', (e as NodeJS.ErrnoException)?.code ?? 'error');
        throw new AppError(503, 'UPLOAD_UNAVAILABLE', 'Image storage is not available right now. Try again, or paste a link instead.');
      }
      await writeAudit('IMAGE_UPLOADED', 'UPLOAD', relative, `Admin uploaded a ${purpose} image (${info.width}x${info.height}, ${file.length} bytes, ${info.mime})`);
      return res.status(201).json({ success: true, data: { url: `${publicBase()}/uploads/${relative}`, width: info.width, height: info.height, bytes: file.length } });
    } catch (err) {
      return fail(res, err, 'image upload');
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// Static serving
// ---------------------------------------------------------------------------------------------------------------------
const statics = new Map<string, express.RequestHandler>();
const staticFor = (root: string): express.RequestHandler => {
  let handler = statics.get(root);
  if (!handler) {
    handler = express.static(root, {
      dotfiles: 'ignore',
      index: false,
      redirect: false,
      extensions: false,
      fallthrough: true,
      immutable: true,
      maxAge: '365d',
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // securityHeaders.ts does not set CORP; the admin portal (another origin) must be able to show these images.
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      },
    });
    statics.set(root, handler);
  }
  return handler;
};

const notFound = (_req: Request, res: Response) => res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' });

/**
 * Mounts GET /uploads/* on the app. Only paths of the exact shape we write are served (<purpose>/<year>/<32 hex>.<ext>): everything else
 * (../, encoded or double encoded dots, null bytes, dotfiles, directories, other methods) is a plain 404 before the file system is touched.
 */
export const mountUploads = (app: Express) => {
  app.use('/uploads', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(req, res);
    if (!FILE_PATH_RE.test(req.path)) return notFound(req, res);
    return staticFor(uploadDir())(req, res, (err?: unknown) => (err ? next(err) : notFound(req, res)));
  });
};
