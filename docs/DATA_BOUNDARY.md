# Data boundary

Every SQLite table created by the two migration trees (`apps/server/migrations/001–033` and `apps/server/web-migrations/100–113`), sorted into three classes. This is the reference for the `UserStore` / `GlobalStore` split in `apps/server/platform/` (see `docs/ARCHITECTURE.md`); nothing in this file changes behaviour.

- **user** – every row belongs to exactly one player principal (identity sessions, conversations, messages, `memory_*`, relationships, that player's operations and attempts, private audio references). The *Owner* column names the column that identifies the principal, or says `needs join via …` when ownership is only reachable through another table.
- **global** – shared by all players: invite codes, character catalog and versions, admin accounts and sessions, quotas, scheduler state, budget and prices, per-character shared assets, retention bookkeeping.
- **legacy-unused** – the web code never writes it and never reads it for application data.

## Principal model

`api_players.id` (player) ← `web_principals.player_id`; `web_principals.world_id` → `worlds.id`, unique, so one principal has exactly one world (`worlds.owner_id` is the same player id). The old tables key their rows by `world_id` (plus `conversation_id` / `character_id`) and carry no `principal_id`; the principal is reached with `web_principals.world_id`. Tables of the web ledger carry `principal_id` directly or through `operation_id` → `web_operations`.

## How usage was determined

Each table name was searched (whole word) in all non-test source under `apps/`, `workers/`, `scripts/` and `packages/` outside the `.sql` folders, and again in `tests/`. Every hit was then read:

- Common words were checked by their SQL, not by the word. `media`, `jobs`, `messages` also match JavaScript properties (`media` appears as a property in the player app); only `messages` and `jobs` are real web tables. `media` appears in SQL only as a string in a "must be empty" probe in `admission/web-retention-cleaner.ts`, so it is legacy-unused. Web audio lives in `web_private_audio_assets` and `web_provider_media_assets`.
- A reference does not count when it sits in a function nothing calls. `cloudQueueNextDue` (`cloudflare/queue-alarm.ts`), `runningAudioCount` (`audio/audio-validation.ts`), `freezeContextEvidence`, `selectProactiveTopic` and `VoiceCatalog` have no callers.
- Web stores cannot be beta stores (`WEB_BETA_MODE_CONFLICT`); the Node store stops at migration 24 unless `beta` is set, so migrations 025–033 are never applied to a web instance.
- A "must be empty" probe or a purge-list entry alone does not make a table used; a table the cleaner deletes from and that another web path writes is used.

Result: 62 user, 24 global, 76 legacy-unused (162 tables including four transient rename targets). Legacy-unused tables still exist in a web database; nothing here drops them.

## Tables

| Table | Created in | Class | Owner (user tables) | Web usage / evidence |
|---|---|---|---|---|
| `worlds` | migrations/001_core.sql | user | `owner_id` (the player id; unique) | identity/web-identity.ts, platform/store.ts, admission/web-admission.ts |
| `character_templates` | migrations/001_core.sql | global | — | character catalog: characters/web-character-catalog.ts, web-character-publication.ts |
| `world_characters` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `conversations` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `participants` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `contacts` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `batches` | migrations/001_core.sql | legacy-unused | — | only in `cloudQueueNextDue` (cloudflare/queue-alarm.ts), which has no caller |
| `draws` | migrations/001_core.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` (test fixtures only) |
| `messages` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `proactive_intents` | migrations/001_core.sql | legacy-unused | — | only an "must be empty" probe in admission/web-retention-cleaner.ts; never written; web audio lives in `web_private_audio_assets` / `web_provider_media_assets` |
| `jobs` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `reply_items` | migrations/001_core.sql | legacy-unused | — | `cloudQueueNextDue` (no caller) and emptiness probes in admission/web-lifecycle-audit.ts and characters/web-character-deletion-audit.ts; never written |
| `media` | migrations/001_core.sql | legacy-unused | — | only an "must be empty" probe in admission/web-retention-cleaner.ts; never written; web audio lives in `web_private_audio_assets` / `web_provider_media_assets` |
| `outbox` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `dialogue_bubbles` | migrations/002_dialogue_memory.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `memory_topics` | migrations/002_dialogue_memory.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/accepted-memory.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_episodes` | migrations/002_dialogue_memory.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/accepted-memory.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_mentions` | migrations/002_dialogue_memory.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/accepted-memory.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `proactive_topics` | migrations/003_proactive_topics.sql | legacy-unused | — | only in `selectProactiveTopic` (memory/memory.ts, no caller) |
| `api_players` | migrations/004_player_api.sql | user | `id` (the player id, joined by `web_principals.player_id`) | identity/web-identity.ts (insert), admission/web-admission.ts |
| `api_devices` | migrations/004_player_api.sql | legacy-unused | — | only the cloudflare guard/recovery modules (cloudflare/guard-access-state.ts, store.ts, schema.ts), which no web worker enters; `beta` stores cannot be web stores (`WEB_BETA_MODE_CONFLICT`) |
| `pairing_invites` | migrations/004_player_api.sql | legacy-unused | — | only the cloudflare guard/recovery modules (cloudflare/guard-access-state.ts, store.ts, schema.ts), which no web worker enters; `beta` stores cannot be web stores (`WEB_BETA_MODE_CONFLICT`) |
| `world_setup_receipts` | migrations/004_player_api.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `text_attempts` | migrations/004_player_api.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `text_retry_state` | migrations/004_player_api.sql | legacy-unused | — | only in `cloudQueueNextDue` (cloudflare/queue-alarm.ts), which has no caller |
| `character_template_versions` | migrations/005_admin.sql | global | — | character versions: characters/web-character-publication.ts (insert) |
| `admin_sessions` | migrations/005_admin.sql | global | — | admin accounts/sessions: admin/web-account-admin.ts, admin/web-admin-schema.ts |
| `admin_login_grants` | migrations/005_admin.sql | global | — | admin accounts/sessions: admin/web-account-admin.ts, admin/web-admin-schema.ts |
| `character_draft_revisions` | migrations/005_admin.sql | global | — | admin character workflow: characters/web-character-admin.ts, web-character-preview*.ts |
| `character_drafts` | migrations/005_admin.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `admin_previews` | migrations/005_admin.sql | global | — | admin character workflow: characters/web-character-admin.ts, web-character-preview*.ts |
| `character_publications` | migrations/005_admin.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `memory_catalog` | migrations/006_memory_corrections.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/accepted-memory.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_corrections` | migrations/006_memory_corrections.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/accepted-memory.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_context_versions` | migrations/006_memory_corrections.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/accepted-memory.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `group_conversations` | migrations/007_groups.sql | legacy-unused | — | only in `freezeContextEvidence` (memory/context-evidence.ts, no caller) and, for the first two, a cleaner emptiness probe |
| `group_creation_receipts` | migrations/007_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `group_message_routes` | migrations/007_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `group_job_reads` | migrations/007_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `group_message_knowledge` | migrations/007_groups.sql | legacy-unused | — | only in `freezeContextEvidence` (memory/context-evidence.ts, no caller) and, for the first two, a cleaner emptiness probe |
| `job_evidence_snapshots` | migrations/008_memory_sources.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/accepted-memory.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_episode_sources` | migrations/008_memory_sources.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/accepted-memory.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `moment_threads` | migrations/010_moments.sql | legacy-unused | — | only in `freezeContextEvidence` (memory/context-evidence.ts, no caller) and, for the first two, a cleaner emptiness probe |
| `moment_requests` | migrations/010_moments.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `autonomy_days` | migrations/011_autonomy.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `voice_profiles` | migrations/012_voice_delivery.sql | legacy-unused | — | only in `VoiceCatalog` (characters/voices.ts, never instantiated) |
| `speech_tasks` | migrations/012_voice_delivery.sql | legacy-unused | — | only in `cloudQueueNextDue` (cloudflare/queue-alarm.ts), which has no caller / `runningAudioCount` (audio/audio-validation.ts, no caller); retention-cleaner emptiness probe only |
| `speech_retry_receipts` | migrations/012_voice_delivery.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `admin_voice_previews` | migrations/013_admin_voice_previews.sql | legacy-unused | — | only in `cloudQueueNextDue` (cloudflare/queue-alarm.ts), which has no caller / `runningAudioCount` (audio/audio-validation.ts, no caller); retention-cleaner emptiness probe only |
| `external_sources` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `external_source_versions` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `source_fetch_attempts` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `source_posts` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `source_post_versions` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `source_summaries` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `dialogue_deliveries` | migrations/015_paced_delivery.sql | legacy-unused | — | only in `cloudQueueNextDue` (cloudflare/queue-alarm.ts), which has no caller |
| `response_fallbacks` | migrations/016_chat_interactions.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `message_feedback` | migrations/016_chat_interactions.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `playtest_resets` | migrations/017_playtest_reset.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `retired_sync_cursors` | migrations/017_playtest_reset.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `retired_proactive_usage` | migrations/017_playtest_reset.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `playtest_reset_usage` | migrations/017_playtest_reset.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `playtest_media_cleanup` | migrations/017_playtest_reset.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `message_feedback_next` | migrations/017_playtest_reset.sql | legacy-unused | — | transient: renamed to `message_feedback` inside migration 017 |
| `admin_voice_previews_next` | migrations/018_audition_expressions.sql | legacy-unused | — | transient: renamed to `admin_voice_previews` inside migration 018 |
| `player_profile_versions` | migrations/019_player_profiles.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/player-profile.ts (live reads; no live writer calls the create/save helpers) |
| `player_profile_requests` | migrations/019_player_profiles.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/player-profile.ts (live reads; no live writer calls the create/save helpers) |
| `character_association_versions` | migrations/019_player_profiles.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/player-profile.ts (live reads; no live writer calls the create/save helpers) |
| `relationship_states` | migrations/020_relationship_events.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/relationships.ts; purge in admission/web-retention-cleaner.ts |
| `relationship_daily_budgets` | migrations/020_relationship_events.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/relationships.ts; purge in admission/web-retention-cleaner.ts |
| `relationship_job_contexts` | migrations/020_relationship_events.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/relationships.ts; purge in admission/web-retention-cleaner.ts |
| `relationship_reviews` | migrations/020_relationship_events.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/relationships.ts; purge in admission/web-retention-cleaner.ts |
| `relationship_events` | migrations/020_relationship_events.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/relationships.ts; purge in admission/web-retention-cleaner.ts |
| `relationship_corrections` | migrations/020_relationship_events.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/relationships.ts; purge in admission/web-retention-cleaner.ts |
| `scene_states` | migrations/021_scenes.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/scenes.ts; purge in admission/web-retention-cleaner.ts |
| `scene_job_contexts` | migrations/021_scenes.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/scenes.ts; purge in admission/web-retention-cleaner.ts |
| `scene_events` | migrations/021_scenes.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/scenes.ts; purge in admission/web-retention-cleaner.ts |
| `scene_end_requests` | migrations/021_scenes.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | conversation/scenes.ts; purge in admission/web-retention-cleaner.ts |
| `moment_post_settings` | migrations/022_autonomous_moments.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `moment_post_setting_requests` | migrations/022_autonomous_moments.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `moment_post_days` | migrations/022_autonomous_moments.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `moment_post_drafts` | migrations/022_autonomous_moments.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `conversation_reads` | migrations/023_playtest_social.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `player_characters` | migrations/023_playtest_social.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `relationship_test_versions` | migrations/023_playtest_social.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `moment_audience_groups` | migrations/024_moment_audience_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `moment_audience_group_members` | migrations/024_moment_audience_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `moment_audience_group_receipts` | migrations/024_moment_audience_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_instance` | migrations/025_beta_accounts.sql | legacy-unused | — | written only when `beta` is set (platform/store.ts), which is rejected for web stores; read only by cloudflare/recovery-point.ts |
| `beta_accounts` | migrations/025_beta_accounts.sql | legacy-unused | — | only the cloudflare guard/recovery modules (cloudflare/guard-access-state.ts, store.ts, schema.ts), which no web worker enters; `beta` stores cannot be web stores (`WEB_BETA_MODE_CONFLICT`) |
| `beta_invites` | migrations/025_beta_accounts.sql | legacy-unused | — | only the cloudflare guard/recovery modules (cloudflare/guard-access-state.ts, store.ts, schema.ts), which no web worker enters; `beta` stores cannot be web stores (`WEB_BETA_MODE_CONFLICT`) |
| `beta_account_receipts` | migrations/025_beta_accounts.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_generation_provenance` | migrations/026_beta_feedback.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_feedback` | migrations/026_beta_feedback.sql | legacy-unused | — | only the cloudflare guard/recovery modules (cloudflare/guard-access-state.ts, store.ts, schema.ts), which no web worker enters; `beta` stores cannot be web stores (`WEB_BETA_MODE_CONFLICT`) |
| `beta_feedback_screenshots` | migrations/026_beta_feedback.sql | legacy-unused | — | only the cloudflare guard/recovery modules (cloudflare/guard-access-state.ts, store.ts, schema.ts), which no web worker enters; `beta` stores cannot be web stores (`WEB_BETA_MODE_CONFLICT`) |
| `beta_evaluations` | migrations/027_beta_evaluations.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_evaluation_revisions` | migrations/027_beta_evaluations.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_feedback_issues` | migrations/028_feedback_workflow.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_feedback_events` | migrations/028_feedback_workflow.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_feedback_workflows` | migrations/028_feedback_workflow.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_feedback_action_receipts` | migrations/028_feedback_workflow.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_character_roster` | migrations/029_character_requests.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_character_catalog` | migrations/029_character_requests.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_character_requests` | migrations/029_character_requests.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_character_request_receipts` | migrations/029_character_requests.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_cost_prices` | migrations/030_beta_costs.sql | legacy-unused | — | only budget/beta-costs.ts, reachable only through cloudflare/guard-cost-facts.ts (no web worker enters it) |
| `beta_cost_budgets` | migrations/030_beta_costs.sql | legacy-unused | — | only budget/beta-costs.ts, reachable only through cloudflare/guard-cost-facts.ts (no web worker enters it) |
| `beta_cost_calls` | migrations/030_beta_costs.sql | legacy-unused | — | only budget/beta-costs.ts, reachable only through cloudflare/guard-cost-facts.ts (no web worker enters it) |
| `beta_cost_events` | migrations/030_beta_costs.sql | legacy-unused | — | only budget/beta-costs.ts, reachable only through cloudflare/guard-cost-facts.ts (no web worker enters it) |
| `beta_cost_admin_receipts` | migrations/030_beta_costs.sql | legacy-unused | — | only budget/beta-costs.ts, reachable only through cloudflare/guard-cost-facts.ts (no web worker enters it) |
| `beta_reviewed_replies` | migrations/032_beta_reviewed_replies.sql | legacy-unused | — | only in `cloudQueueNextDue` (cloudflare/queue-alarm.ts), which has no caller |
| `beta_cost_history` | migrations/033_beta_cost_history.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_cost_history_receipts` | migrations/033_beta_cost_history.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `web_instance` | web-migrations/100_web_instance.sql | global | — | instance singleton: platform/store.ts, budget/web-provider-*budget*.ts |
| `web_principals` | web-migrations/100_web_instance.sql | user | `id` | identity/, admission/, conversation/web-vertical-publisher.ts |
| `web_ip_windows` | web-migrations/100_web_instance.sql | global | — | quotas / rate windows keyed by `ip_hash`: admission/web-admission.ts, admission/web-retention.ts, invites/web-invite-actions.ts |
| `web_operations` | web-migrations/100_web_instance.sql | user | `principal_id` | admission/web-admission.ts, admission/web-stage-queue.ts, budget/web-dispatch-ledger.ts |
| `web_scheduler_state` | web-migrations/101_stage_queue.sql | global | — | scheduler state (singleton): admission/web-stage-queue.ts, admission/web-admission.ts |
| `web_reviewed_candidates` | web-migrations/101_stage_queue.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_stage_attempts` | web-migrations/101_stage_queue.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_admission_counter` | web-migrations/102_admission_order.sql | global | — | scheduler state (singleton): admission/web-stage-queue.ts, admission/web-admission.ts |
| `web_accounts` | web-migrations/103_identity.sql | user | `principal_id` | identity/web-identity.ts |
| `web_sessions` | web-migrations/103_identity.sql | user | `principal_id` | identity/web-identity.ts |
| `web_identity_receipts` | web-migrations/103_identity.sql | user | needs join via `web_accounts.principal_id` (`account_id`) | identity/web-identity.ts |
| `web_external_budgets` | web-migrations/104_dispatch_ledger.sql | global | — | budget and prices: budget/web-dispatch-ledger.ts, budget/web-provider-live-budget.ts |
| `web_external_attempts` | web-migrations/104_dispatch_ledger.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_synthetic_voice_segments` | web-migrations/105_synthetic_voice_queue.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_external_attempts_next` | web-migrations/105_synthetic_voice_queue.sql | user | `principal_id` | transient: created and renamed to `web_external_attempts` inside migration 105 |
| `web_input_snapshots` | web-migrations/106_input_snapshot.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_private_audio_assets` | web-migrations/107_synthetic_private_audio.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_v7_requests` | web-migrations/108_vertical_candidate.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_v7_candidates` | web-migrations/108_vertical_candidate.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_publications` | web-migrations/108_vertical_candidate.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_publication_items` | web-migrations/108_vertical_candidate.sql | user | needs join via `web_publications.principal_id` (`operation_id`) | conversation/web-vertical-publisher.ts |
| `web_footer_assets` | web-migrations/108_vertical_candidate.sql | global | — | per-character shared assets (keyed by `character_id`): conversation/web-vertical-publisher.ts, characters/web-character-materials.ts |
| `web_user_events` | web-migrations/108_vertical_candidate.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_local_text_outputs` | web-migrations/109_local_transport.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_local_audio_outputs` | web-migrations/109_local_transport.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_local_guest_budget` | web-migrations/109_local_transport.sql | global | — | quotas / rate windows keyed by `ip_hash`: admission/web-admission.ts, admission/web-retention.ts, invites/web-invite-actions.ts |
| `web_local_events` | web-migrations/109_local_transport.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_ip_lifetime_quota` | web-migrations/110_data_lifecycle.sql | global | — | quotas / rate windows keyed by `ip_hash`: admission/web-admission.ts, admission/web-retention.ts, invites/web-invite-actions.ts |
| `web_guest_retention` | web-migrations/110_data_lifecycle.sql | global | — | retention bookkeeping (rows carry `principal_id` but are driven by the cross-principal cleaner): admission/web-retention-cleaner.ts, admission/web-lifecycle-audit.ts |
| `web_retention_purge_gate` | web-migrations/110_data_lifecycle.sql | global | — | retention bookkeeping (rows carry `principal_id` but are driven by the cross-principal cleaner): admission/web-retention-cleaner.ts, admission/web-lifecycle-audit.ts |
| `web_retention_file_cleanup` | web-migrations/110_data_lifecycle.sql | global | — | retention bookkeeping (rows carry `principal_id` but are driven by the cross-principal cleaner): admission/web-retention-cleaner.ts, admission/web-lifecycle-audit.ts |
| `web_invite_codes` | web-migrations/111_invite_core.sql | global | — | invite codes: invites/web-invites.ts, admin/web-account-admin.ts |
| `web_invite_grants` | web-migrations/111_invite_core.sql | user | `principal_id` | invites/web-invites.ts, admin/web-account-admin.ts |
| `web_invite_redemptions` | web-migrations/111_invite_core.sql | user | `principal_id` | invites/web-invites.ts, admin/web-account-admin.ts |
| `web_invite_identity_receipts` | web-migrations/112_invite_identity.sql | user | needs join via `web_invite_grants.principal_id` (`grant_id`) | identity/web-identity.ts, invites/web-invites.ts |
| `web_invite_credentials` | web-migrations/112_invite_identity.sql | user | needs join via `web_invite_grants.principal_id` (`grant_id`) | identity/web-identity.ts, invites/web-invites.ts |
| `web_invite_credential_receipts` | web-migrations/112_invite_identity.sql | user | needs join via `web_invite_grants.principal_id` (`grant_id`) | identity/web-identity.ts, invites/web-invites.ts |
| `web_invite_attempt_windows` | web-migrations/112_invite_identity.sql | global | — | quotas / rate windows keyed by `ip_hash`: admission/web-admission.ts, admission/web-retention.ts, invites/web-invite-actions.ts |
| `web_external_attempts_113` | web-migrations/113_provider_offline.sql | user | `principal_id` | transient: created and renamed to `web_external_attempts` inside migration 113 |
| `web_provider_spending` | web-migrations/113_provider_offline.sql | global | — | budget and prices: budget/web-dispatch-ledger.ts, budget/web-provider-live-budget.ts |
| `web_provider_prices` | web-migrations/113_provider_offline.sql | global | — | budget and prices: budget/web-dispatch-ledger.ts, budget/web-provider-live-budget.ts |
| `web_provider_attempts` | web-migrations/113_provider_offline.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_provider_outputs` | web-migrations/113_provider_offline.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_provider_candidates` | web-migrations/113_provider_offline.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_provider_voice_segments` | web-migrations/113_provider_offline.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | admission/web-stage-queue.ts, generation/web-provider-offline.ts, platform/web-local-executor.ts |
| `web_provider_media_assets` | web-migrations/113_provider_offline.sql | user | `principal_id` | budget/web-dispatch-ledger.ts, generation/web-input-snapshot.ts, audio/web-private-audio.ts, conversation/web-vertical-publisher.ts, generation/web-provider-offline.ts |
| `web_provider_footer_assets` | web-migrations/113_provider_offline.sql | global | — | per-character shared assets (keyed by `character_id`): conversation/web-vertical-publisher.ts, characters/web-character-materials.ts |
| `web_provider_voice_bindings` | web-migrations/113_provider_offline.sql | global | — | per-character shared assets (keyed by `character_id`): conversation/web-vertical-publisher.ts, characters/web-character-materials.ts |
| `web_provider_welcome_assets` | web-migrations/113_provider_offline.sql | global | — | per-character shared assets (keyed by `character_id`): conversation/web-vertical-publisher.ts, characters/web-character-materials.ts |

## Tables created in TypeScript, not in a migration tree

These are installed by schema helpers at open time and sit next to the tables above.

| Tables | Where | Class |
|---|---|---|
| `web_admin_members`, `web_admin_session_members`, `web_admin_grant_members`, `web_admin_challenges`, `web_admin_rates`, `web_admin_audit`, `web_admin_schema` | `admin/web-admin-schema.ts` | global (admin accounts and permissions) |
| `web_character_versions`, `web_character_catalog`, `web_character_revisions`, `web_character_drafts`, `web_character_publications`, `web_character_schema` | `characters/web-character-catalog.ts` | global (character catalog) |
| `web_character_materials`, `web_character_material_assets`, `web_character_material_approvals`, `web_character_material_promotions`, `web_character_voice_history`, `web_character_material_schema` | `characters/web-character-material-schema.ts` | global |
| `web_character_preview_jobs`, `web_character_preview_attempts`, `web_character_preview_schema` | `characters/web-character-preview-schema.ts` | global (admin previews) |
| `web_character_deletions`, `web_character_deletion_scopes`, `web_character_purge_gate`, `web_character_deletion_schema` | `characters/web-character-deletion-schema.ts` | global (deletion bookkeeping; scopes name affected worlds) |
| `cf_*`, `guard_*` | `cloudflare/` adapters | global (platform infrastructure) |
| `history`, `calls`, `cloud_grants` | `budget/web-provider-budget.ts` (separate budget database) | global |

## Notes for later Parts

- Retention tables carry `principal_id` but are classified global because the retention cleaner is a cross-principal job that must outlive the principal's rows. A later Part may split them.
- User tables keyed only by `world_id` rely on the 1:1 `web_principals.world_id` link; `UserContext` (`platform/store-boundary.ts`) therefore carries only `worldId`.
- Nothing enforces these classes in SQL yet; `UserStore` and `GlobalStore` are thin wrappers over the same connection.
