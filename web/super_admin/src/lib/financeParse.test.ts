import { describe, expect, it } from 'vitest';
import {
  accountSummary, addDays, checkRange, dateLabel, emptySummary, istDateTime, istToday, parseByDay, parseByDish, parseByRestaurant, parseFinanceSummary, parsePayoutAccount,
  parsePayoutAccountResult, parsePendingSettlementCount, parseProviders, parseReveal, parseRiderPayoutPage, parseRiderPayoutResult, parseRiders, parseRunResult, parseSettlement,
  parseSettlementAction, parseSettlementDetail, parseSettlementPage, parseSettlementSettings, presetOf, presetRange,
} from './financeParse';
import {
  rawAccount, rawAccountResponse, rawAction, rawByDay, rawByDish, rawByRestaurant, rawProviders, rawReveal, rawRiderPayout, rawRiderPayoutList, rawRiders, rawRun,
  rawSettlement, rawSettlementDetail, rawSettlementList, rawSummary,
} from '../test/fixtures';

describe('India dates', () => {
  it('works on the India calendar, 5h30 ahead of UTC', () => {
    expect(istToday(Date.parse('2026-10-07T18:29:59Z'))).toBe('2026-10-07');
    expect(istToday(Date.parse('2026-10-07T18:30:00Z'))).toBe('2026-10-08');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });
  it('presets: today, 7 days and 30 days end today and include it', () => {
    const now = Date.parse('2026-10-07T06:00:00Z');
    expect(presetRange('today', now)).toEqual({ from: '2026-10-07', to: '2026-10-07' });
    expect(presetRange('7d', now)).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(presetRange('30d', now)).toEqual({ from: '2026-09-08', to: '2026-10-07' });
    expect(presetOf({ from: '2026-10-01', to: '2026-10-07' }, now)).toBe('7d');
    expect(presetOf({ from: '2026-10-02', to: '2026-10-07' }, now)).toBeNull();
  });
  it('checkRange refuses bad dates, a reversed range and one that is too long', () => {
    expect(checkRange('2026-10-01', '2026-10-07', 366)).toEqual({ ok: true, range: { from: '2026-10-01', to: '2026-10-07' } });
    expect(checkRange('2026-02-30', '2026-10-07', 366)).toMatchObject({ ok: false });
    expect(checkRange('', '2026-10-07', 366)).toMatchObject({ ok: false });
    expect(checkRange('2026-10-08', '2026-10-07', 366)).toMatchObject({ ok: false, message: expect.stringContaining('after') });
    expect(checkRange('2025-01-01', '2026-10-07', 366)).toMatchObject({ ok: false, message: expect.stringContaining('366') });
    expect(checkRange('2025-10-06', '2026-10-07', 366).ok).toBe(false); // 367 days
    expect(checkRange('2025-10-07', '2026-10-07', 366).ok).toBe(true); // exactly 366 days
  });
  it('labels', () => {
    expect(dateLabel('2026-10-07')).toBe('7 Oct 2026');
    expect(dateLabel('garbage')).toBe('garbage');
    expect(istDateTime('2026-10-07T16:30:00.000Z')).toBe('7 Oct 2026, 10:00 pm');
    expect(istDateTime('2026-10-07T18:30:00.000Z')).toBe('8 Oct 2026, 12:00 am');
    expect(istDateTime(null)).toBe('');
    expect(istDateTime('nope')).toBe('');
  });
});

