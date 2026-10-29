// @vitest-environment jsdom
// Restaurants: the "No owner" chip and filter, the open switch for ownerless ones, suspend / reinstate / remove / restore with the impact summary, and the Removed list.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { VendorManager } from './VendorManager';
import { ApiError, apiService } from '../services/api';
import { normalizeVendor, Vendor } from '../types';
import { parseOutcome, parseVendorImpact } from '../lib/accountParse';
import { byId, byText, click, dialogs, flush, mount, topDialog, type, unmount } from '../test/dom';
import { rawAdminVendor, rawCancelled, rawNoOwner, rawOpenOrder, rawOwnerlessVendor, rawRemovedVendor, rawVendorHasOpenOrders, rawVendorImpact } from '../test/adminFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const apiErr = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);
const vendor = (raw: Record<string, unknown> = rawAdminVendor()): Vendor => normalizeVendor(raw);
const impact = (over: Record<string, unknown> = {}) => parseVendorImpact(rawVendorImpact(over).data)!;
const outcome = (raw: Record<string, unknown> = {}) => parseOutcome({ changed: true, ...raw });

const setup = async (vendors: Vendor[] = [vendor()], impactValue = impact(), props: Record<string, unknown> = {}) => {
  const fetchImpact = vi.spyOn(apiService, 'fetchVendorImpact').mockResolvedValue(impactValue);
  const onToggleVendor = vi.fn();
  const onVendorChanged = vi.fn();
  const onAuthError = vi.fn();
  const onOpenOrder = vi.fn();
  await mount(<VendorManager vendors={vendors} onToggleVendor={onToggleVendor} onVendorChanged={onVendorChanged} onAuthError={onAuthError} onOpenOrder={onOpenOrder} {...(props as any)} />);
  return { fetchImpact, onToggleVendor, onVendorChanged, onAuthError, onOpenOrder };
};
const card = (name: string) => Array.from(document.querySelectorAll('article')).find((a) => a.querySelector('h3')?.textContent === name) as HTMLElement;
const sw = (name: string) => card(name).querySelector('[role="switch"]') as HTMLButtonElement;
const modalBtn = (label: RegExp | string) => byText('button', label, topDialog()!) as HTMLButtonElement;

describe('owner state on the card', () => {
  it('a restaurant with owner === null shows the amber "No owner" chip and the short explanation', async () => {
    await setup([vendor(), vendor(rawOwnerlessVendor())]);
    const c = card('Imported Biryani House');
    expect(byText('span', 'No owner', c)!.className).toContain('text-kraveo-status-placed');
    expect(c.textContent).toContain('Customers can see this restaurant but cannot order until an owner login exists.');
    expect(card('Sharma Dhaba').textContent).not.toContain('No owner');
    expect(card('Sharma Dhaba').textContent).toContain('Owner: Owner2 Kitchen · +91 9777620002');
  });

  it('the card has a direct "Add an owner login" button that opens the Edit drawer on the Owner login section', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([]);
    await setup([vendor(rawOwnerlessVendor())]);
    await click(card('Imported Biryani House').querySelector('button[aria-label="Add an owner login for Imported Biryani House"]'));
    await flush();
    const drawer = document.querySelector('[role="dialog"]')!;
    expect(drawer.textContent).toContain('Edit Imported Biryani House');
    expect(drawer.querySelector('section[aria-label="Owner login"]')!.textContent).toContain('Create or attach an owner login');
  });

  it('an older server that does not send `owner` claims nothing (no chip, switch usable)', async () => {
    const raw = rawAdminVendor(); delete (raw as any).owner;
    await setup([vendor(raw)]);
    expect(card('Sharma Dhaba').textContent).not.toContain('No owner');
    expect(vendor(raw).owner).toBeUndefined();
    expect(vendor(rawOwnerlessVendor()).owner).toBeNull();
  });

  it('the open switch of a closed ownerless restaurant is disabled, with a tooltip and a visible hint tied to the switch', async () => {
    const { onToggleVendor } = await setup([vendor(rawOwnerlessVendor())]);
    const s = sw('Imported Biryani House');
    expect(s.disabled).toBe(true);
    expect(s.title).toBe('Add an owner login first, then it can be opened.');
    expect(document.getElementById(s.getAttribute('aria-describedby')!)!.textContent).toBe('Add an owner login first, then it can be opened.');
    await click(s);
    expect(onToggleVendor).not.toHaveBeenCalled();
  });

  it('closing an ownerless restaurant that is open still works; a restaurant with an owner opens normally', async () => {
    const { onToggleVendor } = await setup([vendor(rawOwnerlessVendor({ isAcceptingOrders: true })), vendor(rawAdminVendor({ id: 'ven-9', name: 'Open Kitchen', isAcceptingOrders: false }))]);
    expect(sw('Imported Biryani House').disabled).toBe(false);
    await click(sw('Imported Biryani House'));
    expect(onToggleVendor).toHaveBeenCalledWith('ven-2');
    expect(sw('Open Kitchen').disabled).toBe(false);
    expect(sw('Open Kitchen').title).toBe('');
  });

  it('a disabled owner login is shown on the card', async () => {
    await setup([vendor(rawAdminVendor({ owner: { id: 'u', name: 'Paused Owner', phone: '+91 9000000009', accountStatus: 'SUSPENDED', statusReason: 'Paused', lastLoginAt: null } }))]);
    expect(card('Sharma Dhaba').textContent).toContain('Login disabled');
  });

  it('the No owner filter appears with a count, and narrows the list', async () => {
    await setup([vendor(), vendor(rawOwnerlessVendor())]);
    const group = document.querySelector('[role="group"][aria-label="Filter vendors"]')!;
    const chip = byText('button', /^No owner/, group)!;
    expect(chip.textContent).toContain('1');
    await click(chip);
    expect(document.querySelectorAll('article')).toHaveLength(1);
    expect(card('Imported Biryani House')).toBeDefined();
  });
});

