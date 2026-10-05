import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import { parseWebInviteBootstrap } from '../../../packages/contracts/web-local-invite.ts';
import type { WebLocalOperation } from '../../../packages/contracts/web-local.ts';
import { LocalSendController } from '../../../apps/player-web/src/data/send-controller.ts';
import { LocalSyncController } from '../../../apps/player-web/src/data/sync-controller.ts';
import type { PendingOperation, PendingStore } from '../../../apps/player-web/src/data/pending-operations.ts';
import { scopeKey } from '../../../apps/player-web/src/data/pending-operations.ts';
import { LocalAccessController } from '../../../apps/player-web/src/session/access-controller.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';
import { LocalApi } from '../../../apps/player-web/src/services/local-api.ts';
import { InviteLocalApi } from '../../../apps/player-web/src/services/invite-local-api.ts';

const character = { characterId: 'synthetic-local', name: 'Test', synthetic: true,
  audition: { state: 'unavailable', reason: 'not_approved' } };
const base = { mode: 'synthetic-local', region: 'local-test', instanceId: 'instance',
  recoveryEpoch: 'epoch', csrf: 'guest-csrf', characters: [character], conversations: [],
  activeOperations: [], syncCursor: 'cursor', unsupported: ['invite'] };
const guest = parseBootstrap({ ...base, contractVersion: 'web-v1-local-2',
  access: { kind: 'guest', principalId: 'principal', playerId: 'player', worldId: 'world',
    revision: 1, trialCharacterId: null, trialRemaining: 3, trialReserved: 0,
    canSend: true, canChooseText: false, trialExpiresAt: null, retentionState: 'unstarted' } });
const inviteAccess = { kind: 'invite', principalId: 'principal', playerId: 'player', worldId: 'world',
  revision: 2, grantId: 'grant', status: 'active', expiresAt: null, canSend: true,
  canChooseText: false, trialCharacterId: null, trialRemaining: null, trialReserved: null,
  trialExpiresAt: null, retentionState: 'protected' };
const invite = parseWebInviteBootstrap({ ...base, contractVersion: 'web-v1-local-3',
  csrf: 'invite-csrf', access: inviteAccess, unsupported: [] });
const operation: WebLocalOperation = { operationId: 'operation', requestId: 'fixed-request',
  conversationId: 'conversation', status: 'queued', revision: 1, acceptedAt: 1,
  deadlineAt: 300001, errorCode: null, canCancel: true, publication: null };

class Pending implements PendingStore {
  readonly rows = new Map<string, PendingOperation>();
  async put(row: PendingOperation) { this.rows.set(row.requestId, structuredClone(row)); }
  async get(scope: PendingOperation['scope'], id: string) {
    const row = this.rows.get(id); return row && scopeKey(row.scope) === scopeKey(scope) ? row : null;
  }
  async list(scope: PendingOperation['scope']) {
    return [...this.rows.values()].filter(row => row.state !== 'accepted' &&
      scopeKey(row.scope) === scopeKey(scope));
  }
}

test('installed invite sends with new trusted CSRF and recovers original request without currentView', async () => {
  const session = new LocalSession(() => 1000); session.install(guest); session.install(invite);
  assert.equal(session.currentView, null);
  assert.equal(session.currentInviteView?.bootstrap.access.grantId, 'grant');
  const paths: string[] = [], tokens: string[] = [];
  const api = new LocalApi(async (url, init) => {
    paths.push(String(url));
    if (init?.method === 'POST') {
      tokens.push((init.headers as Record<string, string>)['X-CSRF-Token'] ?? '');
      return Response.json({ duplicate: false, operation });
    }
    return Response.json(operation);
  });
  const store = new Pending(), sender = new LocalSendController(api, session, store, () => 'fixed-request');
  assert.equal((await sender.send('synthetic-local', 'hello')).kind, 'accepted');
  assert.deepEqual(tokens, ['invite-csrf']);
  store.rows.set('fixed-request', { ...store.rows.get('fixed-request')!, state: 'network_uncertain' });
  assert.deepEqual(await sender.recoverPending(), [{ kind: 'accepted', operation }]);
  assert.ok(paths.some(path => path.endsWith('/operations/by-request/fixed-request')));
  session.invalidate();
});

test('invite access refresh and SSE use invited view; stale response cannot change next identity', async () => {
  const session = new LocalSession(() => 1000); session.install(invite);
  let finish!: (value: Response) => void;
  const inviteApi = new InviteLocalApi(() => new Promise(resolve => { finish = resolve; }));
  const legacyApi = new LocalApi(async () => { throw new Error('legacy access must not be used'); });
  const access = new LocalAccessController(legacyApi, session, inviteApi), old = session.scope!;
  const pending = access.refresh(old);
  session.install(guest);
  finish(Response.json({ ...inviteAccess, revision: 3, status: 'revoked', canSend: false }));
  assert.equal(await pending, false);
  assert.equal(session.currentView?.bootstrap.access.kind, 'guest');
  session.install(invite);
  const accessApi = new InviteLocalApi(async () => Response.json({ ...inviteAccess,
    revision: 3, status: 'revoked', canSend: false }));
  const refresh = new LocalAccessController(legacyApi, session, accessApi);
  const event = { eventId: 'event-1', conversationId: null, kind: 'access', revision: 3, payload: {} };
  const syncApi = { sync: async () => ({ events: [event], cursor: 'event-1', hasMore: false }),
    eventUrl: () => '/events' } as unknown as LocalApi;
  const sync = new LocalSyncController(syncApi, session, {
    apply: async () => {}, refreshAccess: scope => refresh.refresh(scope).then(() => {}),
    refetchOperation: async () => operation, cursor: async () => {},
  }, () => ({ close() {}, onmessage: null, onerror: null }));
  await sync.start('cursor');
  assert.equal(session.currentInviteView?.bootstrap.access.status, 'revoked');
  assert.equal(session.contentAvailable(), false);
  sync.stop(); session.invalidate();
});
