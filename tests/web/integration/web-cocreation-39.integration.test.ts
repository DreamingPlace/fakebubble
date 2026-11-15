import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSecurityCounters, installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { latestPublication, readDraft, saveDraft } from '../../../apps/server/cast/cast-store.ts';
import { WebCocreationRelations } from '../../../apps/server/cocreation/web-cocreation-relations.ts';
import { routeWebCocreation } from '../../../apps/server/cocreation/web-cocreation-routes.ts';
import { purgeCocreation } from '../../../apps/server/cocreation/web-cocreation-purge.ts';
import { installCocreationRelations } from '../../../apps/server/cocreation/web-cocreation-relations-schema.ts';
import { consoleCharacterOrder } from '../../../apps/server/characters/web-character-order.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';
import { RELATION_STAR_LABELS } from '../../../packages/contracts/cocreation-relations.ts';
import { T0, DAY, origin, tiersFixture } from '../fixtures/invite-tiers.ts';
import { SAMPLE_NAMES, sampleCastRaw, sampleId } from '../fixtures/cast-sample.ts';

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
const midnight = Math.floor(T0 / DAY) * DAY;
const ids = Array.from({ length: 15 }, (_, i) => sampleId(i));

/** Part 39: schema 131 + the runtime step, fifteen live characters in a REVERSED console order (c15 first), the sample cast as draft. */
function setup(t: test.TestContext) {
  const f = tiersFixture(t, { stats: true, extras: true, cocreation: true });
  f.setNow(midnight + 3_600_000);
  f.store.db.exec(
    'CREATE TABLE web_character_catalog(character_id TEXT PRIMARY KEY, version INTEGER, position INTEGER) STRICT',
  );
  ids.forEach((id, index) => {
    f.store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,1,?)', id, '{}');
    f.store.run('INSERT INTO web_character_catalog VALUES (?,1,?)', id, 14 - index);
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
  const live = { now: () => f.clock() };
  const co = new WebCocreationRelations(
    f.store,
    live,
    identity as never,
    f.accounts,
    Buffer.alloc(32, 7),
    () => `sub-${++n}`,
  );
  installWebAdminActions(f.store);
  void WebSecurityCounters;
  const player = (name: string) => {
    const who = f.player(name, { signedUp: true });
    tokens.set(who.token, who.principalId);
    return who;
  };
  const raw = sampleCastRaw();
  const draft = (patch: Record<string, unknown> = {}) =>
    saveDraft(f.store as never, f.clock(), readDraft(f.store as never).revision, { ...raw, ...patch });
  const send = (
    who: { token: string },
    requestId: string,
    members: string[],
    over: Partial<{ ratings: unknown; reason: unknown; text: unknown }> = {},
  ) =>
    co.submitRelation(who.token, 'csrf-ok', origin, {
      requestId,
      characterIds: members,
      ratings:
        members.length === 2
          ? [
              { from: members[0], to: members[1], stars: 4 },
              { from: members[1], to: members[0], stars: 1 },
            ]
          : null,
      reason: members.length === 2 ? '一个爱闹一个嫌吵' : null,
      text: '她们在雨天一起躲过同一把伞',
      ...over,
    });
  const adopter = f.member(['cocreation.manage', 'cocreation.read', 'cast.edit', 'cast.read'], 'Adopter');
  const reader = f.member(['cocreation.read'], 'Reader');
  const adopt = (id: string, requestId: string, text: string, name: string | null = null, revision?: number) =>
    co.adoptRelation(adopter, {
      id,
      requestId,
      expectedRevision: revision ?? readDraft(f.store as never).revision,
      text,
      groupName: name,
    });
  return { f, co, player, draft, send, adopter, reader, adopt, raw, tokens };
}

test('39 schema: a runtime step, digest-checked; another table of the family stops the start with its own code', (t) => {
  const s = setup(t);
  assert.ok(s.f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_cocreation_relation_schema'"));
  installCocreationRelations(s.f.store as never);
  s.f.store.run("UPDATE web_cocreation_relation_schema SET sha256='x'");
  assert.equal(
    code(() => installCocreationRelations(s.f.store as never)),
    'WEB_COCREATION_RELATIONS_SCHEMA_MISMATCH',
  );
  const clean = tiersFixture(t, { stats: true, extras: true, cocreation: true });
  clean.store.db.exec('CREATE TABLE web_cocreation_members(x INTEGER)');
  assert.equal(
    code(() => installCocreationRelations(clean.store as never)),
    'WEB_COCREATION_RELATIONS_SCHEMA_MISMATCH',
  );
});

test('39 A: the world background is the SAVED draft, plain text, nothing else of the cast', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const ask = () => s.co.worldBackground(ann.token, 'csrf-ok', origin);
  assert.deepEqual(ask(), { background: null }, 'an unsaved draft has no background');
  s.draft();
  assert.deepEqual(Object.keys(ask()), ['background']);
  assert.equal(ask().background, s.raw.world.background);
  s.draft({ world: { background: '新的世界背景' } });
  assert.equal(ask().background, '新的世界背景', 'a later save is shown');
  // Nothing of the cast leaks: the whole reply holds only the background text.
  assert.equal(JSON.stringify(ask()), JSON.stringify({ background: '新的世界背景' }));
  assert.equal(
    code(() => s.co.worldBackground(ann.token, 'bad', origin)),
    'CSRF_INVALID',
  );
  assert.equal(
    code(() => s.co.worldBackground('nope', 'csrf-ok', origin)),
    'SESSION_EXPIRED',
  );
});

test('39 C/D/E: a pair carries whole-star ratings both ways and a reason; a group carries neither; members are stored in console order', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const pair = s.send(ann, 'r1', ['c01', 'c02']);
  assert.equal(pair.duplicate, false);
  assert.equal(pair.earned, 5);
  const detail = s.co.relationDetail(s.adopter, pair.submissionId);
  assert.deepEqual(detail.members, ['c02', 'c01'], 'console order, not the order sent');
  assert.deepEqual(
    detail.ratings.map((r) => [r.from, r.to, r.stars]),
    [
      ['c02', 'c01', 1],
      ['c01', 'c02', 4],
    ],
  );
  assert.equal(detail.reason, '一个爱闹一个嫌吵');
  // Replay: same reply, nothing twice.
  assert.deepEqual(s.send(ann, 'r1', ['c01', 'c02'], {}).duplicate, true);
  assert.equal(s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_ratings')!.n, 2);
  // Validation.
  const bad = (members: string[], over: Parameters<typeof s.send>[3], request: string) =>
    code(() => s.send(ann, request, members, over));
  assert.equal(bad(['c03', 'c04'], { ratings: [{ from: 'c03', to: 'c04', stars: 4 }] }, 'v1'), 'INVALID_REQUEST');
  assert.equal(
    bad(
      ['c03', 'c04'],
      {
        ratings: [
          { from: 'c03', to: 'c04', stars: 2.5 },
          { from: 'c04', to: 'c03', stars: 1 },
        ],
      },
      'v2',
    ),
    'COCREATION_RATING_INVALID',
  );
  assert.equal(
    bad(
      ['c03', 'c04'],
      {
        ratings: [
          { from: 'c03', to: 'c04', stars: 6 },
          { from: 'c04', to: 'c03', stars: 1 },
        ],
      },
      'v3',
    ),
    'COCREATION_RATING_INVALID',
  );
  assert.equal(
    bad(
      ['c03', 'c04'],
      {
        ratings: [
          { from: 'c03', to: 'c04', stars: 3 },
          { from: 'c03', to: 'c04', stars: 1 },
        ],
      },
      'v4',
    ),
    'COCREATION_RATING_INVALID',
  );
  assert.equal(bad(['c03', 'c04'], { reason: '' }, 'v5'), 'COCREATION_REASON_INVALID');
  assert.equal(bad(['c03', 'c04'], { text: '  ' }, 'v6'), 'COCREATION_TEXT_INVALID');
  assert.equal(bad(['c03', 'c03'], {}, 'v7'), 'INVALID_REQUEST');
  assert.equal(bad(['c03'], {}, 'v8'), 'INVALID_REQUEST');
  assert.equal(bad(ids.slice(0, 9), { ratings: null, reason: null }, 'v9'), 'INVALID_REQUEST');
  assert.equal(
    bad(['c03', 'c04', 'c05'], { ratings: [{ from: 'c03', to: 'c04', stars: 3 }], reason: null }, 'v10'),
    'INVALID_REQUEST',
  );
  assert.equal(bad(['c03', 'c04', 'c05'], { ratings: null, reason: '为什么' }, 'v11'), 'INVALID_REQUEST');
  assert.equal(bad(['c03', 'nope'], {}, 'v12'), 'NOT_FOUND');
  // A group of three to eight.
  const group = s.send(ann, 'g1', ['c05', 'c03', 'c04']);
  assert.equal(group.duplicate, false);
  assert.deepEqual(s.co.relationDetail(s.adopter, group.submissionId).members, ['c05', 'c04', 'c03']);
  assert.deepEqual(s.co.relationDetail(s.adopter, group.submissionId).ratings, []);
  assert.equal(s.send(ann, 'g8', ids.slice(5, 13)).duplicate, false, 'eight is allowed');
  // One note per player per exact set per UTC day.
  assert.equal(
    code(() => s.send(ann, 'g2', ['c03', 'c04', 'c05'])),
    'COCREATION_DAILY_LIMIT',
  );
  assert.equal(
    code(() => s.send(ann, 'g3', ['c03', 'c04', 'c05'], { text: '另一个' })),
    'COCREATION_DAILY_LIMIT',
  );
  // The same request id with other content is a conflict.
  assert.equal(
    code(() => s.send(ann, 'g1', ['c05', 'c03', 'c04'], { text: '换了内容' })),
    'IDEMPOTENCY_CONFLICT',
  );
  // Auth.
  assert.equal(
    code(() =>
      s.co.submitRelation('x', 'csrf-ok', origin, {
        requestId: 'z',
        characterIds: ['c01', 'c02'],
        ratings: null,
        reason: null,
        text: 'x',
      }),
    ),
    'SESSION_EXPIRED',
  );
  assert.equal(RELATION_STAR_LABELS.length, 6);
  assert.equal(new Set(RELATION_STAR_LABELS.map((l) => [...l].length)).size, 1, 'the six words are the same length');
});

test('39 F: matching, 采纳 into a group or a new group; the ratings grid and the published cast are never touched', (t) => {
  const s = setup(t),
    ann = s.player('ann'),
    bob = s.player('bob');
  s.draft();
  const gridBefore = JSON.stringify(readDraft(s.f.store as never).doc.ratings);
  // The exact member set of 文学社 → 加入；a pair is a new group named after the CP convention.
  const join = s.send(ann, 'j1', ['c01', 'c02', 'c03', 'c04'], { text: '社刊第二期' });
  const club = s.co.relationDetail(s.adopter, join.submissionId);
  assert.equal(club.match?.kind, 'join');
  assert.equal(club.match?.kind === 'join' && club.match.name, '文学社');
  const pair = s.send(bob, 'p1', ['c01', 'c02']);
  const pairDetail = s.co.relationDetail(s.adopter, pair.submissionId);
  assert.equal(pairDetail.match?.kind, 'new');
  assert.equal(
    pairDetail.match?.kind === 'new' && pairDetail.match.suggestedName,
    `${SAMPLE_NAMES[1]}与${SAMPLE_NAMES[0]}`,
  );
  // A subset is not a match.
  assert.equal(
    s.co.relationDetail(s.adopter, s.send(bob, 'p2', ['c01', 'c02', 'c03']).submissionId).match?.kind,
    'new',
  );
  // 采纳 into the existing group: the story is appended to THAT group.
  const revision = readDraft(s.f.store as never).revision;
  const done = s.adopt(join.submissionId, 'a1', '社刊第二期，在旧书店加印。');
  assert.equal(done.joined, true);
  assert.equal(done.castRevision, revision + 1);
  const club2 = readDraft(s.f.store as never).doc.groups.find((g) => g.name === '文学社')!;
  assert.equal(club2.stories.length, 2);
  assert.equal(club2.stories[1]!.summary, '社刊第二期，在旧书店加印。');
  // The edited text is what is stored; the original stays readable.
  assert.equal(s.co.relationDetail(s.adopter, join.submissionId).text, '社刊第二期，在旧书店加印。');
  assert.equal(s.co.relationDetail(s.adopter, join.submissionId).originalText, '社刊第二期');
  // Idempotent per request id; another request for the same note is refused.
  assert.deepEqual(s.adopt(join.submissionId, 'a1', '社刊第二期，在旧书店加印。', null, revision).duplicate, true);
  assert.equal(readDraft(s.f.store as never).doc.groups.find((g) => g.name === '文学社')!.stories.length, 2);
  assert.equal(
    code(() => s.adopt(join.submissionId, 'a2', '再来一次')),
    'COCREATION_ALREADY_DECIDED',
  );
  assert.equal(
    code(() => s.adopt(join.submissionId, 'a1', '换了文字', null, revision)),
    'IDEMPOTENCY_CONFLICT',
  );
  // A new group, named by the administrator, with the members in console order.
  const created = s.adopt(pair.submissionId, 'a3', '同桌三年', '小满阿杰');
  assert.equal(created.joined, false);
  const made = readDraft(s.f.store as never).doc.groups.find((g) => g.name === '小满阿杰')!;
  assert.deepEqual(made.members, ['c02', 'c01']);
  assert.equal(made.stories[0]!.summary, '同桌三年');
  assert.equal(
    code(() => s.adopt(s.send(bob, 'p9', ['c05', 'c06']).submissionId, 'a4', '好', '')),
    'COCREATION_GROUP_NAME_INVALID',
  );
  assert.equal(
    code(() => s.adopt(s.send(bob, 'p8', ['c07', 'c08']).submissionId, 'a5', '好', 'x'.repeat(31))),
    'COCREATION_GROUP_NAME_INVALID',
  );
  // Stale revision: nothing is written.
  const stale = s.send(bob, 'p7', ['c09', 'c10']);
  assert.equal(
    code(() => s.adopt(stale.submissionId, 'a6', '好', '甲乙', 1)),
    'CAST_REVISION_CONFLICT',
  );
  assert.equal(
    readDraft(s.f.store as never).doc.groups.some((g) => g.name === '甲乙'),
    false,
  );
  // The ratings grid is untouched, and nothing was published.
  assert.equal(JSON.stringify(readDraft(s.f.store as never).doc.ratings), gridBefore);
  assert.equal(latestPublication(s.f.store as never), null);
  // Permissions: cast.edit and cocreation.manage are both needed; a reader only reads.
  assert.equal(
    code(() =>
      s.co.adoptRelation(s.reader, {
        id: stale.submissionId,
        requestId: 'z1',
        expectedRevision: 1,
        text: 'x',
        groupName: 'y',
      }),
    ),
    'ADMIN_PERMISSION_REQUIRED',
  );
  const manager = s.f.member(['cocreation.manage', 'cocreation.read', 'cast.read'], 'NoCast');
  assert.equal(
    code(() =>
      s.co.adoptRelation(manager, {
        id: stale.submissionId,
        requestId: 'z2',
        expectedRevision: 1,
        text: 'x',
        groupName: 'y',
      }),
    ),
    'ADMIN_PERMISSION_REQUIRED',
  );
  assert.equal(
    code(() => s.co.relationStats(s.reader)),
    'ok',
  );
  assert.equal(
    code(() => s.co.setExcluded(s.reader, stale.submissionId, true)),
    'ADMIN_PERMISSION_REQUIRED',
  );
});

test('39 F: adoption pays the existing points once; the cast limits refuse with their own code and write nothing', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  s.draft();
  const before = s.f.balance(ann.principalId);
  const note = s.send(ann, 'n1', ['c10', 'c11', 'c12'], { text: '宿舍夜谈' });
  assert.equal(s.f.balance(ann.principalId), before + 5);
  s.adopt(note.submissionId, 'x1', '宿舍夜谈');
  assert.equal(s.f.balance(ann.principalId), before + 5 + 20);
  // Group stories: 8 at most.
  const doc = structuredClone(readDraft(s.f.store as never).doc);
  const room = doc.groups.find((g) => g.name === '宿舍')!;
  while (room.stories.length < CAST_LIMITS.groupStories)
    room.stories.push({
      id: '',
      title: `故事${room.stories.length}`,
      summary: '概要',
      details: '',
      period: { start: '', end: '' },
      boundary: '',
    } as never);
  saveDraft(s.f.store as never, s.f.clock(), readDraft(s.f.store as never).revision, doc);
  const bob = s.player('bob');
  const full = s.send(bob, 'n2', ['c10', 'c11', 'c12'], { text: '第九个故事' });
  const view = s.co.relationDetail(s.adopter, full.submissionId);
  assert.equal(view.blocked, 'COCREATION_GROUP_STORIES_FULL');
  const rev = readDraft(s.f.store as never).revision;
  assert.equal(
    code(() => s.adopt(full.submissionId, 'x2', '第九个故事')),
    'COCREATION_GROUP_STORIES_FULL',
  );
  assert.equal(readDraft(s.f.store as never).revision, rev);
  assert.equal(s.co.relationDetail(s.adopter, full.submissionId).decision, null);
  // Summary length: 600.
  assert.equal(
    code(() => s.adopt(note.submissionId, 'x3', '字'.repeat(601))),
    'COCREATION_STORY_TOO_LONG',
  );
  // Groups: 120 at most.
  const many = structuredClone(readDraft(s.f.store as never).doc);
  while (many.groups.length < CAST_LIMITS.groups)
    many.groups.push({
      id: '',
      name: `组${many.groups.length}`,
      members: ['c13', 'c14', 'c15'],
      background: '',
      stories: [],
    } as never);
  saveDraft(s.f.store as never, s.f.clock(), readDraft(s.f.store as never).revision, many);
  const pairNote = s.send(bob, 'n3', ['c01', 'c05']);
  assert.equal(s.co.relationDetail(s.adopter, pairNote.submissionId).blocked, 'COCREATION_GROUPS_FULL');
  assert.equal(
    code(() => s.adopt(pairNote.submissionId, 'x4', '新组合', '甲乙')),
    'COCREATION_GROUPS_FULL',
  );
  assert.equal(readDraft(s.f.store as never).doc.groups.length, CAST_LIMITS.groups);
});

