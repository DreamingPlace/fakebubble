import { inflateSync } from 'node:zlib';

/** A tiny PNG reader for the browser audit: 8-bit RGB / RGBA, non-interlaced (what Playwright screenshots are). */
export function decodePng(buffer: Buffer) {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const data: Buffer[] = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      let out = value;
      if (filter === 1) out = value + left;
      else if (filter === 2) out = value + up;
      else if (filter === 3) out = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      pixels[y * stride + x] = out & 255;
    }
  }
  return {
    width,
    height,
    at: (x: number, y: number): [number, number, number] => {
      const i = y * stride + x * channels;
      return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    },
  };
}
