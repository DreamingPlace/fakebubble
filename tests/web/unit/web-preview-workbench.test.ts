import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../apps/server/platform/store.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import { configureWebProvider } from '../../../apps/server/generation/web-provider-configuration.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { WebCharacterDeletion } from '../../../apps/server/characters/web-character-deletion.ts';
import { installWebCharacterDeletion } from '../../../apps/server/characters/web-character-deletion-schema.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import {
  WebCharacterPreviews,
  parseSimulatedTime,
  previewInstant,
  previewPolicy,
} from '../../../apps/server/characters/web-character-preview.ts';
import {
  PREVIEW_REJECTED_MAX_BYTES,
  WebCharacterPreviewRunner,
  type WebPreviewBudget,
} from '../../../apps/server/characters/web-character-preview-runner.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { textPolicyHash } from '../../../apps/server/generation/text-generation-policy.ts';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { instantAtLocalMinute, localTime } from '../../../packages/domain/schedule.ts';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { acceptedAuditEnvelope, draftEnvelope, toolEnvelope } from '../../text-fixtures.ts';

const ORIGIN = 'https://fixture.invalid';
type Mode = 'normal' | 'unknown' | 'invalid-topics' | 'huge-topics';

/** Schema 113 as the other preview tests build it, plus the real 119 SQL (the migration chain itself has its own tests). */
function fixture(t: test.TestContext) {
  let now = 1_800_000_000_000;
  const clock = { now: () => now },
    raw = new Store(':memory:');
  t.after(() => raw.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    raw.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  raw.db.exec('PRAGMA user_version=112');
  raw.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'preview-instance')");
  migrateWebProviderOffline(raw);
  raw.db.exec(readFileSync(new URL('119_preview_workbench.sql', folder), 'utf8'));
  const store = Object.assign(raw, {
    webReceiptDigest: (kind: string, json: string) =>
      createHash('sha256')
        .update(kind + ':fixture:' + json)
        .digest('hex'),
  }) as unknown as WebRuntimeStore;
  const selected = syntheticSelection();
  for (const item of selected)
    raw.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      item.characterId,
      item.personaVersion,
      JSON.stringify(item.template),
    );
  configureWebProvider(store, selected, now);
  const accounts = new WebAccountAdmin(raw, clock, ORIGIN);
  installWebCharacterCatalog(raw);
  installWebCharacterDeletion(store);
  const chars = new WebCharacterAdmin(raw, clock, accounts),
    previews = new WebCharacterPreviews(raw, clock);
  chars.enablePreviews(previews);
  chars.enableDeletion(new WebCharacterDeletion(store, clock));
  const login = accounts.login(accounts.issueLoginGrant().token, ORIGIN);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  const profile = chars.detail(auth, 'wei-guagua').published!.profile;
  profile.template.version++;
  profile.template.persona += '修改后的角色';
  const saved = chars.save(auth, 'wei-guagua', { expectedRevision: null, profile });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-workbench-'))),
    path = join(root, 'budget.sqlite');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  WebProviderBudget.initialize(
    path,
    ['deepseek', 'fish'].map((provider) => ({
      source: 'offline-history',
      provider: provider as 'deepseek' | 'fish',
      digest: 'a'.repeat(64),
      spentMicros: 0,
      heldMicros: 0,
    })),
  );
  const budget = new WebProviderBudget(path, clock);
  t.after(() => budget.close());
  const calls: string[] = [];
  let mode: Mode = 'normal';
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      const name = JSON.parse(String(init!.body)).tools[0].function.name;
      calls.push(name);
      if (mode === 'unknown') throw new Error('offline network interrupted');
      const row = raw.get<{ request_json: string }>(
        "SELECT request_json FROM admin_previews WHERE status='generating'",
      )!;
      const request = JSON.parse(row.request_json);
      if (name === 'submit_dialogue_draft') return Response.json(draftEnvelope(request));
      const audit = JSON.parse(acceptedAuditEnvelope(request).choices[0]!.message.tool_calls[0]!.function.arguments);
      // Part 16 (named exception): invalid topics alone no longer fail a review (they are dropped), so these modes also
      // break the coverage, which still fails the stage; the raw output still carries the bad topics.
      if (mode === 'invalid-topics')
        return Response.json(toolEnvelope('submit_dialogue_audit', { ...audit, coverage: {}, topics: [1, 2, 3, 4] }));
      if (mode === 'huge-topics')
        return Response.json(
          toolEnvelope('submit_dialogue_audit', {
            ...audit,
            coverage: {},
            topics: [1, 2, 3, 4],
            padding: '长'.repeat(40_000),
          }),
        );
      return Response.json(acceptedAuditEnvelope(request));
    },
  });
  const runner = (authority: WebPreviewBudget = budget) =>
    new WebCharacterPreviewRunner(raw, clock, generator, authority);
  const base = {
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    relationship: 'friend',
  };
  const signal = new AbortController().signal;
  /** Runs everything queued, one claim at a time, like the executor. */
  const drain = async (r = runner()) => {
    for (let claim = r.claim(); claim; claim = r.claim()) await r.run(claim, signal);
  };
  const member = (permissions: string[]) => {
    const grant = accounts.issueMember(auth.cookie, auth.csrf, ORIGIN, {
      requestId: 'member-' + createHash('sha256').update(permissions.join()).digest('hex').slice(0, 16),
      label: 'Member',
      memberId: null,
      permissions,
    });
    const session = accounts.login(grant.token, ORIGIN);
    return { cookie: session.cookie, csrf: session.csrf, origin: ORIGIN };
  };
  return {
    store: raw,
    chars,
    previews,
    auth,
    profile,
    saved,
    base,
    budget,
    calls,
    runner,
    drain,
    member,
    clock,
    tick: (ms: number) => {
      now += ms;
    },
    mode: (m: Mode) => {
      mode = m;
    },
    now: () => now,
    zone: profile.template.schedule.timeZone,
  };
}
const lines = (...texts: string[]) => texts.map((text) => ({ text }));
const runBody = (f: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) => ({
  requestId: 'run-one',
  ...f.base,
  inputs: lines('今天好吗', '晚上吃什么', '早点睡'),
  ...over,
});