test('39 F: 不采纳 archives, keeps the ratings; 不计入 drops them from the statistics; a purged player takes their ratings along; counts only', (t) => {
  const s = setup(t),
    ann = s.player('ann'),
    bob = s.player('bob'),
    cy = s.player('cy');
  s.draft({ ratings: { c01: { c02: 3 } } });
  const a = s.send(ann, 's1', ['c01', 'c02']); // c01→c02 4, c02→c01 1
  const b = s.send(bob, 's2', ['c01', 'c02'], {
    ratings: [
      { from: 'c01', to: 'c02', stars: 2 },
      { from: 'c02', to: 'c01', stars: 5 },
    ],
  });
  const c = s.send(cy, 's3', ['c01', 'c02'], {
    ratings: [
      { from: 'c01', to: 'c02', stars: 4 },
      { from: 'c02', to: 'c01', stars: 0 },
    ],
  });
  const stats = () => s.co.relationStats(s.reader);
  const forward = () => stats().pairs.find((p) => p.from === 'c01' && p.to === 'c02')!;
  assert.deepEqual(forward().distribution, [0, 0, 1, 0, 2, 0]);
  assert.equal(forward().count, 3);
  assert.equal(forward().average, 3.33);
  assert.equal(forward().gridValue, 3, "next to the administrator's grid value");
  assert.deepEqual(
    stats().pairs.map((p) => `${p.from}>${p.to}`),
    ['c02>c01', 'c01>c02'],
    'console order',
  );
  // Rejecting the story alone does not remove the ratings.
  s.co.rejectRelation(s.adopter, a.submissionId);
  assert.equal(s.co.relationDetail(s.adopter, a.submissionId).decision, 'rejected');
  assert.equal(s.co.detail(s.adopter, a.submissionId).status, 'archived');
  assert.equal(forward().count, 3);
  assert.equal(
    code(() => s.co.rejectRelation(s.adopter, a.submissionId)),
    'ok',
    'idempotent',
  );
  // 不计入 removes them; undone they come back.
  s.co.setExcluded(s.adopter, b.submissionId, true);
  assert.equal(forward().count, 2);
  assert.deepEqual(forward().distribution, [0, 0, 0, 0, 2, 0]);
  assert.equal(stats().excludedSubmissions, 1);
  s.co.setExcluded(s.adopter, b.submissionId, false);
  assert.equal(forward().count, 3);
  // The reply names nobody.
  assert.ok(!/principal|sub-|pseudonym|玩家#/.test(JSON.stringify(stats())));
  // A rejected note can still be adopted later; an adopted one cannot be rejected.
  s.adopt(a.submissionId, 'r1', '同桌', '甲乙');
  assert.equal(
    code(() => s.co.rejectRelation(s.adopter, a.submissionId)),
    'COCREATION_ALREADY_DECIDED',
  );
  // The player purge removes the ratings.
  purgeCocreation(s.f.store as never, { principalId: cy.principalId });
  assert.equal(forward().count, 2);
  assert.equal(
    s.f.store.get<{ n: number }>(
      'SELECT count(*) n FROM web_cocreation_relations WHERE submission_id=?',
      c.submissionId,
    )!.n,
    0,
  );
  assert.equal(
    s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_members WHERE submission_id=?', c.submissionId)!
      .n,
    0,
  );
  // Purging a character removes every note it is a member of, including groups.
  const g = s.send(ann, 's4', ['c05', 'c06', 'c07']);
  purgeCocreation(s.f.store as never, { characterId: 'c07' });
  assert.equal(
    s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_submissions WHERE id=?', g.submissionId)!.n,
    0,
  );
  // Request immutability: what a player sent cannot be edited.
  assert.throws(() => s.f.store.run('UPDATE web_cocreation_ratings SET stars=5 WHERE submission_id=?', b.submissionId));
  assert.throws(() =>
    s.f.store.run("UPDATE web_cocreation_relations SET reason='x' WHERE submission_id=?", b.submissionId),
  );
});

test('39 B: the console order is the catalog order; the inbox lists a group under every one of its members', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  assert.deepEqual(consoleCharacterOrder(s.f.store as never).slice(0, 3), ['c15', 'c14', 'c13']);
  assert.deepEqual(consoleCharacterOrder(s.f.store as never, ['zzz', 'aaa', 'c01']).slice(-2), ['aaa', 'zzz']);
  assert.deepEqual(s.co.consoleOrder(s.reader).order.slice(0, 2), ['c15', 'c14']);
  const g = s.send(ann, 'o1', ['c01', 'c05', 'c09', 'c13']);
  const filtered = s.co.list(s.reader, { characterId: 'c01', status: null, starred: null, query: null, before: null });
  assert.equal(filtered.items.length, 1);
  const only = filtered.items[0] as unknown as { memberIds: string[]; kind: string };
  assert.deepEqual(only.memberIds, ['c13', 'c09', 'c05', 'c01']);
  assert.equal(only.kind, 'pair');
  assert.equal(
    s.co.list(s.reader, { characterId: 'c02', status: null, starred: null, query: null, before: null }).items.length,
    0,
  );
  assert.equal(g.duplicate, false);
});

