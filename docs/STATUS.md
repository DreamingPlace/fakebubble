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
- Step 6: an operation that has already started any audio segment (paid) is no longer expired by the summed `WEB_LIMITS.queueWaitMs` wait (claim condition, scheduler sweeps on both executors, `terminate(..., 'expired')` and the Cloudflare alarm time); only its operation deadline ends it. Operations that have not started audio keep today's behavior. Applies from schema 114 (metrics), like the wait-fallback exemption.
- `pnpm check`: **733 tests, 733 passed, 0 failed, 0 skipped** (721 + 12 new), about 7m41s. `pnpm web:player:build`, `pnpm check:web:local-http`, `pnpm check:web:restart` pass. Four-Worker package: **217** files (was 216: `prompts.generated.ts`; the `.md` sources are not packaged).

## Part 7a (memory: importance, player facts, ranking)

- A: the prompt hash covers every `prompts/v7` file. B: `115_memory_importance.sql` (`memory_topics.importance`, `memory_facts`, `web_operation_metrics.review_changed`) is its own version on both runners (`migrateWebProviderMemory` / `migrate-memory`; Cloudflare inline and R2 ledger 115); `memory_facts` is a user table, purged by retention and character deletion and known to both audits. C: `review_changed` is recorded at publication; the owner stage-latency view reports `review` (samples/changed/rate) per day.
- D: review topics carry `importance` and `memoryId` (enum of the recalled memory ids, or null); a linked topic adds an episode under the existing key; importance keeps the maximum. The live request now uses the single `recallMemories` in `memory/memory.ts` (`accepted-memory.ts` removed). E: `factOps` (add/update/retire), player-authored evidence only, written in the publication transaction; an update, or an add of an active key, retires the old row and inserts the new one. F: ranking `0.5·relevance + 0.3·importance/10 + 0.2·exp(−h/72)` over the whole scope before the limit (`RECALL`), promotion at importance ≥ 7 or two mentions; `recallStep`/`maxRecallBonus` removed. G: `playerFacts` (≤ 20) after `playerIntroduction` in the draft and review prompt, plus a content rule.
- Pinned hashes (policy / prompt / fingerprint): main 6a `ddbd9315… / 687b0960… / 6fa11440…`; A `ea400177… / c0eaa2ff… / unchanged`; D `40d4c60d… / dba98588… / 4811a5ed…`; E `481388d9… / dc5db072… / b42431c9…`; G `9342e2c9… / 619d6011… / unchanged`. Previews approved before this Part must be re-run.
- `pnpm check`: **767 tests, 767 passed, 0 failed, 0 skipped** (733 baseline + 34 new), about 8m. `pnpm web:player:build`, `check:web:local-http`, `check:web:restart` pass. Four-Worker package: **217** files (unchanged; the 115 SQL is bundled into the Workers).

## Part 7b (memory embeddings: recall by meaning)

- Vectors live in the existing SQLite database (business object / local store); no Vectorize or other external store. Similarity is computed in code inside one scope. Only memory topics are embedded (key + latest episode summary); player facts are not (all active facts already go into every prompt). Model `@cf/baai/bge-m3` (1024 dims, array input); price USD 0.0118 per million input tokens, reserved on a bytes/2 estimate and settled on reported usage, else on the estimate, never above the hold.
- 1: `generation/embedding-provider.ts` (`EmbeddingProvider`): Workers AI `AI` binding (generation Worker only), Workers AI REST for local provider mode (`.env.embed`, 0600, never committed), and `OfflineEmbeddings` (deterministic; with `fixtures` it is the fixture embedder mapping chosen sentences to chosen vectors). The binding is in `generation.json.example`; everything is off by default (`EMBEDDINGS_ENABLED=false` on both Workers, `EXTERNAL_CALLS=false`). Concurrency (`MAX_EMBED_RUNNING`, default 2) and the query timeout (`EMBED_QUERY_TIMEOUT_MS`, default 3000) are validated configuration in `config/web-embeddings.ts`.
- 2: `116_memory_embeddings.sql` is its own version on both runners (local `user_version=116` via `migrateWebProviderEmbeddings` / `migrate-embeddings`; Cloudflare inline and R2 ledger 116, applied to an authority at 115 through the normal ordered path). `memory_embeddings` and `web_embed_attempts` are user tables (removed by the Node and Cloudflare retention purge and the character-deletion purge, known to both audits; a never-sent call returns its hold first), `web_embed_metrics` is global counters. Existing tests changed only where they assert the latest schema version or a position in the migration ledger (115 → 116, ledger 16 → 17 steps, 40 → 41 applied steps).
- 3: indexing runs after a publication commits, never inside it. One scope per call, at most 16 topics, ONE request with an array of texts; the call is recorded and its money held before it is sent (`web_embed_attempts`, phase `embed`, not_sent → sent → known | unknown); the business object writes the vectors, the bill and the receipt in one transaction. A known failure releases the hold and leaves the topics pending (retried after 60 s); an UNKNOWN outcome keeps the hold, marks the topics `unknown` and is never retried (changed text is new work); stale calls of a crashed process are recovered (never sent: released, sent: UNKNOWN).
- 4: the reply's query embedding happens BEFORE the request is frozen: the text claim does not take an operation whose query embedding is in flight, so `freezeWebV7Request` sees the final recall result and the frozen request stays immutable. The vector exists only in memory until that claim; it is checked against the frozen input by sha256 and never stored. Failure, timeout, UNKNOWN or an unusable body freeze with lexical recall; nothing is retried and no reply waits longer than the timeout. At most one query call per operation (unique index).
- 5: `relevance = max(lexical, semantic)`, semantic = clamp((cosine − τ) / (1 − τ), 0, 1), τ = 0.35, over the scope's ready vectors, at most the 500 most recently seen topics. Importance and recency weights are unchanged and ranking is still over the whole authorized scope before the limit.
- 6: the owner-only stage-latency view reports per UTC day embedding calls, texts embedded, failures, UNKNOWNs, query-embedding fallbacks and timeouts.
- `pnpm check`: **826 tests, 826 passed, 0 failed, 0 skipped** (767 baseline + 59 new), about 7m46s on Node 24.21.0 / pnpm 11.19.0. `pnpm web:player:build`, `check:web:local-http`, `check:web:restart` pass. Four-Worker package: **224** files (was 217: the provider, ledger, runner, purge helper, memory-embeddings and web-embeddings modules; the 116 SQL is bundled into the Workers).
