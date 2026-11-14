import { PLAYER_MODELS, isPlayerModelId, type PlayerModelId } from '../../../packages/contracts/player-models.ts';
import type { ModelRef, TextRoute } from '../../../packages/contracts/text-route.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { offeredModels } from '../admission/web-points.ts';
import { ceilingModels, type ModelFlags } from '../admission/web-model-settings.ts';
import { frozenReviewModel } from '../admission/web-review-model.ts';
import { DEFAULT_REVIEW_MODEL } from '../../../packages/contracts/review-model.ts';

/**
 * Who drafts and who reviews one reply (Part 21b). DRAFT: the player's frozen choice, then DeepSeek, then Gemini. REVIEW
 * (safety and the memory topics / factOps) is always the house reviewer, then Gemini: memory is therefore written by one
 * consistent model whatever the player picks. Part 26b: the house reviewer is DeepSeek V4 Pro or V4.1 Flash, whichever the owner
 * had switched on when the operation was ADMITTED (web_operation_review_models); a later switch never reaches it. A model is only ever tried after a definitely-not-billed failure
 * of the one before it.
 *
 * The chosen model is read from web_operation_models, written at admission: switching affects the next message only. This
 * is routing data; the model name is never put into any prompt.
 */
const REF: Record<'draft' | 'review', Record<'deepseek' | 'gemini' | 'xai', ModelRef>> = {
  draft: {
    deepseek: { provider: 'deepseek', model: DEFAULT_TEXT_MODELS.draft },
    gemini: { provider: 'gemini', model: PLAYER_MODELS.gemini.model },
    xai: { provider: 'xai', model: PLAYER_MODELS.xai.model },
  },
  review: {
    deepseek: { provider: 'deepseek', model: DEFAULT_TEXT_MODELS.review },
    gemini: { provider: 'gemini', model: PLAYER_MODELS.gemini.model },
    // Grok never reviews; present only so the table is total.
    xai: { provider: 'xai', model: PLAYER_MODELS.xai.model },
  },
};

type Reader = Pick<BusinessStore, 'get' | 'all'> & ModelFlags;

/**
 * A model can be used when the owner offers it AND its price, spending bound and capacity ticket exist (renew-prices seeds
 * them). `frozen` is the model an operation was admitted with: it keeps being used while the environment still allows it
 * (ceiling), even if the owner has since switched it off for new messages.
 */
function usable(store: Reader, id: PlayerModelId, phase: 'draft' | 'review', now: number, frozen = false) {
  if (id === 'deepseek') return true;
  const ref = REF[phase][id];
  return (
    !!(frozen ? ceilingModels(store) : offeredModels(store))?.includes(id) &&
    !!store.get(
      "SELECT 1 FROM web_provider_prices WHERE provider=? AND model=? AND phase=? AND currency='USD' AND valid_from<=? AND valid_until>?",
      ref.provider,
      ref.model,
      phase,
      now,
      now,
    ) &&
    !!store.get('SELECT 1 FROM web_provider_spending WHERE provider=?', ref.provider) &&
    !!store.get(
      "SELECT 1 FROM web_external_budgets WHERE provider=? AND stage='text' AND phase=? AND capacity>0",
      ref.provider,
      phase,
    )
  );
}

/** Part 35: the model a 多轮预演 column drafts with: the same table a player's choice is routed by. */
export const draftModelRef = (id: PlayerModelId): ModelRef => REF.draft[id];
/**
 * Part 35: can THIS environment serve `id` for a draft right now: the player-model ceiling (flag and key) and the price, spending
 * bound and capacity ticket a call needs. DeepSeek always. The owner's switch for players does not matter: an administrator may
 * rehearse a model players are not offered.
 */
export const modelUsableHere = (store: Reader, id: PlayerModelId, now: number) => usable(store, id, 'draft', now, true);

/**
 * The route of an operation, or undefined for "exactly today's behaviour" (feature off, no frozen choice: guests, invited
 * players, everything admitted before the feature). `abandoned` are the providers already proven not to have run this stage.
 */
export function textRouteFor(
  store: Reader,
  operationId: string,
  now: number,
  abandoned: (phase: 'draft' | 'review') => readonly string[],
): TextRoute | undefined {
  // Part 26b: the review model this operation was admitted with. Everything else about the route is unchanged.
  const reviewModel = frozenReviewModel(store, operationId);
  const house: ModelRef = { provider: 'deepseek', model: reviewModel };
  if (!offeredModels(store))
    // Feature off: exactly today's behaviour (no route) unless the owner switched the reviewer, which only changes the review model.
    return reviewModel === DEFAULT_REVIEW_MODEL ? undefined : { draft: [REF.draft.deepseek], review: [house] };
  const row = store.get<{ chosen: string }>(
    'SELECT chosen FROM web_operation_models WHERE operation_id=?',
    operationId,
  );
  if (!row || !isPlayerModelId(row.chosen)) return undefined;
  const chain = (phase: 'draft' | 'review', order: PlayerModelId[], frozen?: PlayerModelId) => {
    const skip = new Set(abandoned(phase));
    const refs = [...new Set(order)]
      .filter((id) => usable(store, id, phase, now, id === frozen) && !skip.has(REF[phase][id].provider))
      .map((id) => (phase === 'review' && id === 'deepseek' ? house : REF[phase][id]));
    // Everything abandoned or unavailable: fall back to DeepSeek rather than an empty chain (the call fails or succeeds on its own).
    return refs.length ? refs : [phase === 'review' ? house : REF[phase].deepseek];
  };
  // The frozen model stays while the environment allows it (Part 21g); outside the ceiling it falls back to DeepSeek as before.
  const chosen: PlayerModelId = ceilingModels(store)?.includes(row.chosen) ? row.chosen : 'deepseek';
  return {
    draft: chain('draft', [chosen, 'deepseek', 'gemini'], chosen),
    review: chain('review', ['deepseek', 'gemini']),
  };
}
