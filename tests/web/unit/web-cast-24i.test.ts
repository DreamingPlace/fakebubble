import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileCastView, compileCastViewDetailed } from '../../../apps/server/cast/cast-compile.ts';
import { exportCastFile, prepareCastFile } from '../../../apps/server/cast/cast-file.ts';
import { upgradeCastDoc } from '../../../apps/server/cast/cast-upgrade.ts';
import {
  canonicalCastJson,
  castEntryIds,
  normalizeCastDoc,
  validateCastDoc,
} from '../../../apps/server/cast/cast-validation.ts';
import { checkCastFile } from '../../../scripts/cast-file.ts';
import {
  CAST_LIMITS,
  CAST_SCHEMA,
  castItemProblem,
  castLength,
  type CastAlias,
  type CastDoc,
} from '../../../packages/contracts/web-cast.ts';
import { issueSentence } from '../../../packages/contracts/web-cast-text.ts';
import { counterIds, maxCastRaw, sampleCast, sampleCastRaw } from '../fixtures/cast-sample.ts';

const present = { exists: () => true, deleted: () => false };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const normalize = (raw: unknown, known: ReadonlySet<string> = new Set()) =>
  normalizeCastDoc(raw, { known, fresh: counterIds() });
/** The first problem normalizeCastDoc reports for `raw`: its code and path. */
const firstIssue = (raw: unknown) => {
  try {
    normalize(raw);
  } catch (error) {
    const issues = (error as { detail?: { issues?: { code: string; path: string }[] } }).detail?.issues;
    return issues?.[0] ?? null;
  }
  return null;
};
const withAlias = (text: string, extra: Partial<CastAlias> = {}) => {
  const raw = sampleCastRaw();
  raw.characters[0]!.identity.aliases = [{ text, kind: 'other', attitude: 'ok', ...extra } as never];
  return raw;
};
const withAddresses = (...texts: string[]) => {
  const raw = sampleCastRaw();
  (raw.directions[0] as Record<string, unknown>).addresses = texts.map((text) => ({ text }));
  return raw;
};
const file = (doc: unknown) => ({ format: 'burbur-cast', version: 1, ...(doc as object) });
const prepare = (doc: unknown, current: CastDoc | null = null) =>
  prepareCastFile(file(doc), {
    current,
    known: current ? castEntryIds(current) : new Set(),
    lookup: present,
    newId: () => 'role-test0001',
    entryId: counterIds(),
  });

// ---- the length convention ------------------------------------------------------------------------------------------------

test('length convention: UTF-16 code units, spaces are part of the item, nothing is trimmed', () => {
  assert.equal(castLength('小羊'), 2);
  assert.equal(castLength('Mary Jane'), 9);
  assert.equal(castLength('😀'), 2, 'an astral emoji is two units');
  assert.equal(castLength('é'), 1);
  assert.equal(castLength('é'), 2, 'a combining mark is one unit of its own');
  // Part 24l (named exception, was 16): identity aliases of every kind hold 25; a 称呼 item stays 16.
  assert.equal(CAST_LIMITS.alias, 25);
  assert.equal(CAST_LIMITS.address, 16, 'the sentence for "too long" is shared by both lists');
});

test('an item of exactly 16 units passes and 17 is refused, for 汉字, astral emoji, ASCII + emoji and names with spaces', () => {
  const pass = (text: string) => assert.equal(castItemProblem(text, 16), null, text);
  const fail = (text: string, problem: string) => assert.equal(castItemProblem(text, 16), problem, text);
  pass('字'.repeat(16));
  fail('字'.repeat(17), 'long');
  pass('😀'.repeat(8));
  assert.equal(castLength('😀'.repeat(8)), 16);
  fail('a'.repeat(15) + '😀', 'long');
  assert.equal(castLength('a'.repeat(15) + '😀'), 17);
  pass('Mary Jane'); // inner spaces are part of the name
  pass('Mary Jane Watson-Ka'.slice(0, 16));
  fail(' Mary', 'space');
  fail('Mary ', 'space');
  fail('　Mary', 'space');
  fail('a\nb', 'control');
  fail('a\tb', 'control');
  fail('a b', 'control');
  fail('', 'empty');
});

