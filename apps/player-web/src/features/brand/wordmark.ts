/**
 * The Burbur bubble hand (Part 25a): the wordmark and the Latin names on the 小卡 are drawn as lines, so the page needs no font
 * file and no image. This is a port of the glyph table and the path builder in design/burbur-v2/Hand.dc.html; the numbers are the
 * design's. Output is a plain inline SVG string with presentation attributes only (the CSP forbids style attributes), coloured
 * by `currentColor`, so a stylesheet decides the colour.
 */

/** Glyph advance and an SVG path in a 18-unit-high box whose baseline is y = 0. */
const GLYPHS: Readonly<Record<string, readonly [number, string]>> = {
  a: [13, 'M10.5,-5 a5,5 0 1,0 -10,0 a5,5 0 1,0 10,0 M10.5,-10 v8.2 q0,1.8 1.8,1.8'],
  b: [12, 'M0.5,-18 v18 M0.5,-5 a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0'],
  c: [11, 'M9.04,-8.54 a5,5 0 1,0 0,7.08'],
  d: [13, 'M10.5,-5 a5,5 0 1,0 -10,0 a5,5 0 1,0 10,0 M10.5,-18 v16.2 q0,1.8 1.8,1.8'],
  e: [12, 'M0.5,-5 h10 a5,5 0 1,0 -1.46,3.54'],
  f: [9, 'M8.5,-16.5 q-1.5,-1.8 -3.6,-1.2 q-1.9,0.6 -1.9,3 v14.7 M0.5,-10 h6.5'],
  g: [13, 'M10.5,-5 a5,5 0 1,0 -10,0 a5,5 0 1,0 10,0 M10.5,-10 v11 q0,5 -5,5 q-3,0 -4.5,-2'],
  h: [12, 'M0.5,-18 v18 M0.5,-5.5 a5,4.5 0 0,1 10,0 v5.5'],
  i: [3.5, 'M1.2,-10 v10 M1.2,-15.6 a1.2,1.2 0 1,0 0.01,0'],
  j: [6, 'M4.5,-10 v12 q0,4.5 -4,4.5 M4.5,-15.6 a1.2,1.2 0 1,0 0.01,0'],
  k: [10.5, 'M0.5,-18 v18 M9.5,-10 l-9,6.2 M3.6,-6.1 l6,6.1'],
  l: [5, 'M1,-18 v16.2 q0,1.8 1.8,1.8'],
  m: [18, 'M0.5,-10 v10 M0.5,-5.5 a4,4.5 0 0,1 8,0 v5.5 M8.5,-5.5 a4,4.5 0 0,1 8,0 v5.5'],
  n: [12, 'M0.5,-10 v10 M0.5,-5.5 a5,4.5 0 0,1 10,0 v5.5'],
  o: [12, 'M10.5,-5 a5,5 0 1,0 -10,0 a5,5 0 1,0 10,0'],
  p: [12, 'M0.5,-10 v17 M0.5,-5 a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0'],
  q: [13, 'M10.5,-5 a5,5 0 1,0 -10,0 a5,5 0 1,0 10,0 M10.5,-10 v15 q0,2 2,2'],
  r: [8.5, 'M0.5,-10 v10 M0.5,-5.5 q1.5,-4.5 7,-4.2'],
  s: [
    10,
    'M8.5,-8.8 q-1.2,-1.6 -3.8,-1.4 q-3.6,0.3 -3.4,2.6 q0.2,1.9 3.6,2.5 q3.8,0.6 3.6,2.8 q-0.2,2.4 -3.8,2.4 q-2.7,0 -4,-1.6',
  ],
  t: [9, 'M3,-15 v13 q0,2 2.4,2 q1.4,0 2.4,-0.8 M0.5,-10 h7'],
  u: [13, 'M0.5,-10 v5 a5,5 0 0,0 10,0 M10.5,-10 v8.2 q0,1.8 1.8,1.8'],
  v: [11, 'M0.5,-10 l5,10 l5,-10'],
  w: [15, 'M0.5,-10 l3.5,10 l3.5,-8 l3.5,8 l3.5,-10'],
  x: [10.5, 'M0.5,-10 l9,10 M9.5,-10 l-9,10'],
  y: [13, 'M0.5,-10 v5 a5,5 0 0,0 10,0 M10.5,-10 v11 q0,5 -5,5 q-3,0 -4.5,-2'],
  z: [10.5, 'M0.5,-10 h9 l-9,10 h9'],
  '?': [10, 'M1,-14 q0,-4 4,-4 q4,0 4,3.6 q0,2.4 -3.2,3.6 q-0.8,0.4 -0.8,1.8 v1.6 M5,-1.6 a1.1,1.1 0 1,0 0.01,0'],
  '!': [4, 'M1.5,-17 v11 M1.5,-1.6 a1.1,1.1 0 1,0 0.01,0'],
  '·': [6, 'M3,-5 a0.9,0.9 0 1,0 0.01,0'],
  '~': [10, 'M0.5,-4.5 q2,-3 4.5,-1 q2.5,2 4.5,-1'],
  ' ': [6, ''],
};
/** Letters bounce a hair on the baseline, in this repeating order. */
const BOUNCE = [0, -0.35, 0.25, -0.15, 0.3, -0.3, 0.1, -0.2];
const TOP = -20;
const HEIGHT = 28.5;

