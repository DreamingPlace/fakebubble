import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { contentHash } from './admin-content-hash.ts';
import { publishedWebCharacters } from './web-character-catalog.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import { identifier, keys, record } from './template-validation.ts';
import { CATALOG_MAX } from '../../../packages/contracts/web-provider.ts';

/**
 * Part 24l: 下线 / 重新上线 and the per-admin sidebar order. NO numbered migration: installed idempotently and digest-checked at
 * start, like the 24j profile step. The names do not start with `web_character_` (that prefix is reserved by the catalog's own
 * first-install check). Neither table holds a player, world, conversation or operation id.
 *
 *   web_availability_requests   one row per 下线 / 重新上线 request: the idempotency record (request id + hash) and the answer.
 *                               Append-only in practice (nothing here updates or deletes it).
 *   web_admin_character_order   each admin's own order of characters in the workbench sidebar, one rank per (member, character).
 *                               Never read by the home page, the player or another admin.
 */
const statements = [
  `CREATE TABLE web_availability_requests(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,
    character_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('offline','online')),version INTEGER NOT NULL,
    position INTEGER,member_id TEXT NOT NULL REFERENCES web_admin_members(id),created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_admin_character_order(member_id TEXT NOT NULL REFERENCES web_admin_members(id),
    character_id TEXT NOT NULL,rank INTEGER NOT NULL CHECK(rank>=0),PRIMARY KEY(member_id,character_id)) STRICT`,
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');

export function installWebAvailability(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_availability_schema'")) {
      ensure(
        !store.get(
          "SELECT 1 FROM sqlite_master WHERE name IN ('web_availability_requests','web_admin_character_order')",
        ),
        'WEB_AVAILABILITY_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_availability_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_availability_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_availability_schema');
    ensure(rows.length === 1 && rows[0]!.sha256 === digest, 'WEB_AVAILABILITY_SCHEMA_MISMATCH');
  });
}
export const availabilityInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_availability_schema'");

type Request = {
  character_id: string;
  action: 'offline' | 'online';
  version: number;
  position: number | null;
  created_at: number;
  request_hash: string;
};
const dto = (row: Request) => ({
  characterId: row.character_id,
  action: row.action,
  version: row.version,
  position: row.position,
  at: row.created_at,
});

/** The same fence as a publication: no unfinished player task of this character. Nothing is cancelled, resent or repriced. */
const noInFlight = (store: BusinessStore, id: string) =>
  ensure(
    !store.get(
      `SELECT 1 FROM web_operations WHERE character_id=? AND status NOT IN ('published','cancelled','failed') LIMIT 1`,
      id,
    ),
    'CHARACTER_PUBLICATION_BUSY',
  );

/**
 * 下线 (action 'offline') and 重新上线 ('online'). One synchronous transaction; the caller has checked that the actor is the owner.
 * 下线 removes the catalog row and nothing else; 重新上线 inserts it again at the live version, in the first free position.
 * Idempotent per requestId; one web_admin_audit row each. No provider call, no player content read or written.
 */
export function setWebCharacterAvailability(
  store: BusinessStore,
  now: number,
  actor: { memberId: string },
  id: string,
  action: 'offline' | 'online',
  input: unknown,
) {
  identifier(id);
  record(input);
  keys(input, ['requestId', 'liveVersion']);
  identifier(input.requestId);
  ensure(Number.isSafeInteger(input.liveVersion) && Number(input.liveVersion) > 0, 'INVALID_ADMIN_REQUEST');
  ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
  ensure(availabilityInstalled(store), 'AVAILABILITY_UNAVAILABLE');
  const requestId = input.requestId,
    requestHash = contentHash([actor.memberId, id, action, input]);
  return store.transaction(() => {
    ensure(!webCharacterDeleted(store, id), 'CHARACTER_DELETED');
    const prior = store.get<Request & { action: string }>(
      'SELECT * FROM web_availability_requests WHERE request_id=?',
      requestId,
    );
    if (prior) {
      ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
      return dto(prior);
    }
    const template = store.get<{ version: number }>('SELECT version FROM character_templates WHERE id=?', id);
    ensure(template, 'NOT_FOUND');
    const catalog = publishedWebCharacters(store),
      live = catalog.find((c) => c.characterId === id);
    // The dialog named this live version; if it moved meanwhile, nothing changes under a number nobody agreed to.
    ensure(template.version === input.liveVersion, 'LIVE_VERSION_CONFLICT');
    let position: number | null = null;
    if (action === 'offline') {
      ensure(live, 'CHARACTER_OFFLINE');
      noInFlight(store, id);
      store.run('DELETE FROM web_character_catalog WHERE character_id=?', id);
    } else {
      ensure(!live, 'CHARACTER_ONLINE');
      noInFlight(store, id);
      const free = Array.from({ length: CATALOG_MAX }, (_, i) => i).find((i) => !catalog.some((c) => c.position === i));
      ensure(free !== undefined, 'CHARACTER_CATALOG_FULL');
      position = free;
      store.run('INSERT INTO web_character_catalog VALUES (?,?,?)', id, template.version, position);
      // The live version's snapshot must still match its template (the catalog read verifies the hash); otherwise nothing is put back.
      ensure(
        publishedWebCharacters(store).some((c) => c.characterId === id && c.version === template.version),
        'WEB_PROVIDER_CATALOG_INVALID',
      );
    }
    store.run(
      'INSERT INTO web_availability_requests VALUES (?,?,?,?,?,?,?,?)',
      requestId,
      requestHash,
      id,
      action,
      template.version,
      position,
      actor.memberId,
      now,
    );
    store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actor.memberId,
      `character-${action}:v${template.version}`,
      id,
      now,
    );
    return dto(store.get<Request>('SELECT * FROM web_availability_requests WHERE request_id=?', requestId)!);
  });
}

