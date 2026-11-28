import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
  REHEARSAL_STYLE_PROMPT_SHA256,
  REHEARSAL_VERDICT_PROMPT_SHA256,
  REHEARSAL_JUDGE_PROMPTS,
  REHEARSAL_STYLE_PROMPT,
  parseHints,
  parseStyleVerdict,
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
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
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
    styleUnknown: false,
    styleBad: false,
  };
  let styleCalls = 0;
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
      const which =
        input.systemSha256 === REHEARSAL_HINT_PROMPT_SHA256
          ? 'hint'
          : input.systemSha256 === REHEARSAL_STYLE_PROMPT_SHA256
            ? 'style'
            : 'verdict';
      const row = store.get<{ seq: number }>("SELECT seq FROM web_rehearsal_units WHERE status='generating'")!;
      events.push(`judge:${which}:${row.seq}`);
      judged.push(`${which}:${input.model}`);
      if (which === 'style') {
        if (behaviour.styleUnknown) throw new Error('offline network interrupted');
        const n = (JSON.parse(input.user) as { turns: unknown[] }).turns.length;
        const call = styleCalls++;
        // The first column judged is told it shares its own life every time, the second never; topics every 4th, emotion always.
        const text = behaviour.styleBad
          ? '{"own":[true]}'
          : JSON.stringify({
              own: Array.from({ length: n }, () => call === 0),
              topic: Array.from({ length: n }, (_, i) => i % 4 === 0),
              emotion: Array.from({ length: n }, () => true),
            });
        return { text, inputTokens: 500, outputTokens: 80, model: input.model, receipt: { id: 'judge-fixture' } };
      }
      if (which === 'verdict' && behaviour.verdictUnknown) throw new Error('offline network interrupted');
      const text =
        which === 'hint'
          ? JSON.stringify({ hints: ['那次你们回家路上怎么样', '还记得上次吗'], negative: '你生日哪天' })
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

// ---- Part 37a-3 --------------------------------------------------------------------------------------------------------------

const ADDENDA = {
  deepseek: PROMPTS_V8.writerAddendumDeepseek,
  gemini: PROMPTS_V8.writerAddendumGemini,
  xai: PROMPTS_V8.writerAddendumGrok,
} as const;

test('37a-3 addendum: each 新 column sends its own model addendum in the draft, and the guard never gets one', async (t) => {
  const f = fixture(t);
  f.start({ models: ['deepseek-v8', 'gemini-v8', 'xai-v8'] });
  assert.equal(await drain(f), 3 * 8);
  for (const provider of ['deepseek', 'gemini', 'xai'] as const) {
    const drafts = f.sent.filter((s) => s.provider === provider && s.plain);
    assert.equal(drafts.length, 8, provider);
    for (const call of drafts) {
      const system = (JSON.parse(call.user) as Array<{ role: string; content: string }>)[0]!.content;
      for (const [other, text] of Object.entries(ADDENDA))
        assert.equal(system.includes(text), other === provider, `${provider} draft: ${other} addendum`);
    }
    for (const call of f.sent.filter((s) => s.provider === 'deepseek' && s.guard))
      for (const text of Object.values(ADDENDA)) assert.ok(!call.user.includes(text), 'the guard has no addendum');
  }
});

test('37a-3 addendum: a 旧 column is untouched (the v7 prompt carries no addendum)', async (t) => {
  const f = fixture(t);
  f.start({ models: ['deepseek'] });
  await drain(f);
  assert.ok(f.sent.length > 0);
  for (const call of f.sent) for (const text of Object.values(ADDENDA)) assert.ok(!call.user.includes(text));
});

