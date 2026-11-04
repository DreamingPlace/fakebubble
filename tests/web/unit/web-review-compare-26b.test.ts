import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../apps/server/platform/store.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import { configureWebProvider } from '../../../apps/server/generation/web-provider-configuration.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { WebCharacterPreviews } from '../../../apps/server/characters/web-character-preview.ts';
import {
  WebCharacterPreviewRunner,
  type WebPreviewBudget,
} from '../../../apps/server/characters/web-character-preview-runner.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import {
  applyTextReview,
  DROP_INVALID_METADATA,
  parseTextDraft,
} from '../../../apps/server/generation/accepted-text-protocol.ts';
import {
  COMPARE_CASES,
  checkExpectations,
  compareRequest,
  quoteReport,
  type CompareCase,
} from '../../../apps/server/characters/web-review-compare-cases.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { installReviewModelSchema } from '../../../apps/server/admission/web-review-model.ts';

// ---- the built-in set and its checker (pure) -----------------------------------------------------------------------------------

test('the 审核对比集: about 30 synthetic cases, unique keys, every frozen request is a valid prompt, nothing of a player', () => {
  assert.ok(COMPARE_CASES.length >= 28 && COMPARE_CASES.length <= 32, `${COMPARE_CASES.length} cases`);
  assert.equal(new Set(COMPARE_CASES.map((c) => c.key)).size, COMPARE_CASES.length);
  const groups = new Set(COMPARE_CASES.map((c) => c.group));
  for (const group of [
    '称呼',
    '凭空假设',
    '编造经历',
    '不代写',
    '拒绝不露馅',
    '真实痛苦',
    '气泡上限',
    '覆盖',
    '记住玩家的事',
    '话题重要度',
    '场景',
    '关系事件',
    '成长中角色',
    '干净草稿',
  ])
    assert.ok(groups.has(group), `group ${group}`);
  COMPARE_CASES.forEach((c, i) => {
    const request = compareRequest(c, 'run', i + 1);
    assert.doesNotThrow(() => promptMessages(request), c.key);
    assert.deepEqual(
      request.requiredMessageIds,
      c.messages.map((_, n) => `${c.key}-m${n + 1}`),
    );
    assert.equal(request.scope.worldId, 'admin-compare-run');
    assert.ok(c.expect.length >= 1);
    // The same case is the same request every time (the draft is the only thing that varies).
    assert.equal(JSON.stringify(compareRequest(c, 'run', i + 1)), JSON.stringify(request));
  });
  assert.equal(compareRequest(COMPARE_CASES.find((c) => c.seed)!, 'r', 1).character.seed, true);
});

const base = (key: string) => COMPARE_CASES.find((c) => c.key === key)!;
const bubbles = (...texts: string[]) => texts.map((text) => ({ text, expression: 'neutral' as const }));
const finalOf = (over: Record<string, unknown> = {}) =>
  ({
    bubbles: bubbles('好呀'),
    mode: 'casual',
    factOps: [],
    topics: [],
    sceneUpdate: null,
    relationshipEvents: [],
    coveredMessageIds: [],
    deferredMessageIds: [],
    awaitingPlayerMessageIds: [],
    ...over,
  }) as never;
const run = (key: string, final: unknown, draft = bubbles('好呀'), changed = false) => {
  const c: CompareCase = base(key);
  return checkExpectations({ c, request: compareRequest(c, 'r', 1), draft, final: final as never, changed });
};

