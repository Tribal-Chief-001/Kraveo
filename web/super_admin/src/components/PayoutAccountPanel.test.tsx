// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayoutAccountPanel } from './PayoutAccountPanel';
import { apiService, ApiError } from '../services/api';
import { parsePayoutAccount, parseReveal } from '../lib/financeParse';
import { rawAccount, rawReveal } from '../test/fixtures';
import { byText, click, flush, mount, type, unmount } from '../test/dom';

const FULL = '50100234567890';
const account = (over: Record<string, unknown> = {}) => parsePayoutAccount(rawAccount(over))!;
const result = (acc: ReturnType<typeof account> | null) => ({ partner: { userId: 'u-owner1', name: 'PA Owner One', role: 'VENDOR' }, account: acc, changed: null, message: '' });

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = async (props: Record<string, unknown> = {}) => {
  const onAuthError = vi.fn();
  const host = await mount(<PayoutAccountPanel userId="u-owner1" name="Sharma Dhaba" kind="restaurant" onAuthError={onAuthError} {...(props as any)} />);
  await flush();
  return { host, onAuthError };
};

describe('PayoutAccountPanel: masked view', () => {
  it('loads the account by user id and shows only the masked number', async () => {
    const fetch = vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    const { host } = await render();
    expect(fetch).toHaveBeenCalledWith('u-owner1');
    expect(host.querySelector('[data-testid="masked-account"]')?.textContent).toBe('XXXXXX7890');
    expect(host.textContent).toContain('HDFC0001234');
    expect(host.textContent).toContain('Ram Singh');
    expect(host.textContent).not.toContain(FULL);
    expect(host.textContent).toContain('Not verified yet');
  });

  it('shows a UPI id and no reveal button for UPI', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account({ method: 'UPI', upiId: 'kitchen1@upi', accountLast4: null, accountMasked: null, ifsc: null, bankName: null })));
    const { host } = await render();
    expect(host.textContent).toContain('kitchen1@upi');
    expect(byText('button', /Reveal full account number/, host)).toBeUndefined();
  });

  it('says "No payout details" when nothing is saved', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(null));
    const { host } = await render();
    expect(host.textContent).toContain('No payout details');
    expect(byText('button', /Reveal/, host)).toBeUndefined();
    expect(host.querySelector('button[aria-label^="Add payout details"]')).not.toBeNull();
  });

  it('a restaurant without an owner login says so and does not call the server', async () => {
    const fetch = vi.spyOn(apiService, 'fetchPayoutAccount');
    const { host } = await render({ userId: undefined });
    expect(fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('no owner login');
  });

  it('starts from the account it is given without a request', async () => {
    const fetch = vi.spyOn(apiService, 'fetchPayoutAccount');
    const { host } = await render({ initial: account() });
    expect(fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('XXXXXX7890');
  });

  it('shows the error plainly and retries', async () => {
    const fetch = vi.spyOn(apiService, 'fetchPayoutAccount').mockRejectedValueOnce(new ApiError(500, 'Payout details are unavailable.')).mockResolvedValue(result(account()));
    const { host, onAuthError } = await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Payout details are unavailable.');
    expect(onAuthError).toHaveBeenCalled();
    await click(byText('button', 'Try again', host));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('XXXXXX7890');
  });
});