// Part 24l (named exception): the alias half is now 25 passes / 26 refused (was 16 / 17); the address half is unchanged.
test('the validator names the item: 25 passes, 26 is refused at the right path with the right sentence (aliases); addresses 16 / 17', () => {
  assert.equal(firstIssue(withAlias('字'.repeat(25))), null);
  assert.equal(
    firstIssue(withAlias(`${'Mary Jane '.repeat(2)}Watsonn`.slice(0, 25))),
    null,
    'an English alias with spaces of 25',
  );
  assert.deepEqual(firstIssue(withAlias('字'.repeat(26))), {
    code: 'CAST_ITEM_TOO_LONG',
    path: 'doc.characters[0].identity.aliases[0].text',
  });
  assert.equal(firstIssue(withAddresses('😀'.repeat(8))), null);
  assert.deepEqual(firstIssue(withAddresses('字'.repeat(17))), {
    code: 'CAST_ITEM_TOO_LONG',
    path: 'doc.directions[0].addresses[0].text',
  });
  assert.deepEqual(firstIssue(withAddresses('小羊', 'a'.repeat(15) + '😀')), {
    code: 'CAST_ITEM_TOO_LONG',
    path: 'doc.directions[0].addresses[1].text',
  });
  assert.equal(firstIssue(withAddresses('Mary Jane')), null);
  assert.equal(firstIssue(withAlias('Hazel Zhou')), null);
  assert.equal(firstIssue(withAlias('a'.repeat(15) + ' '))?.code, 'CAST_ITEM_EDGE_SPACE', 'rejected, never trimmed');
  assert.equal(firstIssue(withAlias(' leading'))?.code, 'CAST_ITEM_EDGE_SPACE');
  assert.equal(firstIssue(withAlias('two\nlines'))?.code, 'CAST_ITEM_CONTROL');
  assert.equal(firstIssue(withAlias(''))?.code, 'CAST_ITEM_EMPTY');
  assert.equal(firstIssue(withAddresses(' 小羊'))?.code, 'CAST_ITEM_EDGE_SPACE');
});

test('errors read the way people read them, with 1-based item numbers', () => {
  const doc = sampleCast();
  const name = doc.characters[0]!.identity.names[0]!.text;
  const id = doc.characters[0]!.characterId;
  assert.deepEqual(issueSentence(doc, 'CAST_ITEM_TOO_LONG', `characters[${id}].identity.aliases[3].text`), {
    who: name,
    text: `${name} · 别名 第 4 项 — 超过 25 字`,
  });
  // the same sentence for a shape path (the index form the save answer uses)
  assert.equal(
    issueSentence(doc, 'CAST_ITEM_TOO_LONG', 'doc.characters[0].identity.aliases[3].text').text,
    `${name} · 别名 第 4 项 — 超过 25 字`,
  );
  const d = doc.directions[0]!;
  assert.equal(
    issueSentence(doc, 'CAST_ITEM_TOO_LONG', `directions[${d.id}].addresses[1].text`).text,
    `${doc.characters.find((c) => c.characterId === d.from)!.identity.names[0]!.text} → ${doc.characters.find((c) => c.characterId === d.to)?.identity.names[0]?.text ?? doc.people.find((p) => p.id === d.to)!.names[0]!.text} · 称呼 第 2 项 — 超过 16 字`,
  );
  assert.equal(
    issueSentence(doc, 'CAST_ITEM_EDGE_SPACE', `characters[${id}].identity.aliases[0].text`).text,
    `${name} · 别名 第 1 项 — 开头或结尾有空格（不会自动去掉）`,
  );
});

// ---- counts and totals -----------------------------------------------------------------------------------------------------

