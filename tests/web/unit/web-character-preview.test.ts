import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../apps/server/store.ts';
import { migrateWebProviderOffline } from '../../../apps/server/web-provider-migration.ts';
import type { WebRuntimeStore } from '../../../apps/server/web-store-contract.ts';
import { configureWebProvider } from '../../../apps/server/web-provider-configuration.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebAccountAdmin } from '../../../apps/server/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/web-character-catalog.ts';
import { WebCharacterPreviews, readWebPreview } from '../../../apps/server/web-character-preview.ts';
import { WebCharacterPreviewExecutor } from '../../../apps/server/web-character-preview-executor.ts';
import { installWebCharacterPreviews } from '../../../apps/server/web-character-preview-schema.ts';
import { WebCharacterPreviewRunner, type WebPreviewBudget } from '../../../apps/server/web-character-preview-runner.ts';
import { WebProviderBudget } from '../../../apps/server/web-provider-budget.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/deepseek.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';

function fixture(t: test.TestContext) {
  let now = 1_800_000_000_000;
  const clock = { now: () => now },
    store = new Store(':memory:');
  t.after(() => store.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'preview-instance')");
  migrateWebProviderOffline(store);
  const selected = syntheticSelection();
  for (const item of selected)
    store.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      item.characterId,
      item.personaVersion,
      JSON.stringify(item.template),
    );
  configureWebProvider(store as unknown as WebRuntimeStore, selected, now);
  const admin = new WebAccountAdmin(store, clock, 'https://fixture.invalid');
  installWebCharacterCatalog(store);
  const chars = new WebCharacterAdmin(store, clock, admin),
    previews = new WebCharacterPreviews(store, clock);
  chars.enablePreviews(previews);
  const login = admin.login(admin.issueLoginGrant().token, 'https://fixture.invalid');
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: 'https://fixture.invalid' };
  const profile = chars.detail(auth, 'wei-guagua').published!.profile;
  profile.template.version++;
  profile.template.persona += '修改后的角色';
  const saved = chars.save(auth, 'wei-guagua', { expectedRevision: null, profile });
  const input = {
    requestId: 'preview-one',
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    relationship: 'friend',
    message: '今天好吗',
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'character-preview-'))),
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
  let mode = 'normal',
    onCall: (() => void | Promise<void>) | undefined;
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    textProtocol: 'accepted-v7',
    fetch: async (_url, init) => {
      const name = JSON.parse(String(init!.body)).tools[0].function.name;
      calls.push(name);
      await onCall?.();
      if (mode === 'unknown') throw new Error('offline network interrupted');
      const row = store.get<{ request_json: string }>(
        "SELECT request_json FROM admin_previews WHERE status='generating'",
      )!;
      const request = JSON.parse(row.request_json);
      const response = name === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request);
      return Response.json(mode === 'invalid' ? { ...response, choices: [] } : response);
    },
  });
  const runner = (authority: WebPreviewBudget = budget) =>
    new WebCharacterPreviewRunner(store, clock, generator, authority);
  const start = () => chars.startPreview(auth, 'wei-guagua', input);
  return {
    store,
    admin,
    chars,
    previews,
    auth,
    profile,
    input,
    budget,
    calls,
    runner,
    start,
    clock,
    tick: (ms: number) => {
      now += ms;
    },
    mode: (v: string) => {
      mode = v;
    },
    onCall: (f: () => void | Promise<void>) => {
      onCall = f;
    },
  };
}
const signal = () => new AbortController().signal;

