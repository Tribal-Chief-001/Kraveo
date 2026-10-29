// @vitest-environment jsdom
// Customers: status filter, rows, the detail drawer and the suspend / restore / remove dialogs (Docs/27 B1, Docs/28 section 2).
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { CustomersPanel } from './CustomersPanel';
import { ApiError, apiService } from '../services/api';
import { parseCustomerDetail, parseCustomerList, parseOutcome } from '../lib/accountParse';
import { byId, byText, click, dialogs, flush, mount, topDialog, type, unmount, waitFor } from '../test/dom';
import {
  CUSTOMER_ID, ORDER_ID, rawBadReason, rawCancelled, rawConfirmMismatch, rawCustomerDetail, rawCustomerList, rawCustomerRow, rawHasOpenOrders, rawOpenOrder, rawRateLimited, rawRefundNotSettled,
  rawRemovedDetail, rawSelfDeletedDetail, rawSuspendedDetail, rawOrderInDelivery,
} from '../test/adminFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const apiErr = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);
const list = (rows: Record<string, unknown>[] = [rawCustomerRow()], over: Record<string, unknown> = {}) => parseCustomerList(rawCustomerList(rows, over))!;
const detail = (raw: Record<string, unknown>) => parseCustomerDetail(raw)!;
const outcome = (raw: Record<string, unknown> = {}) => parseOutcome({ changed: true, ...raw });

const setup = async (rows: Record<string, unknown>[] = [rawCustomerRow()], detailRaw: Record<string, unknown> = rawCustomerDetail(), props: Record<string, unknown> = {}) => {
  const fetchCustomers = vi.spyOn(apiService, 'fetchCustomers').mockResolvedValue(list(rows));
  const fetchCustomer = vi.spyOn(apiService, 'fetchCustomer').mockResolvedValue(detail(detailRaw));
  const onAuthError = vi.fn();
  const onOpenOrder = vi.fn();
  const host = await mount(<CustomersPanel query="" onClearQuery={() => {}} onAuthError={onAuthError} onOpenOrder={onOpenOrder} {...(props as any)} />);
  await flush();
  return { host, fetchCustomers, fetchCustomer, onAuthError, onOpenOrder };
};
const openDrawer = async () => { await click(document.querySelector('[aria-label="Open Cust1 Tester"]')); await flush(); };
const drawer = () => document.querySelector('[role="dialog"]') as HTMLElement;
const footerBtn = (label: string) => byText('button', label, drawer());
const reason = (text: string) => type(byId('rd-reason'), text);
const modalConfirm = (label: RegExp | string) => byText('button', label, topDialog()!) as HTMLButtonElement;

