// @vitest-environment jsdom
// The Finance shell (tabs, badge), the Sidebar entry and the "Payout details" section of the Restaurants cards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { FinancePanel } from './FinancePanel';
import { Sidebar } from './Sidebar';
import { VendorManager } from './VendorManager';
import { apiService, ApiError } from '../services/api';
import { parseByDay, parseByDish, parseByRestaurant, parseFinanceSummary, parsePayoutAccountResult, parseReveal, parseRiderPayoutPage, parseRiders, parseSettlementPage } from '../lib/financeParse';
import { rawAccount, rawByDay, rawByDish, rawByRestaurant, rawReveal, rawRiderPayoutList, rawRiders, rawSettlement, rawSettlementList, rawSummary } from '../test/fixtures';
import { byText, click, flush, mount, type, unmount } from '../test/dom';

const vendor = (over: Record<string, unknown> = {}) => ({ id: 'v1', userId: 'u-owner1', name: 'Sharma Dhaba', category: 'North Indian', rating: 4.5, isAcceptingOrders: true, address: 'Ashta road', approvalStatus: 'APPROVED', ...over }) as any;

beforeEach(() => {
  vi.spyOn(apiService, 'fetchFinanceSummary').mockResolvedValue(parseFinanceSummary({ data: rawSummary() })!);
  vi.spyOn(apiService, 'fetchFinanceByDay').mockResolvedValue(parseByDay(rawByDay())!);
  vi.spyOn(apiService, 'fetchFinanceByRestaurant').mockResolvedValue(parseByRestaurant(rawByRestaurant())!);
  vi.spyOn(apiService, 'fetchFinanceByDish').mockResolvedValue(parseByDish(rawByDish())!);
  vi.spyOn(apiService, 'fetchFinanceRiders').mockResolvedValue(parseRiders(rawRiders())!);
  vi.spyOn(apiService, 'fetchRiderPayouts').mockResolvedValue(parseRiderPayoutPage(rawRiderPayoutList())!);
  vi.spyOn(apiService, 'fetchSettlements').mockResolvedValue(parseSettlementPage(rawSettlementList([rawSettlement()]))!);
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('Finance shell', () => {
  const render = async (over: Record<string, unknown> = {}) => {
    const props = { vendors: [vendor()], driverPartners: [], pendingSettlements: 4, onSettlementsChanged: vi.fn(), onAuthError: vi.fn(), ...over };
    const host = await mount(<FinancePanel {...(props as any)} />);
    await flush();
    return { host, props };
  };

  it('has Overview, Settlements and Riders tabs; Overview first; Settlements carries the pending count', async () => {
    const { host } = await render();
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent!.replace(/\d+$/, ''))).toEqual(['Overview', 'Settlements', 'Riders']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].textContent).toContain('4');
    expect(host.querySelector('[role="tabpanel"]')!.textContent).toContain('Platform revenue');
  });

  it('switching tabs shows each section, with clicks and arrow keys', async () => {
    const { host } = await render();
    await click(byText('button', /^Settlements/, host));
    await flush();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Settlements');
    expect(host.textContent).toContain('Create settlements now');
    await click(byText('button', 'Riders', host));
    await flush();
    expect(host.textContent).toContain('Record a payout');
    const riders = host.querySelector('#finance-tab-riders') as HTMLElement;
    await act(async () => { riders.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Overview'); // wraps around
    await act(async () => { (host.querySelector('#finance-tab-overview') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Riders');
  });

  it('no pending settlements: no number on the tab', async () => {
    const { host } = await render({ pendingSettlements: 0 });
    expect(byText('button', 'Settlements', host)).toBeDefined();
  });

  it('works on a 360 px phone: the tab row scrolls, panels render', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    const { host } = await render();
    expect(host.querySelector('[role="tablist"]')!.className).toContain('overflow-x-auto');
    await click(byText('button', /^Settlements/, host));
    await flush();
    expect(host.textContent).toContain('Sharma Dhaba');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });
});

describe('Sidebar', () => {
  const sidebar = (badges: Record<string, number>) => (
    <Sidebar activeTab="map" setActiveTab={vi.fn()} isLiveConnected mobileOpen={false} onCloseMobile={vi.fn()} badges={badges} />
  );

  it('has a Finance entry with the pending settlements badge', async () => {
    const host = await mount(sidebar({ finance: 5 }));
    const nav = host.querySelector('nav[aria-label="Primary"]')!;
    const item = nav.querySelector('button[aria-label="Finance (5)"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain('5');
  });

  it('no badge number at 0', async () => {
    const host = await mount(sidebar({ finance: 0 }));
    expect(host.querySelector('nav button[aria-label="Finance"]')).not.toBeNull();
  });
});

describe('Restaurants: payout details', () => {
  const render = async (vendors: any[]) => {
    const host = await mount(<VendorManager vendors={vendors} onToggleVendor={() => {}} onAuthError={vi.fn()} />);
    await flush();
    return host;
  };

  it('an approved restaurant has a closed "Payout details" section; nothing is fetched until it is opened', async () => {
    const fetchAccount = vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(parsePayoutAccountResult({ data: rawAccount() })!);
    const host = await render([vendor()]);
    expect(fetchAccount).not.toHaveBeenCalled();
    await click(host.querySelector('button[aria-label="Payout details of Sharma Dhaba"]'));
    await flush();
    expect(fetchAccount).toHaveBeenCalledWith('u-owner1');
    expect(host.textContent).toContain('XXXXXX7890');
    expect(host.textContent).toContain('HDFC0001234');
  });

  it('a restaurant that is not approved has no payout section', async () => {
    const host = await render([vendor({ approvalStatus: 'PENDING' })]);
    expect(host.querySelector('button[aria-label="Payout details of Sharma Dhaba"]')).toBeNull();
  });

  it('a restaurant without an owner login says so', async () => {
    const host = await render([vendor({ userId: undefined })]);
    await click(host.querySelector('button[aria-label="Payout details of Sharma Dhaba"]'));
    expect(host.textContent).toContain('no owner login');
  });

  it('edit, verify and reveal work from the restaurant card, and the full number is gone after closing', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(parsePayoutAccountResult({ data: rawAccount() })!);
    const verify = vi.spyOn(apiService, 'setPayoutVerified').mockResolvedValue(parsePayoutAccountResult({ data: rawAccount({ verifiedAt: '2026-10-07T00:00:00.000Z' }) })!);
    const reveal = vi.spyOn(apiService, 'revealPayoutAccount').mockResolvedValue(parseReveal(rawReveal())!);
    const save = vi.spyOn(apiService, 'savePayoutAccount').mockRejectedValue(new ApiError(503, 'Payout encryption is not configured on the server.', 'PAYOUT_ENCRYPTION_NOT_CONFIGURED'));
    const host = await render([vendor()]);
    await click(host.querySelector('button[aria-label="Payout details of Sharma Dhaba"]'));
    await flush();
    await click(host.querySelector('button[role="switch"][aria-label$="payout details verified"]'));
    await flush();
    expect(verify).toHaveBeenCalledWith('u-owner1', true);
    await click(byText('button', /Reveal full account number/, host));
    expect(reveal).not.toHaveBeenCalled();
    await click(byText('button', 'Reveal and log it', document.body));
    await flush();
    expect(document.body.textContent).toContain('50100234567890');
    await click(byText('button', 'Close and hide', document.body));
    expect(document.body.textContent).not.toContain('50100234567890');
    await click(host.querySelector('button[aria-label="Edit payout details of Sharma Dhaba"]'));
    await type(host.querySelector('input[inputmode="numeric"]'), '123456789');
    await click(byText('button', 'Save payout details', host));
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('encryption is not configured');
  });
});