test('count limits: 12 aliases pass and 13 fail; 6 addresses pass and 7 fail', () => {
  const aliases = (n: number) => {
    const raw = sampleCastRaw();
    raw.characters[0]!.identity.aliases = Array.from({ length: n }, (_, i) => ({
      text: `别名${i}`,
      kind: 'other',
      attitude: 'ok',
    })) as never;
    return raw;
  };
  assert.equal(firstIssue(aliases(12)), null);
  assert.deepEqual(firstIssue(aliases(13)), {
    code: 'CAST_TOO_MANY_ITEMS',
    path: 'doc.characters[0].identity.aliases',
  });
  const addresses = (n: number) => withAddresses(...Array.from({ length: n }, (_, i) => `叫法${i}`));
  assert.equal(firstIssue(addresses(6)), null);
  assert.deepEqual(firstIssue(addresses(7)), { code: 'CAST_TOO_MANY_ITEMS', path: 'doc.directions[0].addresses' });
  assert.equal(firstIssue(addresses(0)), null, 'an empty list is fine');
});

test('document totals: 180 aliases and 1,200 addresses are enforced; a repeat inside one list is a located error', () => {
  const doc = sampleCast();
  assert.deepEqual(validateCastDoc(doc, 'draft', present).errors, []);
  // 180 = 15 x 12: the maximal sample sits exactly on it and passes
  const max = normalize(maxCastRaw());
  assert.equal(
    max.characters.reduce((n, c) => n + c.identity.aliases.length, 0),
    CAST_LIMITS.aliasesTotal,
  );
  assert.deepEqual(validateCastDoc(max, 'draft', present).errors, []);
  // a 16th character with 12 aliases (the character cap would stop it first on the way in) breaks the total
  const over = clone(max);
  over.characters.push({ ...clone(over.characters[0]!), characterId: 'c16' });
  over.characters[15]!.identity.aliases.forEach((a, i) => (a.id = `x16-${i}`));
  over.characters[15]!.identity.names.forEach((n, i) => (n.id = `n16-${i}`));
  assert.ok(validateCastDoc(over, 'draft', present).errors.some((e) => e.code === 'CAST_ALIAS_TOTAL'));
  // addresses: 1,200 passes, 1,201 fails
  const many = (count: number) => {
    const d = clone(doc);
    d.directions = [];
    let n = 0;
    const ids = d.characters.map((c) => c.characterId);
    for (const from of ids)
      for (const to of ids) {
        if (from === to || n >= count) continue;
        const per = Math.min(6, count - n);
        d.directions.push({
          id: `d${d.directions.length}`,
          from,
          to,
          addresses: Array.from({ length: per }, (_, i) => ({ id: `a${d.directions.length}-${i}`, text: `叫${i}` })),
          treatment: '',
        });
        n += per;
      }
    return d;
  };
  assert.deepEqual(
    validateCastDoc(many(CAST_LIMITS.addressesTotal), 'draft', present).errors.filter(
      (e) => e.code === 'CAST_ADDRESS_TOTAL',
    ),
    [],
  );
  assert.ok(
    validateCastDoc(many(CAST_LIMITS.addressesTotal + 1), 'draft', present).errors.some(
      (e) => e.code === 'CAST_ADDRESS_TOTAL',
    ),
  );
  // duplicates within one list: the later item is the error; the same text in another list is fine.
  // Part 24l (named exception): "the same" is now the same text AND the same kind, so the cross-kind pair that was an error here
  // (别名 + 黑称) is allowed (asserted below), and the repeat is a second 别名.
  const dup = clone(doc);
  const id = dup.characters[0]!.characterId;
  dup.characters[0]!.identity.aliases = [
    { id: 'a1', text: '阿福', kind: 'other', attitude: 'ok' },
    { id: 'a2', text: '阿福', kind: 'other', attitude: 'dislikes' },
  ];
  assert.deepEqual(validateCastDoc(dup, 'draft', present).errors, [
    { code: 'CAST_DUPLICATE_ITEM', path: `characters[${id}].identity.aliases[1].text` },
  ]);
  const crossKind = clone(doc);
  crossKind.characters[0]!.identity.aliases = [
    { id: 'a1', text: '阿福', kind: 'other', attitude: 'ok' },
    { id: 'a2', text: '阿福', kind: 'insult', attitude: 'dislikes' },
  ];
  assert.deepEqual(validateCastDoc(crossKind, 'draft', present).errors, [], 'one alias per kind: 别名 + 黑称 is fine');
  const dupAddress = clone(doc);
  dupAddress.directions[0]!.addresses = [
    { id: 'p1', text: '小羊' },
    { id: 'p2', text: '小羊' },
  ];
  assert.deepEqual(validateCastDoc(dupAddress, 'draft', present).errors, [
    { code: 'CAST_DUPLICATE_ITEM', path: `directions[${dupAddress.directions[0]!.id}].addresses[1].text` },
  ]);
});

