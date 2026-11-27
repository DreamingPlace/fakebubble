import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebProviderApplication } from '../../../apps/server/generation/web-provider-application.ts';
import { initProviderInstance, localRuntime } from '../../../apps/server/platform/web-local-config.ts';
import { installWebFeedback } from '../../../apps/server/turns/web-feedback-schema.ts';
import { installWebTurns } from '../../../apps/server/turns/web-turn-schema.ts';
import { migrateProvider, openProviderStore } from '../../../scripts/web-provider.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';

/**
 * P0 (Part 36 hotfix): `installWebTurns` guarded its fresh install with `name GLOB 'web_turn*'`, and production already held
 * `web_turnstile_counts` (made by installWebAdminActions on every earlier start; tests and local runs never had it before the step ran).
 * The guard matched it and stopped EVERY start with WEB_TURN_SCHEMA_MISMATCH (business 503). The pattern is `web_turn_*` now.
 */
const key = (n: number) => Buffer.alloc(32, n).toString('base64url');

test('installWebTurns and installWebFeedback succeed on a database that already has web_turnstile_counts; a second start passes the digest check', async (t) => {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `provider-glob-${randomUUID().slice(0, 12)}`);
  initProviderInstance(root);
  migrateProvider(root, syntheticSelection());
  const { store } = openProviderStore(root);
  t.after(() => store.close());
  // what an older version's start left behind: the Turnstile counters (and a row), and none of the turn tables
  installWebAdminActions(store);
  store.run("INSERT INTO web_turnstile_counts(day,outcome,n) VALUES ('2026-11-20','failed',3)");
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE name='web_turnstile_counts'"));
  assert.equal(store.get("SELECT 1 FROM sqlite_master WHERE name='web_turn_schema'"), undefined);
  installWebTurns(store);
  installWebFeedback(store);
  // the second start: the schema table exists, the digest and the trigger count are checked
  installWebTurns(store);
  installWebFeedback(store);
  assert.equal(
    store.get<{ n: number }>('SELECT n FROM web_turnstile_counts')!.n,
    3,
    'the Turnstile counters are untouched',
  );
});

test('a business start with Turnstile on, through every runtime step in order, on a production-shaped database; and again after a restart', async (t) => {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `provider-start-${randomUUID().slice(0, 12)}`);
  initProviderInstance(root);
  migrateProvider(root, syntheticSelection());
  const { store } = openProviderStore(root);
  t.after(() => store.close());
  const clock = { now: () => Date.now() };
  const config = () => ({
    mode: 'provider-local' as const,
    origin: 'https://fixture.invalid',
    cookieName: '__Host-fixture',
    instanceId: store.instanceId,
    recoveryEpoch: store.get<{ recovery_epoch: string }>('SELECT recovery_epoch FROM web_instance WHERE singleton=1')!
      .recovery_epoch,
    ipKey: key(1),
    requestKey: key(2),
    sealKey: key(3),
    cursorKey: key(4),
  });
  const players = { turnstileSiteKey: '1x00000000000000000000AA' };
  // A start of the application: every runtime step in its own order, Turnstile on.
  const start = () => new WebProviderApplication(store, clock, config(), undefined, players);
  start().system; // (the first start makes web_turnstile_counts, as every start since Part 22b has)
  store.run("INSERT INTO web_turnstile_counts(day,outcome,n) VALUES ('2026-11-20','unavailable',2)");
  // Production before Part 36: everything above, and none of the turn or feedback objects.
  for (const type of ['trigger', 'index', 'table'])
    for (const row of store.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type=? AND (name GLOB 'web_turn_*' OR name GLOB 'web_feedback*') ORDER BY name",
      type,
    ))
      store.run(`DROP ${type.toUpperCase()} ${row.name}`);
  assert.equal(
    store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_turn_*' OR name GLOB 'web_feedback*'"),
    undefined,
  );
  assert.ok(
    store.get("SELECT 1 FROM sqlite_master WHERE name='web_turnstile_counts'"),
    'the Turnstile counters are there',
  );
  // the first start of the new version on that database (this stopped with WEB_TURN_SCHEMA_MISMATCH before the fix)
  const first = start();
  assert.ok(first.turns && first.feedback, 'the turn and feedback services started');
  for (const table of [
    'web_turn_schema',
    'web_turn_bubbles',
    'web_feedback_schema',
    'web_feedback',
    'web_turnstile_counts',
  ])
    assert.ok(store.get('SELECT 1 FROM sqlite_master WHERE name=?', table), table);
  // a restart: the digest checks of every step run again over the existing tables
  assert.ok(start().turns);
  assert.equal(store.get<{ n: number }>("SELECT n FROM web_turnstile_counts WHERE outcome='unavailable'")!.n, 2);
});
