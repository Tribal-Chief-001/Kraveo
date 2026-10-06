// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiService, clearAuthToken, setAuthToken } from './api';
import {
  RANGE, rawAccount, rawAccountResponse, rawAction, rawByDay, rawByDish, rawByRestaurant, rawProviders, rawReveal, rawRiderPayout, rawRiderPayoutList, rawRiders, rawRun,
  rawSettlement, rawSettlementDetail, rawSettlementList, rawSummary,
} from '../test/fixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAuthToken(); localStorage.clear(); });

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (body: unknown, status = 200) => {
  setAuthToken('tokentokentoken');
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const call = (f: ReturnType<typeof stub>) => ({ url: String(f.mock.calls[0][0]).replace(/^https?:\/\/[^/]+/, ''), init: (f.mock.calls[0][1] ?? {}) as RequestInit });
const body = (f: ReturnType<typeof stub>) => JSON.parse(call(f).init.body as string);
const range = { from: RANGE.from, to: RANGE.to };

describe('finance analytics calls', () => {
  it('summary, by-day, by-restaurant, by-dish and riders use the contract paths with the date range', async () => {
    let f = stub({ success: true, data: rawSummary() });
    expect(await apiService.fetchFinanceSummary(range)).toMatchObject({ orders: 4, platformRevenue: 169.5 });
    expect(call(f).url).toBe('/api/admin/finance/summary?from=2026-10-01&to=2026-10-07');
    expect((call(f).init.headers as Record<string, string>).Authorization).toBe('Bearer tokentokentoken');

    f = stub(rawByDay());
    expect((await apiService.fetchFinanceByDay(range)).rows).toHaveLength(2);
    expect(call(f).url).toBe('/api/admin/finance/by-day?from=2026-10-01&to=2026-10-07');

    f = stub(rawByRestaurant());
    await apiService.fetchFinanceByRestaurant(range);
    expect(call(f).url).toBe('/api/admin/finance/by-restaurant?from=2026-10-01&to=2026-10-07&limit=100');

    f = stub(rawByDish('commission'));
    await apiService.fetchFinanceByDish(range, { sort: 'commission', top: 10, vendorId: 'v 1' });
    expect(call(f).url).toBe('/api/admin/finance/by-dish?from=2026-10-01&to=2026-10-07&sort=commission&top=10&vendorId=v%201');
    f = stub(rawByDish());
    await apiService.fetchFinanceByDish(range, { sort: 'units', top: 20 });
    expect(call(f).url).not.toContain('vendorId');

    f = stub(rawRiders());
    expect((await apiService.fetchFinanceRiders(range)).totals.deliveries).toBe(7);
    expect(call(f).url).toBe('/api/admin/finance/riders?from=2026-10-01&to=2026-10-07&limit=100');
  });

  it('an answer in the wrong shape is a plain error, not a crash; server errors keep their message', async () => {
    stub({ success: true });
    await expect(apiService.fetchFinanceSummary(range)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    stub({ success: true });
    await expect(apiService.fetchFinanceByDay(range)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    stub({ success: false, message: 'The date range cannot be longer than 366 days.', code: 'BAD_REQUEST', field: 'from' }, 400);
    await expect(apiService.fetchFinanceSummary(range)).rejects.toMatchObject({ status: 400, message: 'The date range cannot be longer than 366 days.', field: 'from' });
  });
});

describe('settlement calls', () => {
  it('list: status, restaurant, range, page; empty filters are left out; all time sends no dates', async () => {
    let f = stub(rawSettlementList([rawSettlement()]));
    const page = await apiService.fetchSettlements({ status: 'ON_HOLD', vendorId: 'v1', range, page: 2, pageSize: 25 });
    expect(call(f).url).toBe('/api/admin/settlements?status=ON_HOLD&vendorId=v1&from=2026-10-01&to=2026-10-07&page=2&pageSize=25');
    expect(page.items[0]).toMatchObject({ vendorName: 'Sharma Dhaba', netPayable: 360 });
    f = stub(rawSettlementList([]));
    await apiService.fetchSettlements({ status: '', vendorId: '', range: null });
    expect(call(f).url).toBe('/api/admin/settlements?page=1&pageSize=25');
    stub({ success: true });
    await expect(apiService.fetchSettlements({})).rejects.toBeInstanceOf(ApiError);
  });

  it('pending count for the badge reads the PENDING summary', async () => {
    const f = stub(rawSettlementList([rawSettlement()], { PENDING: { count: 4, netPayable: 1 } }, { total: 4 }));
    expect(await apiService.fetchPendingSettlementCount()).toBe(4);
    expect(call(f).url).toBe('/api/admin/settlements?status=PENDING&page=1&pageSize=1');
    stub({ nope: true });
    await expect(apiService.fetchPendingSettlementCount()).rejects.toBeInstanceOf(ApiError);
  });

  it('detail', async () => {
    const f = stub({ success: true, data: rawSettlementDetail() });
    const d = await apiService.fetchSettlement('s/1');
    expect(call(f).url).toBe('/api/admin/settlements/s%2F1');
    expect(d.vendor.userId).toBe('u-owner1');
  });

  it('mark-paid, hold, release, adjustments, cancel: paths, methods and bodies', async () => {
    let f = stub(rawAction(rawSettlement({ status: 'PAID', paymentReference: 'UTR123456' })));
    const paid = await apiService.markSettlementPaid('s1', { reference: 'UTR123456', paidAt: '2026-10-05T12:00:00+05:30', note: 'n' });
    expect(call(f).url).toBe('/api/admin/settlements/s1/mark-paid');
    expect(call(f).init.method).toBe('POST');
    expect(body(f)).toEqual({ reference: 'UTR123456', paidAt: '2026-10-05T12:00:00+05:30', note: 'n' });
    expect(paid.settlement).toMatchObject({ status: 'PAID', paymentReference: 'UTR123456' });

    f = stub(rawAction(rawSettlement({ status: 'ON_HOLD' })));
    await apiService.holdSettlement('s1', { note: 'bank check' });
    expect(call(f).url).toBe('/api/admin/settlements/s1/hold');
    expect(body(f)).toEqual({ note: 'bank check' });

    f = stub(rawAction(rawSettlement()));
    await apiService.releaseSettlement('s1');
    expect(call(f).url).toBe('/api/admin/settlements/s1/release');
    expect(call(f).init.method).toBe('POST');

    f = stub(rawAction(rawSettlement({ adjustmentTotal: -5 }), { adjustment: { id: 'a', amount: -5, reason: 'x y z' } }));
    const adj = await apiService.addSettlementAdjustment('s1', { amount: -5, reason: 'x y z', requestId: 'req-12345678' });
    expect(call(f).url).toBe('/api/admin/settlements/s1/adjustments');
    expect(body(f)).toEqual({ amount: -5, reason: 'x y z', requestId: 'req-12345678' });
    expect(adj.adjustment).toMatchObject({ amount: -5 });

    f = stub(rawAction(rawSettlement({ status: 'CANCELLED' }), { freedOrders: 3 }));
    expect((await apiService.cancelSettlement('s1')).freedOrders).toBe(3);
    expect(call(f).url).toBe('/api/admin/settlements/s1/cancel');
  });

  it('the server refusing an action reaches the caller with its own words', async () => {
    stub({ success: false, code: 'ALREADY_PAID', message: 'This settlement was already paid with a different reference. Nothing was changed.' }, 409);
    await expect(apiService.markSettlementPaid('s1', { reference: 'UTR999' })).rejects.toMatchObject({ status: 409, code: 'ALREADY_PAID', message: expect.stringContaining('already paid') });
  });

  it('run now', async () => {
    const f = stub(rawRun());
    const r = await apiService.runSettlements();
    expect(call(f).url).toBe('/api/admin/settlements/run');
    expect(call(f).init.method).toBe('POST');
    expect(r).toMatchObject({ message: '1 settlement(s) created for 3 order(s).', orderCount: 3 });
  });

  it('CSV downloads send the auth header and return the blob and the server file name', async () => {
    setAuthToken('tokentokentoken');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('a,b\r\n1,2\r\n', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="kraveo-settlement-s1111111.csv"' } }));
    vi.stubGlobal('fetch', fetchMock);
    const one = await apiService.downloadSettlementCsv('s1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/admin/settlements/s1/export.csv');
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer tokentokentoken');
    expect(one.filename).toBe('kraveo-settlement-s1111111.csv');
    expect(await one.blob.text()).toBe('a,b\r\n1,2\r\n');
    await apiService.downloadSettlementsCsv(range);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/admin/settlements/export.csv?from=2026-10-01&to=2026-10-07');
    await apiService.downloadSettlementsCsv(null);
    expect(String(fetchMock.mock.calls[2][0])).toMatch(/export\.csv$/);
  });

  it('a failed download is an ApiError with the server message', async () => {
    stub({ success: false, message: 'The date range cannot be longer than 366 days.' }, 400);
    await expect(apiService.downloadSettlementsCsv(range)).rejects.toMatchObject({ status: 400, message: 'The date range cannot be longer than 366 days.' });
    setAuthToken('tokentokentoken');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(apiService.downloadSettlementCsv('s1')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('rider payouts and providers', () => {
  it('ledger list and record', async () => {
    let f = stub(rawRiderPayoutList());
    const page = await apiService.fetchRiderPayouts({ driverUserId: 'u1', range, page: 2 });
    expect(call(f).url).toBe('/api/admin/rider-payouts?driverUserId=u1&from=2026-10-01&to=2026-10-07&page=2&pageSize=25');
    expect(page.totalAmount).toBe(250.5);
    f = stub({ success: true, changed: true, message: 'Payout recorded.', data: rawRiderPayout() });
    const r = await apiService.recordRiderPayout({ driverUserId: 'u-rider1', amount: 250.5, method: 'UPI', reference: 'UTR123456' });
    expect(call(f).url).toBe('/api/admin/rider-payouts');
    expect(call(f).init.method).toBe('POST');
    expect(body(f)).toEqual({ driverUserId: 'u-rider1', amount: 250.5, method: 'UPI', reference: 'UTR123456' });
    expect(r).toMatchObject({ changed: true, payout: { id: 'p1' } });
  });

  it('providers', async () => {
    const f = stub(rawProviders());
    const list = await apiService.fetchPayoutProviders();
    expect(call(f).url).toBe('/api/admin/payout-providers');
    expect(list.find((p) => p.name === 'razorpayx')).toMatchObject({ enabled: false, reason: 'RazorpayX payouts are not configured.' });
  });
});

describe('payout account calls', () => {
  it('get / put / verify / reveal use the admin partner paths', async () => {
    let f = stub(rawAccountResponse());
    const got = await apiService.fetchPayoutAccount('u 1');
    expect(call(f).url).toBe('/api/admin/partners/u%201/payout-account');
    expect(got.account).toMatchObject({ accountMasked: 'XXXXXX7890' });

    f = stub({ success: true, data: null, partner: { userId: 'u1', name: 'A', role: 'DRIVER' } });
    expect((await apiService.fetchPayoutAccount('u1')).account).toBeNull();

    f = stub({ success: true, changed: true, message: 'Saved', partner: { userId: 'u1', name: 'A', role: 'VENDOR' }, data: rawAccount() });
    await apiService.savePayoutAccount('u1', { method: 'BANK', accountHolder: 'Ram Singh', accountNumber: '50100234567890', ifsc: 'HDFC0001234' });
    expect(call(f).init.method).toBe('PUT');
    expect(body(f)).toMatchObject({ method: 'BANK', accountNumber: '50100234567890' });

    f = stub({ success: true, changed: true, data: rawAccount({ verifiedAt: '2026-10-07T00:00:00.000Z' }) });
    const v = await apiService.setPayoutVerified('u1', true);
    expect(call(f).url).toBe('/api/admin/partners/u1/payout-account/verify');
    expect(call(f).init.method).toBe('PATCH');
    expect(body(f)).toEqual({ verified: true });
    expect(v.account?.verified).toBe(true);

    f = stub(rawReveal());
    const r = await apiService.revealPayoutAccount('u1');
    expect(call(f).url).toBe('/api/admin/partners/u1/payout-account/reveal');
    expect(call(f).init.method).toBe('POST');
    expect(r.accountNumber).toBe('50100234567890');
  });

  it('a reveal answer without a method is refused', async () => {
    stub({ success: true, data: {} });
    await expect(apiService.revealPayoutAccount('u1')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});
