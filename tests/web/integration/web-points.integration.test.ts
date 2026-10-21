import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import {
  effectiveModel,
  hasPoints,
  modelChoiceState,
  reconcilePoints,
  setPlayerModel,
  isUnmetered,
} from '../../../apps/server/admission/web-points.ts';
import { BILLING_PAGE_SIZE, WebBilling, playerBilling } from '../../../apps/server/admission/web-billing.ts';
import { routeWebBilling } from '../../../apps/server/admission/web-billing-routes.ts';
import { parseBillingPage } from '../../../packages/contracts/player-billing.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { purgePlayerLogins, playerLoginsRemain } from '../../../apps/server/identity/web-player-purge.ts';
import { POINTS, replyPoints, repliesLeft, parsePlayerTextModels } from '../../../packages/contracts/player-models.ts';
import type { PlayerModelId } from '../../../packages/contracts/player-models.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderInviteTiers,
  migrateWebProviderLegacyInvites,
  migrateWebProviderModelSettings,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { enableModelChoice, schema123 } from '../fixtures/model-choice.ts';
import { grantUnlimited } from '../fixtures/model-settings.ts';

/** Named exception (Part 22x): the entitlement tables (125) and the retired legacy invites (126) on a schema-123 fixture store. */
function upTo126(store: ReturnType<typeof schema123>) {
  migrateWebProviderModelSettings(store);
  migrateWebProviderInviteTiers(store);
  migrateWebProviderLegacyInvites(store);
}

const ip = (digit: string) => digit.repeat(64);
const characterId = 'fixture-character';
const T0 = 1_700_000_000_000;

