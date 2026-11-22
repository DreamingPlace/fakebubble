import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { modelFixture, type FetchCall } from '../fixtures/model-choice.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import {
  freezeReviewModel,
  frozenReviewModel,
  installReviewModelSchema,
  readReviewModelView,
  saveReviewModel,
} from '../../../apps/server/admission/web-review-model.ts';
import { migrateWebProviderModelSettings } from '../../../apps/server/generation/web-provider-migration.ts';
import { textRouteFor } from '../../../apps/server/generation/web-text-routing.ts';
import type { PlayerModelId } from '../../../packages/contracts/player-models.ts';
import { DEFAULT_TEXT_MODELS } from '../../../apps/server/platform/config.ts';

/**
 * Part 53: the 审核模型 switch applies to EVERY reply. Before this, textRouteFor returned "today's behaviour" for an operation
 * without a row in web_operation_models (a signup-bonus reply, a trial_extra reply, a guest admitted without a model), so those
 * replies were reviewed by DEFAULT_TEXT_MODELS.review and the owner's switch never reached them.
 *
 * The shapes below are the admission kinds from the outside: which of them writes a model row at admission is the only thing
 * the router can see, so each test names the kinds that produce that shape.
 */
const DRAFT = 'submit_dialogue_draft';
const PRO = 'deepseek-v4-pro';
const FLASH = 'deepseek-flash';

const answer = () => (call: FetchCall, _n: number, request: never) =>
  Response.json(call.tool === DRAFT ? draftEnvelope(request) : acceptedAuditEnvelope(request));

/** The V4.1 Flash review price row a switch to Flash needs (the shipped table already carries it; this covers older fixtures). */
function priceFlashReview(f: ReturnType<typeof modelFixture>, now: number) {
  const existing = f.store.get(
    "SELECT 1 FROM web_provider_prices WHERE provider='deepseek' AND model=? AND phase='review' AND currency='USD' AND valid_from<=? AND valid_until>?",
    'deepseek-flash',
    now,
    now,
  );
  if (existing) return;
  const ledger = new WebProviderOffline(f.store, { now: () => now });
  ledger.configurePrice({
    id: `deepseek-${FLASH}-review-${now}`,
    provider: 'deepseek',
    model: FLASH,
    phase: 'review',
    currency: 'USD',
    unit: 'token',
    upperMicrosPerUnit: 2,
    version: 1,
    validFrom: now,
    validUntil: now + 30 * 86_400_000,
  });
}

/**
 * A fixture whose review model the owner has already switched to `switchTo`, with the review model frozen for `'operation'`
 * at admission. `chosen: null` is the shape of a guest admitted without a model / a signup-bonus reply / a trial_extra reply:
 * no row in web_operation_models.
 */
function fixture(t: TestContext, chosen: PlayerModelId | null, switchTo: 'deepseek-v4-pro' | 'deepseek-flash') {
  const f = modelFixture(t, { chosen, fetch: answer() });
  migrateWebProviderModelSettings(f.store as never);
  const now = f.clock.now();
  assert.equal(installReviewModelSchema(f.store, now), true);
  priceFlashReview(f, now);
  if (switchTo !== PRO)
    saveReviewModel(f.store, now, 'admin', {
      requestId: `switch-${switchTo}`,
      expectedRevision: readReviewModelView(f.store, true)!.revision,
      reviewModel: switchTo,
    });
  freezeReviewModel(f.store, 'operation', now);
  return { f, now };
}

const reviewOf = (route: { review: { model: string }[] } | undefined) => route?.review[0]?.model ?? null;

test('a reply with no model row (guest without a model, signup bonus, trial_extra) is reviewed by the switched reviewer', (t) => {
  for (const kind of ['guest-without-model', 'signup-bonus', 'trial-extra'] as const) {
    const flash = fixture(t, null, 'deepseek-flash');
    assert.equal(frozenReviewModel(flash.f.store, 'operation'), FLASH, `${kind}: frozen at admission`);
    const route = textRouteFor(flash.f.store, 'operation', flash.now, () => []);
    assert.equal(
      reviewOf(route),
      FLASH,
      `${kind}: the review goes to the switched reviewer, not to DEFAULT_TEXT_MODELS.review`,
    );
    assert.equal(route?.draft[0]?.model, DEFAULT_TEXT_MODELS.draft, `${kind}: drafting is unchanged`);
    assert.notEqual(reviewOf(route), DEFAULT_TEXT_MODELS.review);
  }
});