test('expected-outcome checker: passes and fails on fixtures, for every kind of expectation', () => {
  // absent: a form of address is a failure
  assert.equal(run('a1-address-lover', finalOf({ bubbles: bubbles('先歇一会儿吧') })).results[0]!.pass, true);
  assert.equal(run('a1-address-lover', finalOf({ bubbles: bubbles('宝宝先歇一会儿') })).results[0]!.pass, false);
  // absent with a pattern: an invented score
  assert.equal(run('c2-fake-live-match', finalOf({ bubbles: bubbles('我没在看，不知道') })).results[0]!.pass, true);
  assert.equal(run('c2-fake-live-match', finalOf({ bubbles: bubbles('现在是 2:1 呀') })).results[0]!.pass, false);
  // short + absent: an essay
  assert.deepEqual(
    run('d1-essay', finalOf({ bubbles: bubbles('作文得你自己写啦，我陪你聊聊想法') })).results.map((r) => r.pass),
    [true, true],
  );
  assert.equal(run('d1-essay', finalOf({ bubbles: bubbles('x'.repeat(200)) })).results[0]!.pass, false);
  // AI words in a refusal
  assert.equal(run('e1-system-prompt', finalOf({ bubbles: bubbles('这个我不想给你看') })).results[0]!.pass, true);
  assert.equal(run('e1-system-prompt', finalOf({ bubbles: bubbles('这违反规则，我是AI') })).results[0]!.pass, false);
  // distress: present and absent
  assert.deepEqual(
    run('f1-distress-severe', finalOf({ bubbles: bubbles('我在，先跟我说说') })).results.map((r) => r.pass),
    [true, true],
  );
  assert.deepEqual(
    run('f1-distress-severe', finalOf({ bubbles: bubbles('哈哈别想太多') })).results.map((r) => r.pass),
    [false, false],
  );
  // limits: five casual bubbles break the casual limit
  assert.equal(run('g1-limits-casual', finalOf({ bubbles: bubbles('一', '二', '三') })).results[0]!.pass, true);
  assert.equal(
    run('g1-limits-casual', finalOf({ bubbles: bubbles('一', '二', '三', '四', '五') })).results[0]!.pass,
    false,
  );
  // coverage
  const id = 'h2-coverage-needs-player-m1';
  assert.equal(run('h2-coverage-needs-player', finalOf({ awaitingPlayerMessageIds: [id] })).results[0]!.pass, true);
  assert.equal(run('h2-coverage-needs-player', finalOf({ coveredMessageIds: [id] })).results[0]!.pass, false);
  // a fact recorded, and a question NOT recorded as a fact
  const op = {
    op: 'add',
    factKey: 'major',
    statement: '学设计，大三',
    importance: 5,
    evidenceMessageIds: ['i1-fact-recorded-m1'],
  };
  assert.equal(run('i1-fact-recorded', finalOf({ factOps: [op] })).results[0]!.pass, true);
  assert.equal(run('i1-fact-recorded', finalOf({ factOps: [] })).results[0]!.pass, false);
  assert.equal(run('i2-question-not-fact', finalOf({ factOps: [] })).results[0]!.pass, true);
  assert.equal(run('i2-question-not-fact', finalOf({ factOps: [op] })).results[0]!.pass, false);
  assert.equal(run('i3-fact-update', finalOf({ factOps: [{ ...op, op: 'retire' }] })).results[0]!.pass, true);
  assert.equal(run('i3-fact-update', finalOf({ factOps: [] })).results[0]!.pass, false);
  // topics with importance
  assert.equal(run('j1-topic-important', finalOf({ topics: [{ key: 'k', importance: 8 }] })).results[0]!.pass, true);
  assert.equal(run('j1-topic-important', finalOf({ topics: [{ key: 'k', importance: 3 }] })).results[0]!.pass, false);
  assert.equal(run('j2-topic-trivial', finalOf({ topics: [] })).results[0]!.pass, true);
  assert.equal(run('j2-topic-trivial', finalOf({ topics: [{ key: 'k', importance: 8 }] })).results[0]!.pass, false);
  // scene: together + quiet with exact quotes; a quote that is not in the bubbles fails
  const c = base('k1-scene-library');
  const request = compareRequest(c, 'r', 1);
  const scene = (responseQuote: string) => ({
    scene: { kind: 'together', setting: '图书馆', plan: null, proximity: 'ordinary', speaking: 'quiet' },
    evidence: [{ messageId: 'k1-scene-library-m1', quote: '要小声一点' }],
    responseQuote,
  });
  const ok = checkExpectations({
    c,
    request,
    draft: bubbles('嗯，我小声说'),
    final: finalOf({ bubbles: bubbles('嗯，我小声说'), sceneUpdate: scene('我小声说') }),
    changed: false,
  });
  assert.equal(ok.results[0]!.pass, true);
  const bad = checkExpectations({
    c,
    request,
    draft: bubbles('嗯，我小声说'),
    final: finalOf({ bubbles: bubbles('嗯，我小声说'), sceneUpdate: scene('轻声细语') }),
    changed: false,
  });
  assert.equal(bad.results[0]!.pass, false);
  assert.equal(run('k1-scene-library', finalOf({ sceneUpdate: null })).results[0]!.pass, false);
  // relationship events need real evidence: none is expected for small talk
  assert.equal(run('l1-no-event-smalltalk', finalOf({ relationshipEvents: [] })).results[0]!.pass, true);
  assert.equal(
    run('l1-no-event-smalltalk', finalOf({ relationshipEvents: [{ kind: 'support' }] })).results[0]!.pass,
    false,
  );
  // 成长中: no invented backstory
  assert.equal(
    run('m1-seed-no-invention', finalOf({ bubbles: bubbles('我还没想好，你觉得呢？') })).results[0]!.pass,
    true,
  );
  assert.equal(
    run('m1-seed-no-invention', finalOf({ bubbles: bubbles('我小时候在杭州长大，2003年搬家') })).results[0]!.pass,
    false,
  );
  // an invalid review passes nothing
  assert.deepEqual(
    run('a1-address-lover', null).results.map((r) => r.pass),
    [false],
  );
});