test('a batch submission is ONE run: all rows land together, the run is idempotent by requestId and a different body conflicts', (t) => {
  const f = fixture(t);
  const body = runBody(f, { label: '改人设前' });
  const first = f.chars.startRun(f.auth, 'wei-guagua', body);
  assert.equal(first.replayed, false);
  const again = f.chars.startRun(f.auth, 'wei-guagua', body);
  assert.deepEqual(again, { runId: first.runId, replayed: true });
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_preview_runs')!.n, 1);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM admin_previews')!.n,
    3,
    'a replay queues nothing new',
  );
  assert.throws(
    () => f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { inputs: lines('不同的输入') })),
    /IDEMPOTENCY_CONFLICT/,
  );
  const detail = f.chars.runDetail(f.auth, 'wei-guagua', first.runId);
  assert.equal(detail.run.label, '改人设前');
  assert.equal(detail.run.draftRevision, f.saved.revision);
  assert.equal(detail.run.profileHash, f.saved.contentHash);
  assert.equal(detail.run.relationship, 'friend');
  assert.equal(detail.run.itemCount, 3);
  assert.deepEqual(
    detail.previews.map((p) => [p.ordinal, p.input, p.status, p.settlement]),
    [
      [1, '今天好吗', 'queued', null],
      [2, '晚上吃什么', 'queued', null],
      [3, '早点睡', 'queued', null],
    ],
  );
  // Each preview belongs to at most one run.
  assert.throws(() =>
    f.store.run(
      'INSERT INTO web_preview_run_items(run_id,ordinal,preview_id) VALUES (?,?,?)',
      first.runId,
      9,
      detail.previews[0]!.previewId,
    ),
  );
  assert.throws(() => f.store.run('UPDATE web_preview_runs SET label=? WHERE id=?', 'x', first.runId), /IMMUTABLE/);
  // A single preview has no run and appears in the singles list.
  const single = f.chars.startPreview(f.auth, 'wei-guagua', { ...f.base, requestId: 'single', message: '单条' });
  const list = f.chars.runList(f.auth, 'wei-guagua');
  assert.deepEqual(
    list.singles.map((p) => [p.previewId, p.runId]),
    [[single.previewId, null]],
  );
  assert.deepEqual(
    list.runs.map((r) => [r.runId, r.counts.queued]),
    [[first.runId, 3]],
  );
  // Bounds: 1..50 inputs, text and note lengths, exactly one of inputs / evalSetId.
  assert.throws(
    () => f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { requestId: 'r0', inputs: [] })),
    /INVALID_RUN_INPUTS/,
  );
  assert.throws(
    () =>
      f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { requestId: 'r51', inputs: lines(...Array(51).fill('x')) })),
    /INVALID_RUN_INPUTS/,
  );
  assert.throws(
    () =>
      f.chars.startRun(
        f.auth,
        'wei-guagua',
        runBody(f, { requestId: 'rn', inputs: [{ text: 'a', note: 'n'.repeat(301) }] }),
      ),
    /INVALID_RUN_INPUTS/,
  );
  assert.throws(
    () => f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { requestId: 'rl', label: 'l'.repeat(61) })),
    /INVALID_RUN_LABEL/,
  );
  assert.throws(
    () => f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { requestId: 'rb', evalSetId: 'nope' })),
    /INVALID_RUN_INPUTS/,
  );
});

