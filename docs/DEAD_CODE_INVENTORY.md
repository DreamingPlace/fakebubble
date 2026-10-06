# Dead code inventory (Part 2b)

**Correction (Part 3).** The player app imports TypeScript files with `.js` extensions (for example `main.ts` imports `'../features/prototype/preview.js'` and `import('./local-mode.js')`), and those files are used. The script behind this inventory did not map `.js` specifiers to `.ts`, so it wrongly reported `apps/player-web/src/app/local-mode.ts` and `apps/player-web/src/features/prototype/preview.ts` as unused and listed almost all of `apps/player-web` as reachable only from tests. Re-resolving the graph from `apps/player-web/src/app/main.ts` with `.js` mapped to `.ts` leaves one player-web source file outside it (see (a) and (c)). Entries under `apps/player-web/` in section (b) came from the same unmapped resolution and must be re-derived before anyone acts on them. Do not delete `local-mode.ts` or `preview.ts`. Server paths below were updated for the Part 3 folder layout.

Regenerated after Part 2b from a throwaway static import graph (TypeScript AST; `import`, `export … from`, dynamic `import()`, `import('…')` type references, `new URL(…, import.meta.url)`, and relative `.ts`/`.mjs` path strings such as forked workers). The script is kept outside the repo (`work/`, gitignored). Part 2b deleted the iOS-era modules and the experimental-v10 text protocol listed in the Part 2 inventory; this file describes the tree that remains.

**Entry points:** `workers/web-cloudflare/{edge,business,budget,generation}.ts`, `apps/player-web/src/app/main.ts`, every `scripts/*.ts` named in a `package.json` script (`scripts/web-v1.ts`, `scripts/build-web-player.ts`, `scripts/preview-web.ts`, `scripts/web-cloudflare-package.ts`, `scripts/test-web-local-http.ts`, `scripts/test-web-data-lifecycle-restart.ts`), and the two kept manual operator tools `scripts/web-provider.ts` and `scripts/web-cloudflare-operator.ts` (documented in `docs/DEPLOYMENT.md`).

**Also treated as live:** `workers/cloudflare/runtime.d.ts` (ambient declarations picked up by `tsconfig.json`), and every `.sql` file read by a migration runner. No `.sql` file and neither migration runner changed in Part 2b.

## (a) Source files not reachable from any entry point or test

None. 194 non-test `.ts` files were analysed; the only graph orphan is `workers/cloudflare/runtime.d.ts` (ambient types, live as above). `apps/player-web/src/app/local-mode.ts` and `apps/player-web/src/features/prototype/preview.ts` are reachable from `main.ts` (corrected in Part 3).

## (c) Files reachable only from tests

After the Part 3 correction one file remains: `apps/player-web/src/session/identity-controller.ts` (imported by the player-web component and integration tests, not by `main.ts`). The other 35 files this section previously listed (player-web data, features, services, session and media modules, and `packages/contracts/web-local{,-client,-invite}.ts`) are reachable from `main.ts` through `.js` specifiers. Nothing was deleted.

## (b) Exported symbols never imported by another file

Heuristic: counts named imports/re-exports across all files including tests; ignores same-file use; a namespace import, `export *` or `import('…')` type reference counts as importing every export of that module. Many are exported types or helpers used inside their own module, so this list is **candidates for review, not a deletion list**.

### In files reachable from entry points (196)

