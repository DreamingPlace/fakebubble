import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkCastFile } from '../../../scripts/cast-file.ts';
import { CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';

const example = () => JSON.parse(readFileSync('examples/cast-file.example.json', 'utf8')) as Record<string, any>;
const check = (file: unknown) => checkCastFile(JSON.stringify(file));
const codes = (file: unknown) => {
  const { prepared } = check(file);
  return [...prepared!.problems, ...prepared!.publishBlockers].map((p) => p.code);
};

test('the example file passes: 3 characters (one new), 2 people, 1 group, 2 stories; exit code 0 from the script', () => {
  const { prepared, ok, output } = check(example());
  assert.equal(ok, true, output.join('\n'));
  assert.deepEqual(
    [
      prepared!.created.length,
      prepared!.doc!.characters.length,
      prepared!.doc!.people.length,
      prepared!.doc!.groups.length,
      prepared!.doc!.stories.length,
    ],
    [1, 3, 2, 1, 2],
  );
  assert.ok(prepared!.views.every((v) => v.size < v.max));
  const run = spawnSync(process.execPath, ['scripts/cast-file.ts', 'validate', 'examples/cast-file.example.json'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /结果：可以导入，也可以发布。/);
});

test('the script exits non-zero on a broken file, and 2 on a bad call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cast-file-'));
  try {
    const bad = example();
    bad.ratings['role-example01']['role-example02'] = 3.3;
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
    writeFileSync(join(dir, 'garbage.json'), '{not json');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['scripts/cast-file.ts', ...args], { encoding: 'utf8' });
    const broken = run('validate', join(dir, 'bad.json'));
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /\[错误\] 周小禾 · ratings\[role-example01\]\[role-example02\] — 评分必须在 0–5 星/);
    assert.equal(run('validate', join(dir, 'garbage.json')).status, 1);
    assert.equal(run('validate', join(dir, 'missing.json')).status, 2);
    assert.equal(run('validate').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each rule failure is reported with the character’s name and the path', () => {
  const fail = (change: (file: Record<string, any>) => void, code: string, who: string | null, path?: RegExp) => {
    const file = example();
    change(file);
    const { prepared, ok } = check(file);
    assert.equal(ok, false, code);
    const found = [...prepared!.problems, ...prepared!.publishBlockers].find((p) => p.code === code);
    assert.ok(found, `${code} in ${JSON.stringify(prepared!.problems)}`);
    assert.equal(found!.who, who, code);
    if (path) assert.match(found!.path, path, code);
  };
  fail((f) => (f.ratings['role-example01']['role-example02'] = 3.3), 'CAST_RATING_OUT_OF_GRID', '周小禾');
  fail((f) => (f.ratings['role-example01']['role-example01'] = 3), 'CAST_SELF_RATING', '周小禾');
  fail((f) => (f.ratings['role-example02'].ghost = 3), 'CAST_UNKNOWN_CHARACTER', '沈既明');
  fail((f) => f.groups[0].members.push('role-example01'), 'CAST_DUPLICATE_MEMBER', null, /groups\[/);
  fail((f) => (f.stories[0].period = { start: '2025-05', end: '2025-01' }), 'CAST_PERIOD_ORDER', null, /stories\[/);
  fail(
    (f) => f.stories[0].participants.push('new:没有这个人'),
    'CAST_FILE_NEW_UNDEFINED',
    null,
    /stories\[0\]\.participants/,
  );
  fail(
    (f) => (f.characters[0].identity.prototype = { personId: 'new-owner', inherited: '', notInherited: '' }),
    'CAST_UNKNOWN_PERSON',
    '周小禾',
  );
  fail((f) => f.directions.push({ ...f.directions[0] }), 'CAST_DUPLICATE_DIRECTION', '周小禾');
  // shape problems name the character too, with the field
  fail(
    (f) => (f.characters[1].profile = 'x'.repeat(CAST_LIMITS.profile + 1)),
    'CAST_SHAPE',
    '沈既明',
    /characters\[1\]\.profile/,
  );
  fail(
    (f) => (f.characters[2].identity.oneLiner = 'a\nb'),
    'CAST_SHAPE',
    '林小满',
    /characters\[2\]\.identity\.oneLiner/,
  );
  // the header and the temporary keys
  fail((f) => (f.format = 'something-else'), 'CAST_FILE_HEADER', null);
  fail((f) => (f.version = 2), 'CAST_FILE_HEADER', null);
  fail((f) => (f.characters[2].characterId = 'new:'), 'CAST_FILE_NEW_KEY', '林小满');
  fail((f) => f.characters.push({ ...f.characters[2] }), 'CAST_DUPLICATE_ID', '林小满');
  fail(
    (f) => (f.characters[2].workbench = { displayName: '名字太长了太长了太长了太长了' }),
    'CAST_FILE_WORKBENCH',
    '林小满',
  );
  fail((f) => (f.characters[2].workbench = { nickname: 'x' }), 'CAST_FILE_WORKBENCH', '林小满');
});

test('limits: more than 15 chat characters or 40 people are reported', () => {
  const many = example();
  many.characters = Array.from({ length: CAST_LIMITS.chatCharacters + 1 }, (_, i) => ({
    ...many.characters[0],
    characterId: `role-m${i}`,
    identity: { ...many.characters[0].identity, names: [{ text: `角${i}` }] },
  }));
  many.ratings = {};
  many.directions = [];
  many.groups = [];
  many.stories = [];
  assert.ok(codes(many).includes('CAST_SHAPE'));
  const crowd = example();
  crowd.people = Array.from({ length: CAST_LIMITS.people + 1 }, (_, i) => ({
    id: `new-p${i}`,
    kind: 'person',
    names: [{ text: `人${i}` }],
    oneLiner: '',
  }));
  crowd.ratings = {};
  crowd.stories = [];
  assert.ok(codes(crowd).includes('CAST_SHAPE'));
});

test('a view over the cap is reported with its size and what would be dropped, and it still passes (the cap drops, never blocks)', () => {
  const file = example();
  file.stories = Array.from({ length: 40 }, (_, i) => ({
    title: `旧事${String(i).padStart(2, '0')}`,
    summary: '摘'.repeat(190),
    details: '细'.repeat(480),
    period: { start: `20${String(10 + (i % 15)).padStart(2, '0')}`, end: '' },
    participants: ['role-example01'],
    boundary: '',
    overrides: [],
  }));
  file.ratings = {};
  const { prepared, ok, output } = check(file);
  assert.equal(ok, true, output.join('\n'));
  const view = prepared!.views.find((v) => v.name === '周小禾')!;
  assert.ok(view.size > view.max, 'over the cap before it is applied');
  assert.ok(view.finalSize <= view.max, 'and under it after');
  assert.ok(view.dropped.length > 0 && view.dropped.every((d) => d.includes('旧事')), view.dropped.join());
  assert.ok(output.some((line) => line.includes('周小禾') && line.includes('超出') && line.includes('会舍弃')));
  // a character that did not live those stories is not affected
  assert.equal(prepared!.views.find((v) => v.name === '沈既明')!.dropped.length, 0);
});

test('a key written new:<name> is rewritten everywhere it is used, ids may be omitted, and nothing is read from the file’s own ids it does not carry', () => {
  const { prepared } = check(example());
  const doc = prepared!.doc!;
  const made = prepared!.created[0]!;
  assert.deepEqual([made.key, made.name, made.matched], ['new:林小满', '林小满', false]);
  assert.ok(!JSON.stringify(doc).includes('new:') && !JSON.stringify(doc).includes('new-'));
  assert.ok(doc.groups[0]!.members.includes(made.id));
  assert.ok(doc.stories[1]!.participants.includes(made.id));
  assert.ok(doc.ratings[made.id] !== undefined && doc.ratings['role-example01']![made.id] === 3.5);
  assert.equal(doc.characters.find((c) => c.characterId === made.id)!.identity.names[0]!.text, '林小满');
  // every entry got a server id although the file carried none
  assert.ok(doc.characters.every((c) => c.identity.names.every((n) => /^e_/.test(n.id))));
  assert.equal(made.workbench.displayName, '林小满');
  assert.equal(made.workbench.welcome, '嗨，我是小满。你也是来老街逛逛的吗？');
});
