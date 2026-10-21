import type { CharacterScope } from '../../../packages/contracts/index.ts';
import type {
  CharacterAssociation,
  PlayerIntroductionContext,
  PlayerProfileState,
} from '../../../packages/contracts/profile.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { UserStore as Store } from '../platform/store-boundary.ts';

/** Internal accessors: callers must resolve the authenticated owner or authorize the job's scope first. */
export function playerProfile(store: Store, worldId: string): PlayerProfileState | null {
  const row = store.get<{ revision: number; profile_json: string; updated_at: number }>(
    { worldId },
    'SELECT * FROM player_profile_versions WHERE world_id=? ORDER BY revision DESC LIMIT 1',
    worldId,
  );
  return row ? { revision: row.revision, profile: JSON.parse(row.profile_json), updatedAt: row.updated_at } : null;
}
export function characterAssociation(store: Store, worldId: string, characterId: string): CharacterAssociation | null {
  const row = store.get<{ association_json: string }>(
    { worldId },
    'SELECT association_json FROM character_association_versions WHERE world_id=? AND character_id=? ORDER BY revision DESC LIMIT 1',
    worldId,
    characterId,
  );
  return row ? JSON.parse(row.association_json) : null;
}

export function playerContextKey(store: Store, scope: CharacterScope): string {
  return `${playerProfile(store, scope.worldId)?.revision ?? 0}:${characterAssociation(store, scope.worldId, scope.characterId)?.revision ?? 0}`;
}
export function playerIntroduction(store: Store, scope: CharacterScope): PlayerIntroductionContext | undefined {
  const conversation = store.get<{ kind: string }>(
    scope,
    `SELECT c.kind FROM conversations c JOIN participants p
    ON p.world_id=c.world_id AND p.conversation_id=c.id WHERE c.world_id=? AND c.id=? AND p.character_id=?`,
    scope.worldId,
    scope.conversationId,
    scope.characterId,
  );
  ensure(conversation, 'FORBIDDEN');
  const state = playerProfile(store, scope.worldId);
  const privateChat = conversation.kind === 'private';
  const association = privateChat ? characterAssociation(store, scope.worldId, scope.characterId) : null;
  if (!state && !association) return undefined;
  // A legacy world's test reset can choose an association before its owner fills the profile.
  return {
    source: 'player_setup',
    revision: state?.revision ?? 0,
    name: state?.profile.name ?? null,
    age: state?.profile.age ?? null,
    ...(state && privateChat && state.profile.sharedCharacterIds.includes(scope.characterId)
      ? {
          details: {
            city: state.profile.city,
            occupation: state.profile.occupation,
            familyBackground: state.profile.familyBackground,
          },
        }
      : {}),
    ...(association ? { association } : {}),
  };
}
