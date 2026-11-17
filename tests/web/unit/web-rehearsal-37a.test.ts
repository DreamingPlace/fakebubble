import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { publishedWebCharacters } from '../../../apps/server/characters/web-character-catalog.ts';
import { writerRoster } from '../../../apps/server/generation/writer-roster.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { WebCharacterPreviews } from '../../../apps/server/characters/web-character-preview.ts';
import {
  WebCharacterPreviewRunner,
  type WebPreviewBudget,
} from '../../../apps/server/characters/web-character-preview-runner.ts';
import type { RehearsalJudgeModel } from '../../../apps/server/characters/web-rehearsal-runner.ts';
import {
  REHEARSAL_HINT_PROMPT_SHA256,
  REHEARSAL_VERDICT_PROMPT_SHA256,
  parseHints,
  parseVerdict,
} from '../../../apps/server/characters/web-rehearsal-prompts.ts';
import { NEW_PLAYER_RELATIONSHIP } from '../../../packages/contracts/relationships.ts';
import { rehearsalRequest } from '../../../apps/server/characters/web-rehearsal-request.ts';
import {
  DEFAULT_PHRASES,
  countReplies,
  endsWithQuestion,
  repeatedReplies,
  unaskedAdvice,
} from '../../../apps/server/characters/web-rehearsal-analysis.ts';
import { builtinSets, memeItems, memeTurnPlan } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import {
  configureWebProvider,
  renewProviderPrices,
} from '../../../apps/server/generation/web-provider-configuration.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import { textPolicyHash } from '../../../apps/server/generation/text-generation-policy.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import { normalizeCastDoc } from '../../../apps/server/cast/cast-validation.ts';
import { sampleCastRaw } from '../fixtures/cast-sample.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { wire } from '../fixtures/model-choice.ts';
import { acceptedAuditEnvelope, auditReply, draftWire, draftEnvelope } from '../../text-fixtures.ts';
import { counterIds } from '../fixtures/cast-sample.ts';

const ORIGIN = 'https://fixture.invalid';
const CHARACTER = 'wei-guagua';
const signal = () => new AbortController().signal;

/** A cast of the sample's shape whose first character is the one under test (its memes and stories come with it). */
function castWithCharacter() {
  const raw = JSON.parse(JSON.stringify(sampleCastRaw()).replaceAll('"c01"', `"${CHARACTER}"`));
  return normalizeCastDoc(raw, { known: new Set(), fresh: counterIds() });
}