test('39 routes: the player routes take exactly their keys (session, CSRF, Origin); the admin routes exist and stay behind their permission', async (t) => {
  const s = setup(t),
    ann = s.player('ann');
  s.draft();
  const req = (path: string, body: unknown, over: Record<string, unknown> = {}) =>
    ({
      method: 'POST',
      path: `/api/web/local/cocreation/${path}`,
      body,
      playerToken: ann.token,
      csrf: 'csrf-ok',
      origin,
      trustedIpHash: 'a'.repeat(64),
      ...over,
    }) as never;
  assert.equal(
    (routeWebCocreation(s.co, req('world', {}))!.body as { background: string }).background,
    s.raw.world.background,
  );
  const sent = routeWebCocreation(
    s.co,
    req('relation', {
      requestId: 'q1',
      characterIds: ['c01', 'c02', 'c03'],
      ratings: null,
      reason: null,
      text: '三个人',
    }),
  )!;
  assert.equal(sent.status, 201);
  assert.equal(
    code(() => routeWebCocreation(s.co, req('relation', { requestId: 'q2', characterIds: ['c01', 'c02'], text: 'x' }))),
    'INVALID_REQUEST',
  );
  assert.equal(
    code(() => routeWebCocreation(s.co, req('world', { x: 1 }))),
    'INVALID_REQUEST',
  );
  for (const path of ['world', 'relation']) {
    const body =
      path === 'world'
        ? {}
        : { requestId: 'q3', characterIds: ['c01', 'c02', 'c03'], ratings: null, reason: null, text: 'x' };
    assert.equal(
      code(() => routeWebCocreation(s.co, req(path, body, { playerToken: undefined }))),
      'AUTH_REQUIRED',
    );
    assert.equal(
      code(() => routeWebCocreation(s.co, req(path, body, { csrf: undefined }))),
      'CSRF_INVALID',
    );
    assert.equal(
      code(() => routeWebCocreation(s.co, req(path, body, { origin: 'https://evil.invalid' }))),
      'CSRF_INVALID',
    );
    assert.equal(
      code(() => routeWebCocreation(s.co, { ...(req(path, body) as object), method: 'GET' } as never)),
      'NOT_FOUND',
    );
  }
  const admin = (action: string, body: unknown, who = s.adopter) =>
    routeWebAccountAdmin(
      s.f.accounts,
      {
        method: 'POST',
        path: `/api/web/local/admin/cocreation/${action}`,
        body,
        adminCookie: who.cookie,
        csrf: who.csrf,
        origin,
      } as never,
      undefined,
      s.co,
    );
  const id = (sent.body as { submissionId: string }).submissionId;
  assert.equal(((await admin('relation/detail', { id }))!.body as { members: string[] }).members.length, 3);
  assert.equal(((await admin('relation/stats', {}))!.body as { pairs: unknown[] }).pairs.length, 0);
  assert.equal(((await admin('relation/order', {}))!.body as { order: string[] }).order[0], 'c15');
  assert.equal(
    ((await admin('relation/exclude', { id, excluded: true }))!.body as { excluded: boolean }).excluded,
    true,
  );
  await assert.rejects(
    () => admin('relation/exclude', { id, excluded: true }, s.reader as never),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  await assert.rejects(() => admin('relation/tidy', { id, requestId: 't1' }), /COCREATION_TIDY_UNAVAILABLE/);
  const done = (await admin('relation/adopt', {
    id,
    requestId: 'ad1',
    expectedRevision: readDraft(s.f.store as never).revision,
    text: '三个人的故事',
    groupName: '三人组',
  }))!.body as { joined: boolean };
  assert.equal(done.joined, false);
});

// ---- 整理: the budgeted text call ------------------------------------------------------------------------------------
import {
  COCREATION_TIDY_PROMPT,
  COCREATION_TIDY_PROMPT_SHA256,
  cocreationTidyHash,
} from '../../../apps/server/cocreation/web-cocreation-tidy-prompt.ts';
import {
  WebCocreationTidy,
  parseTidy,
  tidyUserMessage,
  TIDY_USER_MAX,
} from '../../../apps/server/cocreation/web-cocreation-tidy.ts';
import { clipPromptHash, CLIP_DIRECTION_PROMPT_SHA256 } from '../../../apps/server/characters/clip-direction-prompt.ts';
import { PROMPTS_V7 } from '../../../apps/server/generation/prompts.generated.ts';
import { createHash } from 'node:crypto';

function tidySetup(t: test.TestContext) {
  const s = setup(t);
  s.f.store.run("INSERT INTO web_provider_spending VALUES ('deepseek','USD',3000000,0,0)");
  s.f.store.run(
    `INSERT INTO web_provider_prices(id,provider,model,phase,currency,unit,upper_micros_per_unit,valid_from,valid_until,version) VALUES ('price-1','deepseek','deepseek-flash','draft','USD','token',3,0,${midnight + 7_200_000},1)`,
  );
  const events: string[] = [];
  let reply: () => Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
    receipt: unknown;
  }> = async () => ({
    text: JSON.stringify({ story: '整理后的故事', flags: ['像是玩家自己的经历'] }),
    inputTokens: 200,
    outputTokens: 50,
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
      assert.equal(input.system, COCREATION_TIDY_PROMPT);
      return reply();
    },
  };
  const tidy = new WebCocreationTidy(
    s.f.store as never,
    { now: () => s.f.clock() },
    model,
    budget as never,
    (() => {
      let n = 0;
      return () => `tidy-${++n}`;
    })(),
  );
  s.co.enableTidy(tidy);
  s.draft();
  return { s, events, tidy, setReply: (next: typeof reply) => (reply = next) };
}

