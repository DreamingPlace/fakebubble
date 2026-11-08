// Part 24k-2 (named exception): the welcome fixtures/assertions in this file moved from welcome {text,version} to welcomes [{id,text,weight}]; nothing else was changed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { addressItems, listItems, readTemplateFile } from '../../../apps/server/characters/profile-template.ts';
import { templateFile } from '../fixtures/profile-template.ts';

const base = (extra: Record<string, string> = {}) => ({ 角色代码: 'ABC', 人设名称: '阿贝', ...extra });
const read = (
  values: Record<string, string>,
  relations = [] as Parameters<typeof templateFile>[1],
  options?: Parameters<typeof templateFile>[2],
) => readTemplateFile('abc.md', templateFile(values, relations, options));
const only = (
  values: Record<string, string>,
  relations?: Parameters<typeof templateFile>[1],
  options?: Parameters<typeof templateFile>[2],
) => {
  const { profile, problems } = read(values, relations, options);
  assert.deepEqual(problems, []);
  return profile!;
};

test('the example file reads without a problem, and 2000-11-02 is in the birthday and the core setting', () => {
  const { profile, problems } = readTemplateFile(
    'example.md',
    readFileSync(new URL('../../../examples/character-template.example.md', import.meta.url), 'utf8'),
  );
  assert.deepEqual(problems, []);
  assert.equal(profile!.birthDate, '2000-11-02');
  assert.ok(profile!.boundaries['不可改变的核心设定']!.startsWith('2000-11-02 生'));
  assert.equal(profile!.facts['学校-年级'], undefined, '学校-年级 is empty: no material');
});

test('list fields: 「」 items or 、; spaces inside an item are kept; stray text outside 「」 is refused', () => {
  assert.deepEqual(listItems('「Little Sheep」「X老师」「林青野」').items, ['Little Sheep', 'X老师', '林青野']);
  assert.deepEqual(listItems('甲、乙 丙、丁').items, ['甲', '乙 丙', '丁']);
  assert.deepEqual(listItems('「甲」、「乙」').stray, null);
  assert.equal(listItems('「甲」和「乙」').stray, '和');
  assert.equal(listItems('「甲').stray, '「甲');
});

test('称呼: text without 「」 is ONE item as written; never split on / 、 or spaces', () => {
  assert.deepEqual(addressItems('小羊/XX').items, ['小羊/XX']);
  assert.deepEqual(addressItems('小羊、XX 老师').items, ['小羊、XX 老师']);
  assert.deepEqual(addressItems('「Little Sheep」「X老师」').items, ['Little Sheep', 'X老师']);
  assert.deepEqual(addressItems('').items, []);
});

test('empty values are no material: nothing is invented, and every list is empty', () => {
  const p = only(base());
  assert.equal(p.birthDate, '');
  assert.deepEqual(
    [p.selfNames, p.aliases, p.neutralNames, p.insultNames, p.welcome, p.palette],
    [[], [], [], [], [], []],
  );
  assert.equal(p.seed, null);
  assert.deepEqual([p.persona, p.speech, p.background], [[], [], []]);
  assert.deepEqual([p.facts, p.boundaries], [{}, {}]);
});

test('colours: the （主） item is main; the rest are accents; a colour without a hex is not stored and goes to the checklist', () => {
  const p = only(base({ 角色主色: '「#111111 一」「#222222 二（主）」「#333333 三」「深海」' }));
  assert.deepEqual(
    p.palette.map((c) => [c.hex, c.name, c.role]),
    [
      ['#111111', '一', 'accent'],
      ['#222222', '二', 'main'],
      ['#333333', '三', 'accent'],
    ],
  );
  assert.deepEqual(p.checklist, [{ key: 'colour:4:深海', text: '颜色 深海 没有色值，请在工作台选色（辅色）' }]);
  // a single unmarked colour is the main one
  assert.equal(only(base({ 角色主色: '「#abcdef 淡」' })).palette[0]!.role, 'main');
  assert.equal(only(base({ 角色主色: '「#abcdef 淡」' })).palette[0]!.hex, '#ABCDEF');
});

