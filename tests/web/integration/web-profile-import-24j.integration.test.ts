// Part 24k-2 (named exception): the welcome fixtures/assertions in this file moved from welcome {text,version} to welcomes [{id,text,weight}]; nothing else was changed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCastAdmin } from '../../../apps/server/admin/web-cast-admin.ts';
import { readDraft } from '../../../apps/server/cast/cast-store.ts';
import { compileCastView } from '../../../apps/server/cast/cast-compile.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { installWebCharacterDeletion } from '../../../apps/server/characters/web-character-deletion-schema.ts';
import { installWebCharacterMaterials } from '../../../apps/server/characters/web-character-material-schema.ts';
import { migrateWebProviderCast } from '../../../apps/server/generation/web-provider-migration.ts';
import { WEB_PROVIDER_CATALOG } from '../../../config/web-v1.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { FREEZE_NOW, schema128 } from '../fixtures/cast-freeze.ts';
import { templateFile } from '../fixtures/profile-template.ts';
import { installProfileImport } from '../../../apps/server/characters/web-profile-schema.ts';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { textRequest } from '../../text-fixtures.ts';
import { canonicalCastJson } from '../../../apps/server/cast/cast-validation.ts';
import type { CastDoc } from '../../../packages/contracts/web-cast.ts';

const origin = 'https://fixture.invalid';

function fixture(t: TestContext) {
  const store = schema128();
  migrateWebProviderCast(store);
  t.after(() => store.close());
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
  installWebCharacterDeletion(store as never);
  let ids = 0;
  const clock = { now: () => FREEZE_NOW };
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
  characters.enableProfileImport();
  return {
    store,
    accounts,
    cast,
    characters,
    ownerAuth,
    staff,
    request: () => `profile-import-${String(++ids).padStart(6, '0')}`,
  };
}
type F = ReturnType<typeof fixture>;
const files = (...items: [string, string][]) => items.map(([name, text]) => ({ name, text }));
const preview = (f: F, items: { name: string; text: string }[], auth = f.ownerAuth) =>
  f.characters.profileImportPreview(auth, { files: items });
const apply = (
  f: F,
  items: { name: string; text: string }[],
  basis: unknown,
  auth = f.ownerAuth,
  requestId = f.request(),
) => f.characters.profileImportApply(auth, { requestId, files: items, basis });
const run = (f: F, items: { name: string; text: string }[]) => {
  const p = preview(f, items);
  assert.equal(p.problems.length, 0, JSON.stringify(p.problems));
  return { p, r: apply(f, items, p.basis) };
};
const detail = (f: F, code: string) => {
  const row = f.store.get<{ character_id: string }>(
    'SELECT character_id FROM web_profile_codes WHERE code_key=?',
    code.toLowerCase(),
  );
  assert.ok(row, `no character with code ${code}`);
  return f.characters.detail(f.ownerAuth, row.character_id);
};

const refused = (work: () => unknown, code: string) =>
  assert.throws(work, (error: Error & { code?: string }) => error.code === code, code);
const draftOf = (f: F, code: string) => detail(f, code).draft!.profile;
const rows = (f: F) => ({
  codes: f.store.all('SELECT * FROM web_profile_codes ORDER BY 1'),
  checklist: f.store.all('SELECT * FROM web_profile_checklist ORDER BY 1,2'),
  revisions: f.store.all('SELECT character_id,revision FROM web_character_revisions ORDER BY 1,2'),
  drafts: f.store.all('SELECT * FROM web_character_drafts ORDER BY 1'),
  cast: f.store.get('SELECT revision,doc_json FROM web_cast_draft'),
});
const example = () => readFileSync(new URL('../../../examples/character-template.example.md', import.meta.url), 'utf8');
const card = (f: F, characterId: string) =>
  readDraft(f.store).doc.characters.find((c) => c.characterId === characterId)!;
const idOf = (f: F, code: string) =>
  f.store.get<{ character_id: string }>(
    'SELECT character_id FROM web_profile_codes WHERE code_key=?',
    code.toLowerCase(),
  )!.character_id;

const LQY = templateFile(
  {
    角色代码: 'LQY',
    人设名称: '林青野',
    '网页展示名／昵称': '青野',
    欢迎词: '「嗨」',
    陌生时的相处方式: '爱笑。',
  },
  [
    {
      code: 'SYZ',
      cp: '旧巷双人组',
      addresses: '「阿舟」',
      attitude: '当作能吵架的朋友。',
      shared: '一起修过一本旧书。',
    },
  ],
);

