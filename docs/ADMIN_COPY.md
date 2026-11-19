# Admin console copy (Part 24b-7d)

The words the admin console uses. One word for one thing; plain Chinese everywhere an admin reads. Wording, display formats and the
date control only: nothing sent to the server and nothing stored changes.

## Rules
1. **No raw code in visible text.** An error is the sentence from `features/admin/error-sentences.ts` (≤ 60 characters). The code is
   on hover (「代码：…」) and behind a small **复制代码** action (`ui/error-line.ts`), so it can still be passed to a developer. A code
   with no sentence shows 「失败，没有更多信息。」; add a sentence instead (the 24m test requires one for every workbench code).
2. **Plain headings and columns.** No English heading, column or label except the allowlist: model and provider names (DeepSeek, Fish…),
   24H, UTC, CSV, JSON, Fish ID, file names. Values meant for a developer (a cleanup `阶段` / `语句组` value, a model id) stay as they are.
3. **Dates** are YYYY-MM-DD in one field (`ui/date-field.ts`) with 「UTC」 beside it where the value is a UTC date. No native date input.
4. **Money** in the console's format (`$0.07`, `$0.000 071` for a fraction of a cent); never 「µ$」. **Prices** per million tokens
   (`$1.32 / 百万令牌`), per million bytes (`$15 / 百万字节`) or per call; the exact stored value, in its stored unit, is on hover.
   **Counts** have thousands separators.

## The words
| One thing | Use | Not |
|---|---|---|
| What an admin edits before it goes live | **草稿** | 修订, 服务器草稿 (say 草稿; 「本页修改」 is what is not saved yet) |
| What players see | **正式版本** (short form `正式 v3`) | 现行版本, 线上版本 |
| Putting a draft live | **发布** | 上线 (上线 only means turning an offline character back on) |
| Test run of a draft with the real models | **预演** | 试跑; **试听** is for audio only |
| Going back to an older version | **恢复** | 回滚, 撤回 |
| Taking a character off and putting it back | **下线** / **上线** | 停用 |
| The thing a player talks to | **角色** | 人物 (人物 only in the deletion wording that names a character's data) |
| A player's public id | **玩家编号** | 玩家号, 用户 |
| Who runs the console | **管理员** (the owner is **主管理员**) | 用户, 账号 (账号 is a player's or admin's login) |
| The note under a welcome line (what was happening when it was sent; never spoken) | **情境** (hover tip only) | 备注, 旁白 |
| Voice audio the character plays | **成品** (the slot) · **素材版本** (a set of 成品) | 成品位置, 声音素材 |
| A provider call whose result is not known | **结果未知的调用** / **结果未确认** | UNKNOWN |
| Model-run counts per kind of player | **按玩家类型** | 按用户 |
| Voice id at the voice service | **音色编号** (field 「Fish 音色 ID」) | referenceId |
| Model usage unit | **令牌** | token |
| Login proof (player or admin) | **凭据** | 令牌 |

## Changes made in 24b-7d
| Where | Was | Now |
|---|---|---|
| 系统状态 section | UNKNOWN | 结果未知的调用 (hover says what it means) |
| 系统状态 cleanup table | 阶段 phase · 语句组 sub · 表 table · 错误类 errorName · 信息形状 messageShape | 阶段 · 语句组 · 数据表 · 错误类型 · 信息形状 |
| 系统状态 prices | `1.32 µ$ / 令牌`, 列头「微美元 / 单位」 | `$1.32 / 百万令牌`, column 「价格」, exact stored value on hover |
| 总览 warning | N 个 UNKNOWN 调用 | N 次结果未确认的调用 |
| 消耗表 | 按用户 | 按玩家类型 |
| 声音 / 预演 | 先填音色 referenceId | 先填音色编号 |
| 预演 failed row, 对比 | `…（CODE）` | the sentence; code on hover + 复制代码 |
| 测试对话 failed reply | 回复失败 · CODE | 这条回复没有成功：sentence; code on hover + 复制代码 |
| 预演 detail | `状态：…：CODE · <预演 id>` | the sentence; no id in the text |
| 兑换截止, 设定生日 | native date input | the one date field (YYYY-MM-DD, calendar popover, 7 / 30 / 90 天 / 不限 on 兑换截止) |
| 积分发放, 邀请与额度, 总览 | plain counts | counts with thousands separators |

## Part 39
| Where | Words |
|---|---|
| 共创收件箱, a relation note | 加入：<组合名> · 新建组合 · 整理 · 采纳 · 不采纳 · 不计入 / 计入 (a story goes into the 草稿; nothing reaches players until 发布) |
| second view of the inbox | 玩家眼中的关系 (columns 谁对谁 · 评分数 · 平均 · 分布（0–5 星） · 现在的设定) |

## Part 37a-3
| Where | Words |
|---|---|
| 多轮预演 setup, the toggle beside 带关系与故事 | 评估说话方式 (hover: what the judge reads; each column costs one more judge call, already in the total) |
| 多轮预演 counts, three new rows (only in a run that asked for them) | 说了自己的事 (note: 自己的生活或看法) · 主动起话题 (起了话题或转了话题) · 情绪起伏 (情绪露在用词里). Shown as `n / replies`; 等待 while the judge is out, 未确认 when its result is not known, 未得出 when its answer did not hold |
| 多轮预演 counts, 以问句结尾 | note 「目标：约三条里不超过一条」; a column above 1 in 3 reads 偏多 |

## Part 42 — 广播
| Where | Words |
|---|---|
| 玩家 → 广播 | 角色 · 文字 · 语音（可选） · 时间 · 发送 / 定时发送 · 保存修改 · 广播记录 |
| status in the list | 已定时 · 发送中 x% · 已发送 · 已取消 (counts of 玩家, never a player; no message text) |
| voice | 生成 (the cost is on the button, a second click pays) · 上传 WAV · 试听 · 清除 |
| the one irreversible step | 发送 asks in place: 「将由 N 个角色，向 M 位注册玩家各发送一条消息 … 发出后不能撤回。」 Everything else explains itself on hover only. |

Times are UTC (「UTC」 beside the date and the HH:MM field). A scheduled broadcast can be 修改 or 取消 until it starts. With a voice the player gets
one voice bubble (its words behind 转文字); without, one text bubble per line.

## Part 44
| Where | Words |
|---|---|
| 共创收件箱 → 题目 | 全选 · 已选 N 条 · 上线 · 下线 (online status only; the wording text is never touched). Bulk 上线 / 下线 can be undone, so there is no explanation line: hover tips only. A wording that did not switch is named: 「N 条没有上线：「…」」 / 「N 条没有下线：「…」」. |
| 多轮预演 result tables | 对话 and 统计 scroll sideways inside the result panel; the 玩家 column (the row labels in 统计) stays on the left. No new words. |