function fixture(t: test.TestContext, options: { cast?: boolean } = {}) {
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
  store.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'rehearsal-instance')");
  migrateWebProviderOffline(store);
  store.db.exec(readFileSync(new URL('129_cast.sql', folder), 'utf8'));
  const selected = syntheticSelection();
  for (const item of selected)
    store.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      item.characterId,
      item.personaVersion,
      JSON.stringify(item.template),
    );
  configureWebProvider(store as unknown as WebRuntimeStore, selected, now);
  // the prices, spending bounds and capacity tickets of Grok and Gemini (renew-prices), and the player-model ceiling
  renewProviderPrices(store as unknown as WebRuntimeStore, now);
  Object.assign(store, { playerModelChoice: ['deepseek', 'gemini', 'xai'] });
  if (options.cast !== false)
    store.run('UPDATE web_cast_draft SET doc_json=? WHERE singleton=1', JSON.stringify(castWithCharacter()));
  const admin = new WebAccountAdmin(store, clock, ORIGIN);
  installWebCharacterCatalog(store);
  const chars = new WebCharacterAdmin(store, clock, admin);
  chars.enablePreviews(new WebCharacterPreviews(store, clock));
  const login = admin.login(admin.issueLoginGrant().token, ORIGIN);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  const member = (permissions: string[], label: string) => {
    const grant = admin.issueMember(login.cookie, login.csrf, ORIGIN, {
      requestId: `issue-${label}`,
      label,
      memberId: null,
      permissions,
    });
    const next = admin.login(grant.token, ORIGIN);
    return { cookie: next.cookie, csrf: next.csrf, origin: ORIGIN };
  };
  const profile = chars.detail(auth, CHARACTER).published!.profile;
  profile.template.version++;
  profile.template.persona += '（多轮预演）';
  const saved = chars.save(auth, CHARACTER, { expectedRevision: null, profile });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rehearsal-'))),
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
  const sent: Array<{
    provider: string;
    model: string;
    tool: string;
    user: string;
    plain: boolean;
    guard: boolean;
    temperature: unknown;
  }> = [];
  const behaviour = {
    unknown: null as null | { provider: string; turn: number },
    hintsBad: false,
    verdictUnknown: false,
  };
  const unitOfRequest = () =>
    store.get<{ request_json: string; model_key: string; turn: number; seq: number }>(
      "SELECT request_json,model_key,turn,seq FROM web_rehearsal_units WHERE status='generating'",
    )!;
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    keys: { xai: 'offline-x', gemini: 'offline-g' },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init!.body));
      const provider = String(url).includes('x.ai')
        ? 'xai'
        : String(url).includes('googleapis')
          ? 'gemini'
          : 'deepseek';
      // Part 37a: a 新 column's draft is a plain completion (no tools) and its second pass is the guard tool.
      const tool = !body.tools
        ? 'draft'
        : (body.tools[0].function.name as string) === 'submit_dialogue_draft'
          ? 'draft'
          : 'review';
      const row = unitOfRequest();
      events.push(`fetch:${provider}:${body.model}:${tool}:${row.model_key}:${row.turn}`);
      sent.push({
        provider,
        model: body.model,
        tool,
        user: JSON.stringify(body.messages),
        plain: !body.tools,
        guard: body.tools?.[0].function.name === 'submit_reply_check',
        temperature: body.temperature,
      });
      const request = JSON.parse(row.request_json);
      if (behaviour.unknown && behaviour.unknown.provider === provider && behaviour.unknown.turn === row.turn)
        throw new Error('offline network interrupted');
      if (!body.tools) {
        const content = `第${row.turn}轮：行啊\n晚点再说`;
        const message = { role: 'assistant', content };
        const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
        return Response.json({ id: 'plain', model: body.model, choices: [{ finish_reason: 'stop', message }], usage });
      }
      if (body.tools[0].function.name === 'submit_reply_check') {
        const properties = body.tools[0].function.parameters.properties;
        const answer = {
          fixes: [],
          mode: 'casual',
          endsSession: false,
          topics: [],
          factOps: [],
          ...(properties.sceneUpdate ? { sceneUpdate: null } : {}),
          ...(properties.relationshipEvents ? { relationshipEvents: [] } : {}),
        };
        return Response.json({
          id: 'guard',
          model: body.model,
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'c',
                    type: 'function',
                    function: { name: 'submit_reply_check', arguments: JSON.stringify(answer) },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 100,
          },
        });
      }
      if (tool === 'review') return Response.json(acceptedAuditEnvelope(request));
      if (provider === 'xai') return Response.json(wire.xai('submit_dialogue_draft', draftWire(request)));
      if (provider === 'gemini') return Response.json(wire.gemini('submit_dialogue_draft', draftWire(request)));
      return Response.json(draftEnvelope(request));
    },
  });
  const authority: WebPreviewBudget = {
    reserve: (id, provider, fingerprint, micros) => {
      const parts = JSON.parse(id) as unknown[];
      events.push(`reserve:${parts[4]}:${parts[3]}`);
      return budget.reserve(id, provider, fingerprint, micros);
    },
    settle: (...args) => budget.settle(...args),
  };
  const judged: string[] = [];
  const judge: RehearsalJudgeModel = {
    async completeJson(input, _signal, authorize) {
      await authorize?.();
      const which = input.systemSha256 === REHEARSAL_HINT_PROMPT_SHA256 ? 'hint' : 'verdict';
      const row = store.get<{ seq: number }>("SELECT seq FROM web_rehearsal_units WHERE status='generating'")!;
      events.push(`judge:${which}:${row.seq}`);
      judged.push(`${which}:${input.model}`);
      if (which === 'verdict' && behaviour.verdictUnknown) throw new Error('offline network interrupted');
      const item = JSON.parse(input.user) as { key?: string; item?: { key?: string; title?: string } };
      const text =
        which === 'hint'
          ? behaviour.hintsBad
            ? JSON.stringify({ hints: [`提到${item.key}`, '随便一句'], negative: '另一句' })
            : JSON.stringify({ hints: ['那次你们回家路上怎么样', '还记得上次吗'], negative: '你生日哪天' })
          : JSON.stringify({ hints: [true, false], negative: false, ownSide: true });
      return { text, inputTokens: 500, outputTokens: 80, model: input.model, receipt: { id: 'judge-fixture' } };
    },
  };
  const runner = () => {
    const r = new WebCharacterPreviewRunner(store, clock, generator, authority);
    r.useRehearsalJudge(judge);
    return r;
  };
  const input = (over: Record<string, unknown> = {}) => ({
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    source: { kind: 'set', set: 'chat' },
    models: ['deepseek', 'gemini', 'xai'],
    withCast: false,
    ...over,
  });
  let n = 0;
  const start = (over: Record<string, unknown> = {}, requestId = `rehearsal-${String(++n).padStart(4, '0')}`) => {
    const body = input(over);
    const estimate = chars.rehearsalEstimate(auth, CHARACTER, body);
    return chars.rehearsalStart(auth, CHARACTER, { ...body, requestId, acknowledgeMicros: estimate.totalMicros });
  };
  return {
    store,
    chars,
    auth,
    member,
    budget,
    events,
    sent,
    judged,
    behaviour,
    runner,
    input,
    start,
    saved,
    tick: (ms: number) => {
      now += ms;
    },
  };
}
async function drain(f: ReturnType<typeof fixture>, limit = 400) {
  const r = f.runner();
  let n = 0;
  for (let claim = r.claim(); claim && n < limit; claim = r.claim(), n++) await r.run(claim, signal());
  return n;
}

