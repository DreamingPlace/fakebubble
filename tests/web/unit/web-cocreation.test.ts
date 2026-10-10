import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { WebCocreation } from '../../../apps/server/cocreation/web-cocreation.ts';
import { routeWebCocreation } from '../../../apps/server/cocreation/web-cocreation-routes.ts';
import { webProviderHTTPError } from '../../../apps/server/platform/web-provider-http-error.ts';
import { WEB_PROVIDER_CATALOG } from '../../../config/web-v1.ts';
import {
  COCREATION_CARDS,
  COCREATION_LIMITS,
  validateCocreationAnswers,
} from '../../../packages/contracts/cocreation-cards.ts';
import { adoptIntoTemplate, suggestAdoptDraft, type AdoptDraft } from '../../../packages/contracts/cocreation-adopt.ts';
import type { CharacterTemplate } from '../../../packages/contracts/index.ts';

const origin = 'https://fixture.invalid';
const T0 = 1_800_000_000_000;

function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.all(
    'CREATE TABLE web_provider_voice_bindings(character_id TEXT PRIMARY KEY,approved INTEGER,source TEXT) STRICT',
  );
  for (const item of WEB_PROVIDER_CATALOG) {
    const template = {
      id: item.characterId,
      name: item.displayName,
      version: 1,
      fictional: true,
      persona: '合成角色，非真实材料',
      schedule: defaultSchedule(),
    };
    store.run('INSERT INTO character_templates VALUES (?,1,?)', item.characterId, JSON.stringify(template));
    store.run("INSERT INTO web_provider_voice_bindings VALUES (?,1,'user_selected')", item.characterId);
  }
  // The identity-owned and invite tables the inbox reads; the real ones come from migrations 100-111.
  store.db.exec('CREATE TABLE web_principals(id TEXT PRIMARY KEY, player_id TEXT, world_id TEXT, kind TEXT) STRICT');
  for (const file of ['111_invite_core.sql', '117_cocreation.sql'])
    store.db.exec(readFileSync(new URL(`../../../apps/server/web-migrations/${file}`, import.meta.url), 'utf8'));
  let now = T0,
    ids = 0;
  const clock = { now: () => now };
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebCharacterCatalog(store);
  const characters = new WebCharacterAdmin(store, clock, accounts);

  // A tiny identity: tokens map to principals; only `invite` kinds with a live grant count as invited.
  const principals = new Map<string, { principalId: string; kind: 'guest' | 'invite'; invited: boolean }>();
  const player = (name: string, kind: 'guest' | 'invite' = 'invite', batch = 'batch-spring') => {
    const principalId = `principal-${name}`;
    store.run('INSERT INTO api_players VALUES (?,?)', `player-${name}`, now);
    store.run('INSERT INTO worlds VALUES (?,?,?,?)', `world-${name}`, `player-${name}`, 'UTC', '{}');
    store.run('INSERT INTO web_principals VALUES (?,?,?,?)', principalId, `player-${name}`, `world-${name}`, kind);
    principals.set(`token-${name}`, { principalId, kind, invited: kind === 'invite' });
    if (kind === 'invite') {
      const adminSession = store.get<{ id: string }>('SELECT id FROM admin_sessions LIMIT 1')!.id;
      store.run(
        `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,access_duration_ms,status,batch,created_by,created_at)
        VALUES (?,?,?,?,NULL,'active',?,?,?)`,
        `code-${name}`,
        `${name}`.padEnd(64, 'd'),
        `issue-${name}`,
        'e'.repeat(64),
        batch,
        adminSession,
        now,
      );
      store.run(
        `INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at) VALUES (?,?,?,?,?,?)`,
        `grant-${name}`,
        `code-${name}`,
        principalId,
        `player-${name}`,
        `world-${name}`,
        now,
      );
    }
    return { token: `token-${name}`, csrf: 'csrf-ok', principalId };
  };
  const identity = {
    authorizeWrite(token: string, csrf: string, from: string) {
      if (csrf !== 'csrf-ok' || from !== origin) throw new DomainError('CSRF_INVALID');
      const row = principals.get(token);
      if (!row) throw new DomainError('SESSION_EXPIRED');
      return { principalId: row.principalId, world_id: 'w', player_id: 'p', kind: row.kind };
    },
    isInvitedSession: (token: string) => principals.get(token)?.invited === true,
  };
  const cocreation = new WebCocreation(
    store,
    clock,
    identity as never,
    accounts,
    Buffer.alloc(32, 7),
    () => `sub-${++ids}`,
  );

  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const member = (permissions: string[], label = 'Reader') => {
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-${label}-${++ids}`,
      label,
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };
  const submit = (
    who: { token: string; csrf: string },
    requestId: string,
    answers: unknown = [{ cardId: 'catchphrase', text: '哎呀妈呀' }],
    characterId = 'wei-guagua',
  ) => cocreation.submit(who.token, who.csrf, origin, { characterId, requestId, answers });
  return {
    store,
    accounts,
    characters,
    cocreation,
    ownerAuth,
    member,
    player,
    submit,
    advance: (ms: number) => {
      now += ms;
    },
    clockNow: () => now,
  };
}
const list = (f: ReturnType<typeof fixture>, auth: object, over: Record<string, unknown> = {}) =>
  f.cocreation.list(auth as never, {
    characterId: null,
    status: null,
    starred: null,
    query: null,
    before: null,
    ...over,
  });
const code = (error: unknown) => (error as { code?: string }).code;

test('the shared card list: every target field is covered, ids are unique and the dialogue card is the only dialogue', () => {
  assert.equal(new Set(COCREATION_CARDS.map((card) => card.id)).size, COCREATION_CARDS.length);
  assert.deepEqual([...new Set(COCREATION_CARDS.map((card) => card.targetField))].sort(), [
    'boundaries',
    'dialogueExamples',
    'dialogueStyle',
    'fictionalPeople',
    'free',
    'interests',
    'persona',
    'personalityLayers',
    'speechStyle',
  ]);
  assert.deepEqual(
    COCREATION_CARDS.filter((card) => card.kind === 'dialogue').map((card) => card.id),
    ['dialogue'],
  );
  assert.ok(
    COCREATION_CARDS.every((card) => card.id === 'dialogue' || card.id === 'free' || card.prompt.includes('{name}')),
  );
});

test('answers are validated against the card list: unknown, duplicate, empty, oversized and control characters are refused', () => {
  const ok = (answers: unknown) => validateCocreationAnswers(answers);
  const bad = (answers: unknown) => (ok(answers) as { ok: false; code: string }).code;
  assert.equal(ok([{ cardId: 'catchphrase', text: '嗯' }]).ok, true);
  assert.equal(bad([]), 'COCREATION_EMPTY');
  assert.equal(bad('x'), 'COCREATION_EMPTY');
  assert.equal(bad([{ cardId: 'nope', text: 'x' }]), 'COCREATION_CARD_INVALID');
  assert.equal(
    bad([
      { cardId: 'quirk', text: 'a' },
      { cardId: 'quirk', text: 'b' },
    ]),
    'COCREATION_CARD_INVALID',
    'a card is answered once',
  );
  assert.equal(bad([{ cardId: 'quirk', text: '   ' }]), 'COCREATION_TEXT_INVALID');
  assert.equal(
    bad([{ cardId: 'quirk', text: 'a\nb' }]),
    'COCREATION_TEXT_INVALID',
    'no control characters, not even a newline',
  );
  assert.equal(bad([{ cardId: 'quirk', text: 'a\u0000' }]), 'COCREATION_TEXT_INVALID');
  assert.equal(bad([{ cardId: 'quirk', text: '字'.repeat(COCREATION_LIMITS.text) }]) === undefined, true);
  assert.equal(bad([{ cardId: 'quirk', text: '字'.repeat(COCREATION_LIMITS.text + 1) }]), 'COCREATION_TEXT_INVALID');
  assert.equal(
    ok([{ cardId: 'free', text: '字'.repeat(COCREATION_LIMITS.free) }]).ok,
    true,
    'the free card takes 1000',
  );
  assert.equal(bad([{ cardId: 'free', text: '字'.repeat(COCREATION_LIMITS.free + 1) }]), 'COCREATION_TEXT_INVALID');
  assert.equal(ok([{ cardId: 'quirk', text: '😀'.repeat(COCREATION_LIMITS.text) }]).ok, true, 'counted in code points');
  assert.equal(bad([{ cardId: 'quirk', text: 'x', extra: 1 }]), 'INVALID_REQUEST');
  assert.equal(bad([{ cardId: 'quirk' }]), 'INVALID_REQUEST');
  assert.equal(bad([null]), 'INVALID_REQUEST');
  const dialogue = (over: Record<string, unknown>) => [
    { cardId: 'dialogue', player: '你好', replies: ['嗯'], ...over },
  ];
  assert.equal(ok(dialogue({})).ok, true);
  assert.equal(ok(dialogue({ replies: ['一', '二'] })).ok, true, 'up to two reply bubbles');
  assert.equal(bad(dialogue({ replies: ['一', '二', '三'] })), 'COCREATION_TEXT_INVALID');
  assert.equal(bad(dialogue({ replies: [] })), 'COCREATION_TEXT_INVALID');
  assert.equal(bad(dialogue({ player: '字'.repeat(121) })), 'COCREATION_TEXT_INVALID');
  assert.equal(bad(dialogue({ replies: ['字'.repeat(121)] })), 'COCREATION_TEXT_INVALID');
  assert.equal(ok(dialogue({ player: '字'.repeat(120), replies: ['字'.repeat(120)] })).ok, true);
  assert.equal(bad([{ cardId: 'dialogue', text: 'x' }]), 'INVALID_REQUEST', 'a dialogue card has no plain text');
  const twelve = COCREATION_CARDS.slice(0, 12).map((card) =>
    card.kind === 'dialogue' ? { cardId: card.id, player: 'a', replies: ['b'] } : { cardId: card.id, text: 'a' },
  );
  assert.equal(ok(twelve).ok, true, 'twelve answers are allowed');
  assert.equal(COCREATION_CARDS.length, 12);
  assert.equal(bad([...twelve, { cardId: 'quirk', text: 'a' }]), 'COCREATION_TOO_MANY_ANSWERS');
});

test('submit stores answers in order with the card’s own target field; only an invited player may submit', (t) => {
  const f = fixture(t),
    ann = f.player('ann'),
    guest = f.player('guest', 'guest');
  const result = f.submit(ann, 'req-1', [
    { cardId: 'dialogue', player: '夸你一句', replies: ['才没有', '哼'] },
    { cardId: 'cannot-stand', text: '吵闹' },
  ]);
  assert.deepEqual(result, { submissionId: 'sub-1', answered: 2, duplicate: false });
  const detail = f.cocreation.detail(f.ownerAuth, 'sub-1');
  assert.deepEqual(
    detail.answers.map((a) => [a.ordinal, a.cardId, a.targetField, a.kind]),
    [
      [0, 'dialogue', 'dialogueExamples', 'dialogue'],
      [1, 'cannot-stand', 'boundaries', 'text'],
    ],
  );
  assert.deepEqual((detail.answers[0] as { replies: string[] }).replies, ['才没有', '哼']);
  assert.equal(detail.status, 'new');

  assert.throws(() => f.submit(guest, 'req-g'), /COCREATION_INVITE_REQUIRED/, 'a guest cannot submit');
  assert.throws(() => f.submit({ ...ann, csrf: 'wrong' }, 'req-2'), /CSRF_INVALID/);
  assert.throws(() => f.submit({ token: 'token-unknown', csrf: 'csrf-ok' }, 'req-2'), /SESSION_EXPIRED/);
  assert.throws(
    () =>
      f.cocreation.submit(ann.token, ann.csrf, 'https://evil.invalid', {
        characterId: 'wei-guagua',
        requestId: 'r',
        answers: [],
      }),
    /CSRF_INVALID/,
  );
  assert.throws(() => f.submit(ann, 'req-3', undefined, 'no-such-character'), /NOT_FOUND/);
  assert.throws(() => f.submit(ann, 'bad id!'), /INVALID_REQUEST/);
  assert.throws(() => f.submit(ann, 'req-4', [{ cardId: 'quirk', text: 'a\nb' }]), /COCREATION_TEXT_INVALID/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_submissions')!.n, 1);
});

test('a lapsed invite (no live grant) is refused even though its principal kind is invite', (t) => {
  const f = fixture(t);
  const ann = f.player('ann');
  // The identity reports the session as not invited: the grant was revoked or expired.
  const principals = (f.cocreation as unknown as { identity: { isInvitedSession: (t: string) => boolean } }).identity;
  const original = principals.isInvitedSession;
  principals.isInvitedSession = () => false;
  assert.throws(() => f.submit(ann, 'req-1'), /COCREATION_INVITE_REQUIRED/);
  principals.isInvitedSession = original;
  assert.equal(f.submit(ann, 'req-1').duplicate, false);
});

test('submit is idempotent on requestId: the same content replays, other content conflicts, nothing is written twice', (t) => {
  const f = fixture(t),
    ann = f.player('ann');
  const first = f.submit(ann, 'same');
  const again = f.submit(ann, 'same');
  assert.deepEqual(again, { ...first, duplicate: true });
  assert.throws(() => f.submit(ann, 'same', [{ cardId: 'catchphrase', text: '换了内容' }]), /IDEMPOTENCY_CONFLICT/);
  assert.throws(
    () => f.submit(ann, 'same', undefined, 'jojo'),
    /IDEMPOTENCY_CONFLICT/,
    'another character is other content',
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_submissions')!.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_answers')!.n, 1);
  const bob = f.player('bob');
  assert.equal(f.submit(bob, 'same').duplicate, false, 'request ids are per player');
});

test('at most five submissions per player and character in a rolling 24 hours; replays and other scopes do not count', (t) => {
  const f = fixture(t),
    ann = f.player('ann'),
    bob = f.player('bob');
  for (let i = 0; i < 5; i++) {
    f.submit(ann, `r${i}`);
    f.advance(60_000);
  }
  f.submit(ann, 'r0'); // an idempotent replay is not a sixth submission
  let refusal: unknown;
  try {
    f.submit(ann, 'r5');
  } catch (error) {
    refusal = error;
  }
  assert.equal(code(refusal), 'COCREATION_RATE_LIMITED');
  const wait = (refusal as { retryAfterMs: number }).retryAfterMs;
  assert.equal(
    wait,
    T0 + COCREATION_LIMITS.windowMs - f.clockNow(),
    'retry-after is when the oldest leaves the window',
  );
  assert.equal(webProviderHTTPError(refusal).status, 429);
  assert.equal(f.submit(ann, 'jojo-1', undefined, 'jojo').duplicate, false, 'another character has its own allowance');
  assert.equal(f.submit(bob, 'b1').duplicate, false, 'another player has their own allowance');
  f.advance(wait);
  assert.equal(f.submit(ann, 'r5').duplicate, false, 'the window rolls');
  assert.throws(() => f.submit(ann, 'r6'), /COCREATION_RATE_LIMITED/);
});

test('HTTP status mapping: invalid input 400, not invited 403, limit 429', () => {
  for (const [codeName, status] of [
    ['COCREATION_EMPTY', 400],
    ['COCREATION_TEXT_INVALID', 400],
    ['COCREATION_CARD_INVALID', 400],
    ['COCREATION_TOO_MANY_ANSWERS', 400],
    ['COCREATION_INVITE_REQUIRED', 403],
  ] as const)
    assert.equal(webProviderHTTPError(new DomainError(codeName)).status, status, codeName);
});

test('the player route: exact body keys, 201 then 200 on replay, and the limit and invite checks come through', (t) => {
  const f = fixture(t),
    ann = f.player('ann');
  const post = (body: unknown, over: Record<string, unknown> = {}) =>
    routeWebCocreation(f.cocreation, {
      method: 'POST',
      path: '/api/web/local/cocreation/submit',
      origin,
      csrf: ann.csrf,
      playerToken: ann.token,
      body,
      ...over,
    })!;
  const body = { characterId: 'wei-guagua', requestId: 'route-1', answers: [{ cardId: 'quirk', text: '爱数台阶' }] };
  assert.equal(post(body).status, 201);
  assert.equal(post(body).status, 200);
  assert.throws(() => post({ ...body, extra: 1 }), /INVALID_REQUEST/);
  assert.throws(() => post({ characterId: 'wei-guagua' }), /INVALID_REQUEST/);
  assert.throws(() => post([]), /INVALID_REQUEST/);
  assert.throws(() => post(body, { csrf: undefined }), /CSRF_INVALID/);
  assert.throws(() => post(body, { playerToken: undefined }), /AUTH_REQUIRED/);
  assert.equal(
    routeWebCocreation(f.cocreation, { method: 'POST', path: '/api/web/local/cocreation/other', body: {} }),
    null,
  );
  assert.throws(() => post(body, { method: 'GET' }), /NOT_FOUND/);
});

test('the inbox needs the new permissions: read to view, manage to change; the owner has both; categories do not imply them', (t) => {
  const f = fixture(t),
    ann = f.player('ann');
  f.submit(ann, 'r1');
  const none = f.member([], 'None'),
    chars = f.member(['category.characters', 'category.publication'], 'Chars'),
    reader = f.member(['cocreation.read'], 'Reader'),
    manager = f.member(['cocreation.manage'], 'Manager');
  for (const denied of [none, chars]) {
    assert.throws(() => list(f, denied), /ADMIN_PERMISSION_REQUIRED/);
    assert.throws(() => f.cocreation.counts(denied), /ADMIN_PERMISSION_REQUIRED/);
    assert.throws(() => f.cocreation.detail(denied, 'sub-1'), /ADMIN_PERMISSION_REQUIRED/);
    assert.throws(() => f.cocreation.star(denied, 'sub-1', true), /ADMIN_PERMISSION_REQUIRED/);
  }
  assert.equal(list(f, reader).items.length, 1);
  assert.equal(f.cocreation.detail(reader, 'sub-1').id, 'sub-1');
  assert.deepEqual(f.cocreation.counts(reader), { counts: { 'wei-guagua': 1 } });
  assert.throws(() => f.cocreation.setStatus(reader, ['sub-1'], 'archived'), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.cocreation.star(reader, 'sub-1', true), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.cocreation.note(reader, 'sub-1', 'x'), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.cocreation.markAdopted(reader, 'sub-1', 0), /ADMIN_PERMISSION_REQUIRED/);
  assert.equal(list(f, manager).items.length, 1, 'manage includes read');
  assert.equal(f.cocreation.star(manager, 'sub-1', true).starred, true);
  assert.equal(f.cocreation.star(f.ownerAuth, 'sub-1', false).starred, false);
  assert.throws(() => list(f, { ...f.ownerAuth, csrf: 'f'.repeat(64) }), /ADMIN_CSRF_REQUIRED/);
  assert.throws(() => list(f, { ...f.ownerAuth, origin: 'https://evil.invalid' }), /ADMIN_UNAUTHORIZED/);
  assert.throws(() => list(f, { cookie: undefined, csrf: undefined, origin }), /ADMIN_UNAUTHORIZED/);
  // Taking the permission back is immediate.
  f.accounts.setPermissions(
    f.ownerAuth.cookie,
    f.ownerAuth.csrf,
    origin,
    f.accounts.session(reader.cookie).member.id,
    [],
  );
  assert.throws(() => list(f, reader), /ADMIN_PERMISSION_REQUIRED/);
});

test('the permission strings are accepted by the member editor and nothing else of that shape is', (t) => {
  const f = fixture(t);
  let n = 0;
  const issue = (permissions: string[]) =>
    f.accounts.issueMember(f.ownerAuth.cookie, f.ownerAuth.csrf, origin, {
      requestId: `p${++n}`,
      label: 'x',
      memberId: null,
      permissions,
    });
  assert.ok(issue(['cocreation.read', 'cocreation.manage']).token);
  assert.throws(() => issue(['cocreation.delete']), /INVALID_REQUEST/);
  assert.throws(() => issue(['cocreation.read:wei-guagua']), /INVALID_REQUEST/);
});

test('the inbox shows a stable pseudonym and the invite batch, and never an identity', (t) => {
  const f = fixture(t),
    ann = f.player('ann', 'invite', '春季内测'),
    bob = f.player('bob');
  f.submit(ann, 'r1');
  f.submit(ann, 'r2');
  f.submit(bob, 'r3');
  const items = list(f, f.ownerAuth).items;
  assert.equal(items.length, 3);
  const [bobItem, annTwo, annOne] = items;
  assert.match(annOne!.pseudonym, /^玩家#[0-9a-f]{4}$/);
  assert.equal(annOne!.pseudonym, annTwo!.pseudonym, 'the same player has the same label');
  assert.notEqual(annOne!.pseudonym, bobItem!.pseudonym);
  assert.equal(f.cocreation.pseudonym('principal-ann'), annOne!.pseudonym);
  const detail = f.cocreation.detail(f.ownerAuth, annOne!.id);
  assert.equal(detail.batch, '春季内测');
  const everything = JSON.stringify([items, detail, f.cocreation.counts(f.ownerAuth)]);
  for (const secret of [
    'principal-ann',
    'principal-bob',
    'player-ann',
    'world-ann',
    'token-ann',
    'grant-ann',
    'code-ann',
  ])
    assert.ok(!everything.includes(secret), `${secret} must not appear`);
  for (const key of ['principal', 'email', 'ip', 'player', 'world'])
    assert.ok(!Object.keys(detail).some((k) => k.toLowerCase().includes(key)), `no ${key} field`);
  // A different key gives different labels: the pseudonym is keyed, not a bare hash of the principal id.
  const other = new WebCocreation(f.store, { now: () => T0 }, {} as never, f.accounts, Buffer.alloc(32, 9), () => 'x');
  assert.notEqual(other.pseudonym('principal-ann'), f.cocreation.pseudonym('principal-ann'));
});

test('list: newest first, paged, with filters for character, status, star and text (answers, dialogue and notes)', (t) => {
  const f = fixture(t),
    ann = f.player('ann');
  const make = (id: string, answers: unknown, character = 'wei-guagua') => {
    f.advance(1000);
    return f.submit(ann, id, answers, character).submissionId;
  };
  const a = make('a', [{ cardId: 'catchphrase', text: '百分之百 sure' }]);
  const b = make('b', [{ cardId: 'dialogue', player: '吃了吗', replies: ['吃过了啦'] }], 'jojo');
  const c = make('c', [{ cardId: 'quirk', text: '爱数台阶' }]);
  assert.deepEqual(
    list(f, f.ownerAuth).items.map((i) => i.id),
    [c, b, a],
  );
  assert.deepEqual(
    list(f, f.ownerAuth, { characterId: 'jojo' }).items.map((i) => i.id),
    [b],
  );
  assert.deepEqual(
    list(f, f.ownerAuth, { query: '台阶' }).items.map((i) => i.id),
    [c],
  );
  assert.deepEqual(
    list(f, f.ownerAuth, { query: '吃过了' }).items.map((i) => i.id),
    [b],
    'dialogue replies are searched',
  );
  assert.deepEqual(
    list(f, f.ownerAuth, { query: '吃了吗' }).items.map((i) => i.id),
    [b],
    'and the player line',
  );
  assert.deepEqual(list(f, f.ownerAuth, { query: '100%' }).items, [], 'LIKE wildcards are literal');
  assert.deepEqual(
    list(f, f.ownerAuth, { query: '百分之百' }).items.map((i) => i.id),
    [a],
  );
  f.cocreation.note(f.ownerAuth, a, '有意思的口头禅');
  assert.deepEqual(
    list(f, f.ownerAuth, { query: '有意思' }).items.map((i) => i.id),
    [a],
    'notes are searched',
  );
  f.cocreation.star(f.ownerAuth, b, true);
  assert.deepEqual(
    list(f, f.ownerAuth, { starred: true }).items.map((i) => i.id),
    [b],
  );
  f.cocreation.setStatus(f.ownerAuth, [c], 'archived');
  assert.deepEqual(
    list(f, f.ownerAuth, { status: 'archived' }).items.map((i) => i.id),
    [c],
  );
  assert.deepEqual(
    list(f, f.ownerAuth, { status: 'new' }).items.map((i) => i.id),
    [b, a],
  );
  const row = list(f, f.ownerAuth, { characterId: 'jojo' }).items[0]!;
  assert.deepEqual(
    { first: row.firstLine, count: row.answerCount, starred: row.starred, hasNote: row.hasNote, status: row.status },
    { first: '吃了吗', count: 1, starred: true, hasNote: false, status: 'new' },
  );
  assert.throws(() => list(f, f.ownerAuth, { status: 'done' }), /INVALID_REQUEST/);
  assert.throws(() => list(f, f.ownerAuth, { query: 'x'.repeat(101) }), /INVALID_REQUEST/);
  assert.throws(() => list(f, f.ownerAuth, { characterId: "a'b" }), /INVALID_REQUEST/);
  assert.throws(() => list(f, f.ownerAuth, { before: { createdAt: 'x', id: 'y' } }), /INVALID_CURSOR/);
});

test('list pages by cursor without gaps or repeats, including submissions made in the same millisecond', (t) => {
  const f = fixture(t);
  const players = Array.from({ length: 8 }, (_, i) => f.player(`p${i}`));
  const made: string[] = [];
  for (const p of players)
    for (let k = 0; k < 5; k++)
      if (made.length < 40) made.push(f.submit(p, `r${k}`, undefined, k % 2 ? 'jojo' : 'wei-guagua').submissionId);
  const seen: string[] = [];
  let before: unknown = null,
    pages = 0;
  do {
    const page = list(f, f.ownerAuth, { before });
    seen.push(...page.items.map((i) => i.id));
    before = page.next;
    pages++;
  } while (before);
  assert.equal(pages, 2);
  assert.equal(seen.length, 40);
  assert.equal(new Set(seen).size, 40);
  assert.deepEqual(
    seen,
    [...made].sort((x, y) => (x < y ? 1 : -1)),
    'same-millisecond rows come in id order, newest first',
  );
});

test('bulk status is all-or-nothing, records who processed it, and the new count follows', (t) => {
  const f = fixture(t),
    ann = f.player('ann'),
    manager = f.member(['cocreation.manage'], 'Manager');
  const ids = ['a', 'b', 'c'].map((r) => f.submit(ann, r).submissionId);
  assert.deepEqual(f.cocreation.counts(f.ownerAuth), { counts: { 'wei-guagua': 3 } });
  assert.deepEqual(f.cocreation.setStatus(manager, ids.slice(0, 2), 'archived'), { updated: 2, status: 'archived' });
  assert.deepEqual(
    list(f, f.ownerAuth, { status: 'archived' })
      .items.map((i) => i.id)
      .sort(),
    ids.slice(0, 2),
  );
  assert.deepEqual(f.cocreation.counts(f.ownerAuth), { counts: { 'wei-guagua': 1 } });
  assert.throws(() => f.cocreation.setStatus(f.ownerAuth, [ids[2]!, 'missing'], 'processed'), /NOT_FOUND/);
  assert.equal(f.cocreation.detail(f.ownerAuth, ids[2]!).status, 'new', 'nothing was changed by the failed bulk');
  f.cocreation.setStatus(manager, [ids[2]!], 'processed');
  const row = f.store.get<{ processed_by: string; processed_at: number }>(
    'SELECT processed_by,processed_at FROM web_cocreation_submissions WHERE id=?',
    ids[2]!,
  )!;
  assert.equal(row.processed_by, f.accounts.session(manager.cookie).member.id);
  assert.equal(row.processed_at, T0);
  f.cocreation.setStatus(manager, [ids[2]!], 'new');
  assert.equal(f.cocreation.detail(f.ownerAuth, ids[2]!).processedAt, null, 'back to new clears the processed stamp');
  assert.throws(() => f.cocreation.setStatus(f.ownerAuth, [], 'archived'), /INVALID_REQUEST/);
  assert.throws(() => f.cocreation.setStatus(f.ownerAuth, [ids[0]!, ids[0]!], 'archived'), /INVALID_REQUEST/);
  assert.throws(
    () =>
      f.cocreation.setStatus(
        f.ownerAuth,
        Array.from({ length: 101 }, (_, i) => `x${i}`),
        'archived',
      ),
    /INVALID_REQUEST/,
  );
  assert.throws(() => f.cocreation.setStatus(f.ownerAuth, [ids[0]!], 'deleted'), /INVALID_REQUEST/);
  const audit = f.store.all<{ action: string }>("SELECT action FROM web_admin_audit WHERE action LIKE 'cocreation-%'");
  assert.ok(audit.length >= 4, 'every change is audited');
});

test('note, star and adopt: the note is bounded and clearable, adopting marks processed once and keeps the first stamp', (t) => {
  const f = fixture(t),
    ann = f.player('ann');
  const id = f.submit(ann, 'r1', [
    { cardId: 'catchphrase', text: '哎呀' },
    { cardId: 'quirk', text: '数台阶' },
  ]).submissionId;
  assert.equal(f.cocreation.note(f.ownerAuth, id, '  先放着\n下周看  ').adminNote, '  先放着\n下周看  ');
  assert.equal(f.cocreation.note(f.ownerAuth, id, '   ').adminNote, null, 'a blank note clears it');
  assert.equal(f.cocreation.note(f.ownerAuth, id, null).adminNote, null);
  assert.throws(() => f.cocreation.note(f.ownerAuth, id, '字'.repeat(COCREATION_LIMITS.note + 1)), /INVALID_REQUEST/);
  assert.throws(() => f.cocreation.note(f.ownerAuth, id, 'a\u0000b'), /INVALID_REQUEST/);
  assert.throws(() => f.cocreation.star(f.ownerAuth, id, 'yes'), /INVALID_REQUEST/);
  assert.throws(() => f.cocreation.note(f.ownerAuth, 'missing', 'x'), /NOT_FOUND/);

  f.advance(5000);
  assert.deepEqual(f.cocreation.markAdopted(f.ownerAuth, id, 1), { id, ordinal: 1, status: 'processed' });
  const detail = f.cocreation.detail(f.ownerAuth, id);
  assert.equal(detail.status, 'processed');
  assert.equal(detail.answers[0]!.adoptedAt, null);
  assert.equal(detail.answers[1]!.adoptedAt, T0 + 5000);
  f.advance(5000);
  f.cocreation.markAdopted(f.ownerAuth, id, 1);
  assert.equal(
    f.cocreation.detail(f.ownerAuth, id).answers[1]!.adoptedAt,
    T0 + 5000,
    'the first adoption stamp is kept',
  );
  f.cocreation.setStatus(f.ownerAuth, [id], 'new');
  assert.equal(f.cocreation.detail(f.ownerAuth, id).status, 'new', 'the status stays changeable');
  assert.throws(() => f.cocreation.markAdopted(f.ownerAuth, id, 5), /NOT_FOUND/);
  assert.throws(() => f.cocreation.markAdopted(f.ownerAuth, id, -1), /INVALID_REQUEST/);
  assert.throws(() => f.cocreation.markAdopted(f.ownerAuth, id, '1'), /INVALID_REQUEST/);
});

test('submissions are stored as untrusted data: markup comes back verbatim as a string and nothing interprets it', (t) => {
  const f = fixture(t),
    ann = f.player('ann');
  const text = '<img src=x onerror=alert(1)> {{name}} ${x} `ls` "; DROP TABLE web_cocreation_answers; --';
  const id = f.submit(ann, 'r1', [{ cardId: 'free', text }]).submissionId;
  const answer = f.cocreation.detail(f.ownerAuth, id).answers[0] as { text: string };
  assert.equal(answer.text, text);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_answers')!.n, 1);
  assert.deepEqual(
    list(f, f.ownerAuth, { query: '<img src=x' }).items.map((i) => i.id),
    [id],
  );
});

test('the admin routes: exact body keys per action, and every cocreation path needs the admin session', async (t) => {
  const f = fixture(t),
    ann = f.player('ann');
  const id = f.submit(ann, 'r1').submissionId;
  const call = (path: string, body: unknown, over: Record<string, unknown> = {}) =>
    routeWebAccountAdmin(
      f.accounts,
      {
        method: 'POST',
        path: `/api/web/local/admin/cocreation/${path}`,
        origin,
        adminCookie: f.ownerAuth.cookie,
        csrf: f.ownerAuth.csrf,
        body,
        ...over,
      } as never,
      f.characters,
      f.cocreation,
    );
  const filters = { characterId: null, status: null, starred: null, query: null, before: null };
  assert.equal((await call('counts', {}))!.status, 200);
  assert.equal(((await call('list', filters))!.body as { items: unknown[] }).items.length, 1);
  assert.equal(((await call('detail', { id }))!.body as { id: string }).id, id);
  assert.equal((await call('star', { id, starred: true }))!.status, 200);
  assert.equal((await call('note', { id, note: '记一笔' }))!.status, 200);
  assert.equal((await call('adopt', { id, ordinal: 0 }))!.status, 200);
  assert.equal((await call('set-status', { ids: [id], status: 'archived' }))!.status, 200);
  await assert.rejects(call('counts', { extra: 1 }), /INVALID_REQUEST/);
  await assert.rejects(call('list', { characterId: null }), /INVALID_REQUEST/);
  await assert.rejects(call('star', { id }), /INVALID_REQUEST/);
  await assert.rejects(call('delete', { id }), /NOT_FOUND/);
  await assert.rejects(call('counts', {}, { adminCookie: undefined }), /ADMIN_UNAUTHORIZED/);
  await assert.rejects(call('counts', {}, { csrf: 'f'.repeat(64) }), /ADMIN_CSRF_REQUIRED/);
  await assert.rejects(call('counts', {}, { method: 'GET' }), /NOT_FOUND/);
  await assert.rejects(
    routeWebAccountAdmin(
      f.accounts,
      {
        method: 'POST',
        path: '/api/web/local/admin/cocreation/counts',
        origin,
        adminCookie: f.ownerAuth.cookie,
        csrf: f.ownerAuth.csrf,
        body: {},
      } as never,
      f.characters,
    ),
    /NOT_FOUND/,
    'without the service the paths do not exist',
  );
});

test('adopt → draft: each target field lands in the right place and passes the real draft save', (t) => {
  const f = fixture(t);
  const published = f.characters.detail(f.ownerAuth, 'wei-guagua').published!;
  const base = (): CharacterTemplate => structuredClone(published.profile.template);
  const profileOf = (template: CharacterTemplate) => {
    const profile = structuredClone(published.profile);
    profile.template = template;
    profile.template.version = published.version + 1;
    return profile;
  };
  const settings = (template: CharacterTemplate) => (template.authorCanon?.settings ?? {}) as Record<string, any>;
  const text = (field: AdoptDraft['field'], value: string): AdoptDraft => ({ field, text: value }) as AdoptDraft;

  // persona: a new paragraph
  let template = adoptIntoTemplate(base(), text('persona', '被夸时会嘴硬'));
  assert.equal(template.persona, '合成角色，非真实材料\n\n被夸时会嘴硬');
  const saved = f.characters.save(f.ownerAuth, 'wei-guagua', { expectedRevision: null, profile: profileOf(template) });
  assert.equal(saved.revision, 1);

  // text fields without an existing value: speech and dialogue style become text, the lists become a list
  template = adoptIntoTemplate(base(), text('speechStyle', '常说“哎呀妈呀”'));
  assert.equal(settings(template).speechStyle, '常说“哎呀妈呀”');
  assert.equal(template.authorCanon!.kind, 'author_canon');
  template = adoptIntoTemplate(template, text('speechStyle', '语速偏快'));
  assert.equal(settings(template).speechStyle, '常说“哎呀妈呀”\n语速偏快', 'text is appended on a new line');
  for (const field of ['interests', 'boundaries', 'personalityLayers', 'fictionalPeople'] as const) {
    const once = adoptIntoTemplate(base(), text(field, '第一条'));
    assert.deepEqual(settings(once)[field], ['第一条'], field);
    const twice = adoptIntoTemplate(once, text(field, '第二条'));
    assert.deepEqual(settings(twice)[field], ['第一条', '第二条'], `${field} is appended to`);
  }
  template = adoptIntoTemplate(base(), text('dialogueStyle', '先接话再吐槽'));
  assert.equal(settings(template).dialogueStyle, '先接话再吐槽');

  // an existing string in a list field is extended in place, an existing list in a text field too
  const withShapes = base();
  withShapes.authorCanon = {
    kind: 'author_canon',
    settings: { interests: '游戏', speechStyle: ['短句'], boundaries: { 禁忌: ['x'] } },
  } as never;
  assert.equal(settings(adoptIntoTemplate(withShapes, text('interests', '做饭'))).interests, '游戏\n做饭');
  assert.deepEqual(settings(adoptIntoTemplate(withShapes, text('speechStyle', '爱用叠词'))).speechStyle, [
    '短句',
    '爱用叠词',
  ]);
  assert.throws(() => adoptIntoTemplate(withShapes, text('boundaries', '吵闹')), /ADOPT_FIELD_SHAPE_UNSUPPORTED/);

  // dialogueExamples: a structured example with an editable situation
  const example: AdoptDraft = {
    field: 'dialogueExamples',
    situation: '被夸奖时',
    player: '你今天好厉害',
    reply: ['才没有', '哼'],
  };
  template = adoptIntoTemplate(base(), example);
  assert.deepEqual(settings(template).dialogueExamples, [
    { situation: '被夸奖时', player: '你今天好厉害', reply: ['才没有', '哼'] },
  ]);
  template = adoptIntoTemplate(template, {
    ...example,
    situation: '被问起心事',
    player: '最近怎么样',
    reply: ['还行'],
  });
  assert.equal(settings(template).dialogueExamples.length, 2);
  assert.deepEqual(settings(template).dialogueExamples[1], {
    situation: '被问起心事',
    player: '最近怎么样',
    reply: ['还行'],
  });
  assert.throws(() => adoptIntoTemplate(base(), { ...example, situation: ' ' }), /ADOPT_EXAMPLE_INVALID/);
  assert.throws(() => adoptIntoTemplate(base(), { ...example, reply: [] }), /ADOPT_EXAMPLE_INVALID/);
  assert.throws(() => adoptIntoTemplate(base(), { ...example, reply: ['一', '二', '三'] }), /ADOPT_EXAMPLE_INVALID/);
  assert.throws(() => adoptIntoTemplate(base(), { ...example, player: '' }), /ADOPT_EXAMPLE_INVALID/);
  assert.throws(
    () =>
      adoptIntoTemplate(
        { ...base(), authorCanon: { kind: 'author_canon', settings: { dialogueExamples: 'x' } } } as never,
        example,
      ),
    /ADOPT_FIELD_SHAPE_UNSUPPORTED/,
  );
  assert.throws(() => adoptIntoTemplate(base(), text('persona', '  ')), /ADOPT_TEXT_REQUIRED/);
  assert.throws(() => adoptIntoTemplate(base(), text('interests', '')), /ADOPT_TEXT_REQUIRED/);

  // The original is never mutated, and every result of every field is accepted by the real draft save.
  const original = base();
  const before = JSON.stringify(original);
  adoptIntoTemplate(original, example);
  assert.equal(JSON.stringify(original), before);
  let revision: number | null = 1;
  for (const draft of [
    text('speechStyle', '常说“哎呀妈呀”'),
    text('dialogueStyle', '先接话再吐槽'),
    text('interests', '做饭'),
    text('boundaries', '吵闹'),
    text('personalityLayers', '嘴硬心软'),
    text('fictionalPeople', '邻居老王'),
    example,
  ]) {
    const current = f.characters.detail(f.ownerAuth, 'wei-guagua').draft!;
    const next = adoptIntoTemplate(current.profile.template, draft);
    const result = f.characters.save(f.ownerAuth, 'wei-guagua', {
      expectedRevision: revision,
      profile: { ...current.profile, template: next },
    });
    assert.equal(result.revision, revision! + 1);
    revision = result.revision;
  }
  const finalDraft = f.characters.detail(f.ownerAuth, 'wei-guagua').draft!;
  const finalSettings = settings(finalDraft.profile.template);
  assert.equal(finalSettings.speechStyle, '常说“哎呀妈呀”');
  assert.deepEqual(finalSettings.dialogueExamples[0].reply, ['才没有', '哼']);
  assert.deepEqual(finalSettings.fictionalPeople, ['邻居老王']);
  // A stale revision is the existing save API's conflict, shown inline by the inbox.
  assert.throws(
    () =>
      f.characters.save(f.ownerAuth, 'wei-guagua', {
        expectedRevision: 1,
        profile: {
          ...finalDraft.profile,
          template: adoptIntoTemplate(finalDraft.profile.template, text('interests', '再来一条')),
        },
      }),
    /DRAFT_CONFLICT/,
  );
  // Nothing was published by any of this.
  assert.equal(f.characters.detail(f.ownerAuth, 'wei-guagua').published!.version, published.version);
});

test('adoption suggestions: a dialogue answer reads as a script in a text field; a text answer seeds one reply', () => {
  const dialogue = { player: '夸你一句', replies: ['才没有', '哼'] };
  assert.deepEqual(suggestAdoptDraft('speechStyle', dialogue, '瓜瓜'), {
    field: 'speechStyle',
    text: '玩家：夸你一句\n瓜瓜：才没有\n瓜瓜：哼',
  });
  assert.deepEqual(suggestAdoptDraft('dialogueExamples', dialogue, '瓜瓜'), {
    field: 'dialogueExamples',
    situation: '日常聊天',
    player: '夸你一句',
    reply: ['才没有', '哼'],
  });
  assert.deepEqual(suggestAdoptDraft('dialogueExamples', { text: '嘴硬' }, '瓜瓜'), {
    field: 'dialogueExamples',
    situation: '日常聊天',
    player: '',
    reply: ['嘴硬'],
  });
  assert.deepEqual(suggestAdoptDraft('interests', { text: '做饭' }, '瓜瓜'), { field: 'interests', text: '做饭' });
});

test('the co-creation service makes no provider call, reserves no budget and never touches the reply allowance', () => {
  for (const file of ['web-cocreation.ts', 'web-cocreation-routes.ts', 'web-cocreation-purge.ts']) {
    const source = readFileSync(new URL(`../../../apps/server/cocreation/${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/fetch\(|provider|spending|budget|dailyReply|DAILY_REPLY|web_operations|web_stage/i.test(source), file);
  }
});