describe('suspend / reinstate', () => {
  it('suspend: shows the impact, needs a reason, sends it without openOrders, and hands the fresh vendor up', async () => {
    const { fetchImpact, onVendorChanged } = await setup([vendor()], impact({ unpaidSettlements: { count: 0, amount: 0 } }));
    const fresh = vendor(rawAdminVendor({ approvalStatus: 'SUSPENDED', isAcceptingOrders: false }));
    const block = vi.spyOn(apiService, 'blockVendor').mockResolvedValue({ vendor: fresh, outcome: outcome(), ownerDisabled: false });
    await click(card('Sharma Dhaba').querySelector('button[aria-label="Suspend Sharma Dhaba"]'));
    await flush();
    expect(fetchImpact).toHaveBeenCalledWith('ven-1');
    const d = topDialog()!;
    expect(d.textContent).toContain('Suspend Sharma Dhaba?');
    expect(d.querySelector('ul[aria-label="What this affects"]')!.textContent).toContain('No orders are in progress.');
    expect(modalBtn('Suspend restaurant').disabled).toBe(true);
    await type(byId('rd-reason'), 'Customer complaints');
    await click(modalBtn('Suspend restaurant'));
    await flush();
    expect(block).toHaveBeenCalledWith('ven-1', 'suspend', { reason: 'Customer complaints' });
    expect(onVendorChanged).toHaveBeenCalledWith(fresh);
    expect(dialogs().filter((x) => x.textContent!.includes('Suspend Sharma Dhaba?'))).toHaveLength(0);
  });

  it('running orders: the list and the explicit cancel choice (combined orders are explained); CANCEL only after choosing; cancelled and failed are shown', async () => {
    await setup([vendor()], impact({ openOrders: [rawOpenOrder(), rawOpenOrder({ id: 'ord-two-222222', groupId: 'g1' })] }));
    const block = vi.spyOn(apiService, 'blockVendor').mockResolvedValue({ vendor: vendor(rawAdminVendor({ approvalStatus: 'SUSPENDED' })), outcome: outcome({ ...rawCancelled(), failed: [{ orderId: 'ord-two-222222', code: 'X', message: 'Could not cancel.' }] }), ownerDisabled: false });
    await click(card('Sharma Dhaba').querySelector('button[aria-label="Suspend Sharma Dhaba"]'));
    await flush();
    const d = topDialog()!;
    expect(d.textContent).toContain('This restaurant has 2 orders in progress.');
    await type(byId('rd-reason'), 'Customer complaints');
    expect(modalBtn('Suspend restaurant').disabled).toBe(true);
    await click(d.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    expect(d.textContent).toContain("including the other restaurants' parts");
    await click(modalBtn('Cancel the orders and refund, then suspend'));
    await flush();
    expect(block).toHaveBeenCalledWith('ven-1', 'suspend', { reason: 'Customer complaints', openOrders: 'CANCEL' });
    expect(topDialog()!.textContent).toContain('Cancelled (1)');
    expect(topDialog()!.textContent).toContain('Could not cancel.');
  });

  it('an order with a rider: wait only. A 409 from the server for orders the impact missed becomes the same panel', async () => {
    await setup([vendor()], impact({ openOrders: [rawOpenOrder({ status: 'PICKED_UP' })], inDelivery: [rawOpenOrder({ status: 'PICKED_UP' })] }));
    await click(card('Sharma Dhaba').querySelector('button[aria-label="Suspend Sharma Dhaba"]'));
    await flush();
    expect(topDialog()!.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(topDialog()!.textContent).toContain('An order is with a rider right now');
    await unmount();

    await setup([vendor()]);
    vi.spyOn(apiService, 'blockVendor').mockRejectedValue(apiErr(409, rawVendorHasOpenOrders()));
    await click(card('Sharma Dhaba').querySelector('button[aria-label="Suspend Sharma Dhaba"]'));
    await flush();
    await type(byId('rd-reason'), 'Customer complaints');
    await click(modalBtn('Suspend restaurant'));
    await flush();
    expect(topDialog()!.textContent).toContain('This restaurant has 1 order(s) in progress');
    expect(topDialog()!.querySelectorAll('input[type="radio"]')).toHaveLength(2);
  });

  it('a suspended restaurant offers Reinstate (stays closed) instead of Suspend', async () => {
    const { onVendorChanged } = await setup([vendor(rawAdminVendor({ approvalStatus: 'SUSPENDED', isAcceptingOrders: false }))]);
    expect(card('Sharma Dhaba').querySelector('button[aria-label="Suspend Sharma Dhaba"]')).toBeNull();
    const fresh = vendor(rawAdminVendor());
    const revive = vi.spyOn(apiService, 'reviveVendor').mockResolvedValue({ vendor: fresh, outcome: outcome({ warning: 'Stays closed.' }), ownerRestored: false });
    await click(card('Sharma Dhaba').querySelector('button[aria-label="Reinstate Sharma Dhaba"]'));
    expect(topDialog()!.textContent).toContain('It stays closed: the owner opens it from the app.');
    await click(modalBtn('Reinstate'));
    await flush();
    expect(revive).toHaveBeenCalledWith('ven-1', 'reinstate');
    expect(onVendorChanged).toHaveBeenCalledWith(fresh);
  });
});

describe('remove / restore', () => {
  const openRemove = async (impactValue = impact({ unpaidSettlements: { count: 2, amount: 1840.5 } }), v = vendor()) => {
    const ctx = await setup([v], impactValue);
    await click(card(v.name).querySelector(`button[aria-label="Remove ${v.name}"]`));
    await flush();
    return ctx;
  };

  it('shows the settlements that stay, offers to disable the owner login (on by default), and needs the restaurant name', async () => {
    await openRemove();
    const d = topDialog()!;
    expect(d.textContent).toContain('Customers will no longer see it. Its dishes, orders and unpaid settlements stay for the books.');
    expect(d.textContent).toContain('2 unpaid settlements worth ₹1,841 stay in Finance.');
    const own = d.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(own.checked).toBe(true);
    expect(d.textContent).toContain('Also disable the owner login');
    expect(modalBtn('Remove restaurant').disabled).toBe(true);
    await type(byId('rd-reason'), 'Closed for good');
    await type(byId('rd-name'), 'Sharma Dhaba');
    expect(modalBtn('Remove restaurant').disabled).toBe(false);
  });

  it('sends disableOwner true by default and false when unticked; the typed name is sent', async () => {
    const { onVendorChanged } = await openRemove();
    const block = vi.spyOn(apiService, 'blockVendor').mockResolvedValue({ vendor: vendor(rawRemovedVendor({ id: 'ven-1', name: 'Sharma Dhaba' })), outcome: outcome(), ownerDisabled: true });
    await type(byId('rd-reason'), 'Closed for good');
    await type(byId('rd-name'), 'sharma dhaba');
    await click(topDialog()!.querySelector('input[type="checkbox"]'));
    await click(modalBtn('Remove restaurant'));
    await flush();
    expect(block).toHaveBeenCalledWith('ven-1', 'remove', { reason: 'Closed for good', confirmName: 'sharma dhaba', disableOwner: false });
    expect(onVendorChanged).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Sharma Dhaba is removed.');
  });

  it('an ownerless restaurant has no owner checkbox and still sends disableOwner true (nothing to disable)', async () => {
    const v = vendor(rawOwnerlessVendor());
    await openRemove(impact({ vendorId: 'ven-2', hasOwner: false }), v);
    expect(topDialog()!.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const block = vi.spyOn(apiService, 'blockVendor').mockResolvedValue({ vendor: vendor(rawRemovedVendor()), outcome: outcome(), ownerDisabled: false });
    await type(byId('rd-reason'), 'Duplicate listing');
    await type(byId('rd-name'), v.name);
    await click(modalBtn('Remove restaurant'));
    await flush();
    expect(block).toHaveBeenCalledWith('ven-2', 'remove', expect.objectContaining({ disableOwner: true }));
  });

  it('the Removed filter lists removed restaurants (fetched when chosen), shows the reason and offers Restore only', async () => {
    const fetchRemoved = vi.spyOn(apiService, 'fetchRemovedVendors').mockResolvedValue([vendor(rawRemovedVendor())]);
    const { onVendorChanged } = await setup([vendor()]);
    await click(byText('button', 'Removed', document.querySelector('[aria-label="Filter vendors"]')!));
    await flush();
    expect(fetchRemoved).toHaveBeenCalledTimes(1);
    const c = card('Closed Canteen');
    expect(c.textContent).toContain('Removed: Closed for good');
    expect(c.querySelector('[role="switch"]')).toBeNull();
    expect(Array.from(c.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Restore restaurant']);
    const revive = vi.spyOn(apiService, 'reviveVendor').mockResolvedValue({ vendor: vendor(rawAdminVendor({ id: 'ven-3', name: 'Closed Canteen', approvalStatus: 'SUSPENDED' })), outcome: outcome(), ownerRestored: true });
    await click(c.querySelector('button'));
    expect(topDialog()!.textContent).toContain('comes back from removal');
    await click(modalBtn('Restore restaurant'));
    await flush();
    expect(revive).toHaveBeenCalledWith('ven-3', 'restore');
    expect(onVendorChanged).toHaveBeenCalled();
    expect(fetchRemoved).toHaveBeenCalledTimes(2); // the list is reloaded
    expect(document.body.textContent).toContain('its owner login works again');
  });

  it('empty and error states of the Removed list', async () => {
    const fetchRemoved = vi.spyOn(apiService, 'fetchRemovedVendors').mockResolvedValueOnce([]).mockRejectedValueOnce(apiErr(500, { message: 'Boom from server.' })).mockResolvedValue([]);
    await setup([vendor()]);
    const filters = document.querySelector('[aria-label="Filter vendors"]')!;
    await click(byText('button', 'Removed', filters));
    await flush();
    expect(document.body.textContent).toContain('No restaurant has been removed.');
    await click(byText('button', /^All/, filters));
    await click(byText('button', 'Removed', filters));
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Boom from server.');
    await click(byText('button', 'Try again'));
    await flush();
    expect(fetchRemoved).toHaveBeenCalledTimes(3);
  });
});

describe('opening an ownerless restaurant (server side refusal)', () => {
  it('the toggle API error carries the server message (App shows it as a toast)', async () => {
    vi.spyOn(apiService, 'toggleVendorStatus').mockRejectedValue(apiErr(409, rawNoOwner()));
    const e = await apiService.toggleVendorStatus('ven-2', true).catch((x) => x);
    expect(e.message).toBe('Add an owner login first.');
    expect(e.code).toBe('NO_OWNER');
  });
});
