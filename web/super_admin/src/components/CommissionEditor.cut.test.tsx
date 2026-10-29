// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommissionEditor } from './CommissionEditor';
import { apiService } from '../services/api';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';
import { parseVendorCommission } from '../lib/catalogParse';
import { CUT_VENDOR_SAVED } from '../test/cutFixtures';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = (commissionType: any, commissionValue: any) => {
  const onSaved = vi.fn(); const onAuthError = vi.fn();
  return { onSaved, onAuthError, element: <CommissionEditor id="v1" name="Cut Kitchen" commissionType={commissionType} commissionValue={commissionValue} onSaved={onSaved} onAuthError={onAuthError} /> };
};

describe('CommissionEditor: Cut from sale (Docs/26)', () => {
  it('prints a CUT rule in plain words', async () => {
    const host = await mount(render('CUT', 30).element);
    expect(host.textContent).toContain('30% of the sale (this restaurant)');
  });

  it('offers "Cut from sale (%)" as a third option with an explanation and the live example', async () => {
    await mount(render(null, null).element);
    await click(byText('button', 'Change')!);
    const options = Array.from((byId('commission-mode-v1') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['Use the default', 'Percent', 'Flat rupees per dish', 'Cut from sale (%)']);
    await type(byId('commission-mode-v1'), 'CUT');
    expect(document.querySelector('label[for="commission-value-v1"]')?.textContent).toContain('Cut from sale (%)');
    expect(byId('commission-cut-v1')?.textContent).toContain('The customer pays the menu price. Kraveo keeps this percent of that price and pays the restaurant the rest.');
    // before a number is typed the example uses 30%
    expect(document.querySelector('[data-testid="cut-example"]')?.textContent).toBe('Example: Menu price ₹115, cut 30%: the restaurant gets ₹80.50, Kraveo keeps ₹34.50.');
    await type(byId('commission-value-v1'), '20');
    expect(document.querySelector('[data-testid="cut-example"]')?.textContent).toBe('Example: Menu price ₹115, cut 20%: the restaurant gets ₹92, Kraveo keeps ₹23.');
    await type(byId('commission-value-v1'), '95');
    expect(document.querySelector('[data-testid="cut-example"]')?.textContent).toContain('cut 30%'); // never NaN, falls back to the sample
  });

  it('the explanation is only shown for CUT', async () => {
    await mount(render('PERCENT', 10).element);
    await click(byText('button', 'Change')!);
    expect(document.querySelector('[data-testid="cut-explain"]')).toBeNull();
  });

  it('refuses 91 (like the server) and does not call it; saves 30 and reports CUT to the parent', async () => {
    const set = vi.spyOn(apiService, 'setVendorCommission').mockResolvedValue(parseVendorCommission(CUT_VENDOR_SAVED, { type: 'CUT', value: 30 }));
    const r = render(null, null); await mount(r.element);
    await click(byText('button', 'Change')!);
    await type(byId('commission-mode-v1'), 'CUT');
    await type(byId('commission-value-v1'), '91');
    await click(byText('button', 'Save commission')!);
    expect(set).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('A cut from the sale cannot be more than 90%.');
    await type(byId('commission-value-v1'), '30');
    await click(byText('button', 'Save commission')!);
    await flush();
    expect(set).toHaveBeenCalledWith('v1', { type: 'CUT', value: 30 });
    expect(r.onSaved).toHaveBeenCalledWith('v1', { type: 'CUT', value: 30 });
    expect(document.body.textContent).toContain('30% of the sale');
  });

  it('opens an existing CUT rule with its value filled in', async () => {
    await mount(render('CUT', 12.5).element);
    await click(byText('button', 'Change')!);
    expect((byId('commission-mode-v1') as HTMLSelectElement).value).toBe('CUT');
    expect((byId('commission-value-v1') as HTMLInputElement).value).toBe('12.5');
  });
});
