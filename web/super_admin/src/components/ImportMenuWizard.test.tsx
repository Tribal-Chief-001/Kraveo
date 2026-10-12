// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

const saved: Array<{ blob: Blob; filename: string }> = [];
vi.mock('../lib/download', () => ({ saveBlob: (blob: Blob, filename: string) => { saved.push({ blob, filename }); } }));

import { ImportMenuWizard, buildViewRows, tally } from './ImportMenuWizard';
import { ApiError, ImportInvalidError, apiService } from '../services/api';
import { parseImportReport } from '../lib/catalogBulkParse';
import { parseMenuCsv } from '../lib/menuCsv';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';
import { importApplied, importDryRun, importDryRunGood, importInvalid } from '../test/taxonomyFixtures';

const vendors = [{ id: 'v1', name: 'Sharma Dhaba' }, { id: 'v2', name: 'Chai Point' }] as any[];
const report = (body: unknown) => parseImportReport(body)!;

const FIVE = [
  'name,category,price,veg',
  'Paneer Tikka,Starters,150,yes',
  'chicken biryani,Biryani,190,no',
  'Masala Chai,Beverages,20,yes',
  'Bad One,Nope,0,yes',
  'Masala chai,Beverages,20,yes',
].join('\n');
const THREE = FIVE.split('\n').slice(0, 4).join('\n');

const setup = async (over: Record<string, unknown> = {}) => {
  const props = { vendors, initialVendorId: 'v1', onClose: vi.fn(), onImported: vi.fn(), onAuthError: vi.fn(), ...over };
  const host = await mount(<ImportMenuWizard {...(props as any)} />);
  return { host, ...props };
};
const paste = (text: string) => type(byId('import-text'), text);
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const check = async () => { await click(byText('button', 'Check the menu', dialog())); await flush(); };
const importButton = () => Array.from(dialog().querySelectorAll('button')).find((b) => /^(Import \d+ dish|Nothing to import|Importing)/.test(b.textContent ?? '')) as HTMLButtonElement;
const rows = () => Array.from(dialog().querySelectorAll('ul[aria-label="Rows"] > li')) as HTMLElement[];

