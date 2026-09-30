import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export class GoogleAuthError extends Error {
  constructor(public status: 401 | 503, message: string) {
    super(message);
  }
}

type Verifier = (idToken: string) => Promise<GoogleIdentity>;

const audiences = (): string[] =>
  (process.env.GOOGLE_WEB_CLIENT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);

let client: OAuth2Client | null = null;

const defaultVerifier: Verifier = async (idToken) => {
  const aud = audiences();
  if (aud.length === 0) throw new GoogleAuthError(503, 'Google sign-in is not configured on the server yet.');
  client ??= new OAuth2Client();
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: aud });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error('Token has no subject or email.');
    return { sub: p.sub, email: p.email.toLowerCase(), emailVerified: p.email_verified === true, name: p.name || p.email.split('@')[0] };
  } catch (err) {
    if (err instanceof GoogleAuthError) throw err;
    throw new GoogleAuthError(401, 'Google sign-in could not be verified. Please try again.');
  }
};

let verifier: Verifier = defaultVerifier;

/** Tests inject a fake verifier; pass null to restore the real one. */
export const setGoogleVerifier = (v: Verifier | null) => {
  verifier = v ?? defaultVerifier;
};

export const verifyGoogleIdToken = (idToken: string) => verifier(idToken);