test('a fully filled synthetic file: every value lands in its listed field or the checklist, nothing elsewhere', (t) => {
  const f = fixture(t);
  const sheep = templateFile({
    角色代码: 'XJ',
    人设名称: '小羊',
    '网页展示名／昵称': '羊',
    欢迎词: '「咩」',
    陌生时的相处方式: '软。',
  });
  const { p } = run(f, files(['syz.md', example()], ['lqy.md', LQY], ['xj.md', sheep]));
  assert.deepEqual(
    p.characters.map((c) => c.mode),
    ['new', 'new', 'new'],
  );

  const d = detail(f, 'SYZ');
  const profile = d.draft!.profile;
  const t1 = profile.template as unknown as Record<string, unknown>;
  // ---- 身份与展示
  assert.equal(profile.template.name, '沈砚舟');
  assert.equal(profile.presentation.displayName, '砚舟');
  assert.equal(profile.presentation.publicDescription, '话少心细的旧书店店员');
  assert.equal(profile.template.birthDate, '2000-11-02');
  assert.equal('seed' in profile.template, false, '否 = absent');
  assert.equal(d.profileMeta.code, 'SYZ');
  // ---- 欢迎内容 (Part 24k-2, named exception: this used to be "line 1 only"; now EVERY line imports, with even weights)
  assert.equal(profile.presentation.welcomes[0]!.text, '来了。先坐，水刚烧好。');
  assert.equal(profile.presentation.welcomes.length, 2);
  assert.ok(profile.presentation.welcomes[1]!.text.includes('今天书店人少'), 'line 2 is stored too');
  assert.deepEqual(
    profile.presentation.welcomes.map((line) => line.weight),
    [50, 50],
  );
  // ---- 主色
  assert.equal(profile.presentation.color, '#2F4858');
  assert.deepEqual(profile.presentation.palette, [
    { hex: '#2F4858', name: '深墨蓝', role: 'main' },
    { hex: '#C9A227', name: '旧金', role: 'accent' },
  ]);
  // ---- 声音: the id is prefilled, nothing generated or approved
  assert.equal(d.profileMeta.voiceReferenceId, 'syz_voice_001');
  assert.equal(d.profileMeta.avatarFile, 'syz-main.png');
  assert.equal(f.store.all('SELECT 1 FROM web_provider_voice_bindings WHERE character_id=?', idOf(f, 'SYZ')).length, 0);
  assert.equal(t1.voice, undefined);
  // ---- 性格 (persona), in template order
  assert.equal(
    profile.template.persona,
    [
      '陌生时的相处方式：客气、克制，回答简短，不主动追问。',
      '熟悉后的变化：话会变多，开始用冷幽默。',
      '表达关心的方式：不说好听话，默默把热茶推过来。',
      '开玩笑或被调侃时的反应：先沉默一拍，再不动声色地回一句。',
      '遇到冲突·拒绝·冷场时的反应：说「这个我不太方便」，然后换话题。',
    ].join('\n'),
  );
  // ---- authorCanon: exactly these four keys
  const settings = profile.template.authorCanon!.settings;
  assert.deepEqual(Object.keys(settings), ['speechStyle', 'background', 'profileFacts', 'boundaries']);
  assert.deepEqual(settings.speechStyle, [
    '常用词与口头禅：「还行」「再说吧」「随你」',
    '句子长短·断句习惯：短句为主，偶尔一句很长的收尾。',
    '称呼对方的习惯：熟了以后直接叫名字。',
    '文字聊天习惯：很少用表情，句末常带省略号。',
    '开心时怎么说：「……不错。」然后悄悄多说两句。',
    '低落时怎么说：回复变慢，只说「嗯」。',
    '生气时怎么说：语气越来越平，一字一顿。',
    '不会使用的措辞：「宝贝」「亲爱的」',
  ]);
  assert.deepEqual(settings.background, [
    { title: '成长背景', text: '在老城区长大，家里开过一间旧书铺。' },
    { title: '现在的生活状态', text: '白天在书店，晚上整理旧书目录。' },
    { title: '近况', text: '最近在整理一批民国年间的旧账本。' },
  ]);
  assert.deepEqual(settings.profileFacts, {
    性别: '男',
    身高: '181cm',
    饰演过的角色: '话剧《旧巷》里的账房先生',
    动物形象: '灰蓝色的猫',
    兴趣·擅长的事: '修旧书，泡茶，记人的口味。',
    喜欢与不喜欢的事物: '喜欢雨天和纸页的气味；不喜欢吵闹的场合。',
    宠物: '一只叫「墨点」的猫',
    家庭成员: '外婆；父母在外地工作',
    外貌·衣着·体态: '清瘦，常穿深色针织衫，背微微前倾。',
    现在所在地: '老城区的「半页书店」',
  });
  assert.deepEqual(settings.boundaries, {
    知道但不会说出口的事: '其实偷偷替顾客垫过几次书钱。',
    不可改变的核心设定: '2000-11-02 生；是真实存在于虚构世界的书店店员。',
    不应擅自补充的事实: '不擅自给他添加恋爱史或具体家庭住址。',
    不符合角色的行为·表达: '不会大声喊叫，不会使用网络流行语刷屏。',
  });
  assert.deepEqual(Object.keys(t1).sort(), [
    'authorCanon',
    'birthDate',
    'fictional',
    'id',
    'name',
    'persona',
    'schedule',
    'version',
  ]);
  assert.deepEqual(Object.keys(profile.presentation).sort(), [
    'color',
    'displayName',
    'palette',
    'publicDescription',
    'welcomes',
  ]);
  // ---- checklist (Part 24k-2, named exception: the second welcome line is a line now, no longer a checklist item)
  assert.deepEqual(d.profileMeta.checklist, [
    { key: 'avatar:syz-main.png', text: '头像 syz-main.png 待 25e 上传', state: 'open' },
  ]);

  // ---- 关系与故事: the name card only, plus the relation, one story, one meme; nothing in 演绎说明 and friends
  const cast = readDraft(f.store).doc;
  const syz = card(f, idOf(f, 'SYZ'));
  assert.deepEqual(
    syz.identity.names.map((n) => n.text),
    ['沈砚舟'],
  );
  assert.equal(syz.identity.oneLiner, '话少心细的旧书店店员');
  assert.deepEqual(
    syz.identity.aliases.map((a) => [a.text, a.kind, a.attitude]),
    [
      ['我', 'self', 'likes'],
      ['本人', 'self', 'likes'],
      ['Shen', 'other', 'likes'],
      ['小沈', 'other', 'likes'],
      ['沈同学', 'neutral', 'ok'],
      ['沈闷葫芦', 'insult', 'dislikes'],
    ],
  );
  assert.deepEqual(
    [
      syz.performance,
      syz.profile,
      syz.personality,
      syz.unmapped,
      syz.experiences,
      syz.hidden,
      syz.identity.selfConcept,
    ],
    ['', '', '', '', [], [], ''],
  );
  assert.deepEqual(syz.speech, { catchphrases: [], samples: [], avoid: [] });
  assert.deepEqual(cast.ratings, {}, 'ratings are never written');
  // Part 24m (named): each relation pair is now one group (two pairs here); no people are made.
  assert.deepEqual([cast.people.length, cast.groups.length], [0, 2]);
  const lqyId = idOf(f, 'LQY');
  const direction = cast.directions.find((x) => x.from === idOf(f, 'SYZ') && x.to === lqyId)!;
  assert.deepEqual(
    direction.addresses.map((a) => a.text),
    ['Little Sheep', 'X老师', '林青野'],
    'the inner space is kept',
  );
  assert.equal(direction.treatment, '嘴上嫌吵，其实会留一盏灯。');
  assert.equal(cast.directions.find((x) => x.from === lqyId)!.addresses[0]!.text, '阿舟');
  // SYZ's second relation (XJ) resolves to the third file: its address is ONE item
  const xj = cast.directions.find((x) => x.from === idOf(f, 'SYZ') && x.to === idOf(f, 'XJ'))!;
  assert.deepEqual(
    xj.addresses.map((a) => a.text),
    ['小羊/XX'],
  );
  // Part 24m (named, replaces the 24j assertions of one story and one meme per pair): the pair is ONE GROUP of exactly its two
  // members, named by the CP名; the shared history is that group's story; no story of the cast and no meme is made.
  assert.equal(cast.stories.length, 0);
  assert.deepEqual(cast.memes, []);
  const group = cast.groups.find((g) => g.members.includes(lqyId) && g.members.includes(idOf(f, 'SYZ')))!;
  assert.equal(group.name, '旧巷双人组');
  assert.deepEqual(group.members, [lqyId, idOf(f, 'SYZ')], 'LQY < SYZ by code');
  assert.equal(group.stories.length, 1);
  const story = group.stories[0]!;
  assert.equal(story.title, '林青野与沈砚舟');
  assert.equal(story.summary, '一起修过一本旧书。');
  assert.equal(story.details, '（林青野侧）一起修过一本旧书。\n（沈砚舟侧）常一起去夜市；一起修过一本被雨泡过的旧书。');
});

