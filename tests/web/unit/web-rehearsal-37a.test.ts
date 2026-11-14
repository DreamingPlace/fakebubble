import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
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

test('37a columns: DeepSeek·现行 next to DeepSeek·新 on one run, the live switch is ignored, 新 sends the plain draft and the guard', async (t) => {
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
      ['deepseek', 'deepseek', 'v7', 'DeepSeek·现行'],
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
  // 现行 is untouched: tool call drafts; 新 drafts are plain completions at 0.9, the second pass is the guard on the house reviewer.
  const plain = f.sent.filter((s) => s.plain);
  assert.equal(plain.length, 2 * 8);
  assert.ok(plain.every((s) => s.temperature === 0.9));
  assert.deepEqual([...new Set(plain.map((s) => `${s.provider}:${s.model}`))].sort(), [
    'deepseek:deepseek-flash',
    'gemini:gemini-3.8-flash',
  ]);
  const guards = f.sent.filter((s) => s.guard);
  assert.equal(guards.length, 2 * 8);
  assert.ok(guards.every((s) => s.provider === 'deepseek' && s.model === 'deepseek-v4-pro'));
  assert.equal(
    f.sent.filter((s) => s.tool === 'draft' && !s.plain).length,
    8,
    'only the 现行 column drafts with a tool',
  );
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

test('37a columns: the estimate follows the columns, 新 costs less to write than 现行, and a changed column set needs a fresh confirmation', (t) => {
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

test('37a columns: a run stored before this Part (a model key without a writer) still reads as 现行', async (t) => {
  const f = fixture(t);
  const { runId } = f.start({ models: ['deepseek'] });
  await drain(f);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.deepEqual(
    detail.columns.map((c) => [c.key, c.writer, c.label]),
    [['deepseek', 'v7', 'DeepSeek·现行']],
  );
  assert.equal(
    f.store.get<{ models_json: string }>('SELECT models_json FROM web_rehearsal_runs')!.models_json,
    '["deepseek"]',
  );
});
