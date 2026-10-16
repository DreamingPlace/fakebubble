import { PLAYER_MODELS, isPlayerModelId, type PlayerModelId } from '../../../packages/contracts/player-models.ts';
import type { ModelRef, TextRoute } from '../../../packages/contracts/text-route.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { offeredModels } from '../admission/web-points.ts';

/**
 * Who drafts and who reviews one reply (Part 21b). DRAFT: the player's frozen choice, then DeepSeek, then Gemini. REVIEW
 * (safety and the memory topics / factOps) is always the house reviewer, DeepSeek v4 pro, then Gemini: memory is therefore
 * written by one consistent model whatever the player picks. A model is only ever tried after a definitely-not-billed failure
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

type Reader = Pick<BusinessStore, 'get'> & { playerModelChoice?: readonly PlayerModelId[] };

/** A model can be used when the owner offers it AND its price, spending bound and capacity ticket exist (renew-prices seeds them). */
function usable(store: Reader, id: PlayerModelId, phase: 'draft' | 'review', now: number) {
  if (id === 'deepseek') return true;
  const ref = REF[phase][id];
  return (
    !!offeredModels(store)?.includes(id) &&
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
  if (!offeredModels(store)) return undefined;
  const row = store.get<{ chosen: string }>(
    'SELECT chosen FROM web_operation_models WHERE operation_id=?',
    operationId,
  );
  if (!row || !isPlayerModelId(row.chosen)) return undefined;
  const chain = (phase: 'draft' | 'review', order: PlayerModelId[]) => {
    const skip = new Set(abandoned(phase));
    const refs = [...new Set(order)]
      .filter((id) => usable(store, id, phase, now) && !skip.has(REF[phase][id].provider))
      .map((id) => REF[phase][id]);
    // Everything abandoned or unavailable: fall back to DeepSeek rather than an empty chain (the call fails or succeeds on its own).
    return refs.length ? refs : [REF[phase].deepseek];
  };
  const chosen: PlayerModelId = offeredModels(store)!.includes(row.chosen) ? row.chosen : 'deepseek';
  return {
    draft: chain('draft', [chosen, 'deepseek', 'gemini']),
    review: chain('review', ['deepseek', 'gemini']),
  };
}
