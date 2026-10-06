import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import type { WebLocalMessage } from '../../../packages/contracts/web-local.ts';
import { LocalIdentityController } from '../../../apps/player-web/src/session/identity-controller.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalApi, LocalApiError } from '../../../apps/player-web/src/services/local-api.ts';
import { LocalAudioController } from '../../../apps/player-web/src/media/audio-controller.ts';
import { LocalSyncController, type EventStream } from '../../../apps/player-web/src/data/sync-controller.ts';
import { IndexedDbPendingStore } from '../../../apps/player-web/src/data/pending-operations.ts';
import { LocalSendController } from '../../../apps/player-web/src/data/send-controller.ts';

const base = {
  contractVersion: 'web-v1-local-1',
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'c-instance',
  recoveryEpoch: 'c-epoch',
  csrf: 'c-guest-csrf',
  access: {
    kind: 'guest',
    principalId: 'c-principal',
    playerId: 'c-player',
    worldId: 'c-world',
    revision: 1,
    trialCharacterId: null,
    trialRemaining: 3,
    trialReserved: 0,
    canSend: true,
    canChooseText: false,
  },
  characters: [
    {
      characterId: 'synthetic-local',
      name: 'C synthetic',
      synthetic: true,
      audition: { state: 'unavailable', reason: 'not_approved' },
    },
  ],
  conversations: [],
  activeOperations: [],
  syncCursor: 'c0',
  unsupported: ['invite'],
};
const guest = parseBootstrap(base);
const account = parseBootstrap({
  ...base,
  csrf: 'c-account-csrf',
  access: { ...base.access, kind: 'account', trialRemaining: null, trialReserved: null },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const kind of ['register', 'recover'] as const)
  test(`A-WEB-018 C: late ${kind} cannot reinstall an invalidated identity`, async () => {
    const session = new LocalSession();
    session.install(guest);
    const gate = deferred<void>();
    const api = {
      register: () => gate.promise,
      bootstrap: () => (kind === 'recover' ? gate.promise.then(() => account) : Promise.resolve(account)),
      receiptStatus: async () => ({ principalId: 'c-principal', accountId: 'c-account' }),
    } as unknown as LocalApi;
    const identity = new LocalIdentityController(api, session);
    const pending =
      kind === 'register'
        ? identity.register('id', 'name', 'not-secret')
        : identity.recoverRegister('id', 'name', 'not-secret');
    session.invalidate();
    gate.resolve();
    try {
      await pending;
    } catch {
      /* Fail-closed rejection is also acceptable. */
    }
    assert.equal(session.currentView, null, `${kind} revived an invalidated principal`);
  });

test('A-WEB-018 C: delayed older bootstrap cannot overwrite a newer identity CSRF', async () => {
  const slow = deferred<Response>();
  let bootstrapCalls = 0,
    sentCsrf = '';
  const fetcher = (async (path: string, init?: RequestInit) => {
    if (path.endsWith('/bootstrap')) {
      if (++bootstrapCalls === 1) return slow.promise;
      return Response.json(account.bootstrap);
    }
    if (path.includes('/characters/')) {
      sentCsrf = String((init?.headers as Record<string, string>)['X-CSRF-Token']);
      return Response.json({
        duplicate: false,
        operation: {
          operationId: 'o',
          requestId: 'r',
          conversationId: 'c',
          status: 'queued',
          revision: 1,
          acceptedAt: 1,
          deadlineAt: 2,
          errorCode: null,
          canCancel: true,
          publication: null,
        },
      });
    }
    throw new Error(`unexpected path ${path}`);
  }) as typeof fetch;
  const api = new LocalApi(fetcher);
  const older = api.bootstrap();
  await api.bootstrap();
  slow.resolve(Response.json(guest.bootstrap));
  await older;
  await api.send('synthetic-local', 'r', 'synthetic');
  assert.equal(sentCsrf, account.bootstrap.csrf, 'old bootstrap restored an obsolete CSRF');
});

test('A-WEB-019 C: late first play fulfillment must not pause or revoke second playback', async (t) => {
  const session = new LocalSession();
  session.install(guest);
  const firstPlay = deferred<void>(),
    entered = deferred<void>();
  const elements: {
    pauses: number;
    play(): Promise<void>;
    pause(): void;
    removeAttribute(name: string): void;
    load(): void;
    src: string;
  }[] = [];
  const media = new LocalAudioController(
    session,
    (async () => new Response(new Blob(['RIFF'], { type: 'audio/wav' }))) as typeof fetch,
    () => {
      const first = elements.length === 0;
      const element = {
        src: '',
        pauses: 0,
        play: () => {
          if (first) {
            entered.resolve();
            return firstPlay.promise;
          }
          return Promise.resolve();
        },
        pause() {
          this.pauses++;
        },
        removeAttribute(_name: string) {},
        load() {},
      };
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    },
  );
  t.after(() => media.stop());
  const message = (id: string): WebLocalMessage => ({
    messageId: id,
    conversationId: 'c',
    characterId: 'synthetic-local',
    operationId: 'o',
    replyOrdinal: 0,
    author: 'character',
    origin: 'narrative',
    text: 'synthetic',
    createdAt: 1,
    audio: { status: 'ready', mediaId: id, synthetic: true },
  });
  const first = media.play(message('m1'));
  await entered.promise; // Do not race Response.blob with the second play.
  assert.equal(await media.play(message('m2')), 'playing');
  assert.equal(elements[1]!.pauses, 0);
  firstPlay.resolve();
  assert.equal(await first, 'stale_generation');
  assert.equal(elements[1]!.pauses, 0, 'old completion stopped the newer audio');
});

test('A-WEB-020 C: failed SSE apply cannot commit a queued successor while catch-up is blocked', async () => {
  const session = new LocalSession();
  session.install(guest);
  const blockedPage = deferred<{ events: []; cursor: string; hasMore: false }>();
  let reads = 0,
    stream!: EventStream;
  const api = {
    sync: () => (++reads === 1 ? Promise.resolve({ events: [], cursor: 'c0', hasMore: false }) : blockedPage.promise),
    eventUrl: () => '/synthetic-events',
  } as unknown as LocalApi;
  const applied: string[] = [],
    committed: string[] = [],
    errors: unknown[] = [];
  const controller = new LocalSyncController(
    api,
    session,
    {
      apply: async (event) => {
        if (event.eventId === 'e1') throw Error('C injected sink failure');
        applied.push(event.eventId);
      },
      refreshAccess: async () => {},
      refetchOperation: async () => {
        throw Error('unexpected refetch');
      },
      cursor: async (cursor) => {
        committed.push(cursor);
      },
      onError: (error) => {
        errors.push(error);
      },
    },
    () => (stream = { close() {}, onmessage: null, onerror: null }),
  );
  try {
    await controller.start('c0');
    committed.length = 0;
    for (const id of ['e1', 'e2'])
      stream.onmessage!({
        data: JSON.stringify({ eventId: id, conversationId: 'c', kind: 'publication', revision: 1, payload: {} }),
        lastEventId: id,
      } as MessageEvent);
    await tick();
    await tick();
    assert.equal(errors.length, 1);
    assert.deepEqual(
      { applied, committed },
      { applied: [], committed: [] },
      'successor was applied/committed before failed predecessor recovered',
    );
  } finally {
    controller.stop();
    blockedPage.resolve({ events: [], cursor: 'c0', hasMore: false });
    await tick();
  }
});

/** Minimal persistent IDB transaction shim: two store instances share one durable map. */
function idbMemory() {
  const rows = new Map<string, unknown>();
  const db = {
    createObjectStore() {},
    transaction() {
      const tx: any = { oncomplete: null, onabort: null, onerror: null };
      tx.objectStore = () => ({
        put(value: unknown, key: string) {
          queueMicrotask(() => {
            rows.set(key, structuredClone(value));
            tx.oncomplete?.();
          });
        },
        get(key: string) {
          const request: any = { result: undefined, onsuccess: null, onerror: null };
          queueMicrotask(() => {
            request.result = structuredClone(rows.get(key));
            request.onsuccess?.();
          });
          return request;
        },
      });
      return tx;
    },
  };
  const factory = {
    open() {
      const request: any = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return factory;
}

test('A-WEB-021 C: lost-receipt intent remains discoverable by current authenticated scope after reload', async () => {
  const factory = idbMemory();
  const prior = new LocalSession();
  prior.install(guest);
  prior.install(account);
  const saved = new IndexedDbPendingStore(factory);
  const api = {
    send: async () => {
      throw new TypeError('C dropped response');
    },
    byRequest: async () => {
      throw new LocalApiError(404, 'NOT_FOUND');
    },
  } as unknown as LocalApi;
  const result = await new LocalSendController(api, prior, saved, () => 'same-request').send(
    'synthetic-local',
    'synthetic input',
  );
  assert.deepEqual(result, { kind: 'network_uncertain', requestId: 'same-request' });
  const refreshed = new LocalSession();
  refreshed.install(account);
  const reopened = new IndexedDbPendingStore(factory);
  const recovered = await reopened.get(refreshed.scope!, 'same-request');
  assert.equal(recovered?.requestId, 'same-request', 'same account lost its persisted request');
  assert.equal(recovered?.state, 'network_uncertain');
  assert.equal(await reopened.get({ ...refreshed.scope!, principalId: 'another-account' }, 'same-request'), null);
  assert.equal(await reopened.get({ ...refreshed.scope!, recoveryEpoch: 'new-epoch' }, 'same-request'), null);
});
