import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import {
  effectiveModel,
  hasPoints,
  modelChoiceState,
  reconcilePoints,
  setPlayerModel,
} from '../../../apps/server/admission/web-points.ts';
import { purgePlayerLogins, playerLoginsRemain } from '../../../apps/server/identity/web-player-purge.ts';
import { POINTS, replyPoints, repliesLeft, parsePlayerTextModels } from '../../../packages/contracts/player-models.ts';
import type { PlayerModelId } from '../../../packages/contracts/player-models.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { enableModelChoice, schema123 } from '../fixtures/model-choice.ts';

const ip = (digit: string) => digit.repeat(64);
const characterId = 'fixture-character';
const T0 = 1_700_000_000_000;

/** A real schema-123 store with a guest that holds the signup bonus; the Part 21b flag is on unless `flag: false`. */
function fixture(
  t: TestContext,
  options: { flag?: boolean; offered?: readonly PlayerModelId[]; bonusSpent?: number; bonus?: boolean } = {},
) {
  const store = schema123();
  t.after(() => store.close());
  Object.assign(store, { webIpKeyFingerprint: () => 'f'.repeat(64) });
  if (options.flag === false) Object.assign(store, { publicFreeTier: true });
  else enableModelChoice(store, options.offered);
  let now = T0,
    seq = 0;
  const nextId = () => `id-${++seq}`;
  const admission = new WebAdmission(store as WebStore, { now: () => now }, nextId);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  const guest = (name: string, bonus = true) => {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, characterId);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    if (bonus) store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', principalId, now);
    return principalId;
  };
  /** An operation that already exists in some state, optionally one of the 10 bonus replies of the old accounting. */
  const history = (principalId: string, status: string, tier: 'bonus' | null, n: number) => {
    const world = principalId.replace('principal', 'world'),
      player = principalId.replace('principal', 'player');
    const messageId = `m-${n}-${principalId}`;
    store.run(
      `INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,?,'private',?) ON CONFLICT DO NOTHING`,
      world,
      `c-${principalId}`,
      characterId,
    );
    store.run(
      "INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (?,?,?,'player',?,'旧',?,'text',0)",
      messageId,
      world,
      `c-${principalId}`,
      player,
      now,
    );
    store.run(
      `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,
      input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,metering_type)
      VALUES (?,?,?,'p',?,?,?,?,NULL,?,?,?,?,'entitled')`,
      `old-${n}-${principalId}`,
      principalId,
      `old-${n}`,
      world,
      `c-${principalId}`,
      characterId,
      messageId,
      status,
      status === 'published' ? 'used' : 'reserved',
      now,
      now + 1000,
    );
    if (tier)
      store.run("INSERT INTO web_free_operations VALUES (?,?,'bonus',NULL)", `old-${n}-${principalId}`, principalId);
  };
  const state = (principalId: string) => modelChoiceState(store, now, principalId);
  const events = (principalId: string) =>
    store
      .all<{
        source: string;
        reason: string | null;
        delta: number;
        operation_id: string | null;
        admin_id: string | null;
      }>(
        'SELECT source,reason,delta,operation_id,admin_id FROM web_points_events WHERE principal_id=? ORDER BY id',
        principalId,
      )
      .map((row) => ({ ...row }));
  const balance = (principalId: string) =>
    store.get<{ balance: number }>('SELECT balance FROM web_points_balance WHERE principal_id=?', principalId)?.balance;
  const sum = (principalId: string) => events(principalId).reduce((total, e) => total + e.delta, 0);
  const admit = (principalId: string, requestId: string) =>
    admission.admit({ principalId, requestId, characterId, text: '你好', ipHash: ip('a') });
  const finish = (operationId: string, status: string) =>
    store.run(
      'UPDATE web_operations SET status=?,quota_state=?,stage_version=stage_version+1 WHERE id=?',
      status,
      status === 'published' ? 'used' : 'released',
      operationId,
    );
  const advance = (ms: number) => {
    now += ms;
  };
  const principalId = guest('a', options.bonus !== false);
  for (let n = 0; n < (options.bonusSpent ?? 0); n++) history(principalId, 'published', 'bonus', n);
  return {
    store,
    admission,
    admit,
    state,
    events,
    balance,
    sum,
    finish,
    history,
    guest,
    principalId,
    advance,
    clock: () => now,
  };
}

