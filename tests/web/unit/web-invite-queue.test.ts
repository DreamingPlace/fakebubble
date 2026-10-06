import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/store.ts';
import { claimRetention } from '../../../apps/server/web-stage-queue.ts';

test('112 queue invite predicate preserves 110 account/guest rules and excludes invalid grants', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.exec(`
    CREATE TABLE web_principals(id TEXT PRIMARY KEY,player_id TEXT,world_id TEXT,kind TEXT);
    CREATE TABLE web_guest_retention(principal_id TEXT PRIMARY KEY,world_id TEXT,state TEXT,expires_at INTEGER);
    CREATE TABLE web_invite_grants(principal_id TEXT,player_id TEXT,world_id TEXT,revoked_at INTEGER,expires_at INTEGER);
    CREATE TABLE web_operations(id TEXT PRIMARY KEY,principal_id TEXT,world_id TEXT);
  `);
  const now = 1_700_000_000_000;
  const principal = (name: string, kind: string, state: string, expiry: number | null) => {
    store.run('INSERT INTO web_principals VALUES (?,?,?,?)', name, `player-${name}`, `world-${name}`, kind);
    store.run('INSERT INTO web_guest_retention VALUES (?,?,?,?)', name, `world-${name}`, state, expiry);
    store.run('INSERT INTO web_operations VALUES (?,?,?)', name, name, `world-${name}`);
  };
  principal('account', 'account', 'protected', null);
  principal('guest-live', 'guest', 'active', now + 1);
  principal('guest-expired', 'guest', 'active', now);
  for (const name of ['invite-live', 'invite-expired', 'invite-revoked', 'invite-wrong-scope'])
    principal(name, 'invite', 'protected', null);
  const grant = (name: string, expiresAt: number | null, revokedAt: number | null, playerId = `player-${name}`) =>
    store.run(
      'INSERT INTO web_invite_grants VALUES (?,?,?,?,?)',
      name,
      playerId,
      `world-${name}`,
      revokedAt,
      expiresAt,
    );
  grant('account', now - 1, now - 1, 'player-account'); // Historical grant must not gate account.
  grant('invite-live', null, null);
  grant('invite-expired', now, null);
  grant('invite-revoked', null, now - 1);
  grant('invite-wrong-scope', null, null, 'other-player');
  const selected = (schema: number) => {
    const retention = claimRetention(schema, now);
    return store
      .all<{ id: string }>(
        `SELECT o.id FROM web_operations o WHERE 1=1
      ${retention.sql} ORDER BY o.id`,
        ...retention.args,
      )
      .map((row) => row.id);
  };
  assert.deepEqual(selected(110), ['account', 'guest-live']);
  assert.deepEqual(selected(111), ['account', 'guest-live', 'invite-live']);
  assert.deepEqual(selected(112), selected(111));
  assert.deepEqual(claimRetention(110, now).args, [now]);
  assert.deepEqual(claimRetention(112, now).args, [now, now]);
});
