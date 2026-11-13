import { ImageError } from './png.ts';

const fail = (code: string): never => {
  throw new ImageError(code);
};

/** LSB-first bit reader (the VP8L bit order). */
export class Bits {
  readonly data: Uint8Array;
  pos: number;
  bit = 0;
  constructor(data: Uint8Array, start: number) {
    this.data = data;
    this.pos = start;
  }
  read(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.data.length) fail('IMAGE_INVALID');
      value |= ((this.data[this.pos]! >> this.bit) & 1) << i;
      if (++this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    return value >>> 0;
  }
  one() {
    if (this.pos >= this.data.length) fail('IMAGE_INVALID');
    const v = (this.data[this.pos]! >> this.bit) & 1;
    if (++this.bit === 8) {
      this.bit = 0;
      this.pos++;
    }
    return v;
  }
}

/** Canonical Huffman code read one bit at a time, first bit = most significant bit of the code. */
interface Code {
  single: number; // >= 0: the only symbol, zero bits
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  symbols: Uint16Array;
}
function buildCode(lengths: Uint8Array): Code {
  const counts = new Array<number>(16).fill(0);
  let used = 0,
    last = 0;
  for (let s = 0; s < lengths.length; s++)
    if (lengths[s]! > 0) {
      counts[lengths[s]!]!++;
      used++;
      last = s;
    }
  if (used === 0) return { single: 0, maxcode: new Int32Array(0), valptr: new Int32Array(0), mincode: new Int32Array(0), symbols: new Uint16Array(0) };
  if (used === 1) return { single: last, maxcode: new Int32Array(0), valptr: new Int32Array(0), mincode: new Int32Array(0), symbols: new Uint16Array(0) };
  const symbols = new Uint16Array(used);
  const maxcode = new Int32Array(17).fill(-1),
    valptr = new Int32Array(17),
    mincode = new Int32Array(17);
  let code = 0,
    k = 0;
  for (let length = 1; length <= 15; length++) {
    valptr[length] = k;
    mincode[length] = code;
    for (let s = 0; s < lengths.length; s++) if (lengths[s] === length) symbols[k++] = s;
    code += counts[length]!;
    maxcode[length] = counts[length]! > 0 ? code - 1 : -1;
    if (code > 1 << length) fail('IMAGE_INVALID');
    code <<= 1;
  }
  // a complete code uses every leaf
  let sum = 0;
  for (let length = 1; length <= 15; length++) sum += counts[length]! * 2 ** (15 - length);
  if (sum !== 1 << 15) fail('IMAGE_INVALID');
  return { single: -1, maxcode, valptr, mincode, symbols };
}
function readSymbol(bits: Bits, code: Code): number {
  if (code.single >= 0) return code.single;
  let value = 0;
  for (let length = 1; length <= 15; length++) {
    value = (value << 1) | bits.one();
    const max = code.maxcode[length]!;
    if (max >= 0 && value <= max && value >= code.mincode[length]!) return code.symbols[code.valptr[length]! + value - code.mincode[length]!]!;
  }
  return fail('IMAGE_INVALID');
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
function readCode(bits: Bits, alphabet: number): Code {
  const lengths = new Uint8Array(alphabet);
  if (bits.one()) {
    // simple code: one or two symbols
    const count = bits.one() + 1;
    const first = bits.one() ? bits.read(8) : bits.read(1);
    if (first >= alphabet) fail('IMAGE_INVALID');
    lengths[first] = 1;
    if (count === 2) {
      const second = bits.read(8);
      if (second >= alphabet) fail('IMAGE_INVALID');
      lengths[second] = 1;
    }
    if (count === 1) return { single: first, maxcode: new Int32Array(0), valptr: new Int32Array(0), mincode: new Int32Array(0), symbols: new Uint16Array(0) };
    if (lengths.filter((l) => l > 0).length !== 2) fail('IMAGE_INVALID');
    return buildCode(lengths);
  }
  const clLengths = new Uint8Array(19);
  const numCodes = 4 + bits.read(4);
  for (let i = 0; i < numCodes; i++) clLengths[CODE_LENGTH_ORDER[i]!] = bits.read(3);
  const clCode = buildCode(clLengths);
  let maxSymbol = alphabet;
  if (bits.one()) {
    const lengthBits = 2 + 2 * bits.read(3);
    maxSymbol = 2 + bits.read(lengthBits);
    if (maxSymbol > alphabet) fail('IMAGE_INVALID');
  }
  let symbol = 0,
    previous = 8;
  while (symbol < alphabet) {
    if (maxSymbol-- === 0) break;
    const length = readSymbol(bits, clCode);
    if (length < 16) {
      lengths[symbol++] = length;
      if (length !== 0) previous = length;
    } else {
      const repeatFill = length === 16 ? previous : 0;
      const repeat = length === 16 ? 3 + bits.read(2) : length === 17 ? 3 + bits.read(3) : 11 + bits.read(7);
      if (symbol + repeat > alphabet) fail('IMAGE_INVALID');
      for (let i = 0; i < repeat; i++) lengths[symbol++] = repeatFill;
    }
  }
  return buildCode(lengths);
}

const DISTANCE_MAP: [number, number][] = [
  [0, 1], [1, 0], [1, 1], [-1, 1], [0, 2], [2, 0], [1, 2], [-1, 2], [2, 1], [-2, 1], [2, 2], [-2, 2], [0, 3], [3, 0],
  [1, 3], [-1, 3], [3, 1], [-3, 1], [2, 3], [-2, 3], [3, 2], [-3, 2], [0, 4], [4, 0], [1, 4], [-1, 4], [4, 1], [-4, 1],
  [3, 3], [-3, 3], [2, 4], [-2, 4], [4, 2], [-4, 2], [0, 5], [3, 4], [-3, 4], [4, 3], [-4, 3], [5, 0], [1, 5], [-1, 5],
  [5, 1], [-5, 1], [2, 5], [-2, 5], [5, 2], [-5, 2], [4, 4], [-4, 4], [3, 5], [-3, 5], [5, 3], [-5, 3], [0, 6], [6, 0],
  [1, 6], [-1, 6], [6, 1], [-6, 1], [2, 6], [-2, 6], [6, 2], [-6, 2], [4, 5], [-4, 5], [5, 4], [-5, 4], [3, 6], [-3, 6],
  [6, 3], [-6, 3], [0, 7], [7, 0], [1, 7], [-1, 7], [5, 5], [-5, 5], [7, 1], [-7, 1], [4, 6], [-4, 6], [6, 4], [-6, 4],
  [2, 7], [-2, 7], [7, 2], [-7, 2], [3, 7], [-3, 7], [7, 3], [-7, 3], [5, 6], [-5, 6], [6, 5], [-6, 5], [8, 0], [4, 7],
  [-4, 7], [7, 4], [-7, 4], [8, 1], [8, 2], [6, 6], [-6, 6], [8, 3], [5, 7], [-5, 7], [7, 5], [-7, 5], [8, 4], [6, 7],
  [-6, 7], [7, 6], [-7, 6], [8, 5], [7, 7], [-7, 7], [8, 6], [8, 7],
];

const prefixValue = (bits: Bits, symbol: number) => {
  if (symbol < 4) return symbol + 1;
  const extra = (symbol - 2) >> 1;
  const offset = (2 + (symbol & 1)) << extra;
  return offset + bits.read(extra) + 1;
};

/** Decodes an "entropy-coded image": width x height ARGB pixels (as 32-bit integers). */
function decodeImage(bits: Bits, width: number, height: number, main: boolean): Uint32Array {
  let cacheBits = 0;
  if (bits.one()) {
    cacheBits = bits.read(4);
    if (cacheBits < 1 || cacheBits > 11) fail('IMAGE_INVALID');
  }
  let metaBits = 0,
    metaImage: Uint32Array | null = null,
    groups = 1,
    metaWidth = 0;
  if (main && bits.one()) {
    metaBits = bits.read(3) + 2;
    metaWidth = Math.ceil(width / (1 << metaBits));
    metaImage = decodeImage(bits, metaWidth, Math.ceil(height / (1 << metaBits)), false);
    for (let i = 0; i < metaImage.length; i++) groups = Math.max(groups, ((metaImage[i]! >>> 8) & 0xffff) + 1);
    if (groups > 1 << 12) fail('IMAGE_INVALID');
  }
  const cacheSize = cacheBits > 0 ? 1 << cacheBits : 0;
  const codes: Code[][] = [];
  for (let g = 0; g < groups; g++)
    codes.push([readCode(bits, 256 + 24 + cacheSize), readCode(bits, 256), readCode(bits, 256), readCode(bits, 256), readCode(bits, 40)]);
  const total = width * height;
  const out = new Uint32Array(total);
  const cache = cacheSize ? new Uint32Array(cacheSize) : null;
  const insert = (argb: number) => {
    if (cache) cache[Math.imul(0x1e35a7bd, argb) >>> (32 - cacheBits)] = argb >>> 0;
  };
  let i = 0;
  while (i < total) {
    const x = i % width,
      y = (i - x) / width;
    const group = metaImage ? ((metaImage[(y >> metaBits) * metaWidth + (x >> metaBits)]! >>> 8) & 0xffff) : 0;
    const c = codes[group]!;
    const s = readSymbol(bits, c[0]!);
    if (s < 256) {
      const red = readSymbol(bits, c[1]!),
        blue = readSymbol(bits, c[2]!),
        alpha = readSymbol(bits, c[3]!);
      const argb = ((alpha << 24) | (red << 16) | (s << 8) | blue) >>> 0;
      out[i++] = argb;
      insert(argb);
    } else if (s < 256 + 24) {
      const length = prefixValue(bits, s - 256);
      const distanceSymbol = readSymbol(bits, c[4]!);
      const code = prefixValue(bits, distanceSymbol);
      let distance: number;
      if (code > 120) distance = code - 120;
      else {
        const [dx, dy] = DISTANCE_MAP[code - 1]!;
        distance = dx + dy * width;
        if (distance < 1) distance = 1;
      }
      if (distance > i || i + length > total) fail('IMAGE_INVALID');
      for (let k = 0; k < length; k++) {
        const argb = out[i - distance]!;
        out[i++] = argb;
        insert(argb);
      }
    } else {
      if (!cache) fail('IMAGE_INVALID');
      const index = s - 256 - 24;
      if (index >= cacheSize) fail('IMAGE_INVALID');
      const argb = cache![index]!;
      out[i++] = argb;
      insert(argb);
    }
  }
  return out;
}

const channel = (argb: number, shift: number) => (argb >>> shift) & 0xff;
const pack = (a: number, r: number, g: number, b: number) => (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;
const addPixels = (x: number, y: number) =>
  pack(channel(x, 24) + channel(y, 24), channel(x, 16) + channel(y, 16), channel(x, 8) + channel(y, 8), channel(x, 0) + channel(y, 0));
const average2 = (a: number, b: number) =>
  pack((channel(a, 24) + channel(b, 24)) >> 1, (channel(a, 16) + channel(b, 16)) >> 1, (channel(a, 8) + channel(b, 8)) >> 1, (channel(a, 0) + channel(b, 0)) >> 1);
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const select = (l: number, t: number, tl: number) => {
  let pl = 0,
    pt = 0;
  for (const s of [24, 16, 8, 0]) {
    const p = channel(l, s) + channel(t, s) - channel(tl, s);
    pl += Math.abs(p - channel(l, s));
    pt += Math.abs(p - channel(t, s));
  }
  return pl < pt ? l : t;
};
const clampAddSubtractFull = (a: number, b: number, c: number) =>
  pack(...([24, 16, 8, 0].map((s) => clamp8(channel(a, s) + channel(b, s) - channel(c, s))) as [number, number, number, number]));
const clampAddSubtractHalf = (a: number, b: number) =>
  pack(...([24, 16, 8, 0].map((s) => clamp8(channel(a, s) + Math.trunc((channel(a, s) - channel(b, s)) / 2))) as [number, number, number, number]));

interface Transform {
  type: number;
  bits: number;
  data: Uint32Array;
  /** color indexing: the width of the picture before packing */
  width: number;
}
const signed8 = (v: number) => (v << 24) >> 24;
const colorDelta = (t: number, c: number) => (signed8(t) * signed8(c)) >> 5;

/**
 * Decodes the VP8L pixel data that starts at `bits` (the caller has consumed the 5-byte header, or there is none for ALPH).
 * Returns ARGB integers.
 */
export function decodeVp8lStream(bits: Bits, width: number, height: number): Uint32Array {
  const transforms: Transform[] = [];
  const seen = new Set<number>();
  let codedWidth = width;
  while (bits.one()) {
    const type = bits.read(2);
    if (seen.has(type)) fail('IMAGE_INVALID');
    seen.add(type);
    const t: Transform = { type, bits: 0, data: new Uint32Array(0), width: codedWidth };
    if (type === 0 || type === 1) {
      t.bits = bits.read(3) + 2;
      t.data = decodeImage(bits, Math.ceil(codedWidth / (1 << t.bits)), Math.ceil(height / (1 << t.bits)), false);
    } else if (type === 3) {
      const size = bits.read(8) + 1;
      const table = decodeImage(bits, size, 1, false);
      for (let i = 1; i < size; i++) table[i] = addPixels(table[i]!, table[i - 1]!);
      const full = new Uint32Array(1 << (size <= 2 ? 1 : size <= 4 ? 2 : size <= 16 ? 4 : 8)).fill(0);
      full.set(table);
      t.data = full;
      t.bits = size <= 2 ? 3 : size <= 4 ? 2 : size <= 16 ? 1 : 0;
      codedWidth = Math.ceil(codedWidth / (1 << t.bits));
    }
    transforms.push(t);
  }
  let pixels = decodeImage(bits, codedWidth, height, true);
  for (let n = transforms.length - 1; n >= 0; n--) {
    const t = transforms[n]!;
    const w = t.type === 3 ? t.width : codedWidth;
    if (t.type === 2) {
      for (let i = 0; i < pixels.length; i++) {
        const p = pixels[i]!,
          g = channel(p, 8);
        pixels[i] = pack(channel(p, 24), channel(p, 16) + g, g, channel(p, 0) + g);
      }
    } else if (t.type === 1) {
      const tiles = Math.ceil(w / (1 << t.bits));
      for (let y = 0; y < height; y++)
        for (let x = 0; x < w; x++) {
          const m = t.data[(y >> t.bits) * tiles + (x >> t.bits)]!;
          const greenToRed = channel(m, 0),
            greenToBlue = channel(m, 8),
            redToBlue = channel(m, 16);
          const p = pixels[y * w + x]!,
            g = channel(p, 8);
          const red = (channel(p, 16) + colorDelta(greenToRed, g)) & 0xff;
          const blue = (channel(p, 0) + colorDelta(greenToBlue, g) + colorDelta(redToBlue, red)) & 0xff;
          pixels[y * w + x] = pack(channel(p, 24), red, g, blue);
        }
    } else if (t.type === 0) {
      const tiles = Math.ceil(w / (1 << t.bits));
      for (let y = 0; y < height; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          let predictor: number;
          if (y === 0 && x === 0) predictor = 0xff000000;
          else if (y === 0) predictor = pixels[i - 1]!;
          else if (x === 0) predictor = pixels[i - w]!;
          else {
            const mode = channel(t.data[(y >> t.bits) * tiles + (x >> t.bits)]!, 8) & 0xf;
            const L = pixels[i - 1]!,
              T = pixels[i - w]!,
              TL = pixels[i - w - 1]!,
              TR = pixels[i - w + 1]!;
            switch (mode) {
              case 0:
                predictor = 0xff000000;
                break;
              case 1:
                predictor = L;
                break;
              case 2:
                predictor = T;
                break;
              case 3:
                predictor = TR;
                break;
              case 4:
                predictor = TL;
                break;
              case 5:
                predictor = average2(average2(L, TR), T);
                break;
              case 6:
                predictor = average2(L, TL);
                break;
              case 7:
                predictor = average2(L, T);
                break;
              case 8:
                predictor = average2(TL, T);
                break;
              case 9:
                predictor = average2(T, TR);
                break;
              case 10:
                predictor = average2(average2(L, TL), average2(T, TR));
                break;
              case 11:
                predictor = select(L, T, TL);
                break;
              case 12:
                predictor = clampAddSubtractFull(L, T, TL);
                break;
              case 13:
                predictor = clampAddSubtractHalf(average2(L, T), TL);
                break;
              default:
                predictor = 0xff000000;
            }
          }
          pixels[i] = addPixels(pixels[i]!, predictor);
        }
    } else {
      const out = new Uint32Array(t.width * height);
      const bitsPerPixel = 8 >> t.bits,
        mask = (1 << bitsPerPixel) - 1;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < t.width; x++) {
          const packed = channel(pixels[y * codedWidth + (x >> t.bits)]!, 8);
          const index = t.bits === 0 ? packed : (packed >> (bitsPerPixel * (x & ((1 << t.bits) - 1)))) & mask;
          out[y * t.width + x] = index < t.data.length ? t.data[index]! : 0;
        }
      pixels = out;
      codedWidth = t.width;
    }
  }
  return pixels;
}

/** A VP8L chunk body (with its 5-byte header) to straight RGBA. */
export function decodeVp8l(body: Uint8Array, maxPixels: number) {
  if (body.length < 6 || body[0] !== 0x2f) fail('IMAGE_INVALID');
  const bits = new Bits(body, 1);
  const width = bits.read(14) + 1,
    height = bits.read(14) + 1;
  const hasAlpha = bits.read(1) === 1;
  if (bits.read(3) !== 0) fail('IMAGE_UNSUPPORTED');
  if (width * height > maxPixels) fail('IMAGE_TOO_LARGE');
  const argb = decodeVp8lStream(bits, width, height);
  const rgba = new Uint8Array(width * height * 4);
  let alpha = false;
  for (let i = 0; i < argb.length; i++) {
    const p = argb[i]!;
    rgba[i * 4] = channel(p, 16);
    rgba[i * 4 + 1] = channel(p, 8);
    rgba[i * 4 + 2] = channel(p, 0);
    const a = hasAlpha ? channel(p, 24) : 255;
    rgba[i * 4 + 3] = a;
    if (a !== 255) alpha = true;
  }
  return { width, height, rgba, alpha };
}

/** The headerless VP8L stream of an ALPH chunk: the alpha values are the green channel. */
export function decodeAlphaLossless(body: Uint8Array, start: number, width: number, height: number) {
  const argb = decodeVp8lStream(new Bits(body, start), width, height);
  const plane = new Uint8Array(width * height);
  for (let i = 0; i < plane.length; i++) plane[i] = channel(argb[i]!, 8);
  return plane;
}
