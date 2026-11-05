import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../../../apps/server/platform/store.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import {
  PROVIDER_PRICES,
  configureWebProvider,
  installMissingDeepSeekPrices,
  renewProviderPrices,
} from '../../../apps/server/generation/web-provider-configuration.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { TOKEN_LIST_PRICES } from '../../../apps/server/generation/model-list-prices.ts';
import {
  currentReviewModel,
  freezeReviewModel,
  frozenReviewModel,
  installReviewModelSchema,
  readReviewModelView,
  saveReviewModel,
} from '../../../apps/server/admission/web-review-model.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { textRouteFor } from '../../../apps/server/generation/web-text-routing.ts';
import { DEFAULT_REVIEW_MODEL, parseReviewModelSave } from '../../../packages/contracts/review-model.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { modelFixture } from '../fixtures/model-choice.ts';
import { modelSettingsFixture, origin, T0 } from '../fixtures/model-settings.ts';
import { createTextGenerationPolicy, textPolicyHash } from '../../../apps/server/generation/text-generation-policy.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';

const code = (error: unknown) => (error as { code?: string }).code;
const rejects = (work: () => unknown, expected: string) =>
  assert.throws(work, (error: unknown) => code(error) === expected, expected);
const PRO = 'deepseek-v4-pro',
  FLASH = 'deepseek-flash';

/** A deployment that has DeepSeek budgets and the prices Part 21b shipped: no Flash review row yet. */
function priced(store: Store, now: number, withFlash: boolean) {
  const ledger = new WebProviderOffline(store, { now: () => now });
  ledger.configureBudget('deepseek', 3_000_000);
  ledger.configureBudget('fish', 3_000_000);
  const rowsToPrice: ReadonlyArray<readonly [string, 'draft' | 'review', number]> = [
    [FLASH, 'draft', 2],
    [PRO, 'review', 4],
    ...(withFlash ? [[FLASH, 'review', 2] as const] : []),
  ];
  for (const [model, phase, upper] of rowsToPrice)
    ledger.configurePrice({
      id: `deepseek-${model}-${phase}-${now}`,
      provider: 'deepseek',
      model,
      phase,
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: upper,
      validFrom: now,
      validUntil: now + 30 * 86_400_000,
      version: 1,
    });
}

// ---- step 0: the facts the code is built on ---------------------------------------------------------------------------------

test('step 0 (docs/PROVIDERS.md, checked 2026-11-04): list prices of both review models and the unchanged policy', () => {
  // DeepSeek models & pricing page: deepseek-flash (V4.1 Flash) and deepseek-v4-pro are separate models; peak list prices.
  assert.deepEqual(TOKEN_LIST_PRICES['deepseek:deepseek-flash'], { input: 0.3, cachedInput: 0.006, output: 1.2 });
  assert.deepEqual(TOKEN_LIST_PRICES['deepseek:deepseek-v4-pro'], { input: 1.32, cachedInput: 0.044, output: 3.96 });
  // The budget ledger bounds a token at the dearer rate rounded up: 1.2 → 2 for Flash, 3.96 → 4 for Pro.
  const review = (model: string) =>
    PROVIDER_PRICES.find((p) => p.provider === 'deepseek' && p.model === model && p.phase === 'review');
  assert.equal(review(PRO)?.upper, 4);
  assert.equal(review(FLASH)?.upper, 2);
  // The switch changes NO pinned hash: the policy still names V4 Pro as its review model, the route carries the choice.
  assert.equal(createTextGenerationPolicy().stages.review.model, PRO);
  assert.match(textPolicyHash(), /^[0-9a-f]{64}$/);
  assert.match(textPromptHash(), /^[0-9a-f]{64}$/);
});

// ---- the switch ---------------------------------------------------------------------------------------------------------------

