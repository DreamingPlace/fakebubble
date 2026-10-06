import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBootstrap, WebLocalProtocolError } from '../../../packages/contracts/web-local-client.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalAccessController } from '../../../apps/player-web/src/session/access-controller.ts';
import { LocalSendController } from '../../../apps/player-web/src/data/send-controller.ts';
import { IndexedDbLocalCache } from '../../../apps/player-web/src/data/local-cache.ts';
import { LocalApi, LocalApiError } from '../../../apps/player-web/src/services/local-api.ts';
import type { PendingOperation, PendingStore } from '../../../apps/player-web/src/data/pending-operations.ts';

const boot = {
  contractVersion: 'web-v1-local-2',
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'synthetic-i',
  recoveryEpoch: 'synthetic-e',
  csrf: 'synthetic-csrf',
  access: {
    kind: 'guest',
    principalId: 'synthetic-p',
    playerId: 'synthetic-player',
    worldId: 'synthetic-w',
    revision: 2,
    trialCharacterId: 'synthetic-c',
    trialRemaining: 2,
    trialReserved: 0,
    canSend: true,
    canChooseText: false,
    trialExpiresAt: 1100,
    retentionState: 'active',
  },
  characters: [
    {
      characterId: 'synthetic-c',
      name: 'Synthetic',
      synthetic: true,
      audition: { state: 'unavailable', reason: 'not_approved' },
    },
  ],
  conversations: [],
  activeOperations: [],
  syncCursor: 'cursor',
  unsupported: ['invite'],
};

test('local-2 parser requires explicit retention while local-1 remains separate', () => {
  assert.equal(parseBootstrap(boot).bootstrap.contractVersion, 'web-v1-local-2');
  assert.throws(
    () => parseBootstrap({ ...boot, access: { ...boot.access, trialExpiresAt: undefined } }),
    WebLocalProtocolError,
  );
  assert.throws(
    () => parseBootstrap({ ...boot, access: { ...boot.access, retentionState: 'expired', canSend: true } }),
    WebLocalProtocolError,
  );
  assert.equal(
    parseBootstrap({
      ...boot,
      access: { ...boot.access, kind: 'account', retentionState: 'protected', trialExpiresAt: 1100 },
    }).bootstrap.access.kind,
    'account',
  );
});

test('local-2 guest body is not persisted or read offline; account cache is not purged', async () => {
  const unusableIdb = {
    open: () => {
      throw new Error('must not open IDB for guest body');
    },
  } as unknown as IDBFactory;
  const guest = parseBootstrap(boot),
    session = new LocalSession(() => 1000);
  session.install(guest);
  const cache = new IndexedDbLocalCache(unusableIdb);
  const scope = session.scope!;
  await cache.putDraft(scope, 'synthetic-c', 'private text');
  await cache.putMessages(scope, []);
  assert.equal(await cache.draft(scope, 'synthetic-c'), null);
  assert.equal(await cache.message(scope, 'synthetic-conversation', 'synthetic-message'), null);
  const account = parseBootstrap({
    ...boot,
    access: { ...boot.access, kind: 'account', retentionState: 'protected', trialExpiresAt: 1100 },
  });
  session.install(account);
  assert.equal(session.contentAvailable(), true, 'an upgraded account is not expired with its former trial');
  session.invalidate();
});

test('local-2 410 revokes current content and purges only the guest pending partition', async () => {
  let now = 1000,
    posts = 0,
    purges = 0;
  const session = new LocalSession(() => now);
  session.install(parseBootstrap(boot));
  const pending = new Map<string, PendingOperation>();
  const store: PendingStore = {
    put: async (item) => {
      pending.set(item.requestId, item);
    },
    get: async (_scope, id) => pending.get(id) ?? null,
    list: async () => [...pending.values()],
    purgeScope: async (scope) => {
      assert.equal(scope.principalId, 'synthetic-p');
      purges++;
      pending.clear();
    },
  };
  const api = {
    send: async () => {
      posts++;
      throw new LocalApiError(410, 'TRIAL_EXPIRED');
    },
  } as unknown as LocalApi;
  const sender = new LocalSendController(api, session, store, () => 'synthetic-request');
  await assert.rejects(sender.send('synthetic-c', 'private input'), /TRIAL_EXPIRED/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 1);
  assert.equal(purges, 1);
  assert.equal(pending.size, 0);
  assert.equal(session.contentAvailable(), false);
  assert.equal(session.currentView?.bootstrap.access.retentionState, 'expired');
  assert.deepEqual(session.currentView?.bootstrap.conversations, []);
  await assert.rejects(sender.send('synthetic-c', 'again'), /TRIAL_EXPIRED/);
  assert.equal(posts, 1);
  const upgraded = parseBootstrap({
    ...boot,
    access: {
      ...boot.access,
      kind: 'account',
      principalId: 'separate-valid-account',
      retentionState: 'protected',
      trialExpiresAt: 1100,
    },
  });
  session.install(upgraded);
  assert.equal(session.contentAvailable(), true, 'a separate trusted account scope is not revoked');
  session.invalidate();
  now = 1200;
  const expired = parseBootstrap({ ...boot, access: { ...boot.access, retentionState: 'expired', canSend: false } });
  session.install(expired);
  assert.equal(session.contentAvailable(), false, 'offline bootstrap cannot reveal expired guest content');
  now = 1000;
  assert.equal(session.contentAvailable(), false, 'clock rollback cannot re-open a denied generation');
  session.invalidate();
});