// ---- Part 37a: columns are (model, writer) -------------------------------------------------------------------------------

test('37a columns: DeepSeek·旧 next to DeepSeek·新 on one run, the live switch is ignored, 新 sends the plain draft and the guard', async (t) => {
  const f = fixture(t);
  // The live switch says 新, the columns say what they say: a rehearsal never reads it.
  const columns = ['deepseek', 'deepseek-v8', 'gemini-v8'];
  const { runId } = f.start({ models: columns });
  assert.equal(await drain(f), 3 * 8);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.deepEqual(detail.run.models, columns);
  assert.deepEqual(
    detail.columns.map((c) => [c.key, c.model, c.writer, c.label]),
    [
      ['deepseek', 'deepseek', 'v7', 'DeepSeek·旧'],
      ['deepseek-v8', 'deepseek', 'v8', 'DeepSeek·新'],
      ['gemini-v8', 'gemini', 'v8', 'Gemini 3.8 Flash·新'],
    ],
  );
  const request = (key: string) =>
    JSON.parse(
      f.store.get<{ request_json: string }>(
        "SELECT request_json FROM web_rehearsal_units WHERE kind='cell' AND model_key=? AND turn=1",
        key,
      )!.request_json,
    );
  assert.equal(request('deepseek').relationship, 'new');
  assert.equal(request('deepseek').writer, undefined);
  assert.equal(request('deepseek-v8').writer, 'v8');
  assert.equal('relationship' in request('deepseek-v8'), false);
  // 旧 is untouched: tool call drafts; 新 drafts are plain completions at the per-provider temperature, the second pass is the guard on the house reviewer.
  const plain = f.sent.filter((s) => s.plain);
  assert.equal(plain.length, 2 * 8);
  assert.ok(plain.every((s) => s.temperature === (s.provider === 'deepseek' ? 1.3 : 1)));
  assert.deepEqual([...new Set(plain.map((s) => `${s.provider}:${s.model}`))].sort(), [
    'deepseek:deepseek-flash',
    'gemini:gemini-3.8-flash',
  ]);
  const guards = f.sent.filter((s) => s.guard);
  assert.equal(guards.length, 2 * 8);
  assert.ok(guards.every((s) => s.provider === 'deepseek' && s.model === 'deepseek-v4-pro'));
  assert.equal(f.sent.filter((s) => s.tool === 'draft' && !s.plain).length, 8, 'only the 旧 column drafts with a tool');
  // The 新 columns say what the model wrote, line by line, in text; they carry no "answered every message" claim.
  for (const column of detail.columns.filter((c) => c.writer === 'v8')) {
    assert.ok(column.cells.every((c) => c.state === 'done' && c.answered === null));
    assert.deepEqual(column.cells[0]!.bubbles, ['第1轮：行啊', '晚点再说']);
    assert.equal(column.counts.answeredAll, null);
    assert.equal(column.counts.replies, 8);
  }
  assert.equal(detail.columns[0]!.counts.answeredAll, 8);
  // Money: every call reserved first, nothing left held.
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT sum(reserved) n FROM web_external_budgets')!.n, 0);
});

