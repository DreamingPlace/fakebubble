import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCastAdmin } from '../../../apps/server/admin/web-cast-admin.ts';
import { compileCastView } from '../../../apps/server/cast/cast-compile.ts';
import { castDigest, latestPublication, readDraft } from '../../../apps/server/cast/cast-store.ts';
import { canonicalCastJson } from '../../../apps/server/cast/cast-validation.ts';
import {
  CAST_CONTEXT_PROMPT,
  CAST_REVIEW_PROMPT,
  castPromptHash,
} from '../../../apps/server/generation/cast-prompt.ts';
import { freezeInputSnapshot, readInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { migrateWebProviderCast } from '../../../apps/server/generation/web-provider-migration.ts';
import type { Store, WebStore } from '../../../apps/server/platform/store.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';
import { captureFreeze, FREEZE_NOW, schema128, seedFreezeScenario } from '../fixtures/cast-freeze.ts';
import { sampleCastRaw } from '../fixtures/cast-sample.ts';
import { sampleCast } from '../fixtures/cast-sample.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

const origin = 'https://fixture.invalid';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const OFF_MAIN = JSON.parse(
  readFileSync(new URL('../fixtures/cast-off-main.json', import.meta.url), 'utf8'),
) as ReturnType<typeof captureFreeze> & { capturedFrom: string };
const sql129 = () => readFileSync(new URL('../../../apps/server/web-migrations/129_cast.sql', import.meta.url), 'utf8');
const refused = (work: () => unknown, code: string | RegExp) =>
  assert.throws(work, (error: Error & { code?: string }) =>
    typeof code === 'string'
      ? error.code === code || error.message === code
      : code.test(`${error.code}:${error.message}`),
  );

/** The real schema through 129, an owner, staff with chosen permissions, and the cast object. */
function fixture(t: TestContext, options: { characters?: boolean } = {}) {
  const store = schema128();
  migrateWebProviderCast(store);
  t.after(() => store.close());
  let now = FREEZE_NOW,
    ids = 0;
  const clock = { now: () => now };
  if (options.characters !== false)
    for (let i = 1; i <= 15; i++)
      store.run(
        'INSERT OR IGNORE INTO character_templates(id,version,config_json) VALUES (?,?,?)',
        `c${String(i).padStart(2, '0')}`,
        1,
        '{}',
      );
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebAdminActions(store);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const staff = (permissions: string[], label = 'Staff') => {
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-${label}-${String(++ids).padStart(6, '0')}`,
      label,
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };
  const cast = new WebCastAdmin(store, clock, accounts);
  const request = () => `cast-request-${String(++ids).padStart(6, '0')}`;
  return {
    store,
    clock,
    accounts,
    cast,
    ownerAuth,
    staff,
    request,
    advance: (ms: number) => {
      now += ms;
    },
    /** Save the sample cast (without ids: the server assigns them) and publish it. */
    publishSample(raw: unknown = sampleCastRaw()) {
      const draft = cast.draft(ownerAuth, {});
      const saved = cast.save(ownerAuth, { requestId: request(), expectedRevision: draft.revision, doc: raw });
      return cast.publish(ownerAuth, { requestId: request(), expectedRevision: saved.revision });
    },
  };
}

test('129 is the 54th and last step; steps 1–128 hash exactly as on main; the Node and Cloudflare ledgers agree', () => {
  const { inline, r2 } = expectedWebMigrations();
  assert.equal(inline.length, 54);
  assert.equal(r2.length, 54);
  assert.equal(inline.at(-1)!.version, 129);
  assert.equal(r2.at(-1)!.version, 129);
  assert.equal(inline.at(-1)!.sha256, sha(sql129()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(inline.at(-1)!.sha256, r2.at(-1)!.sha256, '129 is the same SQL on both authorities');
  // Part 24a (named, pinned): changing the file is a new migration. Recorded when 129 was written.
  assert.equal(inline.at(-1)!.sha256, '061602aea27da734c9c279dfea8de748520f3d45b0afcfeba1ea6333ce992148');
  // main's 53 steps (3f57e04), both lists, as one digest: nothing in 1-128 moved
  assert.equal(
    sha(JSON.stringify(inline.slice(0, 53))),
    '2ed3e97aed381d5aad8440db2eb8bf4e27b5a64a592981cc967dd7753dd464ab',
  );
  assert.equal(
    sha(JSON.stringify(r2.slice(0, 53))),
    'ace86aeede7af2e80e08a56928fd16f25ac9492247d9ed8155b7263e2a80eec7',
  );
  assert.equal(
    inline[52]!.sha256,
    '44271b05dc49d7f26d59a1f5537249707d8d66863bd4080d7146ea3b8f25364f',
    '128 is untouched',
  );
});

test('129 on the Node store: one draft row, append-only publications, an immutable snapshot with three cast columns', (t) => {
  const f = fixture(t);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 129);
  const draft = f.store.all<{ singleton: number; revision: number; doc_json: string }>('SELECT * FROM web_cast_draft');
  assert.equal(draft.length, 1);
  assert.equal(draft[0]!.revision, 1);
  assert.equal(readDraft(f.store).doc.characters.length, 0);
  refused(() => f.store.run("INSERT INTO web_cast_draft VALUES (2,1,'{}',0)"), /CHECK/);
  refused(() => f.store.run("INSERT INTO web_cast_draft VALUES (1,9,'{}',0)"), /UNIQUE|PRIMARY/);
  refused(() => f.store.run('DELETE FROM web_cast_draft'), 'WEB_CAST_DRAFT_REQUIRED');
  f.publishSample();
  refused(() => f.store.run("UPDATE web_cast_publications SET doc_json='{}'"), 'WEB_CAST_HISTORY_IMMUTABLE');
  refused(() => f.store.run('DELETE FROM web_cast_publications'), 'WEB_CAST_HISTORY_IMMUTABLE');
  refused(
    () => f.store.run("INSERT INTO web_cast_publications VALUES (9,'{}',?,0,'rollback',NULL)", 'a'.repeat(64)),
    /CHECK/,
  );
  refused(
    () => f.store.run("INSERT INTO web_cast_publications VALUES (9,'{}',?,0,'publish',1)", 'a'.repeat(64)),
    /CHECK/,
  );
  refused(
    () =>
      f.store.run(
        `INSERT INTO web_cast_publications VALUES (9,'${'x'.repeat(10)}',?,0,'publish',NULL)`,
        'a'.repeat(64),
      ),
    /CHECK|malformed/,
  );
  const columns = f.store.all<{ name: string; notnull: number }>(
    'SELECT name,"notnull" FROM pragma_table_info(\'web_input_snapshots\')',
  );
  for (const name of ['cast_version', 'cast_json', 'cast_digest']) {
    const column = columns.find((c) => c.name === name);
    assert.ok(column && column.notnull === 0, `${name} is nullable`);
  }
  // the three columns are all NULL or all set
  assert.ok(
    f.store.get("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='web_input_snapshots_cast_together'"),
  );
});

test('permissions: nothing without cast.read / cast.edit / cast.publish (the owner has all); the permission comes before the body', (t) => {
  const f = fixture(t);
  const nobody = f.staff(['stats.read'], 'Nobody');
  const reader = f.staff(['cast.read'], 'Reader');
  const editor = f.staff(['cast.edit'], 'Editor');
  const publisher = f.staff(['cast.publish'], 'Publisher');
  const garbage = { nonsense: true };
  const calls = {
    draft: (a: typeof nobody) => f.cast.draft(a, garbage),
    versions: (a: typeof nobody) => f.cast.versions(a, garbage),
    validate: (a: typeof nobody) => f.cast.validate(a, garbage),
    compile: (a: typeof nobody) => f.cast.compilePreview(a, garbage),
    save: (a: typeof nobody) => f.cast.save(a, garbage),
    importLegacy: (a: typeof nobody) => f.cast.importLegacy(a, garbage),
    publish: (a: typeof nobody) => f.cast.publish(a, garbage),
    rollback: (a: typeof nobody) => f.cast.rollback(a, garbage),
  } as const;
  const needs = {
    draft: 'read',
    versions: 'read',
    validate: 'read',
    compile: 'read',
    save: 'edit',
    importLegacy: 'edit',
    publish: 'publish',
    rollback: 'publish',
  } as const;
  const holders = { read: [reader, editor, publisher], edit: [editor], publish: [publisher] } as const;
  for (const [name, call] of Object.entries(calls)) {
    const need = needs[name as keyof typeof needs];
    // 403 for anyone without it - BEFORE the body is looked at (the garbage body would be INVALID_REQUEST otherwise)
    for (const denied of [nobody, ...[reader, editor, publisher].filter((a) => !holders[need].includes(a as never))])
      refused(() => call(denied), 'ADMIN_PERMISSION_REQUIRED');
    // holders (and the owner) get past the permission: the garbage body is then refused as a body
    for (const allowed of [...holders[need], f.ownerAuth]) refused(() => call(allowed), /INVALID_REQUEST|NOT_FOUND/);
  }
  // cast.edit and cast.publish carry cast.read with them (normalizePermissions adds what is required)
  assert.ok(f.cast.draft(editor, {}).doc);
  assert.ok(f.cast.draft(publisher, {}).doc);
});

test('CSRF, Origin and session are checked on every cast call, and the routes refuse anything but POST bodies of their shape', async (t) => {
  const f = fixture(t);
  const route = (path: string, body: unknown, auth = f.ownerAuth, extra: Record<string, unknown> = {}) =>
    routeWebAccountAdmin(
      f.accounts,
      {
        method: 'POST',
        path: `/api/web/local/admin/cast/${path}`,
        origin: auth.origin,
        csrf: auth.csrf,
        adminCookie: auth.cookie,
        trustedIpHash: 'a'.repeat(64),
        body,
        ...extra,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      f.cast,
    );
  const res = await route('draft', {});
  assert.equal(res!.status, 200);
  for (const path of [
    'draft',
    'versions',
    'validate',
    'compile-preview',
    'save',
    'publish',
    'rollback',
    'import-legacy',
  ]) {
    await assert.rejects(route(path, {}, { ...f.ownerAuth, csrf: 'wrong' }), (e: { code?: string }) =>
      /CSRF|ADMIN_UNAUTHORIZED/.test(String(e.code)),
    );
    await assert.rejects(route(path, {}, { ...f.ownerAuth, origin: 'https://evil.invalid' }), (e: { code?: string }) =>
      /ORIGIN|CSRF|ADMIN_UNAUTHORIZED/.test(String(e.code)),
    );
    await assert.rejects(route(path, {}, { cookie: '', csrf: f.ownerAuth.csrf, origin }), (e: { code?: string }) =>
      /ADMIN_UNAUTHORIZED|AUTH/.test(String(e.code)),
    );
  }
  await assert.rejects(route('nope', {}), (e: { code?: string }) => e.code === 'NOT_FOUND');
  await assert.rejects(
    routeWebAccountAdmin(f.accounts, {
      method: 'POST',
      path: '/api/web/local/admin/cast/draft',
      origin,
      csrf: f.ownerAuth.csrf,
      adminCookie: f.ownerAuth.cookie,
      body: {},
    } as never),
    (e: { code?: string }) => e.code === 'NOT_FOUND',
    'without the cast object (a database older than 129) the routes do not exist',
  );
});

test('save: compare-and-swap on the revision, idempotent per request id, validation results in the answer', (t) => {
  const f = fixture(t);
  const empty = f.cast.draft(f.ownerAuth, {});
  assert.deepEqual([empty.revision, empty.counts.characters], [1, 0]);
  const requestId = f.request();
  const saved = f.cast.save(f.ownerAuth, { requestId, expectedRevision: 1, doc: sampleCastRaw() });
  assert.equal(saved.revision, 2);
  assert.equal(saved.duplicate, false);
  assert.deepEqual(saved.counts, { characters: 15, people: 6, groups: 3, stories: 6, memes: 2 });
  assert.deepEqual(saved.validation, { errors: [], warnings: [] });
  // a lost reply is replayed by request id: the same answer, nothing saved twice
  const replay = f.cast.save(f.ownerAuth, { requestId, expectedRevision: 1, doc: sampleCastRaw() });
  assert.deepEqual({ ...replay, duplicate: false }, saved);
  assert.equal(replay.duplicate, true);
  assert.equal(f.cast.draft(f.ownerAuth, {}).revision, 2);
  // the same id with other content is a conflict, never a second save
  refused(
    () => f.cast.save(f.ownerAuth, { requestId, expectedRevision: 2, doc: sampleCastRaw() }),
    'IDEMPOTENCY_CONFLICT',
  );
  // a stale revision is refused WITH the current one
  const stale = (() => {
    try {
      f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: 1, doc: sampleCastRaw() });
    } catch (error) {
      return error as Error & { code: string; detail: { currentRevision: number } };
    }
  })();
  assert.equal(stale?.code, 'CAST_REVISION_CONFLICT');
  assert.deepEqual(stale?.detail, { currentRevision: 2 });
  assert.equal(f.cast.draft(f.ownerAuth, {}).revision, 2, 'a refused save changes nothing');
  // ids are kept across edits; a new entry gets one; an invented id is refused
  const current = f.cast.draft(f.ownerAuth, {});
  const edited = structuredClone(current.doc);
  edited.memes[0]!.meaning = '改过的含义';
  edited.memes.push({ id: '', key: '新梗', parties: ['c01'], meaning: '', trigger: '', prohibited: '' });
  const again = f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: 2, doc: edited });
  const after = f.cast.draft(f.ownerAuth, {}).doc;
  assert.equal(again.revision, 3);
  assert.equal(after.memes[0]!.id, current.doc.memes[0]!.id);
  assert.equal(after.memes[2]!.key, '新梗');
  assert.ok(after.memes[2]!.id.length > 0);
  const forged = structuredClone(after);
  forged.memes[0]!.id = 'made-up';
  refused(() => f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: 3, doc: forged }), 'CAST_INVALID');
  // a meaning error is refused with the paths (ids, never text)
  const bad = structuredClone(after);
  bad.ratings.c01!.c01 = 3;
  const failure = (() => {
    try {
      f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: 3, doc: bad });
    } catch (error) {
      return error as Error & { detail: { issues: { code: string; path: string }[] } };
    }
  })();
  assert.deepEqual(failure?.detail.issues, [{ code: 'CAST_SELF_RATING', path: 'ratings[c01][c01]' }]);
  // unknown characters only warn on a draft
  const loose = f.cast.draft(f.ownerAuth, {}).doc;
  f.store.run("DELETE FROM character_templates WHERE id='c15'");
  assert.ok(f.cast.draft(f.ownerAuth, {}).validation.warnings.some((w) => w.code === 'CAST_CHARACTER_MISSING'));
  assert.equal(loose.characters.length, 15);
});

test('publish: the whole draft becomes the next version, only if every character exists; rollback republishes an old version as a new one', (t) => {
  const f = fixture(t);
  const draft = f.cast.draft(f.ownerAuth, {});
  refused(() => f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: 1 }), 'CAST_PUBLISH_BLOCKED'); // empty
  const saved = f.cast.save(f.ownerAuth, {
    requestId: f.request(),
    expectedRevision: draft.revision,
    doc: sampleCastRaw(),
  });
  // a missing / deleted character blocks, a draft only warned
  f.store.run("DELETE FROM character_templates WHERE id='c15'");
  const blocked = (() => {
    try {
      f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: saved.revision });
    } catch (error) {
      return error as Error & { code: string; detail: { issues: { code: string; path: string }[] } };
    }
  })();
  assert.equal(blocked?.code, 'CAST_PUBLISH_BLOCKED');
  assert.deepEqual(blocked?.detail.issues, [{ code: 'CAST_CHARACTER_MISSING', path: 'characters[c15]' }]);
  assert.deepEqual(
    f.cast.validate(f.ownerAuth, {}).validation.errors.map((e) => e.code),
    ['CAST_CHARACTER_MISSING'],
  );
  f.store.run("INSERT INTO character_templates(id,version,config_json) VALUES ('c15',1,'{}')");
  f.store.run('CREATE TABLE IF NOT EXISTS web_character_deletions(character_id TEXT PRIMARY KEY)');
  f.store.run("INSERT INTO web_character_deletions(character_id) VALUES ('c14')");
  assert.deepEqual(
    f.cast.validate(f.ownerAuth, {}).validation.errors.map((e) => e.code),
    ['CAST_CHARACTER_DELETED'],
  );
  f.store.run("DELETE FROM web_character_deletions WHERE character_id='c14'");
  // a stale draft revision cannot be published
  refused(() => f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: 1 }), 'CAST_REVISION_CONFLICT');
  const v1 = f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: saved.revision });
  assert.deepEqual([v1.version, v1.kind, v1.fromVersion, v1.duplicate], [1, 'publish', null, false]);
  assert.deepEqual(v1.counts, { characters: 15, people: 6, groups: 3, stories: 6, memes: 2 });
  assert.equal(v1.digest, castDigest(canonicalCastJson(f.cast.draft(f.ownerAuth, {}).doc)));
  // publishing again without a change is a new version of the same document (the draft is not consumed)
  const v2 = f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: saved.revision });
  assert.equal(v2.version, 2);
  assert.equal(v2.digest, v1.digest);
  // edit, publish v3, roll back to 1
  const changed = structuredClone(f.cast.draft(f.ownerAuth, {}).doc);
  changed.world.background = '另一个世界';
  const s2 = f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: saved.revision, doc: changed });
  const v3 = f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: s2.revision });
  assert.notEqual(v3.digest, v1.digest);
  const back = f.cast.rollback(f.ownerAuth, { requestId: f.request(), version: 1 });
  assert.deepEqual([back.version, back.kind, back.fromVersion, back.digest], [4, 'rollback', 1, v1.digest]);
  refused(() => f.cast.rollback(f.ownerAuth, { requestId: f.request(), version: 99 }), 'NOT_FOUND');
  const versions = f.cast.versions(f.ownerAuth, {});
  assert.deepEqual(
    versions.versions.map((v) => [v.version, v.kind, v.fromVersion]),
    [
      [4, 'rollback', 1],
      [3, 'publish', null],
      [2, 'publish', null],
      [1, 'publish', null],
    ],
  );
  assert.equal(versions.latest, 4);
  assert.equal(
    JSON.stringify(versions).includes('另一个世界'),
    false,
    'the list carries counts and digests, never text',
  );
  assert.equal(latestPublication(f.store)!.doc.world.background, sampleCast().world.background);
  // the draft is untouched by publishing and rolling back
  assert.equal(f.cast.draft(f.ownerAuth, {}).doc.world.background, '另一个世界');
  // idempotent per request id: a replay publishes nothing new
  const requestId = f.request();
  const first = f.cast.rollback(f.ownerAuth, { requestId, version: 3 });
  const replay = f.cast.rollback(f.ownerAuth, { requestId, version: 3 });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.version, first.version);
  assert.equal(f.cast.versions(f.ownerAuth, {}).latest, first.version);
  // a rollback is allowed even when a character of the old version has been deleted since (it only costs its card)
  f.store.run("DELETE FROM character_templates WHERE id='c13'");
  const late = f.cast.rollback(f.ownerAuth, { requestId: f.request(), version: 1 });
  assert.equal(late.warnings, 1);
});

test('compile-preview: the view of one character from the draft or from a version, with the knowledge table and what the cap dropped', (t) => {
  const f = fixture(t);
  f.publishSample();
  const draft = f.cast.compilePreview(f.ownerAuth, { characterId: 'c05', source: 'draft' });
  const published = f.cast.compilePreview(f.ownerAuth, { characterId: 'c05', source: 'published' });
  const pinned = f.cast.compilePreview(f.ownerAuth, { characterId: 'c05', source: 'published', version: 1 });
  assert.equal(JSON.stringify(draft.view), JSON.stringify(published.view));
  assert.equal(JSON.stringify(published.view), JSON.stringify(pinned.view));
  assert.deepEqual(draft.source, { kind: 'draft', revision: 2 });
  assert.deepEqual(published.source, { kind: 'published', version: 1 });
  assert.equal(draft.size, JSON.stringify(draft.view).length);
  assert.deepEqual(draft.dropped, { memes: 0, heardStories: 0, groupStories: 0, livedStories: 0, relationTexts: 0 });
  const heard = draft.knowledge.filter((k) => k.level === 'heard');
  assert.equal(heard.length, 2, 'c05 hears two stories only because she rates c01 at 3.5');
  assert.ok(heard.every((k) => !k.fromOverride));
  assert.equal(draft.knowledge.length, 6, 'every story, 不知道 included, for the console table');
  refused(
    () => f.cast.compilePreview(f.ownerAuth, { characterId: 'nobody', source: 'draft' }),
    'CAST_CHARACTER_NOT_IN_CAST',
  );
  refused(
    () => f.cast.compilePreview(f.ownerAuth, { characterId: 'c05', source: 'published', version: 9 }),
    'NOT_FOUND',
  );
  refused(
    () => f.cast.compilePreview(f.ownerAuth, { characterId: 'c05', source: 'draft', version: 1 }),
    'INVALID_REQUEST',
  );
});

test('audit rows and stored results carry the action, version, revision, counts and digests - no cast text, no email', (t) => {
  const f = fixture(t);
  f.publishSample();
  f.cast.rollback(f.ownerAuth, { requestId: f.request(), version: 1 });
  const audit = f.store.all<{ actor_id: string; action: string; target_id: string }>(
    "SELECT actor_id,action,target_id FROM web_admin_audit WHERE action LIKE 'cast-%' ORDER BY rowid",
  );
  assert.deepEqual(
    audit.map((a) => a.action),
    ['cast-draft-saved', 'cast-published', 'cast-rolled-back'],
  );
  assert.match(
    audit[0]!.target_id,
    /^revision=2;characters=15;people=6;groups=3;stories=6;memes=2;digest=[0-9a-f]{12}$/,
  );
  assert.match(
    audit[1]!.target_id,
    /^version=1;characters=15;people=6;groups=3;stories=6;memes=2;digest=[0-9a-f]{12}$/,
  );
  assert.match(audit[2]!.target_id, /^version=2;from=1;characters=15;/);
  const everything = JSON.stringify([
    audit,
    f.store.all('SELECT * FROM web_admin_actions'),
    f.store.all('SELECT * FROM web_admin_audit'),
  ]);
  for (const text of ['林小满', '雨夜', '怕黑', '旧书店', '落汤鸡', '南方小城'])
    assert.equal(everything.includes(text), false, `no cast text (${text}) in audit or stored results`);
  assert.equal(/@/.test(everything), false, 'no email');
  assert.ok(audit.every((a) => /^[A-Za-z0-9_-]+$/.test(a.actor_id) && a.actor_id.length <= 128));
});

/** Every table that is not the cast's own or the administrators': count and digest of its rows. */
function playerTables(store: Store) {
  const tables = store
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name)
    .filter((name) => !/^(web_cast_|web_admin_|admin_)/.test(name));
  return Object.fromEntries(
    tables.map((name) => {
      const rows = store.all<Record<string, unknown>>(`SELECT * FROM "${name}"`);
      return [name, `${rows.length}:${sha(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))}`];
    }),
  );
}

test('publish and rollback never read or write a player table: row counts and digests are equal before and after', (t) => {
  const f = fixture(t);
  seedFreezeScenario(f.store, 'c01');
  Object.assign(f.store, { castContext: true });
  f.store.run(
    'INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?,?,?,?,?)',
    '2027-01-01',
    'reply_published',
    'c01',
    '',
    3,
  );
  // a frozen operation, so web_input_snapshots / web_v7_requests / web_operations are non-empty too
  freezeInputSnapshot(f.store as unknown as WebStore, 'operation', FREEZE_NOW);
  const before = playerTables(f.store);
  for (const table of [
    'messages',
    'web_operations',
    'web_input_snapshots',
    'web_principals',
    'worlds',
    'web_stats_daily',
    'memory_topics',
    'relationship_events',
    'scene_events',
    'web_points_events',
  ])
    assert.ok(table in before, `${table} is among the compared tables`);
  assert.ok(Object.keys(before).length > 100, 'the whole schema except the cast and the administrators');
  f.publishSample();
  const changed = structuredClone(f.cast.draft(f.ownerAuth, {}).doc);
  changed.world.background = '新的世界';
  const saved = f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: 2, doc: changed });
  f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: saved.revision });
  f.cast.rollback(f.ownerAuth, { requestId: f.request(), version: 1 });
  f.cast.compilePreview(f.ownerAuth, { characterId: 'c01', source: 'published' });
  assert.deepEqual(playerTables(f.store), before);
  assert.equal(f.cast.versions(f.ownerAuth, {}).latest, 3);
});

function publishFor(f: ReturnType<typeof fixture>, change?: (raw: ReturnType<typeof sampleCastRaw>) => void) {
  const raw = sampleCastRaw();
  change?.(raw);
  return f.publishSample(raw);
}
const frozen = (store: Store) => {
  const snapshot = store.get<Record<string, unknown>>(
    "SELECT * FROM web_input_snapshots WHERE operation_id='operation'",
  )!;
  const { request } = readWebV7Request(store as unknown as WebStore, 'operation');
  const row = store.get<{
    request_json: string;
    request_digest: string;
    prompt_digest: string;
    protocol_digest: string;
  }>("SELECT * FROM web_v7_requests WHERE operation_id='operation'")!;
  return { snapshot, request, row };
};
const OFF_SNAPSHOT_COLUMNS = Object.keys(OFF_MAIN.snapshot);

test('switch OFF: the snapshot, the request JSON, its digest and every prompt byte are exactly what main produced (fixture captured on 3f57e04)', (t) => {
  assert.match(OFF_MAIN.capturedFrom, /main 3f57e04/);
  for (const published of [false, true]) {
    const f = fixture(t);
    seedFreezeScenario(f.store);
    if (published) publishFor(f); // a publication exists, the switch is still off
    // the scenario's character is 'character'; the sample cast is for c01.. (nothing to freeze for it either way)
    const out = captureFreeze(f.store, false);
    assert.deepEqual(out.snapshot, OFF_MAIN.snapshot, `snapshot (published=${published})`);
    assert.deepEqual(
      out.request,
      OFF_MAIN.request,
      'request row: request_json, request_digest, protocol and prompt digests',
    );
    assert.equal(out.request.request_digest, OFF_MAIN.request.request_digest);
    assert.equal(out.promptSha256, OFF_MAIN.promptSha256);
    assert.deepEqual(
      out.prompts,
      OFF_MAIN.prompts,
      'system + user messages of the draft and the review stage, voice and text',
    );
    const cols = frozen(f.store).snapshot;
    assert.deepEqual([cols.cast_version, cols.cast_json, cols.cast_digest], [null, null, null], 'all three NULL');
    assert.equal(String(out.request.request_json).includes('"cast"'), false, 'the key is absent, not null');
    assert.equal(String(out.request.request_json).includes('cast'), false);
    t.diagnostic(`published=${published} ok`);
  }
});

test('switch ON with nothing published, with the character not in the published cast, or on a database older than 129: still the same bytes', (t) => {
  // on, nothing published
  const a = fixture(t);
  seedFreezeScenario(a.store);
  assert.deepEqual(captureFreeze(a.store, true).request, OFF_MAIN.request);
  // on, a publication that does not contain 'character'
  const b = fixture(t);
  seedFreezeScenario(b.store);
  publishFor(b);
  const outB = captureFreeze(b.store, true);
  assert.deepEqual(outB.request, OFF_MAIN.request);
  assert.deepEqual(outB.prompts, OFF_MAIN.prompts);
  // on, schema 128 (no cast tables at all): the freeze neither fails nor changes
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store);
  const old = captureFreeze(store, true);
  assert.deepEqual(old.snapshot, OFF_MAIN.snapshot);
  assert.deepEqual(old.request, OFF_MAIN.request);
  assert.equal(old.promptSha256, OFF_MAIN.promptSha256);
  assert.equal('cast_json' in store.get<Record<string, unknown>>('SELECT * FROM web_input_snapshots')!, false);
});

test('switch ON with a publication: the compiled view is frozen with the snapshot, put right after `character`, and read with the cast prompt files', (t) => {
  const f = fixture(t);
  seedFreezeScenario(f.store, 'c01');
  publishFor(f);
  const out = captureFreeze(f.store, true);
  const { snapshot, request, row } = frozen(f.store);
  const expected = JSON.stringify(compileCastView(sampleCast(), 'c01'));
  assert.equal(snapshot.cast_version, 1);
  assert.equal(snapshot.cast_json, expected);
  assert.equal(snapshot.cast_digest, sha(expected));
  assert.deepEqual(request.cast, {
    version: 1,
    digest: sha(expected),
    promptHash: castPromptHash(),
    view: JSON.parse(expected),
  });
  // `cast` sits right after `character` in the stored request
  const keys = Object.keys(JSON.parse(row.request_json));
  assert.equal(keys[keys.indexOf('character') + 1], 'cast');
  assert.notEqual(row.request_digest, OFF_MAIN.request.request_digest);
  assert.equal(row.request_digest, sha(row.request_json));
  // the snapshot digest covers the cast (and still verifies as a snapshot of this build)
  assert.notEqual(snapshot.snapshot_digest, OFF_MAIN.snapshot.snapshot_digest);
  // prompts: the user content has `cast` immediately after `character`; the system prompt ends with the cast prompt; the
  // reviewer gets its addendum
  const { draft, review } = out.prompts.voice;
  const content = JSON.parse(draft[1]!.content);
  const order = Object.keys(content);
  assert.equal(order[order.indexOf('character') + 1], 'cast');
  assert.deepEqual(Object.keys(content.cast), ['view']);
  assert.ok(draft[0]!.content.endsWith(CAST_CONTEXT_PROMPT));
  assert.ok(!draft[0]!.content.includes(CAST_REVIEW_PROMPT));
  assert.ok(review[0]!.content.endsWith(CAST_REVIEW_PROMPT));
  assert.ok(JSON.parse(review[1]!.content).cast.view.self.hiddenSettings.items.length === 1);
  // the same request without the cast keeps the old system prompt as a strict prefix
  assert.ok(draft[0]!.content.startsWith(OFF_MAIN.prompts.voice.draft[0]!.content));
  // the part of the user content BEFORE `cast` is the same as without it (the per-character prefix stays stable for caching)
  const prefix = (text: string) => text.slice(0, text.indexOf('"age"'));
  const offContent = OFF_MAIN.prompts.voice.draft[1]!.content;
  assert.equal(
    prefix(draft[1]!.content).replace(/,"cast":\{.*\}(?=,)/s, ''),
    prefix(offContent).replace(/"id":"character"/, '"id":"c01"'),
  );
});

test('the frozen view is immutable: publishing again, a rollback or flipping the switch never changes an operation that is frozen; retries reuse it', (t) => {
  const f = fixture(t);
  seedFreezeScenario(f.store, 'c01');
  publishFor(f);
  captureFreeze(f.store, true);
  const first = frozen(f.store);
  // publish something else, roll back, switch off
  const changed = structuredClone(f.cast.draft(f.ownerAuth, {}).doc);
  changed.characters[0]!.hidden[0]!.text = '换了一条隐藏设定';
  const saved = f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: 2, doc: changed });
  f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: saved.revision });
  f.cast.rollback(f.ownerAuth, { requestId: f.request(), version: 1 });
  Object.assign(f.store, { castContext: false });
  const second = frozen(f.store);
  assert.deepEqual(second.snapshot, first.snapshot);
  assert.deepEqual(second.row, first.row);
  assert.deepEqual(second.request.cast, first.request.cast);
  assert.equal(second.snapshot.cast_version, 1);
  // a re-dispatch freezes nothing again; reading returns the frozen view
  refused(
    () => freezeInputSnapshot(f.store as unknown as WebStore, 'operation', FREEZE_NOW + 1),
    'WEB_INPUT_SNAPSHOT_EXISTS',
  );
  assert.equal(
    readInputSnapshot(f.store as unknown as WebStore, {
      operation_id: 'operation',
      principal_id: 'principal',
      world_id: 'world',
      conversation_id: 'conversation',
      character_id: 'c01',
      input_message_id: 'input',
    }).cast_json,
    first.snapshot.cast_json,
  );
  // the immutability trigger covers the new columns too
  for (const column of ['cast_version', 'cast_json', 'cast_digest'])
    refused(
      () => f.store.run(`UPDATE web_input_snapshots SET ${column}=NULL WHERE operation_id='operation'`),
      'WEB_INPUT_SNAPSHOT_IMMUTABLE',
    );
  refused(
    () => f.store.run("DELETE FROM web_input_snapshots WHERE operation_id='operation'"),
    'WEB_INPUT_SNAPSHOT_IMMUTABLE',
  );
  // a request whose cast prompt files differ from this build's is not read (a deploy that changes them invalidates it)
  f.store.run('DROP TRIGGER IF EXISTS web_v7_requests_no_update');
  const doctored = JSON.parse(first.row.request_json);
  doctored.cast.promptHash = 'f'.repeat(64);
  const json = JSON.stringify(doctored);
  try {
    f.store.run(
      "UPDATE web_v7_requests SET request_json=?,request_digest=? WHERE operation_id='operation'",
      json,
      sha(json),
    );
    refused(() => readWebV7Request(f.store as unknown as WebStore, 'operation'), 'WEB_V7_REQUEST_INVALID');
  } catch (error) {
    // a store that forbids the update is just as good: the request is immutable
    assert.match(String((error as Error).message), /IMMUTABLE|immutable|REQUEST/i);
  }
});

test('a snapshot that froze a cast refuses a half-set row (all three columns are NULL or all are set)', (t) => {
  const f = fixture(t);
  seedFreezeScenario(f.store, 'c01');
  f.store.run('PRAGMA foreign_keys=OFF');
  const insert = (version: unknown, json: unknown, digest: unknown) =>
    f.store.run(
      `INSERT INTO web_input_snapshots(operation_id,capability,format_version,principal_id,player_id,world_id,conversation_id,
      character_id,input_message_id,input_seq,input_body,input_digest,template_version,template_json,template_digest,access_revision,
      frozen_at,snapshot_digest,cast_version,cast_json,cast_digest) VALUES ('operation','input-snapshot-only',1,'p','p','w','c','c1','input-x',1,'b','d',1,'{}','d',1,0,'d',?,?,?)`,
      version as never,
      json as never,
      digest as never,
    );
  refused(() => insert(1, null, null), 'WEB_INPUT_SNAPSHOT_CAST_INVALID');
  refused(() => insert(null, '{}', 'a'.repeat(64)), 'WEB_INPUT_SNAPSHOT_CAST_INVALID');
  refused(() => insert(1, '{}', 'short'), 'WEB_INPUT_SNAPSHOT_CAST_INVALID');
  refused(() => insert(1, 'not json', 'a'.repeat(64)), /WEB_INPUT_SNAPSHOT_CAST_INVALID|malformed|json/i);
  insert(null, null, null);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_input_snapshots')!.n, 1);
});

test('limits that the console will rely on are the ones in the contract', () => {
  assert.equal(CAST_LIMITS.chatCharacters, 15);
  assert.equal(CAST_LIMITS.people, 40);
  assert.equal(CAST_LIMITS.docMax, 300_000);
  assert.equal(CAST_LIMITS.viewMax, 24_000);
});
