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

默认 `PUBLIC_ENABLED`、`EXTERNAL_CALLS`、`OPERATOR_ENABLED` 关闭；`workers_dev`、预览域名关闭，`routes` 为空。部署不是安装脚本的副作用。本仓库不附带一键开启付费调用的命令。

## 私有运维工具

`scripts/web-cloudflare-operator.ts` 需要显式 `CLOUDFLARE_ACCOUNT_ID`，以及指向已安装 Wrangler 模块的绝对路径 `FAKE_WEB_WRANGLER_MODULE`。它只使用绑定到 `fakebubble-business` / `fakebubble-budget` 的认证 RPC。部署时若改服务名，必须同步审查此工具。

调用必须指定 `--action`、绝对路径 `--receipt-file`，部分操作还需要 `--input-file` / `--name`。收据目录权限 0700，输入/收据文件 0600。工具先持久化准备状态，再调用；未知结果应核查收据及服务端状态，**不要盲目重试**。首次主管理员入口只在受控初始化阶段启用，完成后关闭。

## 本地真实供应商适配（非默认预览）

`scripts/web-provider.ts` 保留受控本地适配，`serve` / `render-assets` 必须显式 `--live`；这不是供应商付费授权。真实材料和凭据仍需独立准备。

- `selected-voice-pins.json`：0600 私有指纹清单；结构见 `config/selected-voice-pins.json.example`。`directory` 指向同一材料根下的已审核目录。该目录需包含 `USER-SELECTION.json`、`PUBLICATION.json` 和每个角色的 `*-VOICE.json` / `*-DRAFT.json` / `*-PUBLISHED.json`。指纹文件只绑定字节，不能代替使用权或听感审核。
- `FAKEBUBBLE_BUDGET_AUTHORITY`：指向 0600 绝对路径配置，结构见 `config/budget-authority.json.example`。同一供应商账户下的所有本地实例必须使用同一个 `budgetPath` 和完整 `historyRoots`。只有确实不存在历史调用的新环境才可填空历史列表。路径不能按实例临时变化。
- 供应商 `.env` / `.env.voice` 不随源码分发。禁止把生产运营预算作为任意测试许可；禁止自动重发 UNKNOWN 调用。

不要把 `runtime/`、Secrets、材料目录、邮件、收据、真实数据库或构建产物提交到 GitHub。
