import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { WebSecurityCounters, installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebSystemAdmin } from '../../../apps/server/admin/web-system-admin.ts';
import { playerBilling } from '../../../apps/server/admission/web-billing.ts';
import { readDraft, saveDraft } from '../../../apps/server/cast/cast-store.ts';
import { WebCocreation } from '../../../apps/server/cocreation/web-cocreation.ts';
import { purgeCocreation } from '../../../apps/server/cocreation/web-cocreation-purge.ts';
import { routeWebCocreation } from '../../../apps/server/cocreation/web-cocreation-routes.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { COCREATION_CARDS, COCREATION_PAIR_NOTE_MAX } from '../../../packages/contracts/cocreation-cards.ts';
import { CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';
import { migrateWebProviderCocreationPoints } from '../../../apps/server/generation/web-provider-migration.ts';
import { DAY, T0, origin, tiersFixture } from '../fixtures/invite-tiers.ts';
import { counterIds, sampleCastRaw } from '../fixtures/cast-sample.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { normalizeCastDoc } from '../../../apps/server/cast/cast-validation.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

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

/** Part 24c fixture: schema 131 with the real points machinery, three live characters and a WebCocreation over it. */
function setup(t: test.TestContext) {
  const f = tiersFixture(t, { stats: true, extras: true, cocreation: true });
  f.setNow(midnight + 3_600_000);
  // A stand-in for the live catalog (the real one is seeded from the fixed three-character list, which this fixture does not use).
  f.store.db.exec(
    'CREATE TABLE web_character_catalog(character_id TEXT PRIMARY KEY, version INTEGER, position INTEGER) STRICT',
  );
  for (const [position, id] of ['wei-guagua', 'jojo', 'chen-jimi'].entries()) {
    f.store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,1,?)', id, '{}');
    f.store.run('INSERT INTO web_character_catalog VALUES (?,1,?)', id, position);
  }
  const tokens = new Map<string, string>();
  const identity = {
    authorizeWrite(token: string, csrf: string, from: string) {
      if (csrf !== 'csrf-ok' || from !== origin) throw new DomainError('CSRF_INVALID');
      const principalId = tokens.get(token);
      if (!principalId) throw new DomainError('SESSION_EXPIRED');
      return { principalId, world_id: 'w', player_id: 'p', kind: 'guest' as const };
    },
  };
  let ids = 0;
  const live = { now: () => f.clock() };
  const co = new WebCocreation(f.store, live, identity as never, f.accounts, Buffer.alloc(32, 7), () => `sub-${++ids}`);
  installWebAdminActions(f.store);
  const system = new WebSystemAdmin(f.store, live, f.accounts, {
    ops: undefined,
    security: new WebSecurityCounters(f.store, live),
    emailKey: Buffer.alloc(32, 7),
  });
  const player = (name: string, o: Parameters<typeof f.player>[1] = { signedUp: true }) => {
    const who = f.player(name, o);
    tokens.set(who.token, who.principalId);
    return who;
  };
  const card = (who: { token: string }, requestId: string, answers: unknown, characterId = 'wei-guagua') =>
    co.submit(who.token, 'csrf-ok', origin, { characterId, requestId, answers });
  const note = (
    who: { token: string },
    requestId: string,
    text: string,
    characterId = 'wei-guagua',
    partnerId = 'jojo',
  ) => co.submitNote(who.token, 'csrf-ok', origin, { kind: 'pair', requestId, text, characterId, partnerId });
  const memo = (who: { token: string }, requestId: string, text: string) =>
    co.submitNote(who.token, 'csrf-ok', origin, { kind: 'memo', requestId, text });
  const adopter = f.member(['cocreation.manage', 'cocreation.read', 'cast.edit', 'cast.read'], 'Adopter');
  const points = (who: { principalId: string }) => f.balance(who.principalId);
  const sources = (who: { principalId: string }) => f.events(who.principalId).map(([source]) => source);
  return { f, co, system, player, card, note, memo, adopter, points, sources, tokens };
}

