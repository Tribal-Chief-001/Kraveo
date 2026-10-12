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
