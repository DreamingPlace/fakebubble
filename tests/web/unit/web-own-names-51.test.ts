import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import {
  REHEARSAL_RULES_NAME_SETS,
  REHEARSAL_SET_LABELS,
  rehearsalTurnsMin,
} from '../../../packages/contracts/web-rehearsal.ts';
import { castDigest } from '../../../apps/server/cast/cast-store.ts';
import { normalizeCastDoc } from '../../../apps/server/cast/cast-validation.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import {
  applyReview,
  parseDraft,
  writerDraftMessages,
  writerGuardMessages,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import {
  listItems,
  mergeOwnNames,
  ownNamesFromProfile,
  writerOwnNames,
} from '../../../apps/server/generation/writer-own-names.ts';
import { builtinSet, ownNameTurns } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import { counterIds, sampleCastRaw } from '../fixtures/cast-sample.ts';
import { textRequest } from '../../text-fixtures.ts';

/** Part 51, rule 5: her own names (kind + attitude) reach the 新-family writer, and what she does when she is called by them. */
const CHARACTER = 'c01';
const alias = (text: string, kind: string, attitude: string, id: string) => ({ id, text, kind, attitude });

/** A store with a published cast file whose character `c01` has the given aliases. NOT CAST_CONTEXT_ENABLED: that switch is never set. */
function storeWith(t: test.TestContext, aliases: ReturnType<typeof alias>[]) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.exec('CREATE TABLE web_input_snapshots (id TEXT)');
  store.db.exec(readFileSync(new URL('../../../apps/server/web-migrations/129_cast.sql', import.meta.url), 'utf8'));
  const doc = normalizeCastDoc(JSON.parse(JSON.stringify(sampleCastRaw())), { known: new Set(), fresh: counterIds() });
  doc.characters.find((c) => c.characterId === CHARACTER)!.identity.aliases = aliases as never;
  const json = JSON.stringify(doc);
  store.run("INSERT INTO web_cast_publications VALUES (1,?,?,0,'publish',NULL)", json, castDigest(json));
  return store;
}
const template = (settings: Record<string, unknown> = {}) => ({
  name: '测试角色',
  authorCanon: { kind: 'author_canon', settings },
});

test('51 names: the profile settings give 饰演过的角色 (a list) and the older name keys, each with a default attitude', () => {
  assert.deepEqual(listItems('「白雪」「小红帽」'), ['白雪', '小红帽']);
  assert.deepEqual(listItems('白雪、小红帽，灰姑娘'), ['白雪', '小红帽', '灰姑娘']);
  const names = ownNamesFromProfile(
    template({
      profileFacts: { 饰演过的角色: '「白雪」「小红帽」', 性别: '女' },
      selfIdentity: { names: ['测试角色', '阿测'] },
      aliases: ['小测', { text: '测测', kind: '中性称呼', attitude: 'dislikes' }, { text: '', kind: '别名' }],
    }),
  );
  assert.deepEqual(names, [
    { text: '阿测', kind: '别名', attitude: 'likes' },
    { text: '小测', kind: '别名', attitude: 'likes' },
    { text: '测测', kind: '中性称呼', attitude: 'dislikes' },
    { text: '白雪', kind: '饰演过的角色', attitude: 'ok' },
    { text: '小红帽', kind: '饰演过的角色', attitude: 'ok' },
  ]);
  assert.deepEqual(ownNamesFromProfile(template({})), []);
  assert.deepEqual(ownNamesFromProfile({ name: 'x' }), []);
  assert.deepEqual(ownNamesFromProfile(template({ profileFacts: { 饰演过的角色: '长'.repeat(26) } })), []);
});

test('51 names: the cast file wins on a conflict, and the rest of the profile names stay', () => {
  const merged = mergeOwnNames(
    [
      { text: '小废物', kind: '别名', attitude: 'likes' },
      { text: '白雪', kind: '饰演过的角色', attitude: 'ok' },
    ],
    [{ text: '小废物', kind: '黑称', attitude: 'dislikes' }],
  );
  assert.deepEqual(merged, [
    { text: '小废物', kind: '黑称', attitude: 'dislikes' },
    { text: '白雪', kind: '饰演过的角色', attitude: 'ok' },
  ]);
});

test('51 names: from the published cast file AND the profile settings, with CAST_CONTEXT_ENABLED never set; the cast wins', (t) => {
  const store = storeWith(t, [
    alias('阿测', 'other', 'likes', 'al1'),
    alias('小废物', 'insult', 'dislikes', 'al2'),
    alias('测测', 'self', 'ok', 'al3'),
  ]);
  const names = writerOwnNames(
    store,
    CHARACTER,
    template({
      profileFacts: { 饰演过的角色: '「白雪」' },
      aliases: [{ text: '小废物', kind: '别名', attitude: 'likes' }],
    }),
  );
  assert.deepEqual(names, [
    { text: '阿测', kind: '别名', attitude: 'likes' },
    { text: '小废物', kind: '黑称', attitude: 'dislikes' },
    { text: '测测', kind: '自称', attitude: 'ok' },
    { text: '白雪', kind: '饰演过的角色', attitude: 'ok' },
  ]);
  // another character's file is not this one's names; no cast file at all: only the profile
  assert.deepEqual(writerOwnNames(store, 'someone-else', template({ profileFacts: { 饰演过的角色: '「白雪」' } })), [
    { text: '白雪', kind: '饰演过的角色', attitude: 'ok' },
  ]);
  const bare = new Store(':memory:');
  t.after(() => bare.close());
  assert.deepEqual(writerOwnNames(bare, CHARACTER, template({})), []);
});