test('colours: two （主） and no （主） with several colours are located errors', () => {
  for (const [value, code] of [
    ['「#111111 一（主）」「#222222 二（主）」', 'PROFILE_COLOUR_MAIN_REPEATED'],
    ['「#111111 一」「#222222 二」', 'PROFILE_COLOUR_MAIN_MISSING'],
    ['「#12 一」', 'PROFILE_COLOUR_INVALID'],
  ] as const) {
    const { profile, problems } = read(base({ 角色主色: value }));
    assert.equal(profile, null);
    assert.equal(problems[0]!.code, code);
    assert.deepEqual(
      [problems[0]!.file, problems[0]!.section, problems[0]!.field],
      ['abc.md', '2 展示与欢迎内容', '角色主色'],
    );
  }
});

// Part 24k-2 (named exception): the second and later welcome lines are real lines now, not checklist items.
test('welcome lines: every line is read and none is left on the checklist', () => {
  const p = only(base({ 欢迎词: '「甲」\n「乙」\n「丙」' }));
  assert.deepEqual(p.welcome, ['甲', '乙', '丙']);
  assert.deepEqual(
    p.checklist.map((c) => c.text),
    [],
  );
});

test('the avatar file is recorded by name only (checklist), a path is refused', () => {
  assert.deepEqual(only(base({ '头像／形象图片文件': 'a.png' })).checklist, [
    { key: 'avatar:a.png', text: '头像 a.png 待 25e 上传' },
  ]);
  assert.equal(read(base({ '头像／形象图片文件': '../a.png' })).problems[0]!.code, 'PROFILE_AVATAR_INVALID');
});

test('old format: 自称与其他别名 is read as 别名 with the checklist item; an unlabelled section-6 bullet is 近况', () => {
  const p = only(base(), [], {
    omit: ['自称', '别名（含英文名）', '近况'],
    extra: { '1': ['- 自称与其他别名：「我」「Shen」'], '6': ['- 最近在忙期末'] },
  });
  assert.equal(p.oldAliases, true);
  assert.deepEqual([p.selfNames, p.aliases], [[], ['我', 'Shen']]);
  assert.ok(p.checklist.some((c) => c.text === '自称与别名未分开，请手动把自称移出'));
  assert.deepEqual(p.background, [{ title: '近况', text: '最近在忙期末' }]);
});

test('an unknown, a missing, a renamed field, a missing section and a duplicate section are located problems', () => {
  const unknown = read(base(), [], { extra: { '1': ['- 年龄：18'] } });
  assert.equal(unknown.problems[0]!.code, 'PROFILE_UNKNOWN_FIELD');
  assert.deepEqual([unknown.problems[0]!.section, unknown.problems[0]!.field], ['1 基本信息', '年龄']);
  const missing = read(base(), [], { omit: ['身高'] });
  assert.deepEqual(
    [missing.problems[0]!.code, missing.problems[0]!.section, missing.problems[0]!.field],
    ['PROFILE_MISSING_FIELD', '1 基本信息', '身高'],
  );
  const renamed = readTemplateFile('a.md', templateFile(base()).replace('- 宠物：', '- 宠物们：'));
  assert.deepEqual(
    renamed.problems.map((p) => [p.code, p.field]),
    [
      ['PROFILE_UNKNOWN_FIELD', '宠物们'],
      ['PROFILE_MISSING_FIELD', '宠物'],
    ],
  );
  assert.equal(read(base(), [], { without: [8] }).problems[0]!.code, 'PROFILE_MISSING_SECTION');
  assert.equal(
    readTemplateFile('a.md', `${templateFile(base())}\n## 1 基本信息\n`).problems[0]!.code,
    'PROFILE_DUPLICATE_SECTION',
  );
});

