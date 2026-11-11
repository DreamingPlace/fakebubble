import {
  DEFAULT_SITE_VOICE_MODEL,
  resolveVoiceModel,
  type FishModel,
  type VoiceModelBinding,
} from '../../../packages/contracts/audio.ts';
import type { VoiceBinding } from '../../../packages/contracts/media.ts';
import { freeTier } from '../admission/web-free-tier.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../conversation/web-vertical-publisher.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { contentHash } from './admin-content-hash.ts';
import { codeOf } from './web-profile-schema.ts';

/**
 * Part 29 B and C. One Fish voice id per character, a derived voice binding, and a CLIP MANIFEST: everything a generated clip
 * depends on (the text of each welcome line, the footer text while it is required, and the voice: Fish referenceId and the
 * model that will actually speak). A 素材版本 is valid while its manifest is the draft's manifest; nothing else in the draft
 * (a weight, the persona, the colour) can make it stale.
 */
const HEX_ID = /^[0-9a-f]{32}$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface EffectiveVoice {
  binding: VoiceBinding;
  referenceId: string;
  /** True when no binding was ever written to the draft: profile id and version were derived from the Fish id. */
  derived: boolean;
  /** Where the Fish id came from. 'live' is only the published voice of a character whose draft names none. */
  source: 'draft' | 'recorded' | 'prepared' | 'live';
}

const siteModels = new WeakMap<object, FishModel>();
/** The model every un-pinned voice speaks with (FISH_VOICE_MODEL), set once by the business object. */
export const setSiteVoiceModel = (store: object, model: FishModel) => void siteModels.set(store, model);
export const siteVoiceModel = (store: object): FishModel => siteModels.get(store) ?? DEFAULT_SITE_VOICE_MODEL;

/** The footer is a clip only while the free tier is off (the guest trial footer plays only then). */
export const footerRequired = (store: BusinessStore) => !freeTier(store as { publicFreeTier?: boolean }).on;

type Bound = { voice_revision: number; profile_id: string; reference_id: string };
/** The newest binding the character was published with, if the database has bindings at all (a light fixture may not). */
function latestBinding(store: BusinessStore, characterId: string): Bound | undefined {
  const columns = (table: string) =>
    store.all<{ name: string }>(`PRAGMA table_info(${table})`).some((column) => column.name === 'reference_id');
  if (columns('web_character_voice_history')) {
    const row = store.get<Bound>(
      'SELECT voice_revision,profile_id,reference_id FROM web_character_voice_history WHERE character_id=? ORDER BY rowid DESC LIMIT 1',
      characterId,
    );
    if (row) return row;
  }
  if (columns('web_provider_voice_bindings'))
    return store.get<Bound>(
      'SELECT voice_revision,profile_id,reference_id FROM web_provider_voice_bindings WHERE character_id=?',
      characterId,
    );
  return undefined;
}

/** profileId = the 角色代码 lower-case, else the character id; version 1, +1 whenever the Fish id changes; speed 1. */
export function derivedBinding(store: BusinessStore, characterId: string, fishId: string): VoiceBinding {
  const code = codeOf(store, characterId)?.code.toLowerCase();
  const prior = latestBinding(store, characterId);
  return {
    profileId: code && SAFE_ID.test(code) ? code : characterId,
    version: !prior ? 1 : prior.reference_id === fishId ? prior.voice_revision : prior.voice_revision + 1,
    speed: 1,
    referenceId: fishId,
  };
}

/**
 * The voice a character speaks with. A binding in the draft is kept EXACTLY (hand-made ones too); otherwise the Fish id a
 * profile import recorded gives a derived one. Nothing is written: no draft revision, no row.
 */
export function effectiveVoice(
  store: BusinessStore,
  characterId: string,
  template: { voice?: VoiceBinding | undefined },
): EffectiveVoice | null {
  const recorded = codeOf(store, characterId)?.voice_reference_id ?? null;
  const bound = template.voice;
  if (bound) {
    const live = latestBinding(store, characterId);
    // A binding made before Part 29 has no Fish id of its own: the one it was last prepared with (a 素材版本) is its voice.
    const prepared = store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", 'web_character_materials')
      ? store.get<{ reference_id: string }>(
          `SELECT reference_id FROM web_character_materials WHERE character_id=? AND profile_id=? AND voice_revision=?
          ORDER BY created_at DESC,rowid DESC LIMIT 1`,
          characterId,
          bound.profileId,
          bound.version,
        )
      : undefined;
    // A binding entered by hand often carries the Fish id as its 音色档案 ID.
    const found: [string, EffectiveVoice['source']] | null = bound.referenceId
      ? [bound.referenceId, 'draft']
      : recorded
        ? [recorded, 'recorded']
        : HEX_ID.test(bound.profileId)
          ? [bound.profileId, 'draft']
          : prepared
            ? [prepared.reference_id, 'prepared']
            : live
              ? [live.reference_id, 'live']
              : null;
    return found ? { binding: bound, referenceId: found[0], derived: false, source: found[1] } : null;
  }
  if (!recorded) {
    // A character that is live already speaks with its published binding, whatever its draft says.
    const live = latestBinding(store, characterId);
    return live
      ? {
          binding: {
            profileId: live.profile_id,
            version: live.voice_revision,
            speed: 1,
            referenceId: live.reference_id,
          },
          referenceId: live.reference_id,
          derived: false,
          source: 'live',
        }
      : null;
  }
  return {
    binding: derivedBinding(store, characterId, recorded),
    referenceId: recorded,
    derived: true,
    source: 'recorded',
  };
}

export interface ManifestSlot {
  kind: 'welcome' | 'footer';
  lineId: string | null;
  text: string;
}
export interface ClipManifest {
  slots: ManifestSlot[];
  voice: { referenceId: string; model: FishModel };
}
/** What the draft needs spoken, and in which voice. `model` is the binding choice of the 素材版本 resolved against the site. */
export function clipManifest(
  store: BusinessStore,
  profile: { presentation: { welcomes: { id: string; text: string }[] } },
  voice: { referenceId: string },
  modelBinding: VoiceModelBinding,
): ClipManifest {
  return {
    slots: [
      ...profile.presentation.welcomes.map((line) => ({ kind: 'welcome' as const, lineId: line.id, text: line.text })),
      ...(footerRequired(store) ? [{ kind: 'footer' as const, lineId: null, text: SYNTHETIC_TRIAL_FOOTER }] : []),
    ],
    voice: { referenceId: voice.referenceId, model: resolveVoiceModel(modelBinding, siteVoiceModel(store)) },
  };
}
export const clipManifestHash = (manifest: ClipManifest) => contentHash([manifest.slots, manifest.voice]);
