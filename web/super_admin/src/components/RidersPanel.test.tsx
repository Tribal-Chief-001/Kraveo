// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RidersPanel } from './RidersPanel';
import { apiService, ApiError } from '../services/api';
import { addDays, istToday, parsePayoutAccount, parsePayoutAccountResult, parseReveal, parseRiderPayoutPage, parseRiderPayoutResult, parseRiders } from '../lib/financeParse';
import { rawAccount, rawReveal, rawRiderPayout, rawRiderPayoutList, rawRiders } from '../test/fixtures';
import { byText, click, flush, mount, type, unmount } from '../test/dom';

const partners = [{ id: 'p1', userId: 'u-rider1', name: 'Ravi Kumar', runnerCode: 'R101' }, { id: 'p3', userId: 'u-rider3', name: 'Idle Ishan', runnerCode: 'R103' }, { id: 'p9', name: 'No login' }] as any[];
let riders: ReturnType<typeof vi.spyOn>;
let ledger: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  riders = vi.spyOn(apiService, 'fetchFinanceRiders').mockResolvedValue(parseRiders(rawRiders())!) as any;
  ledger = vi.spyOn(apiService, 'fetchRiderPayouts').mockResolvedValue(parseRiderPayoutPage(rawRiderPayoutList())!) as any;
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = async () => {
  const onAuthError = vi.fn();
  const host = await mount(<RidersPanel driverPartners={partners} onAuthError={onAuthError} />);
  await flush();
  return { host, onAuthError };
};
const last = (spy: ReturnType<typeof vi.spyOn>): any[] => spy.mock.calls[spy.mock.calls.length - 1] as any[];
const btn = (text: string | RegExp, scope: ParentNode = document.body) => byText('button', text, scope);
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const submit = () => click(btn('Record payout', document.querySelector('form')!));

describe('riders overview', () => {
  it('shows deliveries and payout totals of the last 7 days, and riders without a name', async () => {
    const { host } = await render();
    expect(last(riders)[0]).toEqual({ from: addDays(istToday(), -6), to: istToday() });
    const totals = host.querySelector('[data-testid="rider-totals"]')!.textContent!;
    expect(totals).toContain('2'); expect(totals).toContain('7'); expect(totals).toContain('₹250.50');
    const region = host.querySelector('[role="region"]')!;
    expect(region.textContent).toContain('Ravi Kumar (R101)');
    expect(region.textContent).toContain('Rider u-ride'); // no name from the server: a short id, not an invented name
    expect(region.textContent).toContain('1 payout');
    expect(region.textContent).toContain('None in this range');
  });

  it('deliveries per day open on demand', async () => {
    const { host } = await render();
    await click(host.querySelector('button[aria-label="Deliveries per day of Ravi Kumar (R101)"]'));
    expect(host.textContent).toContain('6 Oct 2026');
    expect(host.querySelector('ul[aria-label="Deliveries per day of Ravi Kumar (R101)"]')!.textContent).toContain('3');
  });

  it('changing the date range reloads the riders and the ledger', async () => {
    const { host } = await render();
    await click(btn('30 days', host));
    await flush();
    expect(last(riders)[0]).toEqual({ from: addDays(istToday(), -29), to: istToday() });
    expect(last(ledger)[0]).toMatchObject({ range: { from: addDays(istToday(), -29), to: istToday() }, page: 1 });
  });

  it('empty and error states', async () => {
    riders.mockResolvedValueOnce(parseRiders({ range: {}, totals: {}, data: [] })!).mockRejectedValueOnce(new ApiError(500, 'Rider finance is unavailable.')).mockResolvedValue(parseRiders(rawRiders())!);
    ledger.mockResolvedValue(parseRiderPayoutPage(rawRiderPayoutList([]))!);
    const { host, onAuthError } = await render();
    expect(host.textContent).toContain('No rider activity');
    expect(host.textContent).toContain('No payouts were recorded in this range.');
    await click(host.querySelector('button[aria-label="Reload riders"]'));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Rider finance is unavailable.');
    expect(onAuthError).toHaveBeenCalled();
    await click(btn('Try again', host));
    await flush();
    expect(host.textContent).toContain('Ravi Kumar');
  });
});

