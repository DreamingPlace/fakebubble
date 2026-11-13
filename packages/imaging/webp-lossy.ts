import { ImageError } from './png.ts';
import { AC_QUANT, COEFF_DEFAULT_PROBS, COEFF_UPDATE_PROBS, DC_QUANT, KF_BMODE_PROBS } from './vp8-tables.ts';

const fail = (code: string): never => {
  throw new ImageError(code);
};

/** The boolean entropy decoder of RFC 6386, section 7. */
class Bool {
  private readonly data: Uint8Array;
  private pos: number;
  private readonly end: number;
  private value: number;
  private range = 255;
  private count = 0;
  constructor(data: Uint8Array, start: number, end: number) {
    this.data = data;
    this.end = end;
    // a partition may be shorter than two bytes: the missing bytes read as zeros, as past the end of any partition
    this.value = ((start < end ? data[start]! : 0) << 8) | (start + 1 < end ? data[start + 1]! : 0);
    this.pos = start + 2;
  }
  bool(prob: number): number {
    const split = 1 + (((this.range - 1) * prob) >> 8);
    const big = split << 8;
    let bit: number;
    if (this.value >= big) {
      bit = 1;
      this.range -= split;
      this.value -= big;
    } else {
      bit = 0;
      this.range = split;
    }
    while (this.range < 128) {
      this.value <<= 1;
      this.range <<= 1;
      if (++this.count === 8) {
        this.count = 0;
        if (this.pos < this.end) this.value |= this.data[this.pos]!;
        this.pos++;
      }
    }
    return bit;
  }
  literal(n: number) {
    let v = 0;
    while (n-- > 0) v = (v << 1) | this.bool(128);
    return v;
  }
  signed(n: number) {
    const v = this.literal(n);
    return this.literal(1) ? -v : v;
  }
  flagged(n: number) {
    return this.literal(1) ? this.signed(n) : 0;
  }
}

