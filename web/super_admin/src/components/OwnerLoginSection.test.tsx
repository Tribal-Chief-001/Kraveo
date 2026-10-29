// @vitest-environment jsdom
// Owner login of a restaurant (Docs/27 B4, Docs/28 section 5): create / attach, change, reset, disable / enable, detach / remove, and the show-once password.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { OwnerLoginSection } from './OwnerLoginSection';
import { EditRestaurantDrawer } from './EditRestaurantDrawer';
import { ApiError, apiService } from '../services/api';
import { normalizeVendor, Vendor } from '../types';
import { parseOwnerResult, parseVendorImpact } from '../lib/accountParse';
import { parseCategory } from '../lib/categoryParse';
import { byId, byText, click, dialogs, flush, mount, press, topDialog, type, unmount } from '../test/dom';
import { GENERATED, rawAdminVendor, rawOpenOrder, rawOwnerCreate, rawOwnerView, rawOwnerlessVendor, rawVendorHasOpenOrders, rawVendorImpact } from '../test/adminFixtures';
import { rawCategory } from '../test/taxonomyFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const apiErr = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);
const vendor = (raw: Record<string, unknown> = rawAdminVendor()): Vendor => normalizeVendor(raw);
const result = (raw: Record<string, unknown>) => parseOwnerResult(raw);
const impact = (over: Record<string, unknown> = {}) => parseVendorImpact(rawVendorImpact(over).data)!;

const setup = async (v: Vendor = vendor(), impactValue = impact()) => {
  vi.spyOn(apiService, 'fetchVendorImpact').mockResolvedValue(impactValue);
  const onChanged = vi.fn();
  const onAuthError = vi.fn();
  await mount(<OwnerLoginSection vendor={v} onChanged={onChanged} onAuthError={onAuthError} onOpenOrder={vi.fn()} />);
  return { onChanged, onAuthError };
};
const section = () => document.querySelector('section[aria-label="Owner login"]') as HTMLElement;
const modalBtn = (label: RegExp | string) => byText('button', label, topDialog()!) as HTMLButtonElement;
const fillNewOwner = async (name = 'New Owner', phone = '98765 43299') => { await type(byId('ow-name'), name); await type(byId('ow-phone'), phone); };

