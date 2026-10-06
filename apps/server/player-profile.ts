import { createHash } from 'node:crypto';
import type { CharacterScope, PlayerContext, RelationshipPreset } from '../../packages/contracts/index.ts';
import { ASSOCIATIONS } from '../../packages/contracts/profile.ts';
import type {
  Association,
  AssociationSelection,
  CharacterAssociation,
  PlayerIntroductionContext,
  PlayerProfile,
  PlayerProfileReceipt,
  PlayerProfileState,
} from '../../packages/contracts/profile.ts';
import { associationBaseline } from '../../packages/domain/association.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore as Store } from './store-contract.ts';

function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      fields.every((key) => Object.hasOwn(value, key)),
    'INVALID_PROFILE',
  );
}
function identifier(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value), 'INVALID_PROFILE');
}
export function validateAssociation(value: unknown): asserts value is Association {
  ensure(typeof value === 'string' && ASSOCIATIONS.includes(value as Association), 'INVALID_ASSOCIATION');
}
export function validatedProfile(value: unknown): PlayerProfile {
  exact(value, ['name', 'age', 'city', 'occupation', 'familyBackground', 'sharedCharacterIds']);
  const text = (key: string, maximum: number, required = false) => {
    const field = value[key];
    ensure(
      typeof field === 'string' &&
        field.length <= maximum &&
        (!required || field.trim().length > 0) &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(field),
      'INVALID_PROFILE',
    );
    return field.trim();
  };
  ensure(
    value.age === null || (Number.isSafeInteger(value.age) && Number(value.age) >= 1 && Number(value.age) <= 120),
    'INVALID_PROFILE_AGE',
  );
  ensure(Array.isArray(value.sharedCharacterIds) && value.sharedCharacterIds.length <= 256, 'INVALID_PROFILE');
  value.sharedCharacterIds.forEach(identifier);
  ensure(new Set(value.sharedCharacterIds).size === value.sharedCharacterIds.length, 'INVALID_PROFILE');
  return {
    name: text('name', 40, true),
    age: value.age as number | null,
    city: text('city', 80),
    occupation: text('occupation', 120),
    familyBackground: text('familyBackground', 1600),
    sharedCharacterIds: [...value.sharedCharacterIds].sort(),
  };
}
function selections(value: unknown): AssociationSelection[] {
  ensure(Array.isArray(value) && value.length <= 256, 'INVALID_ASSOCIATION');
  const result = value
    .map((item) => {
      exact(item, ['characterId', 'association']);
      identifier(item.characterId);
      validateAssociation(item.association);
      return { characterId: item.characterId, association: item.association };
    })
    .sort((a, b) => a.characterId.localeCompare(b.characterId));
  ensure(new Set(result.map((item) => item.characterId)).size === result.length, 'INVALID_ASSOCIATION');
  return result;
}

