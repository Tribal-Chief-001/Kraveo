// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceOverview } from './FinanceOverview';
import { apiService, ApiError } from '../services/api';
import { addDays, istToday, parseByDay, parseByDish, parseByRestaurant, parseFinanceSummary } from '../lib/financeParse';
import { rawByDay, rawByDish, rawByRestaurant, rawSummary } from '../test/fixtures';
import { byText, click, flush, mount, type, unmount } from '../test/dom';

const vendors = [{ id: 'v1', name: 'Sharma Dhaba' }, { id: 'v2', name: 'Chai Point' }] as any[];
let summary: ReturnType<typeof vi.spyOn>;
let byDay: ReturnType<typeof vi.spyOn>;
let byRestaurant: ReturnType<typeof vi.spyOn>;
let byDish: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  summary = vi.spyOn(apiService, 'fetchFinanceSummary').mockImplementation(async () => parseFinanceSummary({ data: rawSummary() })!) as any;
  byDay = vi.spyOn(apiService, 'fetchFinanceByDay').mockImplementation(async () => parseByDay(rawByDay())!) as any;
  byRestaurant = vi.spyOn(apiService, 'fetchFinanceByRestaurant').mockImplementation(async () => parseByRestaurant(rawByRestaurant())!) as any;
  byDish = vi.spyOn(apiService, 'fetchFinanceByDish').mockImplementation(async () => parseByDish(rawByDish())!) as any;
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = async () => {
  const onAuthError = vi.fn();
  const host = await mount(<FinanceOverview vendors={vendors} onAuthError={onAuthError} />);
  await flush();
  return { host, onAuthError };
};
const last = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls[spy.mock.calls.length - 1];

