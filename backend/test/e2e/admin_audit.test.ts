/**
 * Admin user management, B5 activity log viewer (Docs/27 B5): filters alone and combined, keyset paging with equal timestamps, escaping of
 * % and _, date ranges (IST), the CSV export (injection safe, capped), read-only router, old consumers still served. Real PostgreSQL and HTTP.
 */
import supertest from 'supertest';
import { prisma } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { getAdminToken, getStudentToken, getAuthHeader } from '../harness/auth';
import { __resetAuditActionsCache, adminAuditRouter, csvCell } from '../../src/routes/adminAudit';
import { writeAudit } from '../../src/services/audit';
import { runWithActor } from '../../src/services/actorContext';

jest.setTimeout(60_000);
const H = () => getAuthHeader(getAdminToken('usr-5', '+91 9876543214'));

describe('Admin activity log viewer', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  const ids: string[] = [];
  const list = (q: string) => request.get(`/api/admin/audit-log${q}`).set(H());
  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    await prisma.adminAuditLog.deleteMany({});
    server = await startTestServer(0);
    request = supertest(server.app);
    const rows = [
      { action: 'ORDER_CANCELLED', targetType: 'ORDER', targetId: 'o-1', summary: 'ADMIN cancelled the order (PLACED, payment PAID): Fake order', createdAt: at('2026-10-01T08:00:00.000Z'), actorId: 'adm-1', actorName: 'Asha Admin' },
      { action: 'ORDER_CANCELLED', targetType: 'ORDER', targetId: 'o-2', summary: 'SYSTEM cancelled the order: Payment not completed', createdAt: at('2026-10-02T08:00:00.000Z'), actorId: null, actorName: null },
      { action: 'PARTNER_SUSPENDED', targetType: 'VENDOR', targetId: 'v-1', summary: 'SUSPENDED vendor Kitchen 100% fresh_food', createdAt: at('2026-10-03T08:00:00.000Z'), actorId: 'adm-1', actorName: 'Asha Admin' },
      { action: 'CUSTOMER_REMOVED', targetType: 'USER', targetId: 'u-1', summary: 'Removed customer Ravi (u-1)', createdAt: at('2026-10-03T08:00:00.000Z'), actorId: 'adm-2', actorName: 'Ben Admin' },
      { action: 'CUSTOMER_REMOVED', targetType: 'USER', targetId: 'u-2', summary: '=HYPERLINK("http://evil","click"), "quoted"', createdAt: at('2026-10-03T08:00:00.000Z'), actorId: 'adm-2', actorName: '+Ben' },
      { action: 'PAYOUT_ACCOUNT_REVEALED', targetType: 'USER', targetId: 'u-3', summary: 'Plain text only', createdAt: at('2026-10-04T08:00:00.000Z'), actorId: 'adm-1', actorName: 'Asha Admin' },
    ];
    for (const r of rows) ids.push((await prisma.adminAuditLog.create({ data: r })).id);
  });
  afterAll(async () => {
    await stopTestServer(server);
    await prisma.adminAuditLog.deleteMany({});
    await prisma.$disconnect();
  });
  beforeEach(() => __resetAuditActionsCache());

  test('newest first, the row shape, old consumers (no params) still get { success, data } with the same fields', async () => {
    const res = await list('');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, count: 6, nextCursor: null });
    expect(res.body.data.map((r: any) => r.targetId)[0]).toBe('u-3');
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['action', 'actorId', 'actorName', 'createdAt', 'id', 'ip', 'summary', 'targetId', 'targetType']);
    expect(res.body.data.find((r: any) => r.targetId === 'o-2')).toMatchObject({ actorId: null, actorName: null });
    expect(JSON.stringify(res.body)).not.toContain('"meta"');
    const old = await list('?limit=200');
    expect(old.status).toBe(200);
    expect(old.body.data).toHaveLength(6);
    expect((await list('?limit=abc')).body.data).toHaveLength(6);
    expect((await list('?limit=0')).body.data).toHaveLength(6);
    expect((await list('?limit=2')).body.data).toHaveLength(2);
  });

  test('each filter alone and combined', async () => {
    const ids = async (q: string) => (await list(q)).body.data.map((r: any) => r.targetId).sort();
    expect(await ids('?action=ORDER_CANCELLED')).toEqual(['o-1', 'o-2']);
    expect(await ids('?action=ORDER_CANCELLED,PARTNER_SUSPENDED')).toEqual(['o-1', 'o-2', 'v-1']);
    expect(await ids('?targetType=USER')).toEqual(['u-1', 'u-2', 'u-3']);
    expect(await ids('?targetId=v-1')).toEqual(['v-1']);
    expect(await ids('?actorId=adm-2')).toEqual(['u-1', 'u-2']);
    expect(await ids('?q=cancelled')).toEqual(['o-1', 'o-2']);
    expect(await ids('?q=KITCHEN')).toEqual(['v-1']);
    expect(await ids('?from=2026-10-03&to=2026-10-03')).toEqual(['u-1', 'u-2', 'v-1']);
    expect(await ids('?from=2026-10-03')).toEqual(['u-1', 'u-2', 'u-3', 'v-1']);
    expect(await ids('?action=CUSTOMER_REMOVED&actorId=adm-2&from=2026-10-01&to=2026-10-31&q=ravi')).toEqual(['u-1']);
    expect(await ids('?action=ORDER_CANCELLED&targetType=VENDOR')).toEqual([]);
  });

  test('IST day bounds: a row at 20:00 UTC on the 3rd is already the 4th in India', async () => {
    const row = await prisma.adminAuditLog.create({ data: { action: 'TZ_TEST', targetType: 'TEST', targetId: 'tz-1', summary: 'late evening', createdAt: at('2026-10-05T20:00:00.000Z') } });
    expect((await list('?from=2026-10-05&to=2026-10-05&action=TZ_TEST')).body.data).toHaveLength(0);
    expect((await list('?from=2026-10-06&to=2026-10-06&action=TZ_TEST')).body.data).toHaveLength(1);
    await prisma.adminAuditLog.delete({ where: { id: row.id } });
  });

  test('q escapes % and _ (they are not wildcards)', async () => {
    const n = async (q: string) => (await list(`?q=${encodeURIComponent(q)}`)).body.data.length;
    expect(await n('100%')).toBe(1);
    expect(await n('fresh_food')).toBe(1);
    expect(await n('fresh%food')).toBe(0);
    expect(await n('fres_ food')).toBe(0);
    expect(await n('%%')).toBe(0);
    expect(await n('Ravi\\')).toBe(0);
  });

  test('keyset paging walks every row exactly once, also with equal timestamps (three rows share 2026-10-03T08:00)', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const res = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((r: any) => r.id));
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...ids].sort());
    // order: createdAt desc, id desc
    const all = (await list('')).body.data;
    expect(all.map((r: any) => r.id)).toEqual(seen);
  });

  test('validation: every bad parameter is a 400 with its field; unknown parameters are refused', async () => {
    const cases: [string, string][] = [
      ['?action=lower', 'action'], ['?action=A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,TT,UU', 'action'], ['?action=A_B;DROP', 'action'], ['?targetType=order', 'targetType'],
      ['?targetId=a%20b', 'targetId'], ['?actorId=../x', 'actorId'], ['?q=a', 'q'], [`?q=${'x'.repeat(61)}`, 'q'], ['?from=2026-13-01', 'from'], ['?from=yesterday', 'from'],
      ['?from=2026-10-05&to=2026-10-01', 'from'], ['?cursor=@@@', 'cursor'], [`?cursor=${Buffer.from('nope|x').toString('base64url')}`, 'cursor'], ['?bogus=1', 'bogus'], ['?action=A&action=B', 'action'],
    ];
    for (const [q, field] of cases) {
      const res = await list(q);
      expect([q, res.status, res.body.field]).toEqual([q, 400, field]);
    }
    expect((await list('?from=2020-01-01&to=2030-12-31')).status).toBe(400); // longer than 3660 days
  });

  test('actions: distinct codes of the last 90 days with counts (cached for a minute)', async () => {
    const res = await request.get('/api/admin/audit-log/actions').set(H());
    expect(res.status).toBe(200);
    const base = [{ action: 'CUSTOMER_REMOVED', count: 2 }, { action: 'ORDER_CANCELLED', count: 2 }, { action: 'PARTNER_SUSPENDED', count: 1 }, { action: 'PAYOUT_ACCOUNT_REVEALED', count: 1 }];
    expect(res.body.data).toEqual(base);
    await prisma.adminAuditLog.create({ data: { action: 'A_RECENT', targetType: 'T', targetId: 't', summary: 's' } });
    await prisma.adminAuditLog.create({ data: { action: 'A_RECENT', targetType: 'T', targetId: 't', summary: 's' } });
    __resetAuditActionsCache();
    expect((await request.get('/api/admin/audit-log/actions').set(H())).body.data).toEqual([{ action: 'A_RECENT', count: 2 }, ...base]);
    await prisma.adminAuditLog.create({ data: { action: 'B_RECENT', targetType: 'T', targetId: 't', summary: 's' } });
    expect((await request.get('/api/admin/audit-log/actions').set(H())).body.data).toEqual([{ action: 'A_RECENT', count: 2 }, ...base]); // cached
    expect((await request.get('/api/admin/audit-log/actions?x=1').set(H())).status).toBe(400);
    await prisma.adminAuditLog.deleteMany({ where: { action: { in: ['A_RECENT', 'B_RECENT'] } } });
  });

  test('CSV: header, neutralised formulas, quoting, filters, no-store; a range over 366 days -> 400 RANGE_TOO_LARGE; admin only', async () => {
    const res = await request.get('/api/admin/audit-log/export.csv?from=2026-10-01&to=2026-10-31').set(H());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toContain('audit-log-2026-10-01-2026-10-31.csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('time,action,targetType,targetId,summary,by,actorId,ip');
    expect(lines).toHaveLength(7);
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"",""click""), ""quoted"""`); // formula neutralised with ', quotes doubled
    expect(res.text).toContain("'+Ben");
    expect(res.text).not.toMatch(/(^|,)=HYPERLINK/m);
    const only = await request.get('/api/admin/audit-log/export.csv?from=2026-10-01&to=2026-10-31&action=ORDER_CANCELLED').set(H());
    expect(only.text.trim().split('\n')).toHaveLength(3);
    const big = await request.get('/api/admin/audit-log/export.csv?from=2025-01-01&to=2026-10-31').set(H());
    expect([big.status, big.body.code, big.body.field]).toEqual([400, 'RANGE_TOO_LARGE', 'from']);
    expect((await request.get('/api/admin/audit-log/export.csv?cursor=x').set(H())).status).toBe(400);
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect((await request.get('/api/admin/audit-log/export.csv').set(getAuthHeader(getStudentToken()))).status).toBe(403);
  });

  test('read only: the router has GET handlers only and every write verb is a 404; non-admins get 401 / 403', async () => {
    const methods = (adminAuditRouter as any).stack.flatMap((l: any) => (l.route ? Object.keys(l.route.methods) : []));
    expect(new Set(methods)).toEqual(new Set(['get']));
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await (request as any)[m]('/api/admin/audit-log').set(H()).send({});
      expect([m, res.status]).toEqual([m, 404]);
    }
    expect((await request.get('/api/admin/audit-log')).status).toBe(401);
    expect((await request.get('/api/admin/audit-log').set(getAuthHeader(getStudentToken()))).status).toBe(403);
    expect(await prisma.adminAuditLog.count()).toBe(6);
  });

  test('rows written inside a request carry the actor, rows written by a job do not (what the viewer shows)', async () => {
    await runWithActor({ id: 'usr-5', ip: '1.2.3.4' }, () => writeAudit('VIEW_TEST_ACTOR', 'TEST', 't', 'in a request'));
    await writeAudit('VIEW_TEST_JOB', 'TEST', 't', 'by a job');
    const res = await list('?action=VIEW_TEST_ACTOR,VIEW_TEST_JOB');
    const byAction = Object.fromEntries(res.body.data.map((r: any) => [r.action, r]));
    expect(byAction.VIEW_TEST_ACTOR).toMatchObject({ actorId: 'usr-5', ip: '1.2.3.4' });
    expect(byAction.VIEW_TEST_JOB).toMatchObject({ actorId: null, ip: null });
    await prisma.adminAuditLog.deleteMany({ where: { action: { in: ['VIEW_TEST_ACTOR', 'VIEW_TEST_JOB'] } } });
  });
});