test('main name, displayName cap and 梗 key limits are unchanged', () => {
  assert.equal(CAST_LIMITS.name, 12);
  assert.equal(CAST_LIMITS.memeKey, 24);
  const raw = sampleCastRaw();
  raw.characters[0]!.identity.names = [{ text: '字'.repeat(13) }];
  assert.equal(firstIssue(raw)?.code, 'CAST_SHAPE');
  const memes = sampleCastRaw();
  memes.memes[0]!.key = '梗'.repeat(25);
  assert.equal(firstIssue(memes)?.code, 'CAST_SHAPE');
});

// ---- one direction, three forms of address; four kinds of alias; save → export → import → compile ------------------------

test('A→B saves ["小羊","XX老师","XXX"]; export then re-import keeps the three values in order, one record, and creates nothing twice', () => {
  const raw = withAddresses('小羊', 'XX老师', 'XXX');
  const doc = normalize(raw);
  const pair = (d: CastDoc) =>
    d.directions.filter((x) => x.from === doc.directions[0]!.from && x.to === doc.directions[0]!.to);
  assert.deepEqual(
    pair(doc)[0]!.addresses.map((a) => a.text),
    ['小羊', 'XX老师', 'XXX'],
  );
  const exported = exportCastFile(doc);
  assert.equal(exported.schema, CAST_SCHEMA);
  const first = prepare(exported, doc);
  assert.equal(first.importable, true, JSON.stringify(first.problems));
  assert.equal(first.summary!.unchanged, true, 'the same file again changes nothing');
  assert.equal(canonicalCastJson(first.doc!), canonicalCastJson(doc), 'same ids, same order');
  assert.equal(pair(first.doc!).length, 1, 'one record for the pair');
  assert.deepEqual(
    pair(first.doc!)[0]!.addresses.map((a) => a.text),
    ['小羊', 'XX老师', 'XXX'],
  );
  assert.ok(!first.warnings.some((w) => w.code === 'CAST_FILE_OLD_FORMAT'));
  // an id-less copy (a hand-written file) of the same content is also "no change", ids kept
  const stripped = clone(exported) as Record<string, unknown>;
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([k]) => k !== 'id')
              .map(([k, v]) => [k, strip(v)]),
          )
        : value;
  const again = prepare(strip(stripped), doc);
  assert.equal(again.importable, true, JSON.stringify(again.problems));
  assert.equal(again.summary!.unchanged, true);
  assert.equal(canonicalCastJson(again.doc!), canonicalCastJson(doc));
});

