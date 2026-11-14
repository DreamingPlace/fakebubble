import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AVATAR_MAX_BYTES, AVATAR_OUTPUT_SIDE, normalizeAvatar, sniffImage } from '../../../packages/imaging/avatar.ts';
import { ImageError, decodePng } from '../../../packages/imaging/png.ts';
import { decodeJpeg } from '../../../packages/imaging/jpeg.ts';
import { decodeWebp } from '../../../packages/imaging/webp.ts';

/**
 * Part 31 (25e): our own decoders. Every reference here is the pixel output of Pillow / libwebp / libjpeg on the same file (made once with
 * a trusted tool, not by this code): PNG and WebP must match bit for bit (lossy WebP included, with its alpha plane); JPEG matches
 * libjpeg within rounding (a different but equally valid upsampler and IDCT).
 */
const dir = new URL('../fixtures/avatars/', import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(new URL(name, dir)));
const reference = JSON.parse(readFileSync(new URL('reference.json', dir), 'utf8')) as Record<string, string>;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MAX = 8_000_000;

for (const name of Object.keys(reference).filter((n) => n.endsWith('.png') || n.endsWith('.webp')))
  test(`decoder is bit-exact with the reference pixels: ${name}`, () => {
    const bytes = file(name);
    const picture = name.endsWith('.png') ? decodePng(bytes, MAX) : decodeWebp(bytes, MAX);
    assert.equal(sha(picture.rgba), reference[name]);
  });

for (const name of ['i.jpg', 'j-prog.jpg', 'k-gray.jpg', 'l-420.jpg', 'm-444.jpg'])
  test(`JPEG decoder is within libjpeg rounding of the reference: ${name}`, () => {
    const picture = decodeJpeg(file(name), MAX);
    const expected = file(`${name}.rgba`);
    assert.equal(picture.rgba.length, expected.length);
    let max = 0,
      sum = 0;
    for (let i = 0; i < expected.length; i++) {
      const d = Math.abs(expected[i]! - picture.rgba[i]!);
      max = Math.max(max, d);
      sum += d;
    }
    assert.ok(max <= 6, `max difference ${max}`);
    assert.ok(sum / expected.length < 0.6, `mean difference ${sum / expected.length}`);
  });

/** Every chunk type of a PNG in order. */
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

test('the stored picture is a PNG of pixels and nothing else: EXIF, GPS, XMP, text and camera strings never survive, whatever the source format', () => {
  for (const name of ['i.jpg', 'n-lossy.webp', 'meta.png', 'a.png', 'o-lossless.webp']) {
    const raw = file(name);
    const out = normalizeAvatar(raw);
    assert.deepEqual(chunkTypes(out.png), ['IHDR', 'IDAT', 'IEND'], `${name}: only the picture chunks`);
    for (const secret of ['SecretCam', 'SECRET', 'GPS', 'Exif', 'XMP', 'tEXt', 'eXIf', 'iCCP', 'iTXt'])
      assert.equal(contains(out.png, secret), false, `${name} leaks ${secret}`);
    assert.equal(sniffImage(out.png), 'png');
    assert.equal(out.sha256, sha(out.png));
  }
  // the secrets really were in the inputs (so the test could fail)
  assert.ok(contains(file('i.jpg'), 'SecretCam') && contains(file('n-lossy.webp'), 'SecretCam'));
  assert.ok(
    contains(file('meta.png'), 'SECRET-GPS') &&
      contains(file('meta.png'), 'SECRET-EXIF') &&
      contains(file('meta.png'), 'SECRET-XMP'),
  );
  // the pixels are the same picture as the metadata-free one
  assert.deepEqual(
    decodePng(normalizeAvatar(file('meta.png')).png, MAX).rgba,
    decodePng(normalizeAvatar(file('a.png')).png, MAX).rgba,
  );
});

test('the output is a bounded square: centre-cropped, shrunk to at most 512 px, alpha kept only when the picture has any', () => {
  const wide = normalizeAvatar(file('wide.png'));
  assert.deepEqual([wide.width, wide.height], [120, 120], 'cropped to the short side, never enlarged');
  const opaque = decodePng(wide.png, MAX);
  assert.equal(opaque.alpha, false);
  assert.ok(opaque.rgba.every((v, i) => (i % 4 === 3 ? v === 255 : true)));
  const transparent = normalizeAvatar(file('b-alpha.png'));
  assert.equal(decodePng(transparent.png, MAX).alpha, true);
  assert.ok(AVATAR_OUTPUT_SIDE === 512 && transparent.width <= 512);
});

test('refusals: SVG and other formats, a lying signature, an unreadable or cut-off file, too big in bytes, in pixels, or too small', () => {
  const code = (bytes: Uint8Array) => {
    try {
      normalizeAvatar(bytes);
    } catch (error) {
      assert.ok(error instanceof ImageError, String(error));
      return error.code;
    }
    return 'ACCEPTED';
  };
  assert.equal(code(file('icon.svg')), 'AVATAR_FORMAT', 'SVG is never an avatar');
  assert.equal(code(new TextEncoder().encode('GIF89a......')), 'AVATAR_FORMAT');
  assert.equal(code(file('svg-as.png')), 'AVATAR_INVALID', 'a PNG signature in front of markup is not a picture');
  assert.equal(code(file('truncated.jpg')), 'AVATAR_INVALID');
  assert.equal(code(new Uint8Array()), 'AVATAR_INVALID');
  assert.equal(
    code(file('huge-dimensions.png')),
    'AVATAR_DIMENSIONS',
    'refused from the header, before anything is inflated',
  );
  assert.equal(
    code(file('bomb.png')),
    'AVATAR_INVALID',
    'a stream that inflates beyond what the header allows is refused',
  );
  assert.equal(code(file('tiny.png')), 'AVATAR_DIMENSIONS');
  const tooBig = new Uint8Array(AVATAR_MAX_BYTES + 1);
  tooBig.set(file('a.png'));
  assert.equal(code(tooBig), 'AVATAR_TOO_LARGE');
  // an animated WebP is not a still avatar
  const animated = new Uint8Array(file('o-lossless.webp'));
  const x = new Uint8Array([
    ...animated.subarray(0, 12),
    ...new TextEncoder().encode('VP8X'),
    10,
    0,
    0,
    0,
    0x02,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...animated.subarray(12),
  ]);
  new DataView(x.buffer).setUint32(4, x.length - 8, true);
  assert.equal(code(x), 'AVATAR_FORMAT');
});

test('a PNG with a damaged checksum or an Adam7 body decodes or refuses exactly', () => {
  const broken = new Uint8Array(file('a.png'));
  broken[broken.length - 20]! ^= 0xff;
  assert.throws(() => decodePng(broken, MAX), /IMAGE_INVALID/);
  const interlaced = decodePng(file('h-interlaced.png'), MAX);
  assert.equal(sha(interlaced.rgba), reference['h-interlaced.png']);
});