- `apps/server/generation/accepted-text-prompt.ts`: `TEXT_SYSTEM_PROMPT`, `TEXT_REVIEW_PROMPT`, `textPolicyHash`
- `apps/server/audio/audio-validation.ts`: `safeAudioError`, `runningAudioCount`, `speechMetadata`, `validateSpeech`
- `apps/server/budget/beta-costs.ts`: `costUsage`, `estimateCost`, `BetaCosts`, `validateCostLedger`
- `apps/server/characters/characters.ts`: `compileApprovedCharacter`
- `apps/server/cloudflare/admin-assets.ts`: `AdminAsset`, `adminAssetType`, `CloudAdminAssets`
- `apps/server/cloudflare/guard-access-state.ts`: `GuardAccount`, `GuardDevice`, `GuardInvite`, `snapshotGuardAccess`
- `apps/server/cloudflare/guard-cost-facts.ts`: `GuardSendIntent`, `guardSendIntent`, `GuardCostFact`
- `apps/server/cloudflare/queue-alarm.ts`: `cloudQueueNextDue`
- `apps/server/cloudflare/recovery-guard.ts`: `GuardIntent`
- `apps/server/cloudflare/recovery-point.ts`: `prepareCloudRecoveryPoint`
- `apps/server/cloudflare/schema.ts`: `cloudScreenshotSchema`, `cloudRateSchema`, `cloudAdminIdentitySchema`, `cloudAccessCoordinatorSchema`, `cloudCostOutboxSchema`, `cloudReconciliationOutboxSchema`, `cloudRetentionSchema`, `cloudAlertSchema`, `cloudWorkerHealthSchema`, `cloudBackupCatalogSchema`
- `apps/server/cloudflare/web-http.ts`: `WebHTTPExecution`
- `apps/server/cloudflare/web-setup.ts`: `WebCloudFixedAsset`
- `apps/server/memory/context-evidence.ts`: `freezeContextEvidence`
- `apps/server/generation/deepseek.ts`: `parseDeepSeekResponse`, `parseDeepSeekToolResponse`
- `apps/server/audio/feedback-png.ts`: `maximumScreenshotPixels`, `normalizeFeedbackPNG`
- `apps/server/memory/memory-review.ts`: `listMemoryTopics`, `readMemoryDetail`, `listCorrections`, `correctionInput`, `correctMemory`
- `apps/server/memory/memory.ts`: `recallMemories`, `recentTurns`, `selectProactiveTopic`
- `apps/server/conversation/player-profile.ts`: `validateAssociation`, `validatedProfile`, `playerProfile`, `initializeAssociation`, `createPlayerProfile`, `savePlayerProfile`
- `apps/server/platform/recovery.ts`: `RECOVERY_FILE`, `RESTORE_INCOMPLETE`
- `apps/server/conversation/relationships.ts`: `freezeRelationshipMessages`, `listRelationshipEvents`, `correctRelationshipEvent`, `resetRelationshipState`
- `apps/server/conversation/scenes.ts`: `freezeSceneContext`, `frozenSceneInputs`, `readScene`, `endScene`
- `apps/server/characters/voices.ts`: `validateVoiceProfile`, `VoiceCatalog`
- `apps/server/admin/web-account-admin.ts`: `ADMIN_PERMISSIONS`, `AdminMember`
- `apps/server/characters/web-character-catalog.ts`: `WebCharacterPresentation`, `CatalogEntry`
- `apps/server/characters/web-character-materials.ts`: `MaterialKind`, `MaterialRow`, `materialAssets`, `materialManifest`
- `apps/server/characters/web-character-preview.ts`: `PreviewActor`, `WebPreviewJob`, `requirePreviewActor`
- `apps/server/platform/web-data-policy-preflight.ts`: `DataPolicyPreflight`
- `apps/server/budget/web-dispatch-ledger.ts`: `WebOperationFence`
- `apps/server/identity/web-identity.ts`: `WebIdentityKeys`, `WebIdentityOptions`
- `apps/server/generation/web-input-snapshot.ts`: `WebInputSnapshot`
- `apps/server/generation/web-provider-materials.ts`: `VoiceMaterialEvidence`, `SelectedVoiceFiles`
- `apps/server/audio/web-provider-media.ts`: `ProviderAudioScope`
- `packages/contracts/admin-costs.ts`: `CostMicros`, `CostUnit`, `CostStage`, `CostFunction`, `CostBudgetInput`, `CostReconciliationInput`, `CostGrouping`, `CostFilters`, `CostQuantityTotal`, `CostTotals`, `CostReportGroup`, `CostPage`, `CostReport`, `CostCallPage`, `CostEvent`
- `packages/contracts/audio.ts`: `VoiceIdentity`, `VoiceBenchmarkCase`, `VOICE_BASELINE_CASES`, `VOICE_QUALITY_CASES`, `VOICE_BENCHMARK_CASES`
- `packages/contracts/beta.ts`: `BetaPairInput`, `AdminPlayerAccount`, `AccountStatusInput`, `ReplyGroup`, `ReplyGroupPage`
- `packages/contracts/generation-rpc.ts`: `GenerationResult`, `GenerationSession`, `GenerationBinding`
- `packages/contracts/groups.ts`: `CreateGroupInput`, `GroupMember`, `CreateGroupReceipt`, `SendGroupInput`, `GroupRouting`, `SendGroupReceipt`
- `packages/contracts/media.ts`: `VoiceMessageState`, `VoiceRetryInput`, `VoiceRetryReceipt`
- `packages/contracts/player-api.ts`: `PairingDescriptor`, `PairInput`, `PairResult`, `WorldSetupInput`, `SendMessageInput`, `ConversationSummary`, `BootstrapResult`, `SyncPage`, `HistoryPage`
- `packages/contracts/profile.ts`: `SavePlayerProfileInput`
- `packages/contracts/provider-calls.ts`: `SynchronousProviderReservation`, `SynchronousProviderMeter`
- `packages/contracts/web-provider.ts`: `WebProviderUnavailableReason`, `WebProviderMedia`, `WebProviderCharacter`, `WebProviderSlot`, `WebProviderConversation`, `WebProviderEvent`, `WebProviderError`
- `packages/contracts/web-v1.ts`: `WebId`, `WebAccessKind`, `WebAccess`, `WebCharacter`, `WebConversation`, `WebAudio`, `WebMessage`, `WebSendInput`, `WebSendDraft`, `WebSendAction`, `WebRegisterInput`, `WebLoginInput`, `WebInviteRedeemInput`, `WebRecoverInput`, `WebPendingTrialClaim`, `WebIdentityReceipt`, `WebTrialArchive`, `WebSaveTrialInput`, `WebTrialArchivePage`, `WebTrialArchiveHistory`, `WebReadReceipt`, `WebListenedReceipt`, `WebMemorySummary`, `WebMemoryPage`, `WebMemoryCorrectionInput`, `WebMemoryCorrectionReceipt`, `WebSyncEvent`, `WebApiError`
- `packages/domain/autonomy.ts`: `DailyOpportunity`, `planDailyOpportunity`
- `packages/domain/defaults.ts`: `testCharacters`
- `packages/domain/directions.ts`: `DialogueParts`
- `packages/domain/schedule.ts`: `slotAt`, `catchUpAt`, `firstProbabilityDrop`, `SessionState`, `closeSession`, `advanceSession`
- `scripts/build-web-player.ts`: `PlayerBuildOptions`
- `scripts/web-cloudflare-operator.ts`: `WebOperatorArguments`
- `scripts/web-provider.ts`: `readSelectedVoiceFiles`, `liveTransports`, `renderAssets`, `lanNetwork`
- `workers/audio/fish.ts`: `speechPayload`
- `workers/audio/validation-error.ts`: `AudioGeneration`
- `workers/audio/wav.ts`: `slicePCM`
- `workers/web-cloudflare/budget.ts`: `BudgetEnvironment`, `WebBudgetService`, `WebBudgetOperatorService`
- `workers/web-cloudflare/edge.ts`: `WebBusinessEndpoint`
- `workers/web-cloudflare/generation.ts`: `WebGenerationEnvironment`, `WebGenerationService`

