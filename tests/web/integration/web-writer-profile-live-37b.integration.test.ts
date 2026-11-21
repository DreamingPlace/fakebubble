import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { VoiceModelBinding } from '../../../packages/contracts/audio.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import {
  framePinsMatch,
  freezeWebV7Request,
  readWebV7Request,
} from '../../../apps/server/generation/web-v7-request.ts';
import { installWriterSetting, readWriter, writeWriter } from '../../../apps/server/generation/web-writer-setting.ts';
import { writerDraftMessages, writerPins } from '../../../apps/server/generation/writer-v8.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { WebCloudTextGenerator } from '../../../apps/server/cloudflare/web-generators.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { schema128, seedFreezeScenario, FREEZE_NOW } from '../fixtures/cast-freeze.ts';
import { isWriterChoice, WRITER_CHOICES } from '../../../packages/contracts/web-writer.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const STEP_ONE = `CREATE TABLE web_writer_setting(id INTEGER PRIMARY KEY CHECK(id=1),writer TEXT NOT NULL CHECK(writer IN ('v7','v8')),
    changed_by TEXT NOT NULL,changed_at INTEGER NOT NULL) STRICT`;
/** What Part 37a installed and recorded (taken from main before this Part). */
const DIGEST_ONE = '04292d5abb2a3b907a9e48fff5e367af6e1d63c8592cbe0c1abffc41e2e255ff';

const fresh = (t: TestContext) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store, 'character', 's2.1-pro' as VoiceModelBinding);
  return store;
};

test('step one is exactly what Part 37a recorded (its digest is the first row, forever)', () => {
  assert.equal(sha(STEP_ONE), DIGEST_ONE);
});

test('an authority that ran step one takes step two: the value stays, 新+档案 becomes writable, expected-migrations untouched', (t) => {
  const store = fresh(t);
  // the state Part 37a left: the v1 table and the v1 marker
  store.run(STEP_ONE);
  store.run('CREATE TABLE web_writer_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT');
  store.run('INSERT INTO web_writer_schema VALUES (1,?)', DIGEST_ONE);
  writeWriter(store, FREEZE_NOW, 'owner', 'v8');
  assert.throws(() => writeWriter(store, FREEZE_NOW, 'owner', 'v8p'), /CHECK|constraint/i);
  installWriterSetting(store);
  assert.equal(readWriter(store), 'v8', 'the choice survives the rebuild');
  const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_writer_schema ORDER BY version');
  assert.deepEqual(
    rows.map((row) => row.version),
    [1, 2],
  );
  assert.equal(rows[0]!.sha256, DIGEST_ONE);
  writeWriter(store, FREEZE_NOW, 'owner', 'v8p');
  assert.equal(readWriter(store), 'v8p');
  // idempotent, and no leftovers of the rebuild
  installWriterSetting(store);
  installWriterSetting(store);
  assert.equal(
    store.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name GLOB 'web_writer_*_v1'")?.n,
    0,
  );
  assert.equal(readWriter(store), 'v8p');
  // any other state stops the start
  store.run('UPDATE web_writer_schema SET sha256=? WHERE version=2', 'f'.repeat(64));
  assert.throws(() => installWriterSetting(store), { code: 'WEB_WRITER_SCHEMA_MISMATCH' });
});

test('a step-one marker with another digest, and a foreign table, still stop the start', (t) => {
  const store = fresh(t);
  store.run(STEP_ONE);
  store.run('CREATE TABLE web_writer_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT');
  store.run('INSERT INTO web_writer_schema VALUES (1,?)', 'a'.repeat(64));
  assert.throws(() => installWriterSetting(store), { code: 'WEB_WRITER_SCHEMA_MISMATCH' });
  const other = fresh(t);
  other.run('CREATE TABLE web_writer_other(x INTEGER)');
  assert.throws(() => installWriterSetting(other), { code: 'WEB_WRITER_SCHEMA_MISMATCH' });
});

test('three choices: each is stored, read back, and a fourth is not a choice', (t) => {
  const store = fresh(t);
  installWriterSetting(store);
  assert.equal(readWriter(store), 'v7');
  for (const choice of ['v8', 'v8p', 'v7', 'v8p', 'v8'] as const) {
    writeWriter(store, FREEZE_NOW, 'owner', choice);
    assert.equal(readWriter(store), choice);
  }
  assert.deepEqual([...WRITER_CHOICES], ['v7', 'v8', 'v8p']);
  assert.equal(isWriterChoice('v9'), false);
  assert.throws(() => store.run("UPDATE web_writer_setting SET writer='v9'"), /CHECK|constraint/i);
});

const frozen = (store: ReturnType<typeof fresh>) => {
  freezeInputSnapshot(store as unknown as WebStore, 'operation', FREEZE_NOW);
  freezeWebV7Request(store as unknown as WebStore, 'operation', FREEZE_NOW);
  return readWebV7Request(store as unknown as WebStore, 'operation');
};

test('the live request per choice: 旧 and 新 freeze exactly what they did; 新+档案 adds writerProfile and its own pins', (t) => {
  const v7 = frozen(fresh(t));
  const a = fresh(t);
  installWriterSetting(a);
  writeWriter(a, FREEZE_NOW, 'owner', 'v8');
  const v8 = frozen(a);
  const b = fresh(t);
  installWriterSetting(b);
  writeWriter(b, FREEZE_NOW, 'owner', 'v8p');
  const profile = frozen(b);
  assert.equal(v7.request.writer, undefined);
  assert.equal(v7.request.writerProfile, undefined);
  assert.equal(v8.request.writer, 'v8');
  assert.ok(!('writerProfile' in v8.request), '新 gains no key');
  assert.equal(profile.request.writer, 'v8');
  assert.equal(profile.request.writerProfile, true);
  assert.equal(profile.request.relationship, undefined);
  // the pins: 新 the v8 ones, 新+档案 the profile ones (the 多轮预演 column's), and neither accepts the other's
  assert.deepEqual({ protocolDigest: v8.row.protocol_digest, promptDigest: v8.row.prompt_digest }, writerPins());
  assert.deepEqual(
    { protocolDigest: profile.row.protocol_digest, promptDigest: profile.row.prompt_digest },
    writerPins(true),
  );
  assert.equal(framePinsMatch(v8.row, profile.request), false);
  assert.equal(framePinsMatch(profile.row, v8.request), false);
  assert.equal(framePinsMatch(profile.row, profile.request), true);
  // a 新 request is the 新+档案 request without the one key (same everything else)
  const { writerProfile: _drop, ...rest } = profile.request;
  assert.deepEqual(JSON.parse(JSON.stringify(rest)), JSON.parse(JSON.stringify(v8.request)));
});

test('the live 新+档案 prompt is the 多轮预演 column path: same builder, same policy hash; 旧 / 新 policy hashes unchanged', (t) => {
  const b = fresh(t);
  installWriterSetting(b);
  writeWriter(b, FREEZE_NOW, 'owner', 'v8p');
  const { request } = frozen(b);
  const generator = new DeepSeekTextGenerator({ apiKey: 'offline-only', fetch: async () => new Response('{}') });
  assert.equal(generator.policyHashFor(request), generator.writerProfilePolicyHash);
  assert.equal(generator.policyHashFor({ writer: 'v8' }), generator.writerPolicyHash);
  assert.equal(generator.policyHashFor({}), generator.policyHash);
  assert.notEqual(generator.writerProfilePolicyHash, generator.writerPolicyHash);
  const cloud = new WebCloudTextGenerator({} as never);
  assert.equal(cloud.writerProfilePolicyHash, generator.writerProfilePolicyHash);
  assert.equal(cloud.writerPolicyHash, generator.writerPolicyHash);
  // the live request is built by the same function the rehearsal column's request goes through (writerDraftMessages)
  assert.ok(writerDraftMessages(request, 'deepseek')[0]!.content.length > 0);
});
