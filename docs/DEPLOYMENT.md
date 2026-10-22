# 运行与部署边界

## 本地离线实例

不要使用已有业务数据库。下面的 `local-demo` 必须是尚不存在的新实例目录：

```sh
mkdir -p runtime/web-v1/public/db
ROOT="$PWD/runtime/web-v1/public/db/local-demo"
pnpm web:local init "$ROOT"
pnpm web:local migrate "$ROOT"
pnpm web:player:build
pnpm web:local serve "$ROOT"
```

服务为 `https://127.0.0.1:18491/`，使用实例内生成的本地证书。它是**服务端测试装置**（合成人物、离线行为，供 `pnpm check:web:local-http`、`pnpm check:web:restart` 与集成测试使用），**没有浏览器入口**：玩家页面只有 `?mode=provider`（裸网址会跳转到它）和管理页 `?mode=provider-admin`，不再有 `?mode=local-2`、`local-3`、`local-3-admin` 或静态演示原型。本地想看真实页面请用 `scripts/web-provider.ts serve`。

## Cloudflare 源码包

```sh
pnpm web:player:build
# 输出目录必须不存在；只生成文件，不上传或创建资源。
pnpm web:cloudflare:package "$PWD/runtime/cloud-package"
```

打包器解析真实依赖、校验浏览器资源哈希并附带依赖许可证。`package-manifest.json` 的 `deployable: false` 表示：该包还没有经过针对目标账户/资源的生产配置核验，不应直接部署。

`workers/web-cloudflare/deploy/*.json.example` 使用 `fakebubble-*` 服务名和占位配置。自行部署前需要明确：

1. Cloudflare 账户、HTTPS 域名/路由、四个独立 Worker、两个 SQLite Durable Object，以及私有 R2 桶。不要复用其他应用的库或桶。
2. 实例 ID、恢复代际、DO ID、静态资源及材料包哈希；替换所有 `CONFIGURE_BEFORE_DEPLOY` / `configure-before-deploy` / 示例域名。
3. 通过平台 Secrets 配置供应商和身份密钥。不要填进源码、打包清单或客户端。管理员邮件需配置受控发信绑定和发件地址。
4. 材料包与已有成品音频的使用权、指纹及版本需自行核验。初始导入仍要求三个固定角色 ID 与六条欢迎/结束成品；之后通过动态目录管理。仓库没有这些真实素材，也不会自动上传或生成它们。
5. 测试和生产的预算授权分开。生产额度需由运营者明确决定；没有授权时保持关闭。已有消费与 UNKNOWN 预占必须继承核账，不能新建实例重新获得测试额度。
6. 私有初始化、资源完整性、身份隔离、故障与恢复验证通过后，才明确开放公网和真实调用。

### 并发、限流与降级（Part 4）

`fakebubble-business` 的 Worker vars 决定阶段并发（本地实例在 `local-config.json` 的 `concurrency` 中配置，字段名为驼峰）：

| var | 默认 | 范围 | 含义 |
|---|---|---|---|
| `MAX_TEXT_RUNNING` | 20 | 1–64 | 同时运行的文本阶段（DeepSeek 允许数百并发） |
| `MAX_AUDIO_RUNNING` | 4 | 1–48 | 同时运行的语音阶段（Fish 入门档账户 5 个并发，留 1 个余量） |
| `MAX_WAITING_OPERATIONS` | 104 | 1–4096 | 运行之外可排队的操作；全局票数 = 文本 + 语音 + 排队 |
| `AUDIO_FALLBACK_WAIT_MS` | 8000 | 1000–60000 | 语音在这段时间内拿不到名额就改发文字 |
| `DAILY_REPLY_LIMIT` | 100 | 1–10000 | 每位受邀玩家在滚动 24 小时内可被接纳的主动发起回复数（本地实例在 `local-config.json` 顶层的 `dailyReplyLimit`） |

`DAILY_REPLY_LIMIT` 在操作接纳（admission）处执行，早于任何预算预占和供应商调用：只统计该玩家自己发起、仍占用配额的操作（预占已释放的不计），不含角色主动/定时消息；访客试用仍是 3 次，不受它影响。达到上限返回 `429 WEB_DAILY_LIMIT_REACHED`，`retryAfterMs` 为最早一条计入的操作滑出窗口所需的时间，页面只显示一句“今天聊得够多啦，明天再来找我吧～”，不是错误页。

缺省取默认值；已设置但不合法（非整数、越界）则 Durable Object / 本地服务拒绝启动。没有任何配置的库内存储（离线夹具）保持 4/4/120。

供应商返回 HTTP 429 表示请求在执行前被拒绝，是**已知未执行**：同一阶段退回待处理，按 2s、4s、8s 退避重试（最多三次，且不越过操作截止时间），重试沿用同一笔预占，不重复预占也不提前释放。超时、网络错误和 5xx 仍是 UNKNOWN，绝不重发。语音重试用尽，或 8 秒内没有语音名额时，已审核的文字原样作为文字气泡发布（`deliveryFallback: "text"`，不生成新文字）；为未使用的语音阶段预占的金额按零成本结算释放。

`114_stage_metrics.sql` 是独立的第 114 版迁移，在 113 之后按顺序执行，并把 `user_version`（Cloudflare 为迁移账本的最大版本）置为 114；113 这一步与 main 上逐字节相同（有哈希测试）。它为每个操作记录文字/语音排队与阶段耗时、限流重试、是否降级，以及降级时被丢弃的已生成语音段数（`discarded_audio_segments`）。Node：新的 provider-* 实例由 `migrate` 一路执行到 114；已在 113 的实例用 `scripts/web-provider.ts migrate-metrics <root>` 升级（`migrate` 只接受全新的 100 版实例，所以这个入口仍然需要）。Cloudflare：Durable Object 启动时校验已应用迁移的哈希，并按顺序补上账本里缺少的步骤，因此已在 113 的现有权威（内联与 R2）会自动升到 114；账本超前于代码或哈希不一致仍然拒绝启动。主管理员可通过 `POST /api/web/local/admin/metrics/stage-latency`（`{"days":1..31}`）查看每日 p50/p95，以及起草/审核两次调用各自的 DeepSeek 提示缓存命中率（`cache.draft` / `cache.review`：`hitTokens`、`missTokens`、`hitRatio` = hit / (hit + miss)；数据来自每次成功文字阶段已保存的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，无需新迁移；供应商没返回时不计样本、比率为 null）。预算预占仍按完整未缓存价格，保持保守上界。

已经开始任何一段语音（已付费）的操作不再受 60 秒累计排队等待（`queueWaitMs`）约束而过期，只受整体操作截止时间（`operationDeadlineMs`）限制；尚未开始语音的操作行为不变。

默认 `PUBLIC_ENABLED`、`EXTERNAL_CALLS`、`OPERATOR_ENABLED` 关闭；`workers_dev`、预览域名关闭，`routes` 为空。部署不是安装脚本的副作用。本仓库不附带一键开启付费调用的命令。

### 提示词文件与缓存友好顺序（Part 6a）

accepted-v7 的提示词正文在 `prompts/v7/*.md`（每块一个文件）。Worker 没有文件系统，所以 `scripts/build-prompts.ts`（`pnpm prompts:build`）把它们生成进提交的 `apps/server/generation/prompts.generated.ts`；`pnpm prompts:check` 和一个单元测试会在生成物过期时失败。修改提示词时先改 `.md`，再运行 `pnpm prompts:build`。

DeepSeek 自动缓存相同的请求前缀。用户消息 JSON 现在把同一角色多轮之间不变的字段放在前面，每轮都变的字段（`messages`、`characterLocalTime` 等）放在最后；审核调用的用户消息同理，`draftPresentation*` 在最末。内容与取值不变，只改键顺序。

**提示词哈希变化，需要重跑角色预览。** 第 4 步新增“玩家只能发文字”规则（`prompts/v7/player-channel-rules.md`，同时进入起草与审核提示词，并在 `responseConstraints.playerInputKinds` 声明），所以策略哈希与提示词哈希都变了（`web-text-policy.test.ts` 记录了新旧值）。哈希包含在预览批准与发布批准里：升级前批准的角色预览在发布前必须重新运行并重新批准。第 3 步只改变发送给供应商的请求字节（`wireRequestHash`），不改变这两个哈希（哈希覆盖系统提示词与协议指纹，不含用户消息的字段顺序）。

### 聊天边界：帮忙、转开与俚语（Part 11b）

新增 `prompts/v7/chat-boundary-rules.md`（同时进入起草与审核提示词）并扩展 `review-system-body.md`：聊天体量的帮忙允许；批量成品与禁区内容由审核做最小的本人口吻改写（accept 加 `replacementBubbles`），不用模板拒绝；玩家流露真实危险时必须认真接住；被转开的请求按 `answered` 计，不触发定时续答（`later`）或等待玩家（`needs_player`）。协议、状态与预算代码未变。

**提示词哈希变化，需要重跑角色预览。** 策略哈希与提示词哈希都变了（`web-text-policy.test.ts` 记录了新旧值，协议指纹不变）。下一次角色发布前，升级前批准的预览必须重新运行并重新批准。

### 记忆：重要度、玩家事实与召回排序（Part 7a）

`115_memory_importance.sql` 是独立的第 115 版迁移，在 114 之后按顺序执行（Node：`user_version=115`；Cloudflare 内联与 R2：账本版本 115，已在 114 的权威启动时自动补上）。它新增 `memory_topics.importance`（1–10，旧话题默认 3）、`memory_facts`（玩家亲口讲过的稳定事实，每个范围每个 `fact_key` 至多一条有效）和 `web_operation_metrics.review_changed`。Node：新的 provider-* 实例由 `migrate` 一路执行到 115；已在 114 的实例用 `scripts/web-provider.ts migrate-memory <root>` 升级。`memory_facts` 属于用户数据：访客保留清理、角色删除、生命周期审计都会覆盖它。

审核输出新增：每个话题的 `importance` 与 `memoryId`（本次请求召回的记忆 id 或 null，用来把同一件事的另一种说法并入已有记忆）；以及最多 3 条 `factOps`（add/update/retire，证据只能是本次请求里玩家自己的消息，角色的话永远不能生成事实）。起草与审核的用户消息在 `playerIntroduction` 之后新增 `playerFacts`（最多 20 条，重要度高者在前）。召回按 `0.5×相关度 + 0.3×重要度/10 + 0.2×exp(-小时/72)` 排序（`packages/domain/dialogue.ts` 的 `RECALL`），重要度 ≥ 7 或玩家提及 ≥ 2 次升为长期记忆。

**提示词哈希与协议指纹变化，需要重跑角色预览。** 第 A 步让提示词哈希覆盖 `prompts/v7/` 的每个文件；第 D、E 步改变审核工具 schema 与审核提示词；第 G 步改变提示词内容（`web-text-policy.test.ts` 记录各步的新旧值）。升级前批准的角色预览在发布前必须重新运行并重新批准。管理员的阶段延迟接口按日新增 `review`（`samples`/`changed`/`rate`：审核改写草稿的比例）。

### 共创收件箱（Part 12）

**每日限制（Part 21i）：** 每位玩家对每个角色的每张**卡片（问题）**每个 UTC 日只能回答一次（Part 21f 是每个角色每天一次）。同一天可以先答 A 卡、之后再答 B 卡；A 卡要到 00:00 UTC 之后才能再答。提交里只要有一张今天已答过的卡，整份提交以 `COCREATION_DAILY_LIMIT` 拒绝，什么都不写入。次数从 `web_cocreation_answers` 联结 `web_cocreation_submissions`（玩家、角色、卡片、日）数出；每个 IP 每日 10 次提交的上限不变。`POST /cocreation/today { characterId }` 现在返回 `{ cardIds }`（今天已答的卡片 id），共创页据此把这些卡显示为“今天已回答，明天再来”（不可点），全部答过时显示“今天的问题都回答过了，明天再来”。

