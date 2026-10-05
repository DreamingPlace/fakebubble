import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { WebStore } from '../../../apps/server/store.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebLocalExecutor } from '../../../apps/server/web-local-executor.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { readWebV7Request } from '../../../apps/server/web-v7-request.ts';
import { syntheticText, syntheticTone } from '../../../apps/server/web-local-fake.ts';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('109 synthetic executor publishes without manual stage advancement', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-executor-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
  const clock = { now: () => 1_700_000_000_000 };
  const identity = new WebIdentity(store, { origin: 'https://127.0.0.1:18451',
    cookieName: '__Host-local-test', clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic', 1,
    JSON.stringify({ id: 'synthetic', name: '合成测试角色', version: 1, fictional: true,
      persona: '仅用于本地合成测试。', schedule: defaultSchedule() }));
  const guest = identity.bootstrap(), scope = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic');
  const admitted = new WebAdmission(store, clock, randomUUID).admit({ principalId: guest.principalId,
    requestId: 'first', characterId: 'synthetic', text: '你好', ipHash: 'a'.repeat(64) });
  const executor = new WebLocalExecutor(store, clock);
  t.after(() => executor.stop());
  executor.start();
  for (let i = 0; i < 8 && !store.get('SELECT 1 FROM web_publications WHERE operation_id=?', admitted.operationId); i++)
    executor.pump();
  assert.equal(executor.lastError, null);
  assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', admitted.operationId)?.status,
    'published');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_local_text_outputs')?.n, 2);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_local_audio_outputs')?.n, 1);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_local_events')!.n > 1, true);
  const second = new WebAdmission(store, clock, randomUUID).admit({ principalId: guest.principalId,
    requestId: 'cancel-me', characterId: 'synthetic', text: '不继续', ipHash: 'a'.repeat(64) });
  assert.equal(executor.cancel(second.operationId, guest.principalId).status, 'cancelled');
  assert.equal(store.get<{ status: string; quota_state: string }>(
    'SELECT status,quota_state FROM web_operations WHERE id=?', second.operationId)?.quota_state, 'released');
  assert.equal(store.get('SELECT 1 FROM web_publications WHERE operation_id=?', second.operationId), undefined);
});

