import assert from 'node:assert/strict';
import test from 'node:test';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { WebCocreationRelations } from '../../../apps/server/cocreation/web-cocreation-relations.ts';
import { routeWebCocreation } from '../../../apps/server/cocreation/web-cocreation-routes.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { T0, DAY, origin, tiersFixture } from '../fixtures/invite-tiers.ts';
import { sampleId } from '../fixtures/cast-sample.ts';

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
type Bulk = { enabled: boolean; switched: string[]; unchanged: string[]; failed: { id: string; code: string }[] };
const bulk = async (s: S, ids: unknown, enabled: unknown, who = s.manager, over = {}) =>
  ((await s.admin('wordings/set-enabled', { ids, enabled }, who, over)) as { body: Bulk }).body;
const texts = (s: S) =>
  Object.fromEntries(
    s.f.store
      .all<{ id: string; text: string }>('SELECT id,text FROM web_cocreation_wordings')
      .map((r) => [r.id, r.text]),
  );
const online = (s: S, id: string) =>
  s.f.store.get<{ enabled: number }>('SELECT enabled FROM web_cocreation_wordings WHERE id=?', id)!.enabled === 1;

test('Part 44 bulk 上线 / 下线: one request switches a selection; online status only, the text never changes', async (t) => {
  const s = setup(t);
  const a = await add(s, ids[0]!, 'theme-know', '问题一', 'r1');
  const b = await add(s, ids[0]!, 'theme-habit', '问题二', 'r2', false);
  const c = await add(s, ids[1]!, 'theme-know', '问题三', 'r3');
  const before = texts(s);
  const off = await bulk(s, [a.id, b.id, c.id], false);
  assert.deepEqual(off.switched.sort(), [a.id, c.id].sort());
  assert.deepEqual(off.unchanged, [b.id], 'already offline: reported, not silently skipped');
  assert.deepEqual(off.failed, []);
  assert.ok(![a.id, b.id, c.id].some((id) => online(s, id)));
  const on = await bulk(s, [a.id, b.id, c.id], true);
  assert.deepEqual(on.switched.sort(), [a.id, b.id, c.id].sort());
  assert.deepEqual(texts(s), before, 'the wording text is untouched');
  // every id asked for lands in exactly one list
  assert.equal(on.switched.length + on.unchanged.length + on.failed.length, 3);
});

test('Part 44 bulk: repeating the request is idempotent', async (t) => {
  const s = setup(t);
  const a = await add(s, ids[0]!, 'theme-know', '问题一', 'r1');
  const first = await bulk(s, [a.id], false);
  const again = await bulk(s, [a.id], false);
  assert.deepEqual(first.switched, [a.id]);
  assert.deepEqual(again.switched, []);
  assert.deepEqual(again.unchanged, [a.id]);
  assert.equal(online(s, a.id), false);
});

test('Part 44 bulk: an id that is not a wording is named in `failed`; the rest still switch (never a silent half-success)', async (t) => {
  const s = setup(t);
  const a = await add(s, ids[0]!, 'theme-know', '问题一', 'r1');
  const done = await bulk(s, [a.id, 'no-such-wording'], false);
  assert.deepEqual(done.switched, [a.id]);
  assert.deepEqual(done.failed, [{ id: 'no-such-wording', code: 'NOT_FOUND' }]);
});

test('Part 44 bulk: shape, permission, CSRF and Origin', async (t) => {
  const s = setup(t);
  const a = await add(s, ids[0]!, 'theme-know', '问题一', 'r1');
  for (const [body, why] of [
    [{ ids: [], enabled: true }, 'empty selection'],
    [{ ids: [a.id, a.id], enabled: true }, 'duplicate ids'],
    [{ ids: [a.id], enabled: 'yes' }, 'enabled is not a boolean'],
    [{ ids: 'x', enabled: true }, 'ids is not a list'],
    [{ ids: [a.id], enabled: true, text: 'new text' }, 'an extra field (text is immutable here)'],
    [{ ids: Array.from({ length: 301 }, (_, i) => `w${i}`), enabled: true }, 'too many'],
  ] as const)
    assert.notEqual(await code(() => s.admin('wordings/set-enabled', body)), 'ok', why);
  assert.equal(
    await code(() => bulk(s, [a.id], false, s.reader)),
    'ADMIN_PERMISSION_REQUIRED',
    'cocreation.read alone cannot switch',
  );
  await assert.rejects(async () => bulk(s, [a.id], false, s.manager, { csrf: 'wrong' }), /CSRF_INVALID|ADMIN/);
  await assert.rejects(
    async () => bulk(s, [a.id], false, s.manager, { origin: 'https://evil.invalid' }),
    /CSRF_INVALID|ORIGIN|ADMIN/,
  );
  assert.equal(online(s, a.id), true, 'a refused request changed nothing');
});

test('Part 44 bulk: players see only what is online afterwards; the audit names no text', async (t) => {
  const s = setup(t);
  const a = await add(s, ids[0]!, 'theme-know', '问题一', 'r1');
  const b = await add(s, ids[0]!, 'theme-know', '问题二', 'r2');
  await bulk(s, [a.id], false);
  const ann = s.player('P');
  const got = (
    (await s.asPlayer('wordings', { characterId: ids[0]! }, ann)) as { body: { themes: Record<string, string[]> } }
  ).body;
  assert.deepEqual(got.themes['theme-know'], ['问题二']);
  void b;
  const audit = JSON.stringify(s.f.store.all('SELECT * FROM web_admin_audit'));
  assert.ok(!audit.includes('问题一') && !audit.includes('问题二'));
});
