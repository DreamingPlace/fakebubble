// Part 48: the PUBLIC catalog read behind the home cards (GET /api/web/provider/catalog), over real HTTP into workerd.
//   - it answers with public card fields only, in the bootstrap's own order, and parses with the page's strict reader;
//   - it reads and sets no cookie, creates no principal and no session (a visitor with no cookie costs the database nothing);
//   - it is rate-limited per IP and over all visitors, like the share routes;
//   - Turnstile is unchanged: a new guest still needs a passed challenge, and no provider call or budget hold happens before a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { WEB_HTTP_LIMITS } from '../../../config/web-v1.ts';
import { parseWebPublicCatalog } from '../../../packages/contracts/web-public-catalog.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';

function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-worker.ts',
    { STATE: 'WebHTTPFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const get = (path: string, headers: Record<string, string> = {}) =>
    runtime.request(origin + path, { headers: { ...headers, 'x-fixture-host': 'fixture.invalid' } });
  return { ...runtime, get, fixture: runtime.call };
}
type Stats = {
  principals: number;
  calls: unknown[];
  operations: unknown[];
  spending: { provider: string; spent_micros: number; held_micros: number }[];
};
const WITHOUT = [
  'csrf',
  'principalId',
  'playerId',
  'worldId',
  'conversationId',
  'instanceId',
  'recoveryEpoch',
  'syncCursor',
];