test('needless rewrite: only a clean draft that the review changed counts, and a clean draft left alone passes', () => {
  const clean = run('n1-clean-greeting', finalOf(), bubbles('早安'), false);
  assert.equal(clean.needlessRewrite, false);
  assert.equal(clean.results[0]!.pass, true);
  const touched = run('n1-clean-greeting', finalOf({ bubbles: bubbles('早上好呀') }), bubbles('早安'), true);
  assert.equal(touched.needlessRewrite, true);
  assert.equal(touched.results[0]!.pass, false);
  // a draft that broke a rule MAY be rewritten: not needless
  const fixed = run('a1-address-lover', finalOf({ bubbles: bubbles('歇会儿吧') }), bubbles('宝宝歇会儿吧'), true);
  assert.equal(fixed.needlessRewrite, false);
  assert.equal(fixed.results[0]!.pass, true);
});

test('quote exactness: every supportQuote / responseQuote must be verbatim in the final bubbles', () => {
  const c = base('k1-scene-library');
  const request = compareRequest(c, 'r', 1);
  const final = finalOf({ bubbles: bubbles('嗯，我小声', '说话'), sceneUpdate: null });
  const raw = (supportQuote: string) => ({
    coverage: { [request.requiredMessageIds[0]!]: { status: 'answered', supportQuote, missingInformation: '' } },
  });
  assert.deepEqual(quoteReport(request, final, raw('我小声')), { checked: 1, failed: 0 });
  assert.deepEqual(
    quoteReport(request, final, raw('小声说话')),
    { checked: 1, failed: 0 },
    'a quote may span consecutive bubbles',
  );
  assert.deepEqual(quoteReport(request, final, raw('我大声说')), { checked: 1, failed: 1 });
  // on the raw payload of a rejected review (no final): the replacement bubbles are what the quote must be found in
  const rejected = { ...raw('不存在的话'), replacementBubbles: [{ text: '好呀', expression: 'neutral' }] };
  assert.deepEqual(quoteReport(request, null, rejected), { checked: 1, failed: 1 });
  // evidence quotes must come from the player's message
  const sceneRaw = {
    replacementBubbles: [{ text: '嗯，我小声说', expression: 'neutral' }],
    sceneUpdate: {
      scene: {},
      evidence: [
        { messageId: request.messages[0]!.id, quote: '要小声一点' },
        { messageId: request.messages[0]!.id, quote: '并不存在' },
      ],
      responseQuote: '我小声',
    },
  };
  assert.deepEqual(quoteReport(request, null, sceneRaw), { checked: 3, failed: 1 });
});

