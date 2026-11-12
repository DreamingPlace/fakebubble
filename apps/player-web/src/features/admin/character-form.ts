import type { CharacterProfile } from '../../services/character-admin-api.ts';
import { derivePalette, parseColour } from '../brand/character-colour.ts';
import { ROSTER_COLOURS, whoUses } from './ui/character-colour.ts';
import { CanonError, canonEditors } from './character-canon.ts';
import { hoverValue } from './ui/hover-value.ts';
import { evenWeights, upgradeWelcomes, type WelcomeLine } from '../../../../../packages/contracts/web-welcomes.ts';
import { newLineId, welcomeList } from './welcome-list.ts';
import { paletteList, type PaletteEntry } from './palette-list.ts';
import { markDirty } from './ui/unsaved.ts';
import { growBox, shortInput } from './ui/grow-box.ts';
import { disclosureDetails } from './ui/disclosure.ts';
import type { JsonValue, Weekday, WeeklySchedule } from '../../../../../packages/contracts/index.ts';
export class AdminFormError extends Error {}
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
/**
 * One labelled field, shaped by what it holds (Part 24b-7b). `kind`:
 *   'short' — a single-line input as wide as its limit (names, codes, ids, a date, a number);
 *   'one'   — one sentence: a box that starts at one line and grows as the text wraps;
 *   'para'  — a paragraph: starts at four lines and grows with the text.
 * Without `kind`: `area` means 'para', anything else 'short'.
 */
export type FieldKind = 'short' | 'one' | 'para';
export function field(
  parent: HTMLElement,
  label: string,
  value: string,
  options: { area?: boolean; type?: string; required?: boolean; max?: number; kind?: FieldKind } = {},
) {
  const kind: FieldKind = options.kind ?? (options.area ? 'para' : 'short');
  const row = el('label'),
    text = el('span', label),
    input = kind === 'short' ? el('input') : el('textarea');
  row.dataset.kind = kind;
  if (input instanceof HTMLInputElement) input.type = options.type ?? 'text';
  input.value = value;
  input.required = options.required ?? false;
  if (options.max) input.maxLength = options.max;
  if (kind !== 'short') growBox(input as HTMLTextAreaElement, kind === 'one' ? 'one' : 'para');
  else if (!options.type || options.type === 'text') shortInput(input as HTMLInputElement, options.max ?? 24);
  else input.className = `${input.className} si si-${options.type}`.trim();
  row.append(text, input);
  parent.append(row);
  return input;
}
export function check(parent: HTMLElement, label: string) {
  const row = el('label'),
    input = el('input');
  input.type = 'checkbox';
  row.className = 'admin-check';
  row.append(input, el('span', label));
  parent.append(row);
  return input;
}
export function disclosure(parent: HTMLElement, title: string) {
  const section = el('details');
  disclosureDetails(section, title);
  parent.append(section);
  return section;
}
export function emptyCharacter(): CharacterProfile {
  const days = {} as WeeklySchedule['days'];
  for (let i = 0; i < 7; i++) days[i as Weekday] = [{ startMinute: 0, endMinute: 1440, probability: 1, catchUp: true }];
  return {
    template: {
      id: '',
      name: '',
      version: 1,
      fictional: true,
      persona: '',
      schedule: { timeZone: 'Asia/Singapore', days },
    },
    // A new character starts with three (empty) welcome lines, 34 / 33 / 33.
    presentation: {
      displayName: '',
      publicDescription: '',
      welcomes: evenWeights(3).map((weight) => ({ id: newLineId(), text: '', weight })),
    },
  };
}
/** Preserves the entire approved template. Only linked identity/name and birthday are synchronized. */
export function editedCharacter(
  base: CharacterProfile,
  values: {
    id: string;
    name: string;
    birthDate: string;
    persona: string;
    displayName: string;
    publicDescription: string;
    /** Part 24k-2: the welcome lines with their percents. */
    welcomes: WelcomeLine[];
    /** Part 24k-2: 主 + 点缀 (null = none). Absent = keep what the base says. */
    palette?: PaletteEntry[] | null;
    /** '' = no main colour (the player page keeps its built-in palette); otherwise '#RRGGBB'. */
    color?: string;
    canon: string;
    voice: null | { profileId: string; version: number; speed: number; referenceId?: string };
    /** Part 24c: 成长中 (seed character). Absent = keep what the base says. */
    seed?: boolean;
  },
): CharacterProfile {
  const next = structuredClone(base),
    t = next.template;
  t.id = values.id.trim();
  t.name = values.name;
  t.persona = values.persona;
  // The key is absent, not false, for a finished character: a profile without it hashes exactly as it always did.
  if (values.seed === true) t.seed = true;
  else if (values.seed === false) delete t.seed;
  let settings: Record<string, JsonValue>;
  try {
    const parsed: unknown = JSON.parse(values.canon);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    settings = parsed as Record<string, JsonValue>;
  } catch {
    throw new AdminFormError('结构化设定必须是有效的 JSON 对象；原资料尚未修改。');
  }
  if (settings.selfIdentity && typeof settings.selfIdentity === 'object' && !Array.isArray(settings.selfIdentity)) {
    const names = settings.selfIdentity.names;
    if (Array.isArray(names) && !names.includes(t.name)) settings.selfIdentity.names = [...names, t.name];
  }
  if (values.birthDate) t.birthDate = values.birthDate;
  else delete t.birthDate;
  if (settings.basicInfo && typeof settings.basicInfo === 'object' && !Array.isArray(settings.basicInfo)) {
    if (values.birthDate) settings.basicInfo.birthDate = values.birthDate;
    else delete settings.basicInfo.birthDate;
  }
  if (base.template.authorCanon || Object.keys(settings).length) t.authorCanon = { kind: 'author_canon', settings };
  else delete t.authorCanon;
  if (values.voice) t.voice = { ...t.voice, ...values.voice };
  else delete t.voice;
  next.presentation = {
    displayName: values.displayName,
    publicDescription: values.publicDescription,
    welcomes: values.welcomes.map((line) => ({ id: line.id, text: line.text, weight: line.weight })),
    // The key is absent, not empty, when there is no colour: a profile without one hashes exactly as it always did.
    ...(values.color ? { color: values.color } : {}),
    // Part 24k-2: 主 + 点缀, edited here; `color` is always the 主's hex. Absent = kept as it came in.
    ...(values.palette === undefined
      ? base.presentation.palette
        ? { palette: structuredClone(base.presentation.palette) }
        : {}
      : values.palette
        ? { palette: values.palette }
        : {}),
  };
  return next;
}

