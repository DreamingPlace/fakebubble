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

服务为 `https://127.0.0.1:18491/`，使用实例内生成的本地证书。验证证书后访问 `?mode=local-2`。它仅含合成人物与离线行为，不代表真实 AI 或声音质量。

邀请码离线场景另建以 `local-invite-` 开头的实例，依次执行 `init`、`migrate`、`migrate-data-lifecycle`、`migrate-invites`，再用 `serve-invites` 启动、以 `?mode=local-3` 访问。测试管理员凭据通过同一实例的 `admin-grant` 命令写入 0600 私有文件，不会直接打印凭据。

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

DeepSeek 自动缓存相同的请求前缀。用户消息 JSON 现在把同一角色多轮之间不变的字段放在前面，每轮都变的字段（`messages`、`currentTime` 等）放在最后；审核调用的用户消息同理，`draftPresentation*` 在最末。内容与取值不变，只改键顺序。

**提示词哈希变化，需要重跑角色预览。** 第 4 步新增“玩家只能发文字”规则（`prompts/v7/player-channel-rules.md`，同时进入起草与审核提示词，并在 `responseConstraints.playerInputKinds` 声明），所以策略哈希与提示词哈希都变了（`web-text-policy.test.ts` 记录了新旧值）。哈希包含在预览批准与发布批准里：升级前批准的角色预览在发布前必须重新运行并重新批准。第 3 步只改变发送给供应商的请求字节（`wireRequestHash`），不改变这两个哈希（哈希覆盖系统提示词与协议指纹，不含用户消息的字段顺序）。

### 聊天边界：帮忙、转开与俚语（Part 11b）

新增 `prompts/v7/chat-boundary-rules.md`（同时进入起草与审核提示词）并扩展 `review-system-body.md`：聊天体量的帮忙允许；批量成品与禁区内容由审核做最小的本人口吻改写（accept 加 `replacementBubbles`），不用模板拒绝；玩家流露真实危险时必须认真接住；被转开的请求按 `answered` 计，不触发定时续答（`later`）或等待玩家（`needs_player`）。协议、状态与预算代码未变。

**提示词哈希变化，需要重跑角色预览。** 策略哈希与提示词哈希都变了（`web-text-policy.test.ts` 记录了新旧值，协议指纹不变）。下一次角色发布前，升级前批准的预览必须重新运行并重新批准。

### 记忆：重要度、玩家事实与召回排序（Part 7a）

`115_memory_importance.sql` 是独立的第 115 版迁移，在 114 之后按顺序执行（Node：`user_version=115`；Cloudflare 内联与 R2：账本版本 115，已在 114 的权威启动时自动补上）。它新增 `memory_topics.importance`（1–10，旧话题默认 3）、`memory_facts`（玩家亲口讲过的稳定事实，每个范围每个 `fact_key` 至多一条有效）和 `web_operation_metrics.review_changed`。Node：新的 provider-* 实例由 `migrate` 一路执行到 115；已在 114 的实例用 `scripts/web-provider.ts migrate-memory <root>` 升级。`memory_facts` 属于用户数据：访客保留清理、角色删除、生命周期审计都会覆盖它。

审核输出新增：每个话题的 `importance` 与 `memoryId`（本次请求召回的记忆 id 或 null，用来把同一件事的另一种说法并入已有记忆）；以及最多 3 条 `factOps`（add/update/retire，证据只能是本次请求里玩家自己的消息，角色的话永远不能生成事实）。起草与审核的用户消息在 `playerIntroduction` 之后新增 `playerFacts`（最多 20 条，重要度高者在前）。召回按 `0.5×相关度 + 0.3×重要度/10 + 0.2×exp(-小时/72)` 排序（`packages/domain/dialogue.ts` 的 `RECALL`），重要度 ≥ 7 或玩家提及 ≥ 2 次升为长期记忆。