export interface WordmarkOptions {
  /** Height in CSS pixels; the width follows from the text. */
  size: number;
  /** Stroke width in glyph units (the design uses 1.7 to 2.1). */
  weight?: number;
  /** The logo trail: an open bubble and a pair of lips after the text. */
  logo?: boolean;
}

/** The path, view box and width of a lettering. Characters the hand does not draw are skipped. */
export function handPath(input: string, logo = false) {
  const text = input.toLowerCase();
  const parts: string[] = [];
  let x = 0;
  let k = 0;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (!glyph) continue;
    const dy = char === ' ' ? 0 : BOUNCE[k++ % BOUNCE.length]!;
    const ox = x;
    parts.push(
      glyph[1].replace(
        /M(-?[\d.]+),(-?[\d.]+)/g,
        (_m, px: string, py: string) => `M${(Number(px) + ox).toFixed(2)},${(Number(py) + dy).toFixed(2)}`,
      ),
    );
    x += glyph[0] + 1.2;
  }
  if (logo) {
    const ex = x + 0.6;
    parts.push(`M${(ex + 1.6).toFixed(2)},-10.5 a1.5,1.5 0 1,0 0.01,0`);
    parts.push(
      `M${(ex + 5.2).toFixed(2)},-15.2 c0,-1.4 -1.9,-1.4 -1.9,0 c0,1.1 1.9,2 1.9,2.6 c0,-0.6 1.9,-1.5 1.9,-2.6 c0,-1.4 -1.9,-1.4 -1.9,0`,
    );
    x += 8.2;
  }
  const width = Math.max(x - 1.2, 1);
  return {
    text,
    d: parts.join(' '),
    viewBox: `-1.5 ${TOP} ${(width + 3).toFixed(2)} ${HEIGHT}`,
    ratio: (width + 3) / HEIGHT,
  };
}

const escapeAttr = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * An inline `<svg>` for `text`. `label` is its accessible name; pass `null` for a decorative one (aria-hidden). The stroke is
 * `currentColor`, so the surrounding element's `color` paints it.
 */
export function handSvg(text: string, options: WordmarkOptions & { label?: string | null; className?: string }) {
  const { d, viewBox, ratio, text: lowered } = handPath(text, options.logo === true);
  const height = options.size;
  const width = Math.round(height * ratio);
  const label = options.label === undefined ? lowered : options.label;
  const a11y = label === null ? 'aria-hidden="true"' : `role="img" aria-label="${escapeAttr(label)}"`;
  return `<svg class="${options.className ?? 'hand'}" ${a11y} viewBox="${viewBox}" width="${width}" height="${height}" fill="none" stroke="currentColor" stroke-width="${options.weight ?? 1.8}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}

/** The lowercase wordmark. In running text the name is written "Burbur". */
export const wordmarkSvg = (options: WordmarkOptions & { className?: string }) =>
  handSvg('burbur', { weight: 2, ...options, label: 'Burbur' });

/** The same lettering as a DOM node, for components that build their page with `createElement` and never parse markup. */
export function handElement(text: string, options: WordmarkOptions & { label?: string | null; className?: string }) {
  const { d, viewBox, ratio, text: lowered } = handPath(text, options.logo === true);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const path = document.createElementNS(ns, 'path');
  const label = options.label === undefined ? lowered : options.label;
  const attrs: Record<string, string> = {
    class: options.className ?? 'hand',
    viewBox,
    width: String(Math.round(options.size * ratio)),
    height: String(options.size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': String(options.weight ?? 1.8),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    ...(label === null ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': label }),
  };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
