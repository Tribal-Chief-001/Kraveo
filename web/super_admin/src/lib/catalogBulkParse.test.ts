import { describe, expect, it } from 'vitest';
import { bulkFailures, importableCount, parseBulkResult, parseImportReport, parseUploadResult, skipReasonText } from './catalogBulkParse';
import { bulkMixed, importApplied, importDryRun, importDryRunGood, importInvalid, uploadOk } from '../test/taxonomyFixtures';

describe('bulk result', () => {
  it('reads the real mixed answer', () => {
    const r = parseBulkResult(bulkMixed)!;
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.message).toBe('2 done, 2 could not be changed.');
    expect(r.results[2]).toEqual({ id: '1686259a-acb1-400c-b4d5-9ebcff5725a1', ok: false, changed: false, code: 'ITEM_DELETED', message: 'This dish is deleted. Restore it first.' });
  });
  it('lists each failure with the dish name and the server message', () => {
    const names: Record<string, string> = { '1686259a-acb1-400c-b4d5-9ebcff5725a1': 'Old Roll' };
    const failures = bulkFailures(parseBulkResult(bulkMixed)!, (id) => names[id] ?? 'A dish that is gone');
    expect(failures).toEqual([
      { id: '1686259a-acb1-400c-b4d5-9ebcff5725a1', name: 'Old Roll', message: 'This dish is deleted. Restore it first.' },
      { id: 'missing-id', name: 'A dish that is gone', message: 'Menu item not found.' },
    ]);
  });
  it('fills a message from the code when the server sent none, and counts from the list when totals are missing', () => {
    const r = parseBulkResult({ data: { results: [{ id: 'a', ok: false, code: 'ITEM_DELETED' }, { id: 'b', ok: false }, { id: 'c', ok: true, changed: false }] } })!;
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(2);
    expect(bulkFailures(r, (id) => id).map((f) => f.message)).toEqual(['This dish is deleted. Restore it first.', 'This dish could not be changed.']);
  });
  it('null when there is no results list', () => {
    expect(parseBulkResult({ success: true })).toBeNull();
    expect(parseBulkResult(null)).toBeNull();
    expect(parseBulkResult({ data: { results: 'x' } })).toBeNull();
  });
});

describe('import report', () => {
  it('reads the real dry run (create / skip / invalid with errors and computed price)', () => {
    const r = parseImportReport(importDryRun)!;
    expect(r.dryRun).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.summary).toEqual({ create: 2, update: 0, skip: 1, invalid: 2, total: 5 });
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0]).toMatchObject({ index: 0, name: 'Paneer Tikka', action: 'create', computedPrice: 150, errors: [] });
    expect(r.rows[1]).toMatchObject({ action: 'skip', reason: 'DUPLICATE_EXISTS', dishId: '0e4af759-820a-4859-9135-ccb08af7b0b0', computedPrice: 190 });
    expect(r.rows[3].errors).toEqual([{ field: 'category', message: 'Pick a category from the list.' }, { field: 'vendorPrice', message: 'The price must be more than 0.' }]);
    expect(r.rows[3].computedPrice).toBeNull();
    expect(importableCount(r)).toBe(2);
  });
  it('reads an applied import and the IMPORT_INVALID error body (same report in data)', () => {
    const applied = parseImportReport(importApplied)!;
    expect(applied.applied).toBe(true);
    expect(applied.rows[0].dishId).toBe('f4084af6-c433-430a-82d0-02ea9781b61e');
    const invalid = parseImportReport(importInvalid)!;
    expect(invalid.summary.invalid).toBe(2);
    expect(invalid.dryRun).toBe(false);
  });
  it('tallies the summary from rows when it is missing; an unknown action counts as invalid', () => {
    const r = parseImportReport({ data: { rows: [{ index: 0, name: 'a', action: 'create' }, { index: 1, name: 'b', action: 'teleport' }, null] } })!;
    expect(r.summary).toEqual({ create: 1, update: 0, skip: 0, invalid: 2, total: 3 });
    expect(r.rows[1].errors[0].message).toBe('This row is not valid.');
    expect(r.rows[2].index).toBe(2);
  });
  it('null without a rows list; bad numbers become null, never NaN', () => {
    expect(parseImportReport({ success: true })).toBeNull();
    expect(parseImportReport(undefined)).toBeNull();
    expect(parseImportReport({ data: { rows: [{ index: 0, action: 'create', computedPrice: 'x' }] } })!.rows[0].computedPrice).toBeNull();
  });
  it('skip reasons in words', () => {
    expect(skipReasonText('DUPLICATE_EXISTS')).toMatch(/Already on the menu/);
    expect(skipReasonText('UNCHANGED')).toMatch(/nothing to change/);
    expect(skipReasonText(null)).toBe('Skipped');
    expect(skipReasonText('NEW_THING')).toBe('Skipped');
  });
  it('the good dry run has nothing invalid', () => {
    expect(parseImportReport(importDryRunGood)!.summary.invalid).toBe(0);
  });
});

describe('upload result', () => {
  it('reads the real answer', () => {
    expect(parseUploadResult(uploadOk)).toEqual({ url: 'https://api.kraveo.site/uploads/banner/2026/bcff31b889235190508d11aaf6161e67.png', width: 800, height: 450, bytes: 68 });
  });
  it('refuses a missing, relative or non-http url', () => {
    expect(parseUploadResult({ data: {} })).toBeNull();
    expect(parseUploadResult({ data: { url: '/uploads/x.png' } })).toBeNull();
    expect(parseUploadResult({ data: { url: 'javascript:alert(1)' } })).toBeNull();
    expect(parseUploadResult(null)).toBeNull();
  });
});
