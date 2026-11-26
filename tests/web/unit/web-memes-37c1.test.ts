import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';
import {
  MEME_HITS_MAX,
  MEME_LEVELS,
  MEME_LEVEL_DEFAULT,
  MEME_OVERRIDES_MAX,
  MemeUseError,
  readMemeUse,
  withoutMemeUse,
  writeMemeUse,
} from '../../../packages/contracts/web-memes.ts';
import {
  REHEARSAL_COLUMN_KEYS,
  REHEARSAL_NET_SETS,
  isRehearsalModels,
  parseRehearsalColumn,
  rehearsalColumnKey,
  rehearsalColumnLabel,
} from '../../../packages/contracts/web-rehearsal.ts';
import { isWriterChoice, WRITER_CHOICES } from '../../../packages/contracts/web-writer.ts';
import { filterEntries, readData, renderModule, MEME_NOTICE } from '../../../scripts/build-memes.ts';
import { MEME_ENTRIES, memeEntry } from '../../../apps/server/memes/meme-dictionary.ts';
import { matchMemes } from '../../../apps/server/memes/meme-match.ts';
import { compileFullView } from '../../../apps/server/cast/cast-compile.ts';
import {
  CAST_ALWAYS_ON,
  CAST_SELECT_BUDGET,
  castViewOf,
  emptyPicked,
  pickCastItems,
  selectCastView,
  unionPicked,
} from '../../../apps/server/cast/cast-select.ts';
import { canonicalCastJson } from '../../../apps/server/cast/cast-validation.ts';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import {
  writerDraftMessages,
  writerGuardMessages,
  writerPins,
  writerPolicyHash,
} from '../../../apps/server/generation/writer-v8.ts';
import {
  MEMES_HEAD,
  WRITER_MEMES_SHA256,
  memesBlock,
  writerMemesHash,
} from '../../../apps/server/generation/writer-memes.ts';
import { WRITER_PROFILE_SHA256, writerProfileHash } from '../../../apps/server/generation/writer-profile.ts';
import { rehearsalRequest } from '../../../apps/server/characters/web-rehearsal-request.ts';
import { builtinSet } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { validatedTemplate } from '../../../apps/server/characters/template-validation.ts';
import { castDocTooLarge } from '../../../packages/contracts/web-cast.ts';
import { sampleCast, sampleCastRaw, normalize } from '../fixtures/cast-sample.ts';
import { bigRaw } from '../fixtures/cast-big.ts';
import { textRequest } from '../../text-fixtures.ts';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const NONE = new Set<string>();
const KNOW = readMemeUse({});
/** What a character sees when nobody touched the switches: the common words of the data are off. */
// Part 37c-1b NAMED EXCEPTION: `defaultOff` now also holds the entries dropped in the re-curation; this test of Part 37c-1 is about the
// 72 common everyday words (the jieba list), which still ship off, so it follows the `everyday` flag. Nothing it asserts changed.
const DEFAULT_OFF = new Set(MEME_ENTRIES.filter((entry) => entry.everyday).map((entry) => entry.key));

// ---- 1. the dictionary ----------------------------------------------------------------------------------------------------------

