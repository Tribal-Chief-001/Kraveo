// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { SettingsPanel } from './SettingsPanel';
import { apiService, ApiError } from '../services/api';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';
import { rawProviders, settingView } from '../test/fixtures';
import { parseProviders } from '../lib/financeParse';

const FEES = { baseFee: 25, lines: [], extraRestaurantFee: 15, freeFeeAbove: 0, smallOrderBelow: 0, smallOrderFee: 0, gstOnFeesPercent: 18, gstOnFoodPercent: 5, futureField: 'keep me' };
const SETTLEMENT = { time: '22:00', mode: 'MANUAL_PAYOUT', autoCreate: true, holdDays: 0 };
let save: ReturnType<typeof vi.spyOn>;
let recalc: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(apiService, 'fetchSettings').mockImplementation(async (group) => settingView(group, (
    group === 'fees' ? { ...FEES } : group === 'commission' ? { type: 'PERCENT', value: 10 } : group === 'settlement' ? { ...SETTLEMENT } : { step: 1 }) as any) as any);
  vi.spyOn(apiService, 'fetchPayoutProviders').mockResolvedValue(parseProviders(rawProviders())!);
  save = vi.spyOn(apiService, 'saveSettings').mockImplementation(async (_g, value) => ({ value, view: null, changed: true, recalculateRecommended: false, message: 'Saved.' })) as any;
  recalc = vi.spyOn(apiService, 'recalculatePrices') as any;
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = async () => { const onAuthError = vi.fn(); const host = await mount(<SettingsPanel onAuthError={onAuthError} />); await flush(); return { host, onAuthError }; };
const result = (over: Record<string, unknown>) => ({ dryRun: true, applied: false, changed: 0, total: 0, truncated: false, samples: [], ...over }) as any;
const saveButton = (card: string) => byText('button', 'Save', document.querySelector(`section[aria-label="${card}"]`)!) as HTMLButtonElement;

describe('fees', () => {
  it('loads the values from the server and Save is off until something changes', async () => {
    await render();
    expect((byId('fee-base') as HTMLInputElement).value).toBe('25');
    expect((byId('fee-gst-fees') as HTMLInputElement).value).toBe('18');
    expect(saveButton('Fees').disabled).toBe(true);
  });

  it('saves the whole group, keeping fields the dashboard does not know', async () => {
    await render();
    await type(byId('fee-base'), '30');
    await click(saveButton('Fees'));
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBe('fees');
    expect(save.mock.calls[0][1]).toMatchObject({ baseFee: 30, extraRestaurantFee: 15, lines: [], futureField: 'keep me' });
  });

  it('never sends a bad number', async () => {
    await render();
    for (const bad of ['-1', '25.555', 'x', '']) {
      await type(byId('fee-base'), bad);
      await click(saveButton('Fees'));
    }
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Fix the highlighted fields');
  });

  it('named lines must add up to the all-in fee', async () => {
    await render();
    await click(byText('button', 'Add a line')!);
    await click(byText('button', 'Add a line')!);
    const labels = Array.from(document.querySelectorAll('input[id^="fee-line-label-"]'));
    const amounts = Array.from(document.querySelectorAll('input[id^="fee-line-amount-"]'));
    await type(labels[0], 'Delivery'); await type(amounts[0], '15');
    await type(labels[1], 'Packaging'); await type(amounts[1], '9');
    expect(document.body.textContent).toContain('Lines add up to ₹24');
    await click(saveButton('Fees'));
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('must be equal');
    await type(amounts[1], '10');
    await click(saveButton('Fees'));
    await flush();
    expect(save.mock.calls[0][1]).toMatchObject({ baseFee: 25, lines: [{ key: 'delivery', label: 'Delivery', amount: 15 }, { key: 'packaging', label: 'Packaging', amount: 10 }] });
  });

  it('double click saves once; a failed save shows the server message and keeps the form', async () => {
    let reject: (e: Error) => void = () => {};
    save.mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const { onAuthError } = await render();
    await type(byId('fee-extra'), '20');
    const button = saveButton('Fees');
    await click(button); await click(button);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new ApiError(400, 'Fee is above the allowed maximum.')); });
    await flush();
    expect(document.querySelector('section[aria-label="Fees"] [role="alert"]')?.textContent).toContain('above the allowed maximum');
    expect((byId('fee-extra') as HTMLInputElement).value).toBe('20');
    expect(onAuthError).toHaveBeenCalled();
  });
});

