import { ImageError, type Raster } from './png.ts';

const fail = (code: string): never => {
  throw new ImageError(code);
};

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

interface Huffman {
  /** For each code length 1..16: the largest code of that length (-1 when none) and the index of its first symbol. */
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  values: Uint8Array;
}
function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1),
    valptr = new Int32Array(17),
    mincode = new Int32Array(17);
  let code = 0,
    k = 0;
  for (let length = 1; length <= 16; length++) {
    valptr[length] = k;
    mincode[length] = code;
    code += counts[length - 1]!;
    k += counts[length - 1]!;
    maxcode[length] = counts[length - 1]! > 0 ? code - 1 : -1;
    if (code > 1 << length) fail('IMAGE_INVALID');
    code <<= 1;
  }
  return { maxcode, valptr, mincode, values };
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  blocksPerLineForMcu: number;
  blocksPerColumnForMcu: number;
  coefficients: Int16Array;
  pred: number;
  dc: Huffman | null;
  ac: Huffman | null;
}

/**
 * Baseline and progressive Huffman JPEG, 8-bit, 1 or 3 components (grey / YCbCr, any sampling factors). Only the entropy-coded
 * pixel data is read: EXIF, XMP, ICC, comments and every other marker segment are skipped and never copied anywhere.
 * Not supported (refused with IMAGE_UNSUPPORTED): arithmetic coding, lossless, 12-bit, CMYK / YCCK.
 */