`117_cocreation.sql` 是独立的第 117 版迁移（Node：`user_version=117`，已有 provider 实例运行 `migrate-cocreation`；Cloudflare 内联与 R2：账本版本 117，已在 116 的权威启动时自动补上）。新增 `web_cocreation_submissions` 与 `web_cocreation_answers`（均为用户数据）。任何持有有效会话的玩家（访客、已注册、账号、受邀；访客会话本身已通过 Turnstile）通过 `POST /api/web/provider/cocreation/submit` 为官方角色留下想法（每答案 ≤300 字，自由卡 ≤1000，对话卡每句 ≤120；每次 ≤12 条；**Part 21f：每玩家每角色每个 UTC 日 1 次**，第二次返回 `COCREATION_DAILY_LIMIT`（429，带到次日零点的 retryAfter）；另有防滥用上限：每个 IP 哈希每 UTC 日 10 次，返回 `COCREATION_IP_LIMIT`，计数放在既有的每 IP 每日计数表 `web_local_guest_budget`（键 `cocreation:<ip 哈希>`，因为提交行不记录地址，无需迁移）；`POST /cocreation/today { characterId }` 告诉玩家今天的名额是否已用，页面据此在输入前显示“今天已提交”；按 requestId 幂等；不计入 DAILY_REPLY_LIMIT；不调用任何供应商、不预占预算）。管理员权限 `cocreation.read`（查看）与 `cocreation.manage`（处理）由主管理员在权限编辑器的“角色 · 共创收件箱”中授予，不包含在四个功能类别里。收件箱只显示稳定的匿名代号（`玩家#` + 4 位十六进制，来自 requestKey 派生密钥的 HMAC）和邀请批次名。内容只有在管理员“加入草稿”并经现有预览与发布流程后才会进入提示词。角色删除与玩家数据清理会一并删除这些行。

### 邮箱账号与多设备登录（Part 11f）

`118_player_logins.sql` 是独立的第 118 版迁移（Node：`user_version=118`，已有 provider 实例运行 `migrate-logins`；Cloudflare 内联与 R2：账本版本 118，已在 117 的权威启动时自动补上）。新增 `web_player_logins`（邮箱 + scrypt 密码哈希，与已有 principal 一对一绑定）、`web_email_challenges`（验证码摘要与发送账本）、`web_player_email_daily`（每个 UTC 日的发送计数）、`web_player_throttle`（登录失败计数，键为 HMAC）。登录只是 principal 的**凭据**：principal 种类、准入与权益不变；有登录但没有有效邀请的 principal 仍按访客试玩处理；登录创建的会话 `account_id` 仍为 NULL，不使用旧的 `web_accounts`/Argon2 路径。

**业务 Worker 新增配置（`workers/web-cloudflare/deploy/business.json.example` 已列出）：**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `PLAYER_EMAIL` | `send_email` 绑定 | Cloudflare Email Service（Email Sending）发信绑定，只发纯中文文本，无链接、无 HTML、无追踪。 |
| `PLAYER_EMAIL_FROM` | 变量 | 发件地址，必须属于已完成发信域名验证的域。 |
| `PLAYER_SIGNUP_ENABLED` | 变量，默认 `false` | 开启注册与忘记密码。为 `false` 时这两个入口显示“注册暂未开放”，**登录照常可用**。为 `true` 时必须同时配置 `PLAYER_EMAIL` 与 `PLAYER_EMAIL_FROM`，否则业务对象拒绝启动。兑换邀请码一律要求先登录（访客输入邀请码被拒绝且码不被消耗）。 |
| `PLAYER_EMAIL_DAILY_CAP` | 变量，默认 `200` | 所有玩家合计每个 UTC 日最多发送的邮件数（1–100000）。 |

**上线前：** (1) 在 Cloudflare Email Service 里为发件域名完成 **Sending Domain onboarding**（添加域名并按提示写入 SPF / DKIM / DMARC 的 DNS 记录，等待状态变为已验证）；(2) Email Service 的发信需要 **Workers Paid** 套餐；(3) 先保持 `PLAYER_SIGNUP_ENABLED=false` 部署，确认迁移账本 `matches:true` 后再改为 `true` 重新部署；(4) 用自己的邮箱走一遍注册、登录、忘记密码。

**验证码：** 6 位数字，10 分钟有效，每个挑战最多 5 次错误尝试，**同一邮箱在所有挑战与用途上合计，滚动 24 小时内最多 10 次错误验证码**（超过后验证与任何用途的请求验证码都返回 `PLAYER_RATE_LIMITED` 并带 `retryAfterMs`，已注册与未注册邮箱的回应完全相同；计数键为邮箱的 HMAC），新的请求使同邮箱同用途的上一个挑战失效。限制在发送之前检查：同一邮箱两次发送至少间隔 60 秒、每小时最多 5 次；同一 IP 每小时最多 10 次；全局每日上限 `PLAYER_EMAIL_DAILY_CAP`。发送超时或出错不会自动重试，玩家可在冷却后点“重新发送”（计入上述限制）。请求验证码的回应对已注册与未注册邮箱完全相同：已注册邮箱收到“你已注册，可直接登录或重置密码”，不含验证码；忘记密码遇到未注册邮箱不发邮件。验证码、密码和完整邮箱不进入日志、指标、回执或错误；管理员视图只显示打码邮箱或玩家编号（首字符 + `***` + 域名）。

**登录与会话：** 邮箱 + 密码（8–128 字节）；同一邮箱 15 分钟内失败 10 次、同一 IP 失败 30 次后需要等待；错误提示一律为“邮箱或密码不正确”。登录只新建会话，其他设备的会话不受影响，永远不合并两个 principal；忘记密码会结束该 principal 的其他全部会话；修改密码可选择同时退出其他设备。**保留期：** 已注册（有邮箱登录）的访客在试玩结束后**不会被保留清理删除**：聊天照常以“试玩已结束”拒绝（准入不变），但仍可登录、查看历史、修改昵称、兑换邀请码（得到的是额度，见下）。保留状态不新增：`web_guest_retention` 保持 `active` 且已过期，“有登录的访客”由服务端推导；只有显式声明 `read` 的读取路径（历史、事件、操作状态、已发布音频）放行，其余一律按 `live` 判断并返回 `TRIAL_EXPIRED`。登录若 **180 天**无活动（`web_player_logins.last_seen_at`，注册、登录时写入，`bootstrap` 每个 UTC 日最多刷新一次）则走原有的、带审计且失败即关闭的访客清理路径连同全部数据删除；没有登录的访客仍在试玩结束时清理。登录会话与注册当下的会话使用 400 天 Cookie，服务端以 400 天为上限。已失效/被撤销的 Cookie 在 `bootstrap` 时由服务端清除，页面回到“登录 / 注册 / 以访客继续”的首页。

**登录错误与密码输入（Part 21i）：** 登录现在分开回答“这个邮箱还没有注册”（`PLAYER_EMAIL_NOT_REGISTERED`，附“去注册”）和“密码不正确”（`PLAYER_PASSWORD_WRONG`），限流“尝试次数太多，请稍后再试”，断网“网络异常，请重试”。这等于公开某个邮箱是否已注册，是主管理员接受的取舍；登录限流不变（每邮箱哈希 10 次／每 IP 30 次／15 分钟，先于任何查询计数）。注册页要输入两次密码（客户端比对，不一致时提交按钮禁用并显示“两次输入的密码不一致”，服务器仍按原规则校验密码）；所有玩家密码框（登录、注册、重置、修改密码、删除账号）都有“显示密码／隐藏密码”按钮（`aria-pressed`、`aria-controls`）。顶部账号菜单只显示条目名称，没有第二行小字。

**唯一的登录方式是邮箱 + 密码**（Part 22x）：恢复码、“我有恢复码”入口、旧邀请体系的绑定邮箱流程都已移除。

**数据清理：** 登录行与验证码挑战是玩家数据，随玩家清理一并删除（Node 与 Cloudflare 保留期清理器、生命周期审计在清理后仍有残留时失败关闭）；昵称写入的“名片”修订同样随之删除。

### 时间、记忆元数据与预演丢失输出（Part 16）

**迁移：** `120_memory_metadata_metrics.sql` 是独立的第 120 版迁移（Node：`user_version=120`，已有 provider 实例运行 `migrate-memory-metrics`；Cloudflare 内联与 R2：账本版本 120，已在 119 的权威启动时自动补上，共 45 步）。只给 `web_operation_metrics` 增加 `topics_dropped`、`facts_dropped` 两列（0/1，默认 0），没有新表。

**提示词（有意改动，策略/提示哈希已重新固定）：** 请求字段 `currentLocalTime` 改名为 `characterLocalTime`，并且不再把 UTC `currentTime` 发给草稿或审核模型（服务端仍用 `request.now`）。草稿与审核提示都明确：这是**角色自己的钟**，玩家的时间、时区和睡没睡未知，除非玩家在当前消息里说了；审核负责删改据此臆断玩家作息的句子。另加两条：没有历史或记忆支持的过去约定不确认；不声称看过具体的近期或正在进行的比赛并引用细节。聊天边界与场景／隐私规则未动。

**记忆元数据不再拖垮回复：** 评审返回的 `topics` / `factOps` 先做无害规范化（缺失的 `memoryId` 视为 null、整数字符串的 `importance` 转为数字、丢弃未定义的多余键），语义检查（文字、重要度 1–10、`sourceKind`、证据 ID、记忆链接）保持严格。规范化后仍不合法、而回复其余部分（覆盖、气泡、格式、安全）都合法时，回复照常送出，该轮不写入记忆，并计入当日 `topics_dropped` / `facts_dropped`，在 运营数据 的“话题/事实丢弃”列显示。覆盖、气泡、格式、安全校验没有放宽。

**预演的“没有保留模型输出”：** 生产里预演的生成器运行在 `fake-paopao-web-generation`，之前经 Worker RPC 重建观察者时只保留了 `finish`，`rejected` 丢失。现在两侧（`workers/web-cloudflare/generation.ts`、`apps/server/cloudflare/web-generators.ts`）都转发 `rejected`：尽力而为，不等待、不抛错、不影响 `finish()` 与账单。

**管理端 403：** 管理员 CSRF 令牌由会话 cookie 推导，浏览器各标签页共享 cookie、令牌则各自保存。在另一个标签页重新登录会换掉 cookie，旧标签页仍带旧令牌，`previews-status` 轮询就会得到 403 `ADMIN_CSRF_REQUIRED`（会话本身没问题）。客户端现在遇到该码时用 `GET /session` 重新同步令牌并重试一次；会话真的失效时仍是 401。

### 预演测试评测台（Part 13b）

`119_preview_workbench.sql` 是独立的第 119 版迁移（Node：`user_version=119`，已有 provider 实例运行 `migrate-preview-workbench`；Cloudflare 内联与 R2：账本版本 119，已在 118 的权威启动时自动补上）。新增六张仅管理员可见的合成数据表：`web_preview_runs`（一次批量运行）、`web_preview_run_items`（运行与预演的归属，一条预演至多属于一次运行）、`web_preview_marks`（预演用的模拟当地时间）、`web_preview_rejected`（完成并有用量、但校验失败的阶段所返回的原始模型输出，每阶段至多 32 KiB）、`web_eval_sets` 与 `web_eval_set_versions`（评测集及其全部历史版本）。预演表与账本（`admin_previews`、`web_character_preview_*`）本身不变，也不新增外键指向由安装器创建的表。没有环境变量或绑定的变化；不改提示词或工具 schema。

- 模拟时间只存在于预演：角色时区始终是角色自己的作息时区，不可更改；真实对话永远使用真实时钟。
- 删除角色时，该角色的运行、模拟时间标记和被拒收的模型输出一并清除（预演行和不可变的计费账本按原设计保留；预演本来就没有独立的保留期，被拒收输出沿用这一点）。
- 轮询：页面只调用一个批量状态端点（`previews-status`），2 秒起逐步退避到 10 秒，没有排队或运行中的预演时停止，页面隐藏时暂停。

### 记忆：按含义召回（Part 7b）

`116_memory_embeddings.sql` 是独立的第 116 版迁移，在 115 之后按顺序执行（Node：`user_version=116`，已有 provider 实例运行 `migrate-embeddings`；Cloudflare 内联与 R2：账本版本 116，已在 115 的权威启动时自动补上）。它新增 `memory_embeddings`（每个范围、话题、模型一条 float32 小端向量，`state` 为 `ready` 或 `unknown`）、`web_embed_attempts`（嵌入调用的派发账本，阶段 `embed`）和 `web_embed_metrics`（每日计数，无内容）。向量存在现有 SQLite（业务对象）里，不使用 Vectorize 或任何外部存储；相似度在代码里、只在同一范围内计算。

