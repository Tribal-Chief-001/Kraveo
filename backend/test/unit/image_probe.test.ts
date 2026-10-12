import { probeImage, ImageError } from '../../src/utils/imageProbe';
import { makePng, makeJpeg, makeWebp, SVG, GIF, HTML } from '../harness/images';

describe('image probe (Docs/23 section 3.6): the magic bytes decide, the size comes from the file header', () => {
  test('PNG, JPEG (baseline and progressive) and WebP (lossy, lossless, extended) report their real type and size', () => {
    expect(probeImage(makePng(640, 480))).toMatchObject({ kind: 'png', ext: 'png', mime: 'image/png', width: 640, height: 480 });
    expect(probeImage(makeJpeg(1200, 800))).toMatchObject({ kind: 'jpeg', ext: 'jpg', mime: 'image/jpeg', width: 1200, height: 800 });
    expect(probeImage(makeJpeg(300, 900, true))).toMatchObject({ kind: 'jpeg', width: 300, height: 900 });
    expect(probeImage(makeWebp(500, 250, 'lossy'))).toMatchObject({ kind: 'webp', ext: 'webp', mime: 'image/webp', width: 500, height: 250 });
    expect(probeImage(makeWebp(501, 251, 'lossless'))).toMatchObject({ width: 501, height: 251 });
    expect(probeImage(makeWebp(4000, 3000, 'extended'))).toMatchObject({ width: 4000, height: 3000 });
  });

  test('SVG, GIF, HTML, text, empty and random bytes are NOT_AN_IMAGE whatever they claim to be', () => {
    for (const b of [SVG, GIF, HTML, Buffer.from('hello'), Buffer.alloc(0), Buffer.alloc(100, 0), Buffer.from([0xff, 0xd8])]) {
      expect(() => probeImage(b)).toThrow(ImageError);
      try { probeImage(b); } catch (e) { expect((e as ImageError).code).toBe('NOT_AN_IMAGE'); }
    }
  });

  test('damaged files are IMAGE_CORRUPT: truncated PNG, data hidden after IEND, JPEG without a frame header, truncated or padded WebP', () => {
    const png = makePng(300, 300);
    const code = (b: Buffer) => { try { probeImage(b); return 'OK'; } catch (e) { return (e as ImageError).code; } };
    expect(code(png.subarray(0, png.length - 5))).toBe('IMAGE_CORRUPT');
    expect(code(Buffer.concat([png, Buffer.from('<script>x</script>')]))).toBe('IMAGE_CORRUPT');
    expect(code(Buffer.concat([png.subarray(0, 8), Buffer.alloc(30)]))).toBe('IMAGE_CORRUPT');
    expect(code(makePng(0, 300))).toBe('IMAGE_CORRUPT');
    const jpg = makeJpeg(300, 300);
    expect(code(jpg.subarray(0, 20))).toBe('IMAGE_CORRUPT');
    expect(code(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBe('IMAGE_CORRUPT'); // scan before any frame
    const webp = makeWebp(400, 400);
    expect(code(webp.subarray(0, webp.length - 4))).toBe('IMAGE_CORRUPT');
    expect(code(Buffer.concat([webp, Buffer.from('trailing garbage')]))).toBe('IMAGE_CORRUPT');
    expect(code(makeWebp(0 + 1, 1, 'lossless'))).toBe('OK'); // 1x1 is a valid file (the 200 px rule is the route's, not the parser's)
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Stricter structure checks (Docs/23 review #6). Real files made by real encoders (Pillow) live in test/fixtures/images.
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const FIX = path.join(__dirname, '../fixtures/images');
const fix = (name: string) => fs.readFileSync(path.join(FIX, name));
const code = (b: Buffer): string => { try { probeImage(b); return 'OK'; } catch (e) { return (e as ImageError).code; } };

describe('image probe: real photos pass, broken or hollow files do not', () => {
  const REAL: [string, string, number, number][] = [
    ['photo_baseline.jpg', 'jpeg', 320, 240], ['photo_progressive.jpg', 'jpeg', 320, 240], ['photo_exif_rotated.jpg', 'jpeg', 320, 240], ['photo_cmyk.jpg', 'jpeg', 320, 240],
    ['photo.png', 'png', 200, 200], ['photo_interlaced.png', 'png', 200, 200], ['photo_palette.png', 'png', 320, 240],
    ['photo_lossy.webp', 'webp', 320, 240], ['photo_lossless.webp', 'webp', 200, 200], ['photo_alpha_lossy.webp', 'webp', 320, 240], ['photo_animated.webp', 'webp', 200, 200],
  ];

  test.each(REAL)('%s (made by a real encoder) is accepted with its real type and size', (file, kind, w, h) => {
    expect(probeImage(fix(file))).toMatchObject({ kind, width: w, height: h });
  });

  test('every real file cut short anywhere is IMAGE_CORRUPT (never accepted, never a crash)', () => {
    for (const [file] of REAL) {
      const full = fix(file);
      for (const cut of [full.length - 1, full.length - 2, full.length - 12, Math.floor(full.length * 0.9), Math.floor(full.length / 2), 40, 20]) {
        const c = code(full.subarray(0, cut));
        expect([file, cut, c === 'IMAGE_CORRUPT' || c === 'NOT_AN_IMAGE']).toEqual([file, cut, true]);
      }
    }
  });

  test('JPEG: a frame header followed by junk (no scan, no EOI) is corrupt; a real file with junk after the EOI or a flipped tail too; zero padding after EOI is tolerated', () => {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x0b, 0xb8, 0x0b, 0xb8, 0x01, 0x01, 0x11, 0x00]);
    expect(code(Buffer.concat([header, Buffer.from('<?php system($_GET[0]); ?><script>alert(1)</script>'.repeat(10))]))).toBe('IMAGE_CORRUPT');
    expect(code(Buffer.concat([header, Buffer.alloc(1000)]))).toBe('IMAGE_CORRUPT');
    const jpg = fix('photo_baseline.jpg');
    expect(code(Buffer.concat([jpg, Buffer.from('<script>alert(1)</script>')]))).toBe('IMAGE_CORRUPT');
    expect(code(Buffer.concat([jpg, Buffer.alloc(16)]))).toBe('OK');
    const noEoi = Buffer.from(jpg); noEoi[noEoi.length - 1] = 0x00;
    expect(code(noEoi)).toBe('IMAGE_CORRUPT');
    expect(code(makeJpeg(400, 400).subarray(0, makeJpeg(400, 400).length - 2))).toBe('IMAGE_CORRUPT'); // the harness stub without its EOI
    const badPrecision = Buffer.from(jpg); badPrecision[badPrecision.indexOf(Buffer.from([0xff, 0xc0])) + 4] = 12;
    expect(code(badPrecision)).toBe('IMAGE_CORRUPT');
  });

  test('PNG: IHDR + IEND without any IDAT is corrupt; a flipped byte (CRC), a bad zlib header, a missing palette, a wrong colour type, IDAT after another chunk all are', () => {
    const png = fix('photo.png');
    const chunks = (b: Buffer) => { const out: { type: string; start: number; end: number }[] = []; let o = 8; while (o < b.length) { const len = b.readUInt32BE(o); out.push({ type: b.toString('latin1', o + 4, o + 8), start: o, end: o + 12 + len }); o += 12 + len; } return out; };
    const cs = chunks(png);
    const ihdr = cs.find((c) => c.type === 'IHDR')!;
    const iend = cs.find((c) => c.type === 'IEND')!;
    const noIdat = Buffer.concat([png.subarray(0, ihdr.end), png.subarray(iend.start)]);
    expect(code(noIdat)).toBe('IMAGE_CORRUPT');
    const idat = cs.find((c) => c.type === 'IDAT')!;
    const flipped = Buffer.from(png); flipped[idat.start + 12] ^= 0xff;
    expect(code(flipped)).toBe('IMAGE_CORRUPT');
    const badZlib = Buffer.from(png); badZlib[idat.start + 8] = 0x00; // also breaks the CRC: both are refused
    expect(code(badZlib)).toBe('IMAGE_CORRUPT');
    const pal = fix('photo_palette.png');
    const pcs = chunks(pal);
    const plte = pcs.find((c) => c.type === 'PLTE')!;
    expect(code(Buffer.concat([pal.subarray(0, plte.start), pal.subarray(plte.end)]))).toBe('IMAGE_CORRUPT'); // colour type 3 without PLTE
    const badColour = Buffer.from(png); badColour[25] = 5; // IHDR colour type 5 does not exist (CRC wrong as well)
    expect(code(badColour)).toBe('IMAGE_CORRUPT');
    const huge = Buffer.from(png); huge.writeUInt32BE(0x7fffffff, idat.start);
    expect(code(huge)).toBe('IMAGE_CORRUPT'); // a chunk length that runs past the file
    const text = Buffer.from('0000000474455874', 'hex'); // length 4, "tEXt"
    const textChunk = Buffer.concat([text, Buffer.from('abcd'), Buffer.alloc(4)]); textChunk.writeUInt32BE(zlib.crc32(textChunk.subarray(4, 12)) >>> 0, 12);
    const idatCopy = png.subarray(idat.start, idat.end);
    expect(code(Buffer.concat([png.subarray(0, iend.start), textChunk, idatCopy, png.subarray(iend.start)]))).toBe('IMAGE_CORRUPT'); // IDAT chunks must be consecutive
    expect(code(Buffer.concat([png.subarray(0, iend.start), idatCopy, png.subarray(iend.start)]))).toBe('OK'); // two consecutive IDATs are legal
  });

  test('WebP: RIFF length must match, a VP8X without image data is corrupt, a VP8 / VP8L bitstream header must be real, extended canvas must equal the frame', () => {
    const lossy = fix('photo_lossy.webp');
    const longer = Buffer.concat([lossy, Buffer.alloc(2)]);
    expect(code(longer)).toBe('IMAGE_CORRUPT');
    const lied = Buffer.from(lossy); lied.writeUInt32LE(lied.readUInt32LE(4) + 2, 4);
    expect(code(lied)).toBe('IMAGE_CORRUPT');
    const vp8xOnly = Buffer.alloc(30); vp8xOnly.write('RIFF', 0, 'latin1'); vp8xOnly.writeUInt32LE(22, 4); vp8xOnly.write('WEBP', 8, 'latin1'); vp8xOnly.write('VP8X', 12, 'latin1'); vp8xOnly.writeUInt32LE(10, 16); vp8xOnly.writeUIntLE(1999, 24, 3); vp8xOnly.writeUIntLE(1999, 27, 3);
    expect(code(vp8xOnly)).toBe('IMAGE_CORRUPT');
    const noStart = Buffer.from(lossy); noStart[lossy.indexOf(Buffer.from([0x9d, 0x01, 0x2a]))] = 0;
    expect(code(noStart)).toBe('IMAGE_CORRUPT');
    const lossless = Buffer.from(fix('photo_lossless.webp')); lossless[lossless.indexOf('VP8L') + 8] = 0x00; // signature byte 0x2f gone
    expect(code(lossless)).toBe('IMAGE_CORRUPT');
    const alpha = fix('photo_alpha_lossy.webp');
    const wrongCanvas = Buffer.from(alpha); wrongCanvas.writeUIntLE(99, wrongCanvas.indexOf('VP8X') + 12, 3);
    expect(code(wrongCanvas)).toBe('IMAGE_CORRUPT');
    const anim = fix('photo_animated.webp');
    const noFrames = Buffer.from(anim); for (let at = noFrames.indexOf('ANMF'); at >= 0; at = noFrames.indexOf('ANMF', at + 4)) noFrames.write('JUNK', at, 'latin1');
    expect(code(noFrames)).toBe('IMAGE_CORRUPT'); // animation flag set but no frame
    expect(code(makeWebp(400, 300, 'extended'))).toBe('OK');
  });
});
