import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { readDraft, saveDraft } from '../../../apps/server/cast/cast-store.ts';
import { WebCocreationRelations } from '../../../apps/server/cocreation/web-cocreation-relations.ts';
import { routeWebCocreation } from '../../../apps/server/cocreation/web-cocreation-routes.ts';
import { purgeCocreation } from '../../../apps/server/cocreation/web-cocreation-purge.ts';
import { installCocreationWordings } from '../../../apps/server/cocreation/web-cocreation-wordings-schema.ts';
import {
  COCREATION_WORDINGS_PROMPT,
  COCREATION_WORDINGS_PROMPT_SHA256,
  cocreationWordingsHash,
} from '../../../apps/server/cocreation/web-cocreation-wordings-prompt.ts';
import {
  WebCocreationWordingGen,
  parseWordings,
  wordingsUserMessage,
  WORDINGS_USER_MAX,
} from '../../../apps/server/cocreation/web-cocreation-wordings-gen.ts';
import {
  cocreationTidyHash,
  COCREATION_TIDY_PROMPT_SHA256,
} from '../../../apps/server/cocreation/web-cocreation-tidy-prompt.ts';
import { clipPromptHash, CLIP_DIRECTION_PROMPT_SHA256 } from '../../../apps/server/characters/clip-direction-prompt.ts';
import { PROMPTS_V7 } from '../../../apps/server/generation/prompts.generated.ts';
import { COCREATION_THEMES, COCREATION_THEME_IDS } from '../../../packages/contracts/cocreation-wordings.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { T0, DAY, origin, tiersFixture } from '../fixtures/invite-tiers.ts';
import { sampleCastRaw, sampleId } from '../fixtures/cast-sample.ts';

const code = async (work: () => unknown) => {
  try {
    await work();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    if (error instanceof Error) return error.message;
    throw error;
  }
  return 'ok';
};
const midnight = Math.floor(T0 / DAY) * DAY;
const ids = Array.from({ length: 5 }, (_, i) => sampleId(i));

function setup(t: test.TestContext) {
  const f = tiersFixture(t, { stats: true, extras: true, cocreation: true });
  f.setNow(midnight + 3_600_000);
  f.store.db.exec(
    'CREATE TABLE web_character_catalog(character_id TEXT PRIMARY KEY, version INTEGER, position INTEGER) STRICT',
  );
  // console order is REVERSED: the last id comes first
  ids.forEach((id, index) => {
    f.store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,1,?)', id, '{}');
    f.store.run('INSERT INTO web_character_catalog VALUES (?,1,?)', id, ids.length - 1 - index);
  });
  const tokens = new Map<string, string>();
  const identity = {
    authorizeWrite(token: string, csrf: string, from: string) {
      if (csrf !== 'csrf-ok' || from !== origin) throw new DomainError('CSRF_INVALID');
      const principalId = tokens.get(token);
      if (!principalId) throw new DomainError('SESSION_EXPIRED');
      return { principalId, world_id: 'w', player_id: 'p', kind: 'guest' as const };
    },
  };
  let n = 0;
  const co = new WebCocreationRelations(
    f.store,
    { now: () => f.clock() },
    identity as never,
    f.accounts,
    Buffer.alloc(32, 7),
    () => `id-${++n}`,
  );
  installWebAdminActions(f.store);
  const player = (name: string) => {
    const who = f.player(name, { signedUp: true });
    tokens.set(who.token, who.principalId);
    return who;
  };
  const manager = f.member(['cocreation.manage', 'cocreation.read'], 'Manager');
  const reader = f.member(['cocreation.read'], 'Reader');
  const nobody = f.member(['cast.read'], 'Nobody');
  const admin = (action: string, body: unknown, who: { cookie: unknown; csrf: unknown } = manager, over = {}) =>
    routeWebAccountAdmin(
      f.accounts,
      {
        method: 'POST',
        path: `/api/web/local/admin/cocreation/${action}`,
        body,
        adminCookie: who.cookie,
        csrf: who.csrf,
        origin,
        ...over,
      } as never,
      undefined,
      co,
    );
  const asPlayer = (path: string, body: unknown, ann: { token: string }, over: Record<string, unknown> = {}) =>
    routeWebCocreation(co, {
      method: 'POST',
      path: `/api/web/local/cocreation/${path}`,
      body,
      playerToken: ann.token,
      csrf: 'csrf-ok',
      origin,
      trustedIpHash: 'a'.repeat(64),
      ...over,
    } as never);
  return { f, co, player, manager, reader, nobody, admin, asPlayer };
}
type S = ReturnType<typeof setup>;
const add = async (s: S, characterId: string, themeId: string, text: string, requestId: string, enabled = true) =>
  ((await s.admin('wordings/add', { characterId, themeId, text, enabled, requestId })) as { body: { id: string } })
    .body;