describe('record a payout', () => {
  it('refuses a missing rider, empty / zero / 3-decimal amounts and a bad reference; nothing is sent', async () => {
    const record = vi.spyOn(apiService, 'recordRiderPayout');
    await render();
    await submit();
    expect(document.body.textContent).toContain('Choose the rider.');
    expect(document.body.textContent).toContain('Enter the amount paid.');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await type(field('payout-rider'), 'u-rider1');
    for (const amount of ['0', '12.345', '-5', 'abc']) { await type(field('payout-amount'), amount); await submit(); }
    await type(field('payout-amount'), '100'); await type(field('payout-reference'), '<>');
    await submit();
    expect(document.body.textContent).toContain('3 to 64 characters');
    expect(record).not.toHaveBeenCalled();
    expect(field('payout-reference').getAttribute('aria-invalid')).toBe('true');
  });

  it('every rider with a login can be chosen, even without activity; riders without a login cannot', async () => {
    await render();
    const options = Array.from(field('payout-rider').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('Idle Ishan (R103)');
    expect(options).toContain('Ravi Kumar (R101)');
    expect(options).not.toContain('No login');
  });

  it('asks first, says it sends no money, and records exactly what was typed', async () => {
    const record = vi.spyOn(apiService, 'recordRiderPayout').mockResolvedValue(parseRiderPayoutResult({ success: true, changed: true, message: 'Payout recorded.', data: rawRiderPayout() }));
    await render();
    await type(field('payout-rider'), 'u-rider1');
    await type(field('payout-method'), 'BANK');
    await type(field('payout-amount'), '300.5');
    await type(field('payout-reference'), ' UTR   777888 ');
    await type(field('payout-note'), 'weekly');
    await submit();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('₹300.50');
    expect(dialog.textContent).toContain('Ravi Kumar (R101)');
    expect(dialog.textContent).toContain('does not send any money');
    await click(btn('Cancel', dialog));
    expect(record).not.toHaveBeenCalled();
    const loads = ledger.mock.calls.length;
    await submit();
    await click(btn('Record payout', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ driverUserId: 'u-rider1', method: 'BANK', amount: 300.5, reference: 'UTR 777888', note: 'weekly' });
    expect(document.body.textContent).toContain('Payout recorded.');
    expect(field('payout-amount').value).toBe(''); // ready for the next one
    expect(field('payout-rider').value).toBe('u-rider1');
    expect(ledger.mock.calls.length).toBeGreaterThan(loads); // ledger reloaded
  });

  it('the same reference again is reported as already recorded', async () => {
    vi.spyOn(apiService, 'recordRiderPayout').mockResolvedValue(parseRiderPayoutResult({ success: true, changed: false, message: 'This payout was already recorded.', data: rawRiderPayout() }));
    await render();
    await type(field('payout-rider'), 'u-rider1'); await type(field('payout-amount'), '250.5'); await type(field('payout-reference'), 'UTR123456');
    await submit();
    await click(btn('Record payout', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/already recorded/i);
  });

  it('a refusal from the server is shown and the form keeps what was typed', async () => {
    vi.spyOn(apiService, 'recordRiderPayout').mockRejectedValue(new ApiError(409, 'A payout with this reference was already recorded for this rider with different details.', 'REFERENCE_USED'));
    const { onAuthError } = await render();
    await type(field('payout-rider'), 'u-rider1'); await type(field('payout-amount'), '99'); await type(field('payout-reference'), 'UTR123456');
    await submit();
    await click(btn('Record payout', document.querySelector('[role="alertdialog"]')!));
    await flush();
    expect(Array.from(document.querySelectorAll('[role="alert"]')).map((e) => e.textContent).join(' ')).toContain('different details');
    expect(field('payout-amount').value).toBe('99');
    expect(onAuthError).toHaveBeenCalled();
  });

  it('a double click records once', async () => {
    let finish: (v: any) => void = () => {};
    const record = vi.spyOn(apiService, 'recordRiderPayout').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    await type(field('payout-rider'), 'u-rider1'); await type(field('payout-amount'), '50');
    await submit();
    await click(btn('Record payout', document.querySelector('[role="alertdialog"]')!));
    await submit(); // pressed again while the first is running
    expect(record).toHaveBeenCalledTimes(1);
    finish(parseRiderPayoutResult({ changed: true, data: rawRiderPayout() }));
    await flush();
  });

  it('the row button picks the rider in the form', async () => {
    const { host } = await render();
    await click(host.querySelector('button[aria-label="Record payout for Ravi Kumar (R101)"]'));
    expect(field('payout-rider').value).toBe('u-rider1');
  });
});

describe('payout ledger', () => {
  it('lists payouts newest first with total, and filters by rider and page', async () => {
    ledger.mockResolvedValue(parseRiderPayoutPage(rawRiderPayoutList([rawRiderPayout(), rawRiderPayout({ id: 'p2', amount: 99.99, method: 'CASH', reference: null, note: 'Diwali bonus' })]) && { ...rawRiderPayoutList([rawRiderPayout(), rawRiderPayout({ id: 'p2', amount: 99.99, method: 'CASH', reference: null, note: 'Diwali bonus' })]), pages: 2, total: 40 })!);
    const { host } = await render();
    const table = host.querySelector('[role="region"][aria-label^="Rider payout ledger"]')!;
    expect(table.textContent).toContain('UTR123456');
    expect(table.textContent).toContain('₹99.99');
    expect(table.textContent).toContain('Cash');
    expect(table.textContent).toContain('Diwali bonus');
    expect(host.textContent).toContain('40 payouts');
    await type(host.querySelector('#ledger-rider'), 'u-rider1');
    await flush();
    expect(last(ledger)[0]).toMatchObject({ driverUserId: 'u-rider1', page: 1 });
    await click(btn('Next', host));
    await flush();
    expect(last(ledger)[0]).toMatchObject({ driverUserId: 'u-rider1', page: 2 });
  });
});

describe('rider payout details', () => {
  it('opens the masked account of that rider; the full number is hidden again after the reveal dialog closes', async () => {
    const fetchAccount = vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(parsePayoutAccountResult({ data: rawAccount({ userId: 'u-rider1', partnerType: 'DRIVER' }) })!);
    vi.spyOn(apiService, 'revealPayoutAccount').mockResolvedValue(parseReveal(rawReveal())!);
    const { host } = await render();
    expect(fetchAccount).not.toHaveBeenCalled(); // only when opened
    await click(host.querySelector('button[aria-label="Payout details of Ravi Kumar (R101)"]'));
    await flush();
    expect(fetchAccount).toHaveBeenCalledWith('u-rider1');
    expect(host.textContent).toContain('XXXXXX7890');
    await click(btn(/Reveal full account number/, host));
    await click(btn('Reveal and log it', document.body));
    await flush();
    expect(document.body.textContent).toContain('50100234567890');
    await click(btn('Close and hide', document.body));
    expect(document.body.textContent).not.toContain('50100234567890');
    void parsePayoutAccount;
  });

  it('a rider with no saved details shows the warning', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue({ partner: null, account: null, changed: null, message: '' });
    const { host } = await render();
    await click(host.querySelector('button[aria-label="Payout details of Rider u-ride"]'));
    await flush();
    expect(host.textContent).toContain('No payout details');
  });
});
