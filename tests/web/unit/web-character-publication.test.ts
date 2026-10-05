import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/store.ts';
import { WebAccountAdmin } from '../../../apps/server/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/web-character-admin.ts';
import { installWebCharacterCatalog, publishedWebCharacters } from '../../../apps/server/web-character-catalog.ts';
import { WEB_PROVIDER_CATALOG, WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { syntheticCharacterReview } from '../fixtures/character-review.ts';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  // Metadata-only unit doubles; HTTP tests below cover complete native workerd schema/R2.
  store.all(`CREATE TABLE web_provider_voice_bindings(character_id TEXT PRIMARY KEY,voice_version TEXT,
    profile_id TEXT,voice_revision INTEGER,approved INTEGER,source TEXT) STRICT`);
  store.all(`CREATE TABLE web_provider_welcome_assets(character_id TEXT,voice_version TEXT,body TEXT,text_version TEXT,origin TEXT) STRICT`);
  store.all(`CREATE TABLE web_provider_footer_assets(character_id TEXT,voice_version TEXT,origin TEXT) STRICT`);
  store.all(`CREATE TABLE web_operations(character_id TEXT,status TEXT) STRICT`);
  const now = 1_800_000_000_000, clock = { now: () => now }, origin = 'https://fixture.invalid';
  const admin = new WebAccountAdmin(store, clock, origin);
  for (const item of WEB_PROVIDER_CATALOG) {
    const id = item.characterId, template = { id, name: item.displayName, version: 1, fictional: true,
      persona: '隔离合成角色', schedule: defaultSchedule(), voice: { profileId: id, version: 1, speed: 1 } };
    store.run('INSERT INTO character_templates VALUES (?,1,?)', id, JSON.stringify(template));
    store.run("INSERT INTO web_provider_voice_bindings VALUES (?,'voice-v1',?,1,1,'user_selected')", id, id);
    store.run("INSERT INTO web_provider_welcome_assets VALUES (?,'voice-v1',?,?,'operator_approved')", id,
      WEB_PROVIDER_WELCOME[id].text, WEB_PROVIDER_WELCOME[id].version);
    store.run("INSERT INTO web_provider_footer_assets VALUES (?,'voice-v1','operator_approved')", id);
  }
  installWebCharacterCatalog(store);
  const service = new WebCharacterAdmin(store, clock, admin), login = admin.login(admin.issueLoginGrant().token, origin);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin };
  const profile = service.detail(auth, 'wei-guagua').published!.profile;
  profile.template.version++; profile.template.persona += '新的资料'; profile.presentation.displayName = '新的显示名';
  const saved = service.save(auth, 'wei-guagua', { expectedRevision: null, profile });
  const input = async () => ({ requestId: 'publish-1', draftRevision: saved.revision, profileHash: saved.contentHash,
    previewId: await syntheticCharacterReview(store, now, 'wei-guagua'), acknowledgeReview: true });
  return { store, service, admin, auth, profile, saved, input, now };
}

test('atomic publication preserves immutable history and exact retries; later drafts cannot be consumed by replay', async t => {
  const f = fixture(t), before = publishedWebCharacters(f.store), input = await f.input();
  const result = f.service.publish(f.auth, 'wei-guagua', input);
  assert.equal(result.version, 2); assert.equal(result.profileHash, f.saved.contentHash);
  assert.equal(f.service.detail(f.auth, 'wei-guagua').draft, null);
  assert.throws(() => f.service.publish(f.auth, 'wei-guagua', { ...input, requestId: 'not-a-retry' }), /DRAFT_CONFLICT/);
  assert.deepEqual(f.service.detail(f.auth, 'wei-guagua').published!.profile, f.profile);
  assert.deepEqual(publishedWebCharacters(f.store).filter(c => c.characterId !== 'wei-guagua'), before.filter(c => c.characterId !== 'wei-guagua'));
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_versions')!.n, 4);
  const next = structuredClone(f.profile); next.template.version++;
  const saved = f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile: next });
  assert.deepEqual(f.service.publish(f.auth, 'wei-guagua', input), result);
  assert.equal(f.service.detail(f.auth, 'wei-guagua').draft!.revision, saved.revision);
  assert.throws(() => f.service.publish(f.auth, 'wei-guagua', { ...input, profileHash: '0'.repeat(64) }), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => f.store.run('DELETE FROM web_character_publications'), /HISTORY_IMMUTABLE/);
  assert.throws(() => f.store.run('UPDATE web_character_versions SET version=20'), /HISTORY_IMMUTABLE/);
  installWebCharacterCatalog(f.store);
  assert.deepEqual(f.service.publish(f.auth, 'wei-guagua', input), result);
});

