# Admin console layout system (Part 24b-7c)

One layout system for every admin page. Layout and styling only; scoped to `.account-admin-page.admin-shell`. The 声音 tab
(`.vc-materials`, Part 30) is never touched: every generic rule excludes it with `:not(.vc-materials *)`. Tokens live at the top of
the Part 24b-7c block in `apps/player-web/src/styles/main.css`; the check is `pnpm check:web:admin-24b7c`.

## 1. Buttons
- Two heights: **compact** `--ad-h-compact` (32) for row actions, chips, tabs, segmented controls, table cells; **standard**
  `--ad-h-standard` (40, the height of a field) for everything else.
- Buttons of one group share one height and either their natural width or one common width. Never one button several times wider
  or taller than its neighbour.
- One solid primary per screen. Icon-only buttons are squares of their height (32).
- Named exceptions (own geometry): the rail (`.admin-pick*`, `.ad-icon-tool`), the navigation, whole-card hit areas (`.cc-row-open`, `.cn-add-card`)
  and the 关系 matrix cells and headings (`.cs-cell`, `.cs-head`).

## 2. Fields are as wide as what they hold
`ui/field-width.ts` sets `data-w` from the field's real limit (`maxlength`, see the 24b-7b field table):
`xs` ≤ 8 characters or a number (`--ad-w-xs` 104), `s` ≤ 16 (176), `m` ≤ 40 (352), `l` the 920 px form column, `full` paragraphs
and tables, `fit` a select (the width of its longest option). A short note is an `m` field. A screen may state its own `data-w`.

## 3. An action sits beside its field
Field and button on one row, same height, one baseline (预演: 运行备注, send button and its reason in one row under the input).

## 3b. Inline add bars and filter bars (round 2)
A bar that fits one row at 1440 stays one row (it may wrap cleanly at 1280). Numbers are `xs` (`--ad-w-xs` 104, room for 5 digits and the
spin buttons); a note in a bar is an `m` box; the action follows the last field it belongs to at one field gap (8 px) and is never alone
on a row or at the far edge. Covered: 邀请与额度's new-batch form, 积分发放 (send bar, 共创积分), 管理员与权限's note + presets, the page
header bars (总览, 消耗表, 模型与价格, 系统状态) and 共创收件箱's status/star/search line. The 共创 role-chip list is data-driven (one chip per
role) and wraps by design: a named exemption. The audit also checks that a placeholder fits its box.

## 4. Vertical rhythm (tokens)
`--ad-sp-1` 4 label → field · `--ad-sp-2` 8 related checkboxes, buttons of a group · `--ad-sp-3` 12 inside a row of controls ·
`--ad-sp-4` 16 field → field · `--ad-sp-5` 24 section → section, the largest gap anywhere. No section heading without content: an
empty section shows a one-line empty state or does not render (an empty confirmation slot takes no row).

## 5. One grid
Labels, fields and buttons share the left edge of the 920 px form column; row actions share one right edge; tables align numbers
right and text left.

## 6. Long sentences next to controls
They become a short label (`data-short`, shown by CSS) with the full sentence as the label's text and hover tip
(发布: 已核对差异与预演).

## 7. The rail (Part 24b-7f, round 3)
One column of avatars, **64 px at rest**; it grows to 212 over the page on hover or focus (the page does not move) and everything else opens with it.
- **A group heading is ONE row:** collapse chevron, label (「当前阵容」) and count, 32 px high (`--ad-h-compact`). At rest the label has no room
  (chevron and count share the row); it opens with the rail (200 ms, `--ad-t-slide`).
- **新建 / 导入 / 首页顺序 are three icon buttons** at the foot of the rail: 32 px squares in ONE row when the rail is expanded (at rest only
  新建 is shown; the other two open with the rail), each with an `aria-label` and the console's hover / focus tip (`ui/icon-tool.ts`).
- **15 avatars without scrolling at 1440×900:** the pitch is 42 (`--ad-rail-pitch`: a 36 px avatar, never below 32), the heading is one pitch,
  and the scroller is a whole number of pitches in what the rail's own height (the window less its top 104 and its 48 px foot, which keeps it
  still when the page scrolls) leaves after its chrome (58): 16 at 900 high. At 1280×800 it holds 14 and scrolls inside itself; avatars snap
  to its top edge and the open character is kept in view.
- Avatars never move when the rail grows; the name and the state word come with the rail.

## 8. The top spacing of a workbench tab
Every tab's first content starts the card body's 24 px under the tab bar. A section that holds nothing visible takes no row, the first node
of a tab (`.wb-first`) has no step above it, and a fold that opens a tab has a compact (32) heading row. Check: `check:web:admin-24b7f`.

## 9. Type size
`--ad-fs-body` (13 px) is the size of body text: the rows of a list and the lines of a conversation (测试对话) are one size.

## Specificity
The system's rules are written last and carry the weight of an id (`:is(.admin-shell, #ad-layout)`), so they win over the
page-by-page rules above them without `!important`. A later correction of a page that still has an id-weighted rule uses the page's
id (`#admin-characters …`).

## 10. Tables that do not fit (round 3)
A table never makes the page wider and its text never overlaps. Each column fits its content (a fixed track where the values are short and
mono, `ui/open-table.ts` `width`); text wraps or is cut with the full value on hover; numbers are right-aligned and so is their header, text
is left. A table that still does not fit scrolls INSIDE its own card (`overflow-x: auto`, like Part 44's `.rh-scroll`): 系统状态's 技术指标
(eleven columns), 未确认的调用 and 清理失败明细. Check: `check:web:admin-24b7f` (section F).

## 11. Button text (round 3)
A button is as wide as its label (`white-space: nowrap`, `min-width: min-content`) at one of the two heights; buttons of a group may share the
widest label's width. The audit (`scripts/admin-button-audit-24b7g.ts`, run by `check:web:admin-24b7f` on every page, open state and workbench tab
at 1280 and 1440) fails on a clipped or wrapped label. Named exemptions: the whole-card hit areas of §1, the rail, the 声音 tab, and what is inside
Part 44's `.rh-scroll`.

## 12. Collapsible sections (round 3)
One pattern for every native `<details>` with a disclosure header: a compact header row (chevron, then its text); the body starts under the
header's TEXT (`--ad-fold-indent`, 30 px), 8 px below it, behind a hairline that runs down from the chevron, so header and body are one
unit; a section inside a section steps in once more per level. Opening and closing animate height and opacity with `--ad-t-open` (nothing under
reduced motion) and the body stops clipping once open. Table rows that open below (`.ot-detail`) start under the row's text; danger zones and
the 预演 settings line step in one level.
