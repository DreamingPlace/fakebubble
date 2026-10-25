import assert from 'node:assert/strict';
import test from 'node:test';
import { contrastRatio, derivePalette, parseColour } from '../../../apps/player-web/src/features/brand/character-colour.ts';

test('a colour is typed as #RRGGBB or as r, g, b and normalised to capitals; anything else is refused', () => {
  for (const [typed, hex] of [
    ['#e8561e', '#E8561E'],
    ['E8561E', '#E8561E'],
    ['  #2F7BEA ', '#2F7BEA'],
    ['232, 86, 30', '#E8561E'],
    ['232 86 30', '#E8561E'],
    ['rgb(47, 123, 234)', '#2F7BEA'],
    ['0,0,0', '#000000'],
    ['255,255,255', '#FFFFFF'],
  ] as const)
    assert.equal(parseColour(typed), hex, typed);
  for (const bad of [
    '',
    '#fff',
    '#12345',
    '#1234567',
    '#GGGGGG',
    '256, 0, 0',
    '-1, 0, 0',
    '1, 2',
    '1, 2, 3, 4',
    'rgb(1, 2, 3',
    '1, 2, 3)',
    '50%, 0, 0',
    'red',
    '1.5, 2, 3',
  ])
    assert.equal(parseColour(bad), null, bad);
});

test('the palette is deterministic, keeps the colour as the accent, and the ink is readable on the card', () => {
  for (const hex of [
    '#E8561E',
    '#2F7BEA',
    '#7C4DEB',
    '#FFFF00',
    '#FFFFFF',
    '#000000',
    '#808080',
    '#00FF7F',
    '#F5C26B',
  ]) {
    const a = derivePalette(hex);
    assert.deepEqual(a, derivePalette(hex));
    assert.ok(contrastRatio(a.ink, a.color) >= 4.5, `${hex} ink on card`);
    assert.ok(contrastRatio(a.aura[3], '#FFFFFF') >= 3, `${hex} accent under white text`);
    for (const c of [a.color, a.ink, ...a.aura]) assert.match(c, /^#[0-9A-F]{6}$/);
  }
  // A colour dark enough already is the accent unchanged; a light one is darkened until white text reads on it.
  assert.equal(derivePalette('#2F7BEA').aura[3], '#2F7BEA');
  assert.notEqual(derivePalette('#FFFF00').aura[3], '#FFFF00');
  // The clouds are light, the same family as the colour.
  assert.ok(
    derivePalette('#E8561E')
      .aura.slice(0, 3)
      .every((c) => contrastRatio(c, '#FFFFFF') < 2.5),
  );
});
