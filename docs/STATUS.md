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

## Part 17 (public readiness: grace period, account deletion, owner alerts, Turnstile, legal pages)

All behind flags that default OFF; no migration, no prompt or tool-schema change (pinned hashes untouched). Details and the launch-day checklist: docs/DEPLOYMENT.md "公开上线准备（Part 17）"; retention and deletion: docs/DATA_BOUNDARY.md.

- `GUEST_GRACE_ENABLED`: guest purge at `expires_at + 7 days` (only without a login); the session survives for signup only; signup inside grace keeps the history; after grace `GUEST_GRACE_ENDED` → signed-out page ("之前的体验聊天已过期").
- `ACCOUNT_DELETE_ENABLED`: 删除我的账号 / 清除本设备的体验数据 through the audited purge path, rate-limited, audited without content, invited grant revoked in the same transaction.
- `ALERTS_ENABLED` (+ `ALERT_*` thresholds): hourly check in the business alarm, one mail per alert type per 6 h, claim-before-send (never retried in a loop), daily digest; no player data in any mail.
- `TURNSTILE_ENABLED` (+ site key, secret): new guest, request-code and login; server-side siteverify, one use per token, fail closed; CSP widened only when on.
- `LEGAL_PAGES_ENABLED`: 隐私政策 / 用户协议 (finalized in Part 19), footer and signup-screen links.
- Part 17b `SIGNUP_BONUS_ENABLED` (owner decision; migration `121_signup_bonus.sql`, sha256 `f0fa334d…ef8d9`, 46 steps): 5 guest trial replies per guest and per IP (lifetime), 10 lifetime bonus replies for a verified-email signup (any character, no time window, off the IP quota, once per address ever via a kept HMAC), at most 3 signups per IP per UTC day. Replies 1-3 keep the CHECK-limited counters; replies 4-5 and the bonus are derived `entitled` operations (`web_free_operations`). Flag off = unchanged (3 replies).
- Part 17c (same flag, no migration): with the flag on the guest trial window is 7 days from the first reply (2 h off), guest sessions created with the flag on live 14 days (window + grace; 24 h off); the bonus is once per inbox (canonical form: drop from the first `+`; gmail/googlemail also drop dots and map googlemail→gmail); every per-IP key (`ip_hash`) uses the IPv4 text unchanged, IPv4-mapped IPv6 as its IPv4 and other IPv6 as its /64 (also with the flag off; existing IPv6 quota rows restart once). Privacy policy states the 7 day window.
- Part 19 `CHAT_REVIEW_ENABLED` (migration `122_chat_review.sql`, sha256 `5a81455c…ec950`, 47 steps): owner reads chat transcripts under a random 4-character code (permission `conversations.read`, desktop 运营 → 测试对话, CSV export, audited); removed chats stay readable anonymously for 180 days in an archive with no identity column, written in the transaction that starts the purge; one-time chat banner, privacy-policy and delete-sheet wording; final legal pages; 18+ tick at signup (`LEGAL_PAGES_ENABLED`). Flag off = unchanged, routes answer as if absent.
- Known limits: the Node local server has no account deletion and no Turnstile; the validation-failure alert counts all `failed` operations (validation and expiry); with the flag off the real trial window in code is 2 hours after the first message (the guest cookie lasts 24 h); with it on, 7 days and 14 days (the policy states the 7 days); no Mainland China region rule exists yet (owner decision pending).

## Part 16 (time, topics, RPC rejected output, admin fixes)