test('4 aliases keep their own kind and attitude through save, export, import and compile', () => {
  const raw = sampleCastRaw();
  raw.characters[0]!.identity.aliases = [
    { text: '小满', kind: 'other', attitude: 'likes' },
    { text: 'Mary Jane', kind: 'other', attitude: 'ok' },
    { text: '本姑娘', kind: 'self', attitude: 'likes' },
    { text: '路人甲', kind: 'neutral', attitude: 'ok' },
    { text: '怂包', kind: 'insult', attitude: 'dislikes' },
    { text: '满满同学', kind: 'neutral', attitude: 'dislikes' },
    // kind and attitude are independent: a 黑称 he is fine with, a 自称 he "dislikes"
    { text: '笨蛋', kind: 'insult', attitude: 'ok' },
    { text: '我自己', kind: 'self', attitude: 'dislikes' },
  ] as never;
  const doc = normalize(raw);
  const id = doc.characters[0]!.characterId;
  const shape = (d: CastDoc) => d.characters[0]!.identity.aliases.map((a) => [a.text, a.kind, a.attitude]);
  const expected = raw.characters[0]!.identity.aliases.map((a) => [a.text, a.kind, a.attitude]);
  assert.deepEqual(shape(doc), expected);
  const imported = prepare(exportCastFile(doc), doc);
  assert.deepEqual(shape(imported.doc!), expected);
  assert.equal(imported.summary!.unchanged, true);

  // compile: his own view carries every alias with its kind (spelled for the model) and attitude, in order
  const self = compileCastView(doc, id).self;
  assert.deepEqual(
    self.aliases.map((a) => [a.text, a.kind, a.attitude]),
    expected.map(([text, kind, attitude]) => [
      text,
      { self: '自称', other: '别名', neutral: '中性称呼', insult: '黑称' }[kind as string],
      attitude,
    ]),
  );
  // somebody else's card: usable names are other / neutral that he does not dislike; 黑称 and disliked names are listed apart
  const card = compileCastView(doc, doc.characters[1]!.characterId).others.find((o) => o.name === self.name)!;
  assert.deepEqual(card.aliases, ['小满', 'Mary Jane', '路人甲']);
  assert.deepEqual(card.doNotCall, { rule: '不要主动这样叫', items: ['怂包', '满满同学', '笨蛋'] });
  for (const bad of ['怂包', '笨蛋', '满满同学']) assert.ok(!card.aliases.includes(bad), `${bad} is not a usable name`);
  const everywhere = JSON.stringify(compileCastView(doc, doc.characters[1]!.characterId));
  assert.ok(
    !everywhere.includes('本姑娘') && !everywhere.includes('我自己'),
    '自称 is never in another character’s view',
  );
  // a card with nothing to avoid has no doNotCall key at all
  assert.equal('doNotCall' in compileCastView(doc, id).others[0]!, false);
});

test('compile: relations carry addresses in order; step 5 of the drop order drops the whole list with the 相处', () => {
  const doc = normalize(withAddresses('小羊', 'XX老师', 'XXX'));
  const from = doc.directions[0]!.from;
  const to = doc.directions[0]!.to;
  const toName = [
    ...doc.characters.map((c) => [c.characterId, c.identity.names[0]!.text]),
    ...doc.people.map((p) => [p.id, p.names[0]!.text]),
  ].find(([i]) => i === to)![1];
  const full = compileCastView(doc, from).relations.find((r) => r.to === toName)!;
  assert.deepEqual(full.addresses, ['小羊', 'XX老师', 'XXX']);
  assert.ok(!('address' in full));
  const tiny = compileCastViewDetailed(doc, from, 1);
  assert.ok(tiny.view.relations.every((r) => r.addresses === undefined && r.treatment === undefined));
  assert.ok(tiny.dropped.relationTexts > 0);
  assert.ok(
    tiny.view.relations.some((r) => r.rating !== undefined),
    'the ratings stay',
  );
});

// ---- schema 1: lossless upgrade --------------------------------------------------------------------------------------------

const legacyDoc = () => {
  const doc = clone(sampleCast()) as unknown as Record<string, any>;
  doc.schema = 1;
  for (const c of doc.characters) for (const a of c.identity.aliases) delete a.kind;
  doc.directions[0].address = '小羊 / XX老师、XXX';
  doc.directions[1].address = '';
  doc.directions[2].address = ' 带空格 ';
  for (const d of doc.directions) delete d.addresses;
  // key order of a stored schema-1 document: id, from, to, address, treatment
  doc.directions = doc.directions.map((d: any) => ({
    id: d.id,
    from: d.from,
    to: d.to,
    address: d.address ?? '',
    treatment: d.treatment,
  }));
  return doc;
};

