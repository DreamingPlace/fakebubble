import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { Store, WebStore } from '../../../apps/server/store.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';

const CHARACTER = 'fixture-character';
const IP = 'a'.repeat(64);
const worker = fileURLToPath(new URL('./web-admission-worker.ts', import.meta.url));
const raceWorker = fileURLToPath(new URL('./web-create-race-worker.mjs', import.meta.url));
const count = (store: WebStore, table: string) => store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n;
const plain = <T extends object>(row: T | undefined): T | undefined => row && { ...row };
const files = (root: string) => Object.fromEntries(readdirSync(root).sort().map(name => {
  const path = join(root, name);
  return [name, { bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }];
}));

function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-s2-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web'), instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  let now = 1_700_000_000_000;
  const admission = new WebAdmission(store, { now: () => now }, randomUUID);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', CHARACTER, 1, '{}');
  function guest(name: string) {
    const playerId = `player-${name}`, worldId = `world-${name}`, principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, CHARACTER);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return principalId;
  }
  return { parent, root, instanceId, store, admission, guest, now: () => now, advance: (ms: number) => { now += ms; } };
}

type ChildResult = { ok: boolean; result?: { operationId?: string; duplicate?: boolean; instanceId?: string }; error?: string };
async function concurrent(inputs: string[][]): Promise<ChildResult[]> {
  const children = inputs.map(args => spawn(process.execPath, [worker, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const results = children.map(child => new Promise<ChildResult>((resolve, reject) => {
    let output = '', error = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`worker exit ${code}: ${error}`));
      else try { resolve(JSON.parse(output) as ChildResult); } catch { reject(new Error(`bad worker output: ${output}; ${error}`)); }
    });
  }));
  for (const child of children) child.stdin.end('go\n');
  return Promise.all(results);
}