describe('finance analytics parsers (real shapes)', () => {
  it('summary', () => {
    expect(parseFinanceSummary({ success: true, data: rawSummary() })).toMatchObject({
      range: { from: '2026-10-01', to: '2026-10-07', days: 7 }, orders: 4, foodGross: 1000, vendorAmount: 900, commission: 100, feesCollected: 100, discounts: 30.5, platformRevenue: 169.5,
      refunds: { count: 1, amount: 120 }, settledAmount: 600, unsettledAmount: 300, paidOutAmount: 450,
    });
  });
  it('missing or broken numbers become 0, never NaN; unknown fields are ignored; no object is null', () => {
    const s = parseFinanceSummary({ data: { orders: 'x', foodGross: null, commission: '12.5', platformRevenue: NaN, mystery: 1 } }, { from: '2026-10-01', to: '2026-10-02' })!;
    expect(s.orders).toBe(0);
    expect(s.foodGross).toBe(0);
    expect(s.commission).toBe(12.5);
    expect(s.platformRevenue).toBe(0);
    expect(s.refunds).toEqual({ count: 0, amount: 0 });
    expect(s.range).toEqual({ from: '2026-10-01', to: '2026-10-02', days: 2 });
    for (const value of Object.values(s)) if (typeof value === 'number') expect(Number.isNaN(value)).toBe(false);
    expect(parseFinanceSummary('nope')).toBeNull();
    expect(parseFinanceSummary(null)).toBeNull();
  });
  it('removes float noise from money', () => {
    expect(parseFinanceSummary({ data: { foodGross: 0.1 + 0.2 } })!.foodGross).toBe(0.3);
  });
  it('by day, by restaurant, by dish', () => {
    const day = parseByDay(rawByDay())!;
    expect(day.rows.map((r) => r.date)).toEqual(['2026-10-06', '2026-10-07']);
    expect(day.rows[1]).toMatchObject({ orders: 4, platformRevenue: 169.5, refunds: { count: 1, amount: 120 } });
    expect(day.rows[0].orders).toBe(0);
    expect(parseByRestaurant(rawByRestaurant())!.rows[0]).toMatchObject({ vendorId: 'v1', vendorName: 'Sharma Dhaba', vendorAmount: 900, unsettledAmount: 300 });
    expect(parseByDish(rawByDish('commission'))).toMatchObject({ sort: 'commission', rows: [{ name: 'Paneer Roll', units: 12, customerRevenue: 1344, vendorRevenue: 1200, commission: 144 }] });
    for (const parse of [parseByDay, parseByRestaurant, parseByDish, parseRiders]) { expect(parse({ success: true })).toBeNull(); expect(parse({ data: 'x' })).toBeNull(); }
  });
  it('riders keep rows without a name and use the server totals', () => {
    const r = parseRiders(rawRiders())!;
    expect(r.totals).toEqual({ riders: 2, deliveries: 7, payoutTotal: 250.5 });
    expect(r.rows[0]).toMatchObject({ driverUserId: 'u-rider1', name: 'Ravi Kumar', runnerCode: 'R101', deliveries: 5, payouts: { count: 1, total: 250.5, lastAt: '2026-10-07T08:00:00.000Z' } });
    expect(r.rows[0].byDay).toEqual([{ date: '2026-10-06', deliveries: 2 }, { date: '2026-10-07', deliveries: 3 }]);
    expect(r.rows[1]).toMatchObject({ name: null, runnerCode: null, payouts: { count: 0, total: 0, lastAt: null } });
    // without totals they are added up from the rows
    expect(parseRiders({ data: rawRiders().data })!.totals).toEqual({ riders: 2, deliveries: 7, payoutTotal: 250.5 });
  });
});

