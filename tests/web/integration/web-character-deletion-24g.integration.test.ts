import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { accountLedgerColumns } from '../../../apps/server/characters/web-character-deletion-audit.ts';
import { billingRow } from '../../../apps/player-web/src/features/account/billing-sheet.ts';

// Part 24g: the six account-level ledgers must not block a character deletion, and the deletion must not touch them.
type Guest = { principalId: string; csrf: string; issuedToken: string };
const ledgers = Object.keys(accountLedgerColumns);
const setup = (t: test.TestContext) =>
  localRuntime(
    t,
    'tests/web/fixtures/cloudflare-character-deletion-24g-worker.ts',
    { STATE: 'WebCharacterDeletion24gFixture' },
    ['MEDIA'],
  );
type Runtime = ReturnType<typeof setup>;
async function player(f: Runtime, tables?: string[], voice = 0) {
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const op = await f.call<{ operationId: string }>('/admit', {
    token: guest.issuedToken,
    csrf: guest.csrf,
    origin: 'https://fixture.invalid',
    ipHash: 'a'.repeat(64),
    input: { requestId: randomUUID(), characterId: 'wei-guagua', text: '这条私人消息会随角色一起删除' },
  });
  await f.call('/run', op);
  await f.call('/ledger/seed', { principalId: guest.principalId, tables, voice });
  return guest;
}
const snapshot = (f: Runtime) => f.call<Record<string, unknown[]>>('/ledger/snapshot', {});
const start = async (f: Runtime) => {
  const preview = await f.call<{ previewHash: string }>('/deletion/preview');
  return f.call<any>('/deletion/start', {
    input: { requestId: randomUUID(), previewHash: preview.previewHash, acknowledgeDeleteAllChats: true },
  });
};

for (const table of ledgers)
  test(`24g: rows in ${table} do not block the preview and are unchanged by it`, async (t) => {
    const f = setup(t);
    await player(f, [table]);
    const before = await snapshot(f);
    assert.ok(before[table]!.length > 0, 'the table holds a row');
    const preview = await f.call<any>('/deletion/preview');
    assert.ok(preview.retains.includes('quota-history') && preview.retains.includes('financial-receipts'));
    assert.deepEqual(await snapshot(f), before);
  });

test('24g: an unknown scoped table still blocks, with the old code', async (t) => {
  const f = setup(t);
  const guest = await player(f);
  await f.call('/deletion/unknown', guest);
  assert.equal((await f.call<any>('/deletion/preview', {}, 409)).error, 'CHARACTER_DELETION_UNHANDLED_CONTENT');
});

for (const table of ledgers)
  test(`24g: ${table} with an extra column blocks with CHARACTER_DELETION_SCHEMA_CHANGED naming it`, async (t) => {
    const f = setup(t);
    await player(f, [table]);
    await f.call('/ledger/alter', { table });
    const failure = await f.call<any>('/deletion/preview', {}, 409);
    assert.equal(failure.error, 'CHARACTER_DELETION_SCHEMA_CHANGED');
    assert.deepEqual(failure.detail, { table });
  });

test('24g: a retention gate row answers CHARACTER_DELETION_BUSY with a retry hint; nothing is written; it clears afterwards', async (t) => {
  const f = setup(t);
  const guest = await player(f);
  const before = await snapshot(f);
  await f.call('/ledger/gate', { principalId: guest.principalId, on: true });
  const busy = await f.call<any>('/deletion/preview', {}, 409);
  assert.equal(busy.error, 'CHARACTER_DELETION_BUSY');
  assert.ok(busy.retryAfterMs > 0);
  const refused = await f.call<any>(
    '/deletion/start',
    { input: { requestId: randomUUID(), previewHash: '0'.repeat(64), acknowledgeDeleteAllChats: true } },
    409,
  );
  assert.equal(refused.error, 'CHARACTER_DELETION_BUSY');
  assert.equal((await f.call<any>('/deletion/status', {}, 409)).error, 'NOT_FOUND', 'no deletion row was created');
  assert.deepEqual(await snapshot(f), before);
  assert.equal((await f.call<any>('/retention/state', guest)).messages > 0, true, 'the chat is untouched');
  await f.call('/ledger/gate', { on: false });
  assert.equal((await start(f)).state, 'purging');
});

