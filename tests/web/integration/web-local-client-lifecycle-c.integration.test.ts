import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import { LocalSession, type LocalScope } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalApi, StaleLocalIdentityError } from '../../../apps/player-web/src/services/local-api.ts';
import { LocalIdentityController } from '../../../apps/player-web/src/session/identity-controller.ts';
import { LocalSendController } from '../../../apps/player-web/src/data/send-controller.ts';
import { LocalSyncController, type EventStream } from '../../../apps/player-web/src/data/sync-controller.ts';
import { IndexedDbLocalCache } from '../../../apps/player-web/src/data/local-cache.ts';
import type { PendingOperation, PendingStore } from '../../../apps/player-web/src/data/pending-operations.ts';

const bootstrap = (kind: 'guest' | 'account' = 'guest', expiresAt = 2000) => parseBootstrap({
  contractVersion: 'web-v1-local-2', mode: 'synthetic-local', region: 'local-test',
  instanceId: 'c-local-2', recoveryEpoch: 'c-epoch', csrf: 'c-csrf',
  access: { kind, principalId: 'c-person', playerId: 'c-player', worldId: 'c-world',
    revision: 2, trialCharacterId: 'c-character', trialRemaining: kind === 'guest' ? 2 : null,
    trialReserved: kind === 'guest' ? 0 : null, canSend: true, canChooseText: false,
    trialExpiresAt: kind === 'guest' ? expiresAt : null,
    retentionState: kind === 'guest' ? 'active' : 'protected' },
  characters: [{ characterId: 'c-character', name: 'C synthetic', synthetic: true,
    audition: { state: 'unavailable', reason: 'not_approved' } }],
  conversations: [{ conversationId: 'c-conversation', characterId: 'c-character' }],
  activeOperations: [], syncCursor: 'c-cursor', unsupported: ['invite']
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

class Pending implements PendingStore {
  readonly rows = new Map<string, PendingOperation>();
  readonly purged: string[] = [];
  private key(scope: LocalScope, id: string) { return `${scope.principalId}/${scope.worldId}/${id}`; }
  async put(item: PendingOperation) { this.rows.set(this.key(item.scope, item.requestId), structuredClone(item)); }
  async get(scope: LocalScope, id: string) { return this.rows.get(this.key(scope, id)) ?? null; }
  async list(scope: LocalScope) { return [...this.rows.values()].filter(row =>
    row.scope.principalId === scope.principalId && row.scope.worldId === scope.worldId); }
  async purgeScope(scope: LocalScope) {
    this.purged.push(scope.principalId);
    for (const [key, item] of this.rows) if (item.scope.principalId === scope.principalId &&
      item.scope.worldId === scope.worldId) this.rows.delete(key);
  }
}

test('C local-2: expiry while a fake durable put is pending prevents POST but not a late fake write', async () => {
  let now = 1000, posts = 0;
  const session = new LocalSession(() => now); session.install(bootstrap());
  const store = new Pending(), gate = deferred<void>(), entered = deferred<void>();
  const ordinaryPut = store.put.bind(store);
  store.put = async item => { entered.resolve(); await gate.promise; await ordinaryPut(item); };
  const api = { send: async () => { posts++; throw Error('unexpected network'); } } as unknown as LocalApi;
  const send = new LocalSendController(api, session, store, () => 'c-request');
  const result = send.send('c-character', 'synthetic private input');
  await entered.promise;
  now = 2000;
  session.denyContent();
  gate.resolve();
  assert.deepEqual(await result, { kind: 'stale_generation' });
  await tick();
  assert.equal(posts, 0);
  assert.deepEqual(store.purged, ['c-person']);
  assert.equal(store.rows.size, 1, 'fake put runs after its earlier purge; this is not an IDB cleanup proof');
  assert.equal(session.currentView?.bootstrap.access.retentionState, 'expired');
  assert.deepEqual(session.currentView?.bootstrap.conversations, []);
  await assert.rejects(send.send('c-character', 'again'), /TRIAL_EXPIRED/);
});

test('C local-2: 410 from sync denies body, closes stream, and blocks later catch-up', async () => {
  let calls = 0, streams = 0;
  const session = new LocalSession(() => 1000); session.install(bootstrap());
  const api = new LocalApi((async (path: string) => {
    assert.match(path, /\/api\/web\/local\/sync\?/);
    calls++;
    return Response.json({ error: { code: 'TRIAL_EXPIRED', requestId: null,
      retryAfterMs: null } }, { status: 410 });
  }) as typeof fetch);
  const controller = new LocalSyncController(api, session, {
    apply: async () => { throw Error('unexpected event'); }, refreshAccess: async () => {},
    refetchOperation: async () => { throw Error('unexpected refetch'); }, cursor: async () => {}
  }, () => { streams++; return { close() {}, onmessage: null, onerror: null } as EventStream; });
  await assert.rejects(controller.start('c-cursor'), /TRIAL_EXPIRED/);
  assert.equal(session.contentAvailable(), false);
  assert.equal(session.currentView?.bootstrap.access.retentionState, 'expired');
  assert.equal(streams, 0);
  await controller.visible(true);
  assert.equal(calls, 1, '410 must not schedule another sync');
  controller.stop();
});

test('C local-2: late registration response cannot revive expired generation', async () => {
  let now = 1000, bootstraps = 0;
  const session = new LocalSession(() => now); session.install(bootstrap());
  const receipt = deferred<void>(), entered = deferred<void>();
  const api = { register: async () => { entered.resolve(); await receipt.promise; },
    bootstrap: async () => { bootstraps++; return bootstrap('account'); } } as unknown as LocalApi;
  const registration = new LocalIdentityController(api, session).register('c-request', 'c-name', 'synthetic-password');
  await entered.promise;
  now = 2000; session.denyContent();
  receipt.resolve();
  await assert.rejects(registration, StaleLocalIdentityError);
  assert.equal(bootstraps, 0);
  assert.equal(session.currentView?.bootstrap.access.kind, 'guest');
  assert.equal(session.contentAvailable(), false);
});

test('C local-2: guest body never opens cache IDB, while account remains eligible', async () => {
  const opens: string[] = [];
  const factory = { open: (name: string) => { opens.push(name); throw Error('C IDB sentinel'); } } as unknown as IDBFactory;
  const cache = new IndexedDbLocalCache(factory);
  const session = new LocalSession(() => 1000); session.install(bootstrap());
  const guest = session.scope!;
  await cache.putDraft(guest, 'c-character', 'synthetic private draft');
  await cache.putMessages(guest, []);
  assert.equal(await cache.draft(guest, 'c-character'), null);
  assert.equal(await cache.message(guest, 'c-conversation', 'c-message'), null);
  assert.deepEqual(opens, [], 'local-2 guest body must not even open IndexedDB');
  session.install(bootstrap('account'));
  assert.equal(session.contentAvailable(), true);
  await assert.rejects(cache.putDraft(session.scope!, 'c-character', 'account draft'), /C IDB sentinel/);
  assert.deepEqual(opens, ['fake-bubble-web-local-cache']);
});
