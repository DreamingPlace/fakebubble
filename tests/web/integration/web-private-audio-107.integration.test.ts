import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { WebSyntheticPrivateAudio, type PrivateAudioScope } from '../../../apps/server/web-private-audio.ts';
import { WebPrivateAudioFiles } from '../../../apps/server/web-private-audio-files.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';
import { tone } from '../../audio-fixtures.ts';

const base = 1_700_000_000_000;
const raceWorker = fileURLToPath(new URL('./web-private-audio-race-worker.mjs', import.meta.url));
const ip = (n: number) => n.toString(16).padStart(64, '0');

function fixture(t: test.TestContext, migrate = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-private-'));
  const root = join(parent, 'web'), instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  if (migrate) store.migrateSyntheticPrivateAudio();
  let now = base;
  const clock = { now: () => now };
  const admission = new WebAdmission(store, clock, randomUUID);
  const queue = new WebStageQueue(store, clock, randomUUID);
  const ledger = new WebDispatchLedger(store, clock);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', 'character', 1, '{"name":"synthetic"}');
  function guest(name: string) {
    const playerId = `player-${name}`, worldId = `world-${name}`, principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'UTC', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, 'character');
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return { principalId, playerId, worldId };
  }
  function complete(name = 'one', narrative = ['合成首片']) {
    const person = guest(name);
    const op = admission.admit({ principalId: person.principalId, requestId: `input-${name}`,
      characterId: 'character', text: `synthetic input ${name}`, ipHash: ip(name.length) });
    const coordinator = queue.acquireCoordinator('coordinator');
    const text = queue.claimText(coordinator, 'text')!;
    const snapshot = queue.inputSnapshot({ operation_id: text.operationId, principal_id: text.principalId,
      world_id: text.worldId, conversation_id: text.conversationId, character_id: text.characterId,
      input_message_id: text.inputMessageId });
    queue.completeText(text, { narrative, inputVersion: snapshot.input_digest,
      characterVersion: String(snapshot.template_version), templateVersion: snapshot.template_digest,
      voiceVersion: 'synthetic-voice', accessRevision: snapshot.access_revision, usage: {} });
    ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 2 });
    function finishNext() {
      const claim = queue.claimAudio(coordinator, 'audio')!;
      const key = ledger.reserve(claim, { phase: 'speech', ordinal: claim.ordinal!, provider: 'fake',
        providerRequestId: randomUUID() });
      ledger.markSent(claim, key);
      ledger.confirm(key, { outcome: 'succeeded', receipt: { synthetic: true }, usage: { calls: 1 } });
      const scope: PrivateAudioScope = { operationId: op.operationId, ordinal: claim.ordinal!,
        principalId: text.principalId, playerId: person.playerId, worldId: text.worldId,
        conversationId: text.conversationId, characterId: text.characterId, inputMessageId: text.inputMessageId };
      return { claim, key, scope };
    }
    return { op, coordinator, person, finishNext };
  }
  return { parent, root, instanceId, store, clock, admission, queue, ledger, guest, complete,
    advance: (ms: number) => { now += ms; }, now: () => now };
}

