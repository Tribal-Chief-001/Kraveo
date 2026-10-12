// Shrinks a photo in the browser before it is uploaded (Docs/23 section 4): longest side <= 1200 px, WebP when the browser can
// make it (otherwise JPEG), quality about 0.82, and the result must be <= 1 MB (the server's limit) or it is shrunk further.
// The browser parts (decode, canvas) sit behind `ImageEnv` so tests can run the real algorithm with a fake canvas.

export const MAX_SIDE_PX = 1200;
export const MAX_UPLOAD_BYTES = 1024 * 1024;
export const START_QUALITY = 0.82;
/** The server refuses photos whose shorter side is under this (Docs/23 3.6). */
export const MIN_SIDE_PX = 200;
const MIN_QUALITY = 0.5;
const MAX_ROUNDS = 14;

export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** A problem the admin can fix (wrong file, unreadable picture, too small). `message` is shown as it is. */
export class ImageProblem extends Error {
  constructor(message: string, public code: 'NOT_AN_IMAGE' | 'UNREADABLE' | 'TOO_SMALL' | 'TOO_BIG' | 'ENCODE_FAILED') {
    super(message);
    this.name = 'ImageProblem';
  }
}

export interface Decoded {
  width: number;
  height: number;
  /** Opaque to the algorithm; handed back to `encode`. */
  source: unknown;
  release?: () => void;
}

export interface ImageEnv {
  decode: (file: Blob) => Promise<Decoded>;
  /** Draws the picture at width x height and encodes it. `null` = the browser could not encode. */
  encode: (decoded: Decoded, width: number, height: number, mime: string, quality: number) => Promise<Blob | null>;
  webpSupported: () => boolean;
}

export interface Compressed {
  blob: Blob;
  width: number;
  height: number;
  mime: string;
  originalBytes: number;
}

const fit = (width: number, height: number, maxSide: number): { width: number; height: number } => {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

const sizeText = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Plain-words check of the chosen file before anything is decoded. Returns a message or '' when it may be tried. */
export const checkPickedFile = (file: { type?: string; name?: string; size?: number }): string => {
  const type = (file.type || '').toLowerCase();
  if (type === 'image/svg+xml' || /\.svgz?$/i.test(file.name || '')) return 'SVG pictures cannot be used. Export the picture as JPG or PNG and choose that.';
  if (!type.startsWith('image/')) return 'That file is not a picture. Choose a JPG, PNG or WebP photo.';
  if (file.size === 0) return 'That file is empty. Choose another photo.';
  return '';
};

export const compressImage = async (file: Blob & { name?: string }, env: ImageEnv = browserEnv(), opts: { maxSide?: number; maxBytes?: number } = {}): Promise<Compressed> => {
  const maxSide = opts.maxSide ?? MAX_SIDE_PX;
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const problem = checkPickedFile(file);
  if (problem) throw new ImageProblem(problem, 'NOT_AN_IMAGE');

  let decoded: Decoded;
  try {
    decoded = await env.decode(file);
  } catch {
    throw new ImageProblem('This picture could not be opened. The file may be damaged, or the browser cannot read this kind of picture. Try a JPG or PNG.', 'UNREADABLE');
  }
  try {
    if (!(decoded.width > 0 && decoded.height > 0)) throw new ImageProblem('This picture has no size, so it cannot be used. Try another photo.', 'UNREADABLE');
    if (Math.min(decoded.width, decoded.height) < MIN_SIDE_PX) {
      throw new ImageProblem(`This picture is too small (${decoded.width} x ${decoded.height}). The shorter side must be at least ${MIN_SIDE_PX} pixels.`, 'TOO_SMALL');
    }

    const mime = env.webpSupported() ? 'image/webp' : 'image/jpeg';
    let size = fit(decoded.width, decoded.height, maxSide);
    let quality = START_QUALITY;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let blob: Blob | null;
      try {
        blob = await env.encode(decoded, size.width, size.height, mime, quality);
      } catch {
        blob = null;
      }
      if (!blob || blob.size === 0) throw new ImageProblem('The browser could not prepare this picture. Try another photo or a smaller one.', 'ENCODE_FAILED');
      const type = (blob.type || mime).toLowerCase();
      if (!(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(type)) throw new ImageProblem('The browser could not make a JPG or WebP from this picture. Try another photo.', 'ENCODE_FAILED');
      if (blob.size <= maxBytes) return { blob, width: size.width, height: size.height, mime: type, originalBytes: file.size };
      // Too big: lower the quality first, then the size.
      if (quality - 0.1 >= MIN_QUALITY - 1e-9) {
        quality = Math.round((quality - 0.1) * 100) / 100;
      } else {
        const next = { width: Math.round(size.width * 0.85), height: Math.round(size.height * 0.85) };
        if (Math.min(next.width, next.height) < MIN_SIDE_PX) {
          throw new ImageProblem(`This picture is still ${sizeText(blob.size)} after shrinking it, and the limit is ${sizeText(maxBytes)}. Choose a simpler photo.`, 'TOO_BIG');
        }
        size = next;
        quality = 0.7;
      }
    }
    throw new ImageProblem(`This picture could not be made smaller than ${sizeText(maxBytes)}. Choose a simpler photo.`, 'TOO_BIG');
  } finally {
    decoded.release?.();
  }
};

// ───────────────────────────── the real browser ─────────────────────────────

export const browserEnv = (): ImageEnv => ({
  decode: async (file) => {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file);
      return { width: bitmap.width, height: bitmap.height, source: bitmap, release: () => { try { bitmap.close(); } catch { /* already closed */ } } };
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('decode failed'));
        image.src = url;
      });
      return { width: image.naturalWidth, height: image.naturalHeight, source: image };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  encode: (decoded, width, height, mime, quality) => new Promise<Blob | null>((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { resolve(null); return; }
    // JPEG has no transparency: a transparent PNG would turn black without a white background.
    if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source as CanvasImageSource, 0, 0, width, height);
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  }),
  webpSupported: () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1;
      return canvas.toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      return false;
    }
  },
});