test('37a columns: the estimate follows the columns, 新 costs less to write than 旧, and a changed column set needs a fresh confirmation', (t) => {
  const f = fixture(t);
  const one = f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ models: ['deepseek'] }));
  const both = f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ models: ['deepseek', 'deepseek-v8'] }));
  const v8 = f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ models: ['deepseek-v8'] }));
  assert.deepEqual(both.models, ['deepseek', 'deepseek-v8']);
  assert.equal(both.replyCalls, one.replyCalls * 2);
  assert.equal(both.totalMicros, one.totalMicros + v8.totalMicros);
  assert.ok(v8.totalMicros > 0 && v8.totalMicros < one.totalMicros);
  assert.throws(
    () =>
      f.chars.rehearsalStart(f.auth, CHARACTER, {
        ...f.input({ models: ['deepseek', 'deepseek-v8'] }),
        requestId: 'rehearsal-9999',
        acknowledgeMicros: one.totalMicros,
      }),
    { code: 'REHEARSAL_ESTIMATE_CHANGED' },
  );
  // Unknown columns, repeats and a writer on an unknown model are refused.
  for (const models of [['deepseek-v9'], ['deepseek', 'deepseek'], ['nope-v8'], []])
    assert.throws(() => f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ models })), {
      code: 'INVALID_REHEARSAL_MODELS',
    });
});

test('37a columns: a run stored before this Part (a model key without a writer) still reads as 旧', async (t) => {
  const f = fixture(t);
  const { runId } = f.start({ models: ['deepseek'] });
  await drain(f);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.deepEqual(
    detail.columns.map((c) => [c.key, c.writer, c.label]),
    [['deepseek', 'v7', 'DeepSeek']],
  );
  assert.equal(
    f.store.get<{ models_json: string }>('SELECT models_json FROM web_rehearsal_runs')!.models_json,
    '["deepseek"]',
  );
});

// ---- Part 37a-2: 开场 (a welcome line with its 情境, then 5 follow-ups) --------------------------------------------------------

