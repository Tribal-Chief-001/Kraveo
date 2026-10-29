// @vitest-environment jsdom
// CredentialDialog (show once), ActionConfirm and OutcomeDialog.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import { CredentialDialog, Credentials } from './CredentialDialog';
import { ActionConfirm } from './ActionConfirm';
import { OutcomeDialog } from './OutcomeDialog';
import { parseOutcome } from '../lib/accountParse';
import { ApiError } from '../services/api';
import { byText, click, flush, mount, press, topDialog, unmount, dialogs } from '../test/dom';
import { GENERATED, ORDER_ID } from '../test/adminFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const creds = (over: Partial<Credentials> = {}): Credentials => ({ heading: 'Kraveo Restaurant Partner login', who: 'New Owner · Sharma Dhaba', phone: '+91 9876543299', password: GENERATED, note: 'The new password is active now.', ...over });

/** The way a parent uses it: the password lives in the parent's state only until Done. */
const Parent: React.FC<{ onDone?: () => void }> = ({ onDone }) => {
  const [secret, setSecret] = useState<Credentials | null>(creds());
  return <><button id="after">after</button><CredentialDialog credentials={secret} onDone={() => { setSecret(null); onDone?.(); }} /></>;
};

describe('CredentialDialog: the password is shown once', () => {
  it('shows the warning, the login and the password as text; Done is off until it is copied or ticked', async () => {
    await mount(<Parent />);
    const d = topDialog()!;
    expect(d.getAttribute('role')).toBe('alertdialog');
    expect(d.textContent).toContain('This password is shown only once. Kraveo cannot show it again; you can reset it any time.');
    expect(d.textContent).toContain('+91 9876543299');
    expect(d.querySelector('[data-testid="shown-password"]')!.textContent).toBe(GENERATED);
    expect((byText('button', 'Done', d) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot be closed by Esc, the backdrop or the X until the admin has the password', async () => {
    const onDone = vi.fn();
    await mount(<Parent onDone={onDone} />);
    await press('Escape');
    await click(document.querySelector('.bg-black\\/70'));
    await click(topDialog()!.querySelector('button[aria-label="Close dialog"]'));
    expect(onDone).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(1);
  });

  it('ticking "I have copied it" enables Done; after Done the password is gone from the page', async () => {
    const onDone = vi.fn();
    await mount(<Parent onDone={onDone} />);
    await click(topDialog()!.querySelector('input[type="checkbox"]'));
    const done = byText('button', 'Done', topDialog()!) as HTMLButtonElement;
    expect(done.disabled).toBe(false);
    await click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(dialogs()).toHaveLength(0);
    expect(document.body.textContent).not.toContain(GENERATED);
    expect(document.body.innerHTML).not.toContain(GENERATED);
  });

  it('the copy button puts the login on the clipboard (10-digit phone, password), marks it copied and enables Done', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount(<Parent />);
    await click(byText('button', 'Copy login details', topDialog()!));
    await flush();
    expect(writeText).toHaveBeenCalledWith(`Kraveo Restaurant Partner login\nPhone: 9876543299\nPassword: ${GENERATED}`);
    expect(topDialog()!.textContent).toContain('Copied');
    expect((byText('button', 'Done', topDialog()!) as HTMLButtonElement).disabled).toBe(false);
    expect(topDialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });

  it('when the browser blocks the clipboard it says so and still needs the tick', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    await mount(<Parent />);
    await click(byText('button', 'Copy login details', topDialog()!));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toContain('did not allow copying');
    expect((byText('button', 'Done', topDialog()!) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the password is not put in a link, an input value or storage', async () => {
    await mount(<Parent />);
    expect(document.querySelectorAll('a[href]')).toHaveLength(0);
    expect(Array.from(document.querySelectorAll('input')).some((i) => (i as HTMLInputElement).value.includes(GENERATED))).toBe(false);
    expect(JSON.stringify({ ...localStorage })).not.toContain(GENERATED);
    expect(window.location.href).not.toContain(GENERATED);
  });

  it('renders nothing without credentials', async () => {
    await mount(<CredentialDialog credentials={null} onDone={() => {}} />);
    expect(dialogs()).toHaveLength(0);
  });
});

describe('ActionConfirm', () => {
  it('focuses Cancel first, runs once, and the parent closes it on success', async () => {
    let release: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const onClose = vi.fn();
    await mount(<ActionConfirm title="Restore X?" confirmLabel="Restore" onConfirm={onConfirm} onClose={onClose}><p>Explained.</p></ActionConfirm>);
    expect((document.activeElement as HTMLElement).textContent).toBe('Cancel');
    await click(byText('button', 'Restore', topDialog()!));
    await click(topDialog()!.querySelector('button[aria-busy="true"]'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await press('Escape');
    expect(onClose).not.toHaveBeenCalled();
    release();
    await flush();
  });

  it('a failure keeps it open with the server message and tells the app', async () => {
    const onAuthError = vi.fn();
    await mount(<ActionConfirm title="Enable?" confirmLabel="Enable" onConfirm={async () => { throw new ApiError(409, 'That owner login was removed and cannot be attached.', 'OWNER_REMOVED'); }} onClose={() => {}} onAuthError={onAuthError}><p>x</p></ActionConfirm>);
    await click(byText('button', 'Enable', topDialog()!));
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('That owner login was removed and cannot be attached.');
    expect(onAuthError).toHaveBeenCalled();
  });
});

describe('OutcomeDialog', () => {
  it('lists cancelled orders (refund started, combined parts) and what failed, as text', async () => {
    const outcome = parseOutcome({
      cancelled: [{ orderId: ORDER_ID, groupId: null, cancelledOrders: 1, refund: 'STARTED' }, { orderId: 'grp-order-aaaaaa', groupId: 'g', cancelledOrders: 2, refund: 'NONE' }],
      failed: [{ orderId: 'bad-order-bbbbbb', code: 'ORDER_IN_DELIVERY', message: '<i>With a rider</i> right now.' }],
      released: ['rel-order-cccccc'],
    });
    const onOpenOrder = vi.fn();
    const onClose = vi.fn();
    await mount(<OutcomeDialog title="What happened to the orders" headline="Cust1 Tester is suspended." outcome={outcome} onClose={onClose} onOpenOrder={onOpenOrder} />);
    const d = topDialog()!;
    expect(d.textContent).toContain('Cust1 Tester is suspended.');
    expect(d.textContent).toContain('refund queued, will retry automatically');
    expect(d.textContent).toContain('combined order, 2 parts cancelled');
    expect(d.textContent).toContain('Could not finish (1)');
    expect(d.textContent).toContain('<i>With a rider</i> right now.');
    expect(d.querySelector('i')).toBeNull();
    expect(d.textContent).toContain('Handed back to the pool (1)');
    expect(d.textContent).toContain('Do the same action again to retry');
    await click(byText('button', '#C0FFEE'.length ? `#${ORDER_ID.slice(-6).toUpperCase()}` : '', d));
    expect(onClose).toHaveBeenCalled();
    expect(onOpenOrder).toHaveBeenCalledWith(ORDER_ID);
  });
});
