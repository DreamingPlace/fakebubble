import { Buffer } from 'node:buffer';
import { crc32, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';

export const maximumScreenshotBytes = 5 * 1024 * 1024;
export const maximumScreenshotPixels = 8 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type: string, data: Buffer) {
  const value = Buffer.alloc(data.length + 12);
  value.writeUInt32BE(data.length);
  value.write(type, 4, 'ascii');
  data.copy(value, 8);
  value.writeUInt32BE(crc32(value.subarray(4, -4)), value.length - 4);
  return value;
}

/** Deliberately bounded PNG subset: the iOS picker renders selected images to 8-bit sRGB RGB/RGBA first.
 * Validate every CRC, the complete deflate stream, scanline sizes and filters; discard ancillary metadata.
 * W3C PNG: https://www.w3.org/TR/png-3/#5DataRep https://www.w3.org/TR/png-3/#9Filters
 */
export function normalizeFeedbackPNG(bytes: Uint8Array) {
  ensure(bytes.byteLength > 0 && bytes.byteLength <= maximumScreenshotBytes, 'SCREENSHOT_TOO_LARGE');
  const input = Buffer.from(bytes);
  ensure(input.subarray(0, 8).equals(signature), 'INVALID_SCREENSHOT');
  let offset = 8,
    count = 0,
    width = 0,
    height = 0,
    channels = 0,
    ended = false,
    idatClosed = false;
  let ihdr: Buffer | null = null;
  const idats: Buffer[] = [];
  while (offset < input.length) {
    ensure(!ended && ++count <= 512 && offset + 12 <= input.length, 'INVALID_SCREENSHOT');
    const length = input.readUInt32BE(offset),
      end = offset + 12 + length;
    ensure(end <= input.length, 'INVALID_SCREENSHOT');
    const type = input.toString('latin1', offset + 4, offset + 8),
      data = input.subarray(offset + 8, end - 4);
    ensure(
      /^[A-Za-z]{4}$/.test(type) &&
        type[2] === type[2]!.toUpperCase() &&
        input.readUInt32BE(end - 4) === crc32(input.subarray(offset + 4, end - 4)),
      'INVALID_SCREENSHOT',
    );
    if (type === 'IHDR') {
      ensure(count === 1 && length === 13, 'INVALID_SCREENSHOT');
      ihdr = data;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      ensure(
        width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= maximumScreenshotPixels,
        'SCREENSHOT_PIXELS_EXCEEDED',
      );
      ensure(
        data[8] === 8 && [2, 6].includes(data[9]!) && data[10] === 0 && data[11] === 0 && data[12] === 0,
        'INVALID_SCREENSHOT',
      );
      channels = data[9] === 6 ? 4 : 3;
    } else {
      ensure(ihdr, 'INVALID_SCREENSHOT');
      if (type === 'IDAT') {
        ensure(!idatClosed, 'INVALID_SCREENSHOT');
        idats.push(data);
      } else {
        if (idats.length) idatClosed = true;
        if (type === 'IEND') {
          ensure(length === 0 && idats.length > 0 && end === input.length, 'INVALID_SCREENSHOT');
          ended = true;
        } else
          ensure(
            type[0] === type[0]!.toLowerCase() && !['acTL', 'fcTL', 'fdAT', 'tRNS'].includes(type),
            'INVALID_SCREENSHOT',
          );
      }
    }
    offset = end;
  }
  ensure(ended && ihdr, 'INVALID_SCREENSHOT');
  const compressed = Buffer.concat(idats),
    stride = width * channels + 1,
    expected = stride * height;
  let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    inflated = inflateSync(compressed, { maxOutputLength: expected, info: true }) as unknown as typeof inflated;
  } catch {
    ensure(false, 'INVALID_SCREENSHOT');
  }
  ensure(
    inflated.buffer.length === expected && inflated.engine.bytesWritten === compressed.length,
    'INVALID_SCREENSHOT',
  );
  for (let row = 0; row < height; row++) ensure(inflated.buffer[row * stride]! <= 4, 'INVALID_SCREENSHOT');
  const png = Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  ensure(png.length <= maximumScreenshotBytes, 'SCREENSHOT_TOO_LARGE');
  return { png, width, height, byteLength: png.length, sha256: createHash('sha256').update(png).digest('hex') };
}
