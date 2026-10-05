import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/store.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { WebAccountAdmin } from '../../../apps/server/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/web-character-admin.ts';
import { installWebCharacterCatalog, publishedWebCharacters, requirePublishedWebCharacter,
  characterProfileHash, type WebCharacterProfile } from '../../../apps/server/web-character-catalog.ts';
import { WEB_PROVIDER_CATALOG } from '../../../config/web-v1.ts';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  // Isolated SQL unit fixture; native workerd coverage uses the complete schema113 below.
  store.all('CREATE TABLE web_provider_voice_bindings(character_id TEXT PRIMARY KEY,approved INTEGER,source TEXT) STRICT');
  for (const item of WEB_PROVIDER_CATALOG) {
    const template = { id: item.characterId, name: item.displayName, version: 1, fictional: true,
      persona: '合成角色，非真实材料', schedule: defaultSchedule() };
    store.run('INSERT INTO character_templates VALUES (?,1,?)', item.characterId, JSON.stringify(template));
    store.run("INSERT INTO web_provider_voice_bindings VALUES (?,1,'user_selected')", item.characterId);
  }
  const clock = { now: () => 1_800_000_000_000 }, origin = 'https://fixture.invalid';
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebCharacterCatalog(store);
  const service = new WebCharacterAdmin(store, clock, accounts);
  const grant = accounts.issueLoginGrant(), owner = accounts.login(grant.token, origin);
  const auth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const draft = (id = 'wei-guagua') => {
    const profile = service.detail(auth, id).published!.profile;
    profile.template.version++; return profile;
  };
  return { store, accounts, service, auth, draft, clock, origin };
}

test('approved seed import is additive, byte-preserving, idempotent and detects schema or publication drift', t => {
  const f = fixture(t), before = f.store.all('SELECT * FROM character_templates');
  installWebCharacterCatalog(f.store); assert.deepEqual(f.store.all('SELECT * FROM character_templates'), before);
  assert.equal(publishedWebCharacters(f.store).length, 3);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_versions')!.n, 3);
  assert.equal(f.store.get<{ created_at: number | null }>('SELECT created_at FROM web_character_versions')!.created_at, null);
  assert.throws(() => f.store.run("UPDATE web_character_versions SET content_hash='x'"), /HISTORY_IMMUTABLE/);
  f.store.run('UPDATE character_templates SET version=version+1 WHERE id=?', 'jojo');
  assert.throws(() => installWebCharacterCatalog(f.store), /CATALOG_INVALID/);
});

test('save, preview and discard preserve published state; strict stale revisions and immutable history', t => {
  const f = fixture(t), before = publishedWebCharacters(f.store), profile = f.draft();
  profile.presentation.displayName = '<script>not executable</script>';
  const first = f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile });
  assert.equal(first.revision, 1);
  assert.deepEqual(f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile }), first);
  profile.template.persona += ' 已修改';
  assert.throws(() => f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile }), /DRAFT_CONFLICT/);
  const second = f.service.save(f.auth, 'wei-guagua', { expectedRevision: 1, profile });
  assert.equal(second.revision, 2);
  assert.throws(() => f.service.preview(f.auth, 'wei-guagua', 1), /DRAFT_CONFLICT/);
  const preview = f.service.preview(f.auth, 'wei-guagua', 2);
  assert.equal(preview.kind, 'profile-preview'); assert.equal(preview.externalCalls, false);
  assert.equal(preview.publishAvailable, false); assert.deepEqual(preview.changedSections, ['template','presentation']);
  assert.deepEqual(publishedWebCharacters(f.store), before);
  assert.throws(() => f.service.discard(f.auth, 'wei-guagua', 1), /DRAFT_CONFLICT/);
  f.service.discard(f.auth, 'wei-guagua', 2);
  assert.equal(f.service.detail(f.auth, 'wei-guagua').draft, null);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_revisions')!.n, 2);
  assert.throws(() => f.store.run('DELETE FROM web_character_revisions'), /HISTORY_IMMUTABLE/);
});

test('explicit character scopes, immediate revocation and create capability do not invalidate any login', t => {
  const f = fixture(t), grant = f.accounts.issueMember(f.auth.cookie, f.auth.csrf, f.origin, {
    requestId: 'issue', label: 'Editor', memberId: null, permissions: ['characters.read:wei-guagua', 'characters.edit:wei-guagua'] });
  const member = f.accounts.login(grant.token, f.origin), auth = { cookie: member.cookie, csrf: member.csrf, origin: f.origin };
  assert.deepEqual(f.service.list(auth).characters.map(c => c.characterId), ['wei-guagua']);
  assert.throws(() => f.service.detail(auth, 'jojo'), /PERMISSION_REQUIRED/);
  assert.throws(() => f.service.detail(auth, 'absent'), /PERMISSION_REQUIRED/);
  const saved = f.service.save(auth, 'wei-guagua', { expectedRevision: null, profile: f.draft() });
  assert.throws(() => f.service.discard(auth, 'wei-guagua', saved.revision), /PERMISSION_REQUIRED/);
  f.accounts.setPermissions(f.auth.cookie, f.auth.csrf, f.origin, member.member.id, []);
  assert.equal(f.accounts.session(member.cookie).member.id, member.member.id);
  assert.throws(() => f.service.detail(auth, 'wei-guagua'), /PERMISSION_REQUIRED/);
  assert.throws(() => f.service.save({ ...f.auth, origin: 'https://evil.invalid' }, 'jojo', {}), /UNAUTHORIZED/);
});

