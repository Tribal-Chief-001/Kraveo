// @vitest-environment jsdom
// Docs/28 section 9 (backend review fixes): bounded cancels with `remaining`, real refund states, LOGIN_NOT_ACTIVE, reset-password `issuedAt`, 429 on the shared limit.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { OutcomeDialog } from './OutcomeDialog';
import { CustomersPanel } from './CustomersPanel';
import { VendorManager } from './VendorManager';
import { OwnerLoginSection } from './OwnerLoginSection';
import { ApplicationsPanel } from './ApplicationsPanel';
import { ApiError, apiService } from '../services/api';
import { Application, normalizeVendor } from '../types';
import { isOlderIssue, mergeOutcome, parseCustomerDetail, parseCustomerList, parseOutcome, parseOwnerResult, parseVendorImpact, refundText } from '../lib/accountParse';
import { byId, byText, click, dialogs, flush, mount, topDialog, type, unmount } from '../test/dom';
import {
  GENERATED, ISSUED_1, ISSUED_2, rawAdminVendor, rawCancelBatch, rawCustomerDetail, rawCustomerList, rawCustomerRow, rawLoginNotActive, rawOpenOrder, rawOwnerlessVendor, rawRateLimited, rawResetPassword,
  rawSuspendedDetail, rawVendorImpact,
} from '../test/adminFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });
const apiErr = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);
const batch = (over: Record<string, unknown> = {}) => parseOutcome({ changed: true, ...rawCancelBatch(over) });
const modalBtn = (label: RegExp | string) => byText('button', label, topDialog()!) as HTMLButtonElement;

describe('parsing', () => {
  it('refund states and remaining are read; an unknown refund value does not break', () => {
    const o = batch();
    expect(o.cancelled.map((c) => c.refund)).toEqual(['DONE', 'STARTED', 'FAILED', 'NONE']);
    expect(o.cancelled[2].refundMessage).toBe('Razorpay is not reachable.');
    expect(o.remaining).toEqual(['ord-rem-555555', 'ord-rem-666666']);
    expect(parseOutcome({ cancelled: [{ orderId: 'a', refund: 'SOMETHING' }], remaining: [1, '', 'ok'] })).toMatchObject({ cancelled: [{ refund: 'UNKNOWN' }], remaining: ['ok'] });
    expect(parseOutcome({}).remaining).toEqual([]);
  });
  it('plain words per refund state', () => {
    expect(refundText({ refund: 'NONE', refundMessage: null })).toBe('nothing to refund');
    expect(refundText({ refund: 'DONE', refundMessage: null })).toBe('refund done, the money is back');
    expect(refundText({ refund: 'STARTED', refundMessage: null })).toBe('refund queued, will retry automatically');
    expect(refundText({ refund: 'FAILED', refundMessage: 'No funds.' })).toContain('refund failed: No funds.');
    expect(refundText({ refund: 'FAILED', refundMessage: 'No funds.' })).toContain('retry it from Needs attention');
  });
  it('batches add up: cancelled orders are kept, the newest remaining / failed win, nothing is counted twice', () => {
    const merged = mergeOutcome(batch(), parseOutcome({ cancelled: [{ orderId: 'ord-rem-555555', refund: 'DONE' }, { orderId: 'ord-done-111111', refund: 'DONE' }], remaining: [] }));
    expect(merged.cancelled).toHaveLength(5);
    expect(merged.remaining).toEqual([]);
  });
  it('reset answer carries issuedAt; older ones are recognised', () => {
    expect(parseOwnerResult(rawResetPassword()).issuedAt).toBe(ISSUED_1);
    expect(parseOwnerResult({ success: true }).issuedAt).toBeNull();
    expect(isOlderIssue(ISSUED_1, ISSUED_2)).toBe(true);
    expect(isOlderIssue(ISSUED_2, ISSUED_1)).toBe(false);
    expect(isOlderIssue(ISSUED_1, ISSUED_1)).toBe(false);
    expect(isOlderIssue(null, ISSUED_2)).toBe(false);
    expect(isOlderIssue(ISSUED_1, null)).toBe(false);
  });
});

