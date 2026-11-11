/**
 * 角色版本历史 (Part 24f). Shapes shared by the server and the admin page. A version is an immutable snapshot of a published
 * profile; nothing here carries an email, an id of a person or any player content.
 */
import { upgradeWelcomes } from "./web-welcomes.js";
/** Why an old version cannot be made current again. The page says 「不可恢复」 and this reason; the server refuses a direct call. */
export const RESTORE_PROBLEMS = [
    'VOICE_BINDING_MISSING',
    'CLIP_MISSING',
    'MATERIAL_MISSING',
    'PROFILE_INVALID',
];
export const RESTORE_PROBLEM_TEXT = {
    VOICE_BINDING_MISSING: '这一版用的已批准声音绑定已经找不到',
    CLIP_MISSING: '这一版的欢迎或结束语音成品已经不在',
    MATERIAL_MISSING: '这一版发布时用的已批准成品材料不完整',
    PROFILE_INVALID: '这一版的资料已不能通过现在的校验',
};
const stable = (value) => Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
        ? `{${Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
            .join(',')}}`
        : JSON.stringify(value);
/** The five groups of the editor, the same cut as 资料改动 (and the draft chip) uses. */
const GROUPS = [
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
/** The names of the groups in which two profiles differ (the version number itself never counts). Part 24b-7 reads it for 草稿记录. */
export const changedGroups = (before, after) => GROUPS.filter(([, part]) => stable(part(before)) !== stable(part(after))).map(([name]) => name);
/** One line for the history list. The version number itself never counts as a change. */
export function describeChange(before, after) {
    if (!before)
        return '初始版本';
    const changed = changedGroups(before, after);
    if (!changed.length)
        return '内容与上一版相同';
    if (changed.length === 1 && changed[0] === '主色')
        return '只改了主色';
    return `改动：${changed.join('、')}`;
}
