import type { CharacterProfile } from '../../services/character-admin-api.ts';
import type { JsonValue, Weekday, WeeklySchedule } from '../../../../../packages/contracts/index.ts';
export class AdminFormError extends Error {}
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
export function field(
  parent: HTMLElement,
  label: string,
  value: string,
  options: { area?: boolean; type?: string; required?: boolean; max?: number } = {},
) {
  const row = el('label'),
    text = el('span', label),
    input = options.area ? el('textarea') : el('input');
  if (input instanceof HTMLInputElement) input.type = options.type ?? 'text';
  input.value = value;
  input.required = options.required ?? false;
  if (options.max) input.maxLength = options.max;
  if (input instanceof HTMLTextAreaElement) input.rows = 5;
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
  section.append(el('summary', title));
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
    presentation: { displayName: '', publicDescription: '', welcome: { text: '', version: 'welcome-v1' } },
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
    welcomeText: string;
    welcomeVersion: string;
    canon: string;
    voice: null | { profileId: string; version: number; speed: number };
  },
): CharacterProfile {
  const next = structuredClone(base),
    t = next.template;
  t.id = values.id.trim();
  t.name = values.name;
  t.persona = values.persona;
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
    welcome: { text: values.welcomeText, version: values.welcomeVersion.trim() },
  };
  return next;
}

export function characterForm(
  parent: HTMLElement,
  base: CharacterProfile,
  isNew: boolean,
  onChange: () => void,
  onError: (e: unknown) => void,
) {
  const form = el('form');
  form.className = 'character-profile-form';
  parent.append(form);
  const identity = el('fieldset');
  identity.append(el('legend', '身份与网页展示'));
  form.append(identity);
  const id = field(identity, '固定人物 ID', base.template.id, { required: true, max: 128 }) as HTMLInputElement;
  id.pattern = '[A-Za-z0-9_-]{1,128}';
  id.readOnly = !isNew;
  identity.append(
    el(
      'p',
      isNew
        ? '使用英文、数字、短横线或下划线；保存后不能改 ID。删除后的 ID 也不能复用。'
        : '固定身份不可修改；名称和展示名通过新版本更新。',
    ),
  );
  const name = field(identity, '人设名称', base.template.name, { required: true, max: 100 });
  const displayName = field(identity, '网页展示名', base.presentation.displayName, { required: true, max: 100 });
  const birthDate = field(identity, '设定生日（可选）', base.template.birthDate ?? '', { type: 'date' });
  const publicDescription = field(identity, '公开简介', base.presentation.publicDescription, { area: true, max: 500 });
  const persona = field(form, '基础人设', base.template.persona, { area: true, required: true, max: 20000 });
  const welcome = el('fieldset');
  welcome.append(el('legend', '欢迎内容'));
  form.append(welcome);
  const welcomeText = field(welcome, '欢迎词', base.presentation.welcome.text, {
    area: true,
    required: true,
    max: 500,
  });
  const welcomeVersion = field(welcome, '欢迎词版本标识', base.presentation.welcome.version, {
    required: true,
    max: 128,
  });
  welcome.append(
    el('p', '修改欢迎词或版本标识后，需要匹配新草稿的欢迎／结束成品批准，保存不会替换玩家当前听到的音频。'),
  );
  const canonSection = disclosure(form, '结构化作者设定与说话样例');
  canonSection.append(
    el(
      'p',
      '保留已审定的虚构背景，不是玩家共同经历。修改人设名称会追加到身份别名；生日会同步 basicInfo.birthDate，其余字段保留。',
    ),
  );
  const canon = field(
    canonSection,
    '作者设定 JSON',
    JSON.stringify(base.template.authorCanon?.settings ?? {}, null, 2),
    { area: true, max: 48000 },
  );
  canon.className = 'admin-json';
  const voiceSection = disclosure(form, '声音绑定');
  voiceSection.append(el('p', '只登记已有音色的标识与版本，不创建／克隆外部声音。发布新人物须另准备并批准两条成品。'));
  const voiceOn = check(voiceSection, '绑定已有音色');
  voiceOn.checked = !!base.template.voice;
  const profileId = field(voiceSection, '音色档案 ID', base.template.voice?.profileId ?? '', { max: 128 });
  const voiceVersion = field(voiceSection, '音色档案版本', String(base.template.voice?.version ?? 1), {
    type: 'number',
  }) as HTMLInputElement;
  voiceVersion.min = '1';
  voiceVersion.step = '1';
  const speed = field(voiceSection, '语速', String(base.template.voice?.speed ?? 1), {
    type: 'number',
  }) as HTMLInputElement;
  speed.min = '0.5';
  speed.max = '2';
  speed.step = 'any';
  form.addEventListener('input', onChange);
  form.addEventListener('change', onChange);
  const read = () => {
    if (!form.reportValidity()) throw new AdminFormError('请先补齐或修正标记的资料字段。');
    return editedCharacter(base, {
      id: id.value,
      name: name.value,
      birthDate: birthDate.value,
      persona: persona.value,
      displayName: displayName.value,
      publicDescription: publicDescription.value,
      welcomeText: welcomeText.value,
      welcomeVersion: welcomeVersion.value,
      canon: canon.value,
      voice: voiceOn.checked
        ? { profileId: profileId.value.trim(), version: Number(voiceVersion.value), speed: Number(speed.value) }
        : null,
    });
  };
  return {
    form,
    read,
    setDisabled: (disabled: boolean) => {
      for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(
        'input,textarea,button',
      )) {
        input.dataset.locked = String(disabled);
        input.disabled = disabled;
      }
    },
  };
}
