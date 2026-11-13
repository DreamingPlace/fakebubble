import { ImageError, type Raster } from './png.ts';
import { decodeAlphaLossless, decodeVp8l } from './webp-lossless.ts';
import { decodeVp8, yuvToRgba } from './webp-lossy.ts';

const fail = (code: string): never => {
  throw new ImageError(code);
};

/**
 * A still WebP: simple lossy (VP8), simple lossless (VP8L), or extended (VP8X) with an ALPH plane. Metadata chunks (EXIF, XMP, ICCP)
 * are read past and never kept. Animations are refused (IMAGE_UNSUPPORTED).
 */
export function decodeWebp(bytes: Uint8Array, maxPixels: number): Raster {
  if (
    bytes.length < 20 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP'
  )
    fail('IMAGE_INVALID');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = view.getUint32(4, true) + 8;
  if (riff > bytes.length || riff < 20) fail('IMAGE_INVALID');
  let at = 12,
    vp8: Uint8Array | null = null,
    vp8l: Uint8Array | null = null,
    alph: Uint8Array | null = null,
    animated = false;
  while (at + 8 <= riff) {
    const type = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > riff) fail('IMAGE_INVALID');
    const body = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'VP8X') {
      if (size < 10) fail('IMAGE_INVALID');
      if (body[0]! & 0x02) animated = true;
    } else if (type === 'ANIM' || type === 'ANMF') animated = true;
    else if (type === 'VP8 ' && !vp8) vp8 = body;
    else if (type === 'VP8L' && !vp8l) vp8l = body;
    else if (type === 'ALPH' && !alph) alph = body;
    at += 8 + size + (size & 1);
  }
  if (animated) fail('IMAGE_UNSUPPORTED');
  if (vp8l) return decodeVp8l(vp8l, maxPixels);
  if (!vp8) return fail('IMAGE_INVALID');
  const yuv = decodeVp8(vp8, maxPixels);
  const rgba = yuvToRgba(yuv);
  let alpha = false;
  if (alph && alph.length > 1) {
    const { width, height } = yuv;
    const method = alph[0]! & 3,
      filter = (alph[0]! >> 2) & 3;
    let plane: Uint8Array;
    if (method === 0) {
      if (alph.length < 1 + width * height) fail('IMAGE_INVALID');
      plane = alph.slice(1, 1 + width * height);
    } else if (method === 1) plane = decodeAlphaLossless(alph, 1, width, height);
    else return fail('IMAGE_INVALID');
    // undo the prediction filter
    if (filter !== 0)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          let pred: number;
          if (y === 0) pred = x === 0 ? 0 : plane[i - 1]!;
          else if (x === 0) pred = plane[i - width]!;
          else if (filter === 1) pred = plane[i - 1]!;
          else if (filter === 2) pred = plane[i - width]!;
          else {
            const l = plane[i - 1]!,
              t = plane[i - width]!,
              tl = plane[i - width - 1]!;
            pred = Math.min(255, Math.max(0, l + t - tl));
          }
          plane[i] = (plane[i]! + pred) & 0xff;
        }
    for (let i = 0; i < plane.length; i++) {
      rgba[i * 4 + 3] = plane[i]!;
      if (plane[i] !== 255) alpha = true;
    }
  }
  return { width: yuv.width, height: yuv.height, rgba, alpha };
}