test('a run is executed in ordinal order, each row bills twice, and the row reports settlement, cost and latency from the ledger', async (t) => {
  const f = fixture(t);
  const { runId } = f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { inputs: lines('一', '二') }));
  const r = f.runner();
  const seen: string[] = [];
  for (let claim = r.claim(); claim; claim = r.claim()) {
    seen.push(
      JSON.parse(
        f.store.get<{ request_json: string }>('SELECT request_json FROM admin_previews WHERE id=?', claim.id)!
          .request_json,
      ).messages[0].text,
    );
    await r.run(claim, new AbortController().signal);
    f.tick(1000);
  }
  assert.deepEqual(seen, ['一', '二']);
  assert.equal(f.calls.length, 4);
  const { previews } = f.chars.runDetail(f.auth, 'wei-guagua', runId);
  for (const p of previews) {
    assert.equal(p.status, 'succeeded');
    assert.equal(p.settlement, 'settled_known');
    assert.ok(p.cost.chargedMicros > 0 && p.cost.heldMicros === 0);
    assert.equal(p.cost.draft!.state, 'known');
    assert.equal(p.cost.chargedMicros, p.cost.draft!.chargedMicros! + p.cost.review!.chargedMicros!);
    assert.ok(p.cost.draft!.reservedMicros >= p.cost.draft!.chargedMicros!);
    assert.equal(typeof p.latency.draftMs, 'number');
    assert.equal(typeof p.latency.reviewMs, 'number');
    assert.ok(p.final!.bubbles.length > 0);
    assert.equal(p.final!.coverage[0]!.status, 'answered');
  }
  const detail = f.chars.previewDetail(f.auth, 'wei-guagua', previews[0]!.previewId);
  assert.ok(detail.draft!.bubbles!.length > 0);
  assert.equal(detail.review!.decision, 'accept');
  assert.ok(Object.values(detail.review!.coverage as object).length === 1);
  assert.deepEqual(detail.rejected, []);
  assert.equal(detail.ids.runId, runId);
  // The batched status call: one query for the whole character, nothing heavy in it.
  const status = f.chars.previewsStatus(f.auth, 'wei-guagua', runId);
  assert.equal(status.active, 0);
  assert.deepEqual(Object.keys(status.previews[0]!).sort(), [
    'errorCode',
    'finishedAt',
    'ordinal',
    'previewId',
    'runId',
    'settlement',
    'status',
  ]);
  assert.equal(f.chars.previewsStatus(f.auth, 'wei-guagua', null).previews.length, 2);
  // Scoped: another character's id never resolves this run or preview.
  assert.throws(() => f.chars.runDetail(f.auth, 'jojo', runId), /NOT_FOUND/);
  assert.throws(() => f.chars.previewDetail(f.auth, 'jojo', previews[0]!.previewId), /NOT_FOUND/);
  assert.throws(() => f.chars.previewsStatus(f.auth, 'jojo', runId), /NOT_FOUND/);
});

