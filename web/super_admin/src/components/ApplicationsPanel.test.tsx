// @vitest-environment jsdom
// Applications tab after the reason dialog and the password dialog were extracted into the shared components.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ApplicationsPanel } from './ApplicationsPanel';
import { ApiError, apiService } from '../services/api';
import { Application } from '../types';
import { parseOutcome } from '../lib/accountParse';
import { byId, byText, click, dialogs, flush, mount, topDialog, type, unmount } from '../test/dom';
import { rawCancelled, rawFoodWithRider, rawHasActiveDelivery, rawVendorHasOpenOrders } from '../test/adminFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const apiErr = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);
const outcome = (raw: Record<string, unknown> = {}) => parseOutcome({ changed: true, ...raw });

const vendorApp = (over: Partial<Application> = {}): Application => ({
  id: 'ven-1', kind: 'VENDOR', userId: 'u-v1', name: 'Owner One', phone: '+91 9876500001', status: 'APPROVED', rejectionReason: null, selfSignup: true,
  appliedAt: '2026-10-01T08:00:00.000Z', reviewedAt: null, createdAt: '2026-10-01T08:00:00.000Z',
  vendor: { name: 'Sharma Dhaba', category: 'North Indian', address: 'Ashta road', fssaiNumber: null, isAcceptingOrders: true, lat: 23.07, lng: 76.85, hasLocation: true }, ...over,
});
const driverApp = (over: Partial<Application> = {}): Application => ({
  id: 'drv-1', kind: 'DRIVER', userId: 'u-d1', name: 'Ravi', phone: '+91 9000000001', status: 'APPROVED', rejectionReason: null, selfSignup: false,
  appliedAt: '2026-10-01T08:00:00.000Z', reviewedAt: null, createdAt: '2026-10-01T08:00:00.000Z', driver: { runnerCode: 'R1', vehicleType: 'Bike', vehicleRegNo: 'MP04', emergencyPhone: null, upiId: null }, ...over,
});

const setup = async (apps: Application[]) => {
  const fetchApps = vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 0, APPROVED: apps.length, REJECTED: 0, SUSPENDED: 0 }, data: apps });
  const onChanged = vi.fn();
  const onAuthError = vi.fn();
  await mount(<ApplicationsPanel refreshKey={0} onChanged={onChanged} onAuthError={onAuthError} />);
  await flush();
  await click(byText('button', /^Approved/, document.querySelector('[aria-label="Filter by decision"]')!));
  await flush();
  return { fetchApps, onChanged, onAuthError };
};
const modalBtn = (label: RegExp | string) => byText('button', label, topDialog()!) as HTMLButtonElement;

