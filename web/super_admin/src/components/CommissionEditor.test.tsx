// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommissionEditor } from './CommissionEditor';
import { apiService } from '../services/api';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';

afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

const render = (commissionType: any, commissionValue: any) => {
  const onSaved = vi.fn(); const onAuthError = vi.fn();
  return { onSaved, onAuthError, element: <CommissionEditor id="v1" name="Sharma Dhaba" commissionType={commissionType} commissionValue={commissionValue} onSaved={onSaved} onAuthError={onAuthError} /> };
};

describe('CommissionEditor', () => {
  it('says what is set: own, default, or not reported', async () => {
    let r = render('PERCENT', 12.5); let host = await mount(r.element);
    expect(host.textContent).toContain('12.5% (this restaurant)');
    await unmount();
    r = render(null, null); host = await mount(r.element);
    expect(host.textContent).toContain('Default (global setting)');
    await unmount();
    r = render(undefined, undefined); host = await mount(r.element);
    expect(host.textContent).toContain('Not reported by the server');
  });

  it('saves a flat commission and reports it to the parent', async () => {
    const set = vi.spyOn(apiService, 'setVendorCommission').mockResolvedValue({ commission: { type: 'FLAT', value: 6 }, staleDishes: 2, dishCount: 5, message: 'Saved. 2 dish prices are out of date: run "Recalculate prices".' });
    const r = render(null, null); await mount(r.element);
    await click(byText('button', 'Change')!);
    await type(byId('commission-mode-v1'), 'FLAT');
    await type(byId('commission-value-v1'), '6');
    await click(byText('button', 'Save commission')!);
    await flush();
    expect(set).toHaveBeenCalledWith('v1', { type: 'FLAT', value: 6 });
    expect(r.onSaved).toHaveBeenCalledWith('v1', { type: 'FLAT', value: 6 });
    expect(document.body.textContent).toContain('2 dish prices are out of date: run "Recalculate prices"'); // the server's own words
  });

  it('refuses bad numbers and shows the server error plainly', async () => {
    const set = vi.spyOn(apiService, 'setVendorCommission').mockRejectedValue(new Error('Commission is too high.'));
    const r = render('PERCENT', 10); await mount(r.element);
    await click(byText('button', 'Change')!);
    await type(byId('commission-value-v1'), '150');
    await click(byText('button', 'Save commission')!);
    expect(set).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('cannot be more than 100');
    await type(byId('commission-value-v1'), '12');
    await click(byText('button', 'Save commission')!);
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Commission is too high.');
    expect(r.onSaved).not.toHaveBeenCalled();
  });

  it('"Use the default" sends nulls', async () => {
    const set = vi.spyOn(apiService, 'setVendorCommission').mockResolvedValue({ commission: { type: null, value: null }, staleDishes: 0, dishCount: 0, message: 'Saved.' });
    const r = render('PERCENT', 10); await mount(r.element);
    await click(byText('button', 'Change')!);
    await type(byId('commission-mode-v1'), 'INHERIT');
    await click(byText('button', 'Save commission')!);
    await flush();
    expect(set).toHaveBeenCalledWith('v1', { type: null, value: null });
  });
});