test('24c points: +5 per note, a paid note shows in 消费记录 as 共创奖励 and in the 22c counters, replays pay nothing twice', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const first = s.card(ann, 'r1', [{ cardId: 'catchphrase', text: '哎呀妈呀' }]);
  assert.deepEqual(
    { answered: first.answered, duplicate: first.duplicate, earned: first.earned },
    { answered: 1, duplicate: false, earned: 5 },
  );
  assert.equal(s.points(ann), 105);
  assert.deepEqual(s.f.events(ann.principalId).at(-1), ['cocreation_note', 5]);
  // An uncertain send is retried as is: the same reply, no second payment.
  assert.deepEqual(s.card(ann, 'r1', [{ cardId: 'catchphrase', text: '哎呀妈呀' }]), { ...first, duplicate: true });
  assert.equal(s.points(ann), 105);
  assert.equal(s.sources(ann).filter((source) => source === 'cocreation_note').length, 1);
  // 消费记录 lists it, and the quota summary still adds up (balance == granted - used).
  const page = playerBilling(s.f.store, s.f.clock(), ann.principalId, {});
  assert.deepEqual(
    page.items.find((item) => item.kind === 'cocreation_note'),
    {
      kind: 'cocreation_note',
      at: s.f.clock(),
      points: 5,
    },
  );
  assert.equal(page.balance, page.quota!.total - page.quota!.used);
  // The 22c counter of the day (counts only: no principal in it).
  assert.equal(
    s.f.store.get<{ value: number }>("SELECT value FROM web_stats_daily WHERE metric='points_cocreation_note'")!.value,
    5,
  );
});

test('24c points: at most 15 PAID notes per player per UTC day, the rest are stored but unpaid; the next UTC day pays again', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  // 12 cards (one submission) + 3 pair notes = 15 paid notes.
  const all = COCREATION_CARDS.map((entry) =>
    entry.kind === 'dialogue'
      ? { cardId: entry.id, player: '我再玩十分钟', replies: ['行吧行吧'] }
      : { cardId: entry.id, text: `第${entry.id}个想法` },
  );
  assert.equal(s.card(ann, 'big', all).earned, 60);
  for (const n of [1, 2, 3]) assert.equal(s.note(ann, `p${n}`, `故事${n}`).earned, 5);
  assert.equal(s.points(ann), 100 + 15 * 5);
  // The 16th note is accepted (a submission row) and pays nothing - silently.
  const over = s.note(ann, 'p4', '故事4');
  assert.equal(over.duplicate, false);
  assert.equal('earned' in over, false);
  assert.equal(s.points(ann), 175);
  assert.equal(
    s.f.store.get<{ n: number }>("SELECT count(*) n FROM web_cocreation_submissions WHERE kind='pair'")!.n,
    4,
  );
  // Tomorrow the allowance is back.
  s.f.setNow(midnight + DAY + 3_600_000);
  assert.equal(s.note(ann, 'p5', '故事5').earned, 5);
  assert.equal(s.points(ann), 180);
});

test("24c points: an exact repeat of the same player's earlier note for that character (or pair) earns nothing, silently", (t) => {
  const s = setup(t),
    ann = s.player('ann'),
    bob = s.player('bob');
  assert.equal(s.card(ann, 'a1', [{ cardId: 'free', text: '喜欢吃辣' }]).earned, 5);
  s.f.setNow(midnight + DAY + 3_600_000);
  // The same words (spaces and width ignored) tomorrow: stored, unpaid.
  const repeat = s.card(ann, 'a2', [{ cardId: 'free', text: '喜欢 吃辣' }]);
  assert.equal(repeat.duplicate, false);
  assert.equal('earned' in repeat, false);
  // Another character, another player: paid.
  assert.equal(s.card(ann, 'a3', [{ cardId: 'free', text: '喜欢吃辣' }], 'jojo').earned, 5);
  assert.equal(s.card(bob, 'b1', [{ cardId: 'free', text: '喜欢吃辣' }]).earned, 5);
  // Pairs: the same two characters in either order are one scope.
  assert.equal(s.note(ann, 'p1', '小时候认识的').earned, 5);
  assert.equal('earned' in s.note(ann, 'p2', '小时候认识的', 'jojo', 'wei-guagua'), false);
  assert.equal(s.note(ann, 'p3', '小时候认识的', 'jojo', 'chen-jimi').earned, 5);
});