test('37a-2 开场: starts from the welcome line with its 情境; only the 新 column is told the note and the teammates', async (t) => {
  const f = fixture(t);
  const note = '弟弟家朋用你的账号在他的电话手表上加了玩家，你刚发现。这是你和玩家第一次说话。';
  const profile = f.chars.detail(f.auth, CHARACTER).draft!.profile;
  profile.presentation.welcomes[0]!.text = '家朋怎么又拿电话手表乱加人';
  profile.presentation.welcomes[0]!.context = note;
  const saved = f.chars.save(f.auth, CHARACTER, { expectedRevision: f.saved.revision, profile });
  // the note is part of the draft
  assert.equal(f.chars.detail(f.auth, CHARACTER).draft!.profile.presentation.welcomes[0]!.context, note);
  const body = f.input({
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    source: { kind: 'set', set: 'opening' },
    models: ['deepseek', 'deepseek-v8'],
  });
  const estimate = f.chars.rehearsalEstimate(f.auth, CHARACTER, body);
  assert.equal(estimate.turns, 5, 'five player follow-ups, below the 6 a script of your own needs');
  f.chars.rehearsalStart(f.auth, CHARACTER, {
    ...body,
    requestId: 'rehearsal-0501',
    acknowledgeMicros: estimate.totalMicros,
  });
  await drain(f);
  const units = f.store.all<{ request_json: string; model_key: string; turn: number }>(
    'SELECT request_json,model_key,turn FROM web_rehearsal_units ORDER BY model_key,turn',
  );
  assert.equal(units.filter((u) => u.model_key === 'deepseek-v8').length, 5);
  for (const unit of units) {
    const request = JSON.parse(unit.request_json) as { opening?: { text: string; context?: string }; roster?: unknown };
    assert.equal(request.opening?.text, '家朋怎么又拿电话手表乱加人');
    if (unit.model_key === 'deepseek-v8') {
      assert.equal(request.opening?.context, note, `turn ${unit.turn}: a young chat keeps the note`);
      assert.ok(Array.isArray(request.roster), 'a 新 column carries the teammates');
    } else {
      assert.ok(!('context' in request.opening!), '旧 never carries the note');
      assert.ok(!('roster' in request), '旧 never carries the roster');
    }
  }
  // a script of your own is still 6 to 20 turns
  assert.throws(() => f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ source: { kind: 'set', set: 'nope' } })), {
    code: 'INVALID_REHEARSAL_SOURCE',
  });
});

test('37a-2 roster: the other published characters in catalog order, cards only (name, aliases, one-liner), never the character itself', (t) => {
  const f = fixture(t);
  const catalog = f.store.all<{ character_id: string }>(
    'SELECT character_id FROM web_character_catalog ORDER BY position',
  );
  assert.ok(catalog.length >= 3, 'the fixture publishes several characters');
  const roster = writerRoster(f.store, CHARACTER);
  assert.deepEqual(
    roster.length,
    catalog.length - 1,
    'everybody else, whatever CAST_CONTEXT_ENABLED says (the fixture never turns it on)',
  );
  for (const card of roster) assert.deepEqual(Object.keys(card).sort(), ['aliases', 'name', 'oneLiner']);
  const names = roster.map((card) => card.name);
  const expected = publishedWebCharacters(f.store)
    .filter((entry) => entry.characterId !== CHARACTER)
    .map((entry) => entry.presentation.displayName);
  assert.deepEqual(names, expected, "the console's catalog order (no cast file published: the public names)");
  assert.ok(!JSON.stringify(roster).includes('persona'), 'no setting travels');
});

// ---- Part 40: columns in parallel, a 预演 is never starved, refusals ---------------------------------------------------------