describe('OutcomeDialog: refunds per order and Continue', () => {
  it('shows every refund state in plain words and the remaining count', async () => {
    await mount(<OutcomeDialog title="What happened to the orders" headline="Cust1 is suspended." outcome={batch()} onClose={() => {}} />);
    const d = topDialog()!;
    expect(d.textContent).toContain('refund done, the money is back');
    expect(d.textContent).toContain('refund queued, will retry automatically');
    expect(d.textContent).toContain('refund failed: Razorpay is not reachable.');
    expect(d.textContent).toContain('the admin can retry it from Needs attention');
    expect(d.textContent).toContain('nothing to refund');
    expect(d.textContent).toContain('2 more orders are still open: they were not cancelled yet.');
    expect(byText('button', 'Continue', d)).toBeUndefined();
  });

  it('Continue repeats the action, adds the next batch to the list, one request at a time, until nothing remains', async () => {
    let release: (o: ReturnType<typeof batch>) => void = () => {};
    const again = vi.fn(() => new Promise<ReturnType<typeof batch>>((resolve) => { release = resolve; }));
    await mount(<OutcomeDialog title="t" headline="h" outcome={batch()} onClose={() => {}} onContinue={again} />);
    const d = topDialog()!;
    expect(d.textContent).toContain('2 more orders are still open: press Continue to cancel the next batch.');
    await click(byText('button', 'Continue', d));
    await click(d.querySelector('button[aria-busy="true"]'));
    expect(again).toHaveBeenCalledTimes(1);
    expect((byText('button', 'Close', d) as HTMLButtonElement).disabled).toBe(true);
    release(parseOutcome({ changed: false, cancelled: [{ orderId: 'ord-rem-555555', refund: 'DONE' }, { orderId: 'ord-rem-666666', refund: 'NONE' }], remaining: [] }));
    await flush();
    expect(d.textContent).toContain('Cancelled (6)');
    expect(d.textContent).not.toContain('still open');
    expect(byText('button', 'Continue', d)).toBeUndefined();
  });

  it('a Continue that fails shows the server message (429 too) and can be pressed again', async () => {
    const onAuthError = vi.fn();
    const again = vi.fn().mockRejectedValueOnce(apiErr(429, rawRateLimited())).mockResolvedValueOnce(parseOutcome({ remaining: [] }));
    await mount(<OutcomeDialog title="t" headline="h" outcome={batch()} onClose={() => {}} onContinue={again} onAuthError={onAuthError} />);
    await click(byText('button', 'Continue', topDialog()!));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('Too many admin changes in a short time. Try again in a few minutes.');
    expect(onAuthError).toHaveBeenCalled();
    await click(byText('button', 'Continue', topDialog()!));
    await flush();
    expect(topDialog()!.textContent).not.toContain('still open');
  });

  it('with no way to repeat, the help text is shown instead of a button', async () => {
    await mount(<OutcomeDialog title="t" headline="h" outcome={batch()} onClose={() => {}} remainingHelp="Continue from the restaurant Suspend flow." />);
    expect(topDialog()!.textContent).toContain('Continue from the restaurant Suspend flow.');
    expect(byText('button', 'Continue', topDialog()!)).toBeUndefined();
  });
});

describe('customers: Continue sends the same action again', () => {
  it('suspend with the cancel choice: batch 1, press Continue, same request again, the list ends up complete', async () => {
    vi.spyOn(apiService, 'fetchCustomers').mockResolvedValue(parseCustomerList(rawCustomerList([rawCustomerRow()]))!);
    vi.spyOn(apiService, 'fetchCustomer').mockResolvedValue(parseCustomerDetail(rawCustomerDetail({ openOrders: [rawOpenOrder()] }))!);
    const detail = parseCustomerDetail(rawSuspendedDetail())!;
    const block = vi.spyOn(apiService, 'blockCustomer')
      .mockResolvedValueOnce({ detail, outcome: batch() })
      .mockResolvedValueOnce({ detail, outcome: parseOutcome({ changed: false, cancelled: [{ orderId: 'ord-rem-555555', refund: 'DONE' }], remaining: [] }) });
    await mount(<CustomersPanel query="" onClearQuery={() => {}} onAuthError={() => {}} />);
    await flush();
    await click(document.querySelector('[aria-label="Open Cust1 Tester"]'));
    await flush();
    await click(byText('button', 'Suspend', document.querySelector('[role="dialog"]')!));
    await type(byId('rd-reason'), 'Fake orders');
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Cancel the orders and refund, then suspend'));
    await flush();
    expect(topDialog()!.textContent).toContain('2 more orders are still open: press Continue to cancel the next batch.');
    await click(byText('button', 'Continue', topDialog()!));
    await flush();
    expect(block).toHaveBeenCalledTimes(2);
    expect(block.mock.calls[1]).toEqual(block.mock.calls[0]);
    expect(block.mock.calls[1][2]).toEqual({ reason: 'Fake orders', openOrders: 'CANCEL' });
    expect(topDialog()!.textContent).toContain('Cancelled (5)');
    expect(topDialog()!.textContent).not.toContain('still open');
  });
});

