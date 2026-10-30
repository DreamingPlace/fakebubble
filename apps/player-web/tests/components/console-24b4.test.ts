import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalize, sampleCast, sampleId } from '../../../../tests/web/fixtures/cast-sample.ts';
import { validateCastDoc } from '../../../../apps/server/cast/cast-validation.ts';
import {
  blankCharacter,
  blankPerson,
  ratingShort,
  removeCharacter,
  removePerson,
} from '../../src/features/admin/cast/cast-model.ts';
import { ROSTER_COLOURS, rosterColours } from '../../src/features/admin/ui/character-colour.ts';

const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
const block = css.slice(css.indexOf('Part 24b-4: one layout system'), css.indexOf('/* Part 15: player only'));
const lookup = { exists: () => true, deleted: () => false };

test('24b-4 one layout system: the content is as wide as the window lets it be (up to 1680), buttons have two heights, the tooltip is light', () => {
  assert.match(css, /--ad-page-max: 1680px/);
  assert.match(block, /section\[data-panel\] \{\s*width: 100%;\s*max-width: var\(--ad-page-max\);/);
  // standard 36 / compact 30
  assert.match(css, /button:where\(:not\([^)]*\)\) \{\s*height: 36px;\s*min-height: 36px;\s*padding: 0 16px;/);
  assert.match(block, /\.seg-button,[\s\S]*?\) \{\s*height: 30px;\s*min-height: 30px;\s*padding: 0 12px;/);
  assert.doesNotMatch(
    block,
    /height: (?:32|40|44)px;\s*min-height: (?:32|40|44)px;\s*padding: 0 1[0-9]px;\s*font-size: 1[34]px;/,
  );
  // hover help: white card, hairline, soft shadow, #2B2833 text; never the dark text colour as a fill
  assert.match(
    block,
    /\.ad-tip,\s*\.account-admin-page\.admin-shell \.permission-tip \{[^}]*background: #fff;[^}]*color: #2b2833;[^}]*box-shadow:/,
  );
  assert.doesNotMatch(
    css.slice(css.indexOf('Part 24b-1: the administrator console')),
    /\.permission-tip \{[^}]*background: var\(--ad-text\)/,
  );
  // two-column pages use fixed proportions
  // Named exception (Part 24b-6, V3): the cast is its fixed grid (its own width) beside the pair panel, the inbox is rows of fixed cards
  // with the detail under the open row (one column), and 管理员与权限 is a table whose rows open below (one column). The old 7fr/5fr,
  // 3fr/2fr and 1fr/1.1fr proportions of those three pages do not exist any more; their V3 layouts are pinned instead.
  assert.match(css, /\.cs-main \{\s*display: grid;\s*grid-template-columns: max-content minmax\(0, 1fr\);/);
  assert.match(css, /#admin-cocreation \.cc-layout \{\s*display: flex;\s*flex-direction: column;/);
  assert.match(css, /#admin-cocreation \.cc-list \{\s*display: grid;\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test('24b-4 colours: one palette of fifteen, dealt by place in the sorted roster, so a character has the same dot on every page', () => {
  assert.equal(new Set(ROSTER_COLOURS).size, 15);
  const colour = rosterColours(['b', 'a', 'c']);
  assert.equal(colour('a'), ROSTER_COLOURS[0]);
  assert.equal(colour('c'), ROSTER_COLOURS[2]);
  assert.notEqual(colour('nobody'), colour('a'), 'a person who is not in the roster gets the quiet grey');
});

test('24b-4 removing a character or a person leaves a cast the server still accepts, with no mention of them', () => {
  const doc = sampleCast();
  const gone = sampleId(0);
  removeCharacter(doc, gone);
  assert.equal(doc.characters.length, 14);
  assert.equal(JSON.stringify(doc).includes(`"${gone}"`), false, 'not in ratings, directions, groups or stories');
  assert.deepEqual(validateCastDoc(doc, 'draft', lookup).errors, []);
  const person = doc.people[0]!;
  doc.stories[0]!.participants.push(person.id);
  doc.characters[0]!.identity.prototype = { personId: person.id, inherited: '', notInherited: '' };
  removePerson(doc, person.id);
  assert.equal(
    doc.people.some((p) => p.id === person.id),
    false,
  );
  assert.equal(JSON.stringify(doc).includes(`"${person.id}"`), false);
  assert.deepEqual(validateCastDoc(doc, 'draft', lookup).errors, []);
});

test('24b-4 a new character and a new person start empty but valid', () => {
  const doc = sampleCast();
  doc.characters = [];
  doc.ratings = {};
  doc.directions = [];
  doc.groups = [];
  doc.stories = [];
  doc.memes = [];
  doc.people = [];
  doc.characters.push(blankCharacter('role-1234abcd', '小雨'));
  doc.people.push(blankPerson('邻居'));
  // what the server does with it on save: ids are given, the token becomes a real id
  assert.deepEqual(validateCastDoc(normalize(doc), 'draft', lookup).errors, []);
  assert.match(doc.people[0]!.id, /^new-/);
  assert.equal(ratingShort(4), '4');
  assert.equal(ratingShort(3.5), '3.5');
  assert.equal(ratingShort(0), '0');
});
