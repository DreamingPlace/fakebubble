import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { isReadOnlyAdminPost } from '../../../apps/server/cloudflare/web-admin-read.ts';
import { WEB_PROVIDER_CATALOG } from '../../../config/web-v1.ts';

/** Part 24b-7: 草稿记录 (the revisions of the current draft line, each with the mark of the admin who saved it). */
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.all(
    'CREATE TABLE web_provider_voice_bindings(character_id TEXT PRIMARY KEY,approved INTEGER,source TEXT) STRICT',
  );
  for (const item of WEB_PROVIDER_CATALOG) {
    store.run(
      'INSERT INTO character_templates VALUES (?,1,?)',
      item.characterId,
      JSON.stringify({
        id: item.characterId,
        name: item.displayName,
        version: 1,
        fictional: true,
        persona: '合成角色，非真实材料',
        schedule: defaultSchedule(),
      }),
    );
    store.run("INSERT INTO web_provider_voice_bindings VALUES (?,1,'user_selected')", item.characterId);
  }
  let now = 1_800_000_000_000,
    issued = 0;
  const clock = { now: () => now },
    origin = 'https://fixture.invalid';
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebCharacterCatalog(store);
  const service = new WebCharacterAdmin(store, clock, accounts);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const member = (label: string, permissions: string[]) => {
    now += 1000; // a later created_at: the order of the 管理员与权限 table
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-${++issued}`,
      label,
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { auth: { cookie: login.cookie, csrf: login.csrf, origin }, memberId: login.member.id };
  };
  return { store, accounts, service, ownerAuth, member, tick: () => (now += 1000) };
}
type Auth = { cookie: string; csrf: string; origin: string };
const id = 'wei-guagua';
const edit = (f: ReturnType<typeof fixture>, auth: Auth, change: (p: ReturnType<typeof base>) => void) => {
  const detail = f.service.detail(auth, id);
  const profile = structuredClone(detail.draft?.profile ?? detail.published!.profile);
  if (!detail.draft) profile.template.version = detail.published!.version + 1;
  change(profile as never);
  f.tick();
  return f.service.save(auth, id, { expectedRevision: detail.draft?.revision ?? null, profile });
};
const base = () =>
  null as unknown as { template: { persona: string }; presentation: { publicDescription: string; color?: string } };

test("草稿记录: newest first, each with the saver's mark and the 24f one-line summary; the groups name who last changed them", (t) => {
  const f = fixture(t);
  const ana = f.member('小安', ['characters.read:*', 'characters.edit:*']);
  edit(f, f.ownerAuth, (p) => (p.template.persona = '主管理员改的人设'));
  edit(f, ana.auth, (p) => (p.presentation.publicDescription = '小安改的描述'));
  edit(f, ana.auth, (p) => (p.presentation.color = '#336699'));
  const history = f.service.draftHistory(ana.auth, id);
  assert.equal(history.draftRevision, 3);
  assert.deepEqual(
    history.revisions.map((r) => r.revision),
    [3, 2, 1],
  );
  assert.deepEqual(
    history.revisions.map((r) => r.summary),
    ['只改了主色', '改动：身份与展示', '改动：人设'],
  );
  // The owner is the first administrator of the table (index 0), 小安 the second.
  assert.deepEqual(
    history.revisions.map((r) => r.by.index),
    [1, 1, 0],
  );
  assert.deepEqual([history.revisions[0]!.by.label, history.revisions[0]!.by.initial], ['小安', '小']);
  const groups = Object.fromEntries(history.groups.map((g) => [g.group, g.by.index]));
  assert.deepEqual(groups, { 人设: 0, 身份与展示: 1, 主色: 1 });
  // A second change of the same group by the other admin moves the mark; a group changed back to live drops out.
  edit(f, f.ownerAuth, (p) => (p.template.persona = '主管理员又改的人设'));
  const after = f.service.draftHistory(f.ownerAuth, id);
  assert.equal(after.groups.find((g) => g.group === '人设')!.by.index, 0);
  edit(
    f,
    ana.auth,
    (p) => (p.template.persona = f.service.detail(f.ownerAuth, id).published!.profile.template.persona),
  );
  assert.ok(!f.service.draftHistory(f.ownerAuth, id).groups.some((g) => g.group === '人设'));
  // Every row carries the profile it saved (the diff and 恢复到这一稿 use it).
  assert.equal(history.revisions[2]!.profile.template.persona, '主管理员改的人设');
  assert.equal(history.earlier?.template.id, id);
});

test('草稿记录 returns at most 20, never an id, an email or a session id, and a removed member keeps a mark and 已移除的管理员', (t) => {
  const f = fixture(t);
  const ana = f.member('小安', ['characters.read:*', 'characters.edit:*']);
  f.store.run("UPDATE web_admin_members SET email='ana-secret@example.invalid',password_hash='h' WHERE label='小安'");
  for (let i = 0; i < 24; i++) edit(f, i % 2 ? ana.auth : f.ownerAuth, (p) => (p.template.persona = `第${i}稿`));
  const history = f.service.draftHistory(f.ownerAuth, id);
  assert.equal(history.revisions.length, 20);
  assert.equal(history.revisions[0]!.revision, 24);
  const text = JSON.stringify(history);
  const secrets = [
    ana.memberId,
    'ana-secret@example.invalid',
    ...f.store.all<{ id: string }>('SELECT id FROM admin_sessions').map((row) => row.id),
    ...f.store.all<{ id: string }>('SELECT id FROM web_admin_members').map((row) => row.id),
    ...f.store.all<{ secret_hash: string }>('SELECT secret_hash FROM admin_sessions').map((row) => row.secret_hash),
  ];
  for (const secret of secrets) assert.ok(!text.includes(secret), `leaked ${secret}`);
  // (the profile has the CHARACTER's own id; what is checked is the saver: exactly a place, an initial and a label)
  for (const by of [...history.revisions.map((r) => r.by), ...history.groups.map((g) => g.by)])
    assert.deepEqual(Object.keys(by).sort(), ['index', 'initial', 'label']);
  assert.deepEqual(Object.keys(history.revisions[0]!).sort(), ['by', 'profile', 'revision', 'savedAt', 'summary']);
  // 小安 is removed afterwards (the revisions stay): the row keeps a neutral mark and the label 已移除的管理员.
  f.store.run('DELETE FROM web_admin_session_members WHERE member_id=?', ana.memberId);
  f.store.run('DELETE FROM web_admin_grant_members WHERE member_id=?', ana.memberId);
  f.store.run('DELETE FROM web_admin_members WHERE id=?', ana.memberId);
  const removed = f.service.draftHistory(f.ownerAuth, id);
  assert.equal(removed.revisions[0]!.by.label, '已移除的管理员'); // revision 24 was 小安's (odd i)
  assert.equal(removed.revisions[0]!.by.index, null);
  assert.equal(removed.revisions[1]!.by.index, 0);
});

test('草稿记录: only characters.read of that character, nothing without a draft, a discard ends the line, nothing is written', (t) => {
  const f = fixture(t);
  const other = f.member('读者', ['characters.read:jojo']);
  assert.throws(() => f.service.draftHistory(other.auth, id), /PERMISSION_REQUIRED/);
  assert.throws(() => f.service.draftHistory({ ...f.ownerAuth, csrf: 'wrong' }, id), /CSRF|INVALID|REQUIRED/);
  assert.deepEqual(f.service.draftHistory(f.ownerAuth, id).revisions, []);
  edit(f, f.ownerAuth, (p) => (p.template.persona = 'A'));
  edit(f, f.ownerAuth, (p) => (p.template.persona = 'B'));
  const rows = () => f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_revisions')!.n;
  const audits = () => f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n;
  const before = [rows(), audits()];
  f.service.draftHistory(f.ownerAuth, id);
  assert.deepEqual([rows(), audits()], before, 'a read writes nothing');
  f.service.discard(f.ownerAuth, id, 2);
  assert.deepEqual(f.service.draftHistory(f.ownerAuth, id).revisions, []);
  edit(f, f.ownerAuth, (p) => (p.template.persona = 'C'));
  assert.deepEqual(
    f.service.draftHistory(f.ownerAuth, id).revisions.map((r) => r.revision),
    [3],
    'the discarded revisions stay in the table but are not part of the new draft',
  );
});

test('both new reads are on the read-only allowlist', () => {
  assert.equal(isReadOnlyAdminPost('/admin/characters/jojo/draft-history'), true);
  assert.equal(isReadOnlyAdminPost('/admin/cast/version'), true);
  assert.equal(isReadOnlyAdminPost('/admin/characters/jojo/draft-history/x'), false);
});