test('C-S3-005 A-WEB-007 persistent directory fsync failure must not attach during recovery', t => {
  const f = fixture(t), flow = f.complete(), { scope } = flow.finishNext();
  const service = new WebSyntheticPrivateAudio(f.store, f.clock);
  const original = fs.fsyncSync;
  let directoryCalls = 0;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) { directoryCalls++; throw new Error('C_INJECTED_DIRECTORY_EIO'); }
    return original(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => service.stage(scope, flow.coordinator, tone(250)), /C_INJECTED_DIRECTORY_EIO/);
    const row = f.store.get<{ state: string; media_id: string }>(
      'SELECT state,media_id FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
    assert.equal(row.state, 'preparing');
    assert.equal(existsSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), true);
    const before = directoryCalls;
    assert.ok(before >= 2);
    f.advance(30_000);
    const recovered = f.queue.acquireCoordinator('recovery');
    assert.throws(() => service.recover(scope, recovered), /C_INJECTED_DIRECTORY_EIO/);
    assert.equal(f.store.get<{ state: string }>(
      'SELECT state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)?.state, 'preparing');
    assert.ok(directoryCalls > before, 'recovery must retry the directory durability boundary');
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
});

test('C-S3-005 A-WEB-008 static symlinked Web parent is rejected without child directory creation', t => {
  const f = fixture(t), moved = join(f.parent, 'original-web'), foreign = join(f.parent, 'foreign');
  mkdirSync(foreign, { mode: 0o700 });
  renameSync(f.root, moved);
  symlinkSync(foreign, f.root);
  try {
    assert.throws(() => new WebPrivateAudioFiles(f.root), /WEB_PRIVATE_AUDIO_ROOT_UNSAFE/);
    assert.deepEqual(readdirSync(foreign), [], 'a rejected parent must remain unwritten');
  } finally {
    unlinkSync(f.root);
    renameSync(moved, f.root);
  }
});

test('C-S3-005 explicit 106→107 migration preserves old candidate/segment/receipt and keeps old asset eligibility zero', t => {
  const f = fixture(t, false), flow = f.complete('old'), { scope } = flow.finishNext();
  const another = f.guest('unknown');
  const unknown = f.admission.admit({ principalId: another.principalId, requestId: 'unknown',
    characterId: 'character', text: '未知回执输入', ipHash: ip(7) });
  const unknownText = f.queue.claimText(flow.coordinator, 'unknown-text')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const unknownKey = f.ledger.reserve(unknownText, { phase: 'draft', ordinal: -1, provider: 'fake',
    providerRequestId: 'unknown-request' });
  f.ledger.markSent(unknownText, unknownKey);
  f.ledger.terminate(flow.coordinator, f.ledger.fence(unknown.operationId), another.principalId, 'cancelled', 'cancel');
  const tables = ['web_operations', 'web_external_attempts', 'web_external_budgets',
    'web_input_snapshots', 'web_reviewed_candidates', 'web_synthetic_voice_segments',
    'web_ip_windows', 'web_principals', 'messages'];
  const before = Object.fromEntries(tables.map(table => [table, f.store.all<Record<string, unknown>>(
    `SELECT * FROM ${table} ORDER BY rowid`).map(row => ({ ...row }))]));
  const reopened106 = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  assert.equal(reopened106.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 106);
  reopened106.close();
  f.store.migrateSyntheticPrivateAudio();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 107);
  for (const table of tables) {
    const rows = f.store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`).map(row => ({ ...row }));
    const withoutEligibility = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'asset_eligible')));
    assert.deepEqual(withoutEligibility, before[table], table);
  }
  assert.equal(f.store.get<{ asset_eligible: number }>(
    'SELECT asset_eligible FROM web_reviewed_candidates WHERE operation_id=?', scope.operationId)?.asset_eligible, 0);
  assert.equal(f.store.get<{ asset_eligible: number }>(
    'SELECT asset_eligible FROM web_synthetic_voice_segments WHERE operation_id=?', scope.operationId)?.asset_eligible, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets')?.n, 0);
  assert.equal(f.store.get<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE stage='text'")?.reserved, 1);
  const service = new WebSyntheticPrivateAudio(f.store, f.clock);
  assert.throws(() => service.stage(scope, flow.coordinator, tone(250)), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets')?.n, 0);
});

test('C-S3-005 late migration DDL failure and foreign-key audit roll eligibility/schema back to 106', t => {
  const f = fixture(t, false), person = f.guest('migration');
  const operation = f.admission.admit({ principalId: person.principalId, requestId: 'input',
    characterId: 'character', text: '原输入', ipHash: ip(1) });
  f.store.run('CREATE TABLE web_private_audio_assets(collision INTEGER)');
  assert.throws(() => f.store.migrateSyntheticPrivateAudio(), /already exists/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 106);
  assert.equal(f.store.get("SELECT 1 FROM pragma_table_info('web_reviewed_candidates') WHERE name='asset_eligible'"), undefined);
  assert.equal(f.store.get("SELECT 1 FROM pragma_table_info('web_synthetic_voice_segments') WHERE name='asset_eligible'"), undefined);
  f.store.run('DROP TABLE web_private_audio_assets');
  const db = (f.store as unknown as { db: { exec(sql: string): void } }).db;
  db.exec('PRAGMA foreign_keys=OFF');
  f.store.run('UPDATE messages SET conversation_id=? WHERE id=?', 'orphan', operation.inputMessageId);
  assert.throws(() => f.store.migrateSyntheticPrivateAudio(), /WEB_PRIVATE_AUDIO_FOREIGN_KEY_INVALID/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 106);
  assert.equal(f.store.get("SELECT 1 FROM pragma_table_info('web_reviewed_candidates') WHERE name='asset_eligible'"), undefined);
  assert.equal(f.store.get('SELECT 1 FROM sqlite_master WHERE name=?', 'web_private_audio_assets'), undefined);
});

test('C-S3-005 fixed private bytes remain unchanged across replay and full internal scope rejection', t => {
  const f = fixture(t), flow = f.complete('bytes'), { scope } = flow.finishNext();
  const service = new WebSyntheticPrivateAudio(f.store, f.clock), bytes = tone(250);
  const result = service.stage(scope, flow.coordinator, bytes);
  assert.equal(result.state, 'synthetic_asset_verified');
  assert.deepEqual(service.read(scope, result.mediaId), bytes);
  assert.deepEqual(service.stage(scope, flow.coordinator, bytes), result);
  assert.throws(() => service.stage(scope, flow.coordinator, tone(300)), /WEB_PRIVATE_AUDIO_INTENT_CONFLICT/);
  const row = f.store.get<{ byte_length: number; sha256: string; duration_ms: number; origin: string }>(
    'SELECT * FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  assert.equal(row.byte_length, bytes.length);
  assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(row.origin, 'synthetic_test');
  assert.ok(row.duration_ms > 0);
  assert.equal(fs.statSync(join(f.root, 'private-audio')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(f.root, 'private-audio', `${result.mediaId}.wav`)).mode & 0o777, 0o600);
  for (const bad of [{ operationId: 'wrong' }, { ordinal: 1 }, { principalId: 'wrong' },
    { playerId: 'wrong' }, { worldId: 'wrong' }, { conversationId: 'wrong' },
    { characterId: 'wrong' }, { inputMessageId: 'wrong' }])
    assert.throws(() => service.read({ ...scope, ...bad }, result.mediaId), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  assert.deepEqual(new WebSyntheticPrivateAudio(reopened, f.clock).read(scope, result.mediaId), bytes);
});

test('C-S3-005 collision never overwrites existing final bytes or rewrites settled provider cost', t => {
  const f = fixture(t), flow = f.complete('collision'), { scope } = flow.finishNext();
  new WebPrivateAudioFiles(f.root);
  const mediaId = randomUUID(), finalPath = join(f.root, 'private-audio', `${mediaId}.wav`);
  const foreign = tone(300), requested = tone(250);
  writeFileSync(finalPath, foreign, { mode: 0o600 });
  const ids = [mediaId, randomUUID()];
  const service = new WebSyntheticPrivateAudio(f.store, f.clock, () => ids.shift()!);
  const beforeAttempt = { ...f.store.get<Record<string, unknown>>(
    "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)! };
  const beforeBudget = f.store.get<{ reserved: number }>(
    "SELECT reserved FROM web_external_budgets WHERE stage='audio'")!.reserved;
  assert.throws(() => service.stage(scope, flow.coordinator, requested), /WEB_PRIVATE_AUDIO_INTEGRITY/);
  assert.deepEqual(readFileSync(finalPath), foreign);
  const asset = f.store.get<{ state: string; sha256: string; byte_length: number }>(
    'SELECT state,sha256,byte_length FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  assert.equal(asset.state, 'preparing');
  assert.equal(asset.sha256, createHash('sha256').update(requested).digest('hex'));
  assert.equal(asset.byte_length, requested.length);
  assert.deepEqual({ ...f.store.get<Record<string, unknown>>(
    "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId) }, beforeAttempt);
  assert.equal(f.store.get<{ reserved: number }>(
    "SELECT reserved FROM web_external_budgets WHERE stage='audio'")?.reserved, beforeBudget);
});

test('C-S3-005 SQL attach fault leaves known provider and durable final for same-intent recovery', t => {
  const f = fixture(t), flow = f.complete('sql'), { scope } = flow.finishNext();
  const service = new WebSyntheticPrivateAudio(f.store, f.clock), bytes = tone(250);
  f.store.run(`CREATE TRIGGER reject_attach BEFORE UPDATE OF state ON web_private_audio_assets
    WHEN NEW.state='synthetic_asset_verified' BEGIN SELECT RAISE(ABORT,'C_INJECTED_ATTACH_FAILURE'); END`);
  assert.throws(() => service.stage(scope, flow.coordinator, bytes), /C_INJECTED_ATTACH_FAILURE/);
  const row = f.store.get<{ state: string; media_id: string }>(
    'SELECT state,media_id FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  assert.equal(row.state, 'preparing');
  assert.equal(existsSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), true);
  assert.equal(f.store.get<{ outcome: string }>(
    "SELECT outcome FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)?.outcome,
    'succeeded');
  f.store.run('DROP TRIGGER reject_attach');
  f.advance(30_000);
  const renewed = f.queue.acquireCoordinator('recovery');
  assert.deepEqual(service.recover(scope, renewed), { mediaId: row.media_id, state: 'synthetic_asset_verified' });
  assert.deepEqual(service.read(scope, row.media_id), bytes);
});

test('C-S3-005 legitimate next ordinal does not invalidate verified first private asset', t => {
  const f = fixture(t), flow = f.complete('two', ['第一片', '第二片']);
  const first = flow.finishNext(), service = new WebSyntheticPrivateAudio(f.store, f.clock);
  const firstResult = service.stage(first.scope, flow.coordinator, tone(250));
  const second = flow.finishNext();
  assert.equal(second.scope.ordinal, 1);
  assert.deepEqual(service.read(first.scope, firstResult.mediaId), tone(250));
  const secondResult = service.stage(second.scope, flow.coordinator, tone(300));
  assert.deepEqual(service.read(second.scope, secondResult.mediaId), tone(300));
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM web_private_audio_assets WHERE state='synthetic_asset_verified'")?.n, 2);
});

test('C-S3-005 file fsync failure leaves only immutable expectation and settled external success', t => {
  const f = fixture(t), flow = f.complete('file-sync'), { scope } = flow.finishNext();
  const service = new WebSyntheticPrivateAudio(f.store, f.clock), original = fs.fsyncSync;
  let fileCalls = 0;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isFile()) { fileCalls++; throw new Error('C_INJECTED_FILE_FSYNC'); }
    return original(fd);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => service.stage(scope, flow.coordinator, tone(250)), /C_INJECTED_FILE_FSYNC/); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.ok(fileCalls >= 1);
  const row = f.store.get<{ state: string; media_id: string; sha256: string }>(
    'SELECT state,media_id,sha256 FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  assert.equal(row.state, 'preparing');
  assert.equal(row.sha256, createHash('sha256').update(tone(250)).digest('hex'));
  assert.equal(existsSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), false);
  assert.equal(f.store.get<{ outcome: string; usage_json: string }>(
    "SELECT outcome,usage_json FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)?.outcome,
    'succeeded');
  assert.equal(f.store.get<{ reserved: number }>(
    "SELECT reserved FROM web_external_budgets WHERE stage='audio'")?.reserved, 0);
});

test('C-S3-005 old coordinator and cancellation cannot attach or expose a prepared final file', t => {
  const f = fixture(t), flow = f.complete('lease'), { scope } = flow.finishNext();
  const service = new WebSyntheticPrivateAudio(f.store, f.clock), bytes = tone(250);
  f.store.run(`CREATE TRIGGER reject_asset_attach BEFORE UPDATE OF state ON web_private_audio_assets
    WHEN NEW.state='synthetic_asset_verified' BEGIN SELECT RAISE(ABORT,'C_INJECTED_SQL_ATTACH'); END`);
  assert.throws(() => service.stage(scope, flow.coordinator, bytes), /C_INJECTED_SQL_ATTACH/);
  f.store.run('DROP TRIGGER reject_asset_attach');
  const row = f.store.get<{ media_id: string; state: string }>(
    'SELECT media_id,state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  f.advance(30_000);
  const takeover = f.queue.acquireCoordinator('takeover');
  assert.throws(() => service.recover(scope, flow.coordinator), /WEB_COORDINATOR_STALE/);
  f.ledger.terminate(takeover, f.ledger.fence(scope.operationId), scope.principalId, 'cancelled', 'cancel');
  assert.throws(() => service.recover(scope, takeover), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  assert.throws(() => service.read(scope, row.media_id), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  assert.equal(f.store.get<{ state: string }>('SELECT state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)?.state,
    'preparing');
  assert.equal(f.store.get<{ outcome: string }>(
    "SELECT outcome FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)?.outcome,
    'succeeded');
});

test('C-S3-005 R1 new and reopened private root must sync its parent before constructor succeeds', t => {
  const f = fixture(t), original = fs.fsyncSync;
  let parentCalls = 0;
  fs.fsyncSync = fd => {
    const stat = fs.fstatSync(fd), parent = fs.statSync(f.root);
    if (stat.isDirectory() && stat.dev === parent.dev && stat.ino === parent.ino) {
      parentCalls++;
      throw new Error('C_INJECTED_PARENT_FSYNC');
    }
    return original(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => new WebPrivateAudioFiles(f.root), /C_INJECTED_PARENT_FSYNC/);
    assert.equal(existsSync(join(f.root, 'private-audio')), true);
    assert.throws(() => new WebPrivateAudioFiles(f.root), /C_INJECTED_PARENT_FSYNC/);
    assert.equal(parentCalls, 2, 'an existing directory must not bypass parent fsync on reopen');
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.doesNotThrow(() => new WebPrivateAudioFiles(f.root));
});

test('C-S3-005 R1 persisted EIO clears into same-intent recovery without provider recount', t => {
  const f = fixture(t), flow = f.complete('recover'), { scope } = flow.finishNext();
  const service = new WebSyntheticPrivateAudio(f.store, f.clock), bytes = tone(250);
  const beforeAttempt = { ...f.store.get<Record<string, unknown>>(
    "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)! };
  const beforeBudget = { ...f.store.get<Record<string, unknown>>(
    "SELECT * FROM web_external_budgets WHERE stage='audio'")! };
  const original = fs.fsyncSync;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('C_INJECTED_DIRECTORY_EIO');
    return original(fd);
  };
  syncBuiltinESMExports();
  let renewed: ReturnType<typeof f.queue.acquireCoordinator>;
  try {
    assert.throws(() => service.stage(scope, flow.coordinator, bytes), /C_INJECTED_DIRECTORY_EIO/);
    f.advance(30_000);
    renewed = f.queue.acquireCoordinator('recovery');
    assert.throws(() => service.recover(scope, renewed), /C_INJECTED_DIRECTORY_EIO/);
    assert.equal(f.store.get<{ state: string }>(
      'SELECT state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)?.state, 'preparing');
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  const row = f.store.get<{ media_id: string }>(
    'SELECT media_id FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  f.advance(30_000);
  const clearedLease = f.queue.acquireCoordinator('cleared-recovery');
  assert.deepEqual(service.recover(scope, clearedLease), { mediaId: row.media_id, state: 'synthetic_asset_verified' });
  assert.deepEqual(service.read(scope, row.media_id), bytes);
  assert.deepEqual(service.stage(scope, clearedLease, bytes), { mediaId: row.media_id, state: 'synthetic_asset_verified' });
  assert.deepEqual({ ...f.store.get<Record<string, unknown>>(
    "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId) }, beforeAttempt);
  assert.deepEqual({ ...f.store.get<Record<string, unknown>>(
    "SELECT * FROM web_external_budgets WHERE stage='audio'") }, beforeBudget);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets')?.n, 1);
});

test('C-S3-005 R1 preparing first ordinal survives later completed second ordinal', t => {
  const f = fixture(t), flow = f.complete('preparing-two', ['第一片', '第二片']);
  const first = flow.finishNext(), service = new WebSyntheticPrivateAudio(f.store, f.clock);
  f.store.run(`CREATE TRIGGER reject_first_attach BEFORE UPDATE OF state ON web_private_audio_assets
    WHEN NEW.state='synthetic_asset_verified' AND NEW.ordinal=0 BEGIN SELECT RAISE(ABORT,'C_FIRST_ATTACH'); END`);
  assert.throws(() => service.stage(first.scope, flow.coordinator, tone(250)), /C_FIRST_ATTACH/);
  f.store.run('DROP TRIGGER reject_first_attach');
  const firstRow = f.store.get<{ media_id: string; state: string }>(
    'SELECT media_id,state FROM web_private_audio_assets WHERE operation_id=? AND ordinal=0', first.scope.operationId)!;
  assert.equal(firstRow.state, 'preparing');
  const second = flow.finishNext();
  assert.equal(second.scope.ordinal, 1);
  const secondResult = service.stage(second.scope, flow.coordinator, tone(300));
  assert.deepEqual(service.read(second.scope, secondResult.mediaId), tone(300));
  f.advance(30_000);
  const renewed = f.queue.acquireCoordinator('recovery');
  assert.deepEqual(service.recover(first.scope, renewed), { mediaId: firstRow.media_id, state: 'synthetic_asset_verified' });
  assert.deepEqual(service.read(first.scope, firstRow.media_id), tone(250));
  assert.equal(f.store.get<{ n: number }>(
    "SELECT count(*) n FROM web_private_audio_assets WHERE state='synthetic_asset_verified'")?.n, 2);
});

test('C-S3-005 R1 file write and link errors retain one fixed intent and settled ledger', t => {
  for (const fault of ['write', 'link'] as const) {
    const f = fixture(t), flow = f.complete(fault), { scope } = flow.finishNext();
    const service = new WebSyntheticPrivateAudio(f.store, f.clock), bytes = tone(250);
    const before = { ...f.store.get<Record<string, unknown>>(
      "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)! };
    const originalWrite = fs.writeFileSync, originalLink = fs.linkSync;
    if (fault === 'write') fs.writeFileSync = ((path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
      if (typeof path === 'number') throw new Error('C_INJECTED_FILE_WRITE');
      return originalWrite(path, data, options as never);
    }) as typeof fs.writeFileSync;
    else fs.linkSync = (() => { throw new Error('C_INJECTED_FINAL_LINK'); }) as typeof fs.linkSync;
    syncBuiltinESMExports();
    try { assert.throws(() => service.stage(scope, flow.coordinator, bytes), /C_INJECTED_FILE_(WRITE)|C_INJECTED_FINAL_LINK/); }
    finally { fs.writeFileSync = originalWrite; fs.linkSync = originalLink; syncBuiltinESMExports(); }
    const row = f.store.get<{ media_id: string; state: string; sha256: string }>(
      'SELECT media_id,state,sha256 FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
    assert.equal(row.state, 'preparing');
    assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(existsSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), false);
    assert.deepEqual({ ...f.store.get<Record<string, unknown>>(
      "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId) }, before);
  }
});

test('C-S3-005 R1 two actual processes stage one fixed intent without duplicate asset or external charge', async t => {
  const f = fixture(t), flow = f.complete('race'), { scope } = flow.finishNext();
  const beforeAttempt = { ...f.store.get<Record<string, unknown>>(
    "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)! };
  const children = [0, 1].map(() => spawn(process.execPath,
    [raceWorker, f.root, f.instanceId, JSON.stringify(scope), JSON.stringify(flow.coordinator), String(f.now())],
    { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const results = children.map(child => new Promise<{ ok: boolean; result?: { mediaId: string }; error?: string }>((resolve, reject) => {
    let output = '', error = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`private audio worker ${code}: ${error}`));
      else try { resolve(JSON.parse(output) as { ok: boolean; result?: { mediaId: string } }); }
      catch { reject(new Error(`private audio worker output ${output}; ${error}`)); }
    });
  }));
  for (const child of children) child.stdin.end('go\n');
  const settled = await Promise.all(results);
  assert.ok(settled.some(row => row.ok), JSON.stringify(settled));
  assert.ok(settled.every(row => row.ok || /WEB_PRIVATE_AUDIO_PREPARATION_BUSY/.test(row.error ?? '')),
    JSON.stringify(settled));
  const row = f.store.get<{ media_id: string; state: string }>(
    'SELECT media_id,state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  assert.equal(row.state, 'synthetic_asset_verified');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets')?.n, 1);
  assert.deepEqual(settled.filter(result => result.ok).map(result => result.result?.mediaId).filter(Boolean),
    Array(settled.filter(result => result.ok).length).fill(row.media_id));
  assert.deepEqual(readFileSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), tone(250));
  assert.deepEqual({ ...f.store.get<Record<string, unknown>>(
    "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId) }, beforeAttempt);
});

test('C-S3-005 R1 missing/corrupt final and replaced root cannot verify preparing intent', t => {
  const f = fixture(t), flow = f.complete('damaged'), { scope } = flow.finishNext();
  const service = new WebSyntheticPrivateAudio(f.store, f.clock), bytes = tone(250);
  f.store.run(`CREATE TRIGGER reject_damaged_attach BEFORE UPDATE OF state ON web_private_audio_assets
    WHEN NEW.state='synthetic_asset_verified' BEGIN SELECT RAISE(ABORT,'C_ATTACH'); END`);
  assert.throws(() => service.stage(scope, flow.coordinator, bytes), /C_ATTACH/);
  f.store.run('DROP TRIGGER reject_damaged_attach');
  const row = f.store.get<{ media_id: string }>(
    'SELECT media_id FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  const finalPath = join(f.root, 'private-audio', `${row.media_id}.wav`);
  unlinkSync(finalPath);
  f.advance(30_000);
  const missingLease = f.queue.acquireCoordinator('missing');
  assert.throws(() => service.recover(scope, missingLease), /WEB_PRIVATE_AUDIO_UNAVAILABLE/);
  writeFileSync(finalPath, tone(300), { mode: 0o600 });
  f.advance(30_000);
  const corruptLease = f.queue.acquireCoordinator('corrupt');
  assert.throws(() => service.recover(scope, corruptLease), /WEB_PRIVATE_AUDIO_INTEGRITY/);
  assert.equal(f.store.get<{ state: string }>(
    'SELECT state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)?.state, 'preparing');
  const privateRoot = join(f.root, 'private-audio'), moved = join(f.parent, 'moved-private');
  renameSync(privateRoot, moved);
  mkdirSync(privateRoot, { mode: 0o700 });
  f.advance(30_000);
  const replacementLease = f.queue.acquireCoordinator('replaced');
  assert.throws(() => service.recover(scope, replacementLease), /WEB_PRIVATE_AUDIO_ROOT_UNSAFE/);
  assert.equal(f.store.get<{ state: string }>(
    'SELECT state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)?.state, 'preparing');
  assert.equal(f.store.get<{ outcome: string }>(
    "SELECT outcome FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)?.outcome,
    'succeeded');
});

test('C-S3-005 R1 original 300-second deadline rejects new private asset intent', t => {
  const f = fixture(t), flow = f.complete('deadline'), { scope } = flow.finishNext();
  const service = new WebSyntheticPrivateAudio(f.store, f.clock);
  f.advance(300_000);
  const afterDeadline = f.queue.acquireCoordinator('late');
  assert.throws(() => service.stage(scope, afterDeadline, tone(250)), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets')?.n, 0);
  assert.equal(f.store.get<{ outcome: string }>(
    "SELECT outcome FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)?.outcome,
    'succeeded');
});
