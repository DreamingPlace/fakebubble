import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCastAdmin } from '../../../apps/server/admin/web-cast-admin.ts';
import { readDraft } from '../../../apps/server/cast/cast-store.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { installWebCharacterDeletion } from '../../../apps/server/characters/web-character-deletion-schema.ts';
import { installWebCharacterMaterials } from '../../../apps/server/characters/web-character-material-schema.ts';
import { migrateWebProviderCast } from '../../../apps/server/generation/web-provider-migration.ts';
import { CAST_FILE_FORMAT, CAST_FILE_VERSION } from '../../../packages/contracts/web-cast.ts';
import { WEB_PROVIDER_CATALOG } from '../../../config/web-v1.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { FREEZE_NOW, schema128 } from '../fixtures/cast-freeze.ts';

const origin = 'https://fixture.invalid';
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refused = (work: () => unknown, code: string | RegExp) =>
  assert.throws(work, (error: Error & { code?: string }) =>
    typeof code === 'string' ? error.code === code : code.test(`${error.code}:${error.message}`),
  );

/** The real schema through 129 with the character tables, an owner, staff with chosen permissions, and both admin objects. */
function fixture(t: TestContext) {
  const store = schema128();
  migrateWebProviderCast(store);
  t.after(() => store.close());
  // The seed catalog first (it insists the table holds exactly the approved characters), then two plain templates of our own.
  for (const item of WEB_PROVIDER_CATALOG) {
    const template = {
      id: item.characterId,
      name: item.displayName,
      version: 1,
      fictional: true,
      persona: '合成角色',
      schedule: defaultSchedule(),
    };
    store.run('INSERT INTO character_templates VALUES (?,1,?)', item.characterId, JSON.stringify(template));
    store.run(
      "INSERT INTO web_provider_voice_bindings VALUES (?,'voice-v1',1,?,'ref','model','user_selected',1,'{}')",
      item.characterId,
      item.characterId,
    );
  }
  installWebCharacterCatalog(store);
  installWebCharacterMaterials(store);
  // The deletion tables want the runtime store type; this one only needs their DDL.
  installWebCharacterDeletion(store as never);
  let ids = 0;
  const clock = { now: () => FREEZE_NOW };
  for (const id of ['c01', 'c02'])
    store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', id, 1, '{}');
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebAdminActions(store);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const staff = (permissions: string[], label: string) => {
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
  const characters = new WebCharacterAdmin(store, clock, accounts);
  cast.enableCharacters(characters);
  return {
    store,
    accounts,
    cast,
    characters,
    ownerAuth,
    staff,
    request: () => `cast-file-request-${String(++ids).padStart(6, '0')}`,
    drafts: () => store.all<{ character_id: string }>('SELECT character_id FROM web_character_drafts ORDER BY 1'),
    /** Everything a cast file must never touch, as one digest: templates, character revisions and drafts. */
    characterState: () =>
      sha([
        store.all('SELECT * FROM character_templates ORDER BY id'),
        store.all('SELECT * FROM web_character_revisions ORDER BY character_id, revision'),
        store.all('SELECT * FROM web_character_drafts ORDER BY character_id'),
      ]),
  };
}

const text = (value: string) => [{ text: value }];
const person = (name: string, extra: Record<string, unknown> = {}) => ({
  characterId: name,
  identity: { oneLiner: `${name}的一句话`, names: text(name), aliases: [], selfConcept: '', prototype: null },
  profile: '简介',
  personality: '',
  speech: { catchphrases: [], samples: [], avoid: [] },
  experiences: [],
  performance: '',
  hidden: [],
  unmapped: '',
  ...extra,
});
/** c01 and c02 exist; 林小满 and 周小禾 do not. */
// biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON file that tests then break on purpose
const file = (): Record<string, any> => ({
  format: CAST_FILE_FORMAT,
  version: CAST_FILE_VERSION,
  schema: 1,
  world: { background: '虚构的小城。' },
  characters: [
    person('c01', { identity: { oneLiner: '店员', names: text('甲'), aliases: [], selfConcept: '', prototype: null } }),
    person('c02', { identity: { oneLiner: '老师', names: text('乙'), aliases: [], selfConcept: '', prototype: null } }),
    {
      ...person('new:林小满'),
      identity: { oneLiner: '美术生', names: text('林小满'), aliases: [], selfConcept: '', prototype: null },
      workbench: { displayName: '小满', persona: '十九岁的美术生。', welcome: '嗨，我是小满。' },
    },
  ],
  people: [{ id: 'new-owner', kind: 'person', names: text('唱片店老板'), oneLiner: '' }],
  ratings: { c01: { 'new:林小满': 3.5, c02: 4 }, 'new:林小满': { c01: 4.5, 'new-owner': 2 } },
  directions: [{ from: 'c01', to: 'new:林小满', address: '小满', treatment: '嘴上嫌弃。' }],
  groups: [{ name: '三人组', members: ['c01', 'c02', 'new:林小满'], background: '', stories: [] }],
  stories: [
    {
      title: '第一幅写生',
      summary: '摘要',
      details: '',
      period: { start: '2025-03', end: '' },
      participants: ['c01', 'new:林小满', 'new-owner'],
      boundary: '',
      overrides: [{ characterId: 'c02', level: 'heard' }],
    },
  ],
  memes: [],
});

test('preview answers with a summary and saves nothing: no draft, no character, no revision change', (t) => {
  const f = fixture(t);
  const before = {
    revision: readDraft(f.store).revision,
    characters: f.characterState(),
    audit: f.store.all('SELECT * FROM web_admin_audit').length,
  };
  const sent = file();
  const preview = f.cast.importPreview(f.ownerAuth, { file: sent });
  assert.deepEqual(sent, file(), 'the file the caller sent is not rewritten in place');
  assert.equal(preview.importable, true);
  assert.deepEqual(preview.problems, []);
  assert.deepEqual(preview.summary!.charactersAdded.sort(), ['乙', '甲', '林小满'].sort());
  assert.deepEqual(
    [preview.summary!.people, preview.summary!.ratings, preview.summary!.groups, preview.summary!.stories],
    [1, 4, 1, 1],
  );
  assert.deepEqual(
    preview.created.map((c) => [c.name, c.matched]),
    [['林小满', false]],
  );
  assert.equal(readDraft(f.store).revision, before.revision);
  assert.equal(f.characterState(), before.characters);
  assert.equal(
    f.store.all('SELECT * FROM web_admin_audit').length,
    before.audit,
    'a preview leaves no audit row either',
  );
});

test('problems come back in words with the character name and the path', (t) => {
  const f = fixture(t);
  const bad = file();
  bad.ratings.c01!['new:林小满'] = 3.3;
  bad.ratings.c02 = { c02: 3, ghost: 1 } as never;
  const preview = f.cast.importPreview(f.ownerAuth, { file: bad });
  assert.equal(preview.importable, false);
  const grid = preview.problems.find((p) => p.code === 'CAST_RATING_OUT_OF_GRID')!;
  assert.equal(grid.who, '甲');
  assert.match(grid.text, /半星/);
  assert.ok(preview.problems.some((p) => p.code === 'CAST_SELF_RATING' && p.who === '乙'));
  assert.ok(preview.problems.some((p) => p.code === 'CAST_UNKNOWN_CHARACTER' && p.who === '乙'));
  // an entry id the draft never handed out is refused (the local check can't know the draft's ids; the server does)
  const invented = file();
  (invented.stories[0] as Record<string, unknown>).id = 'invented-id';
  assert.ok(
    f.cast.importPreview(f.ownerAuth, { file: invented }).problems.some((p) => p.code === 'CAST_FILE_UNKNOWN_ID'),
  );
  // a character the server does not know is a problem, not a warning
  const ghost = file();
  ghost.characters[0]!.characterId = 'nobody-here';
  ghost.ratings = {};
  ghost.directions = [];
  ghost.groups = [];
  ghost.stories = [];
  assert.ok(
    f.cast.importPreview(f.ownerAuth, { file: ghost }).problems.some((p) => p.code === 'CAST_CHARACTER_MISSING'),
  );
  const header = f.cast.importPreview(f.ownerAuth, { file: { ...file(), format: 'other' } });
  assert.deepEqual([header.importable, header.problems.map((p) => p.code)], [false, ['CAST_FILE_HEADER']]);
});

test('confirm: ONE action creates the draft characters, rewrites the keys and saves the draft; nothing is published', (t) => {
  const f = fixture(t);
  const before = f.characterState();
  const result = f.cast.importFile(f.ownerAuth, {
    requestId: f.request(),
    expectedRevision: readDraft(f.store).revision,
    file: file(),
  });
  assert.deepEqual([result.created, result.unchanged, result.duplicate, result.revision], [1, false, false, 2]);
  const draft = readDraft(f.store);
  const json = JSON.stringify(draft.doc);
  assert.ok(
    !json.includes('new:') && !json.includes('new-'),
    `every key is a real id ${json.match(/.{20}new[-:].{20}/)}`,
  );
  const made = draft.doc.characters.find((c) => c.identity.names[0]!.text === '林小满')!;
  assert.match(made.characterId, /^role-[0-9a-f]{8}$/);
  assert.deepEqual(draft.doc.ratings[made.characterId], {
    c01: 4.5,
    [draft.doc.people[0]!.id]: 2,
  });
  assert.equal(draft.doc.groups[0]!.members.at(-1), made.characterId);
  // the draft character exists exactly as 新建角色 makes it, with the workbench seed
  assert.deepEqual(
    f.drafts().map((d) => d.character_id),
    [made.characterId],
  );
  const detail = f.characters.detail(f.ownerAuth, made.characterId);
  assert.equal(detail.published, null);
  assert.equal(detail.draft!.profile.template.version, 1);
  assert.equal(detail.draft!.profile.template.fictional, true);
  assert.equal(detail.draft!.profile.presentation.displayName, '小满');
  assert.equal(detail.draft!.profile.template.persona, '十九岁的美术生。');
  assert.equal(detail.draft!.profile.presentation.welcome.text, '嗨，我是小满。');
  // never published: no publication, no live template for it, the other templates untouched
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_cast_publications')!.n, 0);
  assert.equal(f.store.get('SELECT 1 FROM character_templates WHERE id=?', made.characterId), undefined);
  assert.notEqual(f.characterState(), before);
  assert.equal(
    f.store.get(
      'SELECT 1 FROM character_templates WHERE id NOT IN (?,?) AND id NOT IN (SELECT character_id FROM web_provider_voice_bindings)',
      'c01',
      'c02',
    ),
    undefined,
    'no template was added',
  );
});

test('one transaction: a failure after the characters were made leaves no draft character and no new revision', (t) => {
  const f = fixture(t);
  const before = { characters: f.characterState(), revision: readDraft(f.store).revision };
  f.store.run(
    `CREATE TRIGGER test_cast_draft_refuses BEFORE UPDATE ON web_cast_draft BEGIN SELECT RAISE(ABORT,'injected failure'); END`,
  );
  refused(
    () => f.cast.importFile(f.ownerAuth, { requestId: f.request(), expectedRevision: before.revision, file: file() }),
    /injected failure/,
  );
  assert.deepEqual(f.drafts(), []);
  assert.equal(f.characterState(), before.characters, 'no orphan draft, revision or audit-visible character row');
  assert.equal(readDraft(f.store).revision, before.revision);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_actions')!.n, 0, 'and no recorded request');
  f.store.run('DROP TRIGGER test_cast_draft_refuses');
  // a file with a problem is refused before anything is written
  const bad = file();
  bad.ratings.c01!.c01 = 1;
  refused(
    () => f.cast.importFile(f.ownerAuth, { requestId: f.request(), expectedRevision: before.revision, file: bad }),
    'CAST_FILE_INVALID',
  );
  assert.deepEqual(f.drafts(), []);
});

test('idempotent: the same request answers the first result; the same file again creates nothing twice', (t) => {
  const f = fixture(t);
  const requestId = f.request();
  const first = f.cast.importFile(f.ownerAuth, { requestId, expectedRevision: 1, file: file() });
  const again = f.cast.importFile(f.ownerAuth, { requestId, expectedRevision: 1, file: file() });
  assert.deepEqual({ ...again, duplicate: false }, first);
  assert.equal(again.duplicate, true);
  assert.equal(f.drafts().length, 1);
  // another request id at the old revision is stale, like any save
  assert.throws(
    () => f.cast.importFile(f.ownerAuth, { requestId: f.request(), expectedRevision: 1, file: file() }),
    (error: Error & { code?: string; detail?: { currentRevision?: number } }) =>
      error.code === 'CAST_REVISION_CONFLICT' && error.detail?.currentRevision === 2,
  );
  // the same file at the current revision: the new key finds the character it already made, so nothing is created and nothing changes
  const third = f.cast.importFile(f.ownerAuth, { requestId: f.request(), expectedRevision: 2, file: file() });
  assert.deepEqual([third.created, third.unchanged, third.revision], [0, true, 2]);
  assert.equal(f.drafts().length, 1);
  assert.equal(readDraft(f.store).doc.people.length, 1, 'the person written new-… is not made twice either');
});

test('permissions: cast.read cannot import; cast.edit without characters.create cannot bring new characters; export needs cast.read', (t) => {
  const f = fixture(t);
  const nobody = f.staff(['stats.read'], 'Nobody');
  const reader = f.staff(['cast.read'], 'Reader');
  const editor = f.staff(['cast.edit'], 'Editor');
  const creator = f.staff(['cast.edit', 'characters.create'], 'Creator');
  const garbage = { nonsense: true };
  // the permission is checked BEFORE the body (a garbage body would be INVALID_REQUEST otherwise)
  for (const denied of [nobody, reader]) {
    refused(() => f.cast.importPreview(denied, garbage), 'ADMIN_PERMISSION_REQUIRED');
    refused(() => f.cast.importFile(denied, garbage), 'ADMIN_PERMISSION_REQUIRED');
  }
  refused(() => f.cast.exportFile(nobody, garbage), 'ADMIN_PERMISSION_REQUIRED');
  refused(() => f.cast.importFile(editor, garbage), 'INVALID_REQUEST');
  assert.equal(f.cast.exportFile(reader, {}).file.format, CAST_FILE_FORMAT);
  // cast.edit alone: the preview says why, and the import is refused whole
  const preview = f.cast.importPreview(editor, { file: file() });
  assert.equal(preview.importable, false);
  assert.ok(preview.problems.some((p) => p.code === 'CAST_FILE_NO_CREATE'));
  refused(
    () => f.cast.importFile(editor, { requestId: f.request(), expectedRevision: 1, file: file() }),
    'ADMIN_PERMISSION_REQUIRED',
  );
  assert.deepEqual(f.drafts(), []);
  assert.equal(readDraft(f.store).revision, 1);
  // with characters.create it goes through
  assert.equal(f.cast.importFile(creator, { requestId: f.request(), expectedRevision: 1, file: file() }).created, 1);
});

test('routes: session, CSRF and Origin are checked, the body shape is exact', async (t) => {
  const f = fixture(t);
  const call = (action: string, body: unknown, auth = f.ownerAuth) =>
    routeWebAccountAdmin(
      f.accounts,
      {
        method: 'POST',
        path: `/api/web/local/admin/cast/${action}`,
        body,
        adminCookie: auth.cookie,
        csrf: auth.csrf,
        origin: auth.origin,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      f.cast,
    );
  assert.equal(((await call('export', {}))!.body as { file: { format: string } }).file.format, CAST_FILE_FORMAT);
  assert.equal(((await call('import-preview', { file: file() }))!.body as { importable: boolean }).importable, true);
  const imported = (await call('import-file', { requestId: f.request(), expectedRevision: 1, file: file() }))!.body as {
    created: number;
  };
  assert.equal(imported.created, 1);
  await assert.rejects(call('import-file', { file: file() }), /INVALID_REQUEST/);
  await assert.rejects(call('import-preview', { file: file() }, { ...f.ownerAuth, csrf: 'wrong' }));
  await assert.rejects(call('import-preview', { file: file() }, { ...f.ownerAuth, origin: 'https://evil.invalid' }));
});

test('existing characters are never touched: a workbench block on one is ignored with a warning, its 角色工作台 profile stays byte for byte', (t) => {
  const f = fixture(t);
  // c01 has a saved draft profile in 角色工作台
  const profile = {
    template: {
      id: 'c01',
      name: '甲',
      version: 1,
      fictional: true,
      persona: '工作台里的完整人设。',
      schedule: {
        timeZone: 'Asia/Singapore',
        days: Object.fromEntries(
          [0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ startMinute: 0, endMinute: 1440, probability: 1, catchUp: true }]]),
        ),
      },
    },
    presentation: { displayName: '甲', publicDescription: '', welcome: { text: '你好', version: 'welcome-v1' } },
  };
  f.characters.save(f.ownerAuth, 'c01', { expectedRevision: null, profile } as never);
  const touched = file();
  (touched.characters[0] as Record<string, unknown>).workbench = {
    displayName: '改名',
    persona: '改了',
    welcome: '改了',
  };
  const preview = f.cast.importPreview(f.ownerAuth, { file: touched });
  assert.deepEqual(preview.problems, []);
  assert.ok(preview.warnings.some((w) => w.code === 'CAST_FILE_WORKBENCH_IGNORED'));
  const stateBefore = f.store.all('SELECT * FROM web_character_revisions WHERE character_id=?', 'c01');
  try {
    f.cast.importFile(f.ownerAuth, { requestId: f.request(), expectedRevision: 1, file: touched });
  } catch (e) {
    throw new Error(JSON.stringify((e as { detail: unknown }).detail));
  }
  assert.deepEqual(f.store.all('SELECT * FROM web_character_revisions WHERE character_id=?', 'c01'), stateBefore);
  assert.equal(f.characters.detail(f.ownerAuth, 'c01').draft!.profile.template.persona, '工作台里的完整人设。');
  assert.equal(
    f.store.get<{ config_json: string }>('SELECT config_json FROM character_templates WHERE id=?', 'c01')!.config_json,
    '{}',
  );
});

