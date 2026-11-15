import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AVATAR_MAX_BYTES, normalizeAvatar } from '../../../packages/imaging/avatar.ts';
import { ImageError, decodePng } from '../../../packages/imaging/png.ts';

/**
 * Part 31 / 31b. The server decodes PNG only (the admin's browser crops, shrinks and encodes the picture before upload).
 * Named exceptions (Part 31b, with the files they covered): the JPEG decoder tests "JPEG decoder is within libjpeg rounding of the
 * reference: i.jpg / j-prog.jpg / k-gray.jpg / l-420.jpg / m-444.jpg" and the WebP decoder tests "decoder is bit-exact with the
 * reference pixels: n-lossy.webp / o-lossless.webp / p-alpha-lossy.webp / q-alpha-lossless.webp / r-lossy-q20.webp" went with
 * jpeg.ts, webp.ts, webp-lossy.ts, webp-lossless.ts and vp8-tables.ts; the PNG decoder tests (a, b-alpha, c-pal, d-gray, e-ga,
 * f-1bit, h-interlaced) are unchanged. "the stored picture is a PNG of pixels and nothing else" and "the output is a bounded
 * square" and "refusals" are rewritten for a PNG-only server (their JPEG/WebP inputs are now AVATAR_FORMAT refusals).
 */
const dir = new URL('../fixtures/avatars/', import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(new URL(name, dir)));
const reference = JSON.parse(readFileSync(new URL('reference.json', dir), 'utf8')) as Record<string, string>;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MAX = 8_000_000;

for (const name of Object.keys(reference))
  test(`decoder is bit-exact with the reference pixels: ${name}`, () => {
    assert.equal(sha(decodePng(file(name), MAX).rgba), reference[name]);
  });

const chunkTypes = (png: Uint8Array) => {
  const types: string[] = [];
  const view = new DataView(png.buffer, png.byteOffset);
  for (let at = 8; at < png.length; ) {
    types.push(String.fromCharCode(...png.subarray(at + 4, at + 8)));
    at += 12 + view.getUint32(at);
  }
  return types;
};
const contains = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text));
const code = (bytes: Uint8Array) => {
  try {
    normalizeAvatar(bytes);
  } catch (error) {
    assert.ok(error instanceof ImageError, String(error));
    return error.code;
  }
  return 'ACCEPTED';
};

test('the stored picture is a PNG of pixels and nothing else: EXIF, GPS, XMP and text chunks never survive', () => {
  const raw = file('sq-meta.png');
  for (const secret of ['SECRET-GPS', 'SECRET-EXIF', 'SECRET-XMP'])
    assert.ok(contains(raw, secret), 'the input really carries it');
  const out = normalizeAvatar(raw);
  assert.deepEqual(chunkTypes(out.png), ['IHDR', 'IDAT', 'IEND']);
  for (const secret of ['SECRET', 'GPS', 'Exif', 'XMP', 'tEXt', 'eXIf', 'iCCP', 'iTXt'])
    assert.equal(contains(out.png, secret), false, secret);
  assert.equal(out.sha256, sha(out.png));
  assert.deepEqual(decodePng(out.png, MAX).rgba, decodePng(normalizeAvatar(file('sq-a.png')).png, MAX).rgba);
});

test('what the browser sends is a square PNG of 64..512 px: those are accepted, anything else is refused before inflating', () => {
  const a = normalizeAvatar(file('sq-a.png'));
  assert.deepEqual([a.width, a.height], [128, 128]);
  assert.equal(decodePng(normalizeAvatar(file('sq-b-alpha.png')).png, MAX).alpha, true);
  assert.equal(code(file('sq-512.png')), 'ACCEPTED');
  assert.equal(code(file('sq-513.png')), 'AVATAR_DIMENSIONS');
  assert.equal(code(file('sq-40.png')), 'AVATAR_DIMENSIONS');
  assert.equal(code(file('wide.png')), 'AVATAR_DIMENSIONS', 'not square');
  assert.equal(code(file('huge-dimensions.png')), 'AVATAR_DIMENSIONS');
});

test('refusals: only a PNG is accepted; SVG, a JPEG or WebP signature, a lying signature, a damaged or bomb stream, too many bytes', () => {
  assert.equal(code(file('icon.svg')), 'AVATAR_FORMAT');
  assert.equal(
    code(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])),
    'AVATAR_FORMAT',
    'a JPEG is converted by the browser, never sent',
  );
  assert.equal(code(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'AVATAR_FORMAT');
  assert.equal(code(file('svg-as.png')), 'AVATAR_INVALID');
  assert.equal(code(new Uint8Array()), 'AVATAR_INVALID');
  assert.equal(code(file('bomb.png')), 'AVATAR_INVALID', 'an 80x80 header over a stream that inflates to 50 MB');
  const damaged = new Uint8Array(file('sq-a.png'));
  damaged[damaged.length - 20]! ^= 0xff;
  assert.equal(code(damaged), 'AVATAR_INVALID', 'a chunk checksum that does not match');
  const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
  big.set(file('sq-a.png'));
  assert.equal(code(big), 'AVATAR_TOO_LARGE');
});