test('39 整理: the prompt is pinned (own hash); chat and clip hashes are unchanged; the user message stays under the Worker bound', () => {
  assert.equal(cocreationTidyHash(), COCREATION_TIDY_PROMPT_SHA256);
  assert.equal(createHash('sha256').update(`${COCREATION_TIDY_PROMPT}\n`).digest('hex'), COCREATION_TIDY_PROMPT_SHA256);
  assert.equal(clipPromptHash(), CLIP_DIRECTION_PROMPT_SHA256);
  assert.ok(!Object.values(PROMPTS_V7).includes(COCREATION_TIDY_PROMPT), 'the chat prompt module does not carry it');
  const big = tidyUserMessage({
    members: ['甲', '乙'],
    text: '字'.repeat(600),
    reason: '理'.repeat(200),
    world: '世'.repeat(5000),
    canon: Array.from({ length: 30 }, () => '故'.repeat(500)),
  });
  assert.ok(big.length <= TIDY_USER_MAX);
  assert.deepEqual(parseTidy('{"story":"a","flags":[]}'), { story: 'a', flags: [] });
  for (const bad of [
    'x',
    '[]',
    '{"story":"a"}',
    '{"story":"","flags":[]}',
    '{"story":"a","flags":["1","2","3","4"]}',
    '{"story":"a","flags":[],"x":1}',
  ])
    assert.equal(parseTidy(bad), null, bad);
});