describe('commission and rounding', () => {
  it('commission: percent over 100 is refused; a valid change is saved as type and value', async () => {
    await render();
    await type(byId('commission-value'), '101');
    await click(saveButton('Default commission'));
    expect(save).not.toHaveBeenCalled();
    await type(byId('commission-type'), 'FLAT');
    await type(byId('commission-value'), '7.5');
    await click(saveButton('Default commission'));
    await flush();
    expect(save).toHaveBeenCalledWith('commission', { type: 'FLAT', value: 7.5 });
  });

  it('rounding saves the chosen step', async () => {
    await render();
    const radios = Array.from(document.querySelectorAll('input[name="rounding-step"]')) as HTMLInputElement[];
    expect(radios).toHaveLength(5); // 0, 1, 2, 5, 10 like the server
    const radio = radios[3];
    await click(radio);
    await click(saveButton('Price rounding'));
    await flush();
    expect(save).toHaveBeenCalledWith('rounding', { step: 5 });
  });

  it('a group that fails to load shows a plain error with Try again, the others still work', async () => {
    (apiService.fetchSettings as any).mockImplementation(async (group: string) => { if (group === 'rounding') throw new ApiError(500, 'Rounding settings are unavailable.'); return settingView(group, group === 'fees' ? { ...FEES } : { type: 'PERCENT', value: 10 }); });
    await render();
    expect(document.querySelector('section[aria-label="Price rounding"] [role="alert"]')?.textContent).toContain('Rounding settings are unavailable.');
    expect(byId('fee-base')).not.toBeNull();
  });
});