test('character A: 生日, 一句话描述 and 成长中 land in their fields; three colours keep order and roles; a colour without a hex is a checklist item', (t) => {
  const f = fixture(t);
  const a = templateFile({
    角色代码: 'AAA',
    人设名称: '甲',
    '网页展示名／昵称': '小甲',
    欢迎词: '「你好」',
    陌生时的相处方式: '客气。',
    生日: '1999-12-31',
    一句话描述: '一句话。',
    是否为成长中角色: '是',
    '音色模型 ID（Fish Audio）': 'fish_ref_a',
    角色主色: '「#111111 一」「#222222 二（主）」「#333333 三」「深海」',
  });
  run(f, files(['a.md', a]));
  const d = detail(f, 'AAA');
  assert.equal(d.draft!.profile.template.birthDate, '1999-12-31');
  assert.equal(d.draft!.profile.presentation.publicDescription, '一句话。');
  assert.equal(d.draft!.profile.template.seed, true);
  assert.equal(d.profileMeta.voiceReferenceId, 'fish_ref_a');
  assert.deepEqual(d.draft!.profile.presentation.palette, [
    { hex: '#111111', name: '一', role: 'accent' },
    { hex: '#222222', name: '二', role: 'main' },
    { hex: '#333333', name: '三', role: 'accent' },
  ]);
  assert.equal(d.draft!.profile.presentation.color, '#222222');
  assert.ok(d.profileMeta.checklist.some((c) => c.text === '颜色 深海 没有色值，请在工作台选色（辅色）'));
});

test('B → C: 「Little Sheep」「X老师」「林青野」 are three addresses in order; unquoted 小羊/XX stays ONE', (t) => {
  const f = fixture(t);
  const b = templateFile(
    { 角色代码: 'BBB', 人设名称: '乙', '网页展示名／昵称': '乙', 欢迎词: '「嗯」', 陌生时的相处方式: '冷。' },
    [
      { code: 'CCC', addresses: '「Little Sheep」「X老师」「林青野」', attitude: '好。' },
      { code: 'DDD', addresses: '小羊/XX' },
    ],
  );
  const c = templateFile({
    角色代码: 'CCC',
    人设名称: '丙',
    '网页展示名／昵称': '丙',
    欢迎词: '「嗯」',
    陌生时的相处方式: '冷。',
  });
  const d = templateFile({
    角色代码: 'DDD',
    人设名称: '丁',
    '网页展示名／昵称': '丁',
    欢迎词: '「嗯」',
    陌生时的相处方式: '冷。',
  });
  run(f, files(['b.md', b], ['c.md', c], ['d.md', d]));
  const doc = readDraft(f.store).doc;
  const from = (to: string) => doc.directions.find((x) => x.from === idOf(f, 'BBB') && x.to === idOf(f, to))!;
  assert.deepEqual(
    from('CCC').addresses.map((x) => x.text),
    ['Little Sheep', 'X老师', '林青野'],
  );
  assert.deepEqual(
    from('DDD').addresses.map((x) => x.text),
    ['小羊/XX'],
  );
  // no material on C's side: no direction C → B
  assert.equal(
    doc.directions.some((x) => x.from === idOf(f, 'CCC')),
    false,
  );
});

test('aliases: all four kinds keep their kind and attitude; nothing goes to 演绎说明', (t) => {
  const f = fixture(t);
  const text = templateFile({
    角色代码: 'ALI',
    人设名称: '阿力',
    '网页展示名／昵称': '力',
    欢迎词: '「嗨」',
    陌生时的相处方式: '好。',
    自称: '「我」',
    '别名（含英文名）': '「Ali」「力哥」',
    中性称呼: '「阿力同学」',
    黑称: '「力大笨」',
  });
  run(f, files(['ali.md', text]));
  const c = card(f, idOf(f, 'ALI'));
  assert.deepEqual(
    c.identity.aliases.map((a) => [a.text, a.kind, a.attitude]),
    [
      ['我', 'self', 'likes'],
      ['Ali', 'other', 'likes'],
      ['力哥', 'other', 'likes'],
      ['阿力同学', 'neutral', 'ok'],
      ['力大笨', 'insult', 'dislikes'],
    ],
  );
  assert.equal(c.performance, '');
});

test('an old-format file imports with the 自称 checklist item; the same file again changes nothing', (t) => {
  const f = fixture(t);
  const old = templateFile(
    { 角色代码: 'OLD', 人设名称: '旧', '网页展示名／昵称': '旧', 欢迎词: '「嗯」', 陌生时的相处方式: '好。' },
    [],
    {
      omit: ['自称', '别名（含英文名）', '近况'],
      extra: { '1': ['- 自称与其他别名：「我」「Shen」'], '6': ['- 最近很忙'] },
    },
  );
  run(f, files(['old.md', old]));
  const d = detail(f, 'OLD');
  assert.deepEqual(
    d.profileMeta.checklist.map((c) => c.text),
    ['自称与别名未分开，请手动把自称移出'],
  );
  assert.deepEqual(
    card(f, idOf(f, 'OLD')).identity.aliases.map((a) => [a.text, a.kind]),
    [
      ['我', 'other'],
      ['Shen', 'other'],
    ],
  );
  assert.deepEqual(d.draft!.profile.template.authorCanon!.settings.background, [{ title: '近况', text: '最近很忙' }]);
  const before = rows(f);
  const again = preview(f, files(['old.md', old]));
  assert.equal(again.unchanged, true);
  assert.equal(again.characters[0]!.mode, 'existing');
  assert.equal(apply(f, files(['old.md', old]), again.basis).unchanged, true);
  assert.deepEqual(rows(f), before, 'no new revision, no cast revision, nothing written');
});

test('repeated import: 没有变化, no new revisions; a changed file changes only the changed field', (t) => {
  const f = fixture(t);
  const input = files(['syz.md', example()], ['lqy.md', LQY]);
  run(f, input);
  const before = rows(f);
  const p = preview(f, input);
  assert.equal(p.unchanged, true);
  assert.ok(p.characters.every((c) => c.unchanged && c.changes.length === 0 && c.castChanges.length === 0));
  const r = apply(f, input, p.basis);
  assert.equal(r.unchanged, true);
  assert.deepEqual(rows(f), before);

  const edited = files(['syz.md', example().replace('身高：181cm', '身高：182cm')], ['lqy.md', LQY]);
  const q = preview(f, edited);
  const facts = draftOf(f, 'SYZ').template.authorCanon!.settings.profileFacts as Record<string, string>;
  const lines = (o: Record<string, string>) =>
    Object.entries(o)
      .map(([k, v]) => `${k}：${v}`)
      .join('\n');
  assert.deepEqual(q.characters.find((c) => c.code === 'SYZ')!.changes, [
    { field: '其余设定 · profileFacts', old: lines(facts), new: lines({ ...facts, 身高: '182cm' }) },
  ]);
  assert.equal(q.characters.find((c) => c.code === 'LQY')!.unchanged, true);
  apply(f, edited, q.basis);
  assert.equal((draftOf(f, 'SYZ').template.authorCanon!.settings.profileFacts as Record<string, string>).身高, '182cm');
  assert.equal(f.store.all('SELECT 1 FROM web_character_revisions WHERE character_id=?', idOf(f, 'SYZ')).length, 2);
  assert.equal(f.store.all('SELECT 1 FROM web_character_revisions WHERE character_id=?', idOf(f, 'LQY')).length, 1);
});

