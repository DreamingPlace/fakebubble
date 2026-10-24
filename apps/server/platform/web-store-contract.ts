import type { PlayerModelId } from '../../../packages/contracts/player-models.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebConcurrency } from '../../../config/web-concurrency.ts';
import type { BusinessStore } from './store-contract.ts';
import type { WebPrivateAudioFiles } from '../audio/web-private-audio-files.ts';
import type { PrivateMediaObjects } from '../cloudflare/media-objects.ts';

/** Platform capabilities used by the shared web business code; no Node database or path. */
export interface WebRuntimeStore extends BusinessStore {
  readonly instanceId: string;
  readonly providerRuntime: boolean;
  readonly concurrency?: WebConcurrency;
  readonly dailyReplyLimit?: number;
  /** SIGNUP_BONUS_ENABLED: the 5-reply trial and the signup bonus (see admission/web-free-tier.ts); absent = off. */
  readonly publicFreeTier?: boolean;
  readonly chatReview?: boolean;
  /** CAST_CONTEXT_ENABLED (Part 24a): freeze the compiled cast view into new input snapshots. Absent = off. */
  readonly castContext?: boolean;
  /** PLAYER_MODEL_CHOICE_ENABLED: the models a player may pick (PLAYER_TEXT_MODELS). Absent = the feature is off. */
  readonly playerModelChoice?: readonly PlayerModelId[];
  readonly providerAudio?: PrivateMediaObjects;
  requireInviteTest(): void;
  requireProviderRuntime(): void;
  webIpKeyFingerprint(): string;
  webReceiptDigest(kind: 'receipt' | 'usage', json: string): string;
  webPrivateAudioFiles(): Pick<WebPrivateAudioFiles, 'read' | 'write'>;
}

const approved = new WeakSet<object>();
/** Only the validated platform constructors register a runtime; request data cannot opt in. */
export function registerWebRuntime(store: WebRuntimeStore) {
  approved.add(store);
}
export function requireWebRuntime(store: BusinessStore, kind: 'invite' | 'provider') {
  if (approved.has(store)) {
    const runtime = store as WebRuntimeStore;
    if (kind === 'invite') runtime.requireInviteTest();
    else runtime.requireProviderRuntime();
    return;
  }
  // Existing explicit Node in-memory fixtures remain offline-only.
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '',
    kind === 'invite' ? 'WEB_INVITE_OFFLINE_ONLY' : 'WEB_PROVIDER_OFFLINE_ONLY',
  );
}
