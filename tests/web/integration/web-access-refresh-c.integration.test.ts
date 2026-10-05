import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBootstrap, WebLocalProtocolError } from '../../../packages/contracts/web-local-client.ts';
import { LocalAccessController } from '../../../apps/player-web/src/session/access-controller.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalSyncController, type EventStream } from '../../../apps/player-web/src/data/sync-controller.ts';
import { LocalApi } from '../../../apps/player-web/src/services/local-api.ts';

const initial = () => parseBootstrap({ contractVersion: 'web-v1-local-2', mode: 'synthetic-local',
  region: 'local-test', instanceId: 'c-access-instance', recoveryEpoch: 'c-access-epoch', csrf: 'c-csrf',
  access: { kind: 'guest', principalId: 'c-guest', playerId: 'c-player', worldId: 'c-world',
    revision: 1, trialCharacterId: null, trialRemaining: 3, trialReserved: 0,
    canSend: true, canChooseText: false, trialExpiresAt: null, retentionState: 'unstarted' },
  characters: [], conversations: [], activeOperations: [], syncCursor: 'c0', unsupported: ['invite'] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('C access: first acceptance installs absolute expiry without invalidating an active sync stream', async () => {
  let now = 1000, invalidations = 0, closes = 0, streams = 0;
  const session = new LocalSession(() => now); session.install(initial());
  const scope = session.scope!, signal = session.signal;
  session.onInvalidate(() => { invalidations++; });
  const active = { ...session.currentView!.bootstrap.access, revision: 2,
    trialCharacterId: 'c-character', trialRemaining: 2, trialReserved: 1,
    trialExpiresAt: 1100, retentionState: 'active' };
  const api = new LocalApi((async (path: string) => {
    if (path.includes('/access')) return Response.json(active);
    if (path.includes('/sync')) return Response.json({ events: [], cursor: 'c0', hasMore: false });
    throw Error(`unexpected ${path}`);
  }) as typeof fetch);
  const sync = new LocalSyncController(api, session, { apply: async () => {},
    refreshAccess: async () => {}, refetchOperation: async () => { throw Error('unexpected'); },
    cursor: async () => {} }, () => {
    streams++;
    return { close: () => { closes++; }, onmessage: null, onerror: null } as EventStream;
  });
  try {
    await sync.start('c0');
    assert.equal(streams, 1);
    assert.equal(await new LocalAccessController(api, session).refresh(scope), true);
    assert.equal(session.scope?.guestExpiresAt, 1100);
    assert.equal(session.scope?.generation, scope.generation);
    assert.strictEqual(session.signal, signal);
    assert.equal(invalidations, 0);
    assert.equal(closes, 0, 'ordinary access refresh closed a valid SSE stream');
    now = 1050;
    assert.equal(await new LocalAccessController(api, session).refresh(scope), true);
    assert.equal(session.scope?.guestExpiresAt, 1100, 'activity extended the original deadline');
    assert.equal(closes, 0);
  } finally { sync.stop(); session.invalidate(); }
});

test('C access: same principal and revision may reflect shared-IP remaining without a generation change', async () => {
  const session = new LocalSession(() => 1000); session.install(initial());
  const scope = session.scope!, oldSignal = session.signal;
  const started = { ...session.currentView!.bootstrap.access, revision: 2,
    trialCharacterId: 'c-character', trialRemaining: 2, trialReserved: 1,
    trialExpiresAt: 2000, retentionState: 'active' };
  const responses = [started, { ...started, trialRemaining: 0, canSend: false }, started];
  const api = { access: async () => responses.shift() } as unknown as LocalApi;
  const controller = new LocalAccessController(api, session);
  assert.equal(await controller.refresh(scope), true);
  assert.equal(await controller.refresh(scope), true);
  assert.equal(session.currentView?.bootstrap.access.trialRemaining, 0);
  assert.equal(await controller.refresh(scope), true);
  assert.equal(session.currentView?.bootstrap.access.trialRemaining, 2);
  assert.equal(session.scope?.generation, scope.generation);
  assert.strictEqual(session.signal, oldSignal);
  session.invalidate();
});

test('C access: out-of-order, old-scope, and sliding-expiry replies cannot overwrite access', async () => {
  const session = new LocalSession(() => 1000); session.install(initial());
  const scope = session.scope!, original = session.currentView!.bootstrap.access;
  const first = deferred<typeof original>(), second = deferred<typeof original>();
  let calls = 0;
  const api = { access: async () => ++calls === 1 ? first.promise : second.promise } as unknown as LocalApi;
  const controller = new LocalAccessController(api, session);
  const older = controller.refresh(scope), newer = controller.refresh(scope);
  const active = { ...original, revision: 2, trialCharacterId: 'c-character',
    trialRemaining: 2, trialReserved: 1, trialExpiresAt: 2000, retentionState: 'active' } as typeof original;
  second.resolve(active);
  assert.equal(await newer, true);
  first.resolve({ ...active, revision: 1, trialRemaining: 3 });
  assert.equal(await older, false);
  assert.equal(session.currentView?.bootstrap.access.revision, 2);
  assert.throws(() => session.beginAccessRefresh(scope)({ ...active, revision: 3,
    trialExpiresAt: 2500 }), WebLocalProtocolError);
  assert.equal(session.currentView?.bootstrap.access.trialExpiresAt, 2000);
  session.install(initial());
  assert.equal(await controller.refresh(scope), false, 'old generation was allowed to start a refresh');
  assert.equal(session.currentView?.bootstrap.access.retentionState, 'unstarted');
  session.invalidate();
});
