/**
 * Reads the real type and size of an image from its first bytes (Docs/23 section 3.6). No decoding and no dependency: the MAGIC BYTES decide
 * (never the Content-Type header or the file name), and the width / height come from the file header. Only JPEG, PNG and WebP are known;
 * SVG, GIF, HTML, ICO ... are "not an image" for this server.
 */
export type ImageKind = 'jpeg' | 'png' | 'webp';
export type ImageInfo = { kind: ImageKind; ext: 'jpg' | 'png' | 'webp'; mime: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number };

export class ImageError extends Error {
  constructor(public code: 'NOT_AN_IMAGE' | 'IMAGE_CORRUPT', message: string) {
    super(message);
  }
}

const corrupt = () => new ImageError('IMAGE_CORRUPT', 'The image file is damaged or incomplete.');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION_FIELD = 65_535;

const probePng = (b: Buffer): ImageInfo => {
  if (b.length < 33 || b.readUInt32BE(8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') throw corrupt();
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) throw corrupt();
  // Walk the chunks: lengths must fit, IEND must be reached and must be the end of the file (nothing hidden after the image).
  let off = 8;
  let sawEnd = false;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const next = off + 12 + len;
    if (len > 0x7fffffff || next > b.length) throw corrupt();
    off = next;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd || off !== b.length) throw corrupt();
  return { kind: 'png', ext: 'png', mime: 'image/png', width, height };
};

const probeJpeg = (b: Buffer): ImageInfo => {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw corrupt();
    while (i < b.length && b[i] === 0xff) i += 1; // fill bytes
    const marker = b[i];
    i += 1;
    if (marker === undefined) throw corrupt();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // markers without a length
    if (marker === 0xd9 || marker === 0xda) throw corrupt(); // EOI / start of scan before any frame header
    if (i + 2 > b.length) throw corrupt();
    const segLen = b.readUInt16BE(i);
    if (segLen < 2 || i + segLen > b.length) throw corrupt();
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (segLen < 8) throw corrupt();
      const height = b.readUInt16BE(i + 3);
      const width = b.readUInt16BE(i + 5);
      if (width === 0 || height === 0 || width > MAX_DIMENSION_FIELD || height > MAX_DIMENSION_FIELD) throw corrupt();
      return { kind: 'jpeg', ext: 'jpg', mime: 'image/jpeg', width, height };
    }
    i += segLen;
  }
  throw corrupt();
};

const probeWebp = (b: Buffer): ImageInfo => {
  if (b.length < 30) throw corrupt();
  const riffSize = b.readUInt32LE(4);
  const total = riffSize + 8;
  if (total > b.length || b.length - total > 1) throw corrupt(); // truncated, or something appended after the RIFF container
  const fourcc = b.toString('latin1', 12, 16);
  let width: number;
  let height: number;
  if (fourcc === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw corrupt();
    width = b.readUInt16LE(26) & 0x3fff;
    height = b.readUInt16LE(28) & 0x3fff;
  } else if (fourcc === 'VP8L') {
    if (b[20] !== 0x2f) throw corrupt();
    const bits = b.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (fourcc === 'VP8X') {
    width = b.readUIntLE(24, 3) + 1;
    height = b.readUIntLE(27, 3) + 1;
  } else {
    throw corrupt();
  }
  if (width <= 0 || height <= 0) throw corrupt();
  return { kind: 'webp', ext: 'webp', mime: 'image/webp', width, height };
};

export const probeImage = (b: Buffer): ImageInfo => {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return probePng(b);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return probeJpeg(b);
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return probeWebp(b);
  throw new ImageError('NOT_AN_IMAGE', 'Only JPEG, PNG or WebP photos can be uploaded.');
};