test('a newly created draft cannot join the player catalog; wildcard read is explicit and future permissions fail closed', t => {
  const f = fixture(t), profile = f.draft(); profile.template.id = 'new-character'; profile.template.version = 1;
  const first = f.service.save(f.auth, 'new-character', { expectedRevision: null, profile });
  assert.equal(first.baseVersion, null); assert.equal(f.service.list(f.auth).characters.length, 4);
  assert.equal(publishedWebCharacters(f.store).length, 3);
  assert.throws(() => requirePublishedWebCharacter(f.store, 'new-character'), /UNAVAILABLE/);
  const grant = f.accounts.issueMember(f.auth.cookie, f.auth.csrf, f.origin, {
    requestId: 'all-reader', label: 'Reader', memberId: null, permissions: ['characters.read:*', 'characters.edit:*'] });
  const session = f.accounts.login(grant.token, f.origin), auth = { cookie: session.cookie, csrf: session.csrf, origin: f.origin };
  assert.equal(f.service.list(auth).characters.length, 4);
  const other = structuredClone(profile); other.template.id = 'other-character';
  assert.throws(() => f.service.save(auth, other.template.id, { expectedRevision: null, profile: other }), /PERMISSION_REQUIRED/);
  assert.throws(() => f.accounts.setPermissions(f.auth.cookie, f.auth.csrf, f.origin, session.member.id, ['characters.unsupported:*']), /INVALID_REQUEST/);
});

test('durable catalog is not a seed allowlist, and empty catalog never silently resurrects seed roles', t => {
  const f = fixture(t), entry = publishedWebCharacters(f.store)[0]!;
  const profile: WebCharacterProfile = { template: { ...entry.template, id: 'fourth', version: 1 }, presentation: entry.presentation };
  f.store.run('INSERT INTO character_templates VALUES (?,1,?)', 'fourth', JSON.stringify(profile.template));
  f.store.run('INSERT INTO web_character_versions VALUES (?,1,?,?,NULL)', 'fourth', JSON.stringify(profile), characterProfileHash(profile));
  f.store.run('INSERT INTO web_character_catalog VALUES (?,1,3)', 'fourth');
  assert.equal(publishedWebCharacters(f.store).length, 4);
  assert.throws(() => requirePublishedWebCharacter(f.store, 'fourth'), /UNAVAILABLE/);
  f.store.run("INSERT INTO web_provider_voice_bindings VALUES (?,1,'user_selected')", 'fourth');
  requirePublishedWebCharacter(f.store, 'fourth');
  installWebCharacterCatalog(f.store); assert.equal(publishedWebCharacters(f.store).length, 4);
  f.store.run('DELETE FROM web_character_catalog'); installWebCharacterCatalog(f.store);
  assert.deepEqual(publishedWebCharacters(f.store), []);
});


test('deletion history is discoverable after catalog removal; permission filtering precedes the recent-job limit', t => {
  const f=fixture(t);
  // Metadata-only table/double: actual durable deletion is separately exercised through native workerd/R2.
  f.store.all('CREATE TABLE web_character_deletions(id TEXT PRIMARY KEY,character_id TEXT,state TEXT,created_at INTEGER)');
  for(let i=0;i<105;i++)f.store.run('INSERT INTO web_character_deletions VALUES (?,?,?,?)',`job-${i}`,`removed-${i}`,'deleted',i);
  f.service.enableDeletion({status:(id:string)=>({characterId:id,state:'deleted'})} as never);
  const grant=f.accounts.issueMember(f.auth.cookie,f.auth.csrf,f.origin,{requestId:'old-deleted-reader',label:'Scoped reader',memberId:null,permissions:['characters.read:removed-0']});
  const session=f.accounts.login(grant.token,f.origin),auth={cookie:session.cookie,csrf:session.csrf,origin:f.origin};
  assert.deepEqual(f.service.list(auth).characters,[]);
  assert.deepEqual(f.service.list(auth).deletions,[{characterId:'removed-0',state:'deleted'}]);
  assert.equal(f.service.list(f.auth).deletions.length,100);
  f.accounts.setPermissions(f.auth.cookie,f.auth.csrf,f.origin,session.member.id,[]);
  assert.deepEqual(f.service.list(auth).deletions,[]);assert.equal(f.accounts.session(session.cookie).member.id,session.member.id);
});

test('four-category credentials preallocate only their web capabilities; removal preserves the administrator session', t => {
  const f=fixture(t),grant=f.accounts.issueMember(f.auth.cookie,f.auth.csrf,f.origin,{requestId:'category-member',label:'本机验收账号',memberId:null,permissions:['category.characters']});
  const member=f.accounts.login(grant.token,f.origin),auth={cookie:member.cookie,csrf:member.csrf,origin:f.origin};
  assert.deepEqual(member.member.permissions,['category.characters']);assert.equal(f.service.list(auth).characters.length,3);
  const p=f.draft();p.template.id='category-created';p.template.version=1;
  const saved=f.service.save(auth,p.template.id,{expectedRevision:null,profile:p});assert.equal(saved.revision,1);f.service.discard(auth,p.template.id,1);
  assert.throws(()=>f.service.startPreview(auth,'wei-guagua',{}),/PERMISSION_REQUIRED/);
  f.accounts.setPermissions(f.auth.cookie,f.auth.csrf,f.origin,member.member.id,['category.publication']);
  assert.equal(f.service.list(auth).characters.length,3);assert.throws(()=>f.service.save(auth,'jojo',{expectedRevision:null,profile:f.draft('jojo')}),/PERMISSION_REQUIRED/);
  f.accounts.setPermissions(f.auth.cookie,f.auth.csrf,f.origin,member.member.id,[]);
  assert.deepEqual(f.service.list(auth).characters,[]);assert.equal(f.accounts.session(member.cookie).member.id,member.member.id);
});
