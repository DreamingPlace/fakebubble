# Part 22b screenshots (desktop, 1440 × 900)

Real admin client build (`pnpm web:player:build`) in Chromium against a **stubbed admin API** (canned responses shaped like the
server's; the server behaviour itself is covered by the workerd tests in the PR). Not for merging into `main`.

| File | What |
|---|---|
| 01-nav-and-overview.png | New navigation (概览 first; 玩家: 邀请与额度 / 积分发放 / 玩家统计; 运营: 消耗表; 系统: 模型与价格 / 系统状态 / 管理员与权限) and 概览 |
| 02-system-status.png, 02b-system-status-top.png | 系统状态 (full page / top): a price 24 days from expiry highlighted, a capped DeepSeek budget and an unlimited Fish budget |
| 02c-system-status-retention.png | 系统状态 → 清理 with two failing principals: phase / sub / errorName / messageShape and the count, no ids |
| 03-dialog-renew-prices.png | 续期价格 confirm |
| 04-dialog-budget-topup.png | 预算充值 confirm (provider, amount, new remaining) |
| 05-points-email-lookup.png | 积分发放 by email: the lookup shows 玩家编号, tier and balance only |
| 06-dialog-points-by-email.png | 积分发放 by email confirm (no email echoed) |
| 07-points-skipped-counts.png | 积分发放 result with skipped counts |
| 08-dialog-reset-all.png | 重置全部额度 confirm with the new rule/copy (daily_refill +7 days on top, up to the cap; 已达上限 counted) |
| 09-nav-points-grant-admin.png | An administrator holding only `points.grant`: 概览 and 积分发放 |
