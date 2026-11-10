import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SHAPES,
  PAPER,
  birthdayNo,
  contrast,
  derivedAccents,
  fit,
  glow,
  hexToHsl,
  hslToHex,
  mix,
  relativeLuminance,
  shapesFor,
  skinFor,
  skinSources,
  soften,
} from '../../../apps/player-web/src/features/brand/palette-skin.ts';

const grid: string[] = [];
for (let h = 0; h < 360; h += 24)
  for (const s of [0.1, 0.5, 0.8, 0.95, 1])
    for (const l of [0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.95]) grid.push(hslToHex(h, s, l));

test('Part 24k-2 soften: saturation above 80% becomes exactly 80%; hue and lightness stay; anything else is untouched', () => {
  for (const hex of grid) {
    const [h, s, l] = hexToHsl(hex);
    const out = soften(hex);
    if (s <= 0.8) assert.equal(out, hex, `${hex} is not touched`);
    else {
      const [h2, s2, l2] = hexToHsl(out);
      // (8-bit rounding of a near-black or near-white colour cannot land on the exact percent)
      const slack = l > 0.2 && l < 0.8 ? 0.01 : 0.06;
      assert.ok(Math.abs(s2 - 0.8) < slack, `${hex}: saturation ${s2}`);
      assert.ok(Math.abs(l2 - l) < 0.01, `${hex}: lightness`);
      if (s > 0 && l > 0.03 && l < 0.97)
        assert.ok(Math.min(Math.abs(h2 - h), 360 - Math.abs(h2 - h)) < 2, `${hex}: hue`);
    }
  }
  // a saturated example: pure red-orange
  const [, s] = hexToHsl(soften('#FF3300'));
  assert.ok(Math.abs(s - 0.8) < 0.01);
});

test('Part 24k-2 fit: the main reaches 3:1 on the paper, at night and by day', () => {
  for (const mode of ['night', 'day'] as const)
    for (const hex of grid) {
      const fitted = fit(soften(hex), mode);
      assert.ok(
        contrast(fitted, PAPER[mode]) >= 3 - 1e-9,
        `${mode} ${hex} → ${fitted} = ${contrast(fitted, PAPER[mode])}`,
      );
    }
  // a colour that already reads is not moved; a dark main at night is lifted toward white in 5% steps, a light one by day lowered toward black
  assert.equal(fit('#FFB347', 'night'), '#FFB347');
  assert.notEqual(fit('#1A2A6C', 'night'), '#1A2A6C');
  assert.ok(relativeLuminance(fit('#1A2A6C', 'night')) > relativeLuminance('#1A2A6C'));
  assert.ok(relativeLuminance(fit('#FFE9A8', 'day')) < relativeLuminance('#FFE9A8'));
  const step = fit('#1A2A6C', 'night');
  assert.ok(
    [...Array(21).keys()].some((i) => mix('#1A2A6C', '#FFFFFF', i / 20) === step),
    'a 5% step',
  );
});

test('Part 24k-2 glow: the softened main; a very dark main at night gets 30% white so it still glows', () => {
  const dark = '#0A0A30';
  assert.ok(relativeLuminance(dark) < 0.06);
  assert.equal(glow(dark, 'night'), mix(dark, '#FFFFFF', 0.3));
  assert.equal(glow(dark, 'day'), dark);
  assert.equal(glow('#FFB347', 'night'), '#FFB347');
  // glow uses the SOFTENED main, not the fitted one
  const skin = skinFor('#FF1100', [], 'night');
  assert.equal(skin.glow, soften('#FF1100'));
});

test('Part 24k-2 accents: the first two of the palette; with none, +35° and −30° of the softened main with the stated caps', () => {
  const main = '#3355CC';
  const [a, b] = derivedAccents(soften(main));
  const [h, s, l] = hexToHsl(soften(main));
  const [ha, sa, la] = hexToHsl(a);
  const [hb, sb, lb] = hexToHsl(b);
  const turn = (x: number, y: number) => ((x - y + 540) % 360) - 180;
  assert.ok(Math.abs(turn(ha, h + 35)) < 3 && Math.abs(turn(hb, h - 30)) < 3);
  assert.ok(sa <= Math.min(s, 0.6) + 0.02 && sb <= Math.min(s, 0.5) + 0.02);
  assert.ok(la <= 0.72 + 0.01 && la >= Math.min(l + 0.2, 0.72) - 0.02);
  assert.ok(lb <= 0.65 + 0.01 && lb >= Math.min(l + 0.1, 0.65) - 0.02);
  assert.deepEqual(skinFor(main, [], 'night').accents, derivedAccents(soften(main)));
  assert.deepEqual(skinFor(main, ['#112233', '#445566', '#778899'], 'day').accents, ['#112233', '#445566']);
  // one accent given: it is the first, the second is derived
  assert.deepEqual(skinFor(main, ['#112233'], 'day').accents, ['#112233', derivedAccents(soften(main))[1]]);
});

