import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebRetentionCleaner } from '../../../apps/server/admission/web-retention-cleaner.ts';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

/**
 * The Node retention cleaner (synthetic local mode) deletes embedding rows when the tables exist. It runs on a schema-110
 * database here, so the 116 tables are added by hand: the cleaner decides by table existence, not by schema number.
 */
test("Node guest retention removes a guest's embeddings and embedding calls and keeps another world's", (t) => {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-embed-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WebStore(root, { create: false, instanceId: initialized.instanceId, dataLifecycleTest: true });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  const config = readLocalConfig(root);
  store.migrateIdentity(config.recoveryEpoch);
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  store.migrateVerticalCandidate();
  store.migrateLocalTransport();
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'synthetic-embed',
    1,
    JSON.stringify({
      id: 'synthetic-embed',
      name: '合成',
      version: 1,
      fictional: true,
      persona: 'only for local offline retention test',
      schedule: defaultSchedule(),
    }),
  );
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin: config.origin,
    cookieName: config.cookieName,
    clock,
    keys: {
      keyId: 'embed',
      sealKey: Buffer.from(config.sealKey, 'base64url'),
      requestKey: Buffer.from(config.requestKey, 'base64url'),
    },
  });
  const admission = new WebAdmission(store, clock, randomUUID);
  const worlds = [0, 1].map((i) => {
    const guest = identity.bootstrap();
    const scope = identity.authenticate(guest.issuedToken!);
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic-embed');
    const admitted = admission.admit({
      principalId: guest.principalId,
      requestId: `request-${i}`,
      characterId: 'synthetic-embed',
      text: 'synthetic only',
      ipHash: `${i}`.repeat(64),
    });
    return { guest, scope, admitted };
  });
  store.migrateDataLifecycle(clock);
  // The 116 tables, exactly as the provider migration creates them.
  const sql = readFileSync(
    new URL('../../../apps/server/web-migrations/116_memory_embeddings.sql', import.meta.url),
    'utf8',
  );
  store.db.exec(sql);
  for (const { scope, admitted } of worlds) {
    store.run(
      "INSERT INTO memory_topics VALUES (?,?,?,'猫','long',2,?,?)",
      scope.world_id,
      admitted.conversationId,
      'synthetic-embed',
      now,
      now,
    );
    store.run(
      "INSERT INTO memory_embeddings VALUES (?,?,?,'猫','m',4,?,?,1,'ready',?)",
      scope.world_id,
      admitted.conversationId,
      'synthetic-embed',
      Buffer.alloc(16),
      'a'.repeat(64),
      now,
    );
    store.run(
      `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,model,texts,max_units,
      price_micros_per_million,held_micros,state,sent_at,lease_expires_at,created_at)
      VALUES (?,'index',?,?,?,'m',1,10,11800,1,'unknown',?,?,?)`,
      `attempt-${scope.world_id}`,
      scope.world_id,
      admitted.conversationId,
      'synthetic-embed',
      now,
      now,
      now,
    );
  }
  const count = (table: string, world: string) =>
    store.get<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE world_id=?`, world)!.n;
  const [first, second] = worlds;
  // Both worlds are guests; expire the first one only.
  now += 2 * 60 * 60_000 + 1;
  const cleaner = new WebRetentionCleaner(store, clock);
  cleaner.markExpired(first!.guest.principalId);
  cleaner.clearDatabase(first!.guest.principalId);
  for (const table of ['memory_embeddings', 'web_embed_attempts', 'memory_topics'])
    assert.equal(count(table, first!.scope.world_id), 0, `${table} of the purged guest`);
  for (const table of ['memory_embeddings', 'web_embed_attempts', 'memory_topics'])
    assert.equal(count(table, second!.scope.world_id), 1, `${table} of the other guest is untouched`);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
});