test('24g: a started deletion meeting a retention gate retries instead of half-deleting', async (t) => {
  const f = setup(t);
  const guest = await player(f);
  assert.equal((await start(f)).state, 'purging');
  await f.call('/ledger/gate', { principalId: guest.principalId, on: true });
  const held = await f.call<any>('/deletion/sweep');
  assert.equal(held.errorCode, 'CHARACTER_DELETION_BUSY');
  assert.equal(held.databaseCleared, 0);
  assert.ok((await f.call<any>('/retention/state', guest)).messages > 0);
  await f.call('/ledger/gate', { on: false });
  assert.equal((await f.call<any>('/deletion/sweep')).state, 'deleted');
});

test('24g: a player with a name card, points, a free operation, a model snapshot and a backup receipt: preview → start → sweep → restart', async (t) => {
  const f = setup(t);
  const guest = await player(f);
  // Opening 消费记录 is itself a visit that may pay the signup bonus, so read it once before the baseline snapshot.
  const billingBefore = await f.call<any>('/ledger/billing', { principalId: guest.principalId });
  const before = await snapshot(f);
  for (const table of ledgers) assert.ok(before[table]!.length > 0, `${table} is seeded`);
  assert.ok(billingBefore.items.some((i: any) => i.kind === 'reply' && i.characterId === 'wei-guagua'));

  const job = await start(f);
  assert.equal(job.state, 'purging');
  const done = await f.call<any>('/deletion/sweep');
  assert.equal(done.state, 'deleted', JSON.stringify(done));
  const check = async () => {
    const state = await f.call<any>('/retention/state', guest);
    assert.equal(state.messages, 0);
    assert.equal(state.outputs, 0);
    assert.deepEqual(await snapshot(f), before, 'the six ledgers are row for row unchanged');
    assert.deepEqual((await f.call<any>('/deletion/state', guest)).fk, [], 'PRAGMA foreign_key_check is clean');
    const billing = await f.call<any>('/ledger/billing', { principalId: guest.principalId });
    // Named exception: `voice` is read from the publication items, which the deletion removes with the chat content.
    // Everything else (time, character id, model, points, free) is the ledger and must be identical.
    const ledgerOnly = (items: any[]) => items.map(({ voice: _voice, ...rest }) => rest);
    assert.deepEqual(ledgerOnly(billing.items), ledgerOnly(billingBefore.items), '消费记录 still lists the rows');
    // The character is gone from the catalogue: the page names it neutrally and does not fail.
    const row = billingRow(
      billing.items.find((i: any) => i.kind === 'reply'),
      () => '',
    );
    assert.match(row.title, /已删除的角色/);
    assert.equal(
      row.points,
      billingRow(
        billingBefore.items.find((i: any) => i.kind === 'reply'),
        () => '',
      ).points,
    );
  };
  await check();
  await f.restart();
  assert.equal((await f.call<any>('/deletion/sweep')).state, 'deleted');
  await check();
});

// Part 27: 消费记录 keeps the 语音 flag of a reply whose character was deleted later: it comes from the operation (the ledger).
test('27: the voice flag of a reply survives the deletion of its character', async (t) => {
  const f = setup(t);
  const guest = await player(f, undefined, 1);
  const before = await f.call<any>('/ledger/billing', { principalId: guest.principalId });
  const reply = (page: any) => page.items.find((i: any) => i.kind === 'reply');
  assert.equal(reply(before).voice, true, 'the reply carried a voice');
  await start(f);
  assert.equal((await f.call<any>('/deletion/sweep')).state, 'deleted');
  assert.equal((await f.call<any>('/retention/state', guest)).outputs, 0, 'the chat content and audio are gone');
  const after = await f.call<any>('/ledger/billing', { principalId: guest.principalId });
  assert.deepEqual(after.items, before.items, '消费记录 is identical, 语音 included');
  assert.equal(billingRow(reply(after), () => '').sub.endsWith('语音'), true);
  assert.equal(billingRow(reply(after), () => '').sub.includes('无语音'), false);
});
