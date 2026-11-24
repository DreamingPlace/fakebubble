# Part 53 — the 审核模型 switch applies to every reply

## The bug
`textRouteFor` returned "today's behaviour" (no route) for an operation that has no row in `web_operation_models`. The provider
then built its review chain from its own policy (`DEFAULT_TEXT_MODELS.review`, V4 Pro), so the owner's switch to V4.1 Flash never
reached those replies. Operations without a row are: a signup-bonus reply, a trial_extra reply, and a guest admitted without a
model (web-admission records a model only for points, invited/holder and guestModel).

## The fix
In `apps/server/generation/web-text-routing.ts`, the no-row branch now returns the house reviewer frozen for that operation —
the same shape the feature-off branch already used — instead of `undefined`:

```ts
if (!row || !isPlayerModelId(row.chosen))
  return reviewModel === DEFAULT_REVIEW_MODEL ? undefined : { draft: [REF.draft.deepseek], review: [house] };
```

Drafting is unchanged. When the frozen reviewer is the default, the answer stays `undefined`, which resolves to that same
default: identical behaviour, no gratuitous route.

## Every place that reads the review model
| Where | What it uses |
|---|---|
| `apps/server/generation/web-text-routing.ts:83` (`frozenReviewModel`) | **the frozen model**; builds the `house` ref used by every branch |
| `apps/server/generation/web-text-routing.ts:27` (`REF.review.deepseek`) | the static table, only reached through `chain('review', …)`, where `deepseek` is remapped to `house`; it can never emit the default while a route exists |
| `apps/server/generation/deepseek.ts:420` | fallback chain when **no route** is passed; that only happens when the frozen reviewer IS the default (see above) or in tests |
| `apps/server/generation/text-generation-policy.ts:36` | the policy's `stages.review.model`; the same "no route" fallback, never used for a routed operation |
| `apps/server/platform/config.ts:22` | `DEEPSEEK_REVIEW_MODEL` env override for that policy; **not set in any deploy** (checked the live business config) |
| `apps/server/generation/web-provider-configuration.ts:21` | the shipped price row for V4 Pro review: pricing, not routing |
| `web-review-compare-runner` | by design both models; untouched |
| retries / backups / Part 43 re-queue | they re-enter `textRouteFor`, so they re-read the same frozen model |
| memory writing | consumes the review stage's output of that same call |
| v7 and v8 writers | draft stage only; the writer choice never touches the review model |

## Budget
The reservation prices `provider` + `model` + `phase` from the call it is about to make (`web-provider-offline.ts` `reserve()`),
so routing the review to Flash reserves at Flash's price. No change was needed; the new test asserts the hold equals the Flash
row (2 µUSD/unit) and not the Pro row (4).

## Tests
`tests/web/integration/web-review-model-routing-53.integration.test.ts`: every admission shape (no model row and with a model
row) with the switch on Flash and on Pro, an operation admitted before a switch keeps its reviewer, and the reservation price.
