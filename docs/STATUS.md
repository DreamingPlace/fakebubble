# 验收状态

**本次为网页源码公开预览，不是整版验收通过或新版本上线。**

已纳入：玩家与管理员网页、动态角色目录与资料预览发布、邮箱账号、分类权限、邀请、持久化任务、私有音频、预算预占及安全默认值。

待完成或受限：

- 新手机布局、键盘定位、头像点击、滑动方向及回复节奏需真实手机复验。
- Safari 键盘上方的表单导航工具条属于系统浏览器 UI，网页没有可靠的 CSS 删除接口。
- 管理员邮箱绑定显示有既有真机反馈，但不替代本公开源码导出版本的完整端到端验收。
- 不包含真实人物资料、声音和运行数据库，不能仅克隆源码就运行现有生产服务。
- 初始材料导入仍有三个固定角色的兼容约束；后续目录变更走管理员版本发布流程。
- 大陆可用性、产品化备份恢复和运行监控不在本版完成范围。

验证命令见 README。离线测试通过不能证明真实供应商、邮件送达、公网配置或真机体验全部通过。

## 本次独立导出复验（2026-10-05）

在不使用旧 Git 历史、私人配置或原运行数据的新目录验证：

- Node 24.19.0 / pnpm 11.19.0；锁文件冻结安装通过。
- `pnpm check`：三组类型检查通过；Web 单元、集成、E2E、负载及组件共 **688/688** 通过，无跳过。
- 玩家构建 **53** 个文件；静态 HTTP 内容逐文件匹配构建哈希，私人路径拒绝访问；实际桌面浏览器加载无脚本错误。
- 独立本地 HTTPS 四轮合成对话、私有音频、同 IP 限额与重启检查通过；数据生命周期重启专项通过。
- 四 Worker 关闭状态包 **215** 个文件（Part 2b 之后为 212 个）；测试加载真实 workerd 入口，网络边界使用离线替身。
- Gitleaks 扫描通过（两处明确标注的固定离线测试密码为已审核误报）；已配置秘密及常见编码比对零命中。

这些结果仅证明该源码快照的上述离线范围，不代表真实手机或新生产部署验收完成。

## Baseline (Part 1)

Measured on the unmodified initial commit (`6f1f822`) before any Part 1 change, in a fresh checkout:

- Node 24.19.0 / pnpm 11.19.0, `pnpm install --frozen-lockfile` clean.
- `pnpm check` (typecheck + tests): **688 tests, 688 passed, 0 failed, 0 skipped**.
- Total wall-clock time of `pnpm check`: **7m38s** (reported test duration 445 s).
- Note: on Node 22.22.0 the same run gives 501 passed / 187 failed (`WEB_NATIVE_ALTER_COLUMN_REQUIRED`), so the
  required Node 24.19+ is a hard prerequisite, not a recommendation.

## Part 2b (legacy removal)

- Removed the abandoned experimental-v10 text protocol (accepted-v7 hashes unchanged and pinned by a test), the iOS-era `apps/server` modules reachable only from tests, and the `Engine`-based test helper. The native iOS app is discontinued.
- `pnpm check`: **688 tests, 688 passed, 0 failed, 0 skipped** (688 baseline + 3 new policy-hash tests − 3 deleted legacy Engine scene tests). It also passes when run immediately after `pnpm web:player:build`.
- Four-Worker package: **212** files (was 215).
- No `.sql` migration or migration runner changed.

## Part 4 (concurrency, 429, fallback, metrics)

- `maxTextRunning` / `maxAudioRunning` are deployment configuration (Worker vars `MAX_TEXT_RUNNING`, `MAX_AUDIO_RUNNING`, `MAX_WAITING_OPERATIONS`, `AUDIO_FALLBACK_WAIT_MS`; local `local-config.json` `concurrency`), validated at start (1–64 / 1–48), defaults 20 / 4 / 8000 ms. A store built without configuration (offline fixtures) keeps 4 / 4 / 120 because the stage-queue tests are written against it. Global tickets = text + audio + waiting = 128 for both defaults.
- Provider HTTP 429 is known not-executed: the stage claim returns to pending (2s, 4s, 8s, at most three retries, never past the deadline) on one budget reservation; timeouts, network errors and 5xx are unchanged (UNKNOWN, never resent).
- Voice falls back to the reviewed text as text bubbles (`deliveryFallback: "text"`) after `audioFallbackWaitMs` without a slot, or when 429 retries are exhausted; the unused voice reservation is settled at zero. The wait fallback applies only while no audio segment has been started: once one is sent, the operation is exempt and keeps waiting for slots as voice. A 429-exhausted fallback after earlier segments records them in `web_operation_metrics.discarded_audio_segments`.
- `114_stage_metrics.sql` (stage timings, retries, fallback; 429 bookkeeping; `web_publication_items.media_id` nullable). It is its own migration step: version 114 on the local runner (`migrateWebProviderMetrics`, `user_version=114`) and on the Cloudflare runner (inline and R2); the 113 step is byte-for-byte as on main (hash test). The Cloudflare runner now applies missing trailing steps, so an authority already at 113 upgrades to 114. Every `schema === 113` check became `>= 113`.
- `pnpm check`: **721 tests, 721 passed, 0 failed, 0 skipped** (691 + 30 new), about 7m45s. 30-player load: 15 voice, 15 text fallback (all wait fallbacks), 0 wait-discarded audio, 0 429-discarded audio.
- Four-Worker package: **216** files (was 213: `config/web-concurrency.ts`, `admission/web-stage-metrics.ts` and the 114 SQL).

## Part 6a (prompts as files, cache-friendly order, text-only rule)

- Step 1: byte-for-byte snapshots of `promptMessages()` and `reviewPromptMessages()` for six fixed requests (`tests/web/fixtures/prompt-snapshots/`, regenerate with `UPDATE_PROMPT_SNAPSHOTS=1`).
- Step 2: every prompt block lives in `prompts/v7/*.md`; `scripts/build-prompts.ts` generates `apps/server/generation/prompts.generated.ts` (`pnpm prompts:build`, `pnpm prompts:check`, part of `pnpm check`). Byte-identical: the snapshots and the policy/prompt hashes did not change.
- Step 3: the user-message JSON is ordered stable-first, per-turn fields last. **Existing hashes are unchanged** (they cover system prompts and the protocol fingerprint, not user-message layout), but the wire request bytes change.
- Step 4: text-only player input rule restored from the removed v10 (`player-channel-rules.md`, `responseConstraints.playerInputKinds`). **This changes the policy hash and the prompt hash**: character previews approved before this change must be re-run and re-approved before publishing (see `docs/DEPLOYMENT.md`).
- Step 5: no migration 115. The cache hit/miss tokens were already parsed from DeepSeek `usage` and stored in each succeeded text stage's `metadata_json`; the owner-only stage-latency endpoint now returns `cache.draft` / `cache.review` (calls, hitTokens, missTokens, hitRatio) per UTC day. Offline fixtures return the fields (draft 6/4, review 8/2). Budget reservation math is unchanged.