test('40 parallel: the columns of a run are claimed side by side (at most 3, one call per column), a column keeps its turns in order', async (t) => {
  const f = fixture(t);
  const { runId } = f.start({ models: ['deepseek', 'deepseek-v8', 'gemini', 'xai'] });
  const r = f.runner();
  const first = [r.claim(), r.claim(), r.claim()];
  assert.ok(
    first.every((c) => c?.rehearsal),
    'three claims at once',
  );
  const keys = first.map(
    (c) =>
      f.store.get<{ model_key: string; turn: number }>(
        'SELECT model_key,turn FROM web_rehearsal_units WHERE run_id=? AND seq=?',
        runId,
        c!.rehearsal!.seq,
      )!,
  );
  assert.equal(new Set(keys.map((k) => k.model_key)).size, 3, 'three different columns');
  assert.ok(
    keys.every((k) => k.turn === 1),
    'each is on its first turn',
  );
  assert.equal(r.claim(), null, 'a fourth call waits: three in flight');
  // run them side by side
  await Promise.all(first.map((c) => r.run(c!, signal())));
  // the next claims: the fourth column's first turn, then second turns, never the same column twice at once
  const next = [r.claim(), r.claim(), r.claim()];
  const nextKeys = next.map(
    (c) =>
      f.store.get<{ model_key: string }>(
        'SELECT model_key FROM web_rehearsal_units WHERE run_id=? AND seq=?',
        runId,
        c!.rehearsal!.seq,
      )!.model_key,
  );
  assert.equal(new Set(nextKeys).size, 3);
  for (const c of next) await r.run(c!, signal());
  await drain(f);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.ok(detail.columns.every((c) => c.cells.every((cell) => cell.state === 'done')));
  assert.equal(f.store.get<{ n: number }>('SELECT sum(reserved) n FROM web_external_budgets')!.n, 0);
});

test('40 never starved: a 预演 of the administrator is claimed while 多轮预演 calls are in flight', async (t) => {
  const f = fixture(t);
  f.start({ models: ['deepseek', 'gemini'] });
  const r = f.runner();
  const flying = [r.claim(), r.claim()];
  assert.ok(flying.every((c) => c?.rehearsal));
  const preview = f.chars.startPreview(f.auth, CHARACTER, {
    requestId: 'preview-40-0001',
    draftRevision: f.saved.revision,
    profileHash: f.saved.contentHash,
    message: '你好呀',
  });
  const claimed = r.claim();
  assert.ok(claimed && !claimed.rehearsal && !claimed.compare, 'the preview is taken first');
  assert.equal(claimed.id, preview.previewId);
  // another preview waits for this one (one at a time), but the rehearsal calls in flight do not count against it
  for (const c of flying) await r.run(c!, signal());
});

test('40 refusals: a refusal waiting cannot lift fails the cell at once with its code; capacity full only waits', async (t) => {
  const f = fixture(t);
  const { runId } = f.start({ models: ['gemini'] });
  const r = f.runner();
  // capacity full right now: nothing sent, the cell goes back and waits (retry later), no code, not failed
  f.store.run(
    "UPDATE web_external_budgets SET reserved=capacity WHERE provider='gemini' AND stage='text' AND phase='draft'",
  );
  const waiting = r.claim()!;
  await r.run(waiting, signal());
  const unit = (seq: number) =>
    f.store.get<{ status: string; error_code: string | null; retry_at: number }>(
      'SELECT status,error_code,retry_at FROM web_rehearsal_units WHERE run_id=? AND seq=?',
      runId,
      seq,
    )!;
  assert.deepEqual([unit(waiting.rehearsal!.seq).status, unit(waiting.rehearsal!.seq).error_code], ['queued', null]);
  assert.equal(f.sent.length, 0);
  assert.equal(r.claim(), null, 'it is not retried before its time');
  f.store.run("UPDATE web_external_budgets SET reserved=0 WHERE provider='gemini' AND stage='text' AND phase='draft'");
  // no ticket row: not temporary, the cell fails at once with its code
  f.store.run("DELETE FROM web_external_budgets WHERE provider='gemini' AND stage='text' AND phase='draft'");
  f.tick(11_000);
  const refused = r.claim()!;
  await r.run(refused, signal());
  assert.deepEqual(
    [unit(refused.rehearsal!.seq).status, unit(refused.rehearsal!.seq).error_code],
    ['failed', 'WEB_PROVIDER_CAPACITY_MISSING'],
  );
  assert.equal(f.sent.length, 0, 'nothing was sent');
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.equal(detail.columns[0]!.cells[0]!.errorCode, 'WEB_PROVIDER_CAPACITY_MISSING');
  assert.equal(detail.columns[0]!.counts.failed, 1);
  assert.equal(detail.columns[0]!.counts.codes.WEB_PROVIDER_CAPACITY_MISSING, 1);
});
