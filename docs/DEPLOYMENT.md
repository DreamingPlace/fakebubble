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

**验证码：** 6 位数字，10 分钟有效，每个挑战最多 5 次错误尝试，**同一邮箱在所有挑战与用途上合计，滚动 24 小时内最多 10 次错误验证码**（超过后验证与任何用途的请求验证码都返回 `PLAYER_RATE_LIMITED` 并带 `retryAfterMs`，已注册与未注册邮箱的回应完全相同；计数键为邮箱的 HMAC），新的请求使同邮箱同用途的上一个挑战失效。限制在发送之前检查：同一邮箱两次发送至少间隔 60 秒、每小时最多 5 次；同一 IP 每小时最多 10 次；全局每日上限 `PLAYER_EMAIL_DAILY_CAP`。发送超时或出错不会自动重试，玩家可在冷却后点“重新发送”（计入上述限制）。请求验证码的回应对已注册与未注册邮箱完全相同：已注册邮箱收到“你已注册，可直接登录或重置密码”，不含验证码；忘记密码遇到未注册邮箱不发邮件。验证码、密码和完整邮箱不进入日志、指标、回执或错误；管理员的玩家/邀请记录只显示打码邮箱（首字符 + `***` + 域名）。

**登录与会话：** 邮箱 + 密码（8–128 字节）；同一邮箱 15 分钟内失败 10 次、同一 IP 失败 30 次后需要等待；错误提示一律为“邮箱或密码不正确”。登录只新建会话，其他设备的会话不受影响，永远不合并两个 principal；对已被撤销邀请的受邀 principal，输对密码后给出明确的拒绝，管理员“撤销授权”照旧一次性结束全部会话并阻止今后的登录。忘记密码会结束该 principal 的其他全部会话；修改密码可选择同时退出其他设备。**保留期：** 已注册（有邮箱登录）的访客在试玩结束后**不会被保留清理删除**：聊天照常以“试玩已结束”拒绝（准入不变），但仍可登录、查看历史、修改昵称、兑换邀请码（兑换后按受邀玩家规则）。保留状态不新增：`web_guest_retention` 保持 `active` 且已过期，“有登录的访客”由服务端推导；只有显式声明 `read` 的读取路径（历史、事件、操作状态、已发布音频）放行，其余一律按 `live` 判断并返回 `TRIAL_EXPIRED`。没有邀请授权的登录若 **180 天**无活动（`web_player_logins.last_seen_at`，注册、登录时写入，`bootstrap` 每个 UTC 日最多刷新一次）则走原有的、带审计且失败即关闭的访客清理路径连同全部数据删除；没有登录的访客仍在试玩结束时清理。登录会话与注册当下的会话使用与受邀玩家相同的 400 天 Cookie，服务端以 400 天为上限。已失效/被撤销/被轮换的 Cookie 在 `bootstrap` 时由服务端清除，页面回到“登录 / 注册 / 以访客继续”的首页；仅当一次未确认的邀请兑换回执仍可取回时保留 Cookie。

**旧受邀玩家（只有恢复码）：** 在聊天页“⋯”里“绑定邮箱”，验证后设置密码与昵称，绑定成功即撤销其恢复码；恢复码接口与测试保持不变，未绑定的玩家仍可从首页的小链接使用。

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
| `ACCOUNT_DELETE_ENABLED` | `false` | 账号菜单里出现“删除我的账号”（有登录：密码 + 输入“删除”）和“清除本设备的体验数据”（访客：无需密码）。走原有、带审计、失败即关闭的清理路径，立即清除聊天、记忆、语音、共创、名片、登录、验证码挑战与全部会话；受邀玩家的授权在同一事务里撤销。 |
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

**玩家站点公开、只用 Access 保护管理接口：** 公开玩家站点前，在 Cloudflare Zero Trust 里把 Access 应用的路径从整站收窄到只保护 `/api/web/provider/admin/*`（页面 `/?mode=provider-admin` 本身只是静态壳，没有数据；它调用的接口全在该前缀下，且管理员仍有自己的邮箱 + 密码登录和 CSRF）。收窄之前先在预发布域名验证：未登录 Access 访问 `/api/web/provider/admin/session` 被拦，访问 `/`、`/api/web/provider/bootstrap` 不被拦。

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

## 私有运维工具

`scripts/web-cloudflare-operator.ts` 需要显式 `CLOUDFLARE_ACCOUNT_ID`，以及指向已安装 Wrangler 模块的绝对路径 `FAKE_WEB_WRANGLER_MODULE`。它只使用绑定到业务/预算 Worker 的认证 RPC。服务名默认为 `fakebubble-business` / `fakebubble-budget`；部署使用其他名称（例如 `fake-paopao-web-business` / `fake-paopao-web-budget`）时，必须显式传入 `--business-service=<名称>` 与 `--budget-service=<名称>`（均须匹配 `/^[a-z0-9-]{1,63}$/`，任何操作都可携带，缺省即默认名称）。每条收据都会记录目标服务名（`target.businessService` / `target.budgetService`，以及本次操作实际使用的 `worker`）；收据永远不会被续写或覆盖（独占创建，已存在即 `EEXIST`），而且若已存在的收据记录的目标与当前参数不同，工具会先以 `WEB_OPERATOR_RECEIPT_TARGET_MISMATCH` 拒绝，不会打开任何绑定。记录目标之前写下的旧收据按其 `worker` 名称比较。

调用必须指定 `--action`、绝对路径 `--receipt-file`，部分操作还需要 `--input-file` / `--name`。收据目录权限 0700，输入/收据文件 0600。工具先持久化准备状态，再调用；未知结果应核查收据及服务端状态，**不要盲目重试**。首次主管理员入口只在受控初始化阶段启用，完成后关闭。

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

不要把 `runtime/`、Secrets、材料目录、邮件、收据、真实数据库或构建产物提交到 GitHub。


### 受邀玩家保持登录与恢复码（Part 11d）

- 持有未撤销邀请授权的玩家，其会话不受 24 小时绝对期限和空闲期限约束（访客仍是 24 小时，管理员与账号会话不变）；恢复纪元、`revoked_at` 等其他检查照旧。无需迁移：判断在 `activeSession` 中按主体的有效授权做出，因此已经“过期”的受邀会话在授权仍有效时会自行恢复。
- 每次成功 bootstrap（以及兑换、恢复）都会重新下发会话 cookie，`Max-Age=34560000`（400 天，浏览器上限）；`__Host-`、`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` 不变。
- 管理员在邀请记录里撤销授权（`revoke-grant`）时，同一事务内结束该主体的全部会话并停用其恢复码；撤销未兑换的邀请码仍只阻止今后兑换。
- 玩家兑换成功后页面一次性显示恢复码（`POST /invites/credential-regenerate`，需要 CSRF、Origin 与有效受邀会话；旧码立即失效）。凭恢复码调用 `POST /invites/recover`（沿用每个 IP 哈希每分钟 20 次的失败限额）可在新浏览器里恢复同一主体、同样的聊天与记忆，并轮换出一个新码；每个码只能用一次，错误或已用过的码返回同一个中性错误。恢复码只存摘要，页面不写入 localStorage 或 cookie，也不记录日志。

### 提示词变更（Part 11e）

- Part 11e 修改了角色语气、时间克制、审核保留角色语气及 AI 诚实表述的提示词，因此 `POLICY_HASH` 与 `PROMPT_HASH` 已变化（协议指纹不变）。下一次角色发布之前，必须重新运行角色预演（预演测试），不能沿用旧哈希下通过的预演结果。