- Prompts changed on purpose: `characterLocalTime` (renamed; the UTC `currentTime` no longer reaches the models), the character's clock is not the player's, reviewer duty for assumed player time/sleep, no invented shared history, no claimed live games. POLICY_HASH `2bd7b236db8f307ac3a0a990c42647137efa6fb4f73b606004678b678563227d`, PROMPT_HASH `00448e452aa0172bcb5f69a6400690832d35fbd6ae32bfe7e2126cd9eb8b323b`; protocol fingerprint unchanged.
- `rejected` is forwarded across the Worker RPC bridge on both sides (best effort, never awaited); proven through the two-Worker workerd path.
- Topics/factOps: normalize (missing memoryId -> null, integer-string importance, unknown keys dropped), keep semantics strict; still-invalid metadata on an otherwise valid review is dropped (reply delivered, no memory) and counted in `topics_dropped`/`facts_dropped` (`120_memory_metadata_metrics.sql`, sha256 `5fe0cf7c482aa39772024210b75cccfecb2c738d7ecaf0ee3022db3b84275cde`; 45 steps). Every production caller passes `DROP_INVALID_METADATA`; `applyTextReview` without it stays strict.
- Admin: stale per-tab CSRF after a cookie swap (login in another tab) caused the 403s; the client re-syncs once via GET /session. Inbox badge is a link labelled "N 条新共创".
- `pnpm check`: **1133 tests, 1133 passed** (1113 + 20 new); `web:player:build`, `check:web:local-http`, `check:web:restart` pass.

## Part 13b (预演测试 evaluation workbench)

- `119_preview_workbench.sql` (own version on both runners; `migrateWebProviderPreviewWorkbench` / `migrate-preview-workbench`): runs, run items, simulated-time marks, rejected stage output, eval sets and their versions. Admin-only synthetic data; the preview rows and billing ledger are untouched.
- A batch is one run (idempotent by requestId). A stage that completes with usage but fails validation keeps its raw output (<= 32 KiB, marker when cut) for admin diagnosis; billing is unchanged. Each preview reports `settled_known` / `held_unknown` / `released_unsent`, derived from the ledger; UI copy follows it.
- Simulated local time is an HH:MM inside the character's own zone, applied only by `previewInstant` (refuses any non-admin-preview scope). No prompt or tool-schema change: pinned hashes unchanged.
- One batched status endpoint; the client backs off 2 s -> 10 s, stops when idle and sleeps while hidden. Player top bar: 登录 / 注册, the trial-used-up line, nickname menu.
- Known gaps: previews have no retention of their own, so rejected output is purged on character deletion only; the legacy per-preview polling panel stays in `character-workbench.ts` (pinned by its tests) but is no longer mounted.
- `pnpm check`: **1113 tests, 1113 passed** (1077 + 36 new); `web:player:build`, `check:web:local-http`, `check:web:restart` pass. Migration 119 sha256 `16d1db76b4de5a28024a18008d7eb79a0b65dea8170c2c0da225b407dc155066`; expected-migrations: 44 steps (inline and R2).

## Part 12 (player co-creation inbox)

- `117_cocreation.sql` (own version on both runners; `migrateWebProviderCocreation` / `migrate-cocreation`). Players write ideas on "灵感卡片" (shared list in `packages/contracts/cocreation-cards.ts`); administrators read them in 共创收件箱, adopt answers into the character draft through the existing draft save (pure merge in `packages/contracts/cocreation-adopt.ts`), and publish through the existing flow. No provider calls, no automatic review, no prompt or tool-schema change.
- Permissions `cocreation.read` / `cocreation.manage`; submitter shown only as a keyed pseudonym plus invite batch.
- Purged with the character (deletion start and scope purge, audited) and with the player (retention, lifecycle audit).

## Part 11f (email accounts, multi-device login, nickname, no dead-end session screen)