test('24c 留言条: stored as a memo under no character, typed in the inbox, never paid (not even when adopted)', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const sent = s.memo(ann, 'm1', '希望多加几个角色');
  assert.deepEqual({ answered: sent.answered, duplicate: sent.duplicate }, { answered: 1, duplicate: false });
  assert.equal('earned' in sent, false);
  assert.equal(s.points(ann), 100);
  assert.deepEqual(s.sources(ann), ['bonus']);
  const row = s.f.store.get<{ kind: string; character_id: string; partner_id: string | null }>(
    'SELECT kind,character_id,partner_id FROM web_cocreation_submissions WHERE id=?',
    sent.submissionId,
  )!;
  assert.deepEqual({ ...row }, { kind: 'memo', character_id: '_memo', partner_id: null });
  assert.equal(
    s.f.store.get<{ paid_points: number; note_hash: string | null }>(
      'SELECT paid_points,note_hash FROM web_cocreation_answers',
    )!.note_hash,
    null,
    'a memo is not even hashed for the duplicate rule',
  );
  // The inbox says what it is.
  const detail = s.co.detail(s.adopter, sent.submissionId);
  assert.deepEqual([detail.kind, detail.partnerId, detail.characterId], ['memo', null, '_memo']);
  const listed = s.co.list(s.adopter, { characterId: null, status: null, starred: null, query: null, before: null });
  assert.equal(listed.items[0]!.kind, 'memo');
  // Even adopted, it never pays; and the replay is the same memo.
  s.co.markAdopted(s.adopter, sent.submissionId, 0);
  assert.equal(s.points(ann), 100);
  assert.deepEqual(s.memo(ann, 'm1', '希望多加几个角色'), { ...sent, duplicate: true });
  assert.equal(
    code(() => s.memo(ann, 'm1', '换了内容')),
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    code(() => s.memo(ann, 'm2', '  ')),
    'COCREATION_TEXT_INVALID',
  );
  assert.equal(
    code(() => s.memo(ann, 'm2', 'a\nb')),
    'COCREATION_TEXT_INVALID',
  );
});

test('24c pair story: stored with both character ids, validated, earns like a note', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const sent = s.note(ann, 'p1', '她们是小学同学');
  assert.equal(sent.earned, 5);
  assert.deepEqual(
    {
      ...s.f.store.get<Record<string, unknown>>(
        'SELECT kind,character_id,partner_id FROM web_cocreation_submissions WHERE id=?',
        sent.submissionId,
      ),
    },
    { kind: 'pair', character_id: 'wei-guagua', partner_id: 'jojo' },
  );
  assert.equal(
    code(() => s.note(ann, 'p2', '同一个人', 'jojo', 'jojo')),
    'INVALID_REQUEST',
  );
  assert.equal(
    code(() => s.note(ann, 'p2', '没有这个人', 'wei-guagua', 'nobody')),
    'NOT_FOUND',
  );
  assert.equal(
    code(() => s.note(ann, 'p2', '字'.repeat(COCREATION_PAIR_NOTE_MAX + 1))),
    'COCREATION_TEXT_INVALID',
  );
  assert.equal(
    code(() => s.note(ann, 'p2', '字'.repeat(COCREATION_PAIR_NOTE_MAX))),
    'ok',
  );
  // The pair is listed under either of its characters.
  for (const id of ['wei-guagua', 'jojo'])
    assert.equal(
      s.co.list(s.adopter, { characterId: id, status: null, starred: null, query: null, before: null }).items.length,
      2,
      id,
    );
  assert.equal(
    s.co.list(s.adopter, { characterId: 'chen-jimi', status: null, starred: null, query: null, before: null }).items
      .length,
    0,
  );
  // Deleting one of the two characters deletes the pair notes about it; a stranger's session is refused first.
  assert.equal(
    code(() => s.co.submitNote('token-nobody', 'csrf-ok', origin, { kind: 'memo', requestId: 'x', text: 'a' })),
    'SESSION_EXPIRED',
  );
  s.f.store.transaction(() => purgeCocreation(s.f.store, { characterId: 'jojo' }));
  assert.equal(s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_submissions')!.n, 0);
});

