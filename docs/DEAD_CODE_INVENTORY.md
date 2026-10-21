# Dead code inventory (Part 22x)

This file describes the tree as of Part 22x. The earlier hand-made inventories (Parts 2b, 3, 7a, 7b, 21i and the migration-table survey, which `docs/DATA_BOUNDARY.md` supersedes) were replaced by a check that runs on every `pnpm check`.

## The check

`scripts/check-dead-exports.ts` (`pnpm check:dead-exports`, also `tests/web/unit/dead-exports.test.ts`) fails when a **non-test module exports a value that nothing outside tests calls**.

- Values only: functions, classes, enums, `const`s and named re-exports. Exported types and interfaces have no runtime and are not checked.
- Built from the TypeScript AST over every tracked `.ts` file. `.js` specifiers map to `.ts`. `export *`, a namespace import whose binding escapes, and a dynamic `import()` count as importing every export of that module, so the check errs towards not reporting.
- Use inside the declaring file counts as a caller; **use by a test does not**. A symbol that only a test calls is dead code with a test attached: delete both, or allow-list it as a test seam.
- `anything under tests/ and apps/player-web/tests/` is never itself checked.
- The test also fails on a **stale allow-list entry**: the file or export is gone, or it now has a real caller (so the entry would only hide a future dead export under the same name).

```
pnpm check:dead-exports                      # exit 1 and list offenders
node scripts/check-dead-exports.ts --json    # machine-readable
```

To fix a failure: delete the symbol and the private helpers, constants and imports it alone kept alive (`tsc --noEmit --noUnusedLocals` lists what became unused), delete tests that existed only for it, or add it to `config/dead-exports-allowlist.json` with a reason of at least ten characters.

## The allow-list (`config/dead-exports-allowlist.json`)

| Category | Entries | Why it stays |
|---|---|---|
| Worker entrypoints | every export of `workers/web-cloudflare/{edge,business,budget,generation}.ts` | Bound by name in the Cloudflare deployment (Durable Object classes, RPC services, default `fetch`); nothing imports them. |
| Memory review | `memory/memory-review.ts`: `correctMemory`, `listCorrections`, `listMemoryTopics`, `readMemoryDetail` | The player-facing memory controls are the next product step; the live memory system and its tests use them. |
| Proactive messages | `memory/memory.ts`: `selectProactiveTopic` | Proactive-message code is out of scope until its own Part. |
| Test seams | `resetChatGuide`, `resetCocreationDrafts`, `PLAYER_NUMBER_PATTERN`, `grantPoints`, `memoryAlertState`, `OfflineEmbeddings`, `fixtureVector`, `isPreSend`, `verifyVoiceMaterialEvidence`, `preflightWebDataPolicy`, `syntheticProviderBootstrap` | Helpers that component, unit or fixture-worker tests build on, with no production caller. |

## Entry points and files outside the import graph

`workers/web-cloudflare/{edge,business,budget,generation}.ts`, `apps/player-web/src/app/main.ts`, every `scripts/*.ts` named in a `package.json` script (`web-v1`, `build-web-player`, `preview-web`, `web-cloudflare-package`, `test-web-local-http`, `test-web-data-lifecycle-restart`, `check-dead-exports`, `check-web-browser`) and the two manual operator tools `scripts/web-provider.ts` and `scripts/web-cloudflare-operator.ts` (see `docs/DEPLOYMENT.md`). `workers/cloudflare/runtime.d.ts` is ambient and `.sql` files are read by the migration runners. Nothing else is outside the graph.

## What Part 22x removed

Features of earlier product versions that nobody used. Every symbol below had no caller outside tests (and no caller at all after the removals of Part A); old tables stay, nothing is dropped.

- **Sign-in:** the only way in is email + password. Gone: recovery codes (issue, regenerate, entry, popup), the legacy invite redemption and invite-only sessions (`web_invite_credentials`, identity receipts, `/invites/credential|credential-regenerate|recover`, `/identity/invite-receipt-*`, `/identity/receipt-*`, `/admin/invites/issue|revoke-code|revoke-grant|list`, the `invite-grants` operator command) and the 绑定邮箱 flow for recovery-code holders. Migration 126 (data only) turns the last `kind='invite'` principals into guests: with an email login they are registered players, without one they have no access and retention treats them as expired guests.
- **Browser:** the static demo prototype and the browser-side synthetic modes (`?mode=local-2|local-3|local-3-admin`, local API/session/IndexedDB controllers). The bare URL redirects to `?mode=provider`. The server-side `WebLocalServer` stays because the e2e tests run on it.
- **Server code with no caller:** the player full-profile write paths and the association enum writer (`savePlayerProfile`, `createPlayerProfile`, `validatedProfile`, `initializeAssociation`, `validateAssociation`; nickname read/write stays), relationship correction/reset/list/freeze and scene end/read/freeze entry points (`correctRelationshipEvent`, `freezeRelationshipMessages`, `listRelationshipEvents`, `resetRelationshipState`, `endScene`, `freezeSceneContext`, `frozenSceneInputs`, `readScene`), the beta cost ledger (`budget/beta-costs.ts`, `BetaCosts`, `validateCostLedger`), `VoiceCatalog`, `compileApprovedCharacter`, `CloudAdminAssets`, the unused audio-validation helpers, `normalizeFeedbackPNG`, the old cloud recovery/guard cluster (`cloudflare/guard-access-state.ts`, `guard-cost-facts.ts`, `recovery-guard.ts`, `guard-recovery.ts`, `recovery-point.ts`, `schema.ts`, `DurableStore`, `platform/recovery-protocol.ts` token helpers), the duplicate `textPolicyHash` in `accepted-text-prompt.ts`, `deepSeekObservation`, `deepSeekUsage`, `parseDeepSeekResponse`, `CONTRACT_VERSION`, `isModelTier`, the dead domain functions (`planDailyOpportunity`, `advanceSession`, `catchUpAt`, `closeSession`, `firstProbabilityDrop`, `slotAt`, `testCharacters`), `slicePCM`, three voice benchmark case lists, `AUTONOMY_PRESETS`, and the contract types left without readers (`WebIdentityReceipt`, `WebRecoverInput`, `WebPendingTrialClaim`; `'invite'` left `WebAccessKind`).

## What intentionally stays

- The `web_principals.kind` CHECK still lists `invite` (a CHECK cannot change without rebuilding the table); no business decision reads it.
- Old tables (`web_invite_credentials`, legacy grants, receipts) stay unread.
- `WebLocalServer` and its schema 109/110 harness, `register` and kind `account` (used by the local e2e tests); `WebInviteAdmin` and `InviteAdminApi` (the entitlement admin page's base classes); the `invites.*` permission names.
- Prompts, prompt rules, protocol schemas, relationship presets and proactive-message code were not touched; the pinned prompt and policy hashes are unchanged (`pnpm prompts:check`).

## Text protocols

**accepted-v7 is the only protocol.** The `experimental-v10` protocol (`text-protocol.ts`, `text-prompt.ts`, the `textProtocol` option and every v10 branch) was removed in Part 2b. `createTextGenerationPolicy` still serializes `textProtocol: 'accepted-v7'` in the resolved policy because the approval hash covers the full serialized policy; `tests/web/unit/web-text-policy.test.ts` pins the hash, prompt hash and protocol fingerprint.
