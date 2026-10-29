// @vitest-environment jsdom
// Docs/28 calls: the paths, bodies and parsing of customers, riders, restaurants, owner logins and the activity log.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiService, clearAuthToken, setAuthToken } from './api';
import { EMPTY_FILTERS } from '../lib/auditParse';
import {
  GENERATED, ORDER_ID, rawAdminVendor, rawAuditActions, rawAuditPage, rawCancelled, rawConfirmMismatch, rawCustomerAction, rawCustomerDetail, rawCustomerList, rawCustomerRow, rawHasActiveDelivery,
  rawHasOpenOrders, rawNoOwner, rawOrderInDelivery, rawOwnerCreate, rawOwnerView, rawRateLimited, rawRemovedVendor, rawRiderApplication, rawRiderImpact, rawSuspendedDetail, rawTokenRevoked, rawVendorAction,
  rawVendorImpact,
} from '../test/adminFixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAuthToken(); localStorage.clear(); });

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const stub = (body: unknown, status = 200) => {
  setAuthToken('tokentokentoken');
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const call = (f: ReturnType<typeof stub>, n = 0) => ({ url: String(f.mock.calls[n][0]).replace(/^https?:\/\/[^/]+/, ''), init: (f.mock.calls[n][1] ?? {}) as RequestInit });
const body = (f: ReturnType<typeof stub>) => JSON.parse(call(f).init.body as string);

describe('customers', () => {
  it('list: the status filter and search go to the server; REMOVED also asks for self-deleted accounts; nothing is sent by default', async () => {
    let f = stub(rawCustomerList([rawCustomerRow()]));
    const page = await apiService.fetchCustomers('  asha ', 'cur1', { status: 'SUSPENDED' });
    expect(call(f).url).toBe('/api/admin/customers?limit=30&status=SUSPENDED&search=asha&cursor=cur1');
    expect(page.data[0]).toMatchObject({ id: 'zc-cust-1', accountStatus: 'ACTIVE' });
    f = stub(rawCustomerList());
    await apiService.fetchCustomers('', null, { status: 'REMOVED' });
    expect(call(f).url).toBe('/api/admin/customers?limit=30&status=REMOVED&includeDeleted=1');
    f = stub(rawCustomerList());
    await apiService.fetchCustomers('');
    expect(call(f).url).toBe('/api/admin/customers?limit=30');
    expect((call(f).init.headers as Record<string, string>).Authorization).toBe('Bearer tokentokentoken');
  });

  it('an answer in the wrong shape is a plain error, not a crash', async () => {
    stub({ success: true });
    await expect(apiService.fetchCustomers('')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    stub({ success: true, data: {} });
    await expect(apiService.fetchCustomer('c1')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('suspend sends the reason only; openOrders:CANCEL is sent only when asked for; the answer carries cancelled / failed', async () => {
    let f = stub(rawCustomerAction(rawSuspendedDetail()));
    await apiService.blockCustomer('zc-cust-1', 'suspend', { reason: 'Fake orders' });
    expect(call(f).url).toBe('/api/admin/customers/zc-cust-1/suspend');
    expect(call(f).init.method).toBe('POST');
    expect(body(f)).toEqual({ reason: 'Fake orders' });
    f = stub(rawCustomerAction(rawSuspendedDetail(), rawCancelled()));
    const out = await apiService.blockCustomer('zc-cust-1', 'suspend', { reason: 'Fake orders', openOrders: 'CANCEL' });
    expect(body(f)).toEqual({ reason: 'Fake orders', openOrders: 'CANCEL' });
    expect(out.outcome.cancelled[0]).toMatchObject({ orderId: ORDER_ID, refund: 'STARTED' });
    expect(out.detail.accountStatus).toBe('SUSPENDED');
  });

  it('remove always sends confirmName and scrub (false by default, true only when ticked)', async () => {
    let f = stub(rawCustomerAction(rawCustomerDetail({ accountStatus: 'REMOVED' })));
    await apiService.blockCustomer('c 1', 'remove', { reason: 'Fraud', confirmName: 'Cust1 Tester' });
    expect(call(f).url).toBe('/api/admin/customers/c%201/remove');
    expect(body(f)).toEqual({ reason: 'Fraud', confirmName: 'Cust1 Tester', scrub: false });
    f = stub(rawCustomerAction(rawCustomerDetail({ accountStatus: 'REMOVED' })));
    await apiService.blockCustomer('c1', 'remove', { reason: 'Fraud', confirmName: 'Cust1 Tester', scrub: true, openOrders: 'CANCEL' });
    expect(body(f)).toEqual({ reason: 'Fraud', confirmName: 'Cust1 Tester', scrub: true, openOrders: 'CANCEL' });
  });

  it('restore sends the note only when there is one', async () => {
    let f = stub(rawCustomerAction(rawCustomerDetail()));
    await apiService.restoreCustomer('c1');
    expect(call(f).url).toBe('/api/admin/customers/c1/restore');
    expect(body(f)).toEqual({});
    f = stub(rawCustomerAction(rawCustomerDetail()));
    await apiService.restoreCustomer('c1', 'Spoke to them');
    expect(body(f)).toEqual({ note: 'Spoke to them' });
  });

  it('the 409 / 400 / 429 / 401 bodies reach the caller with code, field, message and the full body', async () => {
    stub(rawHasOpenOrders(), 409);
    const e1 = await apiService.blockCustomer('c1', 'suspend', { reason: 'x y z' }).catch((e) => e);
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1).toMatchObject({ status: 409, code: 'HAS_OPEN_ORDERS' });
    expect(e1.extra.openOrders).toHaveLength(1);
    stub(rawOrderInDelivery(), 409);
    expect(await apiService.blockCustomer('c1', 'suspend', { reason: 'x y z' }).catch((e) => e)).toMatchObject({ code: 'ORDER_IN_DELIVERY' });
    stub(rawConfirmMismatch(), 400);
    expect(await apiService.blockCustomer('c1', 'remove', { reason: 'x y z', confirmName: 'no' }).catch((e) => e)).toMatchObject({ status: 400, code: 'CONFIRM_MISMATCH', field: 'confirmName', message: 'The name you typed does not match.' });
    stub(rawRateLimited(), 429);
    expect(await apiService.restoreCustomer('c1').catch((e) => e)).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    stub(rawTokenRevoked(), 401);
    expect(await apiService.restoreCustomer('c1').catch((e) => e)).toMatchObject({ status: 401, code: 'TOKEN_REVOKED' });
  });
});

describe('riders', () => {
  it('impact, remove (RELEASE only when asked), restore', async () => {
    let f = stub(rawRiderImpact({ activeDeliveries: [{ id: 'a1', status: 'ACCEPTED' }] }));
    expect((await apiService.fetchRiderImpact('drv-1')).activeDeliveries).toHaveLength(1);
    expect(call(f).url).toBe('/api/admin/drivers/drv-1/impact');
    f = stub({ success: true, changed: true, data: rawRiderApplication() });
    await apiService.removeRider('drv-1', { reason: 'Left the company', confirmName: 'Ravi' });
    expect(call(f).url).toBe('/api/admin/drivers/drv-1/remove');
    expect(body(f)).toEqual({ reason: 'Left the company', confirmName: 'Ravi' });
    f = stub({ success: true, changed: true, released: ['a1'], releaseFailed: [], data: rawRiderApplication() });
    const out = await apiService.removeRider('drv-1', { reason: 'Left the company', confirmName: 'Ravi', handover: 'RELEASE' });
    expect(body(f).handover).toBe('RELEASE');
    expect(out.outcome.released).toEqual(['a1']);
    f = stub({ success: true, changed: true, data: rawRiderApplication({ accountStatus: 'ACTIVE' }) });
    await apiService.restoreRider('drv-1');
    expect(call(f).url).toBe('/api/admin/drivers/drv-1/restore');
    expect(body(f)).toEqual({});
  });

  it('removing with a delivery in hand: the 409 bodies are kept', async () => {
    stub(rawHasActiveDelivery(), 409);
    expect(await apiService.removeRider('drv-1', { reason: 'abc', confirmName: 'Ravi' }).catch((e) => e)).toMatchObject({ code: 'HAS_ACTIVE_DELIVERY' });
  });

  it('the status route: handover only for a rider suspension, openOrders only for a restaurant, never for approve', async () => {
    let f = stub({ success: true, data: { id: 'drv-1' }, changed: true, released: ['o1'] });
    const r = await apiService.decidePartner('DRIVER', 'drv-1', 'SUSPENDED', 'No-shows', { handover: 'RELEASE', openOrders: 'CANCEL' });
    expect(call(f).url).toBe('/api/admin/partners/driver/drv-1/status');
    expect(body(f)).toEqual({ status: 'SUSPENDED', reason: 'No-shows', handover: 'RELEASE' });
    expect(r.outcome.released).toEqual(['o1']);
    f = stub({ success: true, data: { id: 'ven-1' }, changed: true, ...rawCancelled() });
    await apiService.decidePartner('VENDOR', 'ven-1', 'SUSPENDED', 'Complaints', { openOrders: 'CANCEL', handover: 'RELEASE' });
    expect(body(f)).toEqual({ status: 'SUSPENDED', reason: 'Complaints', openOrders: 'CANCEL' });
    f = stub({ success: true, data: { id: 'ven-1' } });
    await apiService.setPartnerStatus('VENDOR', 'ven-1', 'APPROVED');
    expect(body(f)).toEqual({ status: 'APPROVED' });
  });
});

describe('restaurants', () => {
  it('impact', async () => {
    const f = stub(rawVendorImpact({ openOrders: [{ id: 'o1', status: 'PLACED', paymentStatus: 'PAID', totalAmount: 100 }], unpaidSettlements: { count: 2, amount: 1234.5 } }));
    const impact = await apiService.fetchVendorImpact('ven-1');
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/impact');
    expect(impact.unpaidSettlements).toEqual({ count: 2, amount: 1234.5 });
  });
  it('suspend / remove bodies; the fresh vendor keeps its owner block', async () => {
    let f = stub(rawVendorAction(rawAdminVendor({ approvalStatus: 'SUSPENDED', isAcceptingOrders: false })));
    const out = await apiService.blockVendor('ven-1', 'suspend', { reason: 'Complaints' });
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/suspend');
    expect(body(f)).toEqual({ reason: 'Complaints' });
    expect(out.vendor.owner).toMatchObject({ name: 'Owner2 Kitchen' });
    f = stub(rawVendorAction(rawRemovedVendor(), { ownerDisabled: true, ...rawCancelled() }));
    const removed = await apiService.blockVendor('ven-1', 'remove', { reason: 'Closed', confirmName: 'Sharma Dhaba', openOrders: 'CANCEL' });
    expect(body(f)).toEqual({ reason: 'Closed', confirmName: 'Sharma Dhaba', disableOwner: true, openOrders: 'CANCEL' });
    expect(removed.ownerDisabled).toBe(true);
    expect(removed.vendor.removedAt).toBe('2026-10-29T05:00:00.000Z');
    f = stub(rawVendorAction(rawRemovedVendor()));
    await apiService.blockVendor('ven-1', 'remove', { reason: 'Closed', confirmName: 'x', disableOwner: false });
    expect(body(f).disableOwner).toBe(false);
  });
  it('reinstate and restore send an empty object', async () => {
    let f = stub(rawVendorAction(rawAdminVendor(), { warning: 'Stays closed.' }));
    const r = await apiService.reviveVendor('ven-1', 'reinstate');
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/reinstate');
    expect(call(f).init.body).toBe('{}');
    expect(r.outcome.warning).toBe('Stays closed.');
    f = stub(rawVendorAction(rawAdminVendor(), { ownerRestored: true }));
    expect((await apiService.reviveVendor('ven-1', 'restore')).ownerRestored).toBe(true);
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/restore');
  });
  it('the removed list asks for includeRemoved and keeps only removed rows', async () => {
    const f = stub({ success: true, data: [rawAdminVendor(), rawRemovedVendor()] });
    const rows = await apiService.fetchRemovedVendors();
    expect(call(f).url).toBe('/api/vendors?includeRemoved=1');
    expect(rows.map((v) => v.id)).toEqual(['ven-3']);
  });
  it('opening an ownerless restaurant: the NO_OWNER 409 message reaches the caller', async () => {
    stub(rawNoOwner(), 409);
    const e = await apiService.toggleVendorStatus('ven-2', true).catch((x) => x);
    expect(e).toMatchObject({ status: 409, code: 'NO_OWNER', message: 'Add an owner login first.' });
  });
});

describe('owner login', () => {
  it('create: a generated password is in the answer only; the request has no password key', async () => {
    const f = stub(rawOwnerCreate());
    const r = await apiService.createOwner('ven-2', { name: 'New Owner', phone: '9876543299' });
    expect(call(f).url).toBe('/api/admin/vendors/ven-2/owner');
    expect(call(f).init.method).toBe('POST');
    expect(body(f)).toEqual({ name: 'New Owner', phone: '9876543299' });
    expect(r.generatedPassword).toBe(GENERATED);
    expect(r.owner).toMatchObject({ id: 'zc-vown-9', phone: '+91 9876543299' });
    expect(call(f).url).not.toContain(GENERATED);
  });
  it('attach sends existingUserId (and takePayoutAccountFrom only when asked)', async () => {
    let f = stub(rawOwnerCreate({ generatedPassword: undefined }));
    await apiService.createOwner('ven-2', { existingUserId: 'u-old' });
    expect(body(f)).toEqual({ existingUserId: 'u-old' });
    f = stub(rawOwnerCreate({ generatedPassword: undefined, payoutAccountMoved: true }));
    const r = await apiService.createOwner('ven-2', { existingUserId: 'u-old', takePayoutAccountFrom: 'u-old' });
    expect(body(f)).toEqual({ existingUserId: 'u-old', takePayoutAccountFrom: 'u-old' });
    expect(r).toMatchObject({ generatedPassword: null, payoutAccountMoved: true });
  });
  it('patch / reset / disable / enable / detach / remove use the contract paths and bodies', async () => {
    let f = stub({ success: true, changed: true, owner: rawOwnerView({ phone: '+91 9876500000' }) });
    await apiService.patchOwner('ven-1', { phone: '9876500000' });
    expect(call(f).init.method).toBe('PATCH');
    expect(body(f)).toEqual({ phone: '9876500000' });
    f = stub({ success: true, generatedPassword: GENERATED });
    expect((await apiService.resetOwnerPassword('ven-1')).generatedPassword).toBe(GENERATED);
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/owner/reset-password');
    expect(call(f).init.body).toBe('{}');
    f = stub({ success: true, changed: true, owner: rawOwnerView({ accountStatus: 'SUSPENDED' }), openOrders: 2, warning: 'Orders will arrive that only an admin can accept.' });
    const d = await apiService.disableOwner('ven-1', { reason: 'Paused', closeRestaurant: false });
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/owner/disable');
    expect(body(f)).toEqual({ reason: 'Paused', closeRestaurant: false });
    expect(d).toMatchObject({ openOrders: 2, warning: 'Orders will arrive that only an admin can accept.' });
    f = stub({ success: true, changed: true, owner: rawOwnerView() });
    await apiService.enableOwner('ven-1');
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/owner/enable');
    f = stub({ success: true, changed: true, owner: null, detachedUser: { id: 'u9', name: 'Old Owner' } });
    const det = await apiService.detachOwner('ven-1', 'detach', { reason: 'Changed', closeRestaurant: true, confirmName: 'ignored' });
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/owner/detach');
    expect(body(f)).toEqual({ reason: 'Changed', closeRestaurant: true });
    expect(det.detachedUser).toEqual({ id: 'u9', name: 'Old Owner' });
    f = stub({ success: true, changed: true, owner: null, detachedUser: { id: 'u9', name: 'Old Owner' } });
    await apiService.detachOwner('ven-1', 'remove', { reason: 'Gone', closeRestaurant: true, confirmName: 'Old Owner', openOrders: 'CANCEL' });
    expect(call(f).url).toBe('/api/admin/vendors/ven-1/owner/remove');
    expect(body(f)).toEqual({ reason: 'Gone', closeRestaurant: true, confirmName: 'Old Owner', openOrders: 'CANCEL' });
  });
  it('owner errors keep their code: one restaurant per login, phone taken', async () => {
    stub({ success: false, code: 'OWNER_HAS_RESTAURANT', message: 'That owner login already runs a restaurant. One login runs one restaurant.' }, 409);
    expect(await apiService.createOwner('ven-2', { existingUserId: 'u1' }).catch((e) => e)).toMatchObject({ code: 'OWNER_HAS_RESTAURANT', message: expect.stringContaining('One login runs one restaurant') });
    stub({ success: false, code: 'PHONE_TAKEN', message: 'This number already belongs to another account.' }, 409);
    expect(await apiService.createOwner('ven-2', { name: 'Ab', phone: '9876543210' }).catch((e) => e)).toMatchObject({ code: 'PHONE_TAKEN' });
  });
  it('GET owner: null when there is none', async () => {
    const f = stub({ success: true, owner: null });
    expect(await apiService.fetchOwner('ven-2')).toBeNull();
    expect(call(f).url).toBe('/api/admin/vendors/ven-2/owner');
  });
});

describe('activity log', () => {
  it('list: filters, limit and cursor in the query', async () => {
    const f = stub(rawAuditPage([], 'next-1'));
    const page = await apiService.fetchAuditLog({ ...EMPTY_FILTERS, actions: ['ORDER_CANCELLED'], from: '2026-10-01', to: '2026-10-29' }, 'cur-0', 50);
    expect(call(f).url).toBe('/api/admin/audit-log?action=ORDER_CANCELLED&from=2026-10-01&to=2026-10-29&limit=50&cursor=cur-0');
    expect(page.nextCursor).toBe('next-1');
  });
  it('wrong shapes are plain errors; the actions list is parsed', async () => {
    stub({ success: true });
    await expect(apiService.fetchAuditLog(EMPTY_FILTERS)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    stub(rawAuditActions());
    expect(await apiService.fetchAuditActions()).toHaveLength(5);
  });
  it('the CSV is fetched with the token (not a link), keeps the server filename and sends no cursor or limit', async () => {
    setAuthToken('tokentokentoken');
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response('time,action\n', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="audit-log-2026-10-01-2026-10-29.csv"' } }));
    vi.stubGlobal('fetch', f);
    const out = await apiService.downloadAuditCsv({ ...EMPTY_FILTERS, from: '2026-10-01', to: '2026-10-29', q: 'refund' });
    expect(String(f.mock.calls[0][0])).toContain('/api/admin/audit-log/export.csv?q=refund&from=2026-10-01&to=2026-10-29');
    expect(String(f.mock.calls[0][0])).not.toMatch(/cursor|limit/);
    expect((f.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer tokentokentoken');
    expect(out.filename).toBe('audit-log-2026-10-01-2026-10-29.csv');
    expect(await out.blob.text()).toBe('time,action\n');
  });
  it('a CSV refusal keeps the server message and code', async () => {
    setAuthToken('tokentokentoken');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: false, code: 'RANGE_TOO_LARGE', message: 'The date range cannot be longer than 366 days.' }, 400)));
    expect(await apiService.downloadAuditCsv(EMPTY_FILTERS).catch((e) => e)).toMatchObject({ status: 400, code: 'RANGE_TOO_LARGE', message: 'The date range cannot be longer than 366 days.' });
  });
});
