import assert from 'node:assert/strict';
import test from 'node:test';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { readDraft, saveDraft } from '../../../apps/server/cast/cast-store.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import {
  characterProfileHash,
  installWebCharacterCatalog,
} from '../../../apps/server/characters/web-character-catalog.ts';
import { WebCocreationRelations } from '../../../apps/server/cocreation/web-cocreation-relations.ts';
import { DetailedError, DomainError } from '../../../packages/domain/errors.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { COCREATION_THEMES } from '../../../packages/contracts/cocreation-wordings.ts';
import { DAY, T0, origin, tiersFixture } from '../fixtures/invite-tiers.ts';
import { sampleCastRaw } from '../fixtures/cast-sample.ts';

const midnight = Math.floor(T0 / DAY) * DAY;
const IDS = ['wei-guagua', 'jojo', 'chen-jimi'] as const;
const code = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    if (error instanceof Error) return error.message;
    throw error;
  }
  return 'ok';
};

/** Part 55: three live characters with real profiles, the cast draft with the same three, the character admin wired into co-creation. */
function setup(t: test.TestContext) {
  const f = tiersFixture(t, { stats: true, extras: true, cocreation: true });
  f.setNow(midnight + 3_600_000);
  // The seed catalog insists on exactly the three approved characters (with their voice bindings).
  f.store.run("DELETE FROM character_templates WHERE id='fixture-character'");
  for (const id of IDS) {
    f.store.run(
      'INSERT INTO character_templates VALUES (?,1,?)',
      id,
      JSON.stringify({
        id,
        name: `角色${id}`,
        version: 1,
        fictional: true,
        persona: '合成角色，非真实材料',
        schedule: defaultSchedule(),
      }),
    );
    f.store.run(
      "INSERT INTO web_provider_voice_bindings VALUES (?,'voice-v1',1,?,'ref','model','user_selected',1,'{}')",
      id,
      id,
    );
  }
  installWebCharacterCatalog(f.store as never);
  // The fixture's players are admitted to its own character: put that template back (it is not in the catalog).
  f.store.run("INSERT INTO character_templates(id,version,config_json) VALUES ('fixture-character',1,'{}')");
  const live = { now: () => f.clock() };
  const characters = new WebCharacterAdmin(f.store as never, live, f.accounts);
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
    live,
    identity as never,
    f.accounts,
    Buffer.alloc(32, 7),
    () => `sub-${++n}`,
  );
  co.enableCharacterDrafts(characters);
  installWebAdminActions(f.store);
  // The cast draft holds the same three characters (a relation note can only name characters the draft has).
  const raw = sampleCastRaw();
  saveDraft(f.store as never, f.clock(), 1, {
    ...raw,
    characters: raw.characters.slice(1, 4).map((entry, index) => ({ ...entry, characterId: IDS[index]! })),
    people: [],
    ratings: {},
    directions: [],
    groups: [],
    stories: [],
    memes: [],
  });
  const adopter = f.member(
    ['cocreation.manage', 'cocreation.read', 'cast.edit', 'cast.read', 'characters.read:*', 'characters.edit:*'],
    'Adopter',
  );
  let players = 0;
  const player = () => {
    const who = f.player(`p${++players}`, { signedUp: true });
    tokens.set(who.token, who.principalId);
    return who;
  };
  let requests = 0;
  const card = (who: { token: string }, characterId: string, answers: unknown) =>
    co.submit(who.token, 'csrf-ok', origin, { characterId, requestId: `r${++requests}`, answers });
  const story = (who: { token: string }, members: string[], text: string) =>
    co.submitRelation(who.token, 'csrf-ok', origin, {
      requestId: `r${++requests}`,
      characterIds: members,
      ratings: [
        { from: members[0], to: members[1], stars: 4 },
        { from: members[1], to: members[0], stars: 2 },
      ],
      reason: '一个爱闹一个嫌吵',
      text,
    });
  /** A new live version, as publishing or restoring writes it. */
  const newLive = (id: string, profile: { template: object; presentation: object }, version: number) => {
    (profile.template as { version: number }).version = version;
    const stored = JSON.stringify(profile);
    f.store.run(
      'INSERT INTO character_template_versions VALUES (?,?,?,?)',
      id,
      version,
      JSON.stringify(profile.template),
      f.clock(),
    );
    f.store.run(
      'UPDATE character_templates SET version=?,config_json=? WHERE id=?',
      version,
      JSON.stringify(profile.template),
      id,
    );
    f.store.run(
      'INSERT INTO web_character_versions VALUES (?,?,?,?,?)',
      id,
      version,
      stored,
      characterProfileHash(profile as never),
      f.clock(),
    );
    f.store.run('UPDATE web_character_catalog SET version=? WHERE character_id=?', version, id);
  };
  /** What 发布 does to the stored rows (a new live version from the draft, the draft consumed), without the 预演 proof it stands on. */
  const publish = (id: string) => {
    const detail = characters.detail(f.owner, id);
    const profile = structuredClone(detail.draft!.profile);
    const version = detail.published!.version + 1;
    newLive(id, profile, version);
    f.store.run('DELETE FROM web_character_drafts WHERE character_id=?', id);
  };
  const points = (who: { principalId: string }) => f.balance(who.principalId);
  const ids = (submitted: { submissionId: string }) => submitted.submissionId;
  return { f, co, characters, player, card, story, publish, newLive, adopter, points, ids, raw };
}
type Setup = ReturnType<typeof setup>;
type Item = { id: string; ordinal: number; destination?: unknown };
type Result = { id: string; ordinal: number; ok: boolean; duplicate?: boolean; code?: string; fields?: string[] };
const adopt = (s: Setup, items: Item[]) => s.co.adoptAnswers(s.adopter, { items }).results as Result[];
const profileText = (s: Setup, id: string) => {
  const detail = s.characters.detail(s.f.owner, id);
  const versions = (
    s.f.store.all('SELECT profile_json FROM web_character_versions WHERE character_id=?', id) as {
      profile_json: string;
    }[]
  )
    .map((row) => row.profile_json)
    .join('\n');
  return `${JSON.stringify(detail.draft?.profile ?? {})}\n${versions}`;
};

