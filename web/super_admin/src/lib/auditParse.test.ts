import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS, actionGroup, actionLabel, actorText, auditQuery, auditTarget, groupActions, hasFilters, isIstDate, istDateTime, istDaysAgo, istToday, parseAuditActions, parseAuditPage,
  parseAuditRow, rangeProblem, searchTooShort,
} from './auditParse';
import { rawAuditActions, rawAuditPage, rawAuditRow } from '../test/adminFixtures';

describe('parsing the log', () => {
  it('reads a real row and page', () => {
    const page = parseAuditPage(rawAuditPage([rawAuditRow(), rawAuditRow({ id: 'aud-2', actorId: null, actorName: null, ip: null })], 'cursor-1'))!;
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBe('cursor-1');
    expect(page.rows[1]).toMatchObject({ actorId: null, actorName: null, ip: null });
    expect(page.count).toBe(2);
  });
  it('skips rows without id or action, ignores unknown fields, and never invents text', () => {
    const page = parseAuditPage({ data: [rawAuditRow({ meta: { secret: 1 } }), { id: 'x' }, { action: 'A' }, null, rawAuditRow({ id: 'aud-3', summary: 5 })], count: 'bad' })!;
    expect(page.rows.map((r) => r.id)).toEqual(['aud-1', 'aud-3']);
    expect((page.rows[0] as any).meta).toBeUndefined();
    expect(page.rows[1].summary).toBe('');
    expect(page.count).toBe(2);
    expect(parseAuditPage({ success: true })).toBeNull();
  });
  it('actions list', () => {
    expect(parseAuditActions(rawAuditActions())).toHaveLength(5);
    expect(parseAuditActions({ data: [{ action: 'A', count: 'x' }, {}] })).toEqual([{ action: 'A', count: 0 }]);
    expect(parseAuditActions(null)).toBeNull();
  });
});

describe('filters to query', () => {
  it('empty filters send nothing; the page size and cursor are added on top', () => {
    expect(auditQuery(EMPTY_FILTERS)).toBe('');
    expect(auditQuery(EMPTY_FILTERS, { limit: 50, cursor: 'abc=' })).toBe('limit=50&cursor=abc%3D');
  });
  it('maps every filter to the server parameter name', () => {
    const q = new URLSearchParams(auditQuery({ actions: ['ORDER_CANCELLED', 'OWNER_CREATED'], targetType: 'ORDER', actorId: 'adm 1', q: ' refund ', from: '2026-10-01', to: '2026-10-29' }));
    expect(q.get('action')).toBe('ORDER_CANCELLED,OWNER_CREATED');
    expect(q.get('targetType')).toBe('ORDER');
    expect(q.get('actorId')).toBe('adm 1');
    expect(q.get('q')).toBe('refund');
    expect(q.get('from')).toBe('2026-10-01');
    expect(q.get('to')).toBe('2026-10-29');
  });
  it('a one-character search is not sent (the server wants 2 to 60) and says so', () => {
    expect(auditQuery({ ...EMPTY_FILTERS, q: 'a' })).toBe('');
    expect(searchTooShort('a')).toBe(true);
    expect(searchTooShort('ab')).toBe(false);
    expect(searchTooShort('')).toBe(false);
    expect(new URLSearchParams(auditQuery({ ...EMPTY_FILTERS, q: 'x'.repeat(90) })).get('q')).toHaveLength(60);
  });
  it('hasFilters', () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, from: '2026-10-01' })).toBe(true);
    expect(hasFilters({ ...EMPTY_FILTERS, actions: ['A'] })).toBe(true);
  });
});

describe('India dates', () => {
  it('validates real calendar dates', () => {
    expect(isIstDate('2026-10-29')).toBe(true);
    expect(isIstDate('2026-02-30')).toBe(false);
    expect(isIstDate('29-10-2026')).toBe(false);
  });
  it('today is the Indian day: 23:00 UTC is already tomorrow in India, and 18:29 UTC is not', () => {
    expect(istToday(Date.parse('2026-10-29T18:29:00Z'))).toBe('2026-10-29');
    expect(istToday(Date.parse('2026-10-29T18:31:00Z'))).toBe('2026-10-30');
    expect(istDaysAgo(6, Date.parse('2026-10-29T10:00:00Z'))).toBe('2026-10-23');
    expect(istDaysAgo(30, Date.parse('2026-10-29T10:00:00Z'))).toBe('2026-09-29');
  });
  it('shows times in IST whatever the browser zone is', () => {
    expect(istDateTime('2026-10-29T06:00:00.000Z')).toMatch(/29 Oct 2026,? 11:30\s?(am|AM)/);
    expect(istDateTime('nonsense')).toBe('-');
    expect(istDateTime(null)).toBe('-');
  });
  it('range problems, in plain words; the file has the 366-day limit', () => {
    expect(rangeProblem({ from: '', to: '' })).toBe('');
    expect(rangeProblem({ from: '2026-10-10', to: '2026-10-01' })).toContain('after');
    expect(rangeProblem({ from: '2026-13-01', to: '' })).toContain('not a valid date');
    expect(rangeProblem({ from: '2025-01-01', to: '2026-10-29' })).toBe('');
    expect(rangeProblem({ from: '2025-01-01', to: '2026-10-29' }, true)).toContain('366 days');
    expect(rangeProblem({ from: '2026-01-01', to: '2026-12-31' }, true)).toBe('');
    expect(rangeProblem({ from: '2026-10-01', to: '2026-10-01' }, true)).toBe('');
  });
});

describe('wording and links', () => {
  it('labels and groups codes; unknown codes still show', () => {
    expect(actionLabel('CUSTOMER_SUSPENDED')).toBe('Customer suspended');
    expect(actionLabel('')).toBe('');
    expect(actionGroup('CUSTOMER_REMOVED')).toBe('Customers');
    expect(actionGroup('OWNER_PHONE_CHANGED')).toBe('Owner logins');
    expect(actionGroup('ORDER_CANCELLED')).toBe('Orders');
    expect(actionGroup('PARTNER_SUSPENDED')).toBe('Restaurants and riders');
    expect(actionGroup('SOMETHING_NEW')).toBe('Other');
    const g = groupActions(parseAuditActions(rawAuditActions())!);
    expect(g.map((x) => x.group)).toEqual(['Customers', 'Orders', 'Owner logins', 'Restaurants and riders', 'Other']);
  });
  it('targets: an order opens the drawer, restaurants / riders / people open their tab, the rest is plain', () => {
    expect(auditTarget({ targetType: 'ORDER', targetId: 'o1' })).toEqual({ kind: 'order', id: 'o1' });
    expect(auditTarget({ targetType: 'VENDOR', targetId: 'v1' })).toMatchObject({ kind: 'tab', tab: 'vendors' });
    expect(auditTarget({ targetType: 'DRIVER', targetId: 'd1' })).toMatchObject({ tab: 'drivers' });
    expect(auditTarget({ targetType: 'USER', targetId: 'u1' })).toMatchObject({ tab: 'customers' });
    expect(auditTarget({ targetType: 'SETTING', targetId: 's' })).toBeNull();
    expect(auditTarget({ targetType: 'ORDER', targetId: '' })).toBeNull();
  });
  it('who did it', () => {
    expect(actorText({ actorId: 'a', actorName: 'Ana' })).toBe('Ana');
    expect(actorText({ actorId: 'abcdefghij', actorName: null })).toBe('Admin abcdefgh');
    expect(actorText({ actorId: null, actorName: null })).toContain('System');
  });
});
