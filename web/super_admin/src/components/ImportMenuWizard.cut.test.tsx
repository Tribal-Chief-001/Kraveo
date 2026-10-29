// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const saved: Array<{ blob: Blob; filename: string }> = [];
vi.mock('../lib/download', () => ({ saveBlob: (blob: Blob, filename: string) => { saved.push({ blob, filename }); } }));

import { ImportMenuWizard, buildViewRows } from './ImportMenuWizard';
import { ImportInvalidError, apiService } from '../services/api';
import { parseImportReport } from '../lib/catalogBulkParse';
import { parseMenuCsv } from '../lib/menuCsv';
import { byId, byText, click, flush, mount, type, unmount } from '../test/dom';
import { settingView } from '../test/fixtures';
import { IMPORT_DRY_CUT, IMPORT_INVALID_CUT, IMPORT_ROW_NEEDS_CUT, IMPORT_ROW_NOT_EXACT } from '../test/cutFixtures';

const vendors = [
  { id: 'cv', name: 'Cut Kitchen', commissionType: 'CUT', commissionValue: 30 },
  { id: 'pv', name: 'Percent Point', commissionType: 'PERCENT', commissionValue: 10 },
  { id: 'gv', name: 'Inherit House', commissionType: null, commissionValue: null },
  { id: 'uv', name: 'Old Server Dhaba' },
] as any[];
const report = (body: unknown) => parseImportReport(body)!;
const blobText = (blob: Blob) => new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });

const setup = async (initialVendorId: string) => {
  const props = { vendors, initialVendorId, onClose: vi.fn(), onImported: vi.fn(), onAuthError: vi.fn() };
  await mount(<ImportMenuWizard {...(props as any)} />);
  return props;
};
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const paste = (text: string) => type(byId('import-text'), text);
const check = async () => { await click(byText('button', 'Check the menu', dialog())); await flush(); };
const rows = () => Array.from(dialog().querySelectorAll('ul[aria-label="Rows"] > li')) as HTMLElement[];
const help = () => dialog().querySelector('[data-testid="price-column-help"]')!.textContent!;

const FILE = 'name,category,menuPrice,position\nImp A,Main,115,1\nImp B,Main,100,2\nImp C,Main,99,3\nImp D,Main,250,7';

beforeEach(() => { saved.length = 0; });
afterEach(async () => { vi.restoreAllMocks(); await unmount(); });

describe('step 1: which price column?', () => {
  it('a Cut from sale restaurant: explains menuPrice, offers the menu-price template, asks what the price column holds', async () => {
    await setup('cv');
    expect(help()).toContain('Cut Kitchen is on 30% of the sale');
    expect(help()).toContain('menuPrice');
    expect(help()).toContain('position');
    expect(dialog().querySelector('[role="radiogroup"][aria-label="What the price column holds"]')).not.toBeNull();
    expect((dialog().querySelector('input[name="import-prices-are"][value="menu"]') as HTMLInputElement).checked).toBe(true);
    await click(byText('button', 'Template with menuPrice', dialog()));
    expect(saved[0].filename).toBe('kraveo-menu-template-customer-price.csv');
    const text = await blobText(saved[0].blob);
    expect(text).toContain('name,category,menuPrice,position,isVeg,description,imageUrl,isAvailable');
  });

  it('a Percent restaurant: use vendorPrice, no menuPrice template, no price-column question', async () => {
    await setup('pv');
    expect(help()).toContain('Percent Point is on 10%');
    expect(help()).toContain('Use the vendorPrice column');
    expect(byText('button', 'Template with menuPrice', dialog())).toBeUndefined();
    expect(dialog().querySelector('[role="radiogroup"][aria-label="What the price column holds"]')).toBeNull();
  });

  it('a restaurant without its own rule follows the default in Settings (asked once)', async () => {
    const fetchSettings = vi.spyOn(apiService, 'fetchSettings').mockResolvedValue(settingView('commission', { type: 'CUT', value: 20 }) as any);
    await setup('gv');
    await flush();
    expect(fetchSettings).toHaveBeenCalledTimes(1);
    expect(help()).toContain('Inherit House is on 20% of the sale');
  });

  it('unknown rule (old server, nothing chosen): both ways are explained and both templates are offered', async () => {
    const fetchSettings = vi.spyOn(apiService, 'fetchSettings');
    await setup('uv');
    expect(fetchSettings).not.toHaveBeenCalled();
    expect(help()).toContain('vendorPrice');
    expect(help()).toContain('menuPrice');
    expect(byText('button', 'Template with menuPrice', dialog())).toBeDefined();
    expect(byText('button', 'Download the template', dialog())).toBeDefined();
  });

  it('the old restaurant-price template is still what "Download the template" gives', async () => {
    await setup('pv');
    await click(byText('button', 'Download the template', dialog()));
    expect(saved[0].filename).toBe('kraveo-menu-template.csv');
    expect(await blobText(saved[0].blob)).toContain('name,category,vendorPrice,isVeg,description,imageUrl,isAvailable');
  });
});

