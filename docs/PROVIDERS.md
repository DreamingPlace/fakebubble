# Provider notes

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
  ledger prices Drama 3 at the s2.1 upper bound (below).

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
2026-10-13 to 2026-11-12, charged per character. The ledger reserves per UTF-8 byte at 15 micros (the s2.1 upper bound),
because the fallback can serve s2.1-pro and the reply does not say which model ran.

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