test('birthday, code, seed and voice id errors carry their field', () => {
  const field = (values: Record<string, string>) => read(base(values)).problems[0]!;
  assert.deepEqual(
    [field({ 生日: '2000-02-30' }).code, field({ 生日: '2000-02-30' }).field],
    ['PROFILE_BIRTH_INVALID', '生日'],
  );
  assert.equal(field({ 角色代码: 'A' }).code, 'PROFILE_CODE_INVALID');
  assert.equal(field({ 角色代码: '' }).code, 'PROFILE_CODE_REQUIRED');
  assert.equal(field({ 是否为成长中角色: '也许' }).code, 'PROFILE_SEED_INVALID');
  assert.equal(field({ '音色模型 ID（Fish Audio）': 'a b' }).code, 'PROFILE_VOICE_ID_INVALID');
  assert.equal(only(base({ 是否为成长中角色: '是' })).seed, true);
  assert.equal(only(base({ 是否为成长中角色: '否' })).seed, false);
});

// Part 24l (named exception): the alias cap is 25 (was 16) and 一句话描述 is checked against 500 (was 40); 名片一句话 holds the 40.
test('over-limit items are refused with the item number, never cut: alias 26, 名片一句话 41, 称呼 17, a persona line 2001', () => {
  const alias = read(base({ 自称: `「一」「${'字'.repeat(26)}」` })).problems[0]!;
  assert.deepEqual([alias.code, alias.field, alias.item], ['CAST_ITEM_TOO_LONG', '自称', 2]);
  const card = read(base({ 名片一句话: 'x'.repeat(41) })).problems[0]!;
  assert.deepEqual([card.code, card.field], ['PROFILE_TOO_LONG', '名片一句话']);
  assert.equal(read(base({ 一句话描述: 'x'.repeat(501) })).problems[0]!.code, 'PROFILE_TOO_LONG');
  const address = read(base(), [{ code: 'XY', addresses: '「甲」「0123456789abcdefg」' }]).problems[0]!;
  assert.deepEqual([address.code, address.field, address.item], ['CAST_ITEM_TOO_LONG', '本角色如何称呼对方', 2]);
  assert.equal(read(base({ 熟悉后的变化: 'x'.repeat(2001) })).problems[0]!.code, 'PROFILE_TOO_LONG');
  assert.equal(read(base({ 自称: '「 甲」' })).problems[0]!.code, 'CAST_ITEM_EDGE_SPACE');
});

test('relation blocks are identified by 对方角色代码: the number means nothing; a repeat or the character itself is an error', () => {
  const a = only(base(), [
    { code: 'XY', addresses: '小羊/XX' },
    { code: 'ZW', addresses: '「Little Sheep」「X老师」「林青野」' },
  ]);
  assert.deepEqual(
    a.relations.map((r) => [r.code, r.addresses]),
    [
      ['XY', ['小羊/XX']],
      ['ZW', ['Little Sheep', 'X老师', '林青野']],
    ],
  );
  assert.equal(read(base(), [{ code: 'XY' }, { code: 'xy' }]).problems[0]!.code, 'PROFILE_RELATION_REPEATED');
  assert.equal(read(base(), [{ code: 'abc' }]).problems[0]!.code, 'PROFILE_RELATION_SELF');
});

test('the four alias lists may not repeat a name across lists, except a 黑称 that is also one other kind (Part 24l)', () => {
  assert.equal(read(base({ 自称: '「甲」', 黑称: '「甲」' })).problems[0]!.code, 'PROFILE_ITEM_REPEATED');
  assert.equal(
    read(base({ '别名（含英文名）': '「甲」', 中性称呼: '「甲」' })).problems[0]!.code,
    'PROFILE_ITEM_REPEATED',
  );
  assert.equal(
    read(base({ '别名（含英文名）': '「甲」', 中性称呼: '「甲」', 黑称: '「甲」' })).problems[0]!.code,
    'PROFILE_ITEM_REPEATED',
  );
  const as别名 = only(base({ '别名（含英文名）': '「小满」', 黑称: '「小满」' }));
  assert.deepEqual([as别名.aliases, as别名.insultNames], [['小满'], ['小满']]);
  const asNeutral = only(base({ 中性称呼: '「小满」', 黑称: '「小满」' }));
  assert.deepEqual([asNeutral.neutralNames, asNeutral.insultNames], [['小满'], ['小满']]);
});

