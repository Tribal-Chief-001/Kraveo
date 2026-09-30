/** `+91 98765 43210`, `09876543210`, `9876543210` -> `+91 9876543210`; null when not a valid Indian mobile. */
export const canonicalPhone = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  const tail = digits.slice(-10);
  if (digits.length < 10 || digits.length > 13 || !/^[6-9]\d{9}$/.test(tail)) return null;
  return `+91 ${tail}`;
};

export const last10 = (canonical: string) => canonical.replace(/\D/g, '').slice(-10);
