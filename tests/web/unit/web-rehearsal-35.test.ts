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
  const sent: Array<{ provider: string; model: string; tool: string; user: string }> = [];
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
      const tool = (body.tools[0].function.name as string) === 'submit_dialogue_draft' ? 'draft' : 'review';
      const row = unitOfRequest();
      events.push(`fetch:${provider}:${body.model}:${tool}:${row.model_key}:${row.turn}`);
      sent.push({ provider, model: body.model, tool, user: JSON.stringify(body.messages) });
      const request = JSON.parse(row.request_json);
      if (behaviour.unknown && behaviour.unknown.provider === provider && behaviour.unknown.turn === row.turn)
        throw new Error('offline network interrupted');
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

// ---- pure parts ----------------------------------------------------------------------------------------------------------

test('built-in sets: 日常闲聊 and 重复检测 are 6 to 20 turns, there is no 连发 set, and the 梗与故事 plan never repeats an item back to back', () => {
  const sets = builtinSets();
  assert.deepEqual(
    sets.map((s) => s.label),
    ['日常闲聊', '重复检测'],
  );
  for (const set of sets) assert.ok(set.turns.length >= 6 && set.turns.length <= 20, set.label);
  const plan = memeTurnPlan(['a', 'b', 'c']);
  assert.equal(plan.length, 9);
  for (let i = 1; i < plan.length; i++) assert.notEqual(plan[i]!.item, plan[i - 1]!.item);
  for (const item of ['a', 'b', 'c']) {
    const mine = plan.filter((p) => p.item === item);
    assert.deepEqual(
      mine.map((p) => p.role),
      ['hint', 'negative', 'hint'],
    );
  }
});

test('hint rules are checked by code: no key word, no name, two different hints and a look-alike, each short', () => {
  const ok = JSON.stringify({ hints: ['那次淋雨的事', '还记得海边吗'], negative: '你生日哪天' });
  assert.ok(parseHints(ok, ['落汤鸡', '林小满']));
  assert.equal(
    parseHints(JSON.stringify({ hints: ['你这个落汤鸡', '还记得海边吗'], negative: '你生日哪天' }), ['落汤鸡']),
    null,
  );
  assert.equal(
    parseHints(JSON.stringify({ hints: ['小满那次', '还记得海边吗'], negative: '你生日哪天' }), ['小满']),
    null,
  );
  assert.equal(parseHints(JSON.stringify({ hints: ['一样', '一样'], negative: '不同' }), []), null);
  assert.equal(parseHints(JSON.stringify({ hints: ['甲', '乙'], negative: 'x'.repeat(50) }), []), null);
  assert.equal(parseHints('not json', []), null);
  assert.ok(parseHints('```json\n' + ok + '\n```', []));
  assert.deepEqual(parseVerdict('{"hints":[true,false],"negative":false,"ownSide":null}'), {
    hints: [true, false],
    negative: false,
    ownSide: null,
  });
  assert.equal(parseVerdict('{"hints":[true],"negative":false,"ownSide":null}'), null);
});

test('counts: answers, unasked advice, trailing question, length, customer-service phrases and repetition are computed by code', () => {
  const r = (player: string, bubbles: string[], answered = true) => ({ player, bubbles, answered });
  assert.equal(endsWithQuestion(['好呀', '你呢？']), true);
  assert.equal(endsWithQuestion(['好呀', '你呢']), true);
  assert.equal(endsWithQuestion(['好呀～']), false);
  assert.equal(unaskedAdvice(r('今天好累', ['那你早点睡吧']), DEFAULT_PHRASES.advice), true);
  assert.equal(unaskedAdvice(r('我该怎么办，好累', ['那你早点睡吧']), DEFAULT_PHRASES.advice), false, 'asked for it');
  const same = ['今天天气真的很不错呢', '我也是这么觉得的呀'];
  const counts = countReplies(
    [r('嗨', same), r('在吗', ['有什么可以帮你的吗？']), r('hi', same, false), r('哈', ['嗯嗯', '好的'])],
    { customerService: [...DEFAULT_PHRASES.customerService], advice: [...DEFAULT_PHRASES.advice] },
    { unconfirmed: 1, failed: 0 },
  );
  assert.equal(counts.replies, 4);
  assert.equal(counts.answeredAll, 3);
  assert.equal(counts.endsWithQuestion, 1);
  assert.equal(counts.customerService, 1);
  assert.equal(counts.repeated, 1, 'the third reply repeats the first');
  assert.equal(counts.unconfirmed, 1);
  assert.equal(counts.avgBubbles, 1.8);
  assert.equal(
    repeatedReplies([r('你好呀今天', ['今天天气真的很不错呢']), r('今天天气真的很不错呢', ['今天天气真的很不错呢'])]),
    0,
    'an echo of the player is not a repeat',
  );
});