export function decodeJpeg(bytes: Uint8Array, maxPixels: number): Raster {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('IMAGE_INVALID');
  let at = 2;
  const quant: (Int32Array | undefined)[] = [];
  const dcTables: (Huffman | undefined)[] = [],
    acTables: (Huffman | undefined)[] = [];
  let width = 0,
    height = 0,
    progressive = false,
    components: Component[] = [],
    restartInterval = 0,
    adobe = -1,
    maxH = 1,
    maxV = 1,
    mcusPerLine = 0,
    mcusPerColumn = 0,
    scans = 0;
  const u16 = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;

  // ---- bit reader over the entropy-coded segment ---------------------------------------------------------------------
  let pos = 0,
    bitBuffer = 0,
    bitCount = 0,
    eobrun = 0;
  const reset = () => {
    bitBuffer = 0;
    bitCount = 0;
  };
  const readBit = (): number => {
    if (bitCount === 0) {
      if (pos >= bytes.length) return fail('IMAGE_INVALID');
      let b = bytes[pos++]!;
      if (b === 0xff) {
        const next = bytes[pos];
        if (next === 0) pos++;
        else {
          // a marker inside the data: feed zeros, do not consume it (the caller handles the marker)
          pos--;
          b = 0;
          if (next === undefined) fail('IMAGE_INVALID');
        }
      }
      bitBuffer = b;
      bitCount = 8;
    }
    bitCount--;
    return (bitBuffer >> bitCount) & 1;
  };
  const readBits = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };
  const receiveExtend = (n: number) => {
    if (n === 0) return 0;
    if (n > 15) fail('IMAGE_INVALID');
    const v = readBits(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  };
  const decodeHuffman = (table: Huffman): number => {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | readBit();
      if (table.maxcode[length]! >= 0 && code <= table.maxcode[length]! && code >= table.mincode[length]!)
        return table.values[table.valptr[length]! + code - table.mincode[length]!]!;
    }
    return fail('IMAGE_INVALID');
  };

  // ---- one scan ----------------------------------------------------------------------------------------------------
  const decodeScan = (scanComponents: Component[], ss: number, se: number, ah: number, al: number) => {
    const baseline = !progressive;
    let decodeBlock: (c: Component, offset: number) => void;
    if (baseline)
      decodeBlock = (c, offset) => {
        const t = decodeHuffman(c.dc!);
        c.pred += receiveExtend(t);
        c.coefficients[offset] = c.pred;
        for (let k = 1; k < 64; k++) {
          const rs = decodeHuffman(c.ac!),
            s = rs & 15,
            r = rs >> 4;
          if (s === 0) {
            if (r < 15) break;
            k += 15;
            continue;
          }
          k += r;
          if (k > 63) fail('IMAGE_INVALID');
          c.coefficients[offset + ZIGZAG[k]!] = receiveExtend(s);
        }
      };
    else if (ss === 0)
      decodeBlock =
        ah === 0
          ? (c, offset) => {
              const t = decodeHuffman(c.dc!);
              c.pred += receiveExtend(t);
              c.coefficients[offset] = c.pred * (1 << al);
            }
          : (c, offset) => {
              if (readBit()) c.coefficients[offset] = c.coefficients[offset]! | (1 << al);
            };
    else if (ah === 0)
      decodeBlock = (c, offset) => {
        if (eobrun > 0) {
          eobrun--;
          return;
        }
        for (let k = ss; k <= se; k++) {
          const rs = decodeHuffman(c.ac!),
            s = rs & 15,
            r = rs >> 4;
          if (s === 0) {
            if (r < 15) {
              eobrun = (1 << r) - 1;
              if (r) eobrun += readBits(r);
              break;
            }
            k += 15;
            continue;
          }
          k += r;
          if (k > 63) fail('IMAGE_INVALID');
          c.coefficients[offset + ZIGZAG[k]!] = receiveExtend(s) * (1 << al);
        }
      };
    else {
      const p1 = 1 << al,
        m1 = -1 << al;
      decodeBlock = (c, offset) => {
        const block = c.coefficients;
        let k = ss;
        if (eobrun === 0) {
          for (; k <= se; k++) {
            const rs = decodeHuffman(c.ac!);
            let s = rs & 15,
              r = rs >> 4;
            if (s !== 0) {
              if (s !== 1) fail('IMAGE_INVALID');
              s = readBit() ? p1 : m1;
            } else if (r !== 15) {
              eobrun = 1 << r;
              if (r) eobrun += readBits(r);
              break;
            }
            while (k <= se) {
              const index = offset + ZIGZAG[k]!;
              const coefficient = block[index]!;
              if (coefficient !== 0) {
                if (readBit() && (coefficient & p1) === 0) block[index] = coefficient + (coefficient >= 0 ? p1 : m1);
              } else if (--r < 0) break;
              k++;
            }
            if (s !== 0 && k <= se) block[offset + ZIGZAG[k]!] = s;
          }
        }
        if (eobrun > 0) {
          for (; k <= se; k++) {
            const index = offset + ZIGZAG[k]!;
            const coefficient = block[index]!;
            if (coefficient !== 0 && readBit() && (coefficient & p1) === 0)
              block[index] = coefficient + (coefficient >= 0 ? p1 : m1);
          }
          eobrun--;
        }
      };
    }
    const single = scanComponents.length === 1;
    const totalMcus = single
      ? scanComponents[0]!.blocksPerLine * scanComponents[0]!.blocksPerColumn
      : mcusPerLine * mcusPerColumn;
    const interval = restartInterval > 0 ? restartInterval : totalMcus;
    let mcu = 0;
    while (mcu < totalMcus) {
      for (const c of scanComponents) c.pred = 0;
      eobrun = 0;
      reset();
      for (let n = 0; n < interval && mcu < totalMcus; n++, mcu++) {
        if (single) {
          const c = scanComponents[0]!;
          const row = Math.floor(mcu / c.blocksPerLine),
            col = mcu % c.blocksPerLine;
          decodeBlock(c, 64 * (row * c.blocksPerLineForMcu + col));
        } else {
          const mcuRow = Math.floor(mcu / mcusPerLine),
            mcuCol = mcu % mcusPerLine;
          for (const c of scanComponents)
            for (let v = 0; v < c.v; v++)
              for (let h = 0; h < c.h; h++)
                decodeBlock(c, 64 * ((mcuRow * c.v + v) * c.blocksPerLineForMcu + mcuCol * c.h + h));
        }
      }
      // After an interval: find the next marker. A restart marker is consumed; anything else ends the scan.
      reset();
      while (pos < bytes.length && !(bytes[pos] === 0xff && bytes[pos + 1] !== 0 && bytes[pos + 1] !== 0xff)) pos++;
      if (pos + 1 < bytes.length && bytes[pos + 1]! >= 0xd0 && bytes[pos + 1]! <= 0xd7) pos += 2;
      else if (mcu < totalMcus) fail('IMAGE_INVALID');
    }
  };

  // ---- markers -----------------------------------------------------------------------------------------------------
  let ended = false;
  while (at + 4 <= bytes.length && !ended) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    const length = u16(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) fail('IMAGE_INVALID');
    const body = at + 4,
      end = at + 2 + length;
    switch (marker) {
      case 0xdb:
        for (let i = body; i < end; ) {
          const info = bytes[i++]!,
            table = new Int32Array(64);
          if (info >> 4 !== 0 && info >> 4 !== 1) fail('IMAGE_INVALID');
          for (let k = 0; k < 64; k++) {
            table[ZIGZAG[k]!] = info >> 4 ? u16(i) : bytes[i]!;
            i += info >> 4 ? 2 : 1;
          }
          if (i > end) fail('IMAGE_INVALID');
          quant[info & 15] = table;
        }
        break;
      case 0xc4:
        for (let i = body; i < end; ) {
          const info = bytes[i++]!,
            counts = bytes.subarray(i, i + 16);
          i += 16;
          const total = counts.reduce((a, b) => a + b, 0);
          if (total > 256 || i + total > end) fail('IMAGE_INVALID');
          const table = buildHuffman(counts, bytes.subarray(i, i + total));
          i += total;
          ((info >> 4 ? acTables : dcTables) as (Huffman | undefined)[])[info & 15] = table;
        }
        break;
      case 0xdd:
        restartInterval = u16(body);
        break;
      case 0xee:
        if (length >= 14 && String.fromCharCode(...bytes.subarray(body, body + 5)) === 'Adobe') adobe = bytes[body + 11]!;
        break;
      case 0xc0:
      case 0xc1:
      case 0xc2: {
        if (components.length > 0) fail('IMAGE_INVALID');
        progressive = marker === 0xc2;
        if (bytes[body] !== 8) fail('IMAGE_UNSUPPORTED');
        height = u16(body + 1);
        width = u16(body + 3);
        const count = bytes[body + 5]!;
        if (width < 1 || height < 1) fail('IMAGE_INVALID');
        if (width * height > maxPixels) fail('IMAGE_TOO_LARGE');
        if (count !== 1 && count !== 3) fail('IMAGE_UNSUPPORTED');
        if (body + 6 + count * 3 > end) fail('IMAGE_INVALID');
        for (let i = 0; i < count; i++) {
          const h = bytes[body + 7 + i * 3]! >> 4,
            v = bytes[body + 7 + i * 3]! & 15;
          if (h < 1 || h > 4 || v < 1 || v > 4) fail('IMAGE_INVALID');
          components.push({
            id: bytes[body + 6 + i * 3]!,
            h,
            v,
            tq: bytes[body + 8 + i * 3]!,
            blocksPerLine: 0,
            blocksPerColumn: 0,
            blocksPerLineForMcu: 0,
            blocksPerColumnForMcu: 0,
            coefficients: new Int16Array(0),
            pred: 0,
            dc: null,
            ac: null,
          });
        }
        maxH = Math.max(...components.map((c) => c.h));
        maxV = Math.max(...components.map((c) => c.v));
        mcusPerLine = Math.ceil(width / (8 * maxH));
        mcusPerColumn = Math.ceil(height / (8 * maxV));
        for (const c of components) {
          c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
          c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
          c.blocksPerLineForMcu = mcusPerLine * c.h;
          c.blocksPerColumnForMcu = mcusPerColumn * c.v;
          c.coefficients = new Int16Array(c.blocksPerLineForMcu * c.blocksPerColumnForMcu * 64);
        }
        break;
      }
      case 0xc3:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        return fail('IMAGE_UNSUPPORTED');
      case 0xda: {
        if (components.length === 0) fail('IMAGE_INVALID');
        const count = bytes[body]!;
        if (count < 1 || count > components.length || body + 1 + count * 2 + 3 > end) fail('IMAGE_INVALID');
        const chosen: Component[] = [];
        for (let i = 0; i < count; i++) {
          const c = components.find((x) => x.id === bytes[body + 1 + i * 2]);
          if (!c) return fail('IMAGE_INVALID');
          const tables = bytes[body + 2 + i * 2]!;
          c.dc = dcTables[tables >> 4] ?? null;
          c.ac = acTables[tables & 15] ?? null;
          chosen.push(c);
        }
        const ss = bytes[body + 1 + count * 2]!,
          se = bytes[body + 2 + count * 2]!,
          a = bytes[body + 3 + count * 2]!;
        const ah = a >> 4,
          al = a & 15;
        if (progressive && (ss > se || se > 63 || (ss === 0 && se !== 0) || (ss > 0 && count !== 1))) fail('IMAGE_INVALID');
        if (!progressive && chosen.some((c) => !c.dc || !c.ac)) fail('IMAGE_INVALID');
        if (progressive && ss === 0 && ah === 0 && chosen.some((c) => !c.dc)) fail('IMAGE_INVALID');
        if (progressive && ss > 0 && chosen.some((c) => !c.ac)) fail('IMAGE_INVALID');
        pos = end;
        decodeScan(chosen, progressive ? ss : 0, progressive ? se : 63, progressive ? ah : 0, progressive ? al : 0);
        scans++;
        at = pos;
        continue;
      }
      default:
        break;
    }
    at = end;
  }
  if (components.length === 0 || scans === 0) fail('IMAGE_INVALID');

  // ---- dequantize + inverse DCT into component planes ----------------------------------------------------------------
  const cosine = new Float64Array(64);
  for (let n = 0; n < 8; n++)
    for (let k = 0; k < 8; k++) cosine[n * 8 + k] = (k === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * n + 1) * k * Math.PI) / 16) * 0.5;
  const planes = components.map((c) => {
    const table = quant[c.tq] ?? fail('IMAGE_INVALID');
    const stride = c.blocksPerLineForMcu * 8,
      plane = new Uint8Array(stride * c.blocksPerColumnForMcu * 8);
    const tmp = new Float64Array(64),
      input = new Float64Array(64);
    for (let by = 0; by < c.blocksPerColumnForMcu; by++)
      for (let bx = 0; bx < c.blocksPerLineForMcu; bx++) {
        const offset = 64 * (by * c.blocksPerLineForMcu + bx);
        let acZero = true;
        for (let i = 0; i < 64; i++) {
          input[i] = c.coefficients[offset + i]! * table[i]!;
          if (i > 0 && input[i] !== 0) acZero = false;
        }
        const base = by * 8 * stride + bx * 8;
        if (acZero) {
          const value = Math.min(255, Math.max(0, Math.round(input[0]! / 8 + 128)));
          for (let y = 0; y < 8; y++) plane.fill(value, base + y * stride, base + y * stride + 8);
          continue;
        }
        // rows (index = v*8+u): tmp[v][x] = sum_u input[v][u] * cos(x,u)
        for (let v = 0; v < 8; v++)
          for (let x = 0; x < 8; x++) {
            let sum = 0;
            for (let u = 0; u < 8; u++) sum += input[v * 8 + u]! * cosine[x * 8 + u]!;
            tmp[v * 8 + x] = sum;
          }
        for (let x = 0; x < 8; x++)
          for (let y = 0; y < 8; y++) {
            let sum = 0;
            for (let v = 0; v < 8; v++) sum += tmp[v * 8 + x]! * cosine[y * 8 + v]!;
            plane[base + y * stride + x] = Math.min(255, Math.max(0, Math.round(sum + 128)));
          }
      }
    return { plane, stride, c };
  });
  for (const c of components) c.coefficients = new Int16Array(0);

  // ---- upsample (centred bilinear = libjpeg's "fancy" triangle for 2x) and colour convert --------------------------------
  const rgba = new Uint8Array(width * height * 4);
  const sampler = planes.map(({ plane, stride, c }) => {
    const cw = Math.ceil((width * c.h) / maxH),
      ch = Math.ceil((height * c.v) / maxV);
    const fx = c.h / maxH,
      fy = c.v / maxV;
    return (x: number, y: number) => {
      if (fx === 1 && fy === 1) return plane[y * stride + x]!;
      const sx = Math.min(cw - 1, Math.max(0, (x + 0.5) * fx - 0.5)),
        sy = Math.min(ch - 1, Math.max(0, (y + 0.5) * fy - 0.5));
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        x1 = Math.min(cw - 1, x0 + 1),
        y1 = Math.min(ch - 1, y0 + 1),
        dx = sx - x0,
        dy = sy - y0;
      const top = plane[y0 * stride + x0]! * (1 - dx) + plane[y0 * stride + x1]! * dx,
        bottom = plane[y1 * stride + x0]! * (1 - dx) + plane[y1 * stride + x1]! * dx;
      return top * (1 - dy) + bottom * dy;
    };
  });
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const ycc = components.length === 3 && adobe !== 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (components.length === 1) {
        const g = sampler[0]!(x, y);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
      } else {
        const a = sampler[0]!(x, y),
          b = sampler[1]!(x, y),
          c = sampler[2]!(x, y);
        if (ycc) {
          rgba[o] = clamp(a + 1.402 * (c - 128));
          rgba[o + 1] = clamp(a - 0.344136 * (b - 128) - 0.714136 * (c - 128));
          rgba[o + 2] = clamp(a + 1.772 * (b - 128));
        } else {
          rgba[o] = clamp(a);
          rgba[o + 1] = clamp(b);
          rgba[o + 2] = clamp(c);
        }
      }
      rgba[o + 3] = 255;
    }
  return { width, height, rgba, alpha: false };
}