describe('restaurants: Continue sends the same action again', () => {
  it('remove with the cancel choice: Continue repeats name, reason, disableOwner and CANCEL', async () => {
    vi.spyOn(apiService, 'fetchVendorImpact').mockResolvedValue(parseVendorImpact(rawVendorImpact({ openOrders: [rawOpenOrder()] }).data)!);
    const v = normalizeVendor(rawAdminVendor());
    const block = vi.spyOn(apiService, 'blockVendor')
      .mockResolvedValueOnce({ vendor: normalizeVendor(rawAdminVendor({ removedAt: '2026-10-29T05:00:00.000Z' })), outcome: batch(), ownerDisabled: true })
      .mockResolvedValueOnce({ vendor: v, outcome: parseOutcome({ changed: false, remaining: [] }), ownerDisabled: true });
    await mount(<VendorManager vendors={[v]} onToggleVendor={() => {}} onAuthError={() => {}} />);
    await click(document.querySelector('button[aria-label="Remove Sharma Dhaba"]'));
    await flush();
    await type(byId('rd-reason'), 'Closed for good');
    await type(byId('rd-name'), 'Sharma Dhaba');
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Cancel the orders and refund, then remove'));
    await flush();
    await click(byText('button', 'Continue', topDialog()!));
    await flush();
    expect(block.mock.calls[1]).toEqual(block.mock.calls[0]);
    expect(block.mock.calls[1][2]).toEqual({ reason: 'Closed for good', confirmName: 'Sharma Dhaba', disableOwner: true, openOrders: 'CANCEL' });
    expect(topDialog()!.textContent).not.toContain('still open');
  });
});