- `118_player_logins.sql` (own version on both runners; `migrateWebProviderLogins` / `migrate-logins`). A login is a credential bound 1:1 to a principal: principal kinds, admission and entitlement are unchanged, sessions it creates keep `account_id` NULL, and the legacy `web_accounts`/Argon2 path is not used. Passwords use the scrypt format of `web-admin-password.ts` (8–128 bytes for players).
- Email one-time codes (6 digits, 10 minutes, 5 attempts, supersede) with per-email, per-IP and daily limits checked before sending; identical answers for registered and unknown addresses; plain-Chinese mail through the new `PLAYER_EMAIL` `send_email` binding; `PLAYER_SIGNUP_ENABLED` defaults to false (login always works).
- Flows: 注册 (binds to the current guest, writes the nickname as a new 名片 revision), 登录 (new session, others untouched, never merges), 忘记密码 (ends other sessions), 我的昵称, 修改密码, 退出登录, 退出其他设备, 绑定邮箱 for legacy invited players (revokes their recovery code). Redeeming requires a login while signup is open.
- A dead cookie leads to the normal signed-out first page (登录 / 注册 / 以访客继续); the old "访问会话需要恢复" dead end is gone.
- Login rows, challenges and nickname 名片 revisions are purged with the player; the lifecycle audit fails closed on leftovers. No prompt or tool-schema change: `POLICY_HASH` / `PROMPT_HASH` are unchanged.
- `pnpm check`: **1016 tests, 1016 passed** (961 baseline + 55 new) on Node 24.21.0 / pnpm 11.19.0 (the three failures of the full run were the ledger-version list in `web-stage-metrics-migration`, fixed and re-run green). `pnpm web:player:build`, `check:web:local-http`, `check:web:restart` pass. Migration 118 sha256 `03845291fa69a047f0249d74737c0ac390673207f6f389d22422f8fb83e5f339`; expected-migrations: 43 steps (inline and R2).

### Part 11f fix-ups (review of PR #16)

- Wrong email codes: at most 10 per address per rolling 24 h over all challenges and purposes (`web_player_throttle` scope `code-email`, hour-slot rows keyed by an HMAC of address + slot); verify-code and every request-code purpose then refuse with `PLAYER_RATE_LIMITED` + retry-after, identically for registered and unknown addresses. The throttle sweep now ages each scope on its own window.
- A guest with a login is kept at trial end (retention row stays `active`/expired; `requireWebContent(..., 'read')` lets read paths through, every other caller still answers `TRIAL_EXPIRED`); login, history, nickname and invite redemption keep working. A login with no activity for 180 days (`web_player_logins.last_seen_at`) goes through the existing audited purge. Guests without a login purge as before.
- `inspect` reports `players`: `PLAYER_SIGNUP_ENABLED`, `PLAYER_EMAIL_DAILY_CAP`, `PLAYER_EMAIL_BINDING_PRESENT`.
- `pnpm check`: **1026 tests, 1026 passed**. Migration 118 (edited in place, not deployed) sha256 `4c5f3beb3db1ef7d683e0bac332c0b37d9cea1d350ccb295267154a4ed777a9b`; expected-migrations: 43 steps.

## Part 21c (Fish Drama 3 reply voice, per-voice fallback, soundCue, listening script)

- Reply voice can run on Fish Drama 3. Site default `FISH_VOICE_MODEL` (`s2.1-pro` default = behaviour unchanged; `drama-3`); a voice binding is unpinned (`s2.1-pro`, follows the default), `pin:s2.1-pro` (admin workbench checkbox) or `drama-3`. No migration (the free-text `model` columns hold the values); `expected-migrations` is byte-identical to main (47 steps, inline and R2).
- **The model header is `drama-3`.** The brief said `drama-3-preview`; the current Drama 3 page, the TTS API reference enum and the launch post all say `drama-3`, and an unrecognised value silently serves s2.1-pro, so `drama-3-preview` is rejected everywhere (`docs/PROVIDERS.md` has the checked links and every unverified item).
- `workers/audio/fish.ts`: Drama 3 cue tables (natural-language directions per expression and delivery style, `<whisper>` for `tender_whisper`, sound tags `[small laugh]`/`[shaky breath]`); the s2.x tables are untouched and covered by a snapshot generated from main's code. Drama 3 requests do not send `features: ['quality-guard']` (documented for s2 only).
- `soundCue`: optional enum on spoken draft bubbles (`none | small_laugh | shaky_breath`, at most one per bubble), rendered by the server for Drama 3 only; the model never writes brackets or tags, `AUDIO_CONTROL_MARKER_FORBIDDEN` still guards all text, displayed text never has tags. Only the two sound tags the docs spell out are whitelisted; `sigh`/`gasp` are unverified.
- Ledger: `fish / drama-3 / speech / byte` at 15 micros/byte (the s2.1 upper bound, because of the silent fallback). Price ids now include the model (`provider-model-phase-time`), since two fish speech rows share a phase.
- Merged with 21b/21d/21e: `usage:report` costs speech per model at list price (`s2.1-pro` 15, `drama-3` 10 micros/byte; ledger bound stays 15); test `usage:report costs a drama-3 reply at its LIST price`.
- Welcome/footer clips are always rendered as s2.1-pro.
- `pnpm voice:samples` (`scripts/voice-samples.ts`, `apps/server/generation/web-voice-samples.ts`): one clip per approved voice per expression on the chosen model into a local folder; reads only bindings and prices, reserves budget first, never resends UNKNOWN.
- Intentional hash change (text policy tests): prompt `6519b6a0…cd6f`→`53df95a8…133b`, policy `e31c3518…52fb`→`a140e333…2c68`, protocol fingerprint `b42431c9…ef99`→`b753fb40…dae8`; stored previews/approvals must be redone. Not verified live: Drama 3 with our cloned voices, and 24 kHz WAV output, are unconfirmed in the docs — listen on staging first.
- Test-file changes (no assertion weakened): `web-text-policy.test.ts` pinned hashes; `prompt-snapshots/voice-reply.json` regenerated (only the new prompt paragraph); `web-provider-offline.test.ts` seed price id includes the model and the three renewal tests use `PROVIDER_PRICES.length` instead of a literal 3.
## Part 21b (player model choice, points, backup, usage)