test('known draft and review survive a closed Store and are published without redispatch', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-known-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), instanceId = randomUUID();
  let store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
  let now = 1_700_000_000_000; const clock = { now: () => now };
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic', 1,
    JSON.stringify({ id: 'synthetic', name: '合成测试角色', version: 1, fictional: true,
      persona: '仅用于本地合成测试。', schedule: defaultSchedule() }));
  const identity = new WebIdentity(store, { origin: 'https://127.0.0.1:18451',
    cookieName: '__Host-local-test', clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  const guest = identity.bootstrap(), scope = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic');
  const admitted = new WebAdmission(store, clock, randomUUID).admit({ principalId: guest.principalId,
    requestId: 'known', characterId: 'synthetic', text: '你好', ipHash: 'a'.repeat(64) });
  const queue = new WebStageQueue(store, clock, randomUUID), ledger = new WebDispatchLedger(store, clock);
  const coordinator = queue.acquireCoordinator('first'), claim = queue.claimText(coordinator, 'first-text')!;
  const output = syntheticText(readWebV7Request(store, admitted.operationId).request);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase, capacity: 4 });
    const key = ledger.reserve(claim, { phase, ordinal: -1, provider: 'synthetic-local',
      providerRequestId: `${admitted.operationId}:${phase}` });
    ledger.markSent(claim, key);
    ledger.confirm(key, { outcome: 'succeeded', receipt: { origin: 'synthetic_test',
      outputDigest: createHash('sha256').update(JSON.stringify(output[phase])).digest('hex') },
    usage: { calls: 1 }, output: output[phase] });
  }
  const original = store.all<{ output_json: string }>(
    'SELECT output_json FROM web_local_text_outputs WHERE operation_id=? ORDER BY phase', admitted.operationId);
  store.close(); now += 31_000;
  store = new WebStore(root, { create: false, instanceId });
  const executor = new WebLocalExecutor(store, clock);
  t.after(() => executor.stop());
  executor.start();
  for (let i = 0; i < 8 && !store.get('SELECT 1 FROM web_publications WHERE operation_id=?', admitted.operationId); i++)
    executor.pump();
  assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status,
    'published');
  assert.deepEqual(store.all<{ output_json: string }>(
    'SELECT output_json FROM web_local_text_outputs WHERE operation_id=? ORDER BY phase', admitted.operationId), original);
  assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM web_external_attempts WHERE operation_id=?
    AND stage='text'`, admitted.operationId)!.n, 2);
});

test('slow synthetic audio does not occupy the independent text execution capacity', async t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-overlap-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
  const clock = { now: () => 1_700_000_000_000 };
  const identity = new WebIdentity(store, { origin: 'https://127.0.0.1:18451',
    cookieName: '__Host-local-test', clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic', 1,
    JSON.stringify({ id: 'synthetic', name: '合成测试角色', version: 1, fictional: true,
      persona: '仅用于本地合成测试。', schedule: defaultSchedule() }));
  const createGuest = () => {
    const guest = identity.bootstrap(), scope = identity.authenticate(guest.issuedToken!);
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic');
    return guest.principalId;
  };
  const first = createGuest(), second = createGuest();
  const admission = new WebAdmission(store, clock, randomUUID);
  const one = admission.admit({ principalId: first, requestId: 'one', characterId: 'synthetic',
    text: '一', ipHash: 'a'.repeat(64) });
  const executor = new WebLocalExecutor(store, clock, { audioDelayMs: 180 });
  t.after(() => executor.stop());
  executor.start();
  executor.pump();
  assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', one.operationId)!.status,
    'audio_running');
  const two = admission.admit({ principalId: second, requestId: 'two', characterId: 'synthetic',
    text: '二', ipHash: 'a'.repeat(64) });
  executor.pump();
  assert.ok(store.get('SELECT 1 FROM web_v7_candidates WHERE operation_id=?', two.operationId));
  assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', one.operationId)!.status,
    'audio_running');
  await new Promise(resolveWait => setTimeout(resolveWait, 220));
  executor.pump();
  assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', one.operationId)!.status,
    'published');
});

test('known speech bytes survive close/reopen and attach without redispatch', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-speech-recovery-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), instanceId = randomUUID();
  let store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
  let now = 1_700_000_000_000; const clock = { now: () => now };
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic', 1,
    JSON.stringify({ id: 'synthetic', name: '合成测试角色', version: 1, fictional: true,
      persona: '仅用于本地合成测试。', schedule: defaultSchedule() }));
  const identity = new WebIdentity(store, { origin: 'https://127.0.0.1:18451',
    cookieName: '__Host-local-test', clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  const guest = identity.bootstrap(), scope = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic');
  const admitted = new WebAdmission(store, clock, randomUUID).admit({ principalId: guest.principalId,
    requestId: 'speech', characterId: 'synthetic', text: '你好', ipHash: 'a'.repeat(64) });
  const queue = new WebStageQueue(store, clock, randomUUID), ledger = new WebDispatchLedger(store, clock);
  const coordinator = queue.acquireCoordinator('first'), textClaim = queue.claimText(coordinator, 'first-text')!;
  const output = syntheticText(readWebV7Request(store, admitted.operationId).request);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase, capacity: 4 });
    const key = ledger.reserve(textClaim, { phase, ordinal: -1, provider: 'synthetic-local',
      providerRequestId: `${admitted.operationId}:${phase}` });
    ledger.markSent(textClaim, key);
    ledger.confirm(key, { outcome: 'succeeded', receipt: { origin: 'synthetic_test',
      outputDigest: createHash('sha256').update(JSON.stringify(output[phase])).digest('hex') },
    usage: { calls: 1 }, output: output[phase] });
  }
  queue.completeReviewedText(textClaim, output);
  ledger.configureBudget({ provider: 'synthetic-local', stage: 'audio', phase: 'speech', capacity: 4 });
  const audioClaim = queue.claimAudio(coordinator, 'first-audio')!;
  const key = ledger.reserve(audioClaim, { phase: 'speech', ordinal: 0, provider: 'synthetic-local',
    providerRequestId: `${admitted.operationId}:speech:0` });
  ledger.markSent(audioClaim, key);
  const bytes = syntheticTone();
  ledger.confirm(key, { outcome: 'succeeded', receipt: { origin: 'synthetic_test',
    outputDigest: createHash('sha256').update(bytes).digest('hex') }, usage: { calls: 1 }, output: bytes });
  assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status,
    'audio_pending');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets')!.n, 0);
  store.close(); now += 31_000;
  store = new WebStore(root, { create: false, instanceId });
  const executor = new WebLocalExecutor(store, clock);
  t.after(() => executor.stop());
  executor.start();
  executor.pump();
  assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status,
    'published');
  assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM web_external_attempts WHERE operation_id=?
    AND stage='audio'`, admitted.operationId)!.n, 1);
});