test('a stage that completes with usage but fails validation keeps its raw output, bounded, without changing the bill', async (t) => {
  const f = fixture(t);
  const { runId } = f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { inputs: lines('会失败的输入') }));
  f.mode('invalid-topics');
  await f.drain();
  const [p] = f.chars.runDetail(f.auth, 'wei-guagua', runId).previews;
  assert.equal(p!.status, 'failed');
  assert.equal(p!.errorCode, 'INCOMPLETE_COVERAGE');
  // The failure is a KNOWN bill settled at actual usage, never an unknown call.
  assert.equal(p!.settlement, 'settled_known');
  assert.equal(p!.cost.heldMicros, 0);
  assert.equal(p!.cost.review!.state, 'known');
  assert.equal(p!.cost.review!.outcome, 'failed');
  assert.ok(p!.cost.review!.chargedMicros! > 0);
  const detail = f.chars.previewDetail(f.auth, 'wei-guagua', p!.previewId);
  assert.equal(detail.rejected.length, 1);
  assert.equal(detail.rejected[0]!.phase, 'review');
  assert.equal(detail.rejected[0]!.errorCode, 'INCOMPLETE_COVERAGE');
  assert.deepEqual(JSON.parse(detail.rejected[0]!.rawOutput).topics, [1, 2, 3, 4]);
  assert.equal(detail.rejected[0]!.truncated, false);
  // The bill is exactly what a rejected stage was charged before this feature: held back to zero, spent > 0.
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
  assert.ok(f.budget.summary()[0]!.spentMicros > 0);
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_character_preview_attempts WHERE state!='known'")!.n,
    0,
  );
  // Never shown to a player: no player-facing table has this text, and the row is only reachable via the admin routes.
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM messages')!.n, 0);
  // Never sent to a provider again: no further call was made for this preview.
  assert.equal(f.calls.length, 2);
});

test('rejected output is bounded to 32 KiB of UTF-8 with a marker and the original size', async (t) => {
  const f = fixture(t);
  const { runId } = f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { inputs: lines('很长的失败输出') }));
  f.mode('huge-topics');
  await f.drain();
  const [p] = f.chars.runDetail(f.auth, 'wei-guagua', runId).previews;
  const row = f.chars.previewDetail(f.auth, 'wei-guagua', p!.previewId).rejected[0]!;
  assert.equal(row.truncated, true);
  assert.ok(row.rawBytes > PREVIEW_REJECTED_MAX_BYTES);
  const kept = Buffer.byteLength(row.rawOutput, 'utf8');
  assert.ok(kept <= PREVIEW_REJECTED_MAX_BYTES + 64, `${kept}`);
  assert.match(row.rawOutput, /\n\[truncated; original \d+ bytes\]$/);
  assert.ok(!row.rawOutput.includes('�'), 'a multi-byte character is never cut in half');
  // The database itself refuses anything larger (defence in depth for any future writer).
  assert.throws(() =>
    f.store.run(
      "INSERT INTO web_preview_rejected VALUES (?,'draft','X',?,1,0,1)",
      p!.previewId,
      'a'.repeat(PREVIEW_REJECTED_MAX_BYTES + 100),
    ),
  );
  assert.throws(
    () => f.store.run("UPDATE web_preview_rejected SET error_code='Y' WHERE preview_id=?", p!.previewId),
    /IMMUTABLE/,
  );
});

