# Part 56 — v8: answer the feeling first; names are agreed, not fought over

Scope: the v8 writer family (新, 新+档案, 新+档案+梗) and its guard. 旧 (v7) is unchanged (asserted: prompt hash `c5f8018e…ab7fa`, `promptMessages` of the fixture `6ebf23b4…a28b`). No migration (expected-migrations 56 + 56, last 131 = `a6f581dd…370990a`).

## The pattern
In the production samples (paraphrased in the rehearsal set; no real player text is committed) the form of address blocked the emotion: a player who missed her or confessed got 「才认识就叫宝宝」/「真的假的」, a nickname got 「搞混了」, a name she had used herself was denied, and a guard edit left 「刚吃了两个…不对，我忘了」.

## Rules (`prompts/v8/writer.md`; Part 51 rule 3 rewritten, rule 5 adjusted)
1. Feeling first (new line, under 你和对方): 「先接住感受：对方说心情、想你、喜欢你、表白，或分享消息，这条回复的主要任务是用你自己的性格暖暖接住……不能只说“好突然”或“真的假的”。称呼最多占一小句，不是话题，也不跨轮讨论。」
2. Pet names (replaces Part 51 rule 3): 「称呼（宝宝、宝贝、亲爱的、哥哥、姐姐这类）：当作对方想要亲近，回应的是亲近。第一次可以轻轻逗一句，同时认真接住对方说的话；从第二次起，或对方解释、坚持，就接受，或叫回去，或一起商量（“那我叫你XX好不好”）。叫定了就自然地用，并记下来。不说教，不反复推拒，不提“进度条”和关系进展。对方没先叫的称呼（姐、哥、昵称），你也不先叫。」
3. Names the player gives her: 「对方给你起的亲昵外号……轻轻接一句你自己风格的反应，收下，记住，之后可以用。」 Only a 黑称 or a clearly insulting name keeps Part 51 rule 5 (「对方叫你的黑称或明显带侮辱的名字，一定是明确的反感，绝不接受，也不顺着玩」).
4. Roles she played (in the rule 5 paragraph): 「对方用你饰演过的角色名叫你，认得出来，俏皮接一句，比如“叫我XX？那我可要入戏了”，不说“搞混了”」.
5. Her own words stand: 「你说过的话算数：这场聊天里你自己说过的（比如你怎么称呼自己），不否认，可以轻轻认下。」
6. Coherence: 「一句话里不自我更正、不前后矛盾（比如“刚吃了两个…不对，我忘了”）；忘了就直接说忘了。」

