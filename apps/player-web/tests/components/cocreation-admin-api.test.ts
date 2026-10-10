import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountAdminApi } from '../../src/services/account-admin-api.ts';
import { CocreationAdminClient } from '../../src/services/cocreation-admin-api.ts';

function client(reply: (path: string, body: Record<string, unknown>) => unknown) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  return {
    sent,
    api: new CocreationAdminClient(async (path, body) => {
      sent.push({ path, body });
      return reply(path, body);
    }),
  };
}
const row = {
  id: 's1',
  characterId: 'jojo',
  createdAt: 1,
  pseudonym: '玩家#0a1b',
  answerCount: 2,
  adoptedCount: 0,
  firstLine: 'x',
  status: 'new',
  starred: false,
  hasNote: false,
};

test('requests carry exactly the documented bodies', async () => {
  const c = client((path) => {
    if (path === 'counts') return { counts: { jojo: 2 } };
    if (path === 'list') return { items: [row], next: { createdAt: 5, id: 's0' } };
    if (path === 'set-status') return { updated: 2, status: 'archived' };
    if (path === 'star') return { id: 's1', starred: true };
    if (path === 'note') return { id: 's1', adminNote: 'n' };
    return { id: 's1', ordinal: 3, status: 'processed' };
  });
  assert.deepEqual(await c.api.counts(), { jojo: 2 });
  const page = await c.api.list({ characterId: 'jojo', status: 'new', starred: true, query: '  哎呀 ' }, null);
  assert.deepEqual(page.next, { createdAt: 5, id: 's0' });
  assert.equal(page.items[0]!.pseudonym, '玩家#0a1b');
  assert.deepEqual(c.sent[1], {
    path: 'list',
    body: { characterId: 'jojo', status: 'new', starred: true, query: '哎呀', before: null },
  });
  await c.api.list({ characterId: null, status: null, starred: false, query: '   ' }, { createdAt: 5, id: 's0' });
  assert.deepEqual(c.sent[2]!.body, {
    characterId: null,
    status: null,
    starred: null,
    query: null,
    before: { createdAt: 5, id: 's0' },
  });
  assert.deepEqual(await c.api.setStatus(['a', 'b'], 'archived'), { updated: 2, status: 'archived' });
  await c.api.star('s1', true);
  assert.equal(await c.api.note('s1', 'n'), 'n');
  assert.deepEqual(await c.api.adopt('s1', 3), { ordinal: 3, status: 'processed' });
  assert.deepEqual(
    c.sent.slice(3).map((s) => s),
    [
      { path: 'set-status', body: { ids: ['a', 'b'], status: 'archived' } },
      { path: 'star', body: { id: 's1', starred: true } },
      { path: 'note', body: { id: 's1', note: 'n' } },
      { path: 'adopt', body: { id: 's1', ordinal: 3 } },
    ],
  );
});

test('the detail is parsed strictly: unknown fields, statuses and kinds are protocol errors', async () => {
  const good = {
    id: 's1',
    characterId: 'jojo',
    createdAt: 1,
    pseudonym: '玩家#0a1b',
    batch: null,
    status: 'new',
    starred: false,
    adminNote: null,
    processedAt: null,
    answers: [
      { ordinal: 0, cardId: 'free', targetField: 'free', kind: 'text', text: 'x', adoptedAt: null },
      {
        ordinal: 1,
        cardId: 'dialogue',
        targetField: 'dialogueExamples',
        kind: 'dialogue',
        player: 'p',
        replies: ['r'],
        adoptedAt: 5,
      },
    ],
  };
  assert.equal((await client(() => good).api.detail('s1')).answers.length, 2);
  for (const bad of [
    { ...good, status: 'done' },
    { ...good, answers: [{ ...good.answers[0], targetField: 'secrets' }] },
    { ...good, answers: [{ ...good.answers[0], kind: 'photo' }] },
    { ...good, answers: [{ ...good.answers[1], replies: [1] }] },
    { ...good, createdAt: -1 },
    null,
  ])
    await assert.rejects(client(() => bad).api.detail('s1'), /ADMIN_COCREATION_PROTOCOL_INVALID/);
});

test('the account client exposes the inbox under /admin/cocreation with the shared CSRF', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const api = new AccountAdminApi(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return Response.json({ counts: { 'wei-guagua': 1 } });
  });
  assert.deepEqual(await api.cocreation.counts(), { 'wei-guagua': 1 });
  assert.equal(requests[0]!.url, '/api/web/provider/admin/cocreation/counts');
  assert.equal(requests[0]!.init.method, 'POST');
});
