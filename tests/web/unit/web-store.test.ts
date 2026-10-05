import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { Store, WebStore } from '../../../apps/server/store.ts';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = (root: string) => readdirSync(root).sort().map(name => [name, digest(join(root, name))]);

test('web store initializes only an explicit new root and reopens the same instance', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-store-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance');
  const instanceId = randomUUID();
  const created = new WebStore(root, { create: true, instanceId });
  const marker = JSON.parse(readFileSync(join(root, '.web-instance.json'), 'utf8'));
  assert.deepEqual(marker, { format: 1, mode: 'web', instanceId, database: 'web.sqlite', state: 'ready' });
  assert.equal(created.web, true);
  assert.equal(created.beta, false);
  assert.equal(created.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 100);
  assert.equal(created.get<{ instance_id: string }>('SELECT instance_id FROM web_instance')?.instance_id, instanceId);
  assert.equal(created.get('SELECT 1 FROM sqlite_master WHERE name=?', 'beta_accounts'), undefined);
  created.close();

  const reopened = new WebStore(root, { create: false, instanceId });
  assert.equal(reopened.get<{ instance_id: string }>('SELECT instance_id FROM web_instance')?.instance_id, instanceId);
  reopened.close();
  assert.throws(() => new WebStore(root, { create: true, instanceId }), /WEB_INSTANCE_ALREADY_EXISTS/);
});

test('schema101 and 102 are explicit, survive reopen and roll back interrupted migration', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-stage-migration-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), id = randomUUID();
  const store = new WebStore(root, { create: true, instanceId: id });
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 100);
  store.migrateStages();
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101);
  assert.throws(() => store.migrateStages(), /WEB_STAGE_MIGRATION_REQUIRED/);
  store.close();
  const reopened = new WebStore(root, { create: false, instanceId: id });
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101);
  reopened.migrateAdmissionOrder();
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 102);
  assert.throws(() => reopened.migrateAdmissionOrder(), /WEB_ADMISSION_ORDER_MIGRATION_REQUIRED/);
  reopened.close();
  const reopenedAgain = new WebStore(root, { create: false, instanceId: id });
  assert.equal(reopenedAgain.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 102);
  reopenedAgain.close();
  assert.throws(() => new Store(join(root, 'web.sqlite')), /WEB_SEPARATE_INSTANCE_REQUIRED/);

  const brokenRoot = join(parent, 'broken'), brokenId = randomUUID();
  const broken = new WebStore(brokenRoot, { create: true, instanceId: brokenId });
  broken.db.exec('CREATE TABLE web_scheduler_state(x INTEGER)');
  assert.throws(() => broken.migrateStages());
  assert.equal(broken.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 100);
  assert.equal(broken.get<{ name: string }>("SELECT name FROM pragma_table_info('web_operations') WHERE name='stage_version'"), undefined);
  broken.close();

  const orderRoot = join(parent, 'broken-order'), orderId = randomUUID();
  const order = new WebStore(orderRoot, { create: true, instanceId: orderId });
  order.migrateStages();
  order.db.exec('CREATE TABLE web_admission_counter(x INTEGER)');
  assert.throws(() => order.migrateAdmissionOrder());
  assert.equal(order.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101);
  assert.equal(order.get<{ name: string }>("SELECT name FROM pragma_table_info('web_operations') WHERE name='admission_seq'"), undefined);
  order.close();
});