test('every request starts like a new player: the new-player relationship, no relationship context, no memory, an isolated scope', (t) => {
  const f = fixture(t);
  const { runId } = f.start();
  const row = f.store.get<{ frozen_json: string }>('SELECT frozen_json FROM web_rehearsal_runs WHERE id=?', runId)!;
  const players = ['嗨', '在干嘛', '吃了吗', '周末呢', '好累', '晚安'];
  const request = rehearsalRequest(JSON.parse(row.frozen_json), runId, 'deepseek', 3, players, [
    ['你好呀'],
    ['在发呆'],
  ]);
  assert.equal(request.relationship, NEW_PLAYER_RELATIONSHIP);
  assert.equal(NEW_PLAYER_RELATIONSHIP, 'new');
  assert.equal(request.relationshipContext, undefined);
  assert.equal(request.memories, undefined);
  assert.equal(request.playerFacts, undefined);
  assert.ok(request.scope.worldId.startsWith('admin-rehearsal-'));
  assert.deepEqual(request.requiredMessageIds, ['p3']);
  assert.deepEqual(
    request.messages.map((m) => `${m.authorKind}:${m.text}`),
    ['player:嗨', 'character:你好呀', 'player:在干嘛', 'character:在发呆', 'player:吃了吗'],
  );
  assert.doesNotThrow(() => promptMessages(request));
  // a long conversation keeps the last 24 messages; the welcome line only while nothing was cut
  const many = Array.from({ length: 20 }, (_, i) => `第${i + 1}句`);
  const long = rehearsalRequest(
    { ...JSON.parse(row.frozen_json), opening: { text: '你好' } },
    runId,
    'deepseek',
    20,
    many,
    many.slice(0, 19).map(() => ['好', '嗯']),
  );
  assert.ok(long.messages.length <= 24);
  assert.equal(long.opening, undefined);
  assert.ok(JSON.stringify(long.messages.at(-1)).includes('第20句'));
  // the pinned policy hash is the one of every other reply
  assert.equal(textPolicyHash().length, 64);
});

// ---- scripts, phrases, estimate, start -------------------------------------------------------------------------------------

