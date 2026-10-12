import { describe, expect, it, vi } from 'vitest';
import { Decoded, ImageEnv, ImageProblem, checkPickedFile, compressImage } from './imageCompress';

const file = (type: string, size = 5000, name = 'photo.jpg') => Object.assign(new Blob([new Uint8Array(size)], { type }), { name });
// A stand-in with just a size and a type: the algorithm only reads those two (a real 100 MB Blob would slow the test for nothing).
const blobOf = (bytes: number, type = 'image/webp') => ({ size: bytes, type }) as unknown as Blob;

/** A fake canvas: the encoded size depends on the pixel count and the quality, like a real encoder. */
const fakeEnv = (dims: { width: number; height: number } | Error, opts: { webp?: boolean; bytesPerPixel?: number; returnNull?: boolean } = {}) => {
  const encodeCalls: Array<{ width: number; height: number; mime: string; quality: number }> = [];
  const release = vi.fn();
  const env: ImageEnv = {
    decode: async () => {
      if (dims instanceof Error) throw dims;
      return { ...dims, source: {}, release } as Decoded;
    },
    encode: async (_d, width, height, mime, quality) => {
      encodeCalls.push({ width, height, mime, quality });
      if (opts.returnNull) return null;
      return blobOf(Math.round(width * height * (opts.bytesPerPixel ?? 0.05) * quality), mime);
    },
    webpSupported: () => opts.webp !== false,
  };
  return { env, encodeCalls, release };
};

describe('checkPickedFile', () => {
  it('accepts pictures and refuses everything else in plain words', () => {
    expect(checkPickedFile({ type: 'image/jpeg', name: 'a.jpg', size: 10 })).toBe('');
    expect(checkPickedFile({ type: 'application/pdf', name: 'a.pdf', size: 10 })).toBe('That file is not a picture. Choose a JPG, PNG or WebP photo.');
    expect(checkPickedFile({ type: '', name: 'a', size: 10 })).toMatch(/not a picture/);
    expect(checkPickedFile({ type: 'image/svg+xml', name: 'a.svg', size: 10 })).toMatch(/SVG/);
    expect(checkPickedFile({ type: 'image/png', name: 'logo.SVG', size: 10 })).toMatch(/SVG/);
    expect(checkPickedFile({ type: 'image/png', name: 'a.png', size: 0 })).toMatch(/empty/);
  });
});

describe('compressImage', () => {
  it('scales the longest side down to 1200 px, keeps the ratio, and prefers WebP at quality 0.82', async () => {
    const { env, encodeCalls, release } = fakeEnv({ width: 4000, height: 3000 });
    const out = await compressImage(file('image/jpeg'), env);
    expect(encodeCalls).toEqual([{ width: 1200, height: 900, mime: 'image/webp', quality: 0.82 }]);
    expect(out).toMatchObject({ width: 1200, height: 900, mime: 'image/webp', originalBytes: 5000 });
    expect(out.blob.size).toBeLessThanOrEqual(1024 * 1024);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not enlarge a small picture', async () => {
    const { env, encodeCalls } = fakeEnv({ width: 800, height: 600 });
    await compressImage(file('image/png'), env);
    expect(encodeCalls[0]).toMatchObject({ width: 800, height: 600 });
  });

  it('portrait pictures are limited on the height', async () => {
    const { env, encodeCalls } = fakeEnv({ width: 1500, height: 3000 });
    await compressImage(file('image/jpeg'), env);
    expect(encodeCalls[0]).toMatchObject({ width: 600, height: 1200 });
  });

  it('falls back to JPEG when the browser cannot make WebP', async () => {
    const { env, encodeCalls } = fakeEnv({ width: 2000, height: 1000 }, { webp: false });
    const out = await compressImage(file('image/png'), env);
    expect(encodeCalls[0].mime).toBe('image/jpeg');
    expect(out.mime).toBe('image/jpeg');
  });

  it('lowers the quality, then the size, until the result is at most 1 MB', async () => {
    // 1200x900 at 0.82 -> 1,080,000 * 1.5 * 0.82 = ~1.33 MB: too big. It must retry smaller.
    const { env, encodeCalls } = fakeEnv({ width: 4000, height: 3000 }, { bytesPerPixel: 1.5 });
    const out = await compressImage(file('image/jpeg'), env);
    expect(encodeCalls.length).toBeGreaterThan(1);
    expect(encodeCalls[1].quality).toBeLessThan(encodeCalls[0].quality);
    expect(out.blob.size).toBeLessThanOrEqual(1024 * 1024);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1200);
    expect(Math.min(out.width, out.height)).toBeGreaterThanOrEqual(200);
    for (const call of encodeCalls) expect(call.quality).toBeGreaterThanOrEqual(0.5);
  });

  it('gives up with a plain message when it cannot get small enough without going under 200 px', async () => {
    const { env } = fakeEnv({ width: 1200, height: 900 }, { bytesPerPixel: 500 });
    await expect(compressImage(file('image/jpeg'), env)).rejects.toMatchObject({ name: 'ImageProblem', code: 'TOO_BIG' });
  });

  it('refuses a picture whose shorter side is under 200 px (the server would refuse it too)', async () => {
    const { env, encodeCalls } = fakeEnv({ width: 1000, height: 150 });
    await expect(compressImage(file('image/png'), env)).rejects.toThrow('too small (1000 x 150)');
    expect(encodeCalls).toHaveLength(0);
  });

  it('a file that is not an image never reaches the decoder', async () => {
    const decode = vi.fn();
    await expect(compressImage(file('text/plain', 10, 'a.txt'), { decode, encode: vi.fn(), webpSupported: () => true })).rejects.toMatchObject({ code: 'NOT_AN_IMAGE', message: 'That file is not a picture. Choose a JPG, PNG or WebP photo.' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('a picture the browser cannot decode is a plain error', async () => {
    const { env } = fakeEnv(new Error('bad data'));
    await expect(compressImage(file('image/jpeg'), env)).rejects.toMatchObject({ code: 'UNREADABLE' });
    await expect(compressImage(file('image/jpeg'), env)).rejects.toThrow(/could not be opened/);
  });

  it('zero-sized pictures and encoder failures are plain errors and the bitmap is still released', async () => {
    const zero = fakeEnv({ width: 0, height: 0 });
    await expect(compressImage(file('image/jpeg'), zero.env)).rejects.toBeInstanceOf(ImageProblem);
    expect(zero.release).toHaveBeenCalled();
    const broken = fakeEnv({ width: 800, height: 600 }, { returnNull: true });
    await expect(compressImage(file('image/jpeg'), broken.env)).rejects.toMatchObject({ code: 'ENCODE_FAILED' });
    expect(broken.release).toHaveBeenCalled();
  });

  it('refuses output the server would not accept (the browser silently made a GIF, say)', async () => {
    const env: ImageEnv = { decode: async () => ({ width: 800, height: 600, source: {} }), encode: async () => blobOf(1000, 'image/gif'), webpSupported: () => true };
    await expect(compressImage(file('image/jpeg'), env)).rejects.toMatchObject({ code: 'ENCODE_FAILED' });
  });

  it('accepts a browser that fell back to PNG for an unsupported type', async () => {
    const env: ImageEnv = { decode: async () => ({ width: 800, height: 600, source: {} }), encode: async () => blobOf(1000, 'image/png'), webpSupported: () => true };
    expect((await compressImage(file('image/jpeg'), env)).mime).toBe('image/png');
  });
});
