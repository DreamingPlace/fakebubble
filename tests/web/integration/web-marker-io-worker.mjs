import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const [root, instanceId, failAt = 'none'] = process.argv.slice(2);
const events = [];
const opened = new Map();
let fsyncCount = 0;

const mkdir = fs.mkdirSync;
fs.mkdirSync = function (path, options) {
  events.push({ event: 'mkdir', path: String(path) });
  return mkdir(path, options);
};
const open = fs.openSync;
fs.openSync = function (path, ...args) {
  const fd = open(path, ...args);
  opened.set(fd, String(path));
  return fd;
};
const close = fs.closeSync;
fs.closeSync = function (fd) {
  opened.delete(fd);
  return close(fd);
};
const fsync = fs.fsyncSync;
fs.fsyncSync = function (fd) {
  fsyncCount++;
  let path = opened.get(fd);
  if (!path) try { path = fs.readlinkSync(`/dev/fd/${fd}`); } catch { path = '<unknown>'; }
  events.push({ event: 'fsync', path, ordinal: fsyncCount });
  if (failAt === `fsync:${fsyncCount}`) throw new Error(`INJECTED_FSYNC_${fsyncCount}`);
  return fsync(fd);
};
const write = fs.writeFileSync;
fs.writeFileSync = function (path, data, options) {
  if (String(path).includes('.web-instance.json')) {
    const state = String(path).endsWith('.ready') ? 'ready-temp' : 'initializing';
    events.push({ event: 'marker-write', state, flush: options?.flush === true });
    if (failAt === `write:${state}`) throw new Error(`INJECTED_WRITE_${state}`);
  }
  return write(path, data, options);
};
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  events.push({ event: 'rename', from: String(from), to: String(to) });
  if (failAt === 'rename') throw new Error('INJECTED_RENAME');
  return rename(from, to);
};
syncBuiltinESMExports();

const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'COMMIT') events.push({ event: 'commit' });
  if (String(sql).includes('PRAGMA synchronous = FULL')) events.push({ event: 'sqlite-full' });
  return exec.call(this, sql);
};
const dbClose = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function () {
  events.push({ event: 'db-close' });
  return dbClose.call(this);
};

try {
  const { WebStore } = await import('../../../apps/server/store.ts');
  const store = new WebStore(root, { create: true, instanceId });
  store.close();
  process.stdout.write(JSON.stringify({ ok: true, fsyncCount, events }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message, fsyncCount, events }));
}