test('the first touch creates the balance from the old bonus accounting: 100 - 10 x bonus replies already spent, once', (t) => {
  const f = fixture(t, { bonusSpent: 3 });
  assert.equal(f.balance(f.principalId), undefined, 'no backfill: nothing exists before the first touch');
  const first = f.state(f.principalId)!;
  assert.equal(first.balance, 70);
  assert.deepEqual(f.events(f.principalId), [
    { source: 'bonus', reason: null, delta: 70, operation_id: null, admin_id: null },
  ]);
  f.history(f.principalId, 'published', 'bonus', 99);
  assert.equal(f.state(f.principalId)!.balance, 70, 'a second touch never initialises again');
  const fresh = fixture(t);
  assert.equal(fresh.state(fresh.principalId)!.balance, 100);
  const spentAll = fixture(t, { bonusSpent: 10 });
  assert.equal(spentAll.state(spentAll.principalId)!.balance, 0);
  assert.deepEqual(spentAll.events(spentAll.principalId), [], 'no event for an empty grant');
  // A failed bonus reply was never spent.
  const failed = fixture(t);
  failed.history(failed.principalId, 'failed', 'bonus', 1);
  failed.store.run(
    "UPDATE web_operations SET quota_state='released',stage_version=stage_version+1 WHERE status='failed'",
  );
  assert.equal(failed.state(failed.principalId)!.balance, 100);
});

test('the displayed numbers come from one price table', () => {
  assert.deepEqual({ ...POINTS.perReply }, { deepseek: 10, gemini: 20, xai: 40 });
  assert.equal(POINTS.voice, 2);
  assert.equal(replyPoints('xai', true), 42);
  assert.equal(replyPoints('deepseek', false), 10);
  assert.equal(repliesLeft(100, 'deepseek'), 8);
  assert.equal(repliesLeft(100, 'xai'), 2);
  assert.deepEqual(parsePlayerTextModels('gemini'), ['deepseek', 'gemini'], 'DeepSeek is always on');
  assert.deepEqual(parsePlayerTextModels('xai, gemini'), ['deepseek', 'gemini', 'xai']);
  assert.deepEqual(parsePlayerTextModels(undefined), ['deepseek', 'gemini', 'xai']);
});

test('a reply by a chosen model is charged at admission, once, and the model is frozen into the operation', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'xai');
  const first = f.admit(f.principalId, 'r1');
  assert.equal(first.duplicate, false);
  assert.equal(f.balance(f.principalId), 100 - 42);
  assert.deepEqual(f.events(f.principalId).at(-1), {
    source: 'spend',
    reason: 'reply',
    delta: -42,
    admin_id: null,
    operation_id: first.operationId,
  });
  const row = f.store.get<Record<string, unknown>>(
    'SELECT * FROM web_operation_models WHERE operation_id=?',
    first.operationId,
  )!;
  assert.deepEqual([row.chosen, row.points_charged, row.voice, row.price_version, row.settled], ['xai', 42, 1, 1, 0]);
  assert.equal(
    f.store.get('SELECT 1 FROM web_free_operations WHERE operation_id=?', first.operationId),
    undefined,
    'not a bonus reply any more',
  );
  const principal = f.store.get<{ trial_reserved: number; trial_used: number }>(
    'SELECT trial_reserved,trial_used FROM web_principals WHERE id=?',
    f.principalId,
  )!;
  assert.deepEqual([principal.trial_reserved, principal.trial_used], [0, 0], 'the guest trial counters are untouched');
  // Idempotent replay: no second charge.
  assert.equal(f.admit(f.principalId, 'r1').duplicate, true);
  assert.equal(f.balance(f.principalId), 58);
  // Switching affects the NEXT message only.
  f.finish(first.operationId, 'published');
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  const second = f.admit(f.principalId, 'r2');
  assert.equal(
    f.store.get<{ chosen: string }>('SELECT chosen FROM web_operation_models WHERE operation_id=?', first.operationId)!
      .chosen,
    'xai',
  );
  assert.equal(
    f.store.get<{ chosen: string }>('SELECT chosen FROM web_operation_models WHERE operation_id=?', second.operationId)!
      .chosen,
    'gemini',
  );
  // The first reply was settled when the balance was next touched: it carried no voice in this fixture, so its 2 voice points came back.
  assert.equal(f.balance(f.principalId), 58 + 2 - 22);
  assert.equal(f.balance(f.principalId), f.sum(f.principalId), 'balance == the sum of its events');
});