Memory: the pet name / nickname is recorded through the existing `factOps` (guard: `add`, factKey 「称呼 XX」, evidence = the player's own message; `update` when the name changes). No new field.

## Guard (`prompts/v8/guard.md`; now 「十四种」)
Five new reasons (a closed list in `GUARD_REASONS`, so the guard tool schema and the protocol digest move): `cold_to_feeling`, `argued_name`, `confused_own_name`, `denied_own_words`, `incoherent_reply`. `presumptuous_address` is relaxed: a name the player used, asked for or agreed never fires it (the 黑称/dislikes branch is unchanged). Coherence: the guard now has to make an edit read as one message with the other lines; if one line cannot, it replaces every line (one fix per index) so the result is one clean reply, and a draft that was fine is kept (`fixes: []`).

## Role names reach the writer
Verified, no code change needed: `ownNamesFromProfile` reads `profileFacts[饰演过的角色]` (the 其余设定 editor and the profile import both write it there) and merges it with the published cast file's aliases (`writerOwnNames`); the names are printed in the writer's system message and given to the guard. A test covers 其余设定 → writer message and guard input.
**Characters with no role names filled in:** the character data (profiles, cast file) lives in the owner's database, not in this repository, so the list cannot be produced from here. The rehearsal scripts 「v8 规则 51 · 名字 饰演过的角色」 and 「v8 规则 56」 put a stand-in (那个角色) in the turn for a character with none, so the run page shows who is missing.

## Sizes (characters; limit 4,000)
writer.md 2,766 (was 2,467), guard.md 3,575 (was 2,961), cast-context 897, directions 382, addenda unchanged.

## Pins (new, on purpose; v8 only; generation must deploy before business)
| pin | was (Part 51) | now |
|---|---|---|
| `WRITER_V8_PROMPT_SHA256` | `2e1768c7fcf82c43e31d40b45862146d44c5b123872f4953667a99574accefbf` | `4f53da3f850005fed1c5686d16abda9bdcf7ccf7e43d3596f198ed8b4fce922a` |
| `writerPromptHash()` (新 prompt_digest) | `65b3f643b25e1ed98b86e931a135391794c10c9b3054da13dc7d1358f1c7174e` | `4186fe6b18b75e9af1d26c57d47b32776a601e73ba6d2dfd75122559ba78b6bb` |
| `writerPins(true).promptDigest` (新+档案) | `04e3cca28266eeb5173f75559ffdb1895611a69240a1a28c9a9a88817e17f4df` | `e8a4e2cbde9166952ed383e4774d015b9fba7add997107967e46553808b13d01` |
| `writerPins(true, true).promptDigest` (新+档案+梗) | `49c15369e9105cb8ed9e6fd869b9e9a27c2fd20017ca3af268eb168226082b3a` | `7d90ab32d46991dbf95d47a6343b1175752be391955506129699f635e2d076ce` |
| `writerPins().protocolDigest` | `e75cd049846d1c6d478187752f03df87c945f295e2fb63445b272d67104e7aa6` | `ce52de214ead5c3e3024a76fd1d321a4e7153dc8cdad3c062571885b5a1587f2` |
| `writerPolicyHash('{"a":1}')` | `19004d2f…ba1a36e7` | `9bfc2745d103ec7b5eede6b9ab46c678dc7186dd650f8ca9b756f8809b76ef85` |
| `…, true` | `a9ab52b7…da2ec59d` | `4f1bec1784e01e9e62f5103a88b833e484abdbc07a40c6edea09126fa9b3c6ed` |
| `…, true, true` | `03bd1819…cc1918984` | `eca0cb9938068be14fe8b2b834e81c8cf9b3669543730132cfb92b750e48e581` |

Files: `writer.md` `b82e980f…e1b3a5b1` → `a7f0f55db48c51d6bfbceda8e56ead8a9aad00568ede13db04c4f596b4224425`; `guard.md` `d3fb5ee3…e64c8f08` → `399f9c19007e78c56d02b1dd6c63ff956042b5b09f5675cba97dcec40deaaeca`; the others (cast-context, directions, the three addenda) are byte-identical. `WRITER_PROFILE_SHA256` and `WRITER_MEMES_SHA256` do not move. The generation Worker refuses a v8 request whose bundled files do not hash to the pin, so **deploy generation before business**. The 37a-3 addenda are untouched and still appended per model (asserted).

## 多轮预演 「v8 规则 56」
Built-in set `rules-56` (9 turns, listed last), paraphrased from samples A–G: 宝宝 at turns 1, 2 and 3, each with a feeling; a confession; agreeing on names (小团子 / 小宝); a nickname the player gives her (团团); a role name (`{饰演}`); a name she called herself earlier (`{别名}`); and 「你今天吃了什么」. The marks are filled per character like the 名字 scripts. The owner judges by ear.

## Tests
New `web-rules-56`: rule texts present; sizes < 4,000; 旧 unchanged; guard text and schema (14 reasons); one `applyReview` case per flag (feeling, argued name, 搞混了 to a role name and to a nickname, denied own words, incoherent self-correction rewritten as a whole, a good draft kept and an asked-for pet name never flagged); factOps `称呼 XX`; role names from 其余设定 reach the writer and the guard; the script's order. NAMED EXCEPTIONS (old tests that pinned what this Part changes on purpose): the hashes in `web-writer-v8-37a`/`web-writer-tuning-37a3` (which now reads the pin from this file), `web-memes-37c1`, `web-speech-profile-37b`; `GUARD_REASONS.length` 9 → 14 in `web-writer-v8-37a`, `web-tone-51`, `web-rules-51`; Part 51's rule 3 and presumptuous_address phrase lists in `web-rules-51`; the 对方…饰演过的角色 phrase of rule 5 in `web-own-names-51`; the set labels in `web-rehearsal-35`.