test('scripts: save, rename and delete are idempotent per request id; 6 to 20 turns; names are unique', (t) => {
  const f = fixture(t);
  const turns = ['一', '二', '三', '四', '五', '六'];
  const saved = f.chars.rehearsalScriptSave(f.auth, { requestId: 'script-aaaa', id: null, name: '我的脚本', turns });
  assert.deepEqual(
    f.chars.rehearsalScriptSave(f.auth, { requestId: 'script-aaaa', id: null, name: '我的脚本', turns }),
    saved,
  );
  assert.throws(
    () => f.chars.rehearsalScriptSave(f.auth, { requestId: 'script-aaaa', id: null, name: '别的名字', turns }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () => f.chars.rehearsalScriptSave(f.auth, { requestId: 'script-bbbb', id: null, name: '我的脚本', turns }),
    /REHEARSAL_NAME_TAKEN/,
  );
  assert.throws(
    () =>
      f.chars.rehearsalScriptSave(f.auth, {
        requestId: 'script-cccc',
        id: null,
        name: '太短',
        turns: turns.slice(0, 5),
      }),
    /INVALID_REHEARSAL_SCRIPT/,
  );
  assert.throws(
    () =>
      f.chars.rehearsalScriptSave(f.auth, {
        requestId: 'script-dddd',
        id: null,
        name: '太长',
        turns: [...turns, ...turns, ...turns, ...turns],
      }),
    /INVALID_REHEARSAL_SCRIPT/,
  );
  const renamed = f.chars.rehearsalScriptSave(f.auth, {
    requestId: 'script-eeee',
    id: saved.id,
    name: '新名字',
    turns,
  });
  assert.equal(renamed.id, saved.id);
  assert.equal(renamed.name, '新名字');
  const library = f.chars.rehearsalLibrary(f.auth);
  assert.deepEqual(
    library.scripts.map((s) => s.name),
    ['新名字'],
  );
  assert.deepEqual(
    library.sets.map((s) => s.label),
    ['日常闲聊', '重复检测'],
  );
  assert.deepEqual(
    library.models.map((m) => [m.id, m.available]),
    [
      ['deepseek', true],
      ['gemini', true],
      ['xai', true],
    ],
  );
  f.chars.rehearsalScriptDelete(f.auth, { requestId: 'script-ffff', id: saved.id });
  assert.equal(f.chars.rehearsalLibrary(f.auth).scripts.length, 0);
});

test('phrase lists: editable, cleaned, idempotent; the counts follow the list', async (t) => {
  const f = fixture(t);
  const library = f.chars.rehearsalLibrary(f.auth);
  assert.deepEqual(library.phrases, library.defaultPhrases);
  const saved = f.chars.rehearsalPhrasesSave(f.auth, {
    requestId: 'phrase-aaaa',
    customerService: ['  好的呢 ', '好的呢', '为您'],
    advice: [],
  });
  assert.deepEqual(saved, { customerService: ['好的呢', '为您'], advice: [] });
  assert.deepEqual(f.chars.rehearsalLibrary(f.auth).phrases, saved);
  assert.throws(
    () => f.chars.rehearsalPhrasesSave(f.auth, { requestId: 'phrase-bbbb', customerService: 'x', advice: [] }),
    /INVALID_REHEARSAL_PHRASES/,
  );
});

test('estimate and start: one total covers models x turns and the judge calls; the administrator must confirm exactly that total', (t) => {
  const f = fixture(t);
  const one = f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ models: ['deepseek'] }));
  const three = f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input());
  assert.equal(one.replyCalls, 8 * 2);
  assert.equal(three.replyCalls, 3 * 8 * 2);
  assert.equal(three.judgeCalls, 0);
  assert.ok(three.totalMicros > one.totalMicros * 2, 'Grok and Gemini cost more than DeepSeek');
  assert.deepEqual(f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input()), three, 'the same inputs, the same total');
  const body = { ...f.input(), requestId: 'rehearsal-confirm' };
  assert.throws(
    () => f.chars.rehearsalStart(f.auth, CHARACTER, { ...body, acknowledgeMicros: three.totalMicros - 1 }),
    /REHEARSAL_ESTIMATE_CHANGED/,
  );
  assert.equal(f.store.get('SELECT 1 FROM web_rehearsal_runs'), undefined, 'nothing was queued');
  const started = f.chars.rehearsalStart(f.auth, CHARACTER, { ...body, acknowledgeMicros: three.totalMicros });
  assert.equal(started.replayed, false);
  assert.deepEqual(f.chars.rehearsalStart(f.auth, CHARACTER, { ...body, acknowledgeMicros: three.totalMicros }), {
    runId: started.runId,
    replayed: true,
  });
  assert.throws(
    () =>
      f.chars.rehearsalStart(f.auth, CHARACTER, { ...body, models: ['deepseek'], acknowledgeMicros: one.totalMicros }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(() => f.start({}, 'rehearsal-second'), /REHEARSAL_RUN_ACTIVE/, 'one run at a time');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_rehearsal_units')!.n, 3 * 8);
});

