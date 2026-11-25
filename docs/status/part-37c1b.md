# Part 37c-1b — 网络梗: re-curated for companionship chat, an editable library, a 「待审」 queue

## Why
Burbur is a companionship chat with fictional idols for trend-aware Chinese-speaking young women (mostly under 25). The 37c-1 dictionary (1,806 entries) was about half AI / tech / hardware / finance / policy terms. Only memes a girl would plausibly say, or understand at once, while chatting with a friend or her idol belong. The owner must also be able to add, edit, delete and import memes himself, and NOTHING new may enter the library without his confirmation. Part 37c-2 will later add two automatic sources (梗雷达, 玩家聊天) into the queue built here.

## 1. The re-curation (judged entry by entry, by hand)
All 1,806 entries were read one by one (term AND meaning). No keyword or tag filter decided anything, no model call was made. Every entry now ships with a **category** and a **default on/off** (`data/chinese-meme-dict/memes-2022plus.json` field `c`; `meme-dictionary.generated.ts` rows are `[term, meaning, year, tags, shipsOff, category, everyday]`; `node scripts/build-memes.ts --check` fails on an unknown category or stale counts).

| Result | Count |
|---|---|
| **Kept** (ship ON unless an everyday word) | **572** — 心情 98 · 关系 93 · 日常 224 · 追星娱乐 54 · 句式 103 |
| Dropped: AI科技 | 823 |
| Dropped: 硬件汽车 | 98 |
| Dropped: 金融 | 67 |
| Dropped: 时政 | 30 |
| Dropped: 真人 | 86 |
| Dropped: 不雅 | 12 |
| Dropped: 非日常 (the GRAY rule: a drama / TV / viral-event phrase that did not become an everyday phrase) | 118 |
| **Ships ON** | **546** (the 572 kept minus 26 of the 72 everyday words) |
| **Ships OFF** | **1,260** (1,234 dropped + the 26 kept everyday words) |

The 72 everyday-word defaults of 37c-1 (jieba frequency list) are **still off** (flag `everyday`, asserted). 「非日常」 is a seventh drop reason beyond the six the owner named: the gray rule says "otherwise drop", and a dropped drama phrase fits none of the six. The full list of kept entries (term — one-line meaning, by category) is `docs/status/part-37c1b-kept.md`.

