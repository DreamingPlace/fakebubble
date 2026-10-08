import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../../../packages/domain/errors.ts';
import { safeError } from '../../../apps/server/cloudflare/safe-error.ts';

test('DomainError logs only its code, never its message', () => {
  assert.deepEqual(safeError(new DomainError('WEB_CLOUD_BUDGET_GRANT_MISMATCH', 'secret detail')), {
    code: 'WEB_CLOUD_BUDGET_GRANT_MISMATCH',
  });
});

test('generic Error: message is truncated to 200 chars and stripped to the safe alphabet', () => {
  const odd = safeError(new TypeError('bad {token}=[abc] 中文 \n x@y#z$ ok (1:2)'));
  assert.deepEqual(odd, {
    name: 'TypeError',
    message: 'bad token=abc   xyz ok (1:2)',
  });
  const long = safeError(new Error('a'.repeat(500))) as { message: string };
  assert.equal(long.message.length, 200);
  assert.deepEqual(safeError(new Error('<a href="x">\'q\'</a>; k=v')), {
    name: 'Error',
    message: '<a href="x">\'q\'</a>; k=v',
  });
});

test('non-errors carry no content', () => {
  for (const value of ['secret', { cookie: 'x' }, null, undefined, 42])
    assert.deepEqual(safeError(value), { name: 'non-error' });
});