/** 20 answers: eight character answers of different cards (themes, 一天, dialogue) spread over three characters, and twelve more. */
function twenty(s: Setup) {
  const items: { item: Item; text: string; author: { principalId: string } }[] = [];
  const theme = COCREATION_THEMES.find((x) => x.id === 'theme-catchphrase')!;
  let k = 0;
  const push = (
    who: { token: string; principalId: string },
    characterId: string,
    answer: Record<string, unknown>,
    text: string,
  ) => {
    const sent = s.card(who, characterId, [answer]);
    items.push({ item: { id: s.ids(sent), ordinal: 0 }, text, author: who });
  };
  for (const id of IDS) {
    const kinds = [
      (n: number) => ({ cardId: 'theme-catchphrase', text: `口头禅${id}${n}`, wording: theme.fallback }),
      (n: number) => ({ cardId: 'theme-know', text: `性格${id}${n}`, wording: '你眼中的他是什么样的人？' }),
      (n: number) => ({ cardId: 'day-morning', text: `早起${id}${n}` }),
      (n: number) => ({ cardId: 'topics', text: `话题${id}${n}` }),
      (n: number) => ({ cardId: 'quirk', text: `怪癖${id}${n}` }),
      (n: number) => ({ cardId: 'dialogue', player: `玩家说${id}${n}`, replies: [`回答${id}${n}`] }),
    ];
    for (const make of kinds) {
      k += 1;
      const answer = make(k) as Record<string, unknown>;
      const text = (answer.text ?? answer.replies?.[0 as never]) as string;
      push(s.player(), id, answer, String(text));
    }
  }
  // 18 character answers so far; two relation notes make 20.
  items.push({
    item: { id: s.ids(s.story(s.player(), ['wei-guagua', 'jojo'], '她们是邻居')), ordinal: 0 },
    text: '她们是邻居',
    author: s.player(),
  });
  items.push({
    item: { id: s.ids(s.story(s.player(), ['jojo', 'chen-jimi'], '他们是旧识')), ordinal: 0 },
    text: '他们是旧识',
    author: s.player(),
  });
  return items;
}

