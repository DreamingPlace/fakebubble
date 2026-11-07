/**
 * Part 24j: the character profile template (docs/CHARACTER_TEMPLATE.md, v1). PURE: text in, values and located problems out.
 * Nothing here reads a store, calls a provider or guesses: an unknown, missing or renamed field is a problem with its place
 * (file, section, field, item number), never a silent default. Two layers:
 *   parseTemplate  - the Markdown into sections / fields / relation blocks (no meaning yet).
 *   readProfile    - the meaning of each field (lists, colours, dates, limits), plus the checklist of what cannot be imported yet.
 */
import { castItemProblem, CAST_ITEM_CODE, CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';
import { validBirthDate } from './characters.ts';

export interface ProfileProblem {
  code: string;
  file: string;
  section: string | null;
  field: string | null;
  /** 1-based item number inside a list field, or the relation block number. */
  item: number | null;
  text: string;
}
export type ChecklistItem = { key: string; text: string };

export const CODE_PATTERN = /^[A-Za-z0-9_-]{2,12}$/;
/** Caps of this importer on top of the cast's and the workbench's own (all JavaScript string length, no cutting). */
export const PROFILE_LIMITS = Object.freeze({
  files: 20,
  fileChars: 60_000,
  name: CAST_LIMITS.name,
  displayName: 100,
  oneLiner: CAST_LIMITS.oneLiner,
  welcome: 500,
  welcomeLines: 12,
  text: 2_000,
  listItem: 100,
  listItems: 30,
  paletteItems: 12,
  colourName: 24,
  persona: 20_000,
  canon: 48_000,
  height: 40,
  avatarFile: 128,
});

const SECTIONS = [
  {
    n: 1,
    title: '基本信息',
    fields: [
      '角色代码',
      '人设名称',
      '网页展示名／昵称',
      '自称',
      '别名（含英文名）',
      '中性称呼',
      '黑称',
      '饰演过的角色',
      '动物形象',
      '性别设定',
      '生日',
      '身高',
      '头像／形象图片文件',
      '一句话描述',
      '音色模型 ID（Fish Audio）',
    ],
  },
  { n: 2, title: '展示与欢迎内容', fields: ['欢迎词', '角色主色', '是否为成长中角色'] },
  {
    n: 3,
    title: '性格与相处方式',
    fields: [
      '陌生时的相处方式',
      '熟悉后的变化',
      '表达关心的方式',
      '开玩笑或被调侃时的反应',
      '遇到冲突·拒绝·冷场时的反应',
    ],
  },
  {
    n: 4,
    title: '语言与声音特征',
    fields: [
      '常用词与口头禅',
      '句子长短·断句习惯',
      '称呼对方的习惯',
      '文字聊天习惯',
      '开心时怎么说',
      '低落时怎么说',
      '生气时怎么说',
      '不会使用的措辞',
    ],
  },
  {
    n: 5,
    title: '背景与生活',
    fields: [
      '成长背景',
      '现在的生活状态',
      '兴趣·擅长的事',
      '喜欢与不喜欢的事物',
      '宠物',
      '家庭成员',
      '外貌·衣着·体态',
      '学校-年级',
    ],
  },
  { n: 6, title: '目前情况', fields: ['现在所在地', '近况'] },
  { n: 7, title: '人物关系', fields: [] },
  {
    n: 8,
    title: '边界与隐藏设定',
    fields: ['知道但不会说出口的事', '不可改变的核心设定', '不应擅自补充的事实', '不符合角色的行为·表达'],
  },
] as const;
export const RELATION_FIELDS = [
  '对方角色代码',
  'CP名',
  '本角色如何称呼对方',
  '本角色对对方的态度',
  '相处方式及共同经历',
] as const;
const OLD_ALIAS_FIELD = '自称与其他别名';
/** Section 1 fields that, when empty, still count as present (they are just "no material"). */
const BIRTH_HINT = /^生日(?:（YYYY-MM-DD）)?$/;

/** The persona's labelled lines, 说话方式 items, 经历 cards, 其余设定 keys: field → destination, in template order. */
export const PERSONA_FIELDS = SECTIONS[2]!.fields;
export const SPEECH_FIELDS = SECTIONS[3]!.fields;
export const BACKGROUND_FIELDS = ['成长背景', '现在的生活状态', '近况'] as const;
/** profileFacts key ← template field. */
export const FACT_FIELDS: readonly (readonly [string, string])[] = [
  ['性别', '性别设定'],
  ['身高', '身高'],
  ['学校-年级', '学校-年级'],
  ['饰演过的角色', '饰演过的角色'],
  ['动物形象', '动物形象'],
  ['兴趣·擅长的事', '兴趣·擅长的事'],
  ['喜欢与不喜欢的事物', '喜欢与不喜欢的事物'],
  ['宠物', '宠物'],
  ['家庭成员', '家庭成员'],
  ['外貌·衣着·体态', '外貌·衣着·体态'],
  ['现在所在地', '现在所在地'],
];
export const BOUNDARY_FIELDS = SECTIONS[7]!.fields;

const normLabel = (label: string) =>
  label.replace(/\*\*/g, '').replace(/\s+/g, ' ').replace(/\(/g, '（').replace(/\)/g, '）').trim();

interface RawField {
  label: string;
  value: string;
  line: number;
}
interface RawSection {
  n: number;
  title: string;
  fields: RawField[];
  /** Section 6 only: bullets without a label (the old format's 近况). */
  unlabelled: RawField[];
}
interface RawRelation {
  block: number;
  fields: RawField[];
}
export interface ParsedTemplate {
  file: string;
  sections: Map<number, RawSection>;
  relations: RawRelation[];
  problems: ProfileProblem[];
}

const FIELD_LINE = /^[-*+]\s+(?:\*\*)?([^：:*]+?)(?:\*\*)?\s*[：:]\s*(.*)$/u;
const BULLET = /^[-*+]\s+(.*)$/u;
const HEADING2 = /^##\s+(.*)$/u;
const HEADING3 = /^###\s+(.*)$/u;
const HEADING1 = /^#\s+/u;
const SECTION_TITLE = /^(\d)[\s.、．]*(.+)$/u;
const RELATION_TITLE = /^关系\s*(\d+)$/u;

export function parseTemplate(file: string, source: string): ParsedTemplate {
  const problems: ProfileProblem[] = [];
  const sections = new Map<number, RawSection>();
  const relations: RawRelation[] = [];
  const problem = (
    code: string,
    section: string | null,
    field: string | null,
    text: string,
    item: number | null = null,
  ) => problems.push({ code, file, section, field, item, text });
  if (source.length > PROFILE_LIMITS.fileChars) {
    problem('PROFILE_FILE_TOO_LARGE', null, null, `文件超过 ${PROFILE_LIMITS.fileChars} 字`);
    return { file, sections, relations, problems };
  }
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let section: RawSection | null = null;
  let sectionName: string | null = null;
  let relation: RawRelation | null = null;
  let current: RawField | null = null;
  let comment = false;
  for (const [index, raw] of lines.entries()) {
    const no = index + 1;
    if (comment) {
      if (raw.includes('-->')) comment = false;
      continue;
    }
    if (raw.trim().startsWith('<!--')) {
      if (!raw.includes('-->')) comment = true;
      continue;
    }
    if (raw.trim() === '' || /^\s*>/.test(raw)) continue;
    const head2 = HEADING2.exec(raw);
    if (head2) {
      current = null;
      relation = null;
      const m = SECTION_TITLE.exec(head2[1]!.trim());
      const def = m ? SECTIONS.find((s) => s.n === Number(m[1])) : undefined;
      if (!m || !def || def.title !== normLabel(m[2]!)) {
        section = null;
        sectionName = null;
        problem('PROFILE_UNKNOWN_SECTION', head2[1]!.trim(), null, `无法识别的分区「${head2[1]!.trim()}」`);
        continue;
      }
      if (sections.has(def.n)) {
        section = null;
        problem('PROFILE_DUPLICATE_SECTION', `${def.n} ${def.title}`, null, '分区重复');
        continue;
      }
      section = { n: def.n, title: def.title, fields: [], unlabelled: [] };
      sectionName = `${def.n} ${def.title}`;
      sections.set(def.n, section);
      continue;
    }
    const head3 = HEADING3.exec(raw);
    if (head3) {
      current = null;
      const m = RELATION_TITLE.exec(head3[1]!.trim());
      if (section?.n === 7 && m) {
        relation = { block: Number(m[1]), fields: [] };
        relations.push(relation);
      } else {
        relation = null;
        problem('PROFILE_UNKNOWN_HEADING', sectionName, null, `无法识别的小标题「${head3[1]!.trim()}」`);
      }
      continue;
    }
    // Before the first section (the title, notes) and inside a refused section nothing is read.
    if (HEADING1.test(raw) || !section) continue;
    const isTop = !/^\s/.test(raw);
    const fieldMatch = isTop ? FIELD_LINE.exec(raw) : null;
    if (fieldMatch) {
      const field: RawField = { label: normLabel(fieldMatch[1]!), value: fieldMatch[2]!.trim(), line: no };
      current = field;
      if (section.n === 7) {
        if (!relation) {
          problem('PROFILE_FIELD_OUTSIDE_RELATION', sectionName, field.label, '关系字段要写在「### 关系 N」之下');
          continue;
        }
        relation.fields.push(field);
      } else section.fields.push(field);
      continue;
    }
    // A line that is not a field: a continuation of the last field, or (section 6, a top-level bullet) the old unlabelled 近况.
    const bullet = isTop ? BULLET.exec(raw) : null;
    if (section.n === 6 && bullet) {
      const field: RawField = { label: '近况', value: bullet[1]!.trim(), line: no };
      section.unlabelled.push(field);
      current = field;
      continue;
    }
    if (current) {
      current.value = current.value === '' ? raw.trim() : `${current.value}\n${raw.trim()}`;
      continue;
    }
    problem('PROFILE_UNREADABLE_LINE', sectionName, null, `第 ${no} 行不属于任何字段`);
  }
  return { file, sections, relations, problems };
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface PaletteItem {
  hex: string | null;
  name: string;
  role: 'main' | 'accent';
  item: number;
}
export interface ReadRelation {
  block: number;
  code: string;
  cp: string;
  addresses: string[];
  attitude: string;
  shared: string;
}
export interface ReadProfile {
  file: string;
  /** Present on an old-format file (自称与其他别名). */
  oldAliases: boolean;
  code: string;
  name: string;
  displayName: string;
  selfNames: string[];
  aliases: string[];
  neutralNames: string[];
  insultNames: string[];
  birthDate: string;
  avatarFile: string;
  oneLiner: string;
  voiceId: string;
  welcome: string[];
  palette: PaletteItem[];
  /** null = the field is empty (no material). */
  seed: boolean | null;
  persona: { label: string; text: string }[];
  speech: { label: string; text: string }[];
  background: { title: string; text: string }[];
  facts: Record<string, string>;
  boundaries: Record<string, string>;
  relations: ReadRelation[];
  checklist: ChecklistItem[];
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;
/** Items of a list field: 「…」 segments, else 、 / line separated. Text left outside the 「」 is a problem. */
export function listItems(value: string): { items: string[]; stray: string | null } {
  if (value.includes('「')) {
    const items: string[] = [];
    let stray = '';
    let rest = value;
    for (;;) {
      const open = rest.indexOf('「');
      if (open < 0) {
        stray += rest;
        break;
      }
      stray += rest.slice(0, open);
      const close = rest.indexOf('」', open + 1);
      if (close < 0) return { items, stray: rest.slice(open) };
      items.push(rest.slice(open + 1, close));
      rest = rest.slice(close + 1);
    }
    const leftover = stray.replace(/[\s、，,;；\-*+]/g, '');
    return { items, stray: leftover ? stray.trim() : null };
  }
  const items = value
    .split(/\n|、/u)
    .map((part) => part.replace(/^[-*+]\s+/, '').trim())
    .filter((part) => part !== '');
  return { items, stray: null };
}
/** Text lines of a field (nested bullets lose their marker); used where each line is one item and 、 is not a separator. */
const lineItems = (value: string) =>
  value
    .split('\n')
    .map((part) => part.replace(/^[-*+]\s+/, '').trim())
    .filter((part) => part !== '');

/** 称呼: items in 「」; text with no 「」 is ONE item, exactly as written. */
export function addressItems(value: string): { items: string[]; stray: string | null } {
  if (value.trim() === '') return { items: [], stray: null };
  if (value.includes('「')) return listItems(value);
  return { items: [value.trim()], stray: null };
}

const COLOUR_ITEM = /^(#[0-9A-Za-z]*)?\s*(.*?)\s*(（主）|\(主\))?$/u;
function colourItems(value: string): { items: { text: string }[]; stray: string | null } {
  const { items, stray } = listItems(value);
  return { items: items.map((text) => ({ text })), stray };
}

export function readProfile(parsed: ParsedTemplate): { profile: ReadProfile | null; problems: ProfileProblem[] } {
  const { file } = parsed;
  const problems = [...parsed.problems];
  const checklist: ChecklistItem[] = [];
  const problem = (
    code: string,
    section: string | null,
    field: string | null,
    text: string,
    item: number | null = null,
  ) => problems.push({ code, file, section, field, item, text });

  const sectionName = (n: number) => `${n} ${SECTIONS.find((s) => s.n === n)!.title}`;
  const values = new Map<number, Map<string, string>>();
  let oldAliases = false;
  for (const def of SECTIONS) {
    const raw = parsed.sections.get(def.n);
    if (!raw) {
      problem('PROFILE_MISSING_SECTION', sectionName(def.n), null, '缺少这个分区');
      continue;
    }
    const map = new Map<string, string>();
    values.set(def.n, map);
    const allowed = new Set<string>(def.fields);
    if (def.n === 1) allowed.add(OLD_ALIAS_FIELD);
    for (const field of def.n === 7 ? [] : raw.fields) {
      let label = field.label;
      if (def.n === 1 && BIRTH_HINT.test(label)) label = '生日';
      if (!allowed.has(label)) {
        problem('PROFILE_UNKNOWN_FIELD', sectionName(def.n), field.label, '无法识别的字段（不会猜测或改名）');
        continue;
      }
      if (map.has(label)) {
        problem('PROFILE_DUPLICATE_FIELD', sectionName(def.n), label, '字段重复');
        continue;
      }
      map.set(label, field.value);
    }
    if (def.n === 6 && raw.unlabelled.length) {
      if (map.has('近况')) problem('PROFILE_DUPLICATE_FIELD', sectionName(6), '近况', '近况既有标签又有无标签的条目');
      else map.set('近况', raw.unlabelled.map((u) => u.value).join('\n'));
    }
    if (def.n === 1) {
      if (map.has(OLD_ALIAS_FIELD)) {
        oldAliases = true;
        if (map.has('自称') || map.has('别名（含英文名）'))
          problem('PROFILE_DUPLICATE_FIELD', sectionName(1), OLD_ALIAS_FIELD, '旧字段不能与「自称」「别名」同时出现');
      }
    }
    for (const label of def.fields) {
      if (def.n === 1 && oldAliases && (label === '自称' || label === '别名（含英文名）')) continue;
      if (def.n === 6 && label === '近况' && map.has('近况')) continue;
      if (!map.has(label)) problem('PROFILE_MISSING_FIELD', sectionName(def.n), label, '缺少这个字段');
    }
  }
  const get = (n: number, label: string) => values.get(n)?.get(label) ?? '';
  const where = (n: number) => sectionName(n);

  const text = (n: number, label: string, max: number = PROFILE_LIMITS.text) => {
    const value = get(n, label);
    if (CONTROL.test(value)) problem('PROFILE_CONTROL_CHARACTER', where(n), label, '含不允许的控制字符');
    if (value.length > max) problem('PROFILE_TOO_LONG', where(n), label, `超过 ${max} 字（${value.length}）`);
    return value;
  };
  const list = (n: number, label: string, max: number, count = PROFILE_LIMITS.listItems) => {
    const { items, stray } = listItems(get(n, label));
    if (stray) problem('PROFILE_LIST_STRAY_TEXT', where(n), label, `「」之外有多余文字：${stray}`);
    if (items.length > count) problem('PROFILE_TOO_MANY_ITEMS', where(n), label, `最多 ${count} 项（${items.length}）`);
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (item.length === 0) problem('PROFILE_ITEM_EMPTY', where(n), label, '空项', i + 1);
      else if (item.length > max)
        problem('PROFILE_TOO_LONG', where(n), label, `超过 ${max} 字（${item.length}）`, i + 1);
      else if (CONTROL.test(item)) problem('PROFILE_CONTROL_CHARACTER', where(n), label, '含不允许的控制字符', i + 1);
      if (seen.has(item)) problem('PROFILE_ITEM_REPEATED', where(n), label, '同一列表里重复', i + 1);
      seen.add(item);
    });
    return items;
  };
  /** A name list that goes to the cast: the cast's own item rules (edge space, length 16, control characters). */
  const names = (n: number, label: string) => {
    const { items, stray } = listItems(get(n, label));
    if (stray) problem('PROFILE_LIST_STRAY_TEXT', where(n), label, `「」之外有多余文字：${stray}`);
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const bad = castItemProblem(item, CAST_LIMITS.alias);
      if (bad) problem(CAST_ITEM_CODE[bad], where(n), label, itemSentence(bad, CAST_LIMITS.alias), i + 1);
      if (seen.has(item)) problem('PROFILE_ITEM_REPEATED', where(n), label, '同一列表里重复', i + 1);
      seen.add(item);
    });
    return items;
  };

  // ---- 1 基本信息 ----
  const code = get(1, '角色代码').trim();
  if (code === '') problem('PROFILE_CODE_REQUIRED', where(1), '角色代码', '角色代码不能为空');
  else if (!CODE_PATTERN.test(code))
    problem('PROFILE_CODE_INVALID', where(1), '角色代码', '角色代码须是 2–12 位的字母、数字、_ 或 -');
  const name = text(1, '人设名称', PROFILE_LIMITS.name);
  const displayName = text(1, '网页展示名／昵称', PROFILE_LIMITS.displayName);
  let selfNames: string[] = [],
    aliases: string[] = [];
  if (oldAliases) {
    aliases = names(1, OLD_ALIAS_FIELD);
    checklist.push({ key: 'old-aliases', text: '自称与别名未分开，请手动把自称移出' });
  } else {
    selfNames = names(1, '自称');
    aliases = names(1, '别名（含英文名）');
  }
  const neutralNames = names(1, '中性称呼');
  const insultNames = names(1, '黑称');
  const allNames = [...selfNames, ...aliases, ...neutralNames, ...insultNames];
  if (new Set(allNames).size !== allNames.length)
    problem('PROFILE_ITEM_REPEATED', where(1), '自称/别名/中性称呼/黑称', '同一个名字出现在多个称呼列表里');
  const totalAliases = selfNames.length + aliases.length + neutralNames.length + insultNames.length;
  if (totalAliases > CAST_LIMITS.aliases)
    problem(
      'PROFILE_TOO_MANY_ITEMS',
      where(1),
      '自称/别名/中性称呼/黑称',
      `合计最多 ${CAST_LIMITS.aliases} 项（${totalAliases}）`,
    );
  const birthDate = get(1, '生日').trim();
  if (birthDate !== '' && !validBirthDate(birthDate))
    problem('PROFILE_BIRTH_INVALID', where(1), '生日', '生日须是真实存在的日期，格式 YYYY-MM-DD');
  const avatarFile = get(1, '头像／形象图片文件').trim();
  if (avatarFile !== '') {
    if (
      /[\\/\u0000-\u001f\u007f]/u.test(avatarFile) ||
      avatarFile.length > PROFILE_LIMITS.avatarFile ||
      avatarFile === '.' ||
      avatarFile === '..'
    )
      problem('PROFILE_AVATAR_INVALID', where(1), '头像／形象图片文件', '只写文件名（不含路径），不超过 128 字');
    else checklist.push({ key: `avatar:${avatarFile}`, text: `头像 ${avatarFile} 待 25e 上传` });
  }
  const oneLiner = text(1, '一句话描述', PROFILE_LIMITS.oneLiner);
  const voiceId = get(1, '音色模型 ID（Fish Audio）').trim();
  if (voiceId !== '' && !/^[A-Za-z0-9_-]{1,128}$/.test(voiceId))
    problem(
      'PROFILE_VOICE_ID_INVALID',
      where(1),
      '音色模型 ID（Fish Audio）',
      '音色模型 ID 只含字母、数字、_ 和 -，不超过 128 位',
    );
  text(1, '身高', PROFILE_LIMITS.height);

  // ---- 2 展示与欢迎内容 ----
  const welcomeRaw = get(2, '欢迎词');
  let welcome: string[];
  if (welcomeRaw.includes('「')) {
    const { items, stray } = listItems(welcomeRaw);
    if (stray) problem('PROFILE_LIST_STRAY_TEXT', where(2), '欢迎词', `「」之外有多余文字：${stray}`);
    welcome = items;
  } else welcome = lineItems(welcomeRaw);
  if (welcome.length > PROFILE_LIMITS.welcomeLines)
    problem(
      'PROFILE_TOO_MANY_ITEMS',
      where(2),
      '欢迎词',
      `最多 ${PROFILE_LIMITS.welcomeLines} 条（${welcome.length}）`,
    );
  welcome.forEach((line, i) => {
    if (line.trim() === '') problem('PROFILE_ITEM_EMPTY', where(2), '欢迎词', '空项', i + 1);
    else if (line.length > PROFILE_LIMITS.welcome)
      problem('PROFILE_TOO_LONG', where(2), '欢迎词', `超过 ${PROFILE_LIMITS.welcome} 字（${line.length}）`, i + 1);
    else if (CONTROL.test(line)) problem('PROFILE_CONTROL_CHARACTER', where(2), '欢迎词', '含不允许的控制字符', i + 1);
  });
  for (let i = 1; i < welcome.length; i++)
    checklist.push({ key: `welcome:${i + 1}`, text: `欢迎词 第 ${i + 1} 条 等 24k 多欢迎词` });

  const palette: PaletteItem[] = [];
  const colourRaw = get(2, '角色主色');
  const { items: colourTexts, stray: colourStray } = colourItems(colourRaw);
  if (colourStray) problem('PROFILE_LIST_STRAY_TEXT', where(2), '角色主色', `「」之外有多余文字：${colourStray}`);
  if (colourTexts.length > PROFILE_LIMITS.paletteItems)
    problem(
      'PROFILE_TOO_MANY_ITEMS',
      where(2),
      '角色主色',
      `最多 ${PROFILE_LIMITS.paletteItems} 种（${colourTexts.length}）`,
    );
  const parsedColours = colourTexts.map(({ text: raw }, index) => {
    const m = COLOUR_ITEM.exec(raw.trim())!;
    const mark = m[3] !== undefined;
    let hex: string | null = null;
    if (m[1] !== undefined) {
      if (/^#[0-9A-Fa-f]{6}$/.test(m[1])) hex = m[1].toUpperCase();
      else problem('PROFILE_COLOUR_INVALID', where(2), '角色主色', '色值须是 #RRGGBB', index + 1);
    }
    const label = m[2]!;
    if (label.length > PROFILE_LIMITS.colourName)
      problem('PROFILE_TOO_LONG', where(2), '角色主色', `颜色名超过 ${PROFILE_LIMITS.colourName} 字`, index + 1);
    return { hex, name: label, mark, item: index + 1 };
  });
  const marked = parsedColours.filter((c) => c.mark).length;
  if (marked > 1) problem('PROFILE_COLOUR_MAIN_REPEATED', where(2), '角色主色', '有多个（主）');
  else if (marked === 0 && parsedColours.length > 1)
    problem('PROFILE_COLOUR_MAIN_MISSING', where(2), '角色主色', '有多种颜色却没有标（主）');
  for (const colour of parsedColours) {
    const role: 'main' | 'accent' = colour.mark || (marked === 0 && parsedColours.length === 1) ? 'main' : 'accent';
    if (colour.hex === null)
      checklist.push({
        key: `colour:${colour.item}:${colour.name}`,
        text: `颜色 ${colour.name || `第 ${colour.item} 个`} 没有色值，请在工作台选色（${role === 'main' ? '主色' : '辅色'}）`,
      });
    else palette.push({ hex: colour.hex, name: colour.name, role, item: colour.item });
  }
  const growing = get(2, '是否为成长中角色').trim();
  let seed: boolean | null = null;
  if (growing === '是') seed = true;
  else if (growing === '否') seed = false;
  else if (growing !== '') problem('PROFILE_SEED_INVALID', where(2), '是否为成长中角色', '只能写「是」或「否」');

  // ---- 3 / 4 / 5 / 8 ----
  const persona = PERSONA_FIELDS.map((label) => ({ label, text: text(3, label) })).filter((x) => x.text.trim() !== '');
  const speech: { label: string; text: string }[] = [];
  for (const label of SPEECH_FIELDS) {
    if (label === '常用词与口头禅' || label === '不会使用的措辞') {
      const items = list(4, label, PROFILE_LIMITS.listItem);
      if (items.length) speech.push({ label, text: items.map((i) => `「${i}」`).join('') });
    } else {
      const value = text(4, label);
      if (value.trim() !== '') speech.push({ label, text: value });
    }
  }
  const background: { title: string; text: string }[] = [];
  for (const [n, label] of [
    [5, '成长背景'],
    [5, '现在的生活状态'],
    [6, '近况'],
  ] as const) {
    const value = text(n, label);
    if (value.trim() !== '') background.push({ title: label, text: value });
  }
  const facts: Record<string, string> = {};
  for (const [key, label] of FACT_FIELDS) {
    // The section a field is written in (the lookup, not a guess: a field read from the wrong section would silently be empty).
    const n = SECTIONS.find((section) => (section.fields as readonly string[]).includes(label))!.n;
    const value = text(n, label, label === '身高' ? PROFILE_LIMITS.height : PROFILE_LIMITS.text);
    if (value.trim() !== '') facts[key] = value;
  }
  const boundaries: Record<string, string> = {};
  for (const label of BOUNDARY_FIELDS) {
    const value = text(8, label);
    if (value.trim() !== '') boundaries[label] = value;
  }

  // ---- 7 人物关系 ----
  const relations: ReadRelation[] = [];
  const seenRelations = new Set<string>();
  for (const block of parsed.relations) {
    const map = new Map<string, string>();
    const here = `${sectionName(7)} · 关系 ${block.block}`;
    for (const field of block.fields) {
      if (!(RELATION_FIELDS as readonly string[]).includes(field.label)) {
        problem('PROFILE_UNKNOWN_FIELD', here, field.label, '无法识别的字段（不会猜测或改名）', block.block);
        continue;
      }
      if (map.has(field.label)) {
        problem('PROFILE_DUPLICATE_FIELD', here, field.label, '字段重复', block.block);
        continue;
      }
      map.set(field.label, field.value);
    }
    for (const label of RELATION_FIELDS)
      if (!map.has(label)) problem('PROFILE_MISSING_FIELD', here, label, '缺少这个字段', block.block);
    const other = (map.get('对方角色代码') ?? '').trim();
    if (!CODE_PATTERN.test(other))
      problem(
        'PROFILE_CODE_INVALID',
        here,
        '对方角色代码',
        '对方角色代码须是 2–12 位的字母、数字、_ 或 -',
        block.block,
      );
    else if (seenRelations.has(other.toLowerCase()))
      problem('PROFILE_RELATION_REPEATED', here, '对方角色代码', '同一个对方出现在多个关系块里', block.block);
    seenRelations.add(other.toLowerCase());
    if (code !== '' && other.toLowerCase() === code.toLowerCase())
      problem('PROFILE_RELATION_SELF', here, '对方角色代码', '关系的对方不能是自己', block.block);
    const cp = (map.get('CP名') ?? '').trim();
    if (cp.length > CAST_LIMITS.memeKey)
      problem('PROFILE_TOO_LONG', here, 'CP名', `超过 ${CAST_LIMITS.memeKey} 字（${cp.length}）`, block.block);
    else if (CONTROL.test(cp)) problem('PROFILE_CONTROL_CHARACTER', here, 'CP名', '含不允许的控制字符', block.block);
    const { items: addresses, stray } = addressItems(map.get('本角色如何称呼对方') ?? '');
    if (stray)
      problem('PROFILE_LIST_STRAY_TEXT', here, '本角色如何称呼对方', `「」之外有多余文字：${stray}`, block.block);
    if (addresses.length > CAST_LIMITS.addresses)
      problem(
        'PROFILE_TOO_MANY_ITEMS',
        here,
        '本角色如何称呼对方',
        `最多 ${CAST_LIMITS.addresses} 项（${addresses.length}）`,
        block.block,
      );
    addresses.forEach((item, i) => {
      const bad = castItemProblem(item, CAST_LIMITS.address);
      if (bad) problem(CAST_ITEM_CODE[bad], here, '本角色如何称呼对方', itemSentence(bad, CAST_LIMITS.address), i + 1);
    });
    if (new Set(addresses).size !== addresses.length)
      problem('PROFILE_ITEM_REPEATED', here, '本角色如何称呼对方', '同一列表里重复', block.block);
    const attitude = (map.get('本角色对对方的态度') ?? '').trim();
    if (attitude.length > CAST_LIMITS.treatment)
      problem(
        'PROFILE_TOO_LONG',
        here,
        '本角色对对方的态度',
        `超过 ${CAST_LIMITS.treatment} 字（${attitude.length}）`,
        block.block,
      );
    const shared = (map.get('相处方式及共同经历') ?? '').trim();
    if (shared.length > CAST_LIMITS.storySummary)
      problem(
        'PROFILE_TOO_LONG',
        here,
        '相处方式及共同经历',
        `超过 ${CAST_LIMITS.storySummary} 字（${shared.length}）`,
        block.block,
      );
    relations.push({ block: block.block, code: other, cp, addresses, attitude, shared });
  }

  // Document totals the server enforces for the files together.
  const personaText = persona.map((p) => `${p.label}：${p.text}`).join('\n');
  if (personaText.length > PROFILE_LIMITS.persona)
    problem(
      'PROFILE_TOO_LONG',
      where(3),
      null,
      `性格部分合计超过 ${PROFILE_LIMITS.persona} 字（${personaText.length}）`,
    );
  const canonSize = JSON.stringify({ speech, background, facts, boundaries }).length;
  if (canonSize > PROFILE_LIMITS.canon)
    problem(
      'PROFILE_TOO_LONG',
      null,
      null,
      `说话方式、经历、其余设定合计超过 ${PROFILE_LIMITS.canon} 字（${canonSize}）`,
    );

  if (problems.length) return { profile: null, problems };
  return {
    profile: {
      file,
      oldAliases,
      code,
      name,
      displayName,
      selfNames,
      aliases,
      neutralNames,
      insultNames,
      birthDate,
      avatarFile,
      oneLiner,
      voiceId,
      welcome,
      palette,
      seed,
      persona,
      speech,
      background,
      facts,
      boundaries,
      relations,
      checklist,
    },
    problems,
  };
}

function itemSentence(problem: 'empty' | 'control' | 'space' | 'long', max: number) {
  return problem === 'empty'
    ? '空项'
    : problem === 'control'
      ? '含换行或控制字符'
      : problem === 'space'
        ? '开头或结尾有空格'
        : `超过 ${max} 字`;
}

/** parse + read in one call. */
export function readTemplateFile(file: string, source: string) {
  return readProfile(parseTemplate(file, source));
}