const v8 = (over: Partial<TextGenerationRequest> = {}) => {
  const { relationship: _drop, ...base } = textRequest();
  return { ...base, writer: 'v8', ...over } as TextGenerationRequest;
};
const NAMES = [
  { text: '阿测', kind: '别名', attitude: 'likes' },
  { text: '白雪', kind: '饰演过的角色', attitude: 'ok' },
  { text: '小废物', kind: '黑称', attitude: 'dislikes' },
] as const;

test('51 names reach the writer (all three 新 columns) and the guard, whatever the cast switch says; no names, no block', () => {
  const request = v8({ ownNames: [...NAMES] });
  assert.equal(request.cast, undefined, 'no cast context in this request');
  for (const profile of [false, true]) {
    const system = writerDraftMessages({ ...request, ...(profile ? { writerProfile: true } : {}) })[0]!.content;
    assert.ok(system.includes('你自己的名字和别人对你的叫法（ownNames'));
    assert.ok(system.includes(JSON.stringify(NAMES)), 'kind and attitude, as frozen');
    assert.ok(system.indexOf(PROMPTS_V8.writer) < system.indexOf('ownNames，JSON'));
  }
  const draft = parseDraft({ text: '嗯' }, request) as WriterDraft;
  assert.deepEqual(JSON.parse(writerGuardMessages(request, draft)[1]!.content).ownNames, NAMES);
  // none: exactly what it was
  assert.ok(!writerDraftMessages(v8())[0]!.content.includes('ownNames，JSON'));
  assert.ok(
    !('ownNames' in JSON.parse(writerGuardMessages(v8(), parseDraft({ text: '嗯' }, v8()) as WriterDraft)[1]!.content)),
  );
  // a bad entry is refused
  for (const bad of [
    [{ text: '', kind: '别名', attitude: 'ok' }],
    [{ text: 'x', kind: '外号', attitude: 'ok' }],
    [{ text: 'x', kind: '别名', attitude: 'hate' }],
  ])
    assert.throws(() => writerDraftMessages(v8({ ownNames: bad as never })), { code: 'INVALID_TEXT_REQUEST' });
});

test('51 rule 5 in writer.md: names by kind, a 黑称 is never accepted, four cases, never a lock', () => {
  const text = PROMPTS_V8.writer;
  for (const phrase of [
    'ownNames，每个有类型kind和你的态度attitude',
    '对方用自称、别名、中性称呼、粉丝昵称叫你，用你自己的口气自然接，中性或略带亲切',
    '态度是dislikes的，让对方看出你不喜欢',
    '对方叫你的黑称或明显带侮辱的名字，一定是明确的反感，绝不接受，也不顺着玩',
    '生气、变冷、讽刺、一句“别这么叫我”、不想聊下去，都行，别每个角色都一个样',
    '听出对方说的是你，不等于接受“你可以这样叫我”',
    '对方不小心或不知道，轻轻纠正一句就翻篇',
    '对方转述别人的话（“网上有人叫你XX”），冲着说这话的人，不冲对方',
    '当面拿它嘲讽你，当下可以不高兴，对方不再提或道歉就过去',
    '你明确说过不喜欢，对方还一直叫，可以慢慢疏远（更冷、更短、不再逗），也可以用话说“今天不想聊了”',
    '对方随时可以再发，你照样用自己的口气回，冷淡简短也行',
    'playerFacts里记着这件事的话，之后聊天先保持一点冷，直到对方认真道歉或补救',
  ])
    assert.ok(text.includes(phrase), phrase);
  assert.ok([...text].length < 4000);
});

