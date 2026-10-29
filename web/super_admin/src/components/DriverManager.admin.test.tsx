// @vitest-environment jsdom
// Riders: remove / restore / suspend / reactivate / reset password (Docs/27 B2, Docs/28 section 3).
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { DriverManager } from './DriverManager';
import { ApiError, apiService } from '../services/api';
import { normalizeDriver } from '../types';
import { parseOutcome, parseRiderImpact } from '../lib/accountParse';
import { byId, byText, click, dialogs, flush, mount, topDialog, type, unmount } from '../test/dom';
import { GENERATED, rawDriverRow, rawFoodWithRider, rawHasActiveDelivery, rawRateLimited, rawRiderImpact } from '../test/adminFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const apiErr = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);
const rider = (over: Record<string, unknown> = {}) => normalizeDriver(rawDriverRow(over));
const removedRider = () => rider({ approvalStatus: 'SUSPENDED', user: { ...rawDriverRow().user, accountStatus: 'REMOVED' } });
const impact = (over: Record<string, unknown> = {}) => parseRiderImpact(rawRiderImpact(over).data)!;
const outcome = (raw: Record<string, unknown> = {}) => parseOutcome({ changed: true, ...raw });

const setup = async (drivers = [rider()], impactValue = impact()) => {
  const fetchImpact = vi.spyOn(apiService, 'fetchRiderImpact').mockResolvedValue(impactValue);
  const onChanged = vi.fn();
  const onAuthError = vi.fn();
  const onOpenOrder = vi.fn();
  await mount(<DriverManager drivers={drivers} onChanged={onChanged} onAuthError={onAuthError} onOpenOrder={onOpenOrder} />);
  return { fetchImpact, onChanged, onAuthError, onOpenOrder };
};
const openDrawer = async (name = 'Ravi') => { await click(document.querySelector(`[aria-label="Open details for ${name}"]`)); await flush(); };
const drawer = () => document.querySelector('[role="dialog"]') as HTMLElement;
const footerLabels = () => Array.from(drawer().querySelectorAll('footer button')).map((b) => b.textContent);
const modalBtn = (label: RegExp | string) => byText('button', label, topDialog()!) as HTMLButtonElement;

describe('rider list and drawer', () => {
  it('normalizes the account state and last sign-in from the user block (unknown on an older server)', () => {
    expect(rider().accountStatus).toBe('ACTIVE');
    expect(rider().lastLoginAt).toBe('2026-10-28T17:30:00.000Z');
    expect(normalizeDriver({ id: 'x', name: 'Old' }).accountStatus).toBeUndefined();
  });

  it('active approved rider: Suspend, Reset password, Remove, Close', async () => {
    await setup();
    await openDrawer();
    expect(footerLabels()).toEqual(['Suspend', 'Reset password', 'Remove', 'Close']);
  });

  it('a suspended rider can be reactivated; a removed rider only restored; both show it', async () => {
    await setup([rider({ approvalStatus: 'SUSPENDED' }), { ...removedRider(), id: 'drv-2', name: 'Gone Rider' }]);
    await openDrawer('Ravi');
    expect(footerLabels()).toEqual(['Reactivate', 'Reset password', 'Remove', 'Close']);
    await click(byText('button', 'Close', drawer()));
    await openDrawer('Gone Rider');
    expect(footerLabels()).toEqual(['Restore', 'Close']);
    expect(drawer().textContent).toContain('This rider was removed. They cannot sign in.');
    expect(drawer().textContent).toContain('their phone number stays reserved');
  });

  it('removed riders show a Removed pill, and the Removed filter appears only when there is one', async () => {
    await setup([rider(), { ...removedRider(), id: 'drv-2', name: 'Gone Rider' }]);
    const group = document.querySelector('[role="group"][aria-label="Filter by duty status"]')!;
    expect(byText('button', /^Removed/, group)).toBeDefined();
    await click(byText('button', /^Removed/, group));
    expect(document.querySelector('[aria-label="Open details for Ravi"]')).toBeNull();
    expect(document.querySelector('[aria-label="Open details for Gone Rider"]')!.textContent).toContain('Removed');
  });

  it('no Removed filter when nobody was removed', async () => {
    await setup();
    expect(byText('button', /^Removed/, document.querySelector('[aria-label="Filter by duty status"]')!)).toBeUndefined();
  });
});

