# Provider notes: Fish Audio

## Fish Audio Drama 3 (verified 2026-10-16)

Every statement below was read on the pages linked next to it on 2026-10-16. Where a page is silent, this file says so
instead of guessing. Re-verify before changing any spelling in `workers/audio/fish.ts`: a wrong `model` value does not
fail, it silently serves s2.1-pro.

### Model header

- **The value is `drama-3`.** [Drama 3](https://docs.fish.audio/features/text-to-speech/drama-3): "set the `model`
  header to `drama-3`" on the existing `POST /v1/tts`; the page never uses the word "preview". The
  [TTS API reference](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech) lists the `model` enum as
  `s1`, `s2-pro`, `s2.1-pro`, `s2.1-pro-free`, `drama-3` (default `s2.1-pro`) and says: "If omitted or set to an
  unrecognized value, the request falls back to `s2.1-pro`." The
  [launch post](https://fish.audio/blog/fish-audio-drama-3/) also names `drama-3`.
- **`drama-3-preview` is NOT accepted anywhere in the code.** It appears only in secondary coverage (kie.ai, Unite.AI) and
  as the Artificial Analysis leaderboard label "Fish Audio Drama 3 Preview"; none of the Fish pages above use it. The
  brief for this change expected `drama-3-preview` in the docs; the current docs say `drama-3`, so `drama-3` is the stored
  and sent value. If Fish ever documents another spelling, change `FishModel` in `packages/contracts/audio.ts` in one
  place and re-run the tests; `FISH_VOICE_MODEL=drama-3-preview` is refused at startup so it can never fall back silently.
- The [models overview](https://docs.fish.audio/developer-guide/models-pricing/models-overview) does not list Drama 3 yet
  (it lists `s2.1-pro`, `s2.1-pro-free`, `s2-pro`, `s1`).
- Fish's response does not echo the served model, so a silent fallback cannot be detected from the reply. That is why the
  ledger prices Drama 3 at its post-discount list price per byte (below).

### Direction syntax

[Drama 3](https://docs.fish.audio/features/text-to-speech/drama-3): a direction is natural language in square brackets
placed before the words it applies to, in English or any other language, e.g.
`[barely holding it together, forcing a smile] I'm fine. Really. Go on without me.` The server builds every direction
(`dramaExpressions` / `dramaDeliveryCues` in `workers/audio/fish.ts`); the draft model never writes one.

### Sound tags

Sounds and pauses go in brackets where they should occur. The docs give two examples and **no complete list**:
`[shaky breath]` and `[small laugh]` (the launch post additionally shows `[whispering]` and `[voice breaking]` as
directions). Only those two sound tags are whitelisted (`SOUND_CUES`: `small_laugh`, `shaky_breath`). `sigh`, `gasp`,
`laugh`, `breath` and `pause` appear only in third-party write-ups and are **not** verified; add one to `SOUND_CUES` (and
`dramaSoundTags`) only after hearing it work via `pnpm voice:samples` and finding it in the official docs or Fish
support.

### Paired word-level tags

Wrap only the affected words. Supported: `<whisper>`, `<emphasis>`, `<soft>`, `<fast>`, `<slow>`, `<stress>`,
`<forceful>`. We use exactly one: `<whisper>…</whisper>` around the spoken text for `tender_whisper`. `<`, `>`, `[` and
`]` are rejected in all model and player text (`AUDIO_CONTROL_MARKER_FORBIDDEN`), so only the server can introduce a tag.

### Not used

- **Language tags** (`<french>`, `<spanish>`, …): the docs call them experimental and not guaranteed per voice.
- **Phoneme syntax** (`<|phoneme_start|>…<|phoneme_end|>`) and **multi-speaker tags** (`<|speaker:0|>`).

### Formats and sample rates

The Drama 3 page shows only `"format": "mp3"` and lists no formats or sample rates. The shared TTS reference lists
`format` as `wav`, `pcm`, `mp3`, `opus` and `sample_rate` as "44100 Hz for most formats, 48000 Hz for opus" when null.
We keep sending `format: wav`, `sample_rate: 24000`; the adapter validates the reply as mono 24 kHz WAV and fails closed
otherwise (`UNEXPECTED_AUDIO_FORMAT`). **Whether Drama 3 honours 24 kHz is not documented and must be confirmed with
`pnpm voice:samples` on staging before enabling it.**

### Cloned voices (`reference_id`)

Not explicitly confirmed. The Drama 3 page documents `reference_id` (a string, or an array for multi-speaker) with public
voices, links "Create a voice clone model", and suggests "a voice cloned from a speaker fluent in both languages" for
language switching; the launch post's example also passes a `reference_id`. It never states in so many words that
cloned voices are supported. Treat this as **expected but unverified for our clones**: that is why a character can be
pinned back to s2.1-pro in the admin workbench, and why `pnpm voice:samples` exists.

### Other parameters

`prosody`, `latency`, `chunk_length`, `temperature`, `top_p` and `normalize` are sent unchanged (shared endpoint). The
`quality-guard` feature is documented for the s2 family only, so it is not sent to Drama 3.

### Price

[Launch post](https://fish.audio/blog/fish-audio-drama-3/): "$10 per million characters, 80% off the $50 list price" from
2026-10-13 to 2026-11-12, charged per character: **USD 10 per million during the launch discount, USD 50 per million after
it** (from 2026-11-13). Fish bills Drama 3 per character, and a UTF-8 byte count is never lower than the character count
(an English `[bracket direction]` is one byte per character, Chinese is three), so a per-byte price never understates.

- **Budget ledger (Part 21i): 50 micro-USD per UTF-8 byte** for `fish / drama-3 / speech` (`PROVIDER_PRICES`), the
  post-discount list price. It was 15 (the s2.1 bound), which understated ASCII text 3.3x once the discount ends. It is a new
  effective-dated price row: `renew-prices` appends a NEW VERSION that takes over from the moment it runs (see DEPLOYMENT.md);
  the old 15 row is never edited, and reservations made before that moment keep their old row. s2.1-pro stays 15.
  **Must be run on production before 2026-11-12.**
- **Usage report (`pnpm usage:report`): list price by UTC day of the call**: drama-3 costs 10 micros/byte for days up to and
  including 2026-11-12 and 50 from 2026-11-13 (`speechListMicrosPerByte(model, day)`); s2.1-pro 15.

## How the model is chosen per reply

`FISH_VOICE_MODEL` (business object var, default `s2.1-pro`; allowed `s2.1-pro`, `drama-3`) is the site default. A voice
binding's stored model decides whether it follows it:

| stored `model` | meaning | model sent |
| --- | --- | --- |
| `s2.1-pro` | unpinned (every binding made before Drama 3) | the site default |
| `pin:s2.1-pro` | admin pinned this character back | `s2.1-pro` |
| `drama-3` | explicitly Drama 3 | `drama-3` |
| `s2-pro` | legacy | `s2-pro` |

The welcome and footer clips are always rendered and kept as `s2.1-pro`, whatever the binding says.
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
- Speech (Part 21c): the usage report costs a reply's voice at the LIST price of the model that made it: `s2.1-pro` 15 micros/byte, `drama-3` **10** micros/byte up to and including 2026-11-12 (UTC day of the call) and **50** from 2026-11-13 (`speechListMicrosPerByte` in `model-list-prices.ts`; Fish bills Drama 3 per character, a byte count is never lower). Since Part 21i the ledger holds and charges **50** for `drama-3` (`PROVIDER_PRICES`) from the day `renew-prices` installs it.
- The ledger holds one integer µ$/token per (provider, model, phase) at the dearer of input/output. Usage rows (`web_provider_usage`) use the real per-rate list prices.
- New rows are created by `renew-prices` (see DEPLOYMENT.md): it also creates the spending bound and capacity ticket of a provider that has none. `configureWebProvider` (first initialization) still seeds only DeepSeek and Fish, so a new deployment runs `renew-prices` once to make xAI/Gemini available.

## Grok latency (Part 21f) — checked 2026-10-16, nothing changed
Staging measured Grok 4.7 at ~21 s per text reply against ~5 s for DeepSeek (already at `reasoning_effort: "low"`). Checked on docs.x.ai:
- **Lower reasoning setting.** [Reasoning](https://docs.x.ai/docs/guides/reasoning): grok-4.7 and grok-4.6 accept `low` / `medium` / `high` (default) / `xhigh`; there is **no `none`**, and the page states "Reasoning cannot be disabled". `low` is already the floor, so there is nothing lower to send.
- **Faster / non-reasoning model.** [Models](https://docs.x.ai/docs/models): the only text model labelled non-reasoning is `grok-4.20-0309-non-reasoning` ($1.25 in / $0.20 cached / $2.50 out below 200k prompt tokens). The page labels no model "fast". Its support for our strict forced-function output is **not documented**: [structured outputs](https://docs.x.ai/docs/guides/structured-outputs) names only the "Grok 4 family" and its examples use grok-4.7.
- **Decision.** Not adopted: a model that may not honour the strict schema is not swapped in on paper (every reply would fail validation as a billed failure). To try it, record a live answer from `grok-4.20-0309-non-reasoning` with our tool schema on staging, add its price row (`PROVIDER_PRICES`, `model-list-prices.ts`) and change `PLAYER_MODELS.xai.model`. Until then the picker tells the player the truth: **较慢，约20秒** (`PLAYER_MODELS[*].speed`).

## Failure classes (what may be retried on the next model)
DEFINITELY NOT BILLED → settled at zero, retried ONCE on the next model of chosen → DeepSeek → Gemini:
HTTP 429 (all three); 503 (DeepSeek, Gemini: documented overload/unavailable; xAI documents none, so its 503 stays UNKNOWN); a response recognised as
"location/region not supported" (Gemini documents `FAILED_PRECONDITION` for unsupported locations, 400; xAI assumed 403/451; matched on the message text); 401/402 (rejected credentials/balance, before processing);
a missing API key (`MODEL_UNAVAILABLE`, nothing reserved); a body over the xAI cap; a connection refused/not found (`ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`).
Everything else after a possible send — timeout, reset, 5xx other than the above, an unparseable body — is **UNKNOWN**: never retried, reservation never released. A complete answer that fails our schema is a KNOWN billed failure on that model (no backup).
Gemini error codes: [errors](https://ai.google.dev/gemini-api/docs/api-errors). Whether failed requests are billed is not stated there; we only treat as unbilled what the protocol itself proves.

## Placement (outbound region)
Cloudflare documents `"placement": {"region": "aws:us-east-1"}` ([placement](https://developers.cloudflare.com/workers/configuration/placement/)); it is set in `generation.json.example`. **The same page says placement affects only `fetch` handlers, not RPC methods or named entrypoints** — and our generation Worker is called by RPC. See DEPLOYMENT.md for what that means and the lever that does work.