test('empty values never clear an existing character, and a re-import fills only what the file now says', (t) => {
  const f = fixture(t);
  const full = templateFile({
    角色代码: 'KEP',
    人设名称: '留',
    '网页展示名／昵称': '留',
    欢迎词: '「嗯」',
    陌生时的相处方式: '好。',
    一句话描述: '原话。',
    生日: '2001-01-01',
    身高: '170cm',
  });
  run(f, files(['k.md', full]));
  const sparse = templateFile({ 角色代码: 'KEP', 人设名称: '留', 熟悉后的变化: '更好。' });
  const { p } = run(f, files(['k.md', sparse]));
  assert.deepEqual(
    p.characters[0]!.changes.map((c) => c.field),
    ['性格'],
  );
  const profile = draftOf(f, 'KEP');
  assert.equal(profile.presentation.publicDescription, '原话。');
  assert.equal(profile.template.birthDate, '2001-01-01');
  assert.equal(profile.presentation.welcomes[0]!.text, '嗯');
  assert.equal((profile.template.authorCanon!.settings.profileFacts as Record<string, string>).身高, '170cm');
  assert.equal(profile.template.persona, '陌生时的相处方式：好。\n熟悉后的变化：更好。');
});

test('the earlier cast-file drafts: matched by name, bound to codes, filled in place, no duplicate characters', (t) => {
  const f = fixture(t);
  const tx = (v: string) => [{ text: v }];
  const castFile = {
    format: 'burbur-cast',
    version: 1,
    schema: 2,
    world: { background: '' },
    characters: [
      {
        characterId: 'new:林小满',
        identity: { oneLiner: '美术生', names: tx('林小满'), aliases: [], selfConcept: '', prototype: null },
        profile: '',
        personality: '',
        speech: { catchphrases: [], samples: [], avoid: [] },
        experiences: [],
        performance: '',
        hidden: [],
        unmapped: '',
        workbench: { displayName: '小满', persona: '十九岁的美术生。', welcome: '嗨，我是小满。' },
      },
    ],
  };
  const imported = f.cast.importFile(f.ownerAuth, {
    requestId: f.request(),
    expectedRevision: readDraft(f.store).revision,
    file: castFile,
  });
  assert.equal(imported.created, 1);
  const earlier = f.store
    .all<{ character_id: string }>('SELECT character_id FROM web_character_drafts')
    .map((r) => r.character_id);
  assert.equal(earlier.length, 1);
  const text = templateFile({
    角色代码: 'LXM',
    人设名称: '林小满',
    '网页展示名／昵称': '满',
    欢迎词: '「嗨」',
    陌生时的相处方式: '开朗。',
    一句话描述: '学美术的女孩',
    生日: '2005-05-05',
  });
  const p = preview(f, files(['lxm.md', text]));
  assert.deepEqual([p.characters[0]!.mode, p.problems.length], ['bind', 0]);
  assert.equal(p.characters[0]!.changes[0]!.field, '角色代码');
  apply(f, files(['lxm.md', text]), p.basis);
  const after = f.store
    .all<{ character_id: string }>('SELECT character_id FROM web_character_drafts')
    .map((r) => r.character_id);
  assert.deepEqual(after, earlier, 'no duplicate character');
  assert.equal(idOf(f, 'LXM'), earlier[0]);
  assert.equal(draftOf(f, 'LXM').template.birthDate, '2005-05-05');
  assert.equal(readDraft(f.store).doc.characters.length, 1, 'the existing name card is filled in place');
  assert.equal(card(f, earlier[0]!).identity.oneLiner, '学美术的女孩');
});

test('the cast merge leaves an unrelated character, its directions, stories and memes byte-identical', (t) => {
  const f = fixture(t);
  const [x, y] = WEB_PROVIDER_CATALOG.map((c) => c.characterId);
  const cardFor = (id: string, name: string) => ({
    characterId: id,
    identity: {
      oneLiner: `${name}的一句话`,
      names: [{ text: name }],
      aliases: [{ text: '老乙', kind: 'insult', attitude: 'dislikes' }],
      selfConcept: '',
      prototype: null,
    },
    profile: '简介',
    personality: '性格',
    speech: { catchphrases: [{ text: '嗯' }], samples: [], avoid: [] },
    experiences: [],
    performance: '演绎',
    hidden: [{ text: '秘密' }],
    unmapped: '',
  });
  const doc = {
    schema: 2,
    world: { background: '世界。' },
    characters: [cardFor(x!, '甲角'), cardFor(y!, '乙角')],
    people: [{ id: 'new-p', kind: 'person', names: [{ text: '路人' }], oneLiner: '' }],
    ratings: { [x!]: { [y!]: 4 } },
    directions: [{ from: x, to: y, addresses: [{ text: '老乙' }, { text: '乙乙' }], treatment: '互损。' }],
    groups: [],
    stories: [
      {
        title: '旧事',
        summary: '摘要',
        details: '细节',
        period: { start: '2020', end: '' },
        participants: [x, y],
        boundary: '',
        overrides: [],
      },
    ],
    memes: [{ key: '老梗', parties: [x, y], meaning: '含义', trigger: '', prohibited: '' }],
  };
  f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: readDraft(f.store).revision, doc });
  // X gets a code by hand; the new file's relation points at it.
  f.characters.profileCodeSave(f.ownerAuth, x!, { code: 'XXA' });
  const before = readDraft(f.store).doc;
  const unrelated = (d: CastDoc) =>
    JSON.stringify([
      d.world,
      d.people,
      d.ratings,
      d.characters.find((c) => c.characterId === y),
      // Part 24m (named): the pair of the new file becomes a group of its own; every other group is untouched.
      d.groups.filter(
        (g) => !g.members.includes(d.characters.find((c) => c.identity.names[0]?.text === '新来')?.characterId ?? ''),
      ),
      d.directions.filter((r) => r.from === x && r.to === y),
      d.stories.filter((s) => s.title === '旧事'),
      d.memes.filter((m) => m.key === '老梗'),
    ]);
  const mine = templateFile(
    { 角色代码: 'NEW', 人设名称: '新来', '网页展示名／昵称': '新', 欢迎词: '「嗨」', 陌生时的相处方式: '好。' },
    [{ code: 'xxa', cp: '新旧', addresses: '「甲甲」', attitude: '尊敬。', shared: '初见。' }],
  );
  run(f, files(['new.md', mine]));
  const after = readDraft(f.store).doc;
  assert.equal(unrelated(after), unrelated(before));
  assert.equal(
    JSON.stringify(after.characters.find((c) => c.characterId === x)),
    JSON.stringify(before.characters.find((c) => c.characterId === x)),
    'X is not an imported character: its card is untouched',
  );
  assert.equal(after.characters.length, 3);
  assert.equal(after.directions.length, 2);
  assert.equal(after.directions[1]!.to, x, 'the code resolved to a character already in the cast');
  // Part 24m (named): the new pair is a group, not a story or a meme; the old 旧事 and 老梗 stay as they were.
  assert.equal(after.stories.length, 1);
  assert.equal(after.memes.length, 1);
  assert.equal(after.groups.length, 1);
});

