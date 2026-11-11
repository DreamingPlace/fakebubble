/** The page's paper behind everything (the contrast target of "fit"). */
export const PAPER = { night: '#0C0B10', day: '#FAF8F6' };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const rgbOf = (hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
];
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
const toHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
export function hexToHsl(hex) {
    const [r, g, b] = rgbOf(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d === 0)
        return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
}
export function hslToHex(h, s, l) {
    const hue = ((h % 360) + 360) % 360, c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = hue < 60
        ? [c, x, 0]
        : hue < 120
            ? [x, c, 0]
            : hue < 180
                ? [0, c, x]
                : hue < 240
                    ? [0, x, c]
                    : hue < 300
                        ? [x, 0, c]
                        : [c, 0, x];
    return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}
/** WCAG relative luminance, 0-1. */
export function relativeLuminance(hex) {
    const [r, g, b] = rgbOf(hex).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
}
/** `amount` (0-1) of the way from `from` to `to`, channel by channel. */
export function mix(from, to, amount) {
    const a = rgbOf(from), b = rgbOf(to);
    return toHex(a.map((v, i) => v + (b[i] - v) * clamp01(amount)));
}
/** Soften: HSL; saturation above 80% is set to exactly 80%. Hue and lightness are unchanged; nothing else is touched. */
export function soften(hex) {
    const [h, s, l] = hexToHsl(hex);
    return s > 0.8 ? hslToHex(h, 0.8, l) : hex;
}
/** Fit: the softened main mixed toward white (night) or black (day) in 5% steps until it reads 3:1 on the paper. */
export function fit(softened, mode) {
    const toward = mode === 'night' ? '#FFFFFF' : '#000000';
    for (let step = 0; step <= 20; step += 1) {
        const candidate = mix(softened, toward, step / 20);
        if (contrast(candidate, PAPER[mode]) >= 3)
            return candidate;
    }
    return toward;
}
/** Glow: the softened main; at night a main darker than 0.06 relative luminance is mixed 30% toward white so it still glows. */
export function glow(softened, mode) {
    return mode === 'night' && relativeLuminance(softened) < 0.06 ? mix(softened, '#FFFFFF', 0.3) : softened;
}
/** The two accents when the palette gives none (or fewer): hue +35° and hue −30° of the softened main, kept light and quiet. */
export function derivedAccents(softened) {
    const [h, s, l] = hexToHsl(softened);
    return [
        hslToHex(h + 35, Math.min(s, 0.6), Math.min(l + 0.2, 0.72)),
        hslToHex(h - 30, Math.min(s, 0.5), Math.min(l + 0.1, 0.65)),
    ];
}
/** The main colour and the accents the player uses: the palette's 'main' and its first 2 accents, else the single `color`. */
export function skinSources(color, palette) {
    const main = palette?.find((entry) => entry.role === 'main')?.hex ?? color;
    const accents = (palette ?? []).filter((entry) => entry.role === 'accent').map((entry) => entry.hex);
    return { main: main ?? null, accents: accents.slice(0, 2) };
}
export function skinFor(main, accents, mode) {
    const softened = soften(main);
    const fitted = fit(softened, mode);
    const derived = derivedAccents(softened);
    const picked = [accents[0] ?? derived[0], accents[1] ?? derived[1]];
    return {
        main: fitted,
        glow: glow(softened, mode),
        accents: picked,
        accentText: [fit(picked[0], mode), fit(picked[1], mode)],
        nameLight: mode === 'night' ? mix(fitted, '#FFFFFF', 0.12) : fitted,
        glyph: relativeLuminance(fitted) > 0.35 ? '#17151C' : '#FFFFFF',
    };
}
// ---- the shapes ----
/** 32-bit FNV-1a of a string: the PRNG seed. */
export function seedOf(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}
/** mulberry32: a small, well-mixed, seedable generator returning [0, 1). */
export function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export const MAX_SHAPES = 5;
const round = (v) => Math.round(v * 100) / 100;
/** The shapes of one character on one surface ('card' = the home card, 'chat' = the chat). At most 5. */
export function shapesFor(characterId, surface) {
    const rand = prng(seedOf(`${characterId}|${surface}`));
    const between = (lo, hi) => round(lo + rand() * (hi - lo));
    const shapes = [];
    // two large glow shapes: one near the top, one near the bottom
    for (const [yLo, yHi, opacity] of [
        [-5, 35, 0.85],
        [60, 105, 0.7],
    ])
        shapes.push({
            kind: 'glow',
            colour: 'glow',
            x: between(-5, 105),
            y: between(yLo, yHi),
            w: between(90, 140),
            h: between(50, 80),
            rotate: between(0, 360),
            blur: 36,
            opacity,
        });
    // 2-3 smaller accent shapes, cycling the accents; the last is usually a long diagonal streak
    const count = 2 + (rand() < 0.5 ? 0 : 1);
    const streak = rand() < 0.7;
    for (let i = 0; i < count; i += 1) {
        const last = i === count - 1 && streak;
        const sign = rand() < 0.5 ? -1 : 1;
        shapes.push(last
            ? {
                kind: 'streak',
                colour: (i % 2),
                x: between(10, 90),
                y: between(10, 90),
                w: between(110, 150),
                h: between(9, 16),
                rotate: round(sign * between(15, 70)),
                blur: 18,
                opacity: between(0.55, 0.8),
            }
            : {
                kind: 'accent',
                colour: (i % 2),
                x: between(-5, 105),
                y: between(-5, 105),
                w: between(40, 75),
                h: between(22, 42),
                rotate: between(0, 360),
                blur: 28,
                opacity: between(0.55, 0.8),
            });
    }
    return shapes;
}
// ---- the No. ----
/** 2000-11-02 → "1102" (month + day). null when there is no usable birthday: the caller keeps the number it had. */
export function birthdayNo(birthDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate ?? '');
    if (!m)
        return null;
    const month = Number(m[2]), day = Number(m[3]);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${m[2]}${m[3]}` : null;
}