test('39b schema: a runtime step, digest-checked, with its own STOP code; no numbered migration', async (t) => {
  const s = setup(t);
  assert.ok(s.f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_cocreation_wording_schema'"));
  installCocreationWordings(s.f.store as never);
  s.f.store.run("UPDATE web_cocreation_wording_schema SET sha256='x'");
  assert.equal(
    await code(() => installCocreationWordings(s.f.store as never)),
    'WEB_COCREATION_WORDINGS_SCHEMA_MISMATCH',
  );
});

test('39b prompt: the new prompt is pinned (own hash) and the other pinned hashes are unchanged', () => {
  assert.equal(cocreationWordingsHash(), COCREATION_WORDINGS_PROMPT_SHA256);
  assert.equal(
    createHash('sha256').update(`${COCREATION_WORDINGS_PROMPT}\n`).digest('hex'),
    COCREATION_WORDINGS_PROMPT_SHA256,
  );
  assert.equal(cocreationTidyHash(), COCREATION_TIDY_PROMPT_SHA256);
  assert.equal(clipPromptHash(), CLIP_DIRECTION_PROMPT_SHA256);
  assert.ok(!(Object.values(PROMPTS_V7) as string[]).includes(COCREATION_WORDINGS_PROMPT));
  const big = wordingsUserMessage({
    name: '名'.repeat(50),
    personality: '格'.repeat(900),
    existing: Array.from({ length: 80 }, () => '题'.repeat(60)),
  });
  assert.ok(big.length <= WORDINGS_USER_MAX);
});

test('39b parse: exactly five themes of six to ten wordings; bad ones are dropped, a short theme refuses the answer', () => {
  const full = Object.fromEntries(
    COCREATION_THEME_IDS.map((id) => [id, Array.from({ length: 12 }, (_, n) => `{name}问${id}${n}`)]),
  );
  const ok = parseWordings(JSON.stringify({ wordings: full }))!;
  assert.equal(ok['theme-know'].length, 10, 'at most ten');
  const short = { ...full, 'theme-know': ['a', 'b', 'c'] };
  assert.equal(parseWordings(JSON.stringify({ wordings: short })), null);
  const dirty = {
    ...full,
    'theme-know': [...full['theme-know']!.slice(0, 8), '', '带\n换行', full['theme-know']![0]!],
  };
  assert.equal(parseWordings(JSON.stringify({ wordings: dirty }))!['theme-know'].length, 8);
  for (const bad of [
    'x',
    '[]',
    '{"wordings":{}}',
    JSON.stringify({ wordings: full, x: 1 }),
    JSON.stringify({ wordings: { ...full, extra: [] } }),
  ])
    assert.equal(parseWordings(bad), null, bad);
});

test('39b pool CRUD: permissions, CSRF, idempotency, limits', async (t) => {
  const s = setup(t);
  const first = ids[0]!;
  const entry = await add(s, first, 'theme-know', '{name}平时是个怎样的人？', 'r1');
  // idempotent: same request, same content → the same entry; other content → conflict
  assert.equal((await add(s, first, 'theme-know', '{name}平时是个怎样的人？', 'r1')).id, entry.id);
  await assert.rejects(
    async () =>
      s.admin('wordings/add', {
        characterId: first,
        themeId: 'theme-know',
        text: '另一句',
        enabled: true,
        requestId: 'r1',
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const list = (
    (await s.admin('wordings/list', {}, s.reader)) as { body: { order: string[]; entries: { id: string }[] } }
  ).body;
  assert.equal(list.entries.length, 1);
  assert.deepEqual(list.order, [...ids].reverse(), 'characters in console order');
  // permission: read lists, cannot write; a member without it is refused everywhere
  for (const [action, body] of [
    ['wordings/add', { characterId: first, themeId: 'theme-habit', text: 'x', enabled: true, requestId: 'r2' }],
    ['wordings/edit', { id: entry.id, text: 'y' }],
    ['wordings/toggle', { id: entry.id, enabled: false }],
    ['wordings/delete', { id: entry.id }],
    ['wordings/estimate', { characterIds: null }],
    ['wordings/generate', { characterId: first, requestId: 'g', acknowledgeMicros: 1 }],
  ] as const)
    await assert.rejects(async () => s.admin(action, body, s.reader), /ADMIN_PERMISSION_REQUIRED/, action);
  await assert.rejects(async () => s.admin('wordings/list', {}, s.nobody), /ADMIN_PERMISSION_REQUIRED/);
  // CSRF and Origin
  await assert.rejects(async () => s.admin('wordings/list', {}, s.manager, { csrf: 'wrong' }), /CSRF_INVALID|ADMIN/);
  await assert.rejects(
    async () => s.admin('wordings/list', {}, s.manager, { origin: 'https://evil.invalid' }),
    /CSRF_INVALID|ORIGIN|ADMIN/,
  );
  // edit, switch off, delete; repeating each is the same answer
  const edited = (
    (await s.admin('wordings/edit', { id: entry.id, text: '{name}是什么样的人' })) as { body: { text: string } }
  ).body;
  assert.equal(edited.text, '{name}是什么样的人');
  assert.equal(
    ((await s.admin('wordings/edit', { id: entry.id, text: '{name}是什么样的人' })) as { body: { text: string } }).body
      .text,
    edited.text,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      ((await s.admin('wordings/toggle', { id: entry.id, enabled: false })) as { body: { enabled: boolean } }).body
        .enabled,
      false,
    );
  assert.equal(await code(() => s.admin('wordings/edit', { id: entry.id, text: '带\n换行' })), 'INVALID_REQUEST');
  assert.equal(
    await code(() =>
      s.admin('wordings/add', { characterId: first, themeId: 'theme-old', text: 'x', enabled: true, requestId: 'r9' }),
    ),
    'INVALID_REQUEST',
  );
  assert.equal(
    await code(() =>
      s.admin('wordings/add', {
        characterId: 'nobody',
        themeId: 'theme-know',
        text: 'x',
        enabled: true,
        requestId: 'r8',
      }),
    ),
    'NOT_FOUND',
  );
  for (let i = 0; i < 2; i++)
    assert.deepEqual(((await s.admin('wordings/delete', { id: entry.id })) as { body: unknown }).body, {
      id: entry.id,
      deleted: true,
    });
  assert.equal(((await s.admin('wordings/list', {})) as { body: { entries: unknown[] } }).body.entries.length, 0);
  // the audit lines hold the entry id and the action, never a wording
  const audit = s.f.store.all<{ action: string; target_id: string }>(
    "SELECT action,target_id FROM web_admin_audit WHERE action LIKE 'cocreation-wording%'",
  );
  assert.ok(audit.length >= 4);
  assert.ok(audit.every((row) => !row.target_id.includes('名')));
  // the per-theme cap
  for (let i = 0; i < 60; i++) await add(s, first, 'theme-habit', `{name}的习惯${i}`, `cap${i}`);
  assert.equal(await code(() => add(s, first, 'theme-habit', '再多一条', 'cap-x')), 'COCREATION_WORDINGS_FULL');
});

test('39b player: the sheet gets the ENABLED wordings only, text only, per character; the pick is random among them and falls back when empty', async (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const [a, b] = ids as [string, string];
  await add(s, a, 'theme-know', '甲一{name}', 'p1');
  await add(s, a, 'theme-know', '甲二{name}', 'p2');
  await add(s, a, 'theme-know', '甲关{name}', 'p3', false);
  await add(s, b, 'theme-know', '乙一{name}', 'p4');
  const got = (s.asPlayer('wordings', { characterId: a }, ann)!.body as { themes: Record<string, string[]> }).themes;
  assert.deepEqual(got['theme-know']!.sort(), ['甲一{name}', '甲二{name}']);
  assert.deepEqual(got['theme-habit'], [], 'an empty pool: the sheet shows its plain default');
  assert.deepEqual(Object.keys(got), [...COCREATION_THEME_IDS]);
  const { pickWording, cocreationTheme } = await import('../../../packages/contracts/cocreation-wordings.ts');
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++)
    seen.add(pickWording(cocreationTheme('theme-know')!, got['theme-know']!, '瓜瓜', () => i / 20));
  assert.deepEqual([...seen].sort(), ['甲一瓜瓜', '甲二瓜瓜'], 'only enabled entries, both reachable, name filled');
  assert.equal(
    pickWording(cocreationTheme('theme-habit')!, [], '瓜瓜', () => 0.5),
    '瓜瓜有哪些小习惯？',
  );
  // session, CSRF, origin, exact keys, method
  assert.equal(
    await code(() => s.asPlayer('wordings', { characterId: a }, ann, { playerToken: undefined })),
    'AUTH_REQUIRED',
  );
  assert.equal(await code(() => s.asPlayer('wordings', { characterId: a }, ann, { csrf: undefined })), 'CSRF_INVALID');
  assert.equal(
    await code(() => s.asPlayer('wordings', { characterId: a }, ann, { origin: 'https://evil.invalid' })),
    'CSRF_INVALID',
  );
  assert.equal(await code(() => s.asPlayer('wordings', { characterId: a, x: 1 }, ann)), 'INVALID_REQUEST');
  assert.equal(await code(() => s.asPlayer('wordings', { characterId: 'gone' }, ann)), 'NOT_FOUND');
  assert.equal(await code(() => s.asPlayer('wordings', { characterId: a }, ann, { method: 'GET' })), 'NOT_FOUND');
});

test('39b submit: a theme answer carries the wording shown; the inbox shows theme and wording; an old card still works; both go with a purge', async (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const c = ids[0]!;
  const handed = s.co.submit(ann.token, 'csrf-ok', origin, {
    characterId: c,
    requestId: 's1',
    answers: [{ cardId: 'theme-catchphrase', text: '又来了', wording: '瓜瓜常挂在嘴边的话' }],
  });
  const detail = s.co.detail(s.reader, handed.submissionId);
  assert.equal(detail.answers[0]!.cardId, 'theme-catchphrase');
  assert.equal((detail.answers[0] as { wording?: string }).wording, '瓜瓜常挂在嘴边的话');
  // a theme answer without its wording, or an old card WITH one, is not a valid shape
  assert.equal(
    await code(() =>
      s.co.submit(ann.token, 'csrf-ok', origin, {
        characterId: c,
        requestId: 's2',
        answers: [{ cardId: 'theme-know', text: 'x' }],
      }),
    ),
    'INVALID_REQUEST',
  );
  assert.equal(
    await code(() =>
      s.co.submit(ann.token, 'csrf-ok', origin, {
        characterId: c,
        requestId: 's3',
        answers: [{ cardId: 'quirk', text: 'x', wording: 'y' }],
      }),
    ),
    'INVALID_REQUEST',
  );
  assert.equal(
    await code(() =>
      s.co.submit(ann.token, 'csrf-ok', origin, {
        characterId: c,
        requestId: 's4',
        answers: [{ cardId: 'theme-habit', text: 'x', wording: '' }],
      }),
    ),
    'COCREATION_WORDING_INVALID',
  );
  // an old card is still accepted, and shows no wording
  const old = s.co.submit(ann.token, 'csrf-ok', origin, {
    characterId: c,
    requestId: 's5',
    answers: [{ cardId: 'quirk', text: '爱发呆' }],
  });
  assert.equal((s.co.detail(s.reader, old.submissionId).answers[0] as { wording?: string }).wording, undefined);
  // same theme twice on one day is the existing per-card limit
  assert.equal(
    await code(() =>
      s.co.submit(ann.token, 'csrf-ok', origin, {
        characterId: c,
        requestId: 's6',
        answers: [{ cardId: 'theme-catchphrase', text: 'z', wording: 'w' }],
      }),
    ),
    'COCREATION_DAILY_LIMIT',
  );
  purgeCocreation(s.f.store as never, { principalId: ann.principalId });
  assert.equal(s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_answer_wordings')!.n, 0);
  // a deleted character's pool goes with it
  await add(s, c, 'theme-know', '池里的', 'pp');
  purgeCocreation(s.f.store as never, { characterId: c });
  assert.equal(s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_wordings')!.n, 0);
});

// ---- 生成: the budgeted text call ------------------------------------------------------------------------------------
function genSetup(t: test.TestContext) {
  const s = setup(t);
  s.f.store.run("INSERT INTO web_provider_spending VALUES ('deepseek','USD',3000000,0,0)");
  s.f.store.run(
    `INSERT INTO web_provider_prices(id,provider,model,phase,currency,unit,upper_micros_per_unit,valid_from,valid_until,version) VALUES ('price-1','deepseek','deepseek-flash','draft','USD','token',3,0,${midnight + 7_200_000},1)`,
  );
  s.f.store.run(
    `INSERT INTO web_instance(singleton,instance_id) SELECT 1,'inst-1' WHERE NOT EXISTS (SELECT 1 FROM web_instance)`,
  );
  const events: string[] = [];
  const drafts = (n = 8) =>
    JSON.stringify({
      wordings: Object.fromEntries(
        COCREATION_THEMES.map((theme) => [theme.id, Array.from({ length: n }, (_, i) => `{name}的${theme.label}${i}`)]),
      ),
    });
  let reply: () => Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
    receipt: unknown;
  }> = async () => ({
    text: drafts(),
    inputTokens: 300,
    outputTokens: 700,
    model: 'deepseek-flash',
    receipt: { id: 'fake' },
  });
  const budget = {
    reserve: (id: string) => void events.push(`reserve:${id.length > 0}`),
    settle: () => void events.push('settle'),
  };
  const model = {
    model: 'deepseek-flash',
    async completePlain(input: { system: string }) {
      events.push('send');
      assert.equal(input.system, COCREATION_WORDINGS_PROMPT);
      return reply();
    },
  };
  let n = 0;
  const gen = new WebCocreationWordingGen(
    s.f.store as never,
    { now: () => s.f.clock() },
    model,
    budget as never,
    () => `gen-${++n}`,
  );
  s.co.enableWordingGen(gen);
  saveDraft(s.f.store as never, s.f.clock(), readDraft(s.f.store as never).revision, sampleCastRaw());
  const estimate = async () =>
    (
      (await s.admin('wordings/estimate', { characterIds: [ids[0]] })) as {
        body: { ok: boolean; totalMicros: number; items: unknown[] };
      }
    ).body;
  return { s, events, gen, estimate, setReply: (next: typeof reply) => (reply = next) };
}

test('39b 生成: estimate first; the budget is reserved BEFORE the call; drafts land switched OFF; a replay never sends again', async (t) => {
  const { s, events, estimate } = genSetup(t);
  const c = ids[0]!;
  const est = await estimate();
  assert.equal(est.ok, true);
  assert.ok(est.totalMicros > 0);
  // not confirmed (or confirmed for less than the hold): nothing is held, nothing is sent
  await assert.rejects(
    () =>
      s.admin('wordings/generate', {
        characterId: c,
        requestId: 'g0',
        acknowledgeMicros: est.totalMicros - 1,
      }) as never,
    /COCREATION_WORDINGS_ESTIMATE_STALE/,
  );
  assert.deepEqual(events, []);
  const done = (await s.admin('wordings/generate', {
    characterId: c,
    requestId: 'g1',
    acknowledgeMicros: est.totalMicros,
  }))!.body as { added: number };
  assert.equal(done.added, 40);
  assert.deepEqual(events.slice(0, 2), ['reserve:true', 'send'], 'reserve first');
  const pool = (
    (await s.admin('wordings/list', {})) as {
      body: { entries: { enabled: boolean; source: string; themeId: string }[] };
    }
  ).body.entries;
  assert.equal(pool.length, 40);
  assert.ok(
    pool.every((e) => !e.enabled && e.source === 'generated'),
    'nothing reaches players until switched on',
  );
  assert.deepEqual(
    (s.asPlayer('wordings', { characterId: c }, s.player('ann'))!.body as { themes: Record<string, string[]> }).themes[
      'theme-know'
    ],
    [],
  );
  const spend = s.f.store.get<{ held_micros: number; spent_micros: number }>(
    "SELECT * FROM web_provider_spending WHERE provider='deepseek'",
  )!;
  assert.equal(spend.held_micros, 0);
  assert.equal(spend.spent_micros, 1000 * 3);
  await s.admin('wordings/generate', { characterId: c, requestId: 'g1', acknowledgeMicros: est.totalMicros });
  assert.equal(events.filter((e) => e === 'send').length, 1, 'idempotent replay');
  assert.equal(
    ((await s.admin('wordings/list', {})) as { body: { entries: unknown[] } }).body.entries.length,
    40,
    'a replay adds nothing',
  );
  // switch one on: now (and only now) the player gets it
  const on = pool[0]!;
  const id = (
    (await s.admin('wordings/list', {})) as { body: { entries: { id: string; themeId: string; text: string }[] } }
  ).body.entries.find((e) => e.themeId === on.themeId)!;
  await s.admin('wordings/toggle', { id: id.id, enabled: true });
  assert.deepEqual(
    (s.asPlayer('wordings', { characterId: c }, s.player('bea'))!.body as { themes: Record<string, string[]> }).themes[
      on.themeId
    ],
    [id.text],
  );
  // a generation names the character and uses its cast personality (the model sees it)
  assert.match(wordingsUserMessage({ name: '瓜瓜', personality: 'x', existing: [] }), /瓜瓜/);
  // permission: a reader cannot generate (checked above too); the owner/manager can
  await assert.rejects(
    async () => s.admin('wordings/generate', { characterId: c, requestId: 'g9', acknowledgeMicros: 1e9 }, s.reader),
    /ADMIN_PERMISSION_REQUIRED/,
  );
});

test('39b 生成: an UNKNOWN call is never retried and its hold is never released; an unreadable answer is billed and adds nothing', async (t) => {
  const { s, events, estimate, setReply } = genSetup(t);
  const c = ids[0]!;
  const ack = (await estimate()).totalMicros;
  const spend = () =>
    s.f.store.get<{ held_micros: number; spent_micros: number }>(
      "SELECT held_micros,spent_micros FROM web_provider_spending WHERE provider='deepseek'",
    )!;
  setReply(async () => {
    throw new Error('network');
  });
  await assert.rejects(
    async () => s.admin('wordings/generate', { characterId: c, requestId: 'u1', acknowledgeMicros: ack }),
    /COCREATION_WORDINGS_UNKNOWN/,
  );
  const held = spend().held_micros;
  assert.ok(held > 0, 'the reservation stays');
  assert.equal(
    s.f.store.get<{ state: string }>("SELECT state FROM web_cocreation_wording_calls WHERE request_id='u1'")!.state,
    'unknown',
  );
  const sends = events.filter((e) => e === 'send').length;
  await assert.rejects(
    async () => s.admin('wordings/generate', { characterId: c, requestId: 'u1', acknowledgeMicros: ack }),
    /COCREATION_WORDINGS_UNKNOWN/,
  );
  assert.equal(events.filter((e) => e === 'send').length, sends, 'never resent');
  assert.equal(spend().held_micros, held, 'never released');
  // an answer that is not what was asked for: billed, refused, nothing in the pool
  setReply(async () => ({
    text: '不是 JSON',
    inputTokens: 10,
    outputTokens: 10,
    model: 'deepseek-flash',
    receipt: {},
  }));
  await assert.rejects(
    async () => s.admin('wordings/generate', { characterId: c, requestId: 'g1', acknowledgeMicros: ack }),
    /COCREATION_WORDINGS_INVALID/,
  );
  assert.equal(spend().spent_micros, 60);
  assert.equal(((await s.admin('wordings/list', {})) as { body: { entries: unknown[] } }).body.entries.length, 0);
  // an exhausted budget refuses before anything is sent and releases only the local hold of THAT call
  s.f.store.run("UPDATE web_provider_spending SET limit_micros=held_micros+spent_micros+1 WHERE provider='deepseek'");
  const before = events.length;
  await assert.rejects(
    async () => s.admin('wordings/generate', { characterId: c, requestId: 'b1', acknowledgeMicros: ack }),
    /WEB_PROVIDER_BUDGET_EXHAUSTED/,
  );
  assert.equal(events.length, before);
});

test('39b 生成: 全部生成 is one call per character, in console order; the estimate lists each; a missing model is its own refusal', async (t) => {
  const { s, events } = genSetup(t);
  const all = (
    (await s.admin('wordings/estimate', { characterIds: null })) as {
      body: { ok: boolean; items: { characterId: string; estimateMicros: number }[]; totalMicros: number };
    }
  ).body;
  assert.deepEqual(
    all.items.map((i) => i.characterId),
    [...ids].reverse(),
  );
  assert.equal(
    all.items.reduce((sum, i) => sum + i.estimateMicros, 0),
    all.totalMicros,
  );
  for (const item of all.items)
    await s.admin('wordings/generate', {
      characterId: item.characterId,
      requestId: `all-${item.characterId}`,
      acknowledgeMicros: item.estimateMicros,
    });
  assert.equal(events.filter((e) => e === 'send').length, ids.length);
  assert.equal(
    ((await s.admin('wordings/list', {})) as { body: { entries: unknown[] } }).body.entries.length,
    ids.length * 40,
  );
  const none = setup(t);
  assert.equal(
    ((await none.admin('wordings/estimate', { characterIds: null })) as { body: { ok: boolean } }).body.ok,
    false,
  );
  await assert.rejects(
    async () => none.admin('wordings/generate', { characterId: ids[0], requestId: 'x', acknowledgeMicros: 5 }),
    /COCREATION_WORDINGS_UNAVAILABLE/,
  );
});