test('settlement labels: known failures never read as unknown; an unknown call keeps its reservation; an unsent preview holds nothing', async (t) => {
  // settled_known (a failure that returned usage) is covered above. held_unknown:
  const u = fixture(t);
  const run = u.chars.startRun(u.auth, 'wei-guagua', runBody(u, { inputs: lines('网络中断') }));
  u.mode('unknown');
  await u.drain();
  const [p] = u.chars.runDetail(u.auth, 'wei-guagua', run.runId).previews;
  assert.equal(p!.status, 'failed');
  assert.equal(p!.errorCode, 'PREVIEW_CALL_UNKNOWN');
  assert.equal(p!.settlement, 'held_unknown');
  assert.ok(p!.cost.heldMicros > 0, 'the reservation stays held');
  assert.equal(p!.cost.chargedMicros, 0);
  assert.equal(
    u.chars.previewDetail(u.auth, 'wei-guagua', p!.previewId).rejected.length,
    0,
    'no response, nothing to keep',
  );
  assert.equal(u.chars.previewsStatus(u.auth, 'wei-guagua', run.runId).previews[0]!.settlement, 'held_unknown');
  assert.equal(u.calls.length, 1, 'never resent');
  // released_unsent: the draft changes while the preview waits, so it fails before any provider call.
  const s = fixture(t);
  const queued = s.chars.startRun(s.auth, 'wei-guagua', runBody(s, { inputs: lines('还没发出') }));
  const edited = structuredClone(s.profile);
  edited.template.persona += '又改了';
  s.chars.save(s.auth, 'wei-guagua', { expectedRevision: s.saved.revision, profile: edited });
  await s.drain();
  const [q] = s.chars.runDetail(s.auth, 'wei-guagua', queued.runId).previews;
  assert.equal(q!.status, 'failed');
  assert.equal(q!.errorCode, 'DRAFT_CONFLICT');
  assert.equal(q!.settlement, 'released_unsent');
  assert.equal(s.calls.length, 0);
  assert.equal(s.budget.summary()[0]!.heldMicros, 0);
});

test("simulated time moves only the preview clock inside the character's own zone; hashes and the zone are untouched", async (t) => {
  const f = fixture(t);
  const zone = f.zone;
  assert.equal(zone, 'Asia/Singapore');
  assert.equal(parseSimulatedTime('05:50'), 350);
  for (const bad of ['5:50', '24:00', '05:60', '05:50 Asia/Tokyo', '0550', 350, '']) {
    assert.throws(() => parseSimulatedTime(bad), /INVALID_SIMULATED_TIME/, String(bad));
  }
  assert.equal(parseSimulatedTime(undefined), null);
  const single = f.chars.startPreview(f.auth, 'wei-guagua', {
    ...f.base,
    requestId: 's-sim',
    message: '早',
    simulatedTime: '05:50',
  });
  const real = f.chars.startPreview(f.auth, 'wei-guagua', { ...f.base, requestId: 's-real', message: '早' });
  const requestOf = (id: string) =>
    JSON.parse(
      f.store.get<{ request_json: string }>('SELECT request_json FROM admin_previews WHERE id=?', id)!.request_json,
    ) as TextGenerationRequest;
  const sim = requestOf(single.previewId),
    now = requestOf(real.previewId);
  assert.equal(now.now, f.now(), 'without the option the real clock is used');
  assert.deepEqual(
    [localTime(sim.now, zone).minute, localTime(sim.now, zone).date],
    [350, localTime(f.now(), zone).date],
    "the matching UTC instant on today's date in the character's own zone",
  );
  assert.equal(sim.now % 60_000, 0);
  assert.equal(sim.character.schedule.timeZone, zone, 'the zone never changes');
  assert.equal(now.character.schedule.timeZone, zone);
  assert.equal(sim.messages[0]!.createdAt, sim.now);
  // The prompt shows the simulated wall clock; the policy / prompt hashes are the live ones.
  assert.match(JSON.stringify(promptMessages(sim)), /\d{4}-\d\d-\d\d 05:50/);
  assert.doesNotMatch(JSON.stringify(promptMessages(now)), /\d{4}-\d\d-\d\d 05:50/);
  assert.equal(previewPolicy, textPolicyHash());
  for (const id of [single.previewId, real.previewId])
    assert.equal(
      f.store.get<{ prompt_hash: string }>('SELECT prompt_hash FROM admin_previews WHERE id=?', id)!.prompt_hash,
      textPolicyHash(),
    );
  // Recorded on the preview (and the run), with the zone that was used.
  const row = f.chars.runList(f.auth, 'wei-guagua').singles.find((p) => p.previewId === single.previewId)!;
  assert.deepEqual(row.simulatedTime, { time: '05:50', timeZone: zone });
  const run = f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { simulatedTime: '15:00', inputs: lines('下午好') }));
  const summary = f.chars.runDetail(f.auth, 'wei-guagua', run.runId);
  assert.deepEqual(summary.run.simulatedTime, { time: '15:00', timeZone: zone });
  assert.equal(summary.previews[0]!.simulatedTime!.time, '15:00');
  // The zone cannot be supplied: no key for it exists on either entry point.
  for (const key of ['timeZone', 'zone', 'simulatedZone'])
    assert.throws(
      () =>
        f.chars.startPreview(f.auth, 'wei-guagua', {
          ...f.base,
          requestId: 'z-' + key,
          message: 'x',
          [key]: 'Asia/Tokyo',
        }),
      /INVALID_ADMIN_REQUEST/,
    );
  assert.throws(
    () => f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { requestId: 'z-run', timeZone: 'UTC' })),
    /INVALID_ADMIN_REQUEST/,
  );
  // Edge: a wall-clock minute inside the zone's own date, and a nonexistent local time is refused rather than moved.
  assert.equal(localTime(instantAtLocalMinute(f.now(), 'Asia/Singapore', 0), 'Asia/Singapore').minute, 0);
  assert.equal(localTime(instantAtLocalMinute(f.now(), 'Asia/Singapore', 1439), 'Asia/Singapore').minute, 1439);
  const spring = Date.UTC(2026, 2, 8, 12);
  assert.throws(() => instantAtLocalMinute(spring, 'America/New_York', 150), /INVALID_SIMULATED_TIME/);
});