Flag `PLAYER_MODEL_CHOICE_ENABLED` (default off; requires `SIGNUP_BONUS_ENABLED`). Off = exactly today, including "免费消息" copy. Details: docs/PROVIDERS.md, docs/DEPLOYMENT.md "Part 21b", docs/DATA_BOUNDARY.md.

- A: xAI (`grok-4.7`) and Gemini (`gemini-3.8-flash`) on one chat-completions adapter shape (`generation/text-wire.ts`); reasoning low, reasoning tokens reserved and billed; list-price rows in `PROVIDER_PRICES` (renew-prices seeds a provider with no rows). Pinned prompt/policy hashes unchanged.
- B: draft = player's frozen choice, review = house reviewer. C: a definitely-not-billed failure is settled at zero and retried once on chosen → DeepSeek → Gemini (reply note 由备用模型回复, player pays the cheaper); UNKNOWN is never retried or released. Kill switch `PLAYER_TEXT_MODELS`. Placement hint added, **but Cloudflare says it does not apply to RPC** (see DEPLOYMENT.md).
- D: migration `123_model_choice.sql` (48 steps), points (policy table separate from balance; events carry source and admin id; invited players choose models, no points, daily limit unchanged; no admin UI) (deepseek 10, gemini 20, xai 40, voice +2, one table: `packages/contracts/player-models.ts`). E: `web_provider_usage` + `pnpm usage:report`. F: model picker (new module + three hooks), screenshots in `review/part-21b/`.
- Ledger/migration tests extended for 123 as named exceptions (step counts, positions from the end, user_version, `length: 24`), plus the renewal tests for the two new providers.
- Known limits: when the whole chain fails definitely-not-billed the operation ends at its deadline (5 min), then points are refunded; a last-model 429 for xAI/Gemini does not use the old 2/4/8 s backoff (DeepSeek still does); the Node local server has no model choice; xAI/Gemini request details marked "assumed" in PROVIDERS.md need a staging check.

## Part 21d (memory for signed-up players, text-fallback context, chain exhaustion, cleanups)

No migration (still 48 steps; step 124 untouched, so Part 21c may claim it). No prompt or tool-schema change: `POLICY_HASH` / `PROMPT_HASH` unchanged.

