import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import type { MediaObjectReference, MediaObjectScope, PrivateMediaObjects } from './cloudflare/media-objects.ts';

export type ProviderAudioRow = { audio_bytes: Uint8Array | null; audio_ref_json?: string | null };
export type ProviderAudioCache = Map<string, Buffer>;
export type ProviderAudioStore = { instanceId: string; providerAudio?: PrivateMediaObjects };
export type ProviderAudioScope = { principalId: string; playerId: string; worldId: string;
  conversationId: string; characterId: string; inputMessageId: string };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function speechObjectScope(store: ProviderAudioStore, operationId: string, ordinal: number,
  scope: ProviderAudioScope): MediaObjectScope {
  return { instanceId: store.instanceId, kind: 'speech',
    ownerId: hash(JSON.stringify([scope.principalId,scope.playerId,scope.worldId,
      scope.conversationId,scope.characterId,scope.inputMessageId])),
    mediaId: hash(JSON.stringify(['web-speech-v1', operationId, ordinal])) };
}
export function fixedObjectScope(store: ProviderAudioStore, kind: 'welcome' | 'footer',
  characterId: string, voiceVersion: string): MediaObjectScope {
  return { instanceId: store.instanceId, kind: 'speech', ownerId: 'web-fixed-v1',
    mediaId: hash(JSON.stringify([kind,characterId,voiceVersion])) };
}
export function checkAudioReference(value: MediaObjectReference, expected: MediaObjectScope, bytes?: Uint8Array) {
  ensure(value && value.instanceId === expected.instanceId && value.ownerId === expected.ownerId &&
    value.mediaId === expected.mediaId && value.kind === expected.kind &&
    Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= 6_000_000 &&
    /^[a-f0-9]{64}$/.test(value.sha256), 'WEB_AUDIO_REFERENCE_INVALID');
  if (bytes) ensure(bytes.byteLength === value.byteLength && hash(bytes) === value.sha256, 'WEB_AUDIO_REFERENCE_INVALID');
  return value;
}
/** Sync business transactions only consume bytes already verified by the async storage boundary. */
export function providerAudioBytes(row: ProviderAudioRow, cache?: ProviderAudioCache): Buffer {
  if (!row.audio_ref_json) {
    ensure(row.audio_bytes instanceof Uint8Array, 'WEB_PROVIDER_OUTPUT_INVALID');
    return Buffer.from(row.audio_bytes);
  }
  ensure(row.audio_bytes === null, 'WEB_AUDIO_REFERENCE_INVALID');
  const reference = JSON.parse(row.audio_ref_json) as MediaObjectReference;
  const bytes = cache?.get(row.audio_ref_json);
  ensure(bytes && bytes.length === reference.byteLength && hash(bytes) === reference.sha256, 'WEB_AUDIO_NOT_LOADED');
  return bytes;
}
export async function loadProviderAudio(store: ProviderAudioStore, row: ProviderAudioRow,
  expected: MediaObjectScope, authorize: () => Promise<void>, cache: ProviderAudioCache) {
  if (!row.audio_ref_json) return providerAudioBytes(row);
  ensure(store.providerAudio && row.audio_bytes === null, 'WEB_AUDIO_REFERENCE_INVALID');
  const reference = checkAudioReference(JSON.parse(row.audio_ref_json) as MediaObjectReference, expected);
  const bytes = await store.providerAudio.read(reference, authorize);
  checkAudioReference(reference, expected, bytes);
  cache.set(row.audio_ref_json, bytes);
  return bytes;
}
