import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import type { WebLocalMessage, WebLocalOperation } from '../../../packages/contracts/web-local.ts';
import { LocalSession, type LocalScope } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalIdentityController } from '../../../apps/player-web/src/session/identity-controller.ts';
import { LocalApi, LocalApiError, StaleLocalIdentityError } from '../../../apps/player-web/src/services/local-api.ts';
import { LocalAudioController } from '../../../apps/player-web/src/media/audio-controller.ts';
import { LocalSyncController, type EventStream } from '../../../apps/player-web/src/data/sync-controller.ts';
import { LocalSendController } from '../../../apps/player-web/src/data/send-controller.ts';
import {
  scopeKey,
  type PendingOperation,
  type PendingStore,
} from '../../../apps/player-web/src/data/pending-operations.ts';

const boot = {
  contractVersion: 'web-v1-local-1',
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'i',
  recoveryEpoch: 'e',
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
const guest = parseBootstrap(boot);
const account = parseBootstrap({
  ...boot,
  access: { ...boot.access, kind: 'account', trialRemaining: null, trialReserved: null },
});
const op: WebLocalOperation = {
  operationId: 'o',
  requestId: 'r',
  conversationId: 'c',
  status: 'queued',
  revision: 1,
  acceptedAt: 1,
  deadlineAt: 1000,
  errorCode: null,
  canCancel: true,
  publication: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('018 register and recover cannot install after invalidate or competing transition', async () => {
  const session = new LocalSession();
  session.install(guest);
  const gate = deferred<void>();
  const api = { register: () => gate.promise, bootstrap: async () => account } as unknown as LocalApi;
  const task = new LocalIdentityController(api, session).register('r', 'u', 'secret');
  session.invalidate();
  gate.resolve();
  await assert.rejects(task, StaleLocalIdentityError);
  assert.equal(session.currentView, null);

  session.install(guest);
  const first = deferred<void>(),
    second = deferred<void>();
  let calls = 0;
  const competing = {
    register: () => (++calls === 1 ? first.promise : second.promise),
    bootstrap: async () => account,
  } as unknown as LocalApi;
  const identity = new LocalIdentityController(competing, session);
  const old = identity.register('r1', 'u', 'secret');
  const current = identity.register('r2', 'u', 'secret');
  second.resolve();
  await current;
  first.resolve();
  await assert.rejects(old, StaleLocalIdentityError);
  assert.equal(session.currentView, account);
});

test('018 stale bootstrap and challenge responses cannot overwrite in-memory CSRF', async () => {
  const bootGate = deferred<Response>(),
    challengeGate = deferred<Response>();
  const seen: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/bootstrap')) return bootGate.promise;
    if (url.endsWith('/identity/receipt-challenge')) return challengeGate.promise;
    seen.push(String((init.headers as Record<string, string>)['X-CSRF-Token']));
    return Response.json({ operation: op, duplicate: false });
  }) as typeof fetch;
  const api = new LocalApi(fetcher);
  api.setCsrf('initial');
  const session = new LocalSession();
  session.install(guest);
  const active = session.beginIdentityTransition();
  const bootstrap = api.bootstrap(undefined, active);
  session.invalidate();
  bootGate.resolve(Response.json({ ...boot, csrf: 'stale-bootstrap' }));
  await assert.rejects(bootstrap, StaleLocalIdentityError);
  session.install(guest);
  const challengeActive = session.beginIdentityTransition();
  const challenge = api.receiptChallenge(challengeActive);
  session.invalidate();
  challengeGate.resolve(Response.json({ csrf: 'stale-challenge' }));
  await assert.rejects(challenge, StaleLocalIdentityError);
  await api.send('synthetic-local', 'r', 'hello');
  assert.deepEqual(seen, ['initial']);
});

test('018 valid old-cookie recovery completes without aborting its own request', async () => {
  const session = new LocalSession();
  session.install(guest);
  const oldSignal = session.signal;
  let boots = 0;
  const api = {
    bootstrap: async () => {
      if (++boots === 1) throw new LocalApiError(409, 'SESSION_ROTATED_RECOVERABLE');
      return account;
    },
    receiptChallenge: async () => 'recovery-csrf',
    recoverRegister: async () => ({ accountId: 'a', principalId: 'p' }),
  } as unknown as LocalApi;
  await new LocalIdentityController(api, session).recoverRegister('r', 'u', 'secret');
  assert.equal(oldSignal.aborted, true);
  assert.equal(session.currentView?.bootstrap.access.kind, 'account');
});
test('018 valid new-cookie receipt-status recovery retains same principal and world', async () => {
  const session = new LocalSession();
  session.install(guest);
  let statuses = 0;
  const api = {
    bootstrap: async () => account,
    receiptStatus: async () => {
      statuses++;
      return { accountId: 'a', principalId: 'p' };
    },
  } as unknown as LocalApi;
  await new LocalIdentityController(api, session).recoverRegister('r', 'u', 'secret');
  assert.equal(statuses, 1);
  assert.equal(session.currentView, account);
});