test('24c points: who earns - guests and unlimited players are skipped, a daily_refill player never goes above its cap', (t) => {
  const s = setup(t),
    guest = s.player('guest', {}),
    reg = s.player('reg');
  // Unlimited: an entitlement that is never charged.
  const unlimitedBatch = s.f.create(s.f.owner, { tier: { kind: 'unlimited' } });
  const unlimited = s.player('unl');
  s.f.redeem(unlimited, unlimitedBatch.codes![0]!);
  // daily_refill with a cap 8 above its 100 opening balance.
  const refillBatch = s.f.create(s.f.owner, { tier: { kind: 'daily_refill', dailyAmount: 50, cap: 108 }, count: 2 });
  const refill = s.player('ref');
  s.f.redeem(refill, refillBatch.codes![0]!);
  // Redeeming pays the first refill at once (100 -> the cap 108); the player then spends 8 points, so there are 8 points of room.
  s.f.store.run('UPDATE web_points_balance SET balance=100 WHERE principal_id=?', refill.principalId);

  for (const who of [guest, unlimited]) {
    const sent = s.card(who, 'r1', [{ cardId: 'catchphrase', text: '哎呀妈呀' }]);
    assert.equal('earned' in sent, false, who.principalId);
    assert.equal(s.f.events(who.principalId).filter(([source]) => source.startsWith('cocreation')).length, 0);
  }
  assert.equal(s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_submissions')!.n, 2, 'still stored');

  assert.equal(s.card(reg, 'r1', [{ cardId: 'catchphrase', text: '哎呀妈呀' }]).earned, 5);
  // 100 -> 105 -> 108 (the cap): the second note is clamped to 3, the third finds no room and is unpaid.
  assert.equal(s.card(refill, 'r1', [{ cardId: 'catchphrase', text: '一二三' }]).earned, 5);
  assert.equal(s.card(refill, 'r2', [{ cardId: 'quirk', text: '四五六' }]).earned, 3);
  const full = s.card(refill, 'r3', [{ cardId: 'topics', text: '七八九' }]);
  assert.equal('earned' in full, false);
  assert.equal(s.points(refill), 108);
  // The adoption reward obeys the same cap: nothing is added above it.
  const adopted = s.co.markAdopted(s.adopter, full.submissionId, 0);
  assert.equal(adopted.status, 'processed');
  assert.equal(s.points(refill), 108);
});

test('24c adoption: +20 once on the first adoption; adopting again or after an undo pays nothing; undo claws nothing back', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const sent = s.card(ann, 'r1', [{ cardId: 'catchphrase', text: '哎呀妈呀' }]);
  assert.equal(s.points(ann), 105);
  s.co.markAdopted(s.adopter, sent.submissionId, 0);
  assert.equal(s.points(ann), 125);
  assert.deepEqual(s.f.events(ann.principalId).at(-1), ['cocreation_adopted', 20]);
  s.co.markAdopted(s.adopter, sent.submissionId, 0);
  assert.equal(s.points(ann), 125, 'adopting the same note again pays nothing');
  s.co.unadopt(s.adopter, sent.submissionId, 0);
  assert.equal(s.points(ann), 125, 'an undo takes nothing back');
  assert.equal(s.co.detail(s.adopter, sent.submissionId).answers[0]!.adoptedAt, null);
  s.co.markAdopted(s.adopter, sent.submissionId, 0);
  assert.equal(s.points(ann), 125, 'and adopting again after the undo does not pay a second time');
  assert.equal(s.sources(ann).filter((source) => source === 'cocreation_adopted').length, 1);
  // The event names the administrator (points moves are audited), and 消费记录 shows it too.
  assert.ok(
    s.f.store.get<{ admin_id: string }>("SELECT admin_id FROM web_points_events WHERE source='cocreation_adopted'")!
      .admin_id,
  );
  assert.ok(
    playerBilling(s.f.store, s.f.clock(), ann.principalId, {}).items.some((item) => item.kind === 'cocreation_adopted'),
  );
  // A guest's adopted note pays nothing, now or ever.
  const guest = s.player('guest', {}),
    theirs = s.card(guest, 'g1', [{ cardId: 'catchphrase', text: '哎呀妈呀！' }]);
  s.co.markAdopted(s.adopter, theirs.submissionId, 0);
  assert.equal(s.f.events(guest.principalId).length, 0);
});

