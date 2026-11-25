import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEME_CATEGORIES,
  MEME_DROP_CATEGORIES,
  MEME_KEPT_CATEGORIES,
  MEME_ROW_PROBLEMS,
  MEME_SOURCES,
  MEME_SOURCE_LABELS,
  isKeptCategory,
  readMemeUse,
} from '../../../packages/contracts/web-memes.ts';
import { REFUSAL_STATUS } from '../../../apps/server/platform/web-refusal-status.ts';
import { ERROR_SENTENCES } from '../../../apps/player-web/src/features/admin/error-sentences.ts';
import { ROW_PROBLEM_TEXT, ROW_STATUS_TEXT, categoryChoices, fnv } from '../../../apps/player-web/src/features/admin/memes/memes-shared.ts';
import { MEME_ENTRIES } from '../../../apps/server/memes/meme-dictionary.ts';
import { SHIPPED_MEME_LIBRARY, buildMatchLibrary, matchMemes } from '../../../apps/server/memes/meme-match.ts';
import { parseDelimited } from '../../../apps/server/memes/meme-import.ts';
import { curationCounts, readData, shipsOff } from '../../../scripts/build-memes.ts';

/** Part 37c-1b: the data's categories, the matcher over a library, the upload's text parser, the page's words. */
const NONE = new Set<string>();
const KNOW = readMemeUse({});

test('data: the header counts equal the entries; ships-off = not kept or an everyday word; a hand-made category is required', () => {
  const data = readData();
  assert.deepEqual(data.curation, curationCounts(data.entries));
  assert.equal(data.curation.kept, 572);
  assert.ok(data.entries.every((e) => MEME_CATEGORIES.includes(e.c ?? '')));
  assert.equal(shipsOff({ c: '心情' }), false);
  assert.equal(shipsOff({ c: '心情', x: 1 }), true, 'an everyday word ships off even when kept');
  assert.equal(shipsOff({ c: 'AI科技' }), true);
  assert.equal(shipsOff({}), true, 'no category = not kept');
  assert.deepEqual(MEME_CATEGORIES, [...MEME_KEPT_CATEGORIES, ...MEME_DROP_CATEGORIES]);
  assert.ok(MEME_KEPT_CATEGORIES.every((c) => isKeptCategory(c)) && MEME_DROP_CATEGORIES.every((c) => !isKeptCategory(c)));
  // the generated module agrees with the data entry by entry (term, category, default)
  assert.equal(MEME_ENTRIES.length, data.entries.length);
  data.entries.forEach((e, i) => {
    const m = MEME_ENTRIES[i]!;
    assert.deepEqual([m.term, m.category, m.defaultOff, m.everyday], [e.t, e.c, shipsOff(e), e.x === 1]);
  });
});

test('matcher over a library: own entries match, an edited meaning wins, off keys never match, the shipped library is the default', () => {
  const library = buildMatchLibrary([{ term: '自家的梗', meaning: '我自己加的' }], new Map([['松弛感', '改过的释义']]));
  const hits = matchMemes(['自家的梗 和 松弛感'], NONE, KNOW, undefined, library);
  assert.deepEqual(hits.map((h) => [h.term, h.meaning]), [['松弛感', '改过的释义'], ['自家的梗', '我自己加的']].sort((a, b) => b[0]!.length - a[0]!.length || (a[0]! < b[0]! ? -1 : 1)));
  assert.deepEqual(matchMemes(['自家的梗'], new Set(['自家的梗']), KNOW, undefined, library), [], 'an own entry that is off never matches');
  assert.deepEqual(matchMemes(['自家的梗'], NONE, KNOW), [], 'the default library holds no own entry');
  assert.equal(matchMemes(['松弛感'], NONE, KNOW)[0]!.meaning, MEME_ENTRIES.find((e) => e.term === '松弛感')!.meaning);
  assert.equal(matchMemes(['松弛感'], NONE, KNOW, undefined, SHIPPED_MEME_LIBRARY)[0]!.meaning, MEME_ENTRIES.find((e) => e.term === '松弛感')!.meaning);
  // an own term that equals a shipped one is impossible in the library; if it ever appeared, the shipped entry stays
  const clash = buildMatchLibrary([{ term: '松弛感', meaning: '冒名' }], new Map());
  assert.equal(matchMemes(['松弛感'], NONE, KNOW, undefined, clash)[0]!.meaning, MEME_ENTRIES.find((e) => e.term === '松弛感')!.meaning);
  // a one-character own term never matches (a single character is not a meme)
  assert.deepEqual(matchMemes(['润'], NONE, KNOW, undefined, buildMatchLibrary([{ term: '润', meaning: 'x' }], new Map())), []);
});

