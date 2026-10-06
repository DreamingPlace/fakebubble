import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalSendController } from '../../../apps/player-web/src/data/send-controller.ts';
import { LocalApi, LocalApiError } from '../../../apps/player-web/src/services/local-api.ts';
import type { PendingOperation, PendingStore } from '../../../apps/player-web/src/data/pending-operations.ts';

const boot = {
  contractVersion: 'web-v1-local-1',
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'i',
  recoveryEpoch: 'e',
  csrf: 'csrf',
  access: {
    kind: 'account',
    principalId: 'p',
    playerId: 'player',
    worldId: 'w',
    revision: 1,
    trialCharacterId: null,
    trialRemaining: null,
    trialReserved: null,
    canSend: true,
    canChooseText: false,
  },
  characters: [
    {
      characterId: 'synthetic-local',
      name: 'Synthetic',
      synthetic: true,
      audition: { state: 'unavailable', reason: 'not_approved' },
    },
  ],
  conversations: [],
  activeOperations: [],
  syncCursor: 'c0',
  unsupported: ['invite'],
};
const view = parseBootstrap(boot);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const intent = (scope: PendingOperation['scope']): PendingOperation => ({
  scope,
  characterId: 'synthetic-local',
  requestId: 'original',
  text: 'synthetic input',
  delivery: 'voice',
  state: 'network_uncertain',
  operationId: null,
});

test('021 R2: retrySame read held across generation switch never POSTs or writes', async () => {
  const session = new LocalSession();
  session.install(view);
  const item = intent(session.scope!);
  const read = deferred<PendingOperation>();
  const writes: PendingOperation[] = [];
  let sends = 0;
  const store = {
    get: () => read.promise,
    put: async (next: PendingOperation) => {
      writes.push(next);
    },
    list: async () => [],
  } as unknown as PendingStore;
  const api = {
    send: async () => {
      sends++;
      throw new Error('must not send');
    },
  } as unknown as LocalApi;
  const pending = new LocalSendController(api, session, store).retrySame(item);
  session.install(view);
  read.resolve(item);
  assert.deepEqual(await pending, { kind: 'stale_generation' });
  assert.equal(sends, 0);
  assert.deepEqual(writes, []);
});

test('021 R2: retrySame durable put held across switch never POSTs', async () => {
  const session = new LocalSession();
  session.install(view);
  const item = intent(session.scope!);
  const write = deferred<void>();
  let sends = 0;
  const store = { get: async () => item, put: () => write.promise, list: async () => [] } as unknown as PendingStore;
  const api = {
    send: async () => {
      sends++;
      throw new Error('must not send');
    },
  } as unknown as LocalApi;
  const pending = new LocalSendController(api, session, store).retrySame(item);
  await new Promise((resolve) => setImmediate(resolve));
  session.install(view);
  write.resolve();
  assert.deepEqual(await pending, { kind: 'stale_generation' });
  assert.equal(sends, 0);
});

test('021 R2: explicit new-generation retry may reuse old durable ID and payload', async () => {
  const session = new LocalSession();
  session.install(view);
  const old = intent(session.scope!);
  session.install(view);
  let sends = 0,
    sentId = '',
    sentText = '';
  const store = { get: async () => old, put: async () => {}, list: async () => [] } as unknown as PendingStore;
  const api = {
    send: async (_character: string, id: string, text: string) => {
      sends++;
      sentId = id;
      sentText = text;
      return {
        operationId: 'o',
        requestId: id,
        conversationId: 'c',
        status: 'queued',
        revision: 1,
        acceptedAt: 1,
        deadlineAt: 1000,
        errorCode: null,
        canCancel: true,
        publication: null,
      };
    },
  } as unknown as LocalApi;
  const result = await new LocalSendController(api, session, store).retrySame(old);
  assert.equal(result.kind, 'accepted');
  assert.equal(sends, 1);
  assert.equal(sentId, 'original');
  assert.equal(sentText, 'synthetic input');
});

test('021 R2: lookup 404 storage write held across switch returns stale', async () => {
  const session = new LocalSession();
  session.install(view);
  const item = intent(session.scope!);
  const write = deferred<void>();
  const store = { get: async () => item, put: () => write.promise, list: async () => [] } as unknown as PendingStore;
  const api = {
    byRequest: async () => {
      throw new LocalApiError(404, 'NOT_FOUND');
    },
  } as unknown as LocalApi;
  const pending = new LocalSendController(api, session, store).lookup(item);
  await new Promise((resolve) => setImmediate(resolve));
  session.install(view);
  write.resolve();
  assert.deepEqual(await pending, { kind: 'stale_generation' });
});

test('021 R2: recoverPending list held across switch returns stale without lookup', async () => {
  const session = new LocalSession();
  session.install(view);
  const item = intent(session.scope!);
  const read = deferred<PendingOperation[]>();
  let lookups = 0;
  const store = { list: () => read.promise, get: async () => item, put: async () => {} } as unknown as PendingStore;
  const api = {
    byRequest: async () => {
      lookups++;
      throw new Error('must not lookup');
    },
  } as unknown as LocalApi;
  const pending = new LocalSendController(api, session, store).recoverPending();
  session.install(view);
  read.resolve([item]);
  assert.deepEqual(await pending, [{ kind: 'stale_generation' }]);
  assert.equal(lookups, 0);
});

test('021 R2: recoverPending lookup response held across switch cannot publish to new UI', async () => {
  const session = new LocalSession();
  session.install(view);
  const item = intent(session.scope!);
  const response = deferred<{
    operationId: string;
    requestId: string;
    conversationId: string;
    status: 'queued';
    revision: number;
    acceptedAt: number;
    deadlineAt: number;
    errorCode: null;
    canCancel: true;
    publication: null;
  }>();
  let writes = 0;
  const store = {
    list: async () => [item],
    get: async () => item,
    put: async () => {
      writes++;
    },
  } as unknown as PendingStore;
  const api = { byRequest: () => response.promise } as unknown as LocalApi;
  const pending = new LocalSendController(api, session, store).recoverPending();
  await new Promise((resolve) => setImmediate(resolve));
  session.install(view);
  response.resolve({
    operationId: 'o',
    requestId: 'original',
    conversationId: 'c',
    status: 'queued',
    revision: 1,
    acceptedAt: 1,
    deadlineAt: 1000,
    errorCode: null,
    canCancel: true,
    publication: null,
  });
  assert.deepEqual(await pending, [{ kind: 'stale_generation' }]);
  assert.equal(writes, 0);
});