test('24c settings: defaults 5/15/20, owner and points.grant edit them, validated, audited with numbers only, next note uses them', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const owner = s.f.owner,
    granter = s.f.member(['points.grant'], 'Granter'),
    nobody = s.f.member(['cocreation.manage'], 'Nobody');
  assert.deepEqual(s.system.cocreationPoints(owner, {}), { notePoints: 5, dailyCap: 15, adoptPoints: 20, revision: 1 });
  assert.equal(
    code(() => s.system.cocreationPoints(nobody, {})),
    'ADMIN_PERMISSION_REQUIRED',
  );
  assert.equal(
    code(() =>
      s.system.saveCocreationPoints(nobody, { notePoints: 5, dailyCap: 15, adoptPoints: 20, expectedRevision: 1 }),
    ),
    'ADMIN_PERMISSION_REQUIRED',
  );
  for (const bad of [
    { notePoints: -1, dailyCap: 15, adoptPoints: 20 },
    { notePoints: 101, dailyCap: 15, adoptPoints: 20 },
    { notePoints: 5, dailyCap: 101, adoptPoints: 20 },
    { notePoints: 5, dailyCap: 15, adoptPoints: 1001 },
    { notePoints: 5.5, dailyCap: 15, adoptPoints: 20 },
    { notePoints: '5', dailyCap: 15, adoptPoints: 20 },
    { notePoints: 5, dailyCap: 15 },
    { notePoints: 5, dailyCap: 15, adoptPoints: 20, extra: 1 },
  ])
    assert.equal(
      code(() => s.system.saveCocreationPoints(granter, { ...bad, expectedRevision: 1 })),
      'INVALID_REQUEST',
      JSON.stringify(bad),
    );
  const saved = s.system.saveCocreationPoints(granter, {
    notePoints: 7,
    dailyCap: 2,
    adoptPoints: 30,
    expectedRevision: 1,
  });
  assert.deepEqual(saved, { notePoints: 7, dailyCap: 2, adoptPoints: 30, revision: 2 });
  // A stale editor is refused.
  assert.equal(
    code(() =>
      s.system.saveCocreationPoints(owner, { notePoints: 9, dailyCap: 9, adoptPoints: 9, expectedRevision: 1 }),
    ),
    'COCREATION_POINTS_REVISION_CONFLICT',
  );
  assert.equal(
    s.f.store.get<{ target_id: string }>(
      "SELECT target_id FROM web_admin_audit WHERE action='cocreation-points-settings'",
    )!.target_id,
    'note=7;cap=2;adopt=30',
  );
  // The very next note uses them: +7, at most 2 paid a day, +30 on adoption.
  assert.equal(
    s.card(ann, 'r1', [
      { cardId: 'catchphrase', text: '一' },
      { cardId: 'quirk', text: '二' },
      { cardId: 'topics', text: '三' },
    ]).earned,
    14,
  );
  const adopted = s.card(ann, 'r2', [{ cardId: 'free', text: '四' }], 'jojo');
  assert.equal('earned' in adopted, false, 'the third note of the day is over the cap of 2');
  s.co.markAdopted(s.adopter, adopted.submissionId, 0);
  assert.equal(s.points(ann), 100 + 14 + 30);
  // The player's sheet reads the same live numbers.
  assert.deepEqual(s.co.rewards(ann.token, 'csrf-ok', origin), { notePoints: 7, dailyCap: 2, adoptPoints: 30 });
  assert.equal(
    code(() => s.co.rewards('nope', 'csrf-ok', origin)),
    'SESSION_EXPIRED',
  );
  assert.equal(
    code(() => s.co.rewards(ann.token, 'bad', origin)),
    'CSRF_INVALID',
  );
});