test('39 整理: budget is reserved BEFORE the call, it only returns text (nothing is adopted), a replay never sends again', async (t) => {
  const { s, events } = tidySetup(t);
  const ann = s.player('ann');
  const note = s.send(ann, 'n1', ['c10', 'c11', 'c12'], { text: '宿舍夜谈' });
  const rev = readDraft(s.f.store as never).revision;
  const result = await s.co.tidy(s.adopter, { id: note.submissionId, requestId: 'ti1' });
  assert.deepEqual(result, { story: '整理后的故事', flags: ['像是玩家自己的经历'] });
  assert.deepEqual(events.slice(0, 2), ['reserve:true', 'send'], 'reserve first');
  assert.equal(readDraft(s.f.store as never).revision, rev, 'only fills the edit box');
  assert.equal(s.co.relationDetail(s.adopter, note.submissionId).decision, null);
  const spend = s.f.store.get<{ held_micros: number; spent_micros: number }>(
    "SELECT * FROM web_provider_spending WHERE provider='deepseek'",
  )!;
  assert.equal(spend.held_micros, 0);
  assert.equal(spend.spent_micros, 250 * 3);
  await s.co.tidy(s.adopter, { id: note.submissionId, requestId: 'ti1' });
  assert.equal(events.filter((e) => e === 'send').length, 1, 'idempotent replay');
  // Permission: a reader cannot tidy.
  await assert.rejects(
    () => s.co.tidy(s.reader, { id: note.submissionId, requestId: 'ti2' }),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  // The result text is gone with the submission; the money row stays.
  purgeCocreation(s.f.store as never, { principalId: ann.principalId });
  assert.equal(
    s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_tidy_calls WHERE result_json IS NOT NULL')!.n,
    0,
  );
  assert.equal(s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_tidy_calls')!.n >= 1, true);
});

test('39 整理: an UNKNOWN call is never retried and its hold is never released; an unreadable answer is billed and not filled', async (t) => {
  const { s, events, setReply } = tidySetup(t);
  const ann = s.player('ann');
  const note = s.send(ann, 'n1', ['c10', 'c11', 'c12'], { text: '宿舍夜谈' });
  const held = () =>
    s.f.store.get<{ held_micros: number; spent_micros: number }>(
      "SELECT held_micros,spent_micros FROM web_provider_spending WHERE provider='deepseek'",
    )!;
  setReply(async () => {
    throw new Error('network');
  });
  await assert.rejects(
    () => s.co.tidy(s.adopter, { id: note.submissionId, requestId: 'u1' }),
    /COCREATION_TIDY_UNKNOWN/,
  );
  const afterUnknown = held();
  assert.ok(afterUnknown.held_micros > 0, 'the reservation stays');
  assert.equal(
    s.f.store.get<{ state: string }>("SELECT state FROM web_cocreation_tidy_calls WHERE request_id='u1'")!.state,
    'unknown',
  );
  const sends = events.filter((e) => e === 'send').length;
  await assert.rejects(
    () => s.co.tidy(s.adopter, { id: note.submissionId, requestId: 'u1' }),
    /COCREATION_TIDY_UNKNOWN/,
  );
  assert.equal(events.filter((e) => e === 'send').length, sends, 'never resent');
  assert.equal(held().held_micros, afterUnknown.held_micros, 'never released');
  // A garbled answer: billed, refused, nothing stored for the box.
  setReply(async () => ({
    text: '不是 JSON',
    inputTokens: 10,
    outputTokens: 10,
    model: 'deepseek-flash',
    receipt: {},
  }));
  await assert.rejects(
    () => s.co.tidy(s.adopter, { id: note.submissionId, requestId: 'g1' }),
    /COCREATION_TIDY_INVALID/,
  );
  assert.equal(held().spent_micros, 60);
  await assert.rejects(
    () => s.co.tidy(s.adopter, { id: note.submissionId, requestId: 'g1' }),
    /COCREATION_TIDY_INVALID/,
  );
  // The wrong model answering is UNKNOWN, not trusted.
  setReply(async () => ({
    text: '{"story":"a","flags":[]}',
    inputTokens: 1,
    outputTokens: 1,
    model: 'other',
    receipt: {},
  }));
  await assert.rejects(
    () => s.co.tidy(s.adopter, { id: note.submissionId, requestId: 'w1' }),
    /COCREATION_TIDY_UNKNOWN/,
  );
  // Without a price in force nothing is reserved.
  s.f.setNow(midnight + 3 * 3_600_000);
  const before = held();
  await assert.rejects(
    () => s.co.tidy(s.adopter, { id: note.submissionId, requestId: 'p1' }),
    /WEB_PROVIDER_PRICE_REQUIRED/,
  );
  assert.deepEqual(held(), before);
});