const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0];
const CAT3456 = [
  [173, 148, 140],
  [176, 155, 140, 135],
  [180, 157, 141, 134, 130],
  [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
];
// modes
const DC_PRED = 0,
  V_PRED = 1,
  H_PRED = 2,
  TM_PRED = 3,
  B_PRED = 4;
const B_DC = 0,
  B_TM = 1,
  B_VE = 2,
  B_HE = 3,
  B_LD = 4,
  B_RD = 5,
  B_VR = 6,
  B_VL = 7,
  B_HD = 8,
  B_HU = 9;
// trees (leaves are <= 0, as in the RFC)
const BMODE_TREE = [-B_DC, 2, -B_TM, 4, -B_VE, 6, 8, 12, -B_HE, 10, -B_RD, -B_VR, -B_LD, 14, -B_VL, 16, -B_HD, -B_HU];
const KF_YMODE_TREE = [-B_PRED, 2, 4, 6, -DC_PRED, -V_PRED, -H_PRED, -TM_PRED];
const UV_MODE_TREE = [-DC_PRED, 2, -V_PRED, 4, -H_PRED, -TM_PRED];
const KF_YMODE_PROB = [145, 156, 163, 128];
const KF_UV_PROB = [142, 114, 183];
const tree = (d: Bool, t: number[], probs: ArrayLike<number>, offset = 0) => {
  let i = 0;
  while ((i = t[i + d.bool(probs[offset + (i >> 1)]!)]!) > 0);
  return -i;
};
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export interface Yuv {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
  yStride: number;
  uvStride: number;
}

interface Segment {
  y1: [number, number];
  y2: [number, number];
  uv: [number, number];
  filter: number;
}

/** A key frame (the only kind a still WebP holds) to planar YUV 4:2:0. */
export function decodeVp8(data: Uint8Array, maxPixels: number): Yuv {
  if (data.length < 10) fail('IMAGE_INVALID');
  const tag = data[0]! | (data[1]! << 8) | (data[2]! << 16);
  if (tag & 1) fail('IMAGE_INVALID'); // not a key frame
  if (((tag >> 1) & 7) > 3) fail('IMAGE_UNSUPPORTED');
  const firstSize = tag >> 5;
  if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) fail('IMAGE_INVALID');
  const width = (data[6]! | (data[7]! << 8)) & 0x3fff,
    height = (data[8]! | (data[9]! << 8)) & 0x3fff;
  if (width < 1 || height < 1) fail('IMAGE_INVALID');
  if (width * height > maxPixels) fail('IMAGE_TOO_LARGE');
  const first = 10;
  if (first + firstSize > data.length) fail('IMAGE_INVALID');
  const d = new Bool(data, first, first + firstSize);
  d.literal(1); // color space
  d.literal(1); // clamping type (we always clamp)
  // ---- segmentation
  const segmentation = d.literal(1) === 1;
  let updateMap = false,
    absolute = false;
  const quantizer = [0, 0, 0, 0],
    segLf = [0, 0, 0, 0],
    segProbs = [255, 255, 255];
  if (segmentation) {
    updateMap = d.literal(1) === 1;
    if (d.literal(1)) {
      absolute = d.literal(1) === 1;
      for (let i = 0; i < 4; i++) quantizer[i] = d.flagged(7);
      for (let i = 0; i < 4; i++) segLf[i] = d.flagged(6);
    }
    if (updateMap) for (let i = 0; i < 3; i++) segProbs[i] = d.literal(1) ? d.literal(8) : 255;
  }
  const simple = d.literal(1) === 1;
  const level = d.literal(6),
    sharpness = d.literal(3);
  const lfAdjust = d.literal(1) === 1;
  const refDelta = [0, 0, 0, 0],
    modeDelta = [0, 0, 0, 0];
  if (lfAdjust && d.literal(1)) {
    for (let i = 0; i < 4; i++) if (d.literal(1)) refDelta[i] = d.signed(6);
    for (let i = 0; i < 4; i++) if (d.literal(1)) modeDelta[i] = d.signed(6);
  }
  const partitions = 1 << d.literal(2);
  const baseQ = d.literal(7);
  const dqY1Dc = d.flagged(4),
    dqY2Dc = d.flagged(4),
    dqY2Ac = d.flagged(4),
    dqUvDc = d.flagged(4),
    dqUvAc = d.flagged(4);
  d.literal(1); // refresh_entropy_probs (a single frame: irrelevant)
  const probs = Uint8Array.from(COEFF_DEFAULT_PROBS);
  for (let i = 0; i < probs.length; i++) if (d.bool(COEFF_UPDATE_PROBS[i]!)) probs[i] = d.literal(8);
  const useSkip = d.literal(1) === 1;
  const skipProb = useSkip ? d.literal(8) : 0;

  // ---- token partitions
  const sizesAt = first + firstSize;
  if (sizesAt + 3 * (partitions - 1) > data.length) fail('IMAGE_INVALID');
  const tokenReaders: Bool[] = [];
  let at = sizesAt + 3 * (partitions - 1);
  for (let p = 0; p < partitions; p++) {
    const size = p < partitions - 1 ? data[sizesAt + 3 * p]! | (data[sizesAt + 3 * p + 1]! << 8) | (data[sizesAt + 3 * p + 2]! << 16) : data.length - at;
    if (at + size > data.length || size < 0) fail('IMAGE_INVALID');
    tokenReaders.push(new Bool(data, at, at + size));
    at += size;
  }

  // ---- dequantization per segment
  const clip = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);
  const segments: Segment[] = [];
  for (let s = 0; s < 4; s++) {
    let q = baseQ;
    if (segmentation) q = absolute ? quantizer[s]! : baseQ + quantizer[s]!;
    let filter = level;
    if (segmentation) filter = absolute ? segLf[s]! : level + segLf[s]!;
    segments.push({
      y1: [DC_QUANT[clip(q + dqY1Dc, 127)]!, AC_QUANT[clip(q, 127)]!],
      y2: [DC_QUANT[clip(q + dqY2Dc, 127)]! * 2, Math.max(8, (AC_QUANT[clip(q + dqY2Ac, 127)]! * 101581) >> 16)],
      uv: [DC_QUANT[clip(q + dqUvDc, 117)]!, AC_QUANT[clip(q + dqUvAc, 127)]!],
      filter,
    });
  }

  const mbw = (width + 15) >> 4,
    mbh = (height + 15) >> 4;
  const yStride = mbw * 16,
    uvStride = mbw * 8;
  const Y = new Uint8Array(yStride * mbh * 16),
    U = new Uint8Array(uvStride * mbh * 8),
    V = new Uint8Array(uvStride * mbh * 8);
  // contexts: per MB column [y0..y3, u0, u1, v0, v1, y2]
  const above = new Uint8Array(mbw * 9),
    left = new Uint8Array(9);
  const aboveModes = new Uint8Array(mbw * 4); // sub-block modes of the row above
  const leftModes = new Uint8Array(4);
  const info = new Uint8Array(mbw * mbh * 3); // [filter level, inner (1/0), segment]

  const coeffs = new Int16Array(25 * 16);
  /** libwebp's GetCoeffs: returns the position after the last token, writes dequantized values (natural order). */
  const getCoeffs = (br: Bool, type: number, ctx: number, dq: [number, number], first: number, out: Int16Array, base: number) => {
    let n = first;
    let p = (type * 8 + BANDS[n]!) * 33 + ctx * 11;
    for (; n < 16; ++n) {
      if (!br.bool(probs[p]!)) return n;
      while (!br.bool(probs[p + 1]!)) {
        p = (type * 8 + BANDS[++n]!) * 33;
        if (n === 16) return 16;
      }
      const next = (type * 8 + BANDS[n + 1]!) * 33;
      let v: number;
      if (!br.bool(probs[p + 2]!)) {
        v = 1;
        p = next + 11;
      } else {
        if (!br.bool(probs[p + 3]!)) {
          if (!br.bool(probs[p + 4]!)) v = 2;
          else v = 3 + br.bool(probs[p + 5]!);
        } else if (!br.bool(probs[p + 6]!)) {
          if (!br.bool(probs[p + 7]!)) v = 5 + br.bool(159);
          else {
            v = 7 + 2 * br.bool(165);
            v += br.bool(145);
          }
        } else {
          const bit1 = br.bool(probs[p + 8]!);
          const bit0 = br.bool(probs[p + 9 + bit1]!);
          const cat = 2 * bit1 + bit0;
          v = 0;
          for (const t of CAT3456[cat]!) v += v + br.bool(t);
          v += 3 + (8 << cat);
        }
        p = next + 22;
      }
      out[base + ZIGZAG[n]!] = (br.bool(128) ? -v : v) * (n > 0 ? dq[1] : dq[0]);
    }
    return 16;
  };

  const idct = (input: Int16Array, base: number, plane: Uint8Array, offset: number, stride: number) => {
    const tmp = new Int32Array(16);
    for (let i = 0; i < 4; i++) {
      const i0 = input[base + i]!,
        i4 = input[base + 4 + i]!,
        i8 = input[base + 8 + i]!,
        i12 = input[base + 12 + i]!;
      const a1 = i0 + i8,
        b1 = i0 - i8;
      let t1 = (i4 * 35468) >> 16,
        t2 = i12 + ((i12 * 20091) >> 16);
      const c1 = t1 - t2;
      t1 = i4 + ((i4 * 20091) >> 16);
      t2 = (i12 * 35468) >> 16;
      const d1 = t1 + t2;
      tmp[i] = a1 + d1;
      tmp[12 + i] = a1 - d1;
      tmp[4 + i] = b1 + c1;
      tmp[8 + i] = b1 - c1;
    }
    for (let i = 0; i < 4; i++) {
      const r = i * 4;
      const a1 = tmp[r]! + tmp[r + 2]!,
        b1 = tmp[r]! - tmp[r + 2]!;
      let t1 = (tmp[r + 1]! * 35468) >> 16,
        t2 = tmp[r + 3]! + ((tmp[r + 3]! * 20091) >> 16);
      const c1 = t1 - t2;
      t1 = tmp[r + 1]! + ((tmp[r + 1]! * 20091) >> 16);
      t2 = (tmp[r + 3]! * 35468) >> 16;
      const d1 = t1 + t2;
      const o = offset + i * stride;
      plane[o] = clamp(plane[o]! + ((a1 + d1 + 4) >> 3));
      plane[o + 3] = clamp(plane[o + 3]! + ((a1 - d1 + 4) >> 3));
      plane[o + 1] = clamp(plane[o + 1]! + ((b1 + c1 + 4) >> 3));
      plane[o + 2] = clamp(plane[o + 2]! + ((b1 - c1 + 4) >> 3));
    }
  };
  const wht = (input: Int16Array, base: number, out: Int16Array) => {
    const tmp = new Int32Array(16);
    for (let i = 0; i < 4; i++) {
      const a1 = input[base + i]! + input[base + 12 + i]!,
        b1 = input[base + 4 + i]! + input[base + 8 + i]!,
        c1 = input[base + 4 + i]! - input[base + 8 + i]!,
        d1 = input[base + i]! - input[base + 12 + i]!;
      tmp[i] = a1 + b1;
      tmp[4 + i] = c1 + d1;
      tmp[8 + i] = a1 - b1;
      tmp[12 + i] = d1 - c1;
    }
    for (let i = 0; i < 4; i++) {
      const a1 = tmp[i * 4]! + tmp[i * 4 + 3]!,
        b1 = tmp[i * 4 + 1]! + tmp[i * 4 + 2]!,
        c1 = tmp[i * 4 + 1]! - tmp[i * 4 + 2]!,
        d1 = tmp[i * 4]! - tmp[i * 4 + 3]!;
      out[i * 4] = (a1 + b1 + 3) >> 3;
      out[i * 4 + 1] = (c1 + d1 + 3) >> 3;
      out[i * 4 + 2] = (a1 - b1 + 3) >> 3;
      out[i * 4 + 3] = (d1 - c1 + 3) >> 3;
    }
  };

  // ---- prediction helpers (work in the frame buffer; edges are 127 above, 129 left)
  const predictBlock = (plane: Uint8Array, stride: number, x0: number, y0: number, size: number, mode: number, mbx: number, mby: number) => {
    const hasTop = mby > 0,
      hasLeft = mbx > 0;
    const A = (i: number) => (hasTop ? plane[(y0 - 1) * stride + x0 + i]! : 127);
    const L = (j: number) => (hasLeft ? plane[(y0 + j) * stride + x0 - 1]! : 129);
    const P = hasTop ? (hasLeft ? plane[(y0 - 1) * stride + x0 - 1]! : 129) : 127;
    if (mode === DC_PRED) {
      let sum = 0,
        count = 0;
      if (hasTop) for (let i = 0; i < size; i++) sum += A(i), count++;
      if (hasLeft) for (let j = 0; j < size; j++) sum += L(j), count++;
      const shift = size === 16 ? 4 : 3;
      // both edges: 2*size pixels; one edge: size pixels; none: 128 (RFC 6386 12.2)
      const value = count === 0 ? 128 : count === size ? (sum + (size >> 1)) >> shift : (sum + size) >> (shift + 1);
      for (let j = 0; j < size; j++) plane.fill(value, (y0 + j) * stride + x0, (y0 + j) * stride + x0 + size);
    } else if (mode === V_PRED) {
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) plane[(y0 + j) * stride + x0 + i] = A(i);
    } else if (mode === H_PRED) {
      for (let j = 0; j < size; j++) plane.fill(L(j), (y0 + j) * stride + x0, (y0 + j) * stride + x0 + size);
    } else {
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) plane[(y0 + j) * stride + x0 + i] = clamp(L(j) + A(i) - P);
    }
  };
  const predictSub = (x0: number, y0: number, mode: number, mbx: number, mby: number, bx: number, by: number) => {
    const hasTopMb = mby > 0 || by > 0,
      hasLeftMb = mbx > 0 || bx > 0;
    const px = (x: number, y: number) => Y[y * yStride + x]!;
    // above row incl. above-right
    const Aarr = new Array<number>(8);
    for (let i = 0; i < 4; i++) Aarr[i] = hasTopMb ? px(x0 + i, y0 - 1) : 127;
    for (let i = 4; i < 8; i++) {
      if (!hasTopMb) Aarr[i] = 127;
      else if (bx === 3) {
        // the right-edge sub-blocks use the row above the macroblock, to the right of it
        if (mby === 0) Aarr[i] = 127;
        else if (mbx === mbw - 1) Aarr[i] = px(mbx * 16 + 15, mby * 16 - 1);
        else Aarr[i] = px(mbx * 16 + 16 + (i - 4), mby * 16 - 1);
      } else Aarr[i] = px(x0 + i, y0 - 1);
    }
    const Larr = [0, 1, 2, 3].map((j) => (hasLeftMb ? px(x0 - 1, y0 + j) : 129));
    const Pv = hasTopMb ? (hasLeftMb ? px(x0 - 1, y0 - 1) : 129) : 127;
    // E: L3 L2 L1 L0 P A0 A1 A2 A3
    const E = [Larr[3]!, Larr[2]!, Larr[1]!, Larr[0]!, Pv, Aarr[0]!, Aarr[1]!, Aarr[2]!, Aarr[3]!];
    const Ap = (i: number) => (i < 0 ? Pv : Aarr[i]!);
    const Lp = (i: number) => Larr[i]!;
    const avg3 = (x: number, y: number, z: number) => (x + y + y + z + 2) >> 2;
    const avg2 = (x: number, y: number) => (x + y + 1) >> 1;
    const a3A = (i: number) => avg3(Ap(i - 1), Ap(i), Ap(i + 1));
    const a3E = (i: number) => avg3(E[i - 1]!, E[i]!, E[i + 1]!);
    const a2E = (i: number) => avg2(E[i]!, E[i + 1]!);
    const a2A = (i: number) => avg2(Ap(i), Ap(i + 1));
    const a2L = (i: number) => avg2(Lp(i), Lp(i + 1));
    const B: number[][] = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    switch (mode) {
      case B_DC: {
        let v = 4;
        for (let i = 0; i < 4; i++) v += Aarr[i]! + Larr[i]!;
        v >>= 3;
        for (const row of B) row.fill(v);
        break;
      }
      case B_TM:
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) B[r]![c] = clamp(Larr[r]! + Aarr[c]! - Pv);
        break;
      case B_VE:
        for (let c = 0; c < 4; c++) {
          const v = a3A(c);
          for (let r = 0; r < 4; r++) B[r]![c] = v;
        }
        break;
      case B_HE: {
        const rows = [avg3(Pv, Larr[0]!, Larr[1]!), avg3(Larr[0]!, Larr[1]!, Larr[2]!), avg3(Larr[1]!, Larr[2]!, Larr[3]!), avg3(Larr[2]!, Larr[3]!, Larr[3]!)];
        for (let r = 0; r < 4; r++) B[r]!.fill(rows[r]!);
        break;
      }
      case B_LD:
        B[0]![0] = a3A(1);
        B[0]![1] = B[1]![0] = a3A(2);
        B[0]![2] = B[1]![1] = B[2]![0] = a3A(3);
        B[0]![3] = B[1]![2] = B[2]![1] = B[3]![0] = a3A(4);
        B[1]![3] = B[2]![2] = B[3]![1] = a3A(5);
        B[2]![3] = B[3]![2] = a3A(6);
        B[3]![3] = avg3(Aarr[6]!, Aarr[7]!, Aarr[7]!);
        break;
      case B_RD:
        B[3]![0] = a3E(1);
        B[3]![1] = B[2]![0] = a3E(2);
        B[3]![2] = B[2]![1] = B[1]![0] = a3E(3);
        B[3]![3] = B[2]![2] = B[1]![1] = B[0]![0] = a3E(4);
        B[2]![3] = B[1]![2] = B[0]![1] = a3E(5);
        B[1]![3] = B[0]![2] = a3E(6);
        B[0]![3] = a3E(7);
        break;
      case B_VR:
        B[3]![0] = a3E(2);
        B[2]![0] = a3E(3);
        B[3]![1] = B[1]![0] = a3E(4);
        B[2]![1] = B[0]![0] = a2E(4);
        B[3]![2] = B[1]![1] = a3E(5);
        B[2]![2] = B[0]![1] = a2E(5);
        B[3]![3] = B[1]![2] = a3E(6);
        B[2]![3] = B[0]![2] = a2E(6);
        B[1]![3] = a3E(7);
        B[0]![3] = a2E(7);
        break;
      case B_VL:
        B[0]![0] = a2A(0);
        B[1]![0] = a3A(1);
        B[2]![0] = B[0]![1] = a2A(1);
        B[1]![1] = B[3]![0] = a3A(2);
        B[2]![1] = B[0]![2] = a2A(2);
        B[3]![1] = B[1]![2] = a3A(3);
        B[2]![2] = B[0]![3] = a2A(3);
        B[3]![2] = B[1]![3] = a3A(4);
        B[2]![3] = a3A(5);
        B[3]![3] = a3A(6);
        break;
      case B_HD:
        B[3]![0] = a2E(0);
        B[3]![1] = a3E(1);
        B[2]![0] = B[3]![2] = a2E(1);
        B[2]![1] = B[3]![3] = a3E(2);
        B[2]![2] = B[1]![0] = a2E(2);
        B[2]![3] = B[1]![1] = a3E(3);
        B[1]![2] = B[0]![0] = a2E(3);
        B[1]![3] = B[0]![1] = a3E(4);
        B[0]![2] = a3E(5);
        B[0]![3] = a3E(6);
        break;
      default: // B_HU
        B[0]![0] = a2L(0);
        B[0]![1] = avg3(Larr[0]!, Larr[1]!, Larr[2]!);
        B[0]![2] = B[1]![0] = a2L(1);
        B[0]![3] = B[1]![1] = avg3(Larr[1]!, Larr[2]!, Larr[3]!);
        B[1]![2] = B[2]![0] = a2L(2);
        B[1]![3] = B[2]![1] = avg3(Larr[2]!, Larr[3]!, Larr[3]!);
        B[2]![2] = B[2]![3] = B[3]![0] = B[3]![1] = B[3]![2] = B[3]![3] = Larr[3]!;
    }
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) Y[(y0 + r) * yStride + x0 + c] = B[r]![c]!;
  };

  // ---- the macroblocks
  const bmodes = new Uint8Array(16);
  for (let mby = 0; mby < mbh; mby++) {
    left.fill(0);
    leftModes.fill(B_DC);
    const br = tokenReaders[mby & (partitions - 1)]!;
    for (let mbx = 0; mbx < mbw; mbx++) {
      // header (first partition)
      const segment = updateMap ? (d.bool(segProbs[0]!) ? 2 + d.bool(segProbs[2]!) : d.bool(segProbs[1]!)) : 0;
      const skip = useSkip ? d.bool(skipProb) : 0;
      const ymode = tree(d, KF_YMODE_TREE, KF_YMODE_PROB);
      if (ymode === B_PRED) {
        for (let b = 0; b < 16; b++) {
          const bx = b & 3,
            by = b >> 2;
          const a = by === 0 ? aboveModes[mbx * 4 + bx]! : bmodes[b - 4]!;
          const l = bx === 0 ? leftModes[by]! : bmodes[b - 1]!;
          bmodes[b] = tree(d, BMODE_TREE, KF_BMODE_PROBS, (a * 10 + l) * 9);
        }
      } else {
        const implied = ymode === DC_PRED ? B_DC : ymode === V_PRED ? B_VE : ymode === H_PRED ? B_HE : B_TM;
        bmodes.fill(implied);
      }
      for (let i = 0; i < 4; i++) {
        aboveModes[mbx * 4 + i] = bmodes[12 + i]!;
        leftModes[i] = bmodes[i * 4 + 3]!;
      }
      const uvmode = tree(d, UV_MODE_TREE, KF_UV_PROB);

      // residuals (token partition)
      const isI4 = ymode === B_PRED;
      const q = segments[segment]!;
      coeffs.fill(0);
      const aboveCtx = mbx * 9;
      let nzAny = false;
      if (!skip) {
        let first = 0;
        const dc = new Int16Array(16);
        if (!isI4) {
          const ctx = above[aboveCtx + 8]! + left[8]!;
          const nz = getCoeffs(br, 1, ctx, q.y2, 0, coeffs, 24 * 16);
          above[aboveCtx + 8] = left[8] = nz > 0 ? 1 : 0;
          wht(coeffs, 24 * 16, dc);
          first = 1;
        }
        const type = isI4 ? 3 : 0;
        for (let b = 0; b < 16; b++) {
          const bx = b & 3,
            by = b >> 2;
          const ctx = above[aboveCtx + bx]! + left[by]!;
          const nz = getCoeffs(br, type, ctx, q.y1, first, coeffs, b * 16);
          above[aboveCtx + bx] = left[by] = nz > first ? 1 : 0;
          if (!isI4) coeffs[b * 16] = dc[b]!;
          if (nz > 1 || coeffs[b * 16] !== 0) nzAny = true;
        }
        for (let plane = 0; plane < 2; plane++)
          for (let b = 0; b < 4; b++) {
            const bx = b & 1,
              by = b >> 1;
            const ai = aboveCtx + 4 + plane * 2 + bx,
              li = 4 + plane * 2 + by;
            const ctx = above[ai]! + left[li]!;
            const idx = (16 + plane * 4 + b) * 16;
            const nz = getCoeffs(br, 2, ctx, q.uv, 0, coeffs, idx);
            above[ai] = left[li] = nz > 0 ? 1 : 0;
            if (nz > 1 || coeffs[idx] !== 0) nzAny = true;
          }
      } else {
        for (let i = 0; i < 8; i++) {
          above[aboveCtx + i] = 0;
          left[i] = 0;
        }
        if (!isI4) above[aboveCtx + 8] = left[8] = 0;
      }

      // reconstruction
      const x0 = mbx * 16,
        y0 = mby * 16;
      if (isI4) {
        for (let b = 0; b < 16; b++) {
          const bx = b & 3,
            by = b >> 2;
          predictSub(x0 + bx * 4, y0 + by * 4, bmodes[b]!, mbx, mby, bx, by);
          idct(coeffs, b * 16, Y, (y0 + by * 4) * yStride + x0 + bx * 4, yStride);
        }
      } else {
        predictBlock(Y, yStride, x0, y0, 16, ymode, mbx, mby);
        for (let b = 0; b < 16; b++) idct(coeffs, b * 16, Y, (y0 + (b >> 2) * 4) * yStride + x0 + (b & 3) * 4, yStride);
      }
      predictBlock(U, uvStride, mbx * 8, mby * 8, 8, uvmode, mbx, mby);
      predictBlock(V, uvStride, mbx * 8, mby * 8, 8, uvmode, mbx, mby);
      for (let b = 0; b < 4; b++) {
        const o = (mby * 8 + (b >> 1) * 4) * uvStride + mbx * 8 + (b & 1) * 4;
        idct(coeffs, (16 + b) * 16, U, o, uvStride);
        idct(coeffs, (20 + b) * 16, V, o, uvStride);
      }

      // loop-filter strength of this macroblock
      let fl = q.filter;
      if (lfAdjust) {
        fl += refDelta[0]!;
        if (isI4) fl += modeDelta[0]!;
      }
      fl = fl < 0 ? 0 : fl > 63 ? 63 : fl;
      const o = (mby * mbw + mbx) * 3;
      info[o] = fl;
      info[o + 1] = isI4 || nzAny ? 1 : 0;
    }
  }

  // ---- loop filter (after the whole frame is reconstructed)
  if (level > 0) {
    const sat = (v: number) => (v < -128 ? -128 : v > 127 ? 127 : v);
    const u2s = (v: number) => v - 128;
    const s2u = (v: number) => sat(v) + 128;
    const commonAdjust = (outer: boolean, px: Uint8Array, i: number, step: number) => {
      const p1 = u2s(px[i - 2 * step]!),
        p0 = u2s(px[i - step]!),
        q0 = u2s(px[i]!),
        q1 = u2s(px[i + step]!);
      let a = sat((outer ? sat(p1 - q1) : 0) + 3 * (q0 - p0));
      const b = sat(a + 3) >> 3;
      a = sat(a + 4) >> 3;
      px[i] = s2u(q0 - a);
      px[i - step] = s2u(p0 + b);
      return a;
    };
    const filterYes = (I: number, E: number, px: Uint8Array, i: number, step: number) => {
      const p3 = px[i - 4 * step]!,
        p2 = px[i - 3 * step]!,
        p1 = px[i - 2 * step]!,
        p0 = px[i - step]!,
        q0 = px[i]!,
        q1 = px[i + step]!,
        q2 = px[i + 2 * step]!,
        q3 = px[i + 3 * step]!;
      return (
        Math.abs(p0 - q0) * 2 + (Math.abs(p1 - q1) >> 1) <= E &&
        Math.abs(p3 - p2) <= I &&
        Math.abs(p2 - p1) <= I &&
        Math.abs(p1 - p0) <= I &&
        Math.abs(q3 - q2) <= I &&
        Math.abs(q2 - q1) <= I &&
        Math.abs(q1 - q0) <= I
      );
    };
    const hev = (t: number, px: Uint8Array, i: number, step: number) =>
      Math.abs(px[i - 2 * step]! - px[i - step]!) > t || Math.abs(px[i + step]! - px[i]!) > t;
    const simpleSegment = (E: number, px: Uint8Array, i: number, step: number) => {
      if (Math.abs(px[i - step]! - px[i]!) * 2 + (Math.abs(px[i - 2 * step]! - px[i + step]!) >> 1) <= E) commonAdjust(true, px, i, step);
    };
    const subblockFilter = (t: number, I: number, E: number, px: Uint8Array, i: number, step: number) => {
      if (!filterYes(I, E, px, i, step)) return;
      const p1 = u2s(px[i - 2 * step]!),
        q1 = u2s(px[i + step]!);
      const hv = hev(t, px, i, step);
      const a = (commonAdjust(hv, px, i, step) + 1) >> 1;
      if (!hv) {
        px[i + step] = s2u(q1 - a);
        px[i - 2 * step] = s2u(p1 + a);
      }
    };
    const mbFilter = (t: number, I: number, E: number, px: Uint8Array, i: number, step: number) => {
      if (!filterYes(I, E, px, i, step)) return;
      if (!hev(t, px, i, step)) {
        const p2 = u2s(px[i - 3 * step]!),
          p1 = u2s(px[i - 2 * step]!),
          p0 = u2s(px[i - step]!),
          q0 = u2s(px[i]!),
          q1 = u2s(px[i + step]!),
          q2 = u2s(px[i + 2 * step]!);
        const w = sat(sat(p1 - q1) + 3 * (q0 - p0));
        let a = sat((27 * w + 63) >> 7);
        px[i] = s2u(q0 - a);
        px[i - step] = s2u(p0 + a);
        a = sat((18 * w + 63) >> 7);
        px[i + step] = s2u(q1 - a);
        px[i - 2 * step] = s2u(p1 + a);
        a = sat((9 * w + 63) >> 7);
        px[i + 2 * step] = s2u(q2 - a);
        px[i - 3 * step] = s2u(p2 + a);
      } else commonAdjust(true, px, i, step);
    };
    for (let mby = 0; mby < mbh; mby++)
      for (let mbx = 0; mbx < mbw; mbx++) {
        const o = (mby * mbw + mbx) * 3;
        const fl = info[o]!;
        if (fl === 0) continue;
        const inner = info[o + 1] === 1;
        let ilevel = fl;
        if (sharpness > 0) {
          ilevel >>= sharpness > 4 ? 2 : 1;
          if (ilevel > 9 - sharpness) ilevel = 9 - sharpness;
        }
        if (ilevel < 1) ilevel = 1;
        const limit = 2 * fl + ilevel;
        const hevT = fl >= 40 ? 2 : fl >= 15 ? 1 : 0;
        const yo = mby * 16 * yStride + mbx * 16,
          uo = mby * 8 * uvStride + mbx * 8;
        if (simple) {
          if (mbx > 0) for (let j = 0; j < 16; j++) simpleSegment(limit + 4, Y, yo + j * yStride, 1);
          if (inner) for (const x of [4, 8, 12]) for (let j = 0; j < 16; j++) simpleSegment(limit, Y, yo + j * yStride + x, 1);
          if (mby > 0) for (let i = 0; i < 16; i++) simpleSegment(limit + 4, Y, yo + i, yStride);
          if (inner) for (const y of [4, 8, 12]) for (let i = 0; i < 16; i++) simpleSegment(limit, Y, yo + y * yStride + i, yStride);
        } else {
          if (mbx > 0) {
            for (let j = 0; j < 16; j++) mbFilter(hevT, ilevel, limit + 4, Y, yo + j * yStride, 1);
            for (let j = 0; j < 8; j++) {
              mbFilter(hevT, ilevel, limit + 4, U, uo + j * uvStride, 1);
              mbFilter(hevT, ilevel, limit + 4, V, uo + j * uvStride, 1);
            }
          }
          if (inner) {
            for (const x of [4, 8, 12]) for (let j = 0; j < 16; j++) subblockFilter(hevT, ilevel, limit, Y, yo + j * yStride + x, 1);
            for (let j = 0; j < 8; j++) {
              subblockFilter(hevT, ilevel, limit, U, uo + j * uvStride + 4, 1);
              subblockFilter(hevT, ilevel, limit, V, uo + j * uvStride + 4, 1);
            }
          }
          if (mby > 0) {
            for (let i = 0; i < 16; i++) mbFilter(hevT, ilevel, limit + 4, Y, yo + i, yStride);
            for (let i = 0; i < 8; i++) {
              mbFilter(hevT, ilevel, limit + 4, U, uo + i, uvStride);
              mbFilter(hevT, ilevel, limit + 4, V, uo + i, uvStride);
            }
          }
          if (inner) {
            for (const y of [4, 8, 12]) for (let i = 0; i < 16; i++) subblockFilter(hevT, ilevel, limit, Y, yo + y * yStride + i, yStride);
            for (let i = 0; i < 8; i++) {
              subblockFilter(hevT, ilevel, limit, U, uo + 4 * uvStride + i, uvStride);
              subblockFilter(hevT, ilevel, limit, V, uo + 4 * uvStride + i, uvStride);
            }
          }
        }
      }
  }
  return { width, height, y: Y, u: U, v: V, yStride, uvStride };
}