test('C-S2 store rejects wrong schema, identity and path aliases without changing existing bytes', t => {
  const f = fixture(t), db = join(f.root, 'web.sqlite');
  const digest = () => createHash('sha256').update(readFileSync(db)).digest('hex');
  const before = digest();
  assert.throws(() => new WebStore(f.root, { create: false, instanceId: randomUUID() }), /WEB_INSTANCE_MISMATCH/);
  const alias = join(f.parent, 'alias'); symlinkSync(f.root, alias, 'dir');
  assert.throws(() => new WebStore(alias, { create: false, instanceId: f.instanceId }), /WEB_UNSAFE_PATH/);
  const hardlinkRoot = join(f.parent, 'hardlink'); mkdirSync(hardlinkRoot);
  linkSync(db, join(hardlinkRoot, 'web.sqlite'));
  assert.throws(() => new WebStore(hardlinkRoot, { create: false, instanceId: f.instanceId }), /WEB_UNSAFE_PATH/);
  assert.throws(() => new Store(db), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.throws(() => new Store(db, { beta: true }), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.equal(digest(), before);
});

test('C-S2 denied wrong-instance reopen must not create database companions (WEB-C-004)', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-companions-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web'), id = randomUUID();
  new WebStore(root, { create: true, instanceId: id }).close();
  const before = files(root);
  assert.throws(() => new WebStore(root, { create: false, instanceId: randomUUID() }), /WEB_INSTANCE_MISMATCH/);
  assert.deepEqual(files(root), before, 'wrong web instanceId must not create WAL/SHM companions');
});

test('C-S2 denied ordinary Store mode must not create database companions (WEB-C-004)', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-wrong-mode-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web');
  new WebStore(root, { create: true, instanceId: randomUUID() }).close();
  const before = files(root);
  assert.throws(() => new Store(join(root, 'web.sqlite')), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.throws(() => new Store(join(root, 'web.sqlite'), { beta: true }), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.throws(() => new Store(join(root, 'other.sqlite')), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.deepEqual(files(root), before, 'wrong Store mode must not create WAL/SHM companions');
});

test('C-S2 denied wrong instance with active WAL leaves existing companions intact (WEB-C-004)', t => {
  const f = fixture(t), before = files(f.root);
  assert.ok('web.sqlite-wal' in before && 'web.sqlite-shm' in before, 'active WAL precondition');
  assert.throws(() => new WebStore(f.root, { create: false, instanceId: randomUUID() }), /WEB_INSTANCE_MISMATCH/);
  assert.throws(() => new Store(join(f.root, 'web.sqlite')), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.throws(() => new Store(join(f.root, 'web.sqlite'), { beta: true }), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.throws(() => new Store(join(f.root, 'other.sqlite')), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  const after = files(f.root);
  assert.deepEqual(after, before, 'wrong caller ID/mode must not touch active WAL or sidecars');
});

test('C-S2 missing, malformed and initializing markers fail before touching a closed database', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-marker-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web'), id = randomUUID();
  new WebStore(root, { create: true, instanceId: id }).close();
  const markerPath = join(root, '.web-instance.json');
  const ready = readFileSync(markerPath, 'utf8');
  const cases: Array<{ label: string; change: () => void; code: RegExp }> = [
    { label: 'missing', change: () => unlinkSync(markerPath), code: /WEB_MARKER_MISSING/ },
    { label: 'malformed', change: () => writeFileSync(markerPath, '{bad', { mode: 0o600 }), code: /WEB_MARKER_INVALID/ },
    { label: 'initializing', change: () => writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(ready), state: 'initializing' })), code: /WEB_INSTANCE_INITIALIZING/ },
    { label: 'unsafe permissions', change: () => chmodSync(markerPath, 0o644), code: /WEB_MARKER_INVALID/ },
  ];
  for (const { label, change, code } of cases) {
    writeFileSync(markerPath, ready, { mode: 0o600 });
    chmodSync(markerPath, 0o600);
    change();
    const before = files(root);
    assert.throws(() => new WebStore(root, { create: false, instanceId: id }), code, label);
    assert.deepEqual(files(root), before, `${label} rejection must not create sidecars`);
  }
  writeFileSync(markerPath, ready, { mode: 0o600 });
  chmodSync(markerPath, 0o600);
  new WebStore(root, { create: false, instanceId: id }).close();
});

test('C-S2 matching ready marker cannot authorize mismatched database identity', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-marker-db-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web'), id = randomUUID();
  new WebStore(root, { create: true, instanceId: id }).close();
  const dbPath = join(root, 'web.sqlite');
  const db = new DatabaseSync(dbPath);
  try { db.prepare('UPDATE web_instance SET instance_id=?').run(randomUUID()); }
  finally { db.close(); }
  const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  assert.throws(() => new WebStore(root, { create: false, instanceId: id }), /WEB_INSTANCE_MISMATCH/);
  assert.equal(createHash('sha256').update(readFileSync(dbPath)).digest('hex'), before);
  // This is a DB-integrity diagnostic after a valid marker, not the C-004
  // zero-side-effect guarantee for an incorrect caller ID or mode.
});

test('C-S2 protected ancestor refuses new web root without creating it', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-protected-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  writeFileSync(join(parent, 'accepted-release.json'), '{}');
  const blocked = join(parent, 'new-web');
  assert.throws(() => new WebStore(blocked, { create: true, instanceId: randomUUID() }), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.equal(existsSync(blocked), false);
});

test('C-S2 concurrent create permits one identity only, without silent replacement', async t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-create-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web'), ids = [randomUUID(), randomUUID()];
  const results = await concurrent(ids.map(id => ['create', root, id]));
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  const winner = ids[results.findIndex(result => result.ok)]!;
  const reopened = new WebStore(root, { create: false, instanceId: winner });
  try { assert.equal(reopened.get<{ instance_id: string }>('SELECT instance_id FROM web_instance')?.instance_id, winner); }
  finally { reopened.close(); }
  assert.throws(() => new WebStore(root, { create: false, instanceId: ids.find(id => id !== winner)! }), /WEB_INSTANCE_MISMATCH/);
});

