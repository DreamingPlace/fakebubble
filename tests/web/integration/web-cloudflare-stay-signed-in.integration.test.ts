import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
type Client = { cookie: string; csrf: string };
const client = (): Client => ({ cookie: '', csrf: '' });

function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-worker.ts',
    { STATE: 'WebHTTPFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const request = (path: string, actor: Client, body?: unknown) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        'x-fixture-host': 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  /** Like the player: follow Set-Cookie (a Max-Age=0 clears it) and keep the newest CSRF. */
  const call = async (path: string, actor: Client, body?: unknown, status = 200) => {
    const response = await request(path, actor, body),
      text = await response.text();
    assert.equal(response.status, status, text);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) actor.cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return { result, setCookie };
  };
  const boot = async (actor: Client) => parseWebProviderBootstrap((await call(`${API}/bootstrap`, actor)).result);
  return { ...runtime, request, call, boot, fixture: runtime.call };
}

test('cloud: guest sessions older than 24h still expire and clear the cookie', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const player = client(),
    boot = await f.boot(player);
  await f.fixture('/fixture/session-expire', { principalId: boot.access.principalId });
  await f.restart();
  const expired = await f.request(`${API}/bootstrap`, player);
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('set-cookie')!, /^__Host-fixture=;.*Max-Age=0/);
});
