import zlib from 'zlib';

/** Tiny hand-made image files for the upload tests. The server only reads headers (it never decodes), so the pixel data is a stub. */
const crc = (b: Buffer) => zlib.crc32(b) >>> 0;

const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};

/** A PNG with the given size. `padding` adds that many bytes of (valid) ancillary data to reach a wanted file size. */
export const makePng = (width: number, height: number, padding = 0): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
  if (padding > 0) parts.push(pngChunk('tEXt', Buffer.alloc(padding, 0x61)));
  parts.push(pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(16))), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
};

export const makeJpeg = (width: number, height: number, progressive = false): Buffer => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 8)]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = progressive ? 0xc2 : 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  [[1, 0x22, 0], [2, 0x11, 1], [3, 0x11, 1]].forEach(([id, hv, tq], i) => { sof[10 + i * 3] = id; sof[11 + i * 3] = hv; sof[12 + i * 3] = tq; });
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, sof, sos, Buffer.alloc(32, 0x55), Buffer.from([0xff, 0xd9])]);
};

const riff = (fourcc: string, data: Buffer) => {
  const chunk = Buffer.concat([Buffer.from(fourcc, 'latin1'), (() => { const l = Buffer.alloc(4); l.writeUInt32LE(data.length); return l; })(), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + chunk.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, chunk]);
};

export const makeWebp = (width: number, height: number, kind: 'lossy' | 'lossless' | 'extended' = 'lossy'): Buffer => {
  if (kind === 'lossy') {
    const d = Buffer.alloc(20);
    d[3] = 0x9d; d[4] = 0x01; d[5] = 0x2a;
    d.writeUInt16LE(width, 6); d.writeUInt16LE(height, 8);
    return riff('VP8 ', d);
  }
  if (kind === 'lossless') {
    const d = Buffer.alloc(16);
    d[0] = 0x2f;
    d.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
    return riff('VP8L', d);
  }
  const d = Buffer.alloc(18);
  d.writeUIntLE(width - 1, 4, 3); d.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', d);
};

export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script></svg>');
export const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40, 1)]);
export const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
