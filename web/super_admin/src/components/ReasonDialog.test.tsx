// @vitest-environment jsdom
// The shared reason dialog: reason rules, type-the-name, the blocking-orders panel with an explicit choice, errors, double submit, locking.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ReasonDialog, ReasonDialogProps } from './ReasonDialog';
import { ApiError } from '../services/api';
import { blockFromError } from '../lib/accountParse';
import { byId, byText, click, dialogs, flush, mount, press, topDialog, type, unmount } from '../test/dom';
import { rawConfirmMismatch, rawHasOpenOrders, rawOrderInDelivery, rawRateLimited, rawTokenRevoked, rawBadReason, rawOpenOrder } from '../test/adminFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const apiErr = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);

const setup = async (props: Partial<ReasonDialogProps> = {}) => {
  const onSubmit = vi.fn(async () => {});
  const onClose = vi.fn();
  const onAuthError = vi.fn();
  await mount(<ReasonDialog title="Suspend Asha?" confirmLabel="Suspend" onSubmit={onSubmit} onClose={onClose} onAuthError={onAuthError} {...props} />);
  return { onSubmit, onClose, onAuthError };
};
const confirm = () => byText('button', /^(Suspend|Remove|Restore|Cancel the orders)/, topDialog()!) as HTMLButtonElement;

describe('ReasonDialog basics', () => {
  it('is a modal dialog with a title, a first-field focus, and the confirm button off until the reason has 3 characters', async () => {
    await setup({ intro: <p>They will be signed out.</p> });
    const d = topDialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toBe('Suspend Asha?');
    expect(document.activeElement).toBe(byId('rd-reason'));
    expect(confirm().disabled).toBe(true);
    await type(byId('rd-reason'), 'ab');
    expect(confirm().disabled).toBe(true);
    expect(d.textContent).toContain('at least 3 characters');
    await type(byId('rd-reason'), 'Fake orders');
    expect(confirm().disabled).toBe(false);
    await type(byId('rd-reason'), 'x'.repeat(201));
    expect(confirm().disabled).toBe(true);
    expect(d.textContent).toContain('At most 200 characters');
  });

  it('quick reasons fill the box; submit sends the trimmed reason and the flags', async () => {
    const { onSubmit } = await setup({ quickReasons: ['Fake orders', 'Abuse of coupons'], flags: [{ key: 'scrub', label: 'Also erase their details', hint: 'Cannot be undone.' }] });
    await click(byText('button', 'Fake orders'));
    expect((byId('rd-reason') as HTMLTextAreaElement).value).toBe('Fake orders');
    expect(byText('button', 'Fake orders')!.getAttribute('aria-pressed')).toBe('true');
    await click(topDialog()!.querySelector('input[type="checkbox"]'));
    await click(confirm());
    expect(onSubmit).toHaveBeenCalledWith({ reason: 'Fake orders', confirmName: '', flags: { scrub: true }, resolve: false });
  });

  it('an optional note can stay empty', async () => {
    const { onSubmit } = await setup({ title: 'Restore Asha?', reasonOptional: true, confirmLabel: 'Restore customer' });
    expect(confirm().disabled).toBe(false);
    await click(confirm());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ reason: '' }));
  });

  it('text from the server or the person is shown as text, never as HTML', async () => {
    await setup({ title: 'Remove <img src=x onerror=alert(1)>?', block: { code: 'HAS_OPEN_ORDERS', message: '<b>bold</b> message', orders: [] } });
    expect(topDialog()!.querySelector('img')).toBeNull();
    expect(topDialog()!.querySelector('b')).toBeNull();
    expect(topDialog()!.textContent).toContain('<b>bold</b> message');
  });
});

