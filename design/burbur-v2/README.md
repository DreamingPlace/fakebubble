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