const message = (id: string): WebLocalMessage => ({
  messageId: id,
  conversationId: 'c',
  characterId: 'synthetic-local',
  operationId: 'o',
  replyOrdinal: 1,
  author: 'character',
  origin: 'narrative',
  text: 'x',
  createdAt: 1,
  audio: { status: 'ready', mediaId: id, synthetic: true },
});
test('019 stale play resolve or reject only releases its own audio', async () => {
  for (const rejectOld of [false, true]) {
    const session = new LocalSession();
    session.install(guest);
    const gate = deferred<void>(),
      entered = deferred<void>();
    const elements: {
      pauses: number;
      src: string;
      play(): Promise<void>;
      pause(): void;
      removeAttribute(): void;
      load(): void;
    }[] = [];
    const media = new LocalAudioController(
      session,
      (async () => new Response(new Blob(['RIFF'], { type: 'audio/wav' }))) as typeof fetch,
      () => {
        const index = elements.length;
        const audio = {
          src: '',
          pauses: 0,
          play: () => (index === 0 ? (entered.resolve(), gate.promise) : Promise.resolve()),
          pause() {
            this.pauses++;
          },
          removeAttribute() {},
          load() {},
        };
        elements.push(audio);
        return audio as unknown as HTMLAudioElement;
      },
    );
    const first = media.play(message('m1'));
    await entered.promise;
    assert.equal(await media.play(message('m2')), 'playing');
    if (rejectOld) gate.reject(new Error('late rejection'));
    else gate.resolve();
    assert.equal(await first, 'stale_generation');
    assert.equal(elements[1]!.pauses, 0);
    media.stop();
  }
});

test('020 failed e1 or cursor cannot let queued e2 commit before replay', async () => {
  for (const failAt of ['apply', 'cursor']) {
    const session = new LocalSession();
    session.install(guest);
    const gate = deferred<{ events: []; cursor: string; hasMore: false }>();
    let reads = 0,
      stream!: EventStream;
    const api = {
      sync: async () => (++reads === 1 ? { events: [], cursor: 'c0', hasMore: false } : gate.promise),
      eventUrl: () => '/events',
    } as unknown as LocalApi;
    const committed: string[] = [],
      applied: string[] = [];
    const sync = new LocalSyncController(
      api,
      session,
      {
        apply: async (event) => {
          if (failAt === 'apply' && event.eventId === 'e1') throw Error('apply failed');
          applied.push(event.eventId);
        },
        refreshAccess: async () => {},
        refetchOperation: async () => op,
        cursor: async (cursor) => {
          if (failAt === 'cursor' && cursor === 'e1') throw Error('cursor failed');
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
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(committed, []);
      assert.deepEqual(applied, failAt === 'cursor' ? ['e1'] : []);
    } finally {
      sync.stop();
      gate.resolve({ events: [], cursor: 'c0', hasMore: false });
    }
  }
});

class DurableMap implements PendingStore {
  private readonly disk = new Map<string, PendingOperation>();
  private key(scope: LocalScope, requestId: string) {
    return `${scopeKey(scope)}\u001f${requestId}`;
  }
  async put(item: PendingOperation) {
    this.disk.set(this.key(item.scope, item.requestId), structuredClone(item));
  }
  async get(scope: LocalScope, requestId: string) {
    return this.disk.get(this.key(scope, requestId)) ?? null;
  }
  async list(scope: LocalScope) {
    const prefix = `${scopeKey(scope)}\u001f`;
    return [...this.disk.entries()]
      .filter(([key, value]) => key.startsWith(prefix) && value.state !== 'accepted')
      .map(([, value]) => value);
  }
}
test('021 trusted reload discovers old pending IDs and queries without another POST', async () => {
  const disk = new DurableMap();
  const prior = new LocalSession();
  prior.install(guest);
  prior.install(account);
  await disk.put({
    scope: prior.scope!,
    characterId: 'synthetic-local',
    requestId: 'r',
    text: 'original',
    delivery: 'voice',
    state: 'network_uncertain',
    operationId: null,
  });
  const refreshed = new LocalSession();
  refreshed.install(account);
  let sends = 0,
    lookups = 0;
  const api = {
    send: async () => {
      sends++;
      return op;
    },
    byRequest: async () => {
      lookups++;
      return op;
    },
  } as unknown as LocalApi;
  const controller = new LocalSendController(api, refreshed, disk);
  assert.equal((await disk.get(refreshed.scope!, 'r'))?.text, 'original');
  const recovered = await controller.recoverPending();
  assert.equal(recovered[0]?.kind, 'accepted');
  assert.equal(sends, 0);
  assert.equal(lookups, 1);
  assert.equal((await disk.get(refreshed.scope!, 'r'))?.operationId, 'o');
  const other = new LocalSession();
  other.install(parseBootstrap({ ...boot, recoveryEpoch: 'other' }));
  assert.deepEqual(await new LocalSendController(api, other, disk).recoverPending(), []);
  const another = new LocalSession();
  another.install(parseBootstrap({ ...boot, access: { ...boot.access, principalId: 'someone-else' } }));
  assert.deepEqual(await new LocalSendController(api, another, disk).recoverPending(), []);
});
test('021 reload of stored-before-send intent keeps 404 unresolved and never auto-sends', async () => {
  const disk = new DurableMap();
  const before = new LocalSession();
  before.install(guest);
  await disk.put({
    scope: before.scope!,
    characterId: 'synthetic-local',
    requestId: 'unseen',
    text: 'draft',
    delivery: 'voice',
    state: 'stored',
    operationId: null,
  });
  const after = new LocalSession();
  after.install(guest);
  let sends = 0;
  const api = {
    send: async () => {
      sends++;
      return op;
    },
    byRequest: async () => {
      throw new LocalApiError(404, 'NOT_FOUND');
    },
  } as unknown as LocalApi;
  assert.deepEqual(await new LocalSendController(api, after, disk).recoverPending(), [
    { kind: 'network_uncertain', requestId: 'unseen' },
  ]);
  assert.equal((await disk.get(after.scope!, 'unseen'))?.state, 'network_uncertain');
  assert.equal(sends, 0);
});