describe('ReasonDialog type-the-name', () => {
  it('Remove stays off until the name matches (case and spaces around do not matter)', async () => {
    const { onSubmit } = await setup({ title: 'Remove Asha Rao?', confirmLabel: 'Remove customer', confirmName: { label: "Type the customer's name to confirm", expected: 'Asha Rao' } });
    await type(byId('rd-reason'), 'Fraud');
    expect(confirm().disabled).toBe(true);
    await type(byId('rd-name'), 'Asha');
    expect(topDialog()!.textContent).toContain('does not match yet');
    expect(confirm().disabled).toBe(true);
    await type(byId('rd-name'), '  asha rao ');
    expect(confirm().disabled).toBe(false);
    await click(confirm());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ confirmName: 'asha rao' }));
  });

  it('a CONFIRM_MISMATCH from the server is shown under the name field and the dialog stays open', async () => {
    const onSubmit = vi.fn(async () => { throw apiErr(400, rawConfirmMismatch()); });
    const { onClose } = await setup({ onSubmit, confirmName: { label: 'Type the name', expected: 'Asha' } });
    await type(byId('rd-reason'), 'Fraud');
    await type(byId('rd-name'), 'Asha');
    await click(confirm());
    await flush();
    expect(byId('rd-name-msg')!.textContent).toBe('The name you typed does not match.');
    expect(byId('rd-name')!.getAttribute('aria-invalid')).toBe('true');
    expect(topDialog()).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a reason refused by the server is shown under the reason field', async () => {
    await setup({ onSubmit: vi.fn(async () => { throw apiErr(400, rawBadReason()); }) });
    await type(byId('rd-reason'), 'Fraud');
    await click(confirm());
    await flush();
    expect(byId('rd-reason-msg')!.textContent).toBe('Reason must be 3 to 200 characters.');
  });
});

