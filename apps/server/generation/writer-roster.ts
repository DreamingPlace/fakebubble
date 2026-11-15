import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { othersAliases } from '../cast/cast-compile.ts';
import { castTablesExist, latestPublication } from '../cast/cast-store.ts';
import { publishedWebCharacters } from '../characters/web-character-catalog.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 37a-2: the v8 writer's teammates. Every other character on the home page, in the console's catalog order (the same
 * `position` the owner arranges), as a card: a name, the aliases others may use and the cast card's one-liner. A character the
 * published cast file does not hold has its public name and public description instead. Never a hidden setting, 演绎说明,
 * relationship or story: those still need CAST_CONTEXT_ENABLED. This is read whether or not that switch is on, once, when the
 * request is frozen. Public catalog data only: no player, world or conversation is read.
 */
export type WriterRoster = NonNullable<TextGenerationRequest['roster']>;
const ONE_LINER_FALLBACK = 40;

export function writerRoster(store: Pick<BusinessStore, 'get' | 'all'>, selfId: string): WriterRoster {
  // No durable catalog (an offline store that never installed it): nobody else is published, so there is no roster.
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_catalog'")) return [];
  const doc = castTablesExist(store) ? latestPublication(store)?.doc : undefined;
  return publishedWebCharacters(store as BusinessStore)
    .filter((entry) => entry.characterId !== selfId)
    .map((entry) => {
      const card = doc?.characters.find((c) => c.characterId === entry.characterId);
      if (card)
        return {
          name: card.identity.names[0]!.text,
          aliases: othersAliases(card.identity.aliases).aliases,
          oneLiner: card.identity.oneLiner,
        };
      return {
        name: entry.presentation.displayName,
        aliases: [],
        oneLiner: [...entry.presentation.publicDescription].slice(0, ONE_LINER_FALLBACK).join(''),
      };
    });
}