test('Part 24k-2: the sources are the 主 and the first 2 点缀; without a palette the single colour; without either nothing', () => {
  const palette = [
    { hex: '#111111', role: 'accent' as const },
    { hex: '#222222', role: 'main' as const },
    { hex: '#333333', role: 'accent' as const },
    { hex: '#444444', role: 'accent' as const },
  ];
  assert.deepEqual(skinSources('#999999', palette), { main: '#222222', accents: ['#111111', '#333333'] });
  assert.deepEqual(skinSources('#999999', null), { main: '#999999', accents: [] });
  assert.deepEqual(skinSources(null, undefined), { main: null, accents: [] });
});

test('Part 24k-2: the name light is 12% toward white at night and the main by day; the glyph is dark on a light main', () => {
  const night = skinFor('#3355CC', [], 'night'),
    day = skinFor('#3355CC', [], 'day');
  assert.equal(night.nameLight, mix(night.main, '#FFFFFF', 0.12));
  assert.equal(day.nameLight, day.main);
  assert.equal(skinFor('#FFE066', [], 'night').glyph, '#17151C');
  assert.equal(skinFor('#2A3F9C', [], 'day').glyph, '#FFFFFF');
});

test('Part 24k-2 shapes: the same character always gets the same shapes; different characters differ; at most 5; the stated ranges', () => {
  assert.deepEqual(shapesFor('wei-guagua', 'card'), shapesFor('wei-guagua', 'card'));
  assert.notDeepEqual(shapesFor('wei-guagua', 'card'), shapesFor('wei-guagua', 'chat'));
  const ids = Array.from({ length: 60 }, (_, i) => `role-${i}`);
  const seen = new Set(ids.map((id) => JSON.stringify(shapesFor(id, 'card'))));
  assert.equal(seen.size, ids.length, 'no two alike');
  let streaks = 0;
  for (const id of ids) {
    for (const surface of ['card', 'chat'] as const) {
      const shapes = shapesFor(id, surface);
      assert.ok(shapes.length >= 4 && shapes.length <= MAX_SHAPES);
      const [g1, g2, ...rest] = shapes;
      assert.equal(g1!.kind, 'glow');
      assert.equal(g2!.kind, 'glow');
      assert.ok(g1!.y >= -5 && g1!.y <= 35 && g2!.y >= 60 && g2!.y <= 105);
      for (const g of [g1!, g2!]) {
        assert.ok(g.x >= -5 && g.x <= 105 && g.w >= 90 && g.w <= 140 && g.h >= 50 && g.h <= 80 && g.blur === 36);
      }
      assert.equal(g1!.opacity, 0.85);
      assert.equal(g2!.opacity, 0.7);
      assert.ok(rest.length >= 2 && rest.length <= 3);
      rest.forEach((s, i) => {
        if (s.kind === 'streak') {
          assert.equal(i, rest.length - 1, 'only the last can be the streak');
          assert.ok(s.w >= 110 && s.w <= 150 && s.h >= 9 && s.h <= 16 && s.blur === 18);
          assert.ok(Math.abs(s.rotate) >= 15 && Math.abs(s.rotate) <= 70);
          streaks += 1;
        } else {
          assert.ok(s.w >= 40 && s.w <= 75 && s.h >= 22 && s.h <= 42 && s.blur === 28);
          assert.ok(s.opacity >= 0.55 && s.opacity <= 0.8);
        }
        assert.equal(s.colour, i % 2, 'the accents cycle');
      });
    }
  }
  const rate = streaks / (ids.length * 2);
  assert.ok(rate > 0.55 && rate < 0.85, `streak rate ${rate}`);
});

test('Part 24k-2: the No. is the birthday month + day; without a usable birthday the caller keeps its number', () => {
  assert.equal(birthdayNo('2000-11-02'), '1102');
  assert.equal(birthdayNo('1999-01-31'), '0131');
  assert.equal(birthdayNo(null), null);
  assert.equal(birthdayNo(undefined), null);
  assert.equal(birthdayNo('2000-13-02'), null);
  assert.equal(birthdayNo('not-a-date'), null);
});
