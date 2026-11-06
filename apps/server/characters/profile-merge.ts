/**
 * Part 24j: what one read template does to one character's profile (the workbench draft). PURE: a base profile (or none, for a new
 * character) and the read values in; the next profile, the field-by-field changes (old → new) and located problems out.
 *
 * Rules that hold everywhere here:
 *  - an EMPTY value is "no material": a new character keeps it empty, an existing one keeps its current value (never cleared);
 *  - a value goes to exactly the field the contract names and nowhere else;
 *  - existing content that this import does not own is kept: unlabelled persona lines, unlabelled 说话方式 / 经历 items and every
 *    other authorCanon key stay as they were;
 *  - a field whose existing shape cannot take the value (boundaries that is a list, profileFacts that is text) is a located
 *    problem, never an overwrite.
 */
import type { JsonValue } from '../../../packages/contracts/index.ts';
import type { WebCharacterPresentation, WebCharacterProfile } from './web-character-catalog.ts';
import {
  BACKGROUND_FIELDS,
  BOUNDARY_FIELDS,
  FACT_FIELDS,
  PERSONA_FIELDS,
  SPEECH_FIELDS,
  type ProfileProblem,
  type ReadProfile,
} from './profile-template.ts';

export interface Change {
  field: string;
  old: string;
  new: string;
}
export const show = (value: unknown): string =>
  value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);

export function blankProfile(id: string): WebCharacterProfile {
  const days: Record<number, unknown[]> = {};
  for (let day = 0; day < 7; day++) days[day] = [{ startMinute: 0, endMinute: 1440, probability: 1, catchUp: true }];
  return {
    template: {
      id,
      name: '',
      version: 1,
      fictional: true,
      persona: '',
      schedule: { timeZone: 'Asia/Singapore', days },
    } as never,
    presentation: { displayName: '', publicDescription: '', welcome: { text: '', version: 'welcome-v1' } },
  };
}

const isObject = (value: unknown): value is Record<string, JsonValue> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The persona as {label → line} for the labels this importer owns, and the lines that belong to none of them. */
export function splitPersona(persona: string) {
  const owned = new Map<string, string>();
  const rest: string[] = [];
  let label: string | null = null;
  for (const line of persona.split('\n')) {
    const found = PERSONA_FIELDS.find((l) => line.startsWith(`${l}：`));
    if (found) {
      label = found;
      owned.set(found, line.slice(found.length + 1));
    } else if (label !== null && line !== '') owned.set(label, `${owned.get(label)}\n${line}`);
    else {
      label = null;
      if (line !== '') rest.push(line);
    }
  }
  return { owned, rest };
}

