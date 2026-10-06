import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterAdminClient } from '../../src/services/character-admin-api.ts';
import { AccountAdminApi } from '../../src/services/account-admin-api.ts';
import { defaultSchedule } from '../../../../packages/domain/defaults.ts';
const profile = {
  template: {
    id: 'role',
    name: '合成人物',
    version: 2,
    fictional: true as const,
    persona: '离线素材',
    schedule: defaultSchedule(),
  },
  presentation: {
    displayName: '合成人物',
    publicDescription: '离线展示',
    welcome: { text: '你好', version: 'welcome-v1' },
  },
};
const draft = { characterId: 'role', revision: 1, baseVersion: 1, profile, contentHash: 'a'.repeat(64), savedAt: 1 };
const job = {
  previewId: 'preview',
  characterId: 'role',
  draftRevision: 1,
  profileHash: draft.contentHash,
  status: 'queued',
  errorCode: null,
  result: null,
};
const deletion = {
  characterId: 'deleted',
  deletionId: 'job-delete',
  state: 'purging',
  total: 2,
  databaseCleared: 1,
  audioCleared: 0,
  errorCode: null,
};

test('character client preserves saved profile, discovers pending reviews/deletions and never starts a provider action while reading', async () => {
  const calls: string[] = [],
    api = new CharacterAdminClient(async (path, body) => {
      calls.push(path);
      assert.deepEqual(body, {});
      return path === 'list'
        ? {
            characters: [{ characterId: 'role', displayName: '合成人物', publishedVersion: 1, draftRevision: 1 }],
            deletions: [deletion],
          }
        : { characterId: 'role', published: { version: 1, profile }, draft, previews: [job], previewAvailable: true };
    });
  assert.deepEqual((await api.list()).deletions, [deletion]);
  const detail = await api.detail('role');
  assert.deepEqual(detail.draft, draft);
  assert.deepEqual(detail.previews, [job]);
  detail.draft!.profile.template.persona = 'local edit';
  assert.equal(profile.template.persona, '离线素材');
  assert.deepEqual(calls, ['list', 'role/detail']);
  await assert.rejects(api.detail('../other'), /PROTOCOL_INVALID/);
  assert.equal(calls.length, 2);
});

test('character transport freezes the caller request identity and rejects malformed server states without guessing success', async () => {
  const input = {
    requestId: 'exact-request',
    draftRevision: 1,
    profileHash: draft.contentHash,
    relationship: 'friend',
    message: '合成预演',
  };
  let count = 0;
  const api = new CharacterAdminClient(async (path, body) => {
    count++;
    assert.equal(path, 'role/review-start');
    assert.deepEqual(body, input);
    return { ...job, status: 'unrecognized' };
  });
  await assert.rejects(api.startPreview('role', input), /PROTOCOL_INVALID/);
  assert.equal(count, 1);
  const malformed = new CharacterAdminClient(async () => ({
    characters: [],
    deletions: [{ ...deletion, total: '2' }],
  }));
  await assert.rejects(malformed.list(), /PROTOCOL_INVALID/);
});

test('account invitation list refuses coercion and sends an explicit cursor over the authenticated namespace', async () => {
  const record = {
    inviteId: 'invite',
    batch: 'offline',
    note: null,
    createdAt: 1,
    redeemBy: null,
    status: 'active',
    redeemed: '0',
    grantId: null,
    redeemedAt: null,
    accessRevokedAt: null,
    accessExpiresAt: null,
  };
  const api = new AccountAdminApi(async (path, init) => {
    assert.equal(path, '/api/web/provider/admin/invites/list');
    assert.deepEqual(JSON.parse(String(init!.body)), { beforeId: 'before' });
    return Response.json({ records: [record], next: null });
  });
  await assert.rejects(api.inviteRecords('before'), /PROTOCOL_INVALID/);
});