describe('suspend with the shared reason dialog', () => {
  it('a restaurant: reason, then the status route; running orders give the explicit cancel choice and CANCEL is sent only after it', async () => {
    const { onChanged, fetchApps } = await setup([vendorApp()]);
    const decide = vi.spyOn(apiService, 'decidePartner').mockRejectedValueOnce(apiErr(409, rawVendorHasOpenOrders())).mockResolvedValueOnce({ application: {} as any, outcome: outcome(rawCancelled()) });
    await click(byText('button', 'Suspend'));
    expect(topDialog()!.textContent).toContain('Suspend Sharma Dhaba?');
    await click(byText('button', 'Customer complaints', topDialog()!));
    fetchApps.mockClear();
    await click(modalBtn('Suspend'));
    await flush();
    expect(decide).toHaveBeenCalledWith('VENDOR', 'ven-1', 'SUSPENDED', 'Customer complaints', {});
    expect(topDialog()!.textContent).toContain('Nothing was changed.');
    expect(topDialog()!.textContent).toContain('This restaurant has 1 order(s) in progress');
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Cancel the orders and refund, then suspend'));
    await flush();
    expect(decide).toHaveBeenLastCalledWith('VENDOR', 'ven-1', 'SUSPENDED', 'Customer complaints', { openOrders: 'CANCEL' });
    expect(topDialog()!.textContent).toContain('Cancelled (1)');
    expect(onChanged).toHaveBeenCalled();
    expect(fetchApps).toHaveBeenCalled(); // the list reloads
  });

  it('a rider: HAS_ACTIVE_DELIVERY offers handing the deliveries back; FOOD_WITH_RIDER has no choice', async () => {
    await setup([driverApp()]);
    const decide = vi.spyOn(apiService, 'decidePartner').mockRejectedValueOnce(apiErr(409, rawHasActiveDelivery())).mockResolvedValueOnce({ application: {} as any, outcome: outcome({ released: ['ord-active-1'] }) });
    await click(byText('button', 'Suspend'));
    await type(byId('rd-reason'), 'No-shows on orders');
    await click(modalBtn('Suspend'));
    await flush();
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Hand the deliveries back, then suspend'));
    await flush();
    expect(decide).toHaveBeenLastCalledWith('DRIVER', 'drv-1', 'SUSPENDED', 'No-shows on orders', { handover: 'RELEASE' });
    expect(topDialog()!.textContent).toContain('Handed back to the pool (1)');
    await unmount();

    await setup([driverApp()]);
    vi.spyOn(apiService, 'decidePartner').mockRejectedValue(apiErr(409, rawFoodWithRider()));
    await click(byText('button', 'Suspend'));
    await type(byId('rd-reason'), 'No-shows on orders');
    await click(modalBtn('Suspend'));
    await flush();
    expect(topDialog()!.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(topDialog()!.textContent).toContain('carrying food right now');
  });

  it('a plain failure keeps the dialog open with the server message and tells the app', async () => {
    const { onAuthError } = await setup([vendorApp()]);
    vi.spyOn(apiService, 'decidePartner').mockRejectedValue(apiErr(429, { code: 'RATE_LIMITED', message: 'Too many admin changes in a short time. Try again in a few minutes.' }));
    await click(byText('button', 'Suspend'));
    await type(byId('rd-reason'), 'Documents expired');
    await click(modalBtn('Suspend'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toContain('Too many admin changes');
    expect(onAuthError).toHaveBeenCalled();
  });

  it('reject uses the same dialog but never shows the order panel', async () => {
    const pending = vendorApp({ status: 'PENDING' });
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 1, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 }, data: [pending] });
    await mount(<ApplicationsPanel refreshKey={0} onChanged={() => {}} onAuthError={() => {}} />);
    await flush();
    const decide = vi.spyOn(apiService, 'decidePartner').mockResolvedValue({ application: {} as any, outcome: outcome() });
    await click(byText('button', 'Reject'));
    expect(topDialog()!.textContent).toContain('Reject application');
    await click(byText('button', 'Details incomplete', topDialog()!));
    await click(modalBtn('Reject'));
    await flush();
    expect(decide).toHaveBeenCalledWith('VENDOR', 'ven-1', 'REJECTED', 'Details incomplete', {});
    expect(dialogs()).toHaveLength(0);
  });

  it('approve is still one click', async () => {
    const pending = driverApp({ status: 'PENDING' });
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 1, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 }, data: [pending] });
    await mount(<ApplicationsPanel refreshKey={0} onChanged={() => {}} onAuthError={() => {}} />);
    await flush();
    const decide = vi.spyOn(apiService, 'decidePartner').mockResolvedValue({ application: {} as any, outcome: outcome() });
    await click(byText('button', 'Approve'));
    await flush();
    expect(decide).toHaveBeenCalledWith('DRIVER', 'drv-1', 'APPROVED', undefined, {});
    expect(document.body.textContent).toContain('Approved');
  });

  it('a removed rider or restaurant cannot be reactivated from here (and a removed rider has no password to reset): the card says where to restore it', async () => {
    await setup([driverApp({ status: 'SUSPENDED', accountStatus: 'REMOVED' }), vendorApp({ id: 'ven-2', status: 'SUSPENDED', removedAt: '2026-10-29T05:00:00.000Z' })]);
    expect(byText('button', 'Reactivate')).toBeUndefined();
    const cards = Array.from(document.querySelectorAll('article'));
    const riderCard = cards.find((c) => c.textContent!.includes('Ravi'))!;
    expect(byText('button', 'Reset password', riderCard)).toBeUndefined();
    expect(document.body.textContent).toContain('This rider was removed by an admin. Restore it from the Drivers tab first.');
    expect(document.body.textContent).toContain('This restaurant was removed by an admin. Restore it from the Vendors tab first.');
  });
});

describe('reset password (drawer form, then the shared credential dialog)', () => {
  it('sets the password, then shows it once in the credential dialog; it is gone after Done', async () => {
    await setup([driverApp()]);
    const reset = vi.spyOn(apiService, 'resetPartnerPassword').mockResolvedValue(undefined);
    await click(byText('button', 'Reset password'));
    const input = byId('new-pass') as HTMLInputElement;
    expect(input.value.length).toBeGreaterThanOrEqual(8);
    await type(input, 'Typed-Pass-77');
    await click(byText('button', 'Set new password'));
    await flush();
    expect(reset).toHaveBeenCalledWith('u-d1', 'Typed-Pass-77');
    const d = topDialog()!;
    expect(d.textContent).toContain('This password is shown only once.');
    expect(d.querySelector('[data-testid="shown-password"]')!.textContent).toBe('Typed-Pass-77');
    expect(d.textContent).toContain('+91 9000000001');
    expect(document.querySelector('#new-pass')).toBeNull(); // the form (and its copy of the password) is gone
    await click(d.querySelector('input[type="checkbox"]'));
    await click(byText('button', 'Done', d));
    expect(document.body.innerHTML).not.toContain('Typed-Pass-77');
  });

  it('a short password is refused; a server failure keeps the form open and shows no password', async () => {
    await setup([vendorApp()]);
    const reset = vi.spyOn(apiService, 'resetPartnerPassword').mockRejectedValue(apiErr(404, { message: 'User not found.' }));
    await click(byText('button', 'Reset password'));
    await type(byId('new-pass'), 'short');
    await click(byText('button', 'Set new password'));
    expect(document.body.textContent).toContain('At least 8 characters.');
    expect(reset).not.toHaveBeenCalled();
    await type(byId('new-pass'), 'long-enough-1');
    await click(byText('button', 'Set new password'));
    await flush();
    expect(document.body.textContent).toContain('User not found.');
    expect(document.querySelector('[data-testid="shown-password"]')).toBeNull();
  });
});
