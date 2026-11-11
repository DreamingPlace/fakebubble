import { upgradeWelcomes } from "../../../../../../packages/contracts/web-welcomes.js";
/** A value of the profile as plain words: text as it is, lists as lines, groups as "名：值" lines. Never JSON. */
export function plain(value, depth = 0) {
    if (value === null || value === undefined || value === '')
        return '—';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
    if (Array.isArray(value))
        return value
            .map((item) => (depth === 0 ? `• ${plain(item, depth + 1).replace(/\n/g, '\n  ')}` : plain(item, depth + 1)))
            .join(depth === 0 ? '\n' : '；');
    const lines = Object.entries(value).map(([key, child]) => {
        const text = plain(child, depth + 1);
        return text.includes('\n') ? `${key}：\n  ${text.replace(/\n/g, '\n  ')}` : `${key}：${text}`;
    });
    return lines.join('\n');
}
/** 网页展示 as labelled fields. */
export const presentationFields = (profile) => {
    const p = profile.presentation;
    return [
        ['网页展示名', p.displayName],
        ['公开简介', plain(p.publicDescription)],
        ['主色', plain(p.color)],
        // Part 24k-2: line by line, each with its percent.
        ...upgradeWelcomes(p).map((line, i, all) => [
            all.length === 1 ? '欢迎词' : `欢迎词 ${i + 1}`,
            all.length === 1 ? line.text : `${line.text}（${line.weight}%）`,
        ]),
        [
            '色板',
            p.palette?.length
                ? p.palette.map((c) => `${c.role === 'main' ? '主' : '点缀'} ${c.hex}${c.name ? ` ${c.name}` : ''}`).join('\n')
                : '—',
        ],
    ];
};
/** 完整模板 as labelled fields; the version number it is published under is not content and is left out. */
export const templateFields = (profile) => {
    const t = profile.template;
    const days = Object.values(t.schedule?.days ?? {});
    const canon = (t.authorCanon?.settings ?? {});
    return [
        ['固定人物 ID', t.id],
        ['人设名称', t.name],
        ['设定生日', plain(t.birthDate)],
        ['成长中角色', plain(t.seed === true)],
        ['声音', t.voice ? `${t.voice.profileId} · 版本 ${t.voice.version} · 语速 ${t.voice.speed}` : '—'],
        ['作息', `${t.schedule?.timeZone ?? '—'} · 每周 ${days.reduce((n, d) => n + d.length, 0)} 个时段`],
        ['主动联系', t.autonomy ? plain(t.autonomy) : '无'],
        ...Object.entries(canon).map(([key, value]) => [`设定 · ${key}`, plain(withoutIds(value))]),
    ];
};
export const fieldsText = (fields) => fields.map(([label, value]) => `${label}：${value.replace(/\n/g, '\n  ')}`).join('\n');
/** The same three groups as 资料改动, as readable text (before = live, after = the version). */
export const readableGroups = (live, version) => [
    ['人设', live?.template.persona, version.template.persona],
    ['网页展示', live ? fieldsText(presentationFields(live)) : undefined, fieldsText(presentationFields(version))],
    ['完整模板', live ? fieldsText(templateFields(live)) : undefined, fieldsText(templateFields(version))],
];
/** Part 24b-7: no id string in an admin view: keys that carry ids (id, xxxId, xxxIds) and uuid-looking values are left out. */
const ID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function withoutIds(value) {
    if (Array.isArray(value))
        return value.filter((v) => !(typeof v === 'string' && ID_VALUE.test(v))).map(withoutIds);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value)
            .filter(([key, v]) => !/^id$|Ids?$/.test(key) && !(typeof v === 'string' && ID_VALUE.test(v)))
            .map(([key, v]) => [key, withoutIds(v)]));
    return value;
}