test('a separate executor process exits after known speech receipt; restart reuses bytes and publishes', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-process-recovery-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), instanceId = randomUUID();
  let store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
  const now = 1_700_000_000_000, clock = { now: () => now + 31_000 };
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic', 1,
    JSON.stringify({ id: 'synthetic', name: '合成测试角色', version: 1, fictional: true,
      persona: '仅用于本地合成测试。', schedule: defaultSchedule() }));
  const identity = new WebIdentity(store, { origin: 'https://127.0.0.1:18451',
    cookieName: '__Host-local-test', clock: { now: () => now },
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  const guest = identity.bootstrap(), scope = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic');
  const admitted = new WebAdmission(store, { now: () => now }, randomUUID).admit({
    principalId: guest.principalId, requestId: 'process-crash', characterId: 'synthetic',
    text: '请回复', ipHash: 'a'.repeat(64) });
  store.close();
  const worker = spawnSync(process.execPath,
    [resolve('tests/web/fixtures/web-local-crash-worker.ts'), root, instanceId, String(now), 'known'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(worker.status, 86, worker.stderr);
  store = new WebStore(root, { create: false, instanceId });
  assert.equal(store.get<{ status: string }>(
    'SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status, 'audio_pending');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_local_audio_outputs')!.n, 1);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets')!.n, 0);
  const executor = new WebLocalExecutor(store, clock);
  t.after(() => executor.stop());
  executor.start();
  executor.pump();
  assert.equal(store.get<{ status: string }>(
    'SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status, 'published');
  assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM web_external_attempts
    WHERE operation_id=? AND stage='audio'`, admitted.operationId)!.n, 1);
});

test('a separate executor process exits after sent speech; restart records UNKNOWN without redispatch', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-process-unknown-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), instanceId = randomUUID();
  let store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
  const now = 1_700_000_000_000, clock = { now: () => now + 31_000 };
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic', 1,
    JSON.stringify({ id: 'synthetic', name: '合成测试角色', version: 1, fictional: true,
      persona: '仅用于本地合成测试。', schedule: defaultSchedule() }));
  const identity = new WebIdentity(store, { origin: 'https://127.0.0.1:18451',
    cookieName: '__Host-local-test', clock: { now: () => now },
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  const guest = identity.bootstrap(), scope = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic');
  const admitted = new WebAdmission(store, { now: () => now }, randomUUID).admit({
    principalId: guest.principalId, requestId: 'process-unknown', characterId: 'synthetic',
    text: '请回复', ipHash: 'a'.repeat(64) });
  store.close();
  const worker = spawnSync(process.execPath,
    [resolve('tests/web/fixtures/web-local-crash-worker.ts'), root, instanceId, String(now), 'sent'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(worker.status, 85, worker.stderr);
  store = new WebStore(root, { create: false, instanceId });
  assert.equal(store.get<{ status: string }>(
    'SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status, 'audio_running');
  const executor = new WebLocalExecutor(store, clock);
  t.after(() => executor.stop());
  executor.start();
  executor.pump();
  assert.equal(store.get<{ status: string }>(
    'SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status, 'unknown');
  assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM web_external_attempts
    WHERE operation_id=? AND stage='audio'`, admitted.operationId)!.n, 1);
  assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM web_local_audio_outputs
    WHERE operation_id=?`, admitted.operationId)!.n, 0);
  assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM web_publications
    WHERE operation_id=?`, admitted.operationId)!.n, 0);
});

