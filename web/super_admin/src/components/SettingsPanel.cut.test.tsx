// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import { apiService } from '../services/api';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';
import { rawProviders, settingView } from '../test/fixtures';
import { parseProviders } from '../lib/financeParse';

const FEES = { baseFee: 25, lines: [], extraRestaurantFee: 15, freeFeeAbove: 0, smallOrderBelow: 0, smallOrderFee: 0, gstOnFeesPercent: 18, gstOnFoodPercent: 5 };
let save: ReturnType<typeof vi.spyOn>;
let stored: Record<string, unknown>;

beforeEach(() => {
  stored = { type: 'PERCENT', value: 10 };
  vi.spyOn(apiService, 'fetchSettings').mockImplementation(async (group) => settingView(group, (group === 'fees' ? { ...FEES } : group === 'commission' ? { ...stored } : group === 'settlement' ? { time: '22:00', mode: 'MANUAL_PAYOUT', autoCreate: true, holdDays: 0 } : { step: 1 }) as any) as any);
  vi.spyOn(apiService, 'fetchPayoutProviders').mockResolvedValue(parseProviders(rawProviders())!);
  save = vi.spyOn(apiService, 'saveSettings').mockImplementation(async (_g, value) => ({ value, view: null, changed: true, recalculateRecommended: true, message: 'Saved. Existing dish prices keep their old value until you run "Recalculate prices".' })) as any;
});
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = async () => { await mount(<SettingsPanel onAuthError={vi.fn()} />); await flush(); };
const saveButton = () => byText('button', 'Save', document.querySelector('section[aria-label="Default commission"]')!) as HTMLButtonElement;
const card = () => document.querySelector('section[aria-label="Default commission"]') as HTMLElement;

describe('Settings -> Default commission: Cut from sale (Docs/26)', () => {
  it('offers the third option, explains it and shows a live example', async () => {
    await render();
    const options = Array.from((byId('commission-type') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['Percent of the restaurant price', 'Flat rupee amount per dish', 'Cut from sale (%)']);
    expect(card().textContent).toContain('Now: 10%.');
    await type(byId('commission-type'), 'CUT');
    await type(byId('commission-value'), '30');
    expect(card().querySelector('[data-testid="cut-explain"]')?.textContent).toContain('Kraveo keeps this percent of that price');
    expect(card().querySelector('[data-testid="cut-example"]')?.textContent).toContain('Menu price ₹115, cut 30%: the restaurant gets ₹80.50, Kraveo keeps ₹34.50.');
    expect(card().querySelector('label[for="commission-value"]')?.textContent).toContain('Cut from sale (%)');
    expect(card().querySelector('[data-testid="commission-summary"]')?.textContent).toBe('Now: 30% of the sale.');
  });

  it('refuses over 90 percent and 3 decimals; saves type CUT with the value', async () => {
    await render();
    await type(byId('commission-type'), 'CUT');
    for (const [bad, message] of [['90.5', 'cannot be more than 90%'], ['100', 'cannot be more than 90%'], ['12.345', 'at most 2 decimals'], ['', 'Enter the cut percent']]) {
      await type(byId('commission-value'), bad); await click(saveButton());
      expect(card().textContent).toContain(message);
    }
    expect(save).not.toHaveBeenCalled();
    await type(byId('commission-value'), '20');
    await click(saveButton());
    await flush();
    expect(save).toHaveBeenCalledWith('commission', { type: 'CUT', value: 20 });
    expect(document.body.textContent).toContain('Recalculate prices');
  });

  it('loads a stored CUT setting and keeps unknown fields when saving', async () => {
    stored = { type: 'CUT', value: 25, note: 'keep me' };
    await render();
    expect((byId('commission-type') as HTMLSelectElement).value).toBe('CUT');
    expect((byId('commission-value') as HTMLInputElement).value).toBe('25');
    expect(card().textContent).toContain('Now: 25% of the sale.');
    await type(byId('commission-value'), '26');
    await click(saveButton());
    await flush();
    expect(save).toHaveBeenCalledWith('commission', { type: 'CUT', value: 26, note: 'keep me' });
  });

  it('an unknown stored type falls back to Percent instead of crashing', async () => {
    stored = { type: 'WEIRD', value: 'abc' };
    await render();
    expect((byId('commission-type') as HTMLSelectElement).value).toBe('PERCENT');
    expect((byId('commission-value') as HTMLInputElement).value).toBe('');
  });
});