test('upgrade: an old address string is ONE item (never split), empty is [], aliases become kind other with the same attitude, ids kept', () => {
  const old = legacyDoc();
  const up = upgradeCastDoc(old, { deriveIds: true }) as Record<string, any>;
  assert.equal(up.schema, 2);
  assert.deepEqual(
    up.directions[0].addresses.map((a: any) => a.text),
    ['小羊 / XX老师、XXX'],
  );
  assert.deepEqual(up.directions[1].addresses, []);
  assert.deepEqual(
    up.directions[2].addresses.map((a: any) => a.text),
    [' 带空格 '],
    'historical text is kept as written',
  );
  assert.equal(up.directions[0].id, old.directions[0].id);
  assert.ok(!('address' in up.directions[0]));
  for (const [i, c] of up.characters.entries())
    for (const [j, a] of c.identity.aliases.entries()) {
      assert.equal(a.kind, 'other');
      assert.equal(a.attitude, old.characters[i].identity.aliases[j].attitude);
      assert.equal(a.id, old.characters[i].identity.aliases[j].id);
    }
  // deterministic: reading twice gives the same ids; the input is not touched
  assert.deepEqual(upgradeCastDoc(old, { deriveIds: true }), up);
  assert.equal(old.schema, 1);
  assert.ok('address' in old.directions[0]);
  // a schema-2 document passes through untouched
  const current = sampleCast();
  assert.equal(upgradeCastDoc(current, { deriveIds: true }), current);
});

test('a stored schema-1 document normalizes (the edge-space rule is not applied to history) and compiles; a NEW schema-2 one is held to it', () => {
  const old = legacyDoc();
  const up = upgradeCastDoc(old, { deriveIds: true });
  const doc = normalizeCastDoc(up, { known: castEntryIds(up as CastDoc), fresh: counterIds(), legacy: true });
  assert.equal(doc.directions[2]!.addresses[0]!.text, ' 带空格 ');
  assert.equal(doc.directions[0]!.addresses[0]!.text, '小羊 / XX老师、XXX');
  assert.ok(compileCastView(doc, doc.directions[0]!.from).relations.length > 0);
  assert.throws(() => normalizeCastDoc(up, { known: castEntryIds(up as CastDoc), fresh: counterIds() }));
});

test('an old schema-1 file imports with the warning, converted by value; the same old file again changes nothing', () => {
  const old = JSON.parse(
    readFileSync(new URL('../fixtures/cast-file-schema1.json', import.meta.url), 'utf8'),
  ) as Record<string, any>;
  assert.equal(old.schema, 1);
  old.directions[0].address = '小满 / 林同学、Jane';
  const first = prepare(old);
  assert.equal(first.importable, true, JSON.stringify(first.problems));
  const warning = first.warnings.find((w) => w.code === 'CAST_FILE_OLD_FORMAT');
  assert.ok(warning);
  assert.equal(warning!.text, '旧格式文件，已按原值转换');
  const doc = first.doc!;
  assert.equal(doc.schema, 2);
  const direction = doc.directions[0]!;
  assert.deepEqual(
    direction.addresses.map((a) => a.text),
    ['小满 / 林同学、Jane'],
    'one item, never split',
  );
  const alias = doc.characters[0]!.identity.aliases;
  assert.deepEqual(
    alias.map((a) => [a.text, a.kind, a.attitude]),
    [
      ['小禾', 'other', 'likes'],
      ['周店员', 'other', 'dislikes'],
    ],
  );
  // the draft now holds it: the same old file again is "unchanged" and keeps every id
  const second = prepare(old, doc);
  assert.equal(second.importable, true, JSON.stringify(second.problems));
  assert.equal(second.summary!.unchanged, true);
  assert.equal(canonicalCastJson(second.doc!), canonicalCastJson(doc));
  // export is schema 2 item by item
  const out = exportCastFile(doc);
  assert.equal(out.schema, 2);
  assert.ok(out.directions.every((d) => Array.isArray(d.addresses) && !('address' in d)));
  // and the local check script agrees, with the same warning and exit-0 content
  const { ok, output } = checkCastFile(JSON.stringify(old));
  assert.equal(ok, true, output.join('\n'));
  assert.ok(output.some((line) => line.includes('旧格式文件，已按原值转换')));
});