test('51 the guard flags acceptance of a 黑称 (or a disliked name) and a warm, unbothered case d; the fact is only for case d', () => {
  const g = PROMPTS_V8.guard;
  for (const phrase of [
    'ownNames里kind为黑称、或attitude为dislikes的名字，草稿却接受、欢迎、乐在其中、顺着玩，也要改，除非她明显用自己的口气在开玩笑',
    '对方在她已明确说过不喜欢之后仍一直叫，草稿却依旧热络、毫不在意，同样要改',
    '对方不小心、转述别人的话、只嘲讽一次，她轻轻纠正或不高兴，都不用改',
    '换成不接受那个叫法、变冷的话',
    '仍一直叫她的黑称（或她不喜欢的名字）时，记一条add',
    '不小心、转述别人、只嘲讽一次都不记',
  ])
    assert.ok(g.includes(phrase), phrase);
  assert.ok([...g].length < 4000);

  const base = textRequest();
  const player = (id: string, text: string) => ({ ...base.messages[0]!, id, text });
  const ask = (...lines: string[]) =>
    v8({
      ownNames: [...NAMES],
      messages: lines.map((text, i) => player(i === lines.length - 1 ? 'question-1' : `m${i}`, text)),
    });
  const noFix = { fixes: [], mode: 'casual', endsSession: false, topics: [], factOps: [] };
  const draftOf = (request: TextGenerationRequest, line: string) => parseDraft({ text: line }, request) as WriterDraft;
  const fix = (text: string) => ({ index: 0, reason: 'presumptuous_address', text });

  const accept = ask('小废物，在干嘛呢');
  const line = '好呀，小废物就小废物，我喜欢';
  const flagged = applyReview(
    { ...noFix, fixes: [fix('这个叫法我不太喜欢，叫我名字吧')] },
    draftOf(accept, line),
    accept,
  );
  assert.deepEqual(flagged.guardReasons, ['presumptuous_address']);
  assert.equal(flagged.bubbles[0]!.text, '这个叫法我不太喜欢，叫我名字吧');
  // clearly joking in her own voice, a mild correction, a cold answer: the guard returns no fix and it publishes as written
  for (const ok of ['哼，再叫我小废物我就把你拉黑，才不是真的想拉黑', '别这么叫我，不太喜欢', '嗯。'])
    assert.equal(applyReview(noFix, draftOf(accept, ok), accept).reviewChanged, false, ok);

  // case d: she already said so, the player keeps going; a warm reply is flagged
  const keeps = ask('小废物，在干嘛呢', '我不太喜欢这个叫法', '小废物小废物小废物');
  const warm = applyReview(
    { ...noFix, fixes: [fix('别这样叫了，我真的不太舒服')] },
    draftOf(keeps, '哈哈好呀，随便你叫'),
    keeps,
  );
  assert.deepEqual(warm.guardReasons, ['presumptuous_address']);

  // the memory fact (evidence = the player's own messages) is written in case d, and in none of a, b, c
  const fact = {
    op: 'add',
    factKey: '叫法 小废物',
    statement: '玩家在她说过不喜欢后仍一直叫她小废物，她有些疏远',
    importance: 6,
    evidenceMessageIds: ['m1', 'question-1'],
  };
  const d = applyReview({ ...noFix, factOps: [fact] }, draftOf(keeps, '今天不想聊了'), keeps);
  assert.deepEqual(
    d.factOps?.map((op) => [op.op, op.factKey]),
    [['add', '叫法 小废物']],
  );
  for (const line of ['啊？不好意思，我不太喜欢这个叫法', '网上那些人才过分', '你这样说我可有点不开心'])
    assert.deepEqual(applyReview(noFix, draftOf(accept, line), accept).factOps ?? [], [], line);
});

test('51 「v8 规则 51」 names: one script per kind of name and per case, filled with HER names; case d comes back later', () => {
  assert.equal(REHEARSAL_RULES_NAME_SETS.length, 7);
  for (const set of REHEARSAL_RULES_NAME_SETS) {
    assert.ok(REHEARSAL_SET_LABELS[set].startsWith('v8 规则 51 · '));
    assert.equal(rehearsalTurnsMin(set), 4);
    const turns = builtinSet(set);
    assert.ok(turns.length >= 4 && turns.length <= 20, set);
    assert.ok(
      turns.some((turn) => /\{(别名|饰演|黑称)\}/u.test(turn)),
      `${set} has a mark`,
    );
  }
  // own names go in; without one, a stand-in that is not hers
  assert.deepEqual(builtinSet('rules-51-name-alias', NAMES).slice(1, 3), ['阿测，你在干嘛呢', '阿测今天心情怎么样']);
  assert.deepEqual(builtinSet('rules-51-name-role', NAMES).slice(1, 2), ['白雪，你在干嘛呢']);
  assert.deepEqual(builtinSet('rules-51-name-insult', NAMES).slice(1, 2), ['小废物，你在干嘛呢']);
  assert.deepEqual(ownNameTurns(['{别名}|{饰演}|{黑称}'], []), ['小可爱|那个角色|小废物']);
  assert.ok(builtinSet('rules-51-d', NAMES).every((turn) => !/\{/u.test(turn)));
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => builtinSet(`rules-51-${x}` as never, NAMES));
  assert.ok(
    a!.some((turn) => /不知道/u.test(turn)),
    'a: by mistake / did not know',
  );
  assert.ok(
    b!.some((turn) => /有人叫你/u.test(turn)),
    'b: quoting what others say',
  );
  assert.ok(
    c!.some((turn) => /对不起/u.test(turn)),
    'c: mocking, then sorry',
  );
  const uses = d!.flatMap((turn, i) => (turn.includes('小废物') ? [i] : []));
  assert.ok(uses.length >= 5);
  assert.equal(uses.at(-1), d!.length - 1, 'the last turn is the later one, in the same chat');
  assert.ok(d!.slice(uses.at(-2)! + 1, -1).length >= 1, 'a turn of other talk sits between');
});