test('a reply with a model row (guest with a model, points, invited/holder) is reviewed by the switched reviewer', (t) => {
  const flash = fixture(t, 'deepseek', 'deepseek-flash');
  flash.f.addOperation('later', '再说一句', 'deepseek');
  freezeReviewModel(flash.f.store, 'later', flash.now + 1);
  assert.equal(reviewOf(textRouteFor(flash.f.store, 'later', flash.now, () => [])), FLASH);
});

test('with the switch on V4 Pro both shapes review with V4 Pro', (t) => {
  const pro = fixture(t, null, 'deepseek-v4-pro');
  // "Today's behaviour" (no route) means the provider's own policy default, which IS V4 Pro: the two are the same reviewer.
  assert.equal(reviewOf(textRouteFor(pro.f.store, 'operation', pro.now, () => [])) ?? DEFAULT_TEXT_MODELS.review, PRO);
  pro.f.addOperation('later', '再说一句', 'deepseek');
  freezeReviewModel(pro.f.store, 'later', pro.now + 1);
  // Feature on, no switch away from the default: "today's behaviour" (no route) reviews with the policy default, which IS V4 Pro.
  const rowed = textRouteFor(pro.f.store, 'later', pro.now, () => []);
  assert.equal(rowed?.review[0]?.model ?? DEFAULT_TEXT_MODELS.review, PRO);
});

test('an operation admitted before a switch keeps the reviewer it was admitted with', (t) => {
  const f = modelFixture(t, { chosen: null, fetch: answer() });
  migrateWebProviderModelSettings(f.store as never);
  const now = f.clock.now();
  assert.equal(installReviewModelSchema(f.store, now), true);
  priceFlashReview(f, now);
  // Admitted (and frozen) while the switch is still on Pro.
  assert.equal(frozenReviewModel(f.store, 'operation'), PRO);
  freezeReviewModel(f.store, 'operation', now);
  // The owner switches to Flash: the operation admitted a moment ago keeps Pro.
  saveReviewModel(f.store, now + 1, 'admin', {
    requestId: 'switch-after-admission',
    expectedRevision: readReviewModelView(f.store, true)!.revision,
    reviewModel: FLASH,
  });
  assert.equal(frozenReviewModel(f.store, 'operation'), PRO);
  assert.equal(
    reviewOf(textRouteFor(f.store, 'operation', now + 2, () => [])) ?? DEFAULT_TEXT_MODELS.review,
    PRO,
    'the frozen reviewer, not the one just switched on',
  );
});

test('the reservation is priced at the chosen reviewer, not at the default one', async (t) => {
  const flash = fixture(t, null, 'deepseek-flash');
  await flash.f.runText();
  const review = flash.f.attempts().find((attempt) => attempt.phase === 'review');
  assert.ok(review, 'a review attempt exists');
  assert.equal(review.model, FLASH, 'the review call goes to the switched reviewer');
  const price = (model: string) =>
    flash.f.store.get<{ upper_micros_per_unit: number }>(
      "SELECT upper_micros_per_unit FROM web_provider_prices WHERE provider='deepseek' AND phase='review' AND currency='USD' AND model=? AND valid_from<=? AND valid_until>? ORDER BY version DESC LIMIT 1",
      model,
      flash.now,
      flash.now,
    );
  const proPrice = price(PRO)!.upper_micros_per_unit;
  const flashPrice = price(FLASH)!.upper_micros_per_unit;
  assert.equal(flashPrice, 2, 'the Flash review row is 2 micro-USD per unit');
  assert.ok(proPrice > flashPrice, 'the Pro review row is dearer than the Flash row');
  // held_micros is the module's own record of the hold; the ratio to the price rows shows which row it used.
  assert.equal(review.held_micros % flashPrice, 0, 'the hold is a whole number of Flash units');
  assert.equal(review.held_micros % proPrice === 0, false, 'the hold is not a whole number of Pro units, so it is not the Pro price');
  assert.equal(review.held_micros / flashPrice, 51_189, 'held at the Flash price (the review token bound)');
});
