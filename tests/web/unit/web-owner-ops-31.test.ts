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

import { WebOwnerOps } from '../../../apps/server/admin/web-owner-ops.ts';
import { installWebOwnerOps } from '../../../apps/server/admin/web-owner-ops-schema.ts';
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
  const ops = new WebOwnerOps(raw as never, clock, accounts);
  return {
    ops,
    accounts,
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
const rows = (f: ReturnType<typeof fixture>, sql: string, ...args: (string | number)[]) =>
  f.store.all<Record<string, unknown>>(sql, ...args).map((row) => ({ ...row }));
const count = (f: ReturnType<typeof fixture>, table: string) =>
  f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n;
const lines = (...texts: string[]) => texts.map((text) => ({ text }));
const runBody = (f: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) => ({
  requestId: 'run-one',
  ...f.base,
  inputs: lines('今天好吗', '晚上吃什么'),
  ...over,
});

test('arc order: it is the catalog position (not the per-admin sidebar order); the owner or a 角色 grant sets it, once per request id', (t) => {
  const f = fixture(t);
  const before = f.ops.arcOrder(f.auth).characters;
  assert.ok(before.length >= 2);
  assert.deepEqual(
    before.map((c) => c.position),
    before.map((_, i) => i + 1),
    'positions are 1..n in the order the home page reads',
  );
  const reversed = [...before].reverse().map((c) => c.characterId);
  const saved = f.ops.saveArcOrder(f.auth, { requestId: 'arc-1', ids: reversed });
  assert.deepEqual(
    saved.characters.map((c) => c.characterId),
    reversed,
  );
  // the home page's own read agrees: it orders by web_character_catalog.position
  assert.deepEqual(
    rows(f, 'SELECT character_id FROM web_character_catalog ORDER BY position').map((r) => r.character_id),
    reversed,
  );
  // a replay answers the same and changes nothing; the same id with another body is a conflict
  assert.equal(f.ops.saveArcOrder(f.auth, { requestId: 'arc-1', ids: reversed }).saved, reversed.length);
  assert.throws(
    () => f.ops.saveArcOrder(f.auth, { requestId: 'arc-1', ids: [...before].map((c) => c.characterId) }),
    /IDEMPOTENCY_CONFLICT/,
  );
  // an order that is not exactly the live characters is refused whole
  assert.throws(() => f.ops.saveArcOrder(f.auth, { requestId: 'arc-2', ids: reversed.slice(1) }), /ARC_ORDER_STALE/);
  assert.throws(
    () => f.ops.saveArcOrder(f.auth, { requestId: 'arc-3', ids: [...reversed.slice(1), 'unknown-one'] }),
    /ARC_ORDER_STALE/,
  );
  // who: a member without the 角色 category is refused; with it, allowed
  const plain = f.member(['characters.read:*']);
  assert.throws(() => f.ops.saveArcOrder(plain, { requestId: 'arc-4', ids: reversed }), /ADMIN_PERMISSION_REQUIRED/);
  const grant = f.member(['category.characters']);
  assert.equal(
    f.ops.saveArcOrder(grant, { requestId: 'arc-5', ids: before.map((c) => c.characterId) }).saved,
    before.length,
  );
  // CSRF and Origin are the admin session's: a wrong one never reaches the order
  assert.throws(
    () => f.ops.saveArcOrder({ ...f.auth, origin: 'https://evil.invalid' }, { requestId: 'arc-6', ids: reversed }),
    /ADMIN_UNAUTHORIZED/,
  );
  assert.throws(
    () => f.ops.saveArcOrder({ ...f.auth, csrf: 'b'.repeat(64) }, { requestId: 'arc-7', ids: reversed }),
    /ADMIN_CSRF_REQUIRED/,
  );
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_admin_audit WHERE action='arc-order-saved'")!.n,
    2,
    'one audit line per real change',
  );
});