test('the default is V4 Pro; a switch affects only messages admitted after it, and each operation keeps its frozen reviewer', (t) => {
  const f = modelSettingsFixture(t);
  assert.equal(installReviewModelSchema(f.store, T0), true);
  assert.equal(currentReviewModel(f.store), DEFAULT_REVIEW_MODEL);
  assert.equal(DEFAULT_REVIEW_MODEL, PRO);
  priced(f.store, T0, true);

  const before = f.admit(f.guest('before'), 'req-before');
  assert.equal(frozenReviewModel(f.store, before.operationId), PRO, 'admitted on the default');
  const owner = f.owner;
  const revision = readReviewModelView(f.store, true)!.revision;
  const result = f.accounts.saveReviewModel(owner.cookie, owner.csrf, owner.origin, {
    requestId: 'switch-to-flash',
    expectedRevision: revision,
    reviewModel: FLASH,
  });
  assert.deepEqual(result, { revision: revision + 1, reviewModel: FLASH, changed: true, duplicate: false });
  assert.equal(currentReviewModel(f.store), FLASH);
  assert.equal(frozenReviewModel(f.store, before.operationId), PRO, 'the earlier operation is untouched by the switch');

  const after = f.admit(f.guest('after'), 'req-after');
  assert.equal(frozenReviewModel(f.store, after.operationId), FLASH);
  assert.equal(frozenReviewModel(f.store, before.operationId), PRO);
  // the frozen row is immutable
  assert.throws(
    () =>
      f.store.run(
        "UPDATE web_operation_review_models SET review_model='deepseek-v4-pro' WHERE review_model='deepseek-flash'",
      ),
    /WEB_REVIEW_MODEL_FROZEN/,
  );

  // and back: only a later admission follows
  f.accounts.saveReviewModel(owner.cookie, owner.csrf, owner.origin, {
    requestId: 'switch-to-pro',
    expectedRevision: revision + 1,
    reviewModel: PRO,
  });
  assert.equal(frozenReviewModel(f.store, after.operationId), FLASH, 'in-flight Flash stays Flash');
  assert.equal(frozenReviewModel(f.store, f.admit(f.guest('third'), 'req-third').operationId), PRO);

  // the change log names the administrator by label, never an id
  const view = readReviewModelView(f.store, true)!;
  assert.deepEqual(
    view.recent.map((c) => [c.from, c.to]),
    [
      [FLASH, PRO],
      [PRO, FLASH],
    ],
  );
  assert.ok(view.recent.every((c) => c.admin === 'Owner' || typeof c.admin === 'string'));
  assert.doesNotMatch(JSON.stringify(view), /@|member-|principal/);
});

