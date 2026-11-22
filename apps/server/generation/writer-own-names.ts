import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import {
  CAST_ALIAS_ATTITUDES,
  CAST_ALIAS_KIND_LABEL,
  type CastAliasAttitude,
} from '../../../packages/contracts/web-cast.ts';
import { castTablesExist, latestPublication } from '../cast/cast-store.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 51 (rule 5): the character's OWN names, each with its kind and her attitude to it, for a v8 request. NO new data and NO new
 * field: it is read from what already exists, once, when the request is frozen, whatever CAST_CONTEXT_ENABLED says (like the roster):
 *   - the published cast file: `identity.aliases` (自称 / 别名 / 中性称呼 / 黑称, with likes / ok / dislikes);
 *   - the profile settings of the character: 饰演过的角色 (`profileFacts`), and the older `selfIdentity.names` / `aliases` keys.
 * Both are merged. On a conflict (the same text in both) the cast file wins, its kind and its attitude.
 * Until now these names only told OTHER characters which names to avoid (cast-compile `othersAliases` → `doNotCall`).
 */
export type OwnName = NonNullable<TextGenerationRequest['ownNames']>[number];
export const OWN_NAMES_MAX = 40;
export const OWN_NAME_TEXT_MAX = 25;
export const ROLE_KIND = '饰演过的角色';
const KINDS: readonly string[] = [...Object.values(CAST_ALIAS_KIND_LABEL), ROLE_KIND];
/** A profile name has no attitude of its own: the same defaults the profile import gives each kind (docs/CHARACTER_TEMPLATE.md). */
const DEFAULT_ATTITUDE: Readonly<Record<string, CastAliasAttitude>> = {
  自称: 'likes',
  别名: 'likes',
  中性称呼: 'ok',
  黑称: 'dislikes',
  [ROLE_KIND]: 'ok',
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fits = (text: unknown): text is string =>
  typeof text === 'string' && text.trim() !== '' && [...text.trim()].length <= OWN_NAME_TEXT_MAX;

/** A list field as the profile writes it: each item in 「…」, or separated by 、 ， , ; ； or lines. */
export function listItems(text: string): string[] {
  const bracketed = [...text.matchAll(/「([^」]*)」/gu)].map((m) => m[1]!.trim());
  const items = bracketed.length ? bracketed : text.split(/[、，,;；\n]/u).map((item) => item.trim());
  return items.filter((item) => item !== '');
}

/** The names the character's own profile settings hold (never mutated). */
export function ownNamesFromProfile(template: { name?: string; authorCanon?: unknown }): OwnName[] {
  const canon = template.authorCanon;
  const settings = isObject(canon) && isObject(canon.settings) ? canon.settings : {};
  const out: OwnName[] = [];
  const add = (text: unknown, kind: string, attitude?: unknown) => {
    if (!fits(text) || !KINDS.includes(kind)) return;
    const clean = text.trim();
    if (out.some((item) => item.text === clean)) return;
    out.push({
      text: clean,
      kind,
      attitude: (CAST_ALIAS_ATTITUDES as readonly unknown[]).includes(attitude)
        ? (attitude as CastAliasAttitude)
        : DEFAULT_ATTITUDE[kind]!,
    });
  };
  // Older profile keys: plain strings are 别名; an object may carry its own kind and attitude.
  const identity = settings.selfIdentity;
  if (isObject(identity) && Array.isArray(identity.names))
    for (const name of identity.names) if (name !== template.name) add(name, '别名');
  if (Array.isArray(settings.aliases))
    for (const item of settings.aliases)
      if (typeof item === 'string') add(item, '别名');
      else if (isObject(item))
        add(item.text ?? item.name, typeof item.kind === 'string' ? item.kind : '别名', item.attitude);
  const facts = settings.profileFacts;
  const roles = isObject(facts) ? facts[ROLE_KIND] : undefined;
  if (typeof roles === 'string') for (const role of listItems(roles)) add(role, ROLE_KIND);
  return out;
}

/** The merge. The cast file's entries come first and win: a profile name with the same text is dropped. */
export function mergeOwnNames(profile: readonly OwnName[], cast: readonly OwnName[]): OwnName[] {
  const taken = new Set(cast.map((item) => item.text));
  return [...cast, ...profile.filter((item) => !taken.has(item.text))].slice(0, OWN_NAMES_MAX);
}

/** A cast view's `self.aliases` (kind spelled 自称 / 别名 / 中性称呼 / 黑称) as own names. */
export const ownNamesFromAliases = (aliases: readonly { text: string; kind: string; attitude: CastAliasAttitude }[]) =>
  aliases.flatMap((alias) =>
    fits(alias.text) && KINDS.includes(alias.kind) ? [{ ...alias, text: alias.text.trim() }] : [],
  );

/** The own names of a v8 request: the PUBLISHED cast file's aliases merged with the profile settings. Public data of this character only. */
export function writerOwnNames(
  store: Pick<BusinessStore, 'get' | 'all'>,
  characterId: string,
  template: { name?: string; authorCanon?: unknown },
): OwnName[] {
  const doc = castTablesExist(store) ? latestPublication(store)?.doc : undefined;
  const card = doc?.characters.find((c) => c.characterId === characterId);
  const cast = card
    ? ownNamesFromAliases(
        card.identity.aliases.map((a) => ({ text: a.text, kind: CAST_ALIAS_KIND_LABEL[a.kind], attitude: a.attitude })),
      )
    : [];
  return mergeOwnNames(ownNamesFromProfile(template), cast);
}

/** What the writer and the guard read: only entries of the right shape, at most OWN_NAMES_MAX. */
export const ownNamesValid = (value: unknown): value is OwnName[] =>
  Array.isArray(value) &&
  value.length <= OWN_NAMES_MAX &&
  value.every(
    (item) =>
      isObject(item) &&
      fits(item.text) &&
      typeof item.kind === 'string' &&
      KINDS.includes(item.kind) &&
      (CAST_ALIAS_ATTITUDES as readonly unknown[]).includes(item.attitude),
  );