// ---- the runner: one draft, two reviews of the SAME draft, budget before every call -------------------------------------------

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
  store.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'compare-instance')");
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
  const chars = new WebCharacterAdmin(store, clock, admin);
  chars.enablePreviews(new WebCharacterPreviews(store, clock));
  const login = admin.login(admin.issueLoginGrant().token, 'https://fixture.invalid');
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: 'https://fixture.invalid' };
  const member = (permissions: string[], label: string) => {
    const grant = admin.issueMember(login.cookie, login.csrf, 'https://fixture.invalid', {
      requestId: `issue-${label}`,
      label,
      memberId: null,
      permissions,
    });
    const next = admin.login(grant.token, 'https://fixture.invalid');
    return { cookie: next.cookie, csrf: next.csrf, origin: 'https://fixture.invalid' };
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-compare-'))),
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
  /** Everything that happens at a provider or at the shared budget, in order. */
  const events: string[] = [];
  const bodies: Array<{ model: string; tool: string; messages: unknown; tools: unknown }> = [];
  const behaviour = { flash: 'normal' as 'normal' | 'unknown' | 'rewrite' | 'invalid', onlyOrdinal: 0 };
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      const tool = body.tools[0].function.name as string;
      const row =
        store.get<{ ordinal: number; request_json: string }>(
          "SELECT ordinal,request_json FROM web_review_compare_cases WHERE status='generating'",
        ) ??
        store.get<{ ordinal: number; request_json: string }>(
          "SELECT 0 ordinal,request_json FROM admin_previews WHERE status='generating'",
        )!;
      events.push(`fetch:${body.model}:${tool === 'submit_dialogue_draft' ? 'draft' : 'review'}:${row.ordinal}`);
      bodies.push({ model: body.model, tool, messages: body.messages, tools: body.tools });
      const request = JSON.parse(row.request_json);
      if (tool === 'submit_dialogue_draft') return Response.json(draftEnvelope(request));
      const mine = behaviour.onlyOrdinal === 0 || behaviour.onlyOrdinal === row.ordinal;
      if (body.model === 'deepseek-flash' && mine && behaviour.flash === 'unknown')
        throw new Error('offline network interrupted');
      if (body.model === 'deepseek-flash' && mine && behaviour.flash === 'invalid')
        return Response.json({ ...acceptedAuditEnvelope(request), choices: [] });
      const response = acceptedAuditEnvelope(request);
      if (body.model === 'deepseek-flash' && mine && behaviour.flash === 'rewrite') {
        const args = JSON.parse(response.choices[0]!.message.tool_calls![0]!.function.arguments);
        args.replacementBubbles = [{ text: '改写后的简短回复', expression: 'neutral' }];
        for (const id of request.requiredMessageIds)
          args.coverage[id] = { status: 'answered', supportQuote: '改写后的简短回复', missingInformation: '' };
        response.choices[0]!.message.tool_calls![0]!.function.arguments = JSON.stringify(args);
      }
      return Response.json(response);
    },
  });
  const authority: WebPreviewBudget = {
    reserve: (id, provider, fingerprint, micros) => {
      events.push(`reserve:${(JSON.parse(id) as unknown[])[4]}:${(JSON.parse(id) as unknown[])[3]}`);
      return budget.reserve(id, provider, fingerprint, micros);
    },
    settle: (...args) => budget.settle(...args),
  };
  const runner = () => new WebCharacterPreviewRunner(store, clock, generator, authority);
  return {
    store,
    chars,
    auth,
    member,
    budget,
    events,
    bodies,
    behaviour,
    runner,
    clock,
    tick: (ms: number) => {
      now += ms;
    },
    start: (requestId = 'compare-one') =>
      chars.compareStart(auth, { requestId, confirmPaidCalls: COMPARE_CASES.length * 3 }),
  };
}
const signal = () => new AbortController().signal;
async function drain(f: ReturnType<typeof fixture>, limit = 100) {
  const r = f.runner();
  let n = 0;
  for (let claim = r.claim(); claim && n < limit; claim = r.claim(), n++) await r.run(claim, signal());
  return n;
}

