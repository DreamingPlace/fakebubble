import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { COCREATION_CARDS } from '../../../packages/contracts/cocreation-cards.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
type Client = { cookie: string; csrf: string };
const client = (): Client => ({ cookie: '', csrf: '' });

/** Real HTTP into workerd SQLite, the same harness as the other Cloudflare HTTP tests. */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-worker.ts',
    { STATE: 'WebHTTPFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const request = (path: string, actor: Client, body?: unknown, headers: Record<string, string> = {}) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        ...headers,
        'x-fixture-host': headers.host ?? 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const call = async (
    path: string,
    actor: Client,
    body?: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) => {
    const response = await request(path, actor, body, headers),
      text = await response.text();
    assert.equal(response.status, status, text);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (cookie) actor.cookie = response.headers.get('set-cookie')!.includes('Max-Age=0') ? '' : cookie;
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return result;
  };
  return { ...runtime, request, call, fixture: runtime.call };
}
const answers = [{ cardId: 'catchphrase', text: '哎呀妈呀' }];

test('co-creation over real HTTP: invited only, idempotent, limited, and an inbox that shows a pseudonym and nothing else', async (t) => {
  const f = setup(t),
    owner = client(),
    reader = client(),
    nobody = client(),
    guest = client(),
    invited = client();
  await f.fixture('/fixture/assets');
  await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const issue = (label: string, permissions: string[]) =>
    f.call(`${API}/admin/members/issue`, owner, { requestId: randomUUID(), label, memberId: null, permissions });
  await f.call(`${API}/admin/login`, reader, { token: (await issue('reader', ['cocreation.read'])).token });
  await f.call(`${API}/admin/login`, nobody, { token: (await issue('nobody', ['category.characters'])).token });

  await f.call(`${API}/bootstrap`, guest);
  await f.call(`${API}/bootstrap`, invited);
  const code = await f.call(
    `${API}/admin/invites/issue`,
    owner,
    { requestId: randomUUID(), redeemBy: null, accessDurationMs: null, batch: '春季内测', note: null },
    201,
  );
  await f.call(`${API}/invites/redeem`, invited, { requestId: randomUUID(), code: code.code }, 201);
  const principal = (await f.call(`${API}/bootstrap`, invited)).access.principalId as string;

  const submit = (actor: Client, body: unknown, status = 201, headers: Record<string, string> = {}) =>
    f.call(`${API}/cocreation/submit`, actor, body, status, headers);
  const body = (requestId: string, over: Record<string, unknown> = {}) => ({
    characterId: 'wei-guagua',
    requestId,
    answers,
    ...over,
  });

  // A guest may not; nothing is stored.
  assert.equal((await submit(guest, body(randomUUID()), 403)).error.code, 'COCREATION_INVITE_REQUIRED');
  // Without the session cookie, or with a wrong CSRF token, or from another origin: refused before any card is read.
  await f.call(`${API}/cocreation/submit`, client(), body('r0'), 401);
  const wrongCsrf = { ...invited, csrf: 'x'.repeat(43) };
  assert.ok([401, 403].includes((await f.request(`${API}/cocreation/submit`, wrongCsrf, body('r0'))).status));
  assert.ok(
    [401, 403].includes(
      (await f.request(`${API}/cocreation/submit`, invited, body('r0'), { origin: 'https://evil.invalid' })).status,
    ),
  );

  const first = await submit(invited, body('req-1'));
  assert.deepEqual({ answered: first.answered, duplicate: first.duplicate }, { answered: 1, duplicate: false });
  const replay = await submit(invited, body('req-1'), 200);
  assert.deepEqual(replay, { ...first, duplicate: true });
  assert.equal((await submit(invited, body('req-1', { characterId: 'jojo' }), 409)).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await submit(invited, body('req-2', { characterId: 'nobody-here' }), 404)).error.code, 'NOT_FOUND');
  assert.equal((await submit(invited, body('req-3', { answers: [] }), 400)).error.code, 'COCREATION_EMPTY');
  assert.equal(
    (await submit(invited, body('req-3', { answers: [{ cardId: 'catchphrase', text: 'a\nb' }] }), 400)).error.code,
    'COCREATION_TEXT_INVALID',
  );
  assert.equal((await submit(invited, body('req-3', { extra: 1 }), 400)).error.code, 'INVALID_REQUEST');

  // The largest legal submission is bigger than the 8 KiB default body and still goes through.
  const largest = COCREATION_CARDS.map((card) =>
    card.kind === 'dialogue'
      ? { cardId: card.id, player: '字'.repeat(120), replies: ['字'.repeat(120), '字'.repeat(120)] }
      : { cardId: card.id, text: '字'.repeat(card.id === 'free' ? 1000 : 300) },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(largest)) > 8192 * 1.2);
  assert.equal((await submit(invited, body('req-big', { answers: largest }))).answered, 12);
  // But there is a ceiling.
  await submit(invited, body('req-huge', { answers: [{ cardId: 'free', text: '字'.repeat(40_000) }] }), 400);

  // Five per player and character in 24 hours: two have been accepted, three more fit, then the limit answers 429.
  for (const n of [4, 5, 6]) await submit(invited, body(`req-${n}x`));
  const limited = await submit(invited, body('req-7x'), 429);
  assert.equal(limited.error.code, 'COCREATION_RATE_LIMITED');
  assert.ok(limited.error.retryAfterMs > 0);
  assert.equal(
    (await submit(invited, body('req-other', { characterId: 'jojo' }))).duplicate,
    false,
    'another character',
  );

  // Co-creation is not a reply: the player's reply allowance and every provider counter are untouched.
  const stats = await f.fixture<any>('/fixture/stats');
  assert.deepEqual(stats.calls, [], 'no provider call');
  assert.deepEqual(stats.operations, [], 'no operation was created');

  // Inbox: permissions.
  const filters = { characterId: null, status: null, starred: null, query: null, before: null };
  const list = (actor: Client, status = 200) => f.call(`${API}/admin/cocreation/list`, actor, filters, status);
  await list(nobody, 403);
  await list(client(), 401);
  const listing = await list(reader);
  assert.equal(listing.items.length, 6);
  assert.match(listing.items[0].pseudonym, /^玩家#[0-9a-f]{4}$/);
  assert.equal(new Set(listing.items.map((i: any) => i.pseudonym)).size, 1, 'one player, one label');
  assert.ok(!JSON.stringify(listing).includes(principal), 'the principal id never leaves the server');
  const detail = await f.call(`${API}/admin/cocreation/detail`, reader, { id: listing.items.at(-1).id });
  assert.equal(detail.batch, '春季内测');
  assert.deepEqual(Object.keys(detail).sort(), [
    'adminNote',
    'answers',
    'batch',
    'characterId',
    'createdAt',
    'id',
    'processedAt',
    'pseudonym',
    'starred',
    'status',
  ]);
  assert.deepEqual((await f.call(`${API}/admin/cocreation/counts`, reader, {})).counts, { 'wei-guagua': 5, jojo: 1 });
  // Read is not manage.
  await f.call(`${API}/admin/cocreation/star`, reader, { id: detail.id, starred: true }, 403);
  await f.call(`${API}/admin/cocreation/set-status`, reader, { ids: [detail.id], status: 'archived' }, 403);
  await f.call(`${API}/admin/cocreation/note`, reader, { id: detail.id, note: 'x' }, 403);
  await f.call(`${API}/admin/cocreation/adopt`, reader, { id: detail.id, ordinal: 0 }, 403);
  // The owner may.
  await f.call(`${API}/admin/cocreation/star`, owner, { id: detail.id, starred: true });
  await f.call(`${API}/admin/cocreation/note`, owner, { id: detail.id, note: '先放着' });
  await f.call(`${API}/admin/cocreation/adopt`, owner, { id: detail.id, ordinal: 0 });
  const after = await f.call(`${API}/admin/cocreation/detail`, reader, { id: detail.id });
  assert.deepEqual(
    {
      status: after.status,
      starred: after.starred,
      note: after.adminNote,
      adopted: after.answers[0].adoptedAt !== null,
    },
    { status: 'processed', starred: true, note: '先放着', adopted: true },
  );
  const archived = await f.call(`${API}/admin/cocreation/set-status`, owner, {
    ids: listing.items.slice(0, 2).map((i: any) => i.id),
    status: 'archived',
  });
  assert.equal(archived.updated, 2);
  assert.deepEqual(
    (await f.call(`${API}/admin/cocreation/list`, owner, { ...filters, status: 'archived' })).items.length,
    2,
  );
  await f.call(`${API}/admin/cocreation/list`, owner, { ...filters, query: '哎呀妈呀' });
  await f.call(`${API}/admin/cocreation/list`, owner, { ...filters, status: 'done' }, 400);
  // Players have no way in.
  await f.call(`${API}/admin/cocreation/list`, invited, filters, 401);
});