test('C-S2 two creators past both preflight gates must not claim one instance identity (A-WEB-003)', { timeout: 25_000 }, async t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-create-race-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web'), flags = join(parent, 'gates'); mkdirSync(flags);
  const ids = [randomUUID(), randomUUID()];
  function child(name: string, id: string) {
    const process = spawn(globalThis.process.execPath, [raceWorker, root, id, flags, name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    process.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    process.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; });
    const done = new Promise<{ ok: boolean; requested: string; actual?: string; error?: string }>((resolve, reject) => {
      process.once('error', reject);
      process.once('close', code => {
        if (code !== 0) reject(new Error(`race worker exit ${code}: ${error}`));
        else try { resolve(JSON.parse(output) as { ok: boolean; requested: string; actual?: string; error?: string }); }
        catch { reject(new Error(`bad race worker output: ${output}; ${error}`)); }
      });
    });
    return { process, done };
  }
  const a = child('a', ids[0]!), b = child('b', ids[1]!);
  t.after(() => { for (const actor of [a, b]) if (actor.process.exitCode === null) actor.process.kill('SIGTERM'); });
  async function waitFor(names: string[]) {
    // A corrected initializer may serialize before a gate; release the first
    // actor after a bounded wait rather than turning a successful fix into a hang.
    const deadline = Date.now() + 3_000;
    while (!names.every(name => existsSync(join(flags, name)))) {
      if (Date.now() > deadline) return false;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    return true;
  }
  await waitFor(['mkdir-a', 'mkdir-b']);
  writeFileSync(join(flags, 'release-mkdir'), 'go');
  const bothAtWal = await waitFor(['wal-a', 'wal-b']);
  writeFileSync(join(flags, 'release-wal-a'), 'go');
  if (bothAtWal) await a.done;
  writeFileSync(join(flags, 'release-wal-b'), 'go');
  const [first, second] = await Promise.all([a.done, b.done]);
  const successes = [first, second].filter(result => result.ok);
  assert.equal(successes.length, 1, `exactly one creator may succeed: ${JSON.stringify({ first, second })}`);
  const winner = successes[0]!;
  assert.equal(winner.actual, winner.requested, `winning creator received the wrong instance: ${JSON.stringify({ first, second })}`);
  const reopened = new WebStore(root, { create: false, instanceId: winner.requested });
  try { assert.equal(reopened.get<{ instance_id: string }>('SELECT instance_id FROM web_instance')?.instance_id, winner.requested); }
  finally { reopened.close(); }
  const loser = [first, second].find(result => !result.ok)!;
  assert.throws(() => new WebStore(root, { create: false, instanceId: loser.requested }), /WEB_INSTANCE_MISMATCH/);
});

