# Burbur code audit and upgrade assessment (November 2026)

Read-only audit of `DreamingPlace/fakebubble` at `main` = `ca495ed` (merge of PR #71, Part 24k-2). No code, test, prompt, migration or deployment was changed. This file is the only thing added.

## How this audit was done

**Ran, on Node 24.22.2 / pnpm 11.19.0 in a Linux container:**

| Check | Result | Time |
|---|---|---|
| `pnpm format:check` | pass | 1 s |
| `pnpm prompts:check` | pass (pinned hashes unchanged) | 1 s |
| `pnpm check:dead-exports` | pass | 4 s |
| `pnpm typecheck` | pass | 18 s |
| `pnpm test` | 2,017 tests: 2,013 pass, 0 fail, 4 skipped | **22 min 38 s** |
| `buildWebPlayer` (the `web:player:build` function) | builds; sizes in F-15 | — |

**Measured with small scratch scripts (kept outside the repository):**

- the full production schema, built in a scratch SQLite from `webR2Migrations` plus the runtime schema steps (234 tables), cross-referenced against every non-test `.ts` file;
- the request limiter in isolation (F-01);
- the shared budget's `summary()` at 10 k / 100 k / 1 M rows (F-03);
- one scrypt hash at the project's parameters (F-08).

**Not run, and why:**

- **The Playwright browser checks** (`scripts/check-web-*.ts`). They are not part of `pnpm check`, and the long console check alone is 10–20 minutes. Statements about them come from reading the scripts.
- **Anything on Cloudflare.** I had no access to staging or production, so every statement about *data present* in production tables is unverified. Where it matters, the report says which read-only `inspect` addition would settle it.
- **A phone.** The rendering finding (F-15) is from reading the CSS and DOM builder, not from a device trace.
- **The dispatch ledger end to end.** I read `reserve`, `markSent` and the shared budget in full and sampled the rest of `web-dispatch-ledger.ts` (1,300 lines). I found no violation of the UNKNOWN rule, and the integration tests for it pass, but I did not trace every path.

"Confirmed" below means reproduced or traced completely through the code. "Suspected" means the mechanism is real but the size of the effect, or whether it has happened, was not verified.

---

## 1. Executive summary

**Overall health: good core, expensive surroundings.** The parts that guard money, identity and privacy are careful and well tested: reserve-before-call, idempotent dispatch, scoped reads, fail-closed purge audits, an edge that strips every caller-supplied internal header. I found no P0. The risk is elsewhere:

- a handful of **fixed capacity constants** sized for a private beta that the 15-character launch will hit;
- **cost and latency that grow with total history** rather than with current load;
- a large amount of **scaffolding from earlier product stages** (three schema mechanisms, three HTTP transports, historical-schema test fixtures) that every new Part pays for.

### The ten most important findings

| # | Finding | Sev | Status |
|---|---|---|---|
| F-01 | The request limiter holds at most 512 keys per minute. About **170 distinct visitors in one minute** fill it; every *new* visitor then gets `RATE_LIMITED`. | P1 | confirmed (reproduced) |
| F-02 | The catalog is hard-capped at **15 characters** in seven places (table CHECK, server, contract parser, client). 3 existing + 15 new = 18. | P1 | confirmed (traced); impact depends on an owner decision |
| F-03 | Every provider reservation makes the budget object **scan its whole call history twice**. 1 M rows = 2 M rows read and ~190 ms per reservation. | P2, rising | confirmed (measured) |
| F-04 | With `BUDGET_POLICY=production-unlimited` there is **no automatic brake on daily spend**; the only control is an hourly e-mail alert. | P2 | suspected (production policy not visible) |
| F-05 | Fish Drama 3 is billed per character but metered **per UTF-8 byte**: reported voice spend is about 3× the real bill for Chinese text. The list price also rises 5× on 2026-11-13. | P2 | confirmed (traced) |
| F-06 | The error mapper turns **every unlisted error code into HTTP 409**, and refusals below 500 are never logged. This is why the production 409 could not be explained. | P2 | mechanism confirmed; the incident's cause suspected |
| F-10 | **Three schema mechanisms**, not two, plus 136 `sqlite_master` probes so that production code can run on historical schemas that exist only in tests. | P2 | confirmed |
| F-11 | The purge/deletion audits fail closed (good), but the table lists are hand-kept in five places; 26 live tables are missing from `DATA_BOUNDARY.md` and 16 player-keyed tables are outside the audit's automatic sweep. | P2 | confirmed |
| F-12 | **Three hand-synced HTTP transports.** The browser checks exercise the Node one; production runs the workerd one. | P2 | confirmed |
| F-14 | `pnpm test` takes 22.6 min serially against a 30-minute CI limit; the browser suite is outside CI and contains 123 fixed sleeps. | P2 | confirmed |

Also notable: scrypt runs inside the single business object (F-08), invisible and bidi characters are accepted in chat and co-creation text (F-13), and the player site ships a 442 KB unminified stylesheet that is mostly admin console rules (F-15).

**On the leftovers:** 86 of the 189 ledger tables come from the iOS-era migrations 001–024; 40 of them have no reference at all in non-test code. The `beta_*` tables (025–033) are **not** in production — the web authority applies only 001–024 and 100–131 — so that part of the brief is refuted. Almost all leftover *code* can go without touching the migration ledger; dropping leftover *tables* needs one numbered migration and should wait for row counts (section 3).

---

## 2. Findings

### F-01 · The request limiter refuses every new visitor after about 170 distinct IPs per minute

- **Severity:** P1 · **Status:** confirmed (reproduced)
- **Location:** `apps/server/cloudflare/request-limits.ts:14-27`; callers `apps/server/cloudflare/web-http.ts:169-173, 188-189`; limits `config/web-v1.ts:42-52`
- **Evidence:** `rate()` inserts one row per key into `cf_http_rates` and refuses a *new* key when the table already holds 512 rows:
  ```ts
  ensure(this.#store.get('SELECT count(*) n FROM cf_http_rates')!.n < 512, 'RATE_LIMITED');
  ```
  A visitor who loads the page, plays one welcome clip and sends one message creates three per-IP keys (`web:ip:…`, `web:welcome:…`, `web:write:…`). I drove the real class with exactly the calls `web-http.ts` makes: 170 visitors served, visitor 171 refused, 512 rows. Keys live 60 s from first use.
- **Root cause:** The cap protects storage from unbounded keys but is shared by all key families, and reaching it fails closed for newcomers rather than degrading.
- **Impact:** A trend-driven spike (the 15-character launch, one viral post) locks out exactly the new players the launch is for, with an ordinary 429. It is also a cheap denial of service: 512 requests per minute from distinct IPv4 addresses or IPv6 /64s holds the door shut. Existing visitors keep working, which makes it hard to notice from the inside.
- **Also:** each request runs 2–3 limiter transactions, about 6 SQL statements of which 2–3 are writes, before any work (measured: 6 statements for the two unconditional calls).
- **Plan:**
  ```ts
  // Before: one table, one cap, a new key is refused when full
  ensure(count < 512, 'RATE_LIMITED'); insert(key)

  // After: the global keys never compete with per-IP keys, and a full table sheds the per-IP check instead of the visitor
  if (key.startsWith('web:global') || key === 'web:welcome:global') return counter(key)   // always present
  if (count >= MAX_KEYS) { this.overflow++; return }   // fail open for per-IP only; the global limit still holds
  ```
  Raise the cap to a number derived from `requestsGlobalPerMinute` (6,000/min allows at most 6,000 distinct IPs). Longer term, keep per-IP counters in memory in the object (they are advisory; losing them on eviction is acceptable) and only the global counters durable — that also removes the per-request writes. Report the overflow count on 系统状态 → 安全.
- **Effort:** S · **Risk:** low (limits get looser only for per-IP when full; global cap unchanged). No migration: `cf_http_rates` keeps its shape.
- **Verify:** unit test with 1,000 distinct IP hashes in one minute: none refused before its own limit; the global limit still trips at 6,000. Extend `web-admin-read-limit.integration.test.ts`'s pattern.

### F-02 · The catalog cannot hold more than 15 characters; the launch adds 15 to the existing 3

- **Severity:** P1 (blocks the launch as described) · **Status:** confirmed (traced); impact depends on Open question 1
- **Location:**
  - `apps/server/characters/web-character-publication.ts:275-277` (`CHARACTER_CATALOG_FULL`)
  - `apps/server/characters/web-character-availability.ts:121-123` (重新上线)
  - `apps/server/characters/web-character-catalog.ts:195` (`ensure(rows.length <= 15, 'WEB_PROVIDER_CATALOG_INVALID')`)
  - `apps/server/generation/web-provider-application.ts:399-406` (slots padded to 15)
  - `packages/contracts/web-provider.ts:304, 316-318, 431` (strict parser: `characters.length > 15`, `slots.length !== 15`)
  - `apps/player-web/src/features/prototype/provider-catalog-view.ts:146`; `apps/player-web/src/features/admin/error-sentences.ts:15`
  - `apps/server/characters/web-character-catalog.ts:52-53` — the table itself: `position INTEGER NOT NULL UNIQUE CHECK(position>=0 AND position<15)`, created by the digest-checked runtime step `web_character_schema` version 1
- **Evidence:** positions are searched in `Array.from({ length: 15 })`; the 16th publish throws `CHARACTER_CATALOG_FULL`. The client parser rejects a bootstrap with other than exactly 15 slots. The table's CHECK refuses position 15 and above.
- **Root cause:** "15" is the size of the original card ring and became a data invariant without a single named constant.
- **Impact:** If the three current characters stay online, only 12 of the 15 new ones can be published. If they are taken 下线 first, the catalog is exactly full with no room for a sixteenth, and 重新上线 of any old character fails. Raising the limit is not a one-line change: the table's CHECK must be replaced, server and client must move together, and an old cached client would reject a longer bootstrap outright (the page would fail to start).
- **Plan:**
  ```ts
  // Before: the literal 15 in six files
  // After: packages/contracts/web-provider.ts
  export const CATALOG_MAX = 15;        // step 1: name it everywhere, no behaviour change
  // step 2 (only if the owner wants >15): parser accepts slots.length >= characters.length && <= CATALOG_MAX_NEXT;
  //   ship the tolerant client one deploy BEFORE the server may send more than 15.
  // step 3: a new runtime step (web_character_schema version 4) rebuilds web_character_catalog with the wider CHECK:
  //   create the new table, copy the rows, drop, rename — inside one transaction. Not a numbered migration.
  ```
- **Effort:** S (name the constant) / M–L (raise it: table rebuild step, ring layout for more than 15 cards) · **Risk:** medium–high for the raise — a table rebuild of the live catalog plus client/server ordering; none for naming.
- **Verify:** contract test for 16+ characters; component test of the ring with 18; a workerd test that an authority at `web_character_schema` version 3 gains version 4 with every catalog row intact; a staging publish of a 16th character. The numbered ledger is not touched; the catalog holds admin data, not player data.

### F-03 · Every reservation scans the entire budget history

- **Severity:** P2 now, P1 as history grows · **Status:** confirmed (measured)
- **Location:** `apps/server/cloudflare/web-budget.ts:114-143` (`summary`), `:214-232` (`reserve` calls `summary`); schema `:13-19` (no index, no running total)
- **Evidence:** `reserve()` calls `summary()`, which runs `SELECT SUM(charged_micros), SUM(CASE …held…) FROM cf_web_budget_calls WHERE provider=?` for both providers. `EXPLAIN QUERY PLAN` reports `SCAN cf_web_budget_calls`. Rows are never deleted (correctly: they are the money record). Measured with the real class:

  | Rows in `cf_web_budget_calls` | Rows read per reservation | Time per reservation |
  |---|---|---|
  | 10,000 | 20,000 | 1.5 ms |
  | 100,000 | 200,000 | 18.8 ms |
  | 1,000,000 | 2,000,000 | 193.5 ms |

  A voice reply makes roughly four reservations (draft, review, speech segments).
- **Root cause:** the allowance check derives totals from the full record instead of maintaining them.
- **Impact:** latency and Durable Object rows-read cost per reply grow linearly with all replies ever sent, so total cost grows quadratically. At a million rows each reply reads about 8 M rows and spends most of a second inside the budget object, which is single-threaded for the whole site. The Node twin has the same shape (`apps/server/budget/web-provider-budget.ts:144`), as does `web-system-admin`'s summary polling.
- **Plan:**
  ```sql
  -- Before: totals = SUM over every call, each time
  -- After: one row per provider, updated in the same transaction as the call row
  CREATE TABLE IF NOT EXISTS cf_web_budget_totals(provider TEXT PRIMARY KEY, spent INTEGER NOT NULL, held INTEGER NOT NULL) STRICT;
  -- reserve: held += x      settle: held -= held_x, spent += charged      (UNKNOWN: nothing changes, the hold stays)
  ```
  Create it the way `cf_web_budget_topups` was added (`CREATE TABLE IF NOT EXISTS` at start, outside the hashed schema) and backfill once from the SUM. Keep the SUM as a consistency check run by `inspect` and by the hourly alert, not per call.
- **Effort:** M · **Risk:** medium — this is the money ledger. The UNKNOWN rule is unaffected (an unsettled row simply stays in `held`), but the backfill and the two update sites must be proven equal to the SUM.
- **Verify:** property test: after any random sequence of reserve / settle / duplicate settle / unknown, totals equal the SUM. Existing `web-cloudflare-budget*` tests unchanged. This is the budget object's own schema, not the business migration ledger; `expected-migrations` is untouched.

### F-04 · No automatic brake on daily spend under `production-unlimited`

- **Severity:** P2 · **Status:** suspected — the repository only shows `test-cumulative` in `workers/web-cloudflare/deploy/business.json.example:17`; production's value is not visible to me
- **Location:** `apps/server/cloudflare/web-budget.ts:221-222` (`remainingMicros === null` → never refuses); alerts `apps/server/cloudflare/web-alerts.ts`; `docs/DEPLOYMENT.md:169-178`
- **Evidence:** a `version 2` grant stores `micros = NULL`; `reserve` then only checks integer safety. `ALERT_DAILY_SPEND_MICROS` sends an e-mail, checked hourly, at most one per 6 hours. Nothing reduces spend.
- **Root cause:** the cumulative cap was designed for testing (≤ USD 3 initial grant, top-ups of USD 1–50); production either lives on manual top-ups or has no cap.
- **Impact:** spend is bounded only by player quotas. Those are solid (per-IP lifetime trial, 3 signups per IP per day, 200 e-mails per day), so this is not an open tap — but a bug that loops a stage, or a price change like F-05, runs until the owner reads an e-mail. With about 200 RMB/day as the comfortable level, an hour's delay matters.
- **Plan:** an owner-set daily ceiling enforced by the business object at admission, with a soft step first:
  ```ts
  // After (admission, before any reservation): today's settled+held spend from the existing daily counters
  if (today >= ceiling)      refuse new guest/free replies ('WEB_DAILY_BUDGET_REACHED'), paying players continue
  else if (today >= 0.8 * ceiling) deliver reviewed text without voice (the existing text-fallback path)
  ```
  Reservations and UNKNOWN handling are untouched; this only decides whether to admit.
- **Effort:** M · **Risk:** low–medium (a wrong ceiling refuses players; default off).
- **Verify:** integration test with a tiny ceiling: voice drops to text at 80 %, guests are refused at 100 %, an in-flight operation still settles.

### F-05 · Fish Drama 3 spend is recorded per byte but billed per character; the price rises 5× on 2026-11-13

- **Severity:** P2 · **Status:** confirmed (traced); the comment in the code shows it is deliberate ("never understates")
- **Location:** `apps/server/generation/model-list-prices.ts:28-48`; `workers/audio/metering.ts` (`unit: 'utf8_bytes'`); `docs/DEPLOYMENT.md:219`
- **Evidence:** `speechListMicrosPerByte('drama-3', day)` returns 10 through 2026-11-12 and 50 from 2026-11-13, applied to UTF-8 bytes. Fish bills Drama 3 per character. A Chinese character is 3 bytes.
- **Impact:**
  - 用量 / 成本, the USD 30 alert and (on a capped budget) the allowance all count voice at about **3× the real bill** for Chinese replies. The alert fires early and a capped budget exhausts early (`WEB_SHARED_BUDGET_EXHAUSTED` → replies fall back or fail) while money remains.
  - From 2026-11-13 real voice cost per reply is 5× today's. Recorded voice cost becomes about 15× the real pre-discount figure. Whatever daily level is comfortable now will not be after the 13th; this is two days away from the audit date.
  - `DEPLOYMENT.md:219` says instances with a Drama 3 price row must run `renew-prices` once more before 2026-11-12. I cannot see whether production did.
- **Constraint:** `web_provider_prices.unit` is `CHECK(unit IN ('token','byte','call'))` (`apps/server/web-migrations/113_provider_offline.sql:45`). A `character` unit would need a table rebuild in a numbered migration. Not worth it.
- **Plan:** keep the byte price row as the **reservation** bound and settle what Fish bills.
  ```ts
  // Before: held = bytes × micros/byte          charged = bytes × micros/byte
  // After:  held = bytes × micros/byte (unchanged upper bound)
  //         charged = [...text].length × micros/byte   for drama-3      // characters ≤ bytes, so charged ≤ held always holds
  ```
  No schema change: `charged_micros <= held_micros` is already the ledger's rule. Until then, show "按字节上限估算" beside Fish figures so the 3× is not read as the bill.
- **Effort:** S (label) / M (settle by character) · **Risk:** medium (pinned usage/receipt snapshots change intentionally; the receipt must record both counts).
- **Verify:** `tests/web/unit/fish-drama.test.ts` and the price-renewal tests; compare one day of recorded Fish spend with the Fish invoice.

### F-06 · Unlisted error codes become HTTP 409 and are never logged — the "unexplained 409"

- **Severity:** P2 · **Status:** mechanism confirmed; the cause of the single production incident suspected
- **Location:** `apps/server/platform/web-provider-http-error.ts:12-99` (the final `: 409`); `apps/server/cloudflare/web-http.ts:113-126` (only `>= 500` reaches `onServerError`; nothing is logged below that); save path `apps/server/characters/web-character-admin.ts:427-463`
- **Evidence:** the status ladder ends `publicCode === 'INTERNAL_ERROR' ? 500 : 409`. On the draft `save` route alone, these all answer 409: `DRAFT_CONFLICT`, `LIVE_VERSION_CONFLICT`, `INVALID_DRAFT_VERSION`, `INVALID_DRAFT_REVISION`, `CHARACTER_ID_MISMATCH`, `CHARACTER_DRAFT_LIMIT`, `CHARACTER_DELETED`, and every validation code thrown by `profile()` (`INVALID_ADMIN_REQUEST`, `INVALID_CANON_VALUE`, `CHARACTER_CONTEXT_TOO_LARGE`, …). The profile import adds `PROFILE_IMPORT_CONFLICT`, `PROFILE_IMPORT_INVALID`, `PROFILE_CODE_TAKEN` and `IDEMPOTENCY_CONFLICT`. The workbench only special-cases `DRAFT_CONFLICT` (`character-workbench.ts:467-476`). A log tail shows no line for a 4xx.
- **Root cause:** 409 is the default bucket, so the status carries no information, and the code that would explain it is neither logged nor counted.
- **Impact:** a production-only refusal leaves nothing to diagnose. Locally the status reproduces only if the same code is hit, which nobody could know.
- **What the 409 most likely was** (ranked; none reproduced):
  1. **A validation code, not a conflict.** An imported profile is re-validated by `profile()` when the workbench saves it back; any field the editor changed past a limit answers 409 with a code the page may not have a sentence for.
  2. **`DRAFT_CONFLICT` after a lost response.** `save` replays only when the content hash is identical (`web-character-admin.ts:447-451`). If a save committed but its response was lost — plausible behind Cloudflare Access on a flaky connection, impossible locally — and the admin then changed anything before pressing 保存 again, the stored revision is already N+1 and the request carries N.
  3. **A second writer.** The cast import, a co-creation 加入草稿, another admin or another tab moved the draft; each writes a revision through `writeRevision`.
  4. **`LIVE_VERSION_CONFLICT`** if the character was published or restored between opening and saving.
- **Plan:**
  ```ts
  // Before: catch → map → respond
  // After: one log line and one counter per refusal; a route class and a code only (both are fixed strings, within the logging rule)
  console.log(JSON.stringify({ event: 'web_refusal', route: routeClass(path), status, code: failure.body.error.code }))
  ```
  and make the mapper explicit: a table `code → status`, with unknown codes answering **400** and being counted, so 409 means "state moved" again. Add the missing sentences to `error-sentences.ts` from the same table (see F-16).
- **Effort:** S · **Risk:** low; changing the default status needs the pinned HTTP tests reviewed (tests are not edited to pass: list each code's intended status first, then change the tests intentionally with the table).
- **Verify:** unit test: every `DomainError` code thrown under `apps/server` appears in the table (AST scan, like the dead-export check); staging log tail shows `web_refusal` lines without ids or content.

### F-07 · The save route's body limit is in bytes; the profile's largest field limit is in characters

- **Severity:** P2 · **Status:** confirmed (traced, arithmetic)
- **Location:** `apps/server/characters/template-validation.ts:110` (`JSON.stringify(settings).length <= 48_000`); `apps/server/cloudflare/web-http.ts:240-253` (save body ≤ 131,072 bytes; import ≤ `CAST_BODY_LIMIT` = 1,000,000); `web-http.ts:102-109` (any body failure becomes `INVALID_REQUEST`); same ladder in `apps/server/generation/web-provider-server.ts:482-491`
- **Evidence:** 48,000 Chinese characters are 144,000 UTF-8 bytes. The profile import accepts up to 1 MB, so it can create a draft that the workbench can never save back: the request exceeds 131,072 bytes, `cloudJSON` throws `PAYLOAD_TOO_LARGE`, and `body()` replaces it with `INVALID_REQUEST` (400). The client's own sentence says "上限约 48000 字".
- **Root cause:** two limits in different units, and an error replaced by a generic one.
- **Impact:** a richly written character (the 15 new ones arrive through the Markdown template) saves through import and then fails on the first manual edit with "请求无效". This answers 400, so it is not the 409 of F-06, but it is the same family: imported drafts that cannot be saved.
- **Plan:** derive the body limit from the validators (`maxProfileBytes = 3 × character limits + overhead`, about 262,144) in one shared constant used by both transports, and let `PAYLOAD_TOO_LARGE` through as its own code with status 413.
- **Effort:** S · **Risk:** low.
- **Verify:** unit test: the largest profile `profile()` accepts, serialized, is below the route limit; a browser check that imports a near-limit profile and saves it.

### F-08 · Password hashing runs inside the single business object

- **Severity:** P2 · **Status:** suspected (mechanism traced; one hash measured at 153 ms on this machine, not in workerd)
- **Location:** `apps/server/admin/web-admin-password.ts:4-8` (scrypt N=16384, r=8, p=5); `apps/server/identity/web-player-accounts.ts:112-129` (`KdfGate`: 2 running, 8 waiting, then `RATE_LIMITED`)
- **Evidence:** signup, login and password change call scrypt in the business Durable Object, the one object that serves every player. A Durable Object runs one thread.
- **Impact:** each hash holds the whole site for roughly 0.15–0.3 s of CPU. A signup wave (a launch day) of 100 per minute would keep the object busy for a quarter to a half of every minute; chat polling and admissions queue behind it, and the eleventh concurrent signup is refused.
- **Plan:** move only the KDF to a stateless entrypoint; the object stays the only writer.
  ```ts
  // Before (in the object):   const hash = await hashPassword(password)
  // After:                    const hash = await env.KDF.hash(password)      // WorkerEntrypoint, no bindings, no storage
  //                           store.run('INSERT INTO web_player_logins …', hash)
  ```
  The generation Worker is the wrong home (it holds provider keys); a third entrypoint class in the business Worker script, bound to itself as a service, keeps the deploy at four Workers.
- **Effort:** M · **Risk:** medium (the password crosses one more internal RPC; keep it out of logs and bound the queue as today).
- **Verify:** workerd test: 20 concurrent signups while a chat poll runs; the poll's latency stays flat. Staging smoke of signup and login.

### F-09 · A cold start of the business object does work proportional to all data

- **Severity:** P2 · **Status:** trace confirmed; cost in production suspected
- **Location:** `apps/server/cloudflare/web-store.ts:133-137` (`PRAGMA foreign_key_check` on every construction); runtime steps `apps/server/generation/web-provider-application.ts:214-262` and the feature constructors; `apps/server/characters/web-character-catalog.ts:185-209`
- **Evidence:** each construction runs: the ledger hash comparison (56 rows), `PRAGMA foreign_key_check` (a scan of every table that has a foreign key, with no limit), eleven runtime schema steps each hashing its statements and probing `sqlite_master`, and `publishedWebCharacters` (F-17). Durable Objects are evicted when idle; the alarm then starts a fresh instance.
- **Impact:** the first request after an idle period pays for the whole history of `messages`, `web_operations`, `web_external_attempts` and the rest. Today that is small; it grows with every reply and is billed as rows read.
- **Plan:** run `foreign_key_check` only when a migration or runtime step actually applied something in this start (and on `inspect`); otherwise trust the ledger hashes.
  ```ts
  // Before: always       ensure(!this.get('PRAGMA foreign_key_check'), …)
  // After:  if (appliedSomething) ensure(!this.get('PRAGMA foreign_key_check'), …)
  ```
- **Effort:** S · **Risk:** low–medium: it removes a tripwire. Keep it in `inspect` and run it from the deploy checklist.
- **Verify:** workerd test that an upgrade still runs the check; time a cold start on a database seeded with 1 M message rows before and after.

### F-10 · Three schema mechanisms, and production code that asks the database what year it is

- **Severity:** P2 · **Status:** confirmed
- **Location:**
  1. **Cloud ledger:** `workers/web-cloudflare/migrations.ts` (inline and R2 lists, 56 steps, last 131) applied by `apps/server/cloudflare/web-store.ts:86-113`.
  2. **Node ladder:** `apps/server/platform/store.ts:716-1000` (one hand-written method per step 100→112) and `apps/server/generation/web-provider-migration.ts` (19 near-identical functions for 113→131, 375 lines).
  3. **Runtime digest steps:** eleven installers creating 45 tables (`web_character_*`, `web_admin_*`, previews, review model, review compare, profile import, availability, admin speech, welcome lines, deletion, materials).
- **Evidence:**
  - 136 `sqlite_master` lookups in `apps/server` and `workers`; the helper `const has = (name) => !!store.get("SELECT 1 FROM sqlite_master …")` is defined about a dozen times.
  - 121 `PRAGMA user_version` reads and 44 `schema >= 1xx` branches. On Cloudflare `PRAGMA user_version` is emulated by `SELECT max(version) FROM cf_web_migrations` (`web-store.ts:166-169`), and `WebDispatchLedger.markSent` runs it four times per call (`web-dispatch-ledger.ts:211-240`).
  - Test fixtures build stores frozen at historical versions: `schema122()` … `schema128()` are used 40 times; `memoryStore()` stops at 115.
  - Runtime steps are installed from different places: some in the application constructor, some lazily when a feature object is built (`WebCharacterPreviews`, `WebAdminSpeech`, `installReviewCompare`), so which tables exist depends on which code path ran first. `business.ts:525` and `web-executor.ts:112` probe for `web_character_deletion_schema` because the alarm can run before the application exists.
- **Root cause:** the rule "expected-migrations must stay byte-identical" made numbered migrations expensive, so new tables moved to runtime steps; the Node ladder was kept so tests and the local runtime can build a database; and because tests run at old versions, production code must tolerate missing tables.
- **Impact:** production has exactly one schema (131 + all steps), yet most feature code carries "table may not exist" branches that only tests exercise. Each new table costs: an installer, a digest, probes at every reader, entries in the audits (F-11), and often a Node-ladder function.
- **Is it sustainable?** The runtime-step idea is sound and should become *the* mechanism. What is not sustainable is having it scattered and unordered next to two other mechanisms.
- **Plan (no ledger change at any step):**
  ```ts
  // After: apps/server/platform/runtime-schema.ts — one ordered registry, installed once, before anything else runs
  export const RUNTIME_STEPS = [reviewModel, adminSchema, adminActions, characterCatalog, materials, deletion,
                                previews, profileImport, availability, adminSpeech, welcomeLines, reviewCompare] as const;
  export function installRuntimeSchema(store) { for (const step of RUNTIME_STEPS) step.install(store); }   // same statements, same digests
  // WebDurableStore constructor calls it; feature code may then assume every table exists.
  ```
  Then, in separate Parts: (a) give tests one `latestStore()` fixture built from the same lists, and move the historical fixtures behind the few tests that are *about* upgrades; (b) delete the probes whose table is now guaranteed; (c) replace the 19 Node functions with a loop over the migration files.
- **Effort:** L in total, in S/M Parts · **Risk:** medium — digests must not change. Each Part asserts the eleven stored digests and `expected-migrations` are byte-identical before and after.
- **Verify:** the existing "authority at N gains N+1 untouched" workerd tests; a new test that a production-shaped database started with the registry has the same `sqlite_master` (names and SQL) as one started today.

### F-11 · The purge and deletion table lists are kept by hand in five places

- **Severity:** P2 · **Status:** confirmed
- **Location:** `apps/server/admission/web-lifecycle-audit.ts:23-136` (four sets); `apps/server/characters/web-character-deletion-audit.ts:5-94` (four lists plus exact column lists); `apps/server/admission/web-retention-cleaner.ts`; `apps/server/identity/web-player-purge.ts`; `workers/web-cloudflare/retention.sql`; documentation `docs/DATA_BOUNDARY.md`
- **Evidence:**
  - The audits are schema-driven and fail closed: any table with a `world_id` or `operation_id` column that is not listed stops the purge. That is the right default. The cost is in the history: the comments at `web-lifecycle-audit.ts:128-134` and `:178-179` record two cases (Parts 24h and 22c) where a missing entry meant a player "could never be purged".
  - **Blind spot.** The automatic sweep looks only at `world_id` and `operation_id`. In the built schema, 16 tables key a player by `principal_id` alone: `web_accounts`, `web_cocreation_submissions`, `web_email_challenges`, `web_entitlement_redemptions`, `web_entitlement_refills`, `web_entitlements`, `web_invite_redemptions`, `web_player_logins`, `web_player_model`, `web_player_numbers`, `web_points_balance`, `web_points_policy`, `web_review_codes`, `web_review_notice`, `web_sessions`, `web_signup_bonus`. Most are covered by purpose-built checks (`playerLoginsRemain`, `cocreationRemains`), but a *new* principal-keyed table would not be noticed by anything.
  - **Documentation drift.** 26 of 234 tables do not appear in `DATA_BOUNDARY.md`, including `web_welcome_choices` (player data), `web_entitlements*`, `web_player_numbers`, the review-compare and review-model tables and the profile-import tables.
  - `web_sessions` and `web_principals` rows are never deleted (sessions are revoked, principals stay as shells). That is documented as intended, but it is unbounded growth with no stated retention decision (Open question 6).
- **Root cause:** ownership of a table is knowledge spread over five files and a document.
- **Plan:** one registry that the audits, the cleaners' assertions and the document are generated from.
  ```ts
  // After: apps/server/platform/data-classes.ts
  export const TABLES = {
    web_welcome_choices: { owner: 'world',     onPlayerPurge: 'delete', onCharacterDelete: 'delete' },
    web_points_events:   { owner: 'principal', onPlayerPurge: 'delete', onCharacterDelete: 'keep'   },
    web_operation_models:{ owner: 'operation', onPlayerPurge: 'shell',  onCharacterDelete: 'keep'   },
    …
  } satisfies Record<string, TableClass>;
  // test: every table in the built schema (ledger + runtime steps) has an entry; DATA_BOUNDARY.md's table section is generated.
  ```
  The existing sets become derived views of it, so behaviour does not change in the first Part.
- **Effort:** M · **Risk:** low if the first Part only derives the existing sets and asserts equality with the old literals.
- **Verify:** the test named "every table with a world_id or operation_id that holds this guest's rows is a known purge table" stays; add "every table is classified" and "every `principal`-owned table is empty after a purge".

### F-12 · Three HTTP transports kept in step by hand

- **Severity:** P2 · **Status:** confirmed
- **Location:** `apps/server/cloudflare/web-http.ts` (470 lines, production); `apps/server/generation/web-provider-server.ts` (671 lines, Node `provider-local`); `apps/server/platform/web-local-server.ts` (784 lines, `synthetic-local`)
- **Evidence:** the route regexes, the body-size ladder (`8_001_024` / `CAST_BODY_LIMIT` / `786_432` / `131072` / `COCREATION_BODY_LIMIT` / `8192`) and the stream limits are copied between the first two (`web-http.ts:220-253` and `web-provider-server.ts:459-491` are textually the same); the third carries its own error map (`web-local-server.ts:746`). All browser checks start `WebProviderServer`; production serves `WebProviderHTTP`. The workerd transport is covered by Miniflare integration tests, not by a browser.
- **Impact:** every new admin route with a larger body means editing a regex in two files; a route that works in every browser check can still be wrong in production. Body limits are opt-in by regex, so a new route silently gets 8,192 bytes.
- **Plan:**
  ```ts
  // After: packages/contracts/web-routes.ts — one table both transports read
  export const ROUTES = [
    { match: /^\/admin\/characters\/[\w-]{1,128}\/save$/, auth: 'admin-write', bodyMax: PROFILE_BODY_MAX },
    { match: /^\/admin\/profile-import\/(preview|apply)$/, auth: 'admin-write', bodyMax: CAST_BODY_LIMIT },
    …
  ];
  ```
  Then run at least the smoke part of the browser suite against Miniflare, and retire the synthetic transport (section 3, R-12).
- **Effort:** M · **Risk:** low (table extracted from the existing code; a test asserts both transports resolve every route identically).
- **Verify:** a table-driven test over every path in the client API modules; one browser check on workerd.

### F-13 · Invisible and direction-changing characters are accepted in chat and co-creation text

- **Severity:** P2 · **Status:** confirmed
- **Location:** `apps/server/admission/web-admission.ts:137-141`; `packages/contracts/cocreation-cards.ts:80-84`; contrast `apps/server/identity/web-player-accounts.ts:139-140` (nicknames *do* refuse bidi overrides)
- **Evidence:** both validators refuse only U+0000–001F and U+007F. Zero-width characters (U+200B–200F, U+FEFF), bidi overrides and isolates (U+202A–202E, U+2066–2069), C1 controls, line/paragraph separators and Unicode tag characters (U+E0000–E007F) pass.
- **Impact — where it reaches other players:** a co-creation note is shown to an admin in the inbox and can be adopted into a draft, which becomes `authorCanon` for every player. With invisible characters, the admin adopts text they cannot see, placed in the most trusted part of the prompt. Bidi overrides can also make a pseudonymous review transcript read differently from what was sent.
- **What is already sound:** all untrusted content is embedded as JSON in one user message (`accepted-text-prompt.ts:267-336`), so there is no structural injection; the reply passes a separate review stage; no tool or action is driven by model output; a player's memories are scoped to that player's world. Player-to-self injection only spoils the player's own chat.
- **Plan:** one validator in `packages/contracts`, used by chat input, co-creation, the profile import and the cast import:
  ```ts
  // After
  const HIDDEN = /[\p{Cc}  ‪-‮⁦-⁩​‌‎‏﻿\u{e0000}-\u{e007f}]/u;  // U+200D (ZWJ) stays: emoji need it
  export const visibleTextOk = (v, max) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= max && !HIDDEN.test(v);
  ```
  In the inbox, render any remaining format character as a visible mark before 加入草稿.
- **Effort:** S · **Risk:** low; a few players' messages with stray zero-width characters will be refused — strip instead of refusing for chat input if that is a concern.
- **Verify:** unit tests per code point; existing rows are untouched (no data change).

### F-14 · Test and check runtimes; why the browser checks flake

- **Severity:** P2 · **Status:** confirmed (timings measured; flake cause read, not reproduced)
- **Location:** `package.json` (`"test": "node --test --test-concurrency=1 …"`); `.github/workflows/check.yml` (`timeout-minutes: 30`); `scripts/check-web-*.ts`
- **Evidence:**
  - `pnpm test`: 22 min 38 s here, serial, 279 test files. CI allows 30 minutes for install + check + build. A few more integration files and CI times out for a reason unrelated to the change under review.
  - The slow tests are real-time waits by design, for example "a real 32-second provider await renews the 30-second coordinator" (37.7 s), "workerd restart during sent speech…" (33.3 s), SIGKILL recovery (31.6 s), and about 25 workerd tests of 10–25 s each.
  - The browser suite is 17 scripts, only 6 of which have a `package.json` entry, and none run in CI. They contain **123 `waitForTimeout` calls** (32 in `check-web-browser.ts`), and the motion checks sample `requestAnimationFrame` against `performance.now()` for 1.1 s (`check-web-browser.ts:448-470`).
- **Root cause of the flakes Part 27 lists:** fixed sleeps and wall-clock animation sampling on a loaded machine. A sleep is both too long (the suite's 10–20 minutes) and sometimes too short (the flake). The 26b strict-mode failure is the usual consequence of a locator such as `.models-review .ic` matching a second element while a transition leaves the old one in the DOM.
- **Plan:**
  1. Split `pnpm test` into `test:unit` (parallel, default concurrency) and `test:workerd` (serial or 2-way), run as two CI jobs. Unit tests on in-memory stores have no shared state that needs `--test-concurrency=1`; confirm by running them in parallel once.
  2. In the browser scripts: install Playwright's clock (`page.clock.install()` / `runFor`) for timing checks, emulate `reducedMotion: 'reduce'` everywhere motion is not the subject (the console already multiplies durations by `--ad-motion`), and replace each sleep with a condition (`locator.waitFor`, `expect.poll`, `element.getAnimations()` finished).
  3. One runner script and one `package.json` entry (`check:web:all`) so every script is reachable and its time is printed.
- **Effort:** M · **Risk:** low. The tests' assertions do not change; only how they wait.
- **Verify:** 20 consecutive green runs of the three named flaky checks under `stress-ng` or `nice`; CI wall time below 12 minutes.

### F-15 · Player site: one 442 KB stylesheet, mostly admin rules; blurred shapes on every card

- **Severity:** P2 (payload, confirmed) / suspected (rendering on phones)
- **Location:** `apps/player-web/src/styles/main.css` (17,545 lines); `apps/player-web/player-assets.json`; `scripts/build-web-player.ts:147-172` (copies CSS unminified); `.pk-shape` at `main.css:17393-17405`; `apps/player-web/src/features/brand/palette-skin.ts:178-233`; `main.css:15922` (`bb-breathe … infinite`)
- **Evidence (built output):**

  | Asset | Raw | gzip -9 |
  |---|---|---|
  | `static-….css` (everything) | 441,882 B | 74,046 B |
  | `main-….js` (player) | 140,620 B | 43,047 B |
  | `admin-mode-….js` (lazy) | 461,786 B | 142,731 B |

  JavaScript is split, so players do not download the console code. CSS is not: the render-blocking stylesheet is larger than the player's JavaScript, and by its section comments roughly lines 3,700–14,300 are console rules (not measured rule by rule).
  Each card gets up to 5 `.pk-shape` elements with `filter: blur(18–36px)`, percentage sizes larger than the card, and `will-change: transform`. With 15 cards that is up to 75 blurred compositor layers. The active card animates for ever.
- **Impact:** slower first paint on mobile data; on mid-range phones, large blurred layers are the usual cause of dropped frames and memory pressure when swiping the ring. I could not measure this.
- **Plan:**
  ```css
  /* Before */ .pk-shape { background: radial-gradient(closest-side, var(--c-d), transparent); filter: blur(var(--blur)); will-change: transform; }
  /* After  */ .pk-shape { background: radial-gradient(closest-side, var(--c-d) 0%, transparent 100%); }   /* a soft gradient is already a blur */
  ```
  Render shapes only for the active card and its two neighbours. Split the stylesheet at build time into `player.css` and `admin.css` (the admin chunk imports its own), and minify with the esbuild that is already a dependency.
- **Effort:** S (shapes) / M (CSS split) · **Risk:** the split touches the file the admin-redesign session is editing — coordinate (roadmap Part 12). The pinned "player-only CSS" tests need their spans restated intentionally.
- **Verify:** Chrome DevTools Layers and Performance panels on a throttled mid-range profile before and after; the 24k-2 palette browser check's screenshots.

### F-16 · Duplicated logic: error sentences, strict parsers, profile upgrades

- **Severity:** P3 · **Status:** confirmed
- **Location:** `apps/player-web/src/features/admin/error-sentences.ts` (142 codes) vs `apps/server/platform/web-provider-http-error.ts` vs `packages/contracts/web-cast-text.ts`; strict parsers in `apps/player-web/src/services/*-api.ts` (571 + 530 + 518 + 464 + 228 lines) vs `packages/contracts/web-provider.ts:250-498`; `upgradedProfile` called from 9 sites in `apps/server/characters/*`
- **Evidence:** the server decides a code's status in one file, the client decides its sentence in another, and nothing checks that a code thrown by the server has either. Each admin API module hand-writes a parser for the response shape the server hand-writes. Stored profiles are upgraded on every read and never rewritten, so the upgrade runs for ever (and `cast-upgrade.ts` does the same for cast documents).
- **Plan:** a single `packages/contracts/errors.ts` table `{ code: { status, sentence } }` read by both sides (with F-06). For parsers, define each response once in `packages/contracts` as a small validator and import it on both sides; do not adopt a schema library just for this. For profile upgrades, rewrite on the next save (already the behaviour) and add an operator-run, idempotent "upgrade stored profiles" step so the read-time upgrade can eventually be deleted — this changes stored admin data, not player data, and needs no numbered migration.
- **Effort:** M · **Risk:** low.
- **Verify:** AST test: every thrown code is in the table; contract tests shared by client and server.

### F-17 · The catalog is re-parsed and re-hashed on hot paths

- **Severity:** P2 · **Status:** trace confirmed; cost estimated, not measured
- **Location:** `apps/server/characters/web-character-catalog.ts:185-209` (`publishedWebCharacters`); callers on player paths: `web-admission.ts:121` → `requirePublishedWebCharacter` (every send), `web-provider-application.ts:586` (every bootstrap), `web-welcome-choice.ts:132, 151`, `web-provider-offline.ts:1702, 1832`
- **Evidence:** each call selects every catalog row with its full `profile_json` and `config_json`, then per character runs `JSON.parse` twice, a canonical SHA-256 of the profile, `JSON.stringify` of both templates for comparison, and `upgradeProfile`. A profile can approach 130 KB. Bootstrap then runs a welcome-choice transaction and two more queries per character.
- **Impact:** with 15 full characters, every message admission and every page load does on the order of a megabyte of JSON work synchronously in the business object, to answer "is this id published".
- **Plan:** cache the verified catalog in the object, keyed by a cheap version read:
  ```ts
  // After
  const stamp = store.get("SELECT group_concat(character_id||':'||version||':'||position) s FROM web_character_catalog").s;
  if (stamp !== this.cached?.stamp) this.cached = { stamp, entries: verifyAndParse() };
  ```
  The integrity check still runs whenever the catalog changes and on every cold start.
- **Effort:** S · **Risk:** low (a stale cache is impossible while the object is the only writer and the stamp is read inside the same transaction).
- **Verify:** unit test counting `JSON.parse` calls across 100 admissions; publication and 下线 tests unchanged.

### F-18 · `/events` (SSE) and `/sync` are served but no client calls them; replies are polled without a bound

- **Severity:** P3 · **Status:** confirmed
- **Location:** server `apps/server/cloudflare/web-http.ts:359-362, 411-469` (and twins in the other two transports); client `apps/player-web/src/services/provider-api.ts:410-419` (`waitForOperation`), `:441-449` (`sync`, `eventUrl` — no caller anywhere in `apps/player-web/src` or `scripts`)
- **Evidence:** the player waits for a reply by `GET /operations/:id` every 500 ms for the first 20 polls, then every 1.5 s, in a loop with no maximum and no backoff on errors. The SSE stream (32 concurrent at most, a 1-second `setInterval` per stream) is unused. The dead-export check does not see this because `sync` and `eventUrl` are class methods, not exports.
- **Impact:** about 20–40 requests per reply, each paying the limiter's writes (F-01); three copies of stream code to maintain; and if `/events` were ever switched on, the 33rd concurrent player would be refused.
- **Plan:** keep polling (it is simple and works behind every proxy) but give it a schedule and a stop: 500 ms × 6, then 1 s, then 2 s, stopping at `deadlineAt` from the operation. Remove `/events` and `/sync` and the two client methods. Keep the `web_local_events` table and its writes for now: the bootstrap cursor reads its sequence, and it holds player data (section 3, R-15).
- **Effort:** S · **Risk:** low.
- **Verify:** component test of the poll schedule with a fake clock; route test that `/events` answers 404.

### F-19 · Welcome audio is uncompressed, uncacheable and globally limited to 300 plays a minute

- **Severity:** P2 · **Status:** constants confirmed; effect at launch suspected
- **Location:** `apps/server/cloudflare/web-http.ts:186-194`; `config/web-v1.ts:48-49`; `workers/web-cloudflare/edge.ts:23-28, 124-126` (every API response is forced to `no-store`); `web-welcome-schema.ts` (`byte_length <= 6000000`)
- **Evidence:** a welcome clip is `audio/wav`, read from R2 through the edge and the business object on every play, with `cache-control: no-store`. Limits: 60 per IP per minute, **300 per minute for the whole site**. Clips are content-addressed (`mediaId`, `sha256`) and public by design.
- **Impact:** the home page's main interaction is tapping a card's voice. With 15 characters, 100 visitors tapping three cards in a minute reach the global cap, after which clips fail for everyone. Every play occupies the single business object for an R2 read and a multi-hundred-kilobyte copy (`Uint8Array.from(bytes)`).
- **Plan:** let the edge cache what is already immutable and public.
  ```ts
  // After (edge, public-audio only): the response is keyed by media id; a 下线/delete changes what bootstrap offers, and a short TTL bounds staleness
  if (publicAudio && response.status === 200) response.headers.set('cache-control', 'public, max-age=300, immutable')
  ```
  plus the Workers Cache API at the edge so repeat plays never reach the object. The servability check (`welcomeClipServable`, deletion) then runs at most once per five minutes per clip — an owner decision, since a deleted character's clip could play for up to five more minutes (Open question 5). Separately, store or transcode clips as a compressed format; WAV at 24 kHz is about 48 KB per second.
- **Effort:** S (cache) / M (format) · **Risk:** low–medium.
- **Verify:** workerd test: second request for the same clip does not reach the object; a deleted character's clip returns 404 after the TTL.

### F-20 · iOS-era and synthetic-runtime branches inside production paths

- **Severity:** P3 · **Status:** confirmed
- **Location:** `apps/server/generation/accepted-text-prompt.ts:84, 134-160, 273-276, 346-365` (`group`, `moment`, `moment_post`, `proactiveTopic`); `prompts/v7/moment-post-task.md`; `apps/server/budget/web-dispatch-ledger.ts:143-171, 217-260` (`web_synthetic_voice_segments` for schema < 113); `apps/server/platform/store.ts:330-560` (beta mode, migrations 025–033, recovery point)
- **Evidence:** the web product creates only `private` conversations, yet the prompt builder keeps group/moment branches and `MOMENT_POST_TASK` is part of `textPromptHash`. The dispatch ledger chooses between provider and synthetic tables by schema version on every call. `new Store(path, { beta: true })` has no caller outside four tests that assert it throws.
- **Impact:** reading cost for every Part that touches these files; no runtime risk.
- **Plan and constraint:** the beta mode and the synthetic branches can be removed with no hash or ledger effect. The moment/group prompt pieces are **inside the pinned prompt hash**: removing `moment-post-task.md` changes `textPromptHash` for every reply. Do it only together with the next intentional prompt change, never as cleanup on its own (section 5).
- **Effort:** M · **Risk:** low for the non-prompt parts.
- **Verify:** `pnpm prompts:check` unchanged for the non-prompt Parts; pinned-hash tests updated intentionally in the prompt Part.

### F-21 · The dead-export check is useful but has three blind spots, and its allow-list is becoming a parking lot

- **Severity:** P3 · **Status:** confirmed
- **Location:** `scripts/check-dead-exports.ts`; `config/dead-exports-allowlist.json` (21 entries); `docs/DEAD_CODE_INVENTORY.md`
- **Evidence:**
  - Class methods are not checked: `ProviderApi.sync`, `ProviderApi.eventUrl`, `WebIdentity.register` (only the synthetic server calls it), `CloudRequestLimits.feedbackUpload` (no caller found).
  - Any script file counts as a caller, so a symbol used only by a browser-check script looks alive.
  - Ten allow-list entries have the reason "a test pins it" for code the product no longer uses (`codesCsv`, `splitPane`, `removeCharacter`, `conicGradient`, `adoptIntoTemplate`, `suggestAdoptDraft`) or "next product step" (`memory-review.ts` ×4, `selectProactiveTopic`, `renderSharedCard`). The inventory document's own rule is "a symbol that only a test calls is dead code with a test attached: delete both".
  - `DEAD_CODE_INVENTORY.md` lists 8 scripts as entry points; there are 35 files in `scripts/`.
- **Plan:** add unused-method detection for classes (TypeScript's `noUnusedLocals` does not cover public methods; a small AST pass over `MethodDeclaration` names with zero property-access references is enough), treat `scripts/check-*` and `scripts/console-*` as tests, and give each "future" allow-list entry an expiry Part after which the check fails.
- **Effort:** S · **Risk:** none at runtime.
- **Verify:** the check reports the four methods above before they are removed.

### F-22 · The admin console's plain-DOM code is at the size where a small shared layer pays for itself

- **Severity:** P3 · **Status:** confirmed (sizes); judgement
- **Location:** `apps/player-web/src/features/admin/character-workbench.ts` (1,999 lines), `preview/preview-workbench.ts` (1,498), `account-admin-page.ts` (1,172), `cocreation-inbox.ts` (996); `features/admin/ui/` (25 small components)
- **Evidence:** the workbench is one closure with roughly 20 mutable variables (`busy`, `dirty`, `snapshot`, `pending`, …), manual `controls.push({ node, locked })` re-evaluation, and repeated `if (gone()) return` after each await. The `ui/` folder shows the direction is already understood. Tests use a hand-written fake DOM (`installFakeDom`), which every new browser API must be added to.
- **Assessment:** not broken, and a framework rewrite is not justified (section 5). What costs review time is state: each feature re-implements "busy / dirty / stale snapshot / pending request".
- **Plan:** since a redesign is in progress, give it three shared pieces rather than a framework: a tiny `store(initial)` with `subscribe`, an `asyncAction(run)` that owns busy/pending/`gone()`, and one `guarded(control, predicate)` helper. Split the workbench by tab into files that receive the store. No behaviour change.
- **Effort:** M–L · **Risk:** collides with the redesign session unless it is done *by* that session.
- **Verify:** existing component tests; file-size budget (for example 600 lines) enforced by a check.

### F-23 · `docs/STATUS.md` is 181 KB in 608 lines and every Part edits it

- **Severity:** P3 · **Status:** confirmed
- **Evidence:** 55 sections, lines up to 3,405 characters, not in chronological order (Part 17 precedes 16, 13b, 12, 11f). It is on the "read first" list, so each Claude Code session spends tens of thousands of tokens on history, and two parallel sessions (Parts and the admin redesign) both append to it.
- **Plan:** `docs/STATUS.md` becomes a one-page current state (what is live, the flags and their production values, the open problems). Each Part writes `docs/parts/NN-name.md` once and never edits it again. Move the existing sections verbatim, one file per section, in a Part that changes nothing else. A 20-line `docs/INVARIANTS.md` holds the decided rules so they are read every time.
- **Effort:** S · **Risk:** none. · **Verify:** link check; total bytes preserved.

### F-24 · Deploy and operator procedure depend on a person-run sequence

- **Severity:** P3 · **Status:** confirmed from `docs/DEPLOYMENT.md`; not exercised
- **Evidence:** four Workers in a fixed order, twice (staging, production); `renew-prices` "每次部署检查清单都运行一次" (`DEPLOYMENT.md:358`), which needs the operator window: deploy with `OPERATOR_ENABLED=true`, run, deploy again with `false` (`:310-314`). Price rows are valid for 90 days (`web-provider-configuration.ts:37`); a missing row fails replies at reservation with `WEB_PROVIDER_PRICE_REQUIRED`. `installMissingDeepSeekPrices` already self-heals DeepSeek at start; the other providers do not.
- **Impact:** two extra production deploys per release, and a 90-day timer that stops voice if nobody deploys. The alert code already computes the earliest expiry (`web-alerts.ts:152-160`).
- **Plan:** (a) let the business object renew due price rows itself at start and from the alarm, using the same function the operator runs — it only adds rows from constants in the code, which is what a deploy does anyway; (b) put the deploy order, read-backs and smoke tests in one script with a `--dry-run` that prints the plan, so the agent runs one command and the log is the record; (c) keep the operator window for `initialize` and admin grants only.
- **Effort:** M · **Risk:** low–medium (prices are money: the self-renewal must be the same code path with the same tests).
- **Verify:** workerd test: an authority with a price row 1 day from expiry renews on the alarm; deploy dry-run on staging.

### F-25 · Smaller items

| ID | Item | Location | Sev | Status |
|---|---|---|---|---|
| a | HSTS is sent without `includeSubDomains`. The player site, cover page and admin share the zone. | `workers/web-cloudflare/edge.ts:27` | P3 | confirmed |
| b | `WebDurableStore.run()` issues a second statement (`SELECT changes(), last_insert_rowid()`) after every write and `all()` rebuilds every row through `Object.entries`/`fromEntries` with per-value checks. Fine per call; it is the base cost of every query. | `apps/server/cloudflare/web-store.ts:163-205` | P3 | confirmed |
| c | Admin speech audio (预演 试听, generated 成品) is the one audio kept as SQLite BLOBs (≤ 1.9 MB a row, under the 2 MB row limit). A longer clip is paid for and then rejected as `SPEECH_AUDIO_INVALID`. Rows go only with a 预演 purge or a character deletion. | `apps/server/characters/web-admin-speech.ts:28, 343`; `web-admin-speech-schema.ts:31-33` | P3 | confirmed (traced) |
| d | The four skipped tests are superseded 24b-1/24b-4 console tests kept as `skip`. | `apps/player-web/tests/components/console-24b1.test.ts`, `console-24b4.test.ts` | P3 | confirmed |
| e | `workers/cloudflare/migrations.ts` imports migrations 025–033 into the Worker bundle although only `slice(0, 24)` is used. | `workers/cloudflare/migrations.ts:26-34`; `workers/web-cloudflare/migrations.ts:55` | P3 | confirmed |
| f | Type strictness is high (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); 89 casts in product code, 75 of them `as unknown as` at the Worker/env boundary (`env as unknown as Record<string, unknown>` six times in `business.ts`). The Playwright scripts use `any` 51 times because Playwright's types are not a dependency. | `workers/web-cloudflare/business.ts:162-215` | P3 | confirmed |
| g | The player's login reveals whether an e-mail is registered. The comment records this as an owner decision (Part 21i) with attempts charged first; not flagged as a defect. | `apps/server/identity/web-player-accounts.ts:810-828` | — | noted |

### Checked and found sound

These were read specifically because the brief asked, and I have nothing to report against them:

- **Edge:** strips `x-internal-*`, `x-forwarded-*`, `forwarded`, `x-real-ip`, `authorization`, `cf-*` and `x-fixture-*` before setting the peer header; rejects encoded paths and unknown query strings; only static GETs may be cached.
- **Origin / CSRF:** Origin equality, `sec-fetch-site` allow-list with one documented exception (`/admin/enter`, a fixed redirect), CSRF token and Origin required on every write, `__Host-` cookies with `HttpOnly; Secure; SameSite=Lax`, the write re-authorized inside the transaction.
- **Scoping:** private audio is looked up by principal + player + world + conversation and the session is re-checked after the asynchronous R2 read (`web-http.ts:374-408`). Cursors are HMAC-bound to instance, epoch, principal and conversation.
- **Operator path:** no HTTP route; a service-binding RPC plus an HMAC proof under a key only the business Worker holds.
- **Per-IP keys:** IPv6 is keyed by /64, IPv4-mapped addresses are normalized.
- **Shared budget:** reserve refuses a known id (`WEB_SHARED_ATTEMPT_UNRESOLVED`), settle is idempotent on (amount, receipt hash) and conflicts otherwise, nothing releases an unsettled hold.
- **Secrets:** provider keys exist only in the generation Worker; the business object reads booleans about them. `safeError` restricts what a log line can carry.
- **Admin routes:** all sit under `/admin/`, which is what the Access application path covers; the application does not depend on Access for authorization (it has its own session, CSRF and permission checks).

---

## 3. Removal list

**Method.** For tables: every table name in the built schema was searched as a whole word in all non-test `.ts` under `apps/`, `packages/`, `workers/`, `scripts/` and `config/`. "No reference" means not even a purge or audit mentions it. **Data present in production is unknown to me.** Before any table is dropped, add row counts (counts only) for the listed tables to the read-only `inspect` RPC and read them on production; this is roadmap Part 4.

**Ledger rule.** Removing code never changes the migration ledger. Dropping a table from an existing authority **requires a new numbered migration** (132: 57 steps, both the inline and the R2 list, new `expected-migrations` output). Editing migrations 001–024 is impossible: their hashes are checked at every start.

### 3.1 Tables

| # | Item | Verdict | Proof | What removal needs |
|---|---|---|---|---|
| R-1 | **40 iOS-era tables with no reference in code:** `admin_voice_previews`, `api_devices`, `autonomy_days`, `character_drafts`, `character_publications`, `conversation_reads`, `dialogue_deliveries`, `external_source_versions`, `external_sources`, `group_creation_receipts`, `group_job_reads`, `group_message_knowledge`, `group_message_routes`, `message_feedback`, `moment_audience_group_members`, `moment_audience_group_receipts`, `moment_audience_groups`, `moment_post_days`, `moment_post_drafts`, `moment_post_setting_requests`, `moment_post_settings`, `moment_requests`, `pairing_invites`, `player_characters`, `playtest_media_cleanup`, `playtest_reset_usage`, `playtest_resets`, `relationship_test_versions`, `response_fallbacks`, `retired_proactive_usage`, `retired_sync_cursors`, `source_fetch_attempts`, `source_post_versions`, `source_posts`, `source_summaries`, `speech_retry_receipts`, `text_attempts`, `text_retry_state`, `voice_profiles`, `world_setup_receipts` | **Remove, later, in one step** | No writer and no reader. The web authority was created empty ("Never adopts the old beta DO", `migrations.ts:53`), so they should hold zero rows. | Migration 132 `DROP TABLE` in dependency order, **after** `inspect` shows zero rows in each. Explicit owner decision (rule: no player data dropped without one). Until then they cost nothing at runtime except `foreign_key_check` and audit iterations. |
| R-2 | **7 iOS-era tables referenced only by purge/audit code:** `group_conversations`, `moment_threads`, `proactive_intents`, `speech_tasks`, `reply_items`, `scene_end_requests`, `player_profile_requests` | **Remove with R-1** (first two pairs: groups, moments, proactive, speech); **keep** `reply_items`, `scene_end_requests`, `player_profile_requests` until checked | Only `web-retention-cleaner.ts` / the audits name them; no writer. `player_profile_requests` and `scene_end_requests` sit next to live tables (`player_profile_versions`, `scene_states`). | Same migration; delete the matching cleaner lines and audit entries in the same Part. |
| R-3 | `proactive_topics` | **Remove with R-1** | Only writer is `selectProactiveTopic` (`memory.ts:413-447`), which is allow-listed dead code. | With R-5. |
| R-4 | **`beta_*` tables (migrations 025–033)** | **Not in production — nothing to drop** | `webMigrations = base.slice(0, 24) + 100…131` (`workers/web-cloudflare/migrations.ts:55`); `WebDurableStore` requires exactly versions 1–24 and 100–131 (`web-store.ts:11`). | None. See R-9 for the code. |
| R-5 | **Web-era tables nobody reads:** `web_identity_receipts` (103), `web_invite_credentials`, `web_invite_credential_receipts`, `web_invite_identity_receipts` (112), `web_invite_redemptions` (111) | **Keep until a retention decision, then drop in 132** | Their code was removed in Part 22x; `web-player-purge.ts` still deletes a player's rows. They **may hold real player data** from before 22x (sealed receipts, code digests). | Owner decision first (Open question 3). They are covered by the player purge, so waiting is safe. |
| R-6 | `web_stage_attempts` (101), `web_synthetic_voice_segments` (105), `web_local_text_outputs`, `web_local_audio_outputs` (109) | **Keep the tables; remove the code branches** (R-12) | `web_stage_attempts` has no writer. The others are written only on the below-113 branches (`store.ts:856`, `web-dispatch-ledger.ts:458`, `web-local-output.ts`). In production they should be empty but are named in the purge lists. `web_reviewed_candidates` looked similar but has two writers in `web-stage-queue.ts:710, 826` that I did not trace to a schema branch — treat it as live. | Drop in 132 if `inspect` shows zero rows. |
| R-7 | `web_accounts` | **Keep** (table), remove writer with R-12 | Read by `web-identity.ts:227` for sessions with an `account_id`, and by `web-v7-request.ts:263`; the only writer is `WebIdentity.register`, called only by the synthetic server. `web_sessions.account_id` references it. | Needs a table rebuild to drop the FK; not worth a migration. |
| R-8 | `web_principals.kind` CHECK still lists `invite` | **Keep** | Documented in `DEAD_CODE_INVENTORY.md`; a CHECK cannot change without rebuilding a live, central table. | — |

### 3.2 Code

| # | Item | Verdict | Proof | What removal needs |
|---|---|---|---|---|
| R-9 | **Beta mode of `Store`** — `beta` / `betaExternalCalls` options, `schemaAllowed(…, beta)`, migrations 025–033 and their files, `config/beta-release.json`, `recovery.ts` / `recovery-protocol.ts` / `recoveryPoint`, the 025–033 imports in `workers/cloudflare/migrations.ts` | **Remove** | No non-test code passes `beta: true`; four tests only assert that doing so throws. `betaExternalCalls` is `false` in both stores. | Code only. `workers/cloudflare/migrations.ts` must keep entries 1–24 exactly; removing 25–33 does not change any hash that `expected-migrations` prints (verify by diffing its output). Rewrite the four tests' intent ("a web database is never opened as anything else") against what remains. |
| R-10 | **Node migration ladder** — `store.ts` `migrateStages` … (100→112) and the 19 functions in `web-provider-migration.ts` | **Replace** | They exist so Node can build a database; each is the same guard-exec-bump with a different file name. | One loop over the migration files plus the same SQL-text loader the operator uses. Keep the two or three guards that encode real upgrade safety as tests. No ledger change. |
| R-11 | **Historical-schema fixtures** `schema122()`…`schema128()`, `memoryStore()` at 115 and the `sqlite_master` probes they require | **Replace** | 40 uses in tests; production is always at 131 + steps. | One `latestStore()` fixture; keep version-specific fixtures only in tests about upgrades. Then delete probes (F-10). Tests change because their fixture changes — state that in the PR; no assertion is weakened. |
| R-12 | **Synthetic local runtime** — `platform/web-local-server.ts`, `web-local-executor.ts`, `web-local-fake.ts`, `web-local-output.ts`, `web-local-static.ts`, `scripts/web-v1.ts`, `packages/contracts/web-v1.ts`, `WebIdentity.register`, the `synthetic` mode of the audits, and the `schema < 113` branches | **Remove, in two steps** | The browser modes were removed in Part 22x and the edge only accepts `mode=provider` / `provider-admin`; no client speaks the `web-v1` contract. Callers: 5 e2e tests, 1 load test, `scripts/test-web-local-http.ts`, `scripts/test-web-data-lifecycle-restart.ts`, 3 unit/integration tests. | Step 1: port what those tests uniquely prove (admission ordering under load, SIGKILL recovery, the 109→110 lifecycle preflight) to the provider runtime or to workerd, or record that the workerd tests already cover it. Step 2: delete. No ledger change — the 100–112 SQL files stay (they are in the ledger). About 2,000 lines of product code and their tests. |
| R-13 | **`WebProviderServer` (Node provider transport)** | **Keep for now; shrink** | All browser checks and `scripts/web-provider.ts` run on it. | After F-12's shared route table it is a thin adapter. Retire it only when the browser suite runs on Miniflare. |
| R-14 | **`cast import-legacy`** — `apps/server/cast/cast-import.ts` (400 lines), `WebCastAdmin.importLegacy`, the client button (`cast-view.ts:829`), `CastCharacter.unmapped` | **Keep until the 15 new characters are in, then remove** | Still wired end to end; it converts what published characters carry in `authorCanon.settings` into a cast draft. New characters arrive through the Markdown template, not this path. | Code only. Remove after confirming the stored cast draft has an empty `unmapped` for every character (a count in `inspect`). Old audit rows with action `cast-import-legacy` stay. |
| R-15 | **Cast per-character fields kept for lossless round-trips** — `speech`, `experiences`, `performance`, `hidden`, self-concept, prototype (in the document, never compiled: `cast-compile.ts:22`), and the schema-1 reader `cast-upgrade.ts` / `isLegacyCastDoc` | **Keep the fields; replace the reader** | The fields are authored content (not player data) that the profile now also carries; deleting them loses admin work unless it is confirmed duplicated. The schema-1 reader runs on every read of an old document. | Rewrite stored schema-1 documents once (operator-run, idempotent), then delete `cast-upgrade.ts`. Decide the fields' fate when cast is switched on (Open question 4) — while `CAST_CONTEXT_ENABLED=false` nothing reads them at reply time. |
| R-16 | **`/events` SSE and `/sync`**, `ProviderApi.sync`, `ProviderApi.eventUrl` | **Remove** | No caller (F-18). | Code only. Keep `web_local_events`, `web_user_events` and their triggers: bootstrap reads the sequence and they are player data in the purge lists. |
| R-17 | **Group / moment / proactive branches of the v7 prompt**, `prompts/v7/moment-post-task.md` | **Keep until the next intentional prompt change** | Unreachable (only `private` conversations exist), but inside `textPromptHash` (`accepted-text-prompt.ts:78-90`). | Changes pinned hashes — do it only as part of a deliberate prompt revision. |
| R-18 | **Old prompt or policy versions** | **Nothing to remove** | `prompts/` contains only `v7`; `experimental-v10` went in Part 2b. `textProtocol: 'accepted-v7'` stays in the serialized policy because the approval hash covers it. | — |
| R-19 | `CloudRequestLimits.feedbackUpload` | **Remove** | No caller found in non-test code; a leftover of the beta feedback upload. | Code only. |
| R-20 | **Skipped tests** (4, "superseded") | **Remove** | Skipped with a note naming their replacement. | Delete; nothing is weakened. |

### 3.3 Allow-list entries (`config/dead-exports-allowlist.json`)

| Entry | Verdict | Reason |
|---|---|---|
| Four Worker entrypoints (`edge`, `business`, `budget`, `generation`) | **Keep** | Bound by name in the deployment. |
| `memory-review.ts`: `correctMemory`, `listCorrections`, `listMemoryTopics`, `readMemoryDetail` | **Keep with an expiry**, or remove | "Next product step" since Part 22x. If player memory controls are not in the next few Parts, delete with their tests; git keeps them. |
| `memory.ts`: `selectProactiveTopic` | **Remove** | Proactive messages are not in the web product; its only effect is writing `proactive_topics` (R-3). |
| `shared-card.ts`: `renderSharedCard` | **Keep with an expiry** | A page with no route and no data: there is no share endpoint on the server. Half-built by design; decide in Open question 7. |
| `resetChatGuide`, `resetCocreationDrafts`, `grantPoints`, `memoryAlertState`, `OfflineEmbeddings`, `fixtureVector`, `isPreSend`, `verifyVoiceMaterialEvidence`, `syntheticProviderBootstrap` | **Keep** | Real test seams. Move them into `*.testing.ts` files so the list shrinks to a path rule. |
| `preflightWebDataPolicy` | **Remove with R-12** | The standalone twin of the 109→110 preflight. |
| `codesCsv`, `splitPane`, `conicGradient`, `removeCharacter` | **Remove, with their tests** | Product no longer uses them; the stated reason is that a test pins them. That is the inventory's own definition of dead code. `splitPane`: ask the redesign session first. |
| `adoptIntoTemplate`, `suggestAdoptDraft` | **Remove, with their tests** | Replaced by `cocreation-draft-box.ts`; kept "as the reference". |

### 3.4 Scripts and other paths

| Item | Verdict | Reason |
|---|---|---|
| `scripts/web-v1.ts`, `scripts/test-web-local-http.ts`, `scripts/test-web-data-lifecycle-restart.ts`; `package.json` scripts `web:local`, `check:web:local-http`, `check:web:restart` | **Remove with R-12** | Synthetic runtime only. |
| `scripts/console-24b6b-checks.ts`, `console-24b6c-checks.ts`, `console-fixture-24b6.ts`, the 17 `check-web-*-browser.ts` | **Keep; consolidate** | One runner, shared fixture, named by area rather than by Part (F-14). |
| The **operator window** | **Keep; narrow** | Needed for `initialize`, admin login/recovery grants, `inspect`, `status`. Take `renew-prices` out of it (F-24) so a routine deploy needs no window. |
| `workers/apex-site`, `workers/audio` | **Keep** | Live (cover page; Fish adapter, WAV handling, metering). |
| `config/budget-authority.json.example`, `selected-voice-pins.json.example` | **Keep** | Operator inputs. |
| `examples/` | Not reviewed | — |

---

## 4. Incremental upgrade roadmap

Part 27 (small UI fixes and the named flakes) is already planned and is not repeated here. Numbers below are a suggested order, not Part numbers.

**Deploy batches.** *Batch A*: Worker code only, no schema of any kind. *Batch B*: adds runtime-created tables or changes the budget object's own tables — still no change to the numbered ledger. *Batch C*: changes the numbered migration ledger; needs its own deploy and an explicit owner decision. *None*: repository only (tests, docs, scripts).

**"Parallel"** says whether the Part can run at the same time as the admin-redesign session without touching the same files.

**No Part below changes the numbered migration ledger except Part 28, which says so.** Part 15 (if wanted) rebuilds one runtime-step table and says so. Every Part ends with `pnpm check` green and `expected-migrations` diffed against `main`.

### Quick wins

| # | Part | Goal and scope | Depends on | Risk | Batch | Parallel |
|---|---|---|---|---|---|---|
| 1 | **Limiter capacity** (F-01) | Global keys exempt from the cap; per-IP fails open when full; cap derived from the global limit; overflow counter on 系统状态. `request-limits.ts`, `web-http.ts`, one test. | — | Low | A | Yes |
| 2 | **Refusals are visible** (F-06, F-07) | `web_refusal` log line (route class + code); explicit code→status table, unknown → 400; `PAYLOAD_TOO_LARGE` → 413; profile body limit derived from the validators in one shared constant. | — | Low; pinned HTTP status tests change intentionally | A | Yes (adds sentences to `error-sentences.ts` — tell the redesign session) |
| 3 | **Name the catalog size** (F-02 step 1) | `CATALOG_MAX` in `packages/contracts`, used by all six sites. No behaviour change. | — | None | A | Yes |
| 4 | **`inspect` row counts** | Counts only, for the R-1/R-2/R-5/R-6 tables, `cf_web_budget_calls`, `web_sessions`, `web_principals`, and cast `unmapped`. Read-only. | — | None | A | Yes |
| 5 | **Catalog cache** (F-17) | Stamp-keyed cache of the verified catalog in the business object. | — | Low | A | Yes |
| 6 | **Visible-text validator** (F-13) | One validator for chat, co-creation, profile and cast import; inbox shows remaining format characters. | — | Low | A | Mostly (one inbox render line) |
| 7 | **Welcome audio caching** (F-19, cache part) | Edge cache for `public-audio` with a short TTL; limiter counts only cache misses. | Open question 5 | Low–medium | A | Yes |
| 8 | **Player reply polling and dead endpoints** (F-18, R-16, R-19, R-20) | Bounded poll schedule; remove `/events`, `/sync`, two client methods, `feedbackUpload`, four skipped tests. | — | Low | A | Yes |
| 9 | **Blur-free shapes** (F-15, shapes part) | Gradient-only `.pk-shape`, shapes for the active card and neighbours only. | — | Low; screenshot baselines change | A | No — `main.css`; schedule between redesign merges |

### Capacity and money

| # | Part | Goal and scope | Depends on | Risk | Batch | Parallel |
|---|---|---|---|---|---|---|
| 10 | **Budget running totals** (F-03) | `cf_web_budget_totals`, backfilled once; `summary()` reads it; the SUM moves to `inspect` and the hourly check. Same for the Node twin. | 4 (to know the row count) | Medium — money ledger; property test required | B (budget object's own table; deploy budget Worker first, as today) | Yes |
| 11 | **Daily spend ceiling** (F-04) | Owner-set ceiling at admission: text-only at 80 %, guests refused at 100 %. Default off. Setting stored like the model settings. | Open question 2 | Medium | B if the setting needs a runtime table, else A | Console page needed — hand the UI to the redesign session |
| 12 | **Player/admin CSS split and minify** (F-15) | Build emits `player.css` and `admin.css`; esbuild minifies. | 9 | Medium — collides with the redesign | A | **No** — do it inside the redesign session or at a quiet point |
| 13 | **KDF out of the business object** (F-08) | A bindingless entrypoint for scrypt; the object keeps all writes. | — | Medium | A (one more entrypoint in the business script) | Yes |
| 14 | **Fish settled per character** (F-05) | Label Fish figures as an upper bound now; then settle Drama 3 by characters while still reserving by bytes. No price-table change. | Open question 2 | Medium; pinned usage snapshots change intentionally | A | Yes |
| 15 | **Raise the catalog** (F-02 steps 2–3) | Only if wanted: tolerant client first; then a runtime step that **rebuilds `web_character_catalog`** with a wider CHECK, and the server limit; ring layout for more than 15. | 3, 17, Open question 1 | Medium–high — live table rebuild (admin data), two deploys, client before server | A, then B | No — player UI plus workbench sentence |

### Structure

| # | Part | Goal and scope | Depends on | Risk | Batch | Parallel |
|---|---|---|---|---|---|---|
| 16 | **Test split and browser runner** (F-14) | `test:unit` parallel, `test:workerd` separate CI job; one `check:web:all` runner; clock and reduced-motion in the scripts; sleeps replaced by conditions, file by file. Can be several PRs. | Part 27 | Low | None | Yes |
| 17 | **Runtime schema registry** (F-10 step 1) | One ordered `installRuntimeSchema`, same statements and digests, called from the store constructor. | — | Medium — digests must be byte-identical; test compares `sqlite_master` | A (no new tables; verify on staging that every `*_schema` row is unchanged) | Yes |
| 18 | **Table registry** (F-11) | `data-classes.ts`; the audits' sets derived from it and asserted equal to today's literals; "every table is classified" test; `DATA_BOUNDARY.md` table section generated. | 17 | Low | A | Yes |
| 19 | **Route table** (F-12) | `ROUTES` in `packages/contracts`, read by both transports. | 2 | Low | A | Yes |
| 20 | **Status and Part notes** (F-23) | Split `STATUS.md` into `docs/parts/*`; one-page status; `INVARIANTS.md`. | — | None | None | Yes — and it removes a shared conflict file |
| 21 | **Dead-export check v2** (F-21) | Unused public methods; browser scripts count as tests; expiry on "future" entries; delete the six pinned-by-test helpers. | 8 | None | None | Ask before deleting `splitPane` |

### Leftover removal

| # | Part | Goal and scope | Depends on | Risk | Batch | Parallel |
|---|---|---|---|---|---|---|
| 22 | **Remove beta mode** (R-9) | `Store` beta options, 025–033 files and imports, recovery point, `beta-release.json`. Diff `expected-migrations`. | — | Low | A (bundle shrinks; behaviour identical) | Yes |
| 23 | **`latestStore()` fixture** (R-11) | New fixture; migrate tests to it in batches; keep versioned fixtures only for upgrade tests. | 17 | Low; many test files touched, no assertion changed | None | Yes |
| 24 | **Node ladder as a loop** (R-10) | Replace the per-step functions. | 23 | Low | None | Yes |
| 25 | **Retire the synthetic runtime** (R-12) | Step 1: list what its tests uniquely prove and port or map each. Step 2: delete server, scripts, contract, `register`, synthetic audit mode. | 23, 24 | Medium — coverage must be shown, not assumed | A | Yes |
| 26 | **Delete guaranteed-table probes and old-schema branches** (F-10, F-20) | After 17, 23 and 25: remove `sqlite_master` probes and `schema >= 1xx` branches whose answer is now fixed. Several small PRs by area. | 17, 23, 25 | Low–medium | A | Yes |
| 27 | **Self-renewing prices; deploy script** (F-24) | Alarm renews due price rows with the operator's function; one deploy script with dry-run. | — | Low–medium | A | Yes |
| 28 | **Drop legacy tables — CHANGES THE MIGRATION LEDGER** (R-1, R-2, R-3, and R-5/R-6 if decided) | Migration **132** (`DROP TABLE` in dependency order) added to both lists; `expected-migrations` becomes 57 steps, last 132. **Why:** it is the only way to remove tables from an existing authority; it shrinks every audit loop and the start-up foreign-key scan. **Preconditions:** Part 4 shows zero rows on production for every table dropped; owner approval per group; a storage snapshot before the deploy. The migration should assert emptiness itself (`SELECT CASE WHEN EXISTS(…) THEN RAISE…`) so it cannot drop data. | 4, 22, 25, 26; Open question 3 | Medium — irreversible | **C**, alone | Yes |
| 29 | **Prompt cleanup with the next prompt revision** (R-17) | Remove group/moment/proactive prompt branches and `moment-post-task.md` in the same PR as a wanted prompt change. **Changes pinned prompt hashes intentionally.** | An intended prompt change | Medium | A | Yes |
| 30 | **Cast legacy** (R-14, R-15) | Rewrite stored schema-1 cast documents; remove `import-legacy` and `cast-upgrade.ts`. | New characters imported; Open question 4 | Low | A | No — cast view button |

### Suggested first three deploys

1. **Before the launch:** Parts 1, 2, 3, 4, 5 (Batch A). Smallest changes with the largest effect on launch day, plus the visibility to diagnose the next refusal.
2. **Launch week:** Parts 6, 7, 8, 13, and 10 once Part 4 has reported the budget row count.
3. **After the launch:** 11, 14, then structure (16–21) while the redesign session continues.

---

## 5. Do not do

| Tempting change | Why not |
|---|---|
| **Rewrite the admin console in a framework.** | The redesign is already under way in plain DOM, the tests rest on a hand-made fake DOM, and the bundle is lazy-loaded. A framework would mean rewriting 60+ component test files and adding a build dependency for a desktop-only tool. The three shared helpers in F-22 remove most of the repeated state code. |
| **Squash migrations 001–131 into one baseline.** | The production authority verifies the hash of every applied step at each start. A new baseline cannot be adopted by an existing database without a second mechanism to "bless" it — more machinery, not less. Leave the files; stop executing them one by one in tests (R-10). |
| **Shard the business object per player.** | It would solve F-08, F-17 and most single-thread concerns at once, and it would also end "the business object is the only writer of state", which is a decided rule and what makes the ledger and the audits tractable. The measured hot spots have local fixes. Revisit only with evidence of sustained saturation after Parts 1, 5, 10 and 13. |
| **Move the database to D1 or Postgres.** | Same reason, plus a data migration of player content. Nothing found here is caused by the storage engine. |
| **Convert runtime schema steps back into numbered migrations.** | Each would change `expected-migrations` for no behavioural gain. The steps work; they need one ordered home (F-10), not a different mechanism. |
| **Drop the legacy tables now, as cleanup.** | Irreversible, changes the ledger, and I cannot see production row counts. Removing the code first is free and gets most of the benefit. |
| **Remove the moment/group prompt branches as dead code.** | They are inside the pinned prompt hash; the change would silently be a prompt change for every reply. Tie it to an intended prompt revision (Part 29). |
| **Release the hold of long-stale UNKNOWN calls to recover budget.** | Decided rule. The right answer to budget pressure from UNKNOWNs is a top-up and the count on the status page, which exist. |
| **Replace polling with the existing SSE stream.** | The stream is capped at 32 clients, keeps a timer per client in the single object, and has three copies. Bounded polling is simpler and sufficient at this scale. |
| **Adopt a schema/validation library (zod, valibot) for the contracts.** | The hand-written parsers are strict and tested; the problem is that they are written twice, not how. Share the existing functions first (F-16). |
| **Verify the Cloudflare Access JWT inside the application.** | The edge deliberately strips `cf-*` headers, and the application has its own admin session, CSRF and permission checks. Adding JWT verification would couple the app to Access configuration and to `jose` at runtime for a second factor that already exists at the network layer. |
| **Make the login error generic again.** | Part 21i records it as an owner decision with attempt limits charged first. |
| **Run the full browser suite in CI today.** | With 123 fixed sleeps it would add 20+ minutes and intermittent red builds. Fix the waiting first (Part 16), then add a short smoke subset. |
| **Chase the 409 by guessing.** | Four plausible causes, none reproducible. Part 2 makes the next occurrence name itself in one log line. |

---

## 6. Open questions for the owner

1. **Do the three current characters stay online when the 15 new ones launch?** If yes, the catalog must hold 18 and Part 15 is required before the launch (two deploys, client first, and a rebuild of the catalog table). If they go 下线 first, 15 fit exactly with no spare slot.
2. **What is production's `BUDGET_POLICY`, and has `renew-prices` been run for the Drama 3 price that takes effect on 2026-11-13?** If the policy is `production-unlimited`, do you want an automatic daily ceiling (Part 11), and at what level given voice costs 5× more from the 13th?
3. **May the pre-22x identity tables be emptied and dropped** (`web_identity_receipts`, `web_invite_credentials`, `web_invite_credential_receipts`, `web_invite_identity_receipts`, `web_invite_redemptions`)? They may hold sealed receipts and code digests of early players. This is a retention decision, not a technical one.
4. **Is cast going to be switched on?** If `CAST_CONTEXT_ENABLED` stays `false` for the foreseeable future, the per-character cast fields and their importers are maintenance without a reader; if it will be turned on with the new characters, R-14/R-15 wait until after that.
5. **Is a five-minute cache on welcome clips acceptable**, knowing a clip of a character taken 下线 or deleted could still play for up to five minutes from a cache?
6. **How long should identity shells live?** `web_principals` and `web_sessions` rows (ids, token digests, timestamps; no content) are never deleted, including for guests who opened the page once. A rule such as "delete shells 400 days after the last session expired" needs your decision because it touches the per-IP trial accounting that the shells support.
7. **Is the shared voice 小卡 link going to be built?** The page exists (`shared-card.ts`), the server has no share route. Either schedule it or remove the page and its allow-list entry.
8. **May the browser checks be renamed by area instead of by Part** (`check-web-console-24b6-browser.ts` → `checks/console/overview.ts`), and may superseded Part-named tests be deleted rather than skipped? This is where most of the suite's runtime and reading cost can be recovered, and it changes test files' names and layout, not their assertions.