test('37a-3 style counts: the judge reads each column once, reserved first, and the table keeps 以问句结尾', async (t) => {
  const f = fixture(t);
  const body = { models: ['deepseek', 'deepseek-v8'] };
  const off = f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input(body));
  const on = f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ ...body, style: true }));
  assert.equal(on.judgeCalls, off.judgeCalls + 2, 'one style call per column');
  assert.ok(on.totalMicros > off.totalMicros, 'the style calls are in the total the administrator confirms');
  assert.throws(
    () =>
      f.chars.rehearsalStart(f.auth, CHARACTER, {
        ...f.input({ ...body, style: true }),
        requestId: 'rehearsal-style-1',
        acknowledgeMicros: off.totalMicros,
      }),
    { code: 'REHEARSAL_ESTIMATE_CHANGED' },
  );
  const { runId } = f.start({ ...body, style: true });
  await drain(f);
  assert.deepEqual(
    f.judged.filter((j) => j.startsWith('style')),
    ['style:deepseek-v4-pro', 'style:deepseek-v4-pro'],
    'once per column, on the house reviewer',
  );
  f.events.forEach((event, i) => {
    if (event.startsWith('judge:style'))
      assert.match(f.events[i - 1]!, /^reserve:judge:/, 'reserved before it is sent');
  });
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  const [old, next] = detail.columns;
  assert.deepEqual(old!.style, { state: 'judged', sharedOwn: 8, startedTopic: 2, showedEmotion: 8 });
  assert.deepEqual(next!.style, { state: 'judged', sharedOwn: 0, startedTopic: 2, showedEmotion: 8 });
  for (const c of detail.columns) {
    assert.equal(typeof c.counts.endsWithQuestion, 'number', 'the question count is still there');
    assert.equal(c.counts.replies, 8);
  }
  // No content leaves with the counts: the unit stores flags only.
  const stored = f.store.all<{ result_json: string }>(
    "SELECT result_json FROM web_rehearsal_units WHERE item_key='~style'",
  );
  assert.equal(stored.length, 2);
  for (const row of stored) assert.match(row.result_json, /^\{"own":\[(true|false)(,(true|false))*\],/);
});

test('37a-3 style counts: a run that did not ask for them has none, and judges nothing', async (t) => {
  const f = fixture(t);
  const { runId } = f.start({ models: ['deepseek', 'deepseek-v8'] });
  await drain(f);
  assert.equal(f.judged.length, 0);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  for (const c of detail.columns)
    assert.deepEqual(c.style, { state: 'none', sharedOwn: null, startedTopic: null, showedEmotion: null });
  assert.throws(() => f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ style: 'yes' })), {
    code: 'INVALID_REQUEST',
  });
});

test('37a-3 style counts: an answer of the wrong shape is a failure without a count, never a guess', async (t) => {
  const f = fixture(t);
  f.behaviour.styleBad = true;
  const { runId } = f.start({ models: ['deepseek-v8'], style: true });
  await drain(f);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.deepEqual(detail.columns[0]!.style, {
    state: 'failed',
    sharedOwn: null,
    startedTopic: null,
    showedEmotion: null,
  });
  assert.equal(detail.columns[0]!.counts.replies, 8, 'the reply counts are unaffected');
  assert.equal(f.judged.filter((j) => j.startsWith('style')).length, 1, 'never retried');
});

test('37a-3 style counts: an UNKNOWN judge call keeps its hold, is never resent, and the column reads 未确认', async (t) => {
  const f = fixture(t);
  f.behaviour.styleUnknown = true;
  const { runId } = f.start({ models: ['deepseek-v8'], style: true });
  await drain(f);
  await drain(f);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.equal(detail.columns[0]!.style.state, 'unconfirmed');
  assert.equal(f.judged.filter((j) => j.startsWith('style')).length, 1, 'sent once');
  const call = f.store.get<{ state: string; held_micros: number }>(
    "SELECT state,held_micros FROM web_rehearsal_calls WHERE phase='judge'",
  )!;
  assert.equal(call.state, 'unknown');
  assert.ok(call.held_micros > 0, 'the hold is kept');
});

test('37a-3 style judge prompt: pinned, known to the generation Worker, and its shape is checked by code', () => {
  assert.equal(
    REHEARSAL_STYLE_PROMPT_SHA256,
    createHash('sha256').update(REHEARSAL_STYLE_PROMPT, 'utf8').digest('hex'),
  );
  assert.equal(REHEARSAL_JUDGE_PROMPTS[REHEARSAL_STYLE_PROMPT_SHA256], REHEARSAL_STYLE_PROMPT);
  for (const word of ['自己的事', '话题', '情绪']) assert.ok(REHEARSAL_STYLE_PROMPT.includes(word));
  assert.deepEqual(parseStyleVerdict('{"own":[true,false],"topic":[false,false],"emotion":[true,true]}', 2), {
    own: [true, false],
    topic: [false, false],
    emotion: [true, true],
  });
  for (const bad of [
    '{"own":[true],"topic":[false],"emotion":[true]}',
    '{"own":[1,0],"topic":[false,false],"emotion":[true,true]}',
    '{"own":[true,false],"topic":[false,false]}',
    '{"own":[true,false],"topic":[false,false],"emotion":[true,true],"x":1}',
    'not json',
  ])
    assert.equal(parseStyleVerdict(bad, 2), null, bad);
});
