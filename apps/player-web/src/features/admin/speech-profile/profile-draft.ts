import type { CharacterAdminClient, CharacterProfile } from '../../../services/character-admin-api.ts';
import {
  SPEECH_PROFILE_ERROR_TEXT,
  SpeechProfileError,
  checkIndependence,
  type IndependenceResult,
} from '../../../../../../packages/contracts/speech-profile.ts';

/**
 * Part 37b: what the 说话档案 screens share: reading a character's draft (the published version while there is none), saving a
 * changed template through the EXISTING draft save (compare-and-swap on the revision it was read at; nothing is published), and the
 * independence check against every other character. No storage of its own.
 */
type Api = Pick<CharacterAdminClient, 'list' | 'detail' | 'save'>;
export type DraftTarget = { base: CharacterProfile; revision: number | null; publishedVersion: number | null };

export const NO_DRAFT_TEXT = '这个角色还没有可编辑的版本，请先在角色工作台中创建草稿。';
export const OTHERS_UNREADABLE_TEXT = '没能读取其他角色的说话档案，无法核对是否撞车，请稍后重试。';
export const NOT_SAVED_TEXT = '草稿没有保存成功，请核对后重试。';

/** The sentence of a thrown error of this module (null for anything else). */
export const profileErrorText = (error: unknown) =>
  error instanceof SpeechProfileError ? (SPEECH_PROFILE_ERROR_TEXT[error.code] ?? null) : null;

export async function readTarget(api: Pick<Api, 'detail'>, characterId: string): Promise<DraftTarget | null> {
  const detail = await api.detail(characterId);
  const base = detail.draft?.profile ?? detail.published?.profile;
  if (!base) return null;
  return { base, revision: detail.draft?.revision ?? null, publishedVersion: detail.published?.version ?? null };
}

/** Saves `template` as the character's next draft revision. With no draft yet it starts one, one version after the published one. */
export async function saveTemplate(
  api: Pick<Api, 'save'>,
  characterId: string,
  target: DraftTarget,
  template: unknown,
) {
  const profile = structuredClone(target.base);
  if (target.revision === null && target.publishedVersion !== null)
    (profile.template as { version: number }).version = target.publishedVersion + 1;
  profile.template = template as typeof profile.template;
  return api.save(characterId, target.revision, profile);
}

/**
 * Every OTHER character's template (draft, else published) for the independence check. Read on demand and kept for 30 seconds, so a
 * run of adoptions does not read fifteen characters each time; a save of our own drops the cache.
 */
export function othersReader(api: Pick<Api, 'list' | 'detail'>, now: () => number = Date.now) {
  let cache: { at: number; for: string; rows: { characterId: string; template: unknown }[] } | null = null;
  return {
    forget: () => {
      cache = null;
    },
    async read(exceptId: string) {
      if (cache && cache.for === exceptId && now() - cache.at < 30_000) return cache.rows;
      const { characters } = await api.list();
      const rows: { characterId: string; template: unknown }[] = [];
      for (const character of characters) {
        if (character.characterId === exceptId) continue;
        const detail = await api.detail(character.characterId);
        const profile = detail.draft?.profile ?? detail.published?.profile;
        if (profile) rows.push({ characterId: character.characterId, template: profile.template });
      }
      cache = { at: now(), for: exceptId, rows };
      return rows;
    },
  };
}
export type OthersReader = ReturnType<typeof othersReader>;

/** The lines `next` adds to `previous`, against every other character. Rejects (OTHERS_UNREADABLE) when the others cannot be read. */
export async function independence(
  others: OthersReader,
  characterId: string,
  previous: unknown,
  next: unknown,
): Promise<IndependenceResult> {
  let rows: Awaited<ReturnType<OthersReader['read']>>;
  try {
    rows = await others.read(characterId);
  } catch {
    throw new Error('PROFILE_OTHERS_UNREADABLE');
  }
  return checkIndependence(previous, next, rows);
}

/** The sentences of a result: who it is close to (by display name) and the line. At most three are shown. */
export function independenceSentences(result: IndependenceResult, nameOf: (characterId: string) => string): string[] {
  return result.hits
    .slice(0, 3)
    .map(
      (hit) =>
        `和${nameOf(hit.characterId)}的「${hit.text}」${hit.score >= 0.9 ? '几乎一样' : '很接近'}（${Math.round(hit.score * 100)}%）`,
    );
}