### In test-only files (23)

- `apps/player-web/src/app/admin-mode.ts`: `startAdminMode`
- `apps/player-web/src/app/local-mode.ts`: `startLocalMode`, `startLocal3Mode`
- `apps/player-web/src/data/pending-operations.ts`: `PendingState`
- `apps/player-web/src/features/admin/account-admin-page.ts`: `adminAccountError`
- `apps/player-web/src/features/admin/invite-admin-page.ts`: `InviteAdminPort`
- `apps/player-web/src/features/invite/invite-form.ts`: `InviteFormDeps`
- `apps/player-web/src/features/prototype/mobile-layout.ts`: `VisibleViewport`
- `apps/player-web/src/features/prototype/preview.ts`: `startPrototype`
- `apps/player-web/src/features/prototype/provider-catalog-view.ts`: `Person`
- `apps/player-web/src/media/audio-controller.ts`: `PlayResult`
- `apps/player-web/src/services/account-admin-api.ts`: `AdminGrant`
- `apps/player-web/src/services/character-admin-api.ts`: `CharacterDraft`, `CharacterSummary`, `PreviewJob`, `DeleteImpact`
- `apps/player-web/src/session/invite-form-adapter.ts`: `InviteFormResult`
- `packages/contracts/web-local-client.ts`: `LocalSendAction`, `LocalError`
- `packages/contracts/web-local-invite.ts`: `WebInviteBootstrap`, `WebInviteRecoveryResult`, `WebInviteCredential`
- `packages/contracts/web-local.ts`: `WebLocalError`