**提示词哈希与协议指纹变化，需要重跑角色预览。** 第 A 步让提示词哈希覆盖 `prompts/v7/` 的每个文件；第 D、E 步改变审核工具 schema 与审核提示词；第 G 步改变提示词内容（`web-text-policy.test.ts` 记录各步的新旧值）。升级前批准的角色预览在发布前必须重新运行并重新批准。管理员的阶段延迟接口按日新增 `review`（`samples`/`changed`/`rate`：审核改写草稿的比例）。

### 共创收件箱（Part 12）

`117_cocreation.sql` 是独立的第 117 版迁移（Node：`user_version=117`，已有 provider 实例运行 `migrate-cocreation`；Cloudflare 内联与 R2：账本版本 117，已在 116 的权威启动时自动补上）。新增 `web_cocreation_submissions` 与 `web_cocreation_answers`（均为用户数据）。受邀玩家通过 `POST /api/web/provider/cocreation/submit` 为官方角色留下想法（每答案 ≤300 字，自由卡 ≤1000，对话卡每句 ≤120；每次 ≤12 条；每玩家每角色滚动 24 小时 ≤5 次；按 requestId 幂等；不计入 DAILY_REPLY_LIMIT；不调用任何供应商、不预占预算）。管理员权限 `cocreation.read`（查看）与 `cocreation.manage`（处理）由主管理员在权限编辑器的“角色 · 共创收件箱”中授予，不包含在四个功能类别里。收件箱只显示稳定的匿名代号（`玩家#` + 4 位十六进制，来自 requestKey 派生密钥的 HMAC）和邀请批次名。内容只有在管理员“加入草稿”并经现有预览与发布流程后才会进入提示词。角色删除与玩家数据清理会一并删除这些行。

### 邮箱账号与多设备登录（Part 11f）

`118_player_logins.sql` 是独立的第 118 版迁移（Node：`user_version=118`，已有 provider 实例运行 `migrate-logins`；Cloudflare 内联与 R2：账本版本 118，已在 117 的权威启动时自动补上）。新增 `web_player_logins`（邮箱 + scrypt 密码哈希，与已有 principal 一对一绑定）、`web_email_challenges`（验证码摘要与发送账本）、`web_player_email_daily`（每个 UTC 日的发送计数）、`web_player_throttle`（登录失败计数，键为 HMAC）。登录只是 principal 的**凭据**：principal 种类、准入与权益不变；有登录但没有有效邀请的 principal 仍按访客试玩处理；登录创建的会话 `account_id` 仍为 NULL，不使用旧的 `web_accounts`/Argon2 路径。

**业务 Worker 新增配置（`workers/web-cloudflare/deploy/business.json.example` 已列出）：**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `PLAYER_EMAIL` | `send_email` 绑定 | Cloudflare Email Service（Email Sending）发信绑定，只发纯中文文本，无链接、无 HTML、无追踪。 |
| `PLAYER_EMAIL_FROM` | 变量 | 发件地址，必须属于已完成发信域名验证的域。 |
| `PLAYER_SIGNUP_ENABLED` | 变量，默认 `false` | 开启注册、绑定邮箱与忘记密码。为 `false` 时这三个入口显示“注册暂未开放”，**登录照常可用**，邀请码兑换也照旧（不要求登录）。为 `true` 时必须同时配置 `PLAYER_EMAIL` 与 `PLAYER_EMAIL_FROM`，否则业务对象拒绝启动；并且兑换邀请码要求先登录。 |
| `PLAYER_EMAIL_DAILY_CAP` | 变量，默认 `200` | 所有玩家合计每个 UTC 日最多发送的邮件数（1–100000）。 |

**上线前：** (1) 在 Cloudflare Email Service 里为发件域名完成 **Sending Domain onboarding**（添加域名并按提示写入 SPF / DKIM / DMARC 的 DNS 记录，等待状态变为已验证）；(2) Email Service 的发信需要 **Workers Paid** 套餐；(3) 先保持 `PLAYER_SIGNUP_ENABLED=false` 部署，确认迁移账本 `matches:true` 后再改为 `true` 重新部署；(4) 用自己的邮箱走一遍注册、登录、忘记密码。