test('C-S2 concurrent guests share three IP slots but preserve private world/input ownership', async t => {
  const f = fixture(t), guests = ['a', 'b', 'c', 'd'].map(f.guest);
  const results = await concurrent(guests.map((principal, i) => ['admit', f.root, f.instanceId, principal, `r${i}`, `合成输入${i}`, IP]));
  assert.equal(results.filter(result => result.ok).length, 3, JSON.stringify(results));
  assert.equal(results.filter(result => result.error?.includes('TRIAL_EXHAUSTED')).length, 1, JSON.stringify(results));
  assert.equal(count(f.store, 'web_operations'), 3);
  assert.equal(count(f.store, 'messages'), 3);
  assert.equal(count(f.store, 'outbox'), 3);
  assert.deepEqual(plain(f.store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE ip_hash=?', IP)),
    { used: 0, reserved: 3 });
  for (const principal of guests) {
    const rows = f.store.all<{ principal_id: string; world_id: string; input_message_id: string }>(
      'SELECT principal_id,world_id,input_message_id FROM web_operations WHERE principal_id=?', principal);
    for (const row of rows) {
      assert.equal(row.principal_id, principal);
      assert.equal(f.store.get<{ world_id: string }>('SELECT world_id FROM messages WHERE id=?', row.input_message_id)?.world_id, row.world_id);
    }
  }
});

test('C-S2 concurrent same request returns one receipt and one input; mismatched payload conflicts', async t => {
  const f = fixture(t), principal = f.guest('idempotent');
  const inputs = Array.from({ length: 2 }, () => ['admit', f.root, f.instanceId, principal, 'same-id', '同一内容', IP]);
  const results = await concurrent(inputs);
  assert.equal(results.filter(result => result.ok).length, 2, JSON.stringify(results));
  assert.equal(results[0]?.result?.operationId, results[1]?.result?.operationId);
  assert.deepEqual(results.map(result => result.result?.duplicate).sort(), [false, true]);
  assert.equal(count(f.store, 'web_operations'), 1);
  assert.equal(count(f.store, 'messages'), 1);
  const conflict = await concurrent([['admit', f.root, f.instanceId, principal, 'same-id', '不同内容', IP]]);
  assert.match(conflict[0]?.error ?? '', /IDEMPOTENCY_CONFLICT/);
  assert.equal(count(f.store, 'web_operations'), 1);
});

test('C-S2 reboot reuses admission receipt and principal limit despite an IP change', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-reboot-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web'), instanceId = randomUUID();
  let store = new WebStore(root, { create: true, instanceId });
  const now = 1_700_000_000_000, principalId = 'principal-reboot';
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', CHARACTER, 1, '{}');
  store.transaction(() => {
    store.run('INSERT INTO api_players VALUES (?,?)', 'player-reboot', now);
    store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world-reboot', 'player-reboot', 'Asia/Singapore', '{}');
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", 'world-reboot', CHARACTER);
  });
  let admission = new WebAdmission(store, { now: () => now }, randomUUID);
  admission.registerGuest({ principalId, playerId: 'player-reboot', worldId: 'world-reboot' });
  const input = { principalId, requestId: 'first', characterId: CHARACTER, text: '首轮', ipHash: IP };
  const original = admission.admit(input);
  store.close();
  store = new WebStore(root, { create: false, instanceId });
  try {
    admission = new WebAdmission(store, { now: () => now + 1 }, randomUUID);
    assert.deepEqual(admission.admit({ ...input, ipHash: 'b'.repeat(64) }), { ...original, duplicate: true });
    admission.admit({ ...input, requestId: 'second', ipHash: 'b'.repeat(64) });
    admission.admit({ ...input, requestId: 'third', ipHash: 'c'.repeat(64) });
    assert.throws(() => admission.admit({ ...input, requestId: 'fourth', ipHash: 'd'.repeat(64) }), /TRIAL_EXHAUSTED/);
    assert.equal(count(store, 'web_operations'), 3);
    assert.equal(count(store, 'messages'), 3);
  } finally { store.close(); }
});

test('C-S2 cross-world guest registration is refused before creating a principal', t => {
  const f = fixture(t), a = f.guest('owner-a'), b = f.guest('owner-b');
  assert.throws(() => f.admission.registerGuest({ principalId: 'cross', playerId: 'player-owner-a', worldId: 'world-owner-b' }),
    /WEB_WORLD_OWNER_MISMATCH/);
  assert.equal(f.store.get('SELECT 1 FROM web_principals WHERE id=?', 'cross'), undefined);
  assert.equal(count(f.store, 'web_principals'), 2);
  assert.notEqual(a, b);
});