test('55: adopt 20 answers one after another, with a publish in between: no conflict, drafts hold all, points once each', (t) => {
  const s = setup(t);
  const list = twenty(s);
  assert.equal(list.length, 20);
  // The authors of the relation notes were minted by the test, not the notes: read the real author from the balance below.
  const before = new Map<string, number>();
  const owner = (n: number) =>
    s.f.store.get<{ principal_id: string }>(
      'SELECT principal_id FROM web_cocreation_submissions WHERE id=?',
      list[n]!.item.id,
    )!.principal_id;
  const balanceOf = (n: number) => s.f.balance(owner(n)) as number;
  list.forEach((_, n) => before.set(list[n]!.item.id, balanceOf(n)));
  const failures: string[] = [];
  list.forEach((entry, n) => {
    const [result] = adopt(s, [entry.item]);
    if (!result!.ok) failures.push(`${n}:${result!.code}`);
    // A publish of the character's draft in the middle of the run (the drafts of the others stay).
    if (n === 6 || n === 12) for (const id of IDS) if (s.characters.detail(s.f.owner, id).draft) s.publish(id);
  });
  assert.deepEqual(failures, []);
  // Every character answer is in a draft or in a published version; the relation notes are in the cast draft.
  for (const { item, text } of list.slice(0, 18)) {
    const submission = s.f.store.get<{ character_id: string }>(
      'SELECT character_id FROM web_cocreation_submissions WHERE id=?',
      item.id,
    )!;
    assert.ok(
      profileText(s, submission.character_id).includes(text),
      `${text} is in ${submission.character_id}'s draft or versions`,
    );
  }
  const cast = JSON.stringify(readDraft(s.f.store as never).doc.groups);
  assert.ok(cast.includes('她们是邻居') && cast.includes('他们是旧识'));
  // Each author got +20 once (the default adoption reward), and a second adoption pays nothing.
  list.forEach((entry, n) =>
    assert.equal(s.f.balance(owner(n)), before.get(entry.item.id)! + 20, `answer ${n} paid once`),
  );
  const again = adopt(
    s,
    list.map((entry) => entry.item),
  );
  assert.ok(again.every((r) => r.ok && r.duplicate === true));
  list.forEach((entry, n) => assert.equal(s.f.balance(owner(n)), before.get(entry.item.id)! + 20));
  // Every note left 新.
  assert.equal(
    s.f.store.get<{ n: number }>("SELECT count(*) n FROM web_cocreation_submissions WHERE status='new'")!.n,
    0,
  );
});