/** A real schema-123 store with a guest that holds the signup bonus; the Part 21b flag is on unless `flag: false`. */
function fixture(
  t: TestContext,
  options: {
    flag?: boolean;
    offered?: readonly PlayerModelId[];
    bonusSpent?: number;
    bonus?: boolean;
    /**
     * Trial replies (of the 5) the guest had used before signing up. Part 21f: unused ones are converted into points, so the
     * default is the realistic "signed up after the whole trial" (5): 100 points, as before the change.
     */
    trialSpent?: number;
  } = {},
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
  const history = (principalId: string, status: string, tier: 'bonus' | 'trial_extra' | null, n: number) => {
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
    if (tier === 'bonus')
      store.run("INSERT INTO web_free_operations VALUES (?,?,'bonus',NULL)", `old-${n}-${principalId}`, principalId);
    if (tier === 'trial_extra')
      store.run(
        "INSERT INTO web_free_operations VALUES (?,?,'trial_extra',?)",
        `old-${n}-${principalId}`,
        principalId,
        ip('a'),
      );
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
  /** The reply carried voice: one narrative publication item with media (what the points settlement looks for). */
  const voiced = (operationId: string) => {
    store.db.exec('PRAGMA foreign_keys=OFF'); // the publication's job and message rows are not what these tests are about
    const op = store.get<{ principal_id: string; world_id: string; conversation_id: string; character_id: string }>(
      'SELECT principal_id,world_id,conversation_id,character_id FROM web_operations WHERE id=?',
      operationId,
    )!;
    store.run(
      `INSERT INTO web_publications(operation_id,principal_id,player_id,world_id,conversation_id,character_id,
      input_message_id,job_id,request_digest,candidate_digest,published_at,receipt_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      operationId,
      op.principal_id,
      op.principal_id.replace('principal', 'player'),
      op.world_id,
      op.conversation_id,
      op.character_id,
      'm',
      `job-${operationId}`,
      'd',
      'd',
      now,
      '{}',
    );
    store.run(
      'INSERT INTO web_publication_items VALUES (?,?,?,?,?)',
      operationId,
      0,
      `msg-${operationId}`,
      'media-1',
      'narrative',
    );
  };
  const advance = (ms: number) => {
    now += ms;
  };
  const principalId = guest('a', options.bonus !== false);
  // Trial replies already used: the first 3 are on the guest counters, replies 4-5 are "extra" (derived accounting).
  const trialSpent = options.trialSpent ?? (options.bonus === false ? 0 : 5);
  store.run('UPDATE web_principals SET trial_used=? WHERE id=?', Math.min(3, trialSpent), principalId);
  for (let n = 3; n < trialSpent; n++) history(principalId, 'published', 'trial_extra', 100 + n);
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
    voiced,
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
  assert.deepEqual({ ...POINTS.perReply }, { deepseek: 10, gemini: 20, xai: 25 });
  assert.equal(POINTS.version, 2, 'the price change is a new version');
  assert.equal(POINTS.voice, 2);
  assert.equal(replyPoints('xai', true), 27);
  assert.equal(replyPoints('deepseek', false), 10);
  assert.equal(repliesLeft(100, 'deepseek'), 8);
  assert.equal(repliesLeft(100, 'xai'), 3);
  assert.deepEqual(parsePlayerTextModels('gemini'), ['deepseek', 'gemini'], 'DeepSeek is always on');
  assert.deepEqual(parsePlayerTextModels('xai, gemini'), ['deepseek', 'gemini', 'xai']);
  assert.deepEqual(parsePlayerTextModels(undefined), ['deepseek', 'gemini', 'xai']);
});

test('a reply by a chosen model is charged at admission, once, and the model is frozen into the operation', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'xai');
  const first = f.admit(f.principalId, 'r1');
  assert.equal(first.duplicate, false);
  assert.equal(f.balance(f.principalId), 100 - 27);
  assert.deepEqual(f.events(f.principalId).at(-1), {
    source: 'spend',
    reason: 'reply',
    delta: -27,
    admin_id: null,
    operation_id: first.operationId,
  });
  const row = f.store.get<Record<string, unknown>>(
    'SELECT * FROM web_operation_models WHERE operation_id=?',
    first.operationId,
  )!;
  assert.deepEqual([row.chosen, row.points_charged, row.voice, row.price_version, row.settled], ['xai', 27, 1, 2, 0]);
  assert.equal(
    f.store.get('SELECT 1 FROM web_free_operations WHERE operation_id=?', first.operationId),
    undefined,
    'not a bonus reply any more',
  );
  const principal = f.store.get<{ trial_reserved: number; trial_used: number }>(
    'SELECT trial_reserved,trial_used FROM web_principals WHERE id=?',
    f.principalId,
  )!;
  // (the fixture signed up after the whole trial: 3 on the counters, 2 extra; the charge touches none of them)
  assert.deepEqual([principal.trial_reserved, principal.trial_used], [0, 3], 'the guest trial counters are untouched');
  // Idempotent replay: no second charge.
  assert.equal(f.admit(f.principalId, 'r1').duplicate, true);
  assert.equal(f.balance(f.principalId), 73);
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
  assert.equal(f.balance(f.principalId), 73 + 2 - 22);
  assert.equal(f.balance(f.principalId), f.sum(f.principalId), 'balance == the sum of its events');
});

// Part 21f (named exception): this test used to assert the opposite for DeepSeek ("uses the guest trial replies first, no
// points row"). A signed-up player now ALWAYS pays points, whatever the model; the unused trial replies are converted into
// the opening balance instead (next test).
test('every reply, any model, creates a spend event and a model row; the guest trial path is never used', (t) => {
  for (const model of ['deepseek', 'gemini', 'xai'] as const) {
    const f = fixture(t);
    setPlayerModel(f.store, f.clock(), f.principalId, model);
    const before = f.store.get<{ trial_used: number; trial_reserved: number }>(
      'SELECT trial_used,trial_reserved FROM web_principals WHERE id=?',
      f.principalId,
    )!;
    const op = f.admit(f.principalId, 'r1');
    const row = f.store.get<{ chosen: string; points_charged: number }>(
      'SELECT chosen,points_charged FROM web_operation_models WHERE operation_id=?',
      op.operationId,
    )!;
    assert.deepEqual([row.chosen, row.points_charged], [model, replyPoints(model, true)]);
    const spend = f.events(f.principalId).filter((e) => e.source === 'spend');
    assert.deepEqual(
      spend.map((e) => [e.operation_id, e.delta]),
      [[op.operationId, -replyPoints(model, true)]],
    );
    assert.deepEqual(
      f.store.get('SELECT trial_used,trial_reserved FROM web_principals WHERE id=?', f.principalId),
      before,
      'the trial counters are not touched',
    );
    assert.equal(f.store.get('SELECT 1 FROM web_free_operations WHERE operation_id=?', op.operationId), undefined);
  }
  // Even a player who signed up with an UNTOUCHED trial (all 5 replies unused) pays points from the first reply.
  const fresh = fixture(t, { trialSpent: 0 });
  const op = fresh.admit(fresh.principalId, 'first');
  assert.equal(
    fresh.store.get<{ points_charged: number }>(
      'SELECT points_charged FROM web_operation_models WHERE operation_id=?',
      op.operationId,
    )!.points_charged,
    12,
  );
  assert.equal(fresh.balance(fresh.principalId), 150 - 12);
});

test('the opening balance converts unused trial replies: signup after 2 -> 130, after 5 -> 100, after 0 -> 150', (t) => {
  for (const [spent, expected] of [
    [2, 130],
    [5, 100],
    [0, 150],
    [3, 120],
    [4, 110],
  ] as const) {
    const f = fixture(t, { trialSpent: spent });
    const first = f.state(f.principalId)!;
    assert.equal(first.balance, expected, `${spent} trial replies used`);
    assert.deepEqual(f.events(f.principalId), [
      { source: 'bonus', reason: null, delta: expected, operation_id: null, admin_id: null },
    ]);
    assert.equal(f.sum(f.principalId), f.balance(f.principalId));
  }
  // Bonus replies already spent count against it, and a reserved (in-flight) trial reply counts as used.
  const mixed = fixture(t, { trialSpent: 2, bonusSpent: 3 });
  assert.equal(mixed.state(mixed.principalId)!.balance, 100 - 30 + 30);
  const reserved = fixture(t, { trialSpent: 0 });
  reserved.store.run('UPDATE web_principals SET trial_reserved=2 WHERE id=?', reserved.principalId);
  assert.equal(reserved.state(reserved.principalId)!.balance, 100 + 30);
  // An already-initialised balance is never recomputed, whatever happens to the trial counters afterwards.
  const done = fixture(t, { trialSpent: 2 });
  assert.equal(done.state(done.principalId)!.balance, 130);
  done.store.run('UPDATE web_principals SET trial_used=0 WHERE id=?', done.principalId);
  assert.equal(done.state(done.principalId)!.balance, 130);
  // A plain guest has no points: exactly as before.
  const guest = fixture(t, { bonus: false, trialSpent: 2 });
  assert.equal(guest.state(guest.principalId), null);
  assert.equal(guest.balance(guest.principalId), undefined);
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
      ['backup_cheaper', 15],
      ['no_voice', 2],
    ],
  );
  assert.equal(state.balance, 100 - 27 + 17, 'xAI price 25 -> DeepSeek 10, and no voice in the reply');

  // Part 21f (named exception): this half asserted that a DeepSeek reply is a free trial reply with no model row. It now
  // has one and is charged (12 points), like every reply of a signed-up player.
  const g = fixture(t);
  const op2 = g.admit(g.principalId, 'y');
  assert.equal(
    g.store.get<{ points_charged: number }>(
      'SELECT points_charged FROM web_operation_models WHERE operation_id=?',
      op2.operationId,
    )!.points_charged,
    12,
  );
});

test('Gemini chosen, DeepSeek wrote it: the balance read right after the reply is start - 12, not start - 22', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  const start = f.state(f.principalId)!.balance;
  const op = f.admit(f.principalId, 'g');
  assert.equal(f.balance(f.principalId), start - 22, 'charged at admission');
  f.store.run(
    "UPDATE web_operation_models SET draft_provider='deepseek',draft_model='deepseek-flash',review_provider='deepseek',review_model='deepseek-v4-pro',backup=1 WHERE operation_id=?",
    op.operationId,
  );
  f.finish(op.operationId, 'published');
  f.voiced(op.operationId); // a voiced reply: the voice points are not refunded
  // The state the player page is given settles first (reconcile before returning), so the figure is already final.
  const shown = f.state(f.principalId)!;
  assert.equal(shown.balance, start - 12);
  assert.equal(shown.balance, f.balance(f.principalId));
  assert.equal(shown.balance, f.sum(f.principalId), 'balance == the sum of its events');
});

test('at 0 points: the same "free replies used up" answer as today; a dearer model than the balance asks for a cheaper one', (t) => {
  const empty = fixture(t, { bonusSpent: 10 });
  setPlayerModel(empty.store, empty.clock(), empty.principalId, 'xai');
  assert.throws(
    () => empty.admit(empty.principalId, 'b'),
    /TRIAL_EXHAUSTED/,
    'nothing affordable: the old copy and code',
  );

  const some = fixture(t, { bonusSpent: 8 }); // 20 points (xAI is 27 with voice, Gemini 22)
  setPlayerModel(some.store, some.clock(), some.principalId, 'xai');
  assert.throws(() => some.admit(some.principalId, 'c'), /POINTS_INSUFFICIENT/);
  assert.equal(some.state(some.principalId)!.balance, 20, 'a refused reply charged nothing');
  setPlayerModel(some.store, some.clock(), some.principalId, 'deepseek');
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
  // The next admission uses DeepSeek, charged like every reply of a signed-up player (Part 21f: no trial path).
  const op = f.admit(f.principalId, 'a');
  assert.equal(
    f.store.get<{ chosen: string }>('SELECT chosen FROM web_operation_models WHERE operation_id=?', op.operationId)!
      .chosen,
    'deepseek',
  );
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
  // Named exception (Part 22x): an invited player is a signed-up player with an unlimited entitlement (no invite principal kind).
  upTo126(f.store);
  grantUnlimited(f.store as never, f.principalId, 'entitlement', f.clock(), false);
  assert.equal(isUnmetered(f.store, f.principalId, f.clock()), true);
  assert.ok(f.state(f.principalId));
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

// ---- 消费记录 (Part 21f) -------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const publish = (
  f: ReturnType<typeof fixture>,
  operationId: string,
  wrote: PlayerModelId,
  backup = false,
  voice = true,
) => {
  f.store.run(
    'UPDATE web_operation_models SET draft_provider=?,draft_model=?,review_provider=?,review_model=?,backup=? WHERE operation_id=?',
    wrote,
    `${wrote}-model`,
    'deepseek',
    'deepseek-v4-pro',
    backup ? 1 : 0,
    operationId,
  );
  f.finish(operationId, 'published');
  if (voice) f.voiced(operationId);
};
const billing = (f: ReturnType<typeof fixture>, principalId = f.principalId, page: unknown = 1, tz = 0) =>
  playerBilling(f.store, f.clock(), principalId, { page, tzOffsetMinutes: tz });

test('消费记录: newest first; a backup reply names the model that wrote it and its NET points; a failed reply shows the refund', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  const r1 = f.admit(f.principalId, 'r1'); // Gemini asked, DeepSeek wrote it (voiced): 22 charged, 10 come back
  publish(f, r1.operationId, 'deepseek', true, true);
  f.advance(60_000);
  setPlayerModel(f.store, f.clock(), f.principalId, 'xai');
  const r2 = f.admit(f.principalId, 'r2'); // Grok wrote it, no voice (fell back to text): 27 - 2
  publish(f, r2.operationId, 'xai', false, false);
  f.advance(60_000);
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  const r3 = f.admit(f.principalId, 'r3'); // failed: the whole charge comes back
  f.finish(r3.operationId, 'failed');
  f.advance(60_000);
  setPlayerModel(f.store, f.clock(), f.principalId, 'deepseek');
  f.admit(f.principalId, 'r4'); // still being written

  const page = billing(f);
  assert.equal(page.metered, true);
  assert.equal(page.balance, 100 - 12 - 25 - 12, 'r1 12, r2 25, r3 refunded, r4 pending 12');
  assert.equal(page.balance, f.sum(f.principalId), 'the shown balance is the sum of the events');
  // Part 21i (named exception): the two trial replies made before signing up are listed too (免费试用, 0 points); the
  // assertions below are about the points rows and are unchanged.
  assert.deepEqual(
    page.items.filter((i) => i.kind === 'trial').map((i) => [(i as any).model, (i as any).characterId]),
    [
      ['deepseek', characterId],
      ['deepseek', characterId],
    ],
  );
  const rows = page.items.filter((i) => i.kind !== 'trial');
  assert.deepEqual(
    rows.map((i) => i.kind),
    ['pending', 'failed', 'reply', 'reply', 'bonus'],
    'newest first',
  );
  const [pending, failed, second, first, bonus] = rows as [any, any, any, any, any];
  assert.deepEqual([pending.model, pending.points, pending.free], ['deepseek', 12, false]);
  assert.deepEqual([failed.refunded, failed.free], [22, false], 'the failed reply shows what was refunded');
  assert.deepEqual(
    [second.model, second.backupFor, second.voice, second.points],
    ['xai', undefined, false, 25],
    'no-voice refund is netted',
  );
  assert.deepEqual(
    [first.model, first.backupFor, first.voice, first.points, first.characterId],
    ['deepseek', 'gemini', true, 12, characterId],
    'DeepSeek wrote it for a Gemini player: 12 net, not 22',
  );
  assert.deepEqual([bonus.kind, bonus.points], ['bonus', 100]);
  assert.ok(first.at < second.at && second.at < failed.at && failed.at < pending.at);
  // This month, by the model that wrote the reply and by character: only published replies.
  assert.deepEqual(page.month.byModel, [
    { model: 'xai', points: 25, replies: 1 },
    { model: 'deepseek', points: 12, replies: 1 },
  ]);
  assert.deepEqual(page.month.byCharacter, [{ characterId, points: 37, replies: 2 }]);
  // The wire form parses, and carries no id of any kind.
  const wire = JSON.parse(JSON.stringify(page));
  assert.deepEqual(parseBillingPage(wire), page);
  assert.doesNotMatch(JSON.stringify(page), /principal|player-|world-|id-\d+|old-|operation/);
  assert.equal(parseBillingPage({ ...wire, items: [{ kind: 'reply', at: 1 }] }), undefined);
});

test("消费记录 is scoped to the session's own principal: player A never sees player B", (t) => {
  const f = fixture(t);
  const other = f.guest('b');
  store_trial(f, other);
  setPlayerModel(f.store, f.clock(), other, 'xai');
  const b1 = f.admit(other, 'b1');
  publish(f, b1.operationId, 'xai');
  f.advance(1000);
  const a1 = f.admit(f.principalId, 'a1');
  publish(f, a1.operationId, 'deepseek');
  const a = billing(f);
  const b = billing(f, other);
  // Part 21i (named exception): each player's own two trial rows are listed too; the points rows are unchanged.
  assert.deepEqual(
    a.items.filter((i) => i.kind !== 'trial').map((i) => i.kind),
    ['reply', 'bonus'],
  );
  assert.equal(a.items.filter((i) => i.kind === 'trial').length, 2);
  assert.equal(b.items.filter((i) => i.kind === 'trial').length, 2, "B's own trial rows, never A's");
  const firstReply = (page: typeof a) => page.items.find((i) => i.kind === 'reply') as any;
  assert.equal(firstReply(a).model, 'deepseek');
  assert.equal(firstReply(b).model, 'xai');
  assert.equal(a.balance, 100 - 12);
  assert.equal(b.balance, 100 - 27 + 0);
  assert.equal(a.month.byModel.length, 1);
  assert.equal(b.month.byModel[0]!.model, 'xai');
  // The transport takes the principal from the session, never from the body.
  const billingService = new WebBilling(
    f.store,
    { now: f.clock },
    {
      authorizeWrite: (token) => ({ principalId: token === 'tok-a' ? f.principalId : other }),
    },
  );
  const route = (token: string, body: unknown = {}) =>
    routeWebBilling(billingService, {
      method: 'POST',
      path: '/api/web/local/billing/history',
      origin: 'https://fixture.invalid',
      csrf: 'c',
      playerToken: token,
      body,
    })!;
  assert.equal(firstReply(route('tok-a').body as typeof a).model, 'deepseek');
  assert.equal(firstReply(route('tok-b').body as typeof a).model, 'xai');
  assert.throws(() => route('tok-a', { principalId: other }), /INVALID_REQUEST/, 'no client-supplied scope');
  assert.throws(() => route('tok-a', { page: 0 }), /INVALID_REQUEST/);
  assert.throws(() => route('tok-a', { page: 1.5 }), /INVALID_REQUEST/);
  assert.throws(() => route('tok-a', { tzOffsetMinutes: 99999 }), /INVALID_REQUEST/);
  assert.throws(() => route('', {}), /AUTH_REQUIRED/);
  assert.equal(route('tok-a', {}).status, 200);
});
/** The second player of a scoping test: trial used up, so its balance starts at 100 like the first. */
function store_trial(f: ReturnType<typeof fixture>, principalId: string) {
  f.store.run('UPDATE web_principals SET trial_used=3 WHERE id=?', principalId);
  f.history(principalId, 'published', 'trial_extra', 201);
  f.history(principalId, 'published', 'trial_extra', 202);
}

// Part 21i (named exception): a guest on the trial now gets its own trial rows instead of 404 (see the tests after this one);
// a deployment without the feature still answers 404, and the invited player's page is unchanged.
test('消费记录: a deployment without the feature gets 404; an invited player sees 不计点 rows', (t) => {
  const off = fixture(t, { flag: false });
  assert.throws(() => billing(off), /NOT_FOUND/);
  const guest = fixture(t, { bonus: false });
  assert.equal(billing(guest).metered, false, 'a guest is no longer a 404');

  const f = fixture(t);
  upTo126(f.store);
  grantUnlimited(f.store as never, f.principalId, 'entitlement', f.clock());
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  const op = f.admit(f.principalId, 'i1');
  publish(f, op.operationId, 'deepseek', true, true);
  const page = billing(f);
  // Named exception (Part 22x): an entitled player is a signed-up player (metered page with its balance, never charged),
  // unlike the legacy invite principal whose page was unmetered; the rows are still free (不计点).
  assert.deepEqual([page.metered, page.balance], [true, 100]);
  assert.deepEqual(page.month, { byModel: [], byCharacter: [] });
  // The signed-up fixture also lists its earlier trial replies; the reply made under the entitlement is the one checked.
  const replies = page.items.filter((item) => item.kind === 'reply');
  assert.equal(replies.length, 1);
  const reply = replies[0] as any;
  assert.deepEqual(
    [reply.kind, reply.free, reply.points, reply.model, reply.backupFor],
    ['reply', true, 0, 'deepseek', 'gemini'],
  );
  // Named exception (Part 22x): an entitled player is registered and has an account; what must hold is that it was never charged.
  assert.equal(f.balance(f.principalId), 100);
  assert.equal(f.events(f.principalId).filter((e) => e.source === 'spend').length, 0);
});

test('消费记录 pages by 50, newest first, only the last 90 days', (t) => {
  const f = fixture(t);
  f.state(f.principalId);
  f.store.run("UPDATE web_points_policy SET kind='unlimited' WHERE principal_id=?", f.principalId);
  const ops: string[] = [];
  const old = f.admit(f.principalId, 'old');
  publish(f, old.operationId, 'deepseek');
  f.advance(91 * DAY);
  for (let n = 0; n < 120; n++) {
    f.advance(1000);
    const op = f.admit(f.principalId, `n${n}`);
    publish(f, op.operationId, 'deepseek', false, false);
    ops.push(op.operationId);
  }
  const first = billing(f, f.principalId, 1);
  const second = billing(f, f.principalId, 2);
  const third = billing(f, f.principalId, 3);
  assert.deepEqual(
    [first.items.length, second.items.length, third.items.length],
    [BILLING_PAGE_SIZE, BILLING_PAGE_SIZE, 20],
  );
  assert.deepEqual([first.hasMore, second.hasMore, third.hasMore], [true, true, false]);
  const times = [...first.items, ...second.items, ...third.items].map((i) => i.at);
  assert.deepEqual(
    times,
    [...times].sort((x, y) => y - x),
    'newest first across pages',
  );
  assert.equal(new Set(times).size, 120, 'no row twice, none missing; the 91-day-old reply and the old bonus are gone');
  assert.equal(billing(f, f.principalId, 4).items.length, 0);
  assert.throws(() => billing(f, f.principalId, 0), /INVALID_REQUEST/);
  assert.throws(() => billing(f, f.principalId, 1001), /INVALID_REQUEST/);
  assert.throws(() => billing(f, f.principalId, '2'), /INVALID_REQUEST/);
});

test("消费记录: grants and refills are listed; the month boundary follows the player's clock", (t) => {
  const f = fixture(t);
  f.state(f.principalId);
  f.store.run(
    "INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at) VALUES (?,NULL,'grant',NULL,50,'admin-1',2,?)",
    f.principalId,
    f.clock(),
  );
  const page = billing(f);
  // Part 21i (named exception): the fixture's two trial replies are listed too; the points rows are unchanged.
  assert.deepEqual(
    page.items
      .filter((i) => i.kind !== 'trial')
      .map((i) => [i.kind, (i as any).points])
      .sort(),
    [
      ['bonus', 100],
      ['grant', 50],
    ],
  );
  assert.doesNotMatch(JSON.stringify(page), /admin/, 'the acting administrator is never shown');
  // A reply made at 23:30 UTC on the last day of the month is already next month for a player at UTC+8.
  const g = fixture(t);
  const end = Date.UTC(2026, 9, 31, 23, 30);
  g.advance(end - g.clock());
  const op = g.admit(g.principalId, 'late');
  publish(g, op.operationId, 'deepseek');
  g.advance(60_000);
  assert.equal(billing(g, g.principalId, 1, 0).month.byModel.length, 1);
  g.advance(DAY * 40);
  const a = billing(g, g.principalId, 1, 0);
  assert.equal(a.month.byModel.length, 0, 'a later month starts empty');
});

test('消费记录 after account deletion: the points data is gone and the page has nothing to show or to open', (t) => {
  const f = fixture(t);
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  const op = f.admit(f.principalId, 'a');
  publish(f, op.operationId, 'deepseek', true, true);
  assert.equal(billing(f).items.length > 1, true);
  purgePlayerLogins(f.store, { principalId: f.principalId, worldId: 'world-a' });
  assert.equal(f.store.get('SELECT 1 FROM web_points_balance'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_points_events'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_player_model'), undefined);
  // Part 21i (named exception): no signup entitlement and no points account any more, so the page is a guest's (no balance, no
  // points rows) instead of a 404; reading it never recreates a balance.
  const after = billing(f);
  assert.deepEqual([after.metered, after.balance, after.quota], [false, null, null]);
  assert.equal(after.items.filter((i) => i.kind === 'bonus' || i.kind === 'grant').length, 0);
  assert.equal(f.store.get('SELECT 1 FROM web_points_balance'), undefined, 'reading after deletion creates nothing');
  assert.equal(playerLoginsRemain(f.store, [f.principalId]), false);
});

// ---- Part 21i: free quota summary and the guest trial ---------------------------------------------------------------------

test('Part 21i 消费记录 (signed up): the summary is total granted, used and left; trial replies are listed as 免费试用 with 0 points', (t) => {
  const f = fixture(t, { trialSpent: 3 }); // 3 trial replies before signing up: 2 unused are worth 20 points
  setPlayerModel(f.store, f.clock(), f.principalId, 'gemini');
  const r1 = f.admit(f.principalId, 'r1'); // 22
  publish(f, r1.operationId, 'deepseek', true, true); // backup: 10 comes back
  f.advance(1000);
  setPlayerModel(f.store, f.clock(), f.principalId, 'xai');
  const r2 = f.admit(f.principalId, 'r2'); // 27
  f.finish(r2.operationId, 'failed'); // all back
  f.advance(1000);
  f.store.run(
    "INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at) VALUES (?,NULL,'grant',NULL,50,'admin-1',2,?)",
    f.principalId,
    f.clock(),
  );
  f.store.run('UPDATE web_points_balance SET balance=balance+50 WHERE principal_id=?', f.principalId);
  f.advance(1000);
  setPlayerModel(f.store, f.clock(), f.principalId, 'deepseek');
  f.admit(f.principalId, 'r3'); // pending: 12
  const page = billing(f);
  assert.equal(page.trial, null);
  const start = f.events(f.principalId).find((e) => e.source === 'bonus')!.delta;
  assert.deepEqual(
    page.quota,
    { total: start + 50, used: 12 + 12 },
    'bonus + grant; r1 net 12, r2 refunded, r3 pending 12',
  );
  assert.equal(page.balance, page.quota!.total - page.quota!.used, 'balance = total - used');
  assert.equal(page.balance, f.sum(f.principalId));
  const trial = page.items.filter((i) => i.kind === 'trial');
  assert.equal(trial.length, 0, 'trialSpent 3 are counter replies with no operation rows in this fixture');
  assert.equal(parseBillingPage(JSON.parse(JSON.stringify(page)))?.quota?.total, start + 50);
});

test('Part 21i 消费记录 (guest): only its own trial rows, no balance, used n of the trial; another principal never shows', (t) => {
  const f = fixture(t, { bonus: false, trialSpent: 5 });
  const other = f.guest('b', false);
  f.history(other, 'published', 'trial_extra', 301);
  f.history(other, 'published', 'trial_extra', 302);
  f.history(other, 'published', 'trial_extra', 303);
  const page = billing(f);
  assert.deepEqual([page.metered, page.balance, page.quota], [false, null, null]);
  assert.deepEqual(
    page.trial,
    { used: 2, limit: 5 },
    "this guest's trial_extra replies only (the other 3 are counter replies)",
  );
  assert.deepEqual(
    page.items.map((i) => [i.kind, (i as any).model, (i as any).characterId]),
    [
      ['trial', 'deepseek', characterId],
      ['trial', 'deepseek', characterId],
    ],
  );
  assert.deepEqual(page.month, { byModel: [], byCharacter: [] });
  const theirs = billing(f, other);
  assert.equal(theirs.items.length, 3);
  assert.deepEqual(theirs.trial, { used: 3, limit: 5 });
  assert.doesNotMatch(JSON.stringify(page), /principal|player-|world-|id-\d+|old-|operation/);
  // A released (failed) trial reply is not a used one and is not listed.
  f.finish(`old-103-${f.principalId}`, 'failed');
  assert.deepEqual(billing(f).trial, { used: 1, limit: 5 });
  assert.equal(billing(f).items.length, 1);
  // The route takes the principal from the session only, with the same CSRF/Origin checks as any player read.
  const service = new WebBilling(
    f.store,
    { now: f.clock },
    {
      authorizeWrite: (token, csrf) => {
        if (csrf !== 'c') throw new DomainError('CSRF_INVALID');
        return { principalId: token === 'tok-a' ? f.principalId : other };
      },
    },
  );
  const route = (token: string, csrf = 'c') =>
    routeWebBilling(service, {
      method: 'POST',
      path: '/api/web/local/billing/history',
      origin: 'https://fixture.invalid',
      csrf,
      playerToken: token,
      body: {},
    })!;
  assert.equal((route('tok-a').body as any).trial.used, 1);
  assert.equal((route('tok-b').body as any).trial.used, 3);
  assert.throws(() => route('tok-a', 'bad'), /CSRF_INVALID/);
});