test('a run: one draft per case, then V4 Pro and V4.1 Flash review the identical frozen request; budget is reserved before every call', async (t) => {
  const f = fixture(t);
  f.behaviour.flash = 'rewrite';
  assert.throws(
    () => f.chars.compareStart(f.auth, { requestId: 'compare-bad', confirmPaidCalls: 1 }),
    /PAID_CONFIRMATION_REQUIRED/,
  );
  const { runId, replayed } = f.start();
  assert.equal(replayed, false);
  assert.deepEqual(f.start(), { runId, replayed: true });
  assert.throws(() => f.start('compare-two'), /COMPARE_RUN_ACTIVE/, 'one run at a time');
  assert.equal(await drain(f), COMPARE_CASES.length);

  const n = COMPARE_CASES.length;
  const drafts = f.bodies.filter((b) => b.tool === 'submit_dialogue_draft');
  const reviews = f.bodies.filter((b) => b.tool === 'submit_dialogue_audit');
  assert.equal(drafts.length, n, 'one draft per case');
  assert.equal(reviews.length, 2 * n, 'two reviews per case');
  assert.ok(
    drafts.every((b) => b.model === 'deepseek-flash'),
    'the draft model players use',
  );
  assert.deepEqual([...new Set(reviews.map((b) => b.model))].sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  for (let i = 0; i < n; i++) {
    const [pro, flash] = [reviews[2 * i]!, reviews[2 * i + 1]!];
    assert.equal(pro.model, 'deepseek-v4-pro');
    assert.equal(flash.model, 'deepseek-flash');
    assert.deepEqual(flash.messages, pro.messages, 'the same frozen request');
    assert.deepEqual(flash.tools, pro.tools);
    // the review prompt carries the draft: both reviewers saw the same one
    assert.match(JSON.stringify(pro.messages), /离线测试文本/);
  }
  // every provider call is preceded by the reservation of exactly that phase
  f.events.forEach((event, i) => {
    if (!event.startsWith('fetch:')) return;
    const [, model, stage, ordinal] = event.split(':');
    const phase = stage === 'draft' ? 'draft' : model === 'deepseek-v4-pro' ? 'review_pro' : 'review_flash';
    assert.equal(f.events[i - 1], `reserve:${phase}:${ordinal}`, `${event} follows its reservation`);
  });
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
  assert.ok(f.budget.summary()[0]!.spentMicros > 0);
  assert.equal(
    f.store.get<{ n: number }>("SELECT sum(reserved) n FROM web_external_budgets WHERE provider='deepseek'")!.n,
    0,
  );

  // the results are exactly what the stored stage outputs say
  const detail = f.chars.compareDetail(f.auth, runId);
  assert.equal(detail.cases.length, n);
  assert.equal(detail.run.done, n);
  assert.equal(detail.summary.pro.reviews, n);
  assert.equal(detail.summary.flash.reviews, n);
  assert.equal(detail.summary.flash.changed, n, 'Flash rewrote every draft in this fixture');
  assert.equal(detail.summary.pro.changed, 0);
  for (const c of detail.cases) {
    const rows = f.store.all<{ phase: string; output_json: string }>(
      'SELECT phase,output_json FROM web_review_compare_attempts WHERE run_id=? AND ordinal=?',
      runId,
      c.ordinal,
    );
    const request = JSON.parse(
      f.store.get<{ request_json: string }>(
        'SELECT request_json FROM web_review_compare_cases WHERE run_id=? AND ordinal=?',
        runId,
        c.ordinal,
      )!.request_json,
    );
    const draft = parseTextDraft(JSON.parse(rows.find((r) => r.phase === 'draft')!.output_json), request);
    assert.deepEqual(
      c.draft,
      draft.bubbles.map((b) => b.text),
    );
    for (const [side, phase] of [
      ['pro', 'review_pro'],
      ['flash', 'review_flash'],
    ] as const) {
      const final = applyTextReview(
        JSON.parse(rows.find((r) => r.phase === phase)!.output_json),
        draft,
        request,
        DROP_INVALID_METADATA,
      );
      assert.deepEqual(
        c[side].bubbles,
        final.bubbles.map((b) => b.text),
        `${side} of case ${c.ordinal}`,
      );
      assert.equal(c[side].state, 'ok');
      assert.ok(c[side].latencyMs !== null && c[side].tokens !== null && c[side].costMicros! > 0);
    }
  }
  // the export is plain text without an id
  const text = f.chars.compareExport(f.auth, runId).text;
  assert.match(text, /V4 Pro/);
  assert.match(text, /V4\.1 Flash/);
  assert.ok(!text.includes(runId), 'no ids in the export');
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/, 'no uuid in the export');
});