describe('payout accounts', () => {
  it('admin view is masked and never carries a full number', () => {
    const a = parsePayoutAccount(rawAccount())!;
    expect(a).toMatchObject({ method: 'BANK', accountLast4: '7890', accountMasked: 'XXXXXX7890', ifsc: 'HDFC0001234', verified: false });
    expect(JSON.stringify(a)).not.toMatch(/\d{9,}/);
    expect(accountSummary(a)).toBe('XXXXXX7890');
    expect(parsePayoutAccount(rawAccount({ verifiedAt: '2026-10-07T00:00:00.000Z', verifiedBy: 'admin1' }))!.verified).toBe(true);
    expect(accountSummary(parsePayoutAccount(rawAccount({ method: 'UPI', upiId: 'a@upi', accountLast4: null, accountMasked: null })))).toBe('a@upi');
    expect(parsePayoutAccount(rawAccount({ accountMasked: undefined }))!.accountMasked).toBe('XXXXXX7890'); // built from last 4 when absent
    expect(parsePayoutAccount(null)).toBeNull();
    expect(parsePayoutAccount({ method: '' })).toBeNull();
  });
  it('the GET answer: partner + data (null = no payout details)', () => {
    expect(parsePayoutAccountResult(rawAccountResponse())).toMatchObject({ partner: { userId: 'u-owner1', name: 'PA Owner One', role: 'VENDOR' }, account: { method: 'BANK' } });
    expect(parsePayoutAccountResult({ success: true, partner: { userId: 'u1', name: 'A', role: 'DRIVER' }, data: null })).toMatchObject({ account: null, changed: null });
    expect(parsePayoutAccountResult({ success: true, changed: true, message: 'Saved', data: rawAccount() })).toMatchObject({ changed: true, message: 'Saved' });
    expect(parsePayoutAccountResult('x')).toBeNull();
  });
  it('reveal', () => {
    expect(parseReveal(rawReveal())).toEqual({ method: 'BANK', upiId: null, accountHolder: 'Ram Singh', accountNumber: '50100234567890', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' });
    expect(parseReveal({ data: {} })).toBeNull();
  });
});

describe('settlements', () => {
  it('one settlement, all real fields', () => {
    expect(parseSettlement(rawSettlement())).toMatchObject({
      id: 's1111111-aaaa', vendorName: 'Sharma Dhaba', status: 'PENDING', orderCount: 3, foodGross: 400, vendorAmount: 360, commissionAmount: 40, netPayable: 360,
      payoutSnapshot: { method: 'UPI', destination: 'kitchen1@upi', accountHolder: 'Kitchen One', verified: false }, hasPayoutDetails: true, paymentReference: null, createdBy: 'AUTO',
    });
    const none = parseSettlement(rawSettlement({ payoutSnapshot: null, hasPayoutDetails: false }))!;
    expect(none.payoutSnapshot).toBeNull();
    expect(none.hasPayoutDetails).toBe(false);
    expect(parseSettlement({ vendorName: 'x' })).toBeNull();
    expect(parseSettlement(rawSettlement({ netPayable: undefined, orderCount: 'x' }))).toMatchObject({ netPayable: 0, orderCount: 0 });
    expect(parseSettlement(rawSettlement({ status: 'on_hold' }))!.status).toBe('ON_HOLD');
  });
  it('list with summary; a status the dashboard does not know still lists', () => {
    const page = parseSettlementPage(rawSettlementList([rawSettlement(), rawSettlement({ id: 's2', status: 'FUTURE' }), 'junk'], { PAID: { count: 2, netPayable: 99.5 } }))!;
    expect(page.items.map((s) => s.id)).toEqual(['s1111111-aaaa', 's2']);
    expect(page.items[1].status).toBe('FUTURE');
    expect(page.summary.PAID).toEqual({ count: 2, netPayable: 99.5 });
    expect(page).toMatchObject({ page: 1, pageSize: 25, pages: 1 });
    expect(parseSettlementPage({ data: [] })!.summary).toEqual(emptySummary());
    expect(parseSettlementPage({ success: true })).toBeNull();
  });
  it('pending count for the sidebar badge', () => {
    expect(parsePendingSettlementCount(rawSettlementList([rawSettlement()], { PENDING: { count: 7, netPayable: 1 } }, { total: 7 }))).toBe(7);
    expect(parsePendingSettlementCount({ data: [], total: 3 })).toBe(3);
    expect(parsePendingSettlementCount(null)).toBeNull();
  });
  it('detail', () => {
    const d = parseSettlementDetail({ success: true, data: rawSettlementDetail() })!;
    expect(d.vendor).toEqual({ id: 'v1', name: 'Sharma Dhaba', userId: 'u-owner1' });
    expect(d.payoutAccount).toMatchObject({ accountMasked: 'XXXXXX7890' });
    expect(d.orders[0]).toMatchObject({ id: 'order-aaaa-1111', subtotal: 200, vendorSubtotal: 180, commissionTotal: 20, totalAmount: 225 });
    expect(d.adjustments).toEqual([{ id: 'a1', amount: -10.5, reason: 'Late handover', createdBy: 'admin1', createdAt: '2026-10-07T17:00:00.000Z' }]);
    expect(d.dishes[0]).toMatchObject({ name: 'Paneer Roll', units: 4, vendorRevenue: 360, commission: 40 });
    expect(d.ordersTruncated).toBe(false);
    expect(parseSettlementDetail(rawSettlementDetail({ payoutAccount: null }) && { data: rawSettlementDetail({ payoutAccount: null }) })!.payoutAccount).toBeNull();
    expect(parseSettlementDetail({ data: { settlement: null } })).toBeNull();
    expect(parseSettlementDetail('x')).toBeNull();
  });
  it('actions', () => {
    const paid = parseSettlementAction(rawAction(rawSettlement({ status: 'PAID', paymentReference: 'UTR123456' }), { message: 'Marked as paid.' }));
    expect(paid).toMatchObject({ changed: true, message: 'Marked as paid.', settlement: { status: 'PAID', paymentReference: 'UTR123456' }, freedOrders: null });
    expect(parseSettlementAction({ success: true, changed: false, data: rawSettlement() }).changed).toBe(false);
    expect(parseSettlementAction({ success: true, changed: true, freedOrders: 3, data: rawSettlement({ status: 'CANCELLED' }) }).freedOrders).toBe(3);
    expect(parseSettlementAction({ adjustment: { id: 'a', amount: 5, reason: 'x' } }).adjustment).toMatchObject({ amount: 5 });
    expect(parseSettlementAction(null)).toMatchObject({ settlement: null, changed: true });
  });
  it('run result', () => {
    const r = parseRunResult(rawRun());
    expect(r).toMatchObject({ message: '1 settlement(s) created for 3 order(s).', orderCount: 3, netPayable: 360, holdDays: 0, skipped: [], failed: [] });
    expect(r.created).toHaveLength(1);
    expect(parseRunResult({ success: true, message: 'Nothing to settle: no delivered, paid order is waiting.', data: { created: [], skipped: [{ vendorId: 'v', reason: 'ALREADY_CREATED_FOR_THIS_DAY' }], failed: [{ vendorId: 'w' }] } })).toMatchObject({ created: [], skipped: [{ vendorId: 'v', reason: 'ALREADY_CREATED_FOR_THIS_DAY' }], failed: [{ vendorId: 'w' }], orderCount: 0 });
    expect(parseRunResult(undefined)).toMatchObject({ created: [], message: '' });
  });
});

describe('rider payouts, providers, settings', () => {
  it('ledger page and record answer', () => {
    const page = parseRiderPayoutPage(rawRiderPayoutList())!;
    expect(page).toMatchObject({ total: 1, pages: 1, totalAmount: 250.5 });
    expect(page.items[0]).toMatchObject({ driverName: 'Ravi Kumar', amount: 250.5, method: 'UPI', reference: 'UTR123456' });
    expect(parseRiderPayoutPage({ success: true })).toBeNull();
    expect(parseRiderPayoutResult({ success: true, changed: false, message: 'This payout was already recorded.', data: rawRiderPayout() })).toMatchObject({ changed: false, payout: { id: 'p1' } });
  });
  it('providers', () => {
    expect(parseProviders(rawProviders())).toEqual([{ name: 'manual', enabled: true, reason: null }, { name: 'razorpayx', enabled: false, reason: 'RazorpayX payouts are not configured.' }]);
    expect(parseProviders({ data: 'x' })).toBeNull();
  });
  it('settlement settings value', () => {
    expect(parseSettlementSettings({ time: '22:00', mode: 'MANUAL_PAYOUT', autoCreate: true, holdDays: 0 })).toEqual({ time: '22:00', mode: 'MANUAL_PAYOUT', autoCreate: true, holdDays: 0 });
    expect(parseSettlementSettings({ step: 1 })).toEqual({ time: null, mode: null, autoCreate: null, holdDays: null });
    expect(parseSettlementSettings({ time: '25:00', mode: 'WIRE', autoCreate: 'yes', holdDays: 1.5 })).toEqual({ time: null, mode: null, autoCreate: null, holdDays: null });
  });
});

describe('rupeesSigned', () => {
  it('puts the minus before the symbol and keeps paise rules', async () => {
    const { rupeesSigned } = await import('./financeParse');
    expect(rupeesSigned(-10.5)).toBe('-₹10.50');
    expect(rupeesSigned(-10)).toBe('-₹10');
    expect(rupeesSigned(10.5)).toBe('₹10.50');
    expect(rupeesSigned(0)).toBe('₹0');
    expect(rupeesSigned(-0.001)).toBe('₹0');
    expect(rupeesSigned(NaN)).toBe('—');
    expect(rupeesSigned(null)).toBe('—');
  });
});