test('isolated durable preview freezes input, bills exactly twice, never creates a player world, and keeps exact idempotency', async (t) => {
  const f = fixture(t),
    before = f.store.get<{ n: number }>('SELECT count(*) n FROM worlds')!.n;
  assert.deepEqual(f.chars.detail(f.auth, 'wei-guagua').previews, []);
  const job = f.start();
  assert.deepEqual(f.start(), job);
  assert.deepEqual(f.chars.detail(f.auth, 'wei-guagua').previews, [job]);
  assert.equal(f.chars.detail(f.auth, 'wei-guagua').previewAvailable, true);
  assert.throws(
    () => f.chars.startPreview(f.auth, 'wei-guagua', { ...f.input, message: 'changed' }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () => f.store.run("UPDATE admin_previews SET request_json='{}' WHERE id=?", job.previewId),
    /IMMUTABLE/,
  );
  const r = f.runner(),
    claim = r.claim()!;
  await r.run(claim, signal());
  const result = f.chars.previewStatus(f.auth, 'wei-guagua', job.previewId);
  assert.deepEqual(f.chars.detail(f.auth, 'wei-guagua').previews, [result]);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  assert.equal(result.result.stages.length, 2);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM worlds')!.n, before);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n, 0);
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
  assert.ok(f.budget.summary()[0]!.spentMicros > 0);
  const local = f.store.get<{ spent_micros: number; held_micros: number }>(
    "SELECT * FROM web_provider_spending WHERE provider='deepseek'",
  )!;
  assert.equal(local.spent_micros, f.budget.summary()[0]!.spentMicros);
  assert.equal(local.held_micros, 0);
  assert.equal(
    f.store.get<{ n: number }>("SELECT sum(reserved) n FROM web_external_budgets WHERE provider='deepseek'")!.n,
    0,
  );
  assert.equal(f.runner().claim(), null);
  await f.runner().recoverBills();
  assert.equal(f.calls.length, 2);
});

test('unknown and lost reservation replies retain shared/local money and capacity across runner restart; never resend', async (t) => {
  for (const lostReserve of [false, true]) {
    const f = fixture(t),
      job = f.start();
    if (!lostReserve) f.mode('unknown');
    const authority: WebPreviewBudget = {
      reserve: (...args) => {
        f.budget.reserve(...args);
        throw new Error('lost RPC reply');
      },
      settle: (...args) => f.budget.settle(...args),
    };
    const r = f.runner(lostReserve ? authority : f.budget);
    await r.run(r.claim()!, signal());
    assert.equal(readWebPreview(f.store, job.previewId).status, 'failed');
    assert.equal(readWebPreview(f.store, job.previewId).error_code, 'PREVIEW_CALL_UNKNOWN');
    assert.equal(f.calls.length, lostReserve ? 0 : 1);
    const held = f.budget.summary()[0]!.heldMicros;
    assert.ok(held > 0);
    f.tick(180_000);
    assert.equal(f.runner().claim(), null);
    assert.equal(f.budget.summary()[0]!.heldMicros, held);
    assert.equal(
      f.store.get<{ reserved: number }>(
        "SELECT reserved FROM web_external_budgets WHERE provider='deepseek' AND phase='draft'",
      )!.reserved,
      1,
    );
  }
});

test('lost known settlement response resumes review only, including an idempotent shared settlement retry', async (t) => {
  const f = fixture(t),
    job = f.start();
  let lost = true;
  const authority: WebPreviewBudget = {
    reserve: (...a) => f.budget.reserve(...a),
    settle: (...a) => {
      f.budget.settle(...a);
      if (lost) {
        lost = false;
        throw new Error('lost known bill reply');
      }
    },
  };
  let r = f.runner(authority);
  await r.run(r.claim()!, signal());
  assert.equal(f.calls.length, 1);
  assert.equal(readWebPreview(f.store, job.previewId).status, 'queued');
  const paid = f.budget.summary()[0]!.spentMicros;
  f.tick(10_000);
  r = f.runner();
  await r.recoverBills();
  assert.equal(f.budget.summary()[0]!.spentMicros, paid);
  await r.run(r.claim()!, signal());
  assert.equal(readWebPreview(f.store, job.previewId).status, 'succeeded');
  assert.deepEqual(f.calls, ['submit_dialogue_draft', 'submit_dialogue_audit']);
});

test('revocation during budget await prevents dispatch without ending the admin session', async (t) => {
  const f = fixture(t);
  const grant = f.admin.issueMember(f.auth.cookie, f.auth.csrf, f.auth.origin, {
    requestId: 'member',
    label: 'Reviewer',
    memberId: null,
    permissions: ['characters.read:wei-guagua', 'characters.preview:wei-guagua'],
  });
  const login = f.admin.login(grant.token, f.auth.origin),
    auth = { ...f.auth, cookie: login.cookie, csrf: login.csrf };
  const job = f.chars.startPreview(auth, 'wei-guagua', f.input);
  const authority: WebPreviewBudget = {
    reserve: (...a) => {
      f.budget.reserve(...a);
      f.admin.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, []);
    },
    settle: (...a) => f.budget.settle(...a),
  };
  const r = f.runner(authority);
  await r.run(r.claim()!, signal());
  assert.equal(f.calls.length, 0);
  assert.equal(readWebPreview(f.store, job.previewId).status, 'failed');
  assert.equal(f.admin.session(auth.cookie).member.id, grant.memberId);
  assert.throws(() => f.chars.previewStatus(auth, 'wei-guagua', job.previewId), /PERMISSION/);
});