- **只嵌入记忆话题**（键 + 最新一条摘要）。玩家事实不嵌入：最多 20 条有效事实本来就进每个提示词。
- **模型**：Workers AI `@cf/baai/bge-m3`（多语言，1024 维，一次请求可传文本数组）。预算价格 **USD 0.0118 / 百万输入 token**；预占按保守估计（UTF-8 字节 ÷ 2，向上取整），结算以供应商返回的用量为准，没有用量则按估计，且不超过预占。
- **绑定与开关**：`AI` 绑定只在 generation Worker 上（见 `workers/web-cloudflare/deploy/generation.json.example` 的 `ai`）。业务对象没有这个绑定，也读不到密钥。默认全部关闭：generation Worker 的 `EMBEDDINGS_ENABLED=false`，业务对象的 `EMBEDDINGS_ENABLED=false`；只有两处都为 `true` 且 `EXTERNAL_CALLS=true`，嵌入才会发生。业务对象另有 `MAX_EMBED_RUNNING`（同时进行的嵌入调用数，默认 2，1–16，与文本、语音并发分开计）和 `EMBED_QUERY_TIMEOUT_MS`（回复等待查询嵌入的上限，默认 3000，200–10000）；无效值拒绝启动。
- **本地 provider 模式**：Workers AI REST。`CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN` 放在与 `.env`、`.env.voice` 同一目录的 `.env.embed`（0600，不进 GitHub）；缺任何一个就没有语义召回，词面召回照旧。并发与超时可写在实例 `local-config.json` 的 `embedding: { "maxEmbedRunning": 2, "queryTimeoutMs": 3000 }`。
- **预算**：嵌入费用是 Cloudflare 的，记在 `web_provider_spending` 的 `cloudflare` 一行（安全上限 USD 1，不是目标值），与 DeepSeek / Fish 的累计账本互相独立。每次调用先写入账本并预占，再发送；已知失败释放预占；结果未知的调用（超时、网络错误、5xx、无法解析的响应）保留预占，永远不重发。

流程：发布提交**之后**（绝不在发布事务里），调度器把当前文本还没有 `ready` 向量的话题（同一 `content_hash`）算作待处理；一次最多取同一范围的 16 个话题，用**一次**请求发送文本数组，由业务对象写入向量。已知失败释放预占，话题 60 秒后再试；结果未知的话题标记为 `unknown`，只用词面召回，直到文本变化（新的 `content_hash`）才产生新工作。回复请求冻结前，用同样的账本规则对玩家当前输入做一次嵌入（有超时），请求冻结时包含最终召回结果，冻结后保持不可变；失败、超时或结果未知时按词面召回冻结并继续，不重试、不阻塞，且不保存玩家输入的向量。游客不做记忆召回，也不嵌入。

排序：`relevance = max(词面, 语义)`，语义 = clamp((cosine − τ) / (1 − τ), 0, 1)，τ = 0.35（`RECALL_SEMANTIC`，与固定的 `RECALL` 权重放在一起），在同一范围内最多比较最近见到的 500 个话题；重要度与时间衰减权重不变。

管理员的阶段延迟接口（仅 owner）按日增加 `embedding`：调用数、嵌入文本数、失败、结果未知、查询嵌入回退与超时。

### 公开上线准备（Part 17）

本部分的**每一项新行为都有开关，默认全部关闭**；什么都不配置时，部署和以前逐字节一致（`GET /account`、CSP、静态文件、报错都不变）。唯一的迁移是 Part 17b 的第 121 版（见下，新表只在 `SIGNUP_BONUS_ENABLED` 打开后才被读写）；不改提示词或工具 schema。

**新增变量（业务 Worker，`business.json.example` 已列出）：**

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `GUEST_GRACE_ENABLED` | `false` | 注册永远开放，并给没有登录的访客 **7 天宽限期**：试玩结束后数据再保留 7 天（清理时间由 `expires_at` 改为 `expires_at + 7 天`，只对没有登录的访客），期间不能聊天、不能读历史，但会话仍可用于注册；注册即成为保留账号（沿用 Part 11f 的 180 天不活跃规则），历史回来。宽限期结束后数据清除，旧 Cookie 返回 `GUEST_GRACE_ENDED`（401，清 Cookie），页面落到“登录 / 注册 / 以访客继续”，提示“之前的体验聊天已过期”，选 注册 会走正常首访流程创建新访客并以空历史注册。准入不变：没有邀请就没有新回复。 |
| `SIGNUP_BONUS_ENABLED` | `false` | 免费额度（Part 17b，见下）：访客试聊每人、每个网络（终身）5 条，注册并验证邮箱再送 10 条，同一 IP 每个 UTC 日最多完成 3 次注册。关闭时（默认）一切照旧：3 条、没有赠送、没有注册上限。 |
| `CHAT_REVIEW_ENABLED` | `false` | 测试对话（Part 19，见下）：站长可以用匿名编号阅读聊天全文；玩家被删除聊天时，文字以匿名编号再保留 180 天；聊天页出现一次性提示；删除账号／清除体验数据的确认单多一句 180 天说明。关闭时（默认）一切照旧：没有页面、没有存档、删除立即清空，审核相关路由和没有一样（404）。 |
| `ACCOUNT_DELETE_ENABLED` | `false` | 顶部账号菜单里出现“删除我的账号”（有登录：密码 + 输入“删除”）；访客的顶部栏出现“更多”，里面是“清除本设备的体验数据”（无需密码）。走原有、带审计、失败即关闭的清理路径，立即清除聊天、记忆、语音、共创、名片、登录、验证码挑战与全部会话；受邀玩家的授权在同一事务里撤销。 |
| `LEGAL_PAGES_ENABLED` | `false` | **业务 Worker 与边缘 Worker 都要设**。开启后注册页显示“注册即表示你同意《用户协议》和《隐私政策》”，页脚和首页出现两个链接；边缘 Worker 才会提供 `/privacy.html`、`/terms.html`（关闭时 404）。两页已在 Part 19 定稿（没有 【待确认】，没有“草稿”提示）；开启后注册弹窗还会多一个必选的“我已年满 18 周岁”勾选（见下）。 |
| `ALERTS_ENABLED` | `false` | 开启给站长发邮件告警与日报。需要 `ALERT_EMAIL_TO`、`ADMIN_EMAIL`（`send_email` 绑定）和 `ADMIN_EMAIL_FROM`，缺任何一个业务对象拒绝启动。 |
| `ALERT_EMAIL_TO` | — | 收件人，必须是 `ADMIN_EMAIL` 绑定允许送达的已验证地址。 |
| `ALERT_ERRORS_PER_HOUR` | `20` | 最近一小时业务 5xx / 异常次数达到即告警（按 10 分钟桶累计）。 |
| `ALERT_DAILY_SPEND_MICROS` | `5000000` | 当日（UTC）已结算的供应商花费（账本，微单位；5000000 = 5.00）。 |
| `ALERT_BUDGET_PERCENT` | `80` | 累计花费（含占用）占预算上限（有上限的供应商合计）的百分比。`production-unlimited` 没有上限，不触发。 |
| `ALERT_VALIDATION_FAIL_PERCENT` | `20` | 最近一小时失败回复占已结束回复的百分比（见下一行的样本下限）。 |
| `ALERT_VALIDATION_MIN_SAMPLES` | `10` | 最近一小时至少有这么多条已结束回复才计算（避免 1 条失败 = 100%）。 |
| `ALERT_DIGEST_HOUR_UTC` | `1` | 日报的 UTC 小时（默认北京时间 09:00）。 |
| `TURNSTILE_ENABLED` | `false` | **业务 Worker 与边缘 Worker 都要设**（边缘用它放宽 CSP）。开启后创建新访客（无 Cookie 的首访）、请求验证码（注册 / 重置 / 绑定）和登录需要有效的 Turnstile 令牌。 |
| `TURNSTILE_SITE_KEY` | — | 控制台里小组件的站点密钥（公开）。开启时必填。 |
| `TURNSTILE_SECRET` | — | **机密**，只配给业务 Worker：`wrangler secret put TURNSTILE_SECRET`。绝不放进 vars、仓库或日志。 |

**邮件告警（`ALERTS_ENABLED`）：** 业务对象闹钟每小时检查一次（检查时刻先写入再工作，30 秒一次的闹钟不会重复检查）。每种告警 **6 小时内最多一封**，发送前先记账，发送失败**不会循环重试**（下一次最早在 6 小时后）。六种告警：①最近一小时业务 5xx/异常 ≥ `ALERT_ERRORS_PER_HOUR`；②当日供应商花费 ≥ `ALERT_DAILY_SPEND_MICROS`；③出现新的 UNKNOWN 供应商 / 外部 / 嵌入调用（累计数超过上次已告警的数）；④累计花费 ≥ 预算上限的 `ALERT_BUDGET_PERCENT`%；⑤玩家验证邮件当日已达 `PLAYER_EMAIL_DAILY_CAP`；⑥最近一小时失败回复率 ≥ `ALERT_VALIDATION_FAIL_PERCENT`%（失败回复 = 状态为 `failed` 的操作，包括校验失败与超时，样本不少于 `ALERT_VALIDATION_MIN_SAMPLES`）。另有每日一封日报（回复、新注册、花费、失败、UNKNOWN、错误）。邮件是纯中文文本，**只含数字，不含玩家内容、邮箱或任何 id**。告警状态存放在业务对象的键值存储里（不是 SQL，不需要迁移）。

**Turnstile 小组件设置（Cloudflare 控制台）：** Turnstile → Add widget → Hostname 填你的站点域名（只填这一个）→ Widget Mode 选 **Managed**（页面使用 `interaction-only` 外观：绝大多数人看不到任何东西，需要点击时才弹出小框）→ 创建后复制 Site Key 填 `TURNSTILE_SITE_KEY`，复制 Secret Key 用 `wrangler secret put TURNSTILE_SECRET` 配给业务 Worker。业务对象调用 `siteverify`，令牌只能用一次（摘要先占位再验证），令牌的主机名与动作（`guest` / `code` / `login`）必须匹配，`siteverify` 不可达时请求被拒（503 `TURNSTILE_UNAVAILABLE`），**失败即关闭**。令牌通过请求头 `X-Turnstile-Token` 携带，所以接口体不变；页面在第一次被拒（`TURNSTILE_REQUIRED`）时自动取令牌并重试同一请求，正常情况下无需额外点击，失败时显示“人机验证没通过，请再试一次”。CSP 只在 `TURNSTILE_ENABLED=true` 时变化：`script-src`、`connect-src` 增加 `https://challenges.cloudflare.com`，新增 `frame-src https://challenges.cloudflare.com`，其余不变。Node 本地服务器不启用 Turnstile。

**玩家站点公开、只用 Access 保护管理接口：** 公开玩家站点前，在 Cloudflare Zero Trust 里把 Access 应用的路径从整站收窄到只保护 `/api/web/provider/admin/*`（页面 `/?mode=provider-admin` 本身只是静态壳，没有数据；它调用的接口全在该前缀下，且管理员仍有自己的邮箱 + 密码登录和 CSRF）。未带 Access cookie 的浏览器打开管理页时，接口会被 Access 重定向；页面会提示“需要先通过 Cloudflare Access 验证身份”，点“前往验证”会顶层导航到 `GET /api/web/provider/admin/enter`（在同一 Access 路径下，无正文、无状态变更、不接受任何查询参数，固定 303 到 `/?mode=provider-admin`；只有这一条路由接受来自 Access 回跳的 `sec-fetch-site: cross-site`，且仅限 GET 与 `sec-fetch-mode: navigate`）。管理员一次性登录凭据有效期 1 小时，单次有效。收窄之前先在预发布域名验证：未登录 Access 访问 `/api/web/provider/admin/session` 被拦，访问 `/`、`/api/web/provider/bootstrap` 不被拦。