// Part 24l (named exception): the over-limit alias is now 26 units (the cap is 25, was 16).
test('errors are located and nothing is written: duplicate codes, a bad date, two （主）, an over-limit item, a missing field', (t) => {
  const f = fixture(t);
  const ok = (code: string, extra: Record<string, string> = {}) =>
    templateFile({
      角色代码: code,
      人设名称: `名${code}`,
      '网页展示名／昵称': '名',
      欢迎词: '「嗨」',
      陌生时的相处方式: '好。',
      ...extra,
    });
  const before = rows(f);
  const cases: [string, { name: string; text: string }[], string, string | null][] = [
    ['duplicate code', files(['a.md', ok('DUP')], ['b.md', ok('dup')]), 'PROFILE_CODE_DUPLICATE', '角色代码'],
    ['bad date', files(['a.md', ok('AAA', { 生日: '2000-13-01' })]), 'PROFILE_BIRTH_INVALID', '生日'],
    [
      'two main',
      files(['a.md', ok('AAA', { 角色主色: '「#111111 一（主）」「#222222 二（主）」' })]),
      'PROFILE_COLOUR_MAIN_REPEATED',
      '角色主色',
    ],
    [
      'over limit',
      files(['a.md', ok('AAA', { 自称: '「0123456789abcdefghijklmnopq」' })]),
      'CAST_ITEM_TOO_LONG',
      '自称',
    ],
    [
      'missing field',
      files(['a.md', templateFile({ 角色代码: 'AAA' }, [], { omit: ['身高'] })]),
      'PROFILE_MISSING_FIELD',
      '身高',
    ],
  ];
  for (const [label, input, code, field] of cases) {
    const p = preview(f, input);
    assert.equal(p.ok, false, label);
    const found = p.problems.find((x) => x.code === code);
    assert.ok(found, `${label}: ${JSON.stringify(p.problems)}`);
    assert.ok(found.file.endsWith('.md'), label);
    assert.equal(found.field, field, label);
    refused(() => apply(f, input, p.basis), 'PROFILE_IMPORT_INVALID');
  }
  assert.deepEqual(rows(f), before, 'nothing was written by any of them');
  // one bad file blocks the good one next to it
  const mixed = files(['good.md', ok('GOOD')], ['bad.md', ok('BAD', { 生日: 'x' })]);
  const p = preview(f, mixed);
  assert.deepEqual(
    p.problems.map((x) => x.file),
    ['bad.md'],
  );
  refused(() => apply(f, mixed, p.basis), 'PROFILE_IMPORT_INVALID');
  assert.deepEqual(rows(f), before);
});

test('a name that matches two characters without a code, or a deleted/duplicate bind, is an error, not a guess', (t) => {
  const f = fixture(t);
  const dup = WEB_PROVIDER_CATALOG[0]!.displayName;
  f.store.run('UPDATE character_templates SET config_json=? WHERE id=?', JSON.stringify({ id: 'x' }), 'c-none-0');
  const text = templateFile({
    角色代码: 'CAT',
    人设名称: dup,
    '网页展示名／昵称': 'x',
    欢迎词: '「嗨」',
    陌生时的相处方式: '好。',
  });
  const p = preview(f, files(['cat.md', text]));
  // one live catalog character with that name and no code: it is offered for binding
  assert.equal(p.characters[0]!.mode, 'bind');
  // a second file claiming the same character is refused
  const two = files(['cat.md', text], ['cat2.md', text.replace('CAT', 'CAU')]);
  const q = preview(f, two);
  assert.ok(q.problems.some((x) => x.code === 'PROFILE_NAME_AMBIGUOUS' && x.file === 'cat2.md'));
});

test('permissions: checked before the body; new needs characters.create, existing needs edit, the cast merge needs cast.edit', (t) => {
  const f = fixture(t);
  const input = files(['lqy.md', LQY]);
  // none of the three: refused before the body is looked at
  const nobody = f.staff(['characters.read:*'], 'reader');
  refused(() => f.characters.profileImportPreview(nobody, 'not even an object'), 'ADMIN_PERMISSION_REQUIRED');
  const noCast = f.staff(['characters.create', 'characters.edit:*'], 'nocast');
  refused(() => preview(f, input, noCast), 'ADMIN_PERMISSION_REQUIRED');
  // cast.edit and characters.create: a new character is fine
  const creator = f.staff(['cast.edit', 'characters.create'], 'creator');
  const p = preview(f, input, creator);
  assert.deepEqual(p.problems, []);
  apply(f, input, p.basis, creator);
  // the same file again is for an EXISTING character: creating is not enough
  const edited = files(['lqy.md', LQY.replace('爱笑。', '爱哭。')]);
  const q = preview(f, edited, creator);
  assert.ok(q.problems.some((x) => x.code === 'ADMIN_PERMISSION_REQUIRED' && x.file === 'lqy.md'));
  refused(() => apply(f, edited, q.basis, creator), 'PROFILE_IMPORT_INVALID');
  const editor = f.staff(['cast.edit', 'characters.edit:*'], 'editor');
  const r = preview(f, edited, editor);
  assert.deepEqual(r.problems, []);
  // an editor may not create: a new code in the same batch is refused
  const mixed = files(
    ['lqy.md', LQY],
    [
      'n.md',
      templateFile({
        角色代码: 'NNN',
        人设名称: '嗯',
        '网页展示名／昵称': '嗯',
        欢迎词: '「嗨」',
        陌生时的相处方式: '好。',
      }),
    ],
  );
  assert.ok(
    preview(f, mixed, editor).problems.some((x) => x.file === 'n.md' && x.code === 'ADMIN_PERMISSION_REQUIRED'),
  );
});