## Text protocols

**accepted-v7 is the only protocol.** The `experimental-v10` protocol (`text-protocol.ts`, `text-prompt.ts`, the `textProtocol` option and every v10 branch) was removed. `createTextGenerationPolicy` still serializes `textProtocol: 'accepted-v7'` in the resolved policy because the approval hash covers the full serialized policy; `tests/web/unit/web-text-policy.test.ts` pins the hash (`58ba3f99…b7b8`), prompt hash and protocol fingerprint to the pre-removal values.

## Legacy migrations 001–033: table usage by web code

Information only; no `.sql` file was touched. Superseded by `docs/DATA_BOUNDARY.md`, which classifies every table of both migration trees. Correction (Part 3): web stores apply only 001–024 (the Node store stops at 24 unless `beta` is set, which web stores reject; the Cloudflare web migrations take `base.slice(0, 24)`), so tables from 025–033 never exist in a web instance. Method: for each `CREATE TABLE` name, a word-boundary text search in non-test TypeScript reachable from entry points (and web migrations 100+). **W** = an `INSERT/UPDATE/DELETE/REPLACE` on the table appears; **R** = `FROM/JOIN` appears; **mention** = name appears without either; **none** = no reference. Names that are common words (`media`, `jobs`, `participants`, `batches`) can give false positives, and shared modules such as `platform/store.ts` and `config` count as web code. A SQL reference in a later web migration is marked **+sql**.

