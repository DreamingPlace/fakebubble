# fakebubble

FAKE 泡泡的网页源码：人物浏览、文字与语音对话、游客体验、邀请升级，以及管理员邮箱登录和角色资料管理。

> **源码预览 · 真机验收未完成。** 公开源码不等于正式发布或生产部署。
> 手机布局、键盘定位、手势与分条回复的修复仍需真实设备复验；桌面移动视口不算真机验收。

## 范围

- 玩家网页与网页管理员界面。
- Cloudflare 的 edge / business / budget / generation 四个 Worker。
- 本地离线测试服务、共享业务逻辑、接口契约、必要数据库迁移和回归测试。
- 不包含原生 App、旧管理前端、旧 Git 历史、真实角色资料、声音样本、数据库、密钥或线上配置。

部分共享模块及迁移保留历史命名，因为网页的数据结构、生成链路和隔离回归仍依赖它们；这不表示网页开放了旧版所有功能。

## 快速查看网页

需要 **Node 24.19+（24.x）** 和 **pnpm 11.19.0**。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm web:player:build
pnpm web:preview
```

打开 <http://127.0.0.1:18530/>。这是**静态交互预览**，没有真实 AI 回复、生成语音或可登录的管理员账号。服务只监听本机，Ctrl-C 退出。

## 验证

```sh
pnpm check                    # 类型、Web 单元/集成/E2E/负载与组件测试
pnpm web:player:build          # 按依赖图构建浏览器产物，生成哈希清单
pnpm check:web:local-http      # 独立本地 HTTPS 实例
pnpm check:web:restart         # 持久化与重启恢复
```

测试使用合成材料和本地实例，不调用真实供应商或发送邮件。运行时需要 OpenSSL；Miniflare 测试使用本地 workerd。测试串行占用 `127.0.0.1:18491`，不要与本地业务服务同时运行。

测试会检查缺失/损坏的静态构建，结束后需重新执行 `pnpm web:player:build` 再预览。运行数据位于忽略的 `runtime/`，不应提交。

## 开发与部署

- [架构与边界](docs/ARCHITECTURE.md)
- [本地运行与生产配置](docs/DEPLOYMENT.md)
- [验收状态与已知限制](docs/STATUS.md)
- [安全与贡献约束](SECURITY.md)

本仓库没有自动部署流程；配置模板默认关闭公网及真实调用。克隆仓库不会复制任何现有账号、人物资料或服务实例。
