import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountAdminApi } from '../../src/services/account-admin-api.ts';

const A = 'a'.repeat(64),
  B = 'b'.repeat(64);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = (csrf: string) => ({
  csrf,
  expiresAt: 1,
  emailDeliveryAvailable: false,
  member: { id: 'm', label: 'o', role: 'owner', email: null, createdAt: 1, permissions: [] },
});
/** A server whose cookie was replaced by a login in another tab: it now only accepts token B. */
function server(options: { valid: string; sessionStatus?: number; statusFor403?: string }) {
  const log: { path: string; csrf: string | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('/api/web/provider/admin', '');
    const csrf = ((init?.headers ?? {}) as Record<string, string>)['X-CSRF-Token'] ?? null;
    log.push({ path, csrf });
    if (path === '/session')
      return options.sessionStatus === 401
        ? json(401, { error: { code: 'ADMIN_UNAUTHORIZED' } })
        : json(200, session(options.valid));
    if (csrf !== options.valid) return json(403, { error: { code: options.statusFor403 ?? 'ADMIN_CSRF_REQUIRED' } });
    return json(200, { previews: [], active: 0 });
  }) as typeof fetch;
  return { fetcher, log };
}

test('previews-status: a stale CSRF after the cookie was replaced in another tab re-syncs once and succeeds', async () => {
  const { fetcher, log } = server({ valid: B });
  const api = new AccountAdminApi(fetcher);
  // This tab restored the session before the other tab logged in again.
  (api as unknown as { csrf: string }).csrf = A;
  assert.deepEqual(await api.previews.status('jojo', null), { previews: [], active: 0 });
  assert.deepEqual(
    log.map((x) => [x.path, x.csrf]),
    [
      ['/characters/jojo/previews-status', A],
      ['/session', null],
      ['/characters/jojo/previews-status', B],
    ],
  );
  await api.previews.status('jojo', null);
  assert.equal(log.at(-1)!.csrf, B, 'the refreshed token is kept for later calls');
  assert.equal(log.length, 4, 'and no further session call is needed');
});

test('a session that is really gone surfaces as 401 and clears the token; a missing permission is never retried', async () => {
  const gone = server({ valid: B, sessionStatus: 401 });
  const api = new AccountAdminApi(gone.fetcher);
  (api as unknown as { csrf: string }).csrf = A;
  await assert.rejects(
    () => api.previews.status('jojo', null),
    (error: { status?: number }) => error.status === 401,
  );
  assert.equal((api as unknown as { csrf: string | null }).csrf, null);

  const denied = server({ valid: A, statusFor403: 'ADMIN_PERMISSION_REQUIRED' });
  const other = new AccountAdminApi(denied.fetcher);
  (other as unknown as { csrf: string }).csrf = B;
  await assert.rejects(
    () => other.previews.status('jojo', null),
    (error: { code?: string }) => error.code === 'ADMIN_PERMISSION_REQUIRED',
  );
  assert.equal(denied.log.length, 1, 'no re-sync, no retry');
});

test('the retry is a single one: a token the server keeps refusing fails with the 403 instead of looping', async () => {
  let calls = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    calls++;
    return String(input).endsWith('/session')
      ? json(200, session(B))
      : json(403, { error: { code: 'ADMIN_CSRF_REQUIRED' } });
  }) as typeof fetch;
  const api = new AccountAdminApi(fetcher);
  (api as unknown as { csrf: string }).csrf = A;
  await assert.rejects(
    () => api.previews.status('jojo', null),
    (error: { status?: number }) => error.status === 403,
  );
  assert.equal(calls, 3);
});
