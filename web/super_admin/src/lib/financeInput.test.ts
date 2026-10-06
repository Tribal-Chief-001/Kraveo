import { describe, expect, it } from 'vitest';
import { newRequestId, validateAdjustment, validateHold, validateMarkPaid, validatePayoutAccount, validateRiderPayout, validateSettlementSettings } from './financeInput';

const NOW = Date.parse('2026-10-07T06:00:00Z'); // 7 Oct 2026, 11:30 India time

describe('mark paid (reference 3-64 chars, optional paid date and note)', () => {
  const form = (over: Partial<{ reference: string; paidDate: string; note: string }> = {}) => ({ reference: 'UTR123456', paidDate: '', note: '', ...over });
  it('accepts a plain reference and sends nothing else', () => {
    expect(validateMarkPaid(form(), NOW)).toEqual({ ok: true, value: { reference: 'UTR123456' } });
  });
  it('trims and collapses spaces in the reference', () => {
    expect(validateMarkPaid(form({ reference: '  UTR   123  ' }), NOW)).toEqual({ ok: true, value: { reference: 'UTR 123' } });
  });
  it('refuses empty, too short, too long and odd characters', () => {
    expect(validateMarkPaid(form({ reference: '' }), NOW)).toMatchObject({ ok: false, errors: { reference: expect.stringContaining('Enter') } });
    expect(validateMarkPaid(form({ reference: '   ' }), NOW).ok).toBe(false);
    expect(validateMarkPaid(form({ reference: 'ab' }), NOW)).toMatchObject({ ok: false, errors: { reference: expect.stringContaining('3 to 64') } });
    expect(validateMarkPaid(form({ reference: 'a'.repeat(65) }), NOW).ok).toBe(false);
    expect(validateMarkPaid(form({ reference: 'a'.repeat(64) }), NOW).ok).toBe(true);
    expect(validateMarkPaid(form({ reference: 'abc' }), NOW).ok).toBe(true);
    expect(validateMarkPaid(form({ reference: '<script>' }), NOW).ok).toBe(false);
    expect(validateMarkPaid(form({ reference: '-abc' }), NOW).ok).toBe(false);
    expect(validateMarkPaid(form({ reference: 'HDFC/2026:10#07_a.b-c' }), NOW).ok).toBe(true);
  });
  it('paid date: today or empty lets the server use now, an earlier day is noon India time, a future day is refused', () => {
    expect(validateMarkPaid(form({ paidDate: '2026-10-07' }), NOW)).toEqual({ ok: true, value: { reference: 'UTR123456' } });
    expect(validateMarkPaid(form({ paidDate: '2026-10-05' }), NOW)).toEqual({ ok: true, value: { reference: 'UTR123456', paidAt: '2026-10-05T12:00:00+05:30' } });
    expect(validateMarkPaid(form({ paidDate: '2026-10-08' }), NOW)).toMatchObject({ ok: false, errors: { paidDate: expect.stringContaining('future') } });
    expect(validateMarkPaid(form({ paidDate: '2026-13-01' }), NOW)).toMatchObject({ ok: false, errors: { paidDate: expect.any(String) } });
  });
  it('note at most 300 characters', () => {
    expect(validateMarkPaid(form({ note: ' paid via app ' }), NOW)).toEqual({ ok: true, value: { reference: 'UTR123456', note: 'paid via app' } });
    expect(validateMarkPaid(form({ note: 'x'.repeat(301) }), NOW)).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
  });
  it('reports every wrong field at once', () => {
    const r = validateMarkPaid(form({ reference: '', paidDate: '2030-01-01', note: 'x'.repeat(400) }), NOW);
    expect(r.ok === false && Object.keys(r.errors).sort()).toEqual(['note', 'paidDate', 'reference']);
  });
});

describe('hold', () => {
  it('note is optional, at most 300 characters', () => {
    expect(validateHold('')).toEqual({ ok: true, value: {} });
    expect(validateHold('  bank check  ')).toEqual({ ok: true, value: { note: 'bank check' } });
    expect(validateHold('x'.repeat(301)).ok).toBe(false);
  });
});