test('名片一句话 (Part 24l): 一句话描述 goes to the public description only; the card takes 名片一句话, else a short 一句话描述, else nothing', () => {
  const long = '长'.repeat(133);
  const whole = read(base({ 一句话描述: long }));
  assert.deepEqual(whole.problems, [], 'a 133-character 一句话描述 is no longer an error');
  assert.equal(whole.profile!.oneLiner, long);
  assert.equal(whole.profile!.cardOneLiner, '');
  assert.deepEqual(
    whole.profile!.checklist.filter((c) => c.key === 'card-oneliner').map((c) => c.text),
    ['名片一句话待填（一句话描述超过 40 字）'],
  );
  const given = only(base({ 一句话描述: long, 名片一句话: '爱笑的邻家同学' }));
  assert.equal(given.cardOneLiner, '爱笑的邻家同学');
  assert.deepEqual(
    given.checklist.filter((c) => c.key === 'card-oneliner'),
    [],
  );
  const short = only(base({ 一句话描述: '慢热的邻家同学' }));
  assert.equal(short.cardOneLiner, '慢热的邻家同学');
  assert.equal(only(base({ 一句话描述: 'x'.repeat(40) })).cardOneLiner, 'x'.repeat(40));
  assert.equal(only(base({ 名片一句话: 'y'.repeat(40) })).cardOneLiner, 'y'.repeat(40));
  const over = read(base({ 名片一句话: 'y'.repeat(41) })).problems;
  assert.deepEqual(
    over.map((p) => [p.code, p.section, p.field]),
    [['PROFILE_TOO_LONG', '1 基本信息', '名片一句话']],
    '41 fails, located',
  );
  // an old file without the field still imports
  const old = readTemplateFile('old.md', templateFile(base({ 一句话描述: '短描述' })));
  assert.deepEqual(old.problems, []);
  assert.equal(old.profile!.cardOneLiner, '短描述');
  assert.ok(!templateFile(base()).includes('名片一句话'));
});

test('共同经历 (Part 24l): each side holds up to 600; 273 passes whole, 601 fails located', () => {
  const side = '共'.repeat(273);
  const ok = only(base(), [{ code: 'XY', shared: side }]);
  assert.equal(ok.relations[0]!.shared, side);
  assert.equal(only(base(), [{ code: 'XY', shared: '共'.repeat(600) }]).relations[0]!.shared.length, 600);
  const bad = read(base(), [{ code: 'XY', shared: '共'.repeat(601) }]).problems;
  assert.deepEqual(
    bad.map((p) => [p.code, p.field]),
    [['PROFILE_TOO_LONG', '相处方式及共同经历']],
  );
});

test('an alias of 25 passes (English with spaces too) and 26 fails located to the field and item; a 称呼 of 17 still fails (Part 24l)', () => {
  const english = 'Hazel Jane Watson Zhou x2'.slice(0, 25);
  assert.equal(english.length, 25);
  assert.deepEqual(only(base({ '别名（含英文名）': `「${english}」` })).aliases, [english]);
  assert.deepEqual(only(base({ 黑称: `「${'字'.repeat(25)}」` })).insultNames, ['字'.repeat(25)]);
  const bad = read(base({ 中性称呼: `「甲」「${'字'.repeat(26)}」` })).problems;
  assert.deepEqual(
    bad.map((p) => [p.code, p.section, p.field, p.item]),
    [['CAST_ITEM_TOO_LONG', '1 基本信息', '中性称呼', 2]],
  );
  const address = read(base(), [{ code: 'XY', addresses: `「${'称'.repeat(17)}」` }]).problems;
  assert.equal(address[0]!.code, 'CAST_ITEM_TOO_LONG');
});