describe('recalculate prices', () => {
  it('previews first, applies only after a confirm, and says how many changed', async () => {
    recalc.mockResolvedValueOnce(result({ changed: 12, total: 80, samples: [{ name: 'Paneer Roll', vendorName: 'Sharma Dhaba', from: 112, to: 110 }] }));
    await render();
    const apply = () => byText('button', /^Recalculate prices/, document.querySelector('section[aria-label="Recalculate prices"]')!) as HTMLButtonElement;
    expect(apply().disabled).toBe(true); // nothing previewed yet
    await click(byText('button', 'Preview changes')!);
    expect(recalc).toHaveBeenCalledWith(true);
    expect(document.querySelector('[data-testid="recalc-preview"]')?.textContent).toContain('12 of 80 dishes would change price.');
    expect(document.querySelector('[data-testid="recalc-preview"]')?.textContent).toContain('₹112 → ₹110');
    expect(document.querySelector('[data-testid="recalc-preview"]')?.textContent).toContain('Paneer Roll (Sharma Dhaba)');
    recalc.mockResolvedValueOnce(result({ changed: 12, total: 80, dryRun: false, applied: true }));
    await click(apply());
    expect(recalc).toHaveBeenCalledTimes(1); // confirm still open
    await click(byText('button', 'Cancel')!);
    expect(recalc).toHaveBeenCalledTimes(1);
    await click(apply());
    await click(byText('button', 'Recalculate prices', document.querySelector('[role="alertdialog"]')!)!);
    await flush();
    expect(recalc).toHaveBeenCalledTimes(2);
    expect(recalc).toHaveBeenLastCalledWith(false);
    expect(document.body.textContent).toContain('12 dishes updated');
  });

  it('refuses to apply when the preview has no count or zero changes', async () => {
    recalc.mockResolvedValueOnce(result({ changed: null, total: null }));
    await render();
    const apply = () => byText('button', /^Recalculate prices/, document.querySelector('section[aria-label="Recalculate prices"]')!) as HTMLButtonElement;
    await click(byText('button', 'Preview changes')!);
    expect(document.body.textContent).toContain('did not say how many dishes');
    expect(apply().disabled).toBe(true);
    recalc.mockResolvedValueOnce(result({ changed: 0, total: 80 }));
    await click(byText('button', 'Preview changes')!);
    expect(document.body.textContent).toContain('No dish would change');
    expect(apply().disabled).toBe(true);
  });

  it('is blocked while commission or rounding has unsaved edits, and a save clears an old preview', async () => {
    recalc.mockResolvedValue(result({ changed: 2, total: 5 }));
    await render();
    await click(byText('button', 'Preview changes')!);
    expect(document.querySelector('[data-testid="recalc-preview"]')).not.toBeNull();
    await type(byId('commission-value'), '12');
    expect((byText('button', 'Preview changes') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('Save your commission or rounding changes first');
    await click(saveButton('Default commission'));
    await flush();
    expect(document.querySelector('[data-testid="recalc-preview"]')).toBeNull();
    expect((byText('button', 'Preview changes') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a failed preview shows the server message', async () => {
    recalc.mockRejectedValueOnce(new ApiError(500, 'Recalculation is not available.'));
    await render();
    await click(byText('button', 'Preview changes')!);
    expect(document.body.textContent).toContain('Recalculation is not available.');
  });
});

describe('real response details', () => {
  it('recalculateRecommended from the server shows the recalculate prompt until prices are recalculated', async () => {
    (save as any).mockImplementation(async (_g: string, value: any) => ({ value, view: null, changed: true, recalculateRecommended: true, message: 'Saved. Existing dish prices keep their old value until you run "Recalculate prices".' }));
    recalc.mockResolvedValueOnce(result({ changed: 3, total: 9 })).mockResolvedValueOnce(result({ changed: 3, total: 9, dryRun: false, applied: true }));
    await render();
    expect(document.body.textContent).not.toContain('keep their old value until you recalculate');
    await type(byId('commission-value'), '15');
    await click(saveButton('Default commission'));
    await flush();
    expect(document.body.textContent).toContain('Existing dish prices keep their old value until you recalculate');
    expect(document.body.textContent).toContain('Recalculate prices'); // the saved message is also toasted
    await click(byText('button', 'Preview changes')!);
    await click(byText('button', /^Recalculate prices \(3\)/)!);
    await click(byText('button', 'Recalculate prices', document.querySelector('[role="alertdialog"]')!)!);
    await flush();
    expect(document.body.textContent).not.toContain('keep their old value until you recalculate');
  });

  it('a save that changed nothing does not ask for a recalculation', async () => {
    (save as any).mockImplementation(async (_g: string, value: any) => ({ value, view: null, changed: false, recalculateRecommended: false, message: 'Saved.' }));
    await render();
    await type(byId('commission-value'), '10.0');
    await click(saveButton('Default commission'));
    await flush();
    expect(document.body.textContent).not.toContain('keep their old value until you recalculate');
  });

  it('a truncated change list is announced; the count stays complete', async () => {
    recalc.mockResolvedValueOnce(result({ changed: 640, total: 900, truncated: true, samples: [{ name: 'A', vendorName: '', from: 1, to: 2 }] }));
    await render();
    await click(byText('button', 'Preview changes')!);
    const box = document.querySelector('[data-testid="recalc-preview"]')!.textContent!;
    expect(box).toContain('640 of 900 dishes would change price.');
    expect(box).toContain('Only the first changes are listed');
  });

  it('existing fee line keys are sent back unchanged when only the label is renamed', async () => {
    (apiService.fetchSettings as any).mockImplementation(async (group: string) => settingView(group, group === 'fees' ? { ...FEES, lines: [{ key: 'delivery_fee', label: 'Delivery', amount: 15 }, { key: 'rest', label: 'Rest', amount: 10 }] } : group === 'commission' ? { type: 'PERCENT', value: 10 } : { step: 1 }));
    await render();
    const labels = Array.from(document.querySelectorAll('input[id^="fee-line-label-"]'));
    await type(labels[0], 'Rider charge');
    await click(saveButton('Fees'));
    await flush();
    expect(save.mock.calls[0][1]).toMatchObject({ lines: [{ key: 'delivery_fee', label: 'Rider charge', amount: 15 }, { key: 'rest', label: 'Rest', amount: 10 }] });
  });
});

describe('settlements', () => {
  const saveSettlement = () => saveButton('Settlements');
  const settlementSaves = () => save.mock.calls.filter((call) => call[0] === 'settlement');

  it('loads the server values; Save is off until something changes', async () => {
    await render();
    expect((byId('settle-time') as HTMLInputElement).value).toBe('22:00');
    expect((byId('settle-hold') as HTMLInputElement).value).toBe('0');
    expect((document.querySelector('input[name="settle-mode"]:checked') as HTMLInputElement | null)?.parentElement?.textContent).toContain('Manual payout');
    expect(document.querySelector('section[aria-label="Settlements"] button[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    expect(saveSettlement().disabled).toBe(true);
  });

  it('automatic payout is disabled with the server reason while the provider is not enabled', async () => {
    await render();
    const auto = document.querySelectorAll('input[name="settle-mode"]')[1] as HTMLInputElement;
    expect(auto.disabled).toBe(true);
    expect(document.getElementById('settle-auto-note')!.textContent).toContain('RazorpayX payouts are not configured.');
    expect(document.getElementById('settle-auto-note')!.textContent).toContain('Use manual payout');
  });

  it('automatic payout can be chosen and saved when the provider is enabled', async () => {
    vi.spyOn(apiService, 'fetchPayoutProviders').mockResolvedValue(parseProviders(rawProviders(true))!);
    await render();
    const auto = document.querySelectorAll('input[name="settle-mode"]')[1] as HTMLInputElement;
    expect(auto.disabled).toBe(false);
    await click(auto);
    await click(saveSettlement());
    await flush();
    expect(settlementSaves()).toHaveLength(1);
    expect(settlementSaves()[0][1]).toEqual({ time: '22:00', mode: 'AUTO_PAYOUT', autoCreate: true, holdDays: 0 });
  });

  it('saves exactly time, mode, autoCreate and holdDays (nothing else)', async () => {
    await render();
    await type(byId('settle-time'), '21:15');
    await type(byId('settle-hold'), '3');
    await click(document.querySelector('section[aria-label="Settlements"] button[role="switch"]'));
    await click(saveSettlement());
    await flush();
    expect(settlementSaves()[0][1]).toEqual({ time: '21:15', mode: 'MANUAL_PAYOUT', autoCreate: false, holdDays: 3 });
  });

  it('never sends a bad time or hold days', async () => {
    await render();
    for (const [time, hold] of [['25:00', '0'], ['9:00', '0'], ['22:00', '31'], ['22:00', '-1'], ['22:00', '1.5'], ['22:00', '']]) {
      await type(byId('settle-time'), time);
      await type(byId('settle-hold'), hold);
      await click(saveSettlement());
    }
    expect(settlementSaves()).toHaveLength(0);
    expect(document.querySelector('section[aria-label="Settlements"]')!.textContent).toContain('HH:MM');
    expect(document.querySelector('section[aria-label="Settlements"]')!.textContent).toContain('0 to 30');
  });

  it('shows the server refusal in plain words and keeps the form', async () => {
    (save as any).mockImplementation(async (group: any) => { if (group === 'settlement') throw new ApiError(400, 'Automatic payout is not available yet: no payout provider is connected. Use MANUAL_PAYOUT.', 'BAD_REQUEST', 'mode'); return { value: {}, view: null, changed: true, recalculateRecommended: false, message: '' }; });
    await render();
    await type(byId('settle-hold'), '2');
    await click(saveSettlement());
    await flush();
    const card = document.querySelector('section[aria-label="Settlements"]')!;
    expect(card.querySelector('[role="alert"]')?.textContent).toContain('Automatic payout is not available yet');
    expect((byId('settle-hold') as HTMLInputElement).value).toBe('2');
  });

  it('if the providers cannot be checked it says so and leaves the choice to the server', async () => {
    vi.spyOn(apiService, 'fetchPayoutProviders').mockRejectedValue(new ApiError(500, 'down'));
    await render();
    expect((document.querySelectorAll('input[name="settle-mode"]')[1] as HTMLInputElement).disabled).toBe(false);
    expect(document.getElementById('settle-auto-note')!.textContent).toContain('could not be checked');
  });

  it('a server that sends no settlement values leaves the fields empty instead of inventing them', async () => {
    (apiService.fetchSettings as any).mockImplementation(async (group: string) => settingView(group, group === 'fees' ? { ...FEES } : group === 'commission' ? { type: 'PERCENT', value: 10 } : { step: 1 }) as any);
    await render();
    expect((byId('settle-time') as HTMLInputElement).value).toBe('');
    expect((byId('settle-hold') as HTMLInputElement).value).toBe('');
    await click(saveSettlement());
    expect(settlementSaves()).toHaveLength(0);
  });
});
