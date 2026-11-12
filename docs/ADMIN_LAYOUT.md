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
- Named exceptions (own geometry): the rail (`.admin-pick*`), the navigation, whole-card hit areas (`.cc-row-open`, `.cn-add-card`)
  and the 关系 matrix cells and headings (`.cs-cell`, `.cs-head`).

## 2. Fields are as wide as what they hold
`ui/field-width.ts` sets `data-w` from the field's real limit (`maxlength`, see the 24b-7b field table):
`xs` ≤ 8 characters or a number (`--ad-w-xs` 120), `s` ≤ 16 (176), `m` ≤ 40 (352), `l` the 920 px form column, `full` paragraphs
and tables, `fit` a select (the width of its longest option). A short note is an `m` field. A screen may state its own `data-w`.

## 3. An action sits beside its field
Field and button on one row, same height, one baseline (预演: 运行备注, send button and its reason in one row under the input).

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

## 7. The rail
Avatars snap to the top edge of the rail's scroller: none is left half cut under the top edge or a group count.

## Specificity
The system's rules are written last and carry the weight of an id (`:is(.admin-shell, #ad-layout)`), so they win over the
page-by-page rules above them without `!important`. A later correction of a page that still has an id-weighted rule uses the page's
id (`#admin-characters …`).
