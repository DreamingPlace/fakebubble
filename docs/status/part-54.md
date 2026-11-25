# Part 54 — P0: replies hang, then the pipeline stays wedged

Branch `part-54`. No migration 132 (expected-migrations unchanged: 56 inline + 56 R2, last 131). The new tables are a digest-checked
runtime step (`installWebUnknownCalls`, STOP `WEB_UNKNOWN_CALLS_SCHEMA_MISMATCH`). No prompt or policy hash changed (a test pins it).

## Step 1 — the causes, with evidence

Everything below runs the REAL edge + business Durable Object + budget + generation Workers in workerd (tests/web/fixtures/topology-54.ts);
only the provider network is fake. workerd does NOT enforce Cloudflare's per-invocation limit of 6 simultaneous outbound connections, so
the business object is built with a labelled MODEL of it (cloudflare-business-54-worker.ts): 6 connections per invocation (an alarm, a
request, a dispatched stage), further attempts queue, a connection that cannot progress is cancelled after `CONNECTION_HUNG_MS`.
Cause 2 is therefore reproduced against a model of the documented limit, not against Cloudflare itself.

| # | Cause | Evidence |
|---|---|---|
| 1 | Callback cycle. `text()` took `meter`/`accept` functions; per stage generation called back reserve → start → finish → accept → close (≈8 round trips per reply), each of them a business → budget RPC inside the callback. | Code: web-generators.ts `meterCallbacks`, generation.ts `text`, runner `meter`. |
| 2 | 6-connection limit. The alarm ran up to 20 text + 4 voice stages inside ONE invocation (`waitUntil`). Every open generation session holds a connection; its callback needs another one (the budget RPC). With ≥6 sessions open every callback queues behind the sessions that wait for it: a deadlock that only the 90 s runtime cancel ends — exactly `rpc open | exception | wall 90 000 ms | cpu 2–3 ms`, with the business Worker logging nothing. | Test (a) on the old code: burst of 50 → 17 published, 32 failed, 1 UNKNOWN, 115 connections cancelled as hung (the observed 50–63 % failure). Without the model the same burst publishes 50/50, so workerd alone does not show it. |
| 3 | Input/output gates, storage transactions across an await. | Not a cause: every ledger transaction is synchronous SQLite and the provider/RPC awaits are outside them (checked in runner/ledger). No change needed. |
| 4 | THE WEDGE: an UNKNOWN call kept its running-slot ticket (`web_external_budgets.reserved`) for ever. Capacity is 20 draft / 20 review / 4 voice, so every call killed at the timeout removed one slot permanently; after 20 the claim fails at any volume (22/22, 26/26, 35/35 failures per hour). Also an `unknown` REPLY kept its player's active slot until its 300 s deadline, so each of that player's next messages died in the queue (60 s). | Test (b) on the old code: 21 stuck drafts → `reserved=20/20`, then 5/5 fresh replies fail within 5 s. Same-player run: the next two messages failed (93 s, 155 s). |

## Step 2 — the new flow

business (one transaction holds draft + review: local holds and tickets) → shared budget `beginAttempt` per stage → one transaction marks
them sent → **ONE call** `GENERATION.runText(job)` (plain data: request, policy hash, known draft, one model per stage, the limits it may
spend, per-call timeout) → **ONE result**: per stage `not_sent` | `started` (+ wire hash, observation or none, accepted output) → business
settles each stage: known (usage), not sent (settled at zero and removed), or UNKNOWN (held, never retried, ticket freed, reply ends now).
Voice is its own call (`runSpeech`), reserved in its own transaction because its request exists only after the review.

