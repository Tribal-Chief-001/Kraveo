/**
 * Boot-time configuration check. Pure (takes the env as an argument) so it can be tested.
 * Hard requirements stop the server from starting; soft ones are returned as warnings.
 * Runs whenever NODE_ENV is not 'test' (a staging box or a mistyped NODE_ENV must not start with an empty JWT secret).
 */
export const REQUIRED_CONFIG = ['JWT_SECRET', 'DATABASE_URL', 'ADMIN_PASSCODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const;
export const RECOMMENDED_CONFIG = ['GOOGLE_WEB_CLIENT_ID'] as const;

export const assertRuntimeConfig = (env: Record<string, string | undefined>): { warnings: string[] } => {
  const blank = (k: string) => !env[k] || !String(env[k]).trim();
  const missing = REQUIRED_CONFIG.filter(blank);
  if (missing.length > 0) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  const warnings: string[] = [];
  for (const key of RECOMMENDED_CONFIG) {
    if (blank(key)) warnings.push(`${key} is not set: student Google sign-in will answer 503 until it is configured.`);
  }
  return { warnings };
};