test('a live (non-preview) request can never take the simulated-time path', () => {
  // The only function that applies a simulated time refuses any scope that is not an isolated admin preview.
  assert.throws(
    () => previewInstant({ worldId: 'world-of-a-player' }, 1_800_000_000_000, 'Asia/Singapore', 350),
    /SIMULATED_TIME_PREVIEW_ONLY/,
  );
  assert.throws(
    () => previewInstant({ worldId: 'world-of-a-player' }, 1_800_000_000_000, 'Asia/Singapore', null),
    /SIMULATED_TIME_PREVIEW_ONLY/,
  );
  assert.equal(
    previewInstant({ worldId: 'admin-preview-x' }, 1_800_000_000_000, 'Asia/Singapore', null),
    1_800_000_000_000,
  );
  // And nothing outside the preview module and its domain helper even references it: live paths read the real clock.
  const root = new URL('../../../apps/', import.meta.url);
  const hits: string[] = [];
  const walk = (dir: URL) => {
    for (const name of readdirSync(dir)) {
      const url = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? '/' : ''), dir);
      if (name === 'node_modules') continue;
      if (statSync(url).isDirectory()) walk(url);
      else if (
        name.endsWith('.ts') &&
        /previewInstant|instantAtLocalMinute|simulatedMinute|simulatedTime/.test(readFileSync(url, 'utf8'))
      )
        hits.push(url.pathname.split('/apps/')[1]!);
    }
  };
  walk(root);
  const allowed = [
    /^server\/characters\/web-character-preview(-read|-runner|-purge)?\.ts$/,
    /^server\/admin\/web-account-admin-routes\.ts$/,
    /^player-web\/(src|tests)\//,
  ];
  assert.deepEqual(
    hits.filter((file) => !allowed.some((re) => re.test(file))),
    [],
    'only the admin preview modules and the admin UI may mention a simulated time',
  );
  const live = hits.filter((file) => /^server\/(conversation|generation|memory|admission|identity)\//.test(file));
  assert.deepEqual(live, []);
});

