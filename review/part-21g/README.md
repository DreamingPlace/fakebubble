# Part 21g screenshots (系统 → 模型与价格)

Rendered from the real page code (`startAccountAdminPage`) with a mocked admin API; Chromium 1280x860 and 390x844. Not part of the PR diff.

| File | Shows |
|---|---|
| desktop-1-table | The table for the owner: models x (总开关 / 游客 / 注册玩家 / 受邀玩家 / 每条点数 / 状态), 语音加点, 保存, 最近修改 |
| desktop-2-confirm | 保存 asks first and lists every change |
| desktop-3-saved | After a save |
| desktop-4-unconfigured-and-empty-tier | A model outside the environment ceiling reads 未配置; emptying the guest tier is refused before sending |
| desktop-5-readonly | An administrator without models.manage: can read, cannot change or save |
| desktop-6-permission-matrix | The new 模型与价格 group (models.manage) in the permission matrix |
| mobile-1-table | Phone layout (cards per model) |
| mobile-2-confirm | The confirmation on a phone |
| mobile-3-readonly | Read-only on a phone |
| mobile-4-other-page-keeps-notice | Every other console route still shows the desktop-only notice |
