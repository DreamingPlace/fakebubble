import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { VoiceModelBinding } from '../../../packages/contracts/audio.ts';
import {
  MEME_CATEGORIES,
  MEME_DROP_CATEGORIES,
  MEME_KEPT_CATEGORIES,
  MEME_LIBRARY_CAP,
  readMemeUse,
  writeMemeUse,
} from '../../../packages/contracts/web-memes.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCastAdmin } from '../../../apps/server/admin/web-cast-admin.ts';
import { installCastDocs } from '../../../apps/server/cast/cast-doc-store.ts';
import { rehearsalRequest, memeCountsOf } from '../../../apps/server/characters/web-rehearsal-request.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { freezeWebV7Request, readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { migrateWebProviderCast } from '../../../apps/server/generation/web-provider-migration.ts';
import { installWriterSetting, writeWriter } from '../../../apps/server/generation/web-writer-setting.ts';
import { WRITER_MEMES_SHA256, writerMemesHash } from '../../../apps/server/generation/writer-memes.ts';
import { writerPins } from '../../../apps/server/generation/writer-v8.ts';
import { MEME_ENTRIES } from '../../../apps/server/memes/meme-dictionary.ts';
import { matchMemes } from '../../../apps/server/memes/meme-match.ts';
import { installMemeLibrary, readMemeLibrary, suggestMeme } from '../../../apps/server/memes/web-meme-library.ts';
import { installMemeStore } from '../../../apps/server/memes/web-meme-store.ts';
import { memeSheets } from '../../../apps/server/export/web-export-tables.ts';
import { csvOf, xlsxOf } from '../../../apps/server/export/web-export-file.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { FREEZE_NOW, schema128, seedFreezeScenario } from '../fixtures/cast-freeze.ts';

/**
 * Part 37c-1b: the re-curated dictionary, the editable library and the 待审 queue. Server side, against a real (in-memory) business
 * store: the runtime step, the owner's writes, matching in replies and in 多轮预演, the upload, the queue, the export round trip.
 */
registerSqlTextLoader();
const origin = 'https://fixture.invalid';
const T0 = FREEZE_NOW;