test('UNKNOWN expires once at original deadline while its external ticket remains unsettled', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-unknown-expiry-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic', 1,
    JSON.stringify({ id: 'synthetic', name: '合成测试角色', version: 1, fictional: true,
      persona: '仅用于本地合成测试。', schedule: defaultSchedule() }));
  const identity = new WebIdentity(store, { origin: 'https://127.0.0.1:18451',
    cookieName: '__Host-local-test', clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  const guest = identity.bootstrap(), scope = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic');
  const admission = new WebAdmission(store, clock, randomUUID);
  const admitted = admission.admit({ principalId: guest.principalId, requestId: 'uncertain',
    characterId: 'synthetic', text: '不确定', ipHash: 'a'.repeat(64) });
  const queue = new WebStageQueue(store, clock, randomUUID), ledger = new WebDispatchLedger(store, clock);
  const old = queue.acquireCoordinator('old'), claim = queue.claimText(old, 'old-text')!;
  ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase: 'draft', capacity: 4 });
  const key = ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'synthetic-local',
    providerRequestId: `${admitted.operationId}:draft` });
  ledger.markSent(claim, key);
  now += 31_000;
  const executor = new WebLocalExecutor(store, clock);
  t.after(() => executor.stop());
  executor.start();
  assert.equal(store.get<{ status: string }>(
    'SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status, 'unknown');
  for (let i = 0; i < 27; i++) { now += 10_000; executor.pump(); }
  executor.pump();
  const ended = store.get<{ status: string; quota_state: string; failure_code: string }>(
    'SELECT status,quota_state,failure_code FROM web_operations WHERE id=?', admitted.operationId)!;
  assert.deepEqual({ ...ended }, { status: 'failed', quota_state: 'released', failure_code: 'OPERATION_EXPIRED' });
  assert.equal(store.get<{ trial_reserved: number }>(
    'SELECT trial_reserved FROM web_principals WHERE id=?', guest.principalId)!.trial_reserved, 0);
  assert.equal(store.get<{ reserved: number }>(`SELECT reserved FROM web_external_budgets
    WHERE provider='synthetic-local' AND stage='text' AND phase='draft'`)!.reserved, 1);
  assert.equal(store.get<{ dispatch_state: string }>(`SELECT dispatch_state FROM web_external_attempts
    WHERE operation_id=?`, admitted.operationId)!.dispatch_state, 'unknown');
  const next = admission.admit({ principalId: guest.principalId, requestId: 'after-expiry',
    characterId: 'synthetic', text: '继续', ipHash: 'a'.repeat(64) });
  assert.equal(next.status, 'queued');
  const receipt = { outcome: 'succeeded' as const, receipt: { vendor: 'late' }, usage: { calls: 1 } };
  assert.equal(ledger.confirm(key, receipt).duplicate, false);
  assert.equal(ledger.confirm(key, receipt).duplicate, true);
  assert.equal(store.get<{ reserved: number }>(`SELECT reserved FROM web_external_budgets
    WHERE provider='synthetic-local' AND stage='text' AND phase='draft'`)!.reserved, 0);
  assert.equal(store.get<{ status: string }>(
    'SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status, 'failed');
});
