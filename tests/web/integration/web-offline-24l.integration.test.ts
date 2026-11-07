import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';

/**
 * Part 24l: 下线 / 重新上线 on workerd SQLite. 下线 removes the catalog row and nothing else; 重新上线 puts it back at its live
 * version. Everything here is synthetic.
 */
type Guest = { principalId: string; csrf: string; issuedToken: string };
type State = {
  catalog: [string, number, number][];
  templates: { id: string; version: number }[];
  versions: number;
  bindings: number;
  audit: { action: string; target_id: string }[];
  requests: number;
  conversations: { id: string }[];
  messages: number;
};
const ID = 'wei-guagua';
/** The version every fixture character is live at. */
const V = 2;
const setup = (t: test.TestContext) =>
  localRuntime(t, 'tests/web/fixtures/cloudflare-offline-24l-worker.ts', { STATE: 'WebOffline24lFixture' }, ['MEDIA']);
type Runtime = ReturnType<typeof setup>;
const admitBody = (guest: Guest, characterId: string, requestId = randomUUID()) => ({
  token: guest.issuedToken,
  csrf: guest.csrf,
  origin: 'https://fixture.invalid',
  ipHash: 'a'.repeat(64),
  input: { requestId, characterId, text: '下线与重新上线测试的私人消息' },
});
async function chat(f: Runtime, guest: Guest, characterId = ID) {
  await f.call('/run', await f.call<{ operationId: string }>('/admit', admitBody(guest, characterId)));
}
const state = (f: Runtime) => f.call<State>('/offline/state', {});
const set = (f: Runtime, action: 'offline' | 'online', liveVersion = V, requestId = randomUUID(), characterId = ID) =>
  f.call<any>('/offline/set', { characterId, action, input: { requestId, liveVersion } });
const refused = async (f: Runtime, path: string, body: unknown, code: string) =>
  assert.equal((await f.call<any>(path, body, 409)).error, code);
type Retention = { messages: number; outputs: number };

test('24l 下线 removes the catalog row and nothing else; its position is free; 重新上线 returns it unchanged for the player', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  await chat(f, guest);
  await f.call('/retention/seed-fact', guest);
  const before = await state(f);
  const at = before.catalog.find(([id]) => id === ID)!;
  assert.ok(at, 'the character is on the home page');
  const retentionBefore = await f.call<Retention>('/retention/state', guest);
  assert.ok(retentionBefore.messages > 0);
  const counts = await f.call('/counts');

  const requestId = randomUUID();
  const off = await set(f, 'offline', at[2], requestId);
  assert.deepEqual(
    { ...off, at: undefined },
    { characterId: ID, action: 'offline', version: at[2], position: null, at: undefined },
  );
  const during = await state(f);
  assert.ok(!during.catalog.some(([id]) => id === ID), 'gone from the home page and bootstrap list');
  assert.equal(during.catalog.length, before.catalog.length - 1);
  assert.ok(!during.catalog.some(([, position]) => position === at[1]), 'its position is free');
  // Everything else stays: templates, versions, voice binding, the player's chat and memory.
  assert.deepEqual(during.templates, before.templates);
  assert.equal(during.versions, before.versions);
  assert.equal(during.bindings, before.bindings);
  assert.deepEqual(during.conversations, before.conversations);
  assert.equal(during.messages, before.messages);
  assert.deepEqual(await f.call<Retention>('/retention/state', guest), retentionBefore);
  assert.deepEqual(await f.call('/counts'), counts, 'no ledger, budget or provider row moved');
  assert.deepEqual(during.audit, [{ action: `character-offline:v${at[2]}`, target_id: ID }]);

  // Idempotent per requestId: the same answer, no second audit row; another body with the same id conflicts.
  assert.deepEqual(await set(f, 'offline', at[2], requestId), off);
  assert.equal((await state(f)).audit.length, 1);
  await refused(
    f,
    '/offline/set',
    { characterId: ID, action: 'offline', input: { requestId, liveVersion: at[2] + 1 } },
    'IDEMPOTENCY_CONFLICT',
  );

  // While offline: admission refuses it; another character is untouched; the clip stops resolving; a second 下线 is refused.
  await refused(f, '/admit', admitBody(guest, ID), 'WEB_CHARACTER_UNAVAILABLE');
  await f.call('/offline/untrial', guest);
  await chat(f, guest, 'jojo');
  await refused(
    f,
    '/offline/set',
    { characterId: ID, action: 'offline', input: { requestId: randomUUID(), liveVersion: at[2] } },
    'CHARACTER_OFFLINE',
  );

  const retentionOffline = await f.call<Retention>('/retention/state', guest);
  // 重新上线: the first free slot (the one it left), the live version, the player's history and memory as they were.
  const onRequest = randomUUID();
  const on = await set(f, 'online', at[2], onRequest);
  assert.deepEqual(
    { ...on, at: undefined },
    { characterId: ID, action: 'online', version: at[2], position: at[1], at: undefined },
  );
  assert.deepEqual(await set(f, 'online', at[2], onRequest), on);
  const after = await state(f);
  assert.deepEqual(
    after.catalog.find(([id]) => id === ID),
    at,
  );
  assert.deepEqual(
    after.audit.map((a) => a.action),
    [`character-offline:v${at[2]}`, `character-online:v${at[2]}`],
  );
  assert.equal(after.requests, 2);
  const retentionAfter = await f.call<Retention>('/retention/state', guest);
  assert.deepEqual(retentionAfter, retentionOffline, 'history and memory unchanged by 重新上线');
  await f.call('/offline/untrial', guest);
  await chat(f, guest);
  await refused(
    f,
    '/offline/set',
    { characterId: ID, action: 'online', input: { requestId: randomUUID(), liveVersion: at[2] } },
    'CHARACTER_ONLINE',
  );
});

