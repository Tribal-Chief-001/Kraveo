import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '../types';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    phone: string;
    role: UserRole;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'kraveo_vit_bhopal_super_secret_jwt_key_2026';

// Generates real signed JWT tokens with 30-day expiration
export const generateToken = (payload: { id: string; phone: string; role: UserRole }): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
};

// Middleware to verify JWT authentication header
export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Missing or malformed Bearer token.'
    });
  }

  const token = authHeader.split(' ')[1];

  // Allow mock fallback tokens for initial developer client convenience if in development
  if (process.env.NODE_ENV === 'development' && token.startsWith('mock_jwt_token_')) {
    const userId = token.replace('mock_jwt_token_', '');
    req.user = { id: userId, phone: '+91 9876543210', role: 'ADMIN' };
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; phone: string; role: UserRole };
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authentication token.'
    });
  }
};

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
