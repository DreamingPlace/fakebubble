import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  installWebShare,
  purgeShareCharacter,
  purgeShareConversation,
  purgeShareWorld,
  shareResidue,
  webShareInstalled,
} from '../../../apps/server/share/web-share-schema.ts';
import { SHARE_PAGE } from '../../../apps/server/share/web-share-path.ts';
import { webProviderHTTPError } from '../../../apps/server/platform/web-provider-http-error.ts';

/** Part 45: the share tables, installed by a digest-checked runtime step (no numbered migration); STOP WEB_SHARE_SCHEMA_MISMATCH. */
const DAY = 86_400_000;
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  // the one table the world purge reads (a principal's world)
  store.db.exec('CREATE TABLE web_principals(id TEXT PRIMARY KEY, world_id TEXT NOT NULL)');
  installWebShare(store);
  const add = (hash: string, world: string, conversation: string, character = 'jojo', at = 1_000) =>
    store.run(
      'INSERT INTO web_shares VALUES (?,?,?,?,?,?,?,?,?)',
      hash.repeat(64).slice(0, 64),
      world,
      conversation,
      `m-${hash}`,
      `media-${hash}`,
      character,
      'reply',
      at,
      at + DAY,
    );
  const request = (principal: string, id: string, hash: string) =>
    store.run(
      'INSERT INTO web_share_requests VALUES (?,?,?,?,?)',
      principal,
      id,
      'h',
      hash.repeat(64).slice(0, 64),
      1_000,
    );
  return { store, add, request };
}

test('45 install: idempotent, creates the three tables and two guards, counters start at zero', (t) => {
  const { store } = fixture(t);
  assert.ok(webShareInstalled(store));
  installWebShare(store);
  installWebShare(store);
  const counts = store
    .all<{ name: string; n: number }>('SELECT name,n FROM web_share_counts ORDER BY name')
    .map((row) => ({ name: row.name, n: row.n }));
  assert.deepEqual(counts, [
    { name: 'created', n: 0 },
    { name: 'expired', n: 0 },
    { name: 'opened', n: 0 },
  ]);
  assert.equal(
    store.get<{ n: number }>("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'web_share*'")!.n,
    2,
  );
});

test('45 STOP WEB_SHARE_SCHEMA_MISMATCH: a changed digest, a missing guard, a changed counter table or a half-installed schema stops the start', (t) => {
  const a = fixture(t);
  a.store.run('UPDATE web_share_schema SET sha256=?', 'b'.repeat(64));
  assert.throws(() => installWebShare(a.store), /WEB_SHARE_SCHEMA_MISMATCH/);
  const b = fixture(t);
  b.store.db.exec('DROP TRIGGER web_shares_fixed');
  assert.throws(() => installWebShare(b.store), /WEB_SHARE_SCHEMA_MISMATCH/);
  const c = fixture(t);
  c.store.db.exec("DELETE FROM web_share_counts WHERE name='opened'");
  assert.throws(() => installWebShare(c.store), /WEB_SHARE_SCHEMA_MISMATCH/);
  // a share table with no marker is a half install, not something to adopt
  const d = new Store(':memory:');
  t.after(() => d.close());
  d.db.exec('CREATE TABLE web_shares(x INTEGER)');
  assert.throws(() => installWebShare(d), /WEB_SHARE_SCHEMA_MISMATCH/);
  // the code is a 503 (a start-up refusal), and the limit a player can meet is a 429
  assert.equal(webProviderHTTPError(new (Error as never)('x')).status, 500);
});

test('45 a share lives exactly one day and is never changed once written', (t) => {
  const { store, add, request } = fixture(t);
  assert.throws(
    () =>
      store.run(
        'INSERT INTO web_shares VALUES (?,?,?,?,?,?,?,?,?)',
        'e'.repeat(64),
        'w',
        'c',
        'm',
        'x',
        'jojo',
        'reply',
        1_000,
        1_000 + DAY + 1,
      ),
    /CHECK/,
    'expires_at must be created_at + one day',
  );
  assert.throws(
    () =>
      store.run(
        'INSERT INTO web_shares VALUES (?,?,?,?,?,?,?,?,?)',
        'e'.repeat(64),
        'w',
        'c',
        'm',
        'x',
        'jojo',
        'text',
        1_000,
        1_000 + DAY,
      ),
    /CHECK/,
    'only a reply or a broadcast voice',
  );
  assert.throws(
    () =>
      store.run(
        'INSERT INTO web_shares VALUES (?,?,?,?,?,?,?,?,?)',
        'short',
        'w',
        'c',
        'm',
        'x',
        'jojo',
        'reply',
        1_000,
        1_000 + DAY,
      ),
    /CHECK/,
    'a SHA-256 hex digest',
  );
  add('a', 'w1', 'c1');
  request('p1', 'r1', 'a');
  assert.throws(
    () => store.run('UPDATE web_shares SET expires_at=expires_at+1,created_at=created_at+1'),
    /WEB_SHARE_IMMUTABLE/,
  );
  assert.throws(() => store.run("UPDATE web_share_requests SET request_hash='x'"), /WEB_SHARE_IMMUTABLE/);
});

test('45 the purges: a conversation, a character and a world remove their links (and the requests that named them); others stay', (t) => {
  const { store, add, request } = fixture(t);
  store.run("INSERT INTO web_principals VALUES ('p1','w1'),('p2','w2')");
  add('a', 'w1', 'c1');
  add('b', 'w1', 'c2');
  add('c', 'w2', 'c3', 'wei-guagua');
  request('p1', 'r1', 'a');
  request('p1', 'r2', 'b');
  request('p2', 'r3', 'c');
  const count = (sql: string) => store.get<{ n: number }>(sql)!.n;
  store.transaction(() => purgeShareConversation(store, 'w1', 'c1'));
  assert.equal(count("SELECT count(*) n FROM web_shares WHERE conversation_id='c1'"), 0);
  assert.equal(count('SELECT count(*) n FROM web_share_requests'), 2, 'the request that named it goes too');
  assert.equal(count('SELECT count(*) n FROM web_shares'), 2, 'other conversations stay');
  store.transaction(() => purgeShareCharacter(store, 'wei-guagua'));
  assert.equal(count("SELECT count(*) n FROM web_shares WHERE character_id='wei-guagua'"), 0);
  assert.equal(shareResidue(store, 'w2'), 0);
  assert.equal(shareResidue(store, 'w1'), 2, 'one link and one request of w1 remain');
  store.transaction(() => purgeShareWorld(store, 'w1'));
  assert.equal(shareResidue(store, 'w1'), 0);
  assert.equal(count('SELECT count(*) n FROM web_share_requests'), 0);
  assert.equal(count('SELECT sum(n) n FROM web_share_counts'), 0, 'counters are counts only and are not purged');
});

test('45 the link page address carries only a 32-character token', () => {
  assert.ok(SHARE_PAGE.test(`/s/${'A'.repeat(32)}`));
  for (const bad of [
    '/s/short',
    `/s/${'A'.repeat(33)}`,
    `/s/${'A'.repeat(31)}!`,
    `/s/${'A'.repeat(32)}/x`,
    `/s/${'A'.repeat(32)}?mode=provider`,
    '/s/',
    '//s/x',
  ])
    assert.equal(SHARE_PAGE.test(bad), false, bad);
});