test('eval sets: CRUD, 50-line cap, versioned on every save, and who may touch them', (t) => {
  const f = fixture(t);
  const items = [{ text: '你好', note: '应该打招呼' }, { text: '再见' }];
  const created = f.chars.evalSetSave(f.auth, { id: null, expectedVersion: null, name: '16 例', items });
  assert.equal(created.version, 1);
  assert.deepEqual(created.items, [
    { text: '你好', note: '应该打招呼' },
    { text: '再见', note: null },
  ]);
  assert.deepEqual(
    f.chars.evalSetList(f.auth).sets.map((s) => [s.name, s.version]),
    [['16 例', 1]],
  );
  // Save = new version; stale versions conflict; the same save replayed after a lost reply is idempotent.
  const next = f.chars.evalSetSave(f.auth, {
    id: created.id,
    expectedVersion: 1,
    name: '16 例',
    items: [...items, { text: '第三条' }],
  });
  assert.equal(next.version, 2);
  assert.deepEqual(
    f.chars.evalSetSave(f.auth, {
      id: created.id,
      expectedVersion: 1,
      name: '16 例',
      items: [...items, { text: '第三条' }],
    }),
    next,
  );
  assert.throws(
    () => f.chars.evalSetSave(f.auth, { id: created.id, expectedVersion: 1, name: '16 例', items: [{ text: '不同' }] }),
    /EVAL_SET_CONFLICT/,
  );
  assert.deepEqual(
    f.store
      .all<{ version: number }>('SELECT version FROM web_eval_set_versions WHERE set_id=? ORDER BY version', created.id)
      .map((r) => r.version),
    [1, 2],
  );
  assert.throws(
    () => f.store.run('UPDATE web_eval_set_versions SET name=? WHERE set_id=?', 'x', created.id),
    /IMMUTABLE/,
  );
  assert.throws(
    () => f.chars.evalSetSave(f.auth, { id: null, expectedVersion: null, name: '16 例', items }),
    /EVAL_SET_NAME_TAKEN/,
  );
  // Limits.
  assert.equal(
    f.chars.evalSetSave(f.auth, {
      id: null,
      expectedVersion: null,
      name: '五十',
      items: Array.from({ length: 50 }, (_, i) => ({ text: `第${i}条` })),
    }).items.length,
    50,
  );
  for (const bad of [
    [],
    Array.from({ length: 51 }, () => ({ text: 'x' })),
    [{ text: '' }],
    [{ text: 'x', note: 'n'.repeat(301) }],
    [{ text: 'x', extra: 1 }],
  ])
    assert.throws(
      () => f.chars.evalSetSave(f.auth, { id: null, expectedVersion: null, name: '坏', items: bad }),
      /INVALID_EVAL_SET|INVALID_ADMIN_REQUEST/,
    );
  // A run names the exact version it used.
  const run = f.chars.startRun(f.auth, 'wei-guagua', {
    requestId: 'by-set',
    ...f.base,
    evalSetId: created.id,
  });
  const detail = f.chars.runDetail(f.auth, 'wei-guagua', run.runId);
  assert.deepEqual(detail.run.evalSet, { id: created.id, version: 2 });
  assert.deepEqual(
    detail.previews.map((p) => [p.input, p.note]),
    [
      ['你好', '应该打招呼'],
      ['再见', null],
      ['第三条', null],
    ],
  );
  // Later edits do not change a run that already exists, and its replay is the same run.
  f.chars.evalSetSave(f.auth, { id: created.id, expectedVersion: 2, name: '16 例', items: [{ text: '全换了' }] });
  assert.equal(
    f.chars.startRun(f.auth, 'wei-guagua', { requestId: 'by-set', ...f.base, evalSetId: created.id }).runId,
    run.runId,
  );
  assert.equal(f.chars.runDetail(f.auth, 'wei-guagua', run.runId).previews.length, 3);
  // Permissions: wildcard preview writes; a one-character preview grant reads but cannot write; nothing at all is refused.
  const writer = f.member(['characters.read:*', 'characters.preview:*']);
  assert.equal(f.chars.evalSetList(writer).sets.length, 2);
  assert.equal(
    f.chars.evalSetSave(writer, { id: null, expectedVersion: null, name: '写手建', items: [{ text: 'a' }] }).version,
    1,
  );
  const scoped = f.member(['characters.read:wei-guagua', 'characters.preview:wei-guagua']);
  assert.equal(f.chars.evalSetList(scoped).sets.length, 3);
  assert.throws(
    () => f.chars.evalSetSave(scoped, { id: null, expectedVersion: null, name: '越权', items: [{ text: 'a' }] }),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  assert.throws(() => f.chars.evalSetDelete(scoped, created.id, 3), /ADMIN_PERMISSION_REQUIRED/);
  const reader = f.member(['characters.read:*']);
  assert.throws(() => f.chars.evalSetList(reader), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.chars.startRun(reader, 'wei-guagua', runBody(f)), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.chars.evalSetList({ ...f.auth, csrf: 'wrong' }), /CSRF|UNAUTHORIZED/);
  assert.throws(() => f.chars.evalSetList({ ...f.auth, origin: 'https://evil.invalid' }), /ORIGIN|UNAUTHORIZED/);
  // Delete removes the set and all its versions; runs that used it keep their rows.
  assert.deepEqual(f.chars.evalSetDelete(f.auth, created.id, 3), { deleted: true });
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_eval_set_versions WHERE set_id=?', created.id)!.n,
    0,
  );
  assert.equal(f.chars.runDetail(f.auth, 'wei-guagua', run.runId).previews.length, 3);
});