test('import: only 2022 and later survive, an undated entry is dropped, and the data file holds exactly 1,806 entries', () => {
  const raw = (d: string) => ({ t: `词${d}`, m: '释义', o: '', d, tag: [] });
  assert.deepEqual(
    filterEntries([raw('2021'), raw('2022'), raw('2026'), raw(''), raw('1999'), raw('2022-05')]).map((e) => e.d),
    ['2022', '2026'],
  );
  const data = readData();
  assert.equal(data.count, 1806);
  assert.equal(data.entries.length, 1806);
  assert.equal(MEME_ENTRIES.length, 1806);
  assert.ok(data.entries.every((entry) => /^\d{4}$/.test(entry.d) && Number(entry.d) >= 2022));
  assert.ok(MEME_ENTRIES.every((entry) => entry.year >= 2022 && entry.meaning !== '' && entry.term !== ''));
  assert.equal(new Set(MEME_ENTRIES.map((entry) => entry.key)).size, MEME_ENTRIES.length, 'a term is a key: unique');
  assert.match(data.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(data.source.commit, 'e02f1eaf823000dbfa31ea0427afe920466f3626');
  assert.equal(data.license, 'CC-BY-4.0');
  assert.ok((memeEntry('松弛感')?.year ?? 0) >= 2022);
});

test('import: the generated module is exactly what the reviewed data file renders (nothing is fetched at runtime)', () => {
  const generated = readFileSync(
    new URL('../../../apps/server/memes/meme-dictionary.generated.ts', import.meta.url),
    'utf8',
  );
  assert.equal(generated, renderModule(readData()));
  assert.doesNotMatch(generated, /https?:\/\/(?!github\.com\/re-skylar\/chinese-meme-dict)/);
});

test('license: the exact notice, with the link, is on the terms page; the privacy page has none; no other text was added', () => {
  const NOTICE = 'chinese-meme-dict — 作者：sky（出力）、楠（出token）— CC BY 4.0';
  assert.equal(MEME_NOTICE, NOTICE);
  assert.equal(readData().notice, NOTICE);
  const terms = readFileSync(new URL('../../../apps/player-web/src/legal/terms.html', import.meta.url), 'utf8');
  const lines = terms.split('\n').filter((line) => line.includes('chinese-meme-dict'));
  assert.equal(lines.length, 1, 'one line');
  assert.ok(lines[0]!.includes(NOTICE));
  assert.ok(lines[0]!.includes('href="https://github.com/re-skylar/chinese-meme-dict"'));
  assert.ok(
    !readFileSync(new URL('../../../apps/player-web/src/legal/privacy.html', import.meta.url), 'utf8').includes(
      'chinese-meme-dict',
    ),
  );
});

// ---- 2. matching ------------------------------------------------------------------------------------------------------------------

test('matching: the longest term wins and claims its stretch (GLM-4.5 hides GLM-4); no match, no hit', () => {
  const hits = matchMemes(['昨天试了GLM-4.5，真不错'], NONE, KNOW);
  assert.deepEqual(
    hits.map((hit) => hit.term),
    ['GLM-4.5'],
  );
  assert.ok(memeEntry('GLM-4'), 'the shorter entry exists, and is still found where it stands alone');
  assert.deepEqual(
    matchMemes(['换成GLM-4吧'], NONE, KNOW).map((hit) => hit.term),
    ['GLM-4'],
  );
  assert.deepEqual(matchMemes(['在吗，今天吃什么'], NONE, KNOW), []);
  assert.deepEqual(matchMemes([], NONE, KNOW), []);
  assert.deepEqual(matchMemes(['润'], NONE, KNOW), [], 'a single character is never a meme');
  assert.deepEqual(
    matchMemes(['润了润了'], NONE, KNOW).map((hit) => hit.term),
    ['润了'],
    'the two-character entry is',
  );
});

test('matching: at most 3 entries, longest first (then code order), the latest message first, each entry once', () => {
  const text = '嘴替 搭子 摆烂 松弛感 美拉德';
  assert.equal(MEME_HITS_MAX, 3);
  assert.deepEqual(
    matchMemes([text], NONE, KNOW).map((h) => h.term),
    ['松弛感', '美拉德', '嘴替'],
  );
  assert.deepEqual(
    matchMemes(['摆烂', '松弛感 美拉德'], NONE, KNOW).map((h) => h.term),
    ['摆烂', '松弛感', '美拉德'],
  );
  assert.deepEqual(
    matchMemes(['松弛感', '松弛感 摆烂'], NONE, KNOW).map((h) => h.term),
    ['松弛感', '摆烂'],
  );
  assert.deepEqual(matchMemes([text], NONE, KNOW, 99).length, 5);
  // identical input, identical output
  assert.deepEqual(matchMemes([text], NONE, KNOW), matchMemes([text], NONE, KNOW));
});

test('matching: a switched-off entry is never found; an ASCII term must not touch another ASCII letter; case and width are folded', () => {
  assert.deepEqual(matchMemes(['这个松弛感绝了'], new Set(['松弛感']), KNOW), []);
  assert.deepEqual(
    matchMemes(['这个松弛感绝了'], NONE, KNOW).map((h) => h.term),
    ['松弛感'],
  );
  assert.deepEqual(matchMemes(['xMCPx'], NONE, KNOW), []);
  assert.deepEqual(
    matchMemes(['用mcp做'], NONE, KNOW).map((h) => h.term),
    ['MCP'],
  );
  assert.deepEqual(
    matchMemes(['用ＭＣＰ做'], NONE, KNOW).map((h) => h.term),
    ['MCP'],
  );
});

test('levels: 会用 / 只懂 / 不碰 each reach the prompt with their own rule; an entry override beats the default', () => {
  const use = { level: 'know' as const, overrides: { 松弛感: 'use' as const, 摆烂: 'avoid' as const } };
  const hits = matchMemes(['松弛感 摆烂 美拉德'], NONE, use);
  assert.deepEqual(
    hits.map((h) => [h.term, h.level]),
    [
      ['松弛感', 'use'],
      ['美拉德', 'know'],
      ['摆烂', 'avoid'],
    ],
  );
  const block = memesBlock(hits);
  assert.ok(block.startsWith(MEMES_HEAD));
  assert.match(block, /「松弛感」：.*（会用：你听得懂，也可以在自然、符合你性格的时候自己用一下）/);
  assert.match(block, /「美拉德」：.*（只懂：你听得懂，但你自己从不使用它）/);
  assert.match(block, /「摆烂」：.*（不碰：.*你自己不用，也不跟着玩，用你自己的话正常回应）/);
  assert.equal(memesBlock(undefined), '');
  assert.equal(memesBlock([]), '');
  assert.deepEqual(MEME_LEVELS, ['use', 'know', 'avoid']);
  assert.equal(MEME_LEVEL_DEFAULT, 'know');
});

test('a character with no setting: default 只懂; the settings round-trip through the template and leave no key at the default', () => {
  assert.deepEqual(readMemeUse({}), { level: 'know', overrides: {} });
  const base = { authorCanon: { kind: 'author_canon', settings: { speechStyle: '短句' } } };
  const set = writeMemeUse(base, { level: 'use', overrides: { 摆烂: 'avoid' } });
  assert.deepEqual(readMemeUse(set), { level: 'use', overrides: { 摆烂: 'avoid' } });
  assert.equal((base.authorCanon.settings as Record<string, unknown>).memeLevel, undefined, 'never mutates');
  const back = writeMemeUse(set, { level: 'know', overrides: {} });
  assert.deepEqual(back, base, 'the default and no overrides leave no key');
  assert.deepEqual(withoutMemeUse(set).authorCanon.settings, { speechStyle: '短句' });
  assert.equal(withoutMemeUse(base), base, 'nothing to remove: the very same object');
  assert.throws(() => writeMemeUse(base, { level: 'x' as never, overrides: {} }), MemeUseError);
  assert.throws(
    () =>
      writeMemeUse(base, {
        level: 'use',
        overrides: Object.fromEntries(Array.from({ length: MEME_OVERRIDES_MAX + 1 }, (_, i) => [`词${i}`, 'use'])),
      }),
    MemeUseError,
  );
  // the template validation takes the two keys and refuses a bad level
  const template = (settings: Record<string, unknown>) => ({
    ...textRequest().character,
    authorCanon: { kind: 'author_canon', settings },
  });
  assert.ok(validatedTemplate(template({ memeLevel: 'use', memeOverrides: { 摆烂: 'avoid' } })));
  assert.throws(() => validatedTemplate(template({ memeLevel: 'loud' })));
  assert.throws(() => validatedTemplate(template({ memeOverrides: { 摆烂: 'loud' } })));
});

// ---- 3. the writer ----------------------------------------------------------------------------------------------------------------

const CANON = {
  kind: 'author_canon',
  settings: {
    speechStyle: '短句，爱用叠词',
    dialogueStyle: '一次一两句',
    dialogueExamples: [
      { situation: '日常聊天', player: '在吗', reply: ['在呀'] },
      { situation: '调侃', player: '你好笨', reply: ['你才笨'] },
    ],
    interests: ['做饭'],
  },
};
const v7Request = () => {
  const base = textRequest();
  return { ...base, character: { ...base.character, authorCanon: CANON } } as TextGenerationRequest;
};
const v8Request = (over: Partial<TextGenerationRequest> = {}) => {
  const { relationship: _drop, ...rest } = v7Request();
  return { ...rest, writer: 'v8', ...over } as TextGenerationRequest;
};
const profileRequest = (over: Partial<TextGenerationRequest> = {}) => v8Request({ writerProfile: true, ...over });
const memesRequest = (over: Partial<TextGenerationRequest> = {}) => profileRequest({ writerMemes: true, ...over });
const latest = (text: string) => ({ messages: [{ ...textRequest().messages[0]!, text }] });

// NAMED EXCEPTION (Part 58): the v8 hashes and digests below (新, 新+档案: prompt text, guard, policy, pins) moved on purpose; every 旧 (v7) hash is
// unchanged.
test('旧, 新 and 新+档案 are byte-identical to main before this Part (hashes taken on main, 2026-11-21)', () => {
  const v8 = v8Request();
  // 旧 and 新: the same pins as Part 37b asserted (v7 prompt, 新 system+user, the three addenda, the guard, the pins).
  assert.equal(sha(promptMessages(v7Request())), '275253132d301adbf8d888c972c6dc26953ce8bedb497d0bdb5deeda2003214f');
  assert.equal(sha(writerDraftMessages(v8)), 'a30891bf285bebe2527816467633506fe257f35795918c2b0d410b134cd484ee');
  assert.equal(
    sha(
      writerGuardMessages(v8, {
        mode: 'casual',
        bubbles: [{ text: 'x', expression: 'neutral' }],
        endsSession: false,
        markups: [null],
      } as never),
    ),
    'b2c1a879658e5ade5430297ec8e39e4b4256b9b1776eca1de48c4c69627bb65b',
  );
  assert.equal(writerPolicyHash('{"a":1}'), 'b11e2dcf6d54fc7ce82424192d35de096948922e42e2fc89ff6ec7ab6f910165');
  assert.deepEqual(writerPins(), {
    protocolDigest: '3b5c190d0233d0eeb208cb26d593a4f1fd0f15ad16a8a58d384643a4e93d9f03',
    promptDigest: '6cb2cf4724c335db073cf156eeacddfbfcce0fa5622e46e44a2cd6eb6cf1b20f',
  });
  // 新+档案: hashes taken on origin/main before this Part.
  const p = profileRequest(latest('哈哈哈你这人也太会了吧'));
  assert.equal(
    sha(writerDraftMessages(p, 'deepseek')),
    '3a1e5f99c89d51e28d54f7eb02b6088a49cd029655be275be2cbd8685b119adb',
  );
  assert.equal(sha(writerDraftMessages(p)), 'ea26956c89bcf971095597cc500f0f8146942ce12a04a0bbdb2ac1f6cf6a5ddb');
  assert.equal(
    sha(
      writerGuardMessages(p, {
        mode: 'casual',
        bubbles: [{ text: 'x', expression: 'neutral' }],
        endsSession: false,
        markups: [null],
      } as never),
    ),
    '51457e23d7c08d77742ff6f5898d9cbda37b9dd4e6cd361b05d14e9c82234790',
  );
  assert.equal(writerPolicyHash('{"a":1}', true), '0276b2c1bfc8ec3713bfbafcdacd1bce07bb9e9efa1b132612635de23d834e37');
  assert.deepEqual(writerPins(true), {
    protocolDigest: '3b5c190d0233d0eeb208cb26d593a4f1fd0f15ad16a8a58d384643a4e93d9f03',
    promptDigest: 'bce0512775bf7c0d265103d0b9f0798a22f6ac4eb8e8b01c533aeca03566426a',
  });
  assert.equal(writerProfileHash(), WRITER_PROFILE_SHA256);
});

test('新+档案+梗 has its own pins, and only it: the meme words, the matching and the selection rules', () => {
  assert.equal(writerMemesHash(), WRITER_MEMES_SHA256);
  assert.notEqual(writerPolicyHash('{"a":1}', true, true), writerPolicyHash('{"a":1}', true));
  assert.notEqual(writerPins(true, true).promptDigest, writerPins(true).promptDigest);
  assert.equal(writerPins(true, true).protocolDigest, writerPins().protocolDigest);
  // asking for the meme pin without it changes nothing for the other three
  assert.equal(writerPolicyHash('{"a":1}', true, false), writerPolicyHash('{"a":1}', true));
});

test('新+档案+梗: with nothing matched it IS 新+档案; a match adds one block after the examples, nothing before them moves', () => {
  const none = memesRequest(latest('哈哈哈你这人也太会了吧'));
  const profile = profileRequest(latest('哈哈哈你这人也太会了吧'));
  assert.deepEqual(writerDraftMessages(none, 'deepseek'), writerDraftMessages(profile, 'deepseek'));
  const hits = matchMemes(['你这个松弛感也太绝了'], NONE, { level: 'use', overrides: {} });
  const withHits = memesRequest({ ...latest('你这个松弛感也太绝了'), memeHits: hits });
  const base = writerDraftMessages(profileRequest(latest('你这个松弛感也太绝了')), 'deepseek')[0]!.content;
  const text = writerDraftMessages(withHits, 'deepseek')[0]!.content;
  assert.ok(text.startsWith(base), 'everything stable, and the picked examples, are exactly what 新+档案 sends');
  assert.equal(text.slice(base.length), `\n\n${memesBlock(hits)}`);
  assert.ok(text.endsWith('）'));
  // the user message (the context) does not change
  assert.equal(
    writerDraftMessages(withHits)[1]!.content,
    writerDraftMessages(profileRequest(latest('你这个松弛感也太绝了')))[1]!.content,
  );
  assert.deepEqual(writerDraftMessages(withHits), writerDraftMessages(withHits));
  // the flags are refused in any other combination
  const { writerProfile: _p, ...noProfile } = memesRequest();
  assert.throws(() => writerDraftMessages(noProfile as TextGenerationRequest), /WRITER_V8_REQUIRED/);
  assert.throws(() => writerDraftMessages(v8Request({ memeHits: hits })), /WRITER_V8_REQUIRED/);
});

test('the writer-setting contract has four choices; a request of 旧, 新 or 新+档案 never carries a meme key', () => {
  assert.deepEqual(WRITER_CHOICES, ['v7', 'v8', 'v8p', 'v8m']);
  for (const choice of WRITER_CHOICES) assert.ok(isWriterChoice(choice));
  assert.ok(!isWriterChoice('v8x'));
  const frozen = {
    template: v8Request().character,
    baseAt: Date.parse('2026-09-09T12:00:00+08:00'),
    memeOff: ['摆烂'],
  } as never;
  const turn = ['松弛感真好'];
  for (const column of ['deepseek', 'deepseek-v8', 'deepseek-v8p']) {
    const request = rehearsalRequest(frozen, 'run', column, 1, turn, []);
    assert.equal(request.writerMemes, undefined, column);
    assert.equal(request.memeHits, undefined, column);
    // and the request does not depend on anything a 梗 column reads
    assert.deepEqual(
      request,
      rehearsalRequest({ ...(frozen as object), memeOff: [] } as never, 'run', column, 1, turn, []),
    );
  }
  const memes = rehearsalRequest(frozen, 'run', 'deepseek-v8m', 1, turn, []);
  assert.equal(memes.writer, 'v8');
  assert.equal(memes.writerProfile, true);
  assert.equal(memes.writerMemes, true);
  assert.deepEqual(
    memes.memeHits?.map((h) => [h.term, h.level]),
    [['松弛感', 'know']],
  );
});

test('多轮预演 columns: 新+档案+梗 is the fourth of each model; the older keys and parses are unchanged', () => {
  assert.equal(rehearsalColumnKey('deepseek', 'v8', true, true), 'deepseek-v8m');
  assert.deepEqual(parseRehearsalColumn('deepseek-v8m'), {
    model: 'deepseek',
    writer: 'v8',
    profile: true,
    memes: true,
  });
  assert.equal(rehearsalColumnLabel('deepseek-v8m').split('·')[1], '新+档案+梗');
  assert.ok(isRehearsalModels(['deepseek', 'deepseek-v8', 'deepseek-v8p', 'deepseek-v8m']));
  assert.equal(REHEARSAL_COLUMN_KEYS.length, 12);
  assert.deepEqual(REHEARSAL_COLUMN_KEYS.slice(0, 4), ['deepseek', 'deepseek-v8', 'deepseek-v8p', 'deepseek-v8m']);
  assert.equal(parseRehearsalColumn('deepseek-v8m2'), null);
});

test('the four 网络梗 scripts: six turns each, every turn holds at least one entry, a run of one gives the same counts every time', () => {
  assert.equal(REHEARSAL_NET_SETS.length, 4);
  for (const set of REHEARSAL_NET_SETS) {
    const turns = builtinSet(set);
    assert.equal(turns.length, 6, set);
    for (const turn of turns) assert.ok(matchMemes([turn], DEFAULT_OFF, KNOW).length >= 1, `${set}: ${turn}`);
  }
  assert.deepEqual(
    REHEARSAL_NET_SETS.map((set) => builtinSet(set).map((turn) => matchMemes([turn], DEFAULT_OFF, KNOW).length)),
    REHEARSAL_NET_SETS.map((set) => builtinSet(set).map((turn) => matchMemes([turn], DEFAULT_OFF, KNOW).length)),
  );
});

// ---- 4. the cast: limits, size, selection -----------------------------------------------------------------------------------------

test('the new library limits: stories 600, inside jokes 300, groups 600; a document is limited in characters AND in UTF-8 bytes', () => {
  assert.equal(CAST_LIMITS.stories, 600);
  assert.equal(CAST_LIMITS.memes, 300);
  assert.equal(CAST_LIMITS.groups, 600);
  assert.equal(CAST_LIMITS.docMax, 640_000);
  assert.equal(CAST_LIMITS.docBytesMax, 1_900_000);
  assert.ok(CAST_LIMITS.docBytesMax < 2 * 1024 * 1024, 'under the 2 MiB value limit of a Durable Object');
  const doc = normalize(bigRaw({ stories: 600, memes: 300, groups: 600, detail: 400 }));
  assert.equal(doc.stories.length, 600);
  assert.equal(doc.memes.length, 300);
  assert.equal(doc.groups.length, 600);
  const json = canonicalCastJson(doc);
  assert.ok(json.length <= CAST_LIMITS.docMax && Buffer.byteLength(json) <= CAST_LIMITS.docBytesMax);
  assert.equal(castDocTooLarge(json), false);
  assert.throws(() => normalize(bigRaw({ stories: 601, memes: 0, groups: 0, detail: 10 })));
  assert.throws(() => normalize(bigRaw({ stories: 0, memes: 301, groups: 0, detail: 10 })));
  assert.throws(() => normalize(bigRaw({ stories: 0, memes: 0, groups: 601, detail: 10 })));
});

test('the byte limit binds before the character limit for 汉字 (3 bytes each): the stored document never exceeds 1,900,000 bytes', () => {
  const cjk = (n: number) => '汉'.repeat(n);
  const raw = (storiesWithDetails: number) => {
    const base = sampleCastRaw();
    base.stories = Array.from({ length: storiesWithDetails }, (_, i) => ({
      title: cjk(30),
      summary: cjk(600),
      details: cjk(2000),
      period: { start: '2026-01', end: '' },
      participants: ['c01'],
      boundary: cjk(100),
      overrides: [],
    })) as never;
    return base;
  };
  // 600K characters of 汉字 and JSON marks: under the character cap, so the byte cap is what is tested
  let small = 0;
  for (let n = 100; n <= 600; n += 10) {
    let doc;
    try {
      doc = normalize(raw(n));
    } catch {
      break;
    }
    small = n;
    assert.ok(Buffer.byteLength(canonicalCastJson(doc)) <= CAST_LIMITS.docBytesMax, `${n} stories`);
  }
  assert.ok(small >= 200, `a large 汉字 document is accepted (${small} full stories)`);
  const refusedAt = small + 10;
  assert.throws(() => normalize(raw(refusedAt)), 'one more full story is refused');
  const worst = canonicalCastJson(normalize(raw(small)));
  assert.ok(Buffer.byteLength(worst) > 1_500_000 && Buffer.byteLength(worst) <= CAST_LIMITS.docBytesMax);
  // a document under the character cap but over the byte cap is refused on its own
  const json = '汉'.repeat(CAST_LIMITS.docMax - 10);
  assert.ok(json.length <= CAST_LIMITS.docMax);
  assert.equal(castDocTooLarge(json), true, '639,990 汉字 = 1,919,970 bytes');
  assert.equal(castDocTooLarge('汉'.repeat(600_000)), false, '1,800,000 bytes');
});

const messages = (...texts: string[]) => texts;
const jsonSize = (value: unknown) => JSON.stringify(value).length;
const itemsSize = (view: ReturnType<typeof selectCastView>) =>
  jsonSize(view.stories) + jsonSize(view.memes) + jsonSize(view.groups);

test('cast selection: only what the recent messages make relevant, plus the always-on stories; the same input, the same view', () => {
  const doc = sampleCast();
  const full = compileFullView(doc, 'c01');
  assert.ok(full.stories.length >= 3 && full.memes.length >= 1);
  // nothing mentioned, no trigger: the always-on stories only (c01 lived 雨夜的告白, 校庆演出 and 天台的约定)
  const quiet = selectCastView(full, messages('在吗，今天吃什么'));
  assert.equal(quiet.memes.length, 0);
  assert.ok(quiet.stories.length > 0 && quiet.stories.length <= CAST_ALWAYS_ON);
  // a name: the stories and inside jokes with that person
  const named = selectCastView(full, messages('你和陈阿杰最近怎么样'));
  assert.ok(named.stories.some((s) => s.title === '雨夜的告白'));
  assert.ok(named.memes.some((m) => m.key === '落汤鸡'));
  // a trigger word of an inside joke (「下雨或有人没带伞时」 -> 下雨 / 带伞), with nobody mentioned
  const rain = selectCastView(full, messages('今天下雨了'));
  assert.ok(rain.memes.some((m) => m.key === '落汤鸡'));
  // a story title word
  assert.ok(selectCastView(full, messages('还记得校庆吗')).stories.some((s) => s.title === '校庆演出'));
  // identical input, identical bytes; document order is kept
  const a = JSON.stringify(selectCastView(full, messages('今天下雨了', '你和陈阿杰最近怎么样')));
  assert.equal(a, JSON.stringify(selectCastView(full, messages('今天下雨了', '你和陈阿杰最近怎么样'))));
  const ordered = selectCastView(full, messages('你和陈阿杰最近怎么样', '今天下雨了')).stories.map((s) => s.title);
  assert.deepEqual(
    ordered,
    full.stories.map((s) => s.title).filter((title) => ordered.includes(title)),
  );
  // the name cards, 称呼 and the world are the fixed part, unchanged
  assert.deepEqual({ ...named, stories: [], groups: [], memes: [] }, { ...full, stories: [], groups: [], memes: [] });
});

test('cast selection at the new limits: 600 stories, 300 inside jokes, 600 groups; within the budget; deterministic; relevant only', () => {
  const doc = normalize(bigRaw({ stories: 600, memes: 300, groups: 600, detail: 400 }));
  const full = compileFullView(doc, 'c01');
  assert.ok(full.stories.length >= 60, `c01 knows ${full.stories.length} stories`);
  assert.ok(
    jsonSize(full.stories) > 10 * CAST_SELECT_BUDGET,
    'what the character knows is far over what a reply may carry',
  );
  const texts = messages('聊到火锅的时候你想起谁了', '你和周屿最近怎么样');
  const view = selectCastView(full, texts);
  assert.ok(
    itemsSize(view) <= CAST_SELECT_BUDGET + 200,
    `items ${itemsSize(view)} within the budget of ${CAST_SELECT_BUDGET}`,
  );
  assert.ok(jsonSize(view) <= CAST_LIMITS.viewMax, 'the whole view never passes the 24a cap');
  assert.equal(JSON.stringify(view), JSON.stringify(selectCastView(full, texts)));
  // every selected story / joke is the always-on kind or mentions someone named, or has a trigger word of the messages
  const picked = pickCastItems(full, messages('你和周屿最近怎么样'));
  assert.ok(picked.stories.size > CAST_ALWAYS_ON, 'relevant stories were found');
  for (const meme of view.memes) assert.ok(meme.parties.includes('周屿') || meme.trigger.includes('火锅'), meme.key);
  // a different message selects a different context
  assert.notEqual(JSON.stringify(view), JSON.stringify(selectCastView(full, messages('今天考试砸了'))));
  // no messages: the always-on only
  assert.ok(selectCastView(full, []).stories.length <= CAST_ALWAYS_ON);
  // a tiny budget is respected, an item that does not fit with its details is kept as its summary
  const tight = selectCastView(full, texts, 700);
  assert.ok(itemsSize(tight) <= 700 + 200);
  assert.ok(tight.stories.every((s) => s.summary !== ''));
  // the union of picks is the union of views (the pool of a rehearsal)
  const one = pickCastItems(full, messages('聊到火锅的时候'));
  const two = pickCastItems(full, messages('你和周屿最近怎么样'));
  const union = castViewOf(full, unionPicked(one, two));
  for (const story of selectCastView(full, messages('你和周屿最近怎么样')).stories)
    assert.ok(union.stories.some((s) => s.title === story.title));
  assert.equal(castViewOf(full, emptyPicked()).stories.length, 0);
});

test('request.cast of 新+档案+梗 is the selected view: the writer prints it exactly as 24a does', () => {
  const doc = sampleCast();
  const view = selectCastView(compileFullView(doc, 'c01'), messages('你和陈阿杰最近怎么样'));
  const cast = { version: 1, digest: 'a'.repeat(64), promptHash: 'b'.repeat(64), view };
  const request = memesRequest({ cast, ...latest('你和陈阿杰最近怎么样') });
  const user = JSON.parse(writerDraftMessages(request)[1]!.content) as { cast: { view: unknown } };
  assert.deepEqual(user.cast.view, view);
});

test('default-off: the shipped common words (jieba frequency >= 20, any length) never match until switched on; the counts follow', () => {
  const data = readData();
  assert.equal(data.defaultOff.minFreq, 20);
  assert.equal(data.defaultOff.source.commit, '67fa2e36e72f69d9134b8a1037b83fbb070b9775');
  assert.equal(data.defaultOff.count, 72);
  assert.equal(DEFAULT_OFF.size, 72);
  for (const term of ['优化', '偷懒', '冥想', '存款', '早市', '估值', '对齐']) assert.ok(DEFAULT_OFF.has(term), term);
  assert.ok(!DEFAULT_OFF.has('松弛感') && !DEFAULT_OFF.has('摆烂'));
  assert.deepEqual(matchMemes(['这个优化太离谱，存款没了'], DEFAULT_OFF, KNOW), []);
  assert.deepEqual(
    matchMemes(['这个优化太离谱'], new Set(), KNOW).map((h) => h.term),
    ['优化'],
    'switched on, it matches',
  );
  assert.deepEqual(
    matchMemes(['松弛感 优化'], DEFAULT_OFF, KNOW).map((h) => h.term),
    ['松弛感'],
  );
  // a 多轮预演 run freezes the effective off list: a default-off word is no hit, switched on it is
  const template = v8Request().character;
  const base = { template, baseAt: Date.parse('2026-09-09T12:00:00+08:00') };
  const off = rehearsalRequest(
    { ...base, memeOff: [...DEFAULT_OFF] } as never,
    'run',
    'deepseek-v8m',
    1,
    ['这个优化太离谱'],
    [],
  );
  const on = rehearsalRequest({ ...base, memeOff: [] } as never, 'run', 'deepseek-v8m', 1, ['这个优化太离谱'], []);
  assert.equal(off.memeHits, undefined);
  assert.deepEqual(
    on.memeHits?.map((h) => h.term),
    ['优化'],
  );
});
