import { DetailedError } from '../../../packages/domain/errors.ts';
import { mergeFields, type Fields } from '../../../packages/contracts/draft-merge.ts';
import { COCREATION_FIELD_LABELS } from '../../../packages/contracts/cocreation-cards.ts';
import { CORE_FIELD_KEYS, CORE_FIELD_LABELS } from '../../../packages/contracts/speech-profile.ts';
import { DAILY_LIFE_KEY, DAILY_LIFE_LABEL } from '../../../packages/contracts/cocreation-day.ts';
import type { WebCharacterProfile } from './web-character-catalog.ts';

/**
 * Part 55: a character draft is saved against the revision AND the published version it was read at. When either has moved on (an
 * adoption wrote into the draft, a publish or a restore made a new live version) the save is not refused any more: the server
 * merges the page's edit into what is stored now, field by field (`packages/contracts/draft-merge.ts`). Only a field changed on
 * both sides is a conflict, and it is named.
 *
 * A FIELD is: each key of `template` (except `version`, which the server owns), each key of `template.authorCanon.settings` (and
 * each other key of `authorCanon`), and each key of `presentation`.
 */
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const SEP = '\u0001';

export function profileFields(profile: WebCharacterProfile): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  const template = profile.template as unknown as Obj;
  for (const [key, value] of Object.entries(template)) {
    if (key === 'version') continue;
    if (key === 'authorCanon' && isObj(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (inner === 'settings' && isObj(innerValue))
          for (const [setting, settingValue] of Object.entries(innerValue))
            fields.set(['template', 'authorCanon', 'settings', setting].join(SEP), settingValue);
        else fields.set(['template', 'authorCanon', inner].join(SEP), innerValue);
      }
    } else fields.set(['template', key].join(SEP), value);
  }
  for (const [key, value] of Object.entries(profile.presentation as unknown as Obj))
    fields.set(['presentation', key].join(SEP), value);
  return fields;
}

const setAt = (root: Obj, path: string[], value: unknown) => {
  let at = root;
  for (const part of path.slice(0, -1)) {
    if (!isObj(at[part])) at[part] = {};
    at = at[part] as Obj;
  }
  const last = path.at(-1)!;
  if (value === undefined) delete at[last];
  else at[last] = structuredClone(value);
};

const SECTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  persona: COCREATION_FIELD_LABELS.persona,
  name: '角色名',
  displayName: '显示名称',
  publicDescription: '公开简介',
  welcomes: '欢迎语',
  color: '颜色',
  palette: '配色',
  avatar: '头像',
  schedule: '周作息',
  voice: '音色',
});
const SETTING_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ...COCREATION_FIELD_LABELS,
  ...Object.fromEntries(
    Object.entries(CORE_FIELD_KEYS).map(([field, key]) => [key, CORE_FIELD_LABELS[field as never]]),
  ),
  [DAILY_LIFE_KEY]: DAILY_LIFE_LABEL,
});
/** The sentence-ready name of a field path: the admin's own word for it, else a plain "其他设定". */
export function fieldLabel(path: string): string {
  const parts = path.split(SEP);
  if (parts[0] === 'template' && parts[1] === 'authorCanon' && parts[2] === 'settings')
    return (SETTING_LABELS as Record<string, string>)[parts[3]!] ?? '其他设定';
  return SECTION_LABELS[parts.at(-1)!] ?? '其他设定';
}

/**
 * `mine` and `theirs` changed from `base`. Returns `theirs` with what `mine` changed written over it (the `version` of the result is
 * left as `theirs`'s: the caller sets it). Throws DRAFT_FIELD_CONFLICT with the labels of the fields both sides changed.
 */
export function rebaseProfile(
  base: WebCharacterProfile,
  mine: WebCharacterProfile,
  theirs: WebCharacterProfile,
): WebCharacterProfile {
  const merged = mergeFields(
    profileFields(base) as Fields,
    profileFields(mine) as Fields,
    profileFields(theirs) as Fields,
  );
  if (merged.conflicts.length)
    throw new DetailedError('DRAFT_FIELD_CONFLICT', {
      fields: [...new Set(merged.conflicts.map(fieldLabel))],
    });
  const next = structuredClone(theirs) as unknown as Obj;
  for (const path of merged.changedByMe) setAt(next, path.split(SEP), merged.values.get(path));
  return next as unknown as WebCharacterProfile;
}
