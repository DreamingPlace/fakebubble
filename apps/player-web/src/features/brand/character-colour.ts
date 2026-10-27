/**
 * A character's main colour (Part 24b-2): how an administrator types it, and what the player page derives from it.
 * Pure and deterministic: the same colour always gives the same palette, with no clock, randomness or lookup.
 */
export type Rgb = readonly [number, number, number];
/** [cloud 1, cloud 2, cloud 3, accent] - the same shape as the built-in aura of the 小卡. */
export type Aura = readonly [string, string, string, string];
export interface CharacterPalette {
  /** The card's tint (a soft, desaturated tone of the colour). */
  color: string;
  /** Text on the card tint, at least 4.5:1 against it. */
  ink: string;
  aura: Aura;
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
const toHex = ([r, g, b]: Rgb) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const channel = (text: string) => (/^\d{1,3}$/.test(text) && Number(text) <= 255 ? Number(text) : null);

/**
 * '#RRGGBB' (any case, a leading # optional) or 'r, g, b' / 'rgb(r, g, b)' with 0-255 integers, to '#RRGGBB' in capitals.
 * Anything else - three-digit hex, percentages, a fourth channel, 256 - is refused with null.
 */
export function parseColour(input: string): string | null {
  const text = input.trim();
  const hex = /^#?([0-9a-fA-F]{6})$/.exec(text);
  if (hex) return `#${hex[1]!.toUpperCase()}`;
  const rgb = /^(?:rgb\(\s*)?(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/i.exec(text);
  if (!rgb || text.includes('(') !== text.includes(')')) return null;
  const parts = [channel(rgb[1]!), channel(rgb[2]!), channel(rgb[3]!)];
  return parts.every((p) => p !== null) ? toHex(parts as unknown as Rgb) : null;
}

const rgbOf = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z),
    min = Math.min(x, y, z),
    l = (max + min) / 2,
    d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function fromHsl(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360,
    c = (1 - Math.abs(2 * l - 1)) * s,
    x = c * (1 - Math.abs(((hue / 60) % 2) - 1)),
    m = l - c / 2;
  const [r, g, b] =
    hue < 60
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
const luminance = (hex: string) => {
  const lin = rgbOf(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
};
/** WCAG contrast ratio, 1-21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
}
/** The same hue and saturation, darkened one percent at a time until it reads at `ratio` against `background`. */
function readableOn(background: string, hue: number, saturation: number, ratio: number): string {
  let lightness = 0.5;
  let colour = fromHsl(hue, saturation, lightness);
  while (contrastRatio(colour, background) < ratio && lightness > 0) {
    lightness = Math.max(0, lightness - 0.01);
    colour = fromHsl(hue, saturation, lightness);
  }
  return colour;
}

/**
 * Palette from one colour:
 *   accent  the colour itself, darkened only if white text on it would be under 3:1;
 *   clouds  the same hue at lightness 85% / 91% / 78%, the second and third turned +18 / -12 degrees (a little warmer / cooler);
 *   color   hue at 20% saturation, 76% lightness (the card's tint);
 *   ink     the hue at 30% saturation, darkened until it is at least 4.5:1 on the tint.
 */
export function derivePalette(hex: string): CharacterPalette {
  const [h, s] = toHsl(rgbOf(hex));
  const saturation = Math.max(0.35, Math.min(1, s));
  const accent = contrastRatio(hex, '#FFFFFF') >= 3 ? hex : readableOn('#FFFFFF', h, s, 3);
  const color = fromHsl(h, 0.2, 0.76);
  return {
    color,
    ink: readableOn(color, h, 0.3, 4.5),
    aura: [
      fromHsl(h, saturation, 0.85),
      fromHsl(h + 18, saturation * 0.9, 0.91),
      fromHsl(h - 12, saturation, 0.78),
      accent,
    ],
  };
}