test('a switch is one save of the 模型与价格 page: request id, revision, permission, CSRF and origin', async (t) => {
  const f = modelSettingsFixture(t);
  installReviewModelSchema(f.store, T0);
  priced(f.store, T0, true);
  const o = f.owner;
  const revision = readReviewModelView(f.store, true)!.revision;
  const body = (over: Record<string, unknown> = {}) => ({
    requestId: 'switch-request-1',
    expectedRevision: revision,
    reviewModel: FLASH,
    ...over,
  });
  const save = (auth: { cookie: string; csrf: string; origin: string }, input: unknown) =>
    f.accounts.saveReviewModel(auth.cookie, auth.csrf, auth.origin, input);

  // permission: a member without models.manage can read, not switch; one with it can
  const reader = f.member(['conversations.read'], 'Reader');
  assert.equal(f.accounts.reviewModelView(reader.cookie, reader.csrf, reader.origin).canManage, false);
  rejects(() => save(reader, body()), 'ADMIN_PERMISSION_REQUIRED');
  assert.equal(currentReviewModel(f.store), PRO, 'a refused switch changed nothing');
  // CSRF and Origin
  rejects(() => save({ ...o, csrf: 'x'.repeat(43) }, body()), 'ADMIN_CSRF_REQUIRED');
  rejects(() => save({ ...o, origin: 'https://evil.invalid' }, body()), 'ADMIN_UNAUTHORIZED');
  assert.equal(currentReviewModel(f.store), PRO);
  // strict body
  rejects(() => save(o, { ...body(), extra: 1 }), 'INVALID_REQUEST');
  rejects(() => save(o, body({ reviewModel: 'deepseek-v4-flash' })), 'INVALID_REQUEST');
  assert.equal(parseReviewModelSave(body({ requestId: 'short' })), undefined);
  // stale page revision
  rejects(() => save(o, body({ expectedRevision: revision + 5 })), 'MODEL_SETTINGS_CONFLICT');
  // the switch and the page's other save share the revision: after a switch, a save quoting the old one conflicts
  const manager = f.member(['models.manage'], 'Manager');
  const first = save(manager, body());
  assert.equal(first.changed, true);
  rejects(() => f.save(o, f.draft({ deepseek: { points: 11 } }, undefined, revision)), 'MODEL_SETTINGS_CONFLICT');
  // idempotent: a replay answers what the first call answered, other content under the same id is a conflict
  assert.deepEqual(save(o, body()), { revision: first.revision, reviewModel: FLASH, changed: false, duplicate: true });
  rejects(() => save(o, body({ reviewModel: PRO })), 'IDEMPOTENCY_CONFLICT');
  assert.equal(currentReviewModel(f.store), FLASH);
  // choosing what is already in force changes nothing (no revision bump, no log row)
  const same = save(o, body({ requestId: 'switch-request-2', expectedRevision: first.revision }));
  assert.deepEqual([same.changed, same.revision], [false, first.revision]);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_review_model_changes')!.n, 1);
  // through the route (session + CSRF + Origin are checked there too)
  const routed = await routeWebAccountAdmin(f.accounts, {
    method: 'POST',
    path: '/api/web/local/admin/models/review-read',
    body: {},
    adminCookie: o.cookie,
    csrf: o.csrf,
    origin: o.origin,
  } as never);
  assert.equal((routed!.body as { current: string }).current, FLASH);
  assert.equal(origin, o.origin);
});

test('a switch is refused while the target model has no price row in force (a review could not be reserved)', (t) => {
  const f = modelSettingsFixture(t);
  installReviewModelSchema(f.store, T0);
  priced(f.store, T0, false);
  const o = f.owner;
  rejects(
    () =>
      f.accounts.saveReviewModel(o.cookie, o.csrf, o.origin, {
        requestId: 'no-price-yet',
        expectedRevision: readReviewModelView(f.store, true)!.revision,
        reviewModel: FLASH,
      }),
    'REVIEW_MODEL_PRICE_MISSING',
  );
  assert.equal(currentReviewModel(f.store), PRO);
  // the start-time install adds the row, and then the switch works
  assert.equal(installMissingDeepSeekPrices(f.store as unknown as WebRuntimeStore, T0).length, 1);
  assert.equal(
    f.accounts.saveReviewModel(o.cookie, o.csrf, o.origin, {
      requestId: 'now-priced',
      expectedRevision: readReviewModelView(f.store, true)!.revision,
      reviewModel: FLASH,
    }).changed,
    true,
  );
});

test('an older store without the tables answers the default everywhere and the route is today’s', (t) => {
  const f = modelSettingsFixture(t);
  assert.equal(currentReviewModel(f.store), PRO);
  assert.equal(frozenReviewModel(f.store, 'any'), PRO);
  assert.equal(
    textRouteFor(f.store, 'any', T0, () => []),
    undefined,
    'feature off + default = no route at all (exactly today)',
  );
  rejects(
    () =>
      f.accounts.saveReviewModel(f.owner.cookie, f.owner.csrf, f.owner.origin, {
        requestId: 'no-tables-1',
        expectedRevision: 1,
        reviewModel: FLASH,
      }),
    'MODEL_SETTINGS_UNAVAILABLE',
  );
});

// ---- the frozen model reaches the provider call, with its own frozen price -----------------------------------------------------