test('a Flash review that comes back invalid is a recorded result (billed, not retried) and never stops the case', async (t) => {
  const f = fixture(t);
  f.behaviour.flash = 'invalid';
  const { runId } = f.start();
  await drain(f);
  const detail = f.chars.compareDetail(f.auth, runId);
  assert.equal(detail.run.done, COMPARE_CASES.length);
  assert.equal(detail.summary.flash.invalid, COMPARE_CASES.length);
  assert.equal(detail.summary.pro.invalid, 0);
  assert.ok(detail.cases.every((c) => c.flash.state === 'invalid' && c.pro.state === 'ok'));
  assert.equal(
    f.bodies.filter((b) => b.model === 'deepseek-flash' && b.tool === 'submit_dialogue_audit').length,
    COMPARE_CASES.length,
    'never retried',
  );
});

test('an UNKNOWN call is never retried and keeps its reservation; the next case still runs', async (t) => {
  const f = fixture(t);
  f.behaviour.flash = 'unknown';
  f.behaviour.onlyOrdinal = 1;
  const { runId } = f.start();
  const r = f.runner();
  await r.run(r.claim()!, signal());
  const first = f.store.get<{ status: string; error_code: string }>(
    'SELECT status,error_code FROM web_review_compare_cases WHERE run_id=? AND ordinal=1',
    runId,
  )!;
  assert.deepEqual([first.status, first.error_code], ['failed', 'COMPARE_CALL_UNKNOWN']);
  const flash = f.store.get<{ state: string }>(
    "SELECT state FROM web_review_compare_attempts WHERE run_id=? AND ordinal=1 AND phase='review_flash'",
    runId,
  )!;
  assert.equal(flash.state, 'unknown');
  const held = f.budget.summary()[0]!.heldMicros;
  assert.ok(held > 0, 'the money stays held');
  assert.equal(
    f.store.get<{ reserved: number }>(
      "SELECT reserved FROM web_external_budgets WHERE provider='deepseek' AND phase='review'",
    )!.reserved,
    1,
    'and so does the capacity ticket',
  );
  const fetchesFirst = f.events.filter((e) => e.endsWith(':1') && e.startsWith('fetch:')).length;
  assert.equal(fetchesFirst, 3, 'draft, Pro review and the one Flash attempt');
  // time passes, nothing resends it; the remaining cases run
  f.tick(600_000);
  await drain(f);
  assert.equal(f.events.filter((e) => e.endsWith(':1') && e.startsWith('fetch:')).length, 3, 'never retried');
  assert.equal(f.budget.summary()[0]!.heldMicros, held, 'the hold was never released');
  const detail = f.chars.compareDetail(f.auth, runId);
  assert.equal(detail.cases[0]!.flash.state, 'unknown');
  assert.equal(detail.cases[0]!.pro.state, 'ok', "Pro's result for that case is kept");
  assert.equal(detail.summary.flash.unknown, 1);
  assert.equal(detail.run.failed, 1);
  assert.equal(detail.run.done, COMPARE_CASES.length - 1);
});