test('upload text: quotes, CRLF, a BOM, doubled quotes, tab-separated paste, a quoted newline', () => {
  assert.deepEqual(parseDelimited('﻿a,b,c\r\n"x,1","y ""q""",z\r\n'), [['a', 'b', 'c'], ['x,1', 'y "q"', 'z']]);
  assert.deepEqual(parseDelimited('词\t释义\t分类\n甲\t乙\t丙'), [['词', '释义', '分类'], ['甲', '乙', '丙']]);
  assert.deepEqual(parseDelimited('a,b\n"line\none",c'), [['a', 'b'], ['line\none', 'c']]);
  assert.deepEqual(parseDelimited(''), []);
  assert.deepEqual(parseDelimited('a,b\r\n\r\nc,d'), [['a', 'b'], [''], ['c', 'd']]);
});

test('the page speaks: a sentence for every row problem and status, every new STOP code has a status and a short sentence', () => {
  for (const problem of MEME_ROW_PROBLEMS) assert.ok(ROW_PROBLEM_TEXT[problem], problem);
  for (const status of ['ok', 'update', 'revive', 'unchanged', 'queued', 'invalid'] as const) assert.ok(ROW_STATUS_TEXT[status], status);
  assert.equal(ROW_STATUS_TEXT.revive, '曾删除');
  for (const code of [
    'WEB_MEMELIB_SCHEMA_MISMATCH', 'MEME_DUPLICATE', 'MEME_LIBRARY_FULL', 'MEME_QUEUE_NOT_FOUND', 'MEME_TERM_EMPTY', 'MEME_TERM_TOO_LONG',
    'MEME_TERM_TOO_SHORT', 'MEME_MEANING_EMPTY', 'MEME_MEANING_TOO_LONG', 'MEME_CATEGORY_INVALID', 'MEME_IMPORT_EMPTY', 'MEME_IMPORT_COLUMNS',
    'MEME_IMPORT_TOO_MANY', 'MEME_IMPORT_FILE',
  ]) {
    assert.ok(typeof REFUSAL_STATUS[code as keyof typeof REFUSAL_STATUS] === 'number', `${code} has an HTTP status`);
    const sentence = (ERROR_SENTENCES as Record<string, string>)[code];
    assert.ok(sentence && [...sentence].length <= 60, `${code} has a sentence of at most 60 characters`);
  }
  assert.deepEqual(MEME_SOURCES.map((s) => MEME_SOURCE_LABELS[s]), ['自带', '手动', '上传', '梗雷达', '玩家聊天']);
  // the category choices: the five; plus the entry's own when it is a drop reason (an edit may leave it)
  assert.deepEqual(categoryChoices(null), [...MEME_KEPT_CATEGORIES]);
  assert.deepEqual(categoryChoices('心情'), [...MEME_KEPT_CATEGORIES]);
  assert.deepEqual(categoryChoices('金融'), [...MEME_KEPT_CATEGORIES, '金融']);
  assert.notEqual(fnv('a'), fnv('b'));
  assert.equal(fnv('同一段'), fnv('同一段'));
});