test('catalog: public card fields only, bootstrap order, no cookie read or set, no principal created', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const before = await f.fixture<Stats>('/fixture/stats');
  // A visitor with NO cookie, and one with a junk cookie: the same answer, and nothing about either is read.
  const plain = await f.get(`${API}/catalog`);
  const text = await plain.text();
  assert.equal(plain.status, 200, text);
  assert.equal(plain.headers.get('set-cookie'), null, 'the catalog never sets a cookie');
  assert.equal(plain.headers.get('cache-control'), 'no-store');
  const catalog = parseWebPublicCatalog(JSON.parse(text));
  const junk = await f.get(`${API}/catalog`, { cookie: '__Host-fixture=not-a-session; other=1' });
  assert.equal(junk.status, 200);
  assert.equal(junk.headers.get('set-cookie'), null);
  assert.equal(await junk.text(), text, 'a cookie changes nothing: no session is read');
  // Exactly the public card fields: no ids beyond characterId, no welcome text, no clip URL, no tokens.
  assert.ok(catalog.characters.length > 0);
  for (const character of catalog.characters)
    assert.deepEqual(
      Object.keys(character).sort(),
      [
        'available',
        'birthDate',
        'characterId',
        'displayName',
        'mainColor',
        'palette',
        'portraitUrl',
        'welcomeClip',
      ].sort(),
    );
  for (const word of [
    ...WITHOUT,
    'publicDescription',
    'welcome',
    'sha256',
    'mediaId',
    'public-audio',
    'personaVersion',
  ])
    assert.equal(
      text.includes(`"${word}"`) || text.includes(word === 'public-audio' ? word : `"${word}":`),
      false,
      word,
    );
  assert.equal(catalog.slots.length, 15);
  // The same characters in the same order as the bootstrap of a real session (the page keeps its cards when the session arrives).
  const boot = parseWebProviderBootstrap(await (await f.get(`${API}/bootstrap`)).json());
  assert.deepEqual(
    catalog.characters.map((c) => c.characterId),
    boot.characters.map((c) => c.characterId),
  );
  assert.deepEqual(catalog.slots, boot.slots);
  for (const [i, character] of boot.characters.entries()) {
    const shown = catalog.characters[i]!;
    assert.equal(shown.displayName, character.displayName);
    assert.equal(shown.portraitUrl, character.portraitUrl);
    assert.equal(shown.mainColor, character.mainColor);
    assert.equal(shown.available, character.availability.state === 'available');
    assert.equal(shown.welcomeClip, character.welcome.audio.state === 'available');
  }
  // Only the bootstrap above made a principal; the two catalog reads made none.
  const after = await f.fixture<Stats>('/fixture/stats');
  assert.equal(before.principals, 0);
  assert.equal(after.principals, 1);
  // Not a write route, and not a place to ask for anything else.
  for (const [method, path] of [
    ['POST', `${API}/catalog`],
    ['GET', `${API}/catalog/extra`],
  ] as const) {
    const response = await f.request(origin + path, {
      method,
      headers: { 'x-fixture-host': 'fixture.invalid', origin, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.ok(response.status >= 400, `${method} ${path}`);
    await response.text();
  }
  assert.equal((await f.get(`${API}/catalog?x=1`)).status, 400, 'no query is accepted');
});

test('catalog: per IP and global rate limits (RATE_LIMITED, like the share routes)', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const reply = (peer: string) => f.get(`${API}/catalog`, { 'x-fixture-peer': peer });
  for (let n = 0; n < WEB_HTTP_LIMITS.catalogPerIpPerMinute; n++)
    assert.equal((await reply('198.51.100.7')).status, 200);
  const limited = await reply('198.51.100.7');
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
  // Another address is not affected by it...
  assert.equal((await reply('198.51.100.8')).status, 200);
  // ...until the global limit (all visitors together) is reached. Every request counts once against it, the refused ones too.
  let requests = WEB_HTTP_LIMITS.catalogPerIpPerMinute + 2;
  let refused = 0;
  for (let n = 0; n < WEB_HTTP_LIMITS.catalogGlobalPerMinute + 10 && refused === 0; n++) {
    const response = await reply(`10.${(n >> 8) & 255}.${n & 255}.9`);
    requests++;
    if (response.status !== 200) {
      refused = response.status;
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
    }
  }
  assert.equal(refused, 429, 'the global limit refused a visitor');
  // (the one per-IP refusal above may or may not have counted against the global key, so the refusal comes at limit + 1 or + 2)
  assert.ok(
    requests >= WEB_HTTP_LIMITS.catalogGlobalPerMinute + 1 && requests <= WEB_HTTP_LIMITS.catalogGlobalPerMinute + 2,
    `refused at request ${requests}`,
  );
});

test('Turnstile still gates a new guest: no bootstrap without a token, and nothing paid happens before a session', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, turnstile: true });
  // The home cards are readable with Turnstile on and no token (that is the point of Part 48)...
  const cards = await f.get(`${API}/catalog`);
  assert.equal(cards.status, 200);
  parseWebPublicCatalog(await cards.json());
  // ...but a session is not: no token = TURNSTILE_REQUIRED and nothing is created (also not by a wrong token).
  for (const headers of [{}, { 'x-turnstile-token': 'bad-token-1' }]) {
    const refused = await f.get(`${API}/bootstrap`, headers);
    assert.equal(refused.status, 403);
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      headers['x-turnstile-token'] ? 'TURNSTILE_FAILED' : 'TURNSTILE_REQUIRED',
    );
    assert.equal(refused.headers.get('set-cookie'), null);
  }
  // Every write route needs a session and answers before reading a body or touching a provider.
  for (const path of [
    `${API}/characters/wei-guagua/operations`,
    `${API}/cocreation/submit`,
    `${API}/shares`,
    `${API}/account/signup`,
  ]) {
    const response = await f.request(origin + path, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-csrf-token': 'none',
        'x-fixture-host': 'fixture.invalid',
      },
      body: JSON.stringify({ requestId: 'r', text: 'x', delivery: 'voice' }),
    });
    assert.ok([400, 401, 403].includes(response.status), `${path} -> ${response.status}`);
    await response.text();
  }
  const stats = await f.fixture<Stats>('/fixture/stats');
  assert.equal(stats.principals, 0, 'no principal without a passed challenge');
  assert.deepEqual(stats.calls, [], 'no provider call before a session');
  assert.deepEqual(stats.operations, []);
  assert.ok(
    stats.spending.every((row) => row.spent_micros === 0 && row.held_micros === 0),
    'no budget reservation before a session',
  );
});
