import test from 'node:test';
import assert from 'node:assert/strict';
import { providerPeople, escapeCardText } from '../../src/features/prototype/provider-catalog-view.ts';
import { syntheticProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { derivePalette } from '../../src/features/brand/character-colour.ts';

test('dynamic orbit retains fifteen slots and approved initial palettes without hardcoded person selection', () => {
  const view = syntheticProviderBootstrap();
  for (const character of view.characters) character.availability = { state: 'available', personaVersion: 1 };
  const seed = providerPeople(view);
  assert.equal(seed.length, 15);
  assert.equal(seed[7]!.characterId, 'wei-guagua');
  assert.equal(seed[7]!.color, '#D7C8B9');
  view.characters.push({ ...view.characters[0]!, characterId: 'new-character', displayName: '<img onerror="x">' });
  view.slots.splice(3, 1, { kind: 'character', characterId: 'new-character' });
  const dynamic = providerPeople(view);
  assert.equal(dynamic.length, 15);
  assert.equal(dynamic.filter((person) => person.characterId).length, 4);
  const added = dynamic.find((person) => person.characterId === 'new-character')!;
  assert.equal(added.mark, '<');
  assert.equal(added.name, '<img onerror="x">');
  assert.equal(escapeCardText(added.name), '&lt;img onerror=&quot;x&quot;&gt;');
  assert.equal(escapeCardText("a&b'"), 'a&amp;b&#39;');
});

test('empty catalog and full orbit have no seed ghosts or duplicated slots', () => {
  const view = syntheticProviderBootstrap();
  view.characters = [];
  view.slots = Array.from({ length: 15 }, (_, n) => ({ kind: 'preview', slotId: `p-${n}`, label: '敬请期待' }));
  assert.equal(providerPeople(view).filter((person) => person.characterId).length, 0);
  const template = syntheticProviderBootstrap().characters[0]!;
  view.characters = Array.from({ length: 15 }, (_, n) => ({ ...template, characterId: `new-${n}` }));
  view.slots = view.characters.map((c) => ({ kind: 'character', characterId: c.characterId }));
  assert.equal(providerPeople(view).length, 15);
  assert.equal(new Set(providerPeople(view).map((p) => p.id)).size, 15);
  assert.ok(providerPeople(view).every((p) => p.transcript === undefined));
});

test('a published main colour drives the card tint, ink and aura; a character without one keeps the built-in palette', () => {
  const view = syntheticProviderBootstrap();
  for (const character of view.characters) character.availability = { state: 'available', personaVersion: 1 };
  const before = providerPeople(view).find((p) => p.characterId === 'jojo')!;
  assert.equal(view.characters.find((c) => c.characterId === 'jojo')!.mainColor, null);
  assert.deepEqual(before.card.aura, ['#C6E4FF', '#D5F6EE', '#97C8F5', '#2F7BEA']);
  view.characters.find((c) => c.characterId === 'jojo')!.mainColor = '#7C4DEB';
  const after = providerPeople(view).find((p) => p.characterId === 'jojo')!;
  assert.equal(after.card.aura[3], '#7C4DEB');
  assert.notEqual(after.color, before.color);
  assert.deepEqual(after.card.aura, derivePalette('#7C4DEB').aura);
  // The other two are untouched.
  const guagua = providerPeople(view).find((p) => p.characterId === 'wei-guagua')!;
  assert.equal(guagua.color, '#D7C8B9');
});
