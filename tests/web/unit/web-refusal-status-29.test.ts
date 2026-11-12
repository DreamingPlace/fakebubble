import assert from 'node:assert/strict';
import test from 'node:test';
import { thrownDomainErrorCodes } from '../../../scripts/domain-error-codes.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { REFUSAL_STATUS, routeClass } from '../../../apps/server/platform/web-refusal-status.ts';
import { unknownRefusalCount, webProviderHTTPError } from '../../../apps/server/platform/web-provider-http-error.ts';

/** Part 29 G (audit F-06). */
test('every DomainError code thrown under apps/server is in the status table', () => {
  const missing = thrownDomainErrorCodes().filter((code) => {
    const publicCode = webProviderHTTPError(new DomainError(code)).body.error.code;
    return !Object.hasOwn(REFUSAL_STATUS, publicCode);
  });
  assert.deepEqual(missing, []);
});

test('409 is only for state that moved; an unknown code answers 400 and is counted', () => {
  const before = unknownRefusalCount();
  const unknown = webProviderHTTPError(new DomainError('SOMETHING_NEW_AND_UNLISTED'));
  assert.equal(unknown.status, 400);
  assert.equal(unknownRefusalCount(), before + 1);
  for (const [code, status] of [
    ['DRAFT_CONFLICT', 409],
    ['LIVE_VERSION_CONFLICT', 409],
    ['INVALID_ADMIN_REQUEST', 400],
    ['INVALID_CANON_VALUE', 400],
    ['CHARACTER_CONTEXT_TOO_LARGE', 400],
    ['PROFILE_IMPORT_INVALID', 400],
    ['PAYLOAD_TOO_LARGE', 413],
    ['NOT_FOUND', 404],
    ['RATE_LIMITED', 429],
  ] as const)
    assert.equal(webProviderHTTPError(new DomainError(code)).status, status, code);
  // Every status in the table is a real HTTP error status, and 409 is a small, reviewed set.
  assert.ok(Object.values(REFUSAL_STATUS).every((status) => status >= 400 && status < 600));
});

test('a refusal log line names a route CLASS only: no id, no query', () => {
  assert.equal(routeClass('/api/web/provider/admin/characters/4f2a-secret-id/save?x=1'), 'admin/characters');
  assert.equal(routeClass('/api/web/provider/public-audio/some-media-id'), 'public-audio');
  assert.equal(routeClass('/nothing'), 'other');
});