test('two creators that both saw a missing root cannot claim different instance IDs', async t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-store-create-race-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance');
  const ids = [randomUUID(), randomUUID()];
  const barrier = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const originalExists = fs.existsSync;
    const barrier = new Int32Array(workerData.barrier);
    fs.existsSync = function(path) {
      if (path === workerData.root) {
        const result = originalExists(path);
        Atomics.add(barrier, 0, 1);
        Atomics.wait(barrier, 1, 0, 10000);
        return result;
      }
      return originalExists(path);
    };
    require('node:module').syncBuiltinESMExports();
    (async () => {
      const { WebStore } = await import(workerData.moduleUrl);
      try {
        const store = new WebStore(workerData.root, { create: true, instanceId: workerData.id });
        const actual = store.get('SELECT instance_id FROM web_instance').instance_id;
        store.close();
        parentPort.postMessage({ ok: true, requested: workerData.id, actual });
      } catch (error) { parentPort.postMessage({ ok: false, code: error.code, message: error.message }); }
    })().catch(error => parentPort.postMessage({ ok: false, message: error.message }));
  `;
  const workers = ids.map(id => new Worker(script, { eval: true, workerData: {
    root, id, barrier: barrier.buffer, moduleUrl: new URL('../../../apps/server/store.ts', import.meta.url).href,
  } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const results = workers.map(worker => new Promise<{ ok: boolean; requested?: string; actual?: string; code?: string; message?: string }>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  }));
  const until = Date.now() + 10000;
  while (Atomics.load(barrier, 0) < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(Atomics.load(barrier, 0), 2, 'both creators reached the missing-root check');
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, 2);
  const settled = await Promise.all(results);
  assert.deepEqual(settled.map(result => result.ok).sort(), [false, true]);
  assert.equal(settled.find(result => result.ok)?.actual, settled.find(result => result.ok)?.requested);
  assert.equal(settled.find(result => !result.ok)?.code, 'WEB_INSTANCE_ALREADY_EXISTS');
});

test('web store rejects original, beta, wrong identity and symlink aliases before writing', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-store-isolation-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const id = randomUUID();
  for (const mode of ['original', 'beta'] as const) {
    const root = join(parent, mode);
    const legacy = new Store(join(root, 'state.sqlite'), { beta: mode === 'beta' });
    legacy.close();
    renameSync(join(root, 'state.sqlite'), join(root, 'web.sqlite'));
    const path = join(root, 'web.sqlite'), before = digest(path);
    assert.throws(() => new WebStore(root, { create: false, instanceId: id }), /WEB_MARKER_MISSING/);
    assert.equal(digest(path), before);
    assert.throws(() => new WebStore(root, { create: true, instanceId: id }), /WEB_INSTANCE_ALREADY_EXISTS/);
    assert.equal(digest(path), before);
  }

  const root = join(parent, 'web');
  new WebStore(root, { create: true, instanceId: id }).close();
  const path = join(root, 'web.sqlite'), before = digest(path);
  const beforeFiles = files(root);
  assert.throws(() => new WebStore(root, { create: false, instanceId: randomUUID() }), /WEB_INSTANCE_MISMATCH/);
  assert.deepEqual(files(root), beforeFiles);
  assert.throws(() => new Store(path), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.throws(() => new Store(path, { beta: true }), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.throws(() => new Store(join(root, 'other.sqlite')), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.deepEqual(files(root), beforeFiles);
  assert.equal(digest(path), before);

  const alias = join(parent, 'alias');
  symlinkSync(root, alias, 'dir');
  assert.throws(() => new WebStore(alias, { create: false, instanceId: id }), /WEB_UNSAFE_PATH/);
  assert.equal(digest(path), before);
  assert.ok(readdirSync(root).includes('web.sqlite'));

  const unknownRoot = join(parent, 'unknown');
  const unknownPath = join(unknownRoot, 'web.sqlite');
  const unknown = new Store(join(unknownRoot, 'state.sqlite'));
  unknown.close();
  renameSync(join(unknownRoot, 'state.sqlite'), unknownPath);
  const probe = new DatabaseSync(unknownPath);
  probe.exec('PRAGMA user_version = 100');
  probe.close();
  const unknownBefore = digest(unknownPath);
  assert.throws(() => new WebStore(unknownRoot, { create: false, instanceId: id }), /WEB_MARKER_MISSING/);
  assert.equal(digest(unknownPath), unknownBefore);
});

test('web marker rejects incomplete and malformed roots before SQLite opens', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-marker-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), id = randomUUID();
  new WebStore(root, { create: true, instanceId: id }).close();
  const path = join(root, '.web-instance.json');
  const ready = readFileSync(path, 'utf8'), before = digest(join(root, 'web.sqlite'));
  unlinkSync(path);
  assert.throws(() => new WebStore(root, { create: false, instanceId: id }), /WEB_MARKER_MISSING/);
  assert.throws(() => new Store(join(root, 'web.sqlite')), /WEB_MARKER_MISSING/);
  writeFileSync(path, ready, { mode: 0o600 });
  writeFileSync(path, '{broken');
  assert.throws(() => new WebStore(root, { create: false, instanceId: id }), /WEB_MARKER_INVALID/);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(ready), state: 'initializing' }));
  assert.throws(() => new WebStore(root, { create: false, instanceId: id }), /WEB_INSTANCE_INITIALIZING/);
  writeFileSync(path, ready);
  chmodSync(path, 0o644);
  assert.throws(() => new WebStore(root, { create: false, instanceId: id }), /WEB_MARKER_INVALID/);
  chmodSync(path, 0o600);
  assert.equal(digest(join(root, 'web.sqlite')), before);
  assert.deepEqual(readdirSync(root).sort(), ['.web-instance.json', 'web.sqlite']);
});

test('wrong caller identity and mode do not touch active WAL or sidecars', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-marker-active-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), id = randomUUID();
  const active = new WebStore(root, { create: true, instanceId: id });
  t.after(() => active.close());
  const before = files(root);
  assert.throws(() => new WebStore(root, { create: false, instanceId: randomUUID() }), /WEB_INSTANCE_MISMATCH/);
  assert.throws(() => new Store(join(root, 'web.sqlite')), /WEB_SEPARATE_INSTANCE_REQUIRED/);
  assert.deepEqual(files(root), before);
});

test('marker is only a preflight: matching marker cannot authorize a mismatched database', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-marker-db-mismatch-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), id = randomUUID();
  new WebStore(root, { create: true, instanceId: id }).close();
  const db = new DatabaseSync(join(root, 'web.sqlite'));
  db.prepare('UPDATE web_instance SET instance_id=?').run(randomUUID());
  db.close();
  const before = digest(join(root, 'web.sqlite'));
  assert.throws(() => new WebStore(root, { create: false, instanceId: id }), /WEB_INSTANCE_MISMATCH/);
  assert.equal(digest(join(root, 'web.sqlite')), before);
});

test('marker I/O failures preserve a non-adopted root until the durable ready switch', async t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-marker-fault-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const original = fs.fsyncSync;
    let count = 0;
    fs.fsyncSync = function(fd) {
      count++;
      if (count === workerData.failAt) throw Error('INJECTED_FSYNC_' + count);
      return original(fd);
    };
    require('node:module').syncBuiltinESMExports();
    (async () => {
      const { WebStore } = await import(workerData.moduleUrl);
      try { const store = new WebStore(workerData.root, { create: true, instanceId: workerData.id }); store.close();
        parentPort.postMessage({ ok: true, count }); }
      catch (error) { parentPort.postMessage({ ok: false, count, message: error.message }); }
    })().catch(error => parentPort.postMessage({ ok: false, count, message: error.message }));
  `;
  for (const failAt of [1, 2, 5, 7, 8]) {
    const root = join(parent, `instance-${failAt}`), id = randomUUID();
    const worker = new Worker(script, { eval: true, workerData: {
      root, id, failAt, moduleUrl: new URL('../../../apps/server/store.ts', import.meta.url).href,
    } });
    const result = await new Promise<{ ok: boolean; count: number; message?: string }>((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    await worker.terminate();
    assert.equal(result.ok, false);
    assert.equal(result.count, failAt);
    assert.equal(result.message, `INJECTED_FSYNC_${failAt}`);
    assert.ok(readdirSync(root).length > 0 || failAt === 1, 'failed root remains for inspection');
    if (failAt < 8) assert.throws(() => new WebStore(root, { create: false, instanceId: id }));
    else {
      // The final directory sync failed after the atomic rename. If ready survived,
      // all DB and marker contents had already been flushed and identity still checks.
      const reopened = new WebStore(root, { create: false, instanceId: id });
      reopened.close();
    }
  }
});