**上线当天清单：**
1. 部署新版本，所有 Part 17 开关保持 `false`；确认 `inspect` 的迁移账本 `matches:true`、`pnpm check` 通过。
2. 两份法律文本已在 Part 19 定稿（运营者、联系邮箱、生效日期、跨境与训练条款、18 周岁、适用法律都已写入），部署时以最新构建为准；在业务与边缘 Worker 同时设 `LEGAL_PAGES_ENABLED=true`。
3. 创建 Turnstile 小组件，配置 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET`，业务与边缘同时设 `TURNSTILE_ENABLED=true`；用无痕窗口走一遍首访、注册、登录。
4. 配置 `ALERT_EMAIL_TO`，设 `ALERTS_ENABLED=true`；确认能收到次日 `ALERT_DIGEST_HOUR_UTC` 的日报。
5. 设 `GUEST_GRACE_ENABLED=true`、`ACCOUNT_DELETE_ENABLED=true`；用测试账号走一遍：宽限期注册找回历史、删除我的账号、清除本设备的体验数据。
6. 设 `PLAYER_SIGNUP_ENABLED=true`（若尚未开）并核对 `PLAYER_EMAIL_DAILY_CAP`；确认预算上限 / `BUDGET_POLICY` 符合预期（公开后访客每个网络累计 3 次免费回复，邀请码只发给选定的人）。
7. 把 Access 收窄到 `/api/web/provider/admin/*`（见上），再把 `PUBLIC_ENABLED` / 路由对外开放。
8. **站长待决定：大陆地区规则。** 目前没有任何地区限制代码（边缘对不在白名单地区的访问者的处理）：需要决定 ①是否对中国大陆访问者开放或屏蔽；②如果开放，是否需要 ICP 备案、跨境传输告知与单独同意、算法/生成式 AI 服务备案等合规动作（隐私政策第 3 节已写明跨境处理并要求使用者同意，但这不替代上述合规判断）。在这个决定做出之前，不要宣传公开。
9. 观察第一天：告警邮件、`inspect`、预算、`GUEST_GRACE` 之后的清理（`web_guest_retention` 的 `purging/purged` 行）。回退：把对应开关改回 `false` 重新部署即可，无需迁移。

**免费额度与注册赠送（`SIGNUP_BONUS_ENABLED`，Part 17b）：** 关闭时一切照旧（访客 3 条，按玩家与按 IP 终身计数）。打开后：①访客试聊 **5 条**（`WEB_LIMITS.publicTrialReplies`），按 IP 的**终身**配额（`web_ip_lifetime_quota`）仍是终身而不是每日，同样是 5；②有邮箱登录、没有邀请授权的访客另有 **10 条终身赠送**（`WEB_LIMITS.signupBonusReplies`）：没有时间窗口，可以和任何角色聊（没有“首个人物锁”），排在试聊之后用，试聊窗口结束后（保留账号）仍可继续聊，**不占用也不检查按 IP 配额**；两者都用完时玩家看到“免费消息已用完，输入邀请码继续”（访客则是“注册即送 10 条免费消息，可以和任何角色聊”）；③赠送**每个已验证邮箱终身最多一次**：只保存规范化邮箱的带密钥 HMAC（`web_bonus_emails`），**删除账号后这一条仍然保留**（隐私政策里已写明），删除后用同一邮箱重新注册不再赠送；④同一 IP 每个 UTC 日最多 **3 次成功注册**（`WEB_LIMITS.signupsPerIpPerDay`）：请求验证码时先检查，完成注册时在同一事务里再检查并计数，超出返回 429 `PLAYER_SIGNUP_IP_LIMIT`（带 `retryAfterMs`，页面显示“这个网络今天的注册次数已用完，请明天再试”，而不是通用的“操作太频繁了”）；原有的邮箱/IP 限流和 Turnstile 不变。邀请玩家不受影响（不领赠送，限额与原来相同）。准入顺序：计数器试聊（第 1–3 条）→ 额外试聊（第 4–5 条）→ 注册赠送 → 否则原有的 `TRIAL_EXHAUSTED` / `TRIAL_EXPIRED`；预算预占、幂等与结算规则不变（赠送与额外试聊是 `entitled` 操作）。开启后不再给第 3 条试聊回复附带“试聊结束”页脚（它不再是最后一条）。**为什么分两种试聊：** `web_principals.trial_*` 与 IP 窗口表被迁移 100 的 CHECK 限制在 3，十二张表引用 `web_principals`，已部署的 Durable Object 无法关闭外键重建，所以前三条沿用原计数器，后两条和赠送用派生记账（`web_free_operations`：每条操作一行，剩余额度 = 上限 − 状态为 reserved/used 的行，失败或取消的操作 `released` 不计，没有会漂移的计数器）。`trial_extra` 行带有 IP 的带密钥哈希并在清理后保留（与 `web_ip_lifetime_quota` 一样，清理不能重置某个 IP 的终身额度），`bonus` 行随玩家删除。

**Part 17c（同一开关 `SIGNUP_BONUS_ENABLED`，无新迁移）：**
- **试聊窗口 7 天：** 打开后，访客试聊从**首条回复**起算 **7 天**（`WEB_LIMITS.publicTrialWindowMs`，`FreeTier.trialWindowMs`；关闭时仍是 2 小时）。计数试聊、额外试聊的窗口起点和时间溢出检查都用它。7 天一到，下一次发送返回 `TRIAL_EXPIRED`，不占 IP 名额、不占试聊计数、不写 `web_free_operations`。`access().trialExpiresAt` 随之变为 7 天后；`web-data-policy-preflight.ts`（只在 109→110 运行）不变。
- **访客登录状态：** 开关打开后**新建**的访客会话绝对寿命至少为 `publicTrialWindowMs + GUEST_GRACE_MS`（14 天）；`LIMITS.guestAbsoluteMs`（24 小时）不变，关闭时仍是 24 小时；已存在的会话不延长。
- **赠送每个邮箱“收件箱”一次：** `bonusEmailKey` 对一个只用于赠送的规范形式取 HMAC（登录仍用 `normalizeEmail`）：本地部分从第一个 `+` 起全部去掉（所有域名）；`gmail.com`、`googlemail.com` 还去掉本地部分的点，并把 `googlemail.com` 改成 `gmail.com`。所以 `a.b+1@gmail.com`、`ab@googlemail.com` 与 `ab@gmail.com` 是同一个收件箱。
- **IPv6 按 /64 计数：** 按 IP 终身配额、IP 窗口、额外试聊的 IP 计数和每 IP 每日 3 次注册上限，都用 `ip_hash`。现在 `ip_hash` 的输入是：IPv4 原文不变（已有 IPv4 行继续有效）；IPv4 映射的 IPv6（`::ffff:a.b.c.d`）按该 IPv4；其他 IPv6 取 /64 前缀的规范文本（如 `2001:db8:1:2::/64`）；无法解析仍按原样拒绝（`REGION_UNAVAILABLE`）。**已有的 IPv6 配额行会重新开始一次**（上线前，可以接受）。此项在开关关闭时同样生效（仅限 IPv6）。
- **密钥轮换：** 轮换 `REQUEST_KEY` 会让所有邮箱重新有资格领取赠送；轮换 IP 密钥会重置所有按 IP 的配额。正常部署都不轮换这两个密钥。

**迁移 121（`121_signup_bonus.sql`，sha256 `f0fa334dbb0ac155d5421792e612438b722b9882fc8ff11a145e34e705fef8d9`）：** 新增 `web_bonus_emails`、`web_signup_bonus`、`web_free_operations`、`web_signup_ip_daily`。Node：`user_version=121`，已有 provider 实例运行 `scripts/web-provider.ts migrate-signup-bonus <root>`（新实例的 `migrate` 一路到 121）；Cloudflare：账本版本 121，已在 120 的权威启动时自动补上，**共 46 步**（`expected-migrations`：inline 与 R2 各 46，121 在两边是同一份 SQL）。需要把 121 加进的版本白名单：`web-identity.ts`（三处）、`web-admission.ts`（四处）、`web-retention.ts`、`web-stage-queue.ts`（两处）、`web-vertical-publisher.ts`、`web-v7-request.ts`、`platform/store.ts`（`WEB_SIGNUP_BONUS_SCHEMA`，三处）、`cloudflare/web-store.ts`（版本列表 22 项）、`workers/web-cloudflare/migrations.ts`、`scripts/web-provider.ts`、`web-provider-migration.ts`（`migrateWebProviderSignupBonus`）。逐字节相同的旧步骤有哈希测试保护；先以 `SIGNUP_BONUS_ENABLED=false` 部署，确认账本 `matches:true`，再打开。

**测试对话与匿名存档（`CHAT_REVIEW_ENABLED`，Part 19）：** 打开后：①后台侧边栏「运营 → 测试对话」（权限 `conversations.read` = 查看测试对话，默认只有主管理员，不在 共创写手／运营 预设里，只在 全部 里）列出每个“角色名-四位编号”的对话（进行中和已删除），可按角色、进行中／已删除筛选，按最近活动排序；点开看全文（玩家文字、角色最终气泡、角色主动消息、失败回复及错误码、“审核改动”标记，时间为角色当地时间，分页），可导出一个对话或一个角色全部对话的 CSV（列：label,time,speaker,text,status,error_code,审核改动）。只显示匿名编号：不返回邮箱（含掩码）、昵称、任何 principal／玩家／世界／会话／操作 id、IP 哈希、邀请码、记忆或语音；玩家的当前和曾用昵称在文字里一律替换为〔昵称〕。每次列表、详情、导出写一条 `web_admin_audit`（操作者、动作、标签、时间，不含内容）。路由在 `web-admin-read.ts` 的只读预算（每分钟 300 次）里。②编号 4 位，字母表去掉 0/O、1/I/L，随机分配（不由任何 id、邮箱、IP、邀请推导），同一玩家的各角色相同，与现用编号和仍在存档里的编号都不重复；第一次被列出时才分配，存档时缺则补。③玩家的聊天被删除时（删除账号、清除本设备的体验数据、访客试玩／宽限结束后的清理、180 天不活跃清理）：在**开始清理的同一个事务里**（T1，清除任何内容之前）把文字复制进匿名存档（昵称先替换），之后才清除；重启后接着做的清理不会重复存档；存档行 180 天后由闹钟里的清理任务批量删除，没有别的东西删除或修改它，玩家侧接口读不到它。关闭开关时什么都不存档，删除和以前一模一样。④玩家侧：聊天页顶部一次性提示（可关闭，关闭状态按玩家存在服务端，随玩家删除），隐私政策第 2、5 节和删除确认单的 180 天说明；发送从不受影响。静态隐私页无法随开关变化，所以两句隐私政策**无条件**写入（开关打开后即为事实，上线时会打开）；提示条和确认单里的句子随开关。

**迁移 122（`122_chat_review.sql`，sha256 `5a81455c85a05c9095d66eb50803acefc1d2c2f6b0a478891e733d1471eec950`）：** 新增 `web_review_codes`、`web_review_notice`、`web_review_archive`。Node：`user_version=122`，已有 provider 实例运行 `scripts/web-provider.ts migrate-chat-review <root>`（新实例的 `migrate` 一路到 122）；Cloudflare：账本版本 122，已在 121 的权威启动时自动补上，**共 47 步**（`expected-migrations`：inline 与 R2 各 47，122 在两边是同一份 SQL，118–121 的哈希不变）。需要把 122 加进的版本白名单：`web-identity.ts`（三处）、`web-admission.ts`（四处）、`web-retention.ts`、`web-stage-queue.ts`（两处）、`web-vertical-publisher.ts`、`web-v7-request.ts`、`platform/store.ts`（`WEB_CHAT_REVIEW_SCHEMA`，三处）、`cloudflare/web-store.ts`（版本列表 23 项）、`workers/web-cloudflare/migrations.ts`、`scripts/web-provider.ts`、`web-provider-migration.ts`（`migrateWebProviderChatReview`）。先以 `CHAT_REVIEW_ENABLED=false` 部署，确认账本 `matches:true`，再打开。回退：把开关改回 `false`——存档里已有的行仍会在 180 天后被清理，不需要迁移。

**注册时的 18 周岁勾选（`LEGAL_PAGES_ENABLED`，Part 19）：** 注册弹窗在“发送验证码”上方多一个必选的“我已年满 18 周岁”；注册请求带 `adult:true`，开关打开时服务端没有它就拒绝（400 `AGE_CONFIRMATION_REQUIRED`）。不存储，也不改变别处（首页、开始页、准入都不检查年龄）。开关关闭：没有勾选，注册和以前一样。

**账号删除怎么保证安全（`ACCOUNT_DELETE_ENABLED`）：** `POST /account/delete`，体 `{ "password", "confirm" }`；有登录的玩家必须提供密码并输入“删除”，没有登录的访客 `password` 为空串、`confirm` 为“清除”；没有登录的受邀玩家不能用这个入口（先绑定邮箱）。CSRF / 来源检查、一次一用的会话校验与登录一致；错误密码计入与改密码相同的限流（每个玩家 15 分钟 5 次）并按 IP 限流（30 次）。在**一个事务**里：撤销受邀玩家的授权、凭据和回执，结束该玩家的全部会话，写一条审计（`web_admin_audit`：动作名 + 玩家的 HMAC 假名前 16 位 + 时间，不含内容、邮箱、昵称或 id），并开始清理的 T1（隔离内容、释放预占，运行中的操作按原规则收尾，UNKNOWN 的外部调用保持 UNKNOWN，不重试、不释放）。事务提交后同一请求继续 T2（清库）与 F（删 R2 语音）；这两步任何失败都不会让删除变成报错——保留状态是 `purging`，闹钟会接着完成。清理后的审计（`auditWebLifecycleWorld`）对受邀玩家额外要求：世界里不能留下未撤销的授权；已撤销的授权行只留 id 与时间，作为 `shells`。

### Drama 3 回复语音（Part 21c）

- **开关：** 业务对象变量 `FISH_VOICE_MODEL`（`workers/web-cloudflare/deploy/business.json.example`），默认 `s2.1-pro`，即行为与之前完全一致；staging 设为 `drama-3`。只接受这两个值，其他值（包括 `drama`、`drama-3-preview`）在业务对象启动时直接拒绝（`INVALID_FISH_VOICE_MODEL`），因为 Fish 对无法识别的 `model` 头不报错而是悄悄改用 s2.1-pro。核实结果与链接见 `docs/PROVIDERS.md`：当前文档里的值是 `drama-3`，不是 `drama-3-preview`。
- **逐角色：** 声音绑定里存的 `model`：`s2.1-pro`（含此前所有绑定）跟随站点默认；`pin:s2.1-pro` 固定回 s2.1-pro；`drama-3` 固定用 Drama 3。管理工作台“声音成品版本”里勾选“固定使用 s2.1-pro”即可把某个角色钉回去（克隆音色在 Drama 3 上不对时用）。这些值存进已有的自由文本 `model` 列，**没有新迁移**：`expected-migrations` 仍是 47 步（inline 与 R2 各 47），与 main 逐字节相同。
- **欢迎／结束成品**始终以 s2.1-pro 渲染并保持原样，不随开关变化。
- **价格：** `PROVIDER_PRICES` 新增 `fish / drama-3 / speech / byte`，上限 **50** micros/字节（Part 21i 起；Fish 按字符计费，折扣期 $10/百万字符到 2026-11-12，之后 $50/百万字符；UTF-8 字节数从不少于字符数，所以不会低估。此前是 15）。**已有 drama-3 价格行的实例必须在 2026-11-12 之前再运行一次 `renew-prices`**：当前生效行的单价与代码不同时，`renew-prices` 会追加一个新版本、从运行那一刻起生效（有效期不短于被取代的行），旧行（15）原样保留、从不修改，运行之前已预留的回复仍按旧行；新版本生效后再次运行报告 `not-due`。**已部署的实例要先运行 `renew-prices` 才有 drama-3 的价格行**；没有价格行时 Drama 3 回复在预留阶段失败（`WEB_PROVIDER_PRICE_REQUIRED`），不会发出调用。新实例的 `migrate` 自动写入。
- **打开顺序（staging）：** 1）`renew-prices`；2）用 `pnpm voice:samples` 在 staging 上各生成一份 s2.1-pro 与 drama-3 的试听，确认 24 kHz WAV 可用、克隆音色听起来正确（文档未明确说明克隆音色与采样率）；3）把 `FISH_VOICE_MODEL` 改为 `drama-3` 并部署；4）个别角色听起来不对就在工作台钉回 s2.1-pro。回退：把变量改回 `s2.1-pro`。
- **本地真实供应商模式（`scripts/web-provider.ts serve --live`）仍只用 s2.1-pro**：它的 Fish 客户端固定为 s2.1-pro，遇到解析为 `drama-3` 的绑定会以 `WEB_PROVIDER_WIRE_MISMATCH` 关闭失败，不会调用。Drama 3 只在 Cloudflare 业务对象上通过 `FISH_VOICE_MODEL` 打开。
- **试听脚本：** `pnpm voice:samples <provider-root> <env-dir> <输出目录> --live [--model=s2.1-pro|drama-3]`。每个已批准角色音色 × 10 种 expression 各一条（固定文案，不读取任何玩家、对话或记忆数据，只读声音绑定与价格），写到 `<输出目录>/<角色>/<expression>.<model>.wav` 与 `manifest.<model>.json`。模型默认读 `.env.voice` 的 `FISH_VOICE_MODEL`。它花真钱：先预留共享预算再调用，UNKNOWN 不重发、占用不释放，已付费的片段重跑时直接复用；输出目录必须为空。
- **声音提示 `soundCue`：** 语音草稿（utterance 与每条 afterthought）多一个可选枚举 `soundCue`（`none` / `small_laugh` / `shaky_breath`），由服务器渲染成文档里写明的 `[small laugh]` / `[shaky breath]`，仅 Drama 3 生效，s2.1 声音忽略。模型不写括号或标签；`[ ] < >` 在所有模型与玩家文字中仍被拒绝（`AUDIO_CONTROL_MARKER_FORBIDDEN`）；气泡显示文字从不含标签。复核阶段的替换气泡不带 `soundCue`。
- **提示词哈希变更（有意）：** 语音草稿 schema 与 `speech-draft-task.md` 改动使 prompt 哈希 `6519b6a0…cd6f`→`53df95a8…133b`，policy 哈希 `e31c3518…52fb`→`a140e333…2c68`，协议指纹 `b42431c9…ef99`→`b753fb40…dae8`。已存的预演与发布批准内嵌这些哈希，**部署后需重新预演并批准**。
### 玩家选模型、点数与备用模型（Part 21b）

默认全部关闭；什么都不配置时与以前一致。说明与已核实的供应商参数见 `docs/PROVIDERS.md`。

**新增密钥（只配给 generation Worker，缺哪个就是哪个模型不可用，不会崩溃）：** `wrangler secret put XAI_API_KEY`、`wrangler secret put GEMINI_API_KEY`。
**新增变量（业务 Worker，`business.json.example` 已列出）：** `PLAYER_MODEL_CHOICE_ENABLED`（默认 `false`；需要同时 `SIGNUP_BONUS_ENABLED=true`）、`PLAYER_TEXT_MODELS`（如 `deepseek,gemini,xai`；DeepSeek 永远开启；不在列表里的模型对玩家隐藏，正在用它的玩家回到 DeepSeek 并收到一次性提示，也不再作为备用；**Part 21g 起它是“上限”，不再单独决定谁能选什么，见下一节“模型与价格”**）。
**迁移 123（`123_model_choice.sql`）：** 48 步；本地 `migrate-model-choice`；`expected-migrations` 与 `inspect` 会显示。不回填：点数余额在玩家首次接触时建立（Part 21f 起：`100 − 10 × 已用赠送条数 + 10 × 没用完的体验回复`，写成唯一一条 `bonus` 事件；已建立的余额不再改动）。

**启用顺序（先 staging）：**
1. 部署代码（开关全关），确认 `expected-migrations` 与 `inspect` 一致（Part 21g 起 49 步）。
2. 配 `XAI_API_KEY`、`GEMINI_API_KEY`；运行 `renew-prices` 一次：它为 xAI、Gemini 创建支出上限、并发名额与首批价格行（已有行不动；首次初始化只写 DeepSeek 与 Fish）。`inspect` 的 `prices` 里应出现 `xai/grok-4.7` 与 `gemini/gemini-3.8-flash`。
3. staging 上把 `PLAYER_MODEL_CHOICE_ENABLED=true`，先只列 `PLAYER_TEXT_MODELS=deepseek,gemini`，再加 `xai`；每个模型发几条真实消息，检查回复、备用提示与 `pnpm usage:report`（用 `inspect` 的回执文件：`pnpm usage:report --receipt=/绝对路径`），据此校准 `packages/contracts/player-models.ts` 的点数表和 `REASONING_HEADROOM`（推理 token 按输出计费）。
4. 生产同样顺序；出问题把模型从 `PLAYER_TEXT_MODELS` 删掉即可（无需迁移）。关掉总开关则立刻回到“免费消息”旧行为。

**备用模型：** 明确未计费的失败（429、供应商文档中的过载/不可用 503、“地区/位置不支持”、缺少密钥、连接未建立）按 选择的模型 → DeepSeek → Gemini 顺序最多重试一次，零费用结算后重新预占；超时、重置、其他 5xx、无法解析一律 UNKNOWN，不重试、占款不释放。玩家按两者中较便宜的点数计费，回复下显示“{选的模型} 繁忙，由 {实际模型} 回复 · 按 {计费模型} 计费”（Part 21f；受邀玩家不计点，不显示计费一句）。审核（安全与记忆）永远是 DeepSeek v4 pro（备用 Gemini），所以记忆始终由同一个模型写入。xAI/Gemini 的花费记入共享预算的文本桶（无需新的授权仪式）。**链路用尽（Part 21d）：** 链上最后一个模型也明确未计费地失败（或下一个模型根本无法发出：缺少密钥、请求过大）时，操作立即以 failed 结束（释放配额，点数由对账全额退回），不再等 5 分钟截止时间；链上最后一个模型返回 429 时，先按上面 DeepSeek 同样的 2s、4s、8s 退避重试，用尽后才结束。UNKNOWN 规则不变。

**出口地区（`generation.json.example` 的 `placement`）：** 我们设置了 Cloudflare 文档中的区域提示 `{"region": "aws:us-east-1"}`（wrangler 未在本仓库固定版本，官方文档也未给出最低版本；选区域提示而不是 Smart Placement，因为目标是固定的出口地区而不是靠探测上游）。**但官方文档明确写着：放置只影响 `fetch` 处理器，不影响 RPC 方法或命名入口，而 generation Worker 是被业务对象通过 RPC 调用的**，所以这条提示在当前架构下很可能不生效：出站请求实际从业务 Durable Object 所在的机房发出（RPC 与调用方同机房）。真正起作用的办法是新建 staging 的业务对象时用 `locationHint`（只在首次创建时有效，已有对象无法搬迁），或后续把供应商调用改成 `fetch` 服务绑定。在那之前由自动备用兜底：地区不被接受的回答会按“未计费”改用 DeepSeek，并计入 `web_provider_backups`。请在 staging 观察备用比例后再决定。

### 系统 → 模型与价格（Part 21g，迁移 124）

站点所有者在管理页 **系统 → 模型与价格** 里不用部署就能决定：哪些回复模型可用、对谁可用、每条消息多少点。**这一页只在 `PLAYER_MODEL_CHOICE_ENABLED=true` 后才影响玩家**（关着时也能打开、先设置好，页面会说明）。

**迁移 124（`124_model_settings.sql`）：** 49 步；本地 `migrate-model-settings`；`expected-migrations` 的最后一步（`version 124`）sha256 为 `5754ab5882783ac356527db8904fd2a4661c6b9ff98ee796a49a438ec1301d17`（123 仍是 `432c1237…28db41`，两个 authority 的 124 完全相同）。新建五张表，只有业务对象写入，**不含任何玩家数据**：`web_model_settings`（每个模型一行：总开关、游客/注册/受邀三类各自是否可用、每条点数、更新时间与管理员）、`web_model_voice`（语音加点与整页的修订号）、`web_price_versions`（每一张曾生效的价格表，只增不改）、`web_model_changes`（只增不改的修改记录：谁、何时、改了什么）、`web_model_save_requests`（保存请求的幂等记录）。迁移写入的默认值**等于现状**：三个模型全开；游客只有 DeepSeek；注册与受邀玩家三个都可选；DeepSeek 10、Gemini 20、Grok 25、语音 +2（价格版本 1 是 Part 21b 的旧表 Grok 40，版本 2 是这组默认值）。迁移不改变任何已有行为；不回填。 版本白名单与 122/123 相同的所有位置都已加上 124（`web-identity.ts`、`web-admission.ts`、`web-retention.ts`、`web-stage-queue.ts`、`web-vertical-publisher.ts`、`web-v7-request.ts`、`platform/store.ts`、`cloudflare/web-store.ts` 的版本列表 25 项、`workers/web-cloudflare/migrations.ts`、`scripts/web-provider.ts`、`web-provider-migration.ts`）。

**`PLAYER_TEXT_MODELS` 现在是“上限”：** 一个模型要对玩家出现，必须同时 ① 在 `PLAYER_TEXT_MODELS` 里，② 它的 API 密钥存在，③ 这张表里总开关打开，④ 该类玩家被勾选。①② 任何一条不满足，不管表里怎么设置都不会出现，管理页该行显示 **未配置**。DeepSeek 是内部备用与固定审核模型，永远在上限之内，即使对所有玩家隐藏也照旧担任备用和审核。`PLAYER_MODEL_CHOICE_ENABLED` 仍是总开关。
- **密钥探测：** 密钥只在 generation Worker。它新增了一个只返回布尔值的 RPC `modelKeys()`（`{ xai, gemini }`，不会返回密钥），业务对象每分钟最多问一次（失败 5 秒后重试），**失败时按“没有密钥”处理（宁可暂时不提供 xAI/Gemini）**。部署顺序：**先 generation，后 business**；反过来也安全，只是 business 先上线的那段时间 xAI/Gemini 会暂时显示“未配置”。本地（Node）运行不探测密钥，上限只看 `PLAYER_TEXT_MODELS`。

**三类玩家（`playerTier`，只在一个函数里判定；Part 22a 起由 `effectiveTier` 在那里拆出不限量/每天补充）：** 游客 = 试用游客；注册玩家 = 注册并持有点数的玩家；受邀玩家 = 受邀（invite）或 account 玩家。游客只有在所在类别可选超过一个模型时才看到选择器（聊天“⋯”菜单出现“切换回复模型”，首次引导文字也会提到；只有一个模型时仍只有“共创”）；游客的一条试用回复无论用哪个模型都只消耗一条试用回复，不扣点数。

**规则：** 每一类至少保留一个“已开启且被勾选”的模型，否则保存被拒绝（`MODEL_TIER_EMPTY`，页面会说是哪一类）。关掉一个模型（总开关或某一类）后，受影响的玩家**下一条消息**起改用本类第一个可用模型，并收到一次性的“模型已下线”提示（`model_withdrawn`）。**已经受理的消息保留当时的模型与价格**（即使之后被关掉，只要环境上限仍允许它；上限之外则改回 DeepSeek，与以前一致）。

**价格：** 每条点数是 1–200 的整数，语音加点 0–20。任何价格变化追加一个新的价格版本；点数事件、扣费与退款都记着自己的价格版本，**下一条消息才按新价格受理**，选择器马上显示新数字；之前受理的消息退款（失败全退、备用模型取较便宜者、没有语音退语音点）按**它受理时的那张表**计算。Part 21f 把代码里 `POINTS` 常量改为版本 2、Grok 25，与这里的价格版本 2（默认值）是同一组数字；之后**所有算点数的地方都读这张表**：受理时的扣费与可发送判断、选择器里的点数与“约可聊 N 条”、备用模型“按 {计费模型} 计费”（由服务器按该条消息受理时的价格版本给出）、退款（备用较便宜的差额与没有语音的语音点，用该操作自己的价格版本）、`usage:report`。常量只在没有迁移 124 的老库里作后备。21f 的开户余额规则不变（`100 − 10 × 已用赠送条数 + 10 × 没用完的体验回复`，10 是固定的赠送单位，不是表里的价格）。

**权限与保存：** 任何管理员都能查看；保存需要主管理员或新权限 **`models.manage`**（权限矩阵里“模型与价格 → 修改模型与价格”，只在“全部”预设里）。保存要走会话、CSRF 与来源检查，带一次性的请求 ID（重放得到同一结果，同 ID 不同内容被拒绝）和页面修订号（别的管理员先改过就拒绝，不覆盖，请刷新）；保存前页面弹出确认并列出所有改动。页面还显示最近 30 条修改（管理员备注、模型、字段、前后值；不含任何 ID、邮箱或玩家内容）。

**手机：** 这是后台唯一能在手机上用的页面（`#/models`；其他页面仍提示“请在电脑浏览器打开”）。

**回退：** 在页面里把值改回去即可；迁移不需要回滚（无需部署）。想让所有人立刻回到“只有 DeepSeek”：关掉 `PLAYER_MODEL_CHOICE_ENABLED`，或把 xAI/Gemini 总开关关掉。

### 邀请即额度（Part 22a，迁移 125）

邀请码不再把玩家变成另一种“邀请玩家”。从这一版起，**邀请是挂在普通注册账号上的“额度（entitlement）”**：兑换只新增一条额度记录，**从不修改 `web_principals.kind` 和 `web_guest_retention.state`**，也不换会话、不发恢复码。有效档位 = 有效的额度，否则就是注册玩家（`effectiveTier`，`admission/web-model-settings.ts` 里唯一的一处；`playerTier`、报价/扣费、消费记录、选择器、记忆召回、内容存活判定都从它读）。

**何时生效：** 数据库有迁移 125 就**永远**走“额度”这条路，与 `SIGNUP_BONUS_ENABLED`、`PLAYER_MODEL_CHOICE_ENABLED` 无关；旧兑换（授权 + `kind='invite'` + retention `protected`）已在 Part 22x 删除。两个开关只影响“点数”：
- `daily_refill` 需要点数。`PLAYER_MODEL_CHOICE_ENABLED` 关着时，建每天补充的批次被拒绝（`WEB_INVITE_POINTS_REQUIRED`，“需要先开启模型选择/积分”）；兑换每天补充的码被拒绝（`WEB_INVITE_UNUSABLE`，“这个邀请码暂时不能使用”），**码不会被消耗**，开关打开后可正常兑换。`unlimited` 批次不受影响。
- 额度持有人的活性和档位**不依赖**免费档开关（`SIGNUP_BONUS_ENABLED`）；点数关着时，持有人不扣点（仍受每日回复上限）。
- 页面从不按 principal kind 判定档位：服务端把 `effectiveTier` 的结果（`tier: {kind, unlimited, plan?}`）随账号信息发给每个已登录玩家，顶栏与 我的信息 只读它。Part 22x 起没有任何业务判定读 `kind='invite'`（迁移 126 把旧邀请主体变成访客，见下）。
- **一个撤销**：管理页“结束额度”（`revokeEntitlement`）在一个事务里结束持有人的额度；玩家保持登录，之后是注册玩家，带着剩余点数。

**迁移 125（`125_invite_tiers.sql`）：** 共 **50 步**（`expected-migrations` 的最后一步，`version 125`，两个 authority 完全相同）；本地 `scripts/web-provider.ts migrate-invite-tiers <root>`（新实例的 `migrate` 一路到 125）。sha256：

```
9e7d9ca7a596747e399a6e69640785015fbd57339ef886dd17945386d7e85a1d   apps/server/web-migrations/125_invite_tiers.sql
```

（124 仍是 `5754ab58…1301d17`，123 仍是 `432c1237…28db41`；1–124 一个字节没动。）新增六张表，只有业务对象写入：`web_invite_batches`（批次：名称、档位 `unlimited`/`daily_refill`、每天 N、总上限 C、额度天数；`request_id` 保证创建幂等）、`web_entitlements`（玩家持有的额度：来源 invite/admin、档位、起止时间、撤销时间；`invite_id` 唯一）、`web_entitlement_redemptions`（兑换的幂等记录）、`web_entitlement_refills`（每个玩家每个 UTC 日一行，每日补充的“一天一次”闸门）、`web_invite_batch_changes`（所有者修改 N/上限的只增不改记录，含当时持有人数）、`web_player_numbers`（玩家编号）。并在 `web_invite_codes` 上 `ALTER TABLE … ADD COLUMN batch_id`（可空，带外键；旧步骤文件一个字节未改）。

**Codex 注意（第 125 步）：**
1. 版本白名单与 123/124 相同的所有位置都已加上 125：`web-identity.ts`（三处）、`web-admission.ts`、`web-stage-queue.ts`、`web-vertical-publisher.ts`、`web-v7-request.ts`、`platform/store.ts`（`WEB_INVITE_TIERS_SCHEMA`）、`cloudflare/web-store.ts`（版本列表 26 项）、`workers/web-cloudflare/migrations.ts`、`scripts/web-provider.ts`、`web-provider-migration.ts`（`migrateWebProviderInviteTiers`）。
2. **回填在迁移里一次性完成**，用的是数据库时钟（`strftime('now')`）判断“授权是否仍有效”：邮箱登录 + 有效授权的邀请主体（`kind='invite'`）得到一条 `unlimited` 额度（到期时间 = 授权的到期时间）；授权已过期/已撤销的**不产生额度**（它们早已是注册玩家，见 17h/17i）；没有登录的邀请主体**不变**，继续走旧路径直到授权结束。**不改任何主体的 kind，不改任何 retention 状态，不改任何授权行。**
3. 玩家编号也在迁移里回填（每个已注册玩家一个，8 位 Crockford base32，随机、唯一、非顺序；极小概率的碰撞由第二条语句补上，仍缺的由应用在下次读取账号时分配）。
4. 旧邀请码按批次名各归入一个 `legacy:<名称>` 批次（档位 `unlimited`），尚未兑换的旧码以后兑换得到“不限量”额度（时长沿用旧码的 `access_duration_ms`）。
5. 部署顺序同 124：先 `SIGNUP_BONUS_ENABLED`/`PLAYER_MODEL_CHOICE_ENABLED` 保持原状部署，`inspect` 确认 `migrations.matches: true`，再让玩家兑换新批次。没有新的密钥、绑定或 wrangler 配置。
6. 回退：迁移是纯增量，不需要回滚。需要时把任一开关关掉即回到旧兑换行为；已发出的额度保留，玩家仍是注册玩家。

**规则（`admission/web-points.ts`、`web-entitlements.ts`）：**
- **不限量（unlimited）**：永不扣点；选模型按“受邀”；每日回复上限（`DAILY_REPLY_LIMIT`）仍作为看不见的防滥用保险，触发时提示原有的“今天聊得够多啦，明天再来找我吧～”。
- **每天补充（daily_refill，每天 +N，总上限 C）**：玩家**每个 UTC 日第一次访问**（打开页面/读取账号/打开消费记录/发消息/兑换）时**增加 N 点**（不是补到 N），写一条 `daily_refill` 事件；当天没访问就没有，漏掉的日子不补。余额不会超过 C：会超过时只加到 C，已达到或超过 C 时不加；注册赠送、管理员赠送（`grantPoints`）同样只加到 C。**已有的点数永不被拿走**（把 C 调低只是暂时不再补充）。按注册玩家的价格扣费；选模型按“受邀”。
- **额度到期/被撤销**：玩家就是普通注册玩家，剩下多少点就是多少点；绝不会 `TRIAL_EXPIRED` 或 `WEB_INVITE_ACCESS_REQUIRED`。
- **访客输入邀请码**：被拒绝（`PLAYER_LOGIN_REQUIRED`），**邀请码不会被消耗**；页面显示“注册后即可使用邀请码”和注册按钮。

**管理页 玩家 → 邀请与额度（取代原“邀请码”页）：** 新建批次（名称、数量 1–500、档位：不限量 / 每天补充 N（默认 50）与上限（默认 1000）、可选额度天数、可选兑换截止日期 UTC）；邀请码**只显示一次**并可下载只含邀请码的 CSV，同一请求 ID 重放得到同一批次但不再给出邀请码；批次列表（档位、N/上限、创建、邀请码、已兑换、已撤销、持有中）；每批的邀请码按序号显示状态、兑换时间、到期日和持有人的**玩家编号**（不显示邮箱、昵称、任何 ID）；撤销未兑换的码、整批（只作废未兑换的码，已兑换的玩家不受影响）、已兑换码的额度（玩家立即变回注册玩家）。**创建、查看、撤销需要主管理员或新权限 `invites.manage`；修改批次的每天补充和上限只有主管理员能做**，保存前弹出确认，写明改动和当前持有这批的人数，并写入审计日志（`web_admin_audit`）与 `web_invite_batch_changes`；改动从每位持有人的下一次每日补充起生效。旧权限 `invites.issue`/`revoke-*` 仍存在（旧的 玩家授权 页继续使用）。

**玩家 我的信息：** 顶栏昵称按钮直接打开（不再是下拉菜单），邀请码入口移到里面：资料（昵称可改、玩家编号带复制、邮箱）、额度（档位、到期日、同一格式的余量 “剩余 N 点 · 约可聊 n 条” 或 “不限量”、消费记录、输入邀请码；**不显示任何上限文字**）、安全（修改密码、退出其他设备）、退出登录，其后另起一块的删除我的账号。访客看到体验状态、注册/登录和“注册后即可使用邀请码”。

**`inspect`：** 新增 `tiers`：按有效档位统计人数（`guest`/`registered`/`unlimited`/`daily_refill`/`account`），只有数字，没有 ID。

**删除我的账号：** 玩家的额度、兑换记录、每日补充记录和玩家编号随玩家一起清除；邀请码行（只是摘要）保留，已用过的码不会复活。

## 私有运维工具

`scripts/web-cloudflare-operator.ts` 需要显式 `CLOUDFLARE_ACCOUNT_ID`，以及指向已安装 Wrangler 模块的绝对路径 `FAKE_WEB_WRANGLER_MODULE`。它只使用绑定到业务/预算 Worker 的认证 RPC。服务名默认为 `fakebubble-business` / `fakebubble-budget`；部署使用其他名称（例如 `fake-paopao-web-business` / `fake-paopao-web-budget`）时，必须显式传入 `--business-service=<名称>` 与 `--budget-service=<名称>`（均须匹配 `/^[a-z0-9-]{1,63}$/`，任何操作都可携带，缺省即默认名称）。每条收据都会记录目标服务名（`target.businessService` / `target.budgetService`，以及本次操作实际使用的 `worker`）；收据永远不会被续写或覆盖（独占创建，已存在即 `EEXIST`），而且若已存在的收据记录的目标与当前参数不同，工具会先以 `WEB_OPERATOR_RECEIPT_TARGET_MISMATCH` 拒绝，不会打开任何绑定。记录目标之前写下的旧收据按其 `worker` 名称比较。

调用必须指定 `--action`、绝对路径 `--receipt-file`，部分操作还需要 `--input-file` / `--name`。收据目录权限 0700，输入/收据文件 0600。工具先持久化准备状态，再调用；未知结果应核查收据及服务端状态，**不要盲目重试**。首次主管理员入口只在受控初始化阶段启用，完成后关闭。

### 运维开关（`OPERATOR_ENABLED`）的判定位置

开关只在 `WebOperatorService`（每次请求都读取新的 env）里判定：不是 `true` 时以 `WEB_CLOUD_OPERATOR_DISABLED` 拒绝。业务 Durable Object 不再读取 `OPERATOR_ENABLED`（对象的 env 在实例启动时固定，而它每 30 秒重设一次 alarm，永远不会被回收，所以仅改 vars 的部署之后它会一直带着旧值）。对象的运维方法（`initialize`、`importFixed`、`adminGrant`、`adminRecoveryGrant`、`inviteGrants`、`status`、`inspect`、`renewPrices`）改为要求一个证明参数：`HMAC-SHA256("fakebubble-operator-v1")`，密钥为已有的 `SEAL_KEY`（只绑定在业务 Worker 上，edge Worker 虽有 BUSINESS 命名空间绑定却没有这个密钥，因此永远调不了运维方法），常量时间比较，失败为 `WEB_CLOUD_OPERATOR_PROOF_INVALID`。没有新密钥，部署步骤不变。

因此 A/B 做法照旧可用：临时把 `OPERATOR_ENABLED` 设为 `true` 部署（A），用完改回 `false` 再部署（B），即使两次部署的代码完全相同、只改了 vars；**不需要再等待对象重启或回收**。

### 清除（retention）失败日志与健康行（Part 17g）

清除某个玩家失败时，业务对象向尾日志（`wrangler tail`）写一行 JSON，`event` 为 `web_retention_failed`。Part 17g 起它说明**哪里坏了、是什么类型的错**，但永远不含 id、邮箱、IP 哈希、昵称或聊天内容：

| 字段 | 含义 |
| --- | --- |
| `step` | `sweep`（闹钟扫描）或 `deletion`（玩家自己的删除请求，立刻尝试的那次） |
| `code` | 抛出的是 `DomainError` 时为其固定错误码；**不是 DomainError 时恒为 `WEB_RETENTION_FAILED`**——此时看下面几项 |
| `phase` | 哪个调用抛的：`markExpired`、`clearDatabase`、`eraseAudio`，或 `archive`（扫描开头的审阅存档清理） |
| `sub` | 该调用里正在执行的语句组（固定标签）：`scope`、`audit_source`、`purge_gate`、各个表名（如 `web_provider_media_assets`、`memory_facts`）、`cocreation`、`free_ops`、`points`、`review_codes`、`player_logins`、`jobs`、`messages`、`foreign_key_check`、`audio_objects`、`retention_row` 等 |
| `errorName` | 错误的构造函数名（`Error`、`TypeError`、`DomainError`、`SqliteError`……） |
| `messageShape` | 错误信息，其中引号内文字→`<q>`、类邮箱文字→`<email>`、8 个及以上 `[A-Za-z0-9_-]` 的串（id、哈希、令牌；`snake_case` 标识符与表名除外）→`<tok>`、数字→`<n>`、非 ASCII→`<u>`，截断到 160 字符。`FOREIGN KEY constraint failed`、`no such table: x`、触发器的固定错误码（如 `WEB_PROVIDER_MEDIA_IMMUTABLE`）都会保留 |
| `at` | 我们代码里第一个栈帧，仅 `文件名:行号` |
| `principalKind` / `state` | 失败的主体种类（`guest`/`invite`/`account`）和清除状态（`active`/`purging`/`unstarted`） |
| `failed` / `stuck` / `backedOff` | 本组相同原因的失败数 / 本次扫描失败的不同主体数 / 因退避被跳过的主体数 |
| `oldestAgeBucket` | 失败行已到期多久的最老档：`<1d`、`1-7d`、`7-30d`、`>30d` |

同一次扫描里原因相同的失败合并为一行，每次扫描最多四行。**读法：** 先看 `phase`+`sub` 定位语句组，再看 `errorName`/`messageShape`：`WEB_…_IMMUTABLE` 是触发器拒绝；`FOREIGN KEY constraint failed` 是还有子表引用着要删的行；`no such table` 是代码与账本不一致；`CHECK constraint failed` 是写入存档/行时违反约束。`principalKind` 为 `invite` 而 `guest` 正常，说明问题只在受邀玩家的清除路径上。

**退避：** 清除失败的主体不会在每次闹钟（30 秒）都被重试，而是按连续失败次数等待 1 分钟、5 分钟、30 分钟，之后每 6 小时一次；成功即清零。闹钟本身照常运行，其他主体、队列与告警不受影响。退避状态（主体 id 与计数，仅存于对象内部）放在 Durable Object 的键值存储 `retention:ledger`，**没有新增迁移或列**（`web_guest_retention` 没有可用的列）。

**健康行（Part 22a2 起带失败清单）：** `status` 的 `retentionHealth` 与 `inspect` 的 `retention.health` 还有 `failures`：对每个正在失败的主体（最多 20 个，次数多的在前）给出上一次失败的 `code`、`phase`、`sub`、`errorName`、`messageShape` 和连续失败次数 `count`——**没有任何 id**，所以下一次排查不需要实时 tail。它们来自退避账本（`retention:ledger`，每个主体多存一个固定标签的小对象）；这一版之前留下的账本条目在该主体下一次失败之前没有细节。其余部分只含计数与时间：`failing`（当前处于失败状态、尚未清除完的主体数）、`oldestAgeBucket`（其中最老的到期档，没有则为 `null`）、`lastSuccessAt`（最近一次清除完成的时间，毫秒时间戳，没有则为 `null`）。`failing` 长期大于 0 就需要按上表排查。

### `inspect`（只读检查）

`--action=inspect` 通过与 `status` 完全相同的认证服务绑定调用业务对象的只读 RPC，结果只写入私有收据。认证与 `status` 一致：业务 Worker 的 `OPERATOR_ENABLED` 不是 `true` 时两者都以 `WEB_CLOUD_OPERATOR_DISABLED` 拒绝（`status` 在关闭时同样不可用，因此 `inspect` 不开例外）。它只执行 `SELECT` 和一次预算 `summary()` 读取，测试用完整表快照与写入计数器证明执行前后不变。

只返回：架构版本；已应用的迁移账本（版本 + sha256）与本版代码期望的步骤（内联与 R2 两份列表），以及布尔 `matches`（与对象实际使用的 R2 列表逐步比较）；`web_instance` 的实例 ID 与恢复纪元；各供应商的已花费/占用额度；三个派发账本（web provider、external、embed）中 `unknown` 尝试的数量及其 ID（最多 200 个，数量精确，不含任何内容）；是否存在 owner 管理员（仅布尔，无邮箱）；`PUBLIC_ENABLED` / `EXTERNAL_CALLS` / `OPERATOR_ENABLED` / `EMBEDDINGS_ENABLED` 当前值（仅 `true`/`false`/未设置，其他值显示为 `other`）；`players` 一节：`PLAYER_SIGNUP_ENABLED`（`true`/`false`/未设置/`other`）、`PLAYER_EMAIL_DAILY_CAP`（合法数字，未设置为 `null`，其他值为 `other`）与 `PLAYER_EMAIL_BINDING_PRESENT`（`PLAYER_EMAIL` 发信绑定是否存在，布尔），不含任何地址、发件人或密钥。不返回密钥、邮箱、邀请码、消息文本或记忆。

**限制：** 迁移的哈希校验与升级发生在业务对象的构造函数里，早于任何 RPC。新代码上的第一次任何调用（包括 `inspect`、HTTP、闹钟）都会先把 113 升级到 118；若某一步哈希不一致，构造函数抛出 `WEB_CLOUD_MIGRATION_MISMATCH`，`inspect` 同样失败，而不是返回 `matches:false`。所以 `inspect` 用于**部署之后**核对结果，不能预演升级；升级前请用下面的 `expected-migrations` 离线取得期望摘要。

```
node scripts/web-cloudflare-operator.ts --action=inspect --receipt-file=/abs/private/inspect.json \
  --business-service=fake-paopao-web-business --budget-service=fake-paopao-web-budget
```

### `renew-prices`（供应商价格续期）

供应商价格行（DeepSeek 草稿/审阅、Fish 语音，`web_provider_prices`）有有效期：初始化写入的第一行只有 30 天，过期后所有回复都会以 `WEB_PROVIDER_PRICE_REQUIRED` 失败。`--action=renew-prices` 为当前代码价格表的每一项**追加**一行 90 天的新价格（上限单价与代码一致）：新行从该项最新一行的 `valid_until` 开始（没有行或已过期则从现在开始），行与行首尾相接、从不重叠；已有的行从不修改或删除。行 ID 由（供应商、模型、阶段、起点）派生，重试只会得到“重复”，不会多出一行。最新一行离到期还超过 60 天时什么都不做，报告 `not-due`。管理员预演使用同一张价格表，一并续期；向量（bge-m3）按自己的固定价格记账，不在此表中，不受影响。

**价格变更（Part 21i）：** 若某项当前生效行的单价与代码里的不同（例如 drama-3 由 15 改为 50），`renew-prices` 不等到 60 天窗口，而是追加一个**更高版本**的新行、从运行那一刻起生效，有效期不短于被取代的行；账本查询取当前生效的最高版本。旧行从不修改或删除，之前已预留的回复保留它们当时的价格行。除这一种“更高版本取代”之外，重叠的价格行仍被拒绝（`WEB_PROVIDER_PRICE_OVERLAP`）。

认证与 `inspect`、`status` 完全相同：需要**临时**把业务 Worker 的 `OPERATOR_ENABLED` 设为 `true`，用完立即改回 `false`。**每次部署检查清单都运行一次**（未到期时是空操作，所以每次都跑也无妨）。结果只写入私有收据。`inspect` 的 `prices` 一节列出每个（供应商、模型、阶段）当前生效的价格行 ID 与 `valid_until`，以及最新的 `valid_until`（只有数字与 ID）。开启 `ALERTS_ENABLED` 时，任何在用价格 7 天内到期（或已过期）会给 owner 发一封告警（沿用每类 6 小时一封的限制），日报里显示最早的到期日。

```
node scripts/web-cloudflare-operator.ts --action=renew-prices --receipt-file=/abs/private/renew-prices.json \
  --business-service=fake-paopao-web-business --budget-service=fake-paopao-web-budget
```

### `expected-migrations`（离线期望摘要）

```
node scripts/web-cloudflare-operator.ts expected-migrations
```

纯本地命令：不需要 `CLOUDFLARE_ACCOUNT_ID`、Wrangler 模块或网络，也不写收据。它输出本版代码期望的每个 Cloudflare 迁移步骤的版本与 sha256（`inline` 与 `r2` 两份列表；已部署的业务对象使用 `r2`，两者只在 113 一步不同），哈希方式与业务对象校验已应用步骤时完全相同（对步骤 SQL 文本取 sha256）。测试把它的输出与 workerd 中业务对象自己算出的结果逐项比对。升级前可用它与现有账本核对；部署后用 `inspect` 对照实际账本。

## 本地真实供应商适配（非默认预览）

`scripts/web-provider.ts` 保留受控本地适配，`serve` / `render-assets` 必须显式 `--live`；这不是供应商付费授权。真实材料和凭据仍需独立准备。

- `selected-voice-pins.json`：0600 私有指纹清单；结构见 `config/selected-voice-pins.json.example`。`directory` 指向同一材料根下的已审核目录。该目录需包含 `USER-SELECTION.json`、`PUBLICATION.json` 和每个角色的 `*-VOICE.json` / `*-DRAFT.json` / `*-PUBLISHED.json`。指纹文件只绑定字节，不能代替使用权或听感审核。
- `FAKEBUBBLE_BUDGET_AUTHORITY`：指向 0600 绝对路径配置，结构见 `config/budget-authority.json.example`。同一供应商账户下的所有本地实例必须使用同一个 `budgetPath` 和完整 `historyRoots`。只有确实不存在历史调用的新环境才可填空历史列表。路径不能按实例临时变化。
- 供应商 `.env` / `.env.voice` / `.env.embed` 不随源码分发。禁止把生产运营预算作为任意测试许可；禁止自动重发 UNKNOWN 调用。

### 退役旧邀请体系（Part 22x，迁移 126）

删除：恢复码（签发、重新生成、输入、“你的恢复码”弹窗）、旧邀请兑换（`kind='invite'` 的会话与授权）、`web_invite_credentials` 与各类回执、路由 `/invites/credential`、`/invites/credential-regenerate`、`/invites/recover`、`/identity/invite-receipt-challenge|recover|status`、`/identity/receipt-challenge|recover|status`、`/admin/invites/issue|revoke-code|revoke-grant`、`/admin/invites/list`（旧邀请记录）、运营命令 `invite-grants`、玩家的“绑定邮箱”流程；浏览器端 `?mode=local-2|local-3|local-3-admin` 与静态演示原型。**旧表一个都没有删**，只是不再有人读写它们。

**迁移 126（`126_legacy_invites_retired.sql`）** 只改数据，不改表结构：每个 `kind='invite'` 的主体变成 `guest`；其中 retention 状态为 `protected` 的改为 `active` 并给一个已结束的试用窗口。有邮箱登录的 = 已注册玩家（17h/17i 规则、22a 额度照旧）；没有登录的 = 试用已结束的访客，没有访问权，由保留期清理器按原有的、带审计且失败即关闭的路径清理。`purging`/`purged` 的主体只改 kind。共 **51 步**（`expected-migrations`，inline 与 R2 各 51，最后一步 `version 126`，两边同一份 SQL）。sha256：

```
68526f0cfc26957124a4a2f7ea9bcc600cc11c6ba0fcb3702b866aba67efec4e   apps/server/web-migrations/126_legacy_invites_retired.sql
```

（125 仍是 `9e7d9ca7…7e85a1d`，1–125 一个字节没动。）本地：`scripts/web-provider.ts migrate-legacy-invites <root>`（新实例的 `migrate` 一路到 126）；Cloudflare：账本版本 126，已在 125 的权威启动时自动补上。版本白名单加上 126 的位置同 125（`web-identity.ts`、`web-admission.ts`、`web-stage-queue.ts`、`platform/store.ts`（`WEB_LEGACY_INVITES_SCHEMA`）、`cloudflare/web-store.ts`（版本列表 27 项）、`workers/web-cloudflare/migrations.ts`、`scripts/web-provider.ts`、`web-provider-migration.ts`）。部署：先确认 `inspect` 的 `migrations.matches: true`；旧邀请玩家里没有邮箱登录的会失去访问并被清理（主管理员已确认只有其自己的测试账号），有登录的照常以注册玩家登录。回退：迁移是单向数据变更，不提供回滚。

不要把 `runtime/`、Secrets、材料目录、邮件、收据、真实数据库或构建产物提交到 GitHub。


### 邀请码可再次查看（Part 22a2，迁移 127）

**迁移 127（`127_invite_codes_viewable.sql`，sha256 `3cc1d4c03ebbdf90f02ce751341a7aa175804c35799dfe34b29034dd1ae54ecf`）：** 共 **52 步**（`expected-migrations`，inline 与 R2 各 52，最后一步 `version 127`，两边同一份 SQL；1–126 一个字节没动，126 仍是 `68526f0c…efec4e`）。只加两列，不改任何已有行：`web_invite_codes.code_sealed BLOB`（可空）和 `web_invite_batches.created_by_member TEXT`（可空）。本地：`scripts/web-provider.ts migrate-invite-codes <root>`（新实例的 `migrate` 一路到 127）；Cloudflare：账本版本 127，已在 126 的权威启动时自动补上。版本白名单加上 127 的位置同 126。**部署：** 先确认 `inspect` 的 `migrations.matches: true`；回退：两列可空且旧代码不读它们，把代码退回即可，不需要回滚迁移。

- **存储。** 兑换仍只读 `code_digest`（HMAC），没有变。从 127 起**新建**的码同时加密保存：`code_sealed = nonce(12) ‖ AES-256-GCM 密文 ‖ tag(16)`，密钥由业务 Worker 的 `SEAL_KEY` 经 HKDF-SHA256 派生（info 为 `invite-code-v1`），附加认证数据是该码所在行的 id（密文不能被搬到另一行）。`SEAL_KEY` 换了，旧的密文打不开，该码显示为“旧邀请码无法再次查看”，兑换不受影响。**127 之前建的码只有摘要，永远无法再次查看**（不回填）；这些行 `code_sealed` 为 NULL。`created_by_member` 记录建批次的**管理员本人**（登录会话 8 小时就失效，所以不能用会话判断“谁建的”）。
- **谁能看什么**（服务端判定，浏览器从不拿到它无权看的明文）：主管理员——所有码的明文；有 `invites.manage` 的管理员——**自己建的**批次明文，其他管理员建的批次里码显示为 `********`，但批次名、档位、N/上限、数量、已兑换、状态都可见；其余人看不到这个页面（`ADMIN_PERMISSION_REQUIRED`）。127 之前的码对所有人（包括主管理员）都显示“旧邀请码无法再次查看”。
- **批次详情**（`/admin/invites/batch-detail`）列出每个码：序号（按生成顺序）、邀请码、状态（未使用 / 已兑换 / 已撤销）、兑换时间（UTC）、玩家编号、额度到期；每个可见的码有自己的“复制”。**导出表格**（新路由 `/admin/invites/batch-export`）返回同样的列、同一套遮罩规则的 CSV，开头带 UTF-8 BOM（Excel 直接显示中文）。以 `=`、`+`、`-`、`@` 开头的单元格（邀请码是 base64url，六十四分之一以 `-` 开头）前面加一个制表符，Excel 当作文本；兑换框会去掉首尾空白，粘贴回去仍可用。
- **审计**（`web_admin_audit`：管理员、动作、批次 id；绝不含邀请码、玩家 id、邮箱）：`invite-batch-exported:<行数>`——每次导出都记（即使全是 `********`）；`invite-codes-viewed:<行数>`——某次批次详情里真的发出了明文码时记（只含遮罩/旧码的查看不产生明文，不记）。`/admin/invites/batch-detail` 因此不再属于“只读 POST”白名单（走写入限速）。
- **创建结果**仍然当场显示邀请码并提供“复制”和“下载 CSV”，但不再是唯一的机会。

### 旧邀请主体清除失败（Part 22a2）

**现象：** 22x 部署后 `purging=2, failing=2`。**根因（已用失败测试复现）：** 迁移 126 把旧 `kind='invite'` 主体变成已过期的访客，但没有动 `web_invite_grants` 及其子表；清除末尾的 `cleared` 审计（`admission/web-lifecycle-audit.ts`）拒绝仍有**未撤销授权**的世界，报 `WEB_RETENTION_UNEXPECTED_WORLD_DATA`（`phase=clearDatabase`、`sub=audit_cleared`）。**修复：** `identity/web-player-purge.ts` 的 `purgeLegacyInvites` 在清除同一事务里、按外键顺序删除该主体的 `web_invite_redemptions`、两种回执和 `web_invite_credentials`，并**撤销**授权（授权行作为已允许的外壳保留：只有 id 和时间）；它由 `purgePlayerLogins` 调用，所以 Cloudflare 的 `clearDatabase`、Node 清除器和玩家自己的删除请求共用同一个实现，`playerLoginsRemain` 也会在还剩任何一行时让审计失败。已卡住的两个主体在部署后的下一次闹钟（退避内最多 6 小时）自行完成，无需手工操作。

### 登录会话 Cookie

- 有邮箱登录的玩家（以及注册当下的会话）使用 `Max-Age=34560000`（400 天，浏览器上限）的会话 Cookie，每次成功 bootstrap 重新下发；访客仍是 24 小时（开启免费档后为试用期 + 宽限期）。`__Host-`、`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` 不变。
- 旧的“受邀会话不过期”“恢复码接口（`/invites/credential`、`/invites/credential-regenerate`、`/invites/recover`）”“邀请回执接口（`/identity/invite-receipt-*`）”与会话回执接口（`/identity/receipt-*`）已在 Part 22x 删除。

### 提示词变更（Part 11e）

- Part 11e 修改了角色语气、时间克制、审核保留角色语气及 AI 诚实表述的提示词，因此 `POLICY_HASH` 与 `PROMPT_HASH` 已变化（协议指纹不变）。下一次角色发布之前，必须重新运行角色预演（预演测试），不能沿用旧哈希下通过的预演结果。

### 玩家修复（Part 21f，无迁移）

- **登录玩家一律付点数：** 开启点数的登录玩家不再走访客体验路径，任何模型每条都有 `web_operation_models` 与 spend 事件。没用完的体验回复折算进开场余额（每条 10 点）。
- **价格：** `POINTS.version` = 2；xAI 25 点/条（DeepSeek 10、Gemini 20、语音 +2，仍在 `packages/contracts/player-models.ts` 一张表里）。旧事件保留 `price_version` = 1。
- **消费记录：** 顶部账号菜单 → “消费记录”（登录玩家、受邀玩家，以及 Part 21i 起的访客：访客的页面只有“免费试用 已用 n/5 条”和自己的试用回复，没有余额；功能开关关闭时仍是 404）。登录玩家顶部是“免费额度 {总数} 点 · 已用 {n} · 剩余 {余额}”（总数 = bonus / grant / daily_refill / reset 事件之和，含注册时折算的试用；已用 = 回复的净点数；余额 = 总数 − 已用），列表里注册前的试用回复显示为“免费试用”、0 点。`POST /api/web/provider/billing/history { page?, tzOffsetMinutes? }`，只读本会话主体，先 `reconcilePoints`，最近 90 天、每页 50 条。只显示点数，不显示金额、供应商成本或任何 id。
- **Grok 延迟：** 见 `docs/PROVIDERS.md`“Grok latency”；选择器按模型显示速度提示（`PLAYER_MODELS[*].speed`）。