test('an old file with an address that now breaks the new rule is refused with a located error, not trimmed', () => {
  const old = JSON.parse(
    readFileSync(new URL('../fixtures/cast-file-schema1.json', import.meta.url), 'utf8'),
  ) as Record<string, any>;
  old.directions[0].address = ' 小满';
  const result = prepare(old);
  assert.equal(result.importable, false);
  assert.equal(result.problems[0]!.code, 'CAST_ITEM_EDGE_SPACE');
  assert.match(result.problems[0]!.text, /称呼 第 1 项 — 开头或结尾有空格/);
});

test('the example file is schema 2 with a 3-address direction and a 4-kind alias list including an English name with a space', () => {
  const example = JSON.parse(readFileSync('examples/cast-file.example.json', 'utf8')) as Record<string, any>;
  assert.equal(example.schema, 2);
  assert.ok(example.directions.some((d: any) => d.addresses.length === 3));
  const aliases = example.characters.flatMap((c: any) => c.identity.aliases);
  assert.ok(aliases.length >= 4);
  assert.deepEqual([...new Set(aliases.map((a: any) => a.kind))].sort(), ['insult', 'neutral', 'other', 'self']);
  assert.ok(aliases.some((a: any) => /\S \S/.test(a.text)));
  const { prepared, ok, output } = checkCastFile(JSON.stringify(example));
  assert.equal(ok, true, output.join('\n'));
  assert.ok(!prepared!.warnings.some((w) => w.code === 'CAST_FILE_OLD_FORMAT'));
});

// ---- Part 24l: the cast view carries only the name card; the stored per-character fields stay lossless -----------------------

test('24l the per-character fields stay in the document and round-trip through export → import byte for byte, though they are not compiled', () => {
  const doc = sampleCast();
  const kept = (d: CastDoc) =>
    JSON.stringify(
      d.characters.map((c) => [
        c.profile,
        c.personality,
        c.speech,
        c.experiences,
        c.performance,
        c.hidden,
        c.identity.selfConcept,
        c.identity.prototype,
      ]),
    );
  const before = kept(doc),
    json = canonicalCastJson(doc);
  assert.ok(doc.characters.every((c) => c.profile && c.personality && c.performance && c.hidden.length));
  assert.ok(
    doc.characters.some((c) => c.identity.prototype),
    'the sample has a prototype to keep',
  );
  // Compiling reads the document and changes nothing in it.
  for (const c of doc.characters) compileCastView(doc, c.characterId);
  assert.equal(canonicalCastJson(doc), json);
  const prepared = prepareCastFile(exportCastFile(doc), {
    current: doc,
    known: castEntryIds(doc),
    lookup: present,
    newId: () => 'role-test0001',
    entryId: counterIds(),
  });
  assert.deepEqual(prepared.problems, []);
  assert.equal(canonicalCastJson(prepared.doc!), json, 'the whole document is byte-identical after the round trip');
  assert.equal(kept(prepared.doc!), before);
  // None of it is in what the character is told, and view.self is exactly the name card.
  const view = compileCastView(doc, doc.characters[0]!.characterId);
  assert.deepEqual(Object.keys(view.self).sort(), ['aliases', 'name', 'names', 'oneLiner']);
  const told = JSON.stringify(view.self);
  const mine = doc.characters[0]!;
  for (const text of [mine.profile, mine.personality, mine.performance, mine.identity.selfConcept])
    assert.ok(!text || !told.includes(text));
});

// ---- Part 24l addenda: room for shared stories; the same name as two kinds of alias ----------------------------------------------