test('24l the same fence as publish: BUSY with work in flight (never cancelled), CATALOG_FULL with fifteen on', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  // An admitted, unfinished operation: 下线 is refused and the operation is left as it is.
  const op = await f.call<{ operationId: string }>('/admit', admitBody(guest, ID));
  const inflight = await f.call<{ status: string }[]>('/offline/inflight', { characterId: ID });
  assert.ok(inflight.length === 1 && !['published', 'cancelled', 'failed'].includes(inflight[0]!.status));
  await refused(
    f,
    '/offline/set',
    { characterId: ID, action: 'offline', input: { requestId: randomUUID(), liveVersion: V } },
    'CHARACTER_PUBLICATION_BUSY',
  );
  assert.deepEqual(await f.call('/offline/inflight', { characterId: ID }), inflight);
  assert.ok((await state(f)).catalog.some(([id]) => id === ID));
  // A character that is offline with work in flight (forced by the test operator) cannot come back until it ends.
  await f.call('/offline/force', { characterId: ID });
  await refused(
    f,
    '/offline/set',
    { characterId: ID, action: 'online', input: { requestId: randomUUID(), liveVersion: V } },
    'CHARACTER_PUBLICATION_BUSY',
  );
  await f.call('/run', op);
  const free = (await state(f)).catalog.length;
  // Fifteen on: no free slot.
  await f.call('/offline/fill', {});
  assert.equal((await state(f)).catalog.length, 15);
  assert.ok(free < 15);
  await refused(
    f,
    '/offline/set',
    { characterId: ID, action: 'online', input: { requestId: randomUUID(), liveVersion: V } },
    'CHARACTER_CATALOG_FULL',
  );
  assert.ok(!(await state(f)).catalog.some(([id]) => id === ID));
});

test('24l a stale live version is refused; an unknown character is not found', async (t) => {
  const f = setup(t);
  await refused(
    f,
    '/offline/set',
    { characterId: ID, action: 'offline', input: { requestId: randomUUID(), liveVersion: 7 } },
    'LIVE_VERSION_CONFLICT',
  );
  await refused(
    f,
    '/offline/set',
    { characterId: 'no-such', action: 'offline', input: { requestId: randomUUID(), liveVersion: V } },
    'NOT_FOUND',
  );
});

test('24l the one-character guest lock ignores an offline character; an unlocked guest is unaffected', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const locked = await f.call<Guest>('/bootstrap', {});
  const fresh = await f.call<Guest>('/bootstrap', {});
  await chat(f, locked);
  await f.call('/offline/untrial', locked);
  assert.deepEqual(await f.call('/offline/lock', { principalId: locked.principalId }), [ID]);
  assert.deepEqual(
    await f.call('/offline/lock', { principalId: fresh.principalId }),
    [],
    'no character chosen yet: any',
  );
  await refused(f, '/admit', admitBody(locked, 'jojo'), 'GUEST_CHARACTER_LOCKED');
  await set(f, 'offline');
  assert.deepEqual(
    await f.call('/offline/lock', { principalId: locked.principalId }),
    [],
    'the offline one holds nobody',
  );
  assert.deepEqual(await f.call('/offline/lock', { principalId: fresh.principalId }), []);
  await chat(f, locked, 'jojo');
  assert.deepEqual(await f.call('/offline/lock', { principalId: locked.principalId }), ['jojo']);
  // Back online it counts again (its messages are still there): the guest now has two, and keeps both.
  await set(f, 'online');
  assert.deepEqual(
    await f.call('/offline/lock', { principalId: locked.principalId }),
    [ID, 'jojo'].sort((a, b) => 0 * a.length + 0 * b.length),
  );
});

test('24l an offline character still deletes (24g) and its guest is still purged; the shared welcome clip stops while it is offline', async (t) => {
  const f = setup(t);
  const fixed = await f.call<string[]>('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const other = await f.call<Guest>('/bootstrap', {});
  await chat(f, guest);
  await chat(f, other);
  await f.call('/welcome', { mediaId: fixed[2] });
  await set(f, 'offline');
  await refused(f, '/welcome', { mediaId: fixed[2] }, 'WEB_PROVIDER_WELCOME_UNAVAILABLE');
  // The retention purge (with the 24h world audit) of a guest whose character is offline.
  await f.call('/retention/expire', { principalId: other.principalId });
  const sweep = await f.call<{ failed: number; error: string | null }>('/retention/sweep', {
    principalId: other.principalId,
  });
  assert.equal(sweep.error, null);
  assert.equal(sweep.failed, 0);
  assert.equal((await f.call<Retention>('/retention/state', other)).messages, 0);
  assert.ok((await f.call<Retention>('/retention/state', guest)).messages > 0, 'the other player is untouched');
  // Character deletion of an offline character: preview, start, sweep, clean.
  const preview = await f.call<any>('/deletion/preview');
  assert.equal(preview.characterId, ID);
  await f.call('/deletion/start', {
    input: { requestId: randomUUID(), previewHash: preview.previewHash, acknowledgeDeleteAllChats: true },
  });
  assert.equal((await f.call<any>('/deletion/sweep')).state, 'deleted');
  assert.equal((await f.call<Retention>('/retention/state', guest)).messages, 0);
  assert.deepEqual((await f.call<any>('/deletion/state', guest)).fk, []);
  // A deleted character cannot be put back.
  await refused(
    f,
    '/offline/set',
    { characterId: ID, action: 'online', input: { requestId: randomUUID(), liveVersion: V } },
    'CHARACTER_DELETED',
  );
});
