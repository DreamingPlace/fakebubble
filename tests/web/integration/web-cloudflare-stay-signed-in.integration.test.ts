import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const LONG = /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000$/;
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
  const settle = async (actor: Client, id: string) => {
    const end = Date.now() + 20_000;
    while (true) {
      const operation = (await call(`${API}/operations/${id}`, actor)).result;
      if (['published', 'failed', 'cancelled'].includes(operation.status)) return operation;
      assert.ok(Date.now() < end, JSON.stringify(operation));
      await sleep(100);
    }
  };
  return { ...runtime, request, call, boot, settle, fixture: runtime.call };
}

async function admin(f: ReturnType<typeof setup>) {
  const owner = client();
  const grant = await f.fixture<{ token: string }>('/fixture/grant');
  await f.call(`${API}/admin/login`, owner, { token: grant.token });
  const issue = async () =>
    (
      await f.call(
        `${API}/admin/invites/issue`,
        owner,
        { requestId: randomUUID(), redeemBy: null, accessDurationMs: null, batch: 'stay', note: null },
        201,
      )
    ).result.code as string;
  return { owner, issue };
}

test('cloud: invited cookie is long-lived on redeem and re-issued on every bootstrap, even past the old 24h deadline', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const { issue } = await admin(f);
  const player = client();
  const guest = await f.boot(player);
  // A guest keeps the plain session cookie: no Max-Age, and bootstrap sets nothing new.
  const plain = await f.request(`${API}/bootstrap`, player);
  assert.equal(plain.headers.get('set-cookie'), null);
  const redeemed = await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code: await issue() }, 201);
  assert.match(
    redeemed.setCookie!,
    /^__Host-fixture=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000$/,
  );
  const first = await f.request(`${API}/bootstrap`, player);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('set-cookie')!, LONG);
  assert.equal(
    first.headers.get('set-cookie')!.split(';')[0],
    player.cookie,
    'same token, only the lifetime is renewed',
  );
  // The old 24h absolute deadline passes; the owner's own invited session must come back.
  await f.fixture('/fixture/session-expire', { principalId: guest.access.principalId });
  await f.restart();
  const later = await f.request(`${API}/bootstrap`, player);
  assert.equal(later.status, 200);
  assert.match(later.headers.get('set-cookie')!, LONG);
  assert.equal(parseWebProviderBootstrap(await later.json()).access.principalId, guest.access.principalId);
});

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

test('cloud: redeem → one-time code → cookie cleared → recover to the same principal and history → old code dead → regenerate', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const { issue } = await admin(f);
  const player = client();
  const original = await f.boot(player);
  await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code: await issue() }, 201);
  const upgraded = await f.boot(player);
  assert.equal(upgraded.access.kind, 'invite');
  const sent = (
    await f.call(
      `${API}/characters/wei-guagua/operations`,
      player,
      { requestId: randomUUID(), text: '恢复前的聊天', delivery: 'voice' },
      202,
    )
  ).result;
  assert.equal((await f.settle(player, sent.operation.operationId)).status, 'published');
  const conversationId = sent.operation.conversationId;
  const history = (await f.call(`${API}/conversations/${conversationId}/history`, player)).result.messages;
  assert.ok(history.length >= 2);

  // The page asks for the code right after redemption. Regenerate upserts: it works when none exists yet.
  const shown = (await f.call(`${API}/invites/credential-regenerate`, player, {}, 201)).result;
  assert.match(shown.secret, /^[A-Za-z0-9_-]{43}$/);
  // It needs CSRF and a signed-in session (the existing player-route convention answers 403 without a cookie).
  assert.equal(
    (await f.request(`${API}/invites/credential-regenerate`, { ...player, csrf: 'x'.repeat(43) }, {})).status,
    403,
  );
  assert.equal((await f.request(`${API}/invites/credential-regenerate`, client(), {})).status, 403);

  // New browser: no cookie, only the code.
  const fresh = client();
  const recovered = await f.call(`${API}/invites/recover`, fresh, { requestId: randomUUID(), secret: shown.secret });
  assert.match(recovered.setCookie!, LONG);
  assert.equal(recovered.result.principalId, original.access.principalId);
  const again = await f.boot(fresh);
  assert.equal(again.access.principalId, original.access.principalId);
  assert.equal(again.access.worldId, original.access.worldId);
  const sameHistory = (await f.call(`${API}/conversations/${conversationId}/history`, fresh)).result.messages;
  assert.deepEqual(
    sameHistory.map((m: { messageId: string }) => m.messageId),
    history.map((m: { messageId: string }) => m.messageId),
  );
  // Recovery rotated the session: the previous browser is out, and the used code no longer works.
  await f.call(`${API}/sync`, player, undefined, 401);
  const used = await f.call(`${API}/invites/recover`, client(), { requestId: randomUUID(), secret: shown.secret }, 409);
  assert.equal(used.result.error.code, 'WEB_INVITE_RECOVERY_UNAVAILABLE');
  const wrong = await f.call(
    `${API}/invites/recover`,
    client(),
    { requestId: randomUUID(), secret: 'Q'.repeat(43) },
    409,
  );
  assert.deepEqual(wrong.result, used.result, 'wrong and used codes look identical');
  assert.notEqual(recovered.result.recoverySecret, shown.secret);

  // Regenerate from the signed-in browser invalidates the code the recovery just produced.
  const regenerated = (await f.call(`${API}/invites/credential-regenerate`, fresh, {}, 201)).result;
  assert.notEqual(regenerated.secret, recovered.result.recoverySecret);
  await f.call(
    `${API}/invites/recover`,
    client(),
    { requestId: randomUUID(), secret: recovered.result.recoverySecret },
    409,
  );
  const last = client();
  await f.call(`${API}/invites/recover`, last, { requestId: randomUUID(), secret: regenerated.secret });
  assert.equal((await f.boot(last)).access.principalId, original.access.principalId);
});

test('cloud: revoking the grant ends every session at once and disables the recovery code; failed attempts stay limited', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const { owner, issue } = await admin(f);
  const player = client();
  await f.boot(player);
  const redeemed = (
    await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code: await issue() }, 201)
  ).result;
  const code = (await f.call(`${API}/invites/credential-regenerate`, player, {}, 201)).result.secret;
  await f.call(`${API}/sync`, player);
  await f.call(`${API}/admin/invites/revoke-grant`, owner, { id: redeemed.grantId });
  const dead = await f.request(`${API}/bootstrap`, player);
  assert.equal(dead.status, 401);
  // Part 11f: the dead cookie is cleared (the page shows the signed-out first page); it is still never replaced by a guest.
  assert.match(dead.headers.get('set-cookie')!, /^__Host-fixture=; .*Max-Age=0$/, 'cleared, not replaced by a guest');
  await f.call(`${API}/sync`, player, undefined, 401);
  await f.call(`${API}/invites/credential-regenerate`, player, {}, 401);
  const refused = await f.call(`${API}/invites/recover`, client(), { requestId: randomUUID(), secret: code }, 409);
  assert.equal(refused.result.error.code, 'WEB_INVITE_RECOVERY_UNAVAILABLE');
  // Unchanged limit: 20 failed proofs per trusted IP per minute, then 429 with the same envelope.
  let limited = 0;
  for (let i = 0; i < 22; i++) {
    const response = await f.request(`${API}/invites/recover`, client(), {
      requestId: randomUUID(),
      secret: 'W'.repeat(43),
    });
    if (response.status === 429) limited++;
    else assert.equal(response.status, 409);
  }
  assert.ok(limited >= 1, 'the per-IP failed-attempt limit still applies');
});
