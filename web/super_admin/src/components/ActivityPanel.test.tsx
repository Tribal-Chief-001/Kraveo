// @vitest-environment jsdom
// Activity tab (Docs/27 B5): filters, paging, rows, CSV, empty / error / loading states.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const saved: Array<{ blob: Blob; filename: string }> = [];
vi.mock('../lib/download', () => ({ saveBlob: (blob: Blob, filename: string) => { saved.push({ blob, filename }); } }));

import { ActivityPanel } from './ActivityPanel';
import { ApiError, apiService } from '../services/api';
import { EMPTY_FILTERS, istToday, istDaysAgo, parseAuditActions, parseAuditPage } from '../lib/auditParse';
import { byId, byText, click, flush, mount, type, unmount, waitFor } from '../test/dom';
import { rawAuditActions, rawAuditPage, rawAuditRow } from '../test/adminFixtures';

afterEach(async () => { vi.restoreAllMocks(); saved.length = 0; await unmount(); });

const apiErr = (status: number, body: Record<string, any>) => new ApiError(status, body.message, body.code, body.field, body);
const page = (rows: Record<string, unknown>[] = [rawAuditRow()], next: string | null = null) => parseAuditPage(rawAuditPage(rows, next))!;

const setup = async (first = page(), props: Record<string, unknown> = {}) => {
  const fetchLog = vi.spyOn(apiService, 'fetchAuditLog').mockResolvedValue(first);
  const fetchActions = vi.spyOn(apiService, 'fetchAuditActions').mockResolvedValue(parseAuditActions(rawAuditActions())!);
  const onAuthError = vi.fn();
  const onOpenOrder = vi.fn();
  const onNavigate = vi.fn();
  await mount(<ActivityPanel onAuthError={onAuthError} onOpenOrder={onOpenOrder} onNavigate={onNavigate} {...(props as any)} />);
  await flush();
  return { fetchLog, fetchActions, onAuthError, onOpenOrder, onNavigate };
};
const lastFilters = (f: { mock: { calls: any[][] } }) => f.mock.calls[f.mock.calls.length - 1][0];
const csvButton = () => byText('button', 'Download CSV') as HTMLButtonElement;

describe('rows', () => {
  it('loads the newest page with the default page size and no filters; shows time (IST), action, target, summary and who', async () => {
    const { fetchLog, fetchActions } = await setup();
    expect(fetchLog).toHaveBeenCalledWith(EMPTY_FILTERS, null, 50);
    expect(fetchActions).toHaveBeenCalledTimes(1);
    const row = document.querySelector('tbody tr')!;
    expect(row.textContent).toMatch(/29 Oct 2026,? 11:30\s?(am|AM)/);
    expect(row.textContent).toContain('Customer suspended');
    expect(row.textContent).toContain('CUSTOMER_SUSPENDED');
    expect(row.textContent).toContain('Suspended customer Cust1 Tester (zc-cust-): Fake orders; 1 open order(s) cancelled');
    expect(row.textContent).toContain('Campus Dispatch Admin');
    expect(row.textContent).toContain('203.0.113.9');
    expect(document.querySelector('table caption')!.textContent).toBe('Activity log, newest first');
    expect(Array.from(document.querySelectorAll('th')).map((h) => h.getAttribute('scope'))).toEqual(Array(5).fill('col'));
    expect(document.body.textContent).toContain('1 entry shown.');
  });

  it('a summary with markup is shown as text; a system row says so; unknown action codes still show', async () => {
    await setup(page([
      rawAuditRow({ id: 'a1', summary: '<img src=x onerror=alert(1)> and <b>bold</b>' }),
      rawAuditRow({ id: 'a2', actorId: null, actorName: null, ip: null, action: 'SOMETHING_NEW', targetType: 'WEIRD', targetId: 'zz' }),
    ]));
    expect(document.querySelector('tbody img')).toBeNull();
    expect(document.querySelector('tbody b')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)> and <b>bold</b>');
    expect(document.body.textContent).toContain('System or before admin names were recorded');
    expect(document.body.textContent).toContain('Something new');
  });

  it('targets: an order opens the order drawer, a restaurant opens its tab', async () => {
    const { onOpenOrder, onNavigate } = await setup(page([
      rawAuditRow({ id: 'a1', action: 'ORDER_CANCELLED', targetType: 'ORDER', targetId: 'order-abc123' }),
      rawAuditRow({ id: 'a2', action: 'VENDOR_REMOVED', targetType: 'VENDOR', targetId: 'ven-12345678' }),
      rawAuditRow({ id: 'a3', action: 'SETTING_CHANGED', targetType: 'SETTING', targetId: 'fees' }),
    ]));
    const rows = document.querySelectorAll('tbody tr');
    await click(rows[0].querySelector('button'));
    expect(onOpenOrder).toHaveBeenCalledWith('order-abc123');
    await click(byText('button', 'Open Restaurants', rows[1] as HTMLElement));
    expect(onNavigate).toHaveBeenCalledWith('vendors');
    expect(rows[2].querySelector('button')).toBeNull();
  });
});