test('DeepSeek still uses the guest trial replies first (3 + 2); only when those are gone does it spend points; the picker model never uses them', (t) => {
  const f = fixture(t);
  for (let n = 0; n < 5; n++) {
    const free = f.admit(f.principalId, `free-${n}`);
    assert.equal(
      f.store.get('SELECT 1 FROM web_operation_models WHERE operation_id=?', free.operationId),
      undefined,
      'a guest trial reply has no points row',
    );
    f.finish(free.operationId, 'published');
  }
  assert.equal(f.balance(f.principalId), undefined, 'nothing was charged, nothing was even initialised');
  const sixth = f.admit(f.principalId, 'sixth');
  assert.equal(
    f.store.get<{ points_charged: number; chosen: string }>(
      'SELECT points_charged,chosen FROM web_operation_models WHERE operation_id=?',
      sixth.operationId,
    )!.points_charged,
    12,
  );
  assert.equal(f.balance(f.principalId), 88);

  const g = fixture(t);
  setPlayerModel(g.store, g.clock(), g.principalId, 'gemini');
  const paid = g.admit(g.principalId, 'a');
  assert.equal(
    g.store.get<{ points_charged: number }>(
      'SELECT points_charged FROM web_operation_models WHERE operation_id=?',
      paid.operationId,
    )!.points_charged,
    22,
    'the trial replies are kept for later DeepSeek messages',
  );
  assert.equal(
    g.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', g.principalId)!
      .trial_reserved,
    0,
  );
});

test('no reply means the whole charge comes back: known failure, cancellation or UNKNOWN; settled once', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  const ops = (['failed', 'unknown', 'cancelled'] as const).map((outcome, n) => {
    const op = f.admit(f.principalId, `op-${n}`);
    if (outcome === 'unknown')
      f.store.run(
        "UPDATE web_operations SET status='unknown',stage_version=stage_version+1 WHERE id=?",
        op.operationId,
      );
    else f.finish(op.operationId, outcome);
    return op.operationId;
  });
  assert.equal(ops.length, 3);
  reconcilePoints(f.store, f.clock(), f.principalId);
  const refunds = f.events(f.principalId).filter((e) => e.source === 'refund');
  assert.deepEqual(refunds.map((e) => [e.reason, e.delta]).sort(), [
    ['no_reply', 22],
    ['no_reply', 22],
    ['no_reply', 22],
  ]);
  assert.equal(f.balance(f.principalId), 100);
  reconcilePoints(f.store, f.clock(), f.principalId);
  reconcilePoints(f.store, f.clock(), f.principalId);
  assert.equal(
    f.events(f.principalId).filter((e) => e.source === 'refund').length,
    3,
    'a second settlement of the same fact is a no-op',
  );
  assert.equal(f.balance(f.principalId), f.sum(f.principalId));
});

test('answered by a backup model: the player pays the CHEAPER of the two models; a reply without voice is not charged the voice points', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'xai');
  const op = f.admit(f.principalId, 'x');
  f.store.run(
    "UPDATE web_operation_models SET draft_provider='deepseek',draft_model='deepseek-flash',review_provider='deepseek',review_model='deepseek-v4-pro',backup=1 WHERE operation_id=?",
    op.operationId,
  );
  f.finish(op.operationId, 'published');
  f.store.run("INSERT INTO web_publication_items SELECT 'x',0,'nope','narrative','m' WHERE 0");
  const state = f.state(f.principalId)!;
  const events = f.events(f.principalId);
  assert.deepEqual(
    events
      .filter((e) => e.source === 'refund')
      .map((e) => [e.reason, e.delta])
      .sort(),
    [
      ['backup_cheaper', 30],
      ['no_voice', 2],
    ],
  );
  assert.equal(state.balance, 100 - 42 + 32, 'xAI price 40 -> DeepSeek 10, and no voice in the reply');

  // The backup is DEARER than the chosen model: the player still pays only the chosen (cheaper) price.
  const g = fixture(t);
  const op2 = g.admit(g.principalId, 'y');
  setPlayerModel(g.store, g.clock(), g.principalId, 'deepseek');
  assert.equal(
    g.store.get('SELECT 1 FROM web_operation_models WHERE operation_id=?', op2.operationId),
    undefined,
    'free trial reply',
  );
});

