# Part 55 — co-creation: adopt fast, in bulk, without draft errors

Branch `part-55`; screenshots on `review/part-55`. No migration 132: expected-migrations are byte-identical (56 inline + 56 R2, last 131
`a6f581dd6b9bf482d72c035dd6d693b5a4330aae195123aef16106e0e370990a`). No new table, no runtime step.

## What the owner reported, and the cause of each
1. **Single-character answers had no 采纳.** An answer of a character note (the five themes, a part of 一天, a dialogue) could only be
   put into the amber editor (加入草稿 → edit → 保存草稿), which saves the draft from the PAGE and then marks the answer. Only relation
   notes had a 采纳 (`relation/adopt`, written by the server). So an adoption needed an editor round trip per answer and was easily
   skipped, and the author's +20 never came.
2. **Processed items stayed in the list.** The list opened on 全部 and only a filtered list dropped a card whose status changed.
3. **「世界设定草稿刚刚有了新的保存，请重新打开后再采纳」** (`CAST_REVISION_CONFLICT`). `relation/adopt` and `cast-story` compared the
   cast draft's revision the PAGE had read (`castRevision` from the relation detail / `cast.draft()`) with the stored one. Adopting one
   note bumps the revision, so the next note (whose detail was read before) always met a stale number.
4. **「草稿的版本号接不上当前正式版本」** (`INVALID_DRAFT_VERSION`, with `LIVE_VERSION_CONFLICT` and `DRAFT_CONFLICT` as its relatives).
   `WebCharacterAdmin.save` required `template.version === (live version) + 1` and the page's draft revision to be the stored one.
   The page computes `version` when it reads the character (`live + 1` when there is no draft). Anything that changes the live version or
   the draft after the page read it makes the number wrong: a publish (it consumes the draft and moves live), a restore (a new live
   version while the draft keeps its old base), or an adoption that started a draft from a cached read (`templateOf` cached the
   character once per open note). Before, the server could only refuse; now it merges (below).

## The new adopt flow
- **`cocreation/adopt-answers`** (`WebCocreationRelations.adoptAnswers`, route key `items`, 1–100 items `{id, ordinal, destination?}`).
  Each item is its OWN transaction inside the business object: merge the answer into its destination, mark it adopted, move the
  submission to 已处理, pay the author. The client sends **no revision**.
  - character answers → the character's 草稿 (`WebCharacterAdmin.adoptIntoDraft`: reads the draft's CURRENT revision in the
    transaction; no draft yet → started from the live version, one version ahead; never publishes). The destination is the card's
    own unless the admin picked one: a part of 一天 → 一天的安排; a dialogue → 说话样本 under 日常闲聊; 说话风格 / 对话方式 → the 核心卡
    (300 characters); free notes and the 「他的近况」 theme → 人设; the other fields as before (`adoptIntoTemplate`). Contract:
    `packages/contracts/cocreation-adopt.ts` (`defaultDestination`, `adoptAnswerIntoTemplate`).
  - relation answers → the 关系与故事 草稿 (`adoptRelationCore`, the same code as the panel's 采纳, at the cast draft's current revision;
    a group of the same members is joined, else a new group with the suggested name).
  - **Points:** the existing `adopt()` — +20 (the 积分发放 setting, `adoptPoints`), once per answer, the six parts of a 一天 once.
  - **Idempotent per answer:** an answer already adopted answers `duplicate: true` and pays nothing again.
  - **Failures are named per item** (`code`, plus `fields` for a field both sides changed); the others still go through. The page turns
    each into a sentence (`docs/ADMIN_COPY.md`, Part 55); never a raw code.
  - Permissions: `cocreation.manage` and, per item, `characters.edit` for that character (the character admin's own check) or
    `cast.edit` for a relation note; session, CSRF and Origin as every admin route; the route takes exactly its keys.
- `relation/adopt` and `cast-story` also lost `expectedRevision` (error 3 is gone).
- **Inbox page:** opens on 新; each answer has **采纳**; 采纳全部（N） on a card with several; 全选 and **采纳所选（N）** in the bulk
  bar (every answer of every ticked card; a relation note goes to 关系与故事; a memo is named, it has no adoption). A card that is
  processed (采纳, 标为已处理, 归档) leaves 新 at once with a short fade (200 ms; none under `prefers-reduced-motion`); the next one
  moves up and opens. 已处理 / 已归档 / 全部 still list it. The amber 加入草稿 editor stays for the admin who wants to edit first.
  First adoption marks the whole card 已处理 (unchanged rule); 采纳全部 is there for a card with more answers.
- The intended flow: adopt in bulk here, then tidy the drafts and publish via 正式版本 in the workbench / 关系与故事 (unchanged).

## The draft rebase (error 4)
- **Characters (server).** `save` still takes the page's `expectedRevision` and profile. When the revision, the draft's base or the
  live version no longer match (or the page's `template.version` is not live + 1) the server does a three-way merge: base = the
  revision the page read (`web_character_revisions`) or, with no draft, the published version before the page's version; mine = the
  page's profile; theirs = what is stored now (the draft, itself first rebased onto the live version if it was started on an older
  one). A FIELD is each key of `template` (except `version`), each key of `template.authorCanon.settings` and each key of
  `presentation`. A field changed on one side only is taken; both sides equal is fine; both different → `DRAFT_FIELD_CONFLICT`
  with the field names (the workbench says 「<栏目>」在别处也改过，不能自动合并). The result is written at `live + 1` with
  `base_version = live`. Code: `packages/contracts/draft-merge.ts`, `apps/server/characters/web-character-rebase.ts`.
- **关系与故事 (page).** The cast keeps one draft row, so the base is the page's own `state.base` (the draft as last read or saved).
  On `CAST_REVISION_CONFLICT` (and when the page loads with unsaved edits over a newer draft) the page reads the newer draft, merges
  with `packages/contracts/cast-merge.ts` (fields: the world background, one entry of a list, the group without its stories, one
  story of a group, one rating cell) and saves on top of it, up to three tries; only a field changed on both sides shows the
  conflict notice, now naming it. Order of a list follows the newer draft.

## Not done / decisions
- The independence check of Part 37b (similar lines in other characters) is a page-side check of the amber editor and is NOT applied to
  the server-side 采纳 (the server has no other-characters read in this path). The 300-character 核心卡 and the 6-per-situation limits ARE.
- 说话风格 / 对话方式 (the 核心卡) can fill up: the next adoption into a full one is refused by name; the admin picks another field.
- A draft on an old base whose live version changed the same field is refused by name (adoption and save alike), never guessed.
- `check:web:*` scripts that opened the inbox on 全部 were updated where they relied on it (the list now opens on 新).

## Tests
`tests/web/integration/web-cocreation-55.integration.test.ts` (20 in a row with publishes between, 20 in one bulk action across three
characters and relations, points once each, duplicates, per-item failures, the 300 card, merge on save, rebase on live move, real
conflict named, the route), `tests/web/unit/web-draft-merge-55.test.ts`, `apps/player-web/tests/components/cocreation-inbox.test.ts`
(55 cases), `cast-24b2.test.ts` (real conflict + merge), browser `scripts/check-web-adopt-55-browser.ts`.