**验证码：** 6 位数字，10 分钟有效，每个挑战最多 5 次错误尝试，新的请求使同邮箱同用途的上一个挑战失效。限制在发送之前检查：同一邮箱两次发送至少间隔 60 秒、每小时最多 5 次；同一 IP 每小时最多 10 次；全局每日上限 `PLAYER_EMAIL_DAILY_CAP`。发送超时或出错不会自动重试，玩家可在冷却后点“重新发送”（计入上述限制）。请求验证码的回应对已注册与未注册邮箱完全相同：已注册邮箱收到“你已注册，可直接登录或重置密码”，不含验证码；忘记密码遇到未注册邮箱不发邮件。验证码、密码和完整邮箱不进入日志、指标、回执或错误；管理员的玩家/邀请记录只显示打码邮箱（首字符 + `***` + 域名）。

**登录与会话：** 邮箱 + 密码（8–128 字节）；同一邮箱 15 分钟内失败 10 次、同一 IP 失败 30 次后需要等待；错误提示一律为“邮箱或密码不正确”。登录只新建会话，其他设备的会话不受影响，永远不合并两个 principal；对已被撤销邀请的受邀 principal，输对密码后给出明确的拒绝，管理员“撤销授权”照旧一次性结束全部会话并阻止今后的登录。忘记密码会结束该 principal 的其他全部会话；修改密码可选择同时退出其他设备。登录会话与注册当下的会话使用与受邀玩家相同的 400 天 Cookie，服务端以 400 天为上限。已失效/被撤销/被轮换的 Cookie 在 `bootstrap` 时由服务端清除，页面回到“登录 / 注册 / 以访客继续”的首页；仅当一次未确认的邀请兑换回执仍可取回时保留 Cookie。

**旧受邀玩家（只有恢复码）：** 在聊天页“⋯”里“绑定邮箱”，验证后设置密码与昵称，绑定成功即撤销其恢复码；恢复码接口与测试保持不变，未绑定的玩家仍可从首页的小链接使用。

**数据清理：** 登录行与验证码挑战是玩家数据，随玩家清理一并删除（Node 与 Cloudflare 保留期清理器、生命周期审计在清理后仍有残留时失败关闭）；昵称写入的“名片”修订同样随之删除。

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

## 私有运维工具

`scripts/web-cloudflare-operator.ts` 需要显式 `CLOUDFLARE_ACCOUNT_ID`，以及指向已安装 Wrangler 模块的绝对路径 `FAKE_WEB_WRANGLER_MODULE`。它只使用绑定到业务/预算 Worker 的认证 RPC。服务名默认为 `fakebubble-business` / `fakebubble-budget`；部署使用其他名称（例如 `fake-paopao-web-business` / `fake-paopao-web-budget`）时，必须显式传入 `--business-service=<名称>` 与 `--budget-service=<名称>`（均须匹配 `/^[a-z0-9-]{1,63}$/`，任何操作都可携带，缺省即默认名称）。每条收据都会记录目标服务名（`target.businessService` / `target.budgetService`，以及本次操作实际使用的 `worker`）；收据永远不会被续写或覆盖（独占创建，已存在即 `EEXIST`），而且若已存在的收据记录的目标与当前参数不同，工具会先以 `WEB_OPERATOR_RECEIPT_TARGET_MISMATCH` 拒绝，不会打开任何绑定。记录目标之前写下的旧收据按其 `worker` 名称比较。

调用必须指定 `--action`、绝对路径 `--receipt-file`，部分操作还需要 `--input-file` / `--name`。收据目录权限 0700，输入/收据文件 0600。工具先持久化准备状态，再调用；未知结果应核查收据及服务端状态，**不要盲目重试**。首次主管理员入口只在受控初始化阶段启用，完成后关闭。