test('at 0 points: the same "free replies used up" answer as today; a dearer model than the balance asks for a cheaper one', (t) => {
  const empty = fixture(t, { bonusSpent: 10 });
  setPlayerModel(empty.store, empty.clock(), empty.principalId, 'xai');
  assert.throws(
    () => empty.admit(empty.principalId, 'b'),
    /TRIAL_EXHAUSTED/,
    'nothing affordable: the old copy and code',
  );

  const some = fixture(t, { bonusSpent: 7 }); // 30 points
  setPlayerModel(some.store, some.clock(), some.principalId, 'xai');
  assert.throws(() => some.admit(some.principalId, 'c'), /POINTS_INSUFFICIENT/);
  assert.equal(some.state(some.principalId)!.balance, 30, 'a refused reply charged nothing');
  setPlayerModel(some.store, some.clock(), some.principalId, 'gemini');
  some.admit(some.principalId, 'd');
  assert.equal(some.balance(some.principalId), 8);

  const ten = fixture(t, { bonusSpent: 9 }); // 10 points < 12 (the cheapest reply with voice)
  setPlayerModel(ten.store, ten.clock(), ten.principalId, 'gemini');
  assert.throws(() => ten.admit(ten.principalId, 'e'), /TRIAL_EXHAUSTED/);
});

test('flag off = exactly today: the old bonus replies, no picker, no points rows, no row written for the operation', (t) => {
  const f = fixture(t, { flag: false });
  assert.equal(hasPoints(f.store, f.principalId), false);
  assert.equal(f.state(f.principalId), null);
  assert.throws(() => setPlayerModel(f.store, f.clock(), f.principalId, 'xai'), /NOT_FOUND/);
  // Use up the 5 trial replies, then the sixth is a bonus reply (old accounting).
  for (let n = 0; n < 5; n++) {
    const op = f.admit(f.principalId, `t${n}`);
    f.finish(op.operationId, 'published');
  }
  const bonus = f.admit(f.principalId, 'bonus');
  assert.equal(
    f.store.get<{ tier: string }>('SELECT tier FROM web_free_operations WHERE operation_id=?', bonus.operationId)!.tier,
    'bonus',
  );
  assert.equal(f.store.get('SELECT 1 FROM web_operation_models'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_points_balance'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_points_events'), undefined);
});

test('guests and players without the bonus have no points and no picker; their operations are the old ones', (t) => {
  const f = fixture(t, { bonus: false });
  assert.equal(hasPoints(f.store, f.principalId), false);
  assert.equal(f.state(f.principalId), null);
  assert.throws(() => setPlayerModel(f.store, f.clock(), f.principalId, 'gemini'), /NOT_FOUND/);
  const op = f.admit(f.principalId, 'a');
  assert.equal(f.store.get('SELECT 1 FROM web_operation_models WHERE operation_id=?', op.operationId), undefined);
  assert.equal(effectiveModel(f.store, f.clock(), f.principalId), 'deepseek');
});

test('owner kill switch: a model that is no longer offered is hidden and the player falls back to DeepSeek with a one-time notice', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  assert.equal(f.state(f.principalId)!.selected, 'gemini');
  Object.assign(f.store, { playerModelChoice: ['deepseek', 'xai'] });
  const after = f.state(f.principalId)!;
  assert.deepEqual(
    after.models.map((m) => m.id),
    ['deepseek', 'xai'],
    'hidden from the picker',
  );
  assert.equal(after.selected, 'deepseek');
  assert.equal(after.notice, 'model_withdrawn');
  assert.equal(f.state(f.principalId)!.notice, undefined, 'shown once');
  assert.throws(() => setPlayerModel(f.store, f.clock(), f.principalId, 'gemini'), /MODEL_NOT_AVAILABLE/);
  // The next admission uses DeepSeek (the trial replies first).
  const op = f.admit(f.principalId, 'a');
  assert.equal(f.store.get('SELECT 1 FROM web_operation_models WHERE operation_id=?', op.operationId), undefined);
});

test('points data goes with the player, and the lifecycle audit sees nothing left', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'xai');
  f.admit(f.principalId, 'a');
  assert.equal(playerLoginsRemain(f.store, [f.principalId]), true);
  purgePlayerLogins(f.store, { principalId: f.principalId, worldId: 'world-a' });
  assert.equal(f.store.get('SELECT 1 FROM web_points_balance'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_points_events'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_player_model'), undefined);
  assert.equal(playerLoginsRemain(f.store, [f.principalId]), false);
});

test('points events are append-only', (t) => {
  const f = fixture(t);
  f.state(f.principalId);
  assert.throws(() => f.store.run('UPDATE web_points_events SET delta=1'), /WEB_POINTS_EVENT_IMMUTABLE/);
});