| Migration | Table | Web code | Files (up to 3) |
|---|---|---|---|
| 001_core.sql | worlds | W+R +sql | `identity/web-identity.ts`, `budget/beta-costs.ts`, `cloudflare/queue-alarm.ts` |
|  | character_templates | W+R +sql | `cloudflare/web-setup.ts`, `characters/web-character-publication.ts`, `scripts/web-v1.ts` |
|  | world_characters | W+R +sql | `cloudflare/web-retention.ts`, `characters/web-character-deletion.ts`, `platform/web-local-server.ts` |
|  | conversations | W+R +sql | `admission/web-admission.ts`, `conversation/player-profile.ts`, `conversation/relationships.ts` |
|  | participants | W+R | `admission/web-admission.ts`, `budget/beta-costs.ts`, `conversation/player-profile.ts` |
|  | contacts | W | `cloudflare/web-retention.ts`, `admission/web-admission.ts`, `characters/web-character-deletion.ts` |
|  | batches | R | `cloudflare/queue-alarm.ts` |
|  | draws | none |  |
|  | messages | W+R +sql | `cloudflare/web-retention.ts`, `admission/web-admission.ts`, `characters/web-character-deletion.ts` |
|  | proactive_intents | mention | `admission/web-retention-cleaner.ts` |
|  | jobs | W+R +sql | `cloudflare/web-retention.ts`, `conversation/scenes.ts`, `characters/web-character-deletion.ts` |
|  | reply_items | R | `cloudflare/queue-alarm.ts`, `characters/web-character-deletion-audit.ts`, `admission/web-lifecycle-audit.ts` |
|  | media | mention +sql | `apps/player-web/src/app/local-mode.ts`, `apps/player-web/src/features/local/local-page.ts`, `cloudflare/admin-assets.ts` |
|  | outbox | W | `admission/web-admission.ts`, `conversation/web-vertical-publisher.ts`, `cloudflare/web-retention.ts` |
| 002_dialogue_memory.sql | dialogue_bubbles | W+R | `conversation/web-vertical-publisher.ts`, `memory/memory.ts`, `generation/web-v7-request.ts` |
|  | memory_topics | W+R | `memory/memory.ts`, `memory/accepted-memory.ts`, `memory/memory-review.ts` |
|  | memory_episodes | W+R | `memory/memory.ts`, `memory/accepted-memory.ts`, `memory/memory-review.ts` |
|  | memory_mentions | W+R | `memory/memory.ts`, `cloudflare/web-retention.ts`, `characters/web-character-deletion-audit.ts` |
| 003_proactive_topics.sql | proactive_topics | W+R | `memory/memory.ts` |
| 004_player_api.sql | api_players | W+R +sql | `identity/web-identity.ts`, `platform/store.ts`, `admission/web-admission.ts` |
|  | api_devices | R | `cloudflare/guard-access-state.ts` |
|  | pairing_invites | R | `cloudflare/guard-access-state.ts` |
|  | world_setup_receipts | none |  |
|  | text_attempts | none |  |
|  | text_retry_state | R | `cloudflare/queue-alarm.ts` |
| 005_admin.sql | character_template_versions | W | `characters/web-character-publication.ts` |
|  | admin_sessions | W+R +sql | `admin/web-account-admin.ts`, `invites/web-invite-admin.ts`, `characters/web-character-preview.ts` |
|  | admin_login_grants | W+R | `invites/web-invite-admin.ts`, `admin/web-account-admin.ts`, `admin/web-admin-schema.ts` |
|  | character_draft_revisions | W+R | `characters/web-character-preview.ts`, `characters/web-character-publication.ts` |
|  | character_drafts | none |  |
|  | admin_previews | W+R | `characters/web-character-preview-runner.ts`, `characters/web-character-preview.ts`, `characters/web-character-admin.ts` |
|  | character_publications | none |  |
| 006_memory_corrections.sql | memory_catalog | W+R | `memory/memory.ts`, `memory/memory-review.ts`, `cloudflare/web-retention.ts` |
|  | memory_corrections | W+R | `memory/memory-review.ts`, `memory/memory.ts`, `generation/web-v7-request.ts` |
|  | memory_context_versions | W+R | `memory/memory-review.ts`, `cloudflare/web-retention.ts`, `characters/web-character-deletion-audit.ts` |
| 007_groups.sql | group_conversations | mention | `memory/context-evidence.ts`, `admission/web-retention-cleaner.ts` |
|  | group_creation_receipts | none |  |
|  | group_message_routes | none |  |
|  | group_job_reads | none |  |
|  | group_message_knowledge | R | `memory/context-evidence.ts` |
| 008_memory_sources.sql | job_evidence_snapshots | W+R | `memory/context-evidence.ts`, `conversation/web-vertical-publisher.ts`, `cloudflare/web-retention.ts` |
|  | memory_episode_sources | W+R | `memory/context-evidence.ts`, `generation/web-v7-request.ts`, `cloudflare/web-retention.ts` |
| 009_clarifications.sql | (alters existing tables only) | n/a | |
| 010_moments.sql | moment_threads | mention | `memory/context-evidence.ts`, `admission/web-retention-cleaner.ts` |
|  | moment_requests | none |  |
| 011_autonomy.sql | autonomy_days | none |  |
| 012_voice_delivery.sql | voice_profiles | W+R | `characters/voices.ts` |
|  | speech_tasks | R | `audio/audio-validation.ts`, `cloudflare/queue-alarm.ts`, `admission/web-retention-cleaner.ts` |
|  | speech_retry_receipts | none |  |
| 013_admin_voice_previews.sql | admin_voice_previews | R | `audio/audio-validation.ts` |
| 014_external_sources.sql | external_sources | none |  |
|  | external_source_versions | none |  |
|  | source_fetch_attempts | none |  |
|  | source_posts | none |  |
|  | source_post_versions | none |  |
|  | source_summaries | none |  |
| 015_paced_delivery.sql | dialogue_deliveries | R | `cloudflare/queue-alarm.ts` |
| 016_chat_interactions.sql | response_fallbacks | none |  |
|  | message_feedback | none |  |
| 017_playtest_reset.sql | playtest_resets | none |  |
|  | retired_sync_cursors | none |  |
|  | retired_proactive_usage | none |  |
|  | playtest_reset_usage | none |  |
|  | playtest_media_cleanup | none |  |
|  | message_feedback_next | none |  |
| 018_audition_expressions.sql | admin_voice_previews_next | none |  |
| 019_player_profiles.sql | player_profile_versions | W+R | `conversation/player-profile.ts`, `admission/web-retention-cleaner.ts` |
|  | player_profile_requests | W+R | `conversation/player-profile.ts` |
|  | character_association_versions | W+R | `conversation/player-profile.ts` |
| 020_relationship_events.sql | relationship_states | W+R | `conversation/relationships.ts`, `cloudflare/web-retention.ts`, `characters/web-character-deletion-audit.ts` |
|  | relationship_daily_budgets | W+R | `conversation/relationships.ts`, `cloudflare/web-retention.ts`, `characters/web-character-deletion-audit.ts` |
|  | relationship_job_contexts | W+R | `conversation/relationships.ts`, `conversation/web-vertical-publisher.ts`, `conversation/scenes.ts` |
|  | relationship_reviews | W | `conversation/relationships.ts`, `cloudflare/web-retention.ts`, `characters/web-character-deletion-audit.ts` |
|  | relationship_events | W+R | `conversation/relationships.ts`, `generation/web-v7-request.ts`, `cloudflare/web-retention.ts` |
|  | relationship_corrections | W+R | `conversation/relationships.ts`, `cloudflare/web-retention.ts`, `characters/web-character-deletion-audit.ts` |
| 021_scenes.sql | scene_states | W+R | `conversation/scenes.ts`, `cloudflare/web-retention.ts`, `characters/web-character-deletion-audit.ts` |
|  | scene_job_contexts | W+R | `conversation/scenes.ts`, `conversation/web-vertical-publisher.ts`, `cloudflare/web-retention.ts` |
|  | scene_events | W+R | `conversation/scenes.ts`, `generation/web-v7-request.ts`, `cloudflare/web-retention.ts` |
|  | scene_end_requests | W+R | `conversation/scenes.ts`, `cloudflare/web-retention.ts`, `characters/web-character-deletion-audit.ts` |
| 022_autonomous_moments.sql | moment_post_settings | none |  |
|  | moment_post_setting_requests | none |  |
|  | moment_post_days | none |  |
|  | moment_post_drafts | none |  |
| 023_playtest_social.sql | conversation_reads | none |  |
|  | player_characters | none |  |
|  | relationship_test_versions | none |  |
| 024_moment_audience_groups.sql | moment_audience_groups | none |  |
|  | moment_audience_group_members | none |  |
|  | moment_audience_group_receipts | none |  |
| 025_beta_accounts.sql | beta_instance | W+R | `cloudflare/store.ts`, `platform/store.ts`, `cloudflare/recovery-point.ts` |
|  | beta_accounts | R | `budget/beta-costs.ts`, `cloudflare/guard-access-state.ts`, `cloudflare/queue-alarm.ts` |
|  | beta_invites | R | `cloudflare/guard-access-state.ts` |
|  | beta_account_receipts | none |  |
| 026_beta_feedback.sql | beta_generation_provenance | none |  |
|  | beta_feedback | mention | `cloudflare/schema.ts` |
|  | beta_feedback_screenshots | R | `cloudflare/store.ts`, `cloudflare/schema.ts` |
| 027_beta_evaluations.sql | beta_evaluations | none |  |
|  | beta_evaluation_revisions | none |  |
| 028_feedback_workflow.sql | beta_feedback_issues | none |  |
|  | beta_feedback_events | none |  |
|  | beta_feedback_workflows | none |  |
|  | beta_feedback_action_receipts | none |  |
| 029_character_requests.sql | beta_character_roster | none |  |
|  | beta_character_catalog | none |  |
|  | beta_character_requests | none |  |
|  | beta_character_request_receipts | none |  |
| 030_beta_costs.sql | beta_cost_prices | W+R | `budget/beta-costs.ts` |
|  | beta_cost_budgets | W+R | `budget/beta-costs.ts` |
|  | beta_cost_calls | W+R | `budget/beta-costs.ts` |
|  | beta_cost_events | W+R | `budget/beta-costs.ts` |
|  | beta_cost_admin_receipts | W+R | `budget/beta-costs.ts` |
| 031_beta_audio_queue.sql | (alters existing tables only) | n/a | |
| 032_beta_reviewed_replies.sql | beta_reviewed_replies | R | `cloudflare/queue-alarm.ts` |
| 033_beta_cost_history.sql | beta_cost_history | none |  |
|  | beta_cost_history_receipts | none |  |