describe('step 2: the preview with menuPrice and position', () => {
  it('sends menuPrice and position as numbers and shows menu price, the restaurant share and the customer price per row', async () => {
    const dry = vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(IMPORT_DRY_CUT));
    await setup('cv');
    await paste(FILE);
    await check();
    expect(dry.mock.calls[0][1]).toEqual([
      { name: 'Imp A', category: 'Main', menuPrice: 115, position: 1 },
      { name: 'Imp B', category: 'Main', menuPrice: 100, position: 2 },
      { name: 'Imp C', category: 'Main', menuPrice: 99, position: 3 },
      { name: 'Imp D', category: 'Main', menuPrice: 250, position: 7 },
    ]);
    const list = rows();
    expect(list).toHaveLength(4);
    expect(list[0].textContent).toContain('menu price ₹115');
    expect(list[0].textContent).toContain('restaurant gets ₹80.50');
    expect(list[0].textContent).toContain('customer pays ₹115');
    expect(list[0].textContent).toContain('position 1');
    expect(list[2].textContent).toContain('restaurant gets ₹69.30');
    expect(list[3].textContent).toContain('position 7');
    expect(dialog().querySelector('[data-testid="import-summary"]')!.textContent).toContain('4 to add');
  });

  it('a plain "Price" column in a Cut from sale restaurant\'s file is sent as menuPrice by default, and as vendorPrice when the admin says so', async () => {
    const dry = vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(IMPORT_DRY_CUT));
    await setup('cv');
    await paste('Dish,Section,Price\nImp A,Main,115');
    await check();
    expect(dry.mock.calls[0][1]).toEqual([{ name: 'Imp A', category: 'Main', menuPrice: 115 }]);
    await click(byText('button', 'Back', dialog()));
    await click(dialog().querySelector('input[name="import-prices-are"][value="vendor"]'));
    await check();
    expect(dry.mock.calls[1][1]).toEqual([{ name: 'Imp A', category: 'Main', vendorPrice: 115 }]);
  });

  it('for a Percent restaurant a plain Price column stays the restaurant price', async () => {
    const dry = vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(IMPORT_DRY_CUT));
    await setup('pv');
    await paste('Dish,Section,Price\nImp A,Main,115');
    await check();
    expect(dry.mock.calls[0][1]).toEqual([{ name: 'Imp A', category: 'Main', vendorPrice: 115 }]);
  });

  it('MENU_PRICE_NOT_EXACT, MENU_PRICE_NEEDS_CUT_RULE and PRICE_REQUIRED are shown in plain words with a next step; Import stays off', async () => {
    const bad = report({ data: { dryRun: true, applied: false, summary: { create: 0, update: 0, skip: 0, invalid: 3, total: 3 }, rows: [
      { ...IMPORT_ROW_NOT_EXACT, index: 0 }, { ...IMPORT_ROW_NEEDS_CUT, index: 1 }, { ...IMPORT_INVALID_CUT.data.rows[1], index: 2 },
    ] } });
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(bad);
    await setup('cv');
    await paste('name,category,menuPrice\nThird,Main,10\nPlain,Main,20\nBoth,Main,30');
    await check();
    const list = rows();
    expect(list[0].textContent).toContain('The nearest price that works is Rs 9.99.');
    expect(list[0].textContent).toContain('Change the menu price to the nearest one that works');
    expect(list[1].textContent).toContain('A menu price can only be used when the commission is "Cut from sale"');
    expect(list[1].textContent).toContain('Use the restaurant price column for this dish');
    expect(list[2].textContent).toContain('not both');
    expect(list[2].textContent).toContain('Fill in exactly one price per dish');
    expect(dialog().textContent).toContain('3 rows are not valid, so nothing can be imported yet.');
    const importButton = Array.from(dialog().querySelectorAll('button')).find((b) => /^(Import \d+ dish|Nothing to import)/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
  });

  it('a bad menuPrice or position cell is caught in the browser, in plain words, and nothing is applied', async () => {
    vi.spyOn(apiService, 'importMenu').mockResolvedValue(report(IMPORT_DRY_CUT));
    await setup('cv');
    await paste('name,category,menuPrice,position\nA,Main,abc,0\nB,Main,100,2');
    await check();
    expect(rows()[0].textContent).toContain('is not a menu price');
    expect(rows()[0].textContent).toContain('is not a position');
    expect(rows()[0].getAttribute('data-row-action')).toBe('invalid');
  });

  it('a file with menuPrice only (no vendorPrice column) is accepted; the apply sends dryRun false with the same rows', async () => {
    const dry = vi.spyOn(apiService, 'importMenu')
      .mockResolvedValueOnce(report(IMPORT_DRY_CUT))
      .mockResolvedValueOnce(report({ ...IMPORT_DRY_CUT, message: 'Imported: 4 added, 0 updated, 0 skipped.', data: { ...IMPORT_DRY_CUT.data, dryRun: false, applied: true } }));
    const props = await setup('cv');
    await paste(FILE);
    await check();
    await click(byText('button', 'Import 4 dishes', dialog()));
    await flush();
    expect(dry.mock.calls[1][2]).toEqual({ dryRun: false, onDuplicate: 'SKIP' });
    expect(dry.mock.calls[1][1]).toEqual(dry.mock.calls[0][1]);
    expect(props.onImported).toHaveBeenCalledTimes(1);
    expect(dialog().textContent).toContain('Imported: 4 added');
  });

  it('IMPORT_INVALID on apply shows the server report (codes kept) and writes nothing', async () => {
    vi.spyOn(apiService, 'importMenu')
      .mockResolvedValueOnce(report(IMPORT_DRY_CUT))
      .mockRejectedValueOnce(new ImportInvalidError(IMPORT_INVALID_CUT.message, report(IMPORT_INVALID_CUT), IMPORT_INVALID_CUT));
    const props = await setup('cv');
    await paste(FILE);
    await check();
    await click(byText('button', 'Import 4 dishes', dialog()));
    await flush();
    expect(props.onImported).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('2 rows are not valid. Nothing was imported.');
  });
});

describe('buildViewRows', () => {
  it('menu price rows carry typed text, the share and hints; vendor rows keep the old fields', () => {
    const parsed = parseMenuCsv('name,category,menuPrice,position\nA,Main,115,2\nB,Main,abc,');
    const view = buildViewRows(parsed, report(IMPORT_DRY_CUT));
    expect(view[0]).toMatchObject({ menuPrice: '₹115', position: '2', restaurantGets: 80.5, vendorPrice: '-', hints: [] });
    expect(view[1]).toMatchObject({ action: 'invalid', menuPrice: 'abc', restaurantGets: null });
    const plain = buildViewRows(parseMenuCsv('name,category,price\nA,Main,150'), report(IMPORT_DRY_CUT));
    expect(plain[0]).toMatchObject({ vendorPrice: '₹150', menuPrice: null, position: null });
  });
  it('a missing server row never crashes or shows NaN', () => {
    const view = buildViewRows(parseMenuCsv('name,category,menuPrice\nA,Main,115'), report({ data: { rows: [] } }));
    expect(view[0]).toMatchObject({ action: 'invalid', restaurantGets: null });
    expect(view[0].problems).toEqual(['This row could not be checked.']);
  });
});