describe('PayoutAccountPanel: verify', () => {
  it('toggles verification through the server and shows the answer', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    const verify = vi.spyOn(apiService, 'setPayoutVerified').mockResolvedValue(result(account({ verifiedAt: '2026-10-07T04:00:00.000Z', verifiedBy: 'admin1' })));
    const { host } = await render();
    const toggle = host.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await click(toggle);
    await flush();
    expect(verify).toHaveBeenCalledWith('u-owner1', true);
    expect((host.querySelector('button[role="switch"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('Verified');
  });

  it('a refused verify shows the server message and keeps the old state', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    vi.spyOn(apiService, 'setPayoutVerified').mockRejectedValue(new ApiError(404, 'This partner has not saved payout details yet.', 'NO_PAYOUT_ACCOUNT'));
    const { host } = await render();
    await click(host.querySelector('button[role="switch"]'));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('has not saved payout details');
    expect((host.querySelector('button[role="switch"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
  });
});

describe('PayoutAccountPanel: reveal the full account number', () => {
  it('asks first (audit-logged), shows the number once, hides it when closed', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    const reveal = vi.spyOn(apiService, 'revealPayoutAccount').mockResolvedValue(parseReveal(rawReveal())!);
    const { host } = await render();
    await click(byText('button', /Reveal full account number/, host));
    const confirmDialog = document.querySelector('[role="alertdialog"]')!;
    expect(confirmDialog.textContent).toContain('audit log');
    expect(reveal).not.toHaveBeenCalled(); // nothing is shown or fetched before the admin agrees
    expect(document.body.textContent).not.toContain(FULL);

    await click(byText('button', 'Reveal and log it', document.body as any));
    await flush();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith('u-owner1');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('[data-testid="revealed-number"]')?.textContent).toBe(FULL);

    await click(byText('button', 'Close and hide', document.body as any));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain(FULL);
    expect(host.textContent).toContain('XXXXXX7890'); // back to the masked view
  });

  it('Escape closes the reveal and hides the number', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    vi.spyOn(apiService, 'revealPayoutAccount').mockResolvedValue(parseReveal(rawReveal())!);
    const { host } = await render();
    await click(byText('button', /Reveal full account number/, host));
    await click(byText('button', 'Reveal and log it', document.body as any));
    await flush();
    expect(document.body.textContent).toContain(FULL);
    await import('react').then(({ act }) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }));
    expect(document.body.textContent).not.toContain(FULL);
  });

  it('cancelling the question reveals nothing and never calls the server', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    const reveal = vi.spyOn(apiService, 'revealPayoutAccount');
    const { host } = await render();
    await click(byText('button', /Reveal full account number/, host));
    await click(byText('button', 'Cancel', document.body as any));
    await flush();
    expect(reveal).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(FULL);
  });

  it('a failed reveal shows the server message and nothing is shown', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    vi.spyOn(apiService, 'revealPayoutAccount').mockRejectedValue(new ApiError(503, 'Payout encryption is not configured on the server.', 'PAYOUT_ENCRYPTION_NOT_CONFIGURED'));
    const { host } = await render();
    await click(byText('button', /Reveal full account number/, host));
    await click(byText('button', 'Reveal and log it', document.body as any));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('encryption is not configured');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('the revealed number does not survive the panel being removed', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    vi.spyOn(apiService, 'revealPayoutAccount').mockResolvedValue(parseReveal(rawReveal())!);
    const { host } = await render();
    await click(byText('button', /Reveal full account number/, host));
    await click(byText('button', 'Reveal and log it', document.body as any));
    await flush();
    expect(document.body.textContent).toContain(FULL);
    await unmount();
    expect(document.body.textContent).not.toContain(FULL);
  });
});

describe('PayoutAccountPanel: edit', () => {
  it('validates before sending, then saves and forgets the typed number', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(account()));
    const save = vi.spyOn(apiService, 'savePayoutAccount').mockResolvedValue(result(account({ accountLast4: '1111', accountMasked: 'XXXXXX1111' })));
    const { host } = await render();
    await click(host.querySelector('button[aria-label^="Edit payout details"]'));
    const number = host.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(number.value).toBe(''); // the stored number is never put in the form
    expect(host.textContent).toContain('cannot be shown here');
    await click(byText('button', 'Save payout details', host));
    expect(save).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Enter the full account number');
    await type(number, '12345');
    await click(byText('button', 'Save payout details', host));
    expect(save).not.toHaveBeenCalled();
    expect(host.textContent).toContain('6 to 20 digits');
    await type(number, '4444 5555 1111');
    await click(byText('button', 'Save payout details', host));
    await flush();
    expect(save).toHaveBeenCalledWith('u-owner1', { method: 'BANK', accountHolder: 'Ram Singh', accountNumber: '444455551111', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' });
    expect(host.querySelector('[data-testid="masked-account"]')?.textContent).toBe('XXXXXX1111');
    expect(host.textContent).not.toContain('444455551111');
    await click(host.querySelector('button[aria-label^="Edit payout details"]'));
    expect((host.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value).toBe('');
  });

  it('switches to UPI and shows the server refusal', async () => {
    vi.spyOn(apiService, 'fetchPayoutAccount').mockResolvedValue(result(null));
    const save = vi.spyOn(apiService, 'savePayoutAccount').mockRejectedValue(new ApiError(400, 'That does not look like a UPI id (for example name@okhdfcbank).', 'BAD_REQUEST', 'upiId'));
    const { host } = await render();
    await click(host.querySelector('button[aria-label^="Add payout details"]'));
    const method = host.querySelector('select') as HTMLSelectElement;
    await type(method, 'UPI');
    const upi = host.querySelector('input[placeholder="name@okhdfcbank"]') as HTMLInputElement;
    await type(upi, 'bad');
    await click(byText('button', 'Save payout details', host));
    expect(save).not.toHaveBeenCalled(); // caught on this side first
    await type(upi, 'ok@upi');
    await click(byText('button', 'Save payout details', host));
    await flush();
    expect(save).toHaveBeenCalledWith('u-owner1', { method: 'UPI', upiId: 'ok@upi' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('does not look like a UPI id');
  });
});
