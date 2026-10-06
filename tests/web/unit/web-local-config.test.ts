import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertLocalRoot, localRuntime } from '../../../apps/server/web-local-config.ts';

test('local root and port belong only to this checkout', () => {
  const { parent, port } = localRuntime();
  assert.equal(port, 18491);
  assert.equal(parent, resolve('runtime/web-v1/public/db'));
  assertLocalRoot(join(parent, 'local-b-unit'));
  assert.throws(() => assertLocalRoot(resolve(parent, '..', 'web.sqlite')), /WEB_LOCAL_ROOT_REQUIRED/);
  const otherRole = parent.includes('/control/') ? 'build' : 'control';
  assert.throws(
    () => assertLocalRoot(resolve(parent, '..', '..', otherRole, 'db', 'local-other-unit')),
    /WEB_LOCAL_ROOT_REQUIRED/,
  );
});