describe('adjustment (+/- amount with a reason, empty refused)', () => {
  it('accepts signed amounts with up to 2 decimals', () => {
    expect(validateAdjustment({ amount: '50', reason: 'Bonus for delay' })).toEqual({ ok: true, value: { amount: 50, reason: 'Bonus for delay' } });
    expect(validateAdjustment({ amount: '+25.5', reason: 'abc' })).toEqual({ ok: true, value: { amount: 25.5, reason: 'abc' } });
    expect(validateAdjustment({ amount: '-10.25', reason: 'Late handover' })).toEqual({ ok: true, value: { amount: -10.25, reason: 'Late handover' } });
    expect(validateAdjustment({ amount: '- 5', reason: 'Late handover' })).toEqual({ ok: true, value: { amount: -5, reason: 'Late handover' } });
  });
  it('refuses empty, zero, NaN, 3 decimals, too big', () => {
    for (const amount of ['', '  ', '0', '-0', '0.00', 'abc', '1e3', '10.123', '--5', '100000.01', '1000000']) {
      expect(validateAdjustment({ amount, reason: 'Late handover' }), amount).toMatchObject({ ok: false, errors: { amount: expect.any(String) } });
    }
    expect(validateAdjustment({ amount: '100000', reason: 'edge ok' }).ok).toBe(true);
    expect(validateAdjustment({ amount: '-100000', reason: 'edge ok' }).ok).toBe(true);
  });
  it('refuses an empty or too short or too long reason', () => {
    expect(validateAdjustment({ amount: '5', reason: '' })).toMatchObject({ ok: false, errors: { reason: expect.stringContaining('Enter a reason') } });
    expect(validateAdjustment({ amount: '5', reason: '   ' }).ok).toBe(false);
    expect(validateAdjustment({ amount: '5', reason: 'ab' }).ok).toBe(false);
    expect(validateAdjustment({ amount: '5', reason: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateAdjustment({ amount: '5', reason: 'x'.repeat(200) }).ok).toBe(true);
  });
  it('refuses a deduction that makes the payable amount negative (paise exact)', () => {
    const current = { vendorAmount: 100.1, adjustmentTotal: -20.05 };
    expect(validateAdjustment({ amount: '-80.05', reason: 'Refund share' }, current)).toEqual({ ok: true, value: { amount: -80.05, reason: 'Refund share' } });
    expect(validateAdjustment({ amount: '-80.06', reason: 'Refund share' }, current)).toMatchObject({ ok: false, errors: { amount: expect.stringContaining('negative') } });
  });
  it('request ids are unique and server-acceptable', () => {
    const a = newRequestId(); const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('rider payout', () => {
  const form = (over: Record<string, string> = {}) => ({ driverUserId: 'u1', method: 'UPI', amount: '250.50', reference: 'UTR123456', note: '', ...over });
  it('valid', () => {
    expect(validateRiderPayout(form())).toEqual({ ok: true, value: { driverUserId: 'u1', method: 'UPI', amount: 250.5, reference: 'UTR123456' } });
    expect(validateRiderPayout(form({ method: 'CASH', reference: '', note: ' weekly ' }))).toEqual({ ok: true, value: { driverUserId: 'u1', method: 'CASH', amount: 250.5, note: 'weekly' } });
  });
  it('refuses bad fields', () => {
    expect(validateRiderPayout(form({ driverUserId: '' }))).toMatchObject({ ok: false, errors: { driverUserId: expect.any(String) } });
    expect(validateRiderPayout(form({ method: 'WIRE' }))).toMatchObject({ ok: false, errors: { method: expect.any(String) } });
    for (const amount of ['', '0', '-5', '12.345', 'x', '100000.5']) expect(validateRiderPayout(form({ amount })), amount).toMatchObject({ ok: false, errors: { amount: expect.any(String) } });
    expect(validateRiderPayout(form({ reference: 'ab' }))).toMatchObject({ ok: false, errors: { reference: expect.any(String) } });
    expect(validateRiderPayout(form({ note: 'x'.repeat(301) }))).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
  });
});

describe('payout account', () => {
  const upi = { method: 'UPI', upiId: ' Ram@OkHdfcBank ', accountHolder: '', accountNumber: '', ifsc: '', bankName: '' };
  const bank = { method: 'BANK', upiId: '', accountHolder: 'Ram Singh', accountNumber: '5010 0234-567890', ifsc: 'hdfc0001234', bankName: 'HDFC Bank' };
  it('UPI id is lower-cased; holder optional', () => {
    expect(validatePayoutAccount(upi)).toEqual({ ok: true, value: { method: 'UPI', upiId: 'ram@okhdfcbank' } });
    expect(validatePayoutAccount({ ...upi, accountHolder: "Ram O'Neil" })).toMatchObject({ ok: true, value: { accountHolder: "Ram O'Neil" } });
    for (const upiId of ['', 'ram', 'ram@', '@upi', 'ram@1bank']) expect(validatePayoutAccount({ ...upi, upiId }), upiId).toMatchObject({ ok: false, errors: { upiId: expect.any(String) } });
  });
  it('bank: number without spaces, IFSC upper-cased, holder required', () => {
    expect(validatePayoutAccount(bank)).toEqual({ ok: true, value: { method: 'BANK', accountHolder: 'Ram Singh', accountNumber: '50100234567890', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' } });
    expect(validatePayoutAccount({ ...bank, accountHolder: '' })).toMatchObject({ ok: false, errors: { accountHolder: expect.any(String) } });
    expect(validatePayoutAccount({ ...bank, accountHolder: 'R2D2' })).toMatchObject({ ok: false, errors: { accountHolder: expect.any(String) } });
    expect(validatePayoutAccount({ ...bank, accountNumber: '' })).toMatchObject({ ok: false, errors: { accountNumber: expect.any(String) } });
    expect(validatePayoutAccount({ ...bank, accountNumber: '12345' }).ok).toBe(false);
    expect(validatePayoutAccount({ ...bank, accountNumber: '1'.repeat(21) }).ok).toBe(false);
    expect(validatePayoutAccount({ ...bank, accountNumber: '12ab5678' }).ok).toBe(false);
    expect(validatePayoutAccount({ ...bank, ifsc: 'HDFC1001234' }).ok).toBe(false);
    expect(validatePayoutAccount({ ...bank, ifsc: '' }).ok).toBe(false);
    expect(validatePayoutAccount({ ...bank, bankName: '' })).toMatchObject({ ok: true });
    expect(validatePayoutAccount({ ...bank, method: 'CASH' })).toMatchObject({ ok: false, errors: { method: expect.any(String) } });
  });
});

describe('settlement settings', () => {
  const good = { time: '22:00', mode: 'MANUAL_PAYOUT', autoCreate: true, holdDays: '0' };
  it('valid', () => {
    expect(validateSettlementSettings(good)).toEqual({ ok: true, value: { time: '22:00', mode: 'MANUAL_PAYOUT', autoCreate: true, holdDays: 0 } });
    expect(validateSettlementSettings({ ...good, time: '00:00', holdDays: '30', mode: 'AUTO_PAYOUT' }).ok).toBe(true);
  });
  it('refuses what the server refuses', () => {
    for (const time of ['25:00', '9:00', '22:60', '22:00:00', '', '2200']) expect(validateSettlementSettings({ ...good, time }), time).toMatchObject({ ok: false, errors: { time: expect.any(String) } });
    for (const holdDays of ['-1', '31', '1.5', 'x', '', '100']) expect(validateSettlementSettings({ ...good, holdDays }), holdDays).toMatchObject({ ok: false, errors: { holdDays: expect.any(String) } });
    expect(validateSettlementSettings({ ...good, mode: 'WIRE' })).toMatchObject({ ok: false, errors: { mode: expect.any(String) } });
    expect(validateSettlementSettings({ ...good, mode: '' }).ok).toBe(false);
  });
});