test('optimistic: an edit after the preview is a conflict, nothing is written; the same request id answers once', (t) => {
  const f = fixture(t);
  const input = files(['lqy.md', LQY]);
  run(f, input);
  const edited = files(['lqy.md', LQY.replace('爱笑。', '爱哭。')]);
  const p = preview(f, edited);
  const id = idOf(f, 'LQY');
  const current = f.characters.detail(f.ownerAuth, id).draft!;
  const profile = structuredClone(current.profile);
  profile.presentation.publicDescription = '别人改的';
  f.characters.save(f.ownerAuth, id, { expectedRevision: current.revision, profile });
  const before = rows(f);
  refused(() => apply(f, edited, p.basis), 'PROFILE_IMPORT_CONFLICT');
  assert.deepEqual(rows(f), before);
  // after a fresh preview it goes through, and a repeat of the same request id writes nothing more
  const q = preview(f, edited);
  const requestId = f.request();
  const first = apply(f, edited, q.basis, f.ownerAuth, requestId);
  const mid = rows(f);
  const second = apply(f, edited, q.basis, f.ownerAuth, requestId);
  assert.equal(second.duplicate, true);
  assert.deepEqual(rows(f), mid);
  assert.equal(first.unchanged, false);
  assert.equal(
    draftOf(f, 'LQY').presentation.publicDescription,
    '别人改的',
    'the import never touched the field the file leaves empty',
  );
  assert.ok(draftOf(f, 'LQY').template.persona.includes('爱哭'));
});

test('an existing live character: the import makes a draft revision on the live version and never publishes', (t) => {
  const f = fixture(t);
  const live = WEB_PROVIDER_CATALOG[0]!;
  const text = templateFile({
    角色代码: 'LIV',
    人设名称: live.displayName,
    欢迎词: '「新欢迎」',
    陌生时的相处方式: '新的。',
    身高: '170cm',
  });
  const catalogBefore = f.store.all('SELECT * FROM web_character_catalog ORDER BY position');
  const p = preview(f, files(['liv.md', text]));
  assert.equal(p.characters[0]!.mode, 'bind');
  apply(f, files(['liv.md', text]), p.basis);
  const d = f.characters.detail(f.ownerAuth, live.characterId);
  assert.equal(d.draft!.baseVersion, 1);
  assert.equal(d.draft!.profile.template.version, 2);
  assert.equal(d.published!.version, 1, 'the live version is untouched');
  assert.deepEqual(f.store.all('SELECT * FROM web_character_catalog ORDER BY position'), catalogBefore);
  // Part 24k-2 (named exception): the welcome has no version any more; an import that gives none leaves the single line as it was.
  assert.deepEqual(
    d.draft!.profile.presentation.welcomes.map((line) => line.weight),
    [100],
  );
  assert.equal(d.draft!.profile.presentation.displayName, live.displayName, 'empty 网页展示名 leaves the current one');
  assert.equal(f.store.all('SELECT 1 FROM web_character_publications').length, 0);
});

test('角色代码: unique case-insensitively, editable by hand, shape checked; a held code cannot be taken', (t) => {
  const f = fixture(t);
  run(f, files(['lqy.md', LQY]));
  const id = idOf(f, 'LQY');
  refused(
    () => f.characters.profileCodeSave(f.ownerAuth, WEB_PROVIDER_CATALOG[0]!.characterId, { code: 'lqy' }),
    'PROFILE_CODE_TAKEN',
  );
  refused(() => f.characters.profileCodeSave(f.ownerAuth, id, { code: 'a' }), 'INVALID_PROFILE_CODE');
  refused(() => f.characters.profileCodeSave(f.ownerAuth, id, { code: 'has space' }), 'INVALID_PROFILE_CODE');
  const saved = f.characters.profileCodeSave(f.ownerAuth, id, { code: 'Lqy2' });
  assert.equal(saved.code, 'Lqy2');
  assert.equal(
    f.characters.profileCodeSave(f.ownerAuth, id, { code: 'LQY2' }).code,
    'LQY2',
    'only the character holding it may change its case',
  );
  // the importer follows the new code
  const p = preview(f, files(['x.md', LQY.replace('角色代码：LQY', '角色代码：lqy2')]));
  assert.equal(p.characters[0]!.mode, 'existing');
  // permission: edit on that character
  const reader = f.staff(['characters.read:*'], 'reader2');
  refused(() => f.characters.profileCodeSave(reader, id, { code: 'RRR' }), 'ADMIN_PERMISSION_REQUIRED');
});

test('the checklist stays until dismissed; a re-import with the item resolved removes it; dismissed items stay dismissed', (t) => {
  const f = fixture(t);
  const text = templateFile({
    角色代码: 'CHK',
    人设名称: '清',
    '网页展示名／昵称': '清',
    欢迎词: '「一」\n「二」',
    陌生时的相处方式: '好。',
    '头像／形象图片文件': 'chk.png',
  });
  run(f, files(['chk.md', text]));
  const id = idOf(f, 'CHK');
  // Part 24k-2 (named exception): the import no longer makes a 「欢迎词 第 2 条 等 24k」 item; a character imported BEFORE 24k-2 still has
  // one stored, and the re-import below resolves it. That old item is put back by hand here, as the earlier import would have left it.
  assert.equal(f.characters.detail(f.ownerAuth, id).profileMeta.checklist.length, 1);
  f.store.run(
    "INSERT INTO web_profile_checklist(character_id,item_key,item_text,state,created_at) VALUES (?,?,?,'open',1)",
    id,
    'welcome:2',
    '欢迎词 第 2 条 等 24k 多欢迎词',
  );
  assert.equal(f.characters.detail(f.ownerAuth, id).profileMeta.checklist.length, 2);
  const dismissed = f.characters.profileChecklistDismiss(f.ownerAuth, id, { key: 'welcome:2' });
  // every answer of the three calls has the one shape the console's strict client reads (it once lacked `available`)
  assert.deepEqual(Object.keys(dismissed).sort(), Object.keys(f.characters.detail(f.ownerAuth, id).profileMeta).sort());
  assert.equal(dismissed.available, true);
  assert.deepEqual(
    dismissed.checklist.map((c) => [c.key, c.state]),
    [
      ['avatar:chk.png', 'open'],
      ['welcome:2', 'dismissed'],
    ],
  );
  refused(() => f.characters.profileChecklistDismiss(f.ownerAuth, id, { key: 'nope' }), 'NOT_FOUND');
  // Part 24k-2: a re-import of the same file resolves the old welcome item (the item is dropped whether it was open or dismissed);
  // the avatar item, which the file still asks for, stays as it was.
  const q = preview(f, files(['chk.md', text]));
  apply(f, files(['chk.md', text]), q.basis);
  assert.deepEqual(
    f.characters.detail(f.ownerAuth, id).profileMeta.checklist.map((c) => c.key),
    ['avatar:chk.png'],
  );
});

