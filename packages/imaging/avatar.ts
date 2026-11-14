import { createHash } from 'node:crypto';
import { ImageError, decodePng, encodePng } from './png.ts';

/**
 * Part 31 (25e) / 31b: the one image of a character. Limits are the contract; the server, the page and the tests all read these.
 *
 * Part 31b: decoding a big JPEG or WebP in JS took about a second inside the single business object, so it no longer happens there.
 * The admin's BROWSER decodes whatever the admin picked (PNG, JPEG or WebP), crops it to a square, shrinks it to at most 512 px and
 * encodes a PNG (a canvas); the server accepts that PNG only, checks it, decodes it and encodes it again, so what is stored holds
 * pixels and nothing else.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** The picture the server accepts: a square PNG of at most this many pixels per side. */
export const AVATAR_MAX_SIDE = 512;
export const AVATAR_MIN_SIDE = 64;
/** What the admin's browser may pick (checked by the page; the server only ever sees the PNG the page made). */
export const AVATAR_PICK_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** True when the bytes begin with the PNG signature (never the file name or a declared type). */
export const isPng = (bytes: Uint8Array) => bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);

export interface NormalizedAvatar {
  png: Uint8Array;
  width: number;
  height: number;
  sha256: string;
}
/**
 * Signature, IHDR dimensions (square, 64..512) before anything is inflated, every chunk CRC, then decode and encode again as a PNG
 * that carries ONLY pixels: no EXIF / GPS / ICC / XMP / text chunk can survive because nothing but the decoded pixels is written.
 * Throws ImageError with one of AVATAR_TOO_LARGE, AVATAR_FORMAT (not a PNG: JPEG, WebP, SVG, anything), AVATAR_INVALID (does not
 * decode, bad checksum, a stream that inflates beyond its header), AVATAR_DIMENSIONS (not square, or outside 64..512).
 */
export function normalizeAvatar(bytes: Uint8Array): NormalizedAvatar {
  if (bytes.length === 0) throw new ImageError('AVATAR_INVALID');
  if (bytes.length > AVATAR_MAX_BYTES) throw new ImageError('AVATAR_TOO_LARGE');
  if (!isPng(bytes)) throw new ImageError('AVATAR_FORMAT');
  if (bytes.length < 33) throw new ImageError('AVATAR_INVALID');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR')
    throw new ImageError('AVATAR_INVALID');
  if (width !== height || width < AVATAR_MIN_SIDE || width > AVATAR_MAX_SIDE) throw new ImageError('AVATAR_DIMENSIONS');
  let picture;
  try {
    picture = decodePng(bytes, AVATAR_MAX_SIDE * AVATAR_MAX_SIDE);
  } catch {
    // a decoder that runs off the end of a damaged file is a bad file, not a server fault
    throw new ImageError('AVATAR_INVALID');
  }
  const png = new Uint8Array(encodePng(picture));
  return { png, width: picture.width, height: picture.height, sha256: createHash('sha256').update(png).digest('hex') };
}
