import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { WebSyntheticPrivateAudio, type PrivateAudioScope } from '../../../apps/server/web-private-audio.ts';
import { WebPrivateAudioFiles } from '../../../apps/server/web-private-audio-files.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';
import { tone } from '../../audio-fixtures.ts';

function fixture(t: test.TestContext, migrate = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-private-audio-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  if (migrate) store.migrateSyntheticPrivateAudio();
  let now = 1_700_000_000_000;
  const clock = { now: () => now }, nextId = randomUUID;
  const admission = new WebAdmission(store, clock, nextId);
  const queue = new WebStageQueue(store, clock, nextId);
  const ledger = new WebDispatchLedger(store, clock);
  store.run("INSERT INTO character_templates VALUES ('character',1,'{\"name\":\"synthetic\"}')");
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', now);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'Asia/Singapore', '{}');
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", 'world', 'character');
  admission.registerGuest({ principalId: 'principal', playerId: 'player', worldId: 'world' });
  const audio = new WebSyntheticPrivateAudio(store, clock, nextId);
  function complete() {
    admission.admit({ principalId: 'principal', requestId: randomUUID(), characterId: 'character',
      text: '输入', ipHash: 'a'.repeat(64) });
    const coordinator = queue.acquireCoordinator('coordinator');
    const text = queue.claimText(coordinator, 'worker')!;
    const snapshot = queue.inputSnapshot({ operation_id: text.operationId,
      principal_id: text.principalId, world_id: text.worldId, conversation_id: text.conversationId,
      character_id: text.characterId, input_message_id: text.inputMessageId });
    queue.completeText(text, { narrative: ['合成测试正文'], inputVersion: snapshot.input_digest,
      characterVersion: String(snapshot.template_version), templateVersion: snapshot.template_digest,
      voiceVersion: 'synthetic-test', accessRevision: snapshot.access_revision, usage: {} });
    ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
    const claim = queue.claimAudio(coordinator, 'audio-worker')!;
    const key = ledger.reserve(claim, { phase: 'speech', ordinal: 0, provider: 'fake',
      providerRequestId: randomUUID() });
    ledger.markSent(claim, key);
    ledger.confirm(key, { outcome: 'succeeded', receipt: { synthetic: true }, usage: { calls: 1 } });
    const scope: PrivateAudioScope = { operationId: text.operationId, ordinal: 0,
      principalId: text.principalId, playerId: 'player', worldId: text.worldId,
      conversationId: text.conversationId, characterId: text.characterId,
      inputMessageId: text.inputMessageId };
    return { scope, coordinator };
  }
  return { root, instanceId, store, clock, queue, ledger, audio, complete,
    advance: (ms: number) => { now += ms; } };
}