describe('filters', () => {
  it('the action picker lists the server actions grouped; picking sends the codes comma-separated; the count shows', async () => {
    const { fetchLog } = await setup();
    const trigger = byText('button', 'Any action')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = byId('au-actions')!;
    expect(Array.from(panel.querySelectorAll('legend')).map((l) => l.textContent)).toEqual(['Customers', 'Orders', 'Owner logins', 'Restaurants and riders', 'Other']);
    await click(byText('label', /Customer suspended/, panel)!.querySelector('input'));
    await click(byText('label', /Order cancelled/, panel)!.querySelector('input'));
    await flush();
    expect(lastFilters(fetchLog).actions).toEqual(['CUSTOMER_SUSPENDED', 'ORDER_CANCELLED']);
    expect(trigger.textContent).toContain('2 selected');
    await click(byText('label', /Order cancelled/, panel)!.querySelector('input'));
    await flush();
    expect(lastFilters(fetchLog).actions).toEqual(['CUSTOMER_SUSPENDED']);
  });

  it('target type, actor (people seen in the rows) and quick dates are sent; Clear filters resets everything', async () => {
    const { fetchLog } = await setup(page([rawAuditRow(), rawAuditRow({ id: 'a2', actorId: 'adm-2', actorName: 'Second Admin' })]));
    await type(byId('au-type'), 'ORDER');
    await flush();
    expect(lastFilters(fetchLog).targetType).toBe('ORDER');
    const actorOptions = Array.from((byId('au-actor') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(actorOptions).toEqual(['Anyone', 'Campus Dispatch Admin', 'Second Admin']);
    await type(byId('au-actor'), 'adm-2');
    await flush();
    expect(lastFilters(fetchLog).actorId).toBe('adm-2');
    await click(byText('button', 'Last 7 days'));
    await flush();
    expect(lastFilters(fetchLog)).toMatchObject({ from: istDaysAgo(6), to: istToday() });
    expect((byId('au-from') as HTMLInputElement).value).toBe(istDaysAgo(6));
    await click(byText('button', 'Today'));
    await flush();
    expect(lastFilters(fetchLog)).toMatchObject({ from: istToday(), to: istToday() });
    await click(byText('button', 'Clear filters'));
    await flush();
    expect(lastFilters(fetchLog)).toEqual(EMPTY_FILTERS);
    expect(byText('button', 'Clear filters')).toBeUndefined();
  });

  it('typing the dates by hand works; a "from" after the "to" is explained and nothing is requested', async () => {
    const { fetchLog } = await setup();
    await type(byId('au-from'), '2026-10-10');
    await type(byId('au-to'), '2026-10-01');
    await flush();
    const callsBefore = fetchLog.mock.calls.length;
    expect(document.body.textContent).toContain('The "from" date is after the "to" date.');
    expect(csvButton().disabled).toBe(true);
    expect(fetchLog.mock.calls.filter((c) => (c[0] as any).from === '2026-10-10' && (c[0] as any).to === '2026-10-01')).toHaveLength(0);
    await type(byId('au-to'), '2026-10-20');
    await flush();
    expect(lastFilters(fetchLog)).toMatchObject({ from: '2026-10-10', to: '2026-10-20' });
    expect(fetchLog.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('search waits for a pause, needs 2 characters, and is sent trimmed', async () => {
    const { fetchLog } = await setup();
    const before = fetchLog.mock.calls.length;
    await type(byId('au-q'), 'a');
    await flush();
    expect(document.body.textContent).toContain('Type at least 2 characters.');
    await type(byId('au-q'), 'refund ');
    expect(fetchLog.mock.calls.length).toBe(before); // not yet: the pause has not passed
    await waitFor(() => fetchLog.mock.calls.length > before);
    expect(lastFilters(fetchLog).q).toBe('refund ');
    // the single character typed first was never applied: only the later text reached the server
    expect(fetchLog.mock.calls.some((c) => (c[0] as any).q === 'a')).toBe(false);
  });

  it('a slow answer for old filters never replaces the list of the new filters', async () => {
    const fetchLog = vi.spyOn(apiService, 'fetchAuditLog');
    vi.spyOn(apiService, 'fetchAuditActions').mockResolvedValue(parseAuditActions(rawAuditActions())!);
    let slow: (p: ReturnType<typeof page>) => void = () => {};
    fetchLog.mockResolvedValueOnce(page([rawAuditRow({ id: 'first', summary: 'First load' })]));
    await mount(<ActivityPanel onAuthError={() => {}} />);
    await flush();
    fetchLog.mockImplementationOnce(() => new Promise((resolve) => { slow = resolve as any; }));
    await type(byId('au-type'), 'ORDER');
    fetchLog.mockResolvedValueOnce(page([rawAuditRow({ id: 'new', summary: 'Newest filter result' })]));
    await type(byId('au-type'), 'VENDOR');
    await flush();
    slow(page([rawAuditRow({ id: 'old', summary: 'Stale result' })]));
    await flush();
    expect(document.body.textContent).toContain('Newest filter result');
    expect(document.body.textContent).not.toContain('Stale result');
  });

  it('the action list failing does not stop the log; it can be retried', async () => {
    vi.spyOn(apiService, 'fetchAuditLog').mockResolvedValue(page());
    const fetchActions = vi.spyOn(apiService, 'fetchAuditActions').mockRejectedValueOnce(apiErr(500, { message: 'no' })).mockResolvedValue(parseAuditActions(rawAuditActions())!);
    await mount(<ActivityPanel onAuthError={() => {}} />);
    await flush();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect((byText('button', 'Actions unavailable') as HTMLButtonElement).disabled).toBe(true);
    await click(byText('button', /action list could not be loaded/));
    await flush();
    expect(fetchActions).toHaveBeenCalledTimes(2);
    expect(byText('button', 'Any action')).toBeDefined();
  });
});

describe('paging', () => {
  it('load more sends the cursor with the same filters, appends, skips duplicates, and the button goes away at the end', async () => {
    const { fetchLog } = await setup(page([rawAuditRow()], 'cur-1'));
    expect(document.body.textContent).toContain('more available');
    fetchLog.mockResolvedValueOnce(page([rawAuditRow(), rawAuditRow({ id: 'aud-2', summary: 'Older entry' })], null));
    await click(byText('button', 'Load more'));
    await flush();
    expect(fetchLog).toHaveBeenLastCalledWith(EMPTY_FILTERS, 'cur-1', 50);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(byText('button', 'Load more')).toBeUndefined();
  });

  it('load more failing keeps the rows and tells the admin', async () => {
    const { fetchLog } = await setup(page([rawAuditRow()], 'cur-1'));
    fetchLog.mockRejectedValueOnce(apiErr(500, { message: 'Server hiccup.' }));
    await click(byText('button', 'Load more'));
    await flush();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(document.body.textContent).toContain('Server hiccup.');
    expect(byText('button', 'Load more')).toBeDefined();
  });

  it('a page loaded for old filters is dropped when the filters changed meanwhile', async () => {
    const { fetchLog } = await setup(page([rawAuditRow()], 'cur-1'));
    let finish: (p: ReturnType<typeof page>) => void = () => {};
    fetchLog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as any; }));
    await click(byText('button', 'Load more'));
    fetchLog.mockResolvedValueOnce(page([rawAuditRow({ id: 'only', summary: 'Only new filter' })]));
    await type(byId('au-type'), 'ORDER');
    await flush();
    finish(page([rawAuditRow({ id: 'stale', summary: 'Stale page' })]));
    await flush();
    expect(document.body.textContent).toContain('Only new filter');
    expect(document.body.textContent).not.toContain('Stale page');
  });
});

describe('states', () => {
  it('loading skeleton first', async () => {
    vi.spyOn(apiService, 'fetchAuditLog').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(apiService, 'fetchAuditActions').mockResolvedValue([]);
    await mount(<ActivityPanel onAuthError={() => {}} />);
    expect(document.querySelector('[role="status"][aria-label="Loading activity"]')).not.toBeNull();
    expect(csvButton().disabled).toBe(true);
  });

  it('empty without filters, and empty with filters (with a way out)', async () => {
    await setup(page([]));
    expect(document.body.textContent).toContain('No activity yet');
    expect(byText('button', 'Clear filters')).toBeUndefined();
  });

  it('empty with filters', async () => {
    const { fetchLog } = await setup();
    fetchLog.mockResolvedValue(page([]));
    await type(byId('au-type'), 'DRIVER');
    await flush();
    expect(document.body.textContent).toContain('No activity matches these filters.');
    const clears = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === 'Clear filters');
    expect(clears.length).toBeGreaterThan(0);
  });

  it('error with the server message and a retry; a 401 reaches the app', async () => {
    const fetchLog = vi.spyOn(apiService, 'fetchAuditLog').mockRejectedValueOnce(apiErr(401, { code: 'TOKEN_REVOKED', message: 'Please sign in again.' })).mockResolvedValue(page());
    vi.spyOn(apiService, 'fetchAuditActions').mockResolvedValue([]);
    const onAuthError = vi.fn();
    await mount(<ActivityPanel onAuthError={onAuthError} />);
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Please sign in again.');
    expect(onAuthError).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    await click(byText('button', 'Try again'));
    await flush();
    expect(fetchLog).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('a 400 from the server (bad filter) shows its text', async () => {
    vi.spyOn(apiService, 'fetchAuditLog').mockRejectedValue(apiErr(400, { code: 'BAD_REQUEST', field: 'q', message: 'q must be 2 to 60 characters.' }));
    vi.spyOn(apiService, 'fetchAuditActions').mockResolvedValue([]);
    await mount(<ActivityPanel onAuthError={() => {}} />);
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('q must be 2 to 60 characters.');
  });
});

describe('CSV', () => {
  it('downloads with the filters, through the token, and saves the file the server named', async () => {
    await setup();
    const blob = new Blob(['time,action\n']);
    const download = vi.spyOn(apiService, 'downloadAuditCsv').mockResolvedValue({ blob, filename: 'audit-log-2026-10-01-2026-10-29.csv' });
    await type(byId('au-from'), '2026-10-01');
    await type(byId('au-to'), '2026-10-29');
    await flush();
    await click(csvButton());
    await flush();
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-01', to: '2026-10-29' }));
    expect(saved).toEqual([{ blob, filename: 'audit-log-2026-10-01-2026-10-29.csv' }]);
    expect(document.body.textContent).toContain('audit-log-2026-10-01-2026-10-29.csv was saved.');
  });

  it('one download at a time; a failure shows the server message and the button works again', async () => {
    await setup();
    let release: (v: { blob: Blob; filename: string }) => void = () => {};
    const download = vi.spyOn(apiService, 'downloadAuditCsv').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockRejectedValueOnce(apiErr(400, { code: 'RANGE_TOO_LARGE', message: 'The date range cannot be longer than 366 days.' }));
    await click(csvButton());
    expect(csvButton().disabled).toBe(true);
    expect(csvButton().getAttribute('aria-busy')).toBe('true');
    await click(csvButton());
    expect(download).toHaveBeenCalledTimes(1);
    release({ blob: new Blob(['x']), filename: 'a.csv' });
    await flush();
    await click(csvButton());
    await flush();
    expect(document.body.textContent).toContain('The date range cannot be longer than 366 days.');
    expect(csvButton().disabled).toBe(false);
  });

  it('over 366 days is refused before asking: the button is off and says why; the list itself still allows it', async () => {
    const { fetchLog } = await setup();
    await type(byId('au-from'), '2025-01-01');
    await type(byId('au-to'), '2026-10-29');
    await flush();
    expect(csvButton().disabled).toBe(true);
    expect(csvButton().title).toContain('366 days');
    expect(lastFilters(fetchLog)).toMatchObject({ from: '2025-01-01', to: '2026-10-29' });
  });

  it('says what an empty date range means', async () => {
    await setup();
    expect(document.body.textContent).toContain('The CSV covers the last 31 days unless you choose dates');
    expect(csvButton().title).toBe('Without dates the file covers the last 31 days.');
  });
});

describe('mobile layout and roles', () => {
  it('cards on a phone, table on a wide screen; labelled filters and a named region', async () => {
    const { } = await setup();
    expect(document.querySelector('ul[aria-label="Activity log, newest first"].xl\\:hidden')).not.toBeNull();
    expect(document.querySelector('.hidden.xl\\:block table')).not.toBeNull();
    expect(document.querySelector('section[aria-label="Filters"]')).not.toBeNull();
    for (const id of ['au-q', 'au-type', 'au-actor', 'au-from', 'au-to']) expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
    const card = document.querySelector('ul[aria-label="Activity log, newest first"] li')!;
    expect(card.textContent).toContain('Customer suspended');
    expect(card.textContent).toContain('By Campus Dispatch Admin');
  });
});
