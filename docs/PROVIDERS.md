# Text providers (Part 21b)

Players choose the model that WRITES their replies: DeepSeek (default), Gemini 3.8 Flash, Grok 4.7. Checked on **2026-10-15** with
the documentation pages below. The fetch tool used summarises pages, so each line says whether it was **confirmed** in the docs or is
**our assumption to confirm on staging** (re-record the fixtures in `tests/web/fixtures/model-choice.ts` from live answers then).

## One adapter shape
All three speak Chat Completions with ONE forced function call (`tool_choice`), exactly like DeepSeek before. The prompt text and the
output tool are identical for every provider; only the envelope (`apps/server/generation/text-wire.ts`) differs. The pinned prompt and
policy hashes are untouched (DeepSeek stays the policy). Our strict server-side validation of the returned payload is the source of
truth whatever a provider claims to enforce. Every fetch uses `redirect: 'manual'` (workerd rejects `'error'`).

| | DeepSeek | xAI | Gemini |
|---|---|---|---|
| Model id | `deepseek-flash` (draft) / `deepseek-v4-pro` (review) | `grok-4.7` — confirmed, [models](https://docs.x.ai/docs/models) | `gemini-3.8-flash` — confirmed ("New Stable"), [models](https://ai.google.dev/gemini-api/docs/models) |
| Endpoint | `https://api.deepseek.com/beta/chat/completions` | `https://api.x.ai/v1/chat/completions` — standard xAI path (the docs fetched describe `/v1/responses`; chat completions assumed) | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` — confirmed, [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) |
| Reasoning | thinking disabled | `reasoning_effort: "low"` — confirmed values low/medium/high/xhigh, cannot be disabled, [reasoning](https://docs.x.ai/docs/guides/reasoning) | `reasoning_effort: "low"` — confirmed mapping to thinking level low; `minimal` is rejected on 3.8 Flash |
| Completion limit | `max_tokens` | `max_completion_tokens` (assumed) | `max_tokens` (assumed) |
| Strict structured output | strict function (beta path) | strict function calling is implicit, `maxLength` ≤ 2048 enforced, `additionalProperties` default false — confirmed, [structured outputs](https://docs.x.ai/docs/guides/structured-outputs) | **Not confirmed**: the compat page documents function calling but no `strict`/`json_schema` strictness. The schema is rewritten to the OpenAPI subset (no `additionalProperties`, `type:null`, type arrays) and validated by us |
| Usage | `prompt/completion/total`, cache hit/miss | `usage` with `completion_tokens_details.reasoning_tokens`; whether `completion_tokens` includes reasoning is **not stated** | `total_tokens` includes thinking tokens ("output (including thinking tokens)") |

**Billing of reasoning/thinking.** They bill as output. We therefore take output = `total_tokens − prompt_tokens` (correct whether a
provider reports reasoning inside `completion_tokens` or beside it), and the money hold is `visible limit (4096) + 12288 headroom`
tokens for xAI and Gemini (`REASONING_HEADROOM`), sent as the completion limit. A reply that would exceed its hold fails closed
(`WEB_PROVIDER_CHARGE_EXCEEDS_HOLD`, UNKNOWN, hold kept). **Staging must check the headroom against real usage** (`pnpm usage:report`).

## Prices (LIST, never introductory) — `PROVIDER_PRICES` and `model-list-prices.ts`
- Gemini 3.8 Flash: $0.75 in / $0.075 cached / $3.75 out per million **until 2026-12-31**, then **$1.50 / $0.15 / $7.50 from 2027-01-01**
  ([pricing](https://ai.google.dev/gemini-api/docs/pricing)). The ledger bound is 8 µ$/token (7.5 rounded up), so nothing breaks on 1 Jan 2027. No long-context tier is listed for this model.
- Grok 4.7: $2 / $0.50 / $6 below 200k prompt tokens, **$4 / $1 / $12 at or above 200k** (all tokens of the request). A request body over 150 000 bytes is never sent (`MAX_REQUEST_BYTES.xai`; bytes ≥ tokens), so the dearer tier is impossible. Bound 6 µ$/token.
- DeepSeek (peak rates = list, off-peak is half): flash $0.006 / $0.30 / $1.20, v4-pro $0.044 / $1.32 / $3.96 ([pricing](https://api-docs.deepseek.com/quick_start/pricing)). The existing ledger bounds (2 and 4 µ$/token) are far above these and unchanged.
- The ledger holds one integer µ$/token per (provider, model, phase) at the dearer of input/output. Usage rows (`web_provider_usage`) use the real per-rate list prices.
- New rows are created by `renew-prices` (see DEPLOYMENT.md): it also creates the spending bound and capacity ticket of a provider that has none. `configureWebProvider` (first initialization) still seeds only DeepSeek and Fish, so a new deployment runs `renew-prices` once to make xAI/Gemini available.

## Failure classes (what may be retried on the next model)
DEFINITELY NOT BILLED → settled at zero, retried ONCE on the next model of chosen → DeepSeek → Gemini:
HTTP 429 (all three); 503 (DeepSeek, Gemini: documented overload/unavailable; xAI documents none, so its 503 stays UNKNOWN); a response recognised as
"location/region not supported" (Gemini documents `FAILED_PRECONDITION` for unsupported locations, 400; xAI assumed 403/451; matched on the message text); 401/402 (rejected credentials/balance, before processing);
a missing API key (`MODEL_UNAVAILABLE`, nothing reserved); a body over the xAI cap; a connection refused/not found (`ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`).
Everything else after a possible send — timeout, reset, 5xx other than the above, an unparseable body — is **UNKNOWN**: never retried, reservation never released. A complete answer that fails our schema is a KNOWN billed failure on that model (no backup).
Gemini error codes: [errors](https://ai.google.dev/gemini-api/docs/api-errors). Whether failed requests are billed is not stated there; we only treat as unbilled what the protocol itself proves.

## Placement (outbound region)
Cloudflare documents `"placement": {"region": "aws:us-east-1"}` ([placement](https://developers.cloudflare.com/workers/configuration/placement/)); it is set in `generation.json.example`. **The same page says placement affects only `fetch` handlers, not RPC methods or named entrypoints** — and our generation Worker is called by RPC. See DEPLOYMENT.md for what that means and the lever that does work.
