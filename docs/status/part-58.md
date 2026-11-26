# Part 58 — v8: understand the player first, then decide what the reply is for

Scope: the v8 writer family (新, 新+档案, 新+档案+梗) and its guard. 旧 (v7) is unchanged (asserted: prompt hash `c5f8018e…ab7fa`, `promptMessages` of the fixture `6ebf23b4…a28b`). No migration 132 (expected-migrations 56 + 56, last 131 = `a6f581dd…370990a`, byte-identical). No new column or table: the plan rides in the stored candidate JSON (`web_provider_candidates.candidate_json`, which already holds the whole reply) and in the rehearsal unit's `result_json`.

## The pattern (owner feedback)
Replies read as AI-made: 行 / 行吧 / 行行行 / 行了行了 sound dismissive, she answers every literal point instead of the person, comments on the player's words (「你说话像个老干部」「还给我留了理解空间」) and talks in empty inner commentary. A real person would take the care (「谢谢，好久没人这么关心我了」) or flirt back (「有你的爱给我当外套，我就不会着凉」).

## Design: think first, inside the same call
One draft call, no extra provider call (Part 54's one-call flow, the reservation before every call and "UNKNOWN is never retried" are untouched; the draft cap `WRITER_V8_MAX_TOKENS` 2048 and so the hold are unchanged).

**The plan format** (the writer's output, three fixed markers):
```
【读到】对方话背后的感受和需要（一句）
【目的】心动（回撩）：怎么做的几个字      ← one or two of 被接住 / 被关心 / 心动（回撩） / 开心（逗一下、小恶作剧） / 惊喜（她自己的事、新话题） / 被认真对待（认真安慰）
【回复】the reply lines (one line = one bubble, as before)
```
**How it is stripped** (`apps/server/generation/writer-plan.ts`, `splitWriterOutput`, called first in `parseWriterDraft`; every path to a reply, the voice path included, goes through `parseDraft`):
- the reply is what follows the first 【回复】; the plan is parsed from what precedes it (read ≤ 80 chars, aim ≤ 80 chars, `aims` = the closed-list purposes named before the first colon, at most two); a plan without a usable 读到 / 目的 is dropped, the reply stays;
- **no marker at all:** the whole output is the reply, no plan; **a marker but no 【回复】 (malformed):** every line that carries a marker is removed, the rest is the reply; **a stray marker inside the reply** is removed; the same for a guard replacement text;
- drift is understood: `[读到]` / `［读到］`, a colon after the marker, markdown bold around it;
- a reply that is only markers is `INVALID_BUBBLES`, as an empty reply always was.
Tested (text and voice): no `【 】`, no 读到 / 目的 / 回复 and no plan text reaches `bubbles`.

**Where the plan lives** (owner only, never a player): `candidate.plan = {read, aim, aims}` (contracts `DialogueCandidate.plan`), stored in the existing candidate JSON; read back by
- 测试对话 (the players' test conversations): a small line under each reply, 「读到：… 目的：…」; the page's CSV gets `读到,目的` at the end; archived transcripts have no plan (the archive table has no column for it, a migration is not allowed), like the guard reasons;
- the Part 57 export 对话消息: two new columns `读到` / `目的` at the end (nicknames replaced, then the usual scrub; the candidate's bubbles are still never read; a player line and a placeholder row are empty). `GUARD_REASONS` of that export now lists all 18 (it was missing the five of Part 56, so 改动原因 dropped them);
- 单次预演 (the run page detail and its CSV / JSON export: the same two columns) and 多轮预演 (a line under each 新 cell, and the counts below).
Logs and daily metrics are unchanged: no content, no plan.

**Variety.** The writer's user message gets `recentAims`: the first purpose of her last up to 3 replies in this conversation (live chat: read from the earlier operations' candidates, frozen into the request; rehearsal: this column's earlier cells); absent when there is none, so a first turn's request is what it was. The rule: 「同一个不连选三次，除非对方明显需要（比如一直在安慰）」.

**Her personality drives the aim.** No new field: the 核心卡 (说话习惯, 幽默方式, 绝不会说的话, 回复长短) and the settings are already in her system message; the plan lines say "用你的性格选".

## Rules (`prompts/v8/writer.md`, 3,220 characters, was 2,766; limit 4,000)
New block 「先想后说」 at the top:
> 【读到】对方话背后的感受和需要（关心、想被疼、表白、试探、求安慰、分享开心、无聊……），一句。
> 【目的】想让对方感到什么，用你的性格选一到两个：被接住、被关心、心动（回撩）、开心（逗一下、小恶作剧）、惊喜（你自己的事、新话题）、被认真对待（认真安慰），后面写几个字说怎么做。recentAims是你最近的目的，同一个不连选三次，除非对方明显需要（比如一直在安慰）。
> 【回复】然后才是回复：只说服务这个目的的话，短、自然。

Three new lines under 怎么聊 (plus the last line of 怎么写 now starts 「【回复】之后只写你对对方说的话」):
- 「不说敷衍的口头语：行、行吧、行行行、行了行了、好吧好吧、随你、得了，不当回复，也不当开头（“行”用在正常句子里说做某事可以）。不急躁，不居高临下，不说教，不卑微、不站在下位。」
- 「不点评、不分析对方刚说的话（比如“你说话像老干部”“还给我留了理解空间”），回应的是人。不逐点回答：先接住感受，再给点东西：暖一句、回撩、小惊喜、你自己的事或新话题。」
- 「心里的想法不全说出口，不接连讲内心旁白，语音里更要少。」
All Part 51 / 56 rules are untouched (asserted).

## Guard (`prompts/v8/guard.md`, 3,949 characters, was 3,575; now 「十八种」)
The guard sees `plan` (`read`, `aim`) next to `draft` and the prompt says it is only a reference. Four new reasons (a closed list in `GUARD_REASONS`, so the tool schema and the protocol digest move), one test each:
- `dismissive_filler`：整条或开头是“行”“行吧”“行行行”“行了行了”“好吧好吧”“随你”“得了”这类听着不耐烦的敷衍口头语（“行”在正常句子里说做某事不算）。替换成接住对方的一句。
- `impatient_or_lecturing`：急躁、居高临下、说教，或卑微讨好、站在下位。替换成平等自然的一句。
- `meta_commentary`：点评或分析对方刚说的话（如“你说话像老干部”“还给我留了理解空间”），而不是回应人。替换成回应人的一句。
- `no_emotional_value`：对方表现了关心、喜欢或心情，草稿只应一声或顺着说，什么也没给；或与plan的aim矛盾（如aim是心动却只回“嗯”）。替换成按aim给点暖、回撩或小惊喜的一句。
A reply that contradicts its own plan is flagged under `no_emotional_value`.

## Measurement
- **多轮预演 counts, per column** (deterministic, by code, from the stored replies): 「行类敷衍」 = replies with a bubble that *opens* with 行 / 行吧 / 行啊 / 行行行 / 行了行了 / 好吧(好吧) / 随你(吧) / 得了 followed by a break (so 行李, 行不行, 行动 and a 行 inside a sentence are not counted); 「目的分布」 = how many replies of a 新 column aimed at each purpose (— for 旧). Both in the table and in the Part 57 多轮预演 sheets' counts.
- **New set 「v8 规则 58」** (7 turns, listed last, paraphrased, no real player text): care given to her; an ambiguous "if you think I care"; a reminder to dress warmly; care phrased as 「你怎么定义都行」; a confession; a bored player; a player who is down.
- **Extra output tokens per reply: NOT MEASURED — this environment has no provider key, so no live call was made.** Estimate from the format: the plan is about 35–45 output tokens typical (a ~18-character read, a ~22-character aim, three markers); about 120 at the most the prompt allows (the code clips each line at 80 characters); the cap that bounds any reply is unchanged (2,048). Input: writer.md +454 characters and guard.md +374 (the stable prefix, cache-friendly) plus about 50 tokens of `plan` in the guard message. Latency: at DeepSeek's usual 50–80 tokens/s the draft stage should take about 0.5–0.8 s longer typically; Gemini and Grok already spend their thinking budget first, so the plan adds the same few tokens there. The 多轮预演 estimate (the confirmation total) now assumes 200 output tokens per 新 draft (was 120). **Measure with a real 「v8 规则 58」 run (带 style) before relying on these numbers.**
- **Per-model format.** Not verified live (no keys). The parser accepts the format drift most likely from DeepSeek / Gemini / Grok (brackets, colon, bold, no marker, a missing 【回复】) and never publishes a marker, so a model that ignores the format costs only an empty 读到 / 目的 and an empty `recentAims`, never a visible marker. **No per-model addendum line was added** (the three addenda are byte-identical); if the first 规则 58 run shows a column with no plan lines, add one line to that model's addendum then (it moves the pin). 

## Pins (new, on purpose; v8 only; **generation must deploy before business**)
| pin | was (Part 56) | now |
|---|---|---|
| `WRITER_V8_PROMPT_SHA256` | `4f53da3f850005fed1c5686d16abda9bdcf7ccf7e43d3596f198ed8b4fce922a` | `73d6855c6a5edcfa6b89684ec5f2824e888f39413cbb0d70741e93045fd1315d` |
| `writerPromptHash()` (新 prompt_digest) | `4186fe6b18b75e9af1d26c57d47b32776a601e73ba6d2dfd75122559ba78b6bb` | `6cb2cf4724c335db073cf156eeacddfbfcce0fa5622e46e44a2cd6eb6cf1b20f` |
| `writerPins(true).promptDigest` (新+档案) | `e8a4e2cbde9166952ed383e4774d015b9fba7add997107967e46553808b13d01` | `bce0512775bf7c0d265103d0b9f0798a22f6ac4eb8e8b01c533aeca03566426a` |
| `writerPins(true, true).promptDigest` (新+档案+梗) | `7d90ab32d46991dbf95d47a6343b1175752be391955506129699f635e2d076ce` | `1bc7c985247289ab97482458b4331b94559418fb373f64ecb7f846ddeb75dbea` |
| `writerPins().protocolDigest` | `ce52de214ead5c3e3024a76fd1d321a4e7153dc8cdad3c062571885b5a1587f2` | `3b5c190d0233d0eeb208cb26d593a4f1fd0f15ad16a8a58d384643a4e93d9f03` |
| `writerPolicyHash('{"a":1}')` | `9bfc2745…76ef85` | `b11e2dcf6d54fc7ce82424192d35de096948922e42e2fc89ff6ec7ab6f910165` |
| `…, true` | `4f1bec17…3c6ed` | `0276b2c1bfc8ec3713bfbafcdacd1bce07bb9e9efa1b132612635de23d834e37` |
| `…, true, true` | `eca0cb99…e48e581` | `2097994b854e6986503a196e260967ce007df0e1e00e6f87cceba38cfc0ed6b9` |

Files: `writer.md` `a7f0f55d…4224425` → `dd7aaf7413a80b6aa1d4e903a29a34efd487f0585c5a5f26253628ab291dea6d`; `guard.md` `399f9c19…eaaeca` → `cbfc5b4045709751d74759bc560200d720c4c708e1cee759a35022c67021c7cc`; the other five (cast-context, directions, the three addenda) are byte-identical. `WRITER_PROFILE_SHA256` and `WRITER_MEMES_SHA256` do not move. The generation Worker refuses a v8 request whose bundled files do not hash to the pin, so **deploy generation before business**. The 37a-3 addenda are untouched and still appended per model (asserted). A frozen v8 request carries `recentAims` only when she has earlier replies with a plan.

## Tests
New `tests/web/unit/web-rules-58.test.ts` (15): rule texts; sizes < 4,000 and 旧 hashes; the split (format, no marker, malformed, drift, stray marker, unusable plan); no marker or plan text in the published bubbles (text and voice, a guard replacement too); the plan stored on the candidate and absent on a plan-less reply; the guard text, schema (18) and one `applyReview` case per new reason; the guard message carries `plan`; `recentAims` (writer message, validation, the rehearsal request); the 行-family count (openers only) and the aim distribution; the set 「v8 规则 58」; the preview export's two columns. Added to existing tests: `web-chat-review` (a transcript line carries the plan, nickname replaced), `web-export-57` (the two columns, a player line empty).
NAMED EXCEPTIONS (old tests that pinned what this Part changes on purpose): the prompt hashes and digests in `web-writer-v8-37a`, `web-writer-tuning-37a3`, `web-rules-56`, `web-rules-51`, `web-memes-37c1`, `web-speech-profile-37b`; `GUARD_REASONS.length` 14 → 18 and 「十四种」 → 「十八种」 in the same files; the set labels / count in `web-rehearsal-35`; the page CSV header of `web-chat-review` (`…,审核改动,读到,目的`).

## Limits
- An archived (deleted-account) transcript has no plan (no column; a migration is not allowed). Guard reason codes have the same limit.
- The plan is the writer's own words about a player's message: it is owner-only content, exported only through the audited owner export, scrubbed like any text cell, and never in a log.
