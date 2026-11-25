# Part 57 — Export everything worth reviewing

## Why
The owner reads players' test conversations one by one, which is too slow to find problems or study preferences in bulk, and other data (the provider-call ledgers, the failed replies) could not be exported at all. Every page that shows data now has ONE 「导出」 button, top right of its title row.

## 1. Audit — every admin page and section that shows data
"Today" = what could be exported before this Part. "Worth" = worth a table for review. 「导出」 = added here.

| Page | Section / data | Exportable today? | Worth exporting? | Now |
|---|---|---|---|---|
| 总览 | tiles, trend (回复 / 聊天人数 / 活跃, 24H–90 天), 按天 table, 按角色, 按模型 | CSV (the daily table only, via 导出表格) | **yes** | 导出 → 每日统计 · 按角色 · 按模型 · **每小时** · 每日消耗 · 消耗明细 · 按玩家类型 |
| 总览 | the 系统状态 warning line | no | no (one sentence) | — |
| 角色工作台 | profile, 草稿, 版本历史, 说话档案, 声音 / 素材 | no | no (it is the content itself, already versioned and diffable) | — |
| 角色工作台 | 单次预演 runs | JSON + CSV per run (Part 13b / 35) | already | unchanged |
| 角色工作台 | **多轮预演** runs (lines, scores) | no | **yes** | 导出 (the 多轮预演 panel) → 预演轮次 · 对话 · 评分 |
| 角色工作台 | 审核对比 | no | low | — |
| 关系与故事 | the cast draft / published versions | yes (cast file, 24b-5) | yes | unchanged |
| 共创收件箱 | notes (card, 题目 / wording, text, status, adoption, points) | no | **yes** | 导出 |
| 共创收件箱 | 玩家眼中的关系, 题目 pool | no | low | — |
| 网络梗 | the 1,806-entry library and its switches | no (Part 37c-1b has no export on main) | **yes** | 导出 (the whole library under the search / year / tag / state on screen) |
| 邀请与额度 | batches, codes, allowances | one batch's codes (CSV, masking rule of the page) | **yes** | 导出 → 批次 · 邀请码 (always masked) · 额度. The per-batch 导出表格 stays. |
| 积分发放 | grants, 共创积分 numbers | no | low (an action page; its audit rows are the record) | — |
| 广播 | history (status, time, counts) | no | **yes** | 导出 |
| 消耗表 | per day / model / phase, spend by player type | CSV (消耗明细 only) | **yes** | 导出 (the same tables as 总览) |
| 测试对话 | transcripts | CSV of one conversation or one character | **yes — the priority** | 导出 → 对话消息 (one row per message + 按对话汇总) · 失败的回复 |
| 模型与价格 | models, prices, 回复写法, 审核模型 | no | low (settings; changes are already recorded) | — |
| 系统状态 | versions, migrations, prices, budget, retention, security counters | no | no | — |
| 系统状态 | provider / external / embedding calls, 结果未知的调用 | counts only | **yes** | 导出 → 模型调用 · 外部调用 · 向量调用 · 结果未知的调用 |
| 系统状态 | failed replies | only inside a conversation | **yes** | 导出 → 失败的回复 |
| 系统状态 | share-link counts | no | yes | 导出 → 分享链接 |
| 系统状态 | 技术指标 (stage latency) | no | low | — |
| 管理员与权限 / 我的账号 | members, grants, own login | no | no (identity and permissions) | — |

## 2. What was added
One server entry, `POST /api/web/local/admin/export/file` (and `…/export/allowed`), served by `WebExportAdmin` (`apps/server/export/`), which reads the same tables as the pages, builds the table in memory and returns ONE file per request (CSV text, or a base64 .xlsx). Nothing is written to disk or kept: no file, no cache. A table over 50,000 rows is **split into parts** (`part` / `parts` in the answer, one file each, named `…-1of3.csv`); the dialog asks for the parts one after the other. The cap per export is 500,000 rows (`EXPORT_TOO_LARGE` asks for a narrower range).

Both formats: CSV is UTF-8 with a BOM, CRLF, and a leading TAB on any cell that could be read as a formula; .xlsx is hand-written OOXML in a zip (deflate, no library; inline strings, so a cell is never a formula; frozen bold header). A CSV carries one table (the dialog asks which; the file name has an ASCII word for it); a workbook carries them all. All times are **UTC+8** (statistics keep their UTC day / hour).