describe('owner detach: the remaining orders are explained, not repeatable', () => {
  it('shows the batch result and says to continue from the restaurant suspend flow or the order cancel', async () => {
    vi.spyOn(apiService, 'fetchVendorImpact').mockResolvedValue(parseVendorImpact(rawVendorImpact({ openOrders: [rawOpenOrder()] }).data)!);
    vi.spyOn(apiService, 'detachOwner').mockResolvedValue(parseOwnerResult({ success: true, changed: true, owner: null, detachedUser: { id: 'u-old', name: 'Owner2 Kitchen' }, ...rawCancelBatch() }));
    await mount(<OwnerLoginSection vendor={normalizeVendor(rawAdminVendor())} onChanged={() => {}} />);
    await click(byText('button', 'Detach from restaurant'));
    await flush();
    await type(byId('rd-reason'), 'Owner changed');
    await click(topDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    await click(modalBtn('Cancel the orders and refund, then detach'));
    await flush();
    const d = topDialog()!;
    expect(d.textContent).toContain('2 more orders are still open: they were not cancelled yet.');
    expect(d.textContent).toContain('suspend the restaurant and choose to cancel its orders');
    expect(d.textContent).toContain('cancel them one by one in the Orders tab');
    expect(byText('button', 'Continue', d)).toBeUndefined();
    expect(d.textContent).toContain('refund failed: Razorpay is not reachable.');
  });
});

describe('attach: LOGIN_NOT_ACTIVE', () => {
  it('shows the server message and keeps the form open', async () => {
    vi.spyOn(apiService, 'createOwner').mockRejectedValue(apiErr(409, rawLoginNotActive()));
    await mount(<OwnerLoginSection vendor={normalizeVendor(rawOwnerlessVendor())} onChanged={() => {}} />);
    await click(byText('button', 'Create or attach an owner login'));
    await click(byText('button', 'Attach a detached login', topDialog()!));
    await type(byId('ow-attach'), 'u-paused-1');
    await click(modalBtn('Attach login'));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('That owner login is paused for another reason, so it cannot be attached. It stays paused.');
    expect(topDialog()!.textContent).toContain('Owner login for Imported Biryani House');
  });
});

describe('reset password: issuedAt', () => {
  const setup = async () => {
    vi.spyOn(apiService, 'fetchVendorImpact').mockResolvedValue(parseVendorImpact(rawVendorImpact().data)!);
    await mount(<OwnerLoginSection vendor={normalizeVendor(rawAdminVendor())} onChanged={() => {}} />);
  };
  const reset = async () => { await click(byText('button', 'Reset password', document.querySelector('section')!)); await click(modalBtn('Reset and show new password')); await flush(); };
  const finish = async () => { const d = topDialog()!; await click(d.querySelector('input[type="checkbox"]')); await click(byText('button', 'Done', d)); };

  it('the credential dialog says when the password was generated (India time)', async () => {
    await setup();
    vi.spyOn(apiService, 'resetOwnerPassword').mockResolvedValue(parseOwnerResult(rawResetPassword(GENERATED, ISSUED_1)));
    await reset();
    expect(topDialog()!.textContent).toMatch(/Generated at 29 Oct 2026,? 1:30\s?(pm|PM) \(India time\)/);
    expect(topDialog()!.querySelector('[data-testid="shown-password"]')!.textContent).toBe(GENERATED);
  });

  it('an answer issued EARLIER than a password already shown never replaces it, and says so', async () => {
    await setup();
    const call = vi.spyOn(apiService, 'resetOwnerPassword')
      .mockResolvedValueOnce(parseOwnerResult(rawResetPassword('NewestPassword2222', ISSUED_2)))
      .mockResolvedValueOnce(parseOwnerResult(rawResetPassword('OlderPassword1111', ISSUED_1)));
    await reset();
    expect(topDialog()!.querySelector('[data-testid="shown-password"]')!.textContent).toBe('NewestPassword2222');
    await finish();
    await reset(); // the older answer arrives now
    expect(document.body.textContent).not.toContain('OlderPassword1111');
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toContain('A newer password was issued a moment ago');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('a later password (newer issuedAt) is shown normally', async () => {
    await setup();
    vi.spyOn(apiService, 'resetOwnerPassword')
      .mockResolvedValueOnce(parseOwnerResult(rawResetPassword('FirstPassword1111', ISSUED_1)))
      .mockResolvedValueOnce(parseOwnerResult(rawResetPassword('SecondPassword2222', ISSUED_2)));
    await reset(); await finish();
    await reset();
    expect(topDialog()!.querySelector('[data-testid="shown-password"]')!.textContent).toBe('SecondPassword2222');
    await finish();
    expect(document.body.innerHTML).not.toContain('FirstPassword1111');
    expect(document.body.innerHTML).not.toContain('SecondPassword2222');
  });

  it('a double click sends one request', async () => {
    await setup();
    let go: () => void = () => {};
    const call = vi.spyOn(apiService, 'resetOwnerPassword').mockImplementation(() => new Promise((resolve) => { go = () => resolve(parseOwnerResult(rawResetPassword())); }));
    await click(byText('button', 'Reset password', document.querySelector('section')!));
    const b = modalBtn('Reset and show new password');
    await click(b); await click(b);
    expect(call).toHaveBeenCalledTimes(1);
    go();
    await flush();
  });
});

describe('429 on the shared admin limit (old status route, reset-password)', () => {
  const app: Application = {
    id: 'ven-1', kind: 'VENDOR', userId: 'u-v1', name: 'Owner One', phone: '+91 9876500001', status: 'PENDING', rejectionReason: null, selfSignup: true,
    appliedAt: '2026-10-01T08:00:00.000Z', reviewedAt: null, createdAt: '2026-10-01T08:00:00.000Z', vendor: { name: 'Sharma Dhaba', category: 'North Indian', address: 'Ashta road', fssaiNumber: null, isAcceptingOrders: false },
  };
  it('approve (status route): the server message in a toast', async () => {
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 1, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 }, data: [app] });
    vi.spyOn(apiService, 'decidePartner').mockRejectedValue(apiErr(429, rawRateLimited()));
    await mount(<ApplicationsPanel refreshKey={0} onChanged={() => {}} onAuthError={() => {}} />);
    await flush();
    await click(byText('button', 'Approve'));
    await flush();
    expect(document.body.textContent).toContain('Too many admin changes in a short time. Try again in a few minutes.');
  });
  it('reset-password (partner route): the server message in the form, no password shown', async () => {
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts: { PENDING: 0, APPROVED: 1, REJECTED: 0, SUSPENDED: 0 }, data: [{ ...app, status: 'APPROVED' }] });
    vi.spyOn(apiService, 'resetPartnerPassword').mockRejectedValue(apiErr(429, rawRateLimited()));
    await mount(<ApplicationsPanel refreshKey={0} onChanged={() => {}} onAuthError={() => {}} />);
    await flush();
    await click(byText('button', /^Approved/, document.querySelector('[aria-label="Filter by decision"]')!));
    await flush();
    await click(byText('button', 'Reset password'));
    await click(byText('button', 'Set new password'));
    await flush();
    expect(document.querySelector('#reset-form [role="alert"]')!.textContent).toBe('Too many admin changes in a short time. Try again in a few minutes.');
    expect(dialogs().some((d) => d.querySelector('[data-testid="shown-password"]'))).toBe(false);
  });
});