test('trusted same-identity access refresh starts fixed expiry without interrupting sync or identity', async () => {
  let now = 1000,
    invalidations = 0;
  const session = new LocalSession(() => now);
  const unstarted = parseBootstrap({
    ...boot,
    access: {
      ...boot.access,
      revision: 1,
      trialCharacterId: null,
      trialRemaining: 3,
      trialExpiresAt: null,
      retentionState: 'unstarted',
    },
  });
  session.install(unstarted);
  session.onInvalidate(() => {
    invalidations++;
  });
  const originalScope = session.scope!,
    signal = session.signal;
  const responses = [
    {
      ...unstarted.bootstrap.access,
      revision: 2,
      trialCharacterId: 'synthetic-c',
      trialRemaining: 2,
      trialReserved: 1,
      trialExpiresAt: 1100,
      retentionState: 'active',
    },
    {
      ...unstarted.bootstrap.access,
      revision: 2,
      trialCharacterId: 'synthetic-c',
      trialRemaining: 0,
      trialReserved: 1,
      canSend: false,
      trialExpiresAt: 1100,
      retentionState: 'active',
    },
    {
      ...unstarted.bootstrap.access,
      revision: 2,
      trialCharacterId: 'synthetic-c',
      trialRemaining: 2,
      trialReserved: 1,
      trialExpiresAt: 1100,
      retentionState: 'active',
    },
  ];
  const api = { access: async () => responses.shift() } as unknown as LocalApi;
  const controller = new LocalAccessController(api, session);
  assert.equal(await controller.refresh(originalScope), true);
  assert.equal(session.scope?.guestExpiresAt, 1100);
  assert.equal(session.scope?.generation, originalScope.generation);
  assert.strictEqual(session.signal, signal);
  assert.equal(invalidations, 0);
  assert.equal(await controller.refresh(originalScope), true, 'same revision can reflect other IP users');
  assert.equal(session.currentView?.bootstrap.access.trialRemaining, 0);
  assert.equal(await controller.refresh(originalScope), true, 'released shared IP reservation can restore capacity');
  assert.equal(session.currentView?.bootstrap.access.trialRemaining, 2);
  now = 1100;
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(session.contentAvailable(), false);
  assert.equal(invalidations, 1, 'fixed deadline invalidates exactly once');
  assert.equal(session.currentView?.bootstrap.access.retentionState, 'expired');
  session.invalidate();
});

test('access tickets reject stale, regressed and cross-identity responses without reviving expired guest', async () => {
  let now = 1000;
  const session = new LocalSession(() => now);
  session.install(parseBootstrap(boot));
  const access = session.currentView!.bootstrap.access;
  let resolveFirst!: (value: any) => void,
    resolveSecond!: (value: any) => void,
    calls = 0;
  const api = {
    access: () =>
      new Promise((resolve) => {
        if (++calls === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      }),
  } as unknown as LocalApi;
  const controller = new LocalAccessController(api, session),
    scope = session.scope!;
  const first = controller.refresh(scope),
    second = controller.refresh(scope);
  resolveSecond({ ...access, revision: 3, trialRemaining: 1 });
  assert.equal(await second, true);
  resolveFirst({ ...access, revision: 2, trialRemaining: 2 });
  assert.equal(await first, false, 'old request ticket cannot overwrite a newer response');
  assert.equal(session.currentView?.bootstrap.access.revision, 3);
  assert.throws(() => session.beginAccessRefresh(scope)({ ...access, revision: 2 }), WebLocalProtocolError);
  assert.throws(
    () => session.beginAccessRefresh(scope)({ ...access, revision: 4, principalId: 'other' }),
    WebLocalProtocolError,
  );
  assert.throws(
    () => session.beginAccessRefresh(scope)({ ...access, revision: 4, trialExpiresAt: 1300 }),
    WebLocalProtocolError,
    'active expiry cannot slide',
  );
  now = 1100;
  assert.equal(
    session.beginAccessRefresh(scope)({
      ...access,
      revision: 3,
      trialRemaining: 0,
      canSend: false,
      retentionState: 'expired',
    }),
    true,
  );
  assert.equal(session.contentAvailable(), false);
  now = 1000;
  assert.equal(
    session.beginAccessRefresh(scope)({ ...access, revision: 5 }),
    false,
    'even a higher revision cannot revive denied content',
  );
  session.invalidate();
});
