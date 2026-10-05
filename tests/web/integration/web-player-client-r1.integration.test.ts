import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import type { WebLocalMessage, WebLocalOperation } from '../../../packages/contracts/web-local.ts';
import { LocalSession, type LocalScope } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalApi, LocalApiError } from '../../../apps/player-web/src/services/local-api.ts';
import { LocalIdentityController } from '../../../apps/player-web/src/session/identity-controller.ts';
import { LocalAudioController } from '../../../apps/player-web/src/media/audio-controller.ts';
import { LocalSyncController, type EventStream } from '../../../apps/player-web/src/data/sync-controller.ts';
import { LocalSendController } from '../../../apps/player-web/src/data/send-controller.ts';
import {
  scopeKey,
  type PendingOperation,
  type PendingStore,
} from '../../../apps/player-web/src/data/pending-operations.ts';

const base = {
  contractVersion: 'web-v1-local-1',
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'c-instance',
  recoveryEpoch: 'c-epoch',
  csrf: 'c-csrf',
  access: {
    kind: 'account',
    principalId: 'c-principal',
    playerId: 'c-player',
    worldId: 'c-world',
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
const view = parseBootstrap(base);
const receipt: WebLocalOperation = {
  operationId: 'c-op',
  requestId: 'c-original',
  conversationId: 'c-conversation',
  status: 'queued',
  revision: 1,
  acceptedAt: 1,
  deadlineAt: 300_001,
  errorCode: null,
  canCancel: true,
  publication: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function intent(scope: LocalScope): PendingOperation {
  return {
    scope,
    characterId: 'synthetic-local',
    requestId: 'c-original',
    text: 'C saved input',
    delivery: 'voice',
    state: 'network_uncertain',
    operationId: null,
  };
}
class Store implements PendingStore {
  readonly rows = new Map<string, PendingOperation>();
  writes = 0;
  readonly key = (scope: LocalScope, id: string) => `${scopeKey(scope)}\u001f${id}`;
  async put(item: PendingOperation) {
    this.writes++;
    this.rows.set(this.key(item.scope, item.requestId), structuredClone(item));
  }
  async get(scope: LocalScope, id: string) {
    return this.rows.get(this.key(scope, id)) ?? null;
  }
  async list(scope: LocalScope) {
    return [...this.rows.values()].filter((row) => scopeKey(row.scope) === scopeKey(scope) && row.state !== 'accepted');
  }
}

test('A-WEB-021 R1 C: retry suspended in durable get must not rebind to a later UI generation', async () => {
  const session = new LocalSession();
  session.install(view);
  const old = intent(session.scope!),
    gate = deferred<PendingOperation | null>(),
    entered = deferred<void>();
  const store = new Store();
  await store.put(old);
  store.writes = 0;
  store.get = async () => {
    entered.resolve();
    return gate.promise;
  };
  let sends = 0;
  const api = {
    send: async () => {
      sends++;
      return receipt;
    },
    byRequest: async () => {
      throw Error('unexpected lookup');
    },
  } as unknown as LocalApi;
  const retry = new LocalSendController(api, session, store).retrySame(old);
  await entered.promise;
  session.install(view); // Same principal/world, but this is a new volatile generation.
  gate.resolve(old);
  assert.deepEqual(
    { result: await retry, sends, writes: store.writes },
    { result: { kind: 'stale_generation' }, sends: 0, writes: 0 },
    'old user action must not POST or rewrite pending intent after generation turnover',
  );
});

test('C R1 positive: a newly explicit same-ID retry in the current generation still works', async () => {
  const session = new LocalSession();
  session.install(view);
  const saved = intent(session.scope!),
    store = new Store();
  await store.put(saved);
  session.install(view); // Old durable intent, new explicit user action after trusted rebootstrap.
  let sends = 0;
  const api = {
    send: async (_character: string, id: string, text: string) => {
      sends++;
      assert.equal(id, saved.requestId);
      assert.equal(text, saved.text);
      return receipt;
    },
  } as unknown as LocalApi;
  const result = await new LocalSendController(api, session, store).retrySame(saved);
  assert.equal(result.kind, 'accepted');
  assert.equal(sends, 1);
  assert.equal((await store.get(session.scope!, saved.requestId))?.operationId, receipt.operationId);
});

test('C R1: a retry rotated while durable put is pending cannot dispatch', async () => {
  const session = new LocalSession();
  session.install(view);
  const saved = intent(session.scope!),
    store = new Store();
  await store.put(saved);
  const writeGate = deferred<void>(),
    entered = deferred<void>(),
    ordinaryPut = store.put.bind(store);
  store.put = async (item) => {
    entered.resolve();
    await writeGate.promise;
    await ordinaryPut(item);
  };
  let sends = 0;
  const api = {
    send: async () => {
      sends++;
      return receipt;
    },
  } as unknown as LocalApi;
  const retry = new LocalSendController(api, session, store).retrySame(saved);
  await entered.promise;
  session.install(view);
  writeGate.resolve();
  assert.deepEqual(await retry, { kind: 'stale_generation' });
  assert.equal(sends, 0);
});

test('C R1: unknown-ID recovery is scoped and only checks by-request, including 404', async () => {
  const before = new LocalSession();
  before.install(view);
  const store = new Store(),
    saved = intent(before.scope!);
  await store.put(saved);
  await store.put(intent({ ...before.scope!, principalId: 'another-principal' }));
  await store.put(intent({ ...before.scope!, recoveryEpoch: 'other-epoch' }));
  const now = new LocalSession();
  now.install(view);
  let lookups = 0,
    sends = 0;
  const api = {
    byRequest: async (id: string) => {
      lookups++;
      assert.equal(id, saved.requestId);
      throw new LocalApiError(404, 'NOT_FOUND');
    },
    send: async () => {
      sends++;
      return receipt;
    },
  } as unknown as LocalApi;
  const result = await new LocalSendController(api, now, store).recoverPending();
  assert.deepEqual(result, [{ kind: 'network_uncertain', requestId: saved.requestId }]);
  assert.equal(lookups, 1);
  assert.equal(sends, 0);
  assert.equal((await store.get(now.scope!, saved.requestId))?.state, 'network_uncertain');
});

test('C R1: valid old-cookie receipt recovery survives its own identity transition', async () => {
  const session = new LocalSession();
  session.install(view);
  const signal = session.signal,
    before = session.scope!;
  let boots = 0,
    challenges = 0,
    recoveries = 0;
  const api = {
    bootstrap: async () => {
      if (++boots === 1) throw new LocalApiError(409, 'SESSION_ROTATED_RECOVERABLE');
      return view;
    },
    receiptChallenge: async () => {
      challenges++;
      return 'c-challenge';
    },
    recoverRegister: async () => {
      recoveries++;
      return { principalId: before.principalId, accountId: 'c-account' };
    },
  } as unknown as LocalApi;
  const result = await new LocalIdentityController(api, session).recoverRegister(
    'c-receipt',
    'c-name',
    'not-a-real-password',
  );
  assert.equal(result, view);
  assert.equal(challenges, 1);
  assert.equal(recoveries, 1);
  assert.equal(signal.aborted, true);
  assert.equal(session.scope?.principalId, before.principalId);
  assert.notEqual(session.scope?.generation, before.generation);
});

test('C R1: late rejection of an old play cannot pause a newer audio element', async (t) => {
  const session = new LocalSession();
  session.install(view);
  let rejectFirst!: (reason: Error) => void;
  const oldPlay = new Promise<void>((_, reject) => {
    rejectFirst = reject;
  });
  const entered = deferred<void>();
  const elements: {
    pauses: number;
    src: string;
    play(): Promise<void>;
    pause(): void;
    removeAttribute(name: string): void;
    load(): void;
  }[] = [];
  const audio = new LocalAudioController(
    session,
    (async () => new Response(new Blob(['RIFF'], { type: 'audio/wav' }))) as typeof fetch,
    () => {
      const first = elements.length === 0;
      const element = {
        src: '',
        pauses: 0,
        play: () => (first ? (entered.resolve(), oldPlay) : Promise.resolve()),
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
  t.after(() => audio.stop());
  const message = (id: string): WebLocalMessage => ({
    messageId: id,
    conversationId: 'c',
    characterId: 'synthetic-local',
    operationId: 'o',
    replyOrdinal: 0,
    author: 'character',
    origin: 'narrative',
    text: 'C synthetic',
    createdAt: 1,
    audio: { status: 'ready', mediaId: id, synthetic: true },
  });
  const first = audio.play(message('old'));
  await entered.promise;
  assert.equal(await audio.play(message('new')), 'playing');
  rejectFirst(Error('late old playback rejection'));
  assert.equal(await first, 'stale_generation');
  assert.equal(elements[1]!.pauses, 0);
});

test('C R1: failed cursor persistence blocks the queued next SSE event until catch-up', async () => {
  const session = new LocalSession();
  session.install(view);
  const blocked = deferred<{ events: []; cursor: string; hasMore: false }>();
  let reads = 0,
    stream!: EventStream;
  const api = {
    sync: async () => (++reads === 1 ? { events: [], cursor: 'c0', hasMore: false } : blocked.promise),
    eventUrl: () => '/synthetic-events',
  } as unknown as LocalApi;
  const applied: string[] = [],
    committed: string[] = [];
  const sync = new LocalSyncController(
    api,
    session,
    {
      apply: async (event) => {
        applied.push(event.eventId);
      },
      refreshAccess: async () => {},
      refetchOperation: async () => receipt,
      cursor: async (cursor) => {
        if (cursor === 'e1') throw Error('C cursor store unavailable');
        committed.push(cursor);
      },
    },
    () => (stream = { close() {}, onmessage: null, onerror: null }),
  );
  try {
    await sync.start('c0');
    committed.length = 0;
    for (const id of ['e1', 'e2'])
      stream.onmessage!({
        data: JSON.stringify({ eventId: id, conversationId: 'c', kind: 'publication', revision: 1, payload: {} }),
        lastEventId: id,
      } as MessageEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual({ applied, committed }, { applied: ['e1'], committed: [] });
  } finally {
    sync.stop();
    blocked.resolve({ events: [], cursor: 'c0', hasMore: false });
  }
});

test('C R2: by-request 404 persisted across a generation change cannot report current uncertainty', async () => {
  const session = new LocalSession();
  session.install(view);
  const saved = intent(session.scope!),
    store = new Store();
  await store.put(saved);
  const pendingWrite = deferred<void>(),
    entered = deferred<void>(),
    ordinaryPut = store.put.bind(store);
  store.put = async (item) => {
    entered.resolve();
    await pendingWrite.promise;
    await ordinaryPut(item);
  };
  let sends = 0;
  const api = {
    byRequest: async () => {
      throw new LocalApiError(404, 'NOT_FOUND');
    },
    send: async () => {
      sends++;
      return receipt;
    },
  } as unknown as LocalApi;
  const lookup = new LocalSendController(api, session, store).lookup(saved);
  await entered.promise;
  session.install(view);
  pendingWrite.resolve();
  assert.deepEqual(await lookup, { kind: 'stale_generation' });
  assert.equal(sends, 0);
});

test('C R2: recovery finishing an uncertain lookup after rotation returns only stale', async () => {
  const session = new LocalSession();
  session.install(view);
  const saved = intent(session.scope!),
    store = new Store();
  await store.put(saved);
  const pendingWrite = deferred<void>(),
    entered = deferred<void>(),
    ordinaryPut = store.put.bind(store);
  store.put = async (item) => {
    entered.resolve();
    await pendingWrite.promise;
    await ordinaryPut(item);
  };
  let sends = 0,
    lookups = 0;
  const api = {
    byRequest: async () => {
      lookups++;
      throw new LocalApiError(404, 'NOT_FOUND');
    },
    send: async () => {
      sends++;
      return receipt;
    },
  } as unknown as LocalApi;
  const recovery = new LocalSendController(api, session, store).recoverPending();
  await entered.promise;
  session.install(view);
  pendingWrite.resolve();
  assert.deepEqual(await recovery, [{ kind: 'stale_generation' }]);
  assert.equal(lookups, 1);
  assert.equal(sends, 0);
});
