import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import { maximumScreenshotBytes } from '../audio/feedback-png.ts';
import { maximumAudioBytes } from '../audio/audio-validation.ts';

interface ObjectInfo {
  size: number;
  httpMetadata: { contentType?: string; cacheControl?: string };
}
export interface PrivateBucket {
  delete?(key: string): Promise<void>;
  put(
    key: string,
    bytes: Uint8Array,
    options: { onlyIf: Headers; sha256: string; httpMetadata: { contentType: string; cacheControl: string } },
  ): Promise<ObjectInfo | null>;
  get(
    key: string,
  ): Promise<(ObjectInfo & { body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> }) | null>;
}
export interface MediaObjectScope {
  instanceId: string;
  ownerId: string;
  mediaId: string;
  kind: 'screenshot' | 'speech' | 'audition';
}
export interface MediaObjectReference extends MediaObjectScope {
  byteLength: number;
  sha256: string;
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const limit = (kind: MediaObjectScope['kind']) => (kind === 'screenshot' ? maximumScreenshotBytes : maximumAudioBytes);
const mime = (kind: MediaObjectScope['kind']) => (kind === 'screenshot' ? 'image/png' : 'audio/wav');
function key(scope: MediaObjectScope) {
  ensure(
    ['screenshot', 'speech', 'audition'].includes(scope.kind) &&
      [scope.instanceId, scope.ownerId, scope.mediaId].every(
        (v) => typeof v === 'string' && v.length > 0 && v.length <= 256,
      ),
    'INVALID_MEDIA_REFERENCE',
  );
  return `private/v1/${scope.kind}/${digest(JSON.stringify([scope.instanceId, scope.ownerId, scope.mediaId]))}`;
}
function validate(reference: MediaObjectReference) {
  key(reference);
  ensure(
    Number.isSafeInteger(reference.byteLength) &&
      reference.byteLength > 0 &&
      reference.byteLength <= limit(reference.kind) &&
      /^[a-f0-9]{64}$/.test(reference.sha256),
    'INVALID_MEDIA_REFERENCE',
  );
}

/** Internal storage only: caller validates PNG/WAV and derives scope from authoritative business state.
 * The mandatory guard must check current identity, ownership and recovery epoch, not just a bearer token.
 * Staging is NOT publication: caller rechecks its lease/guard and commits the reference in SQL afterwards.
 * Failed commits may leave private orphans; never delete them here or expose a public object URL.
 */
export class PrivateMediaObjects {
  readonly #bucket: PrivateBucket;
  constructor(bucket: PrivateBucket) {
    this.#bucket = bucket;
  }
  async stage(
    scope: MediaObjectScope,
    value: Uint8Array,
    authorize: () => Promise<void>,
  ): Promise<MediaObjectReference> {
    key(scope);
    ensure(
      value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= limit(scope.kind),
      'MEDIA_SIZE_LIMIT',
    );
    // Own the snapshot across awaits; a mutable caller buffer must not change an in-flight upload.
    const bytes = Buffer.from(value);
    const reference: MediaObjectReference = { ...scope, byteLength: bytes.byteLength, sha256: digest(bytes) };
    await authorize();
    const written = await this.#bucket.put(key(reference), bytes, {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      sha256: reference.sha256,
      httpMetadata: { contentType: mime(reference.kind), cacheControl: 'no-store' },
    });
    if (written === null) await this.read(reference, authorize);
    await authorize();
    return reference;
  }
  /** Explicit retention worker only; authorization must validate the durable deletion intent. */
  async remove(value: MediaObjectReference, authorize: () => Promise<void>) {
    const reference = { ...value };
    validate(reference);
    ensure(this.#bucket.delete, 'MEDIA_DELETE_UNAVAILABLE');
    await authorize();
    await this.#bucket.delete(key(reference));
    await authorize();
    const remaining = await this.#bucket.get(key(reference));
    if (remaining) {
      await remaining.body.cancel();
      ensure(false, 'MEDIA_DELETE_INCOMPLETE');
    }
    await authorize();
  }
  /** Erase private bytes but retain a zero-byte fence. Unlike DELETE, it prevents a late
   * If-None-Match:* staging PUT from resurrecting content after a crashed writer. */
  async erase(value: MediaObjectReference, authorize: () => Promise<void>) {
    const reference = { ...value };
    validate(reference);
    await authorize();
    await this.#bucket.put(key(reference), new Uint8Array(), {
      onlyIf: new Headers(),
      sha256: digest(new Uint8Array()),
      httpMetadata: { contentType: 'application/x-web-erased', cacheControl: 'no-store' },
    });
    await authorize();
    const tombstone = await this.#bucket.get(key(reference));
    ensure(tombstone, 'MEDIA_ERASURE_INCOMPLETE');
    const bytes = await tombstone.arrayBuffer();
    ensure(
      tombstone.size === 0 &&
        bytes.byteLength === 0 &&
        tombstone.httpMetadata.contentType === 'application/x-web-erased',
      'MEDIA_ERASURE_INCOMPLETE',
    );
    await authorize();
  }
  async read(value: MediaObjectReference, authorize: () => Promise<void>): Promise<Buffer> {
    const reference = { ...value };
    validate(reference);
    await authorize();
    const object = await this.#bucket.get(key(reference));
    ensure(object, 'MEDIA_FILE_UNAVAILABLE');
    if (
      object.size !== reference.byteLength ||
      object.httpMetadata.contentType !== mime(reference.kind) ||
      object.httpMetadata.cacheControl !== 'no-store'
    ) {
      await object.body.cancel();
      ensure(false, 'MEDIA_INTEGRITY_ERROR');
    }
    const bytes = Buffer.from(await object.arrayBuffer());
    ensure(bytes.byteLength === reference.byteLength && digest(bytes) === reference.sha256, 'MEDIA_INTEGRITY_ERROR');
    await authorize();
    return bytes;
  }
}
