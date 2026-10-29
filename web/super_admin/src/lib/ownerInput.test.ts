import { describe, expect, it } from 'vitest';
import { LOGIN_ID_RE, newOwnerBody, phoneDigits, validateName, validateOwnerForm, validatePhone } from './ownerInput';

describe('owner form rules', () => {
  it('phones typed any common way give the same 10 digits; junk gives null', () => {
    for (const raw of ['9876543210', '+91 98765 43210', '09876543210', '91-9876543210', ' 98765 43210 ']) expect(phoneDigits(raw)).toBe('9876543210');
    for (const raw of ['', '12345', '5876543210', '98765432101234567', 'abcdefghij']) expect(phoneDigits(raw)).toBeNull();
    expect(validatePhone('1234')).toContain('10-digit');
    expect(validatePhone('9876543210')).toBe('');
  });
  it('names: letters first, no symbols, 2 to 60 characters', () => {
    expect(validateName('Ramesh Sharma')).toBe('');
    expect(validateName("D'Souza-Rao Jr.")).toBe('');
    expect(validateName('  Ana   Lee ')).toBe('');
    expect(validateName('A')).not.toBe('');
    expect(validateName('<script>')).not.toBe('');
    expect(validateName('9lives')).not.toBe('');
    expect(validateName('x'.repeat(70))).not.toBe('');
  });
  it('the password is checked only when the admin types one', () => {
    const f = { name: 'Ramesh', phone: '9876543210', generate: true, password: '' };
    expect(validateOwnerForm(f)).toEqual({});
    expect(validateOwnerForm({ ...f, generate: false, password: 'short' }).password).toContain('8');
    expect(validateOwnerForm({ ...f, generate: false, password: 'longenough' })).toEqual({});
    expect(validateOwnerForm({ ...f, name: '', phone: 'x' })).toMatchObject({ name: expect.any(String), phone: expect.any(String) });
  });
  it('the request body: generated = no password key at all; typed = the password; payout move only when asked', () => {
    expect(newOwnerBody({ name: ' Ramesh  K ', phone: '+91 98765 43210', generate: true, password: 'ignored' })).toEqual({ name: 'Ramesh K', phone: '9876543210' });
    expect(newOwnerBody({ name: 'Ramesh', phone: '9876543210', generate: false, password: 'longenough' }, 'u-9')).toEqual({ name: 'Ramesh', phone: '9876543210', password: 'longenough', takePayoutAccountFrom: 'u-9' });
  });
  it('login ids look like the server accepts them', () => {
    expect(LOGIN_ID_RE.test('zc-vown-2')).toBe(true);
    expect(LOGIN_ID_RE.test('has space')).toBe(false);
    expect(LOGIN_ID_RE.test('')).toBe(false);
  });
});
