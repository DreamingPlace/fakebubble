import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBootstrap, parseError, WebLocalProtocolError } from '../../../packages/contracts/web-local-client.ts';
import type { WebLocalOperation } from '../../../packages/contracts/web-local.ts';
import { LocalSendController } from '../../../apps/player-web/src/data/send-controller.ts';
import type { PendingOperation, PendingStore } from '../../../apps/player-web/src/data/pending-operations.ts';
import { scopeKey } from '../../../apps/player-web/src/data/pending-operations.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalApi, LocalApiError } from '../../../apps/player-web/src/services/local-api.ts';
import { LocalSyncController } from '../../../apps/player-web/src/data/sync-controller.ts';
import { LocalAudioController } from '../../../apps/player-web/src/media/audio-controller.ts';
import { LocalIdentityController } from '../../../apps/player-web/src/session/identity-controller.ts';
import type { WebLocalMessage } from '../../../packages/contracts/web-local.ts';
import { draftKey, messageKey } from '../../../apps/player-web/src/data/local-cache.ts';

const boot = {
  contractVersion: 'web-v1-local-1',
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'test',
  recoveryEpoch: 'epoch',
  csrf: 'csrf',
  access: {
    kind: 'guest',
    principalId: 'p',
    playerId: 'player',
    worldId: 'w',
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
      name: 'Test',
      synthetic: true,
      audition: { state: 'unavailable', reason: 'not_approved' },
    },
  ],
  conversations: [],
  activeOperations: [],
  syncCursor: 'cursor',
  unsupported: ['invite'],
};
const op: WebLocalOperation = {
  operationId: 'op',
  requestId: 'r1',
  conversationId: 'c',
  status: 'queued',
  revision: 1,
  acceptedAt: 1,
  deadlineAt: 300001,
  errorCode: null,
  canCancel: true,
  publication: null,
};
const view = parseBootstrap(boot);

