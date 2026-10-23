# Part 22c screenshots (desktop, 1800 × 1500)

The real admin client build (`pnpm web:player:build`) in Chromium against a real, migrated provider-local instance served by the real
server (`pnpm check:web:stats`, `scripts/check-web-stats-browser.ts`), signed in as the owner. The instance's clock stands on
**2026-11-20** and its counters started on **2026-11-03** (so the month holds 2026-11-12, the day Fish Drama 3's list price changes, and
the days before 2026-11-03 show — in the ledger column). The **numbers are synthetic**: a seeded generator wrote them straight into
`web_stats_daily` / `web_provider_usage`, so these show the layout of a busy site, not a real one. What the real reply pipeline writes
is covered by `web-stats-22c-http` (workerd) in the PR. Not for merging into `main`.

| File | What |
|---|---|
| 01-overview-with-stats-line.png | 概览 with the new line: yesterday's 新注册 / 活跃 / 回复 and this month's spend in RMB (owner and `stats.read` only) |
| 02-player-stats-7-days.png | 玩家统计, 最近 7 天: daily table (newest first), totals row, 次日留存 as "x / y (%)" and — while a cohort is open |
| 03-player-stats-30-days.png | 玩家统计, 最近 30 天 (from the day the counters started) |
| 04-player-stats-by-character.png | 按角色: display names, never an id |
| 05-player-stats-by-model.png | 按模型 (a reply admitted with model choice off reads 未选择模型) |
| 06-costs-month-spanning-2026-11-12.png | 消耗表: "按 1 美元 ≈ 6.7 元估算", this UTC month in USD and RMB, the Fish Drama 3 note row, cost per published reply, points spent |
