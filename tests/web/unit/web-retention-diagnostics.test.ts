import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ageBucket,
  backoffDelay,
  errorName,
  firstFrame,
  messageShape,
  olderBucket,
} from '../../../apps/server/cloudflare/web-retention-diagnostics.ts';
import { durableRetentionMemory, inMemoryRetention } from '../../../apps/server/cloudflare/web-retention.ts';

// Part 17g: what a failed purge may say about itself.
test('messageShape keeps SQLite wording and drops every value', () => {
  assert.equal(messageShape('FOREIGN KEY constraint failed'), 'FOREIGN KEY constraint failed');
  assert.equal(messageShape('no such table: web_points_events'), 'no such table: web_points_events');
  assert.equal(
    messageShape('UNIQUE constraint failed: web_review_archive.label, web_review_archive.line_order'),
    'UNIQUE constraint failed: web_review_archive.label, web_review_archive.line_order',
  );
  assert.equal(
    messageShape('table messages has no column named memory', new Set(['messages'])),
    'table messages has no column named memory',
  );
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e',
    hash = 'a'.repeat(64);
  const shaped = messageShape(
    `bad ${id} for kim.lee@example.com ip ${hash} nick "阿泡" 'Bob' key=Zm9vYmFyYmF6 at 12:34 row 4711 阿泡`,
  );
  assert.equal(shaped, 'bad <tok> for <email> ip <tok> nick <q> <q> key=<tok> at <n>:<n> row <n> <u>');
  for (const value of [id, hash, 'kim', 'example.com', '阿泡', 'Bob', 'Zm9vYmFy', '4711'])
    assert.ok(!shaped.includes(value));
});
test('messageShape is cut to 160 characters and accepts anything', () => {
  assert.equal(messageShape('x '.repeat(500)).length, 160);
  assert.equal(messageShape(undefined), '');
  assert.equal(messageShape({ nope: 1 }), '');
});
test('errorName is a class name or a fixed word, nothing the error carries', () => {
  assert.equal(errorName(new TypeError('x')), 'TypeError');
  assert.equal(errorName(new (class SqliteError extends Error {})('x')), 'SqliteError');
  assert.equal(errorName('a nickname'), 'string');
  assert.equal(errorName(null), 'Nothing');
  assert.equal(errorName(Object.create(null)), 'Object');
});
test('firstFrame is file-basename:line of our code only', () => {
  const error = new Error('x');
  error.stack = [
    'Error: x',
    '    at Object.run (node:internal/foo:1:1)',
    '    at get (file:///home/user/fakebubble/node_modules/.pnpm/miniflare/x.js:5:5)',
    '    at ensure (file:///home/user/fakebubble/packages/domain/errors.ts:20:9)',
    '    at WebCloudRetention.clearDatabase (file:///home/user/fakebubble/apps/server/cloudflare/web-retention.ts:487:12)',
    '    at sweep (file:///home/user/fakebubble/apps/server/cloudflare/web-retention.ts:300:12)',
  ].join('\n');
  assert.equal(firstFrame(error), 'web-retention.ts:487');
  const bare = new Error('no stack frames here, only /secret/path/with/id');
  bare.stack = 'Error: no stack frames here';
  assert.equal(firstFrame(bare), undefined);
  assert.equal(firstFrame('a string'), undefined);
});
test('age buckets and the backoff schedule', () => {
  const day = 24 * 60 * 60_000;
  assert.deepEqual([0, day - 1, day, 7 * day - 1, 7 * day, 30 * day - 1, 30 * day, 400 * day].map(ageBucket), [
    '<1d',
    '<1d',
    '1-7d',
    '1-7d',
    '7-30d',
    '7-30d',
    '>30d',
    '>30d',
  ]);
  assert.equal(olderBucket(undefined, '1-7d'), '1-7d');
  assert.equal(olderBucket('>30d', '<1d'), '>30d');
  assert.deepEqual([0, 1, 2, 3, 4, 50].map(backoffDelay), [0, 60_000, 300_000, 1_800_000, 21_600_000, 21_600_000]);
});
test('the retention ledger survives a round trip and ignores a damaged stored value', async () => {
  const mem = inMemoryRetention();
  await mem.save({ failures: { p: [2, 5] }, lastSuccessAt: 9 });
  assert.deepEqual(await mem.load(), { failures: { p: [2, 5] }, lastSuccessAt: 9 });
  const kv = new Map<string, unknown>();
  const durable = durableRetentionMemory({ get: async (k) => kv.get(k), put: async (k, v) => void kv.set(k, v) });
  assert.deepEqual(await durable.load(), { failures: {}, lastSuccessAt: null });
  kv.set('retention:ledger', { failures: { ok: [1, 2], bad: 'x', worse: [1.5, 2] }, lastSuccessAt: 'soon' });
  assert.deepEqual(await durable.load(), { failures: { ok: [1, 2] }, lastSuccessAt: null });
});