const mult = (v: number, c: number) => (v * c) >> 8;
const clip8 = (v: number) => ((v & ~((256 << 6) - 1)) === 0 ? v >> 6 : v < 0 ? 0 : 255);
const yuvR = (y: number, v: number) => clip8(mult(y, 19077) + mult(v, 26149) - 14234);
const yuvG = (y: number, u: number, v: number) => clip8(mult(y, 19077) - mult(u, 6419) - mult(v, 13320) + 8708);
const yuvB = (y: number, u: number) => clip8(mult(y, 19077) + mult(u, 33050) - 17685);

/** libwebp's "fancy" chroma upsampling and YUV to RGB conversion. Returns straight RGBA (alpha 255). */
export function yuvToRgba(yuv: Yuv): Uint8Array {
  const { width, height } = yuv;
  const out = new Uint8Array(width * height * 4);
  const put = (row: number, x: number, y: number, u: number, v: number) => {
    const o = (row * width + x) * 4;
    out[o] = yuvR(y, v);
    out[o + 1] = yuvG(y, u, v);
    out[o + 2] = yuvB(y, u);
    out[o + 3] = 255;
  };
  const uAt = (r: number, x: number) => yuv.u[r * yuv.uvStride + x]!;
  const vAt = (r: number, x: number) => yuv.v[r * yuv.uvStride + x]!;
  const line = (topRow: number, bottomRow: number | null, topUvRow: number, curUvRow: number) => {
    const last = (width - 1) >> 1;
    let tlU = uAt(topUvRow, 0),
      tlV = vAt(topUvRow, 0),
      lU = uAt(curUvRow, 0),
      lV = vAt(curUvRow, 0);
    const Yt = (x: number) => yuv.y[topRow * yuv.yStride + x]!;
    const Yb = (x: number) => yuv.y[bottomRow! * yuv.yStride + x]!;
    put(topRow, 0, Yt(0), (3 * tlU + lU + 2) >> 2, (3 * tlV + lV + 2) >> 2);
    if (bottomRow !== null) put(bottomRow, 0, Yb(0), (3 * lU + tlU + 2) >> 2, (3 * lV + tlV + 2) >> 2);
    for (let x = 1; x <= last; x++) {
      const tU = uAt(topUvRow, x),
        tV = vAt(topUvRow, x),
        cU = uAt(curUvRow, x),
        cV = vAt(curUvRow, x);
      const avgU = tlU + tU + lU + cU + 8,
        avgV = tlV + tV + lV + cV + 8;
      const d12U = (avgU + 2 * (tU + lU)) >> 3,
        d12V = (avgV + 2 * (tV + lV)) >> 3,
        d03U = (avgU + 2 * (tlU + cU)) >> 3,
        d03V = (avgV + 2 * (tlV + cV)) >> 3;
      put(topRow, 2 * x - 1, Yt(2 * x - 1), (d12U + tlU) >> 1, (d12V + tlV) >> 1);
      if (2 * x < width) put(topRow, 2 * x, Yt(2 * x), (d03U + tU) >> 1, (d03V + tV) >> 1);
      if (bottomRow !== null) {
        put(bottomRow, 2 * x - 1, Yb(2 * x - 1), (d03U + lU) >> 1, (d03V + lV) >> 1);
        if (2 * x < width) put(bottomRow, 2 * x, Yb(2 * x), (d12U + cU) >> 1, (d12V + cV) >> 1);
      }
      tlU = tU;
      tlV = tV;
      lU = cU;
      lV = cV;
    }
    if (!(width & 1)) {
      put(topRow, width - 1, Yt(width - 1), (3 * tlU + lU + 2) >> 2, (3 * tlV + lV + 2) >> 2);
      if (bottomRow !== null) put(bottomRow, width - 1, Yb(width - 1), (3 * lU + tlU + 2) >> 2, (3 * lV + tlV + 2) >> 2);
    }
  };
  line(0, null, 0, 0);
  let row = 1;
  for (; row + 1 < height; row += 2) line(row, row + 1, (row - 1) >> 1, (row + 1) >> 1);
  if (row < height) {
    // the last luma row of an even height: its chroma row is its own
    const uvRow = (height - 1) >> 1;
    line(row, null, uvRow, uvRow);
  }
  return out;
}
