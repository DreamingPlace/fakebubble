import type { CharacterProfile } from '../../../services/character-admin-api.ts';
import { upgradeWelcomes } from '../../../../../../packages/contracts/web-welcomes.ts';

/** A value of the profile as plain words: text as it is, lists as lines, groups as "名：值" lines. Never JSON. */
export function plain(value: unknown, depth = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
  if (Array.isArray(value))
    return value
      .map((item) => (depth === 0 ? `• ${plain(item, depth + 1).replace(/\n/g, '\n  ')}` : plain(item, depth + 1)))
      .join(depth === 0 ? '\n' : '；');
  const lines = Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const text = plain(child, depth + 1);
    return text.includes('\n') ? `${key}：\n  ${text.replace(/\n/g, '\n  ')}` : `${key}：${text}`;
  });
  return lines.join('\n');
}

export type Field = readonly [label: string, value: string];
/** 网页展示 as labelled fields. */
export const presentationFields = (profile: CharacterProfile): Field[] => {
  const p = profile.presentation;
  return [
    ['网页展示名', p.displayName],
    ['公开简介', plain(p.publicDescription)],
    ['主色', plain(p.color)],
    // Part 24k-2: line by line, each with its percent.
    ...upgradeWelcomes(p).map(
      (line, i, all) =>
        [
          all.length === 1 ? '欢迎词' : `欢迎词 ${i + 1}`,
          all.length === 1 ? line.text : `${line.text}（${line.weight}%）`,
        ] as Field,
    ),
    [
      '色板',
      p.palette?.length
        ? p.palette.map((c) => `${c.role === 'main' ? '主' : '点缀'} ${c.hex}${c.name ? ` ${c.name}` : ''}`).join('\n')
        : '—',
    ],
  ];
};
/** The labels the editors give the settings keys (so 资料改动 says 个人资料, not profileFacts). */
const CANON_LABEL: Record<string, string> = {
  speechStyle: '说话风格',
  dialogueStyle: '对话风格',
  dialogueExamples: '对话样例',
  background: '经历',
  profileFacts: '个人资料',
  boundaries: '边界与隐藏设定',
};
/** 完整模板 as labelled fields; the version number it is published under is not content and is left out. */
export const templateFields = (profile: CharacterProfile): Field[] => {
  const t = profile.template;
  const days = Object.values(t.schedule?.days ?? {}) as unknown[][];
  const canon = (t.authorCanon?.settings ?? {}) as Record<string, unknown>;
  return [
    ['固定人物 ID', t.id],
    ['人设名称', t.name],
    ['设定生日', plain(t.birthDate)],
    ['成长中角色', plain(t.seed === true)],
    ['声音', t.voice ? `${t.voice.profileId} · 版本 ${t.voice.version} · 语速 ${t.voice.speed}` : '—'],
    ['作息', `${t.schedule?.timeZone ?? '—'} · 每周 ${days.reduce((n, d) => n + d.length, 0)} 个时段`],
    ['主动联系', t.autonomy ? plain(t.autonomy) : '无'],
    ...Object.entries(canon).map(
      ([key, value]) => [`设定 · ${CANON_LABEL[key] ?? key}`, plain(withoutIds(value))] as Field,
    ),
  ];
};
export const fieldsText = (fields: readonly Field[]) =>
  fields.map(([label, value]) => `${label}：${value.replace(/\n/g, '\n  ')}`).join('\n');

/** The same three groups as 资料改动, as readable text (before = live, after = the version). */
export const readableGroups = (
  live: CharacterProfile | null,
  version: CharacterProfile,
): [string, string | undefined, string][] => [
  ['人设', live?.template.persona, version.template.persona],
  ['网页展示', live ? fieldsText(presentationFields(live)) : undefined, fieldsText(presentationFields(version))],
  ['完整模板', live ? fieldsText(templateFields(live)) : undefined, fieldsText(templateFields(version))],
];

/** Part 24b-7: no id string in an admin view: keys that carry ids (id, xxxId, xxxIds) and uuid-looking values are left out. */
const ID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !(typeof v === 'string' && ID_VALUE.test(v))).map(withoutIds);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, v]) => !/^id$|Ids?$/.test(key) && !(typeof v === 'string' && ID_VALUE.test(v)))
        .map(([key, v]) => [key, withoutIds(v)]),
    );
  return value;
}