### Tables and columns
- **对话消息** (conversations; filters: UTC+8 date range, 角色, 范围 live / archived on the page, 回复写法, 模型, 状态, 玩家): 对话编号 · 时间（UTC+8） · 说话人 · 角色 · 内容 · 方式 (语音 / 文字) · 回复写法 · 草稿模型 · 审核模型 · 审核改动 · 改动原因 (the guard's reason codes) · 状态 (已发布 / 失败 / 结果未知) · 错误代码. **按对话汇总**: 对话编号 · 角色 · 消息数 · 第一条时间 · 最后一条时间 · 失败数.
- **失败的回复**: 时间 · 角色 · 回复写法 · 草稿模型 · 审核模型 · 失败阶段 (草稿 / 审核 / 语音 / 未到模型调用) · 状态 · 错误代码.
- **调用记录** (date range, 供应商, 状态): 时间 · 种类 · 供应商 · 模型 · 阶段 · 状态 · 结果 · 错误代码 · HTTP 状态 · 预留金额 · 实际扣款 · 已过时间（分钟）, four sheets: 模型调用, 外部调用 (target = the provider; no amounts), 向量调用, 结果未知的调用.
- **统计** (7 / 30 / 90 天): 每日统计 (the 总览 day table) · 按角色 · 按模型 · 每小时 (`web_stats_hourly`, kept 48 h) · 每日消耗 · 消耗明细 · 按玩家类型.
- **共创收件箱** (filters of the page): 时间 · 玩家代号 (the inbox's own anonymous code) · 类型 · 角色 · 关系中的其他角色 · 卡片 · 题目 / 措辞 · 内容 · 状态 · 星标 · 是否采纳 · 采纳时间 · 积分（已发放）.
- **网络梗**: 词 · 释义 · 年份 · 标签 · 状态 · 默认关闭. **邀请与额度**: 批次 / 邀请码（始终 ********）/ 额度. **广播记录**: 状态 · 时间 · 角色 · 收件人数 · 已送达 · 进度 (counts; no text, no player). **分享链接**: 已创建 · 已打开 · 已过期 · 仍有效. **多轮预演**: 预演轮次 · 对话 (the script's line, the replies) · 评分 (the counts and the style judge).

## Permissions, privacy, audit
- Conversations, failures and calls: **the owner only** (a delegated 测试对话 reader has no button and gets `ADMIN_OWNER_REQUIRED`). 统计: owner or `stats.read`. 网络梗: owner or `cast.read`. 邀请与额度: owner or an invite permission. 分享链接: owner or `system.read`. 广播, 多轮预演 and 共创收件箱 go through the page's own reader, so they have exactly the page's permission. The permission is checked before the filters are read.
- Every file is built from whitelisted columns; nothing reads an id, email, nickname, IP hash, token, request / response body or a receipt beyond `errorCode` / `code` / `httpStatus` / `status` (each checked against a fixed shape). Conversations use the review page's pseudonymous code and its nickname replacement; every text cell then passes one more scrub (an email, a UUID or a 32+ character hex string a player typed becomes 〔邮箱〕 / 〔编号〕). The candidate's text is never read: only the list of guard reason codes inside it.
- **One audit row per file** (`web_admin_audit`: the administrator, `export:<kind>`, format, part n/m, the row count, the filters; players are counted, never listed; no content). A refused export writes nothing.
- No migration, no new table: `expected-migrations` is byte-identical (56 inline + 56 R2, last 131 = `a6f581dd…990a`); no prompt / policy hash changed.

## Limits worth knowing
- A call's **HTTP status** is not stored as such; the column is filled only when the receipt carries one (the error code names the class, e.g. `…_RATE_LIMITED`). External calls carry no amount.
- **Guard reason codes** and models exist only while the reply's rows exist; an archived (deleted-account) transcript has neither, so the 回复写法 and 模型 filters leave archived lines out. 失败的回复 reads the operations still on the books: a purge removes them, the daily counters in 统计 keep the counts.
- A browser may ask permission to save several files at once when a table is split.

## Tests
`tests/web/unit/web-export-57.test.ts` (columns, every filter, the 50,000-row split, BOM, xlsx validity, permissions, the audit row, and a scan of every file of every export for ids, emails, nicknames, IP hashes and tokens) and `scripts/check-web-export-57-browser.ts` (the button of every page at its title row, the dialog, a real 50,010-message chat saved as two files, a delegated reader refused, the same scan on every saved file).