test('draft editing during a known draft response settles its bill but cannot send review or publish', async (t) => {
  const f = fixture(t),
    job = f.start();
  f.onCall(() => {
    f.profile.template.persona += '另一个版本';
    f.chars.save(f.auth, 'wei-guagua', { expectedRevision: 1, profile: f.profile });
  });
  const r = f.runner();
  await r.run(r.claim()!, signal());
  assert.equal(f.calls.length, 1);
  assert.equal(readWebPreview(f.store, job.previewId).status, 'failed');
  assert.ok(f.budget.summary()[0]!.spentMicros > 0);
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
});

test('stale lease, current permission, prices, and shared capacity are closed dispatch gates', async (t) => {
  const f = fixture(t),
    job = f.start(),
    r = f.runner(),
    claim = r.claim()!;
  f.tick(151_000);
  await r.run(claim, signal());
  assert.equal(f.calls.length, 0);
  assert.equal(readWebPreview(f.store, job.previewId).status, 'failed');
  const f2 = fixture(t);
  f2.start();
  f2.store.run("UPDATE web_external_budgets SET reserved=capacity WHERE provider='deepseek' AND phase='draft'");
  const r2 = f2.runner();
  await r2.run(r2.claim()!, signal());
  assert.equal(f2.calls.length, 0);
  assert.equal(f2.budget.summary()[0]!.heldMicros, 0);
  const f3 = fixture(t);
  f3.start();
  f3.tick(8 * 60 * 60_000);
  assert.equal(f3.runner().claim(), null);
  assert.equal(f3.calls.length, 0);
});

test('known invalid output is charged once but never becomes a publishable review', async (t) => {
  const f = fixture(t),
    job = f.start();
  f.mode('invalid');
  const r = f.runner();
  await r.run(r.claim()!, signal());
  assert.equal(readWebPreview(f.store, job.previewId).status, 'failed');
  assert.equal(f.calls.length, 1);
  assert.ok(f.budget.summary()[0]!.spentMicros > 0);
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
  assert.equal(
    f.store.get<{ outcome: string }>('SELECT outcome FROM web_character_preview_attempts')!.outcome,
    'failed',
  );
  f.tick(160_000);
  assert.equal(f.runner().claim(), null);
  await f.runner().recoverBills();
  assert.equal(f.calls.length, 1);
});

