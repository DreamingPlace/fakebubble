import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebInviteAccess, parseWebInviteBootstrap, parseWebInviteCredential, parseWebInviteReceipt,
  parseWebInviteRecovery, parseWebInviteStatus } from '../../../packages/contracts/web-local-invite.ts';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';
import { IndexedDbLocalCache } from '../../../apps/player-web/src/data/local-cache.ts';

const access = { kind: 'invite', principalId: 'principal-1', playerId: 'player-1',
  worldId: 'world-1', revision: 2, grantId: 'grant-1', status: 'active',
  expiresAt: null, canSend: true, canChooseText: false,
  trialCharacterId: 'character-1', trialRemaining: null, trialReserved: null,
  retentionState: 'protected', trialExpiresAt: null };

test('local-3 invite access is a separate candidate and cannot silently enter the local-2 parser', () => {
  assert.deepEqual(parseWebInviteAccess(access), access);
  assert.deepEqual(parseWebInviteAccess({ ...access, canChooseText: true }),
    { ...access, canChooseText: true });
  assert.throws(() => parseWebInviteAccess({ ...access, status: 'revoked', canSend: true }),
    /WEB_INVITE_PROTOCOL_INVALID/);
  assert.throws(() => parseWebInviteAccess({ ...access, grantId: undefined }),
    /WEB_INVITE_PROTOCOL_INVALID/);
  assert.throws(() => parseBootstrap({ contractVersion: 'web-v1-local-3',
    mode: 'synthetic-local', region: 'local-test', access }), /unsupported local protocol/);
});

test('receipt/status and one-time recovery-secret shapes reject unintended extra secrets', () => {
  const status = { grantId: 'grant-1', principalId: 'principal-1', expiresAt: null };
  const receipt = { ...status, csrf: 'csrf-1' };
  assert.deepEqual(parseWebInviteStatus(status), status);
  assert.deepEqual(parseWebInviteReceipt(receipt), receipt);
  assert.throws(() => parseWebInviteStatus({ ...status, csrf: 'csrf-1' }),
    /WEB_INVITE_PROTOCOL_INVALID/);
  assert.throws(() => parseWebInviteReceipt({ ...receipt, issuedToken: 'bearer' }),
    /WEB_INVITE_PROTOCOL_INVALID/);
  const secret = 'A'.repeat(43);
  assert.deepEqual(parseWebInviteCredential({ grantId: status.grantId, expiresAt: null, secret }),
    { grantId: status.grantId, expiresAt: null, secret });
  assert.deepEqual(parseWebInviteRecovery({ ...receipt, recoverySecret: secret, duplicate: false }),
    { ...receipt, recoverySecret: secret, duplicate: false });
  assert.throws(() => parseWebInviteRecovery({ ...receipt, recoverySecret: secret,
    duplicate: false, code: 'never-persist' }), /WEB_INVITE_PROTOCOL_INVALID/);
});

const inviteBootstrap = { contractVersion: 'web-v1-local-3', mode: 'synthetic-local',
  region: 'local-test', instanceId: 'instance-1', recoveryEpoch: 'epoch-1', csrf: 'csrf-1',
  access, characters: [{ characterId: 'character-1', name: 'Synthetic', synthetic: true,
    audition: { state: 'unavailable', reason: 'not_approved' } }],
  conversations: [], activeOperations: [], syncCursor: 'cursor-1', unsupported: [] };

test('local-3 parser and existing session install preserve scope but deny revoked invite content', () => {
  assert.throws(() => parseBootstrap(inviteBootstrap), /unsupported local protocol/);
  assert.throws(() => parseWebInviteBootstrap({ ...inviteBootstrap, access: { ...access,
    status: 'revoked', canSend: true } }), /WEB_INVITE_PROTOCOL_INVALID/);
  const session = new LocalSession(() => 1000);
  const view = parseWebInviteBootstrap(inviteBootstrap);
  session.install(view);
  const scope = session.scope!;
  assert.equal(scope.accessKind, 'invite');
  assert.equal(session.currentView, null, 'legacy local-1/2 view cannot masquerade as invite');
  assert.equal(session.currentInviteView?.bootstrap.access.grantId, 'grant-1');
  assert.equal(session.contentAvailable(scope), true);
  const refresh = session.beginInviteAccessRefresh(scope);
  assert.equal(refresh(parseWebInviteAccess({ ...access, revision: 3, status: 'revoked',
    canSend: false })), true);
  assert.equal(session.contentAvailable(), false);
  assert.equal(session.currentInviteView?.bootstrap.access.status, 'revoked');
  assert.deepEqual(session.currentInviteView?.bootstrap.conversations, []);
  assert.equal(refresh(parseWebInviteAccess(access)), false, 'old generation cannot revive grant');
  session.invalidate();
});

test('local-3 session denies at the absolute expiry and cannot revive on clock rollback', () => {
  let now = 1100;
  const session = new LocalSession(() => now);
  session.install(parseWebInviteBootstrap({ ...inviteBootstrap,
    access: { ...access, expiresAt: 1100 } }));
  assert.equal(session.contentAvailable(), false);
  assert.equal(session.currentInviteView?.bootstrap.access.status, 'expired');
  now = 1000;
  assert.equal(session.contentAvailable(), false);
  session.invalidate();
});

test('revoked invite cannot read or write cached private body with a stale active scope', async () => {
  const session = new LocalSession(() => 1000);
  session.install(parseWebInviteBootstrap(inviteBootstrap));
  const oldScope = session.scope!;
  const cache = new IndexedDbLocalCache({ open: () => {
    throw new Error('revoked invite must not open IDB for private body');
  } } as unknown as IDBFactory, session);
  const refresh = session.beginInviteAccessRefresh(oldScope);
  refresh(parseWebInviteAccess({ ...access, revision: 3, status: 'revoked', canSend: false }));
  await cache.putDraft(oldScope, 'character-1', 'private');
  assert.equal(await cache.draft(oldScope, 'character-1'), null);
  assert.equal(await cache.message(oldScope, 'conversation-1', 'message-1'), null);
  session.invalidate();
});