test('start refuses what cannot be run: a stale draft, an unknown model, 梗与故事 without the cast, a permission it does not hold', (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ profileHash: 'a'.repeat(64) })),
    /DRAFT_CONFLICT/,
  );
  assert.throws(
    () => f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ models: ['deepseek', 'nope'] })),
    /INVALID_REHEARSAL_MODELS/,
  );
  assert.throws(
    () => f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input({ models: [] })),
    /INVALID_REHEARSAL_MODELS/,
  );
  assert.throws(
    () =>
      f.chars.rehearsalEstimate(
        f.auth,
        CHARACTER,
        f.input({ source: { kind: 'memes', items: ['meme:落汤鸡', 'story:天台的约定'] } }),
      ),
    /REHEARSAL_MEMES_NEED_CAST/,
  );
  const reader = f.member(['characters.read:*'], 'reader');
  assert.throws(() => f.chars.rehearsalEstimate(reader, CHARACTER, f.input()), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(
    () =>
      f.chars.rehearsalStart(reader, CHARACTER, { ...f.input(), requestId: 'rehearsal-nope', acknowledgeMicros: 1 }),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  assert.throws(
    () =>
      f.chars.rehearsalScriptSave(reader, {
        requestId: 'script-zzzz',
        id: null,
        name: 'x',
        turns: ['1', '2', '3', '4', '5', '6'],
      }),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  // the Part 21b switch decides what the environment can serve
  Object.assign(f.store, { playerModelChoice: ['deepseek'] });
  assert.throws(() => f.chars.rehearsalEstimate(f.auth, CHARACTER, f.input()), /REHEARSAL_MODEL_UNAVAILABLE/);
  assert.deepEqual(
    f.chars.rehearsalLibrary(f.auth).models.map((m) => [m.id, m.available]),
    [
      ['deepseek', true],
      ['gemini', false],
      ['xai', false],
    ],
  );
});

// ---- a run -----------------------------------------------------------------------------------------------------------------

test('a run on three models: budget is reserved before every call, each column is written by its own model, the house reviewer reviews all of them', async (t) => {
  const f = fixture(t);
  const { runId } = f.start();
  assert.equal(await drain(f), 3 * 8);
  const fetches = f.events.filter((e) => e.startsWith('fetch:'));
  assert.equal(fetches.length, 3 * 8 * 2, 'a draft and a review per cell');
  f.events.forEach((event, i) => {
    if (!event.startsWith('fetch:')) return;
    const [, , , stage, model, turn] = event.split(':');
    const seq = f.store.get<{ seq: number }>(
      "SELECT seq FROM web_rehearsal_units WHERE kind='cell' AND turn=? AND model_key=?",
      Number(turn),
      model!,
    )!.seq;
    assert.equal(f.events[i - 1], `reserve:${stage}:${seq}`, `${event} follows its reservation`);
  });
  const drafts = f.sent.filter((s) => s.tool === 'draft');
  assert.deepEqual([...new Set(drafts.map((s) => `${s.provider}:${s.model}`))].sort(), [
    'deepseek:deepseek-flash',
    'gemini:gemini-3.8-flash',
    'xai:grok-4.7',
  ]);
  const reviews = f.sent.filter((s) => s.tool === 'review');
  assert.ok(
    reviews.every((s) => s.provider === 'deepseek' && s.model === 'deepseek-v4-pro'),
    'the house reviewer, as today',
  );
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
  assert.ok(f.budget.summary()[0]!.spentMicros > 0);
  assert.equal(f.store.get<{ n: number }>('SELECT sum(reserved) n FROM web_external_budgets')!.n, 0);
  // the conversation of a column grows: turn 2 of Grok carries Grok's own reply to turn 1
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.equal(detail.run.status, 'done');
  assert.equal(detail.turns.length, 8);
  assert.deepEqual(
    detail.columns.map((c) => c.model),
    ['deepseek', 'gemini', 'xai'],
  );
  for (const column of detail.columns) {
    assert.equal(column.cells.length, 8);
    assert.ok(column.cells.every((c) => c.state === 'done' && (c.bubbles?.length ?? 0) > 0));
    assert.equal(column.counts.replies, 8);
    assert.equal(column.counts.unconfirmed, 0);
  }
  const second = f.store.get<{ request_json: string }>(
    "SELECT request_json FROM web_rehearsal_units WHERE kind='cell' AND model_key='xai' AND turn=2",
  )!;
  const request = JSON.parse(second.request_json);
  assert.equal(request.messages.filter((m: { authorKind: string }) => m.authorKind === 'player').length, 2);
  assert.ok(request.messages.some((m: { authorKind: string }) => m.authorKind === 'character'));
  assert.equal(request.relationship, 'new');
  assert.equal(request.relationshipContext, undefined);
  // the cast view is off unless asked for
  assert.equal(request.cast, undefined);
});

test('带关系与故事: the run carries the cast view of the current cast file, whatever CAST_CONTEXT_ENABLED says for live chat', async (t) => {
  const f = fixture(t);
  assert.equal(
    (f.store as unknown as { castContext?: boolean }).castContext,
    undefined,
    'production keeps the switch off',
  );
  f.start({ withCast: true, models: ['deepseek'] });
  await drain(f);
  const unit = f.store.get<{ request_json: string }>(
    "SELECT request_json FROM web_rehearsal_units WHERE kind='cell' AND turn=1",
  )!;
  const request = JSON.parse(unit.request_json);
  assert.ok(request.cast, 'the cast view is in the request');
  assert.ok(request.cast.view.memes.some((m: { key: string }) => m.key === '落汤鸡'));
  assert.ok(JSON.stringify(promptMessages(request)).includes('落汤鸡'));
});

test('an UNKNOWN call is never resent and keeps its hold; that model’s later turns are not sent, the other models go on', async (t) => {
  const f = fixture(t);
  f.behaviour.unknown = { provider: 'xai', turn: 3 };
  const { runId } = f.start();
  await drain(f);
  const held = f.budget.summary()[0]!.heldMicros;
  assert.ok(held > 0, 'the money stays held');
  const unit = f.store.get<{ status: string; error_code: string }>(
    "SELECT status,error_code FROM web_rehearsal_units WHERE kind='cell' AND model_key='xai' AND turn=3",
  )!;
  assert.deepEqual([unit.status, unit.error_code], ['unconfirmed', 'REHEARSAL_CALL_UNKNOWN']);
  assert.equal(
    f.store.get<{ state: string }>(
      "SELECT state FROM web_rehearsal_calls c JOIN web_rehearsal_units u ON u.run_id=c.run_id AND u.seq=c.seq WHERE u.model_key='xai' AND u.turn=3",
    )!.state,
    'unknown',
  );
  assert.equal(
    f.store.get<{ n: number }>("SELECT reserved n FROM web_external_budgets WHERE provider='xai' AND phase='draft'")!.n,
    1,
    'and so does the ticket',
  );
  assert.equal(f.events.filter((e) => e.startsWith('fetch:xai:') && e.endsWith(':3')).length, 1, 'sent once');
  f.tick(900_000);
  await drain(f);
  assert.equal(f.events.filter((e) => e.startsWith('fetch:xai:') && e.endsWith(':3')).length, 1, 'never retried');
  assert.equal(f.budget.summary()[0]!.heldMicros, held, 'the hold was never released');
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  const grok = detail.columns.find((c) => c.model === 'xai')!;
  assert.deepEqual(
    grok.cells.map((c) => c.state),
    ['done', 'done', 'unconfirmed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'],
  );
  assert.equal(grok.counts.unconfirmed, 1);
  for (const other of detail.columns.filter((c) => c.model !== 'xai'))
    assert.ok(other.cells.every((c) => c.state === 'done'));
  assert.equal(detail.run.status, 'done');
});

test('梗与故事: hints are written by the judge, replies are judged per item, the table says hit or miss, false triggers and own side', async (t) => {
  const f = fixture(t);
  const items = f.chars.rehearsalItems(f.auth, CHARACTER);
  assert.equal(items.available, true);
  assert.ok(items.items.some((i) => i.kind === 'meme' && i.label === '落汤鸡'));
  assert.ok(items.items.some((i) => i.kind === 'story' && i.label === '天台的约定'));
  const source = { kind: 'memes', items: ['meme:落汤鸡', 'story:天台的约定'] };
  const estimate = f.chars.rehearsalEstimate(
    f.auth,
    CHARACTER,
    f.input({ source, withCast: true, models: ['deepseek', 'gemini'] }),
  );
  assert.equal(estimate.turns, 6);
  assert.equal(estimate.judgeCalls, 2 * (1 + 2), 'a hint writer per item and a verdict per model and item');
  const { runId } = f.start({ source, withCast: true, models: ['deepseek', 'gemini'] });
  await drain(f);
  assert.deepEqual(f.judged.filter((j) => j.startsWith('hint')).length, 2);
  assert.equal(f.judged.filter((j) => j.startsWith('verdict')).length, 4);
  assert.ok(
    f.judged.every((j) => j.endsWith(':deepseek-v4-pro')),
    'the house reviewer judges',
  );
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.equal(detail.turns.length, 6);
  assert.deepEqual(
    detail.turns.map((t) => t.role),
    ['hint', 'hint', 'negative', 'negative', 'hint', 'hint'],
  );
  assert.ok(detail.turns.every((t) => t.text.length > 0));
  assert.ok(detail.turns.some((t) => t.text === '你生日哪天'));
  assert.equal(detail.memes!.length, 2);
  for (const row of detail.memes!) {
    assert.equal(row.played, true);
    for (const model of ['deepseek', 'gemini'])
      assert.deepEqual(row.models[model], {
        hints: [true, false],
        falseTrigger: false,
        ownSide: true,
        state: 'judged',
      });
  }
  // every judge call went through the budget first
  f.events.forEach((event, i) => {
    if (event.startsWith('judge:')) assert.match(f.events[i - 1]!, /^reserve:judge:/);
  });
});

test('a hint that breaks the rules drops its item (billed, not retried); the run goes on with the rest', async (t) => {
  const f = fixture(t);
  f.behaviour.hintsBad = true;
  const { runId } = f.start({
    source: { kind: 'memes', items: ['meme:落汤鸡', 'story:天台的约定'] },
    withCast: true,
    models: ['deepseek'],
  });
  await drain(f);
  assert.equal(f.judged.filter((j) => j.startsWith('hint')).length, 2, 'once each, never retried');
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.equal(detail.memes![0]!.played, false);
  assert.equal(detail.memes![1]!.played, true, 'only the rule-breaking one is dropped');
  assert.equal(detail.columns[0]!.cells.filter((c) => c.state === 'done').length, 3);
  assert.equal(f.budget.summary()[0]!.heldMicros, 0);
});

test('an UNKNOWN judge call keeps its hold, is never resent, and marks the item 未确认', async (t) => {
  const f = fixture(t);
  f.behaviour.verdictUnknown = true;
  const { runId } = f.start({
    source: { kind: 'memes', items: ['meme:落汤鸡', 'story:天台的约定'] },
    withCast: true,
    models: ['deepseek'],
  });
  await drain(f);
  assert.equal(f.judged.filter((j) => j.startsWith('verdict')).length, 2, 'each verdict sent once');
  assert.ok(f.budget.summary()[0]!.heldMicros > 0);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  assert.ok(detail.memes!.every((m) => m.models.deepseek!.state === 'unconfirmed'));
  assert.equal(
    detail.columns[0]!.cells.every((c) => c.state === 'done'),
    true,
    'the replies themselves are kept',
  );
});

test('the admin view carries no id, no email and no nickname; another character’s run is not found', async (t) => {
  const f = fixture(t);
  const { runId } = f.start({ models: ['deepseek'] });
  await drain(f);
  const detail = f.chars.rehearsalDetail(f.auth, CHARACTER, runId);
  const text = JSON.stringify({ ...detail, run: { ...detail.run, runId: undefined } });
  assert.ok(!text.includes(runId));
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.throws(() => f.chars.rehearsalDetail(f.auth, 'chen-jimi', runId), /NOT_FOUND/);
  assert.equal(f.chars.rehearsalList(f.auth, 'chen-jimi').runs.length, 0);
  assert.equal(f.chars.rehearsalList(f.auth, CHARACTER).runs.length, 1);
  // nothing here touches a player: no table of a world, a conversation or a message was written
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM messages')!.n, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM world_characters')!.n, 0);
});

test('the pinned policy hash of every reply is the one the generator reports (this Part changes no prompt)', () => {
  const generator = new DeepSeekTextGenerator({ apiKey: 'offline-only', fetch: async () => new Response('{}') });
  assert.equal(generator.policyHash, textPolicyHash());
  assert.equal(auditReply().coverage !== undefined, true);
  assert.ok(memeItems.length > 0);
});

test('a 预演 body without a relationship starts (the console no longer sends one); an old tab\u2019s value is allowed and ignored', (t) => {
  const f = fixture(t);
  const body = { draftRevision: f.saved.revision, profileHash: f.saved.contentHash, message: '你好' };
  const one = f.chars.startPreview(f.auth, CHARACTER, { requestId: 'preview-norel-1', ...body });
  const two = f.chars.startPreview(f.auth, CHARACTER, { requestId: 'preview-norel-2', ...body, relationship: 'lover' });
  for (const started of [one, two]) {
    const request = JSON.parse(
      f.store.get<{ request_json: string }>('SELECT request_json FROM admin_previews WHERE id=?', started.previewId)!
        .request_json,
    );
    assert.equal(request.relationship, NEW_PLAYER_RELATIONSHIP);
  }
});