/** The cast draft with the two characters of the pair in it (a story can only name characters the draft holds). */
function castWithPair(s: ReturnType<typeof setup>) {
  const raw = sampleCastRaw();
  const two = raw.characters
    .slice(1, 3)
    .map((entry, index) => ({ ...entry, characterId: ['wei-guagua', 'jojo'][index]! }));
  const doc = {
    ...raw,
    characters: two,
    people: [],
    ratings: {},
    directions: [],
    groups: [],
    stories: [],
    memes: [],
  };
  const stored = normalizeCastDoc(doc, { known: new Set(), fresh: counterIds() });
  void stored;
  return saveDraft(s.f.store as never, s.f.clock(), 1, doc);
}

test('24c adoption to the cast: a pair note becomes a story of the DRAFT with both participants, CAS-guarded, never published', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const saved = castWithPair(s);
  const sent = s.note(ann, 'p1', '她们小学同桌三年');
  const before = readDraft(s.f.store as never);
  assert.equal(before.revision, saved.revision);
  // A stale revision is refused and NOTHING happens: no story, no adoption, no points.
  const stale = code(() => s.co.addToCastStory(s.adopter, sent.submissionId, 0, before.revision - 1));
  assert.equal(stale, 'CAST_REVISION_CONFLICT');
  assert.equal(readDraft(s.f.store as never).doc.stories.length, 0);
  assert.equal(s.co.detail(s.adopter, sent.submissionId).answers[0]!.adoptedAt, null);
  assert.equal(s.points(ann), 105);
  const done = s.co.addToCastStory(s.adopter, sent.submissionId, 0, before.revision);
  assert.equal(done.castRevision, before.revision + 1);
  const draft = readDraft(s.f.store as never);
  assert.equal(draft.doc.stories.length, 1);
  assert.deepEqual([...draft.doc.stories[0]!.participants].sort(), ['jojo', 'wei-guagua']);
  assert.equal(draft.doc.stories[0]!.summary, '她们小学同桌三年');
  assert.ok(
    draft.doc.stories[0]!.title.length > 0 && [...draft.doc.stories[0]!.title].length <= CAST_LIMITS.storyTitle,
  );
  // Adopted (+20 once), and the cast was never published.
  assert.ok(s.co.detail(s.adopter, sent.submissionId).answers[0]!.adoptedAt !== null);
  assert.equal(s.points(ann), 125);
  assert.equal(s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cast_publications')!.n, 0);
  // Only a pair note can go there, and only with cast.edit.
  const card = s.card(ann, 'c1', [{ cardId: 'free', text: '别的想法' }]);
  assert.equal(
    code(() => s.co.addToCastStory(s.adopter, card.submissionId, 0, draft.revision)),
    'INVALID_REQUEST',
  );
  const reader = s.f.member(['cocreation.manage', 'cast.read'], 'Reader');
  const another = s.note(ann, 'p2', '第二个故事');
  assert.equal(
    code(() => s.co.addToCastStory(reader, another.submissionId, 0, draft.revision)),
    'ADMIN_PERMISSION_REQUIRED',
  );
  assert.equal(
    code(() => s.co.addToCastStory(s.adopter, another.submissionId, 0, 'x')),
    'INVALID_REQUEST',
  );
});

