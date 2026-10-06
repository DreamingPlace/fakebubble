# 网页架构

```text
Browser → edge → business Durable Object → generation Worker → DeepSeek / Fish
                       │                         │
                       ├─ private R2 media       └─ budget Worker / Durable Object
                       └─ identity, quota, jobs, messages, materials, administrator permissions
```

- `apps/player-web`：TypeScript 浏览器入口、人物环形选择、聊天、邀请、管理员账号与角色工作台。
- `apps/server/`：按领域分目录（文件名不变，迁移 `.sql` 仍在 `migrations/` 与 `web-migrations/`）：
  - `identity/` 网页身份与会话；`invites/` 邀请码；`admin/` 管理员账号与权限；
  - `characters/` 角色目录、资料、预览、发布与删除；`conversation/` 场景、关系、气泡发布（`web-vertical-publisher.ts`）；`memory/` 记忆；
  - `generation/` DeepSeek、文本策略与协议、提示词、供应商运行与执行；`audio/` 私有语音；
  - `budget/` 预算、计量、成本与调度账本；`admission/` 准入、阶段队列与保留清理；
  - `platform/` 存储、迁移运行、配置、恢复、本地 HTTP；`cloudflare/` 为适配层。
- 数据边界：`platform/store-boundary.ts` 定义 `UserStore`（每次调用带主体上下文）与 `GlobalStore`，均为同一 SQLite 连接上的薄封装。`memory/` 与 `conversation/` 只接收 `UserStore`（`tests/web/unit/store-boundary.test.ts` 强制；`web-vertical-publisher.ts` 仍使用 `WebRuntimeStore`，待后续拆分）。每张表属于 user、global 还是 legacy-unused，见 `docs/DATA_BOUNDARY.md`。
- `apps/server/cloudflare/web-*`：持久化、HTTP、安全边界和服务绑定适配。
- `workers/web-cloudflare`：四个 Worker 入口与关闭状态的部署模板。
- `scripts/web-provider.ts`、`scripts/web-cloudflare-operator.ts`：手动运维工具（保留，见 DEPLOYMENT.md）。
- `packages/contracts`、`packages/domain`、共享 server/audio 模块：Web 实际引用的契约、生成、记忆与数据库基础设施。
- `tests/web`、`apps/player-web/tests/components`：离线回归；fixtures 仅用于测试，不是供应商验收材料。

## 不变量

业务服务是状态的唯一写入方。生成进程不直接写业务库。私人访问必须绑定身份、世界和会话；预算在发出调用前预占。已发送但结果未知的调用保留占款，不能因超时、重启或创建新实例而重发或释放。

管理员的账号会话与功能授权分离，撤销权限不等于删除账号或聊天会话。现有功能类别为角色资料、素材语音、预览发布和邀请码；主管理员管理授权。角色资料编辑须经过预览与发布，不包含主动消息推送。

静态资源仅按构建哈希清单发布，API、R2 和运维接口不能作为任意文件访问通道。Cloudflare 运维通过已认证的私有 service binding 执行，不提供公网初始化接口。
