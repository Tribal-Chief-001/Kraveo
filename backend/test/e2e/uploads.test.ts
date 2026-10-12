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
import zlib from 'zlib';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { __resetUploadUsage } from '../../src/routes/uploads';
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
    __resetUploadUsage();
    delete process.env.UPLOAD_MAX_TOTAL_MB;
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
      ['webp extended', 'image/webp', () => makeWebp(2400, 1800, 'extended'), 'webp', 2400, 1800],
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

    test('size and dimension limits: 200 px short side and 2400 px long side are inclusive; 1 MB is the body limit', async () => {
      expect((await upload(makePng(200, 200))).status).toBe(201);
      expect((await upload(makePng(2400, 200))).status).toBe(201);
      expect((await upload(makePng(200, 2400))).status).toBe(201);
      expect((await upload(makePng(2400, 2400))).status).toBe(201);
      const small = await upload(makePng(199, 900));
      expect([small.status, small.body.code]).toEqual([400, 'IMAGE_TOO_SMALL']);
      const small2 = await upload(makePng(900, 150));
      expect([small2.status, small2.body.code]).toEqual([400, 'IMAGE_TOO_SMALL']);
      const big = await upload(makePng(2401, 300));
      expect([big.status, big.body.code]).toEqual([400, 'IMAGE_DIMENSIONS_TOO_LARGE']);
      const big2 = await upload(makeJpeg(300, 4000), 'image/jpeg');
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

  // =========================================================================================
  describe('review fixes: real photos, hollow files, failed writes, quota, gzip, limiter', () => {
    const FIX = path.join(__dirname, '../fixtures/images');
    const real = (f: string) => fs.readFileSync(path.join(FIX, f));
    const typeOf = (f: string) => (f.endsWith('.jpg') ? 'image/jpeg' : f.endsWith('.png') ? 'image/png' : 'image/webp');

    test.each(fs.readdirSync(path.join(__dirname, '../fixtures/images')))('real photo %s (progressive / interlaced / CMYK / EXIF / alpha / animated ...) is accepted and served back byte for byte', async (f) => {
      const r = await upload(real(f), typeOf(f));
      expect([f, r.status]).toEqual([f, 201]);
      expect((await rawGet(pathOf(r.body.data.url))).body.equals(real(f))).toBe(true);
    });

    test('hollow or damaged files are 400 IMAGE_CORRUPT: junk after a JPEG frame header, a PNG with no image data, a WebP header with no image, a real JPEG / PNG / WebP cut short', async () => {
      const jpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0xe8, 0x03, 0xe8, 0x01, 0x01, 0x11, 0x00]);
      const junk = Buffer.concat([jpgHeader, Buffer.from('<?php echo 1; ?>'.repeat(40))]);
      const png = real('photo.png');
      const iend = png.length - 12;
      const ihdrEnd = 8 + 25;
      const noIdat = Buffer.concat([png.subarray(0, ihdrEnd), png.subarray(iend)]);
      const vp8x = Buffer.alloc(30); vp8x.write('RIFF', 0, 'latin1'); vp8x.writeUInt32LE(22, 4); vp8x.write('WEBP', 8, 'latin1'); vp8x.write('VP8X', 12, 'latin1'); vp8x.writeUInt32LE(10, 16); vp8x.writeUIntLE(499, 24, 3); vp8x.writeUIntLE(499, 27, 3);
      const cases: [string, Buffer, string][] = [
        ['jpeg junk', junk, 'image/jpeg'], ['png without IDAT', noIdat, 'image/png'], ['webp VP8X only', vp8x, 'image/webp'],
        ['jpeg cut', real('photo_baseline.jpg').subarray(0, 3000), 'image/jpeg'], ['png cut', png.subarray(0, 3000), 'image/png'], ['webp cut', real('photo_lossy.webp').subarray(0, 2000), 'image/webp'],
        ['jpeg + trailing script', Buffer.concat([real('photo_baseline.jpg'), Buffer.from('<script>1</script>')]), 'image/jpeg'],
      ];
      for (const [label, body, type] of cases) {
        const r = await upload(body, type);
        expect([label, r.status, r.body.code]).toEqual([label, 400, 'IMAGE_CORRUPT']);
      }
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('a failed write (disk full) answers 503 and leaves NO .tmp- file behind; a failed rename too', async () => {
      const real_write = fs.promises.writeFile;
      jest.spyOn(fs.promises, 'writeFile').mockImplementation(async (p: any, data: any, opts: any) => {
        await real_write(p, (data as Buffer).subarray(0, 20), opts); // a partial file exists when the error comes
        throw Object.assign(new Error('write failed'), { code: 'ENOSPC' });
      });
      const r = await upload(makePng(300, 300));
      expect([r.status, r.body.code]).toEqual([503, 'UPLOAD_UNAVAILABLE']);
      const left = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? left(path.join(d, e.name)) : [e.name]));
      expect(left(dir)).toEqual([]);
      jest.restoreAllMocks();
      jest.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('rename failed'), { code: 'EIO' }));
      const r2 = await upload(makePng(300, 300));
      expect([r2.status, r2.body.code]).toEqual([503, 'UPLOAD_UNAVAILABLE']);
      expect(left(dir)).toEqual([]);
      jest.restoreAllMocks();
      expect((await upload(makePng(300, 300))).status).toBe(201); // and the next one works
    });

    test('total quota (UPLOAD_MAX_TOTAL_MB): the upload that would pass it is 507 UPLOAD_QUOTA_EXCEEDED with a plain message, nothing is stored; files that are already there count; room again after cleaning', async () => {
      process.env.UPLOAD_MAX_TOTAL_MB = '0.002'; // about 2 KB
      const a = await upload(makePng(300, 300, 1200));
      expect(a.status).toBe(201);
      const b = await upload(makePng(300, 300, 1200));
      expect([b.status, b.body.code]).toEqual([507, 'UPLOAD_QUOTA_EXCEEDED']);
      expect(b.body.message).toMatch(/storage is full/);
      expect(JSON.stringify(b.body)).not.toMatch(/ENOSPC|\/tmp|at /);
      const count = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
      expect(count(dir)).toBe(1);
      // free the space; the size is a cached scan (refreshed every 60 s), here the cache is dropped like a restart or the minute passing
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      __resetUploadUsage();
      expect((await upload(makePng(300, 300, 1200))).status).toBe(201);
      // a file that was put there by something else is counted by the scan
      fs.writeFileSync(path.join(dir, 'other-bytes.bin'), Buffer.alloc(5000));
      __resetUploadUsage();
      expect((await upload(makePng(300, 300))).body.code).toBe('UPLOAD_QUOTA_EXCEEDED');
      delete process.env.UPLOAD_MAX_TOTAL_MB;
      __resetUploadUsage();
      expect((await upload(makePng(300, 300))).status).toBe(201); // default is 1500 MB
    });

    test('Content-Encoding: gzip is inflated first and the 1 MB limit applies to the inflated size (a small gzip cannot hide a big file)', async () => {
      const png = makePng(300, 300);
      const ok = await request.post('/api/admin/uploads/image?purpose=dish').set(H(tAdmin)).set('Content-Type', 'image/png').set('Content-Encoding', 'gzip').send(zlib.gzipSync(png));
      expect(ok.status).toBe(201);
      const bomb = zlib.gzipSync(makePng(300, 300, 3 * 1024 * 1024));
      expect(bomb.length).toBeLessThan(20_000);
      const r = await request.post('/api/admin/uploads/image?purpose=dish').set(H(tAdmin)).set('Content-Type', 'image/png').set('Content-Encoding', 'gzip').send(bomb);
      expect([r.status, r.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    });

    test('the limiter counts every request that reaches the route, also the ones whose file is refused', async () => {
      process.env.RL_ADMIN_UPLOAD_MAX = '2';
      expect((await upload(SVG, 'image/svg+xml')).status).toBe(415);
      expect((await upload(GIF, 'image/png')).status).toBe(415);
      const third = await upload(makePng(300, 300));
      expect([third.status, third.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });
});