describe('FinanceOverview', () => {
  it('opens on the last 7 India days and shows every card with rupees (paise only when they exist)', async () => {
    const { host } = await render();
    const today = istToday();
    expect(last(summary)[0]).toEqual({ from: addDays(today, -6), to: today });
    expect(byText('button', '7 days', host)!.getAttribute('aria-pressed')).toBe('true');
    const cards = host.querySelector('[data-testid="finance-cards"]')!.textContent!;
    for (const label of ['Orders', 'Food gross', 'Restaurant amount', 'Commission', 'Fees collected', 'Discounts', 'Platform revenue', 'Refunds', 'Settled', 'Unsettled', 'Paid out']) expect(cards).toContain(label);
    expect(cards).toContain('₹1,000'); // food gross, no .00
    expect(cards).toContain('₹30.50'); // discounts keep paise
    expect(cards).toContain('₹169.50'); // platform revenue
    expect(cards).toContain('₹120'); // refunds
    expect(cards).toContain('1 order');
    expect(cards).toContain('₹600'); expect(cards).toContain('₹300'); expect(cards).toContain('₹450');
    expect(cards).not.toContain('NaN');
  });

  it('by-day, by-restaurant and by-dish tables show the server rows', async () => {
    const { host } = await render();
    const days = host.querySelector('table[aria-label], div[aria-label^="Finance by day"]')!;
    expect(days.textContent).toContain('6 Oct 2026');
    expect(days.textContent).toContain('7 Oct 2026');
    expect(days.textContent).toContain('₹169.50');
    expect(host.textContent).toContain('Sharma Dhaba');
    expect(host.textContent).toContain('Paneer Roll');
    expect(host.textContent).toContain('₹1,344');
    expect(host.textContent).toContain('₹144');
    expect(last(byRestaurant)[0]).toMatchObject({ from: addDays(istToday(), -6) });
  });

  it('presets change every request: Today and 30 days', async () => {
    const { host } = await render();
    await click(byText('button', 'Today', host));
    await flush();
    const today = istToday();
    expect(last(summary)[0]).toEqual({ from: today, to: today });
    expect(last(byDay)[0]).toEqual({ from: today, to: today });
    expect(byText('button', 'Today', host)!.getAttribute('aria-pressed')).toBe('true');
    await click(byText('button', '30 days', host));
    await flush();
    expect(last(summary)[0]).toEqual({ from: addDays(today, -29), to: today });
  });

  it('custom range: valid dates are sent, a reversed range is refused before any request', async () => {
    const { host } = await render();
    await click(byText('button', 'Custom', host));
    const [from, to] = Array.from(host.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    const calls = summary.mock.calls.length;
    await type(from, '2026-09-10');
    await type(to, '2026-09-01');
    await click(byText('button', 'Apply dates', host));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot be after');
    expect(summary.mock.calls.length).toBe(calls);
    await type(to, '2026-09-20');
    await click(byText('button', 'Apply dates', host));
    await flush();
    expect(last(summary)[0]).toEqual({ from: '2026-09-10', to: '2026-09-20' });
    expect(host.textContent).toContain('10 Sep 2026 to 20 Sep 2026');
  });

  it('a range longer than 366 days is refused on this side', async () => {
    const { host } = await render();
    await click(byText('button', 'Custom', host));
    const [from, to] = Array.from(host.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    const calls = summary.mock.calls.length;
    await type(from, '2025-01-01'); await type(to, '2026-10-07');
    await click(byText('button', 'Apply dates', host));
    expect(host.textContent).toContain('366 days');
    expect(summary.mock.calls.length).toBe(calls);
  });

  it('dish sort and top N go to the server; a restaurant can be chosen', async () => {
    const { host } = await render();
    expect(last(byDish)[1]).toEqual({ sort: 'units', top: 20, vendorId: undefined });
    await click(byText('button', 'Commission', host));
    await flush();
    expect(last(byDish)[1]).toMatchObject({ sort: 'commission', top: 20 });
    await click(byText('button', 'Restaurant revenue', host));
    await flush();
    expect(last(byDish)[1]).toMatchObject({ sort: 'vendorRevenue' });
    await type(host.querySelector('#finance-dish-top'), '50');
    await flush();
    expect(last(byDish)[1]).toMatchObject({ top: 50 });
    await type(host.querySelector('#finance-dish-vendor'), 'v2');
    await flush();
    expect(last(byDish)[1]).toMatchObject({ vendorId: 'v2' });
  });

  it('one section failing shows its own error and the rest still work; Try again reloads only that section', async () => {
    summary.mockRejectedValueOnce(new ApiError(500, 'Finance is unavailable right now.'));
    const { host, onAuthError } = await render();
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Finance is unavailable right now.');
    expect(onAuthError).toHaveBeenCalled();
    expect(host.textContent).toContain('Sharma Dhaba'); // by-restaurant still there
    expect(host.querySelector('[data-testid="finance-cards"]')).toBeNull(); // no invented zeros
    await click(byText('button', 'Try again', host));
    await flush();
    expect(summary).toHaveBeenCalledTimes(2);
    expect(byRestaurant).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="finance-cards"]')).not.toBeNull();
  });

  it('empty states are plain words', async () => {
    summary.mockResolvedValue(parseFinanceSummary({ data: rawSummary({ orders: 0, foodGross: 0, vendorAmount: 0, commission: 0, feesCollected: 0, discounts: 0, platformRevenue: 0, refunds: { count: 0, amount: 0 }, settledAmount: 0, unsettledAmount: 0, paidOutAmount: 0 }) })!);
    byRestaurant.mockResolvedValue({ range: { from: '', to: '', days: 0 }, rows: [] });
    byDish.mockResolvedValue({ range: { from: '', to: '', days: 0 }, sort: 'units', rows: [] });
    const { host } = await render();
    expect(host.textContent).toContain('No delivered, paid orders in this range yet.');
    expect(host.textContent).toContain('No restaurant had a delivered, paid order in this range.');
    expect(host.textContent).toContain('No dishes were sold in this range.');
  });

  it('shows loading placeholders first', async () => {
    summary.mockImplementation(() => new Promise(() => {}));
    const host = await mount(<FinanceOverview vendors={vendors} onAuthError={vi.fn()} />);
    expect(host.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull();
  });

  it('a 360 px phone: renders, tables sit in sideways-scrolling regions, nothing crashes', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    const { host } = await render();
    const regions = Array.from(host.querySelectorAll('[role="region"]'));
    expect(regions.length).toBe(3);
    for (const region of regions) expect(region.className).toContain('overflow-x-auto');
    expect(host.textContent).toContain('₹169.50');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
  });
});