test('crash lease classification during a pending reservation fences the late callback, without guessing a zero bill', async (t) => {
  const f = fixture(t),
    job = f.start();
  let release!: () => void, reserved!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    reached = new Promise<void>((resolve) => {
      reserved = resolve;
    });
  const authority: WebPreviewBudget = {
    reserve: async (...args) => {
      f.budget.reserve(...args);
      reserved();
      await blocked;
    },
    settle: (...args) => f.budget.settle(...args),
  };
  const r = f.runner(authority),
    task = r.run(r.claim()!, signal());
  await reached;
  assert.equal(f.runner().claim(), null, 'cannot steal an unexpired preview lease');
  f.tick(151_000);
  assert.equal(f.runner().claim(), null);
  release();
  await task;
  assert.equal(f.calls.length, 0);
  assert.equal(readWebPreview(f.store, job.previewId).status, 'failed');
  assert.equal(f.store.get<{ state: string }>('SELECT state FROM web_character_preview_attempts')!.state, 'unknown');
  assert.ok(f.budget.summary()[0]!.heldMicros > 0);
});

test('existing shared consumption is honored; a new preview instance cannot reset the allowance', async (t) => {
  const f = fixture(t);
  f.budget.reserve('other-instance', 'deepseek', 'a'.repeat(64), 2_999_999);
  f.start();
  const r = f.runner();
  await r.run(r.claim()!, signal());
  assert.equal(f.calls.length, 0);
  assert.equal(f.budget.summary()[0]!.heldMicros, 2_999_999);
  assert.equal(f.budget.summary()[0]!.remainingMicros, 1);
});

test('idle preview execution does not create an endless alarm loop; schema and completed receipts stay immutable', async (t) => {
  const f = fixture(t);
  let held = 0,
    woke = 0;
  const idle = new WebCharacterPreviewExecutor(f.runner(), {
    hold: () => {
      held++;
    },
    settled: async () => {
      woke++;
    },
  });
  idle.kick();
  await idle.close();
  assert.equal(held, 0);
  assert.equal(woke, 0);
  const job = f.start(),
    r = f.runner();
  await r.run(r.claim()!, signal());
  assert.equal(readWebPreview(f.store, job.previewId).status, 'succeeded');
  assert.throws(() => f.store.run("UPDATE web_character_preview_attempts SET state='sent'"), /IMMUTABLE/);
  assert.throws(() => f.store.run('DELETE FROM web_character_preview_jobs'), /IMMUTABLE/);
  installWebCharacterPreviews(f.store);
  f.store.run("UPDATE web_character_preview_schema SET sha256='wrong'");
  assert.throws(() => installWebCharacterPreviews(f.store), /SCHEMA_MISMATCH/);
});

test('late old worker cannot mark the successor review UNKNOWN after a known-draft lease recovery', async (t) => {
  const f = fixture(t),
    job = f.start();
  let releaseOld!: () => void, oldSettled!: () => void;
  const oldWait = new Promise<void>((r) => {
      releaseOld = r;
    }),
    reached = new Promise<void>((r) => {
      oldSettled = r;
    });
  const oldBudget: WebPreviewBudget = {
    reserve: (...a) => f.budget.reserve(...a),
    settle: async (...a) => {
      f.budget.settle(...a);
      oldSettled();
      await oldWait;
    },
  };
  const old = f.runner(oldBudget),
    oldTask = old.run(old.claim()!, signal());
  await reached;
  f.tick(151_000);
  let releaseReview!: () => void, reviewing!: () => void;
  const reviewWait = new Promise<void>((r) => {
      releaseReview = r;
    }),
    sent = new Promise<void>((r) => {
      reviewing = r;
    });
  f.onCall(async () => {
    reviewing();
    await reviewWait;
  });
  const successor = f.runner(),
    nextClaim = successor.claim()!;
  assert.ok(nextClaim);
  const nextTask = successor.run(nextClaim, signal());
  await sent;
  releaseOld();
  await oldTask;
  assert.equal(
    f.store.get<{ state: string }>("SELECT state FROM web_character_preview_attempts WHERE phase='review'")!.state,
    'sent',
  );
  assert.equal(readWebPreview(f.store, job.previewId).status, 'generating');
  releaseReview();
  await nextTask;
  assert.equal(readWebPreview(f.store, job.previewId).status, 'succeeded');
  assert.equal(f.calls.length, 2);
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
});