describe('list and filter', () => {
  it('starts on Active and asks the server for exactly that; each chip asks for its own status and shows it pressed', async () => {
    const { fetchCustomers } = await setup();
    expect(fetchCustomers).toHaveBeenLastCalledWith('', null, { status: 'ACTIVE' });
    const group = document.querySelector('[role="group"][aria-label="Filter by account status"]')!;
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Active', 'Suspended', 'Removed', 'All']);
    expect(byText('button', 'Active', group)!.getAttribute('aria-pressed')).toBe('true');
    for (const [label, status] of [['Suspended', 'SUSPENDED'], ['Removed', 'REMOVED'], ['All', 'ALL']] as const) {
      await click(byText('button', label, group));
      await flush();
      expect(fetchCustomers).toHaveBeenLastCalledWith('', null, { status });
      expect(byText('button', label, group)!.getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('the search text goes to the server together with the filter (debounced)', async () => {
    const { fetchCustomers } = await setup([rawCustomerRow()], rawCustomerDetail(), { query: 'asha' });
    await waitFor(() => fetchCustomers.mock.calls.some((c) => c[0] === 'asha'));
    expect(fetchCustomers).toHaveBeenLastCalledWith('asha', null, { status: 'ACTIVE' });
  });

  it('rows show the status chip, open orders, last sign-in, total spent and orders', async () => {
    await setup([
      rawCustomerRow({ openOrders: 2 }),
      rawCustomerRow({ id: 'c2', name: 'Susp Person', accountStatus: 'SUSPENDED', statusReason: 'Fake orders', lastLoginAt: null, totalSpent: 1500 }),
      rawCustomerRow({ id: 'c3', name: 'Gone Person', accountStatus: 'REMOVED' }),
      rawCustomerRow({ id: 'c4', name: 'Deleted user', email: null, phone: null, deleted: true }),
    ]);
    const table = document.querySelector('table')!;
    const rowOf = (name: string) => Array.from(table.querySelectorAll('tbody tr')).find((r) => r.textContent!.includes(name)) as HTMLElement;
    expect(rowOf('Cust1 Tester').textContent).toContain('Active');
    expect(rowOf('Cust1 Tester').textContent).toContain('2 open');
    expect(rowOf('Cust1 Tester').textContent).toContain('₹820');
    expect(rowOf('Susp Person').textContent).toContain('Suspended');
    expect(rowOf('Susp Person').textContent).toContain('Not recorded');
    expect(rowOf('Susp Person').textContent).toContain('₹1,500');
    expect(rowOf('Gone Person').textContent).toContain('Removed');
    expect(rowOf('Deleted user').textContent).toContain('Deleted by user');
    expect(Array.from(table.querySelectorAll('th')).map((h) => h.textContent)).toContain('Last sign-in');
  });

  it('empty states per filter use the plain wording', async () => {
    const { fetchCustomers } = await setup([]);
    expect(document.body.textContent).toContain('No customers yet');
    const group = document.querySelector('[aria-label="Filter by account status"]')!;
    await click(byText('button', 'Suspended', group)); await flush();
    expect(document.body.textContent).toContain('Nobody is suspended.');
    await click(byText('button', 'Removed', group)); await flush();
    expect(document.body.textContent).toContain('Nobody has been removed.');
    expect(fetchCustomers).toHaveBeenCalled();
  });

  it('a failed load shows the server message and a retry', async () => {
    const fetchCustomers = vi.spyOn(apiService, 'fetchCustomers').mockRejectedValueOnce(apiErr(500, { message: 'Could not load customers.' })).mockResolvedValue(list());
    await mount(<CustomersPanel query="" onClearQuery={() => {}} onAuthError={() => {}} />);
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Could not load customers.');
    await click(byText('button', 'Try again'));
    await flush();
    expect(document.querySelector('table')).not.toBeNull();
    expect(fetchCustomers).toHaveBeenCalledTimes(2);
  });

  it('load more appends the next page with the same filter and skips duplicates; a page of an old filter is dropped', async () => {
    const fetchCustomers = vi.spyOn(apiService, 'fetchCustomers')
      .mockResolvedValueOnce(list([rawCustomerRow()], { total: 3, nextCursor: 'cur-1' }))
      .mockResolvedValueOnce(list([rawCustomerRow(), rawCustomerRow({ id: 'c2', name: 'Second Person' })], { total: 3 }));
    await mount(<CustomersPanel query="" onClearQuery={() => {}} onAuthError={() => {}} />);
    await flush();
    await click(byText('button', /Load more/));
    await flush();
    expect(fetchCustomers).toHaveBeenLastCalledWith('', 'cur-1', { status: 'ACTIVE' });
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);

    // race: the filter changes while "load more" is still running
    fetchCustomers.mockReset();
    let finishMore: (v: ReturnType<typeof list>) => void = () => {};
    fetchCustomers.mockResolvedValueOnce(list([rawCustomerRow()], { total: 9, nextCursor: 'cur-2' }));
    await click(byText('button', 'All', document.querySelector('[aria-label="Filter by account status"]')!));
    await flush();
    fetchCustomers.mockImplementationOnce(() => new Promise((resolve) => { finishMore = resolve as any; }));
    await click(byText('button', /Load more/));
    fetchCustomers.mockResolvedValueOnce(list([rawCustomerRow({ id: 'c9', name: 'Only Suspended', accountStatus: 'SUSPENDED' })]));
    await click(byText('button', 'Suspended', document.querySelector('[aria-label="Filter by account status"]')!));
    await flush();
    finishMore(list([rawCustomerRow({ id: 'stale', name: 'Stale Row' })]));
    await flush();
    expect(document.body.textContent).toContain('Only Suspended');
    expect(document.body.textContent).not.toContain('Stale Row');
  });
});

describe('drawer footer and banners per state', () => {
  it('active: Suspend, Remove, Close; stats, last sign-in, in-progress orders and refunds owed are shown', async () => {
    const { onOpenOrder, fetchCustomer } = await setup([rawCustomerRow()], rawCustomerDetail({ openOrders: [rawOpenOrder()], refundsOwed: [{ orderId: 'ord-refund-zzzzzz', refundStatus: 'FAILED', amount: 120 }], lastLoginAt: '2026-10-28T17:30:00.000Z' }));
    await openDrawer();
    expect(fetchCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(Array.from(drawer().querySelectorAll('footer button')).map((b) => b.textContent)).toEqual(['Suspend', 'Remove', 'Close']);
    expect(drawer().querySelector('section[aria-label="Orders in progress"]')!.textContent).toContain('₹205');
    expect(drawer().querySelector('section[aria-label="Refunds owed"]')!.textContent).toContain('Refunds owed: ₹120');
    expect(drawer().querySelector('section[aria-label="Refunds owed"]')!.textContent).toContain('the refund failed, retry it from Needs attention');
    expect(drawer().textContent).toContain('Last sign-in');
    await click(drawer().querySelector('section[aria-label="Orders in progress"] button'));
    expect(onOpenOrder).toHaveBeenCalledWith(ORDER_ID);
  });

  it('suspended: banner with the reason, Restore and Remove', async () => {
    await setup([rawCustomerRow({ accountStatus: 'SUSPENDED' })], rawSuspendedDetail());
    await openDrawer();
    expect(drawer().querySelector('[role="status"]')!.textContent).toContain('Reason shown to them: Fake orders');
    expect(Array.from(drawer().querySelectorAll('footer button')).map((b) => b.textContent)).toEqual(['Restore', 'Remove', 'Close']);
  });

  it('removed by an admin: Restore and Close only', async () => {
    await setup([rawCustomerRow({ accountStatus: 'REMOVED' })], rawRemovedDetail());
    await openDrawer();
    expect(drawer().textContent).toContain('Reason: Fraud');
    expect(Array.from(drawer().querySelectorAll('footer button')).map((b) => b.textContent)).toEqual(['Restore', 'Close']);
  });

  it('deleted by the customer: the plain sentence and no way to restore', async () => {
    await setup([rawCustomerRow({ deleted: true, name: 'Deleted user' })], rawSelfDeletedDetail());
    await click(document.querySelector('[aria-label="Open Deleted user"]'));
    await flush();
    expect(drawer().textContent).toContain('The customer deleted this account themselves. It cannot be restored.');
    expect(Array.from(drawer().querySelectorAll('footer button')).map((b) => b.textContent)).toEqual(['Close']);
  });

  it('a detail that fails to load shows the message with a retry', async () => {
    vi.spyOn(apiService, 'fetchCustomers').mockResolvedValue(list());
    const fetchCustomer = vi.spyOn(apiService, 'fetchCustomer').mockRejectedValueOnce(apiErr(404, { message: 'Customer not found.' })).mockResolvedValue(detail(rawCustomerDetail()));
    await mount(<CustomersPanel query="" onClearQuery={() => {}} onAuthError={() => {}} />);
    await flush();
    await openDrawer();
    expect(drawer().querySelector('[role="alert"]')!.textContent).toContain('Customer not found.');
    await click(byText('button', 'Try again', drawer()));
    await flush();
    expect(fetchCustomer).toHaveBeenCalledTimes(2);
    expect(drawer().textContent).toContain('Cust1 Tester');
  });
});

describe('suspend', () => {
  it('happy path: consequences, reason (3-200), then the request without openOrders; the drawer shows the suspended state and the list reloads', async () => {
    const { fetchCustomers } = await setup();
    const block = vi.spyOn(apiService, 'blockCustomer').mockResolvedValue({ detail: detail(rawSuspendedDetail()), outcome: outcome() });
    await openDrawer();
    await click(footerBtn('Suspend'));
    const d = topDialog()!;
    expect(d.textContent).toContain('Suspend Cust1 Tester?');
    expect(d.textContent).toContain('They will be signed out on every device and cannot sign in or order until you restore them. Their past orders and payments stay.');
    expect(d.textContent).toContain('Reason (shown to the customer, 3-200 characters)');
    expect(modalConfirm('Suspend').disabled).toBe(true);
    await click(byText('button', 'Fake orders', d));
    fetchCustomers.mockClear();
    await click(modalConfirm('Suspend'));
    await flush();
    expect(block).toHaveBeenCalledWith(CUSTOMER_ID, 'suspend', { reason: 'Fake orders' });
    expect(dialogs().filter((x) => x.textContent!.includes('Suspend Cust1 Tester?'))).toHaveLength(0);
    expect(drawer().textContent).toContain('Reason shown to them: Fake orders');
    expect(document.body.textContent).toContain('Cust1 Tester is suspended.');
    expect(fetchCustomers).toHaveBeenCalledTimes(1);
  });

  it('open orders known in advance: the list and an explicit choice; "Stop here" is the default; only the cancel choice sends openOrders CANCEL, and the result is shown plainly', async () => {
    await setup([rawCustomerRow({ openOrders: 1 })], rawCustomerDetail({ openOrders: [rawOpenOrder()] }));
    const block = vi.spyOn(apiService, 'blockCustomer').mockResolvedValue({ detail: detail(rawSuspendedDetail()), outcome: outcome({ ...rawCancelled(), failed: [{ orderId: 'ord-failed-ffffff', code: 'ORDER_IN_DELIVERY', message: 'With a rider right now.' }] }) });
    await openDrawer();
    await click(footerBtn('Suspend'));
    const d = topDialog()!;
    expect(d.textContent).toContain('They have 1 order in progress.');
    expect(d.textContent).toContain('Placed');
    await reason('Fake orders');
    expect(modalConfirm('Suspend').disabled).toBe(true);
    await click(d.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    expect(d.textContent).toContain('Cancel these orders and refund the customer');
    await click(modalConfirm('Cancel the orders and refund, then suspend'));
    await flush();
    expect(block).toHaveBeenCalledWith(CUSTOMER_ID, 'suspend', { reason: 'Fake orders', openOrders: 'CANCEL' });
    const notice = topDialog()!;
    expect(notice.textContent).toContain('Cancelled (1)');
    expect(notice.textContent).toContain('refund queued, will retry automatically');
    expect(notice.textContent).toContain('Could not finish (1)');
    expect(notice.textContent).toContain('With a rider right now.');
    expect(notice.textContent).toContain('The change itself was made.');
  });

  it('the server finds open orders the screen did not know about (409): the list appears, nothing was changed, and the cancel is only sent after the explicit choice', async () => {
    await setup();
    const block = vi.spyOn(apiService, 'blockCustomer')
      .mockRejectedValueOnce(apiErr(409, rawHasOpenOrders()))
      .mockResolvedValueOnce({ detail: detail(rawSuspendedDetail()), outcome: outcome(rawCancelled()) });
    await openDrawer();
    await click(footerBtn('Suspend'));
    await reason('Fake orders');
    await click(modalConfirm('Suspend'));
    await flush();
    const d = topDialog()!;
    expect(block).toHaveBeenCalledTimes(1);
    expect(block.mock.calls[0][2]).toEqual({ reason: 'Fake orders' });
    expect(d.textContent).toContain('This customer has 1 order(s) in progress');
    expect(d.textContent).toContain('Nothing was changed.');
    expect(modalConfirm('Suspend').disabled).toBe(true);
    await click(d.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalConfirm('Cancel the orders and refund, then suspend'));
    await flush();
    expect(block).toHaveBeenCalledTimes(2);
    expect(block.mock.calls[1][2]).toEqual({ reason: 'Fake orders', openOrders: 'CANCEL' });
    expect(topDialog()!.textContent).toContain('Cancelled (1)');
  });

  it('an order already with the rider: nothing to choose, the server text and the order are shown', async () => {
    await setup();
    vi.spyOn(apiService, 'blockCustomer').mockRejectedValue(apiErr(409, rawOrderInDelivery()));
    await openDrawer();
    await click(footerBtn('Suspend'));
    await reason('Fake orders');
    await click(modalConfirm('Suspend'));
    await flush();
    const d = topDialog()!;
    expect(d.textContent).toContain('An order is with a rider right now.');
    expect(d.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });

  it('429 and 401: the server message in the dialog, and a 401 reaches the app (it logs out)', async () => {
    const { onAuthError } = await setup();
    vi.spyOn(apiService, 'blockCustomer').mockRejectedValueOnce(apiErr(429, rawRateLimited())).mockRejectedValueOnce(apiErr(401, { code: 'TOKEN_REVOKED', message: 'Please sign in again.' }));
    await openDrawer();
    await click(footerBtn('Suspend'));
    await reason('Fake orders');
    await click(modalConfirm('Suspend'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('Too many admin changes in a short time. Try again in a few minutes.');
    await click(modalConfirm('Suspend'));
    await flush();
    expect(onAuthError).toHaveBeenLastCalledWith(expect.objectContaining({ status: 401 }));
  });

  it('a reason the server refuses is shown under the reason box', async () => {
    await setup();
    vi.spyOn(apiService, 'blockCustomer').mockRejectedValue(apiErr(400, rawBadReason()));
    await openDrawer();
    await click(footerBtn('Suspend'));
    await reason('Fake orders');
    await click(modalConfirm('Suspend'));
    await flush();
    expect(byId('rd-reason-msg')!.textContent).toBe('Reason must be 3 to 200 characters.');
  });

  it('a double click sends one request', async () => {
    await setup();
    let release: () => void = () => {};
    const block = vi.spyOn(apiService, 'blockCustomer').mockImplementation(() => new Promise((resolve) => { release = () => resolve({ detail: detail(rawSuspendedDetail()), outcome: outcome() }); }));
    await openDrawer();
    await click(footerBtn('Suspend'));
    await reason('Fake orders');
    const btn = modalConfirm('Suspend');
    await click(btn); await click(btn);
    expect(block).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });
});

describe('remove', () => {
  const openRemove = async (detailRaw = rawCustomerDetail()) => {
    const ctx = await setup([rawCustomerRow()], detailRaw);
    await openDrawer();
    await click(footerBtn('Remove'));
    return ctx;
  };

  it('wording, the scrub box is off and explained, and the button waits for the reason and the typed name', async () => {
    await openRemove();
    const d = topDialog()!;
    expect(d.textContent).toContain('Remove Cust1 Tester?');
    expect(d.textContent).toContain('they cannot sign in again with the same Google account unless you restore them. Orders, payments and settlements stay for the books.');
    const scrub = d.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(scrub.checked).toBe(false);
    expect(d.textContent).toContain('Also erase their name, phone, hostel and coins (cannot be undone)');
    expect(d.textContent).toContain('Their email and Google sign-in stay on record so the block holds.');
    expect(modalConfirm('Remove customer').disabled).toBe(true);
    await reason('Fraud');
    expect(modalConfirm('Remove customer').disabled).toBe(true);
    await type(byId('rd-name'), 'Cust1 Tester');
    expect(modalConfirm('Remove customer').disabled).toBe(false);
  });

  it('sends scrub:false by default and scrub:true when ticked, with the typed name', async () => {
    await openRemove();
    const block = vi.spyOn(apiService, 'blockCustomer').mockResolvedValue({ detail: detail(rawRemovedDetail()), outcome: outcome() });
    await reason('Fraud');
    await type(byId('rd-name'), 'cust1 tester');
    await click(modalConfirm('Remove customer'));
    await flush();
    expect(block).toHaveBeenCalledWith(CUSTOMER_ID, 'remove', { reason: 'Fraud', confirmName: 'cust1 tester', scrub: false });
    expect(drawer().textContent).toContain('Reason: Fraud');
    expect(Array.from(drawer().querySelectorAll('footer button')).map((b) => b.textContent)).toEqual(['Restore', 'Close']);

    await click(footerBtn('Restore'));
    await click(byText('button', 'Cancel', topDialog()!));
    expect(dialogs().filter((x) => x.textContent!.includes('Restore Cust1')).length).toBe(0);
  });

  it('scrub ticked is sent as scrub:true', async () => {
    await openRemove();
    const block = vi.spyOn(apiService, 'blockCustomer').mockResolvedValue({ detail: detail(rawRemovedDetail()), outcome: outcome() });
    await reason('Fraud');
    await type(byId('rd-name'), 'Cust1 Tester');
    await click(topDialog()!.querySelector('input[type="checkbox"]'));
    await click(modalConfirm('Remove customer'));
    await flush();
    expect(block).toHaveBeenCalledWith(CUSTOMER_ID, 'remove', { reason: 'Fraud', confirmName: 'Cust1 Tester', scrub: true });
  });

  it('CONFIRM_MISMATCH from the server stays in the dialog under the name box', async () => {
    await openRemove();
    vi.spyOn(apiService, 'blockCustomer').mockRejectedValue(apiErr(400, rawConfirmMismatch()));
    await reason('Fraud');
    await type(byId('rd-name'), 'Cust1 Tester');
    await click(modalConfirm('Remove customer'));
    await flush();
    expect(byId('rd-name-msg')!.textContent).toBe('The name you typed does not match.');
    expect(topDialog()!.textContent).toContain('Remove Cust1 Tester?');
  });

  it('REFUND_NOT_SETTLED (scrub while a refund is pending) is a block with no choice; owed refunds are mentioned before sending', async () => {
    await openRemove(rawCustomerDetail({ refundsOwed: [{ orderId: ORDER_ID, refundStatus: 'PENDING', amount: 205 }] }));
    expect(topDialog()!.textContent).toContain('They are still owed 1 refund (₹205).');
    vi.spyOn(apiService, 'blockCustomer').mockRejectedValue(apiErr(409, rawRefundNotSettled()));
    await reason('Fraud');
    await type(byId('rd-name'), 'Cust1 Tester');
    await click(modalConfirm('Remove customer'));
    await flush();
    expect(topDialog()!.textContent).toContain('A refund for this customer has not reached them yet.');
    expect(topDialog()!.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });

  it('with running orders, remove offers the same explicit cancel choice and sends CANCEL only then', async () => {
    await openRemove(rawCustomerDetail({ openOrders: [rawOpenOrder()] }));
    const block = vi.spyOn(apiService, 'blockCustomer').mockResolvedValue({ detail: detail(rawRemovedDetail()), outcome: outcome(rawCancelled()) });
    await reason('Fraud');
    await type(byId('rd-name'), 'Cust1 Tester');
    expect(modalConfirm('Remove customer').disabled).toBe(true);
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalConfirm('Cancel the orders and refund, then remove'));
    await flush();
    expect(block).toHaveBeenCalledWith(CUSTOMER_ID, 'remove', { reason: 'Fraud', confirmName: 'Cust1 Tester', scrub: false, openOrders: 'CANCEL' });
  });
});

describe('restore', () => {
  it('suspended customer: optional note, then restored', async () => {
    await setup([rawCustomerRow({ accountStatus: 'SUSPENDED' })], rawSuspendedDetail());
    const restore = vi.spyOn(apiService, 'restoreCustomer').mockResolvedValue({ detail: detail(rawCustomerDetail()), outcome: outcome() });
    await openDrawer();
    await click(footerBtn('Restore'));
    const d = topDialog()!;
    expect(d.textContent).toContain('Sessions that were ended stay ended');
    expect(modalConfirm('Restore customer').disabled).toBe(false);
    await reason('Spoke on the phone');
    await click(modalConfirm('Restore customer'));
    await flush();
    expect(restore).toHaveBeenCalledWith(CUSTOMER_ID, 'Spoke on the phone');
    expect(Array.from(drawer().querySelectorAll('footer button')).map((b) => b.textContent)).toEqual(['Suspend', 'Remove', 'Close']);
  });

  it('a scrubbed customer is warned that the profile must be filled in again; NOT_RESTORABLE shows the server text', async () => {
    await setup([rawCustomerRow({ accountStatus: 'REMOVED', name: 'Removed user' })], rawRemovedDetail({ name: 'Removed user' }));
    vi.spyOn(apiService, 'restoreCustomer').mockRejectedValue(apiErr(409, { code: 'NOT_RESTORABLE', message: 'The customer deleted this account themselves.' }));
    await click(document.querySelector('[aria-label="Open Removed user"]'));
    await flush();
    await click(footerBtn('Restore'));
    expect(topDialog()!.textContent).toContain('will ask them to fill the profile in again');
    await click(modalConfirm('Restore customer'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('The customer deleted this account themselves.');
  });
});

describe('mobile layout (360 px) and roles', () => {
  it('cards for narrow screens, table only on wide ones; chips scroll sideways instead of overflowing', async () => {
    const { host } = await setup();
    expect(host.querySelector('.xl\\:hidden.grid')).not.toBeNull();
    expect(host.querySelector('.hidden.xl\\:block table')).not.toBeNull();
    expect(host.querySelector('[aria-label="Filter by account status"]')!.className).toContain('overflow-x-auto');
    const card = host.querySelector('[role="button"][aria-label="Open Cust1 Tester"]')!;
    expect(card.textContent).toContain('Active');
    expect(card.textContent).toContain('₹820');
  });

  it('dialogs are bottom sheets on a phone: full width, scrollable body, at most 94% of the screen height', async () => {
    await setup();
    await openDrawer();
    await click(footerBtn('Suspend'));
    const d = topDialog()!;
    expect(d.className).toContain('w-full');
    expect(d.className).toContain('max-h-[94vh]');
    expect(d.parentElement!.className).toContain('items-end');
    expect(d.querySelector('.overflow-y-auto')).not.toBeNull();
  });

  it('roles and names: filter group, labelled dialogs, a named close button, rows that can be opened with the keyboard', async () => {
    const { host } = await setup();
    expect(host.querySelector('[role="group"][aria-label="Filter by account status"]')).not.toBeNull();
    const row = host.querySelector('tbody tr[aria-label="Open Cust1 Tester"]') as HTMLElement;
    expect(row.getAttribute('tabindex')).toBe('0');
    await openDrawer();
    expect(drawer().getAttribute('aria-modal')).toBe('true');
    expect(drawer().querySelector('button[aria-label="Close panel"]')).not.toBeNull();
    await click(footerBtn('Suspend'));
    expect(topDialog()!.querySelector('button[aria-label="Close dialog"]')).not.toBeNull();
    expect(topDialog()!.getAttribute('aria-labelledby')).toBeTruthy();
  });
});
