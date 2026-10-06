import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { UserRole } from '../types';
import { prisma } from '../db';

dotenv.config();

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    phone?: string | null;
    role: UserRole;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'test' ? 'kraveo_vit_bhopal_super_secret_jwt_key_2026' : '');

const getJwtSecret = (): string => {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not configured.');
  return JWT_SECRET;
};

type TokenClaims = { id: string; phone?: string | null; role: UserRole; tv?: number };

// Generates real signed JWT tokens with 30-day expiration. `tv` is the user's tokenVersion: bumping it in the
// database (password reset, suspension, account deletion) revokes every token issued before.
export const generateToken = (payload: { id: string; phone?: string | null; role: UserRole; tokenVersion?: number | null }): string => {
  const { tokenVersion, ...claims } = payload;
  return jwt.sign({ ...claims, tv: tokenVersion ?? 0 }, getJwtSecret(), { expiresIn: '30d' });
};

// ---------------------------------------------------------------------------------------------
// Account check: a token is only good while its user exists and tokenVersion still matches.
// A small in-memory cache (default 15 s, cleared on every bump) keeps this off the hot path.
// Only "account is fine" is cached, so a ghost/revoked token is re-checked every time.
// ---------------------------------------------------------------------------------------------
const authCache = new Map<string, { tv: number; until: number }>();
const cacheTtlMs = () => {
  const raw = process.env.AUTH_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '' && Number.isFinite(Number(raw))) return Math.max(0, Number(raw));
  return process.env.NODE_ENV === 'test' ? 0 : 15_000; // tests change rows directly: no stale cache by default
};

/** Forget what we know about a user (call right after changing their tokenVersion or deleting them). */
export const invalidateAuthCache = (userId?: string) => (userId ? authCache.delete(userId) : authCache.clear());

/** True when the user exists and `tv` (missing claim = 0) equals the stored tokenVersion. */
export const accountMatchesToken = async (userId: string, tv: unknown): Promise<boolean> => {
  const claimed = typeof tv === 'number' && Number.isInteger(tv) ? tv : 0;
  const now = Date.now();
  const hit = authCache.get(userId);
  if (hit && hit.until > now) return hit.tv === claimed;
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true, deletedAt: true } });
  if (!row || row.deletedAt) {
    authCache.delete(userId);
    return false;
  }
  const ttl = cacheTtlMs();
  if (ttl > 0) authCache.set(userId, { tv: row.tokenVersion, until: now + ttl });
  return row.tokenVersion === claimed;
};

/** Revoke every token of a user right now (and drop the cache entry on this instance). */
export const bumpTokenVersion = async (userId: string) => {
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
  invalidateAuthCache(userId);
};

/** Verifies signature + expiry only (no database). Throws on an invalid token. */
export const verifyToken = (token: string) => jwt.verify(token, getJwtSecret()) as TokenClaims;

/** Signature + expiry + account check (exists, not deleted, tokenVersion). Throws on anything wrong. Used by sockets. */
export const verifyTokenForAccount = async (token: string): Promise<TokenClaims> => {
  const decoded = verifyToken(token);
  if (!decoded?.id || typeof decoded.id !== 'string' || !(await accountMatchesToken(decoded.id, decoded.tv))) throw new Error('Token revoked or account missing.');
  return decoded;
};

/** True when this (already signature-verified) token's user is a partner whose profile is currently SUSPENDED. Never throws. */
const partnerIsSuspended = async (userId: string, role: unknown): Promise<boolean> => {
  try {
    if (role === 'VENDOR') return (await prisma.vendor.count({ where: { userId, approvalStatus: 'SUSPENDED' } })) > 0 && (await prisma.vendor.count({ where: { userId, approvalStatus: 'APPROVED' } })) === 0;
    if (role === 'DRIVER') return (await prisma.driverPartner.count({ where: { userId, approvalStatus: 'SUSPENDED' } })) > 0;
    return false;
  } catch {
    return false;
  }
};

// Middleware to verify JWT authentication header
export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Missing or malformed Bearer token.'
    });
  }

  const token = authHeader.split(' ')[1];

  let decoded: TokenClaims;
  try {
    decoded = verifyToken(token);
    if (!decoded?.id || typeof decoded.id !== 'string') throw new Error('no subject');
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authentication token.'
    });
  }

  try {
    if (!(await accountMatchesToken(decoded.id, decoded.tv))) {
      // The signature and expiry verified and the id belongs to a real account, so this is a session that account really held:
      // it may be told WHY it ended when the admin paused the partner. Anyone without a validly signed token never gets here.
      const suspended = await partnerIsSuspended(decoded.id, decoded.role);
      if (suspended) {
        return res.status(401).json({ success: false, code: 'TOKEN_REVOKED', reason: 'ACCOUNT_SUSPENDED', message: 'Your Kraveo account is paused. Log in to see why, or ask Kraveo support.' });
      }
      return res.status(401).json({ success: false, code: 'TOKEN_REVOKED', message: 'This session is no longer valid. Please sign in again.' });
    }
  } catch (error) {
    console.error('auth account check failed:', (error as Error).message);
    return res.status(503).json({ success: false, message: 'Service temporarily unavailable. Please try again.' });
  }
  req.user = { id: decoded.id, phone: decoded.phone, role: decoded.role };
  return next();
};

export const authenticateJwt = requireAuth;

// Role-Based Access Control (RBAC) middleware
export const requireRole = (...allowedRoles: UserRole[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden. Role '${req.user.role}' is not authorized to access this resource.`
      });
    }

    return next();
  };
};
