import { deflateSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

/** A decoded picture: 8-bit RGBA, row after row, straight (not premultiplied) alpha. */
export interface Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** True when any pixel is not fully opaque. */
  alpha: boolean;
}
export class ImageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new ImageError(code);
};

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * Decodes a PNG (all colour types and depths, Adam7, tRNS). Only the pixel chunks are read: text, ICC, EXIF and every other
 * ancillary chunk are ignored here and so are never copied to the re-encoded picture. `maxPixels` is checked before anything is inflated.
 */
export function decodePng(bytes: Uint8Array, maxPixels: number): Raster {
  if (bytes.length < 45 || SIGNATURE.some((b, i) => bytes[i] !== b)) fail('IMAGE_INVALID');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8,
    width = 0,
    height = 0,
    depth = 0,
    color = -1,
    interlace = 0,
    palette: Uint8Array | null = null,
    trns: Uint8Array | null = null,
    sawHeader = false,
    sawEnd = false;
  const data: Uint8Array[] = [];
  while (at + 12 <= bytes.length && !sawEnd) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    if (length > bytes.length - at - 12) fail('IMAGE_INVALID');
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (view.getUint32(at + 8 + length) !== crc32(bytes.subarray(at + 4, at + 8 + length))) fail('IMAGE_INVALID');
    if (!sawHeader && type !== 'IHDR') fail('IMAGE_INVALID');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) fail('IMAGE_INVALID');
      sawHeader = true;
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8]!;
      color = body[9]!;
      interlace = body[12]!;
      if (body[10] !== 0 || body[11] !== 0 || interlace > 1 || !DEPTHS[color]?.includes(depth)) fail('IMAGE_INVALID');
      if (width < 1 || height < 1) fail('IMAGE_INVALID');
      if (width * height > maxPixels) fail('IMAGE_TOO_LARGE');
    } else if (type === 'PLTE') {
      if (length === 0 || length % 3 !== 0 || length > 768) fail('IMAGE_INVALID');
      palette = body;
    } else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') sawEnd = true;
    at += 12 + length;
  }
  if (!sawHeader || !sawEnd || data.length === 0) fail('IMAGE_INVALID');
  if (color === 3 && !palette) fail('IMAGE_INVALID');
  const channels = CHANNELS[color]!;
  const bitsPerPixel = channels * depth;
  const stride = (w: number) => Math.ceil((w * bitsPerPixel) / 8);
  const passes: { x0: number; y0: number; dx: number; dy: number }[] =
    interlace === 0
      ? [{ x0: 0, y0: 0, dx: 1, dy: 1 }]
      : [
          { x0: 0, y0: 0, dx: 8, dy: 8 },
          { x0: 4, y0: 0, dx: 8, dy: 8 },
          { x0: 0, y0: 4, dx: 4, dy: 8 },
          { x0: 2, y0: 0, dx: 4, dy: 4 },
          { x0: 0, y0: 2, dx: 2, dy: 4 },
          { x0: 1, y0: 0, dx: 2, dy: 2 },
          { x0: 0, y0: 1, dx: 1, dy: 2 },
        ];
  const dims = passes.map((p) => ({
    ...p,
    w: Math.ceil((width - p.x0) / p.dx),
    h: Math.ceil((height - p.y0) / p.dy),
  }));
  const expected = dims.reduce((n, d) => (d.w > 0 && d.h > 0 ? n + d.h * (stride(d.w) + 1) : n), 0);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
  } catch {
    return fail('IMAGE_INVALID');
  }
  if (raw.length !== expected) fail('IMAGE_INVALID');

  const rgba = new Uint8Array(width * height * 4);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  let alpha = false;
  const sample = (row: Uint8Array, index: number) => {
    // sample number `index` of a row (channel-major within a pixel), as an integer of `depth` bits
    if (depth === 8) return row[index]!;
    if (depth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!;
    const bit = index * depth;
    return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const max = (1 << depth) - 1;
  const to8 = (value: number) => (depth === 8 ? value : depth === 16 ? value >> 8 : Math.round((value * 255) / max));
  let offset = 0;
  for (const d of dims) {
    if (d.w <= 0 || d.h <= 0) continue;
    const size = stride(d.w);
    let previous = new Uint8Array(size);
    for (let y = 0; y < d.h; y++) {
      const filter = raw[offset++]!;
      const row = new Uint8Array(raw.subarray(offset, offset + size));
      offset += size;
      for (let i = 0; i < size; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0,
          b = previous[i]!,
          c = i >= bpp ? previous[i - bpp]! : 0;
        let add: number;
        switch (filter) {
          case 0:
            add = 0;
            break;
          case 1:
            add = a;
            break;
          case 2:
            add = b;
            break;
          case 3:
            add = (a + b) >> 1;
            break;
          case 4: {
            const p = a + b - c,
              pa = Math.abs(p - a),
              pb = Math.abs(p - b),
              pc = Math.abs(p - c);
            add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            break;
          }
          default:
            return fail('IMAGE_INVALID');
        }
        row[i] = (row[i]! + add) & 0xff;
      }
      previous = row;
      const py = d.y0 + y * d.dy;
      for (let x = 0; x < d.w; x++) {
        const o = (py * width + d.x0 + x * d.dx) * 4;
        let r: number, g: number, b: number, a = 255;
        if (color === 0) {
          const v = sample(row, x);
          r = g = b = to8(v);
          if (trns && trns.length >= 2 && v === ((trns[0]! << 8) | trns[1]!)) a = 0;
        } else if (color === 2) {
          const sr = sample(row, x * 3),
            sg = sample(row, x * 3 + 1),
            sb = sample(row, x * 3 + 2);
          r = to8(sr);
          g = to8(sg);
          b = to8(sb);
          if (trns && trns.length >= 6 && sr === ((trns[0]! << 8) | trns[1]!) && sg === ((trns[2]! << 8) | trns[3]!) && sb === ((trns[4]! << 8) | trns[5]!))
            a = 0;
        } else if (color === 3) {
          const i = sample(row, x);
          if (i * 3 + 2 >= palette!.length) fail('IMAGE_INVALID');
          r = palette![i * 3]!;
          g = palette![i * 3 + 1]!;
          b = palette![i * 3 + 2]!;
          if (trns && i < trns.length) a = trns[i]!;
        } else if (color === 4) {
          r = g = b = to8(sample(row, x * 2));
          a = to8(sample(row, x * 2 + 1));
        } else {
          r = to8(sample(row, x * 4));
          g = to8(sample(row, x * 4 + 1));
          b = to8(sample(row, x * 4 + 2));
          a = to8(sample(row, x * 4 + 3));
        }
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = a;
        if (a !== 255) alpha = true;
      }
    }
  }
  return { width, height, rgba, alpha };
}

function chunk(type: string, body: Uint8Array) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
/**
 * Encodes a PNG holding ONLY the picture: IHDR, one IDAT, IEND. No text, ICC profile, EXIF, time or any other ancillary chunk, ever.
 * 8-bit RGB when the raster is opaque, RGBA otherwise; every row uses the Sub filter (small, deterministic).
 */
export function encodePng(picture: Raster): Buffer {
  const { width, height } = picture;
  const channels = picture.alpha ? 4 : 3;
  const line = width * channels;
  const raw = Buffer.alloc((line + 1) * height);
  for (let y = 0; y < height; y++) {
    const base = y * (line + 1);
    raw[base] = 1;
    for (let x = 0; x < width; x++)
      for (let c = 0; c < channels; c++) {
        const value = picture.rgba[(y * width + x) * 4 + c]!;
        const left = x > 0 ? picture.rgba[(y * width + x - 1) * 4 + c]! : 0;
        raw[base + 1 + x * channels + c] = (value - left) & 0xff;
      }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = picture.alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}
