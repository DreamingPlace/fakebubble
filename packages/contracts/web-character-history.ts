/**
 * 角色版本历史 (Part 24f). Shapes shared by the server and the admin page. A version is an immutable snapshot of a published
 * profile; nothing here carries an email, an id of a person or any player content.
 */
import { upgradeWelcomes } from './web-welcomes.ts';

export type VersionOrigin = { kind: 'publish' } | { kind: 'colour' } | { kind: 'restore'; from: number };
/** Who published it, as a role: never an email, a label or an id. 'system' is the first import of a seed character. */
export type VersionActor = 'owner' | 'admin' | 'system';
/** Why an old version cannot be made current again. The page says 「不可恢复」 and this reason; the server refuses a direct call. */
export const RESTORE_PROBLEMS = [
  'VOICE_BINDING_MISSING',
  'CLIP_MISSING',
  'MATERIAL_MISSING',
  'PROFILE_INVALID',
] as const;
export type RestoreProblem = (typeof RESTORE_PROBLEMS)[number];
export const RESTORE_PROBLEM_TEXT: Readonly<Record<RestoreProblem, string>> = {
  VOICE_BINDING_MISSING: '这一版用的已批准声音绑定已经找不到',
  CLIP_MISSING: '这一版的欢迎或结束语音成品已经不在',
  MATERIAL_MISSING: '这一版发布时用的已批准成品材料不完整',
  PROFILE_INVALID: '这一版的资料已不能通过现在的校验',
};
export type VersionRow = {
  version: number;
  publishedAt: number | null;
  by: VersionActor;
  origin: VersionOrigin;
  /** One line: what changed against the version before it. */
  summary: string;
  live: boolean;
  /** False for the live version. When false and `problem` is set, the page shows 「不可恢复」. */
  restorable: boolean;
  problem: RestoreProblem | null;
};
export type VersionHistory = { characterId: string; live: number | null; versions: VersionRow[] };

type ProfileLike = {
  template: {
    id: string;
    name: string;
    persona: string;
    birthDate?: unknown;
    seed?: unknown;
    authorCanon?: unknown;
    voice?: unknown;
  };
  presentation: {
    displayName: string;
    publicDescription: string;
    color?: unknown;
    palette?: unknown;
    welcome?: unknown;
    welcomes?: unknown;
  };
};
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
          .join(',')}}`
      : JSON.stringify(value);
/** The five groups of the editor, the same cut as 资料改动 (and the draft chip) uses. */
const GROUPS: readonly [string, (p: ProfileLike) => unknown][] = [
  [
    '身份与展示',
    (p) => [
      p.template.id,
      p.template.name,
      p.template.birthDate ?? null,
      p.presentation.displayName,
      p.presentation.publicDescription,
    ],
  ],
  ['主色', (p) => [p.presentation.color ?? null, p.presentation.palette ?? null]],
  // Part 24k-2: an old single welcome and the one-line list that upgrades from it are the same.
  ['欢迎词', (p) => upgradeWelcomes(p.presentation)],
  ['人设', (p) => [p.template.persona, p.template.seed === true]],
  ['设定', (p) => p.template.authorCanon ?? null],
  ['声音', (p) => p.template.voice ?? null],
];
/** One line for the history list. The version number itself never counts as a change. */
export function describeChange(before: ProfileLike | null, after: ProfileLike): string {
  if (!before) return '初始版本';
  const changed = GROUPS.filter(([, part]) => stable(part(before)) !== stable(part(after))).map(([name]) => name);
  if (!changed.length) return '内容与上一版相同';
  if (changed.length === 1 && changed[0] === '主色') return '只改了主色';
  return `改动：${changed.join('、')}`;
}
