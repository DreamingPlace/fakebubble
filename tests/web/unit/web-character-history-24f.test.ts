import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../../../apps/server/platform/store.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import { configureWebProvider } from '../../../apps/server/generation/web-provider-configuration.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import {
  installWebCharacterCatalog,
  publishedWebCharacters,
} from '../../../apps/server/characters/web-character-catalog.ts';
import { installWebCharacterMaterials } from '../../../apps/server/characters/web-character-material-schema.ts';
import { WebCharacterMaterials } from '../../../apps/server/characters/web-character-materials.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { syntheticCharacterReview } from '../fixtures/character-review.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { WEB_PROVIDER_CATALOG, WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { hasCharacterPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import {
  ADMIN_PERMISSION_ITEMS,
  ADMIN_PERMISSION_PRESETS,
  itemPermission,
} from '../../../packages/contracts/web-admin-permissions.ts';
import { profileContentKey } from '../../../apps/server/characters/web-character-history.ts';
import { PrivateMediaObjects, type PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/conversation/web-vertical-publisher.ts';

function full(t: test.TestContext) {
  const store = Object.assign(new Store(':memory:'), { instanceId: 'material-unit' });
  t.after(() => store.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'material-unit')");
  migrateWebProviderOffline(store);
  const now = 1_800_000_000_000,
    clock = { now: () => now },
    selected = syntheticSelection();
  for (const item of selected)
    store.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      item.characterId,
      item.personaVersion,
      JSON.stringify(item.template),
    );
  configureWebProvider(store as unknown as WebRuntimeStore, selected, now);
  const accounts = new WebAccountAdmin(store, clock, 'https://fixture.invalid');
  installWebCharacterCatalog(store);
  installWebCharacterMaterials(store);
  const chars = new WebCharacterAdmin(store, clock, accounts),
    materials = new WebCharacterMaterials(store, clock);
  chars.enableMaterials(materials);
  const login = accounts.login(accounts.issueLoginGrant().token, 'https://fixture.invalid');
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: 'https://fixture.invalid' };
  const offline = new WebProviderOffline(store, clock);
  for (const role of publishedWebCharacters(store)) {
    const version = store.get<{ voice_version: string }>(
      'SELECT voice_version FROM web_provider_voice_bindings WHERE character_id=?',
      role.characterId,
    )!.voice_version;
    offline.registerWelcome({
      characterId: role.characterId,
      voiceVersion: version,
      body: role.presentation.welcome.text,
      wav: syntheticTone(),
    });
    offline.registerApprovedFooter({
      characterId: role.characterId,
      voiceVersion: version,
      body: SYNTHETIC_TRIAL_FOOTER,
      wav: syntheticTone(),
      approved: true,
    });
  }
  const draft = (id = 'wei-guagua', model = 's2.1-pro') => {
    const profile = chars.detail(auth, 'wei-guagua').published!.profile;
    profile.template.id = id;
    profile.template.version = id === 'wei-guagua' ? profile.template.version + 1 : 1;
    profile.presentation.welcome = { text: '新的欢迎词', version: 'welcome-next' };
    profile.template.voice = { profileId: 'new-approved-profile', version: 1, speed: 1 };
    const saved = chars.save(auth, id, { expectedRevision: null, profile });
    const input = {
      requestId: 'material-' + id,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      referenceId: 'selected-existing-reference',
      model,
    };
    const material = chars.materialPrepare(auth, id, input);
    return { id, profile, saved, input, ...material };
  };
  const approve = async (d: ReturnType<typeof draft>) => {
    for (const kind of ['welcome', 'footer'])
      await chars.materialUpload(auth, d.id, {
        materialId: d.materialId,
        kind,
        base64: syntheticTone().toString('base64'),
      });
    return chars.materialApprove(auth, d.id, {
      materialId: d.materialId,
      acknowledgeRights: true,
      acknowledgeWelcomeListening: true,
      acknowledgeFooterListening: true,
      note: '离线合成素材授权与试听确认',
    });
  };
  const publication = async (d: ReturnType<typeof draft>) => ({
    requestId: 'publish-' + d.id,
    draftRevision: d.saved.revision,
    profileHash: d.saved.contentHash,
    previewId: await syntheticCharacterReview(store, now, d.id),
    acknowledgeReview: true,
    materialId: d.materialId,
  });
  return { store, accounts, chars, materials, auth, clock, offline, draft, approve, publication };
}

type Full = ReturnType<typeof full>;
const ID = 'wei-guagua';
/** The seed of the full fixture is published as version 2 (its persona version); v2 below is the next one, v3 the restore. */
const V1 = 2,
  V2 = 3,
  V3 = 4;
const ORIGIN = 'https://fixture.invalid';
/** A signed-in administrator who is NOT the owner, holding exactly these grants. */
let memberSeq = 0;
function member(accounts: WebAccountAdmin, owner: { cookie: unknown; csrf: unknown }, permissions: string[]) {
  const grant = accounts.issueMember(owner.cookie, owner.csrf, ORIGIN, {
    requestId: 'helper-' + ++memberSeq,
    label: 'Helper',
    memberId: null,
    permissions: permissions as never,
  });
  const login = accounts.login(grant.token, ORIGIN);
  return { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
}
/** v1 (seed voice) -> v2 (a new approved voice bundle and welcome line). */
async function publishV2(f: Full) {
  const d = f.draft(ID);
  await f.approve(d);
  f.chars.publish(f.auth, ID, await f.publication(d));
  return d;
}
const table = (f: Full, sql: string, ...args: unknown[]) => f.store.all(sql, ...(args as never[]));

test('delete is the owner role only: no category, preset, wildcard or scoped grant opens it; stored grants stay untouched', () => {
  for (const grants of [
    ['category.characters'],
    ['category.characters', 'category.publication', 'category.materials'],
    ['characters.delete:*'],
    [`characters.delete:${ID}`],
    ADMIN_PERMISSION_ITEMS.map(itemPermission),
  ])
    assert.equal(hasCharacterPermission(grants, 'delete', ID), false, grants.join());
  const everything = ADMIN_PERMISSION_PRESETS.find((p) => p.id === 'all')!.items;
  assert.ok(!(everything as readonly string[]).includes('characters.delete'), '全部 no longer lists delete');
  for (const preset of ADMIN_PERMISSION_PRESETS)
    assert.ok(!(preset.items as readonly string[]).includes('characters.delete'), preset.id);
  // The other actions are unchanged.
  assert.equal(hasCharacterPermission(['category.characters'], 'edit', ID), true);
});

test('a direct delete call by a non-owner is refused with the existing forbidden code; the owner passes authorisation', (t) => {
  const f = full(t);
  for (const grants of [
    ['category.characters'],
    ['characters.delete:*', 'characters.read:*'],
    [`characters.delete:${ID}`, `characters.read:${ID}`],
    ADMIN_PERMISSION_ITEMS.map(itemPermission),
  ]) {
    const who = member(f.accounts, f.auth, grants);
    assert.throws(() => f.chars.deletionPreview(who, ID), /ADMIN_PERMISSION_REQUIRED/);
    assert.throws(
      () => f.chars.deletionStart(who, ID, { requestId: 'x', previewHash: 'y', acknowledgeDeleteAllChats: true }),
      /ADMIN_PERMISSION_REQUIRED/,
    );
  }
  // The owner is authorised (the deletion machinery itself is not wired in this unit fixture).
  assert.throws(() => f.chars.deletionPreview(f.auth, ID), /DELETION_UNAVAILABLE/);
});

test('history lists every version newest first with origin, role label and a one-line summary; the snapshot is the stored profile_json', async (t) => {
  const f = full(t);
  await publishV2(f);
  const list = f.chars.history(f.auth, ID);
  assert.deepEqual(
    list.versions.map((v) => [v.version, v.live, v.by, v.origin.kind]),
    [
      [V2, true, 'owner', 'publish'],
      [V1, false, 'system', 'publish'],
    ],
  );
  assert.equal(list.live, V2);
  assert.equal(list.versions[1]!.summary, '初始版本');
  assert.equal(list.versions[0]!.summary, '改动：欢迎词、声音');
  assert.ok(JSON.stringify(list).match(/@|memberId|sessionId/) === null, 'no email or id in the history');
  const stored = f.store.get<{ profile_json: string; content_hash: string }>(
    'SELECT profile_json,content_hash FROM web_character_versions WHERE character_id=? AND version=?',
    ID,
    V1,
  )!;
  const snap = f.chars.historyVersion(f.auth, ID, V1);
  assert.deepEqual(snap.profile, JSON.parse(stored.profile_json));
  assert.equal(snap.profileHash, stored.content_hash);
  assert.equal(snap.liveProfile!.template.version, V2);
  // A read-only administrator sees the same; an administrator without read does not.
  const reader = member(f.accounts, f.auth, [`characters.read:${ID}`]);
  assert.equal(f.chars.history(reader, ID).versions.length, 2);
  assert.throws(() => f.chars.history(member(f.accounts, f.auth, ['invites.read']), ID), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.chars.historyVersion(f.auth, ID, 99), /NOT_FOUND/);
});

test("restore v1 after v2 publishes v3 with v1's profile, voice binding and clips; v1 and v2 stay byte for byte; a replay is the same v3", async (t) => {
  const f = full(t),
    seedBinding = f.store.get('SELECT * FROM web_provider_voice_bindings WHERE character_id=?', ID);
  await publishV2(f);
  const history = () => table(f, 'SELECT * FROM web_character_versions WHERE character_id=? ORDER BY version', ID);
  const [v1, v2] = history();
  const v2Binding = f.store.get('SELECT * FROM web_provider_voice_bindings WHERE character_id=?', ID);
  assert.notDeepEqual(v2Binding, seedBinding);
  const clips = [
    table(f, 'SELECT * FROM web_provider_welcome_assets WHERE character_id=? ORDER BY voice_version', ID),
    table(f, 'SELECT * FROM web_provider_footer_assets WHERE character_id=? ORDER BY voice_version', ID),
  ];
  const input = { requestId: 'restore-1', version: V1, liveVersion: V2 };
  const result = f.chars.restore(f.auth, ID, input);
  assert.deepEqual(
    { v: result.version, from: result.restoredFrom, id: result.characterId },
    { v: V3, from: V1, id: ID },
  );
  // History: v1 and v2 untouched, one new row.
  const after = history();
  assert.equal(after.length, 3);
  assert.deepEqual(after.slice(0, 2), [v1, v2]);
  const v3 = after[2] as { profile_json: string; content_hash: string };
  const p1 = JSON.parse((v1 as { profile_json: string }).profile_json),
    p3 = JSON.parse(v3.profile_json);
  assert.equal(p3.template.version, V3, 'the profile carries the number it is published under');
  assert.deepEqual({ ...p3, template: { ...p3.template, version: V1 } }, p1);
  assert.equal(profileContentKey(p3), profileContentKey(p1), 'same profile hash once the version number is set aside');
  assert.equal(result.profileHash, v3.content_hash);
  // The live catalog, the template row the next message is frozen from, the voice binding and the clips are v1's.
  const live = publishedWebCharacters(f.store).find((c) => c.characterId === ID)!;
  assert.equal(live.version, V3);
  assert.deepEqual(
    { ...f.store.get<object>('SELECT version,config_json FROM character_templates WHERE id=?', ID) },
    { version: V3, config_json: JSON.stringify(p3.template) },
  );
  assert.deepEqual(f.store.get('SELECT * FROM web_provider_voice_bindings WHERE character_id=?', ID), seedBinding);
  assert.deepEqual(
    [
      table(f, 'SELECT * FROM web_provider_welcome_assets WHERE character_id=? ORDER BY voice_version', ID),
      table(f, 'SELECT * FROM web_provider_footer_assets WHERE character_id=? ORDER BY voice_version', ID),
    ],
    clips,
    'no clip is rewritten or duplicated',
  );
  const welcome = f.store.get<{ body: string }>(
    `SELECT w.body FROM web_provider_welcome_assets w JOIN web_provider_voice_bindings v
    ON v.character_id=w.character_id AND v.voice_version=w.voice_version WHERE w.character_id=?`,
    ID,
  )!;
  assert.equal(welcome.body, p1.presentation.welcome.text);
  // The guard on the binding is back, byte for byte, and the schema check still passes.
  assert.throws(
    () => f.store.run("UPDATE web_provider_voice_bindings SET reference_id='unapproved' WHERE character_id=?", ID),
    /VOICE_IMMUTABLE/,
  );
  installWebCharacterMaterials(f.store);
  assert.equal(f.store.get('PRAGMA foreign_key_check'), undefined);
  // Replay: the same answer, still three versions and one audit row; the same id with another body is a conflict.
  assert.deepEqual(f.chars.restore(f.auth, ID, input), result);
  assert.equal(history().length, 3);
  assert.deepEqual(
    table(f, `SELECT action FROM web_admin_audit WHERE action LIKE 'restore:%'`).map((r: any) => r.action),
    [`restore:v${V1}->v${V3}`],
  );
  assert.throws(() => f.chars.restore(f.auth, ID, { ...input, version: V2 }), /IDEMPOTENCY_CONFLICT/);
  // History now says so, and v2 can be restored the other way round (the new bundle becomes current again).
  const list = f.chars.history(f.auth, ID);
  assert.deepEqual(list.versions[0]!.origin, { kind: 'restore', from: V1 });
  assert.equal(list.versions[0]!.live, true);
  assert.equal(list.versions[0]!.by, 'owner');
  assert.equal(f.chars.restore(f.auth, ID, { requestId: 'restore-2', version: V2, liveVersion: V3 }).version, V3 + 1);
  assert.deepEqual(f.store.get('SELECT * FROM web_provider_voice_bindings WHERE character_id=?', ID), v2Binding);
});

test('restore is refused for a non-owner, for the live version, for a stale live number and for a version that does not exist', async (t) => {
  const f = full(t);
  await publishV2(f);
  const before = table(f, 'SELECT * FROM web_character_versions');
  for (const grants of [
    [`characters.publish:${ID}`],
    ['category.publication', 'category.characters'],
    ADMIN_PERMISSION_ITEMS.map(itemPermission),
  ])
    assert.throws(
      () =>
        f.chars.restore(member(f.accounts, f.auth, grants), ID, {
          requestId: 'n' + grants.length,
          version: 1,
          liveVersion: 2,
        }),
      /ADMIN_OWNER_REQUIRED/,
    );
  assert.throws(
    () => f.chars.restore(f.auth, ID, { requestId: 'live', version: V2, liveVersion: V2 }),
    /CHARACTER_VERSION_IS_LIVE/,
  );
  assert.throws(
    () => f.chars.restore(f.auth, ID, { requestId: 'stale', version: V1, liveVersion: V1 }),
    /LIVE_VERSION_CONFLICT/,
  );
  assert.throws(() => f.chars.restore(f.auth, ID, { requestId: 'none', version: 99, liveVersion: V2 }), /NOT_FOUND/);
  assert.throws(
    () => f.chars.restore(f.auth, ID, { requestId: 'extra', version: V1, liveVersion: V2, x: 1 }),
    /INVALID_ADMIN_REQUEST/,
  );
  assert.deepEqual(table(f, 'SELECT * FROM web_character_versions'), before);
  assert.equal(table(f, 'SELECT * FROM web_character_restores').length, 0);
});

test('a version whose voice binding, clip or material is gone shows the reason and is refused; nothing half-restored', async (t) => {
  const cases: [string, number, (f: Full, seedVoice: string) => void, boolean][] = [
    // [problem, version, how it is lost, restore v1 first (so that the version in question is not the live one)]
    [
      'CLIP_MISSING',
      V1,
      (f, voice) => {
        f.store.all('DROP TRIGGER web_provider_footer_no_delete');
        f.store.run('DELETE FROM web_provider_footer_assets WHERE character_id=? AND voice_version=?', ID, voice);
      },
      false,
    ],
    [
      'VOICE_BINDING_MISSING',
      V1,
      (f, voice) => {
        f.store.all('DROP TRIGGER web_character_voice_history_delete');
        f.store.run('DELETE FROM web_character_voice_history WHERE character_id=? AND voice_version=?', ID, voice);
      },
      false,
    ],
    [
      'MATERIAL_MISSING',
      V2,
      (f) => {
        f.store.all('DROP TRIGGER web_character_material_approvals_delete');
        f.store.run('DELETE FROM web_character_material_approvals');
      },
      true,
    ],
  ];
  for (const [problem, version, lose, restoreFirst] of cases) {
    const f = full(t);
    // The losses below are direct tampering (what the immutability triggers exist to prevent), so the reference checks are set aside.
    f.store.all('PRAGMA foreign_keys=OFF');
    const seedVoice = f.store.get<{ voice_version: string }>(
      'SELECT voice_version FROM web_provider_voice_bindings WHERE character_id=?',
      ID,
    )!.voice_version;
    await publishV2(f);
    if (restoreFirst) f.chars.restore(f.auth, ID, { requestId: 'first', version: V1, liveVersion: V2 });
    const liveVersion = restoreFirst ? V3 : V2;
    lose(f, seedVoice);
    const watch = () => [
      table(f, 'SELECT * FROM web_character_versions'),
      table(f, 'SELECT * FROM web_provider_voice_bindings'),
      table(f, 'SELECT * FROM character_templates'),
      table(f, 'SELECT * FROM web_character_restores'),
    ];
    const before = watch();
    const row = f.chars.history(f.auth, ID).versions.find((v) => v.version === version)!;
    assert.deepEqual([row.restorable, row.problem], [false, problem], problem);
    assert.throws(
      () => f.chars.restore(f.auth, ID, { requestId: 'r-' + problem, version, liveVersion }),
      (e: any) => e.code === 'CHARACTER_VERSION_NOT_RESTORABLE' && e.detail.problem === problem,
      problem,
    );
    assert.deepEqual(watch(), before, 'nothing half-restored: ' + problem);
    // The version that is still whole is not affected.
    const other = f.chars.history(f.auth, ID).versions.find((v) => v.version !== version && !v.live);
    if (other && problem !== 'MATERIAL_MISSING')
      assert.equal(other.restorable, true, 'the other version stays restorable');
  }
});

/** The lighter fixture of the publication tests (metadata-only voice tables): busy fence, deleted character, drafts. */
function light(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.all(`CREATE TABLE web_provider_voice_bindings(character_id TEXT PRIMARY KEY,voice_version TEXT,
    profile_id TEXT,voice_revision INTEGER,approved INTEGER,source TEXT) STRICT`);
  store.all(
    `CREATE TABLE web_provider_welcome_assets(character_id TEXT,voice_version TEXT,body TEXT,text_version TEXT,origin TEXT) STRICT`,
  );
  store.all(`CREATE TABLE web_provider_footer_assets(character_id TEXT,voice_version TEXT,origin TEXT) STRICT`);
  store.all(`CREATE TABLE web_operations(character_id TEXT,status TEXT) STRICT`);
  const now = 1_800_000_000_000,
    clock = { now: () => now };
  const admin = new WebAccountAdmin(store, clock, ORIGIN);
  for (const item of WEB_PROVIDER_CATALOG) {
    const id = item.characterId,
      template = {
        id,
        name: item.displayName,
        version: 1,
        fictional: true,
        persona: '隔离合成角色',
        schedule: defaultSchedule(),
        voice: { profileId: id, version: 1, speed: 1 },
      };
    store.run('INSERT INTO character_templates VALUES (?,1,?)', id, JSON.stringify(template));
    store.run("INSERT INTO web_provider_voice_bindings VALUES (?,'voice-v1',?,1,1,'user_selected')", id, id);
    store.run(
      "INSERT INTO web_provider_welcome_assets VALUES (?,'voice-v1',?,?,'operator_approved')",
      id,
      WEB_PROVIDER_WELCOME[id].text,
      WEB_PROVIDER_WELCOME[id].version,
    );
    store.run("INSERT INTO web_provider_footer_assets VALUES (?,'voice-v1','operator_approved')", id);
  }
  installWebCharacterCatalog(store);
  const service = new WebCharacterAdmin(store, clock, admin),
    login = admin.login(admin.issueLoginGrant().token, ORIGIN),
    auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  let n = 0;
  /** Save an edited copy of the live profile as a draft, and (publish = true) publish it. */
  const edit = async (persona: string, publish: boolean) => {
    const profile = service.detail(auth, ID).published!.profile;
    profile.template.version++;
    profile.template.persona = persona;
    const saved = service.save(auth, ID, { expectedRevision: null, profile });
    if (!publish) return saved;
    service.publish(auth, ID, {
      requestId: 'p' + ++n,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      previewId: await syntheticCharacterReview(store, now, ID),
      acknowledgeReview: true,
    });
    return saved;
  };
  return { store, service, admin, auth, edit, now };
}

test('restore keeps the one-publication-at-a-time fence: any unfinished player task refuses it, nothing is touched', async (t) => {
  const f = light(t);
  await f.edit('第二版', true);
  const before = table(f as never, 'SELECT * FROM web_character_versions');
  for (const status of ['queued', 'running', 'unknown', 'waiting']) {
    f.store.run('INSERT INTO web_operations VALUES (?,?)', ID, status);
    assert.throws(
      () => f.service.restore(f.auth, ID, { requestId: 'busy', version: 1, liveVersion: 2 }),
      /CHARACTER_PUBLICATION_BUSY/,
    );
    assert.equal(f.store.get<{ status: string }>('SELECT status FROM web_operations')!.status, status);
    f.store.run('DELETE FROM web_operations');
  }
  assert.deepEqual(table(f as never, 'SELECT * FROM web_character_versions'), before);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_restores')!.n, 0);
  f.store.run("INSERT INTO web_operations VALUES ('jojo','unknown')");
  for (const status of ['published', 'failed', 'cancelled'])
    f.store.run('INSERT INTO web_operations VALUES (?,?)', ID, status);
  assert.equal(f.service.restore(f.auth, ID, { requestId: 'free', version: 1, liveVersion: 2 }).version, 3);
});

test('a deleted character has no history and no restore', async (t) => {
  const f = light(t);
  await f.edit('第二版', true);
  f.store.all(
    'CREATE TABLE web_character_deletions(id TEXT PRIMARY KEY,character_id TEXT,state TEXT,created_at INTEGER)',
  );
  f.store.run("INSERT INTO web_character_deletions VALUES ('d',?,'purging',1)", ID);
  assert.throws(
    () => f.service.restore(f.auth, ID, { requestId: 'gone', version: 1, liveVersion: 2 }),
    /CHARACTER_DELETED/,
  );
  assert.throws(() => f.service.history(f.auth, ID), /CHARACTER_DELETED/);
  assert.throws(() => f.service.historyVersion(f.auth, ID, 1), /CHARACTER_DELETED/);
});

test('an unpublished draft survives a restore unchanged; its base is then older than live and the existing stale-base checks say so', async (t) => {
  const f = light(t);
  await f.edit('第二版', true);
  const draft = await f.edit('草稿里的新人设', false); // based on v2
  const rows = () => table(f as never, 'SELECT * FROM web_character_revisions ORDER BY character_id,revision');
  const pointer = () => table(f as never, 'SELECT * FROM web_character_drafts');
  const [before, pointerBefore] = [rows(), pointer()];
  assert.equal(draft.baseVersion, 2);
  assert.equal(f.service.restore(f.auth, ID, { requestId: 'with-draft', version: 1, liveVersion: 2 }).version, 3);
  assert.deepEqual(rows(), before);
  assert.deepEqual(pointer(), pointerBefore);
  const detail = f.service.detail(f.auth, ID);
  assert.deepEqual(
    [detail.draft!.revision, detail.draft!.baseVersion, detail.published!.version],
    [draft.revision, 2, 3],
  );
  assert.deepEqual(detail.draft!.profile, draft.profile);
  // What the draft panel already does for an old base: publishing and saving over it are refused as LIVE_VERSION_CONFLICT.
  assert.throws(
    () =>
      f.service.publish(f.auth, ID, {
        requestId: 'stale-draft',
        draftRevision: draft.revision,
        profileHash: draft.contentHash,
        previewId: 'whatever',
        acknowledgeReview: true,
      }),
    /LIVE_VERSION_CONFLICT/,
  );
  assert.throws(
    () =>
      f.service.save(f.auth, ID, {
        expectedRevision: draft.revision,
        profile: { ...draft.profile, template: { ...draft.profile.template, persona: '再改一次' } },
      }),
    /LIVE_VERSION_CONFLICT|INVALID_DRAFT_VERSION/,
  );
});

test('colour-only publications and restores are told apart in the history; a lost clip in the lighter fixture is reported too', async (t) => {
  const f = light(t);
  const colour = f.service.detail(f.auth, ID).published!.profile;
  colour.template.version++;
  colour.presentation.color = '#112233';
  const saved = f.service.save(f.auth, ID, { expectedRevision: null, profile: colour });
  f.service.publish(f.auth, ID, {
    requestId: 'colour',
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    acknowledgeReview: true,
  });
  f.service.restore(f.auth, ID, { requestId: 'back', version: 1, liveVersion: 2 });
  const list = f.service.history(f.auth, ID).versions;
  assert.deepEqual(
    list.map((v) => [v.version, v.origin.kind, v.summary]),
    [
      [3, 'restore', '只改了主色'],
      [2, 'colour', '只改了主色'],
      [1, 'publish', '初始版本'],
    ],
  );
  // Losing v1's welcome clip makes v1 不可恢复.
  f.store.run('DELETE FROM web_provider_welcome_assets WHERE character_id=?', ID);
  assert.ok(
    f.service.history(f.auth, ID).versions.every((v) => v.live || (!v.restorable && v.problem === 'CLIP_MISSING')),
  );
});

test('the admin routes reach history, one snapshot and restore with exactly their fields; the history reads are on the read-only budget', async () => {
  const { routeWebAccountAdmin } = await import('../../../apps/server/admin/web-account-admin-routes.ts');
  const { isReadOnlyAdminPost } = await import('../../../apps/server/cloudflare/web-admin-read.ts');
  const seen: Record<string, unknown> = {};
  const characters = {
    history: (_a: unknown, id: string) => (seen.history = id),
    historyVersion: (_a: unknown, _id: string, version: unknown) => (seen.version = version),
    restore: (_a: unknown, _id: string, body: unknown) => (seen.restore = body),
  };
  const call = (path: string, body: Record<string, unknown>) =>
    routeWebAccountAdmin(
      { authorize: () => ({}) } as never,
      {
        method: 'POST',
        path: `/api/web/local/admin/characters/jojo/${path}`,
        body,
        adminCookie: 'c',
        csrf: 'x',
        origin: 'o',
      } as never,
      characters as never,
    );
  assert.equal((await call('history', {}))?.status, 200);
  assert.equal(seen.history, 'jojo');
  await call('history-version', { version: 3 });
  assert.equal(seen.version, 3);
  await call('restore', { requestId: 'r', version: 1, liveVersion: 2 });
  assert.deepEqual(seen.restore, { requestId: 'r', version: 1, liveVersion: 2 });
  await assert.rejects(
    () => call('restore', { requestId: 'r', version: 1, liveVersion: 2, extra: 1 }),
    /INVALID_REQUEST/,
  );
  await assert.rejects(() => call('history', { x: 1 }), /INVALID_REQUEST/);
  assert.equal(isReadOnlyAdminPost('/admin/characters/jojo/history'), true);
  assert.equal(isReadOnlyAdminPost('/admin/characters/jojo/history-version'), true);
  assert.equal(isReadOnlyAdminPost('/admin/characters/jojo/restore'), false);
});

test('schema step 3 is added to an authority that has steps 1 and 2, keeps its history, and an unknown hash fails closed', (t) => {
  const f = light(t);
  const before = table(f as never, 'SELECT * FROM web_character_versions');
  f.store.all('DROP TABLE web_character_restores');
  f.store.run('DELETE FROM web_character_schema WHERE version=3');
  installWebCharacterCatalog(f.store);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_schema')!.n, 3);
  assert.deepEqual(table(f as never, 'SELECT * FROM web_character_versions'), before);
  f.store.run("UPDATE web_character_schema SET sha256='changed' WHERE version=3");
  assert.throws(() => installWebCharacterCatalog(f.store), /SCHEMA_MISMATCH/);
});
