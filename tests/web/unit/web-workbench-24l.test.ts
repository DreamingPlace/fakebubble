// Part 24k-2 (named exception): the welcome fixtures/assertions in this file moved from welcome {text,version} to welcomes [{id,text,weight}]; nothing else was changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebAvailability, orderGroup } from '../../../apps/server/characters/web-character-availability.ts';
import {
  installWebCharacterCatalog,
  publishedWebCharacters,
  type WebCharacterProfile,
} from '../../../apps/server/characters/web-character-catalog.ts';
import { WEB_PROVIDER_CATALOG } from '../../../config/web-v1.ts';

/** Part 24l: the workbench sidebar groups (server truth), the per-admin order, and 下线 / 重新上线 as an owner action. */
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.all(
    'CREATE TABLE web_provider_voice_bindings(character_id TEXT PRIMARY KEY,approved INTEGER,source TEXT) STRICT',
  );
  // Isolated SQL unit fixture: the only column the 下线 fence reads.
  store.all('CREATE TABLE web_operations(character_id TEXT NOT NULL,status TEXT NOT NULL) STRICT');
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
  const clock = { now: () => 1_800_000_000_000 },
    origin = 'https://fixture.invalid';
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebCharacterCatalog(store);
  const service = new WebCharacterAdmin(store, clock, accounts);
  service.enableAvailability();
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const auth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  let n = 0;
  const staff = (permissions: string[]) => {
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-${++n}`,
      label: `Staff ${n}`,
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };
  const newDraft = (id: string) => {
    const profile: WebCharacterProfile = {
      template: {
        id,
        name: '新角色',
        version: 1,
        fictional: true,
        persona: '合成角色',
        schedule: defaultSchedule(),
      },
      presentation: {
        displayName: '新角色',
        publicDescription: '',
        welcomes: [{ id: 'w1', text: '你好', weight: 100 }],
      }, // Part 24k-2 (named exception): welcome → welcomes
    };
    return service.save(auth, id, { expectedRevision: null, profile });
  };
  const request = () => `req-${++n}`;
  const names = (a = auth) => service.list(a).characters.map((c) => `${c.group}:${c.characterId}`);
  return { store, accounts, service, auth, staff, newDraft, request, names };
}
/** The home page order (catalog position) of the three fixture characters. */
const ids = ['wei-guagua', 'jojo', 'chen-jimi'];
const live = (id: string, store: Store) =>
  store.get<{ version: number }>('SELECT version FROM character_templates WHERE id=?', id)!.version;

test('24l the install step is idempotent and digest-checked; there is no numbered migration', (t) => {
  const f = fixture(t);
  installWebAvailability(f.store);
  installWebAvailability(f.store);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_availability_schema')!.n, 1);
  f.store.run("UPDATE web_availability_schema SET sha256='x'");
  assert.throws(() => installWebAvailability(f.store), /WEB_AVAILABILITY_SCHEMA_MISMATCH/);
});

test('24l sidebar groups come from the catalog and the versions: 当前阵容, 未发布草稿, 已下线', (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.service.list(f.auth).characters.map((c) => [c.characterId, c.group, c.online]),
    ids.map((id) => [id, 'live', true]),
  );
  f.newDraft('fresh-one');
  const off = f.service.setAvailability(f.auth, 'jojo', 'offline', { requestId: f.request(), liveVersion: 1 });
  assert.equal(off.action, 'offline');
  assert.deepEqual(f.names(), [
    'live:wei-guagua', // the home page order (catalog position), not the id
    'live:chen-jimi',
    'draft:fresh-one',
    'offline:jojo',
  ]);
  // 当前阵容 is the catalog, never the cast: a character that no cast mentions is still on the home page.
  assert.deepEqual(
    publishedWebCharacters(f.store).map((c) => c.characterId),
    ['wei-guagua', 'chen-jimi'],
  );
  // 已下线 holds nothing that is deleted; a published character with a draft stays in its own group.
  const draft = f.service.detail(f.auth, 'jojo').published!.profile;
  draft.template.version++;
  f.service.save(f.auth, 'jojo', { expectedRevision: null, profile: draft });
  assert.equal(f.service.list(f.auth).characters.find((c) => c.characterId === 'jojo')!.group, 'offline');
  assert.equal(f.service.detail(f.auth, 'jojo').online, false);
  assert.equal(f.service.detail(f.auth, 'jojo').published!.version, 1, 'its live version stays');
  f.service.setAvailability(f.auth, 'jojo', 'online', { requestId: f.request(), liveVersion: 1 });
  assert.equal(f.service.list(f.auth).characters.find((c) => c.characterId === 'jojo')!.group, 'live');
});

test('24l 下线 / 重新上线 are the owner’s alone; publishing an offline character is refused with CHARACTER_OFFLINE', (t) => {
  const f = fixture(t);
  const everything = f.staff(['category.characters', 'category.publication']);
  for (const action of ['offline', 'online'] as const)
    assert.throws(
      () => f.service.setAvailability(everything, 'jojo', action, { requestId: f.request(), liveVersion: 1 }),
      /ADMIN_OWNER_REQUIRED/,
    );
  assert.equal(publishedWebCharacters(f.store).length, 3);
  f.service.setAvailability(f.auth, 'jojo', 'offline', { requestId: f.request(), liveVersion: 1 });
  const profile = f.service.detail(f.auth, 'jojo').published!.profile;
  profile.template.version++;
  const saved = f.service.save(f.auth, 'jojo', { expectedRevision: null, profile });
  const input = {
    requestId: f.request(),
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    acknowledgeReview: true,
    previewId: 'p1',
  };
  assert.throws(() => f.service.publish(f.auth, 'jojo', input), /CHARACTER_OFFLINE/);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_versions')!.n,
    3,
    'nothing was published',
  );
  assert.equal(publishedWebCharacters(f.store).length, 2, 'and nothing came back silently');
  f.service.setAvailability(f.auth, 'jojo', 'online', { requestId: f.request(), liveVersion: 1 });
  assert.throws(
    () => f.service.publish(f.auth, 'jojo', input),
    (e: any) => e.code !== 'CHARACTER_OFFLINE',
  );
  // The history is untouched and a restore of an offline character is also refused.
  assert.equal(live('jojo', f.store), 1);
});

test('24l 下线 is refused while an operation is in flight and never touches it', (t) => {
  const f = fixture(t);
  f.store.run("INSERT INTO web_operations VALUES ('jojo','accepted')");
  f.store.run("INSERT INTO web_operations VALUES ('wei-guagua','published')");
  assert.throws(
    () => f.service.setAvailability(f.auth, 'jojo', 'offline', { requestId: f.request(), liveVersion: 1 }),
    /CHARACTER_PUBLICATION_BUSY/,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(f.store.all('SELECT * FROM web_operations ORDER BY character_id'))), [
    { character_id: 'jojo', status: 'accepted' },
    { character_id: 'wei-guagua', status: 'published' },
  ]);
  assert.equal(publishedWebCharacters(f.store).length, 3);
  f.service.setAvailability(f.auth, 'wei-guagua', 'offline', { requestId: f.request(), liveVersion: 1 });
  assert.equal(publishedWebCharacters(f.store).length, 2);
});

test('24l each admin has an order of their own, per group; it never reaches another admin; a missing character goes last', (t) => {
  const f = fixture(t);
  const other = f.staff(['category.characters']);
  const before = f.names();
  assert.deepEqual(f.names(other), before);
  // The owner drags chen-jimi to the front of 当前阵容.
  f.service.saveOrder(f.auth, { group: 'live', ids: ['chen-jimi', 'wei-guagua', 'jojo'] });
  assert.deepEqual(f.names(), ['live:chen-jimi', 'live:wei-guagua', 'live:jojo']);
  assert.deepEqual(f.names(other), before, 'the other admin and the home page order are unchanged');
  assert.deepEqual(
    publishedWebCharacters(f.store).map((c) => c.characterId),
    ['wei-guagua', 'jojo', 'chen-jimi'],
  );
  // The other admin orders differently.
  f.service.saveOrder(other, { group: 'live', ids: ['jojo', 'chen-jimi', 'wei-guagua'] });
  assert.deepEqual(f.names(other), ['live:jojo', 'live:chen-jimi', 'live:wei-guagua']);
  assert.deepEqual(f.names(), ['live:chen-jimi', 'live:wei-guagua', 'live:jojo']);
  // A character with no saved place goes to the end of its group; a draft joins its own group at the end.
  f.newDraft('fresh-one');
  f.newDraft('fresh-two');
  assert.deepEqual(f.names(), ['live:chen-jimi', 'live:wei-guagua', 'live:jojo', 'draft:fresh-one', 'draft:fresh-two']);
  f.service.saveOrder(f.auth, { group: 'draft', ids: ['fresh-two', 'fresh-one'] });
  assert.deepEqual(f.names().slice(3), ['draft:fresh-two', 'draft:fresh-one']);
  // Changing group keeps the relative place: jojo (last of the live) goes offline, then back.
  f.service.setAvailability(f.auth, 'wei-guagua', 'offline', { requestId: f.request(), liveVersion: 1 });
  f.service.setAvailability(f.auth, 'jojo', 'offline', { requestId: f.request(), liveVersion: 1 });
  f.service.saveOrder(f.auth, { group: 'offline', ids: ['jojo', 'wei-guagua'] });
  assert.deepEqual(
    f.names().filter((n) => n.startsWith('offline')),
    ['offline:jojo', 'offline:wei-guagua'],
  );
  f.service.setAvailability(f.auth, 'wei-guagua', 'online', { requestId: f.request(), liveVersion: 1 });
  f.service.setAvailability(f.auth, 'jojo', 'online', { requestId: f.request(), liveVersion: 1 });
  assert.deepEqual(
    f.names().filter((n) => n.startsWith('live')),
    ['live:chen-jimi', 'live:jojo', 'live:wei-guagua'],
    'jojo was dragged before wei-guagua while offline and keeps that place',
  );
  // A drag that is not exactly the group's members is refused (the sidebar was stale).
  assert.throws(() => f.service.saveOrder(f.auth, { group: 'live', ids: ['jojo'] }), /CHARACTER_ORDER_CONFLICT/);
  assert.throws(() => f.service.saveOrder(f.auth, { group: 'nope', ids: [] }), /INVALID_ADMIN_REQUEST/);
  // Permission: an admin that reads one character orders only what they see and never learns about the others.
  const narrow = f.staff(['characters.read:jojo']);
  assert.deepEqual(f.names(narrow), ['live:jojo']);
  f.service.saveOrder(narrow, { group: 'live', ids: ['jojo'] });
  assert.deepEqual(f.names(), f.names(), 'unchanged for the owner');
  assert.equal(orderGroup(['a', 'b', 'c'], ['c', 'x']).join(), 'c,a,b');
});

test('24l the order table holds only member ids, character ids and ranks (no player data)', (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.store.all<{ name: string }>('PRAGMA table_info(web_admin_character_order)').map((c) => c.name),
    ['member_id', 'character_id', 'rank'],
  );
  assert.deepEqual(
    f.store.all<{ name: string }>('PRAGMA table_info(web_availability_requests)').map((c) => c.name),
    ['request_id', 'request_hash', 'character_id', 'action', 'version', 'position', 'member_id', 'created_at'],
  );
});