test('24c routes: memo / pair / rewards need a session, CSRF and Origin, take exactly their keys; the admin routes exist', async (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const hash = 'a'.repeat(64);
  const req = (path: string, body: unknown, over: Record<string, unknown> = {}) =>
    ({
      method: 'POST',
      path: `/api/web/local/cocreation/${path}`,
      body,
      playerToken: ann.token,
      csrf: 'csrf-ok',
      origin,
      trustedIpHash: hash,
      ...over,
    }) as never;
  const memo = routeWebCocreation(s.co, req('memo', { requestId: 'm1', text: '你好' }))!;
  assert.equal(memo.status, 201);
  assert.equal(
    routeWebCocreation(s.co, req('memo', { requestId: 'm1', text: '你好' }))!.status,
    200,
    'a replay is 200',
  );
  const pair = routeWebCocreation(
    s.co,
    req('pair', { requestId: 'p1', text: '故事', characterId: 'wei-guagua', partnerId: 'jojo' }),
  )!;
  assert.equal(pair.status, 201);
  assert.equal((pair.body as { earned: number }).earned, 5);
  assert.deepEqual(routeWebCocreation(s.co, req('rewards', {}))!.body, {
    notePoints: 5,
    dailyCap: 15,
    adoptPoints: 20,
  });
  for (const bad of [
    req('memo', { requestId: 'm2', text: 'x', extra: 1 }),
    req('memo', { requestId: 'm2' }),
    req('pair', { requestId: 'p2', text: 'x', characterId: 'wei-guagua' }),
    req('rewards', { x: 1 }),
  ])
    assert.equal(
      code(() => routeWebCocreation(s.co, bad)),
      'INVALID_REQUEST',
    );
  for (const path of ['memo', 'pair', 'rewards']) {
    const body = path === 'rewards' ? {} : { requestId: 'z', text: 'x', characterId: 'wei-guagua', partnerId: 'jojo' };
    const shaped = path === 'memo' ? { requestId: 'z', text: 'x' } : body;
    assert.equal(
      code(() => routeWebCocreation(s.co, req(path, shaped, { playerToken: undefined }))),
      'AUTH_REQUIRED',
      path,
    );
    assert.equal(
      code(() => routeWebCocreation(s.co, req(path, shaped, { csrf: undefined }))),
      'CSRF_INVALID',
      path,
    );
    assert.equal(
      code(() => routeWebCocreation(s.co, req(path, shaped, { origin: 'https://evil.invalid' }))),
      'CSRF_INVALID',
      path,
    );
    assert.equal(
      code(() => routeWebCocreation(s.co, { ...(req(path, shaped) as object), method: 'GET' } as never)),
      'NOT_FOUND',
      path,
    );
  }
  assert.equal(
    code(() => routeWebCocreation(s.co, req('memo', { requestId: 'm9', text: 'x' }, { trustedIpHash: undefined }))),
    'WEB_TRUSTED_IP_REQUIRED',
  );
  // The admin side: the same business object behind /admin/cocreation/{unadopt,cast-story}.
  const admin = (action: string, body: unknown) =>
    routeWebAccountAdmin(
      s.f.accounts,
      {
        method: 'POST',
        path: `/api/web/local/admin/cocreation/${action}`,
        body,
        adminCookie: s.adopter.cookie,
        csrf: s.adopter.csrf,
        origin,
      } as never,
      undefined,
      s.co,
    );
  const sentId = (pair.body as { submissionId: string }).submissionId;
  assert.deepEqual(
    ((await admin('adopt', { id: sentId, ordinal: 0 }))!.body as { status: string }).status,
    'processed',
  );
  assert.deepEqual(((await admin('unadopt', { id: sentId, ordinal: 0 }))!.body as { ordinal: number }).ordinal, 0);
  await assert.rejects(() => admin('unadopt', { id: sentId, ordinal: 0, extra: 1 }), /INVALID_REQUEST/);
});

test('24c migration 131 on a database that has data: existing events, ids and the statistics trigger survive the rebuild', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  // The bonus event of the fixture was copied with its id; the ledger still adds up and the append-only trigger is back.
  assert.equal(s.f.events(ann.principalId)[0]![0], 'bonus');
  assert.throws(() => s.f.store.run('UPDATE web_points_events SET delta=1'), /WEB_POINTS_EVENT_IMMUTABLE/);
  // The CHECK now allows the two sources only with a ref and a positive amount, and never an operation.
  const insert = (source: string, ref: string | null, delta: number, admin: string | null = null) =>
    s.f.store.run(
      'INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at,ref) VALUES (?,NULL,?,NULL,?,?,2,?,?)',
      ann.principalId,
      source,
      delta,
      admin,
      s.f.clock(),
      ref,
    );
  assert.throws(() => insert('cocreation_note', null, 5), /CHECK/);
  assert.throws(() => insert('cocreation_note', 'r', -5), /CHECK/);
  assert.throws(() => insert('grant', 'r', 5), /CHECK/);
  assert.throws(() => insert('cocreation_note', 'r', 5, 'admin'), /CHECK/);
  insert('cocreation_note', 'r', 5);
  assert.throws(() => insert('cocreation_note', 'r', 5), /UNIQUE/);
  assert.equal(
    s.f.store.get<{ value: number }>("SELECT value FROM web_stats_daily WHERE metric='points_cocreation_note'")!.value,
    5,
  );
  assert.ok(cardCount() > 0);
  function cardCount() {
    return COCREATION_CARDS.length;
  }
});