test('run reads need read permission, a run needs preview permission, and a revoked member is refused at once', (t) => {
  const f = fixture(t);
  const { runId } = f.chars.startRun(f.auth, 'wei-guagua', runBody(f));
  const reader = f.member(['characters.read:wei-guagua']);
  assert.equal(f.chars.runList(reader, 'wei-guagua').runs.length, 1);
  assert.equal(f.chars.runDetail(reader, 'wei-guagua', runId).previews.length, 3);
  assert.throws(
    () => f.chars.startRun(reader, 'wei-guagua', runBody(f, { requestId: 'no' })),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  const other = f.member(['characters.read:jojo']);
  assert.throws(() => f.chars.runList(other, 'wei-guagua'), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.chars.previewsStatus(other, 'wei-guagua', null), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(
    () => f.chars.startRun({ ...f.auth, csrf: 'wrong' }, 'wei-guagua', runBody(f, { requestId: 'c' })),
    /CSRF|UNAUTHORIZED/,
  );
});

test("deleting a character purges its runs, time marks and rejected output with it, and nothing else's", async (t) => {
  const f = fixture(t);
  const mine = f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { simulatedTime: '05:50', inputs: lines('会被删') }));
  f.mode('invalid-topics');
  await f.drain();
  const count = (table: string) => f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n;
  assert.equal(count('web_preview_rejected'), 1);
  assert.equal(count('web_preview_marks'), 1);
  // A stand-in for another character's workbench rows.
  f.store.run(
    "INSERT INTO web_preview_runs VALUES ('other-run','other-req',?,'jojo',NULL,1,?,'friend',NULL,'Asia/Singapore',NULL,NULL,1,'m',1)",
    'a'.repeat(64),
    'b'.repeat(64),
  );
  const preview = f.chars.deletionPreview(f.auth, 'wei-guagua');
  f.chars.deletionStart(f.auth, 'wei-guagua', {
    requestId: 'delete-1',
    previewHash: preview.previewHash,
    acknowledgeDeleteAllChats: true,
  });
  assert.equal(count('web_preview_rejected'), 0);
  assert.equal(count('web_preview_marks'), 0);
  assert.equal(count('web_preview_run_items'), 0);
  assert.deepEqual(
    f.store.all<{ id: string }>('SELECT id FROM web_preview_runs').map((r) => r.id),
    ['other-run'],
  );
  assert.equal(mine.replayed, false);
  // The ledger rows are immutable by design and stay; only the readable diagnosis went.
  assert.ok(count('web_character_preview_attempts') > 0);
  // A call that was still in flight when the character was deleted cannot write diagnosis afterwards.
  const r = f.runner();
  (
    r as unknown as { keepRejected(id: string, phase: string, v: { raw: string; errorCode: string }): void }
  ).keepRejected(f.store.get<{ id: string }>('SELECT id FROM admin_previews LIMIT 1')!.id, 'review', {
    raw: 'late',
    errorCode: 'INVALID_TOPICS',
  });
  assert.equal(count('web_preview_rejected'), 0);
});