Ten drops I was unsure about (all dropped, all one switch away from ON): 79元眉笔 (a brand scandal, but an everyday price ruler), AI手办, AI男友, AI写真 (girls do use these, but they are AI products), 上春山 (a gala song, not a phrase), 中年返贫 (a money worry, but not a under-25 one), 中登 (老登's cousin: mean), 减肥神药 (a drug an idol should not promote), 吉卜力化, 吉卜力风 (a filter trend that is really an AI tool).

## 2. The editable library (角色 → 网络梗)
The library = the shipped entries (as re-curated) + the owner's own entries, with his edits, switches and deletions applied. Cap **5,000** (shipped entries that are not deleted + own).
- **添加词条**: term ≤ 40, meaning ≤ 200, category from the five, year optional; the entry starts ON, source 手动. A duplicate term (own, shipped, or in 已删除) is refused (`MEME_DUPLICATE`, whose detail names the existing entry) and the form offers a link to it.
- **编辑** the meaning and category of ANY entry. A shipped entry gets an *override* (the shipped text stays); **恢复原文** restores it. A shipped entry that carries an edit shows 已改.
- **开关**: any entry, own or shipped, both ways over the shipped default.
- **删除**, single or bulk: his own entries are deleted for good after an in-place confirm that says so (the one explanatory text on the page); shipped entries move to **已删除** (filter on the page) and are restored there with their switch and edit. A deleted entry no longer matches and no longer counts.
- **导出** (Part 57) gained 分类, 来源 (自带 / 手动 / 上传, later 梗雷达 / 玩家聊天) and 已删除 at the END of the columns (the first six keep their place).
- Every row shows 分类 and 来源; filters: 分类, 来源, 年份, 标签, 状态 (全部 / 已开启 / 已关闭 / 默认关闭 / 已删除), search. The head reads `共 N 条 · 已开启 N 条 · 待审 N 条`.
- Everything is **live** for the next reply (not through 草稿 / 正式版本); a reply already in flight keeps the entries it froze. Every change leaves one audit row (who, which action, when, counts only — never a term).

## 3. Bulk import → 待审
上传导入: a CSV, a .xlsx (read on the server: zip + XML, no library) or pasted rows (tab- or comma-separated); the first row names the columns 词 / 释义 / 分类 (or term / meaning / category; extra columns ignored); max **2,000 rows** per upload. 预览 shows EVERY row with its status or reason (`EMPTY_TERM`, `EMPTY_MEANING`, `TERM_TOO_LONG`, `TERM_TOO_SHORT`, `MEANING_TOO_LONG`, `BAD_CATEGORY`, `DUPLICATE_IN_FILE`) — nothing is dropped silently. Rows that pass go to 待审 with source 上传; nothing goes straight into the library. A row for an existing term shows the current entry and the new version side by side (approving updates it); a row for a term the owner deleted is flagged 曾删除 (approving brings it back); an identical row is 「没有变化」. Whole-file refusals: `MEME_IMPORT_EMPTY`, `MEME_IMPORT_COLUMNS`, `MEME_IMPORT_TOO_MANY`, `MEME_IMPORT_FILE`.

Limit worth knowing: an export of a library with more than 2,000 rows cannot be uploaded back in ONE file (the page's filters make an export smaller; the round-trip test uses the whole library, 1,806 + a few).

## 4. The 待审 queue
Each item: term and meaning (both editable before approving), category, source, date (links and a player count are stored for 37c-2 and shown when present — never a player or a message). 通过 → the library, ON; 不要 → dismissed (the same term from an automatic source is never suggested again); bulk 通过所选 / 不要所选. A term the owner deleted is also never suggested again by an automatic source. 37c-2's only door is `suggestMeme(store, now, {term, meaning, category, source: 'radar' | 'chat', links?, playerCount?})` in `apps/server/memes/web-meme-library.ts`: it can only fill the queue (`queued` / `dismissed` / `deleted` / `exists` / `already-queued` / `invalid`).

## Storage (no migration 132)
A SECOND digest-checked runtime step beside 37c-1's on/off table, installed at business-object start (`installMemeLibrary`): `web_memelib_entry` (own entries), `web_memelib_override` (edits of shipped entries), `web_memelib_deleted` (shipped tombstones, restorable; own tombstones, the term only), `web_memelib_queue`, `web_memelib_dismissed`, `web_memelib_schema`. A shipped entry's on/off stays in `web_meme_switch`. No column holds a player id, nickname, email or message. Every write is idempotent per request id (`web_admin_actions`), CSRF/Origin like every administrator write, `cast.edit` (reads `cast.read`) — the same permission the page has today; the business object is the only writer.

STOP codes (all new, with their sentences in `error-sentences.ts` and statuses in `web-refusal-status.ts`): `WEB_MEMELIB_SCHEMA_MISMATCH` (start-up), `MEME_DUPLICATE`, `MEME_LIBRARY_FULL`, `MEME_QUEUE_NOT_FOUND`, `MEME_TERM_EMPTY`, `MEME_TERM_TOO_LONG`, `MEME_TERM_TOO_SHORT`, `MEME_MEANING_EMPTY`, `MEME_MEANING_TOO_LONG`, `MEME_CATEGORY_INVALID`, `MEME_IMPORT_EMPTY`, `MEME_IMPORT_COLUMNS`, `MEME_IMPORT_TOO_MANY`, `MEME_IMPORT_FILE`. (`WEB_MEME_SCHEMA_MISMATCH` and `MEME_NOT_FOUND` are unchanged.)

## Matching
Writer 新+档案+梗 and 多轮预演 match against the **effective library**: `readMemeLibrary(store)` → the keys off (shipped off/deleted/switched off, own off), the owner's own entries, his edited meanings → `matchMemes(texts, off, use, max, library)` (a fifth optional argument, the shipped library by default, so every earlier call keeps its meaning). A 多轮预演 run freezes that layer at its start (`memeOff`, `memeOwn`, `memeMeanings`); a run frozen before this Part counts against the shipped library as before.

## Pins
旧, 新, 新+档案 **and 新+档案+梗** are all unchanged: the matching rules, constants and words did not move, so `WRITER_MEMES_SHA256` is still `a43554c584cadef62dc5b9ed1041268d1f0505f6cfff59d635502e3c35c6a485` (asserted, with the other three pins, in `web-memes-37c1b.integration.test.ts`; the values equal those taken from origin/main). expected-migrations byte-identical: 56 inline + 56 R2, last 131 sha256 `a6f581dd6b9bf482d72c035dd6d693b5a4330aae195123aef16106e0e370990a`.

## Named exceptions to earlier tests (never deleted, only narrowed, each commented in place)
- `web-memes-37c1.integration.test.ts`: the pinned counts 72 / 1,734 / 1,733 / 73 follow the new default (`SHIPS_ON = 546`, `SHIPS_OFF = 1260`).
- `web-memes-37c1.test.ts`: `DEFAULT_OFF` now follows the `everyday` flag (the 72 words that test is about).
- `web-export-57.test.ts`: the 网络梗 header gained three columns at the end.
- `check-web-memes-37c1-browser.ts`: the same counts; the head line is `共 N 条 · 已开启 N 条 · 待审 N 条` and the 默认关闭 count moved into the 状态 option's label.

## UI and passes
#57 components (`data-table`, `segmented`, `drawer`, `inline-confirm`, `page-head`, `hover-value`, `error-line`), desktop only, every transition under `--ad-motion`, one control height. Impeccable is not installed in this environment, so critique, audit and polish were done by hand on 1440×900 screenshots of the page, the add/edit form, the delete confirm, the import preview and the queue (branch `review/part-37c1b`). First pass found: the add/import buttons wrapped to a second filter row (moved into the title row, 添加词条 as the one solid button); the 曾删除 chip sat in the comparison grid as a cell (moved into the label row); the queue card was tall (term and category now share a row); the category select overflowed its card (a global `min-width` on selects); a read-only term looked editable (tinted). Audit after the fixes: no horizontal scroll, every action has a hover tip, the only explanatory sentence is the permanent-delete confirm, no raw code in visible text.

## Tests
`web-memes-37c1b.integration.test.ts` (17 tests: re-curation counts and standard, dropped never match until on, the runtime step and its STOP, add / duplicate / limits, edit and 恢复原文, delete own / shipped / restore / bulk, the switch both ways, the 5,000 cap, upload valid / invalid / 2,000 cap / csv / paste / xlsx, side by side and 曾删除, the queue with edits and dismissal with a fake automatic source, 多轮预演 counts on the effective library, the live request, permissions / CSRF / audit / routes / no player columns, the export round trip csv and xlsx, the four pins), browser `scripts/check-web-memes-37c1b-browser.ts`.
