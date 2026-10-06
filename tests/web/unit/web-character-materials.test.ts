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
import { PrivateMediaObjects, type PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/conversation/web-vertical-publisher.ts';

function fixture(t: test.TestContext) {
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
  const draft = (id = 'wei-guagua') => {
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
      model: 's2.1-pro',
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

test('material migration preserves all seed binding bytes; drift and unapproved direct updates fail closed', (t) => {
  const f = fixture(t),
    before = f.store.all('SELECT * FROM web_provider_voice_bindings ORDER BY character_id');
  installWebCharacterMaterials(f.store);
  assert.deepEqual(f.store.all('SELECT * FROM web_character_voice_history ORDER BY character_id'), before);
  assert.throws(
    () => f.store.run("UPDATE web_provider_voice_bindings SET reference_id='unapproved'"),
    /VOICE_IMMUTABLE/,
  );
  assert.throws(() => f.store.run('DELETE FROM web_character_voice_history'), /MATERIAL_IMMUTABLE/);
  f.store.all('DROP TRIGGER web_provider_voice_bindings_no_update');
  assert.throws(() => installWebCharacterMaterials(f.store), /SCHEMA_MISMATCH/);
  assert.deepEqual(f.store.all('SELECT * FROM web_provider_voice_bindings ORDER BY character_id'), before);
});

test('prepared bundle is private and immutable; both finished clips, exact draft and separate approval are required', async (t) => {
  const f = fixture(t),
    before = publishedWebCharacters(f.store),
    d = f.draft();
  assert.deepEqual(f.chars.materialPrepare(f.auth, d.id, d.input), { materialId: d.materialId });
  assert.throws(
    () => f.chars.materialPrepare(f.auth, d.id, { ...d.input, referenceId: 'other' }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const input = await f.publication(d);
  assert.throws(() => f.chars.publish(f.auth, d.id, input), /MATERIALS_REQUIRED/);
  const upload = { materialId: d.materialId, kind: 'welcome', base64: syntheticTone().toString('base64') };
  assert.deepEqual(
    await f.chars.materialUpload(f.auth, d.id, upload),
    await f.chars.materialUpload(f.auth, d.id, upload),
  );
  const wav = Buffer.from(syntheticTone());
  wav[100] = wav[100]! ^ 1;
  await assert.rejects(
    f.chars.materialUpload(f.auth, d.id, { ...upload, base64: wav.toString('base64') }),
    /IMMUTABLE/,
  );
  await assert.rejects(
    f.chars.materialApprove(f.auth, d.id, {
      materialId: d.materialId,
      acknowledgeRights: true,
      acknowledgeWelcomeListening: true,
      acknowledgeFooterListening: true,
      note: '合成',
    }),
    /MATERIALS_REQUIRED/,
  );
  await f.approve(d);
  await assert.rejects(
    f.chars.materialApprove(f.auth, d.id, {
      materialId: d.materialId,
      acknowledgeRights: false,
      acknowledgeWelcomeListening: true,
      acknowledgeFooterListening: true,
      note: '合成',
    }),
    /APPROVAL_REQUIRED/,
  );
  assert.deepEqual(publishedWebCharacters(f.store), before);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_provider_welcome_assets')!.n, 3);
  const clip = await f.chars.materialAudio(f.auth, d.id, { materialId: d.materialId, kind: 'welcome' });
  assert.equal(clip.base64, upload.base64);
  await assert.rejects(
    f.chars.materialAudio(f.auth, 'jojo', { materialId: d.materialId, kind: 'welcome' }),
    /NOT_FOUND/,
  );
  for (const table of ['web_character_materials', 'web_character_material_assets', 'web_character_material_approvals'])
    assert.throws(() => f.store.run('DELETE FROM ' + table), /IMMUTABLE/);
});

test('new role and changed voice/welcome publish atomically, preserve all original assets and survive service reconstruction', async (t) => {
  const f = fixture(t),
    oldBindings = f.store.all('SELECT * FROM web_provider_voice_bindings ORDER BY character_id'),
    oldWelcome = f.store.all('SELECT * FROM web_provider_welcome_assets ORDER BY character_id'),
    oldFooter = f.store.all('SELECT * FROM web_provider_footer_assets ORDER BY character_id'),
    money = f.store.all('SELECT * FROM web_provider_spending ORDER BY provider');
  for (const id of ['new-role', 'wei-guagua']) {
    const d = f.draft(id);
    await f.approve(d);
    const input = await f.publication(d);
    const result = f.chars.publish(f.auth, id, input);
    assert.equal(result.version, d.profile.template.version);
    assert.deepEqual(f.chars.publish(f.auth, id, input), result);
    const binding = f.store.get<{ voice_version: string; reference_id: string }>(
      'SELECT * FROM web_provider_voice_bindings WHERE character_id=?',
      id,
    )!;
    assert.equal(binding.reference_id, d.input.referenceId);
    assert.match(binding.voice_version, /^web-material-/);
    const audio = f.store.get<{ media_id: string }>(
      'SELECT media_id FROM web_provider_welcome_assets WHERE character_id=? AND voice_version=?',
      id,
      binding.voice_version,
    )!;
    assert.deepEqual(await f.offline.readWelcomeAudio(audio.media_id), syntheticTone());
    installWebCharacterCatalog(f.store);
    installWebCharacterMaterials(f.store);
  }
  assert.equal(publishedWebCharacters(f.store).length, 4);
  for (const row of oldBindings as any[])
    assert.deepEqual(
      f.store.get(
        'SELECT * FROM web_character_voice_history WHERE character_id=? AND voice_version=?',
        row.character_id,
        row.voice_version,
      ),
      row,
    );
  for (const row of oldWelcome as any[])
    assert.deepEqual(
      f.store.get(
        'SELECT * FROM web_provider_welcome_assets WHERE character_id=? AND voice_version=?',
        row.character_id,
        row.voice_version,
      ),
      row,
    );
  for (const row of oldFooter as any[])
    assert.deepEqual(
      f.store.get(
        'SELECT * FROM web_provider_footer_assets WHERE character_id=? AND voice_version=?',
        row.character_id,
        row.voice_version,
      ),
      row,
    );
  assert.deepEqual(f.store.all('SELECT * FROM web_provider_spending ORDER BY provider'), money);
  assert.equal(f.store.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(
    () => f.store.run("UPDATE web_provider_voice_bindings SET reference_id='unapproved' WHERE character_id='new-role'"),
    /VOICE_IMMUTABLE/,
  );
});

test('failure after promotion rolls back template, catalog, binding, clips, history and publication receipt together', async (t) => {
  const f = fixture(t),
    d = f.draft();
  await f.approve(d);
  const input = await f.publication(d);
  const tables = [
    'character_templates',
    'web_character_catalog',
    'web_provider_voice_bindings',
    'web_provider_welcome_assets',
    'web_provider_footer_assets',
    'web_character_voice_history',
    'web_character_publications',
    'web_character_material_promotions',
  ];
  const before = tables.map((table) => f.store.all('SELECT * FROM ' + table));
  f.store.all(
    "CREATE TRIGGER fail_publication BEFORE INSERT ON web_admin_audit WHEN NEW.action LIKE 'character-published:%' BEGIN SELECT RAISE(ABORT,'FIXTURE_FAIL'); END",
  );
  assert.throws(() => f.chars.publish(f.auth, d.id, input), /FIXTURE_FAIL/);
  assert.deepEqual(
    tables.map((table) => f.store.all('SELECT * FROM ' + table)),
    before,
  );
  assert.equal(f.chars.detail(f.auth, d.id).draft!.revision, d.saved.revision);
});

test('stale draft cannot upload, approve or consume an approved old bundle; no session invalidation on grant changes', async (t) => {
  const f = fixture(t),
    d = f.draft();
  await f.approve(d);
  const grant = f.accounts.issueMember(f.auth.cookie, f.auth.csrf, f.auth.origin, {
    requestId: 'editor',
    label: 'Editor',
    memberId: null,
    permissions: ['characters.materials:wei-guagua', 'characters.read:wei-guagua'],
  });
  const login = f.accounts.login(grant.token, f.auth.origin),
    auth = { ...f.auth, cookie: login.cookie, csrf: login.csrf };
  await assert.rejects(async () => f.chars.materialApprove(auth, d.id, {}), /PERMISSION_REQUIRED/);
  assert.throws(() => f.chars.materialPrepare(auth, 'jojo', d.input), /PERMISSION_REQUIRED/);
  f.accounts.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, []);
  assert.throws(() => f.chars.materialList(auth, d.id), /PERMISSION_REQUIRED/);
  assert.equal(f.accounts.session(auth.cookie).member.id, grant.memberId);
  d.profile.template.persona += 'changed';
  const next = f.chars.save(f.auth, d.id, { expectedRevision: d.saved.revision, profile: d.profile });
  await assert.rejects(
    f.chars.materialUpload(f.auth, d.id, {
      materialId: d.materialId,
      kind: 'welcome',
      base64: syntheticTone().toString('base64'),
    }),
    /DRAFT_CONFLICT/,
  );
  await assert.rejects(f.approve(d), /DRAFT_CONFLICT/);
  const input = await f.publication(d);
  assert.throws(
    () => f.chars.publish(f.auth, d.id, { ...input, draftRevision: next.revision, profileHash: next.contentHash }),
    /MATERIALS_REQUIRED/,
  );
});

test('invalid, silent, oversized and noncanonical uploads never reach storage', async (t) => {
  const f = fixture(t),
    d = f.draft();
  const silent = Buffer.from(syntheticTone());
  silent.fill(0, 44);
  for (const base64 of [
    'garbage',
    Buffer.from('not wav').toString('base64'),
    silent.toString('base64'),
    'A'.repeat(8_000_004),
    syntheticTone().toString('base64') + '\n',
  ]) {
    await assert.rejects(f.chars.materialUpload(f.auth, d.id, { materialId: d.materialId, kind: 'welcome', base64 }));
    assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_material_assets')!.n, 0);
  }
});

test('permission revoked during private R2 stage leaves only an unreferenced private object; exact retry recovers after regrant', async (t) => {
  const f = fixture(t),
    d = f.draft(),
    objects = new Map<string, { bytes: Uint8Array; httpMetadata: { contentType: string; cacheControl: string } }>();
  const grant = f.accounts.issueMember(f.auth.cookie, f.auth.csrf, f.auth.origin, {
    requestId: 'upload',
    label: 'Uploader',
    memberId: null,
    permissions: ['characters.materials:wei-guagua', 'characters.read:wei-guagua'],
  });
  const login = f.accounts.login(grant.token, f.auth.origin),
    auth = { ...f.auth, cookie: login.cookie, csrf: login.csrf };
  let revoke = true,
    onRead: (() => void) | undefined;
  const bucket: PrivateBucket = {
    put: async (key, bytes, options) => {
      if (objects.has(key)) return null;
      objects.set(key, { bytes: Uint8Array.from(bytes), httpMetadata: options.httpMetadata });
      if (revoke) {
        revoke = false;
        f.accounts.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, []);
      }
      return { size: bytes.length, httpMetadata: options.httpMetadata };
    },
    get: async (key) => {
      const o = objects.get(key);
      if (!o) return null;
      onRead?.();
      return {
        size: o.bytes.length,
        httpMetadata: o.httpMetadata,
        body: new ReadableStream({
          start(c) {
            c.enqueue(o.bytes);
            c.close();
          },
        }),
        arrayBuffer: async () => Uint8Array.from(o.bytes).buffer,
      };
    },
  };
  Object.assign(f.store, { providerAudio: new PrivateMediaObjects(bucket) });
  const input = { materialId: d.materialId, kind: 'welcome', base64: syntheticTone().toString('base64') };
  await assert.rejects(f.chars.materialUpload(auth, d.id, input), /PERMISSION_REQUIRED/);
  assert.equal(objects.size, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_material_assets')!.n, 0);
  assert.equal(f.accounts.session(auth.cookie).member.id, grant.memberId);
  f.accounts.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, [
    'characters.materials:wei-guagua',
    'characters.read:wei-guagua',
  ]);
  await f.chars.materialUpload(auth, d.id, input);
  assert.equal(objects.size, 1);
  assert.equal(
    (await f.chars.materialAudio(auth, d.id, { materialId: d.materialId, kind: 'welcome' })).base64,
    input.base64,
  );
  await f.chars.materialUpload(auth, d.id, { ...input, kind: 'footer' });
  f.accounts.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, [
    'characters.approve-materials:wei-guagua',
  ]);
  onRead = () => {
    onRead = undefined;
    f.accounts.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, []);
  };
  const approval = {
    materialId: d.materialId,
    acknowledgeRights: true,
    acknowledgeWelcomeListening: true,
    acknowledgeFooterListening: true,
    note: '合成',
  };
  await assert.rejects(f.chars.materialApprove(auth, d.id, approval), /PERMISSION_REQUIRED/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_material_approvals')!.n, 0);
  f.accounts.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, [
    'characters.approve-materials:wei-guagua',
  ]);
  onRead = () => {
    onRead = undefined;
    d.profile.template.persona += '草稿已变化';
    f.chars.save(f.auth, d.id, { expectedRevision: d.saved.revision, profile: d.profile });
  };
  await assert.rejects(f.chars.materialApprove(auth, d.id, approval), /DRAFT_CONFLICT/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_material_approvals')!.n, 0);
});