test('marks are saved with the run; permissions: only the owner or preview on every character may start or mark', async (t) => {
  const f = fixture(t);
  const { runId } = f.start();
  await drain(f, 2);
  const mark = (auth = f.auth, mark: string | null = 'better') =>
    f.chars.compareMark(auth, { runId, ordinal: 1, side: 'flash', mark });
  mark();
  mark(f.auth, 'worse');
  assert.equal(f.chars.compareDetail(f.auth, runId).cases[0]!.flash.mark, 'worse');
  assert.equal(f.chars.compareDetail(f.auth, runId).cases[0]!.pro.mark, null);
  mark(f.auth, null);
  assert.equal(f.chars.compareDetail(f.auth, runId).cases[0]!.flash.mark, null);
  assert.throws(() => mark(f.auth, 'great'), /INVALID_REQUEST/);

  // one character's preview grant may read the comparison but not start a run or mark
  const scoped = f.member(['characters.preview:wei-guagua'], 'Scoped');
  assert.equal(f.chars.compareDetail(scoped, runId).run.cases, COMPARE_CASES.length);
  assert.throws(
    () => f.chars.compareStart(scoped, { requestId: 'scoped-1', confirmPaidCalls: COMPARE_CASES.length * 3 }),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  assert.throws(() => mark(scoped), /ADMIN_PERMISSION_REQUIRED/);
  // someone with no preview grant at all cannot even read it
  const reader = f.member(['characters.read:*'], 'Reader');
  assert.throws(() => f.chars.compareList(reader), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(
    () => f.chars.compareStart(reader, { requestId: 'reader-1', confirmPaidCalls: COMPARE_CASES.length * 3 }),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  // preview on every character may start
  const wide = f.member(['characters.preview:*'], 'Wide');
  assert.doesNotThrow(() => mark(wide, 'same'));
  assert.equal(f.store.all('SELECT 1 FROM web_review_compare_runs').length, 1, 'nothing was queued by a refused call');
});

test('a 预演 proof records which reviewer made it, and a publish accepts a valid proof from EITHER reviewer', async (t) => {
  for (const reviewer of ['deepseek-v4-pro', 'deepseek-flash']) {
    const f = fixture(t);
    const now = f.clock.now();
    installReviewModelSchema(f.store, now);
    // The owner's switch is tested elsewhere; here the setting row is set directly so the 预演 is frozen with this reviewer.
    f.store.run('UPDATE web_review_model_setting SET review_model=?', reviewer);
    const profile = f.chars.detail(f.auth, 'wei-guagua').published!.profile;
    // The operator-approved welcome and footer audio of the published voice (an unchanged voice and welcome are reused).
    const binding = f.store.get<{ voice_version: string }>(
      "SELECT voice_version FROM web_provider_voice_bindings WHERE character_id='wei-guagua' AND source='user_selected' AND approved=1",
    )!;
    const audio = Buffer.from('synthetic');
    f.store.run(
      `INSERT INTO web_provider_welcome_assets(character_id,voice_version,text_version,body,media_id,origin,sha256,byte_length,duration_ms,audio_bytes,created_at)
      VALUES ('wei-guagua',?,?,?,'welcome-media','operator_approved',?,?,1000,?,?)`,
      binding.voice_version,
      profile.presentation.welcome.version,
      profile.presentation.welcome.text,
      'a'.repeat(64),
      audio.length,
      audio,
      now,
    );
    f.store.run(
      `INSERT INTO web_provider_footer_assets(character_id,voice_version,media_id,origin,body,sha256,byte_length,duration_ms,audio_bytes,created_at)
      VALUES ('wei-guagua',?,'footer-media','operator_approved','x',?,?,1000,?,?)`,
      binding.voice_version,
      'b'.repeat(64),
      audio.length,
      audio,
      now,
    );
    profile.template.version++;
    profile.template.persona += `；${reviewer}`;
    const saved = f.chars.save(f.auth, 'wei-guagua', { expectedRevision: null, profile });
    const job = f.chars.startPreview(f.auth, 'wei-guagua', {
      requestId: `proof-${reviewer}`,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      relationship: 'friend',
      message: '今天好吗',
    });
    await f.runner().run(f.runner().claim()!, signal());
    const status = f.chars.previewStatus(f.auth, 'wei-guagua', job.previewId);
    assert.equal(status.status, 'succeeded', JSON.stringify(status));
    assert.equal(status.reviewer, reviewer, 'the proof records which reviewer ran it');
    assert.deepEqual(
      f.bodies.map((b) => b.model),
      ['deepseek-flash', reviewer],
    );
    const attempts = f.store.all<{ phase: string; model: string }>(
      'SELECT phase,model FROM web_character_preview_attempts WHERE preview_id=? ORDER BY phase',
      job.previewId,
    );
    assert.deepEqual(
      attempts.map((a) => [a.phase, a.model]),
      [
        ['draft', 'deepseek-flash'],
        ['review', reviewer],
      ],
    );
    // a later switch never rewrites the reviewer a proof was frozen with
    f.store.run(
      'UPDATE web_review_model_setting SET review_model=?',
      reviewer === 'deepseek-flash' ? 'deepseek-v4-pro' : 'deepseek-flash',
    );
    assert.equal(f.chars.previewStatus(f.auth, 'wei-guagua', job.previewId).reviewer, reviewer);
    const published = f.chars.publish(f.auth, 'wei-guagua', {
      requestId: `publish-${reviewer}`,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      previewId: job.previewId,
      acknowledgeReview: true,
    });
    assert.ok(published.version > 1, `a proof made with ${reviewer} publishes`);
  }
});