const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
          .join(',')}}`
      : JSON.stringify(value);
/**
 * True when the draft differs from the published profile in the main colour and nothing else (the version number it will be
 * published under aside). Such a draft is published without a 预演; the server makes the same comparison and has the last word.
 */
export function isColourOnlyChange(published: CharacterProfile | null, draft: CharacterProfile): boolean {
  // Part 24k-2: 主色 and 点缀 are both colour; the server's gate (withoutColour) says the same.
  if (
    !published ||
    (published.presentation.color === draft.presentation.color &&
      stable(published.presentation.palette ?? null) === stable(draft.presentation.palette ?? null))
  )
    return false;
  const bare = (profile: CharacterProfile) => {
    const { color: _color, palette: _palette, ...presentation } = profile.presentation;
    return stable({ template: { ...profile.template, version: 0 }, presentation });
  };
  return bare(published) === bare(draft);
}

/**
 * 主色: one text field that takes #RRGGBB or r, g, b, a colour-picker swatch that writes into it, and a live chip showing the card
 * tint, its ink and the three aura clouds that the player page will derive. Empty means "no colour". Anything else that does not
 * parse is flagged on the field and refused when the form is read.
 */
export function colourField(
  parent: HTMLElement,
  initial: string | undefined,
  onChange: () => void,
  selfId: string | null = null,
) {
  const row = el('div');
  row.className = 'colour-field';
  const label = el('label'),
    input = el('input'),
    picker = el('input'),
    chip = el('span');
  label.append(el('span', '主色'), input);
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = '#RRGGBB 或 r, g, b';
  input.value = initial ?? '';
  // #RRGGBB or r, g, b: sixteen visible characters; the field still takes forty and widens with its text.
  shortInput(input, 16);
  input.autocomplete = 'off';
  picker.type = 'color';
  // The swatch starts on a soft tint, not the browser's black: the text field decides whether there is a colour at all.
  picker.value = '#ddd8f0';
  picker.title = '取色';
  picker.setAttribute?.('aria-label', '取色');
  chip.className = 'colour-chip';
  chip.setAttribute?.('role', 'img');
  const paint = () => {
    const parsed = input.value.trim() === '' ? '' : parseColour(input.value);
    input.setAttribute?.('aria-invalid', String(parsed === null));
    chip.dataset.state = parsed === null ? 'invalid' : parsed === '' ? 'empty' : 'ok';
    chip.setAttribute?.('aria-label', parsed ? `主色 ${parsed}` : parsed === null ? '颜色格式不对' : '未设置');
    chip.replaceChildren();
    if (!parsed) return;
    picker.value = parsed.toLowerCase();
    const palette = derivePalette(parsed);
    chip.style?.setProperty('--chip-tint', palette.color);
    chip.style?.setProperty('--chip-ink', palette.ink);
    chip.append(el('b', '字'));
    palette.aura.forEach((colour, index) => {
      const dot = el('i');
      dot.style?.setProperty('--dot', colour);
      dot.dataset.n = String(index);
      chip.append(dot);
    });
  };
  input.addEventListener('input', () => {
    paint();
    onChange();
  });
  picker.addEventListener('input', () => {
    input.value = picker.value.toUpperCase();
    paint();
    onChange();
  });
  // The palette: one swatch per colour; a colour another character already wears shows that character's initial on hover (no text),
  // and a chosen colour that equals another character's gets a small amber mark.
  const swatches = el('div'),
    same = el('span');
  swatches.className = 'colour-swatches';
  same.className = 'colour-same';
  same.hidden = true;
  const swatchOf = new Map<string, HTMLElement>();
  for (const hex of ROSTER_COLOURS) {
    const swatch = el('button');
    swatch.type = 'button';
    swatch.className = 'colour-swatch';
    swatch.style?.setProperty('--sw', hex);
    swatch.dataset.color = hex;
    swatch.setAttribute?.('aria-label', `主色 ${hex}`);
    swatch.addEventListener('click', () => {
      input.value = hex;
      paint();
      paintSwatches();
      onChange();
    });
    swatchOf.set(hex, swatch);
    swatches.append(swatch);
  }
  const paintSwatches = () => {
    const parsed = input.value.trim() === '' ? '' : parseColour(input.value);
    for (const [hex, swatch] of swatchOf) {
      const others = whoUses(hex, selfId);
      const initial = others[0]?.name ? [...others[0].name][0]! : '';
      swatch.classList?.toggle('is-used', others.length > 0);
      swatch.dataset.initial = others.length ? initial : '';
      swatch.setAttribute?.('aria-pressed', String(!!parsed && parsed.toUpperCase() === hex));
      if (others.length) swatch.setAttribute?.('title', others.map((o) => o.name).join('、'));
      else swatch.removeAttribute?.('title');
    }
    const clash = parsed ? whoUses(parsed, selfId) : [];
    same.hidden = clash.length === 0;
    same.textContent = clash.length ? `和 ${clash[0]!.name} 同色` : '';
  };
  input.addEventListener('input', paintSwatches);
  picker.addEventListener('input', paintSwatches);
  // Part 24b-6b: the swatch and the live chip sit together in the second grid column, so the text field is one column wide like every other field.
  const tools = el('span');
  tools.className = 'colour-tools';
  tools.append(picker, chip);
  row.append(label, tools, same, swatches);
  parent.append(row);
  paint();
  paintSwatches();
  return {
    input,
    picker,
    /** '' for none, '#RRGGBB' for a valid one; a typed value that does not parse is refused. */
    read: () => {
      if (input.value.trim() === '') return '';
      const parsed = parseColour(input.value);
      if (!parsed) throw new AdminFormError('主色请填 #RRGGBB（如 #E8561E）或 r, g, b（0–255）。');
      return parsed;
    },
  };
}

export type FormPane = { id: string; label: string; node: HTMLElement };

/** The editor sections whose content differs between a published profile and a draft: what 草稿有 N 处改动 counts. */
export function changedSections(published: CharacterProfile | null, draft: CharacterProfile): string[] {
  const part = (profile: CharacterProfile | null, id: string) => {
    if (!profile) return null;
    const { template: t, presentation: p } = profile;
    const settings = (t.authorCanon?.settings ?? {}) as Record<string, unknown>;
    const { speechStyle, dialogueStyle, dialogueExamples, background, ...rest } = settings;
    return stable(
      {
        identity: [
          t.id,
          t.name,
          t.birthDate ?? null,
          p.displayName,
          p.publicDescription,
          p.color ?? null,
          p.palette ?? null,
          t.seed === true,
        ],
        welcome: upgradeWelcomes(p),
        persona: t.persona,
        speech: [speechStyle ?? null, dialogueStyle ?? null, dialogueExamples ?? null],
        past: background ?? null,
        raw: t.authorCanon ? rest : null,
        voice: t.voice ?? null,
      }[id] ?? null,
    );
  };
  return ['identity', 'welcome', 'persona', 'speech', 'past', 'raw', 'voice'].filter(
    (id) => part(published, id) !== part(draft, id),
  );
}

/** A small heading that opens a group of fields inside a tab (Part 24b-7b). */
const sec = (parent: HTMLElement, text: string) => {
  const node = el('h4', text);
  node.className = 'wb-sec';
  parent.append(node);
};
export function characterForm(
  parent: HTMLElement,
  base: CharacterProfile,
  isNew: boolean,
  onChange: () => void,
  onError: (e: unknown) => void,
  /** A required or malformed field sits in this section (null: unknown); the console shows it before the browser complains. */
  onInvalid?: (pane: string | null) => void,
  /** The voice the character speaks with now (from the server): the form's Fish id and 语速 start from it. */
  voiceHint?: { referenceId: string; profileId: string; version: number; speed: number } | null,
) {
  const form = el('form');
  form.className = 'character-profile-form';
  parent.append(form);
  const identity = el('fieldset');
  identity.append(el('legend', '身份与网页展示'));
  form.append(identity);
  sec(identity, '基本信息');
  const id = field(identity, '固定人物 ID', base.template.id, {
    required: true,
    max: 128,
    kind: 'short',
  }) as HTMLInputElement;
  // `\-` (not a bare trailing `-`): the browser compiles `pattern` with the v flag, where a bare `-` in a class is a syntax error.
  id.pattern = '[A-Za-z0-9_\\-]{1,128}';
  id.readOnly = !isNew;
  // The fixed-id sentence of an existing role is gone (Part 24b-4): the field is read-only, which says it. A new role keeps the id rule.
  if (isNew) identity.append(el('p', '使用英文、数字、短横线或下划线；保存后不能改 ID。删除后的 ID 也不能复用。'));
  // 人设名称 / 网页展示名 are names (the template caps 人设名称 at 12): a single-line input sized to a name, wider only when the text is.
  const name = field(identity, '人设名称', base.template.name, { required: true, max: 100, kind: 'short' });
  const displayName = field(identity, '网页展示名', base.presentation.displayName, {
    required: true,
    max: 100,
    kind: 'short',
  });
  const birthDate = field(identity, '设定生日（可选）', base.template.birthDate ?? '', { type: 'date' });
  const publicDescription = field(identity, '公开简介', base.presentation.publicDescription, { kind: 'one', max: 500 });
  sec(identity, '颜色');
  const colour = colourField(identity, base.presentation.color, () => onChange(), isNew ? null : base.template.id);
  // Part 24k-2: the colours as a list (主 mirrors the field above; 点缀 follow); the chip shows what a player will see.
  const colours = paletteList(
    base.presentation.palette,
    () => {
      try {
        return colour.read();
      } catch {
        return null;
      }
    },
    () => onChange(),
  );
  identity.append(colours.node);
  colour.input.addEventListener('input', () => colours.refresh());
  colour.picker.addEventListener('input', () => colours.refresh());
  identity.addEventListener('click', () => colours.refresh());
  // 成长中 (Part 24c): a switch in 身份与展示; the title row and the rail show the same state.
  sec(identity, '状态');
  const seed = check(identity, '成长中');
  seed.checked = base.template.seed === true;
  seed.className = 'wb-switch';
  const personaSet = el('fieldset');
  personaSet.append(el('legend', '性格'));
  form.append(personaSet);
  const persona = field(personaSet, '基础人设', base.template.persona, { kind: 'para', required: true, max: 20000 });
  const welcome = el('fieldset');
  welcome.append(el('legend', '欢迎内容'));
  form.append(welcome);
  // Part 24k-2: 1-8 weighted lines; each player gets one of them (by weight, once) and hears that line's clip.
  const welcomes = welcomeList(upgradeWelcomes(base.presentation), () => onChange());
  welcome.append(welcomes.node);
  welcomes.node.title =
    '每位玩家第一次见到这个角色时，按比例抽中一条并固定下来。改动欢迎词的文字后，需要为新草稿准备并批准每一条的成品，保存不会替换玩家当前听到的音频。';
  const parts = canonEditors((base.template.authorCanon?.settings ?? {}) as Record<string, JsonValue>, () =>
    onChange(),
  );
  form.append(parts.speech, parts.past);
  const rawSet = el('fieldset');
  rawSet.append(el('legend', '其余设定'));
  form.append(rawSet);
  // Round 2: 个人资料 and 边界与隐藏设定 are structured; what no editor owns stays in a JSON box, folded and only there when such keys exist.
  rawSet.append(parts.other);
  let jsonHost: HTMLElement = el('div');
  if (parts.hasRest) {
    const fold = el('details');
    disclosureDetails(fold, '其他（JSON）');
    rawSet.append(fold);
    jsonHost = fold;
  }
  const canon = field(jsonHost, '其他（JSON）', parts.rest, { kind: 'para', max: 48000 });
  canon.className = `${canon.className} admin-json`.trim();
  const voiceSection = el('fieldset');
  voiceSection.append(el('legend', '声音'));
  form.append(voiceSection);
  sec(voiceSection, '音色绑定');
  // Part 29 B: ONE voice field. The binding (profile id, version) is derived from the Fish id; only a hand-made one is kept as it is.
  const effective = voiceHint ?? null;
  const fishId = field(voiceSection, 'Fish 音色 ID', base.template.voice?.referenceId ?? effective?.referenceId ?? '', {
    max: 128,
  }) as HTMLInputElement;
  // Part 27: the `-` is escaped - the browser reads a pattern attribute with the v flag, where a bare trailing `-` in a class is a syntax error.
  fishId.pattern = '[A-Za-z0-9_\\-]{1,128}';
  if (fishId.parentElement)
    hoverValue(
      fishId.parentElement as HTMLElement,
      '只登记已有音色的 ID，不创建／克隆外部声音。导入资料时填的 Fish 音色 ID 会直接带到这里。',
    );
  const speed = field(voiceSection, '语速', String(base.template.voice?.speed ?? effective?.speed ?? 1), {
    type: 'number',
  }) as HTMLInputElement;
  speed.min = '0.5';
  speed.max = '2';
  speed.step = 'any';
  // A changed field turns amber until the draft is saved (and the page re-renders from what was saved).
  for (const control of form.querySelectorAll?.<HTMLInputElement | HTMLTextAreaElement>('input,textarea') ?? [])
    if (control.getAttribute?.('data-was') === null || control.getAttribute?.('data-was') === undefined)
      control.setAttribute?.(
        'data-was',
        control.type === 'checkbox' ? String((control as HTMLInputElement).checked) : control.value,
      );
  const flag = (event: Event) => {
    const control = event.target as HTMLInputElement | null;
    const was = control?.getAttribute?.('data-was');
    if (!control || was === null || was === undefined) return;
    markDirty(control, (control.type === 'checkbox' ? String(control.checked) : control.value) !== was);
  };
  form.addEventListener('input', flag);
  form.addEventListener('change', flag);
  form.addEventListener('input', onChange);
  form.addEventListener('change', onChange);
  /** The editor's sections (Part 24b-3), in the order of the console's rail. Each is a node of this one form. */
  const panes: FormPane[] = [
    { id: 'identity', label: '身份与展示', node: identity },
    { id: 'welcome', label: '欢迎内容', node: welcome },
    { id: 'persona', label: '性格', node: personaSet },
    { id: 'speech', label: '说话方式', node: parts.speech },
    { id: 'past', label: '经历', node: parts.past },
    { id: 'raw', label: '其余设定', node: rawSet },
    { id: 'voice', label: '声音', node: voiceSection },
  ];
  const controlsOf = (node: HTMLElement) => [
    ...(node.querySelectorAll?.<HTMLInputElement | HTMLTextAreaElement>('input,textarea') ?? []),
  ];
  const valuesOf = (node: HTMLElement) =>
    controlsOf(node).map((control) =>
      control.type === 'checkbox' ? String((control as HTMLInputElement).checked) : control.value,
    );
  const initial = new Map(panes.map((pane) => [pane.id, valuesOf(pane.node).join('\u0000')]));
  const assembled = () => {
    try {
      return JSON.stringify(parts.assemble(canon.value));
    } catch (error) {
      throw error instanceof CanonError ? new AdminFormError(error.message) : error;
    }
  };
  /**
   * What the draft's voice binding becomes. Nothing typed changed -> the binding as it is (none for an imported character: the
   * binding stays derived and no revision is written for it). A changed id or speed -> a binding with a derived profile id and a
   * version one higher when the id changed; a hand-made binding keeps its own profile id.
   */
  const readVoice = (): { profileId: string; version: number; speed: number; referenceId?: string } | null => {
    const typed = fishId.value.trim(),
      rate = Number(speed.value);
    const bound = base.template.voice ?? null;
    const was = bound?.referenceId ?? effective?.referenceId ?? '';
    const wasRate = bound?.speed ?? effective?.speed ?? 1;
    if (typed === was && rate === wasRate) return bound;
    if (!typed) return bound;
    const prior = bound ?? effective;
    const idChanged = typed !== was;
    return {
      ...(bound ?? {}),
      profileId: prior?.profileId ?? base.template.id,
      version: (prior?.version ?? 0) + (prior ? (idChanged ? 1 : 0) : 1),
      speed: rate,
      referenceId: typed,
    };
  };
  const read = () => {
    // A control in a section that is not showing cannot take the browser's bubble: show that section first.
    const bad = panes.find((pane) => controlsOf(pane.node).some((c) => c.willValidate && c.validity?.valid === false));
    if (bad) onInvalid?.(bad.id);
    if (!form.reportValidity()) throw new AdminFormError('请先补齐或修正标记的资料字段。');
    const problem = welcomes.problems()[0];
    if (problem) {
      onInvalid?.('welcome');
      throw new AdminFormError(problem.message);
    }
    return editedCharacter(base, {
      id: id.value,
      name: name.value,
      birthDate: birthDate.value,
      persona: persona.value,
      displayName: displayName.value,
      publicDescription: publicDescription.value,
      welcomes: welcomes.read(),
      // (the 主色 is read first: its own refusal is the one to show)
      color: colour.read(),
      palette: (() => {
        try {
          return colours.read();
        } catch {
          throw new AdminFormError('点缀请填 #RRGGBB（如 #E8561E）或 r, g, b（0–255）。');
        }
      })(),
      canon: assembled(),
      seed: seed.checked,
      voice: readVoice(),
    });
  };
  return {
    form,
    read,
    panes,
    seed: () => seed.checked,
    /** The sections whose fields differ from what was loaded (a field typed back to its old value no longer counts). */
    changed: () => panes.filter((pane) => valuesOf(pane.node).join('\u0000') !== initial.get(pane.id)).map((p) => p.id),
    setDisabled: (disabled: boolean) => {
      for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(
        'input,textarea,button',
      )) {
        input.dataset.locked = String(disabled);
        input.disabled = disabled;
      }
      // (after the generic pass above: the lists keep their own limits, e.g. no ninth line, when they are enabled again)
      welcomes.setDisabled(disabled);
      colours.setDisabled(disabled);
      parts.setDisabled(disabled);
    },
  };
}
