import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import {
  installWebCharacterCatalog,
  publishedWebCharacters,
  type WebCharacterProfile,
} from '../../../apps/server/characters/web-character-catalog.ts';
import { WEB_PROVIDER_CATALOG, WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { syntheticCharacterReview } from '../fixtures/character-review.ts';

function fixture(t: test.TestContext, edit: (profile: WebCharacterProfile) => void) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  // Metadata-only unit doubles; HTTP tests below cover complete native workerd schema/R2.
  store.all(`CREATE TABLE web_provider_voice_bindings(character_id TEXT PRIMARY KEY,voice_version TEXT,
    profile_id TEXT,voice_revision INTEGER,approved INTEGER,source TEXT) STRICT`);
  store.all(
    `CREATE TABLE web_provider_welcome_assets(character_id TEXT,voice_version TEXT,body TEXT,text_version TEXT,origin TEXT) STRICT`,
  );
  store.all(`CREATE TABLE web_provider_footer_assets(character_id TEXT,voice_version TEXT,origin TEXT) STRICT`);
  store.all(`CREATE TABLE web_operations(character_id TEXT,status TEXT) STRICT`);
  const now = 1_800_000_000_000,
    clock = { now: () => now },
    origin = 'https://fixture.invalid';
  const admin = new WebAccountAdmin(store, clock, origin);
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
    login = admin.login(admin.issueLoginGrant().token, origin);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin };
  const profile = service.detail(auth, 'wei-guagua').published!.profile;
  profile.template.version++;
  profile.template.persona += '新的资料';
  profile.presentation.displayName = '新的显示名';
  edit(profile);
  const saved = service.save(auth, 'wei-guagua', { expectedRevision: null, profile });
  const input = async () => ({
    requestId: 'publish-1',
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    previewId: await syntheticCharacterReview(store, now, 'wei-guagua'),
    acknowledgeReview: true,
  });
  return { store, service, admin, auth, profile, saved, input, now };
}

const DIRECTION = '语速舒缓，句尾常拖长。';

test('a voice direction is versioned and published with the profile, and needs no new clips', async (t) => {
  const f = fixture(t, (profile) => {
    profile.template.voice!.direction = DIRECTION;
  });
  assert.equal(f.saved.contentHash.length, 64);
  assert.equal(f.service.detail(f.auth, 'wei-guagua').draft!.profile.template.voice!.direction, DIRECTION);
  const result = f.service.publish(f.auth, 'wei-guagua', await f.input());
  assert.equal(result.version, 2);
  const published = f.service.detail(f.auth, 'wei-guagua').published!;
  assert.equal(published.profile.template.voice!.direction, DIRECTION);
  assert.equal(
    JSON.parse(
      f.store.get<{ config_json: string }>("SELECT config_json FROM character_templates WHERE id='wei-guagua'")!
        .config_json,
    ).voice.direction,
    DIRECTION,
  );
  // The next draft changes only the direction: still no materials, a new version, the old version keeps its own text.
  const next = structuredClone(published.profile);
  next.template.version++;
  next.template.voice!.direction = '语速很慢。';
  const saved = f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile: next });
  const second = f.service.publish(f.auth, 'wei-guagua', {
    requestId: 'publish-2',
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    previewId: await syntheticCharacterReview(f.store, f.now, 'wei-guagua'),
    acknowledgeReview: true,
  });
  assert.equal(second.version, 3);
  const versions = f.store.all<{ version: number; config_json: string }>(
    "SELECT version,config_json FROM character_template_versions WHERE character_id='wei-guagua' ORDER BY version",
  );
  assert.deepEqual(
    versions.map((v) => JSON.parse(v.config_json).voice?.direction),
    [DIRECTION, '语速很慢。'],
    'every version keeps the direction it was published with',
  );
});

test('an invalid direction cannot be saved as a draft', (t) => {
  const f = fixture(t, () => {});
  for (const bad of ['', '[x]', '<x>', 'a\nb', '好'.repeat(41)]) {
    const next = structuredClone(f.profile);
    next.template.voice!.direction = bad;
    assert.throws(
      () => f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile: next }),
      /INVALID_VOICE_BINDING/,
      bad,
    );
  }
  const ok = structuredClone(f.profile);
  ok.template.voice!.direction = '好'.repeat(40);
  assert.doesNotThrow(() => f.service.save(f.auth, 'wei-guagua', { expectedRevision: f.saved.revision, profile: ok }));
});