test('107 fixes synthetic bytes before file IO; same intent, scope, restart and corruption checks', t => {
  const f = fixture(t), { scope, coordinator } = f.complete(), wav = tone(250);
  const result = f.audio.stage(scope, coordinator, wav);
  assert.equal(result.state, 'synthetic_asset_verified');
  assert.deepEqual(f.audio.read(scope, result.mediaId), wav);
  assert.deepEqual(f.audio.stage(scope, coordinator, wav), result);
  assert.throws(() => f.audio.stage(scope, coordinator, tone(300)), /WEB_PRIVATE_AUDIO_INTENT_CONFLICT/);
  for (const bad of [{ principalId: 'other' }, { playerId: 'other' }, { worldId: 'other' },
    { conversationId: 'other' }, { inputMessageId: 'other' }])
    assert.throws(() => f.audio.read({ ...scope, ...bad }, result.mediaId), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  assert.deepEqual(new WebSyntheticPrivateAudio(reopened, f.clock).read(scope, result.mediaId), wav);
  const path = join(f.root, 'private-audio', `${result.mediaId}.wav`);
  const original = readFileSync(path); writeFileSync(path, tone(250, 24000, 1, true));
  assert.throws(() => f.audio.read(scope, result.mediaId), /WEB_PRIVATE_AUDIO_INTEGRITY/);
  writeFileSync(path, original); chmodSync(path, 0o644);
  assert.throws(() => f.audio.read(scope, result.mediaId), /WEB_PRIVATE_AUDIO_INTEGRITY/);
});

test('106 historical segment remains ineligible after 107 migration', t => {
  const f = fixture(t, false), { scope, coordinator } = f.complete();
  f.store.migrateSyntheticPrivateAudio();
  assert.equal(f.store.get<{ asset_eligible: number }>('SELECT asset_eligible FROM web_reviewed_candidates WHERE operation_id=?',
    scope.operationId)?.asset_eligible, 0);
  assert.throws(() => f.audio.stage(scope, coordinator, tone(250)), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets')?.n, 0);
});

test('file failure does not alter known provider receipt, usage or budget; fixed expectation persists', t => {
  const f = fixture(t), { scope, coordinator } = f.complete(), wav = tone(250);
  chmodSync(join(f.root, 'private-audio'), 0o755);
  assert.throws(() => f.audio.stage(scope, coordinator, wav), /WEB_PRIVATE_AUDIO_ROOT_UNSAFE/);
  const row = f.store.get<{ state: string; byte_length: number; sha256: string; media_id: string }>(
    'SELECT * FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  assert.equal(row.state, 'preparing'); assert.equal(row.byte_length, wav.length);
  assert.equal(f.store.get<{ dispatch_state: string; outcome: string; receipt_json: string; usage_json: string }>(
    "SELECT * FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)?.outcome, 'succeeded');
  assert.equal(f.store.get<{ reserved: number }>(
    "SELECT reserved FROM web_external_budgets WHERE provider='fake' AND stage='audio'")?.reserved, 0);
  chmodSync(join(f.root, 'private-audio'), 0o700);
  f.advance(30_000); const renewed = f.queue.acquireCoordinator('recovery');
  assert.throws(() => f.audio.recover(scope, renewed), /WEB_PRIVATE_AUDIO_UNAVAILABLE/);
  assert.equal(existsSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), false);
});

test('existing fixed file can recover after attach rollback without altering external settlement', t => {
  const f = fixture(t), { scope, coordinator } = f.complete(), wav = tone(250);
  f.store.run(`CREATE TRIGGER block_private_attach BEFORE UPDATE OF state ON web_private_audio_assets
    BEGIN SELECT RAISE(ABORT,'attach blocked'); END`);
  assert.throws(() => f.audio.stage(scope, coordinator, wav), /attach blocked/);
  const row = f.store.get<{ media_id: string; state: string }>(
    'SELECT * FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  assert.equal(row.state, 'preparing');
  assert.equal(existsSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), true);
  f.store.run('DROP TRIGGER block_private_attach');
  f.advance(30_000); const renewed = f.queue.acquireCoordinator('recovery');
  assert.deepEqual(f.audio.recover(scope, renewed), { mediaId: row.media_id, state: 'synthetic_asset_verified' });
  assert.deepEqual(f.audio.read(scope, row.media_id), wav);
  f.store.run("UPDATE web_operations SET status='cancelled',quota_state='released' WHERE id=?", scope.operationId);
  assert.throws(() => f.audio.read(scope, row.media_id), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
});

test('107 migration conflict rolls back both historical eligibility columns', t => {
  const f = fixture(t, false);
  f.store.run('CREATE TABLE web_private_audio_assets(id TEXT)');
  assert.throws(() => f.store.migrateSyntheticPrivateAudio());
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 106);
  assert.equal(f.store.get<{ n: number }>(
    "SELECT count(*) n FROM pragma_table_info('web_reviewed_candidates') WHERE name='asset_eligible'")?.n, 0);
  assert.equal(f.store.get<{ n: number }>(
    "SELECT count(*) n FROM pragma_table_info('web_synthetic_voice_segments') WHERE name='asset_eligible'")?.n, 0);
});

test('replaced private root is refused before reading a verified file', t => {
  const f = fixture(t), { scope, coordinator } = f.complete();
  const { mediaId } = f.audio.stage(scope, coordinator, tone(250));
  const dir = join(f.root, 'private-audio'), moved = join(f.root, 'private-audio-old');
  renameSync(dir, moved); symlinkSync(moved, dir);
  assert.throws(() => f.audio.read(scope, mediaId), /WEB_PRIVATE_AUDIO_ROOT_UNSAFE/);
  rmSync(dir); renameSync(moved, dir);
  assert.deepEqual(f.audio.read(scope, mediaId), tone(250));
  renameSync(dir, moved); mkdirSync(dir, { mode: 0o700 });
  assert.throws(() => f.audio.read(scope, mediaId), /WEB_PRIVATE_AUDIO_ROOT_UNSAFE/);
  rmSync(dir, { recursive: true }); renameSync(moved, dir);
});

test('static Web root symlink is rejected before creating a foreign private directory', t => {
  const f = fixture(t), original = join(f.root, '..', 'original-instance');
  const foreign = join(f.root, '..', 'foreign');
  mkdirSync(foreign, { mode: 0o700 });
  renameSync(f.root, original); symlinkSync(foreign, f.root);
  try {
    assert.throws(() => new WebSyntheticPrivateAudio(f.store, f.clock), /WEB_PRIVATE_AUDIO_ROOT_UNSAFE/);
    assert.deepEqual(readdirSync(foreign), []);
  } finally { rmSync(f.root); renameSync(original, f.root); }
});

test('cancellation between durable file and SQL attach leaves only an unreadable orphan', t => {
  const f = fixture(t), { scope, coordinator } = f.complete();
  const files = new class extends WebPrivateAudioFiles {
    override write(mediaId: string, bytes: Buffer, expected: Parameters<WebPrivateAudioFiles['write']>[2]) {
      super.write(mediaId, bytes, expected);
      f.store.run("UPDATE web_operations SET status='cancelled',quota_state='released' WHERE id=?",
        scope.operationId);
    }
  }(f.root);
  const service = new WebSyntheticPrivateAudio(f.store, f.clock, randomUUID, files);
  assert.throws(() => service.stage(scope, coordinator, tone(250)), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  const row = f.store.get<{ media_id: string; state: string }>(
    'SELECT media_id,state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
  assert.equal(row.state, 'preparing');
  assert.equal(existsSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), true);
  assert.throws(() => service.read(scope, row.media_id), /WEB_PRIVATE_AUDIO_NOT_ELIGIBLE/);
  assert.equal(f.store.get<{ outcome: string }>(
    "SELECT outcome FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)?.outcome,
  'succeeded');
});

test('symlink substitution and missing final file never become readable', t => {
  const f = fixture(t), { scope, coordinator } = f.complete();
  const { mediaId } = f.audio.stage(scope, coordinator, tone(250));
  const path = join(f.root, 'private-audio', `${mediaId}.wav`);
  rmSync(path); symlinkSync(join(f.root, 'web.sqlite'), path);
  assert.throws(() => f.audio.read(scope, mediaId), /WEB_PRIVATE_AUDIO_UNAVAILABLE/);
  rmSync(path);
  assert.throws(() => f.audio.read(scope, mediaId), /WEB_PRIVATE_AUDIO_UNAVAILABLE/);
});

test('low-level write, file-fsync and link failures leave fixed intent without altering provider success', t => {
  for (const fault of ['write', 'file-fsync', 'link'] as const) {
    const f = fixture(t), { scope, coordinator } = f.complete();
    const originalWrite = fs.writeFileSync, originalFsync = fs.fsyncSync, originalLink = fs.linkSync;
    try {
      if (fault === 'write') fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === 'number') throw new Error('INJECTED_WRITE_EIO');
        return originalWrite(...args);
      }) as typeof fs.writeFileSync;
      if (fault === 'file-fsync') fs.fsyncSync = fd => {
        if (fs.fstatSync(fd).isFile()) throw new Error('INJECTED_FILE_FSYNC_EIO');
        return originalFsync(fd);
      };
      if (fault === 'link') fs.linkSync = () => { throw new Error('INJECTED_LINK_EIO'); };
      syncBuiltinESMExports();
      assert.throws(() => f.audio.stage(scope, coordinator, tone(250)), /INJECTED_.*_EIO/);
    } finally {
      fs.writeFileSync = originalWrite; fs.fsyncSync = originalFsync; fs.linkSync = originalLink;
      syncBuiltinESMExports();
    }
    const row = f.store.get<{ state: string; media_id: string }>(
      'SELECT state,media_id FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)!;
    assert.equal(row.state, 'preparing', fault);
    assert.equal(existsSync(join(f.root, 'private-audio', `${row.media_id}.wav`)), false, fault);
    assert.equal(f.store.get<{ outcome: string }>(
      "SELECT outcome FROM web_external_attempts WHERE operation_id=? AND stage='audio'", scope.operationId)?.outcome,
    'succeeded');
    assert.equal(f.store.get<{ reserved: number }>(
      "SELECT reserved FROM web_external_budgets WHERE provider='fake' AND stage='audio'")?.reserved, 0);
  }
});

test('recovery re-syncs the verified file before attaching a previously durable name', t => {
  const f = fixture(t), { scope, coordinator } = f.complete();
  f.store.run(`CREATE TRIGGER block_private_attach BEFORE UPDATE OF state ON web_private_audio_assets
    BEGIN SELECT RAISE(ABORT,'attach blocked'); END`);
  assert.throws(() => f.audio.stage(scope, coordinator, tone(250)), /attach blocked/);
  f.store.run('DROP TRIGGER block_private_attach');
  f.advance(30_000); const recovery = f.queue.acquireCoordinator('recovery');
  const original = fs.fsyncSync; let fileAttempts = 0;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isFile()) { fileAttempts++; throw new Error('INJECTED_FILE_FSYNC_EIO'); }
    return original(fd);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => f.audio.recover(scope, recovery), /INJECTED_FILE_FSYNC_EIO/); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.ok(fileAttempts > 0);
  assert.equal(f.store.get<{ state: string }>(
    'SELECT state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)?.state, 'preparing');
});

test('new private directory needs parent fsync; reopening cannot bypass its failure', t => {
  const f = fixture(t), dir = join(f.root, 'private-audio');
  rmSync(dir, { recursive: true });
  const original = fs.fsyncSync; let parentAttempts = 0;
  fs.fsyncSync = fd => {
    const stat = fs.fstatSync(fd), parent = fs.lstatSync(f.root);
    if (stat.isDirectory() && stat.dev === parent.dev && stat.ino === parent.ino) {
      parentAttempts++; throw new Error('INJECTED_PARENT_FSYNC_EIO');
    }
    return original(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => new WebSyntheticPrivateAudio(f.store, f.clock), /INJECTED_PARENT_FSYNC_EIO/);
    assert.equal(existsSync(dir), true);
    assert.throws(() => new WebSyntheticPrivateAudio(f.store, f.clock), /INJECTED_PARENT_FSYNC_EIO/);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.ok(parentAttempts >= 2);
  assert.ok(new WebSyntheticPrivateAudio(f.store, f.clock));
});

test('failed directory durability cannot be recovered until fsync succeeds for same fixed intent', t => {
  const f = fixture(t), { scope, coordinator } = f.complete(), wav = tone(250);
  const original = fs.fsyncSync; let directoryAttempts = 0;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) { directoryAttempts++; throw new Error('INJECTED_DIRECTORY_FSYNC_EIO'); }
    return original(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.audio.stage(scope, coordinator, wav), /INJECTED_DIRECTORY_FSYNC_EIO/);
    f.advance(30_000); const second = f.queue.acquireCoordinator('recovery-one');
    const before = directoryAttempts;
    assert.throws(() => f.audio.recover(scope, second), /INJECTED_DIRECTORY_FSYNC_EIO/);
    assert.ok(directoryAttempts > before);
    assert.equal(f.store.get<{ state: string }>(
      'SELECT state FROM web_private_audio_assets WHERE operation_id=?', scope.operationId)?.state, 'preparing');
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  f.advance(30_000); const third = f.queue.acquireCoordinator('recovery-two');
  const result = f.audio.recover(scope, third);
  assert.equal(result.state, 'synthetic_asset_verified');
  assert.deepEqual(f.audio.read(scope, result.mediaId), wav);
  assert.deepEqual(f.audio.recover(scope, third), result);
});
