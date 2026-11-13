import { createHash } from 'node:crypto';
import { ImageError, decodePng, encodePng, type Raster } from './png.ts';
import { decodeJpeg } from './jpeg.ts';
import { decodeWebp } from './webp.ts';

/** Part 31 (25e): the one image of a character. Limits are the contract; the server, the page and the tests all read these. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Decoding needs about 10 bytes per pixel at once; 8 megapixels stay well inside a Worker's memory. */
export const AVATAR_MAX_PIXELS = 8_000_000;
export const AVATAR_MAX_SIDE = 4096;
export const AVATAR_MIN_SIDE = 64;
/** The stored picture is a square of at most this many pixels per side (a retina circle of 170 px still has 3x). */
export const AVATAR_OUTPUT_SIDE = 512;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

/** What the bytes ARE, by their signature alone (never the file name or a declared type). SVG, GIF, BMP, ... are null. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP')
    return 'webp';
  return null;
}

/** Centre-crop to a square, then area-average down to at most `side` pixels. Colour is averaged premultiplied by alpha. */
function squareAndShrink(source: Raster, side: number): Raster {
  const size = Math.min(source.width, source.height);
  const x0 = (source.width - size) >> 1,
    y0 = (source.height - size) >> 1;
  const out = Math.min(size, side);
  const rgba = new Uint8Array(out * out * 4);
  let alpha = false;
  for (let y = 0; y < out; y++) {
    const ya = Math.floor((y * size) / out),
      yb = Math.max(ya + 1, Math.ceil(((y + 1) * size) / out));
    for (let x = 0; x < out; x++) {
      const xa = Math.floor((x * size) / out),
        xb = Math.max(xa + 1, Math.ceil(((x + 1) * size) / out));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = ya; sy < yb; sy++)
        for (let sx = xa; sx < xb; sx++) {
          const i = ((y0 + sy) * source.width + x0 + sx) * 4;
          const w = source.rgba[i + 3]!;
          r += source.rgba[i]! * w;
          g += source.rgba[i + 1]! * w;
          b += source.rgba[i + 2]! * w;
          a += w;
          n++;
        }
      const o = (y * out + x) * 4;
      if (a > 0) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
      }
      rgba[o + 3] = Math.round(a / n);
      if (rgba[o + 3] !== 255) alpha = true;
    }
  }
  return { width: out, height: out, rgba, alpha };
}

export interface NormalizedAvatar {
  png: Uint8Array;
  width: number;
  height: number;
  sha256: string;
  /** What the upload was, for the admin's information only. */
  source: 'png' | 'jpeg' | 'webp';
  sourceWidth: number;
  sourceHeight: number;
}
/**
 * Decode, check the bounds, crop to a square, shrink, and encode again as a PNG that carries ONLY pixels: no EXIF / GPS / ICC / XMP /
 * text chunk can survive because nothing but the decoded pixels is written. Throws ImageError with one of AVATAR_TOO_LARGE,
 * AVATAR_FORMAT (not PNG / JPEG / WebP, including SVG), AVATAR_INVALID (does not decode), AVATAR_DIMENSIONS (too big or too small).
 */
export function normalizeAvatar(bytes: Uint8Array): NormalizedAvatar {
  if (bytes.length === 0) throw new ImageError('AVATAR_INVALID');
  if (bytes.length > AVATAR_MAX_BYTES) throw new ImageError('AVATAR_TOO_LARGE');
  const kind = sniffImage(bytes);
  if (!kind) throw new ImageError('AVATAR_FORMAT');
  let picture: Raster;
  try {
    picture = kind === 'png' ? decodePng(bytes, AVATAR_MAX_PIXELS) : kind === 'jpeg' ? decodeJpeg(bytes, AVATAR_MAX_PIXELS) : decodeWebp(bytes, AVATAR_MAX_PIXELS);
  } catch (error) {
    if (error instanceof ImageError)
      throw new ImageError(error.code === 'IMAGE_TOO_LARGE' ? 'AVATAR_DIMENSIONS' : error.code === 'IMAGE_UNSUPPORTED' ? 'AVATAR_FORMAT' : 'AVATAR_INVALID');
    // A decoder that runs off the end of a damaged file is a bad file, not a server fault.
    throw new ImageError('AVATAR_INVALID');
  }
  if (Math.max(picture.width, picture.height) > AVATAR_MAX_SIDE || Math.min(picture.width, picture.height) < AVATAR_MIN_SIDE)
    throw new ImageError('AVATAR_DIMENSIONS');
  const square = squareAndShrink(picture, AVATAR_OUTPUT_SIDE);
  const png = new Uint8Array(encodePng(square));
  return {
    png,
    width: square.width,
    height: square.height,
    sha256: createHash('sha256').update(png).digest('hex'),
    source: kind,
    sourceWidth: picture.width,
    sourceHeight: picture.height,
  };
}
