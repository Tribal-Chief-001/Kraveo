/**
 * Reads the real type and size of an image from its bytes (Docs/23 section 3.6). No decoding and no dependency: the MAGIC BYTES decide
 * (never the Content-Type header or the file name), the width / height come from the file header, and the file STRUCTURE must be complete so a
 * 15-byte header followed by arbitrary bytes is not an "image":
 *   JPEG  SOI, a frame header (8-bit, 1..4 components), a scan header, entropy data, and EOI as the last bytes (only zero padding after it);
 *   PNG   IHDR with valid fields, a palette where the colour type needs one, at least one IDAT starting with a zlib header, IEND as the last
 *         chunk, every chunk length inside the file and every chunk CRC correct;
 *   WebP  a RIFF length that matches the file exactly, a VP8 / VP8L bitstream header with data (or, for the extended format, the same frame
 *         chunk whose size equals the canvas, or animation frames).
 * Only JPEG, PNG and WebP are known; SVG, GIF, HTML, ICO ... are "not an image" for this server. The server never decodes pixels.
 */
export type ImageKind = 'jpeg' | 'png' | 'webp';
export type ImageInfo = { kind: ImageKind; ext: 'jpg' | 'png' | 'webp'; mime: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number };

export class ImageError extends Error {
  constructor(public code: 'NOT_AN_IMAGE' | 'IMAGE_CORRUPT', message: string) {
    super(message);
  }
}

const corrupt = () => new ImageError('IMAGE_CORRUPT', 'The image file is damaged or incomplete. Choose the photo again.');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION_FIELD = 65_535;

// CRC-32 (the PNG / zlib polynomial); table built once. Does not depend on the Node version (zlib.crc32 is new).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer, from: number, to: number): number => {
  let c = 0xffffffff;
  for (let i = from; i < to; i += 1) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const probePng = (b: Buffer): ImageInfo => {
  if (b.length < 45 || b.readUInt32BE(8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') throw corrupt();
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const depth = b[24];
  const colour = b[25];
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) throw corrupt();
  if (!PNG_DEPTHS[colour]?.includes(depth) || b[26] !== 0 || b[27] !== 0 || (b[28] !== 0 && b[28] !== 1)) throw corrupt();

  let off = 8;
  let sawPalette = false;
  let sawEnd = false;
  let idatBytes = 0;
  let idatSeen = false;
  let idatClosed = false;
  let zlibHead = -1;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const next = off + 12 + len;
    if (len > 0x7fffffff || next > b.length || !/^[A-Za-z]{4}$/.test(type)) throw corrupt();
    if (b.readUInt32BE(next - 4) !== crc32(b, off + 4, next - 4)) throw corrupt();
    if (type === 'IDAT') {
      if (idatClosed) throw corrupt(); // image data chunks must be consecutive
      if (!idatSeen && len >= 2) zlibHead = (b[off + 8] << 8) | b[off + 9];
      idatSeen = true;
      idatBytes += len;
    } else if (idatSeen) {
      idatClosed = true;
    }
    if (type === 'PLTE') {
      if (idatSeen || len === 0 || len % 3 !== 0 || len > 768) throw corrupt();
      sawPalette = true;
    }
    off = next;
    if (type === 'IEND') { sawEnd = len === 0; break; }
  }
  if (!sawEnd || off !== b.length) throw corrupt(); // IEND last, nothing hidden after the image
  if (idatBytes < 2 || zlibHead < 0 || (zlibHead & 0x0f00) !== 0x0800 || zlibHead % 31 !== 0) throw corrupt(); // data present, valid zlib header
  if ((colour === 3 && !sawPalette) || ((colour === 0 || colour === 4) && sawPalette)) throw corrupt();
  return { kind: 'png', ext: 'png', mime: 'image/png', width, height };
};