beforeEach(() => { saved.length = 0; });
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('step 1: the file', () => {
  it('starts with the restaurant from the filter, explains the columns and the 200 row limit, and needs text before it can check', async () => {
    await setup();
    expect((byId('import-vendor') as HTMLSelectElement).value).toBe('v1');
    expect(dialog().textContent).toContain('At most 200 dishes at a time');
    expect(dialog().textContent).toContain('The category must already exist in the Categories tab.');
    expect((byText('button', 'Check the menu', dialog()) as HTMLButtonElement).disabled).toBe(true);
    await paste('name,category,price\nTea,Beverages,10');
    expect((byText('button', 'Check the menu', dialog()) as HTMLButtonElement).disabled).toBe(false);
  });

  it('downloads the template with the expected header (UTF-8 with BOM so Excel reads it)', async () => {
    await setup();
    await click(byText('button', 'Download the template', dialog()));
    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toBe('kraveo-menu-template.csv');
    expect(saved[0].blob.type).toBe('text/csv;charset=utf-8');
    const bytes = new Uint8Array(await new Promise<ArrayBuffer>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(saved[0].blob); }));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toContain('name,category,vendorPrice,isVeg,description,imageUrl,isAvailable');
  });

  it('choosing a file reads it into the text box (and says so); the text can still be edited', async () => {
    await setup();
    const file = new File(['x'], 'menu.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => '﻿name;category;price\nTea;Beverages;10' });
    const input = document.querySelector('[data-testid="import-file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect((byId('import-text') as HTMLTextAreaElement).value).toContain('Tea;Beverages;10');
    expect(dialog().textContent).toContain('Loaded “menu.csv”');
  });

  it('a file over 400 KB is refused with a plain message', async () => {
    await setup();
    const file = new File([new Uint8Array(10)], 'huge.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'size', { value: 500 * 1024 });
    const input = document.querySelector('[data-testid="import-file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('A menu file can be at most 400 KB');
    expect((byId('import-text') as HTMLTextAreaElement).value).toBe('');
  });

  it('a restaurant must be chosen', async () => {
    const dry = vi.spyOn(apiService, 'importMenu');
    await setup({ initialVendorId: '' });
    await paste(THREE);
    await check();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe('Choose the restaurant this menu belongs to.');
    expect(dry).not.toHaveBeenCalled();
  });

  it('a file with a missing column or too many rows is explained and never sent', async () => {
    const dry = vi.spyOn(apiService, 'importMenu');
    await setup();
    await paste('name,price\nTea,10');
    await check();
    expect(dialog().textContent).toContain('This file cannot be imported yet:');
    expect(dialog().textContent).toContain('Missing: category');
    const big = `name,category,price\n${Array.from({ length: 201 }, (_, i) => `D${i},Snacks,10`).join('\n')}`;
    await paste(big);
    await check();
    expect(dialog().textContent).toContain('This file has 201 dishes, but at most 200 can be imported at a time.');
    expect(dry).not.toHaveBeenCalled();
  });
});

describe('step 2: the preview', () => {
  it('asks the server for a dry run with the parsed rows and shows create / skip / not valid with errors and the customer price', async () => {
    const dry = vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(importDryRun));
    await setup();
    await paste(FIVE);
    await check();
    expect(dry).toHaveBeenCalledTimes(1);
    expect(dry.mock.calls[0][0]).toBe('v1');
    expect(dry.mock.calls[0][1]).toEqual([
      { name: 'Paneer Tikka', category: 'Starters', vendorPrice: 150, isVeg: true },
      { name: 'chicken biryani', category: 'Biryani', vendorPrice: 190, isVeg: false },
      { name: 'Masala Chai', category: 'Beverages', vendorPrice: 20, isVeg: true },
      { name: 'Bad One', category: 'Nope', vendorPrice: 0, isVeg: true },
      { name: 'Masala chai', category: 'Beverages', vendorPrice: 20, isVeg: true },
    ]);
    expect(dry.mock.calls[0][2]).toEqual({ dryRun: true, onDuplicate: 'SKIP' });
    expect(dialog().textContent).toContain('Nothing has been saved yet.');
    const summary = dialog().querySelector('[data-testid="import-summary"]')!.textContent!;
    expect(summary).toContain('2 to add');
    expect(summary).toContain('1 skipped');
    expect(summary).toContain('2 not valid');
    const list = rows();
    expect(list).toHaveLength(5);
    expect(list[0].textContent).toContain('Paneer Tikka');
    expect(list[0].textContent).toContain('Add');
    expect(list[0].textContent).toContain('customer pays ₹150');
    expect(list[1].textContent).toContain('Skip');
    expect(list[1].textContent).toContain('Already on the menu, left as it is');
    expect(list[3].textContent).toContain('Pick a category from the list.');
    expect(list[3].textContent).toContain('The price must be more than 0.');
    expect(list[3].textContent).toContain('customer pays -');
    expect(list[4].textContent).toContain('This dish name is repeated in the file (first at row 3).');
    expect(list[3].textContent).toContain('Row 5');
  });

  it('"Import N dishes" is OFF while any row is not valid, with the reason', async () => {
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(importDryRun));
    await setup();
    await paste(FIVE);
    await check();
    expect(importButton().disabled).toBe(true);
    expect(importButton().textContent).toBe('Import 2 dishes');
    expect(dialog().textContent).toContain('2 rows are not valid, so nothing can be imported yet.');
  });

  it('with no invalid rows the button says how many dishes it will import and sends the real import', async () => {
    const calls: any[] = [];
    vi.spyOn(apiService, 'importMenu').mockImplementation(async (_v, _r, opts) => { calls.push(opts); return report(opts.dryRun ? importDryRunGood : importApplied); });
    const { onImported, host } = await setup();
    await paste(THREE);
    await check();
    expect(importButton().textContent).toBe('Import 2 dishes');
    expect(importButton().disabled).toBe(false);
    await click(importButton());
    await flush();
    expect(calls).toEqual([{ dryRun: true, onDuplicate: 'SKIP' }, { dryRun: false, onDuplicate: 'SKIP' }]);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(dialog().textContent).toContain('Imported: 2 added, 0 updated, 1 skipped.');
    expect(dialog().textContent).toContain('Sharma Dhaba: 2 added, 0 updated, 1 skipped.');
    expect(dialog().textContent).toContain('Paneer Tikka');
    expect(dialog().textContent).toContain('Masala Chai');
    expect(dialog().textContent).not.toContain('chicken biryani'); // skipped rows are not listed as imported
    expect(host.ownerDocument.body.textContent).toContain('Menu imported');
    await click(byText('button', 'Done', dialog()));
  });

  it('switching to "Update it" asks the server again with onDuplicate UPDATE', async () => {
    const dry = vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(importDryRunGood));
    await setup();
    await paste(THREE);
    await check();
    await click(dialog().querySelector('input[type="radio"][value="UPDATE"]'));
    await flush();
    expect(dry).toHaveBeenCalledTimes(2);
    expect(dry.mock.calls[1][2]).toEqual({ dryRun: true, onDuplicate: 'UPDATE' });
  });

  it('a double click on Import sends one real import', async () => {
    let release: (v: any) => void = () => {};
    const calls: boolean[] = [];
    vi.spyOn(apiService, 'importMenu').mockImplementation((_v, _r, opts) => {
      calls.push(opts.dryRun);
      return opts.dryRun ? Promise.resolve(report(importDryRunGood)) : new Promise((resolve) => { release = resolve; });
    });
    await setup();
    await paste(THREE);
    await check();
    await click(importButton());
    await click(importButton());
    expect(calls.filter((dryRun) => !dryRun)).toHaveLength(1);
    await act(async () => { release(report(importApplied)); });
    await flush();
  });

  it('a problem the dashboard found itself (a price that is not a number) blocks the import even if the server said create', async () => {
    const lenient = { data: { dryRun: true, applied: false, summary: { create: 2, update: 0, skip: 0, invalid: 0, total: 2 }, rows: [
      { index: 0, name: 'Tea', action: 'create', errors: [], computedPrice: 10 }, { index: 1, name: 'Coffee', action: 'create', errors: [], computedPrice: 15 }] } };
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(lenient));
    await setup();
    await paste('name,category,price\nTea,Beverages,10\nCoffee,Beverages,twelve');
    await check();
    expect(rows()[1].textContent).toContain('Not valid');
    expect(rows()[1].textContent).toContain('“twelve” is not a price.');
    expect(importButton().disabled).toBe(true);
  });

  it('rows with extra values (an unquoted comma) are blocked too', async () => {
    const ok = { data: { dryRun: true, applied: false, summary: { create: 1, update: 0, skip: 0, invalid: 0, total: 1 }, rows: [{ index: 0, name: 'Roll', action: 'create', errors: [], computedPrice: 50 }] } };
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(ok));
    await setup();
    await paste('name,category,price\nRoll, special,Snacks,50');
    await check();
    expect(rows()[0].textContent).toContain('more values than the header has columns');
    expect(importButton().disabled).toBe(true);
  });

  it('when every dish is already on the menu there is nothing to import', async () => {
    const allSkip = { data: { dryRun: true, applied: false, summary: { create: 0, update: 0, skip: 1, invalid: 0, total: 1 }, rows: [{ index: 0, name: 'Tea', action: 'skip', errors: [], computedPrice: 10, reason: 'DUPLICATE_EXISTS' }] } };
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(allSkip));
    await setup();
    await paste('name,category,price\nTea,Beverages,10');
    await check();
    expect(importButton().textContent).toBe('Nothing to import');
    expect(importButton().disabled).toBe(true);
    expect(dialog().textContent).toContain('Every dish is already on the menu');
  });

  it('the "Not valid" chip shows only the rows that need fixing', async () => {
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(importDryRun));
    await setup();
    await paste(FIVE);
    await check();
    await click(byText('button', /^Not valid \(2\)/, dialog()));
    expect(rows()).toHaveLength(2);
    expect(rows().every((r) => r.dataset.rowAction === 'invalid')).toBe(true);
  });

  it('Back returns to the file with the text still there', async () => {
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(importDryRunGood));
    await setup();
    await paste(THREE);
    await check();
    await click(byText('button', 'Back', dialog()));
    expect((byId('import-text') as HTMLTextAreaElement).value).toBe(THREE);
  });

  it('ignored columns are mentioned', async () => {
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(importDryRunGood));
    await setup();
    await paste('name,category,price,colour\nA,Starters,1,red');
    await check();
    expect(dialog().textContent).toContain('Columns that are not used and were ignored: colour.');
  });
});