describe('display', () => {
  it('with an owner: name, phone, status, last sign-in and every action', async () => {
    await setup();
    expect(section().textContent).toContain('Owner2 Kitchen');
    expect(section().textContent).toContain('+91 9777620002');
    expect(section().textContent).toContain('Login active');
    expect(section().textContent).toContain('Has not signed in yet');
    expect(Array.from(section().querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Change phone or name', 'Reset password', 'Disable login', 'Detach from restaurant', 'Remove login']);
  });
  it('without an owner: amber chip, the explanation and the create button', async () => {
    await setup(vendor(rawOwnerlessVendor()));
    expect(section().textContent).toContain('No owner');
    expect(section().textContent).toContain('Customers can see this restaurant but cannot order until an owner login exists.');
    expect(byText('button', 'Create or attach an owner login', section())).toBeDefined();
  });
  it('a disabled login offers Enable; nothing at all on an older server (owner not sent)', async () => {
    await setup(vendor(rawAdminVendor({ owner: { id: 'u', name: 'Paused', phone: '+91 9000000009', accountStatus: 'SUSPENDED', statusReason: 'Owner asked to pause', lastLoginAt: '2026-10-27T10:00:00.000Z' } })));
    expect(section().textContent).toContain('Login disabled');
    expect(section().textContent).toContain('The login is disabled: Owner asked to pause');
    expect(byText('button', 'Enable login', section())).toBeDefined();
    expect(byText('button', 'Disable login', section())).toBeUndefined();
    await unmount();
    const raw = rawAdminVendor(); delete (raw as any).owner;
    await setup(vendor(raw));
    expect(section()).toBeNull();
  });
});

describe('create: the password is shown once', () => {
  it('validates before sending, then creates with a generated password: no password key is sent, the card updates, the restaurant is reported closed', async () => {
    const { onChanged } = await setup(vendor(rawOwnerlessVendor()));
    const create = vi.spyOn(apiService, 'createOwner').mockResolvedValue(result(rawOwnerCreate()));
    await click(byText('button', 'Create or attach an owner login', section()));
    expect(topDialog()!.textContent).toContain('The restaurant stays closed until the owner signs in and opens it.');
    await click(modalBtn('Create login'));
    expect(create).not.toHaveBeenCalled();
    expect(byId('ow-name-msg')!.textContent).toContain('Enter the owner name');
    expect(byId('ow-phone-msg')!.textContent).toContain('valid 10-digit');
    await fillNewOwner();
    await click(modalBtn('Create login'));
    await flush();
    expect(create).toHaveBeenCalledWith('ven-2', { name: 'New Owner', phone: '9876543299' });
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ isAcceptingOrders: false, owner: expect.objectContaining({ id: 'zc-vown-9' }) }));
    // the credential dialog
    const d = topDialog()!;
    expect(d.textContent).toContain('This password is shown only once. Kraveo cannot show it again; you can reset it any time.');
    expect(d.querySelector('[data-testid="shown-password"]')!.textContent).toBe(GENERATED);
    expect(d.textContent).toContain('+91 9876543299');
    expect(d.textContent).toContain('Imported Biryani House stays closed until New Owner signs in and opens it.');
    // the card behind it already shows the new owner
    expect(section().textContent).toContain('New Owner');
    expect((byText('button', 'Done', d) as HTMLButtonElement).disabled).toBe(true);
    await click(d.querySelector('input[type="checkbox"]'));
    await click(byText('button', 'Done', d));
    // gone from the page, and from every later render
    expect(dialogs()).toHaveLength(0);
    expect(document.body.textContent).not.toContain(GENERATED);
    expect(document.body.innerHTML).not.toContain(GENERATED);
  });

  it('a typed password is sent, never echoed or shown, and clears with the dialog', async () => {
    await setup(vendor(rawOwnerlessVendor()));
    const create = vi.spyOn(apiService, 'createOwner').mockResolvedValue(result(rawOwnerCreate({ generatedPassword: undefined })));
    await click(byText('button', 'Create or attach an owner login', section()));
    await fillNewOwner();
    await click(topDialog()!.querySelector('input[type="checkbox"]')); // generate off
    expect(byId('ow-pass')!.getAttribute('type')).toBe('password');
    await type(byId('ow-pass'), 'short');
    await click(modalBtn('Create login'));
    expect(byId('ow-pass-msg')!.textContent).toContain('at least 8');
    expect(create).not.toHaveBeenCalled();
    await type(byId('ow-pass'), 'my-own-pass-1');
    await click(modalBtn('Create login'));
    await flush();
    expect(create).toHaveBeenCalledWith('ven-2', { name: 'New Owner', phone: '9876543299', password: 'my-own-pass-1' });
    expect(dialogs()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('my-own-pass-1');
    expect(document.body.textContent).toContain('Owner login ready');
  });

  it('PHONE_TAKEN is a field error with the plain sentence, and the dialog stays open', async () => {
    await setup(vendor(rawOwnerlessVendor()));
    vi.spyOn(apiService, 'createOwner').mockRejectedValue(apiErr(409, { code: 'PHONE_TAKEN', message: 'taken (server text)' }));
    await click(byText('button', 'Create or attach an owner login', section()));
    await fillNewOwner();
    await click(modalBtn('Create login'));
    await flush();
    expect(byId('ow-phone-msg')!.textContent).toBe('This number already belongs to another account.');
    expect(byId('ow-phone')!.getAttribute('aria-invalid')).toBe('true');
    expect(topDialog()!.textContent).toContain('Owner login for Imported Biryani House');
  });

  it('OWNER_EXISTS: the server text is shown and the card is reloaded from the server', async () => {
    const { onChanged } = await setup(vendor(rawOwnerlessVendor()));
    vi.spyOn(apiService, 'createOwner').mockRejectedValue(apiErr(409, { code: 'OWNER_EXISTS', message: 'This restaurant already has an owner login.' }));
    const fetchOwner = vi.spyOn(apiService, 'fetchOwner').mockResolvedValue({ id: 'someone', name: 'Faster Admin Owner', phone: '+91 9000000001', accountStatus: 'ACTIVE', statusReason: null, lastLoginAt: null });
    await click(byText('button', 'Create or attach an owner login', section()));
    await fillNewOwner();
    await click(modalBtn('Create login'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('This restaurant already has an owner login.');
    expect(fetchOwner).toHaveBeenCalledWith('ven-2');
    expect(onChanged).toHaveBeenCalledWith({ owner: expect.objectContaining({ name: 'Faster Admin Owner' }) });
    expect(section().textContent).toContain('Faster Admin Owner');
  });

  it('a second click while it runs sends one request; the dialog cannot be closed meanwhile', async () => {
    await setup(vendor(rawOwnerlessVendor()));
    let release: () => void = () => {};
    const create = vi.spyOn(apiService, 'createOwner').mockImplementation(() => new Promise((resolve) => { release = () => resolve(result(rawOwnerCreate())); }));
    await click(byText('button', 'Create or attach an owner login', section()));
    await fillNewOwner();
    const btn = modalBtn('Create login');
    await click(btn); await click(btn);
    expect(create).toHaveBeenCalledTimes(1);
    await press('Escape');
    expect(topDialog()!.textContent).toContain('Owner login for');
    release();
    await flush();
  });

  it('attach: the login id is required; one restaurant per login is shown plainly; payout details can be moved', async () => {
    await setup(vendor(rawOwnerlessVendor()));
    const create = vi.spyOn(apiService, 'createOwner')
      .mockRejectedValueOnce(apiErr(409, { code: 'OWNER_HAS_RESTAURANT', message: 'That owner login already runs a restaurant. One login runs one restaurant.' }))
      .mockResolvedValueOnce(result(rawOwnerCreate({ generatedPassword: undefined, payoutAccountMoved: true })));
    await click(byText('button', 'Create or attach an owner login', section()));
    await click(byText('button', 'Attach a detached login', topDialog()!));
    await click(modalBtn('Attach login'));
    expect(byId('ow-attach-msg')!.textContent).toContain('Enter the id of a detached owner login.');
    await type(byId('ow-attach'), 'u-detached-1');
    await click(modalBtn('Attach login'));
    await flush();
    expect(create).toHaveBeenCalledWith('ven-2', { existingUserId: 'u-detached-1' });
    expect(topDialog()!.textContent).toContain('One login runs one restaurant.');
    await click(topDialog()!.querySelectorAll('input[type="checkbox"]')[0]);
    await type(byId('ow-move'), 'u-detached-1');
    await click(modalBtn('Attach login'));
    await flush();
    expect(create).toHaveBeenLastCalledWith('ven-2', { existingUserId: 'u-detached-1', takePayoutAccountFrom: 'u-detached-1' });
    expect(dialogs()).toHaveLength(0);
  });
});

describe('change phone or name', () => {
  it('warns that a phone change signs the owner out; sends only what changed', async () => {
    const { onChanged } = await setup();
    const patch = vi.spyOn(apiService, 'patchOwner').mockResolvedValue(result({ success: true, changed: true, owner: rawOwnerView({ userId: 'zc-vown-2', name: 'Owner2 Kitchen', phone: '+91 9777620099' }) }));
    await click(byText('button', 'Change phone or name', section()));
    expect((byId('oe-phone') as HTMLInputElement).value).toBe('+91 9777620002');
    await click(modalBtn('Save'));
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('Nothing was changed.');
    expect(patch).not.toHaveBeenCalled();
    await type(byId('oe-phone'), '97776 20099');
    expect(topDialog()!.textContent).toContain('Changing the phone signs the owner out of every device. They sign in again with the new number and the same password.');
    await click(modalBtn('Save'));
    await flush();
    expect(patch).toHaveBeenCalledWith('ven-1', { phone: '9777620099' });
    expect(onChanged).toHaveBeenCalledWith({ owner: expect.objectContaining({ phone: '+91 9777620099' }) });
    expect(section().textContent).toContain('+91 9777620099');
  });

  it('name only; a bad phone is caught before sending; PHONE_TAKEN is a field error', async () => {
    await setup();
    const patch = vi.spyOn(apiService, 'patchOwner').mockRejectedValue(apiErr(409, { code: 'PHONE_TAKEN', message: 'x' }));
    await click(byText('button', 'Change phone or name', section()));
    await type(byId('oe-phone'), '12345');
    await click(modalBtn('Save'));
    expect(byId('oe-phone-msg')!.textContent).toContain('valid 10-digit');
    expect(patch).not.toHaveBeenCalled();
    await type(byId('oe-phone'), '9876500011');
    await click(modalBtn('Save'));
    await flush();
    expect(byId('oe-phone-msg')!.textContent).toBe('This number already belongs to another account.');
    await type(byId('oe-phone'), '+91 9777620002');
    await type(byId('oe-name'), 'Ramesh K');
    patch.mockResolvedValue(result({ success: true, changed: true, owner: rawOwnerView({ userId: 'zc-vown-2', name: 'Ramesh K' }) }));
    await click(modalBtn('Save'));
    await flush();
    expect(patch).toHaveBeenLastCalledWith('ven-1', { name: 'Ramesh K' });
  });
});

describe('reset password', () => {
  it('asks first, then shows the server-made password once', async () => {
    await setup();
    const reset = vi.spyOn(apiService, 'resetOwnerPassword').mockResolvedValue(result({ success: true, generatedPassword: GENERATED }));
    await click(byText('button', 'Reset password', section()));
    expect(topDialog()!.textContent).toContain('Reset the password for Owner2 Kitchen?');
    expect(topDialog()!.textContent).toContain('They are signed out everywhere and the old password stops working now.');
    await click(modalBtn('Reset and show new password'));
    await flush();
    expect(reset).toHaveBeenCalledWith('ven-1');
    const d = topDialog()!;
    expect(d.querySelector('[data-testid="shown-password"]')!.textContent).toBe(GENERATED);
    await click(d.querySelector('input[type="checkbox"]'));
    await click(byText('button', 'Done', d));
    expect(document.body.innerHTML).not.toContain(GENERATED);
  });
  it('an answer without a password is an error, not a silent success', async () => {
    await setup();
    vi.spyOn(apiService, 'resetOwnerPassword').mockResolvedValue(result({ success: true }));
    await click(byText('button', 'Reset password', section()));
    await click(modalBtn('Reset and show new password'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toContain('did not send a new password');
  });
  it('a rate limit keeps the dialog open with the server text', async () => {
    const { onAuthError } = await setup();
    vi.spyOn(apiService, 'resetOwnerPassword').mockRejectedValue(apiErr(429, { code: 'RATE_LIMITED', message: 'Too many admin changes in a short time. Try again in a few minutes.' }));
    await click(byText('button', 'Reset password', section()));
    await click(modalBtn('Reset and show new password'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toContain('Too many admin changes');
    expect(onAuthError).toHaveBeenCalled();
  });
});

describe('disable / enable', () => {
  it('disable: reason, "also close the restaurant" on by default, the orders-stay note; sends closeRestaurant', async () => {
    const { onChanged } = await setup(vendor(), impact({ openOrders: [rawOpenOrder()] }));
    const disable = vi.spyOn(apiService, 'disableOwner').mockResolvedValue(result({ success: true, changed: true, owner: rawOwnerView({ userId: 'zc-vown-2', accountStatus: 'SUSPENDED', statusReason: 'Owner asked to pause' }), openOrders: 1 }));
    await click(byText('button', 'Disable login', section()));
    await flush();
    const d = topDialog()!;
    expect(d.textContent).toContain('They are signed out and cannot sign in until you enable it again.');
    expect(d.textContent).toContain('1 order is in progress.');
    expect(d.textContent).toContain('These orders are not cancelled. You can handle them in the Orders tab.');
    const close = d.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(close.checked).toBe(true);
    await type(byId('rd-reason'), 'Owner asked to pause');
    await click(modalBtn('Disable login'));
    await flush();
    expect(disable).toHaveBeenCalledWith('ven-1', { reason: 'Owner asked to pause', closeRestaurant: true });
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ isAcceptingOrders: false }));
    expect(section().textContent).toContain('Login disabled');
    expect(byText('button', 'Enable login', section())).toBeDefined();
  });

  it('keeping the restaurant open sends closeRestaurant:false and shows the server warning', async () => {
    await setup();
    const disable = vi.spyOn(apiService, 'disableOwner').mockResolvedValue(result({ success: true, changed: true, owner: rawOwnerView({ userId: 'zc-vown-2', accountStatus: 'SUSPENDED' }), openOrders: 0, warning: 'Orders will arrive that only an admin can accept.' }));
    await click(byText('button', 'Disable login', section()));
    await flush();
    await type(byId('rd-reason'), 'Owner asked to pause');
    await click(topDialog()!.querySelector('input[type="checkbox"]'));
    await click(modalBtn('Disable login'));
    await flush();
    expect(disable).toHaveBeenCalledWith('ven-1', { reason: 'Owner asked to pause', closeRestaurant: false });
    expect(document.body.textContent).toContain('Orders will arrive that only an admin can accept.');
  });

  it('enable brings back the login only (the restaurant stays closed)', async () => {
    await setup(vendor(rawAdminVendor({ owner: { id: 'zc-vown-2', name: 'Paused', phone: '+91 9000000009', accountStatus: 'SUSPENDED', statusReason: 'x', lastLoginAt: null } })));
    const enable = vi.spyOn(apiService, 'enableOwner').mockResolvedValue(result({ success: true, changed: true, owner: rawOwnerView({ userId: 'zc-vown-2', name: 'Paused' }) }));
    await click(byText('button', 'Enable login', section()));
    expect(topDialog()!.textContent).toContain('The restaurant stays closed: they open it from the app.');
    await click(modalBtn('Enable login'));
    await flush();
    expect(enable).toHaveBeenCalledWith('ven-1');
    expect(section().textContent).toContain('Login active');
  });
});

describe('detach and remove', () => {
  it('detach needs a reason, closes the restaurant by default, and leaves the restaurant ownerless; the detached login can be attached again', async () => {
    const { onChanged } = await setup();
    const detach = vi.spyOn(apiService, 'detachOwner').mockResolvedValue(result({ success: true, changed: true, owner: null, detachedUser: { id: 'u-old-1', name: 'Owner2 Kitchen' } }));
    await click(byText('button', 'Detach from restaurant', section()));
    await flush();
    const d = topDialog()!;
    expect(d.textContent).toContain('Remove the owner login from Sharma Dhaba?');
    expect(d.textContent).toContain('The restaurant stays, but nobody can run it until you add a new owner.');
    expect(d.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(d.querySelector('#rd-name')).toBeNull();
    await type(byId('rd-reason'), 'Owner changed');
    await click(modalBtn('Detach login'));
    await flush();
    expect(detach).toHaveBeenCalledWith('ven-1', 'detach', { reason: 'Owner changed', closeRestaurant: true, confirmName: '' });
    expect(onChanged).toHaveBeenCalledWith({ owner: null, isAcceptingOrders: false });
    expect(section().textContent).toContain('No owner');
    expect(section().textContent).toContain("Owner2 Kitchen's login was detached a moment ago and can be attached again.");
    await click(byText('button', 'Create or attach an owner login', section()));
    await click(byText('button', 'Attach a detached login', topDialog()!));
    expect((byId('ow-attach') as HTMLInputElement).value).toBe('u-old-1');
  });

  it('running orders: the same explicit cancel choice; CANCEL only after choosing it', async () => {
    await setup();
    const detach = vi.spyOn(apiService, 'detachOwner').mockRejectedValueOnce(apiErr(409, rawVendorHasOpenOrders())).mockResolvedValueOnce(result({ success: true, changed: true, owner: null, detachedUser: { id: 'u-old-1', name: 'Owner2 Kitchen' }, cancelled: [{ orderId: 'o1', cancelledOrders: 1, refund: 'STARTED' }] }));
    await click(byText('button', 'Detach from restaurant', section()));
    await flush();
    await type(byId('rd-reason'), 'Owner changed');
    await click(modalBtn('Detach login'));
    await flush();
    expect(topDialog()!.textContent).toContain('This restaurant has 1 order(s) in progress');
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Cancel the orders and refund, then detach'));
    await flush();
    expect(detach.mock.calls[0][2]).not.toHaveProperty('openOrders');
    expect(detach.mock.calls[1][2]).toMatchObject({ openOrders: 'CANCEL' });
  });

  it('remove login needs the owner name typed', async () => {
    await setup();
    const detach = vi.spyOn(apiService, 'detachOwner').mockResolvedValue(result({ success: true, changed: true, owner: null, detachedUser: { id: 'u-old-1', name: 'Owner2 Kitchen' } }));
    await click(byText('button', 'Remove login', section()));
    await flush();
    expect(topDialog()!.textContent).toContain("Remove Owner2 Kitchen's login for good?");
    await type(byId('rd-reason'), 'Left');
    await type(byId('rd-reason'), 'Left it');
    expect(modalBtn('Remove login').disabled).toBe(true);
    await type(byId('rd-name'), 'owner2 kitchen');
    await click(modalBtn('Remove login'));
    await flush();
    expect(detach).toHaveBeenCalledWith('ven-1', 'remove', { reason: 'Left it', closeRestaurant: true, confirmName: 'owner2 kitchen' });
    expect(section().textContent).toContain('No owner');
  });
});

describe('inside the Edit restaurant drawer', () => {
  it('the section is in the drawer; pressing Enter in an owner field does not save the restaurant form', async () => {
    vi.spyOn(apiService, 'fetchCategories').mockResolvedValue([parseCategory(rawCategory())!]);
    vi.spyOn(apiService, 'fetchVendorImpact').mockResolvedValue(impact());
    const update = vi.spyOn(apiService, 'updateVendorProfile');
    const onOwnerChanged = vi.fn();
    await mount(<EditRestaurantDrawer vendor={vendor(rawOwnerlessVendor())} onClose={() => {}} onSaved={() => {}} onOwnerChanged={onOwnerChanged} />);
    await flush();
    expect(document.querySelector('[role="dialog"] section[aria-label="Owner login"]')).not.toBeNull();
    const create = vi.spyOn(apiService, 'createOwner').mockResolvedValue(result(rawOwnerCreate()));
    await click(byText('button', 'Create or attach an owner login'));
    await fillNewOwner();
    await type(byId('er-name'), 'Changed restaurant name'); // the profile form is dirty: an Enter that reached it would save
    const input = byId('ow-name')!;
    input.focus();
    await (await import('react')).act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(update).not.toHaveBeenCalled();
    await click(byText('button', 'Create login', topDialog()!));
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(onOwnerChanged).toHaveBeenCalledWith('ven-2', expect.objectContaining({ isAcceptingOrders: false }));
  });
});
