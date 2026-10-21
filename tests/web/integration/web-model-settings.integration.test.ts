import assert from 'node:assert/strict';
import test from 'node:test';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import {
  canChooseModel,
  isUnmetered,
  effectiveModel,
  modelChoiceState,
  offeredModels,
  reconcilePoints,
  setPlayerModel,
} from '../../../apps/server/admission/web-points.ts';
import {
  currentPrices,
  probeModelKeys,
  playerTier,
  pricesAt,
  tierModels,
} from '../../../apps/server/admission/web-model-settings.ts';
import { textRouteFor } from '../../../apps/server/generation/web-text-routing.ts';
import { DEFAULT_MODEL_SETTINGS, MODEL_TIERS, parseModelSave } from '../../../packages/contracts/model-settings.ts';
import { hasModelsPermission, isAdminPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { POINTS } from '../../../packages/contracts/player-models.ts';
import { billedModelAt } from '../../../apps/server/admission/web-model-settings.ts';
import { providerHistoryMessage } from '../../../apps/server/generation/web-provider-application.ts';
import { modelSettingsFixture, origin, schema124 } from '../fixtures/model-settings.ts';

const code = (error: unknown) => (error as { code?: string }).code;
const rejects = (work: () => unknown, expected: string) =>
  assert.throws(work, (error: unknown) => code(error) === expected, expected);

// ---- defaults = today's behaviour -------------------------------------------------------------------------------------------

test('migration 124 writes exactly today’s behaviour: all three on, guests DeepSeek only, 10/20/25 and voice 2', (t) => {
  const f = modelSettingsFixture(t);
  assert.deepEqual(f.rows(), [...DEFAULT_MODEL_SETTINGS.models]);
  assert.deepEqual(
    f.rows().map((row) => [row.model, row.enabled, row.guest, row.registered, row.invited, row.points]),
    [
      ['deepseek', true, true, true, true, 10],
      ['gemini', true, false, true, true, 20],
      // Grok 25: Part 21f moves the POINTS constant to 25 as well; the migration default is the agreed number.
      ['xai', true, false, true, true, 25],
    ],
  );
  assert.equal(currentPrices(f.store).voice, 2);
  assert.equal(currentPrices(f.store).voice, POINTS.voice);
  assert.equal(currentPrices(f.store).perReply.deepseek, POINTS.perReply.deepseek);
  assert.equal(currentPrices(f.store).perReply.gemini, POINTS.perReply.gemini);
  assert.equal(
    currentPrices(f.store).version,
    2,
    'version 1 is the table Part 21b shipped (Grok 40); 2 is the defaults',
  );
  assert.deepEqual(pricesAt(f.store, 1)!.perReply, { deepseek: 10, gemini: 20, xai: 40 });
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_model_changes')!.n, 0);

  const guest = f.guest('g'),
    registered = f.guest('r', 'registered'),
    invited = f.guest('i', 'invited');
  assert.deepEqual(
    MODEL_TIERS.map((tier) => [tier, tierModels(f.store, tier)]),
    [
      ['guest', ['deepseek']],
      ['registered', ['deepseek', 'gemini', 'xai']],
      ['invited', ['deepseek', 'gemini', 'xai']],
    ],
  );
  assert.deepEqual(
    [guest, registered, invited].map((id) => playerTier(f.store, id)),
    ['guest', 'registered', 'invited'],
  );
  // A guest has no picker (one model), the others do - as before the table existed.
  assert.equal(canChooseModel(f.store, guest), false);
  assert.equal(modelChoiceState(f.store, f.clock(), guest), null);
  assert.deepEqual(
    modelChoiceState(f.store, f.clock(), registered)!.models.map((m) => [m.id, m.points, m.voicePoints]),
    [
      ['deepseek', 10, 2],
      ['gemini', 20, 2],
      ['xai', 25, 2],
    ],
  );
  const invitedState = modelChoiceState(f.store, f.clock(), invited)!;
  // Named exception (Part 22x): the invited tier is an unlimited entitlement on a signed-up player (the legacy invite kind is
  // gone). Such a player is never charged; the page still shows its (registered) balance, so "unmetered" replaces "metered:false".
  assert.equal(isUnmetered(f.store, invited, f.clock()), true);
  assert.deepEqual(
    invitedState.models.map((m) => m.id),
    ['deepseek', 'gemini', 'xai'],
  );
});

test('PLAYER_MODEL_CHOICE_ENABLED stays the master flag: with it off nothing is offered whatever the table says', (t) => {
  const f = modelSettingsFixture(t);
  const registered = f.guest('r', 'registered');
  Object.assign(f.store, { playerModelChoice: undefined });
  assert.equal(offeredModels(f.store), null);
  assert.equal(canChooseModel(f.store, registered), false);
  assert.equal(modelChoiceState(f.store, f.clock(), registered), null);
  assert.equal(f.read(f.owner).featureOn, false);
});

// ---- global off, per tier, last model -----------------------------------------------------------------------------------------

test('a model switched off globally is hidden everywhere: every picker, setPlayerModel, the offered list and the backup chain', (t) => {
  const f = modelSettingsFixture(t);
  const registered = f.guest('r', 'registered'),
    invited = f.guest('i', 'invited');
  f.save(f.owner, f.draft({ gemini: { enabled: false } }));
  for (const tier of MODEL_TIERS) assert.equal(tierModels(f.store, tier).includes('gemini'), false, tier);
  assert.deepEqual(offeredModels(f.store), ['deepseek', 'xai']);
  for (const id of [registered, invited]) {
    assert.deepEqual(
      modelChoiceState(f.store, f.clock(), id)!.models.map((m) => m.id),
      ['deepseek', 'xai'],
    );
    rejects(() => setPlayerModel(f.store, f.clock(), id, 'gemini'), 'MODEL_NOT_AVAILABLE');
  }
  assert.equal(f.read(f.owner).models.find((m) => m.model === 'gemini')!.enabled, false);
  // Back on: it returns to every tier that allows it.
  f.save(f.owner, f.draft({ gemini: { enabled: true } }));
  assert.deepEqual(tierModels(f.store, 'registered'), ['deepseek', 'gemini', 'xai']);
});

test('per-tier allow and deny: allowing a model for guests gives them a picker; denying it for one tier leaves the others alone', (t) => {
  const f = modelSettingsFixture(t);
  const guest = f.guest('g'),
    registered = f.guest('r', 'registered'),
    invited = f.guest('i', 'invited');
  f.save(f.owner, f.draft({ gemini: { guest: true }, xai: { invited: false } }));
  assert.deepEqual(tierModels(f.store, 'guest'), ['deepseek', 'gemini']);
  assert.deepEqual(tierModels(f.store, 'registered'), ['deepseek', 'gemini', 'xai']);
  assert.deepEqual(tierModels(f.store, 'invited'), ['deepseek', 'gemini']);
  assert.equal(
    canChooseModel(f.store, guest),
    true,
    'a guest sees the picker once its tier allows more than one model',
  );
  const guestState = modelChoiceState(f.store, f.clock(), guest)!;
  assert.equal(guestState.metered, false, 'a guest reply costs a trial reply, never points');
  assert.deepEqual(
    guestState.models.map((m) => m.id),
    ['deepseek', 'gemini'],
  );
  rejects(() => setPlayerModel(f.store, f.clock(), guest, 'xai'), 'MODEL_NOT_AVAILABLE');
  rejects(() => setPlayerModel(f.store, f.clock(), invited, 'xai'), 'MODEL_NOT_AVAILABLE');
  setPlayerModel(f.store, f.clock(), registered, 'xai');
  assert.equal(effectiveModel(f.store, f.clock(), registered), 'xai');
});

test('a guest may use a chosen model and it still costs exactly one trial reply; nothing is charged in points', (t) => {
  const f = modelSettingsFixture(t);
  const guest = f.guest('g');
  f.save(f.owner, f.draft({ gemini: { guest: true } }));
  setPlayerModel(f.store, f.clock(), guest, 'gemini');
  const op = f.admit(guest, 'g1');
  const frozen = f.store.get<{ chosen: string; points_charged: number; price_version: number }>(
    'SELECT chosen,points_charged,price_version FROM web_operation_models WHERE operation_id=?',
    op.operationId,
  )!;
  assert.deepEqual([frozen.chosen, frozen.points_charged], ['gemini', 0]);
  const row = f.store.get<{ trial_reserved: number; trial_used: number }>(
    'SELECT trial_reserved,trial_used FROM web_principals WHERE id=?',
    guest,
  )!;
  assert.equal(row.trial_reserved + row.trial_used, 1, 'one trial reply, whatever the model');
  assert.equal(f.store.get('SELECT 1 FROM web_points_events'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_points_balance'), undefined);
  // A DeepSeek-only guest (the default) keeps no model row at all: exactly today's behaviour.
  const plain = f.guest('plain');
  f.save(f.owner, f.draft({ gemini: { guest: false } }));
  const plainOp = f.admit(plain, 'p1', 'b');
  assert.equal(f.store.get('SELECT 1 FROM web_operation_models WHERE operation_id=?', plainOp.operationId), undefined);
});

test('every tier keeps at least one allowed + enabled model: a save that empties a tier is refused and writes nothing', (t) => {
  const f = modelSettingsFixture(t);
  const before = f.rows();
  const revision = f.read(f.owner).revision;
  // The guest tier only has DeepSeek: turning it off for guests, or off globally, would leave it empty.
  rejects(() => f.save(f.owner, f.draft({ deepseek: { guest: false } })), 'MODEL_TIER_EMPTY');
  rejects(() => f.save(f.owner, f.draft({ deepseek: { enabled: false } })), 'MODEL_TIER_EMPTY');
  rejects(
    () =>
      f.save(
        f.owner,
        f.draft({
          gemini: { enabled: false, registered: true },
          deepseek: { registered: false },
          xai: { registered: false },
        }),
      ),
    'MODEL_TIER_EMPTY',
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(f.read(f.owner).revision, revision);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_model_changes')!.n, 0);
  // Moving the guest tier to another model first makes DeepSeek removable.
  f.save(f.owner, f.draft({ gemini: { guest: true }, deepseek: { guest: false } }));
  assert.deepEqual(tierModels(f.store, 'guest'), ['gemini']);
  rejects(() => f.save(f.owner, f.draft({ gemini: { guest: false } })), 'MODEL_TIER_EMPTY');
});

test('DeepSeek stays the internal backup and the house reviewer even when hidden from every tier', (t) => {
  const f = modelSettingsFixture(t);
  const registered = f.guest('r', 'registered');
  f.save(f.owner, f.draft({ deepseek: { enabled: false, guest: false }, gemini: { guest: true } }));
  for (const tier of MODEL_TIERS) assert.equal(tierModels(f.store, tier).includes('deepseek'), false, tier);
  // The player lands on the tier's first allowed model...
  assert.equal(effectiveModel(f.store, f.clock(), registered), 'gemini');
  // ...and the route still ends in DeepSeek (backup) and reviews with it, whatever the table says about visibility.
  const op = f.admit(registered, 'r1');
  const route = textRouteFor(f.store, op.operationId, f.clock(), () => [])!;
  assert.equal(route.draft.at(-1)!.provider, 'deepseek');
  assert.deepEqual(
    route.review.map((ref) => ref.provider),
    ['deepseek'],
  );
});

// ---- the environment ceiling ------------------------------------------------------------------------------------------------

test('the ceiling wins: PLAYER_TEXT_MODELS and the API key decide, whatever the table says; the page shows 未配置', (t) => {
  const f = modelSettingsFixture(t, { models: ['deepseek', 'gemini'] });
  const registered = f.guest('r', 'registered');
  // The table allows xai for everybody, the environment does not list it.
  assert.equal(f.rows().find((row) => row.model === 'xai')!.registered, true);
  assert.deepEqual(tierModels(f.store, 'registered'), ['deepseek', 'gemini']);
  rejects(() => setPlayerModel(f.store, f.clock(), registered, 'xai'), 'MODEL_NOT_AVAILABLE');
  let view = f.read(f.owner);
  assert.deepEqual(
    view.models.map((m) => [m.model, m.configured]),
    [
      ['deepseek', true],
      ['gemini', true],
      ['xai', false],
    ],
  );
  // Listed but without its key: also never offered.
  Object.assign(f.store, {
    playerModelChoice: ['deepseek', 'gemini', 'xai'],
    playerModelKeys: { gemini: false, xai: true },
  });
  assert.deepEqual(tierModels(f.store, 'registered'), ['deepseek', 'xai']);
  view = f.read(f.owner);
  assert.deepEqual(
    view.models.map((m) => [m.model, m.configured]),
    [
      ['deepseek', true],
      ['gemini', false],
      ['xai', true],
    ],
  );
  // Not-checked keys (local runs) leave the PLAYER_TEXT_MODELS list as the ceiling.
  Object.assign(f.store, { playerModelKeys: undefined });
  assert.deepEqual(tierModels(f.store, 'registered'), ['deepseek', 'gemini', 'xai']);
  // DeepSeek is the house model: inside the ceiling whatever the list says.
  Object.assign(f.store, { playerModelChoice: ['gemini'] });
  assert.equal(tierModels(f.store, 'registered').includes('deepseek'), true);
  // A missing ceiling does not stop the owner saving: the tier rule is judged by the table.
  f.save(f.owner, f.draft({ xai: { enabled: false } }));
});

// ---- prices -----------------------------------------------------------------------------------------------------------------

test('a price change applies to the next admission only: the frozen operation keeps its model, price and version; refunds use the frozen table', (t) => {
  const f = modelSettingsFixture(t);
  const player = f.guest('r', 'registered');
  setPlayerModel(f.store, f.clock(), player, 'gemini');
  const first = f.admit(player, 'm1');
  const frozen = () =>
    f.store.get<{ chosen: string; points_charged: number; price_version: number }>(
      'SELECT chosen,points_charged,price_version FROM web_operation_models WHERE operation_id=?',
      first.operationId,
    )!;
  assert.deepEqual({ ...frozen() }, { chosen: 'gemini', points_charged: 22, price_version: 2 });
  // Part 21f's opening balance: 100 + 10 x 5 unused trial replies = 150, then this reply's 22.
  assert.equal(f.store.get<{ balance: number }>('SELECT balance FROM web_points_balance')!.balance, 128);

  // The owner makes Gemini dearer (and voice dearer): a new price version, nothing existing is re-priced.
  const result = f.save(f.owner, f.draft({ gemini: { points: 30 } }, 5));
  assert.equal(result.priceVersion, 3);
  assert.deepEqual({ ...frozen() }, { chosen: 'gemini', points_charged: 22, price_version: 2 });
  // The picker shows the new numbers at once...
  const state = modelChoiceState(f.store, f.clock(), player)!;
  assert.deepEqual(
    state.models.find((m) => m.id === 'gemini'),
    { id: 'gemini', points: 30, voicePoints: 5 },
  );
  assert.equal(state.version, 3);
  // ...and the next message pays them, recorded in the points events with the new version.
  const second = f.admit(player, 'm2', 'b');
  assert.equal(
    f.store.get<{ points_charged: number; price_version: number }>(
      'SELECT points_charged,price_version FROM web_operation_models WHERE operation_id=?',
      second.operationId,
    )!.points_charged,
    35,
  );
  assert.deepEqual(
    f.store
      .all<{ delta: number; price_version: number; source: string }>(
        "SELECT delta,price_version,source FROM web_points_events WHERE source='spend' ORDER BY id",
      )
      .map((row) => ({ ...row })),
    [
      { delta: -22, price_version: 2, source: 'spend' },
      { delta: -35, price_version: 3, source: 'spend' },
    ],
  );
  // The first message ends without a reply: it is refunded what it paid (22), not what the table says now (35).
  f.finish(first.operationId, 'failed');
  reconcilePoints(f.store, f.clock(), player);
  assert.deepEqual(
    f.store
      .all<{ delta: number; price_version: number; reason: string }>(
        "SELECT delta,price_version,reason FROM web_points_events WHERE source='refund'",
      )
      .map((row) => ({ ...row })),
    [{ delta: 22, price_version: 2, reason: 'no_reply' }],
  );
  // A published reply without voice gets the FROZEN voice price back (2 at version 3's admission would be 5).
  f.finish(second.operationId, 'published');
  reconcilePoints(f.store, f.clock(), player);
  const voiceRefund = f.store.get<{ delta: number; price_version: number }>(
    "SELECT delta,price_version FROM web_points_events WHERE reason='no_voice'",
  )!;
  assert.deepEqual(
    { ...voiceRefund },
    { delta: 5, price_version: 3 },
    'the voice price of the table it was admitted under (v3: 5)',
  );
  assert.deepEqual(pricesAt(f.store, 2)!.voice, 2);
  assert.deepEqual(pricesAt(f.store, 3)!.perReply.gemini, 30);
});

test('prices are integers: 1-200 per reply and 0-20 for voice; a save with other numbers is refused', (t) => {
  const f = modelSettingsFixture(t);
  const good = f.draft({ gemini: { points: 200 } }, 0);
  assert.ok(parseModelSave(good));
  for (const bad of [
    f.draft({ gemini: { points: 0 } }),
    f.draft({ gemini: { points: 201 } }),
    f.draft({ gemini: { points: 1.5 } }),
    f.draft({}, 21),
    f.draft({}, -1),
    f.draft({}, 0.5),
  ])
    assert.equal(parseModelSave(bad), undefined, JSON.stringify(bad.voicePoints));
  rejects(() => f.save(f.owner, f.draft({ gemini: { points: 201 } })), 'INVALID_REQUEST');
  // The database enforces the same bounds.
  assert.throws(() => f.store.run("UPDATE web_model_settings SET points_per_reply=0 WHERE model='gemini'"));
  assert.throws(() => f.store.run('UPDATE web_model_voice SET voice_points=21'));
  f.save(f.owner, good);
  assert.equal(currentPrices(f.store).perReply.gemini, 200);
  assert.equal(currentPrices(f.store).voice, 0);
});

// ---- withdrawn --------------------------------------------------------------------------------------------------------------

test('a withdrawn model moves the player to the tier’s first allowed model on their next message, with the one-time notice', (t) => {
  const f = modelSettingsFixture(t);
  const registered = f.guest('r', 'registered'),
    invited = f.guest('i', 'invited');
  setPlayerModel(f.store, f.clock(), registered, 'xai');
  setPlayerModel(f.store, f.clock(), invited, 'xai');
  const admitted = f.admit(registered, 'before'); // frozen with xai
  assert.equal(
    f.store.get<{ chosen: string }>(
      'SELECT chosen FROM web_operation_models WHERE operation_id=?',
      admitted.operationId,
    )!.chosen,
    'xai',
  );
  // Off for the registered tier only.
  f.save(f.owner, f.draft({ xai: { registered: false } }));
  assert.equal(effectiveModel(f.store, f.clock(), invited), 'xai', 'the other tier is unaffected');
  const next = f.admit(registered, 'after', 'b');
  assert.equal(
    f.store.get<{ chosen: string }>('SELECT chosen FROM web_operation_models WHERE operation_id=?', next.operationId)
      ?.chosen ?? 'deepseek',
    'deepseek',
  );
  const state = modelChoiceState(f.store, f.clock(), registered)!;
  assert.equal(state.selected, 'deepseek');
  assert.equal(state.notice, 'model_withdrawn');
  assert.equal(modelChoiceState(f.store, f.clock(), registered)!.notice, undefined, 'shown once');
  // The message admitted before keeps its frozen model and price.
  assert.deepEqual(
    {
      ...f.store.get<{ chosen: string; points_charged: number; price_version: number }>(
        'SELECT chosen,points_charged,price_version FROM web_operation_models WHERE operation_id=?',
        admitted.operationId,
      )!,
    },
    { chosen: 'xai', points_charged: 27, price_version: 2 },
  );
  // Globally off: everyone who had it moves, to their own tier's first model.
  f.save(f.owner, f.draft({ xai: { registered: true } }));
  setPlayerModel(f.store, f.clock(), registered, 'xai');
  f.save(f.owner, f.draft({ xai: { enabled: false } }));
  assert.equal(effectiveModel(f.store, f.clock(), invited), 'deepseek');
  assert.equal(effectiveModel(f.store, f.clock(), registered), 'deepseek');
});

test('a message already admitted keeps its frozen model even after the owner switches it off; the environment ceiling still bounds it', (t) => {
  const f = modelSettingsFixture(t);
  const registered = f.guest('r', 'registered');
  for (const provider of ['gemini', 'xai']) {
    f.store.run("INSERT INTO web_provider_spending VALUES (?,'USD',1000000,0,0)", provider);
    for (const [phase, model] of [
      ['draft', provider === 'xai' ? 'grok-4.7' : 'gemini-3.8-flash'],
      ['review', provider === 'xai' ? 'grok-4.7' : 'gemini-3.8-flash'],
    ] as const) {
      f.store.run(
        "INSERT INTO web_provider_prices VALUES (?,?,?,?,'USD','token',10,0,9000000000000,1)",
        `price-${provider}-${phase}`,
        provider,
        model,
        phase,
      );
      f.store.run(
        "INSERT INTO web_external_budgets(provider,stage,phase,capacity) VALUES (?,'text',?,10)",
        provider,
        phase,
      );
    }
  }
  setPlayerModel(f.store, f.clock(), registered, 'xai');
  const op = f.admit(registered, 'x1');
  f.save(f.owner, f.draft({ xai: { enabled: false } }));
  const route = textRouteFor(f.store, op.operationId, f.clock(), () => [])!;
  assert.equal(route.draft[0]!.provider, 'xai', 'admitted with xai: still written by xai');
  Object.assign(f.store, { playerModelChoice: ['deepseek', 'gemini'] });
  const bounded = textRouteFor(f.store, op.operationId, f.clock(), () => [])!;
  assert.equal(bounded.draft[0]!.provider !== 'xai', true, 'outside the ceiling it falls back to the house model');
});

// ---- the admin side ---------------------------------------------------------------------------------------------------------

test('permissions: owner saves; models.manage saves; any other administrator only reads; no session reads nothing', (t) => {
  const f = modelSettingsFixture(t);
  const managed = f.member(['models.manage'], 'Manager'),
    reader = f.member(['invites.read'], 'Reader'),
    nobody = f.member([], 'Nobody');
  assert.equal(isAdminPermission('models.manage'), true);
  assert.equal(hasModelsPermission(['models.manage']), true);
  assert.equal(hasModelsPermission(['category.invites']), false);

  assert.equal(f.read(f.owner).canManage, true);
  assert.equal(f.read(managed).canManage, true);
  assert.equal(f.read(reader).canManage, false, 'read access for any administrator');
  assert.equal(f.read(nobody).canManage, false, 'even one with no permission at all');

  f.save(f.owner, f.draft({ gemini: { points: 21 } }));
  f.save(managed, f.draft({ gemini: { points: 22 } }));
  rejects(() => f.save(reader, f.draft({ gemini: { points: 23 } })), 'ADMIN_PERMISSION_REQUIRED');
  rejects(() => f.save(nobody, f.draft({ gemini: { points: 23 } })), 'ADMIN_PERMISSION_REQUIRED');
  assert.equal(f.rows().find((row) => row.model === 'gemini')!.points, 22);
  // No session / a wrong CSRF token / a foreign origin: nothing is read or written.
  assert.throws(() => f.accounts.modelSettings(undefined, undefined, origin));
  assert.throws(() => f.accounts.modelSettings(f.owner.cookie, 'f'.repeat(64), origin), /ADMIN_CSRF_REQUIRED/);
  assert.throws(() => f.accounts.modelSettings(f.owner.cookie, f.owner.csrf, 'https://evil.invalid'));
  assert.throws(() => f.accounts.saveModelSettings(f.owner.cookie, 'f'.repeat(64), origin, f.draft()));
  assert.equal(f.rows().find((row) => row.model === 'gemini')!.points, 22);
  // The change log names the administrator that made each change (by label in the view).
  const recent = f.read(reader).recent;
  assert.deepEqual(
    recent.map((change) => [change.admin, change.model, change.field, change.from, change.to]),
    [
      ['Manager', 'gemini', 'points_per_reply', 21, 22],
      ['主管理员', 'gemini', 'points_per_reply', 20, 21],
    ],
  );
});

test('the permission can be granted to a member and shows in the matrix items (normalised, no requirements)', async () => {
  const { normalizePermissions, ADMIN_PERMISSION_ITEMS, requiredItems } = await import(
    '../../../packages/contracts/web-admin-permissions.ts'
  );
  assert.ok(ADMIN_PERMISSION_ITEMS.includes('models.manage'));
  assert.deepEqual(requiredItems('models.manage'), []);
  assert.deepEqual(normalizePermissions(['models.manage']), ['models.manage']);
});

test('saving is idempotent per request id, optimistic on the revision, and a no-op changes nothing', (t) => {
  const f = modelSettingsFixture(t);
  const input = f.draft({ gemini: { points: 40 } });
  const first = f.save(f.owner, input);
  assert.equal(first.duplicate, false);
  const replay = f.save(f.owner, input);
  assert.deepEqual([replay.duplicate, replay.revision, replay.changes], [true, first.revision, 0]);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_price_versions')!.n,
    3,
    'the replay wrote no new version',
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_model_changes')!.n, 1);
  // The same id with other content is a conflict; a stale revision is a conflict; neither writes.
  rejects(
    () => f.save(f.owner, { ...input, models: input.models.map((m) => ({ ...m, points: m.points + 1 })) }),
    'IDEMPOTENCY_CONFLICT',
  );
  rejects(
    () => f.save(f.owner, f.draft({ gemini: { points: 41 } }, undefined, first.revision - 1)),
    'MODEL_SETTINGS_CONFLICT',
  );
  assert.equal(f.rows().find((row) => row.model === 'gemini')!.points, 40);
  // Saving what is already there changes nothing and does not bump the revision.
  const none = f.save(f.owner, f.draft());
  assert.deepEqual([none.changes, none.revision], [0, first.revision]);
});

test('HTTP routes: read and save need the admin session, CSRF and origin; only POST; the body is exactly the documented shape', async (t) => {
  const f = modelSettingsFixture(t);
  const call = (path: string, body: unknown, over: Record<string, unknown> = {}) =>
    routeWebAccountAdmin(f.accounts, {
      method: 'POST',
      path: `/api/web/local/admin/models/${path}`,
      origin,
      adminCookie: f.owner.cookie,
      csrf: f.owner.csrf,
      body,
      ...over,
    } as never);
  const read = await call('read', {});
  assert.equal((read!.body as { canManage: boolean }).canManage, true);
  await assert.rejects(call('read', { extra: 1 }), /INVALID_REQUEST/);
  await assert.rejects(call('read', {}, { csrf: 'f'.repeat(64) }), /ADMIN_CSRF_REQUIRED/);
  await assert.rejects(call('read', {}, { method: 'GET' }), /NOT_FOUND/);
  const saved = await call('save', f.draft({ xai: { points: 26 } }));
  assert.equal((saved!.body as { changes: number }).changes, 1);
  await assert.rejects(call('save', { ...f.draft(), surprise: true }), /INVALID_REQUEST/);
  await assert.rejects(call('save', [] as never), /INVALID_REQUEST/);
  await assert.rejects(call('save', f.draft(), { csrf: 'f'.repeat(64) }), /ADMIN_CSRF_REQUIRED/);
  assert.equal(f.rows().find((row) => row.model === 'xai')!.points, 26);
  // Read routes are on the read-only allowlist, saving is not.
  const { isReadOnlyAdminPost } = await import('../../../apps/server/cloudflare/web-admin-read.ts');
  assert.equal(isReadOnlyAdminPost('/admin/models/read'), true);
  assert.equal(isReadOnlyAdminPost('/admin/models/save'), false);
});

// ---- no player data ---------------------------------------------------------------------------------------------------------

test('the change log, the settings and the admin view hold no player data: no ids, no emails, no content; and are append-only', (t) => {
  const f = modelSettingsFixture(t);
  const registered = f.guest('registered-secret-name', 'registered');
  f.store.run('UPDATE web_principals SET revision=revision WHERE id=?', registered);
  setPlayerModel(f.store, f.clock(), registered, 'gemini');
  f.admit(registered, 'req-secret-id');
  f.save(f.owner, f.draft({ gemini: { points: 33, registered: false }, xai: { guest: true } }, 7));
  f.save(f.owner, f.draft({ deepseek: { points: 11 } }));

  const tables = [
    'web_model_settings',
    'web_model_voice',
    'web_price_versions',
    'web_model_changes',
    'web_model_save_requests',
  ];
  const everything = tables.map((name) => JSON.stringify(f.store.all(`SELECT * FROM ${name}`))).join('\n');
  const view = JSON.stringify(f.read(f.owner));
  const memberId = f.store.get<{ id: string }>('SELECT id FROM web_admin_members LIMIT 1')!.id;
  for (const secret of ['registered-secret-name', 'principal-', 'player-', 'world-', 'req-secret-id', '你好', '@']) {
    assert.equal(everything.includes(secret), false, `tables: ${secret}`);
    assert.equal(view.includes(secret), false, `view: ${secret}`);
  }
  assert.equal(view.includes(memberId), false, 'the view shows an administrator by label, never by id');
  // The columns themselves carry nothing about a player.
  for (const name of tables) {
    const columns = f.store.all<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`).map((c) => c.name);
    assert.equal(
      columns.some((column) => /principal|player|world|email|content|body|text/.test(column)),
      false,
      `${name}: ${columns}`,
    );
  }
  // Append-only.
  assert.throws(() => f.store.run('UPDATE web_model_changes SET new_value=0'), /WEB_MODEL_CHANGE_IMMUTABLE/);
  assert.throws(() => f.store.run('DELETE FROM web_model_changes'), /WEB_MODEL_CHANGE_IMMUTABLE/);
  assert.throws(() => f.store.run('UPDATE web_price_versions SET xai_points=1'), /WEB_PRICE_VERSION_IMMUTABLE/);
  assert.throws(() => f.store.run('DELETE FROM web_price_versions'), /WEB_PRICE_VERSION_IMMUTABLE/);
  // The log lists what changed, in order.
  const log = f.store
    .all<{ model: string | null; field: string; old_value: number; new_value: number }>(
      'SELECT model,field,old_value,new_value FROM web_model_changes ORDER BY id',
    )
    .map((row) => ({ ...row }));
  assert.deepEqual(log, [
    { model: 'gemini', field: 'allowed_registered', old_value: 1, new_value: 0 },
    { model: 'gemini', field: 'points_per_reply', old_value: 20, new_value: 33 },
    { model: 'xai', field: 'allowed_guest', old_value: 0, new_value: 1 },
    { model: null, field: 'voice_points', old_value: 2, new_value: 7 },
    { model: 'deepseek', field: 'points_per_reply', old_value: 10, new_value: 11 },
  ]);
});

test('a database without migration 124 keeps Part 21b: the PLAYER_TEXT_MODELS list, the constant prices, no guest picker', (t) => {
  // schema 123 only: the settings tables do not exist.
  const f = modelSettingsFixture(t);
  f.store.db.exec(
    'DROP TABLE web_model_save_requests; DROP TABLE web_model_changes; DROP TABLE web_model_voice; DROP TABLE web_model_settings; DROP TABLE web_price_versions;',
  );
  const registered = f.guest('r', 'registered'),
    guest = f.guest('g');
  assert.deepEqual(tierModels(f.store, 'registered'), ['deepseek', 'gemini', 'xai']);
  assert.deepEqual(tierModels(f.store, 'guest'), []);
  assert.equal(canChooseModel(f.store, guest), false);
  assert.equal(currentPrices(f.store).perReply.xai, POINTS.perReply.xai);
  assert.equal(modelChoiceState(f.store, f.clock(), registered)!.models.length, 3);
  assert.throws(() => f.accounts.modelSettings(f.owner.cookie, f.owner.csrf, origin), /NOT_FOUND/);
  assert.ok(schema124);
});

test('the key probe fails closed: no method, an error or anything but `true` means no key; a real answer is passed on', async () => {
  assert.deepEqual(await probeModelKeys({}), { keys: { gemini: false, xai: false }, ok: false });
  assert.deepEqual(
    await probeModelKeys({
      modelKeys: async () => {
        throw new Error('rpc down');
      },
    }),
    { keys: { gemini: false, xai: false }, ok: false },
  );
  assert.deepEqual(await probeModelKeys({ modelKeys: async () => ({ xai: true, gemini: 'yes' }) }), {
    keys: { gemini: false, xai: true },
    ok: true,
  });
  assert.deepEqual(await probeModelKeys({ modelKeys: async () => ({ xai: false, gemini: true }) }), {
    keys: { gemini: true, xai: false },
    ok: true,
  });
});

// ---- Part 21f x 21g: every points computation reads the owner's table ---------------------------------------------------------

const spends = (f: ReturnType<typeof modelSettingsFixture>) =>
  f.store
    .all<{ delta: number; price_version: number }>(
      "SELECT delta,price_version FROM web_points_events WHERE source='spend' ORDER BY id",
    )
    .map((row) => ({ ...row }));

test('the owner raises Gemini 20 → 30: the next reply is charged 30 + voice at the new version, the one before keeps 22', (t) => {
  const f = modelSettingsFixture(t);
  const player = f.guest('r', 'registered');
  setPlayerModel(f.store, f.clock(), player, 'gemini');
  const before = f.admit(player, 'before');
  assert.deepEqual(spends(f), [{ delta: -22, price_version: 2 }]);
  f.save(f.owner, f.draft({ gemini: { points: 30 } }));
  const after = f.admit(player, 'after', 'b');
  assert.deepEqual(spends(f), [
    { delta: -22, price_version: 2 },
    { delta: -32, price_version: 3 },
  ]);
  const charged = (id: string) =>
    f.store.get<{ points_charged: number }>('SELECT points_charged FROM web_operation_models WHERE operation_id=?', id)!
      .points_charged;
  assert.deepEqual([charged(before.operationId), charged(after.operationId)], [22, 32]);
  // The picker's numbers and 约可聊 N 条 come from the same table: (150 - 22 - 32) / (30 + 2) = 3.
  const state = modelChoiceState(f.store, f.clock(), player)!;
  assert.equal(state.balance, 96);
  assert.equal(state.models.find((m) => m.id === 'gemini')!.points, 30);
  assert.equal(state.repliesLeft, 3);
  // Deepseek (selected) at 10 + 2: switch and the figure follows that model's price.
  setPlayerModel(f.store, f.clock(), player, 'deepseek');
  assert.equal(modelChoiceState(f.store, f.clock(), player)!.repliesLeft, 8);
});

test('a reply admitted BEFORE a price change, answered by the backup model, is refunded with its OWN version’s prices', (t) => {
  const f = modelSettingsFixture(t);
  const player = f.guest('r', 'registered');
  setPlayerModel(f.store, f.clock(), player, 'xai');
  const op = f.admit(player, 'old'); // xai 25 + voice 2 = 27 at version 2
  assert.deepEqual(spends(f), [{ delta: -27, price_version: 2 }]);
  // Later the owner reprices everything: xai far cheaper than DeepSeek, voice dearer. Version 3.
  f.save(f.owner, f.draft({ xai: { points: 5 }, deepseek: { points: 14 } }, 4));
  assert.equal(currentPrices(f.store).version, 3);
  // The old reply was drafted by the backup (DeepSeek) and carried no voice.
  f.store.run(
    "UPDATE web_operation_models SET draft_provider='deepseek',draft_model='deepseek-flash',backup=1 WHERE operation_id=?",
    op.operationId,
  );
  f.finish(op.operationId, 'published');
  reconcilePoints(f.store, f.clock(), player);
  const refunds = f.store
    .all<{ reason: string; delta: number; price_version: number }>(
      "SELECT reason,delta,price_version FROM web_points_events WHERE source='refund' ORDER BY id",
    )
    .map((row) => ({ ...row }));
  // Version 2's table: xai 25 - deepseek 10 = 15 back, and the frozen voice price 2. (Today's table would say 0 and 4.)
  assert.deepEqual(refunds, [
    { reason: 'backup_cheaper', delta: 15, price_version: 2 },
    { reason: 'no_voice', delta: 2, price_version: 2 },
  ]);
  // The label "按 {billed} 计费" is named by the same frozen table: at version 2 DeepSeek was the cheaper, at 3 xAI would be.
  assert.equal(billedModelAt(f.store, 2, 'xai', 'deepseek'), 'deepseek');
  assert.equal(billedModelAt(f.store, 3, 'xai', 'deepseek'), 'xai');
  assert.equal(billedModelAt(f.store, 2, 'deepseek', 'gemini'), 'deepseek', 'a dearer backup never raises the price');
  const row = {
    id: 'm1',
    body: '回复',
    created_at: 1,
    operation_id: op.operationId,
    origin: 'narrative' as const,
    ordinal: 0,
    media_id: null,
    duration_ms: null,
    via_backup: 1,
    chosen_model: 'xai',
    actual_model: 'deepseek',
    billed_model: billedModelAt(f.store, 2, 'xai', 'deepseek'),
  };
  assert.deepEqual(providerHistoryMessage(row, 'c', 'wei-guagua' as never).viaBackup, {
    chosen: 'xai',
    actual: 'deepseek',
    billed: 'deepseek',
  });
});

test('21f’s opening balance keeps its fixed unit (100 − 10 × bonus spent + 10 × unused trial), whatever the table says', (t) => {
  const f = modelSettingsFixture(t);
  f.save(f.owner, f.draft({ deepseek: { points: 99 }, gemini: { points: 150 } }, 20));
  const player = f.guest('r', 'registered');
  const state = modelChoiceState(f.store, f.clock(), player)!;
  assert.equal(state.balance, 150, '100 + 10 x 5 unused trial replies: the signup-bonus unit, not a table price');
  assert.equal(
    f.store.get<{ price_version: number }>("SELECT price_version FROM web_points_events WHERE source='bonus'")!
      .price_version,
    3,
    'the bonus event names the table in force',
  );
  // And what a reply costs now is the table's, so the cheapest reply is DeepSeek at 99 + 20.
  assert.equal(state.repliesLeft, Math.floor(150 / (99 + 20)));
});

test('an operation admitted under 21f’s constant v2 and one under the table’s v2 mean the same prices', (t) => {
  assert.equal(POINTS.version, 2);
  const f = modelSettingsFixture(t);
  const prices = pricesAt(f.store, 2)!;
  assert.deepEqual({ ...prices.perReply }, { ...POINTS.perReply });
  assert.equal(prices.voice, POINTS.voice);
  // Same player, same model, one store with the table and one with only the constant (a database before migration 124).
  const withTable = modelSettingsFixture(t);
  const constants = modelSettingsFixture(t);
  constants.store.db.exec(
    'DROP TABLE web_model_save_requests; DROP TABLE web_model_changes; DROP TABLE web_model_voice; DROP TABLE web_model_settings; DROP TABLE web_price_versions;',
  );
  const run = (x: ReturnType<typeof modelSettingsFixture>) => {
    const player = x.guest('r', 'registered');
    setPlayerModel(x.store, x.clock(), player, 'xai');
    const op = x.admit(player, 'same');
    x.finish(op.operationId, 'failed');
    reconcilePoints(x.store, x.clock(), player);
    return x.store
      .all<{ source: string; reason: string | null; delta: number; price_version: number }>(
        'SELECT source,reason,delta,price_version FROM web_points_events ORDER BY id',
      )
      .map((row) => ({ ...row }));
  };
  const a = run(withTable),
    b = run(constants);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((row) => [row.source, row.delta, row.price_version]),
    [
      ['bonus', 150, 2],
      ['spend', -27, 2],
      ['refund', 27, 2],
    ],
  );
  // A later table change does not touch an old operation's version: it still resolves to the same numbers.
  withTable.save(withTable.owner, withTable.draft({ xai: { points: 60 } }));
  assert.equal(pricesAt(withTable.store, 2)!.perReply.xai, 25);
});

test('a guest gets the picker only when the guest tier has two or more models; the server state is the one the page reads', (t) => {
  const f = modelSettingsFixture(t);
  const guest = f.guest('g');
  assert.equal(modelChoiceState(f.store, f.clock(), guest), null, 'one model: no picker');
  f.save(f.owner, f.draft({ gemini: { guest: true } }));
  const two = modelChoiceState(f.store, f.clock(), guest)!;
  assert.deepEqual(
    two.models.map((m) => m.id),
    ['deepseek', 'gemini'],
  );
  assert.equal(two.metered, false);
  // Back to one model (a different one): still no picker, and the guest is served by it.
  f.save(f.owner, f.draft({ deepseek: { guest: false } }));
  assert.equal(modelChoiceState(f.store, f.clock(), guest), null);
  assert.equal(effectiveModel(f.store, f.clock(), guest), 'gemini');
});