export type SidebarGroup = 'live' | 'draft' | 'offline';
export const SIDEBAR_GROUPS: readonly SidebarGroup[] = ['live', 'draft', 'offline'];

/**
 * The saved order of one admin: character ids, first to last. A character with no rank (never ordered, or new) is NOT in this list;
 * callers put it after every ranked one of its group.
 */
export function savedOrder(store: BusinessStore, memberId: string): string[] {
  if (!availabilityInstalled(store)) return [];
  return store
    .all<{ character_id: string }>(
      'SELECT character_id FROM web_admin_character_order WHERE member_id=? ORDER BY rank,character_id',
      memberId,
    )
    .map((row) => row.character_id);
}

/** Sorts one group's members: ranked ones in the admin's order, then the unranked ones in `fallback` order (the group's default). */
export function orderGroup(members: readonly string[], saved: readonly string[]): string[] {
  const rank = new Map(saved.map((id, at) => [id, at] as const));
  const ranked = members.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...ranked, ...members.filter((id) => !rank.has(id))];
}

/**
 * Saves one admin's drag within one group. `visible` is every character that admin may see, each with its CURRENT group (server
 * truth); `ids` must be exactly the members of `group`. One order is kept per admin across all groups, so a character that changes
 * group keeps its relative place: the dragged group's members take, in the new order, the places its members held before.
 */
export function saveGroupOrder(
  store: BusinessStore,
  memberId: string,
  visible: readonly { id: string; group: SidebarGroup }[],
  group: unknown,
  ids: unknown,
) {
  ensure(availabilityInstalled(store), 'AVAILABILITY_UNAVAILABLE');
  ensure(typeof group === 'string' && (SIDEBAR_GROUPS as readonly string[]).includes(group), 'INVALID_ADMIN_REQUEST');
  ensure(Array.isArray(ids) && ids.length <= 200 && ids.every((id) => typeof id === 'string'), 'INVALID_ADMIN_REQUEST');
  const members = visible.filter((c) => c.group === group).map((c) => c.id);
  ensure(
    new Set(ids).size === ids.length && ids.length === members.length && members.every((id) => ids.includes(id)),
    'CHARACTER_ORDER_CONFLICT',
  );
  return store.transaction(() => {
    const saved = savedOrder(store, memberId);
    const all = visible.map((c) => c.id);
    // One list over every visible character: the saved ones first (their order), the rest after, in the order given.
    const known = new Set(all);
    const full = [...saved.filter((id) => known.has(id)), ...all.filter((id) => !saved.includes(id))];
    const inGroup = new Set(members);
    const next = [...(ids as string[])];
    const merged = full.map((id) => (inGroup.has(id) ? next.shift()! : id));
    store.run('DELETE FROM web_admin_character_order WHERE member_id=?', memberId);
    merged.forEach((id, rank) => store.run('INSERT INTO web_admin_character_order VALUES (?,?,?)', memberId, id, rank));
    return { group, ids: ids as string[] };
  });
}

/** A character leaves every admin's order when it is deleted. */
export function clearCharacterOrder(store: BusinessStore, characterId: string) {
  if (!availabilityInstalled(store)) return;
  store.run('DELETE FROM web_admin_character_order WHERE character_id=?', characterId);
}