test('the allowance POLICY is stored apart from the BALANCE, and every event names its source (admin id only for admin actions)', (t) => {
  const f = fixture(t, { bonusSpent: 2 });
  f.state(f.principalId);
  const policy = f.store.get<Record<string, unknown>>(
    'SELECT * FROM web_points_policy WHERE principal_id=?',
    f.principalId,
  )!;
  assert.deepEqual([policy.kind, policy.amount, policy.last_refill_day], ['one_off', 100, null]);
  assert.equal(f.balance(f.principalId), 80);
  const ins = (source: string, reason: string | null, delta: number, op: string | null, admin: string | null) =>
    f.store.run(
      'INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at) VALUES (?,?,?,?,?,?,1,1)',
      f.principalId,
      op,
      source,
      reason,
      delta,
      admin,
    );
  // Part 22 can add these without a schema change.
  ins('grant', null, 50, null, 'admin-1');
  ins('daily_refill', null, 30, null, null);
  ins('reset', null, 5, null, 'admin-1');
  for (const kind of ['daily_refill', 'unlimited'])
    f.store.run(
      'UPDATE web_points_policy SET kind=?,last_refill_day=? WHERE principal_id=?',
      kind,
      kind === 'daily_refill' ? '2026-10-15' : null,
      f.principalId,
    );
  // The rules the schema enforces.
  assert.throws(
    () => ins('daily_refill', null, 1, null, 'admin-1'),
    /CHECK/,
    'only an admin action carries an admin id',
  );
  assert.throws(() => ins('bonus', null, 1, null, null), /UNIQUE/, 'the signup bonus is once');
  assert.throws(() => ins('spend', 'reply', 5, 'x', null), /CHECK|FOREIGN/, 'a spend is negative');
  assert.throws(() => ins('made_up', null, 1, null, null), /CHECK/);
});

test('an unlimited policy is never charged; the operation still freezes the chosen model', (t) => {
  const f = fixture(t);
  f.state(f.principalId);
  f.store.run("UPDATE web_points_policy SET kind='unlimited' WHERE principal_id=?", f.principalId);
  setPlayerModel(f.store, f.clock(), f.principalId, 'xai');
  const op = f.admit(f.principalId, 'u');
  assert.equal(
    f.store.get<{ points_charged: number; chosen: string }>(
      'SELECT points_charged,chosen FROM web_operation_models WHERE operation_id=?',
      op.operationId,
    )!.chosen,
    'xai',
  );
  assert.equal(f.balance(f.principalId), 100);
  assert.equal(f.events(f.principalId).filter((e) => e.source === 'spend').length, 0);
});

test('invited players may choose a model, are never charged points, and keep their rolling daily limit', (t) => {
  const f = fixture(t, { bonus: false });
  // Turn the fixture principal into an invited player with an active grant.
  f.store.run("UPDATE web_principals SET kind='invite',revision=revision+1 WHERE id=?", f.principalId);
  f.store.run(
    "UPDATE web_guest_retention SET state='protected',started_at=NULL,expires_at=NULL,revision=revision+1 WHERE principal_id=?",
    f.principalId,
  );
  f.store.db.exec('PRAGMA foreign_keys=OFF'); // the grant's invite code row is not what this test is about
  f.store.run(
    'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at) VALUES (?,?,?,?,?,?)',
    'grant',
    'invite',
    f.principalId,
    'player-a',
    'world-a',
    1,
  );
  const s = f.state(f.principalId)!;
  assert.equal(s.metered, false);
  assert.equal(f.balance(f.principalId), undefined, 'no points account is created');
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  assert.equal(f.state(f.principalId)!.selected, 'gemini');
  const op = f.admit(f.principalId, 'i1');
  const row = f.store.get<{ chosen: string; points_charged: number }>(
    'SELECT chosen,points_charged FROM web_operation_models WHERE operation_id=?',
    op.operationId,
  )!;
  assert.deepEqual([row.chosen, row.points_charged], ['gemini', 0]);
  assert.equal(f.store.get('SELECT 1 FROM web_points_events'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_points_balance'), undefined);
  // The existing rolling daily limit still applies, exactly as before.
  f.finish(op.operationId, 'published');
  Object.assign(f.store, { dailyReplyLimit: 1 });
  assert.throws(() => f.admit(f.principalId, 'i2'), /WEB_DAILY_LIMIT_REACHED/);
});
