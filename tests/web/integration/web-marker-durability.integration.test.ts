import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebStore } from '../../../apps/server/store.ts';

const worker = fileURLToPath(new URL('./web-marker-io-worker.mjs', import.meta.url));
type Event = { event: string; path?: string; ordinal?: number; state?: string; flush?: boolean };
type Result = { ok: boolean; error?: string; fsyncCount: number; events: Event[] };

function run(root: string, id: string, fault = 'none'): Promise<Result> {
  const child = spawn(process.execPath, [worker, root, id, fault], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '',
      error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      error += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`marker worker exit ${code}: ${error}`));
      else
        try {
          resolve(JSON.parse(output) as Result);
        } catch {
          reject(new Error(`marker worker output ${output}; ${error}`));
        }
    });
  });
}

test('C R4 marker durable operations precede ready rename in the observed JS/SQLite call sequence', async (t) => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-marker-order-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'web'),
    id = randomUUID();
  const result = await run(root, id);
  assert.equal(result.ok, true, JSON.stringify(result));
  const sequence = result.events.filter((item) =>
    ['mkdir', 'marker-write', 'sqlite-full', 'commit', 'fsync', 'rename'].includes(item.event),
  );
  const names = sequence.map((item) =>
    item.event === 'marker-write'
      ? `${item.event}:${item.state}`
      : item.event === 'fsync'
        ? `${item.event}:${item.ordinal}`
        : item.event,
  );
  assert.deepEqual(names, [
    'mkdir',
    'fsync:1',
    'marker-write:initializing',
    'fsync:2',
    'fsync:3',
    'sqlite-full',
    'commit',
    'fsync:4',
    'fsync:5',
    'marker-write:ready-temp',
    'fsync:6',
    'fsync:7',
    'rename',
    'fsync:8',
  ]);
  assert.deepEqual(
    sequence.filter((item) => item.event === 'marker-write').map((item) => item.flush),
    [true, true],
  );
  assert.equal(sequence.find((item) => item.ordinal === 1)?.path, parent);
  assert.equal(sequence.find((item) => item.ordinal === 2)?.path, join(root, '.web-instance.json'));
  assert.equal(sequence.find((item) => item.ordinal === 3)?.path, root);
  assert.equal(sequence.find((item) => item.ordinal === 4)?.path, join(root, 'web.sqlite'));
  assert.equal(sequence.find((item) => item.ordinal === 5)?.path, root);
  assert.equal(sequence.find((item) => item.ordinal === 6)?.path, join(root, '.web-instance.json.ready'));
  assert.equal(sequence.find((item) => item.ordinal === 7)?.path, root);
  assert.equal(sequence.find((item) => item.ordinal === 8)?.path, root);
  const marker = JSON.parse(readFileSync(join(root, '.web-instance.json'), 'utf8'));
  assert.equal(marker.state, 'ready');
  assert.equal(marker.instanceId, id);
  new WebStore(root, { create: false, instanceId: id }).close();
  t.diagnostic(`observed marker order: ${names.join(' > ')}`);
});

test('C R4 every injected fsync and ready-transition failure leaves a retained root and safe reopen outcome', async (t) => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-marker-fault-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const faults = [
    ...Array.from({ length: 8 }, (_, i) => `fsync:${i + 1}`),
    'write:initializing',
    'write:ready-temp',
    'rename',
  ];
  const outcomes: string[] = [];
  for (const fault of faults) {
    const root = join(parent, fault.replace(':', '-')),
      id = randomUUID();
    const result = await run(root, id, fault);
    assert.equal(result.ok, false, `${fault}: ${JSON.stringify(result)}`);
    assert.match(result.error ?? '', /INJECTED_/);
    assert.equal(existsSync(root), true, `${fault}: failed root must be retained`);
    assert.equal(
      result.events.some((item) => item.event === 'db-close'),
      fault !== 'fsync:1' && fault !== 'fsync:2' && fault !== 'fsync:3' && fault !== 'write:initializing',
      `${fault}: opened DB should close on failure`,
    );
    const ready =
      existsSync(join(root, '.web-instance.json')) &&
      JSON.parse(readFileSync(join(root, '.web-instance.json'), 'utf8')).state === 'ready';
    assert.equal(ready, fault === 'fsync:8', `${fault}: ready may only be visible after rename`);
    if (ready) {
      new WebStore(root, { create: false, instanceId: id }).close();
      assert.throws(() => new WebStore(root, { create: false, instanceId: randomUUID() }), /WEB_INSTANCE_MISMATCH/);
    } else
      assert.throws(
        () => new WebStore(root, { create: false, instanceId: id }),
        /WEB_DATABASE_MISSING|WEB_MARKER_MISSING|WEB_INSTANCE_INITIALIZING/,
      );
    outcomes.push(`${fault}:${ready ? 'ready-verified' : 'reopen-refused'}`);
  }
  t.diagnostic(`injected outcomes: ${outcomes.join(', ')}`);
});