export function mergeProfile(
  id: string,
  base: WebCharacterProfile | null,
  read: ReadProfile,
): { next: WebCharacterProfile; changes: Change[]; problems: ProfileProblem[] } {
  const isNew = base === null;
  const next = structuredClone(base ?? blankProfile(id));
  const changes: Change[] = [];
  const problems: ProfileProblem[] = [];
  const problem = (code: string, section: string | null, field: string | null, text: string) =>
    problems.push({ code, file: read.file, section, field, item: null, text });
  const t = next.template;
  const p = next.presentation as WebCharacterPresentation;
  const set = <T>(field: string, before: T | undefined, after: T, assign: () => void) => {
    if (show(before) === show(after)) return;
    changes.push({ field, old: show(before), new: show(after) });
    assign();
  };

  // ---- 身份与展示 ----
  if (read.name !== '') set('人设名称', t.name, read.name, () => (t.name = read.name));
  if (read.displayName !== '')
    set('网页展示名', p.displayName, read.displayName, () => (p.displayName = read.displayName));
  if (read.oneLiner !== '')
    set('公开简介', p.publicDescription, read.oneLiner, () => (p.publicDescription = read.oneLiner));
  if (read.birthDate !== '') {
    const basic = t.authorCanon?.settings.basicInfo;
    if (isObject(basic) && typeof basic.birthDate === 'string' && basic.birthDate !== read.birthDate)
      problem(
        'PROFILE_BIRTH_CONFLICT',
        '1 基本信息',
        '生日',
        `与已有设定里的 basicInfo.birthDate（${basic.birthDate}）不一致，请先在工作台核对`,
      );
    else set('生日', t.birthDate, read.birthDate, () => (t.birthDate = read.birthDate));
  }
  if (read.seed === true) set('成长中', t.seed === true ? '是' : '否', '是', () => (t.seed = true));
  else if (read.seed === false) set('成长中', t.seed === true ? '是' : '否', '否', () => delete t.seed);

  // ---- 欢迎内容 ----
  if (read.welcome.length) set('欢迎词', p.welcome.text, read.welcome[0]!, () => (p.welcome.text = read.welcome[0]!));

  // ---- 主色 and the palette ----
  const main = read.palette.find((c) => c.role === 'main');
  if (main?.hex) set('主色', p.color, main.hex, () => (p.color = main.hex!));
  if (read.palette.length) {
    const palette = read.palette.map((c) => ({ hex: c.hex!, name: c.name, role: c.role }));
    set('色板', p.palette, palette, () => (p.palette = palette));
  }

  // ---- 性格: section 3 as labelled lines, template order ----
  if (read.persona.length) {
    const before = t.persona;
    const { owned, rest } = splitPersona(before);
    const lines = [...rest];
    for (const label of PERSONA_FIELDS) {
      const value = read.persona.find((x) => x.label === label)?.text ?? owned.get(label);
      if (value !== undefined && value !== '') lines.push(`${label}：${value}`);
    }
    const after = lines.join('\n');
    set('性格', before, after, () => (t.persona = after));
  }

  // ---- authorCanon ----
  const hasCanon =
    read.speech.length ||
    read.background.length ||
    Object.keys(read.facts).length ||
    Object.keys(read.boundaries).length;
  if (hasCanon) {
    const had = t.authorCanon;
    const settings: Record<string, JsonValue> = structuredClone(had?.settings ?? {});
    const before = structuredClone(settings);
    const touch = (key: string, value: JsonValue, label: string) => {
      if (show(before[key]) !== show(value)) changes.push({ field: label, old: show(before[key]), new: show(value) });
      settings[key] = value;
    };
    if (read.speech.length) {
      const current = settings.speechStyle;
      if (
        current !== undefined &&
        typeof current !== 'string' &&
        !(Array.isArray(current) && current.every((x) => typeof x === 'string'))
      )
        problem(
          'PROFILE_SHAPE_CONFLICT',
          '4 语言与声音特征',
          null,
          '已有的说话方式不是文字或文字列表，导入不会覆盖；请先在工作台处理',
        );
      else {
        const existing: string[] =
          typeof current === 'string' ? (current === '' ? [] : [current]) : ((current as string[] | undefined) ?? []);
        const owned = new Map<string, string>();
        const loose: string[] = [];
        for (const item of existing) {
          const label = SPEECH_FIELDS.find((l) => item.startsWith(`${l}：`));
          if (label) owned.set(label, item);
          else loose.push(item);
        }
        for (const { label, text } of read.speech) owned.set(label, `${label}：${text}`);
        const items = [...loose, ...SPEECH_FIELDS.filter((l) => owned.has(l)).map((l) => owned.get(l)!)];
        touch('speechStyle', items, '说话方式');
      }
    }
    if (read.background.length) {
      const current = settings.background;
      const shaped =
        current === undefined ||
        (Array.isArray(current) &&
          current.every(
            (x) => typeof x === 'string' || (isObject(x) && Object.keys(x).every((k) => k === 'title' || k === 'text')),
          ));
      if (!shaped)
        problem(
          'PROFILE_SHAPE_CONFLICT',
          '5 背景与生活',
          null,
          '已有的经历不是文字或 {title, text} 列表，导入不会覆盖；请先在工作台处理',
        );
      else {
        const existing = (current as (string | Record<string, JsonValue>)[] | undefined) ?? [];
        const titled = new Map<string, JsonValue>();
        const loose: JsonValue[] = [];
        for (const item of existing)
          if (
            isObject(item) &&
            typeof item.title === 'string' &&
            (BACKGROUND_FIELDS as readonly string[]).includes(item.title)
          )
            titled.set(item.title, item);
          else loose.push(item);
        for (const { title, text } of read.background) titled.set(title, { title, text });
        const items = [...loose, ...BACKGROUND_FIELDS.filter((l) => titled.has(l)).map((l) => titled.get(l)!)];
        touch('background', items, '经历');
      }
    }
    const merged = (
      key: 'profileFacts' | 'boundaries',
      order: readonly string[],
      values: Record<string, string>,
      section: string,
    ) => {
      if (!Object.keys(values).length) return;
      const current = settings[key];
      if (current !== undefined && !isObject(current))
        return problem(
          'PROFILE_SHAPE_CONFLICT',
          section,
          null,
          `已有的 ${key} 不是「字段名 → 内容」的对象，导入不会覆盖；请先在工作台处理`,
        );
      const existing = (current ?? {}) as Record<string, JsonValue>;
      const out: Record<string, JsonValue> = {};
      for (const label of order) {
        if (values[label] !== undefined) out[label] = values[label]!;
        else if (existing[label] !== undefined) out[label] = existing[label]!;
      }
      for (const [label, value] of Object.entries(existing)) if (!(label in out)) out[label] = value;
      touch(key, out, key === 'profileFacts' ? '其余设定 · profileFacts' : '其余设定 · boundaries');
    };
    merged(
      'profileFacts',
      FACT_FIELDS.map(([key]) => key),
      read.facts,
      '5 背景与生活',
    );
    merged('boundaries', BOUNDARY_FIELDS, read.boundaries, '8 边界与隐藏设定');
    if (show(settings) !== show(before) || !had) t.authorCanon = { kind: 'author_canon', settings };
  }

  // ---- what a NEW character cannot be without ----
  if (isNew) {
    const need = (ok: boolean, section: string, field: string) =>
      ok || problem('PROFILE_REQUIRED_FOR_NEW', section, field, '新角色必须填写这一项（工作台不接受空值）');
    need(read.name !== '', '1 基本信息', '人设名称');
    need(read.displayName !== '', '1 基本信息', '网页展示名／昵称');
    need(read.welcome.length > 0, '2 展示与欢迎内容', '欢迎词');
    need(read.persona.length > 0, '3 性格与相处方式', '（五项至少填一项）');
  }
  return { next, changes, problems };
}