/** Internal accessors: callers must resolve the authenticated owner or authorize the job's scope first. */
export function playerProfile(store: Store, worldId: string): PlayerProfileState | null {
  const row = store.get<{ revision: number; profile_json: string; updated_at: number }>(
    'SELECT * FROM player_profile_versions WHERE world_id=? ORDER BY revision DESC LIMIT 1',
    worldId,
  );
  return row ? { revision: row.revision, profile: JSON.parse(row.profile_json), updatedAt: row.updated_at } : null;
}
export function characterAssociation(store: Store, worldId: string, characterId: string): CharacterAssociation | null {
  const row = store.get<{ association_json: string }>(
    'SELECT association_json FROM character_association_versions WHERE world_id=? AND character_id=? ORDER BY revision DESC LIMIT 1',
    worldId,
    characterId,
  );
  return row ? JSON.parse(row.association_json) : null;
}
export function initializeAssociation(
  store: Store,
  worldId: string,
  characterId: string,
  association: Association,
  now: number,
) {
  validateAssociation(association);
  const current = characterAssociation(store, worldId, characterId);
  const row = store.get<{ relationship: RelationshipPreset }>(
    'SELECT relationship FROM world_characters WHERE world_id=? AND character_id=?',
    worldId,
    characterId,
  );
  ensure(row, 'INVALID_ASSOCIATION');
  const value: CharacterAssociation = {
    association,
    revision: (current?.revision ?? 0) + 1,
    ...associationBaseline(row.relationship, association),
  };
  store.run(
    'INSERT INTO character_association_versions VALUES (?,?,?,?,?)',
    worldId,
    characterId,
    value.revision,
    JSON.stringify(value),
    now,
  );
  return value;
}
export function createPlayerProfile(
  store: Store,
  worldId: string,
  profile: PlayerProfile,
  associations: AssociationSelection[],
  now: number,
) {
  const ids = store
    .all<{ character_id: string }>('SELECT character_id FROM world_characters WHERE world_id=?', worldId)
    .map((row) => row.character_id);
  ensure(
    profile.sharedCharacterIds.every((id) => ids.includes(id)),
    'INVALID_PROFILE_VISIBILITY',
  );
  const missing = ids.filter((id) => !characterAssociation(store, worldId, id)).sort();
  ensure(
    JSON.stringify(associations.map((item) => item.characterId).sort()) === JSON.stringify(missing),
    'ASSOCIATION_SELECTIONS_REQUIRED',
  );
  for (const item of associations) initializeAssociation(store, worldId, item.characterId, item.association, now);
  const revision = (playerProfile(store, worldId)?.revision ?? 0) + 1;
  store.run('INSERT INTO player_profile_versions VALUES (?,?,?,?)', worldId, revision, JSON.stringify(profile), now);
  return revision;
}
export function savePlayerProfile(
  store: Store,
  context: PlayerContext,
  now: number,
  value: unknown,
): PlayerProfileReceipt {
  const hasAssociations = value !== null && typeof value === 'object' && Object.hasOwn(value, 'associations');
  exact(value, ['requestId', 'expectedRevision', 'profile', ...(hasAssociations ? ['associations'] : [])]);
  identifier(value.requestId);
  ensure(Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 0, 'INVALID_PROFILE');
  const profile = validatedProfile(value.profile);
  const associations = hasAssociations ? selections(value.associations) : [];
  const hash = createHash('sha256')
    .update(JSON.stringify([value.expectedRevision, profile, associations]))
    .digest('hex');
  return store.transaction(() => {
    ensure(store.get('SELECT 1 FROM worlds WHERE id=? AND owner_id=?', context.worldId, context.playerId), 'FORBIDDEN');
    const previous = store.get<{ request_hash: string; revision: number; updated_at: number }>(
      `SELECT r.request_hash,r.revision,v.updated_at FROM player_profile_requests r JOIN player_profile_versions v
       ON v.world_id=r.world_id AND v.revision=r.revision WHERE r.world_id=? AND r.request_id=?`,
      context.worldId,
      value.requestId as string,
    );
    if (previous) {
      ensure(previous.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
      return { worldId: context.worldId, revision: previous.revision, updatedAt: previous.updated_at, duplicate: true };
    }
    ensure(
      (playerProfile(store, context.worldId)?.revision ?? 0) === value.expectedRevision,
      'PROFILE_REVISION_CONFLICT',
    );
    const revision = createPlayerProfile(store, context.worldId, profile, associations, now);
    store.run(
      'INSERT INTO player_profile_requests VALUES (?,?,?,?)',
      context.worldId,
      value.requestId as string,
      hash,
      revision,
    );
    return { worldId: context.worldId, revision, updatedAt: now, duplicate: false };
  });
}

export function playerContextKey(store: Store, scope: CharacterScope): string {
  return `${playerProfile(store, scope.worldId)?.revision ?? 0}:${characterAssociation(store, scope.worldId, scope.characterId)?.revision ?? 0}`;
}
export function playerIntroduction(store: Store, scope: CharacterScope): PlayerIntroductionContext | undefined {
  const conversation = store.get<{ kind: string }>(
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