test('C-S2 full global queue rejects without locking a new guest or creating a window', t => {
  const f = fixture(t);
  for (let i = 0; i < WEB_LIMITS.maxGlobalReservedOperations; i++) {
    const principalId = f.guest(`queued-${i}`);
    f.admission.admit({ principalId, requestId: `queued-${i}`, characterId: CHARACTER, text: '排队',
      ipHash: i.toString(16).padStart(64, '0') });
  }
  const next = f.guest('overflow'), windows = count(f.store, 'web_ip_windows');
  assert.throws(() => f.admission.admit({ principalId: next, requestId: 'overflow', characterId: CHARACTER, text: '不应接纳',
    ipHash: 'f'.repeat(64) }), /QUEUE_FULL/);
  assert.equal(count(f.store, 'web_ip_windows'), windows);
  assert.equal(count(f.store, 'web_operations'), WEB_LIMITS.maxGlobalReservedOperations);
  assert.equal(f.store.get('SELECT 1 FROM messages WHERE world_id=?', 'world-overflow'), undefined);
  assert.deepEqual(plain(f.store.get<{ trial_character_id: string | null; trial_reserved: number }>(
    'SELECT trial_character_id,trial_reserved FROM web_principals WHERE id=?', next)),
  { trial_character_id: null, trial_reserved: 0 });
});

test('C-S2 late SQL failure rolls back lock, original window, conversation, message and outbox', t => {
  const f = fixture(t), principal = f.guest('rollback');
  f.store.db.exec("CREATE TRIGGER c_fail_operation BEFORE INSERT ON web_operations BEGIN SELECT RAISE(ABORT, 'c_synthetic_abort'); END;");
  assert.throws(() => f.admission.admit({ principalId: principal, requestId: 'r1', characterId: CHARACTER, text: '合成输入', ipHash: IP }),
    /c_synthetic_abort/);
  for (const table of ['web_ip_windows', 'web_operations', 'conversations', 'messages', 'outbox']) assert.equal(count(f.store, table), 0, table);
  assert.deepEqual(plain(f.store.get<{ trial_character_id: string | null; trial_reserved: number }>(
    'SELECT trial_character_id,trial_reserved FROM web_principals WHERE id=?', principal)),
  { trial_character_id: null, trial_reserved: 0 });
});

