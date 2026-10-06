# Dead code inventory (Part 2b)

Regenerated after Part 2b from a throwaway static import graph (TypeScript AST; `import`, `export … from`, dynamic `import()`, `import('…')` type references, `new URL(…, import.meta.url)`, and relative `.ts`/`.mjs` path strings such as forked workers). The script is kept outside the repo (`work/`, gitignored). Part 2b deleted the iOS-era modules and the experimental-v10 text protocol listed in the Part 2 inventory; this file describes the tree that remains.

**Entry points:** `workers/web-cloudflare/{edge,business,budget,generation}.ts`, `apps/player-web/src/app/main.ts`, every `scripts/*.ts` named in a `package.json` script (`scripts/web-v1.ts`, `scripts/build-web-player.ts`, `scripts/preview-web.ts`, `scripts/web-cloudflare-package.ts`, `scripts/test-web-local-http.ts`, `scripts/test-web-data-lifecycle-restart.ts`), and the two kept manual operator tools `scripts/web-provider.ts` and `scripts/web-cloudflare-operator.ts` (documented in `docs/DEPLOYMENT.md`).

**Also treated as live:** `workers/cloudflare/runtime.d.ts` (ambient declarations picked up by `tsconfig.json`), and every `.sql` file read by a migration runner. No `.sql` file and neither migration runner changed in Part 2b.

## (a) Source files not reachable from any entry point or test

None. 194 non-test `.ts` files were analysed; the graph orphans are `workers/cloudflare/runtime.d.ts` (ambient types, live as above) and, in `apps/player-web`, `src/app/local-mode.ts` and `src/features/prototype/preview.ts` (not imported by any file or test; not touched in Part 2b, candidates for a later Part).

## (c) Files reachable only from tests

Outside Part 2b's scope and not deleted. All are in `apps/player-web` or are the `web-local*` contracts used by the player-web component tests:

- `apps/player-web/src/app/admin-mode.ts`
- `apps/player-web/src/data/local-cache.ts`
- `apps/player-web/src/data/pending-operations.ts`
- `apps/player-web/src/data/send-controller.ts`
- `apps/player-web/src/data/sync-controller.ts`
- `apps/player-web/src/features/admin/account-admin-page.ts`
- `apps/player-web/src/features/admin/character-form.ts`
- `apps/player-web/src/features/admin/character-workbench.ts`
- `apps/player-web/src/features/admin/invite-admin-page.ts`
- `apps/player-web/src/features/admin/invite-records.ts`
- `apps/player-web/src/features/admin/permission-editor.ts`
- `apps/player-web/src/features/invite/invite-form.ts`
- `apps/player-web/src/features/local/local-page.ts`
- `apps/player-web/src/features/local/local-state.ts`
- `apps/player-web/src/features/prototype/mobile-layout.ts`
- `apps/player-web/src/features/prototype/orbit.ts`
- `apps/player-web/src/features/prototype/provider-binding.ts`
- `apps/player-web/src/features/prototype/provider-catalog-view.ts`
- `apps/player-web/src/features/prototype/provider-start-error.ts`
- `apps/player-web/src/features/prototype/reply-presentation.ts`
- `apps/player-web/src/media/audio-controller.ts`
- `apps/player-web/src/services/account-admin-api.ts`
- `apps/player-web/src/services/character-admin-api.ts`
- `apps/player-web/src/services/invite-admin-api.ts`
- `apps/player-web/src/services/invite-local-api.ts`
- `apps/player-web/src/services/local-api.ts`
- `apps/player-web/src/services/provider-api.ts`
- `apps/player-web/src/session/access-controller.ts`
- `apps/player-web/src/session/identity-controller.ts`
- `apps/player-web/src/session/invite-controller.ts`
- `apps/player-web/src/session/invite-form-adapter.ts`
- `apps/player-web/src/session/local-session.ts`
- `apps/player-web/src/session/provider-invite-controller.ts`
- `packages/contracts/web-local-client.ts`
- `packages/contracts/web-local-invite.ts`
- `packages/contracts/web-local.ts`

Operator tools (`scripts/web-provider.ts`, `scripts/web-cloudflare-operator.ts`) and the modules only they use (`apps/server/web-provider-{assets,budget,live-budget,migration,server}.ts`) are entry-point-reachable and therefore live.