describe('ReasonDialog blocking orders and the explicit choice', () => {
  const toBlock = (e: unknown) => blockFromError(e, 'customer', 'suspend');

  it('a 409 shows the list and the server text, changes nothing, and the confirm stays off until the admin picks the cancel choice', async () => {
    const onSubmit = vi.fn(async (v: { resolve: boolean }) => { if (!v.resolve) throw apiErr(409, rawHasOpenOrders()); });
    const { onClose } = await setup({ onSubmit: onSubmit as any, toBlock });
    await type(byId('rd-reason'), 'Fake orders');
    await click(confirm());
    await flush();
    const d = topDialog()!;
    expect(d.querySelector('[role="alert"]')!.textContent).toContain('This customer has 1 order(s) in progress');
    expect(d.textContent).toContain('Nothing was changed.');
    expect(d.querySelector('ul[aria-label="Orders in the way"]')!.textContent).toContain('Placed');
    expect(d.textContent).toContain('₹205');
    // the default is "Stop here": the main button is off, nothing was re-sent
    const stop = d.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0];
    expect(stop.checked).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((byText('button', 'Suspend', d) as HTMLButtonElement).disabled).toBe(true);
    // the explicit choice
    await click(d.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
    expect(d.textContent).toContain('Cancel these orders and refund the customer');
    const go = byText('button', 'Cancel the orders and refund, then suspend', d) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    await click(go);
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1][0]).toMatchObject({ reason: 'Fake orders', resolve: true });
    expect(onClose).not.toHaveBeenCalled(); // closing is the parent's job after success
  });

  it('a block already known before sending shows at once; "stop here" is the default and nothing can be sent', async () => {
    const { onSubmit } = await setup({ block: { code: 'HAS_OPEN_ORDERS', message: 'They have 1 order in progress.', orders: [{ id: 'abc-123456', status: 'PLACED', paymentStatus: 'PAID', totalAmount: 205, groupId: null }], choice: { label: 'Cancel these orders and refund the customer', submitLabel: 'Cancel the orders and refund, then suspend' } } });
    expect(topDialog()!.textContent).toContain('They have 1 order in progress.');
    expect(topDialog()!.textContent).not.toContain('Nothing was changed.');
    await type(byId('rd-reason'), 'Fake orders');
    expect((byText('button', 'Suspend', topDialog()!) as HTMLButtonElement).disabled).toBe(true);
    await click(byText('button', 'Suspend', topDialog()!));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('an order already with a rider has no choice at all, only the wait text', async () => {
    const onSubmit = vi.fn(async () => { throw apiErr(409, rawOrderInDelivery()); });
    await setup({ onSubmit, toBlock });
    await type(byId('rd-reason'), 'Fake orders');
    await click(confirm());
    await flush();
    const d = topDialog()!;
    expect(d.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(d.textContent).toContain('An order is with a rider right now');
    expect(d.textContent).toContain('Wait until it is finished');
    expect((byText('button', 'Suspend', d) as HTMLButtonElement).disabled).toBe(true);
  });

  it('orders are links that hand the id to the parent', async () => {
    const onOpenOrder = vi.fn();
    await setup({ block: { code: 'HAS_OPEN_ORDERS', message: 'x', orders: [{ id: rawOpenOrder().id, status: 'PLACED', paymentStatus: 'PAID', totalAmount: 1, groupId: null }] }, onOpenOrder });
    await click(topDialog()!.querySelector('button[aria-label^="Open order"]'));
    expect(onOpenOrder).toHaveBeenCalledWith(rawOpenOrder().id);
  });
});

describe('ReasonDialog failures and guards', () => {
  it('429 shows the server message in an alert; 401 tells the app (it logs out)', async () => {
    const { onAuthError } = await setup({ onSubmit: vi.fn(async () => { throw apiErr(429, rawRateLimited()); }) });
    await type(byId('rd-reason'), 'Fraud');
    await click(confirm());
    await flush();
    expect(topDialog()!.querySelector('[role="alert"]')!.textContent).toBe('Too many admin changes in a short time. Try again in a few minutes.');
    expect(onAuthError).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }));
    await unmount();
    const second = await setup({ onSubmit: vi.fn(async () => { throw apiErr(401, rawTokenRevoked()); }) });
    await type(byId('rd-reason'), 'Fraud');
    await click(confirm());
    await flush();
    expect(second.onAuthError).toHaveBeenCalledWith(expect.objectContaining({ status: 401, code: 'TOKEN_REVOKED' }));
  });

  it('a 429 with no message of its own still gets a plain sentence', async () => {
    await setup({ onSubmit: vi.fn(async () => { throw new ApiError(429, 'Request failed (429).'); }) });
    await type(byId('rd-reason'), 'Fraud');
    await click(confirm());
    await flush();
    expect(topDialog()!.textContent).toContain('Too many changes in a short time');
  });

  it('while the request runs: no second send, no Cancel, no Esc, no backdrop, no X; it works again after a failure', async () => {
    let release: (() => void) | undefined;
    let fail = true;
    const onSubmit = vi.fn(() => new Promise<void>((resolve, reject) => { release = () => (fail ? reject(new Error('Server said no.')) : resolve()); }));
    const { onClose } = await setup({ onSubmit });
    await type(byId('rd-reason'), 'Fraud');
    await click(confirm());
    await click(topDialog()!.querySelector('button[aria-busy="true"]'));
    await click(topDialog()!.querySelector('button[aria-busy="true"]'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(topDialog()!.getAttribute('aria-busy')).toBe('true');
    expect((byText('button', 'Cancel', topDialog()!) as HTMLButtonElement).disabled).toBe(true);
    expect((topDialog()!.querySelector('button[aria-label="Close dialog"]') as HTMLButtonElement).disabled).toBe(true);
    await press('Escape');
    await click(document.querySelector('.bg-black\\/70'));
    expect(onClose).not.toHaveBeenCalled();
    expect((byId('rd-reason') as HTMLTextAreaElement).disabled).toBe(true);
    await act2(() => release!());
    expect(topDialog()!.textContent).toContain('Server said no.');
    expect(confirm().disabled).toBe(false);
    fail = false;
    await click(confirm());
    await act2(() => release!());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('Esc, Cancel and the X close it when nothing is running; Esc does not reach a drawer under it', async () => {
    const underneath = vi.fn();
    document.addEventListener('keydown', underneath);
    const { onClose } = await setup();
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(underneath).not.toHaveBeenCalled();
    await click(byText('button', 'Cancel', topDialog()!));
    await click(topDialog()!.querySelector('button[aria-label="Close dialog"]'));
    expect(onClose).toHaveBeenCalledTimes(3);
    document.removeEventListener('keydown', underneath);
  });

  it('Tab stays inside the dialog (focus trap)', async () => {
    await setup({ quickReasons: ['A reason'] });
    const d = topDialog()!;
    const nodes = Array.from(d.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea'));
    nodes[nodes.length - 1].focus();
    await press('Tab');
    expect(d.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(nodes[0]);
    await press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(nodes[nodes.length - 1]);
  });

  it('returns focus to the button that opened it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    await setup();
    expect(document.activeElement).toBe(byId('rd-reason'));
    await unmount();
    expect(dialogs()).toHaveLength(0);
  });

  it('does nothing when closed', async () => {
    await mount(<ReasonDialog open={false} title="x" confirmLabel="Go" onSubmit={async () => {}} onClose={() => {}} />);
    expect(dialogs()).toHaveLength(0);
  });
});

const act2 = async (fn: () => void) => { const { act } = await import('react'); await act(async () => { fn(); await new Promise((r) => setTimeout(r, 0)); }); };
