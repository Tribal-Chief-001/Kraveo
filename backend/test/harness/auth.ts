import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET || 'kraveo_vit_bhopal_super_secret_jwt_key_2026';

export interface TokenPayload {
  id: string;
  phone: string;
  role: Role;
}

export const generateTestToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
};

export const getStudentToken = (id: string = 'usr-1', phone: string = '+91 9876543210'): string => {
  return generateTestToken({ id, phone, role: Role.STUDENT });
};

export const getVendorToken = (id: string = 'usr-3', phone: string = '+91 9876543212'): string => {
  return generateTestToken({ id, phone, role: Role.VENDOR });
};

export const getDriverToken = (id: string = 'usr-4', phone: string = '+91 9876543213'): string => {
  return generateTestToken({ id, phone, role: Role.DRIVER });
};

export const getAdminToken = (id: string = 'usr-5', phone: string = '+91 9876543214'): string => {
  return generateTestToken({ id, phone, role: Role.ADMIN });
};

export const getAuthHeader = (token: string) => {
  return { Authorization: `Bearer ${token}` };
};