Removed in Part 2b: `apps/server/{engine,autonomy,moment-autonomy,media,media-core,group-knowledge,relationship-test,beta-accounts,beta-access-transactions,credentials,text-queue,audio-queue,audio-files,audio-storage,player-generation-error,provider-meter,memory-links,text-protocol,text-prompt}.ts`, `packages/contracts/moment-autonomy.ts`, `packages/domain/delivery.ts`. `memory-links.ts` became unreachable once `text-prompt.ts` was gone. The two env-file loaders from `credentials.ts` that `scripts/web-provider.ts` needs now live in that script.

## (b) Exported symbols never imported by another file

Heuristic: counts named imports/re-exports across all files including tests; ignores same-file use; a namespace import, `export *` or `import('…')` type reference counts as importing every export of that module. Many are exported types or helpers used inside their own module, so this list is **candidates for review, not a deletion list**.

### In files reachable from entry points (196)

- `apps/server/accepted-text-prompt.ts`: `TEXT_SYSTEM_PROMPT`, `TEXT_REVIEW_PROMPT`, `textPolicyHash`
- `apps/server/audio-validation.ts`: `safeAudioError`, `runningAudioCount`, `speechMetadata`, `validateSpeech`
- `apps/server/beta-costs.ts`: `costUsage`, `estimateCost`, `BetaCosts`, `validateCostLedger`
- `apps/server/characters.ts`: `compileApprovedCharacter`
- `apps/server/cloudflare/admin-assets.ts`: `AdminAsset`, `adminAssetType`, `CloudAdminAssets`
- `apps/server/cloudflare/guard-access-state.ts`: `GuardAccount`, `GuardDevice`, `GuardInvite`, `snapshotGuardAccess`
- `apps/server/cloudflare/guard-cost-facts.ts`: `GuardSendIntent`, `guardSendIntent`, `GuardCostFact`
- `apps/server/cloudflare/queue-alarm.ts`: `cloudQueueNextDue`
- `apps/server/cloudflare/recovery-guard.ts`: `GuardIntent`
- `apps/server/cloudflare/recovery-point.ts`: `prepareCloudRecoveryPoint`
- `apps/server/cloudflare/schema.ts`: `cloudScreenshotSchema`, `cloudRateSchema`, `cloudAdminIdentitySchema`, `cloudAccessCoordinatorSchema`, `cloudCostOutboxSchema`, `cloudReconciliationOutboxSchema`, `cloudRetentionSchema`, `cloudAlertSchema`, `cloudWorkerHealthSchema`, `cloudBackupCatalogSchema`
- `apps/server/cloudflare/web-http.ts`: `WebHTTPExecution`
- `apps/server/cloudflare/web-setup.ts`: `WebCloudFixedAsset`
- `apps/server/context-evidence.ts`: `freezeContextEvidence`
- `apps/server/deepseek.ts`: `parseDeepSeekResponse`, `parseDeepSeekToolResponse`
- `apps/server/feedback-png.ts`: `maximumScreenshotPixels`, `normalizeFeedbackPNG`
- `apps/server/memory-review.ts`: `listMemoryTopics`, `readMemoryDetail`, `listCorrections`, `correctionInput`, `correctMemory`
- `apps/server/memory.ts`: `recallMemories`, `recentTurns`, `selectProactiveTopic`
- `apps/server/player-profile.ts`: `validateAssociation`, `validatedProfile`, `playerProfile`, `initializeAssociation`, `createPlayerProfile`, `savePlayerProfile`
- `apps/server/recovery.ts`: `RECOVERY_FILE`, `RESTORE_INCOMPLETE`
- `apps/server/relationships.ts`: `freezeRelationshipMessages`, `listRelationshipEvents`, `correctRelationshipEvent`, `resetRelationshipState`
- `apps/server/scenes.ts`: `freezeSceneContext`, `frozenSceneInputs`, `readScene`, `endScene`
- `apps/server/voices.ts`: `validateVoiceProfile`, `VoiceCatalog`
- `apps/server/web-account-admin.ts`: `ADMIN_PERMISSIONS`, `AdminMember`
- `apps/server/web-character-catalog.ts`: `WebCharacterPresentation`, `CatalogEntry`
- `apps/server/web-character-materials.ts`: `MaterialKind`, `MaterialRow`, `materialAssets`, `materialManifest`
- `apps/server/web-character-preview.ts`: `PreviewActor`, `WebPreviewJob`, `requirePreviewActor`
- `apps/server/web-data-policy-preflight.ts`: `DataPolicyPreflight`
- `apps/server/web-dispatch-ledger.ts`: `WebOperationFence`
- `apps/server/web-identity.ts`: `WebIdentityKeys`, `WebIdentityOptions`
- `apps/server/web-input-snapshot.ts`: `WebInputSnapshot`
- `apps/server/web-provider-materials.ts`: `VoiceMaterialEvidence`, `SelectedVoiceFiles`
- `apps/server/web-provider-media.ts`: `ProviderAudioScope`
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

