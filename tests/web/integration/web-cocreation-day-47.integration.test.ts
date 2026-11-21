// Part 47: the fixed card 「一天」 on the server: parts stored as ordinary text answers (no schema change), idempotent hand-over, the
// daily rule is one for the whole card, points count it once, and an adoption only marks the answer (nothing is published).
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSecurityCounters, installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCocreation } from '../../../apps/server/cocreation/web-cocreation.ts';
import { DomainError, RetryAfterError } from '../../../packages/domain/errors.ts';
import { DAY, T0, origin, tiersFixture } from '../fixtures/invite-tiers.ts';

const code = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError || error instanceof RetryAfterError) return error.code;
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
  const player = (name: string, o: Parameters<typeof f.player>[1] = { signedUp: true }) => {
    const who = f.player(name, o);
    tokens.set(who.token, who.principalId);
    return who;
  };
  const card = (who: { token: string }, requestId: string, answers: unknown, characterId = 'wei-guagua') =>
    co.submit(who.token, 'csrf-ok', origin, { characterId, requestId, answers });
  const adopter = f.member(['cocreation.manage', 'cocreation.read', 'cast.edit', 'cast.read'], 'Adopter');
  const points = (who: { principalId: string }) => f.balance(who.principalId);
  const sources = (who: { principalId: string }) => f.events(who.principalId).map(([source]) => source);
  return { f, co, player, card, adopter, points, sources, tokens };
}

const none = { characterId: null, status: null, starred: null, query: null, before: null };

test('47: the parts are stored as ordinary text answers, the answered parts are the rows, a replay is the same reply', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const answers = [
    { cardId: 'day-morning', text: '先喂猫，再慢慢煮咖啡' },
    { cardId: 'day-whole', text: '一整天都在晒太阳' },
  ];
  const first = s.card(ann, 'r1', answers);
  assert.equal(first.answered, 2);
  assert.equal(first.duplicate, false);
  assert.deepEqual(s.card(ann, 'r1', answers), { ...first, duplicate: true });
  assert.equal(
    s.f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_answers')!.n,
    2,
    'a replay writes nothing',
  );
  assert.deepEqual(
    s.f.store
      .all<{ card_id: string; kind: string; target_field: string }>(
        'SELECT card_id,kind,target_field FROM web_cocreation_answers ORDER BY ordinal',
      )
      .map((row) => ({ ...row })),
    [
      { card_id: 'day-morning', kind: 'text', target_field: 'free' },
      { card_id: 'day-whole', kind: 'text', target_field: 'free' },
    ],
  );
  const detail = s.co.detail(s.adopter, first.submissionId);
  assert.deepEqual(
    detail.answers.map((answer) => [answer.cardId, 'text' in answer ? answer.text : '']),
    [
      ['day-morning', '先喂猫，再慢慢煮咖啡'],
      ['day-whole', '一整天都在晒太阳'],
    ],
  );
  // the same request id with other content is a conflict, never a second note
  assert.equal(
    code(() => s.card(ann, 'r1', [answers[0]])),
    'IDEMPOTENCY_CONFLICT',
  );
});

test('47: at least one part; each part within its cap', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  assert.equal(
    code(() => s.card(ann, 'e', [])),
    'COCREATION_EMPTY',
  );
  assert.equal(
    code(() => s.card(ann, 'b', [{ cardId: 'day-noon', text: '  ' }])),
    'COCREATION_TEXT_INVALID',
  );
  assert.equal(
    code(() => s.card(ann, 'l', [{ cardId: 'day-evening', text: '长'.repeat(301) }])),
    'COCREATION_TEXT_INVALID',
  );
  assert.equal(
    code(() => s.card(ann, 'w', [{ cardId: 'day-whole', text: '长'.repeat(801) }])),
    'COCREATION_TEXT_INVALID',
  );
  assert.equal(
    code(() => s.card(ann, 'ok', [{ cardId: 'day-whole', text: '长'.repeat(800) }])),
    'ok',
  );
});

test('47: one 一天 per player per character per UTC day (any part closes the card), the next day opens it again', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  s.card(ann, 'r1', [{ cardId: 'day-morning', text: '先喂猫' }]);
  assert.equal(
    code(() => s.card(ann, 'r2', [{ cardId: 'day-noon', text: '午睡' }])),
    'COCREATION_DAILY_LIMIT',
  );
  assert.deepEqual(s.co.usedToday(ann.token, 'csrf-ok', origin, 'wei-guagua').cardIds, ['day-morning']);
  // another character, and a theme card, are not affected
  assert.equal(
    code(() => s.card(ann, 'r3', [{ cardId: 'day-noon', text: '午睡' }], 'jojo')),
    'ok',
  );
  assert.equal(
    code(() => s.card(ann, 'r4', [{ cardId: 'theme-habit', text: '爱转笔', wording: '{name}有哪些小习惯？' }])),
    'ok',
  );
  s.f.setNow(midnight + DAY + 3_600_000);
  assert.equal(
    code(() => s.card(ann, 'r5', [{ cardId: 'day-noon', text: '午睡' }])),
    'ok',
  );
});

test('47: the parts of one 一天 are one note for points (+5 once, not per part), and adopting parts pays the reward once', (t) => {
  const s = setup(t),
    ann = s.player('ann');
  const sent = s.card(ann, 'r1', [
    { cardId: 'day-morning', text: '先喂猫' },
    { cardId: 'day-noon', text: '午睡' },
    { cardId: 'day-whole', text: '晒太阳' },
  ]);
  assert.equal(sent.earned, 5);
  assert.equal(s.points(ann), 105);
  const before = s.f.store.all('SELECT id,config_json FROM character_templates ORDER BY id');
  s.co.markAdopted(s.adopter, sent.submissionId, 0);
  s.co.markAdopted(s.adopter, sent.submissionId, 1);
  s.co.markAdopted(s.adopter, sent.submissionId, 2);
  assert.equal(s.points(ann), 125, 'the adoption reward (+20) is paid once for the whole 一天');
  // an adoption only marks the answer: no template changed, nothing was published
  assert.deepEqual(s.f.store.all('SELECT id,config_json FROM character_templates ORDER BY id'), before);
  const detail = s.co.detail(s.adopter, sent.submissionId);
  assert.ok(detail.answers.every((answer) => answer.adoptedAt !== null));
  assert.equal(s.co.list(s.adopter, none).items.length, 1);
});