class MemoryStore implements PendingStore {
  items = new Map<string, PendingOperation>();
  fail = false;
  async put(item: PendingOperation) {
    if (this.fail) throw new Error('commit failed');
    this.items.set(item.requestId, structuredClone(item));
  }
  async get(_scope: PendingOperation['scope'], id: string) {
    return this.items.get(id) ?? null;
  }
  async list(scope: PendingOperation['scope']) {
    return [...this.items.values()].filter(
      (item) => item.state !== 'accepted' && scopeKey(item.scope) === scopeKey(scope),
    );
  }
}
test('local protocol refuses unknown version/mode/error instead of draft casting', () => {
  assert.throws(() => parseBootstrap({ ...boot, mode: 'live' }), WebLocalProtocolError);
  assert.throws(() => parseBootstrap({ ...boot, contractVersion: 'web-v1-draft-1' }), WebLocalProtocolError);
  assert.throws(() => parseError({ error: { code: 'X' } }), WebLocalProtocolError);
});
test('commit before send, simultaneous click one intent; later explicit action new ID', async () => {
  const session = new LocalSession();
  session.install(view);
  const store = new MemoryStore();
  let calls = 0,
    ids = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = {
    send: async (_c: string, requestId: string) => {
      calls++;
      assert.ok(store.items.has(requestId));
      await gate;
      return { ...op, requestId };
    },
  } as unknown as LocalApi;
  const controller = new LocalSendController(api, session, store, () => `r${++ids}`);
  const first = controller.send('synthetic-local', 'hello');
  const second = controller.send('synthetic-local', 'hello');
  assert.strictEqual(first, second);
  release();
  assert.equal((await first).kind, 'accepted');
  assert.equal(calls, 1);
  await Promise.resolve();
  assert.equal((await controller.send('synthetic-local', 'hello')).kind, 'accepted');
  assert.equal(calls, 2);
  assert.equal(ids, 2);
});
test('failed pending commit prevents network dispatch', async () => {
  const session = new LocalSession();
  session.install(view);
  const store = new MemoryStore();
  store.fail = true;
  let calls = 0;
  const api = {
    send: async () => {
      calls++;
      return op;
    },
  } as unknown as LocalApi;
  await assert.rejects(new LocalSendController(api, session, store).send('synthetic-local', 'x'));
  assert.equal(calls, 0);
});
test('lost 202 and 404 remain network-uncertain, never resend', async () => {
  const session = new LocalSession();
  session.install(view);
  const store = new MemoryStore();
  let sends = 0,
    lookups = 0;
  const api = {
    send: async () => {
      sends++;
      throw new TypeError('network');
    },
    byRequest: async () => {
      lookups++;
      throw new LocalApiError(404, 'NOT_FOUND');
    },
  } as unknown as LocalApi;
  const result = await new LocalSendController(api, session, store, () => 'r1').send('synthetic-local', 'x');
  assert.deepEqual(result, { kind: 'network_uncertain', requestId: 'r1' });
  assert.equal(store.items.get('r1')?.state, 'network_uncertain');
  assert.equal(sends, 1);
  assert.equal(lookups, 1);
});
test('server 500 after possible admission checks original requestId instead of declaring rejection', async () => {
  const session = new LocalSession();
  session.install(view);
  const store = new MemoryStore();
  let sends = 0;
  const api = {
    send: async () => {
      sends++;
      throw new LocalApiError(500, 'INTERNAL_ERROR');
    },
    byRequest: async () => op,
  } as unknown as LocalApi;
  const result = await new LocalSendController(api, session, store, () => 'r1').send('synthetic-local', 'x');
  assert.equal(result.kind, 'accepted');
  assert.equal(sends, 1);
  assert.equal(store.items.get('r1')?.operationId, 'op');
});
test('same principal/world identity rotation fences late response', async () => {
  const session = new LocalSession();
  session.install(view);
  const store = new MemoryStore();
  let finish!: (value: WebLocalOperation) => void;
  const api = {
    send: () =>
      new Promise<WebLocalOperation>((resolve) => {
        finish = resolve;
      }),
  } as unknown as LocalApi;
  const task = new LocalSendController(api, session, store, () => 'r1').send('synthetic-local', 'x');
  await new Promise((resolve) => setImmediate(resolve));
  session.install(view);
  finish(op);
  assert.deepEqual(await task, { kind: 'stale_generation' });
  assert.equal(store.items.get('r1')?.state, 'stored');
});
test('sync applies before cursor, replays duplicate and detects revision conflict', async () => {
  const session = new LocalSession();
  session.install(view);
  const event = {
    eventId: 'e1',
    conversationId: 'c',
    kind: 'operation' as const,
    revision: 1,
    payload: { operationId: 'op', status: 'queued' },
  };
  let page = 0,
    failApply = true;
  const actions: string[] = [];
  const api = {
    sync: async () => ({ events: page++ === 0 ? [event] : [event], cursor: 'e1', hasMore: false }),
    eventUrl: () => '/events',
  } as unknown as LocalApi;
  const sink = {
    apply: async () => {
      actions.push('apply');
      if (failApply) throw Error('sink');
    },
    refreshAccess: async () => {},
    refetchOperation: async () => op,
    cursor: async () => {
      actions.push('cursor');
    },
  };
  let streamCount = 0;
  const sync = new LocalSyncController(api, session, sink, () => {
    streamCount++;
    return { close() {}, onmessage: null, onerror: null };
  });
  await assert.rejects(sync.start('start'));
  assert.deepEqual(actions, ['apply']);
  failApply = false;
  await sync.start('start');
  assert.equal(streamCount, 1);
  assert.deepEqual(actions.slice(-2), ['apply', 'cursor']);
  sync.stop();
});
test('same-revision conflicting sync payload refetches and does not commit conflicted cursor', async () => {
  const session = new LocalSession();
  session.install(view);
  const first = {
    eventId: 'e1',
    conversationId: 'c',
    kind: 'operation',
    revision: 1,
    payload: { operationId: 'op', status: 'queued' },
  };
  const second = { ...first, eventId: 'e2', payload: { operationId: 'op', status: 'failed' } };
  let refetched = 0;
  const committed: string[] = [];
  const api = {
    sync: async () => ({ events: [first, second], cursor: 'e2', hasMore: false }),
    eventUrl: () => '/events',
  } as unknown as LocalApi;
  const sync = new LocalSyncController(
    api,
    session,
    {
      apply: async () => {},
      refreshAccess: async () => {},
      refetchOperation: async () => {
        refetched++;
        return op;
      },
      cursor: async (cursor) => {
        committed.push(cursor);
      },
    },
    () => ({ close() {}, onmessage: null, onerror: null }),
  );
  await assert.rejects(sync.start('start'), /conflicting operation revision/);
  assert.equal(refetched, 1);
  assert.deepEqual(committed, []);
});
test('late private audio fetch cannot play after generation change', async () => {
  const session = new LocalSession();
  session.install(view);
  let finish!: (response: Response) => void;
  let played = 0;
  const fetcher = (() =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    })) as typeof fetch;
  const media = new LocalAudioController(
    session,
    fetcher,
    () =>
      ({
        play: async () => {
          played++;
        },
        pause() {},
        removeAttribute() {},
        load() {},
        src: '',
      }) as unknown as HTMLAudioElement,
  );
  const message: WebLocalMessage = {
    messageId: 'm',
    conversationId: 'c',
    characterId: 'synthetic-local',
    operationId: 'op',
    replyOrdinal: 1,
    author: 'character',
    origin: 'narrative',
    text: 'x',
    createdAt: 1,
    audio: { status: 'ready', mediaId: 'a', synthetic: true },
  };
  const pending = media.play(message);
  session.install(view);
  finish(new Response(new Blob(['RIFF'], { type: 'audio/wav' }), { status: 200 }));
  assert.equal(await pending, 'stale_generation');
  assert.equal(played, 0);
});
test('in-place registration does not abort its own request and rotates generation on receipt', async () => {
  const session = new LocalSession();
  session.install(view);
  const oldScope = session.scope!,
    oldSignal = session.signal;
  let finish!: () => void;
  const api = {
    register: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    bootstrap: async () =>
      parseBootstrap({
        ...boot,
        access: { ...boot.access, kind: 'account', trialRemaining: null, trialReserved: null },
      }),
  } as unknown as LocalApi;
  const pending = new LocalIdentityController(api, session).register('r', 'name', 'password');
  assert.equal(oldSignal.aborted, false);
  finish();
  await pending;
  assert.equal(oldSignal.aborted, true);
  assert.equal(session.scope?.principalId, oldScope.principalId);
  assert.equal(session.scope?.worldId, oldScope.worldId);
  assert.notEqual(session.scope?.generation, oldScope.generation);
});
test('draft and history cache keys partition world, identity generation and stable IDs', () => {
  const session = new LocalSession();
  session.install(view);
  const scope = session.scope!;
  assert.equal(draftKey(scope, 'a'), draftKey({ ...scope, generation: scope.generation + 1 }, 'a'));
  assert.notEqual(draftKey(scope, 'a'), draftKey({ ...scope, worldId: 'other' }, 'a'));
  const message: WebLocalMessage = {
    messageId: 'm',
    conversationId: 'c',
    characterId: 'a',
    operationId: 'o',
    replyOrdinal: 1,
    author: 'character',
    origin: 'narrative',
    text: 'x',
    createdAt: 1,
    audio: null,
  };
  assert.notEqual(messageKey(scope, message), messageKey(scope, { ...message, messageId: 'm2' }));
  assert.notEqual(messageKey(scope, message), messageKey(scope, { ...message, conversationId: 'c2' }));
});
test('old generation sync response cannot advance visible cursor', async () => {
  const session = new LocalSession();
  session.install(view);
  let finish!: (value: { events: []; cursor: string; hasMore: false }) => void;
  const api = {
    sync: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    eventUrl: () => '/events',
  } as unknown as LocalApi;
  const committed: string[] = [];
  const sync = new LocalSyncController(
    api,
    session,
    {
      apply: async () => {},
      refreshAccess: async () => {},
      refetchOperation: async () => op,
      cursor: async (cursor) => {
        committed.push(cursor);
      },
    },
    () => ({ close() {}, onmessage: null, onerror: null }),
  );
  const pending = sync.start('old');
  session.install(view);
  finish({ events: [], cursor: 'late', hasMore: false });
  await pending;
  assert.deepEqual(committed, []);
});
test('character switch stops a late audio fetch before playback', async () => {
  const session = new LocalSession();
  session.install(view);
  let finish!: (response: Response) => void;
  let played = 0;
  const makeAudio = () =>
    ({
      play: async () => {
        played++;
      },
      pause() {},
      removeAttribute() {},
      load() {},
      src: '',
    }) as unknown as HTMLAudioElement;
  const media = new LocalAudioController(
    session,
    (() =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })) as typeof fetch,
    makeAudio,
  );
  const message: WebLocalMessage = {
    messageId: 'm',
    conversationId: 'c',
    characterId: 'a',
    operationId: 'o',
    replyOrdinal: 1,
    author: 'character',
    origin: 'narrative',
    text: 'x',
    createdAt: 1,
    audio: { status: 'ready', mediaId: 'media', synthetic: true },
  };
  media.selectCharacter('a');
  const pending = media.play(message);
  media.selectCharacter('b');
  finish(new Response(new Blob(['RIFF'], { type: 'audio/wav' }), { status: 200 }));
  assert.equal(await pending, 'stale_generation');
  assert.equal(played, 0);
});