test('131 is the 56th and last step: the same SQL on both authorities, and the 55 steps of main did not move a byte', () => {
  const { inline, r2 } = expectedWebMigrations();
  assert.equal(inline.length, 56);
  assert.equal(r2.length, 56);
  assert.equal(inline.at(-1)!.version, 131);
  const file = readFileSync(
    new URL('../../../apps/server/web-migrations/131_cocreation_points.sql', import.meta.url),
    'utf8',
  );
  assert.equal(inline.at(-1)!.sha256, sha(file), 'the ledger hash is the sha256 of the SQL file as written');
  assert.deepEqual(r2.at(-1), inline.at(-1), '131 is the same SQL on both authorities');
  // Part 24c (named, pinned): changing the file is a new migration. Recorded when 131 was written.
  assert.equal(inline.at(-1)!.sha256, 'a6f581dd6b9bf482d72c035dd6d693b5a4330aae195123aef16106e0e370990a');
  // main's 55 steps (80cebc4), both lists, as one digest each: nothing in 1-130 moved. 130 is still 8ec416d7…5621.
  assert.equal(
    sha(JSON.stringify(inline.slice(0, 55))),
    '42cfe9a186ecdd08003aff4a57fb31bf454d93d7b16853ab3d8817b758ee5c29',
  );
  assert.equal(
    sha(JSON.stringify(r2.slice(0, 55))),
    '1d0e39b83d5f54cdb6630b5c1d7e6de888dd58feeef84fae5ad3f2f915f490e0',
  );
  assert.equal(
    inline[54]!.sha256,
    '8ec416d7f741b65203a30dc215e902b37810e76283c1c84d7a0f8a66508b5621',
    '130 is untouched',
  );
});

test('131 on a database that had co-creation data: nothing is lost, the old rows are character notes, the defaults are 5 / 15 / 20', (t) => {
  // Build the schema one step short of 131 (a store with data in the tables 131 changes), then take the step.
  const before = tiersFixture(t, { stats: true, extras: true });
  const ann = before.player('ann', { signedUp: true });
  before.store.run(
    `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at) VALUES ('old-1','wei-guagua',?,'r1',?,?)`,
    ann.principalId,
    'a'.repeat(64),
    T0,
  );
  before.store.run(
    `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES ('old-1',0,'free','free','text','"旧的想法"')`,
  );
  const eventsBefore = before.store.all('SELECT id,source,delta,created_at FROM web_points_events ORDER BY id');
  migrateWebProviderCocreationPoints(before.store);
  assert.deepEqual(
    before.store.all('SELECT id,source,delta,created_at FROM web_points_events ORDER BY id'),
    eventsBefore,
  );
  assert.deepEqual(
    { ...before.store.get('SELECT kind,partner_id FROM web_cocreation_submissions') },
    { kind: 'character', partner_id: null },
  );
  assert.deepEqual(
    { ...before.store.get('SELECT adopt_paid,paid_points,note_hash FROM web_cocreation_answers') },
    { adopt_paid: 0, paid_points: 0, note_hash: null },
  );
  assert.deepEqual(
    { ...before.store.get('SELECT note_points,daily_cap,adopt_points,revision FROM web_cocreation_points') },
    { note_points: 5, daily_cap: 15, adopt_points: 20, revision: 1 },
  );
  assert.equal(before.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 131);
  assert.equal(before.store.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(
    () => migrateWebProviderCocreationPoints(before.store),
    /WEB_PROVIDER_COCREATION_POINTS_MIGRATION_REQUIRED/,
  );
  // The AUTOINCREMENT counter was not wound back: the next event id is above every old one.
  before.store.run(
    "INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,price_version,created_at,ref) VALUES (?,NULL,'cocreation_note',NULL,5,2,?,'x:0')",
    ann.principalId,
    T0,
  );
  assert.ok(
    before.store.get<{ id: number }>("SELECT id FROM web_points_events WHERE ref='x:0'")!.id >
      (eventsBefore.at(-1) as { id: number }).id,
  );
});
