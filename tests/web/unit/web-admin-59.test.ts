import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  ADMIN_ABSOLUTE_MS,
  ADMIN_IDLE_MS,
  ADMIN_RENEW_STEP_MS,
} from '../../../apps/server/invites/web-invite-admin.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { mergeCastDocs } from '../../../packages/contracts/cast-merge.ts';
import { CAST_LIMITS, type CastDoc } from '../../../packages/contracts/web-cast.ts';
import { compileCastViewDetailed } from '../../../apps/server/cast/cast-compile.ts';
import {
  castEntryIds,
  emptyCastDoc,
  normalizeCastDoc,
  validateCastDoc,
} from '../../../apps/server/cast/cast-validation.ts';
import {
  blankCharacter,
  removeCharacter,
  setPairNote,
  changeCount,
} from '../../../apps/player-web/src/features/admin/cast/cast-model.ts';

const origin = 'https://admin.fixture.invalid';

/**
 * Part 59 (server and shared pieces): the admin session slides (8 h after the last request, 24 h at most); the cast document
 * carries an optional, validated 关系注解 of a pair that reaches both characters' view and merges like any other entry.
 */
function admin(t: test.TestContext) {
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const clock = { now: () => now };
  const accounts = new WebAccountAdmin(store, clock, origin);
  t.after(() => store.close());
  const grant = accounts.issueLoginGrant();
  const login = accounts.login(grant.token, origin);
  return { accounts, store, login, tick: (ms: number) => (now += ms), now: () => now };
}

test('59: the admin session slides while it is used, and ends at the idle limit and at the absolute limit', (t) => {
  const f = admin(t);
  const { cookie, csrf } = f.login;
  const started = f.now();
  assert.equal(f.login.expiresAt, started + ADMIN_IDLE_MS, 'a sign-in lasts the idle time');
  // Used every 2 hours, an owner is never logged out in the idle window...
  let last = f.login.expiresAt;
  for (let hour = 2; hour <= 20; hour += 2) {
    f.tick(2 * 60 * 60_000);
    const session = f.accounts.authorize(cookie, csrf, origin);
    assert.ok(session.expiresAt >= last, `the expiry never moves back (hour ${hour})`);
    last = session.expiresAt;
  }
  assert.equal(
    last,
    f.now() + ADMIN_IDLE_MS > started + ADMIN_ABSOLUTE_MS ? started + ADMIN_ABSOLUTE_MS : f.now() + ADMIN_IDLE_MS,
  );
  // ...but never past the absolute limit (24 h after the sign-in), however active.
  f.tick(5 * 60 * 60_000);
  assert.throws(() => f.accounts.authorize(cookie, csrf, origin), /ADMIN_UNAUTHORIZED/, 'the absolute limit ends it');
});

test('59: an idle admin session ends after the idle time, and a read renews only once per step', (t) => {
  const f = admin(t);
  const { cookie, csrf } = f.login;
  const first = f.accounts.session(cookie).expiresAt;
  f.tick(ADMIN_RENEW_STEP_MS - 1_000);
  assert.equal(f.accounts.session(cookie).expiresAt, first, 'less than one step later: no write');
  f.tick(2_000);
  assert.ok(f.accounts.session(cookie).expiresAt > first, 'a step later: renewed');
  const row = f.store.get<{ expires_at: number }>('SELECT expires_at FROM admin_sessions LIMIT 1')!;
  assert.equal(row.expires_at, f.accounts.session(cookie).expiresAt);
  f.tick(ADMIN_IDLE_MS + 1_000);
  assert.throws(() => f.accounts.authorize(cookie, csrf, origin), /ADMIN_UNAUTHORIZED/, 'idle past the limit: refused');
  assert.throws(() => f.accounts.session(cookie), /ADMIN_UNAUTHORIZED/);
});

// ---- the cast: 关系注解 --------------------------------------------------------------------------------------------------------
const ids = {
  known: new Set<string>(),
  fresh: (() => {
    let n = 0;
    return () => `e_${(n += 1).toString().padStart(20, '0')}`;
  })(),
};
function doc(): CastDoc {
  const base = emptyCastDoc();
  base.characters = [blankCharacter('a', '甲'), blankCharacter('b', '乙'), blankCharacter('c', '丙')];
  return base;
}
const lookup = { exists: () => true, deleted: () => false };
const normalize = (value: CastDoc) =>
  normalizeCastDoc(JSON.parse(JSON.stringify(value)), { ...ids, known: castEntryIds(value) });

