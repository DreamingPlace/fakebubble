# Data boundary

Every SQLite table created by the two migration trees (`apps/server/migrations/001–033` and `apps/server/web-migrations/100–118`), sorted into three classes. This is the reference for the `UserStore` / `GlobalStore` split in `apps/server/platform/` (see `docs/ARCHITECTURE.md`); nothing in this file changes behaviour.

- **user** – every row belongs to exactly one player principal (identity sessions, conversations, messages, `memory_*`, relationships, that player's operations and attempts, private audio references). The *Owner* column names the column that identifies the principal, or says `needs join via …` when ownership is only reachable through another table.
- **global** – shared by all players: invite codes, character catalog and versions, admin accounts and sessions, quotas, scheduler state, budget and prices, per-character shared assets, retention bookkeeping.
- **legacy-unused** – the web code never writes it and never reads it for application data.

## Principal model

`api_players.id` (player) ← `web_principals.player_id`; `web_principals.world_id` → `worlds.id`, unique, so one principal has exactly one world (`worlds.owner_id` is the same player id). The old tables key their rows by `world_id` (plus `conversation_id` / `character_id`) and carry no `principal_id`; the principal is reached with `web_principals.world_id`. Tables of the web ledger carry `principal_id` directly or through `operation_id` → `web_operations`.

## How usage was determined

Each table name was searched (whole word) in all non-test source under `apps/`, `workers/`, `scripts/` and `packages/` outside the `.sql` folders, and again in `tests/`. Every hit was then read:

- Common words were checked by their SQL, not by the word. `media`, `jobs`, `messages` also match JavaScript properties (`media` appears as a property in the player app); only `messages` and `jobs` are real web tables. `media` appears in SQL only as a string in a "must be empty" probe in `admission/web-retention-cleaner.ts`, so it is legacy-unused. Web audio lives in `web_private_audio_assets` and `web_provider_media_assets`.
- A reference does not count when it sits in a function nothing calls. Part 22x deleted the functions that were the only readers of many legacy tables (`cloudQueueNextDue`, `runningAudioCount`, `freezeContextEvidence`, `VoiceCatalog`, the cloud guard/recovery modules, `budget/beta-costs.ts`); `selectProactiveTopic` still has no caller and is allow-listed.
- Web stores cannot be beta stores (`WEB_BETA_MODE_CONFLICT`); the Node store stops at migration 24 unless `beta` is set, so migrations 025–033 are never applied to a web instance.
- A "must be empty" probe or a purge-list entry alone does not make a table used; a table the cleaner deletes from and that another web path writes is used.

Result: 71 user, 27 global, 76 legacy-unused (174 tables including four transient rename targets; Part 4 added the two `114_stage_metrics.sql` tables, both user; Part 7a added `memory_facts` in `115_memory_importance.sql`, user; Part 7b added `memory_embeddings` and `web_embed_attempts` (user) and `web_embed_metrics` (global) in `116_memory_embeddings.sql`; Part 12 added `web_cocreation_submissions` and `web_cocreation_answers`, both user, in `117_cocreation.sql`; Part 11f added `web_player_logins` and `web_email_challenges` (user) and `web_player_email_daily` and `web_player_throttle` (global) in `118_player_logins.sql`). Legacy-unused tables still exist in a web database; nothing here drops them.

## Tables

| Table | Created in | Class | Owner (user tables) | Web usage / evidence |
|---|---|---|---|---|
| `worlds` | migrations/001_core.sql | user | `owner_id` (the player id; unique) | identity/web-identity.ts, platform/store.ts, admission/web-admission.ts |
| `character_templates` | migrations/001_core.sql | global | — | character catalog: characters/web-character-catalog.ts, web-character-publication.ts |
| `world_characters` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `conversations` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `participants` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `contacts` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `batches` | migrations/001_core.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `draws` | migrations/001_core.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` (test fixtures only) |
| `messages` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `proactive_intents` | migrations/001_core.sql | legacy-unused | — | only an "must be empty" probe in admission/web-retention-cleaner.ts; never written; web audio lives in `web_private_audio_assets` / `web_provider_media_assets` |
| `jobs` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `reply_items` | migrations/001_core.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) and a cleaner/lifecycle emptiness probe only |
| `media` | migrations/001_core.sql | legacy-unused | — | only an "must be empty" probe in admission/web-retention-cleaner.ts; never written; web audio lives in `web_private_audio_assets` / `web_provider_media_assets` |
| `outbox` | migrations/001_core.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `dialogue_bubbles` | migrations/002_dialogue_memory.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | admission/web-admission.ts, conversation/web-vertical-publisher.ts, memory/, conversation/, generation/web-v7-request.ts, purge in admission/web-retention-cleaner.ts |
| `memory_facts` | web-migrations/115_memory_importance.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts (facts written in the publication transaction through `UserStore`), generation/web-v7-request.ts (read for the prompt); purge in admission/web-retention-cleaner.ts, cloudflare/web-retention.ts and characters/web-character-deletion.ts; audited in admission/web-lifecycle-audit.ts and characters/web-character-deletion-audit.ts |
| `memory_embeddings` | web-migrations/116_memory_embeddings.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | one float32 vector per topic and model, written only by the business object (generation/web-embed-ledger.ts, after the publication commit); read by `memory/memory-embeddings.ts` under the scope's three ids; purge in admission/web-retention-cleaner.ts, cloudflare/web-retention.ts and characters/web-character-deletion.ts (before `memory_topics`, which it references); audited in admission/web-lifecycle-audit.ts and characters/web-character-deletion-audit.ts |
| `web_embed_attempts` | web-migrations/116_memory_embeddings.sql | user | `world_id` / `conversation_id` / `character_id` (query calls also name `operation_id`) | dispatch ledger of embedding provider calls (phase `embed`, state not_sent → sent → known \| unknown, hold and charge against the `cloudflare` row of `web_provider_spending`): generation/web-embed-ledger.ts; items_json holds topic ids and hashes only and is cleared once a call is resolved, a query's text and vector are never stored; purge deletes the rows after returning never-sent holds (budget/web-embed-purge.ts); audited like `memory_embeddings` |
| `web_cocreation_submissions` | web-migrations/117_cocreation.sql | user | `principal_id` (and `character_id`: the official character the idea is for) | players' co-creation ideas for official characters, one row per hand-over, with the administrators' working state (status, star, note): cocreation/web-cocreation.ts. Untrusted player text; removed with the player (Node and Cloudflare retention purge) and with the character (character deletion), known to both audits |
| `web_cocreation_answers` | web-migrations/117_cocreation.sql | user | needs join via `web_cocreation_submissions.principal_id` (`submission_id`) | the answers of one submission, in order written (card id, hidden target field, text or dialogue as JSON, adoption stamp): cocreation/web-cocreation.ts; purged with its submission |
| `web_preview_runs` | web-migrations/119_preview_workbench.sql | global | `character_id` | one batch of the 预演测试 workbench: the draft revision and profile hash it ran on, relationship, the simulated wall-clock minute (preview only, inside the character's own zone) and who started it. Admin-only synthetic data, written only by `characters/web-character-preview.ts`; removed with the character in `characters/web-character-preview-purge.ts` (deletion start) |
| `web_preview_run_items` | web-migrations/119_preview_workbench.sql | global | via `web_preview_runs.character_id` (`run_id`) | which previews belong to a run, in order, with the eval-set line's optional note; a preview is in at most one run. Purged with the character |
| `web_preview_marks` | web-migrations/119_preview_workbench.sql | global | via `admin_previews.character_id` (`preview_id`) | the simulated local time one preview used, with the zone that was read. Purged with the character |
| `web_preview_rejected` | web-migrations/119_preview_workbench.sql | global | via `admin_previews.character_id` (`preview_id`) | the raw model output (at most 32 KiB, truncated with a marker) of a stage that completed with usage but failed validation, with the error code: for admin diagnosis only, never shown to a player, never sent to a provider again. Written by `characters/web-character-preview-runner.ts` after the known bill is durable. Purged with the character |
| `web_eval_sets` | web-migrations/119_preview_workbench.sql | global | none (named lists of synthetic inputs, at most 50 lines) | the current version of each eval set; edited by administrators with `characters.preview:*` (`characters/web-character-preview-read.ts`) |
| `web_eval_set_versions` | web-migrations/119_preview_workbench.sql | global | none | every saved version of an eval set, append-only; a run names the version it used |
| `web_player_logins` | web-migrations/118_player_logins.sql | user | `principal_id` (1:1; also the key `email_norm` is unique) | a player's email login: the address (trimmed, lower-cased) and a scrypt password hash, bound to an existing principal without changing its kind or admission: identity/web-player-accounts.ts (written only by the business object). The address is personal data: administrators see it masked (first character + `***` + domain) in the invite records, it never reaches a log, metric, receipt or error. `last_seen_at` is the player's last activity (set at signup and login, refreshed by bootstrap at most once per UTC day): a guest with a login is kept at trial end and purged only after 180 days without it (identity/web-player-purge.ts). Removed with the player in admission/web-retention-cleaner.ts and cloudflare/web-retention.ts (identity/web-player-purge.ts), known to admission/web-lifecycle-audit.ts, which fails closed while one remains for a cleared world |
| `web_email_challenges` | web-migrations/118_player_logins.sql | user | `principal_id` for signup / bind (NULL for a reset challenge, which is matched through `email_norm` of the login being purged) | one-time email codes: purpose, address, an HMAC digest of the code (never the code), attempts, hashed IP, expiry, verified / consumed stamps and the mail's delivery state; the rows are also the send ledger behind the per-email and per-IP limits and are deleted a day after creation: identity/web-player-accounts.ts; purged with the player like the login |
| `web_player_email_daily` | web-migrations/118_player_logins.sql | global | none (one counter row per UTC day) | emails sent per UTC day against `PLAYER_EMAIL_DAILY_CAP`: identity/web-player-accounts.ts; old days are deleted on the next send |
| `web_player_throttle` | web-migrations/118_player_logins.sql | global | none (key is an HMAC of the address, of the hashed IP or of the principal id; no address, no IP, no principal) | failure counters: fixed 15-minute windows for login and password checks, and (`code-email`, one row per address-HMAC and hour slot) the wrong email codes of an address over ALL challenges, summed over a rolling 24 hours: identity/web-player-accounts.ts; each scope's rows age out on their own window (the sweep never deletes a live 24 h counter) |
| `memory_topics` | migrations/002_dialogue_memory.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_episodes` | migrations/002_dialogue_memory.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_mentions` | migrations/002_dialogue_memory.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `proactive_topics` | migrations/003_proactive_topics.sql | legacy-unused | — | only in `selectProactiveTopic` (memory/memory.ts, no caller) |
| `api_players` | migrations/004_player_api.sql | user | `id` (the player id, joined by `web_principals.player_id`) | identity/web-identity.ts (insert), admission/web-admission.ts |
| `api_devices` | migrations/004_player_api.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `pairing_invites` | migrations/004_player_api.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `world_setup_receipts` | migrations/004_player_api.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `text_attempts` | migrations/004_player_api.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `text_retry_state` | migrations/004_player_api.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `character_template_versions` | migrations/005_admin.sql | global | — | character versions: characters/web-character-publication.ts (insert) |
| `admin_sessions` | migrations/005_admin.sql | global | — | admin accounts/sessions: admin/web-account-admin.ts, admin/web-admin-schema.ts |
| `admin_login_grants` | migrations/005_admin.sql | global | — | admin accounts/sessions: admin/web-account-admin.ts, admin/web-admin-schema.ts |
| `character_draft_revisions` | migrations/005_admin.sql | global | — | admin character workflow: characters/web-character-admin.ts, web-character-preview*.ts |
| `character_drafts` | migrations/005_admin.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `admin_previews` | migrations/005_admin.sql | global | — | admin character workflow: characters/web-character-admin.ts, web-character-preview*.ts |
| `character_publications` | migrations/005_admin.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `memory_catalog` | migrations/006_memory_corrections.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_corrections` | migrations/006_memory_corrections.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_context_versions` | migrations/006_memory_corrections.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `group_conversations` | migrations/007_groups.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) and a cleaner/lifecycle emptiness probe only |
| `group_creation_receipts` | migrations/007_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `group_message_routes` | migrations/007_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `group_job_reads` | migrations/007_groups.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `group_message_knowledge` | migrations/007_groups.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) and a cleaner/lifecycle emptiness probe only |
| `job_evidence_snapshots` | migrations/008_memory_sources.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `memory_episode_sources` | migrations/008_memory_sources.sql | user | needs join via `web_principals.world_id` (1:1 with the principal; `worlds.owner_id` is the player) | memory/memory.ts, memory/memory-review.ts, memory/context-evidence.ts; purge in admission/web-retention-cleaner.ts |
| `moment_threads` | migrations/010_moments.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) and a cleaner/lifecycle emptiness probe only |
| `moment_requests` | migrations/010_moments.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `autonomy_days` | migrations/011_autonomy.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `voice_profiles` | migrations/012_voice_delivery.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `speech_tasks` | migrations/012_voice_delivery.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) and a cleaner/lifecycle emptiness probe only |
| `speech_retry_receipts` | migrations/012_voice_delivery.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `admin_voice_previews` | migrations/013_admin_voice_previews.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) and a cleaner/lifecycle emptiness probe only |
| `external_sources` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `external_source_versions` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `source_fetch_attempts` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `source_posts` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `source_post_versions` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `source_summaries` | migrations/014_external_sources.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `dialogue_deliveries` | migrations/015_paced_delivery.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
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
| `beta_instance` | migrations/025_beta_accounts.sql | legacy-unused | — | written only when `beta` is set (platform/store.ts), which is rejected for web stores; its only reader was deleted in Part 22x |
| `beta_accounts` | migrations/025_beta_accounts.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `beta_invites` | migrations/025_beta_accounts.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `beta_account_receipts` | migrations/025_beta_accounts.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_generation_provenance` | migrations/026_beta_feedback.sql | legacy-unused | — | no reference in `apps/`, `workers/`, `scripts/`, `packages/` |
| `beta_feedback` | migrations/026_beta_feedback.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `beta_feedback_screenshots` | migrations/026_beta_feedback.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
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
| `beta_cost_prices` | migrations/030_beta_costs.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `beta_cost_budgets` | migrations/030_beta_costs.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `beta_cost_calls` | migrations/030_beta_costs.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `beta_cost_events` | migrations/030_beta_costs.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `beta_cost_admin_receipts` | migrations/030_beta_costs.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
| `beta_reviewed_replies` | migrations/032_beta_reviewed_replies.sql | legacy-unused | — | its only readers were deleted in Part 22x (no code reads or writes it) |
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
| `web_operation_metrics` | web-migrations/114_stage_metrics.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | per-operation stage timings, rate-limit retries, fallback flag and (115) `review_changed`: admission/web-stage-metrics.ts, written in the publication transaction by conversation/web-vertical-publisher.ts; read by the owner-only `admin.stageLatency` |
| `web_attempt_rejections` | web-migrations/114_stage_metrics.sql | user | needs join via `web_operations.principal_id` (`operation_id`) | attempts a provider rejected with HTTP 429 before running them: generation/web-provider-offline.ts |
| `web_embed_metrics` | web-migrations/116_memory_embeddings.sql | global | — | per-UTC-day counters (calls, texts, failures, UNKNOWNs, query fallbacks and timeouts), no content and no scope: generation/web-embed-ledger.ts; read by the owner-only `admin.stageLatency` |

## Tables created in TypeScript, not in a migration tree

These are installed by schema helpers at open time and sit next to the tables above.

| Tables | Where | Class |
|---|---|---|
| `web_admin_members`, `web_admin_session_members`, `web_admin_grant_members`, `web_admin_challenges`, `web_admin_rates`, `web_admin_audit`, `web_admin_schema` | `admin/web-admin-schema.ts` | global (admin accounts and permissions) |
| `web_admin_actions`, `web_turnstile_counts` | `admin/web-admin-actions.ts` (Part 22b, `CREATE TABLE IF NOT EXISTS`, no ledger step) | global (counts only). `web_admin_actions`: one row per owner action of the console (续期价格, 预算充值, 积分发放, 重置全部额度) - request id, action, request hash (an email is hashed with the keyed digest, never stored), administrator id, the RESULT as shown (counts and prices) and the optional note the administrator typed. No `world_id`, `operation_id` or player id, so the lifecycle audits never see player data in it. `web_turnstile_counts`: failures per UTC day and outcome (`failed`, `unavailable`), pruned after 8 days. |
| `web_character_versions`, `web_character_catalog`, `web_character_revisions`, `web_character_drafts`, `web_character_publications`, `web_character_schema` | `characters/web-character-catalog.ts` | global (character catalog) |
| `web_character_materials`, `web_character_material_assets`, `web_character_material_approvals`, `web_character_material_promotions`, `web_character_voice_history`, `web_character_material_schema` | `characters/web-character-material-schema.ts` | global |
| `web_character_preview_jobs`, `web_character_preview_attempts`, `web_character_preview_schema` | `characters/web-character-preview-schema.ts` | global (admin previews) |
| `web_character_deletions`, `web_character_deletion_scopes`, `web_character_purge_gate`, `web_character_deletion_schema` | `characters/web-character-deletion-schema.ts` | global (deletion bookkeeping; scopes name affected worlds) |
| `cf_*`, `guard_*` | `cloudflare/` adapters | global (platform infrastructure) |
| `history`, `calls`, `cloud_grants` | `budget/web-provider-budget.ts` (separate budget database) | global |

## Part 17: retention changes and account deletion

No new table, no migration. What changed is *when* and *by whom* the existing audited purge path (T1 fence and release, T2 database clear, F file erase; fail-closed `auditWebLifecycleWorld`) runs.

| Case | Before | Now |
|---|---|---|
| Guest without a login | purged at `web_guest_retention.expires_at` | with `GUEST_GRACE_ENABLED`: purged at `expires_at + 7 days` (`GUEST_GRACE_MS`); with the flag off: unchanged |
| Guest during grace | n/a | cannot chat (`requireWebContent` live → `TRIAL_EXPIRED`) and cannot read history or audio (`read` → `TRIAL_EXPIRED`, as the retained rule applies only to guests with a login); the session stays usable (`WebIdentity.inGrace`) so the player can sign up; the session never lasts past `expires_at + 7 days`; a guest that never started a trial has no grace |
| Guest who signs up during grace | n/a | becomes a kept account (Part 11f): readable history, no new replies, purged only after 180 inactive days |
| Guest with a login | purged after 180 inactive days | unchanged |
| Invited player | never purged | unchanged, except on request (below) |
| Player's own request (`ACCOUNT_DELETE_ENABLED`) | not possible | guest (button) or login (password + typed 删除) or invited player with a login: same transaction revokes grant, credentials and receipts, ends every session, writes one audit row and runs T1 (`WebCloudRetention.markExpired(id, 'deleted')`), then T2 and F; the retention state stays `purging` if T2 or F fail and the alarm completes it |

Part 17c: with `SIGNUP_BONUS_ENABLED` on, a guest's trial window is 7 days from its first reply (`WEB_LIMITS.publicTrialWindowMs`; 2 hours with the flag off), so retention (`expires_at`, the purge time and, with grace, `expires_at + 7 days`) moves accordingly; a guest session created while the flag is on lives at least 14 days (window + grace). The bonus-once key is the HMAC of a canonical form used only for the bonus (logins keep the normalized address): everything from the first `+` of the local part is dropped for every domain; for `gmail.com` and `googlemail.com` the dots of the local part are removed too and `googlemail.com` becomes `gmail.com`. Per-IP keys (`ip_hash`) hash the IPv4 text unchanged, an IPv4-mapped IPv6 address as its IPv4, and any other IPv6 address as its canonical /64 prefix (e.g. `2001:db8:1:2::/64`).

Part 17b adds four tables (migration 121, written only while `SIGNUP_BONUS_ENABLED` is on):

| Table | Class | Kept after deletion? |
|---|---|---|
| `web_bonus_emails` (HMAC of the normalized address under a REQUEST_KEY-derived key, time) | global | **Yes, on purpose**: the only thing kept of a bonus grant, so deleting and re-signing-up with the same address does not grant the bonus twice. It is not the address and cannot be turned back into it; the privacy policy says so. |
| `web_signup_bonus` (principal id, time: the entitlement) | user | No: removed with the player (`purgePlayerLogins`; the lifecycle audit's `playerLoginsRemain` fails closed on it). |
| `web_free_operations` (operation id, principal id, tier `bonus` / `trial_extra`, keyed IP hash for `trial_extra`) | user (shell) | `bonus` rows: no (deleted with the player). `trial_extra` rows: yes, like `web_ip_lifetime_quota`: only ids and a keyed IP hash, so a purge cannot reset an IP's lifetime trial. The table is one of the audit's `providerShells`. |
| `web_signup_ip_daily` (keyed IP hash, UTC day, count) | global | Yes (no principal; two days of use, counts successful signups per IP). |

Deleted on request, exactly the set the retention cleaner deletes: messages and chats, memory (facts, topics, episodes, embeddings), generated voice (database rows and R2 objects), co-creation ideas, 名片 (nickname) revisions, the email login, its challenges, and every session. What stays, and why: the `web_principals` / `web_operations` / provider-attempt shells (ids, states and money; payloads and receipts are replaced by keyed digests, as in the existing purge), the `web_guest_retention` row (`purged`), and a *revoked* `web_invite_grants` row (ids and times, no content; `web_invite_grants` is now one of the audit's `shells`, and a cleared world may hold no unrevoked grant). The audit row (`web_admin_audit`: `actor_id` NULL, action `player-account-deleted` / `guest-data-cleared`, `target_id` the first 16 hex characters of an HMAC pseudonym, time) carries no content, address, nickname or id. Idempotency state of other kinds: `web_player_throttle` rows are HMAC keys with no principal and age out on their own.

Not stored in SQL: owner-alert state (last check, last send per alert type, error buckets, the UNKNOWN high-water mark) lives in the business Durable Object's key-value storage; the Turnstile one-use ledger holds SHA-256 digests of tokens in memory for ten minutes. Neither holds player data. Turnstile also receives the visitor's IP address and browser signals from Cloudflare's own widget; the privacy policy names it as a processor.

## Part 19: tester chat review (migration 122, flag `CHAT_REVIEW_ENABLED`)

During testing the owner reads whole chat transcripts to tune the characters' tone without being able to tell which account a transcript belongs to; removed chats stay readable, anonymously, for 180 days. Migration 122 (`122_chat_review.sql`, sha256 `5a81455c85a05c9095d66eb50803acefc1d2c2f6b0a478891e733d1471eec950`) adds three tables. The business object is the only writer; nothing here reaches a prompt or a provider.

| Table | Class | Kept after deletion? |
|---|---|---|
| `web_review_codes` (principal id, 4-character code from an alphabet without 0/O, 1/I/L, time) | user | **No**: removed with the player by `purgePlayerLogins` (account deletion, guest clear, the guest purge after trial/grace and the 180-day inactivity purge), and also in the transaction that archives the transcript. The lifecycle audit's `playerLoginsRemain` fails closed if one remains for a cleared world. The code is drawn at random (never derived from an id, email, IP or invite), is the same across one player's characters, and is unique against live codes AND codes still present in the archive. |
| `web_review_notice` (principal id, time the one-time banner was closed) | user | **No**: removed with the player (same path and same audit check). |
| `web_review_archive` (label, review code, character id, line order, character-local time, speaker, text, status, error code, review_changed, archived_at, expires_at) | **anonymous review archive: content without identity, 180 days** | Yes, until `expires_at` (= `archived_at` + 180 days); then the alarm's retention sweep deletes it (batched, idempotent). Nothing else deletes or edits it and no player-facing route reads it. |

The archive has no principal, player, world, conversation, session or operation id and no column, index or digest that joins to an account. `auditWebLifecycleWorld` checks the columns on every run (`archiveHasIdentityColumn`: no column naming a principal / player / world / conversation / session / operation / invite / email / account / IP, and no `*_id` column other than `character_id`) and fails closed. The player's nicknames - the current one and every past 名片 revision - are replaced by 〔昵称〕 (compatibility-folded, case-insensitive, ignoring spaces and invisible characters) before any text is written, and again in everything the admin screen and the CSV return.

**When it is written.** Only while `CHAT_REVIEW_ENABLED` is on, and only in the transaction that STARTS a purge (`WebCloudRetention.markExpired` / `WebRetentionCleaner.markExpired`, T1), before any content is cleared and before the purge's own writes: a crash can neither lose the copy nor leave content without one. A purge resumed after a restart finds the retention state already `purging` and returns before the copy, so a principal is archived at most once. With the flag off nothing is archived and deletion is exactly as before. The same T1 covers all four paths: account deletion, 清除本设备的体验数据, the guest purge after trial/grace, and the 180-day inactivity purge.

**Who can read what.** The live transcripts and the archive are read only through the admin routes `/admin/conversations/{list,detail,export}` (read-only budget, permission `conversations.read` = 查看测试对话, owner by default, in no preset except 全部; with the flag off the routes do not exist). Every list, detail and export call writes one `web_admin_audit` row (actor, action, label, time; no content). Never returned: email (even masked), nickname, any principal / player / world / session / operation id, IP hash, invite code, memories or facts, voice files.

**Residual risk, stated plainly.** A reader who also sees the retained operation shells (ids, states, millisecond timestamps) could in principle correlate an archived line's minute-resolution local time with a shell's timestamp; the archive stores no digest of any id, so there is no key to join on, but timing is not hidden. The privacy policy also says that anything identifying a player may be recognised if the player typed it into the chat.

## Notes for later Parts

- Retention tables carry `principal_id` but are classified global because the retention cleaner is a cross-principal job that must outlive the principal's rows. A later Part may split them.
- User tables keyed only by `world_id` rely on the 1:1 `web_principals.world_id` link; `UserContext` (`platform/store-boundary.ts`) therefore carries only `worldId`.
- Nothing enforces these classes in SQL yet; `UserStore` and `GlobalStore` are thin wrappers over the same connection.

## Player model choice, points, backup log and usage (Part 21b, migration 123, flag `PLAYER_MODEL_CHOICE_ENABLED`)

The player's chosen model only DRAFTS. REVIEW (safety, memory topics and `factOps`) always runs on the house reviewer (DeepSeek v4 pro, backup Gemini 3.8 Flash), so memory is written by one consistent model whatever the player picks; a switch mid-conversation changes the next draft only, and topics keep linking (tested). The chosen model is frozen into the operation at admission and is routing data: it is never put into any prompt or into the frozen request. Guests and administrators are untouched. Invited players may choose a model but are never charged points: no points rows are created for them, their rolling daily reply limit is unchanged, and their operations carry `web_operation_models` with `points_charged = 0`. There is no admin UI for points in this Part. (Existing behaviour worth knowing: `freezeWebV7Request` recalls memory only for non-guest principals, and a signed-up player with the bonus is still a `guest`-kind principal.)

| Table | Class | Kept after deletion? |
|---|---|---|
| `web_player_model` (principal id, chosen model, one-time notice) | user | No: removed with the player (`purgePlayerLogins`). |
| `web_points_policy` (principal id, kind `one_off` / `daily_refill` / `unlimited`, amount, last refill day) | user | No (same). The allowance POLICY, kept apart from the balance so Part 22 can add tiers without a rewrite; today only `one_off` (the signup bonus) and `unlimited` are acted on. |
| `web_points_balance` (principal id, balance) | user | No (same). Created lazily on first touch: 100 − 10 × bonus replies already spent; no backfill. |
| `web_points_events` (principal id, operation id, `source` = bonus / grant / daily_refill / reset / spend / refund, signed delta, reason, acting admin id for grant/reset only, price version) | user | No (same; append-only: updates are refused by a trigger; `playerLoginsRemain` fails closed on leftovers). |
| `web_operation_models` (operation id, chosen model, voice, points charged, price version, settled, draft/review provider+model, backup flag) | user (shell) | Yes: ids, enums and counts, no principal id, no content (one of the audit's `providerShells`). |
| `web_provider_backups` (operation id, phase, generation, abandoned provider/model, code, held micros) | user (shell) | Yes (same reasons; its row count is also the generation of the shared budget reservation id). |
| `web_provider_usage` (UTC day, provider, model, phase, calls, tokens/bytes, cost at list price in micros, replies) | global | Yes: aggregates only, no principal id, no operation id, no content. Read by `pnpm usage:report` and the operator `inspect`. |

Points are player fairness; the budget ledger is money safety; they are independent (a refund never releases a reservation). A charge happens at admission; an operation that ends with no reply (failed, cancelled, UNKNOWN) is refunded in full, and one answered by the backup model costs the cheaper of the two models, when the balance is next touched (`reconcilePoints`, once per fact by a unique index). xAI and Gemini spend books against the existing text bucket (`deepseek`) of the shared budget authority (no new grant ceremony); the local ledger tracks each provider separately.

## Owner-controlled models and prices (Part 21g, migration 124)

The admin page 系统 → 模型与价格 is settings only: it holds no player data. The five tables below are global configuration written only by the business object (an owner or `models.manage` administrator, behind session + CSRF + origin). They carry no principal id, player id, world id, email, nickname or message content, and no column could (`web_model_changes` stores the acting administrator's member id, shown in the page only as the administrator's label).

| Table | Class | Kept after deletion? |
|---|---|---|
| `web_model_settings` (model, enabled, allowed per tier: guest / registered / invited, points per reply, updated at, updating admin) | global | Yes: it is the site's configuration; nothing in it concerns a player. |
| `web_model_voice` (voice points, revision of the page, updated at, updating admin) | global | Yes (same). |
| `web_price_versions` (version, the three per-reply prices, voice price, created at, creating admin) | global | Yes: append-only (update and delete are refused by triggers). Points events and `web_operation_models` name a version, so an old charge stays explainable. |
| `web_model_changes` (save id, admin member id, model or voice, field, old value, new value, price version, time) | global | Yes: append-only (triggers); the page lists the latest 30 with the administrator's label. |
| `web_model_save_requests` (request id, content digest, save id, revision, time) | global | Yes: idempotency record of admin saves; request ids are random page-generated strings. |

Tier of a player (`playerTier`): guest, registered (a guest holding the signup bonus) or invited (invite or account principal). It is derived from existing rows at request time and is never stored. Admitted operations keep their frozen model and price version (`web_operation_models`, unchanged); a player's own saved model (`web_player_model`) is still removed with the player. The change log and the admin view show no ids, emails or content (tested: the tables' JSON and the page's view are searched for principal, player, world and request ids and for message text).
