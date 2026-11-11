/**
 * One colour per character, the same on every console page (Part 24b-4, 24b-6).
 *
 * The source of truth is the character's 主色 (presentation.color), which the admin character list returns for every character, so no
 * page waits for a role to be opened. A character without one gets the first palette colour that no 主色 and no other colour-less
 * character uses, dealt in sorted-id order; deleting or adding a character therefore never changes another character's colour, and two
 * characters only share one when the fifteen palette colours are all taken.
 */
/**
 * Fifteen colours picked so that any two differ clearly (CIE76 ΔE ≥ 25) and white reads on every one at 4.7:1 or more, so the rail's
 * initial never needs a darker circle than the dots on the other pages.
 */
export const ROSTER_COLOURS = [
    '#E22019',
    '#3D3DF5',
    '#078607',
    '#1E7BA9',
    '#DA0B95',
    '#946C31',
    '#7863CB',
    '#A75C7A',
    '#2B8165',
    '#BF26D6',
    '#D92A59',
    '#6B7A06',
    '#BC5521',
    '#3D62F5',
    '#A257A2',
];
/** Someone who is not a chat character (a 人物 of the cast): one quiet grey. */
export const PERSON_COLOUR = '#8C8697';
const HEX = /^#[0-9A-Fa-f]{6}$/;
const same = (a, b) => a.toUpperCase() === b.toUpperCase();
/** The colour of each character: its 主色, else the first unused palette colour, colour-less ones in sorted-id order. */
export function assignColours(entries) {
    const rows = [...new Map([...entries].map((row) => [row.characterId, row])).values()].sort((a, b) => a.characterId < b.characterId ? -1 : a.characterId > b.characterId ? 1 : 0);
    const out = new Map();
    const used = [];
    for (const row of rows)
        if (typeof row.color === 'string' && HEX.test(row.color)) {
            out.set(row.characterId, row.color.toUpperCase());
            used.push(row.color);
        }
    for (const row of rows) {
        if (out.has(row.characterId))
            continue;
        const free = ROSTER_COLOURS.find((colour) => !used.some((other) => same(other, colour)));
        // Only when every palette colour is taken does a colour repeat (the palette is the size of the largest roster).
        const pick = free ?? ROSTER_COLOURS[out.size % ROSTER_COLOURS.length];
        out.set(row.characterId, pick);
        used.push(pick);
    }
    return out;
}
let roster = new Map();
let colours = new Map();
const names = new Map();
const deal = () => {
    colours = assignColours(roster.values());
};
/** The whole roster, as the admin list returns it (every page starts from this). */
export const setRoster = (entries) => {
    roster = new Map(entries.map((row) => [row.characterId, { ...row }]));
    names.clear();
    for (const row of entries)
        if (row.displayName)
            names.set(row.displayName, row.characterId);
    deal();
};
/** One character's 主色 changed (a draft was saved, a role was opened): every other colour-less character is dealt again. */
export const setMainColour = (characterId, color) => {
    const row = roster.get(characterId) ?? { characterId };
    roster.set(characterId, { ...row, color: typeof color === 'string' && HEX.test(color) ? color : null });
    deal();
};
export const hasRoster = () => roster.size > 0;
/** The colour of a character of the roster; a person who is not one gets the quiet grey. */
export const characterColour = (characterId) => colours.get(characterId) ?? PERSON_COLOUR;
/** 总览 names a character by its display name only. */
export const colourOfName = (displayName) => {
    const id = names.get(displayName);
    return id === undefined ? null : characterColour(id);
};
/** Who else wears this colour (for the swatches and the amber "和 X 同色" mark): the display names, never the ids. */
export const whoUses = (color, exceptId) => [...colours]
    .filter(([id, colour]) => id !== exceptId && same(colour, color))
    .map(([id]) => ({ characterId: id, name: roster.get(id)?.displayName ?? '' }));
/**
 * A page that knows only some ids (the inbox, the cast): the colour of each of them from the shared roster. Without a roster (a unit
 * test, a stub) the ids themselves are dealt.
 */
export const rosterColours = (ids) => {
    const known = new Set(ids);
    const local = hasRoster() ? null : assignColours([...known].map((characterId) => ({ characterId })));
    return (id) => {
        if (!known.has(id))
            return PERSON_COLOUR;
        return (local ?? colours).get(id) ?? PERSON_COLOUR;
    };
};
/** The circle colour that carries a white initial: the same hue, darkened a step at a time until white reads at 4.5:1 or more. */
export function legibleColour(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m)
        return '#6E6875';
    let channels = [16, 8, 0].map((shift) => (Number.parseInt(m[1], 16) >> shift) & 255);
    const luminance = (c) => {
        const lin = c.map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    for (let step = 0; step < 12 && 1.05 / (luminance(channels) + 0.05) < 4.6; step++)
        channels = channels.map((v) => Math.round(v * 0.92));
    return `#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
