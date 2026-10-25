import assert from 'node:assert/strict';
import test from 'node:test';
import { guestCharacterIds, lockedCharacterIds } from '../../../apps/server/admission/web-guest-lock.ts';
import { characterId as first, tiersFixture } from '../fixtures/invite-tiers.ts';

/**
 * Part 26a: an unregistered guest chats with one character (GUEST_ONE_CHARACTER_ENABLED). The lock is derived from the guest's
 * own messages, decided in admission before any reservation, trial counter or provider call.
 */
const second = 'second-character',
  third = 'third-character';
const ip = (digit: string) => digit.repeat(64);
const code = (expected: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === expected;

function setup(t: test.TestContext, flag = true) {
  const f = tiersFixture(t);
  if (flag) Object.assign(f.store, { guestOneCharacter: true });
  for (const id of [second, third])
    f.store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', id, 1, '{}');
  const player = (name: string, o: Parameters<typeof f.player>[1] = {}) => {
    const who = f.player(name, o);
    for (const id of [second, third]) f.store.run("INSERT INTO world_characters VALUES (?,?,'new')", who.worldId, id);
    return who;
  };
  const send = (principalId: string, character: string, requestId: string) =>
    f.admission.admit({ principalId, requestId, characterId: character, text: '你好', ipHash: ip('a') });
  const counts = () =>
    f.store.get<Record<string, number>>(`SELECT
      (SELECT count(*) FROM web_operations) operations,(SELECT count(*) FROM messages) messages,
      (SELECT count(*) FROM conversations) conversations,(SELECT count(*) FROM outbox) outbox,
      (SELECT count(*) FROM web_ip_windows) windows,
      (SELECT coalesce(sum(trial_reserved+trial_used),0) FROM web_principals) trial,
      (SELECT count(*) FROM web_free_operations) free,(SELECT count(*) FROM web_points_events) points`)!;
  return { f, player, send, counts };
}

test('26a the first character a guest writes to is its character; another one is refused before anything is reserved', (t) => {
  const { f, player, send, counts } = setup(t);
  const guest = player('guest');
  assert.deepEqual(lockedCharacterIds(f.store, guest.principalId, f.clock()), []);
  send(guest.principalId, first, 'r1');
  assert.deepEqual(lockedCharacterIds(f.store, guest.principalId, f.clock()), [first]);
  const before = { ...counts() };
  assert.throws(() => send(guest.principalId, second, 'r2'), code('GUEST_CHARACTER_LOCKED'));
  assert.throws(() => send(guest.principalId, third, 'r3'), code('GUEST_CHARACTER_LOCKED'));
  // No reservation, trial counter use, conversation, message, outbox row or free/points row: the refusal cost nothing.
  assert.deepEqual({ ...counts() }, before);
  // The chosen character is still open to it (a replay is not a new send).
  assert.equal(send(guest.principalId, first, 'r1').duplicate, true);
});

test('26a a guest that already has messages with several characters keeps every one of them; only new characters are locked', (t) => {
  const { f, player, send } = setup(t);
  const guest = player('old');
  const conversation = (id: string, character: string) => {
    f.store.run(
      "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,?,'private',?)",
      guest.worldId,
      id,
      character,
    );
    f.store.run(
      "INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (?,?,?,'player',?,?,?,'text',0)",
      `m-${id}`,
      guest.worldId,
      id,
      guest.playerId,
      '早先的消息',
      f.clock(),
    );
  };
  conversation('c-first', first);
  conversation('c-second', second);
  assert.deepEqual(guestCharacterIds(f.store, guest.principalId), [first, second]);
  assert.deepEqual(lockedCharacterIds(f.store, guest.principalId, f.clock()), [first, second]);
  // A conversation without a player message (a chat that was only opened) holds nothing.
  f.store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,'c-empty','private',?)",
    guest.worldId,
    third,
  );
  assert.deepEqual(guestCharacterIds(f.store, guest.principalId), [first, second]);
  assert.equal(send(guest.principalId, second, 'old-1').duplicate, false);
  assert.throws(() => send(guest.principalId, third, 'old-2'), code('GUEST_CHARACTER_LOCKED'));
});

test('26a registered players, holders and accounts are never locked; the list is absent for them', (t) => {
  const { f, player, send } = setup(t);
  const registered = player('registered', { signedUp: true });
  assert.equal(lockedCharacterIds(f.store, registered.principalId, f.clock()), null);
  send(registered.principalId, first, 'reg-1');
  assert.doesNotThrow(() => send(registered.principalId, second, 'reg-2'));
  assert.doesNotThrow(() => send(registered.principalId, third, 'reg-3'));

  const batch = f.create(f.owner, { tier: { kind: 'unlimited' }, count: 1 });
  const holder = player('holder', { signedUp: true });
  f.redeem(holder, batch.codes![0]!);
  assert.equal(lockedCharacterIds(f.store, holder.principalId, f.clock()), null);
  send(holder.principalId, first, 'hold-1');
  assert.doesNotThrow(() => send(holder.principalId, second, 'hold-2'));

  const refill = f.create(f.owner, { tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 }, count: 1 });
  const refilled = player('refilled', { signedUp: true });
  f.redeem(refilled, refill.codes![0]!);
  assert.equal(lockedCharacterIds(f.store, refilled.principalId, f.clock()), null);
  send(refilled.principalId, first, 'refill-1');
  assert.doesNotThrow(() => send(refilled.principalId, second, 'refill-2'));

  // An account principal is not a guest at all.
  f.store.run("UPDATE web_principals SET kind='account' WHERE id=?", registered.principalId);
  assert.equal(lockedCharacterIds(f.store, registered.principalId, f.clock()), null);
});

test('26a a guest that signs up is released: the rule follows the registered state, not the messages', (t) => {
  const { f, player, send } = setup(t);
  const guest = player('grows');
  send(guest.principalId, first, 'g-1');
  assert.throws(() => send(guest.principalId, second, 'g-2'), code('GUEST_CHARACTER_LOCKED'));
  f.store.run(
    'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
    guest.principalId,
    'grows@example.com',
    'x',
    f.clock(),
    f.clock(),
    f.clock(),
  );
  assert.equal(lockedCharacterIds(f.store, guest.principalId, f.clock()), null);
});

test('26a with the switch off nothing changes: no list, and the refusal is never GUEST_CHARACTER_LOCKED', (t) => {
  const { f, player, send } = setup(t, false);
  const guest = player('off');
  send(guest.principalId, first, 'o-1');
  assert.equal(lockedCharacterIds(f.store, guest.principalId, f.clock()), null);
  // Exactly what main does for a trial guest: the Part 11 trial lock, not the new code.
  assert.throws(() => send(guest.principalId, second, 'o-2'), code('TRIAL_CHARACTER_LOCKED'));
});

test('26a 清除本设备数据 is a new guest: it starts with no character', (t) => {
  const { f, player, send } = setup(t);
  const guest = player('before');
  send(guest.principalId, first, 'b-1');
  assert.throws(() => send(guest.principalId, second, 'b-2'), code('GUEST_CHARACTER_LOCKED'));
  const fresh = player('after');
  assert.deepEqual(lockedCharacterIds(f.store, fresh.principalId, f.clock()), []);
  assert.doesNotThrow(() => send(fresh.principalId, second, 'a-1'));
});