test('real review, current policy, exact template/profile, acknowledgement and finished state are mandatory', async t => {
  const f = fixture(t), input = await f.input(), before = publishedWebCharacters(f.store);
  const bad = (change: object, expected: RegExp) => assert.throws(() => f.service.publish(f.auth, 'wei-guagua', { ...input, ...change }), expected);
  bad({ acknowledgeReview: false }, /ACKNOWLEDGEMENT/); bad({ draftRevision: 2 }, /DRAFT_CONFLICT/);
  bad({ profileHash: '0'.repeat(64) }, /DRAFT_CONFLICT/); bad({ previewId: 'missing' }, /VALID_PREVIEW/);
  for (const [column, value] of [['evidence_kind','fixture'], ['status','generating'], ['prompt_hash','wrong'],
    ['content_hash','wrong'], ['error_code','PREVIEW_INTERRUPTED'], ['result_json','{}'], ['finished_at',f.now + 1]] as const) {
    const previous = f.store.get<Record<string, string | number | null>>(`SELECT ${column} FROM admin_previews WHERE id=?`, input.previewId)![column]!;
    f.store.run(`UPDATE admin_previews SET ${column}=? WHERE id=?`, value, input.previewId);
    bad({}, /VALID_PREVIEW/);
    f.store.run(`UPDATE admin_previews SET ${column}=? WHERE id=?`, previous, input.previewId);
  }
  assert.deepEqual(publishedWebCharacters(f.store), before);
  assert.equal(f.service.detail(f.auth, 'wei-guagua').draft!.revision, f.saved.revision);
  const stored = f.store.get<{ result_json: string }>('SELECT result_json FROM admin_previews WHERE id=?', input.previewId)!.result_json;
  for (const change of [{ stages: [] }, { reply: {} },
    { stages: JSON.parse(stored).stages.map((stage: object) => ({ ...stage, usage: undefined })) }]) {
    f.store.run('UPDATE admin_previews SET result_json=? WHERE id=?', JSON.stringify({ ...JSON.parse(stored), ...change }), input.previewId);
    bad({}, /VALID_PREVIEW/);
  }
});

test('active and unknown operations fence publication without cancelling, settling or changing their state', async t => {
  const f = fixture(t), input = await f.input();
  for (const status of ['queued','text_running','text_ready','audio_pending','audio_running','ready_to_publish','retryable_failed','unknown']) {
    f.store.run('INSERT INTO web_operations VALUES (?,?)', 'wei-guagua', status);
    assert.throws(() => f.service.publish(f.auth, 'wei-guagua', input), /CHARACTER_PUBLICATION_BUSY/);
    assert.equal(f.store.get<{ status: string }>('SELECT status FROM web_operations')!.status, status);
    assert.equal(f.service.detail(f.auth, 'wei-guagua').published!.version, 1);
    f.store.run('DELETE FROM web_operations');
  }
  f.store.run("INSERT INTO web_operations VALUES ('jojo','unknown')");
  for (const status of ['published','failed','cancelled']) f.store.run('INSERT INTO web_operations VALUES (?,?)', 'wei-guagua', status);
  assert.equal(f.service.publish(f.auth, 'wei-guagua', input).version, 2);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n, 4);
});

test('publication requires separate current role-scoped authority and revocation leaves sessions usable', async t => {
  const f = fixture(t), input = await f.input();
  const grant = f.admin.issueMember(f.auth.cookie, f.auth.csrf, f.auth.origin, { requestId: 'publisher', label: 'Publisher', memberId: null,
    permissions: ['characters.read:wei-guagua', 'characters.edit:wei-guagua'] });
  const login = f.admin.login(grant.token, f.auth.origin), auth = { cookie: login.cookie, csrf: login.csrf, origin: f.auth.origin };
  assert.throws(() => f.service.publish(auth, 'wei-guagua', input), /PERMISSION_REQUIRED/);
  f.admin.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, ['characters.publish:wei-guagua']);
  assert.throws(() => f.service.publish(auth, 'jojo', input), /PERMISSION_REQUIRED/);
  assert.equal(f.service.publish(auth, 'wei-guagua', input).version, 2);
  f.admin.setPermissions(f.auth.cookie, f.auth.csrf, f.auth.origin, grant.memberId, []);
  assert.throws(() => f.service.publish(auth, 'wei-guagua', input), /PERMISSION_REQUIRED/);
  assert.equal(f.admin.session(auth.cookie).member.id, grant.memberId);
});