test('C-S2 terminal release after rollover affects only the original window', t => {
  const f = fixture(t), firstGuest = f.guest('old'), secondGuest = f.guest('new');
  const first = f.admission.admit({ principalId: firstGuest, requestId: 'old', characterId: CHARACTER, text: '旧窗口', ipHash: IP });
  const oldWindow = f.store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', first.operationId)!.ip_window_id;
  f.advance(WEB_LIMITS.ipWindowMs);
  const second = f.admission.admit({ principalId: secondGuest, requestId: 'new', characterId: CHARACTER, text: '新窗口', ipHash: IP });
  const newWindow = f.store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', second.operationId)!.ip_window_id;
  assert.notEqual(oldWindow, newWindow);
  assert.deepEqual(f.admission.finalize(first.operationId, 'cancelled'), { status: 'cancelled', duplicate: false });
  assert.deepEqual(f.admission.finalize(first.operationId, 'cancelled'), { status: 'cancelled', duplicate: true });
  assert.deepEqual(plain(f.store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', oldWindow)),
    { used: 0, reserved: 0 });
  assert.deepEqual(plain(f.store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', newWindow)),
    { used: 0, reserved: 1 });
});

test('C-S2 inside-deadline publication stays closed across IP rollover, then releases original window', t => {
  const f = fixture(t), seed = f.guest('seed'), old = f.guest('old'), fresh = f.guest('fresh');
  const seedReceipt = f.admission.admit({ principalId: seed, requestId: 'seed', characterId: CHARACTER, text: '建立窗口', ipHash: IP });
  f.admission.finalize(seedReceipt.operationId, 'cancelled');
  f.advance(WEB_LIMITS.ipWindowMs - 1000);
  const oldReceipt = f.admission.admit({ principalId: old, requestId: 'old', characterId: CHARACTER, text: '接近边界', ipHash: IP });
  const oldWindow = f.store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', oldReceipt.operationId)!.ip_window_id;
  f.advance(1001);
  const newReceipt = f.admission.admit({ principalId: fresh, requestId: 'new', characterId: CHARACTER, text: '新窗口', ipHash: IP });
  const newWindow = f.store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', newReceipt.operationId)!.ip_window_id;
  assert.notEqual(oldWindow, newWindow);
  f.store.run("UPDATE web_operations SET status='ready_to_publish' WHERE id=?", oldReceipt.operationId);
  f.store.db.exec('CREATE TABLE c_publish_marker(x INTEGER)');
  const unsafeCall = f.admission.finalize.bind(f.admission) as (...args: unknown[]) => unknown;
  assert.throws(() => unsafeCall(oldReceipt.operationId, 'published', () => {
    f.store.run('INSERT INTO c_publish_marker(x) VALUES (1)');
  }), /WEB_PUBLICATION_NOT_READY/);
  assert.equal(count(f.store, 'c_publish_marker'), 0);
  assert.deepEqual(f.admission.finalize(oldReceipt.operationId, 'cancelled'), { status: 'cancelled', duplicate: false });
  assert.deepEqual(plain(f.store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', oldWindow)),
    { used: 0, reserved: 0 });
  assert.deepEqual(plain(f.store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', newWindow)),
    { used: 0, reserved: 1 });
});

test('C-S2 expired operation must not publish or charge a successful trial round (A-WEB-001)', t => {
  const f = fixture(t), principal = f.guest('deadline');
  const receipt = f.admission.admit({ principalId: principal, requestId: 'deadline', characterId: CHARACTER, text: '临界', ipHash: IP });
  const deadline = f.store.get<{ deadline_at: number }>('SELECT deadline_at FROM web_operations WHERE id=?', receipt.operationId)!.deadline_at;
  f.store.run("UPDATE web_operations SET status='ready_to_publish' WHERE id=?", receipt.operationId);
  f.advance(deadline - f.now() + 1);
  let called = false;
  const unsafeCall = f.admission.finalize.bind(f.admission) as (...args: unknown[]) => unknown;
  try { unsafeCall(receipt.operationId, 'published', () => { called = true; }); } catch { /* rejection is acceptable */ }
  const operation = f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', receipt.operationId);
  const window = f.store.get<{ used: number }>('SELECT used FROM web_ip_windows WHERE ip_hash=?', IP);
  assert.deepEqual({ published: operation?.status === 'published', used: window?.used, called },
    { published: false, used: 0, called: false });
  assert.deepEqual(f.admission.finalize(receipt.operationId, 'failed'), { status: 'failed', duplicate: false });
  assert.deepEqual(plain(f.store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE ip_hash=?', IP)),
    { used: 0, reserved: 0 });
});

test('C-S2 async publication must not settle quota or write after transaction (A-WEB-002)', async t => {
  const f = fixture(t), principal = f.guest('async');
  const receipt = f.admission.admit({ principalId: principal, requestId: 'async', characterId: CHARACTER, text: '临界', ipHash: IP });
  f.store.run("UPDATE web_operations SET status='ready_to_publish' WHERE id=?", receipt.operationId);
  f.store.db.exec('CREATE TABLE c_late_probe(x INTEGER)');
  let release!: () => void, invoked = false, error: unknown;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const publish = async () => {
    invoked = true;
    await gate;
    f.store.run('INSERT INTO c_late_probe(x) VALUES (1)');
  };
  const unsafeCall = f.admission.finalize.bind(f.admission) as (...args: unknown[]) => unknown;
  try { unsafeCall(receipt.operationId, 'published', publish); }
  catch (caught) { error = caught; }
  const beforeRelease = f.store.get<{ status: string; quota_state: string }>('SELECT status,quota_state FROM web_operations WHERE id=?', receipt.operationId);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual({ rejected: Boolean(error), beforeRelease: plain(beforeRelease), invoked, lateWrites: count(f.store, 'c_late_probe') },
    { rejected: true, beforeRelease: { status: 'ready_to_publish', quota_state: 'reserved' }, invoked: false, lateWrites: 0 });
});