test('59: a cast document without notes keeps exactly its bytes; a note is validated, limited and unique per pair', () => {
  const plain = normalize(doc());
  assert.equal('pairNotes' in plain, false, 'no key when there is no note (old documents and digests are unchanged)');
  const withNote = doc();
  setPairNote(withNote, 'a', 'b', '一个嘴硬，一个心软');
  const saved = normalize(withNote);
  assert.equal(saved.pairNotes?.length, 1);
  assert.ok(/^e_/.test(saved.pairNotes![0]!.id), 'the server gives the note its id');
  // too long, empty, a line break are refused
  for (const text of ['字'.repeat(CAST_LIMITS.pairNote + 1), '', 'a\u0000b']) {
    const bad = doc();
    bad.pairNotes = [{ id: '', a: 'a', b: 'b', text }];
    assert.throws(() => normalize(bad), /CAST_INVALID|doc\.pairNotes/, `refused: ${JSON.stringify(text).slice(0, 12)}`);
  }
  assert.equal(
    normalize(
      Object.assign(doc(), { pairNotes: [{ id: '', a: 'a', b: 'b', text: '字'.repeat(CAST_LIMITS.pairNote) }] }),
    ).pairNotes?.length,
    1,
    'exactly the limit is fine',
  );
});

test('59: the note reaches the cast view of both characters (and of nobody else); an unknown or doubled pair is an error', () => {
  const d = doc();
  setPairNote(d, 'a', 'b', '一个嘴硬，一个心软');
  const saved = normalize(d);
  const viewOf = (id: string) => compileCastViewDetailed(saved, id).view;
  assert.equal(viewOf('a').relations.find((r) => r.to === '乙')?.note, '一个嘴硬，一个心软');
  assert.equal(viewOf('b').relations.find((r) => r.to === '甲')?.note, '一个嘴硬，一个心软');
  assert.equal(
    viewOf('c').relations.some((r) => r.note !== undefined),
    false,
    'nobody else sees it',
  );
  // a document without it compiles exactly as before: no `note` key anywhere
  assert.equal(JSON.stringify(compileCastViewDetailed(normalize(doc()), 'a').view).includes('"note"'), false);
  const doubled = doc();
  doubled.pairNotes = [
    { id: '', a: 'a', b: 'b', text: '一' },
    { id: '', a: 'b', b: 'a', text: '二' },
  ];
  assert.ok(
    validateCastDoc(normalize(doubled), 'draft', lookup).errors.some((e) => e.code === 'CAST_DUPLICATE_PAIR_NOTE'),
    'one note per unordered pair',
  );
  const unknown = doc();
  unknown.pairNotes = [{ id: '', a: 'a', b: 'zzz', text: '一' }];
  assert.ok(
    validateCastDoc(normalize(unknown), 'draft', lookup).errors.some((e) => e.code === 'CAST_UNKNOWN_CHARACTER'),
  );
  const self = doc();
  self.pairNotes = [{ id: '', a: 'a', b: 'a', text: '一' }];
  assert.ok(validateCastDoc(normalize(self), 'draft', lookup).errors.some((e) => e.code === 'CAST_SELF_RELATION'));
  assert.equal(validateCastDoc(saved, 'draft', lookup).errors.length, 0, 'a good note is valid');
});

test('59: Part 55 merge carries notes like any other entry; deleting a character takes its notes along', () => {
  const base = normalize(doc());
  const mine = normalize(Object.assign(doc(), {}));
  setPairNote(mine as CastDoc, 'a', 'b', '我写的注解');
  const theirs = structuredClone(base);
  theirs.world = { background: '别处改了世界' };
  const merged = mergeCastDocs(base, normalize(mine), theirs);
  assert.ok(merged.ok);
  if (merged.ok) {
    assert.equal(merged.doc.pairNotes?.[0]?.text, '我写的注解');
    assert.equal(merged.doc.world.background, '别处改了世界');
  }
  // both sides wrote the note of the same pair differently: named, never merged
  const a = structuredClone(base);
  setPairNote(a, 'a', 'b', '甲方的');
  const baseWith = normalize(a);
  const mine2 = structuredClone(baseWith);
  mine2.pairNotes![0]!.text = '我改的';
  const theirs2 = structuredClone(baseWith);
  theirs2.pairNotes![0]!.text = '他改的';
  const clash = mergeCastDocs(baseWith, mine2, theirs2);
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.ok(clash.conflicts.includes('关系注解'));
  const cleaned = structuredClone(baseWith);
  removeCharacter(cleaned, 'b');
  assert.equal(cleaned.pairNotes, undefined, 'the note went with the character');
  assert.equal(changeCount(base, a), 1, 'a note is one change in the title row count');
});
