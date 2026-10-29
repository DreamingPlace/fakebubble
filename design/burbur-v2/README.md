# Burbur design v2 (reference only — not shipped code)

Exported from the owner-approved design canvas (2026-10-23). Each `*.dc.html` is one artboard written in the
Design Component format: plain HTML + inline styles in `<x-dc>`, `{{holes}}` filled by the `renderVals()` script at the
bottom, `<sc-for>` / `<sc-if>` for loops and branches, `<dc-import name="X">` = the sibling file `X.dc.html`.
They do not run outside the canvas (they need its runtime); read them for exact colors, sizes, spacing, copy, states and
motion (`@keyframes` in each `<helmet>`).

Player screens (390×844, mobile Safari; grey bands = browser chrome, not part of the design):
- Language.dc.html — the 小卡 (photocard) design language: palette per character, type, shapes.
- Naming.dc.html / Hand.dc.html — Burbur wordmark + logo; Hand = the hand-lettered SVG path generator.
- Motion.dc.html — every transition.
- Main.dc.html (home + swipe), Chat.dc.html, Shared.dc.html (voice card; later Part),
  MyInfo.dc.html, Models.dc.html, Cocreate.dc.html, Login.dc.html, Billing.dc.html.

Admin console (desktop, UTC): AdminNav, Dashboard, Invites, Stats, Usage, System, Workbench, Cast, Inbox.
Sample data and "[示例]" text in the boards are placeholders, never real character content.

## Admin V3 (owner-approved 2026-10-29) — folder `v3/`

These replace every older admin board above (Dashboard, Invites, Stats, Usage, System, Workbench, Cast, Inbox,
AdminNav, WorkbenchV3). Palette is D1 (Palette.dc.html) unchanged. Numbers and names in the boards are sample data.

- NavV3 — sidebar. 玩家统计 is gone (merged into 总览).
- Framework3 — the rules every page follows: three layouts (numbers / click a row → detail opens BELOW it, full width /
  workbench), one 56 px title row (name left; one status line + the only solid button right), amber = not saved yet,
  hover shows the exact value on every chart point and table cell, danger actions at the bottom (open → type the name →
  hold 1.5 s; no modal), motion timings.
- Workbench4 — 角色工作台: character rail collapsed to colour circles, expands over the page on hover/focus; the middle
  has ONE section bar, clicking a section pops that section in and replaces the previous one; 预演 is the last section
  (controls + chat + full-width results table, click a run → its lines open below, tick two runs to compare);
  放弃服务器草稿 / 删除角色 at the bottom of 发布. 成长中 switch (Part 24c) in 身份与展示 + title row tag + dashed ring.
  Weighted welcome lines (欢迎内容) and 不公开设定 / 演绎说明 need server work (later Parts).
- Cast3 — 关系与故事: only what is BETWEEN characters. 15×15 grid with horizontal headers; click a name → that
  character's NAME CARD (names, nicknames with attitude, one-liner, prototype) + "他看到的"; click a cell → the pair
  (two directions: half-star rating incl. 0 and 未设置, 称呼, 相处) + their shared stories; a story opens below
  (participants picked by clicking names, 谁知道 computed, click to override, orange = manual); 组合 shows only groups
  containing the selected people (+ "全部 n 个"); one compact 世界 card (background + chips of the world's other people).
  "整页版本" strip: published versions and draft saves (per-admin colour squares need server work).
- Inbox3 — 共创收件箱: fixed-size cards (3 per row, text fades, card never grows); clicking a card opens the detail
  under its row: the note on the left, the target section of that character's DRAFT on the right; "加入草稿" appends
  the note there in amber, editable, then 保存草稿 (or 加入关系与故事 for pair/story notes). 管理员备注 is removed.
- Invites3 — one full-width create bar; click a batch → its codes table opens below, full width, copy per code.
- Overview3 — 总览 with 玩家统计 merged in: one range (24H/7/30/90 天) + 导出表格 for the whole page.
- Usage3 / System3 / Points3 (incl. 共创积分 settings, Part 24c) / Models3 / Members3 — same frame and rules.
