// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

vi.mock('../lib/download', () => ({ saveBlob: vi.fn() }));

import { SettlementsPanel } from './SettlementsPanel';
import { apiService, ApiError } from '../services/api';
import { saveBlob } from '../lib/download';
import { addDays, istToday, parsePayoutAccount, parseRunResult, parseSettlementAction, parseSettlementDetail, parseSettlementPage } from '../lib/financeParse';
import { rawAccount, rawAction, rawRun, rawSettlement, rawSettlementDetail, rawSettlementList } from '../test/fixtures';
import { byText, click, flush, mount, type, unmount } from '../test/dom';

const vendors = [{ id: 'v1', name: 'Sharma Dhaba' }, { id: 'v2', name: 'Chai Point' }] as any[];
const ROWS = [rawSettlement(), rawSettlement({ id: 's2222222-bbbb', vendorId: 'v2', vendorName: 'Chai Point', netPayable: 90.5, vendorAmount: 90.5, orderCount: 1, payoutSnapshot: null, hasPayoutDetails: false })];
const list = (rows: unknown[] = ROWS, summary: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => parseSettlementPage(rawSettlementList(rows, summary, over))!;
const detail = (settlement: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => parseSettlementDetail({ data: rawSettlementDetail({ settlement: rawSettlement(settlement), ...over }) })!;
const action = (settlement: Record<string, unknown>, over: Record<string, unknown> = {}) => parseSettlementAction(rawAction(rawSettlement(settlement), over));

let fetchList: ReturnType<typeof vi.spyOn>;
let fetchOne: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchList = vi.spyOn(apiService, 'fetchSettlements').mockResolvedValue(list()) as any;
  fetchOne = vi.spyOn(apiService, 'fetchSettlement').mockResolvedValue(detail()) as any;
  (saveBlob as any).mockClear();
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = async () => {
  const onChanged = vi.fn(); const onAuthError = vi.fn();
  const host = await mount(<SettlementsPanel vendors={vendors} onChanged={onChanged} onAuthError={onAuthError} />);
  await flush();
  return { host, onChanged, onAuthError };
};
const last = (spy: ReturnType<typeof vi.spyOn>): any[] => spy.mock.calls[spy.mock.calls.length - 1] as any[];
const body = () => document.body;
const btn = (text: string | RegExp, scope: ParentNode = document.body) => byText('button', text, scope);
const openFirst = async () => { await click(document.querySelector('tr[aria-label^="Open settlement of Sharma"]')); await flush(); };
const drawer = () => document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement;

describe('settlement list', () => {
  it('opens on PENDING, shows rows and the totals of that status only', async () => {
    const { host } = await render();
    expect(last(fetchList)[0]).toEqual({ status: 'PENDING', vendorId: '', range: null, page: 1, pageSize: 25 });
    expect(btn('Pending', host)!.getAttribute('aria-pressed')).toBe('true');
    const row = host.querySelector('tr[aria-label^="Open settlement of Sharma"]')!;
    expect(row.textContent).toContain('₹360');
    expect(host.querySelector('tr[aria-label^="Open settlement of Chai"]')!.textContent).toContain('₹90.50');
    expect(host.querySelector('tr[aria-label^="Open settlement of Chai"]')!.textContent).toContain('No payout details');
    expect(row.textContent).toContain('UPI');
    const totals = host.querySelector('[data-testid="settlement-summary"]')!;
    expect(totals.textContent).toContain('Pending');
    expect(totals.textContent).not.toContain('Paid');
    expect(host.textContent).toContain('2 settlements');
  });

  it('status chips, restaurant and dates go to the server and reset the page', async () => {
    fetchList.mockResolvedValue(list(ROWS, { PAID: { count: 3, netPayable: 1234.5 } }, { pages: 3, total: 60 }));
    const { host } = await render();
    for (const [label, status] of [['On hold', 'ON_HOLD'], ['Paid', 'PAID'], ['Cancelled', 'CANCELLED'], ['All', '']] as const) {
      await click(btn(label, host));
      await flush();
      expect(last(fetchList)[0]).toMatchObject({ status, page: 1 });
    }
    expect(host.querySelector('[data-testid="settlement-summary"]')!.textContent).toContain('₹1,234.50'); // All: every status card
    expect(host.querySelectorAll('[data-testid="settlement-summary"] > div').length).toBe(4);
    await type(host.querySelector('#settle-vendor-filter'), 'v2');
    await flush();
    expect(last(fetchList)[0]).toMatchObject({ vendorId: 'v2' });
    await click(btn('Next', host));
    await flush();
    expect(last(fetchList)[0]).toMatchObject({ page: 2 });
    await click(btn('7 days', host));
    await flush();
    expect(last(fetchList)[0]).toMatchObject({ page: 1, range: { from: addDays(istToday(), -6), to: istToday() } });
    await click(btn('All time', host));
    await flush();
    expect(last(fetchList)[0].range).toBeNull();
  });

  it('empty and error states', async () => {
    fetchList.mockResolvedValueOnce(list([])).mockRejectedValueOnce(new ApiError(500, 'Settlements are unavailable.')).mockResolvedValue(list());
    const { host, onAuthError } = await render();
    expect(host.textContent).toContain('Nothing is waiting to be paid');
    await click(btn('Reload settlements', host) ?? host.querySelector('button[aria-label="Reload settlements"]'));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Settlements are unavailable.');
    expect(onAuthError).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="settlement-summary"]')).toBeNull();
    await click(btn('Try again', host));
    await flush();
    expect(host.textContent).toContain('Sharma Dhaba');
  });
});

describe('Create settlements now', () => {
  it('explains what it does, runs only after a yes, shows the server message and reloads', async () => {
    const run = vi.spyOn(apiService, 'runSettlements').mockResolvedValue(parseRunResult(rawRun()));
    const { host, onChanged } = await render();
    await click(btn('Create settlements now', host));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('delivered and paid order');
    expect(dialog.textContent).toContain('safe to press again');
    expect(dialog.textContent).toContain('Nothing is paid');
    await click(btn('Cancel', dialog));
    expect(run).not.toHaveBeenCalled();
    const before = fetchList.mock.calls.length;
    await click(btn('Create settlements now', host));
    await click(btn('Create settlements', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    const result = host.querySelector('[data-testid="run-result"]')!;
    expect(result.textContent).toContain('1 settlement(s) created for 3 order(s).');
    expect(result.textContent).toContain('₹360 payable');
    expect(fetchList.mock.calls.length).toBeGreaterThan(before);
    expect(onChanged).toHaveBeenCalled();
  });

  it('"nothing to settle", skipped and failed restaurants are reported plainly; an error is shown', async () => {
    const run = vi.spyOn(apiService, 'runSettlements').mockResolvedValueOnce(parseRunResult({ message: 'Nothing to settle: no delivered, paid order is waiting.', data: { created: [], skipped: [{ vendorId: 'a', reason: 'X' }], failed: [{ vendorId: 'b' }] } }))
      .mockRejectedValueOnce(new ApiError(429, 'Too many requests.'));
    const { host } = await render();
    await click(btn('Create settlements now', host));
    await click(btn('Create settlements', document.querySelector('[role="alertdialog"]')!));
    await flush();
    const result = host.querySelector('[data-testid="run-result"]')!;
    expect(result.textContent).toContain('Nothing to settle');
    expect(result.textContent).toContain('1 skipped');
    expect(result.textContent).toContain('1 restaurant failed');
    await click(btn('Create settlements now', host));
    await click(btn('Create settlements', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Too many requests.');
  });
});

describe('CSV export of the list', () => {
  it('downloads with the auth-carrying fetch and saves the blob', async () => {
    const dl = vi.spyOn(apiService, 'downloadSettlementsCsv').mockResolvedValue({ blob: new Blob(['x']), filename: 'kraveo-settlements-2026-10-01_2026-10-07.csv' });
    const { host } = await render();
    expect(host.textContent).toContain('Export CSV (last 31 days)');
    await click(btn(/Export CSV/, host));
    await flush();
    expect(dl).toHaveBeenCalledWith(null);
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'kraveo-settlements-2026-10-01_2026-10-07.csv');
    await click(btn('30 days', host));
    await flush();
    expect(host.textContent).toMatch(/Export CSV \(.* to .*\)/);
    await click(btn(/Export CSV/, host));
    await flush();
    expect(dl).toHaveBeenLastCalledWith({ from: addDays(istToday(), -29), to: istToday() });
  });

  it('a range over 366 days is refused with a message and nothing is requested; a failed download shows the error', async () => {
    const dl = vi.spyOn(apiService, 'downloadSettlementsCsv').mockRejectedValueOnce(new ApiError(0, 'The operations API is unreachable.', 'NETWORK'));
    const { host } = await render();
    await click(btn('Custom', host));
    const [from, to] = Array.from(host.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    await type(from, '2025-01-01'); await type(to, '2026-10-07');
    await click(btn('Apply dates', host));
    await flush();
    await click(btn(/Export CSV/, host));
    expect(host.textContent).toContain('at most 366 days');
    expect(dl).not.toHaveBeenCalled();
    await click(btn('7 days', host));
    await click(btn(/Export CSV/, host));
    await flush();
    expect(host.textContent).toContain('The operations API is unreachable.');
    expect(saveBlob).not.toHaveBeenCalled();
  });
});

describe('settlement detail drawer', () => {
  it('shows totals, the frozen snapshot, the live masked account, orders, dishes and adjustments', async () => {
    await render();
    await openFirst();
    expect(fetchOne).toHaveBeenCalledWith('s1111111-aaaa');
    const d = drawer();
    expect(d.getAttribute('aria-labelledby')).toBeTruthy();
    const text = d.textContent!;
    expect(text).toContain('Sharma Dhaba');
    expect(text).toContain('Net payable');
    expect(text).toContain('₹360');
    expect(text).toContain('kitchen1@upi'); // snapshot
    expect(text).toContain('XXXXXX7890'); // live masked account
    expect(text).not.toContain('50100234567890');
    expect(text).toContain('order-aa'); // orders table (first 8 of the id)
    expect(text).toContain('Paneer Roll');
    expect(text).toContain('Late handover');
    expect(text).toContain('-₹10.50');
  });

  it('warns "no payout details" when neither a snapshot nor a live account exists', async () => {
    fetchOne.mockResolvedValue(detail({ payoutSnapshot: null, hasPayoutDetails: false }, { payoutAccount: null }));
    await render();
    await openFirst();
    expect(drawer().textContent).toContain('No payout details were saved when this settlement was created');
    expect(drawer().textContent).toContain('has not saved a UPI id or bank account yet');
  });

  it('a detail error is shown with Try again', async () => {
    fetchOne.mockRejectedValueOnce(new ApiError(404, 'Settlement not found.')).mockResolvedValue(detail());
    await render();
    await openFirst();
    expect(drawer().querySelector('[role="alert"]')?.textContent).toContain('Settlement not found.');
    await click(btn('Try again', drawer()));
    await flush();
    expect(drawer().textContent).toContain('Paneer Roll');
  });

  it('Escape closes the drawer', async () => {
    await render();
    await openFirst();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(drawer()).toBeNull();
  });
});

describe('mark paid', () => {
  const openPay = async () => { await render(); await openFirst(); await click(btn('Mark paid', drawer())); };
  const reference = () => document.getElementById('settle-reference') as HTMLInputElement;

  it('refuses an empty or too short reference: no confirm, no request', async () => {
    const pay = vi.spyOn(apiService, 'markSettlementPaid');
    await openPay();
    await click(btn('Review and mark paid', drawer()));
    expect(drawer().textContent).toContain('Enter the bank or UPI transaction reference');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await type(reference(), 'ab');
    await click(btn('Review and mark paid', drawer()));
    expect(drawer().textContent).toContain('3 to 64 characters');
    await type(reference(), 'a'.repeat(65));
    await click(btn('Review and mark paid', drawer()));
    expect(pay).not.toHaveBeenCalled();
    expect(reference().getAttribute('aria-invalid')).toBe('true');
  });

  it('a future paid date is refused', async () => {
    const pay = vi.spyOn(apiService, 'markSettlementPaid');
    await openPay();
    await type(reference(), 'UTR123456');
    await type(document.getElementById('settle-paid-date'), addDays(istToday(), 3));
    await click(btn('Review and mark paid', drawer()));
    expect(drawer().textContent).toContain('cannot be in the future');
    expect(pay).not.toHaveBeenCalled();
  });

  it('confirm dialog names the amount and the reference; No sends nothing; Yes marks paid once and shows the UTR afterwards', async () => {
    const pay = vi.spyOn(apiService, 'markSettlementPaid').mockResolvedValue(action({ status: 'PAID', paymentReference: 'UTR123456', paidAt: '2026-10-07T10:00:00.000Z' }, { message: 'Marked as paid.' }));
    await openPay();
    await type(reference(), '  UTR123456 ');
    await type(document.getElementById('settle-note'), 'paid from the HDFC account');
    await click(btn('Review and mark paid', drawer()));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('₹360');
    expect(dialog.textContent).toContain('UTR123456');
    expect(dialog.textContent).toContain('cannot be undone');
    await click(btn('Cancel', dialog));
    expect(pay).not.toHaveBeenCalled();
    await click(btn('Review and mark paid', drawer()));
    fetchOne.mockResolvedValue(detail({ status: 'PAID', paymentReference: 'UTR123456', paidAt: '2026-10-07T10:00:00.000Z' }));
    await click(btn('Mark as paid', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay).toHaveBeenCalledWith('s1111111-aaaa', { reference: 'UTR123456', note: 'paid from the HDFC account' });
    expect(drawer().querySelector('[data-testid="payment-reference"]')?.textContent).toBe('UTR123456');
    expect(btn('Mark paid', drawer())).toBeUndefined(); // a paid settlement offers no money actions
    expect(btn('Cancel settlement', drawer())).toBeUndefined();
    expect(btn('Download CSV', drawer())).toBeDefined();
  });

  it('an earlier paid date is sent as noon India time', async () => {
    const pay = vi.spyOn(apiService, 'markSettlementPaid').mockResolvedValue(action({ status: 'PAID', paymentReference: 'UTR123456' }));
    await openPay();
    await type(reference(), 'UTR123456');
    const day = addDays(istToday(), -2);
    await type(document.getElementById('settle-paid-date'), day);
    await click(btn('Review and mark paid', drawer()));
    await click(btn('Mark as paid', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(pay).toHaveBeenCalledWith('s1111111-aaaa', { reference: 'UTR123456', paidAt: `${day}T12:00:00+05:30` });
  });

  it('the server refusing (second different reference) is shown and the drawer stays open', async () => {
    vi.spyOn(apiService, 'markSettlementPaid').mockRejectedValue(new ApiError(409, 'This settlement was already paid with a different reference. Nothing was changed.', 'ALREADY_PAID'));
    const { onAuthError } = { onAuthError: null };
    void onAuthError;
    await openPay();
    await type(reference(), 'UTR999999');
    await click(btn('Review and mark paid', drawer()));
    await click(btn('Mark as paid', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(drawer().querySelector('[role="alert"]')?.textContent).toContain('already paid with a different reference');
    expect(drawer().textContent).not.toContain('UTR / reference');
  });

  it('Mark paid is disabled when nothing is payable', async () => {
    fetchOne.mockResolvedValue(detail({ netPayable: 0, vendorAmount: 0 }));
    fetchList.mockResolvedValue(list([rawSettlement({ netPayable: 0, vendorAmount: 0 })]));
    await render();
    await openFirst();
    expect((btn('Mark paid', drawer()) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('hold and release', () => {
  it('hold with a note, then the drawer offers Release and no Mark paid', async () => {
    const hold = vi.spyOn(apiService, 'holdSettlement').mockResolvedValue(action({ status: 'ON_HOLD', note: 'bank check' }));
    const release = vi.spyOn(apiService, 'releaseSettlement').mockResolvedValue(action({ status: 'PENDING' }));
    const { onChanged } = await render();
    await openFirst();
    await click(btn('Hold', drawer()));
    await type(document.getElementById('settle-hold-note'), 'bank check');
    fetchOne.mockResolvedValue(detail({ status: 'ON_HOLD', note: 'bank check' }));
    await click(btn('Put on hold', drawer()));
    await flush();
    expect(hold).toHaveBeenCalledWith('s1111111-aaaa', { note: 'bank check' });
    expect(onChanged).toHaveBeenCalled();
    expect(drawer().textContent).toContain('Release it before marking it paid');
    expect(btn('Mark paid', drawer())).toBeUndefined();
    fetchOne.mockResolvedValue(detail());
    await click(btn('Release', drawer()));
    await flush();
    expect(release).toHaveBeenCalledWith('s1111111-aaaa');
    expect(btn('Mark paid', drawer())).toBeDefined();
  });
});

describe('adjustments', () => {
  const openAdjust = async () => { await render(); await openFirst(); await click(btn('Add adjustment', drawer())); };
  const amount = () => document.getElementById('settle-adj-amount') as HTMLInputElement;
  const reason = () => document.getElementById('settle-adj-reason') as HTMLInputElement;

  it('refuses empty, zero, 3 decimals and a missing reason', async () => {
    const add = vi.spyOn(apiService, 'addSettlementAdjustment');
    await openAdjust();
    await click(btn('Add adjustment', drawer().querySelector('form')!));
    expect(drawer().textContent).toContain('Enter an amount');
    expect(drawer().textContent).toContain('Enter a reason');
    for (const bad of ['0', '12.345', 'abc']) {
      await type(amount(), bad); await type(reason(), 'Late handover');
      await click(btn('Add adjustment', drawer().querySelector('form')!));
    }
    await type(amount(), '5'); await type(reason(), '  ');
    await click(btn('Add adjustment', drawer().querySelector('form')!));
    expect(add).not.toHaveBeenCalled();
  });

  it('refuses a deduction that would make the payable amount negative', async () => {
    const add = vi.spyOn(apiService, 'addSettlementAdjustment');
    await openAdjust();
    await type(amount(), '-500'); await type(reason(), 'Wrong order');
    await click(btn('Add adjustment', drawer().querySelector('form')!));
    expect(drawer().textContent).toContain('negative');
    expect(add).not.toHaveBeenCalled();
  });

  it('sends a signed amount, a trimmed reason and a request id; a double click adds it once', async () => {
    let finish: (v: any) => void = () => {};
    const add = vi.spyOn(apiService, 'addSettlementAdjustment').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await openAdjust();
    await type(amount(), '-25.5'); await type(reason(), '  Cold   food  ');
    const submit = btn('Add adjustment', drawer().querySelector('form')!)!;
    await click(submit); await click(submit);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe('s1111111-aaaa');
    expect(add.mock.calls[0][1]).toMatchObject({ amount: -25.5, reason: 'Cold food' });
    expect(add.mock.calls[0][1].requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await act(async () => { finish(action({ adjustmentTotal: -25.5, netPayable: 334.5 }, { adjustment: { id: 'a2', amount: -25.5, reason: 'Cold food' } })); });
    await flush();
    expect(drawer().querySelector('form[aria-label="Add adjustment"]')).toBeNull(); // form closes on success
  });
});

describe('cancel and CSV of one settlement', () => {
  it('cancel explains that the orders go back to unsettled and only runs after a yes', async () => {
    const cancel = vi.spyOn(apiService, 'cancelSettlement').mockResolvedValue(action({ status: 'CANCELLED' }, { freedOrders: 3 }));
    const { onChanged } = await render();
    await openFirst();
    await click(btn('Cancel settlement', drawer()));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('3 orders');
    expect(dialog.textContent).toContain('unsettled');
    expect(dialog.textContent).toContain('next settlement run');
    await click(btn('Keep it', dialog));
    expect(cancel).not.toHaveBeenCalled();
    await click(btn('Cancel settlement', drawer()));
    fetchOne.mockResolvedValue(detail({ status: 'CANCELLED' }, { orders: [] }));
    await click(btn('Cancel settlement', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalled();
    expect(drawer().textContent).toContain('Cancelled');
    expect(btn('Cancel settlement', drawer())).toBeUndefined();
  });

  it('Download CSV saves the file the server named', async () => {
    const dl = vi.spyOn(apiService, 'downloadSettlementCsv').mockResolvedValue({ blob: new Blob(['a']), filename: 'kraveo-settlement-s1111111.csv' });
    await render();
    await openFirst();
    await click(btn('Download CSV', drawer()));
    await flush();
    expect(dl).toHaveBeenCalledWith('s1111111-aaaa');
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'kraveo-settlement-s1111111.csv');
  });
});

describe('small screens', () => {
  it('at 360 px the list renders as cards and the table scrolls sideways; nothing crashes', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    const { host } = await render();
    expect(host.querySelectorAll('li button[aria-label^="Open settlement of"]').length).toBe(2);
    expect(host.querySelector('[role="region"]')?.className).toContain('overflow-x-auto');
    await click(host.querySelector('li button[aria-label^="Open settlement of Sharma"]'));
    await flush();
    expect(drawer()).not.toBeNull();
    expect(body().textContent).toContain('Net payable');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });
});

void parsePayoutAccount;
void rawAccount;
