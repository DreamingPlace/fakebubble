import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type State = {
  messages: number;
  facts: number;
  outputs: number;
  attempts: { phase: string; state: string; charged_micros: number }[];
  operations: { status: string; quota_state: string }[];
  objects: { erased: boolean; size: number; type: string }[];
};
const setup = (t: test.TestContext) =>
  localRuntime(
    t,
    'tests/web/fixtures/cloudflare-conversation-deletion-31-worker.ts',
    { STATE: 'WebConversationDeletion31Fixture' },
    ['MEDIA'],
  );
const admit = (f: ReturnType<typeof setup>, guest: Guest, text = '这条私人消息会被站长单独删除') =>
  f.call<{ operationId: string }>('/admit', {
    token: guest.issuedToken,
    csrf: guest.csrf,
    origin: 'https://fixture.invalid',
    ipHash: 'a'.repeat(64),
    input: { requestId: randomUUID(), characterId: 'wei-guagua', text },
  });

test('Part 31: deleting one live conversation removes its content and R2 audio, keeps every bill and another player intact, and is refused while a reply is in flight', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guests = [await f.call<Guest>('/bootstrap', {}), await f.call<Guest>('/bootstrap', {})];
  for (const guest of guests) await f.call('/run', await admit(f, guest));
  for (const guest of guests) await f.call('/retention/seed-fact', guest);
  const before = await Promise.all(guests.map((g) => f.call<State>('/retention/state', g)));
  assert.ok(
    before.every((s) => s.messages >= 2 && s.outputs > 0 && s.objects.length > 0 && s.objects.every((o) => o.size > 0)),
  );

  // The runtime step widened every guarded trigger, and a direct delete outside the owner's transaction is still refused.
  const installed = await f.call<any>('/conv/state');
  assert.equal(installed.triggers.length, 10);
  assert.ok(installed.triggers.every((x: any) => x.widened));
  assert.match(
    (await f.call<{ error: string }>('/retention/unsafe-delete', guests[0], 409)).error,
    /WEB_PROVIDER_OUTPUT_IMMUTABLE/,
  );

  const deleted = await f.call<{ messages: number }>('/conv/delete', {
    principalId: guests[0]!.principalId,
    characterId: 'wei-guagua',
  });
  assert.equal(deleted.messages, before[0]!.messages);
  const after = await f.call<State>('/retention/state', guests[0]);
  assert.equal(after.messages, 0);
  assert.equal(after.facts, 0);
  assert.equal(after.outputs, 0);
  assert.deepEqual(after.attempts, before[0]!.attempts, 'every bill is exactly as it was');
  assert.deepEqual(after.operations, before[0]!.operations, 'the operations (counts of what was used) stay');
  // the R2 audio is erased by the sweep (a crash in between is retried by the alarm)
  assert.ok((await f.call<State>('/retention/state', guests[0])).objects.some((o) => o.size > 0));
  assert.deepEqual(await f.call('/conv/sweep'), { erased: 1 });
  const erased = await f.call<State>('/retention/state', guests[0]);
  assert.ok(erased.objects.every((o) => o.erased && o.size === 0 && o.type === 'application/x-web-erased'));
  const meta = await f.call<any>('/conv/state');
  assert.deepEqual(meta.gates, []);
  assert.deepEqual(meta.fk, []);
  assert.deepEqual(meta.deletions, [{ done: 1 }]);
  // the other player's conversation is untouched
  assert.deepEqual(await f.call<State>('/retention/state', guests[1]), before[1]);
  // deleting an empty conversation again is fine and removes nothing
  assert.deepEqual(await f.call('/conv/delete', { principalId: guests[0]!.principalId, characterId: 'wei-guagua' }), {
    messages: 0,
  });

  // a reply that is still in flight blocks the deletion whole: nothing is cancelled, released or changed
  await admit(f, guests[1]!, '这条还在回复中');
  const busy = await f.call<State>('/retention/state', guests[1]);
  assert.equal(
    (
      await f.call<{ error: string }>(
        '/conv/delete',
        { principalId: guests[1]!.principalId, characterId: 'wei-guagua' },
        409,
      )
    ).error,
    'CONVERSATION_DELETE_BUSY',
  );
  assert.deepEqual(await f.call<State>('/retention/state', guests[1]), busy);
});
