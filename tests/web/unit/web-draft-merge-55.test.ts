import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCastDocs } from '../../../packages/contracts/cast-merge.ts';
import { mergeFields } from '../../../packages/contracts/draft-merge.ts';
import type { CastDoc } from '../../../packages/contracts/web-cast.ts';

/** Part 55: the three-way merge that stops 「草稿已在别处更新」 from being an error when nothing was changed on both sides. */
const fields = (entries: Record<string, unknown>) => new Map(Object.entries(entries));

test('55 mergeFields: one-sided changes are taken, equal changes are taken once, different changes are named', () => {
  const base = fields({ a: 1, b: 1, c: 1, d: 1 });
  const merged = mergeFields(base, fields({ a: 2, b: 1, c: 5, d: 1 }), fields({ a: 1, b: 3, c: 5, d: 1 }));
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(Object.fromEntries(merged.values), { a: 2, b: 3, c: 5, d: 1 });
  assert.deepEqual(merged.changedByMe, ['a', 'c']);
  const clash = mergeFields(base, fields({ a: 2 }), fields({ a: 3 }));
  assert.deepEqual(clash.conflicts, ['a']);
});

const doc = (over: Partial<Record<string, unknown>> = {}): CastDoc =>
  ({
    schema: 2,
    world: { background: '旧背景' },
    characters: [
      { characterId: 'jojo', identity: { names: [{ text: 'JOJO' }] } },
      { characterId: 'gua', identity: { names: [{ text: '瓜瓜' }] } },
    ],
    people: [],
    ratings: { jojo: { gua: 3 } },
    directions: [],
    groups: [
      {
        id: 'g1',
        name: '社团',
        members: ['jojo', 'gua'],
        background: '',
        stories: [{ id: 's1', title: '一', summary: '甲' }],
      },
    ],
    stories: [],
    memes: [],
    ...over,
  }) as unknown as CastDoc;
const withGroup = (patch: Record<string, unknown>, stories?: unknown[]) =>
  doc({
    groups: [
      {
        id: 'g1',
        name: '社团',
        members: ['jojo', 'gua'],
        background: '',
        stories: stories ?? [{ id: 's1', title: '一', summary: '甲' }],
        ...patch,
      },
    ],
  });

test('55 cast: a story an adoption added and a group renamed on the page are both kept', () => {
  const base = doc();
  const mine = withGroup({ name: '新社团' });
  const theirs = withGroup({}, [
    { id: 's1', title: '一', summary: '甲' },
    { id: 's2', title: '二', summary: '乙' },
  ]);
  const merged = mergeCastDocs(base, mine, theirs);
  assert.ok(merged.ok);
  if (!merged.ok) return;
  assert.equal(merged.doc.groups[0]!.name, '新社团');
  assert.deepEqual(
    merged.doc.groups[0]!.stories.map((story) => story.id),
    ['s1', 's2'],
  );
});

test('55 cast: a new group and a rating on the page, a new story elsewhere: merged; the world text changed on both sides is named', () => {
  const base = doc();
  const mine = doc({
    ratings: { jojo: { gua: 4 } },
    groups: [
      ...doc().groups,
      {
        id: 'g2',
        name: '新组',
        members: ['jojo', 'gua'],
        background: '',
        stories: [{ id: 's9', title: '九', summary: '丁' }],
      },
    ],
  });
  const theirs = withGroup({}, [
    { id: 's1', title: '一', summary: '甲' },
    { id: 's2', title: '二', summary: '乙' },
  ]);
  const merged = mergeCastDocs(base, mine, theirs);
  assert.ok(merged.ok);
  if (merged.ok) {
    assert.equal(merged.doc.ratings.jojo!.gua, 4);
    assert.deepEqual(
      merged.doc.groups.map((group) => group.id),
      ['g1', 'g2'],
    );
    assert.equal(merged.doc.groups[1]!.stories[0]!.id, 's9');
    assert.equal(merged.doc.groups[0]!.stories.length, 2);
  }
  const clash = mergeCastDocs(
    doc(),
    doc({ world: { background: '我的背景' } }),
    doc({ world: { background: '他的背景' } }),
  );
  assert.deepEqual(clash, { ok: false, conflicts: ['世界背景'] });
});

test('55 cast: the same story edited on both sides is a conflict that names the group and the story', () => {
  const edit = (summary: string) => withGroup({}, [{ id: 's1', title: '一', summary }]);
  const merged = mergeCastDocs(doc(), edit('我改的'), edit('他改的'));
  assert.deepEqual(merged, { ok: false, conflicts: ['组合「社团」的故事「一」'] });
});

test('55 cast: a group deleted on the page and still edited nowhere else is deleted; one rated cell removed is removed', () => {
  const base = doc();
  const merged = mergeCastDocs(base, doc({ groups: [], ratings: {} }), doc());
  assert.ok(merged.ok);
  if (merged.ok) {
    assert.deepEqual(merged.doc.groups, []);
    assert.deepEqual(merged.doc.ratings, {});
  }
});