test('the schema step is idempotent and digest-checked; the tables hold no player, world or operation id', (t) => {
  const f = fixture(t);
  installProfileImport(f.store);
  installProfileImport(f.store);
  assert.equal(f.store.all('SELECT * FROM web_profile_schema').length, 1);
  for (const table of ['web_profile_codes', 'web_profile_checklist'])
    assert.equal(
      f.store
        .all<{ name: string }>(`PRAGMA table_info(${table})`)
        .some((c) => /world_id|operation_id|player|principal/.test(c.name)),
      false,
    );
  // a different digest is a mismatch, not a silent upgrade
  f.store.run("UPDATE web_profile_schema SET sha256='x'");
  assert.throws(
    () => installProfileImport(f.store),
    (e: Error & { code?: string }) => e.code === 'WEB_PROFILE_SCHEMA_MISMATCH',
  );
  // the table refuses two codes that differ only in case
  const g = fixture(t);
  g.store.run("INSERT INTO web_profile_codes VALUES ('a','Ab','ab',NULL,NULL,1,1)");
  assert.throws(() => g.store.run("INSERT INTO web_profile_codes VALUES ('b','AB','ab',NULL,NULL,1,1)"));
  assert.throws(() => g.store.run("INSERT INTO web_profile_codes VALUES ('c','a b','a b',NULL,NULL,1,1)"));
});

test('profileFacts and boundaries reach the chat prompt input, with the boundary rules in the prompt', (t) => {
  const f = fixture(t);
  run(f, files(['syz.md', example()]));
  const settings = draftOf(f, 'SYZ').template.authorCanon!.settings;
  const request = textRequest();
  request.character = { ...request.character, authorCanon: { kind: 'author_canon', settings } } as never;
  const messages = promptMessages(request);
  const user = JSON.parse(messages.at(-1)!.content as string) as {
    character: { authorCanon: { settings: Record<string, unknown> } };
  };
  assert.deepEqual(user.character.authorCanon.settings.profileFacts, settings.profileFacts);
  assert.deepEqual(user.character.authorCanon.settings.boundaries, settings.boundaries);
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content as string)
    .join('\n');
  for (const rule of [
    'authorCanon.profileFacts是本人的既定事实',
    '知道但不会说出口的事',
    '绝不直接说出口',
    '不可改变的核心设定',
    '不应擅自补充的事实',
    '不符合角色的行为·表达',
  ])
    assert.ok(system.includes(rule), rule);
});

test("the import writes through the draft path only: the draft passes the workbench's own save checks (version, hash, template)", (t) => {
  const f = fixture(t);
  run(f, files(['syz.md', example()]));
  const id = idOf(f, 'SYZ');
  const draft = f.characters.detail(f.ownerAuth, id).draft!;
  // saving the imported profile back through save() is accepted unchanged (open → save is a no-op)
  const again = f.characters.save(f.ownerAuth, id, { expectedRevision: draft.revision, profile: draft.profile });
  assert.equal(again.contentHash, draft.contentHash);
  assert.equal(again.revision, draft.revision);
  assert.equal(canonicalCastJson(readDraft(f.store).doc).length > 0, true);
});

// ---- Part 24l addenda ------------------------------------------------------------------------------------------------------

test('24l a 133-character 一句话描述 imports whole into the public description, the card keeps its one-liner, and the checklist says so', (t) => {
  const f = fixture(t);
  const long = '长'.repeat(133);
  const file = templateFile({
    角色代码: 'LONG',
    人设名称: '长简介',
    '网页展示名／昵称': '长',
    一句话描述: long,
    欢迎词: '「嗨」',
    陌生时的相处方式: '好。',
  });
  const p = preview(f, files(['long.md', file]));
  assert.deepEqual(p.problems, [], 'no longer an error');
  apply(f, files(['long.md', file]), p.basis);
  const d = detail(f, 'LONG');
  assert.equal(d.draft!.profile.presentation.publicDescription, long, 'whole, not cut');
  assert.equal(card(f, idOf(f, 'LONG')).identity.oneLiner, '', 'the name card is left as it was');
  assert.ok(d.profileMeta.checklist.some((c) => c.text === '名片一句话待填（一句话描述超过 40 字）'));
  // 名片一句话 given: it is the card's one-liner; 一句话描述 stays the public description
  const next = templateFile({
    角色代码: 'LONG',
    人设名称: '长简介',
    '网页展示名／昵称': '长',
    一句话描述: long,
    名片一句话: '爱讲长故事的人',
    欢迎词: '「嗨」',
    陌生时的相处方式: '好。',
  });
  const q = preview(f, files(['long.md', next]));
  assert.deepEqual(q.problems, []);
  apply(f, files(['long.md', next]), q.basis);
  assert.equal(card(f, idOf(f, 'LONG')).identity.oneLiner, '爱讲长故事的人');
  assert.equal(detail(f, 'LONG').draft!.profile.presentation.publicDescription, long);
});

test('24l 名片一句话 of 40 passes and 41 fails located; an old file without the field still imports', (t) => {
  const f = fixture(t);
  const make = (card: string | undefined) =>
    templateFile({
      角色代码: 'CARD',
      人设名称: '名片',
      '网页展示名／昵称': '名',
      ...(card === undefined ? {} : { 名片一句话: card }),
      欢迎词: '「嗨」',
      陌生时的相处方式: '好。',
    });
  const ok = files(['c.md', make('卡'.repeat(40))]);
  assert.deepEqual(preview(f, ok).problems, []);
  const bad = preview(f, files(['c.md', make('卡'.repeat(41))]));
  assert.equal(bad.ok, false);
  const found = bad.problems.find((x) => x.code === 'PROFILE_TOO_LONG')!;
  assert.deepEqual([found.file, found.section, found.field], ['c.md', '1 基本信息', '名片一句话']);
  const old = files(['c.md', make(undefined)]);
  assert.deepEqual(preview(f, old).problems, []);
});

