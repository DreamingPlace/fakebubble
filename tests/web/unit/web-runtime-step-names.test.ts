import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

/**
 * A runtime step (a digest-checked install at start, no numbered migration) guards its own names with `name GLOB 'web_xxx*'`: on a
 * fresh install nothing of that family may exist, and the step counts its own triggers by the same pattern. A pattern that is wider than
 * the step's own names also matches a table another step (or a numbered migration) already made, and the step then stops the start of a
 * database that has run for months: Part 36 shipped `GLOB 'web_turn*'` and production's `web_turnstile_counts` matched it (a P0).
 *
 * This test collects every `name GLOB 'web_…*'` pattern in the server code and every table / index / trigger / view the server code or
 * its SQL creates, and fails when a pattern matches a name that is created in ANOTHER file.
 */
const root = new URL('../../../', import.meta.url).pathname;
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry.endsWith('.generated.ts')) return [];
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|sql)$/.test(entry) ? [path] : [];
  });
}
const files = [...walk(join(root, 'apps/server')), ...walk(join(root, 'workers/web-cloudflare'))];
const source = new Map(files.map((file) => [relative(root, file), readFileSync(file, 'utf8')]));

const PATTERN = /name\s+GLOB\s+'(web_[a-z0-9_]*)\*'/g;
const CREATED = /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(web_[a-z0-9_]+)/gi;

const patterns: { prefix: string; file: string }[] = [];
const created: { name: string; file: string }[] = [];
for (const [file, text] of source) {
  for (const match of text.matchAll(PATTERN)) patterns.push({ prefix: match[1]!, file });
  for (const match of text.matchAll(CREATED)) created.push({ name: match[1]!.toLowerCase(), file });
}

test('the scan sees the steps it is meant to guard (it would be silent if the patterns moved)', () => {
  const prefixes = new Set(patterns.map((p) => p.prefix));
  for (const known of ['web_turn_', 'web_feedback', 'web_share', 'web_broadcast', 'web_writer_'])
    assert.ok(prefixes.has(known), `the scan finds GLOB '${known}*'`);
  assert.ok(
    created.some((c) => c.name === 'web_turnstile_counts'),
    'and the table that broke Part 36',
  );
  assert.ok(created.some((c) => c.name === 'web_turn_bubbles'));
});

/**
 * Four families that were already wider than their own step when they shipped. They are NOT a defect today: each guard only runs on an
 * install that has no `<family>_schema` table yet, the other objects of the family are created by LATER steps of a fresh install, and
 * every production database ran the guard before those objects existed (so the guard is skipped there). They are listed so that nothing
 * NEW joins them: a pattern or a table that creates a fresh overlap fails the test below. Narrow a family here only together with a
 * deliberate change of its step.
 */
const HISTORICAL = new Set([
  'apps/server/admin/web-admin-schema.ts :: web_admin_',
  'apps/server/characters/web-character-catalog.ts :: web_character_',
  'apps/server/characters/web-character-preview-schema.ts :: web_character_preview_',
  'apps/server/characters/web-rehearsal-schema.ts :: web_rehearsal_',
]);

test("no runtime step's GLOB pattern matches a table, index, trigger or view that another file creates (except the four historical families)", () => {
  const collisions = new Map<string, string[]>();
  for (const pattern of patterns)
    for (const object of created)
      if (object.name.startsWith(pattern.prefix) && object.file !== pattern.file) {
        const key = `${pattern.file} :: ${pattern.prefix}`;
        collisions.set(key, [...(collisions.get(key) ?? []), `${object.name} (${object.file})`]);
      }
  const fresh = [...collisions]
    .filter(([key]) => !HISTORICAL.has(key))
    .map(
      ([key, names]) =>
        `GLOB '${key.split(' :: ')[1]}*' in ${key.split(' :: ')[0]} matches ${[...new Set(names)].join(', ')}`,
    );
  assert.deepEqual(
    fresh,
    [],
    "a runtime step's pattern must match only the names its own file creates (Part 36: web_turn* matched web_turnstile_counts)",
  );
  // an entry that no longer collides is removed from the list
  assert.deepEqual(
    [...HISTORICAL].filter((key) => !collisions.has(key)),
    [],
  );
});

test('the pattern that broke production stays fixed: web_turn_ (with its underscore) and nothing owned by another file', () => {
  const turn = patterns.filter((p) => p.file.endsWith('turns/web-turn-schema.ts'));
  assert.equal(turn.length, 2, 'the fresh-install guard and the trigger count');
  for (const pattern of turn) assert.equal(pattern.prefix, 'web_turn_');
  assert.ok(!'web_turnstile_counts'.startsWith('web_turn_'));
});