- **Memory for signed-up players.** `freezeWebV7Request` recalled memories, corrections and player facts only for non-`guest` principals; a guest who signed up (holds the signup bonus) is guest-kind and got none. Now `recallsMemory()` (`admission/web-free-tier.ts`): account, invite, and guest-with-signup-bonus recall; plain trial guests are unchanged. WRITING was already unconditional for every principal (`recordDialogueMemories` in the publisher); the one inconsistent piece was the embedding side (`web-embed-ledger.ts` skipped every guest, so a signed-up player's memory was never indexed or query-embedded and recall was lexical only): it now uses the same predicate. Test: `web-signup-memory` (fact stated, nine more turns, fact recalled; plain guest: written, not recalled).
- **Voice -> text fallback replies in context.** Test written first (`web-text-fallback-context`, failed before the fix): voice fails four times, the reviewed text is published as `text_fallback`, the next message is claimed. **Suspicion proved:** `WEB_V7_MEMORY_SOURCE_UNTRUSTED` was real. The memory episode of the fallback reply cites the fallback bubbles as evidence, but `allowed` only held `origin='narrative'` items, so every following request was refused. `text_fallback` now counts like `narrative` in the transcript (`allowed` / `orderedIds`), in `shortTermTurns`, in the publisher's per-message trust check, and in the local server's `replyOrdinal`. Reviewed and left alone because they are audio-only or already include the fallback: media joins (`origin='narrative'` AND media), the voiced check in points reconcile (fallback has no media, so the voice points are still refunded), `web-chat-review` (no origin filter), publication view in `web-provider-application` (already maps fallback to a narrative bubble).
- **Fail fast on an exhausted chain.** The real hole was a chain whose next model cannot even be started (no key, request too large): the earlier attempt was settled at zero and archived, nothing was left to fail the operation, so it sat in `text_running` until its deadline. `WebDispatchLedger.failChainExhausted` (runner calls it only for a route, a not-billed error and a live claim; any open/UNKNOWN attempt blocks it) now ends it as `failed`, quota released, points refunded by `reconcilePoints`. A last model that WAS sent and failed not-billed already failed at once through `confirm`. 429 on the LAST model of the chain (xAI/Gemini/DeepSeek) now uses the existing 2/4/8 s `rejectForRetry` backoff before giving up; the rejection counter's CHECK only lists `DEEPSEEK_RATE_LIMITED`, so that value labels every text provider (avoids a migration). UNKNOWN is unchanged (never retried, reservation never released). Test: `web-chain-exhausted`.
- **Cleanups.** `review/part-21b/` removed (screenshots live on `review/*` branches, not `main`); the stray regex statement after `REGION` in `text-wire.ts` removed; the page footer says 免费体验 only to a trial guest (`LiveBinding.freeTierEnabled`), a signed-up player sees just 回复由AI生成. Screenshots: branch `review/part-21d`.
- Test fixture `model-choice.ts` gained an optional `fish` override and a running admission sequence for extra operations (additive; no existing test edited).
- `pnpm check` (format, prompts, typecheck, all tests): **1357 tests, 1357 passed** on Node 24.21.0 / pnpm 11.19.0; expected-migrations unchanged (last step 123, 48 steps).

## Part 21e (operator gate, per-reply telemetry)

- Operator gate bug: the business Durable Object kept the `OPERATOR_ENABLED` it started with, so after a vars-only deploy every operator call failed `WEB_CLOUD_OPERATOR_DISABLED`. Now only `WebOperatorService` (fresh env) decides on/off; the object's operator methods take a proof (HMAC-SHA256 of `fakebubble-operator-v1` under the existing `SEAL_KEY`, which the edge worker does not hold), compared in constant time; failure is `WEB_CLOUD_OPERATOR_PROOF_INVALID`. No new secret, no migration, no deploy-step change; A/B pattern works without waiting for the object (DEPLOYMENT.md). The regression test (object constructed with "false", entrypoint "true") fails on the old code.
- Telemetry: one `console.log` line per finished reply (`web_reply`: outcome, chosen, draft/review provider+model, backup, abandoned codes, textMs, audioMs, voice, pointsCharged); no ids, content, principal or IP (tested). Reported by the executor for operations it worked on; a restart forgets operations that finished across it. `pointsCharged` for a published reply is the admission charge before the lazily settled backup/no-voice refunds.
- Untouched: web-v7-request.ts, admission/points files, prompt/policy hashes, migrations (48 steps, 123 = 432c1237…28db41).