test('deleting 预演 records: content goes, the bills stay, every reader skips them, and only the owner may', async (t) => {
  const f = fixture(t);
  const run = f.chars.startRun(f.auth, 'wei-guagua', runBody(f));
  await f.drain();
  const detail = f.chars.runDetail(f.auth, 'wei-guagua', run.runId);
  assert.equal(detail.previews.length, 2);
  const ledgerBefore = rows(
    f,
    'SELECT preview_id,phase,state,outcome,charged_micros,receipt_json,output_hash,settled_at FROM web_character_preview_attempts ORDER BY preview_id,phase',
  );
  assert.ok(ledgerBefore.length >= 4 && ledgerBefore.every((r) => r.state === 'known'));
  assert.ok(
    f.store.get('SELECT 1 FROM web_character_preview_attempts WHERE output_json IS NOT NULL'),
    'there is content to delete',
  );

  // not the owner: refused before anything is read
  const member = f.member(['category.characters', 'characters.preview:*', 'characters.read:*']);
  assert.throws(
    () => f.ops.deletePreviews(member, { requestId: 'del-0', runIds: [run.runId], previewIds: [] }),
    /ADMIN_OWNER_REQUIRED/,
  );
  assert.throws(
    () =>
      f.ops.deletePreviews(
        { ...f.auth, origin: 'https://evil.invalid' },
        { requestId: 'del-0', runIds: [run.runId], previewIds: [] },
      ),
    /ADMIN_UNAUTHORIZED/,
  );
  assert.equal(count(f, 'web_preview_erased'), 0);

  const done = f.ops.deletePreviews(f.auth, { requestId: 'del-1', runIds: [run.runId], previewIds: [] });
  assert.deepEqual(done, { previews: 2, runs: 1 });
  assert.deepEqual(
    f.ops.deletePreviews(f.auth, { requestId: 'del-1', runIds: [run.runId], previewIds: [] }),
    done,
    'a replay answers the same',
  );
  assert.throws(
    () => f.ops.deletePreviews(f.auth, { requestId: 'del-1', runIds: [], previewIds: ['x'] }),
    /IDEMPOTENCY_CONFLICT/,
  );

  // the content is physically gone ...
  assert.equal(count(f, 'web_preview_runs'), 0);
  assert.equal(count(f, 'web_preview_run_items'), 0);
  assert.equal(count(f, 'web_preview_rejected'), 0);
  assert.equal(
    f.store.get("SELECT 1 FROM admin_previews WHERE result_json IS NOT NULL OR request_json<>'{}'"),
    undefined,
  );
  assert.equal(
    f.store.get(
      'SELECT 1 FROM web_character_preview_attempts WHERE output_json IS NOT NULL OR metadata_json IS NOT NULL',
    ),
    undefined,
  );
  // ... and the money rows are exactly as they were
  assert.deepEqual(
    rows(
      f,
      'SELECT preview_id,phase,state,outcome,charged_micros,receipt_json,output_hash,settled_at FROM web_character_preview_attempts ORDER BY preview_id,phase',
    ),
    ledgerBefore,
  );
  // readers skip them: detail, the run list and the character's recent previews
  assert.throws(() => f.chars.runDetail(f.auth, 'wei-guagua', run.runId), /NOT_FOUND/);
  assert.throws(() => f.chars.previewDetail(f.auth, 'wei-guagua', detail.previews[0]!.previewId), /NOT_FOUND/);
  assert.deepEqual(f.chars.runList(f.auth, 'wei-guagua'), { runs: [], singles: [] });
  assert.deepEqual(f.chars.detail(f.auth, 'wei-guagua').previews, []);
  // the audit holds a fixed action and a count, no id
  assert.deepEqual(rows(f, "SELECT action,target_id FROM web_admin_audit WHERE action='previews-deleted'"), [
    { action: 'previews-deleted', target_id: 'n=2' },
  ]);
  // the guard is still a guard: a marked preview may only lose content, never change a bill, and an unmarked one may not change at all
  const erased = ledgerBefore[0]!.preview_id as string;
  assert.throws(
    () =>
      f.store.run(
        'UPDATE web_character_preview_attempts SET charged_micros=charged_micros+1 WHERE preview_id=?',
        erased,
      ),
    /WEB_PREVIEW_IMMUTABLE/,
  );
  const second = f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { requestId: 'run-two' }));
  await f.drain();
  const live = f.chars.runDetail(f.auth, 'wei-guagua', second.runId).previews[0]!.previewId;
  assert.throws(
    () => f.store.run('UPDATE web_character_preview_attempts SET output_json=NULL WHERE preview_id=?', live),
    /WEB_PREVIEW_IMMUTABLE/,
  );
  assert.throws(
    () => f.store.run("UPDATE admin_previews SET request_json='{}' WHERE id=?", live),
    /WEB_PREVIEW_IMMUTABLE/,
  );
});

test('a 预演 that is still running cannot be deleted, and deleting one single preview leaves the rest of its run', async (t) => {
  const f = fixture(t);
  const run = f.chars.startRun(f.auth, 'wei-guagua', runBody(f));
  const queued = f.chars.runDetail(f.auth, 'wei-guagua', run.runId).previews.map((p) => p.previewId);
  assert.throws(
    () => f.ops.deletePreviews(f.auth, { requestId: 'busy-1', runIds: [run.runId], previewIds: [] }),
    /PREVIEW_DELETE_BUSY/,
  );
  assert.equal(count(f, 'web_preview_erased'), 0, 'nothing was changed by the refusal');
  await f.drain();
  const one = f.ops.deletePreviews(f.auth, { requestId: 'one-1', runIds: [], previewIds: [queued[0]!] });
  assert.deepEqual(one, { previews: 1, runs: 0 });
  const left = f.chars.runDetail(f.auth, 'wei-guagua', run.runId);
  assert.deepEqual(
    left.previews.map((p) => p.previewId),
    [queued[1]],
  );
  assert.equal(
    f.ops.deletePreviews(f.auth, { requestId: 'one-2', runIds: [run.runId], previewIds: [] }).runs,
    1,
    'the run goes once it is empty',
  );
});

test('a deleted 预演 can no longer be the proof of a publication', async (t) => {
  const f = fixture(t);
  const run = f.chars.startRun(f.auth, 'wei-guagua', runBody(f, { inputs: lines('今天好吗') }));
  await f.drain();
  const previewId = f.chars.runDetail(f.auth, 'wei-guagua', run.runId).previews[0]!.previewId;
  f.ops.deletePreviews(f.auth, { requestId: 'proof-1', runIds: [], previewIds: [previewId] });
  assert.throws(
    () =>
      f.chars.publish(f.auth, 'wei-guagua', {
        requestId: 'pub-1',
        draftRevision: f.saved.revision,
        profileHash: f.saved.contentHash,
        previewId,
        acknowledgeReview: true,
      }),
    /VALID_PREVIEW_REQUIRED/,
  );
});

test('the owner-ops step is digest-checked: a second start changes nothing, and a foreign table of the same name is a STOP', (t) => {
  const f = fixture(t);
  const digest = f.store.get('SELECT * FROM web_owner_ops_schema');
  installWebOwnerOps(f.store as never);
  assert.deepEqual(f.store.get('SELECT * FROM web_owner_ops_schema'), digest);
  f.store.run('UPDATE web_owner_ops_schema SET sha256=?', 'f'.repeat(64));
  assert.throws(() => installWebOwnerOps(f.store as never), /WEB_OWNER_OPS_SCHEMA_MISMATCH/);
});
