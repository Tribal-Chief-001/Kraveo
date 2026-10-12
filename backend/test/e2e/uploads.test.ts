/**
 * Image upload and static serving (Docs/23 section 3.6). Real HTTP, real files in a temporary UPLOAD_DIR.
 * Covers: magic bytes vs header, SVG / GIF / HTML refused, size and dimension limits, random names, ADMIN only, rate limit,
 * audit, the exact response headers of GET /uploads/*, and every path-traversal / listing attempt we could think of.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { makePng, makeJpeg, makeWebp, SVG, GIF, HTML } from '../harness/images';

jest.setTimeout(60_000);

const tAdmin = getAdminToken();
const H = (t: string) => getAuthHeader(t);
const URL_RE = /^https:\/\/api\.test\.kraveo\/uploads\/(banner|dish)\/\d{4}\/[0-9a-f]{32}\.(jpg|png|webp)$/;

describe('Image upload (Docs/23 section 3.6)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let dir: string;

  const upload = (body: Buffer, type = 'image/png', purpose: string | null = 'dish', token = tAdmin) =>
    request.post(`/api/admin/uploads/image${purpose === null ? '' : `?purpose=${encodeURIComponent(purpose)}`}`).set(H(token)).set('Content-Type', type).send(body);
  /** Raw GET with the path exactly as written (no client-side normalisation of ../ or %2e). */
  const rawGet = (rawPath: string, method = 'GET') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const u = new URL(server.baseUrl);
    const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  const pathOf = (url: string) => new URL(url).pathname;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraveo-uploads-test-'));
    process.env.UPLOAD_DIR = dir;
    process.env.PUBLIC_BASE_URL = 'https://api.test.kraveo/';
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    __resetRateLimits();
    await prisma.adminAuditLog.deleteMany({ where: { action: 'IMAGE_UPLOADED' } });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  });

  afterAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    delete process.env.UPLOAD_DIR;
    delete process.env.PUBLIC_BASE_URL;
    fs.rmSync(dir, { recursive: true, force: true });
    await prisma.adminAuditLog.deleteMany({ where: { action: 'IMAGE_UPLOADED' } });
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('accepted files', () => {
    test.each([
      ['png', 'image/png', () => makePng(640, 480), 'png', 640, 480],
      ['jpeg', 'image/jpeg', () => makeJpeg(1200, 800), 'jpg', 1200, 800],
      ['webp lossy', 'image/webp', () => makeWebp(500, 300, 'lossy'), 'webp', 500, 300],
      ['webp lossless', 'image/webp', () => makeWebp(401, 402, 'lossless'), 'webp', 401, 402],
      ['webp extended', 'image/webp', () => makeWebp(4000, 3000, 'extended'), 'webp', 4000, 3000],
    ])('%s: stored under a random name, answered with the exact shape, served with the exact headers', async (_n, type, make, ext, w, h) => {
      const file = (make as () => Buffer)();
      const r = await upload(file, type as string, 'banner');
      expect(r.status).toBe(201);
      expect(Object.keys(r.body).sort()).toEqual(['data', 'success']);
      expect(Object.keys(r.body.data).sort()).toEqual(['bytes', 'height', 'url', 'width']);
      expect(r.body.data).toMatchObject({ width: w, height: h, bytes: file.length });
      expect(r.body.data.url).toMatch(URL_RE);
      expect(r.body.data.url.endsWith(`.${ext}`)).toBe(true);
      expect(r.body.data.url).toContain('/uploads/banner/');
      const stored = path.join(dir, pathOf(r.body.data.url).replace(/^\/uploads\//, ''));
      expect(fs.readFileSync(stored).equals(file)).toBe(true);
      expect(fs.readdirSync(path.dirname(stored)).filter((f) => f.startsWith('.'))).toEqual([]); // no temp file left behind

      const got = await rawGet(pathOf(r.body.data.url));
      expect(got.status).toBe(200);
      expect(got.body.equals(file)).toBe(true);
      expect(got.headers['content-type']).toBe(type);
      expect(got.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(got.headers['cross-origin-resource-policy']).toBe('cross-origin');
      const head = await rawGet(pathOf(r.body.data.url), 'HEAD');
      expect([head.status, head.headers['cross-origin-resource-policy']]).toEqual([200, 'cross-origin']);
    });

    test('the same bytes twice give two different random names; the client file name does not exist for the server', async () => {
      const file = makePng(300, 300);
      const [a, b] = [await upload(file), await upload(file)];
      expect(a.status).toBe(201);
      expect(a.body.data.url).not.toBe(b.body.data.url);
    });

    test('size and dimension limits: 200 px short side and 4000 px long side are inclusive; 1 MB is the body limit', async () => {
      expect((await upload(makePng(200, 200))).status).toBe(201);
      expect((await upload(makePng(4000, 200))).status).toBe(201);
      expect((await upload(makePng(200, 4000))).status).toBe(201);
      const small = await upload(makePng(199, 900));
      expect([small.status, small.body.code]).toEqual([400, 'IMAGE_TOO_SMALL']);
      const small2 = await upload(makePng(900, 150));
      expect([small2.status, small2.body.code]).toEqual([400, 'IMAGE_TOO_SMALL']);
      const big = await upload(makePng(4001, 300));
      expect([big.status, big.body.code]).toEqual([400, 'IMAGE_DIMENSIONS_TOO_LARGE']);
      const big2 = await upload(makeJpeg(300, 5000), 'image/jpeg');
      expect([big2.status, big2.body.code]).toEqual([400, 'IMAGE_DIMENSIONS_TOO_LARGE']);
      const nearLimit = makePng(300, 300, 1024 * 1024 - 200); // just under 1 MiB in total
      expect(nearLimit.length).toBeLessThanOrEqual(1024 * 1024);
      expect((await upload(nearLimit)).status).toBe(201);
      const over = makePng(300, 300, 1024 * 1024 + 10);
      const tooBig = await upload(over);
      expect([tooBig.status, tooBig.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    });
  });

  // =========================================================================================
  describe('refused files', () => {
    test('SVG, GIF and HTML are refused even when they claim to be a PNG; the type must match the bytes', async () => {
      for (const [label, bytes] of [['svg', SVG], ['gif', GIF], ['html', HTML], ['text', Buffer.from('just text, not an image at all')]] as const) {
        const r = await upload(bytes, 'image/png');
        expect([label, r.status, r.body.code]).toEqual([label, 415, 'NOT_AN_IMAGE']);
      }
      const mismatch = await upload(makePng(300, 300), 'image/jpeg');
      expect([mismatch.status, mismatch.body.code]).toEqual([415, 'IMAGE_TYPE_MISMATCH']);
      const mismatch2 = await upload(makeJpeg(300, 300), 'image/webp');
      expect([mismatch2.status, mismatch2.body.code]).toEqual([415, 'IMAGE_TYPE_MISMATCH']);
    });

    test('headers that are not jpeg / png / webp are refused before anything is read', async () => {
      for (const type of ['image/svg+xml', 'image/gif', 'text/html', 'application/octet-stream', 'application/json', 'text/plain']) {
        const r = await upload(type === 'application/json' ? Buffer.from('{"a":1}') : SVG, type);
        expect([type, r.status, r.body.code]).toEqual([type, 415, 'UNSUPPORTED_IMAGE_TYPE']);
      }
      expect(fs.readdirSync(dir)).toEqual([]); // nothing was stored by any refused call so far in this block
    });

    test('empty body, damaged files, a missing or unknown purpose', async () => {
      const empty = await upload(Buffer.alloc(0), 'image/png');
      expect([empty.status, empty.body.code]).toEqual([400, 'EMPTY_FILE']);
      const png = makePng(300, 300);
      const cut = await upload(png.subarray(0, png.length - 7), 'image/png');
      expect([cut.status, cut.body.code]).toEqual([400, 'IMAGE_CORRUPT']);
      for (const purpose of [null, '', 'avatar', 'BANNER', 'dish/../x']) {
        const r = await upload(png, 'image/png', purpose);
        expect([String(purpose), r.status, r.body.field]).toEqual([String(purpose), 400, 'purpose']);
      }
    });

    test('storage that cannot be written answers 503 and says what to do, never a stack trace', async () => {
      const keep = process.env.UPLOAD_DIR;
      process.env.UPLOAD_DIR = '/dev/null/not-a-directory';
      try {
        const r = await upload(makePng(300, 300));
        expect([r.status, r.body.code]).toEqual([503, 'UPLOAD_UNAVAILABLE']);
        expect(JSON.stringify(r.body)).not.toMatch(/ENOTDIR|\/dev\/null|at .*\(/);
      } finally {
        process.env.UPLOAD_DIR = keep;
      }
    });
  });

  // =========================================================================================
  describe('who may upload, limits, audit', () => {
    test('ADMIN only: no token 401, student / restaurant owner / rider 403, and nothing is stored', async () => {
      const png = makePng(300, 300);
      const anon = await request.post('/api/admin/uploads/image?purpose=dish').set('Content-Type', 'image/png').send(png);
      expect(anon.status).toBe(401);
      for (const t of [getStudentToken(), getVendorToken(), getDriverToken()]) {
        const r = await upload(png, 'image/png', 'dish', t);
        expect(r.status).toBe(403);
      }
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('60 per hour per admin by default (rule ADMIN_UPLOAD), here lowered to 3: the 4th is a 429 with Retry-After', async () => {
      process.env.RL_ADMIN_UPLOAD_MAX = '3';
      const png = makePng(300, 300);
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await upload(png)).status);
      expect(codes).toEqual([201, 201, 201, 429]);
      const r = await upload(png);
      expect([r.status, r.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    });

    test('every stored upload is audited (type, size, bytes) and the url is usable as an ordinary image link', async () => {
      const r = await upload(makeJpeg(640, 480), 'image/jpeg', 'dish');
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'IMAGE_UPLOADED' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toMatch(/dish image \(640x480, \d+ bytes, image\/jpeg\)/);
      expect(rows[0].targetId).toMatch(/^dish\/\d{4}\/[0-9a-f]{32}\.jpg$/);
      // the existing admin dish endpoint takes it like any https link
      const created = await request.post('/api/admin/catalog').set(H(tAdmin)).send({ vendorId: 'ven-1', name: 'Photo dish', vendorPrice: 50, imageUrl: r.body.data.url });
      expect(created.status).toBe(201);
      expect(created.body.data.imageUrl).toBe(r.body.data.url);
      await prisma.menuItem.delete({ where: { id: created.body.data.id } });
    });
  });

  // =========================================================================================
  describe('serving: nothing but our own files, no traversal, no listing', () => {
    test('every traversal / encoding / dotfile / directory attempt is a plain 404 and never reveals a file', async () => {
      const good = await upload(makePng(300, 300), 'image/png', 'dish');
      const goodPath = pathOf(good.body.data.url);
      const year = goodPath.split('/')[3];
      // things that must NOT be served even though they exist on disk
      fs.writeFileSync(path.join(dir, 'dish', year, '.hidden.png'), 'secret');
      fs.writeFileSync(path.join(dir, 'dish', year, 'plain.txt'), 'secret');
      fs.writeFileSync(path.join(dir, 'dish', year, 'ABCDEF0123456789ABCDEF0123456789.png'), 'secret'); // upper case hex: not our naming
      fs.writeFileSync(path.join(dir, 'secret.png'), 'secret');
      const attempts = [
        '/uploads/../package.json', '/uploads/%2e%2e/package.json', '/uploads/%2E%2E/package.json', '/uploads/%252e%252e/package.json',
        '/uploads/..%2fpackage.json', '/uploads/..%5cpackage.json', '/uploads/dish/../../package.json', '/uploads/dish/%2e%2e/%2e%2e/package.json',
        `/uploads/dish/${year}/..%2f..%2f..%2fpackage.json`, `/uploads/dish/${year}/%2e%2e%2f%2e%2e%2fsecret.png`, '/uploads//etc/passwd', '/uploads/etc/passwd',
        `/uploads/dish/${year}/%00.png`, `${goodPath}%00`, `${goodPath}%00.jpg`, `${goodPath}/`, `${goodPath}/..`, `${goodPath}?x=../../x`.replace('?x=../../x', '/x'),
        `/uploads/dish/${year}/.hidden.png`, `/uploads/dish/${year}/%2ehidden.png`, `/uploads/dish/${year}/plain.txt`, `/uploads/dish/${year}/ABCDEF0123456789ABCDEF0123456789.png`,
        '/uploads/secret.png', '/uploads', '/uploads/', '/uploads/dish', '/uploads/dish/', `/uploads/dish/${year}`, `/uploads/dish/${year}/`, '/uploads/banner/', '/uploads/.env', '/uploads/%2eenv',
        '/uploads/dish/9999/00000000000000000000000000000000.png',
      ];
      for (const p of attempts) {
        const r = await rawGet(p);
        expect([p, r.status]).toEqual([p, 404]);
        expect(r.body.toString()).not.toMatch(/secret|"name": "kraveo-backend"|root:/);
        expect(r.headers['content-type']).toMatch(/json/);
      }
      // methods other than GET / HEAD never reach the file
      for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) expect([m, (await rawGet(goodPath, m)).status]).toEqual([m, 404]);
      // and the good one is still there
      expect((await rawGet(goodPath)).status).toBe(200);
    });

    test('a request for a file that was never uploaded (right shape) is a 404 too, without touching the API router', async () => {
      const r = await rawGet('/uploads/dish/2026/0123456789abcdef0123456789abcdef.jpg');
      expect([r.status, JSON.parse(r.body.toString()).code]).toEqual([404, 'NOT_FOUND']);
    });
  });
});
