// Owner login form rules (Docs/28 section 5). The server checks everything again; this only saves a round trip and words the problems.
export interface OwnerForm { name: string; phone: string; generate: boolean; password: string }
export type OwnerFormErrors = Partial<Record<'name' | 'phone' | 'password', string>>;

/** The 10 digits of an Indian mobile number typed in any common way ("+91 98765 43210", "09876543210"), or null. */
export const phoneDigits = (raw: string): string | null => {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  const tail = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(tail) ? tail : null;
};

export const collapseName = (raw: string): string => raw.replace(/\s+/g, ' ').trim();
// Same shape as the server's NAME_RE: starts with a letter, 2 to 60 characters, letters / marks / digits / space . ' -
const NAME_RE = /^[\p{L}][\p{L}\p{M}\p{Nd} .'’-]{1,59}$/u;

export const validateName = (raw: string): string => (NAME_RE.test(collapseName(raw).replace(/[()]/g, '')) ? '' : 'Enter the owner name (2 to 60 characters, no symbols).');
export const validatePhone = (raw: string): string => (phoneDigits(raw) ? '' : 'Enter a valid 10-digit Indian mobile number.');

export const validateOwnerForm = (f: OwnerForm): OwnerFormErrors => {
  const errors: OwnerFormErrors = {};
  const name = validateName(f.name); if (name) errors.name = name;
  const phone = validatePhone(f.phone); if (phone) errors.phone = phone;
  if (!f.generate) {
    if (f.password.length < 8) errors.password = 'Use at least 8 characters.';
    else if (f.password.length > 128) errors.password = 'That password is too long.';
  }
  return errors;
};

/** The body of POST /owner for a new login. A typed password is sent only when "generate" is off. */
export const newOwnerBody = (f: OwnerForm, takePayoutAccountFrom?: string): { name: string; phone: string; password?: string; takePayoutAccountFrom?: string } => ({
  name: collapseName(f.name),
  phone: phoneDigits(f.phone) ?? f.phone.trim(),
  ...(f.generate ? {} : { password: f.password }),
  ...(takePayoutAccountFrom ? { takePayoutAccountFrom } : {}),
});

export const LOGIN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