const probeJpeg = (b: Buffer): ImageInfo => {
  let i = 2;
  let frame: { width: number; height: number } | null = null;
  let scanStart = -1;
  while (i < b.length) {
    if (b[i] !== 0xff) throw corrupt();
    while (i < b.length && b[i] === 0xff) i += 1; // fill bytes
    const marker = b[i];
    i += 1;
    if (marker === undefined) throw corrupt();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // markers without a length
    if (marker === 0xd9) throw corrupt(); // EOI before any scan
    if (i + 2 > b.length) throw corrupt();
    const segLen = b.readUInt16BE(i);
    if (segLen < 2 || i + segLen > b.length) throw corrupt();
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (frame || segLen < 11) throw corrupt();
      const precision = b[i + 2];
      const height = b.readUInt16BE(i + 3);
      const width = b.readUInt16BE(i + 5);
      const comps = b[i + 7];
      if (precision !== 8 || comps < 1 || comps > 4 || segLen !== 8 + 3 * comps) throw corrupt();
      if (width === 0 || height === 0 || width > MAX_DIMENSION_FIELD || height > MAX_DIMENSION_FIELD) throw corrupt();
      frame = { width, height };
    } else if (marker === 0xda) {
      const ns = b[i + 2];
      if (!frame || ns < 1 || ns > 4 || segLen !== 6 + 2 * ns) throw corrupt(); // a scan needs its frame header first
      scanStart = i + segLen;
      break;
    }
    i += segLen;
  }
  if (!frame || scanStart < 0) throw corrupt();
  // The entropy-coded data must exist and the file must END with EOI (zero padding after it is tolerated, nothing else).
  let end = b.length;
  while (end > scanStart && b[end - 1] === 0x00) end -= 1;
  if (end - scanStart < 3 || b[end - 2] !== 0xff || b[end - 1] !== 0xd9) throw corrupt();
  return { kind: 'jpeg', ext: 'jpg', mime: 'image/jpeg', width: frame.width, height: frame.height };
};

const probeWebp = (b: Buffer): ImageInfo => {
  if (b.length < 30) throw corrupt();
  const riffSize = b.readUInt32LE(4);
  if (riffSize + 8 !== b.length || riffSize % 2 !== 0) throw corrupt(); // the container length must match the file exactly
  let off = 12;
  let canvas: { width: number; height: number; animated: boolean } | null = null;
  let frameDims: { width: number; height: number } | null = null;
  let animFrames = 0;
  let first = true;
  while (off + 8 <= b.length) {
    const fourcc = b.toString('latin1', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const data = off + 8;
    if (data + size > b.length) throw corrupt();
    if (first && fourcc !== 'VP8X' && fourcc !== 'VP8 ' && fourcc !== 'VP8L') throw corrupt();
    if (fourcc === 'VP8X') {
      if (!first || size < 10) throw corrupt();
      canvas = { width: b.readUIntLE(data + 4, 3) + 1, height: b.readUIntLE(data + 7, 3) + 1, animated: (b[data] & 0x02) !== 0 };
    } else if (fourcc === 'VP8 ' || fourcc === 'VP8L') {
      if (frameDims) throw corrupt(); // one still image per file
      if (fourcc === 'VP8 ') {
        if (size < 11 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) throw corrupt();
        frameDims = { width: b.readUInt16LE(data + 6) & 0x3fff, height: b.readUInt16LE(data + 8) & 0x3fff };
      } else {
        if (size < 6 || b[data] !== 0x2f || (b[data + 4] >>> 5) !== 0) throw corrupt();
        const bits = b.readUInt32LE(data + 1);
        frameDims = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    } else if (fourcc === 'ANMF') {
      if (size < 17) throw corrupt(); // 16 bytes of frame header + frame data
      animFrames += 1;
    }
    first = false;
    off = data + size + (size % 2);
  }
  if (off !== b.length) throw corrupt();
  let width: number;
  let height: number;
  if (canvas?.animated) {
    if (animFrames === 0) throw corrupt();
    ({ width, height } = canvas);
  } else {
    if (!frameDims || frameDims.width === 0 || frameDims.height === 0) throw corrupt();
    if (canvas && (canvas.width !== frameDims.width || canvas.height !== frameDims.height)) throw corrupt();
    ({ width, height } = frameDims);
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