test('export → import with no edits changes nothing (the round trip), and a file may omit entry ids', (t) => {
  const f = fixture(t);
  f.cast.importFile(f.ownerAuth, { requestId: f.request(), expectedRevision: 1, file: file() });
  const exported = f.cast.exportFile(f.ownerAuth, {});
  assert.equal(exported.file.format, CAST_FILE_FORMAT);
  assert.equal(exported.file.version, CAST_FILE_VERSION);
  assert.ok(!JSON.stringify(exported.file).includes('workbench'), 'the profile of 角色工作台 is not exported');
  const preview = f.cast.importPreview(f.ownerAuth, { file: exported.file });
  assert.deepEqual([preview.importable, preview.summary!.unchanged], [true, true]);
  assert.deepEqual(
    [preview.summary!.charactersAdded, preview.summary!.charactersChanged, preview.summary!.charactersRemoved],
    [[], [], []],
  );
  const before = readDraft(f.store);
  const again = f.cast.importFile(f.ownerAuth, {
    requestId: f.request(),
    expectedRevision: before.revision,
    file: exported.file,
  });
  assert.deepEqual(
    [again.unchanged, again.created, again.revision, again.digest],
    [true, 0, before.revision, before.digest],
  );
  // the same file with every entry id stripped is still no change: ids are kept where the content matches
  const stripped = JSON.parse(
    JSON.stringify(exported.file, (key, value) =>
      key === 'id' && typeof value === 'string' && !/^role-/.test(value) && value.startsWith('e_') ? undefined : value,
    ),
  );
  const bare = f.cast.importPreview(f.ownerAuth, { file: stripped });
  assert.equal(bare.summary!.unchanged, true);
  // and an edit shows up as exactly that
  const edited = structuredClone(exported.file) as { characters: { profile: string }[] };
  edited.characters[0]!.profile = '改过的简介';
  const diff = f.cast.importPreview(f.ownerAuth, { file: edited });
  assert.deepEqual(diff.summary!.charactersChanged, ['甲']);
});

test('the audit row and the stored result carry the action, revision, counts and a digest - no cast text, no name, no id', (t) => {
  const f = fixture(t);
  f.cast.importFile(f.ownerAuth, { requestId: f.request(), expectedRevision: 1, file: file() });
  const rows = f.store.all<{ action: string; target_id: string }>(
    "SELECT action,target_id FROM web_admin_audit WHERE action LIKE 'cast-file%'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, 'cast-file-imported');
  assert.match(
    rows[0]!.target_id,
    /^revision=2;characters=3;people=1;groups=1;stories=1;memes=0;created=1;digest=[0-9a-f]{12}$/,
  );
  const stored = f.store.all<{ result_json: string }>(
    "SELECT result_json FROM web_admin_actions WHERE action='cast-import-file'",
  );
  const everything = JSON.stringify([rows, stored]);
  for (const secret of ['林小满', '小满', '店员', '唱片店老板', 'role-'])
    assert.ok(!everything.includes(secret), secret);
});
