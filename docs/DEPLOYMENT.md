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

缺省取默认值；已设置但不合法（非整数、越界）则 Durable Object / 本地服务拒绝启动。没有任何配置的库内存储（离线夹具）保持 4/4/120。

供应商返回 HTTP 429 表示请求在执行前被拒绝，是**已知未执行**：同一阶段退回待处理，按 2s、4s、8s 退避重试（最多三次，且不越过操作截止时间），重试沿用同一笔预占，不重复预占也不提前释放。超时、网络错误和 5xx 仍是 UNKNOWN，绝不重发。语音重试用尽，或 8 秒内没有语音名额时，已审核的文字原样作为文字气泡发布（`deliveryFallback: "text"`，不生成新文字）；为未使用的语音阶段预占的金额按零成本结算释放。

`114_stage_metrics.sql` 是独立的第 114 版迁移，在 113 之后按顺序执行，并把 `user_version`（Cloudflare 为迁移账本的最大版本）置为 114；113 这一步与 main 上逐字节相同（有哈希测试）。它为每个操作记录文字/语音排队与阶段耗时、限流重试、是否降级，以及降级时被丢弃的已生成语音段数（`discarded_audio_segments`）。Node：新的 provider-* 实例由 `migrate` 一路执行到 114；已在 113 的实例用 `scripts/web-provider.ts migrate-metrics <root>` 升级（`migrate` 只接受全新的 100 版实例，所以这个入口仍然需要）。Cloudflare：Durable Object 启动时校验已应用迁移的哈希，并按顺序补上账本里缺少的步骤，因此已在 113 的现有权威（内联与 R2）会自动升到 114；账本超前于代码或哈希不一致仍然拒绝启动。主管理员可通过 `POST /api/web/local/admin/metrics/stage-latency`（`{"days":1..31}`）查看每日 p50/p95。

默认 `PUBLIC_ENABLED`、`EXTERNAL_CALLS`、`OPERATOR_ENABLED` 关闭；`workers_dev`、预览域名关闭，`routes` 为空。部署不是安装脚本的副作用。本仓库不附带一键开启付费调用的命令。

### 提示词文件与缓存友好顺序（Part 6a）

accepted-v7 的提示词正文在 `prompts/v7/*.md`（每块一个文件）。Worker 没有文件系统，所以 `scripts/build-prompts.ts`（`pnpm prompts:build`）把它们生成进提交的 `apps/server/generation/prompts.generated.ts`；`pnpm prompts:check` 和一个单元测试会在生成物过期时失败。修改提示词时先改 `.md`，再运行 `pnpm prompts:build`。

DeepSeek 自动缓存相同的请求前缀。用户消息 JSON 现在把同一角色多轮之间不变的字段放在前面，每轮都变的字段（`messages`、`currentTime` 等）放在最后；审核调用的用户消息同理，`draftPresentation*` 在最末。内容与取值不变，只改键顺序。

**提示词哈希变化，需要重跑角色预览。** 第 4 步新增“玩家只能发文字”规则（`prompts/v7/player-channel-rules.md`，同时进入起草与审核提示词，并在 `responseConstraints.playerInputKinds` 声明），所以策略哈希与提示词哈希都变了（`web-text-policy.test.ts` 记录了新旧值）。哈希包含在预览批准与发布批准里：升级前批准的角色预览在发布前必须重新运行并重新批准。第 3 步只改变发送给供应商的请求字节（`wireRequestHash`），不改变这两个哈希（哈希覆盖系统提示词与协议指纹，不含用户消息的字段顺序）。

## 私有运维工具

`scripts/web-cloudflare-operator.ts` 需要显式 `CLOUDFLARE_ACCOUNT_ID`，以及指向已安装 Wrangler 模块的绝对路径 `FAKE_WEB_WRANGLER_MODULE`。它只使用绑定到 `fakebubble-business` / `fakebubble-budget` 的认证 RPC。部署时若改服务名，必须同步审查此工具。

调用必须指定 `--action`、绝对路径 `--receipt-file`，部分操作还需要 `--input-file` / `--name`。收据目录权限 0700，输入/收据文件 0600。工具先持久化准备状态，再调用；未知结果应核查收据及服务端状态，**不要盲目重试**。首次主管理员入口只在受控初始化阶段启用，完成后关闭。

## 本地真实供应商适配（非默认预览）

`scripts/web-provider.ts` 保留受控本地适配，`serve` / `render-assets` 必须显式 `--live`；这不是供应商付费授权。真实材料和凭据仍需独立准备。

- `selected-voice-pins.json`：0600 私有指纹清单；结构见 `config/selected-voice-pins.json.example`。`directory` 指向同一材料根下的已审核目录。该目录需包含 `USER-SELECTION.json`、`PUBLICATION.json` 和每个角色的 `*-VOICE.json` / `*-DRAFT.json` / `*-PUBLISHED.json`。指纹文件只绑定字节，不能代替使用权或听感审核。
- `FAKEBUBBLE_BUDGET_AUTHORITY`：指向 0600 绝对路径配置，结构见 `config/budget-authority.json.example`。同一供应商账户下的所有本地实例必须使用同一个 `budgetPath` 和完整 `historyRoots`。只有确实不存在历史调用的新环境才可填空历史列表。路径不能按实例临时变化。
- 供应商 `.env` / `.env.voice` 不随源码分发。禁止把生产运营预算作为任意测试许可；禁止自动重发 UNKNOWN 调用。

不要把 `runtime/`、Secrets、材料目录、邮件、收据、真实数据库或构建产物提交到 GitHub。
