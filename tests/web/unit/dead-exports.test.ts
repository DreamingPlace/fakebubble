import assert from 'node:assert/strict';
import test from 'node:test';
import { findDeadExports, loadAllowList, staleAllowEntries } from '../../../scripts/check-dead-exports.ts';

// Part 22x: the repeatable dead-code check. A non-test module export that nothing outside tests calls fails the build.
test('no non-test module exports a value that nothing outside tests calls', () => {
  const dead = findDeadExports(loadAllowList());
  assert.deepEqual(
    dead.map((d) => `${d.file}: ${d.name}${d.testOnly ? ' (only tests use it)' : ''}`),
    [],
    'delete the symbol and its private helpers, or add it to config/dead-exports-allowlist.json with a reason',
  );
});

test('every allow-list entry still matches an uncalled export and carries a reason', () => {
  const allow = loadAllowList();
  assert.ok(allow.length > 0);
  assert.deepEqual(staleAllowEntries(allow), []);
  for (const entry of allow) assert.ok(entry.reason.length >= 10, entry.file);
});

test('the check does find an export with no caller: without the allow-list the Worker entrypoints and test seams show up', () => {
  const dead = findDeadExports([]);
  assert.ok(dead.some((d) => d.file === 'workers/web-cloudflare/business.ts' && d.name === 'default'));
  assert.ok(
    dead.some((d) => d.file === 'apps/server/admission/web-points.ts' && d.name === 'grantPoints' && d.testOnly),
  );
});