function fixture(t: TestContext) {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store, 'character', 's2.1-pro' as VoiceModelBinding);
  migrateWebProviderCast(store);
  installCastDocs(store);
  let tick = T0;
  const clock = { now: () => ++tick };
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebAdminActions(store);
  installWriterSetting(store);
  installMemeStore(store);
  installMemeLibrary(store);
  writeWriter(store, T0, 'owner', 'v8m');
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const auth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const cast = new WebCastAdmin(store, clock, accounts);
  let n = 0;
  const id = () => `memelib-request-${String(++n).padStart(6, '0')}`;
  const staff = (permissions: string[]) => {
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-staff-${String(++n).padStart(6, '0')}`,
      label: 'S',
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };
  const list = (over: object = {}, who = auth) =>
    cast.memesList(who, { query: '', year: null, tag: null, state: 'all', page: 1, ...over });
  const entry = (term: string, state = 'all') => list({ query: term, state }).entries.find((e) => e.term === term);
  const add = (term: string, meaning = `${term}的意思`, category = '日常') =>
    cast.memesAdd(auth, { requestId: id(), term, meaning, category, year: null });
  const upload = (text: string) => ({ kind: 'text' as const, text });
  const importText = (text: string) => cast.memesImport(auth, { requestId: id(), upload: upload(text) });
  const preview = (text: string) => cast.memesImportPreview(auth, { upload: upload(text) });
  /** The hits a reply to this player message would carry: the matcher over the effective library, exactly as the live request calls it. */
  const hits = (body: string) => {
    const { off, library } = readMemeLibrary(store);
    return matchMemes([body], off, readMemeUse({}), undefined, library);
  };
  /** The REAL live request (frozen once per store: a frozen request is immutable). */
  const frozenHits = (body: string) => {
    store.run("UPDATE messages SET body=? WHERE id='input'", body);
    freezeInputSnapshot(store as unknown as WebStore, 'operation', T0);
    freezeWebV7Request(store as unknown as WebStore, 'operation', T0);
    return readWebV7Request(store as unknown as WebStore, 'operation').request.memeHits ?? [];
  };
  return {
    store,
    cast,
    auth,
    accounts,
    owner,
    staff,
    id,
    list,
    entry,
    add,
    upload,
    importText,
    preview,
    hits,
    frozenHits,
    clock,
  };
}
type F = ReturnType<typeof fixture>;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const csv = (rows: string[][]) => `词,释义,分类\r\n${rows.map((r) => r.join(',')).join('\r\n')}\r\n`;

// ---- 1. the re-curation -------------------------------------------------------------------------------------------------------------

test('re-curation: every entry has a category, 572 are kept (ON unless an everyday word), the rest ship OFF for a named reason', () => {
  assert.equal(MEME_ENTRIES.length, 1806);
  assert.ok(MEME_ENTRIES.every((e) => MEME_CATEGORIES.includes(e.category)));
  const kept = MEME_ENTRIES.filter((e) => (MEME_KEPT_CATEGORIES as readonly string[]).includes(e.category));
  assert.equal(kept.length, 572);
  const by = (c: string) => MEME_ENTRIES.filter((e) => e.category === c).length;
  assert.deepEqual(Object.fromEntries([...MEME_KEPT_CATEGORIES, ...MEME_DROP_CATEGORIES].map((c) => [c, by(c)])), {
    心情: 98,
    关系: 93,
    日常: 224,
    追星娱乐: 54,
    句式: 103,
    AI科技: 823,
    硬件汽车: 98,
    金融: 67,
    时政: 30,
    真人: 86,
    不雅: 12,
    非日常: 118,
  });
  // ships ON = kept and not an everyday word; the 72 everyday words of Part 37c-1 still ship OFF
  assert.equal(MEME_ENTRIES.filter((e) => !e.defaultOff).length, 546);
  assert.equal(MEME_ENTRIES.filter((e) => e.everyday).length, 72);
  assert.ok(MEME_ENTRIES.filter((e) => e.everyday).every((e) => e.defaultOff));
  assert.ok(
    MEME_ENTRIES.filter((e) => !(MEME_KEPT_CATEGORIES as readonly string[]).includes(e.category)).every(
      (e) => e.defaultOff,
    ),
  );
  // spot checks of the owner's standard
  const cat = (term: string) => MEME_ENTRIES.find((e) => e.term === term)?.category;
  for (const [term, category] of [
    ['精神状态良好', '心情'],
    ['人间真实', '心情'],
    ['饭搭子', '关系'],
    ['亲戚式关心', '关系'],
    ['特种兵大学生', '日常'],
    ['电影票刺客', '日常'],
    ['王心凌男孩', '追星娱乐'],
    ['主打一个XX', '句式'],
    ['你真是个妙人', '句式'],
    ['六代机', '硬件汽车'],
    ['AGI', 'AI科技'],
    ['国债', '金融'],
  ] as const)
    assert.equal(cat(term), category, term);
});

test('re-curation: a dropped entry never matches until the owner switches it on; the switch works both ways', (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.hits('今天聊聊六代机和AGI').map((h) => h.term),
    [],
    'dropped entries are off',
  );
  assert.equal(f.entry('六代机')!.enabled, false);
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['六代机'], enabled: true });
  assert.deepEqual(
    f.hits('今天聊聊六代机和AGI').map((h) => h.term),
    ['六代机'],
  );
  // a kept entry matches by default and the owner can switch it off
  assert.deepEqual(
    f.hits('这个松弛感也太绝了').map((h) => h.term),
    ['松弛感'],
  );
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['松弛感'], enabled: false });
  assert.deepEqual(
    f.hits('这个松弛感也太绝了').map((h) => h.term),
    [],
  );
  // an everyday word stays off until switched on
  assert.equal(f.entry('优化')!.enabled, false);
});

test('the live request: a reply carries the effective library - own entries, edited meanings, switched-on drops - and not the deleted or the off', (t) => {
  const f = fixture(t);
  f.add('现场自有词', '自己加的释义');
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '嘴替', meaning: '现场改过的释义', category: '句式' });
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['松弛感'] });
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['六代机'], enabled: true });
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['摆烂'], enabled: false });
  const got = f.frozenHits('现场自有词 嘴替 松弛感 六代机 摆烂');
  assert.deepEqual(
    got.map((h) => [h.term, h.meaning]).sort(),
    [
      ['嘴替', '现场改过的释义'],
      ['六代机', MEME_ENTRIES.find((e) => e.term === '六代机')!.meaning],
      ['现场自有词', '自己加的释义'],
    ].sort(),
  );
});

// ---- 2. the runtime step -------------------------------------------------------------------------------------------------------------

test('the library tables are a digest-checked runtime step: idempotent, a foreign table or a changed digest stops the start', (t) => {
  const f = fixture(t);
  installMemeLibrary(f.store);
  installMemeLibrary(f.store);
  assert.deepEqual(
    f.store
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE name GLOB 'web_memelib_*' ORDER BY name")
      .map((r) => r.name),
    [
      'web_memelib_deleted',
      'web_memelib_dismissed',
      'web_memelib_entry',
      'web_memelib_override',
      'web_memelib_queue',
      'web_memelib_schema',
    ],
  );
  const foreign = schema128();
  t.after(() => foreign.close());
  foreign.run('CREATE TABLE web_memelib_other(x INTEGER)');
  assert.throws(() => installMemeLibrary(foreign), { code: 'WEB_MEMELIB_SCHEMA_MISMATCH' });
  f.store.run('UPDATE web_memelib_schema SET sha256=?', 'f'.repeat(64));
  assert.throws(() => installMemeLibrary(f.store), { code: 'WEB_MEMELIB_SCHEMA_MISMATCH' });
  // the Part 37c-1 table is untouched by this step (its own STOP code is unchanged)
  const other = schema128();
  t.after(() => other.close());
  other.run('CREATE TABLE web_meme_other(x INTEGER)');
  assert.throws(() => installMemeStore(other), { code: 'WEB_MEME_SCHEMA_MISMATCH' });
});

// ---- 3. add / edit / restore original / switch / delete ----------------------------------------------------------------------------------

test('add: the entry is ON, labelled 手动, matches in the next reply; a duplicate is refused with where it is; limits and categories hold', (t) => {
  const f = fixture(t);
  f.add('绝绝子本人', '夸一个人或一件事好到极点');
  const row = f.entry('绝绝子本人')!;
  assert.deepEqual(
    [row.enabled, row.source, row.category, row.meaning, row.deleted],
    [true, 'manual', '日常', '夸一个人或一件事好到极点', false],
  );
  assert.deepEqual(
    f.hits('哈哈绝绝子本人').map((h) => [h.term, h.meaning]),
    [['绝绝子本人', '夸一个人或一件事好到极点']],
  );
  // a duplicate (own, shipped, or in 已删除) is refused, and the refusal says where it is
  assert.throws(
    () => f.add('绝绝子本人'),
    (e: { code?: string; detail?: { deleted?: boolean } }) =>
      e.code === 'MEME_DUPLICATE' && e.detail?.deleted === false,
  );
  assert.throws(() => f.add('松弛感'), { code: 'MEME_DUPLICATE' });
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['松弛感'] });
  assert.throws(
    () => f.add('松弛感'),
    (e: { code?: string; detail?: { deleted?: boolean; key?: string } }) =>
      e.code === 'MEME_DUPLICATE' && e.detail?.deleted === true && e.detail?.key === '松弛感',
  );
  // the shape: term ≤ 40, meaning ≤ 200, category from the five, year optional
  const bad = (term: string, meaning: string, category: string) => () => f.add(term, meaning, category);
  assert.throws(bad('', '释义', '日常'), { code: 'MEME_TERM_EMPTY' });
  assert.throws(bad('字'.repeat(41), '释义', '日常'), { code: 'MEME_TERM_TOO_LONG' });
  assert.throws(bad('字', '释义', '日常'), { code: 'MEME_TERM_TOO_SHORT' });
  assert.throws(bad('新词一号', '', '日常'), { code: 'MEME_MEANING_EMPTY' });
  assert.throws(bad('新词一号', '长'.repeat(201), '日常'), { code: 'MEME_MEANING_TOO_LONG' });
  assert.throws(bad('新词一号', '释义', 'AI科技'), { code: 'MEME_CATEGORY_INVALID' });
  assert.throws(bad('新词一号', '释义', '随便'), { code: 'MEME_CATEGORY_INVALID' });
  f.add('字'.repeat(40), '长'.repeat(200), '句式');
  assert.equal(
    f.cast.memesAdd(f.auth, { requestId: f.id(), term: '带年份的词', meaning: '有年份', category: '心情', year: 2026 })
      .key,
    '带年份的词',
  );
  assert.equal(f.entry('带年份的词')!.year, 2026);
  assert.throws(
    () =>
      f.cast.memesAdd(f.auth, { requestId: f.id(), term: '坏年份', meaning: '有年份', category: '心情', year: 1800 }),
    /INVALID_REQUEST/,
  );
});

test('edit: any entry; a shipped entry gets an override and 恢复原文 brings the shipped text back; the new meaning is what a reply carries', (t) => {
  const f = fixture(t);
  const shipped = MEME_ENTRIES.find((e) => e.term === '松弛感')!;
  assert.deepEqual(
    f.hits('松弛感').map((h) => h.meaning),
    [shipped.meaning],
  );
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '松弛感', meaning: '我改过的释义', category: '句式' });
  const edited = f.entry('松弛感')!;
  assert.deepEqual(
    [edited.meaning, edited.category, edited.edited, edited.original],
    ['我改过的释义', '句式', true, { meaning: shipped.meaning, category: shipped.category }],
  );
  assert.deepEqual(
    f.hits('松弛感').map((h) => h.meaning),
    ['我改过的释义'],
    'live matching uses the edit at once',
  );
  assert.equal(f.store.get<{ n: number }>('SELECT COUNT(*) n FROM web_memelib_override')!.n, 1);
  // editing back to the shipped text leaves no override
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '松弛感', meaning: shipped.meaning, category: shipped.category });
  assert.equal(f.store.get<{ n: number }>('SELECT COUNT(*) n FROM web_memelib_override')!.n, 0);
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '松弛感', meaning: '又改了', category: shipped.category });
  assert.equal(f.cast.memesRestoreOriginal(f.auth, { requestId: f.id(), keys: ['松弛感'] }).changed, 1);
  assert.deepEqual([f.entry('松弛感')!.meaning, f.entry('松弛感')!.edited], [shipped.meaning, false]);
  // an own entry is edited in place; a dropped entry may keep its drop category while its text is edited
  f.add('自己的词', '旧释义');
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '自己的词', meaning: '新释义', category: '关系' });
  assert.deepEqual([f.entry('自己的词')!.meaning, f.entry('自己的词')!.category], ['新释义', '关系']);
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '六代机', meaning: '改一下', category: '硬件汽车' });
  assert.equal(f.entry('六代机')!.category, '硬件汽车');
  assert.throws(
    () => f.cast.memesEdit(f.auth, { requestId: f.id(), key: '六代机', meaning: '改一下', category: '乱写' }),
    { code: 'MEME_CATEGORY_INVALID' },
  );
  assert.throws(
    () => f.cast.memesEdit(f.auth, { requestId: f.id(), key: '没有这个词', meaning: '改一下', category: '日常' }),
    { code: 'MEME_NOT_FOUND' },
  );
});

test('delete: an own entry is gone for good, a shipped one moves to 已删除 and can be restored; a deleted entry neither matches nor counts; bulk works', (t) => {
  const f = fixture(t);
  const before = f.list();
  f.add('临时词一号');
  f.add('临时词二号');
  assert.equal(f.list().total, before.total + 2);
  assert.deepEqual(
    f.hits('临时词一号').map((h) => h.term),
    ['临时词一号'],
  );
  // own: permanent
  assert.deepEqual(
    { ...f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['临时词一号'] }) },
    { changed: 1, own: 1, duplicate: false },
  );
  assert.equal(f.entry('临时词一号'), undefined);
  assert.equal(
    f.list({ state: 'deleted' }).entries.some((e) => e.term === '临时词一号'),
    false,
    'an own entry is not in 已删除',
  );
  assert.deepEqual(
    f.hits('临时词一号').map((h) => h.term),
    [],
  );
  assert.throws(() => f.cast.memesRestore(f.auth, { requestId: f.id(), keys: ['临时词一号'] }), {
    code: 'MEME_NOT_FOUND',
  });
  // shipped: 已删除, restorable; its switch and its edit come back with it
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '松弛感', meaning: '改过', category: '心情' });
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['松弛感'] });
  assert.equal(f.entry('松弛感'), undefined, 'not in the list any more');
  assert.equal(f.list().total, before.total + 1 - 1);
  const gone = f.list({ state: 'deleted' });
  assert.deepEqual(
    [gone.matching, gone.entries[0]!.term, gone.deleted, gone.entries[0]!.enabled],
    [1, '松弛感', 1, false],
  );
  assert.deepEqual(
    f.hits('松弛感').map((h) => h.term),
    [],
    'a deleted entry does not match',
  );
  assert.throws(() => f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['松弛感'], enabled: true }), {
    code: 'MEME_NOT_FOUND',
  });
  assert.throws(
    () => f.cast.memesEdit(f.auth, { requestId: f.id(), key: '松弛感', meaning: 'x定', category: '日常' }),
    { code: 'MEME_NOT_FOUND' },
  );
  f.cast.memesRestore(f.auth, { requestId: f.id(), keys: ['松弛感'] });
  assert.deepEqual(
    [f.entry('松弛感')!.enabled, f.entry('松弛感')!.meaning, f.list({ state: 'deleted' }).matching],
    [true, '改过', 0],
  );
  assert.deepEqual(
    f.hits('松弛感').map((h) => h.term),
    ['松弛感'],
  );
  // bulk: a page of shipped entries and the own one in one call
  const page = f.list().entries.map((e) => e.key);
  const done = f.cast.memesDelete(f.auth, { requestId: f.id(), keys: [...page, '临时词二号'] });
  assert.deepEqual([done.changed, done.own], [page.length + 1, 1]);
  assert.equal(f.list({ state: 'deleted' }).matching, page.length);
  assert.equal(f.list().total, before.total - page.length);
  assert.equal(f.cast.memesRestore(f.auth, { requestId: f.id(), keys: page }).changed, page.length);
  assert.equal(f.list().total, before.total);
});

test('the switch: any entry, own or shipped, on or off, overrides the shipped default both ways', (t) => {
  const f = fixture(t);
  f.add('开关测试词');
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['开关测试词'], enabled: false });
  assert.deepEqual([f.entry('开关测试词')!.enabled, f.hits('开关测试词').length], [false, 0]);
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['开关测试词'], enabled: true });
  assert.equal(f.hits('开关测试词').length, 1);
  // filters: 已关闭 lists it when off; 默认关闭 never lists an own entry (it never shipped off)
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['开关测试词'], enabled: false });
  assert.ok(f.list({ state: 'off', query: '开关测试词' }).entries.length === 1);
  assert.equal(f.list({ state: 'default-off', query: '开关测试词' }).matching, 0);
});

test('the library holds at most 5,000 entries: a 5,001st is refused, a deleted shipped entry frees a place, an approval counts too', (t) => {
  const f = fixture(t);
  const room = MEME_LIBRARY_CAP - f.list().total;
  assert.equal(room, 3194);
  f.store.transaction(() => {
    for (let i = 0; i < room - 1; i++)
      f.store.run(
        'INSERT INTO web_memelib_entry(term,meaning,category,year,enabled,source,created_at,changed_at) VALUES (?,?,?,?,?,?,?,?)',
        `填充${i}号`,
        '填充',
        '日常',
        null,
        0,
        'upload',
        T0,
        T0,
      );
  });
  assert.equal(f.list().total, MEME_LIBRARY_CAP - 1);
  f.add('最后一个');
  assert.equal(f.list().total, MEME_LIBRARY_CAP);
  assert.throws(() => f.add('多一个'), { code: 'MEME_LIBRARY_FULL' });
  // an approval that would grow the library past the cap is refused whole
  assert.equal(f.importText(csv([['排队词', '队里的词', '日常']])).queued, 1);
  assert.throws(
    () =>
      f.cast.memesApprove(f.auth, {
        requestId: f.id(),
        items: [{ term: '排队词', meaning: '队里的词', category: '日常' }],
      }),
    { code: 'MEME_LIBRARY_FULL' },
  );
  // deleting one frees a place
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['松弛感'] });
  assert.equal(
    f.cast.memesApprove(f.auth, {
      requestId: f.id(),
      items: [{ term: '排队词', meaning: '队里的词', category: '日常' }],
    }).changed,
    1,
  );
  assert.equal(f.list().total, MEME_LIBRARY_CAP);
});

// ---- 4. the upload ---------------------------------------------------------------------------------------------------------------------

test('upload: valid rows go to 待审 (source 上传), invalid rows come back with their reasons, nothing enters the library', (t) => {
  const f = fixture(t);
  const library = f.list().total;
  const text = csv([
    ['好词一号', '一个好词', '日常'],
    ['', '没有词', '日常'],
    ['好词二号', '', '心情'],
    ['字'.repeat(41), '词太长', '日常'],
    ['好词三号', '长'.repeat(201), '日常'],
    ['好词四号', '分类不对', '乱写'],
    ['好词一号', '重复的', '日常'],
    ['好词五号', '另一个词', '句式'],
  ]);
  const view = f.preview(text);
  assert.deepEqual(
    view.rows.map((r) => [r.row, r.status, r.problem]),
    [
      [2, 'ok', null],
      [3, 'invalid', 'EMPTY_TERM'],
      [4, 'invalid', 'EMPTY_MEANING'],
      [5, 'invalid', 'TERM_TOO_LONG'],
      [6, 'invalid', 'MEANING_TOO_LONG'],
      [7, 'invalid', 'BAD_CATEGORY'],
      [8, 'invalid', 'DUPLICATE_IN_FILE'],
      [9, 'ok', null],
    ],
  );
  assert.deepEqual(view.counts, { ok: 2, update: 0, revive: 0, unchanged: 0, queued: 0, invalid: 6 });
  assert.equal(f.cast.memesQueue(f.auth, {}).pending, 0, 'a preview saves nothing');
  const done = f.importText(text);
  assert.equal(done.queued, 2);
  assert.equal(f.list().total, library, 'nothing went straight into the library');
  assert.equal(f.list().pending, 2);
  const queue = f.cast.memesQueue(f.auth, {});
  assert.deepEqual(
    queue.items.map((i) => [i.term, i.source, i.existing, i.wasDeleted]),
    [
      ['好词一号', 'upload', null, false],
      ['好词五号', 'upload', null, false],
    ],
  );
  assert.equal(f.hits('好词一号').length, 0, 'a queued term does not match');
  // the same request id is a duplicate; the same id with other rows is a conflict
  const again = f.cast.memesImport(f.auth, { requestId: 'fixed-import-id-0001', upload: f.upload(text) });
  assert.equal(
    f.cast.memesImport(f.auth, { requestId: 'fixed-import-id-0001', upload: f.upload(text) }).duplicate,
    true,
  );
  assert.ok(again.queued >= 0);
  assert.throws(
    () =>
      f.cast.memesImport(f.auth, {
        requestId: 'fixed-import-id-0001',
        upload: f.upload(csv([['别的词', 'x', '日常']])),
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test('upload: file refusals (no header columns, empty, over 2,000 rows) and the formats: csv, tab-separated paste, xlsx', (t) => {
  const f = fixture(t);
  assert.throws(() => f.preview('名字,说明\r\na,b\r\n'), { code: 'MEME_IMPORT_COLUMNS' });
  assert.throws(() => f.preview(''), { code: 'MEME_IMPORT_EMPTY' });
  assert.throws(() => f.preview('词,释义,分类\r\n'), { code: 'MEME_IMPORT_EMPTY' });
  const rows = (n: number) => csv(Array.from({ length: n }, (_, i) => [`批量${i}号`, '批量词', '日常']));
  assert.equal(f.preview(rows(2000)).rows.length, 2000);
  assert.throws(() => f.preview(rows(2001)), { code: 'MEME_IMPORT_TOO_MANY' });
  assert.throws(() => f.importText(rows(2001)), { code: 'MEME_IMPORT_TOO_MANY' });
  assert.equal(f.cast.memesQueue(f.auth, {}).pending, 0, 'a refused file queues nothing');
  assert.equal(f.importText(rows(2000)).queued, 2000);
  // extra columns are ignored, English headers work, a quoted comma and a BOM are fine
  const extra = '﻿note,term,meaning,category,year\r\nx,"逗号,词","有逗号, 也有引号""",心情,2024\r\n';
  const view = f.preview(extra);
  assert.deepEqual(
    [view.rows[0]!.term, view.rows[0]!.meaning, view.rows[0]!.status],
    ['逗号,词', '有逗号, 也有引号"', 'ok'],
  );
  // pasted from a sheet: tab separated
  assert.deepEqual(
    f.preview('词\t释义\t分类\n粘贴词\t从表格复制\t关系').rows.map((r) => [r.term, r.status]),
    [['粘贴词', 'ok']],
  );
  // .xlsx (inline strings as the export writes them, numbers for the year)
  const book = xlsxOf([
    {
      name: '网络梗',
      header: ['词', '释义', '年份', '分类'],
      rows: [
        ['表格词', '来自 .xlsx 的 <词> & 释义', 2025, '追星娱乐'],
        ['', '没词', 2025, '日常'],
      ],
    },
  ]);
  const xlsx = f.cast.memesImportPreview(f.auth, { upload: { kind: 'xlsx', base64: book.toString('base64') } });
  assert.deepEqual(
    xlsx.rows.map((r) => [r.term, r.meaning, r.status, r.problem]),
    [
      ['表格词', '来自 .xlsx 的 <词> & 释义', 'ok', null],
      ['', '没词', 'invalid', 'EMPTY_TERM'],
    ],
  );
  assert.throws(
    () =>
      f.cast.memesImportPreview(f.auth, {
        upload: { kind: 'xlsx', base64: Buffer.from('not a zip').toString('base64') },
      }),
    { code: 'MEME_IMPORT_FILE' },
  );
  assert.throws(() => f.cast.memesImportPreview(f.auth, { upload: { kind: 'xlsx', base64: '' } }), {
    code: 'MEME_IMPORT_FILE',
  });
});

test('upload: a row whose term exists shows the current entry and the new version; approving updates it; a deleted term is 曾删除 and comes back', (t) => {
  const f = fixture(t);
  const current = f.entry('松弛感')!;
  f.add('我的词', '原来的释义', '日常');
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['蛐蛐'] });
  f.add('曾经的词', '以前的释义');
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['曾经的词'] });
  const text = csv([
    ['松弛感', '新的释义', '句式'],
    ['我的词', '原来的释义', '日常'],
    ['我的词二', '新词', '日常'],
    ['蛐蛐', '回来的释义', '关系'],
    ['曾经的词', '再来一次', '心情'],
    ['六代机', '改个释义', '硬件汽车'],
  ]);
  const view = f.preview(text);
  assert.deepEqual(
    view.rows.map((r) => r.status),
    ['update', 'unchanged', 'ok', 'revive', 'revive', 'update'],
  );
  assert.deepEqual(
    view.rows[0]!.existing,
    { meaning: current.meaning, category: current.category },
    'the current entry beside the new one',
  );
  const shippedCooked = MEME_ENTRIES.find((e) => e.term === '蛐蛐')!;
  assert.deepEqual(
    view.rows[3]!.existing,
    { meaning: shippedCooked.meaning, category: shippedCooked.category },
    'a deleted shipped entry shows what it was',
  );
  assert.equal(f.importText(text).queued, 5, 'unchanged is not queued');
  const queue = f.cast.memesQueue(f.auth, {});
  const by = (term: string) => queue.items.find((i) => i.term === term)!;
  assert.deepEqual(
    [
      by('松弛感').existing?.meaning,
      by('曾经的词').wasDeleted,
      by('曾经的词').existing,
      by('蛐蛐').wasDeleted,
      by('我的词二').wasDeleted,
    ],
    [current.meaning, true, null, true, false],
  );
  // approving the existing one updates it (and it is ON); approving the deleted ones brings them back, ON
  f.cast.memesApprove(f.auth, {
    requestId: f.id(),
    items: [
      { term: '松弛感', meaning: '新的释义', category: '句式' },
      { term: '蛐蛐', meaning: '回来的释义', category: '关系' },
      { term: '曾经的词', meaning: '再来一次', category: '心情' },
      { term: '六代机', meaning: '改个释义', category: '硬件汽车' },
    ],
  });
  assert.deepEqual(
    [f.entry('松弛感')!.meaning, f.entry('松弛感')!.category, f.entry('松弛感')!.edited],
    ['新的释义', '句式', true],
  );
  assert.deepEqual(
    [
      f.entry('蛐蛐')!.enabled,
      f.entry('蛐蛐')!.meaning,
      f.list({ state: 'deleted' }).entries.some((e) => e.term === '蛐蛐'),
    ],
    [true, '回来的释义', false],
  );
  assert.deepEqual(
    [f.entry('曾经的词')!.enabled, f.entry('曾经的词')!.source, f.entry('曾经的词')!.meaning],
    [true, 'upload', '再来一次'],
  );
  assert.equal(f.entry('六代机')!.enabled, true, 'approval switches an updated entry on');
  assert.deepEqual(
    f.hits('曾经的词').map((h) => h.term),
    ['曾经的词'],
  );
});

// ---- 5. the queue ----------------------------------------------------------------------------------------------------------------------

test('queue: approve with edits (meaning, category, even the term) → the library, ON, source kept; dismiss → never suggested again by an automatic source', (t) => {
  const f = fixture(t);
  f.importText(
    csv([
      ['待审甲', '甲的释义', '日常'],
      ['待审乙', '乙的释义', '关系'],
      ['待审丙', '丙的释义', '句式'],
    ]),
  );
  const total = f.list().total;
  const result = f.cast.memesApprove(f.auth, {
    requestId: f.id(),
    items: [
      { term: '待审甲', meaning: '改过的甲释义', category: '心情' },
      { term: '待审乙', newTerm: '待审乙改名', meaning: '乙的释义', category: '关系' },
    ],
  });
  assert.deepEqual([result.changed, result.updated, result.revived], [2, 0, 0]);
  assert.equal(f.list().total, total + 2);
  assert.deepEqual(
    [f.entry('待审甲')!.meaning, f.entry('待审甲')!.category, f.entry('待审甲')!.source, f.entry('待审甲')!.enabled],
    ['改过的甲释义', '心情', 'upload', true],
  );
  assert.equal(f.entry('待审乙'), undefined);
  assert.equal(f.entry('待审乙改名')!.enabled, true);
  assert.deepEqual(
    f.hits('待审甲').map((h) => h.meaning),
    ['改过的甲释义'],
  );
  // an item that is not in the queue, a bad edit, a duplicate target
  assert.throws(
    () =>
      f.cast.memesApprove(f.auth, {
        requestId: f.id(),
        items: [{ term: '不在队里', meaning: 'x定', category: '日常' }],
      }),
    { code: 'MEME_QUEUE_NOT_FOUND' },
  );
  assert.throws(
    () =>
      f.cast.memesApprove(f.auth, { requestId: f.id(), items: [{ term: '待审丙', meaning: '', category: '日常' }] }),
    { code: 'MEME_MEANING_EMPTY' },
  );
  assert.equal(f.cast.memesQueue(f.auth, {}).pending, 1, 'a refused approval changes nothing');
  // 不要: gone from the queue, and an automatic source (a fake one here) never suggests it again
  assert.equal(f.cast.memesDismiss(f.auth, { requestId: f.id(), terms: ['待审丙'] }).changed, 1);
  assert.equal(f.cast.memesQueue(f.auth, {}).pending, 0);
  assert.equal(f.entry('待审丙'), undefined);
  const fake = (term: string, source: 'radar' | 'chat' = 'radar') =>
    suggestMeme(f.store, T0, {
      term,
      meaning: '自动来源建议的释义',
      category: '日常',
      source,
      links: ['https://example.invalid/a'],
      playerCount: 7,
    });
  assert.equal(fake('待审丙'), 'dismissed');
  assert.equal(fake('待审丙', 'chat'), 'dismissed');
  assert.equal(f.cast.memesQueue(f.auth, {}).pending, 0);
  // a term the owner deleted is never suggested again either (shipped or own); a term the library holds is not suggested
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['松弛感', '待审甲'] });
  assert.deepEqual([fake('松弛感'), fake('待审甲'), fake('嘴替')], ['deleted', 'deleted', 'exists']);
  // a fresh term is queued with its source, links and count, once
  assert.equal(fake('全新的梗'), 'queued');
  assert.equal(fake('全新的梗'), 'already-queued');
  assert.equal(suggestMeme(f.store, T0, { term: '', meaning: 'x', category: '日常', source: 'radar' }), 'invalid');
  const item = f.cast.memesQueue(f.auth, {}).items[0]!;
  assert.deepEqual(
    [item.term, item.source, item.links, item.playerCount],
    ['全新的梗', 'radar', ['https://example.invalid/a'], 7],
  );
  // the owner can still upload a dismissed term himself, and approving it lifts the dismissal
  f.importText(csv([['待审丙', '再来一次', '日常']]));
  f.cast.memesApprove(f.auth, {
    requestId: f.id(),
    items: [{ term: '待审丙', meaning: '再来一次', category: '日常' }],
  });
  assert.equal(f.entry('待审丙')!.enabled, true);
  assert.equal(f.store.get<{ n: number }>("SELECT COUNT(*) n FROM web_memelib_dismissed WHERE term='待审丙'")!.n, 0);
  // the fake source's entry, approved, is labelled with its source
  f.cast.memesApprove(f.auth, {
    requestId: f.id(),
    items: [{ term: '全新的梗', meaning: '自动来源建议的释义', category: '日常' }],
  });
  assert.equal(f.entry('全新的梗')!.source, 'radar');
  assert.ok(f.list({ source: 'radar' }).entries.every((e) => e.source === 'radar'));
});

// ---- 6. matching in 多轮预演 ---------------------------------------------------------------------------------------------------------------

test('多轮预演: the run counts memes against the effective library it froze (own entries, edited meanings, deletions, switches)', (t) => {
  const f = fixture(t);
  f.add('预演专用词', '预演里的释义', '日常');
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '嘴替', meaning: '预演里改过的嘴替', category: '句式' });
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['松弛感'] });
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['六代机'], enabled: true });
  const { off, library } = readMemeLibrary(f.store);
  const state = {
    memeOff: [...off].sort(),
    memeOwn: [{ term: '预演专用词', meaning: '预演里的释义' }],
    memeMeanings: { 嘴替: '预演里改过的嘴替' },
  };
  const players = ['预演专用词真的好用', '松弛感满满，嘴替来了', '聊聊六代机'];
  const template = writeMemeUse(
    JSON.parse(
      f.store.get<{ config_json: string }>("SELECT config_json FROM character_templates WHERE id='character'")!
        .config_json,
    ),
    { level: 'use', overrides: {} },
  );
  const counts = memeCountsOf({ template, baseAt: T0, ...state } as never, players);
  // turn 1: 预演专用词; turn 2: 嘴替 (松弛感 is deleted) - and 预演专用词 is still inside the 3-message window; turn 3: 六代机 + the earlier ones
  assert.ok(counts.matched >= 3 && counts.given >= 3);
  const request = rehearsalRequest({ template, baseAt: T0, ...state } as never, 'run', 'deepseek-v8m', 2, players, [
    ['好的'],
  ]);
  assert.deepEqual(
    request.memeHits?.map((h) => [h.term, h.meaning]),
    [
      ['嘴替', '预演里改过的嘴替'],
      ['预演专用词', '预演里的释义'],
    ],
  );
  // the same texts against the SHIPPED library: no own entry, the shipped meaning, 松弛感 still there
  const shipped = memeCountsOf({ template, baseAt: T0 } as never, players);
  const mine = memeCountsOf({ template, baseAt: T0, ...state } as never, players);
  assert.notDeepEqual(shipped, mine, 'the effective library changes the counts');
  assert.deepEqual(
    matchMemes(['松弛感', '预演专用词'], off, readMemeUse(template), undefined, library).map((h) => h.term),
    ['预演专用词'],
  );
  // a run frozen BEFORE this Part (no owner layer) counts exactly as it did
  const old = memeCountsOf({ template, baseAt: T0, memeOff: [] } as never, ['松弛感']);
  assert.deepEqual(old, { matched: 1, given: 1, use: 1, know: 0, avoid: 0 });
});

// ---- 7. permissions, audit, routes ---------------------------------------------------------------------------------------------------------

test('permissions, audit and routes: reading needs cast.read, every write needs cast.edit; the audit says what and how many, never a term', async (t) => {
  const f = fixture(t);
  const reader = f.staff(['cast.read']);
  const editor = f.staff(['cast.read', 'cast.edit']);
  const nobody = f.staff(['points.grant']);
  assert.equal(f.cast.memesQueue(reader, {}).pending, 0);
  assert.throws(() => f.cast.memesQueue(nobody, {}), /ADMIN_PERMISSION_REQUIRED/);
  const writes: Array<() => unknown> = [
    () =>
      f.cast.memesAdd(reader, { requestId: f.id(), term: '读者的词', meaning: 'x定', category: '日常', year: null }),
    () => f.cast.memesEdit(reader, { requestId: f.id(), key: '松弛感', meaning: 'x定', category: '心情' }),
    () => f.cast.memesDelete(reader, { requestId: f.id(), keys: ['松弛感'] }),
    () => f.cast.memesRestore(reader, { requestId: f.id(), keys: ['松弛感'] }),
    () => f.cast.memesRestoreOriginal(reader, { requestId: f.id(), keys: ['松弛感'] }),
    () => f.cast.memesImport(reader, { requestId: f.id(), upload: f.upload(csv([['a词', 'b', '日常']])) }),
    () => f.cast.memesImportPreview(reader, { upload: f.upload(csv([['a词', 'b', '日常']])) }),
    () => f.cast.memesApprove(reader, { requestId: f.id(), items: [{ term: 'a词', meaning: 'b', category: '日常' }] }),
    () => f.cast.memesDismiss(reader, { requestId: f.id(), terms: ['a词'] }),
  ];
  for (const write of writes) assert.throws(write, /ADMIN_PERMISSION_REQUIRED/);
  // a write needs the CSRF token and the Origin like every administrator write
  assert.throws(
    () =>
      f.cast.memesAdd(
        { ...editor, csrf: 'wrong' },
        { requestId: f.id(), term: '坏令牌的词', meaning: 'x定', category: '日常', year: null },
      ),
    /ADMIN_UNAUTHORIZED|CSRF|ORIGIN|FORBIDDEN/i,
  );
  assert.throws(
    () =>
      f.cast.memesAdd(
        { ...editor, origin: 'https://evil.invalid' },
        { requestId: f.id(), term: '坏来源的词', meaning: 'x定', category: '日常', year: null },
      ),
    /ADMIN_UNAUTHORIZED|CSRF|ORIGIN|FORBIDDEN/i,
  );
  assert.equal(f.entry('坏令牌的词'), undefined);
  f.cast.memesAdd(editor, {
    requestId: f.id(),
    term: '编辑者的词',
    meaning: '编辑者加的',
    category: '日常',
    year: null,
  });
  assert.throws(
    () =>
      f.cast.memesAdd(f.auth, { requestId: 'short', term: '坏编号的词', meaning: 'x定', category: '日常', year: null }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () =>
      f.cast.memesAdd(f.auth, {
        requestId: f.id(),
        term: '多余键',
        meaning: 'x定',
        category: '日常',
        year: null,
        extra: 1,
      }),
    /INVALID_REQUEST/,
  );
  f.importText(csv([['审计词', '审计用', '日常']]));
  f.cast.memesApprove(f.auth, { requestId: f.id(), items: [{ term: '审计词', meaning: '审计用', category: '日常' }] });
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['审计词', '松弛感'] });
  f.cast.memesRestore(f.auth, { requestId: f.id(), keys: ['松弛感'] });
  const audit = f.store.all<{ action: string; target_id: string }>(
    "SELECT action,target_id FROM web_admin_audit WHERE action GLOB 'memes-*' ORDER BY seq",
  );
  assert.ok(audit.length >= 5);
  const text = audit.map((a) => `${a.action} ${a.target_id}`).join('\n');
  assert.ok(!/审计|松弛感|编辑者/.test(text), 'no term in the audit');
  assert.ok(
    audit.every((a) => /^([a-z]+=\d+;?)+$/.test(a.target_id)),
    text,
  );
  assert.ok(audit.some((a) => a.action === 'memes-add') && audit.some((a) => a.action === 'memes-delete'));
  // the routes exist (the queue and the preview are reads; the rest are writes)
  const call = async (action: string, body: unknown) =>
    routeWebAccountAdmin(
      f.accounts,
      {
        method: 'POST',
        path: `/api/web/local/admin/cast/${action}`,
        body,
        adminCookie: f.owner.cookie,
        csrf: f.owner.csrf,
        origin,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      f.cast,
    );
  assert.equal(((await call('memes-queue', {}))?.body as { pending: number }).pending, 0);
  assert.equal(
    (
      await call('memes-add', {
        requestId: f.id(),
        term: '路由的词',
        meaning: '走路由加的',
        category: '日常',
        year: null,
      })
    )?.status,
    200,
  );
  assert.equal(
    (
      (
        await call('memes-list', {
          query: '路由的词',
          year: null,
          tag: null,
          state: 'all',
          page: 1,
          category: '日常',
          source: 'manual',
        })
      )?.body as { matching: number }
    ).matching,
    1,
  );
  assert.throws(
    () => f.cast.memesList(f.auth, { query: '', year: null, tag: null, state: 'all', page: 1, category: '乱写' }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => f.cast.memesList(f.auth, { query: '', year: null, tag: null, state: 'all', page: 1, source: 'nope' }),
    /INVALID_REQUEST/,
  );
  // no player data anywhere in the library tables
  for (const table of [
    'web_memelib_entry',
    'web_memelib_override',
    'web_memelib_deleted',
    'web_memelib_queue',
    'web_memelib_dismissed',
  ]) {
    const columns = f.store
      .all<{ name: string }>(`PRAGMA table_info(${table})`)
      .map((c) => c.name)
      .join(',');
    // (player_count is a number of players who said a term - 37c-2 fills it; no id, nickname, email, world or message column exists)
    assert.ok(!/player_id|user|email|nick|world|operation|message|body|text/.test(columns), `${table}: ${columns}`);
  }
});

// ---- 8. export round trip --------------------------------------------------------------------------------------------------------------------

test('export: category, source, on/off and deleted columns; uploading the export back leaves nothing new to approve (csv and xlsx)', (t) => {
  const f = fixture(t);
  f.add('导出的自有词', '自己加的，带逗号, 和引号"', '关系');
  f.cast.memesEdit(f.auth, { requestId: f.id(), key: '松弛感', meaning: '改过 -的释义', category: '句式' });
  f.cast.memesSet(f.auth, { requestId: f.id(), keys: ['嘴替'], enabled: false });
  f.cast.memesDelete(f.auth, { requestId: f.id(), keys: ['蛐蛐'] });
  const filters = { query: '', year: null, tag: null, state: 'all' as const, category: null, source: null };
  const [sheet] = memeSheets(f.store, filters);
  assert.deepEqual(sheet!.header, ['词', '释义', '年份', '标签', '状态', '默认关闭', '分类', '来源', '已删除']);
  const row = (term: string) => sheet!.rows.find((r) => r[0] === term)!;
  assert.deepEqual(
    [row('导出的自有词')[4], row('导出的自有词')[6], row('导出的自有词')[7], row('导出的自有词')[8]],
    ['已开启', '关系', '手动', '否'],
  );
  assert.deepEqual([row('嘴替')[4], row('嘴替')[7]], ['已关闭', '自带']);
  assert.deepEqual([row('六代机')[5], row('六代机')[6]], ['是', '硬件汽车']);
  assert.equal(
    sheet!.rows.some((r) => r[0] === '蛐蛐'),
    false,
    "the page's 全部 does not list the deleted ones",
  );
  const gone = memeSheets(f.store, { ...filters, state: 'deleted' })[0]!;
  assert.deepEqual(
    gone.rows.map((r) => [r[0], r[8]]),
    [['蛐蛐', '是']],
  );
  assert.deepEqual(
    memeSheets(f.store, { ...filters, source: 'manual' })[0]!.rows.map((r) => r[0]),
    ['导出的自有词'],
  );
  assert.ok(memeSheets(f.store, { ...filters, category: '日常' })[0]!.rows.every((r) => r[6] === '日常'));
  // round trip through csv
  const csvBack = f.cast.memesImportPreview(f.auth, { upload: { kind: 'text', text: csvOf(sheet!) } });
  assert.equal(csvBack.rows.length, sheet!.rows.length);
  assert.deepEqual(csvBack.counts, {
    ok: 0,
    update: 0,
    revive: 0,
    unchanged: sheet!.rows.length,
    queued: 0,
    invalid: 0,
  });
  // and through xlsx
  const xlsxBack = f.cast.memesImportPreview(f.auth, {
    upload: { kind: 'xlsx', base64: xlsxOf([sheet!]).toString('base64') },
  });
  assert.deepEqual(xlsxBack.counts, csvBack.counts);
  assert.equal(
    f.cast.memesImport(f.auth, { requestId: f.id(), upload: { kind: 'text', text: csvOf(sheet!) } }).queued,
    0,
  );
  assert.equal(f.cast.memesQueue(f.auth, {}).pending, 0, 'nothing new to approve');
  // the deleted ones, uploaded back, are 曾删除
  const deletedBack = f.cast.memesImportPreview(f.auth, { upload: { kind: 'text', text: csvOf(gone) } });
  assert.deepEqual(
    deletedBack.rows.map((r) => r.status),
    ['revive'],
  );
});

// ---- 9. the pins -----------------------------------------------------------------------------------------------------------------------------

test('the pins: 旧, 新 and 新+档案 are what they were on main; 新+档案+梗 is unchanged too (the matcher and the words did not move)', () => {
  assert.deepEqual(writerPins(), {
    protocolDigest: 'ce52de214ead5c3e3024a76fd1d321a4e7153dc8cdad3c062571885b5a1587f2',
    promptDigest: '4186fe6b18b75e9af1d26c57d47b32776a601e73ba6d2dfd75122559ba78b6bb',
  });
  assert.deepEqual(writerPins(true), {
    protocolDigest: 'ce52de214ead5c3e3024a76fd1d321a4e7153dc8cdad3c062571885b5a1587f2',
    promptDigest: 'e8a4e2cbde9166952ed383e4774d015b9fba7add997107967e46553808b13d01',
  });
  assert.deepEqual(writerPins(true, true), {
    protocolDigest: 'ce52de214ead5c3e3024a76fd1d321a4e7153dc8cdad3c062571885b5a1587f2',
    promptDigest: '7d90ab32d46991dbf95d47a6343b1175752be391955506129699f635e2d076ce',
  });
  assert.equal(WRITER_MEMES_SHA256, 'a43554c584cadef62dc5b9ed1041268d1f0505f6cfff59d635502e3c35c6a485');
  assert.equal(writerMemesHash(), WRITER_MEMES_SHA256);
  void sha;
});

void ({} as F);