describe('errors', () => {
  it('a refused dry run (too big, rate limit, session) is shown on step 1 and the session error is passed up', async () => {
    const failure = new ApiError(413, 'That file is too big.', 'PAYLOAD_TOO_LARGE');
    vi.spyOn(apiService, 'importMenu').mockRejectedValue(failure);
    const { onAuthError } = await setup();
    await paste(THREE);
    await check();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe('That file is too big.');
    expect(onAuthError).toHaveBeenCalledWith(failure);
    expect(dialog().textContent).toContain('Choose the file'); // still on step 1
  });

  it('IMPORT_INVALID on the real import: nothing was written, the server’s report replaces the preview and the import stays off', async () => {
    vi.spyOn(apiService, 'importMenu').mockImplementation(async (_v, _r, opts) => {
      if (opts.dryRun) return report(importDryRunGood);
      throw new ImportInvalidError(importInvalid.message, report(importInvalid), importInvalid as any);
    });
    const { onImported } = await setup();
    await paste(THREE);
    await check();
    await click(importButton());
    await flush();
    expect(onImported).not.toHaveBeenCalled();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('Nothing was imported. Fix them and try again.');
    expect(importButton().disabled).toBe(true);
  });

  it('a network failure during the import keeps the preview and says so', async () => {
    vi.spyOn(apiService, 'importMenu').mockImplementation(async (_v, _r, opts) => {
      if (opts.dryRun) return report(importDryRunGood);
      throw new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.', 'NETWORK');
    });
    await setup();
    await paste(THREE);
    await check();
    await click(importButton());
    await flush();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('unreachable');
    expect(importButton().disabled).toBe(false); // can try again
  });
});