* Round trips: a reply is 1 call for text + 1 per voice clip; no session is opened (test pins `opens === 0`); nothing sent is a function.
* A model proven not billed is retried as a NEW call with a NEW reservation (a second round); a normal reply makes one.
* Per provider call timeout inside generation (35 s text, 50 s voice, Worker vars), unhashed; the business side waits at most 2×35+10 s.
* The whole RPC failing after it may have sent: every stage without a result is UNKNOWN and held. The pending wire hash is stored on
  the attempt (the review's request does not exist before the draft returns); the real hash is kept in the receipt.
* Each running stage gets its own invocation: the alarm only calls `startStage` on the object itself (the existing `BUSINESS` binding,
  no deploy change); the call returns at once and the stage runs in that invocation. A stage whose dispatch fails or is not started in
  5 s runs where it was scheduled — never lost.
* Self-healing: UNKNOWN frees its ticket (money stays held); legacy UNKNOWN tickets are freed once per pass; legacy `unknown` replies are
  ended; the stage lease (90 s / 120 s), coordinator lease and the alarm watchdog are unchanged and every RPC has a deadline.
* Part 43: only an attempt that never crossed the send gate is re-queued (unchanged). Stages generation reports as not started are
  released; an ambiguous RPC failure is NEVER re-queued.
* Limits (honest): voice is reserved per clip, not up front; `supportsRunText` cannot detect an old generation Worker (deploy generation first).

## Step 3 — capacity

Measured (compressed load run, see PR): every stage in its own invocation, peak 1 connection per invocation, 24 provider calls in flight at
once. Proposed Worker vars (global tickets stay 128 = text + audio + waiting):

| var | now | proposed | why |
|---|---|---|---|
| `MAX_TEXT_RUNNING` | 20 | 30 | a reply holds a slot for ~7 s (draft+review); 30 ≈ 4 replies/s, the 50-in-10 s burst is absorbed. DeepSeek allows hundreds of concurrent requests; xAI/Gemini limits depend on the account tier (check before enabling choice for many players). |
| `MAX_AUDIO_RUNNING` | 4 | 4 on the Fish starter plan (5 concurrent) | one below the plan limit; **9 if the plan is raised to 10 concurrent** — the real bound on voice. 4 slots ≈ 0.7 clips/s ≈ 44/min. |
| `MAX_WAITING_OPERATIONS` | 104 | 89 (30+4+89 = 123, ≤128) or 94 with 30/4 | tickets: 128 total. |
| `AUDIO_FALLBACK_WAIT_MS` | 8000 | 8000 | with 4 slots a burst of 50 cannot all be voiced: the rest become text, as designed. Raising it only delays them. |
| `TEXT_CALL_TIMEOUT_MS` / `SPEECH_CALL_TIMEOUT_MS` | – | 35000 / 50000 | see above |

Cloudflare bounds: per-invocation 6 connections (designed around: one stage per invocation); the single business Durable Object is single-threaded,
a reply costs ~20 short SQLite transactions, which is far below its throughput at these rates.

## Step 4 — UNKNOWN calls

* A call killed at 90 s: its attempt is `unknown`, its hold stays in `web_provider_spending.held_micros` and in the shared budget; it is
  never retried. Before this part it also kept a running slot and its reply kept the player's slot; now only the money is held.
* The ~52-day-old 3 provider + 6 external UNKNOWN calls: the same state (held, not retried, no receipt). The 6 external rows include the
  dispatch-ledger twins of the provider calls; they stay held until the owner settles them. Their tickets are freed by the first pass.
* 「未确认的调用」 (系统状态): code `U-XXXXX-XXXXX` (one-way hash), provider, model, stage, held amount, age, error code (`NOT_RECORDED`
  for calls older than this part). Owner-only 「已按账单核对」 settles one call at the held amount or a lower amount from the bill, shared
  budget settled at the same amount; never automatic. Embedding unknowns are counted, not settled there.
* Failure-rate alert and daily report count `web_operations` rows (one per reply); an UNKNOWN reply is now terminal `failed`, so it is
  counted once, and a re-queued retry is the same row.

## Results

* Real-time load run (`LOAD54_SCALE=1`, 300 replies from 60 players in 15 minutes, burst of 50 in 10 s, draft/review 2–5 s, voice 3–8 s, every 20th call 15 s, 6-connection model on): **300/300 published, 0 hung, 0 connections cancelled, p50 17.0 s, p95 28.1 s** (all replies ask for voice, bound 40 s); 262 published with voice, **38 published as text** (no voice slot within 8 s, as designed). 562 calls to generation (300 text + 262 voice), 0 sessions opened, at most 24 provider calls in flight (20 text + 4 voice), at most 1 connection in any one invocation.
* Throughput bound: voice. 4 voice slots at ~5.5 s per clip ≈ 0.7 clips/s; text (20–30 slots, ~7 s per reply) is ≈ 3–4 replies/s. Raising voice means raising the Fish plan's concurrency first.
* Wedge test: one draft never returns, then 50 replies → 50/50 published; the stuck one ends failed with its attempt UNKNOWN and its money held, within the call limit; no slot left taken.
* `pnpm check`: 2449 tests, 0 failed. `web:player:build` ok. `check:web:all`: 41/44; the 3 failures (part-46, share-45, wave-49) cannot start because WebKit is not installed in this container (`Executable doesn't exist .../webkit-2359`), not because of this change. expected-migrations unchanged (last step 131, sha256 a6f581dd…0990a).
* Named test exceptions: every test that asserted the old UNKNOWN behaviour (reply 'unknown' until its deadline, ticket kept) is marked `Part 54 NAMED EXCEPTION`; fixtures gained the single-call entries.
