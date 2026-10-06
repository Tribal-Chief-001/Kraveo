import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppError } from '../utils/appError';

/**
 * Encryption of bank account numbers at rest (Docs/21 sections 2 and 9). AES-256-GCM, key from the environment variable
 * PAYOUT_ENC_KEY (32 random bytes, base64: `openssl rand -base64 32`). The key lives only in the server environment, never in the repo.
 *
 * Stored form: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). A fresh 12-byte random IV per value, and the owner's user id is bound
 * in as additional authenticated data, so a ciphertext copied into another user's row does not decrypt.
 *
 * Nothing here ever logs or returns a plain value in an error. A missing or malformed key is a 503 (the feature is switched off,
 * the rest of the API keeps working): UPI ids are not secret and never touch this module.
 */
const VERSION = 'v1';
const IV_BYTES = 12;

export const NOT_CONFIGURED_MESSAGE = 'Payout encryption is not configured on the server, so bank accounts cannot be saved yet. UPI ids still work.';

/** The key, or a 503 AppError. Read on every call so tests (and a restart with a new env) see the current value. */
const loadKey = (): Buffer => {
  const raw = process.env.PAYOUT_ENC_KEY;
  if (!raw || !raw.trim()) throw new AppError(503, 'PAYOUT_ENCRYPTION_NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new AppError(503, 'PAYOUT_ENCRYPTION_NOT_CONFIGURED', 'Payout encryption is misconfigured on the server (PAYOUT_ENC_KEY must be 32 random bytes, base64).');
  return key;
};

export const payoutEncryptionConfigured = (): boolean => {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
};

export const encryptSecret = (plain: string, aad: string): string => {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
};

export const decryptSecret = (stored: string, aad: string): string => {
  const key = loadKey();
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new AppError(500, 'PAYOUT_DECRYPT_FAILED', 'The stored account number could not be read.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, tampered value or another user's ciphertext: say so without any detail.
    throw new AppError(500, 'PAYOUT_DECRYPT_FAILED', 'The stored account number could not be decrypted (wrong key or damaged value).');
  }
};

/** Last 4 digits of an account number (the only part that is ever stored in clear or shown). */
export const last4 = (accountNumber: string): string => accountNumber.slice(-4);

/** `XXXXXX1234`: what screens and exports show. Null when there is nothing to show. */
export const maskAccount = (last4Digits: string | null | undefined): string | null => (last4Digits ? `XXXXXX${last4Digits}` : null);
