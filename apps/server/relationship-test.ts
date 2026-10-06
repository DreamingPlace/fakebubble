import { createHash } from 'node:crypto';
import type { CharacterScope, RelationshipPreset } from '../../packages/contracts/index.ts';
import type {
  RelationshipTestInput,
  RelationshipTestReceipt,
  RelationshipTestState,
  RelationshipTestValues,
} from '../../packages/contracts/playtest-social.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import { relationshipContext } from './relationships.ts';

const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
const publicScope = ({ worldId, conversationId, characterId }: CharacterScope) => ({
  worldId,
  conversationId,
  characterId,
});
export function relationshipTestVersion(store: Store, scope: CharacterScope) {
  return (
    store.get<{ revision: number }>(
      `SELECT revision FROM relationship_test_versions WHERE ${where} ORDER BY revision DESC LIMIT 1`,
      ...params(scope),
    )?.revision ?? 0
  );
}
export function relationshipTestValues(store: Store, scope: CharacterScope): RelationshipTestValues | null {
  const row = store.get<{ values_json: string | null }>(
    `SELECT values_json FROM relationship_test_versions WHERE ${where} ORDER BY revision DESC LIMIT 1`,
    ...params(scope),
  );
  return row?.values_json ? JSON.parse(row.values_json) : null;
}
function natural(store: Store, scope: CharacterScope) {
  const row = store.get<{ relationship: RelationshipPreset }>(
    `SELECT relationship FROM world_characters wc JOIN worlds w ON wc.world_id=w.id
    JOIN conversations c ON c.world_id=wc.world_id AND c.private_character_id=wc.character_id
    WHERE w.owner_id=? AND wc.world_id=? AND c.id=? AND wc.character_id=? AND c.kind='private'`,
    scope.playerId,
    ...params(scope),
  );
  ensure(row, 'NOT_FOUND');
  return relationshipContext(store, scope, row.relationship);
}
export function readRelationshipTest(store: Store, scope: CharacterScope): RelationshipTestState {
  const context = natural(store, scope);
  return {
    scope: publicScope(scope),
    revision: relationshipTestVersion(store, scope),
    values: relationshipTestValues(store, scope),
    naturalFamiliarity: context.familiarity,
    naturalOpenness: context.openness === 'comfortable' ? 80 : context.openness === 'settling' ? 45 : 10,
  };
}
/** Append a test override, not a relationship event. null restores the actual relationship ledger. */
export function saveRelationshipTest(
  store: Store,
  scope: CharacterScope,
  value: unknown,
  now: number,
): RelationshipTestReceipt {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'expectedRevision,requestId,values',
    'INVALID_TEST_RELATIONSHIP',
  );
  const input = value as RelationshipTestInput;
  ensure(
    typeof input.requestId === 'string' &&
      /^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) &&
      Number.isSafeInteger(input.expectedRevision) &&
      input.expectedRevision >= 0 &&
      input.expectedRevision < Number.MAX_SAFE_INTEGER,
    'INVALID_TEST_RELATIONSHIP',
  );
  ensure(
    input.values === null ||
      (typeof input.values === 'object' &&
        Object.keys(input.values).sort().join(',') === 'boundaryOpenness,familiarity' &&
        Object.values(input.values).every((n) => Number.isInteger(n) && n >= 0 && n <= 100)),
    'INVALID_TEST_RELATIONSHIP',
  );
  const values =
    input.values === null
      ? null
      : { familiarity: input.values.familiarity, boundaryOpenness: input.values.boundaryOpenness };
  const digest = createHash('sha256')
    .update(JSON.stringify([scope.conversationId, scope.characterId, input.expectedRevision, values]))
    .digest('hex');
  return store.transaction(() => {
    natural(store, scope);
    const previous = store.get<{ request_hash: string; revision: number }>(
      'SELECT request_hash,revision FROM relationship_test_versions WHERE world_id=? AND request_id=?',
      scope.worldId,
      input.requestId,
    );
    if (previous) {
      ensure(previous.request_hash === digest, 'IDEMPOTENCY_CONFLICT');
      return { scope: publicScope(scope), revision: previous.revision, duplicate: true };
    }
    ensure(relationshipTestVersion(store, scope) === input.expectedRevision, 'TEST_RELATIONSHIP_CONFLICT');
    const revision = input.expectedRevision + 1;
    store.run(
      'INSERT INTO relationship_test_versions VALUES (?,?,?,?,?,?,?,?)',
      ...params(scope),
      revision,
      values === null ? null : JSON.stringify(values),
      input.requestId,
      digest,
      now,
    );
    return { scope: publicScope(scope), revision, duplicate: false };
  });
}