### `inspect`（只读检查）

`--action=inspect` 通过与 `status` 完全相同的认证服务绑定调用业务对象的只读 RPC，结果只写入私有收据。认证与 `status` 一致：业务 Worker 的 `OPERATOR_ENABLED` 不是 `true` 时两者都以 `WEB_CLOUD_OPERATOR_DISABLED` 拒绝（`status` 在关闭时同样不可用，因此 `inspect` 不开例外）。它只执行 `SELECT` 和一次预算 `summary()` 读取，测试用完整表快照与写入计数器证明执行前后不变。

只返回：架构版本；已应用的迁移账本（版本 + sha256）与本版代码期望的步骤（内联与 R2 两份列表），以及布尔 `matches`（与对象实际使用的 R2 列表逐步比较）；`web_instance` 的实例 ID 与恢复纪元；各供应商的已花费/占用额度；三个派发账本（web provider、external、embed）中 `unknown` 尝试的数量及其 ID（最多 200 个，数量精确，不含任何内容）；是否存在 owner 管理员（仅布尔，无邮箱）；`PUBLIC_ENABLED` / `EXTERNAL_CALLS` / `OPERATOR_ENABLED` / `EMBEDDINGS_ENABLED` 当前值（仅 `true`/`false`/未设置，其他值显示为 `other`）。不返回密钥、邮箱、邀请码、消息文本或记忆。

**限制：** 迁移的哈希校验与升级发生在业务对象的构造函数里，早于任何 RPC。新代码上的第一次任何调用（包括 `inspect`、HTTP、闹钟）都会先把 113 升级到 118；若某一步哈希不一致，构造函数抛出 `WEB_CLOUD_MIGRATION_MISMATCH`，`inspect` 同样失败，而不是返回 `matches:false`。所以 `inspect` 用于**部署之后**核对结果，不能预演升级；升级前请用下面的 `expected-migrations` 离线取得期望摘要。

```
node scripts/web-cloudflare-operator.ts --action=inspect --receipt-file=/abs/private/inspect.json \
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

不要把 `runtime/`、Secrets、材料目录、邮件、收据、真实数据库或构建产物提交到 GitHub。


### 受邀玩家保持登录与恢复码（Part 11d）

- 持有未撤销邀请授权的玩家，其会话不受 24 小时绝对期限和空闲期限约束（访客仍是 24 小时，管理员与账号会话不变）；恢复纪元、`revoked_at` 等其他检查照旧。无需迁移：判断在 `activeSession` 中按主体的有效授权做出，因此已经“过期”的受邀会话在授权仍有效时会自行恢复。
- 每次成功 bootstrap（以及兑换、恢复）都会重新下发会话 cookie，`Max-Age=34560000`（400 天，浏览器上限）；`__Host-`、`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` 不变。
- 管理员在邀请记录里撤销授权（`revoke-grant`）时，同一事务内结束该主体的全部会话并停用其恢复码；撤销未兑换的邀请码仍只阻止今后兑换。
- 玩家兑换成功后页面一次性显示恢复码（`POST /invites/credential-regenerate`，需要 CSRF、Origin 与有效受邀会话；旧码立即失效）。凭恢复码调用 `POST /invites/recover`（沿用每个 IP 哈希每分钟 20 次的失败限额）可在新浏览器里恢复同一主体、同样的聊天与记忆，并轮换出一个新码；每个码只能用一次，错误或已用过的码返回同一个中性错误。恢复码只存摘要，页面不写入 localStorage 或 cookie，也不记录日志。

### 提示词变更（Part 11e）

- Part 11e 修改了角色语气、时间克制、审核保留角色语气及 AI 诚实表述的提示词，因此 `POLICY_HASH` 与 `PROMPT_HASH` 已变化（协议指纹不变）。下一次角色发布之前，必须重新运行角色预演（预演测试），不能沿用旧哈希下通过的预演结果。
