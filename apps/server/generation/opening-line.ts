import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 26a. The character's welcome line of the PUBLISHED revision the request's template was frozen from (never the current
 * draft, never a later publication), as the request's `opening`. Nothing when it cannot be resolved or is empty.
 * The line is presentation text of the character: it is never stored as a player fact or a memory.
 */
export function openingFrom(text: unknown): TextGenerationRequest['opening'] | undefined {
  return typeof text === 'string' && text.trim().length > 0 ? { text } : undefined;
}

export function frozenOpening(store: Pick<BusinessStore, 'get'>, characterId: string, templateVersion: number) {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_versions'")) {
    const seed = Object.hasOwn(WEB_PROVIDER_WELCOME, characterId)
      ? WEB_PROVIDER_WELCOME[characterId as keyof typeof WEB_PROVIDER_WELCOME]
      : undefined;
    return openingFrom(seed?.text);
  }
  const row = store.get<{ profile_json: string }>(
    'SELECT profile_json FROM web_character_versions WHERE character_id=? AND version=?',
    characterId,
    templateVersion,
  );
  if (!row) return undefined;
  try {
    return openingFrom(
      (JSON.parse(row.profile_json) as { presentation?: { welcome?: { text?: unknown } } }).presentation?.welcome?.text,
    );
  } catch {
    return undefined;
  }
}