test('24l story summary holds 600 and details 2,000, in stories[] and in groups[].stories[]; one over is a located error', () => {
  assert.equal(CAST_LIMITS.storySummary, 600);
  assert.equal(CAST_LIMITS.storyDetails, 2_000);
  assert.equal(CAST_LIMITS.viewMax, 24_000, 'the per-character view cap is unchanged');
  const edit = (change: (raw: ReturnType<typeof sampleCastRaw>) => void) => {
    const raw = sampleCastRaw();
    change(raw);
    return firstIssue(raw);
  };
  const story = (raw: ReturnType<typeof sampleCastRaw>) => raw.stories[0] as unknown as Record<string, string>;
  const groupStory = (raw: ReturnType<typeof sampleCastRaw>) =>
    (raw.groups[0] as unknown as { stories: Record<string, string>[] }).stories[0]!;
  for (const [field, max] of [
    ['summary', 600],
    ['details', 2_000],
  ] as const) {
    assert.equal(
      edit((r) => (story(r)[field] = '长'.repeat(max))),
      null,
      `${field} ${max} passes`,
    );
    assert.deepEqual(
      edit((r) => (story(r)[field] = '长'.repeat(max + 1))),
      { code: 'CAST_SHAPE', path: `doc.stories[0].${field}` },
      `${field} ${max + 1} fails, located`,
    );
    assert.equal(
      edit((r) => (groupStory(r)[field] = '长'.repeat(max))),
      null,
    );
    assert.deepEqual(
      edit((r) => (groupStory(r)[field] = '长'.repeat(max + 1))),
      { code: 'CAST_SHAPE', path: `doc.groups[0].stories[0].${field}` },
    );
  }
});

test('24l a view over the cap still gives up the oldest stories first, with the bigger stories', () => {
  const raw = sampleCastRaw();
  const stories = raw.stories as unknown as Record<string, unknown>[];
  stories.forEach((s, i) => {
    s.summary = '史'.repeat(600);
    s.details = '节'.repeat(2_000);
    s.period = { start: `20${10 + i}-01`, end: '' };
  });
  const doc = normalize(raw);
  const id = doc.characters[0]!.characterId;
  const full = compileCastViewDetailed(doc, id);
  const cap = JSON.stringify(full.view).length - 1;
  const cut = compileCastViewDetailed(doc, id, cap);
  assert.ok(JSON.stringify(cut.view).length <= cap);
  const dropped = cut.dropped.memes + cut.dropped.heardStories + cut.dropped.groupStories + cut.dropped.livedStories;
  assert.ok(dropped >= 1, 'something was given up');
  // within one level, what was given up is older than (or as old as) every story that is left: oldest first
  for (const level of ['听说', '亲历'] as const) {
    const before = full.view.stories.filter((x) => x.level === level);
    const left = new Set(cut.view.stories.filter((x) => x.level === level).map((x) => x.title));
    const gone = before.filter((x) => !left.has(x.title));
    const stay = before.filter((x) => left.has(x.title));
    for (const g of gone) for (const k of stay) assert.ok(g.period.start <= k.period.start, `${level}: oldest first`);
  }
  assert.ok(cut.dropped.memes >= 0 && dropped >= 1);
});

test('24l one name as 别名 and 黑称 is two aliases; in others’ cards it is only under doNotCall, once', () => {
  const doc = sampleCast();
  const [first, second] = doc.characters;
  first!.identity.aliases = [
    { id: 'x1', text: '小野', kind: 'other', attitude: 'ok' },
    { id: 'x2', text: '小野', kind: 'insult', attitude: 'dislikes' },
    { id: 'x3', text: '阿野', kind: 'neutral', attitude: 'ok' },
    { id: 'x4', text: 'Mary Jane Watson Zhou 25ch', kind: 'other', attitude: 'likes' },
  ];
  assert.deepEqual(validateCastDoc(doc, 'draft', present).errors, []);
  const card = compileCastView(doc, second!.characterId).others.find((o) => o.name === first!.identity.names[0]!.text)!;
  assert.ok(!card.aliases.includes('小野'));
  assert.ok(card.aliases.includes('阿野'));
  assert.deepEqual(card.doNotCall?.items, ['小野']);
  // his own view of himself is the name card: both aliases are there, each with its kind
  const own = compileCastView(doc, first!.characterId).self.aliases.filter((a) => a.text === '小野');
  assert.deepEqual(own.map((a) => a.kind).sort(), ['别名', '黑称']);
});