test('an operation reviews with the model and price it was frozen with, even after a switch; a later one with the new model', async (t) => {
  const seen: Array<{ model: string; tool: string }> = [];
  let operation = 'operation';
  const f: ReturnType<typeof modelFixture> = modelFixture(t, {
    chosen: null,
    flag: false,
    fetch: (call) => {
      seen.push({ model: call.body.model as string, tool: call.tool });
      // the frozen request of the operation being run (each operation has its own required message)
      const request = readWebV7Request(f.store as never, operation).request as never;
      return Response.json(
        call.tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request),
      );
    },
  });
  // The fixture is schema 123; the switch needs the page revision (124) and its own tables.
  const { migrateWebProviderModelSettings } = await import('../../../apps/server/generation/web-provider-migration.ts');
  migrateWebProviderModelSettings(f.store as never);
  const now = f.clock.now();
  assert.equal(installReviewModelSchema(f.store, now), true);
  freezeReviewModel(f.store, 'operation', now);
  assert.equal(frozenReviewModel(f.store, 'operation'), PRO);

  // The owner switches to Flash BEFORE the first operation runs: it was admitted earlier, so it is not affected.
  const switched = saveReviewModel(f.store, now, 'admin', {
    requestId: 'switch-in-flight',
    expectedRevision: readReviewModelView(f.store, true)!.revision,
    reviewModel: FLASH,
  });
  assert.equal(switched.changed, true);
  f.addOperation('later', '再说一句', 'deepseek');
  freezeReviewModel(f.store, 'later', now + 1);
  assert.equal(frozenReviewModel(f.store, 'later'), FLASH);
  assert.deepEqual(
    textRouteFor(f.store, 'operation', now, () => [])?.review ?? [{ provider: 'deepseek', model: PRO }],
    [{ provider: 'deepseek', model: PRO }],
    'the in-flight operation routes to Pro (feature off: default means no route)',
  );
  assert.deepEqual(textRouteFor(f.store, 'later', now, () => [])?.review, [{ provider: 'deepseek', model: FLASH }]);

  await f.runText();
  assert.deepEqual(
    seen.map((s) => s.model),
    [FLASH, PRO],
    'draft by the draft model, review by the frozen Pro',
  );
  let attempts = f.attempts();
  const first = attempts.find((a) => a.phase === 'review')!;
  assert.equal(first.model, PRO);
  assert.equal(first.held_micros / 4 > 0, true, 'held at the Pro price row (4 micro-USD per unit)');
  await f.finishReply('operation');

  f.advance(1000);
  operation = 'later';
  await f.runText();
  assert.deepEqual(
    seen.slice(2).map((s) => s.model),
    [FLASH, FLASH],
    'the later operation: Flash drafts and Flash reviews',
  );
  attempts = f.all(
    `SELECT phase,model,held_micros,charged_micros FROM web_provider_attempts WHERE operation_id='later' ORDER BY phase`,
  );
  const review = attempts.find((a) => a.phase === 'review') as unknown as {
    model: string;
    held_micros: number;
    charged_micros: number;
  };
  assert.equal(review.model, FLASH);
  const units = review.charged_micros / 2;
  assert.ok(Number.isInteger(units) && units > 0, 'charged at the Flash price row (2 micro-USD per unit)');
  const price = f.get<{ upper_micros_per_unit: number }>(
    `SELECT upper_micros_per_unit FROM web_provider_prices WHERE provider='deepseek' AND model=? AND phase='review'`,
    FLASH,
  )!;
  assert.equal(price.upper_micros_per_unit, 2);
});

// ---- prices -------------------------------------------------------------------------------------------------------------------

const reviewRows = (store: Store) =>
  store.all<{
    id: string;
    model: string;
    upper_micros_per_unit: number;
    valid_from: number;
    valid_until: number;
    version: number;
  }>("SELECT * FROM web_provider_prices WHERE provider='deepseek' AND phase='review' ORDER BY model,version");
function plain(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'price-instance')");
  migrateWebProviderOffline(store);
  return store;
}