describe('helpers', () => {
  it('buildViewRows merges the file with the report and tally counts the verdicts', () => {
    const parsed = parseMenuCsv(FIVE);
    const view = buildViewRows(parsed, report(importDryRun));
    expect(tally(view)).toEqual({ create: 2, update: 0, skip: 1, invalid: 2 });
    expect(view[3]).toMatchObject({ name: 'Bad One', action: 'invalid', computedPrice: null });
    expect(view[0].vendorPrice).toBe('₹150');
  });
  it('a row the server did not report is treated as not checked, never as fine', () => {
    const parsed = parseMenuCsv('name,category,price\nA,B,1\nC,D,2');
    const view = buildViewRows(parsed, report({ data: { rows: [{ index: 0, name: 'A', action: 'create', errors: [], computedPrice: 1 }] } }));
    expect(view[1].action).toBe('invalid');
    expect(view[1].problems).toEqual(['This row could not be checked.']);
  });
});

describe('small screens', () => {
  it('works at 360 px: no table, rows are wrapping cards', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(importDryRun));
    await setup();
    await paste(FIVE);
    await check();
    expect(dialog().querySelector('table')).toBeNull();
    expect(rows()).toHaveLength(5);
  });

  it('keyboard: Escape closes, and the step heading takes focus when the step changes', async () => {
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(importDryRunGood));
    const { onClose } = await setup();
    await paste(THREE);
    await check();
    expect(document.activeElement?.textContent).toContain('Step 2 of 3');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalled();
  });
});