test('55: adopt 20 in one bulk action (three characters and relations) after a publish: each goes to its own destination, no conflict', (t) => {
  const s = setup(t);
  const warm = twenty(s);
  // Start from characters that already have a draft and then a newer published version (a draft consumed by a publish in between).
  adopt(s, [warm[0]!.item, warm[6]!.item, warm[12]!.item]);
  for (const id of IDS) s.publish(id);
  const rest = warm.filter((entry) => !['0', '6', '12'].includes(String(warm.indexOf(entry))));
  const results = adopt(
    s,
    rest.map((entry) => entry.item),
  );
  assert.equal(results.length, 17);
  assert.deepEqual(
    results.filter((r) => !r.ok),
    [],
  );
  // Destinations: the catchphrase goes into 说话风格 (the 核心卡), a day part into 一天的安排, a dialogue into 说话样本.
  const jojo = s.characters.detail(s.f.owner, 'jojo').draft!.profile.template as unknown as {
    authorCanon: { settings: Record<string, unknown> };
    persona: string;
  };
  assert.match(String(jojo.authorCanon.settings.speechStyle), /口头禅jojo/);
  assert.match(JSON.stringify(jojo.authorCanon.settings.dailyLife), /早起jojo/);
  assert.match(JSON.stringify(jojo.authorCanon.settings.dialogueExamples), /玩家说jojo/);
  assert.match(jojo.persona, /怪癖jojo/);
  // The relation notes are one story each in the cast draft, never published.
  const groups = readDraft(s.f.store as never).doc.groups;
  assert.equal(groups.length, 2);
  assert.equal(s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cast_publications')!.n, 0);
});

test('55: an answer already adopted answers duplicate and pays nothing again; a failure is named per item and the rest go on', (t) => {
  const s = setup(t);
  const ann = s.player();
  const a = s.card(ann, 'jojo', [{ cardId: 'quirk', text: '爱吃辣' }]);
  const first = adopt(s, [{ id: a.submissionId, ordinal: 0 }]);
  assert.deepEqual(first, [
    { id: a.submissionId, ordinal: 0, ok: true, duplicate: false, target: 'character', revision: 1 },
  ]);
  const paid = s.points(ann);
  assert.deepEqual(adopt(s, [{ id: a.submissionId, ordinal: 0 }])[0]!.duplicate, true);
  assert.equal(s.points(ann), paid);
  // A bad destination for one item (a dialogue sample from a text answer) fails alone, with its code.
  const b = s.card(s.player(), 'jojo', [{ cardId: 'quirk', text: '爱睡觉' }]);
  const c = s.card(s.player(), 'jojo', [{ cardId: 'quirk', text: '爱跑步' }]);
  const mixed = adopt(s, [
    { id: b.submissionId, ordinal: 0, destination: { field: 'dialogueExamples' } },
    { id: c.submissionId, ordinal: 0 },
  ]);
  assert.deepEqual(
    mixed.map((r) => [r.ok, r.code ?? null]),
    [
      [false, 'ADOPT_EXAMPLE_INVALID'],
      [true, null],
    ],
  );
  assert.equal(
    s.f.store.get<{ status: string }>('SELECT status FROM web_cocreation_submissions WHERE id=?', b.submissionId)!
      .status,
    'new',
  );
  assert.equal(
    s.f.store.get<{ n: number }>(
      'SELECT count(*) n FROM web_cocreation_answers WHERE submission_id=? AND adopted_at IS NOT NULL',
      b.submissionId,
    )!.n,
    0,
  );
  // A character with no editable version, and a memo, are named too.
  const memo = s.co.submitNote(s.player().token, 'csrf-ok', origin, {
    kind: 'memo',
    requestId: 'm1',
    text: '给制作组',
  });
  assert.equal(adopt(s, [{ id: memo.submissionId, ordinal: 0 }])[0]!.code, 'ADOPT_MEMO');
});

test('55: the 说话风格 card holds 300 characters: a full one refuses the next adoption by name, nothing is written', (t) => {
  const s = setup(t);
  const long = s.card(s.player(), 'jojo', [{ cardId: 'catchphrase', text: '长'.repeat(290) }]);
  const next = s.card(s.player(), 'jojo', [{ cardId: 'catchphrase', text: '又一句口头禅，加起来超过三百字' }]);
  assert.equal(adopt(s, [{ id: long.submissionId, ordinal: 0 }])[0]!.ok, true);
  const refused = adopt(s, [{ id: next.submissionId, ordinal: 0 }])[0]!;
  assert.deepEqual([refused.ok, refused.code], [false, 'PROFILE_CARD_TOO_LONG']);
  assert.equal(s.characters.detail(s.f.owner, 'jojo').draft!.revision, 1);
});

test('55: a save against a draft or a published version that moved on is merged; only the same field asks, by name', (t) => {
  const s = setup(t);
  const id = 'jojo';
  const open = () => s.characters.detail(s.f.owner, id);
  const page = () => {
    const detail = open();
    const profile = structuredClone(detail.draft?.profile ?? detail.published!.profile);
    if (!detail.draft) (profile.template as { version: number }).version = detail.published!.version + 1;
    return { revision: detail.draft?.revision ?? null, profile };
  };
  // The workbench page is read; then an adoption writes into the draft.
  const mine = page();
  adopt(s, [{ id: s.card(s.player(), id, [{ cardId: 'quirk', text: '别处加的怪癖' }]).submissionId, ordinal: 0 }]);
  (mine.profile.presentation as { publicDescription: string }).publicDescription = '页面上改的简介';
  // Before: this was DRAFT_CONFLICT / INVALID_DRAFT_VERSION. Now the two edits are different fields: merged.
  const saved = s.characters.save(s.f.owner, id, { expectedRevision: mine.revision, profile: mine.profile });
  assert.equal(saved.profile.presentation.publicDescription, '页面上改的简介');
  assert.match(saved.profile.template.persona, /别处加的怪癖/);
  // A publish in between: the page was read before it (version 2 expected, the live version is now 2, so the draft needs 3).
  const stale = page();
  s.publish(id);
  (stale.profile.presentation as { publicDescription: string }).publicDescription = '发布之后再改的简介';
  const after = s.characters.save(s.f.owner, id, { expectedRevision: stale.revision, profile: stale.profile });
  assert.equal(after.baseVersion, 2);
  assert.equal(after.profile.template.version, 3);
  assert.equal(after.profile.presentation.publicDescription, '发布之后再改的简介');
  assert.match(after.profile.template.persona, /别处加的怪癖/, 'what the publish carried stays');
  // The SAME field changed on both sides is a real conflict, named.
  const one = page();
  const two = page();
  (one.profile.template as { persona: string }).persona = '甲改的人设';
  (two.profile.template as { persona: string }).persona = '乙改的人设';
  s.characters.save(s.f.owner, id, { expectedRevision: one.revision, profile: one.profile });
  let caught: unknown;
  try {
    s.characters.save(s.f.owner, id, { expectedRevision: two.revision, profile: two.profile });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DetailedError);
  assert.equal((caught as DetailedError).code, 'DRAFT_FIELD_CONFLICT');
  assert.deepEqual((caught as DetailedError).detail.fields, ['人设 · 性格底色']);
  assert.match(open().draft!.profile.template.persona, /甲改的人设/, 'the stored draft is untouched');
});

test('55: a draft started on an older live version is rebased when a restore or publish moved live; adoption names a real conflict', (t) => {
  const s = setup(t);
  const id = 'jojo';
  adopt(s, [{ id: s.card(s.player(), id, [{ cardId: 'quirk', text: '草稿里的怪癖' }]).submissionId, ordinal: 0 }]);
  const draft = s.characters.detail(s.f.owner, id).draft!;
  // A new live version appears with the draft still in place (what a restore does): it changes the 公开简介.
  const live = structuredClone(s.characters.detail(s.f.owner, id).published!.profile);
  (live.presentation as { publicDescription: string }).publicDescription = '新的正式简介';
  s.newLive(id, live, 2);
  assert.equal(draft.baseVersion, 1);
  const next = adopt(s, [
    { id: s.card(s.player(), id, [{ cardId: 'topics', text: '后来的话题' }]).submissionId, ordinal: 0 },
  ]);
  assert.equal(next[0]!.ok, true);
  const now = s.characters.detail(s.f.owner, id).draft!;
  assert.equal(now.baseVersion, 2);
  assert.equal(now.profile.template.version, 3);
  assert.equal(now.profile.presentation.publicDescription, '新的正式简介');
  assert.match(now.profile.template.persona, /草稿里的怪癖/);
});

test('55: the route takes exactly its keys, needs the session, CSRF and Origin, and a reader cannot adopt', async (t) => {
  const s = setup(t);
  const sent = s.card(s.player(), 'jojo', [{ cardId: 'quirk', text: '路由怪癖' }]);
  const admin = (body: unknown, who: { cookie: string; csrf: string }, from = origin) =>
    routeWebAccountAdmin(
      s.f.accounts,
      {
        method: 'POST',
        path: '/api/web/local/admin/cocreation/adopt-answers',
        body,
        adminCookie: who.cookie,
        csrf: who.csrf,
        origin: from,
      } as never,
      undefined,
      s.co,
    );
  const body = { items: [{ id: sent.submissionId, ordinal: 0 }] };
  await assert.rejects(() => admin({ ...body, requestId: 'x' }, s.adopter as never), /INVALID_REQUEST/);
  await assert.rejects(
    () => admin({ items: [{ id: sent.submissionId, ordinal: 0, extra: 1 }] }, s.adopter as never),
    /INVALID_REQUEST/,
  );
  await assert.rejects(() => admin({ items: [] }, s.adopter as never), /INVALID_REQUEST/);
  await assert.rejects(
    () => admin(body, { ...(s.adopter as object), csrf: 'wrong' } as { cookie: string; csrf: string }),
    /CSRF|ADMIN_/,
  );
  await assert.rejects(() => admin(body, s.adopter as never, 'https://evil.invalid'), /ORIGIN|CSRF|ADMIN_/);
  const reader = s.f.member(['cocreation.read'], 'Reader');
  await assert.rejects(() => admin(body, reader as never), /ADMIN_PERMISSION_REQUIRED/);
  const noCharacter = s.f.member(['cocreation.manage', 'cocreation.read'], 'NoCharacter');
  const refused = (await admin(body, noCharacter as never))!.body as { results: Result[] };
  assert.equal(refused.results[0]!.code, 'ADMIN_PERMISSION_REQUIRED');
  const done = (await admin(body, s.adopter as never))!.body as { results: Result[]; adopted: number };
  assert.equal(done.adopted, 1);
});
