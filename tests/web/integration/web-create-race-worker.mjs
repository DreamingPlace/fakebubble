import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// C-only scheduler: pause two actual processes after preflight and after both
// see schema 0. Never patch product files or alter a real instance.
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const [root, instanceId, flags, name] = process.argv.slice(2);
if (!root || !instanceId || !flags || !name) throw new Error('race arguments missing');
const pause = new Int32Array(new SharedArrayBuffer(4));
function wait(file) {
  const deadline = Date.now() + 12_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`gate timeout: ${file}`);
    Atomics.wait(pause, 0, 0, 5);
  }
}
const mkdir = fs.mkdirSync;
fs.mkdirSync = function (path, ...args) {
  if (path === root) {
    fs.writeFileSync(`${flags}/mkdir-${name}`, 'ready');
    wait(`${flags}/release-mkdir`);
  }
  return mkdir.call(this, path, ...args);
};
syncBuiltinESMExports();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;') {
    fs.writeFileSync(`${flags}/wal-${name}`, 'zero-checked');
    wait(`${flags}/release-wal-${name}`);
  }
  return exec.call(this, sql);
};
try {
  const { WebStore } = await import('../../../apps/server/platform/store.ts');
  const store = new WebStore(root, { create: true, instanceId });
  const actual = store.get('SELECT instance_id FROM web_instance').instance_id;
  store.close();
  process.stdout.write(JSON.stringify({ ok: true, requested: instanceId, actual }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, requested: instanceId, error: String(error) }));
}