test('24l a 273-character shared history imports whole as the story summary; one name may be a 别名 and a 黑称 and shows only under doNotCall in others’ cards', (t) => {
  const f = fixture(t);
  const history = '一起'.repeat(136) + '。';
  assert.equal(history.length, 273);
  const mine = templateFile(
    {
      角色代码: 'LQY',
      人设名称: '林青野',
      '网页展示名／昵称': '青野',
      '别名（含英文名）': '「小野」',
      黑称: '「小野」「野猴」',
      欢迎词: '「嗨」',
      陌生时的相处方式: '爱笑。',
    },
    [{ code: 'SYZ', cp: '旧巷双人组', addresses: '「阿舟」', attitude: '朋友。', shared: history }],
  );
  const { p } = run(f, files(['syz.md', example()], ['lqy.md', mine]));
  assert.deepEqual(p.problems, []);
  const doc = readDraft(f.store).doc;
  // Part 24m (named): the pair's shared history is the story of the pair's group.
  const story = doc.groups.flatMap((g) => g.stories).find((s) => s.summary.includes('一起'))!;
  assert.equal(story.summary, history, 'whole, as the summary');
  const lqy = card(f, idOf(f, 'LQY'));
  assert.deepEqual(
    lqy.identity.aliases.map((a) => [a.text, a.kind]).sort(),
    [
      ['小野', 'insult'],
      ['小野', 'other'],
      ['野猴', 'insult'],
    ].sort(),
  );
  const view = compileCastView(doc, idOf(f, 'SYZ'));
  const seen = view.others.find((o) => o.name === '林青野')!;
  assert.ok(!seen.aliases.includes('小野'), 'a 黑称 is never offered as a usable name');
  assert.deepEqual(seen.doNotCall?.items.sort(), ['小野', '野猴']);
});

// ---- Part 24m: each relation pair is a group ---------------------------------------------------------------------------------
test('24m a relation pair is one group: named by the CP名 or 「A与B」, its story is the shared history, re-import finds the same group by its exact pair', (t) => {
  const f = fixture(t);
  const a = (cp: string, shared: string) =>
    templateFile(
      { 角色代码: 'AAA', 人设名称: '甲', '网页展示名／昵称': '甲', 欢迎词: '「嗨」', 陌生时的相处方式: '好。' },
      [{ code: 'BBB', cp, addresses: '「乙乙」', attitude: '尊敬。', shared }],
    );
  const b = templateFile(
    { 角色代码: 'BBB', 人设名称: '乙', '网页展示名／昵称': '乙', 欢迎词: '「嗨」', 陌生时的相处方式: '好。' },
    [{ code: 'AAA', addresses: '「甲甲」', attitude: '随意。', shared: '' }],
  );
  // no CP名 at all: 「A与B」
  run(f, files(['a.md', a('', '同桌。')], ['b.md', b]));
  let cast = readDraft(f.store).doc;
  const [ida, idb] = [idOf(f, 'AAA'), idOf(f, 'BBB')];
  assert.equal(cast.groups.length, 1);
  assert.equal(cast.groups[0]!.name, '甲与乙');
  assert.deepEqual(cast.groups[0]!.members, [ida, idb]);
  assert.deepEqual([cast.stories.length, cast.memes.length], [0, 0], 'no story of the cast and no meme');
  assert.deepEqual(cast.ratings, {}, 'ratings are never written');
  const groupId = cast.groups[0]!.id;
  // the same files again: nothing changes
  const again = preview(f, files(['a.md', a('', '同桌。')], ['b.md', b]));
  assert.equal(again.unchanged, true);
  // a CP名 names the same group (found by its exact member pair), it does not make a second one
  run(f, files(['a.md', a('甲乙组', '同桌。')]));
  cast = readDraft(f.store).doc;
  assert.equal(cast.groups.length, 1);
  assert.equal(cast.groups[0]!.id, groupId);
  assert.equal(cast.groups[0]!.name, '甲乙组');
  assert.equal(cast.groups[0]!.stories.length, 1);
  assert.equal(cast.groups[0]!.stories[0]!.title, '甲与乙');
  // the longest CP名 the template allows (24) is a valid group name (the cap is 30 now, so 「A与B」 of two 12-character names fits too)
  assert.deepEqual(preview(f, files(['a.md', a('字'.repeat(24), '同桌。')])).problems, []);
});

test('24m an earlier import’s story and meme for the pair are replaced by the group; nothing else is touched', (t) => {
  const f = fixture(t);
  const a = templateFile(
    { 角色代码: 'AAA', 人设名称: '甲', '网页展示名／昵称': '甲', 欢迎词: '「嗨」', 陌生时的相处方式: '好。' },
    [{ code: 'BBB', cp: '甲乙组', addresses: '「乙乙」', attitude: '尊敬。', shared: '同桌。' }],
  );
  const b = templateFile({
    角色代码: 'BBB',
    人设名称: '乙',
    '网页展示名／昵称': '乙',
    欢迎词: '「嗨」',
    陌生时的相处方式: '好。',
  });
  const c = templateFile({
    角色代码: 'CCC',
    人设名称: '丙',
    '网页展示名／昵称': '丙',
    欢迎词: '「嗨」',
    陌生时的相处方式: '好。',
  });
  run(f, files(['a.md', a], ['b.md', b], ['c.md', c]));
  const [ida, idb, idc] = [idOf(f, 'AAA'), idOf(f, 'BBB'), idOf(f, 'CCC')];
  // Put the entries a 24j import used to make for this pair, plus look-alikes that must survive.
  const doc = structuredClone(readDraft(f.store).doc);
  const story = (title: string, participants: string[]) => ({
    title,
    summary: '旧',
    details: '旧',
    period: { start: '', end: '' },
    participants,
    boundary: '',
    overrides: [],
  });
  // The ids are given by the cast's own normalizer when it saves.
  doc.stories.push(
    ...([
      story('甲与乙', [ida, idb]),
      story('甲与乙', [ida, idb, idc]),
      story('别的故事', [ida, idb]),
    ] as unknown as CastDoc['stories']),
  );
  doc.memes.push(
    ...([
      { key: '甲乙组', parties: [ida, idb], meaning: '甲乙组', trigger: '', prohibited: '' },
      { key: '另一个梗', parties: [ida, idb], meaning: '含义', trigger: '', prohibited: '' },
    ] as unknown as CastDoc['memes']),
  );
  doc.groups = [];
  f.cast.save(f.ownerAuth, { requestId: f.request(), expectedRevision: readDraft(f.store).revision, doc });
  run(f, files(['a.md', a.replace('同桌。', '同桌，一起值日。')], ['b.md', b]));
  const after = readDraft(f.store).doc;
  assert.deepEqual(
    after.stories.map((s) => [s.title, s.participants.length]),
    [
      ['甲与乙', 3],
      ['别的故事', 2],
    ],
    'only the story titled 「A与B」 with exactly [A, B] is replaced',
  );
  assert.deepEqual(
    after.memes.map((m) => m.key),
    ['另一个梗'],
    'only the meme keyed by the CP名 with exactly [A, B] is replaced',
  );
  assert.equal(after.groups.length, 1);
  assert.equal(after.groups[0]!.name, '甲乙组');
  assert.match(after.groups[0]!.stories[0]!.details, /同桌，一起值日/);
});