test('unapproved voice changes and unmatched welcome clips cannot publish; transaction failure rolls back every pointer', async t => {
  const f = fixture(t), input = await f.input(), before = publishedWebCharacters(f.store);
  f.store.run("DELETE FROM web_provider_welcome_assets WHERE character_id='wei-guagua'");
  assert.throws(() => f.service.publish(f.auth, 'wei-guagua', input), /CHARACTER_MATERIALS_REQUIRED/);
  f.store.run("INSERT INTO web_provider_welcome_assets VALUES ('wei-guagua','voice-v1',?,?,'operator_approved')",
    f.profile.presentation.welcome.text, f.profile.presentation.welcome.version);
  f.store.all("CREATE TRIGGER fixture_fail BEFORE INSERT ON web_admin_audit WHEN NEW.action LIKE 'character-published:%' BEGIN SELECT RAISE(ABORT,'FIXTURE_DISK_FAIL'); END");
  assert.throws(() => f.service.publish(f.auth, 'wei-guagua', input), /FIXTURE_DISK_FAIL/);
  assert.deepEqual(publishedWebCharacters(f.store), before);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_publications')!.n, 0);
  assert.equal(f.service.detail(f.auth, 'wei-guagua').draft!.contentHash, f.saved.contentHash);
  f.store.all('DROP TRIGGER fixture_fail');
  const changed = structuredClone(f.profile); changed.template.voice!.speed = 1.1;
  const saved = f.service.save(f.auth, 'wei-guagua', { expectedRevision: 1, profile: changed });
  const previewId = await syntheticCharacterReview(f.store, f.now, 'wei-guagua');
  assert.throws(() => f.service.publish(f.auth, 'wei-guagua', { ...input, previewId, draftRevision: saved.revision, profileHash: saved.contentHash }),
    /CHARACTER_MATERIALS_REQUIRED/);
});

test('catalog v1 upgrades additively and unknown schema hashes fail without overwriting history', t => {
  const f = fixture(t), before = f.store.all('SELECT * FROM web_character_versions');
  const v1 = f.store.get<{ sha256: string }>('SELECT sha256 FROM web_character_schema WHERE version=1')!.sha256;
  f.store.all('DROP TABLE web_character_publications'); f.store.run('DELETE FROM web_character_schema WHERE version=2');
  installWebCharacterCatalog(f.store);
  assert.deepEqual(f.store.all('SELECT * FROM web_character_versions'), before);
  assert.equal(f.store.get<{ sha256: string }>('SELECT sha256 FROM web_character_schema WHERE version=1')!.sha256, v1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_schema')!.n, 2);
  f.store.run("UPDATE web_character_schema SET sha256='changed' WHERE version=2");
  assert.throws(() => installWebCharacterCatalog(f.store), /SCHEMA_MISMATCH/);
  assert.deepEqual(f.store.all('SELECT * FROM web_character_versions'), before);
});

test('new draft publication fails closed until approved material intake exists, without allocating a catalog slot', async t => {
  const f = fixture(t), profile = structuredClone(f.profile);
  profile.template.id = 'new-character'; profile.template.version = 1;
  const saved = f.service.save(f.auth, profile.template.id, { expectedRevision: null, profile });
  const previewId = await syntheticCharacterReview(f.store, f.now, profile.template.id);
  assert.throws(() => f.service.publish(f.auth, profile.template.id, { requestId: 'new-character-publication',
    draftRevision: saved.revision, profileHash: saved.contentHash, previewId, acknowledgeReview: true }), /CHARACTER_MATERIALS_REQUIRED/);
  assert.equal(publishedWebCharacters(f.store).length, 3);
  assert.equal(f.service.detail(f.auth, profile.template.id).published, null);
  assert.equal(f.service.detail(f.auth, profile.template.id).draft!.contentHash, saved.contentHash);
});
