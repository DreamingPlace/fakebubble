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

## Part 37b — 说话档案
| Where | Words |
|---|---|
| 角色工作台, a section after 资料改动 | **说话档案** · 核心卡 (说话习惯 · 幽默方式 · 绝不会说的话 · 回复长短) · 说话样本 grouped by 日常闲聊 · 调侃 · 抱怨 · 安慰 · 吵架 · 分享日常 · 内部梗 · 认真 (count `x/6`) and **未分类** (an old sample whose situation is not one of the eight: it is never rewritten until the owner moves it) · 保存核心卡 · 删除 · 移到… |
| the adopt box (共创收件箱 → 「+ 加入说话档案」, ⭐ in 多轮预演, ⭐ in 测试对话) | 加入说话档案 · 去向: 说话样本 / 核心卡 · 栏目 · 情境（x/6） · 玩家说 · 保存到草稿 (hover: 只存进草稿，发布后玩家才看得到) |
| refusals | 这一栏最多 300 字，请先精简现有内容。 · 这个情境已有 6 条样本，请先删掉一条。 · 这句话和别的角色太像了，不能保存。 (names the other character and the line) · a close line: 「和别的角色有点接近」, the button becomes 仍然保存 |
| 多轮预演 | third column 「新+档案」 beside 旧 and 新 (model·新+档案); rail group 「说话档案 · 八个情境」 (the eight built-in scripts, four turns each: 日常 · 调侃 · 抱怨 · 安慰 · 吵架 · 分享日常 · 内部梗 · 认真); ⭐ on a character line |

Everything here goes into the 草稿; **正式版本** changes only with 发布. There are no explanation lines (hover tips only: nothing in this Part is irreversible, because the 草稿 and 版本历史 are the review and the rollback). The word 「现行」 is not used.

### Part 37b follow-up — 回复写法
系统 → 模型与价格 → 回复写法: three options **旧写法 · 新写法 · 新+档案** (the pill says 当前：新+档案); owner only, one confirmation as before. Nothing else changes.

## Part 37c-1 — 网络梗
| Where | Words |
|---|---|
| 角色 → **网络梗** (new page, after 共创收件箱; the owner or cast.read sees it, cast.edit switches) | 搜索 · 年份 · 标签 · 状态 (全部 · 已开启 · 已关闭) · columns 词 · 释义 · 年份 · 标签 · 开关 · status line `共 1,806 条 · 已开启 N 条` · 开启所选 / 关闭所选 for the ticked rows · 上一页 / 下一页 · `第 x / y 页 · 符合 n 条（每页 50 条）`. An entry's switch reads 已开启 / 已关闭. No explanation line: the search box has a hover tip (词、释义和标签都会被搜到). |
| 角色工作台 → 说话档案 → **网络梗** | 默认档位 (**会用** · **只懂** · **不碰**) · 单条设置 (词 + 档位, 添加 · 删除) · 保存网络梗档位 (hover: 只存进草稿，发布后玩家才看得到). The three levels: 会用 = 听得懂，也可能自己用 · 只懂 = 听得懂，自己不用 · 不碰 = 听得懂，自己不用，也不跟着玩 (hover only). A character nobody set up is 只懂. |
| 多轮预演 | fourth column 「新+档案+梗」 beside 旧 · 新 · 新+档案; rail group 「网络梗 · 四个场景」 (日常 · 职场 · 出游 · 情绪); two rows in 统计, only in a run that has the column: **命中的梗** (按回复累计) · **给出释义** (每条回复最多 3 条), 「—」 for the other columns |
| 系统 → 模型与价格 → 回复写法 | four options **旧写法 · 新写法 · 新+档案 · 新+档案+梗** (the pill says 当前：新+档案+梗); owner only |
| refusals | 词库里没有这个词，请核对后再添加（要和词库里的原词一样）。 · 单条设置最多 200 条。 · 词库里没有这一条，请刷新后再试。 |

Player pages: one line on the terms page (the license notice and its link); nothing else.

### Part 37c-1 follow-up — 默认关闭
网络梗: 状态 gains **默认关闭** (the common words that ship switched off); each such row has a 默认关闭 badge (hover: 常用词，默认不会触发；可以手动开启); the status line adds `默认关闭 N 条`. No explanation line.