describe('remove', () => {
  it('wording, payout hint, type-the-name; sends the reason and the name and refreshes the list', async () => {
    const { onChanged, fetchImpact } = await setup();
    const remove = vi.spyOn(apiService, 'removeRider').mockResolvedValue({ outcome: outcome() });
    await openDrawer();
    await click(byText('button', 'Remove', drawer()));
    await flush();
    expect(fetchImpact).toHaveBeenCalledWith('drv-1');
    const d = topDialog()!;
    expect(d.textContent).toContain('Remove Ravi as a rider?');
    expect(d.textContent).toContain('They are signed out and cannot work again unless you restore them. Past deliveries and payout records stay. Their phone number stays reserved.');
    expect(d.textContent).toContain('Record any payout you owe Ravi first');
    expect(modalBtn('Remove rider').disabled).toBe(true);
    await type(byId('rd-reason'), 'Left the company');
    await type(byId('rd-name'), 'Ravi');
    await click(modalBtn('Remove rider'));
    await flush();
    expect(remove).toHaveBeenCalledWith('drv-1', { reason: 'Left the company', confirmName: 'Ravi' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(dialogs().filter((x) => x.textContent!.includes('Remove Ravi as a rider?'))).toHaveLength(0);
  });

  it('a delivery in hand is known from the impact answer: the list, and the explicit "hand back to the pool" choice; RELEASE is sent only after choosing it', async () => {
    await setup([rider()], impact({ activeDeliveries: [{ id: 'ord-active-1', status: 'ACCEPTED' }] }));
    const remove = vi.spyOn(apiService, 'removeRider').mockResolvedValue({ outcome: outcome({ released: ['ord-active-1'] }) });
    await openDrawer();
    await click(byText('button', 'Remove', drawer()));
    await flush();
    const d = topDialog()!;
    expect(d.textContent).toContain('Ravi has 1 delivery in hand');
    await type(byId('rd-reason'), 'Left the company');
    await type(byId('rd-name'), 'Ravi');
    expect(modalBtn('Remove rider').disabled).toBe(true);
    await click(d.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Hand the deliveries back, then remove'));
    await flush();
    expect(remove).toHaveBeenCalledWith('drv-1', { reason: 'Left the company', confirmName: 'Ravi', handover: 'RELEASE' });
    expect(topDialog()!.textContent).toContain('Handed back to the pool (1)');
  });

  it('food already with the rider: no choice, only the wait text (impact says so before sending)', async () => {
    await setup([rider()], impact({ activeDeliveries: [{ id: 'ord-picked-1', status: 'PICKED_UP' }], foodWithRider: [{ id: 'ord-picked-1', status: 'PICKED_UP' }] }));
    const remove = vi.spyOn(apiService, 'removeRider');
    await openDrawer();
    await click(byText('button', 'Remove', drawer()));
    await flush();
    const d = topDialog()!;
    expect(d.textContent).toContain('Ravi is carrying food right now.');
    expect(d.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    await type(byId('rd-reason'), 'Left the company');
    await type(byId('rd-name'), 'Ravi');
    expect(modalBtn('Remove rider').disabled).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it('the server can still answer 409 (a delivery was taken meanwhile): HAS_ACTIVE_DELIVERY turns into the choice, FOOD_WITH_RIDER into the wait', async () => {
    await setup();
    const remove = vi.spyOn(apiService, 'removeRider').mockRejectedValueOnce(apiErr(409, rawHasActiveDelivery())).mockResolvedValueOnce({ outcome: outcome({ released: ['ord-active-1'] }) });
    await openDrawer();
    await click(byText('button', 'Remove', drawer()));
    await flush();
    await type(byId('rd-reason'), 'Left the company');
    await type(byId('rd-name'), 'Ravi');
    await click(modalBtn('Remove rider'));
    await flush();
    expect(topDialog()!.textContent).toContain('Nothing was changed.');
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Hand the deliveries back, then remove'));
    await flush();
    expect(remove.mock.calls[1][1]).toMatchObject({ handover: 'RELEASE' });
    await unmount();

    await setup();
    vi.spyOn(apiService, 'removeRider').mockRejectedValue(apiErr(409, rawFoodWithRider()));
    await openDrawer();
    await click(byText('button', 'Remove', drawer()));
    await flush();
    await type(byId('rd-reason'), 'Left the company');
    await type(byId('rd-name'), 'Ravi');
    await click(modalBtn('Remove rider'));
    await flush();
    expect(topDialog()!.textContent).toContain('carrying food right now');
    expect(topDialog()!.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });

  it('a failed impact look-up does not block: the dialog says so and the server checks again; 429 shows the server text', async () => {
    const fetchImpact = vi.spyOn(apiService, 'fetchRiderImpact').mockRejectedValue(apiErr(500, { message: 'x' }));
    await mount(<DriverManager drivers={[rider()]} onChanged={() => {}} onAuthError={() => {}} />);
    vi.spyOn(apiService, 'removeRider').mockRejectedValue(apiErr(429, rawRateLimited()));
    await openDrawer();
    await click(byText('button', 'Remove', drawer()));
    await flush();
    expect(fetchImpact).toHaveBeenCalled();
    expect(topDialog()!.textContent).toContain("Could not check the rider's deliveries first.");
    await type(byId('rd-reason'), 'Left the company');
    await type(byId('rd-name'), 'Ravi');
    await click(modalBtn('Remove rider'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toContain('Too many admin changes');
  });

  it('while the delivery check runs the confirm button waits', async () => {
    vi.spyOn(apiService, 'fetchRiderImpact').mockImplementation(() => new Promise(() => {}));
    await mount(<DriverManager drivers={[rider()]} />);
    await openDrawer();
    await click(byText('button', 'Remove', drawer()));
    await flush();
    await type(byId('rd-reason'), 'Left the company');
    await type(byId('rd-name'), 'Ravi');
    expect(topDialog()!.textContent).toContain("Checking the rider's deliveries");
    expect(modalBtn('Remove rider').disabled).toBe(true);
  });
});

describe('suspend, reactivate, restore', () => {
  it('suspend goes through the status route with the reason; running deliveries give the same choice, RELEASE only when chosen', async () => {
    const { onChanged } = await setup([rider()], impact({ activeDeliveries: [{ id: 'ord-active-1', status: 'ACCEPTED' }] }));
    const decide = vi.spyOn(apiService, 'decidePartner').mockResolvedValue({ application: {} as any, outcome: outcome({ released: ['ord-active-1'] }) });
    await openDrawer();
    await click(byText('button', 'Suspend', drawer()));
    await flush();
    await type(byId('rd-reason'), 'No-shows on orders');
    expect(modalBtn('Suspend').disabled).toBe(true);
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Hand the deliveries back, then suspend'));
    await flush();
    expect(decide).toHaveBeenCalledWith('DRIVER', 'drv-1', 'SUSPENDED', 'No-shows on orders', { handover: 'RELEASE' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('suspend with nothing running sends no handover', async () => {
    await setup();
    const decide = vi.spyOn(apiService, 'decidePartner').mockResolvedValue({ application: {} as any, outcome: outcome() });
    await openDrawer();
    await click(byText('button', 'Suspend', drawer()));
    await flush();
    await type(byId('rd-reason'), 'Customer complaints');
    await click(modalBtn('Suspend'));
    await flush();
    expect(decide).toHaveBeenCalledWith('DRIVER', 'drv-1', 'SUSPENDED', 'Customer complaints', {});
  });

  it('reactivate is one click with a toast and a refresh; a failure shows the server text', async () => {
    const { onChanged } = await setup([rider({ approvalStatus: 'SUSPENDED' })]);
    const decide = vi.spyOn(apiService, 'decidePartner').mockRejectedValueOnce(apiErr(409, { code: 'ACCOUNT_NOT_ACTIVE', message: 'This rider was removed. Restore the account first.' })).mockResolvedValueOnce({ application: {} as any, outcome: outcome() });
    await openDrawer();
    await click(byText('button', 'Reactivate', drawer()));
    await flush();
    expect(document.body.textContent).toContain('This rider was removed. Restore the account first.');
    expect(onChanged).not.toHaveBeenCalled();
    await click(byText('button', 'Reactivate', drawer()));
    await flush();
    expect(decide).toHaveBeenLastCalledWith('DRIVER', 'drv-1', 'APPROVED');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('restore: says the rider stays suspended; sends the optional note', async () => {
    const { onChanged } = await setup([removedRider()]);
    const restore = vi.spyOn(apiService, 'restoreRider').mockResolvedValue({ outcome: outcome() });
    await openDrawer();
    await click(byText('button', 'Restore', drawer()));
    expect(topDialog()!.textContent).toContain('They stay suspended until you press Reactivate');
    await click(modalBtn('Restore rider'));
    await flush();
    expect(restore).toHaveBeenCalledWith('drv-1', undefined);
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('reset password', () => {
  it('shows the new password once in the credential dialog and drops it after Done', async () => {
    await setup();
    const reset = vi.spyOn(apiService, 'resetPartnerPassword').mockResolvedValue(undefined);
    await openDrawer();
    await click(byText('button', 'Reset password', drawer()));
    expect(topDialog()!.textContent).toContain('They are signed out everywhere and the old password stops working now.');
    await click(modalBtn('Reset and show new password'));
    await flush();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0][0]).toBe('u-rider-1');
    const password = reset.mock.calls[0][1];
    expect(password.length).toBeGreaterThanOrEqual(8);
    const d = topDialog()!;
    expect(d.textContent).toContain('This password is shown only once.');
    expect(d.querySelector('[data-testid="shown-password"]')!.textContent).toBe(password);
    await click(d.querySelector('input[type="checkbox"]'));
    await click(byText('button', 'Done', d));
    expect(document.body.textContent).not.toContain(password);
    expect(GENERATED).toBeDefined();
  });

  it('a refusal keeps the dialog open with the server message and shows no password', async () => {
    await setup();
    vi.spyOn(apiService, 'resetPartnerPassword').mockRejectedValue(apiErr(404, { message: 'User not found.' }));
    await openDrawer();
    await click(byText('button', 'Reset password', drawer()));
    await click(modalBtn('Reset and show new password'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('User not found.');
    expect(topDialog()!.querySelector('[data-testid="shown-password"]')).toBeNull();
  });
});