test('both review price rows exist on a freshly initialized store', (t) => {
  const store = plain(t);
  const now = 1_800_000_000_000;
  const selected = syntheticSelection();
  for (const item of selected)
    store.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      item.characterId,
      item.personaVersion,
      JSON.stringify(item.template),
    );
  configureWebProvider(store as unknown as WebRuntimeStore, selected, now);
  assert.deepEqual(
    reviewRows(store).map((r) => [r.model, r.upper_micros_per_unit, r.version]),
    [
      [FLASH, 2, 1],
      [PRO, 4, 1],
    ],
  );
  // starting the business object adds nothing that exists
  assert.deepEqual(installMissingDeepSeekPrices(store as unknown as WebRuntimeStore, now + 1000), []);
  // renew-prices on this store: the 30-day rows of initialization are renewed once, then reported not-due
  const first = renewProviderPrices(store as unknown as WebRuntimeStore, now + 1000).filter(
    (r) => r.provider === 'deepseek' && r.phase === 'review',
  );
  assert.deepEqual(
    first.map((r) => r.result),
    ['renewed', 'renewed'],
  );
  const again = renewProviderPrices(store as unknown as WebRuntimeStore, now + 2000).filter(
    (r) => r.provider === 'deepseek' && r.phase === 'review',
  );
  assert.ok(
    again.every((r) => r.result === 'not-due' || r.result === 'duplicate'),
    JSON.stringify(again),
  );
});

test('a store at schema 131 gains ONLY the missing Flash review row at start; nothing existing changes; renew-prices leaves it alone', (t) => {
  const store = plain(t);
  const now = 1_800_000_000_000;
  priced(store, now, false);
  const everything = () => store.all<{ id: string }>('SELECT * FROM web_provider_prices ORDER BY id');
  const before = everything();
  assert.deepEqual(
    reviewRows(store).map((r) => r.model),
    [PRO],
    'a deployment from before this Part: no Flash review row',
  );

  const added = installMissingDeepSeekPrices(store as unknown as WebRuntimeStore, now + 5000);
  assert.deepEqual(added, [`deepseek-${FLASH}-review-${now + 5000}`]);
  const after = everything();
  assert.equal(after.length, before.length + 1);
  for (const row of before)
    assert.deepEqual(
      after.find((r) => r.id === row.id),
      row,
      'an existing row is byte-identical',
    );
  const flash = reviewRows(store).find((r) => r.model === FLASH)!;
  assert.deepEqual(
    [flash.upper_micros_per_unit, flash.version, flash.valid_from, flash.valid_until],
    [2, 1, now + 5000, now + 5000 + 90 * 86_400_000],
  );

  // idempotent, however often it starts
  assert.deepEqual(installMissingDeepSeekPrices(store as unknown as WebRuntimeStore, now + 6000), []);
  assert.deepEqual(installMissingDeepSeekPrices(store as unknown as WebRuntimeStore, now + 7000), []);
  assert.equal(everything().length, before.length + 1);

  // renew-prices: the new row is not due, and a second pass at the same instant is a duplicate or not-due
  const rows = renewProviderPrices(store as unknown as WebRuntimeStore, now + 8000).filter(
    (r) => r.provider === 'deepseek' && r.phase === 'review',
  );
  const flashRenewal = rows.find((r) => r.model === FLASH)!;
  assert.equal(flashRenewal.result, 'not-due');
  assert.ok(
    ['not-due', 'duplicate'].includes(
      renewProviderPrices(store as unknown as WebRuntimeStore, now + 8000).find(
        (r) => r.model === FLASH && r.phase === 'review',
      )!.result,
    ),
  );

  // an expired row is renew-prices' business, not start's: start never adds a second row for a model that has one
  assert.deepEqual(installMissingDeepSeekPrices(store as unknown as WebRuntimeStore, now + 400 * 86_400_000), []);
});

test('start never touches a store that was not initialized (no DeepSeek spending row, no price tables)', (t) => {
  const store = plain(t);
  assert.deepEqual(installMissingDeepSeekPrices(store as unknown as WebRuntimeStore, 1_800_000_000_000), []);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_provider_prices')!.n, 0);
  const bare = new Store(':memory:');
  t.after(() => bare.close());
  assert.deepEqual(installMissingDeepSeekPrices(bare as unknown as WebRuntimeStore, 1), []);
  assert.equal(installReviewModelSchema(bare, 1), false, 'a store without operations is left alone');
});