Information only; no `.sql` file was touched. Both migration runners still apply all of 001–033. Method: for each `CREATE TABLE` name, a word-boundary text search in non-test TypeScript reachable from entry points (and web migrations 100+). **W** = an `INSERT/UPDATE/DELETE/REPLACE` on the table appears; **R** = `FROM/JOIN` appears; **mention** = name appears without either; **none** = no reference. Names that are common words (`media`, `jobs`, `participants`, `batches`) can give false positives, and shared modules such as `store.ts` and `config` count as web code. A SQL reference in a later web migration is marked **+sql**.

| Migration | Table | Web code | Files (up to 3) |
|---|---|---|---|
| 001_core.sql | worlds | W+R +sql | `web-identity.ts`, `beta-costs.ts`, `cloudflare/queue-alarm.ts` |
|  | character_templates | W+R +sql | `cloudflare/web-setup.ts`, `web-character-publication.ts`, `scripts/web-v1.ts` |
|  | world_characters | W+R +sql | `cloudflare/web-retention.ts`, `web-character-deletion.ts`, `web-local-server.ts` |
|  | conversations | W+R +sql | `web-admission.ts`, `player-profile.ts`, `relationships.ts` |
|  | participants | W+R | `web-admission.ts`, `beta-costs.ts`, `player-profile.ts` |
|  | contacts | W | `cloudflare/web-retention.ts`, `web-admission.ts`, `web-character-deletion.ts` |
|  | batches | R | `cloudflare/queue-alarm.ts` |
|  | draws | none |  |
|  | messages | W+R +sql | `cloudflare/web-retention.ts`, `web-admission.ts`, `web-character-deletion.ts` |
|  | proactive_intents | mention | `web-retention-cleaner.ts` |
|  | jobs | W+R +sql | `cloudflare/web-retention.ts`, `scenes.ts`, `web-character-deletion.ts` |
|  | reply_items | R | `cloudflare/queue-alarm.ts`, `web-character-deletion-audit.ts`, `web-lifecycle-audit.ts` |
|  | media | mention +sql | `apps/player-web/src/app/local-mode.ts`, `apps/player-web/src/features/local/local-page.ts`, `cloudflare/admin-assets.ts` |
|  | outbox | W | `web-admission.ts`, `web-vertical-publisher.ts`, `cloudflare/web-retention.ts` |
| 002_dialogue_memory.sql | dialogue_bubbles | W+R | `web-vertical-publisher.ts`, `memory.ts`, `web-v7-request.ts` |
|  | memory_topics | W+R | `memory.ts`, `accepted-memory.ts`, `memory-review.ts` |
|  | memory_episodes | W+R | `memory.ts`, `accepted-memory.ts`, `memory-review.ts` |
|  | memory_mentions | W+R | `memory.ts`, `cloudflare/web-retention.ts`, `web-character-deletion-audit.ts` |
| 003_proactive_topics.sql | proactive_topics | W+R | `memory.ts` |
| 004_player_api.sql | api_players | W+R +sql | `web-identity.ts`, `store.ts`, `web-admission.ts` |
|  | api_devices | R | `cloudflare/guard-access-state.ts` |
|  | pairing_invites | R | `cloudflare/guard-access-state.ts` |
|  | world_setup_receipts | none |  |
|  | text_attempts | none |  |
|  | text_retry_state | R | `cloudflare/queue-alarm.ts` |
| 005_admin.sql | character_template_versions | W | `web-character-publication.ts` |
|  | admin_sessions | W+R +sql | `web-account-admin.ts`, `web-invite-admin.ts`, `web-character-preview.ts` |
|  | admin_login_grants | W+R | `web-invite-admin.ts`, `web-account-admin.ts`, `web-admin-schema.ts` |
|  | character_draft_revisions | W+R | `web-character-preview.ts`, `web-character-publication.ts` |
|  | character_drafts | none |  |
|  | admin_previews | W+R | `web-character-preview-runner.ts`, `web-character-preview.ts`, `web-character-admin.ts` |
|  | character_publications | none |  |
| 006_memory_corrections.sql | memory_catalog | W+R | `memory.ts`, `memory-review.ts`, `cloudflare/web-retention.ts` |
|  | memory_corrections | W+R | `memory-review.ts`, `memory.ts`, `web-v7-request.ts` |
|  | memory_context_versions | W+R | `memory-review.ts`, `cloudflare/web-retention.ts`, `web-character-deletion-audit.ts` |
| 007_groups.sql | group_conversations | mention | `context-evidence.ts`, `web-retention-cleaner.ts` |
|  | group_creation_receipts | none |  |
|  | group_message_routes | none |  |
|  | group_job_reads | none |  |
|  | group_message_knowledge | R | `context-evidence.ts` |
| 008_memory_sources.sql | job_evidence_snapshots | W+R | `context-evidence.ts`, `web-vertical-publisher.ts`, `cloudflare/web-retention.ts` |
|  | memory_episode_sources | W+R | `context-evidence.ts`, `web-v7-request.ts`, `cloudflare/web-retention.ts` |
| 009_clarifications.sql | (alters existing tables only) | n/a | |
| 010_moments.sql | moment_threads | mention | `context-evidence.ts`, `web-retention-cleaner.ts` |
|  | moment_requests | none |  |
| 011_autonomy.sql | autonomy_days | none |  |
| 012_voice_delivery.sql | voice_profiles | W+R | `voices.ts` |
|  | speech_tasks | R | `audio-validation.ts`, `cloudflare/queue-alarm.ts`, `web-retention-cleaner.ts` |
|  | speech_retry_receipts | none |  |
| 013_admin_voice_previews.sql | admin_voice_previews | R | `audio-validation.ts` |
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
| 019_player_profiles.sql | player_profile_versions | W+R | `player-profile.ts`, `web-retention-cleaner.ts` |
|  | player_profile_requests | W+R | `player-profile.ts` |
|  | character_association_versions | W+R | `player-profile.ts` |
| 020_relationship_events.sql | relationship_states | W+R | `relationships.ts`, `cloudflare/web-retention.ts`, `web-character-deletion-audit.ts` |
|  | relationship_daily_budgets | W+R | `relationships.ts`, `cloudflare/web-retention.ts`, `web-character-deletion-audit.ts` |
|  | relationship_job_contexts | W+R | `relationships.ts`, `web-vertical-publisher.ts`, `scenes.ts` |
|  | relationship_reviews | W | `relationships.ts`, `cloudflare/web-retention.ts`, `web-character-deletion-audit.ts` |
|  | relationship_events | W+R | `relationships.ts`, `web-v7-request.ts`, `cloudflare/web-retention.ts` |
|  | relationship_corrections | W+R | `relationships.ts`, `cloudflare/web-retention.ts`, `web-character-deletion-audit.ts` |
| 021_scenes.sql | scene_states | W+R | `scenes.ts`, `cloudflare/web-retention.ts`, `web-character-deletion-audit.ts` |
|  | scene_job_contexts | W+R | `scenes.ts`, `web-vertical-publisher.ts`, `cloudflare/web-retention.ts` |
|  | scene_events | W+R | `scenes.ts`, `web-v7-request.ts`, `cloudflare/web-retention.ts` |
|  | scene_end_requests | W+R | `scenes.ts`, `cloudflare/web-retention.ts`, `web-character-deletion-audit.ts` |
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
| 025_beta_accounts.sql | beta_instance | W+R | `cloudflare/store.ts`, `store.ts`, `cloudflare/recovery-point.ts` |
|  | beta_accounts | R | `beta-costs.ts`, `cloudflare/guard-access-state.ts`, `cloudflare/queue-alarm.ts` |
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
| 030_beta_costs.sql | beta_cost_prices | W+R | `beta-costs.ts` |
|  | beta_cost_budgets | W+R | `beta-costs.ts` |
|  | beta_cost_calls | W+R | `beta-costs.ts` |
|  | beta_cost_events | W+R | `beta-costs.ts` |
|  | beta_cost_admin_receipts | W+R | `beta-costs.ts` |
| 031_beta_audio_queue.sql | (alters existing tables only) | n/a | |
| 032_beta_reviewed_replies.sql | beta_reviewed_replies | R | `cloudflare/queue-alarm.ts` |
| 033_beta_cost_history.sql | beta_cost_history | none |  |
|  | beta_cost_history_receipts | none |  |
