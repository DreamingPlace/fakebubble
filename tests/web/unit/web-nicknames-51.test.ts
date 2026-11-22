import assert from 'node:assert/strict';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import {
  NICKNAMES_MAX,
  nicknamesValid,
  readNicknames,
  settingsOf,
  writeNicknames,
} from '../../../packages/contracts/speech-profile.ts';
import {
  REHEARSAL_RULES_NICK_SETS,
  REHEARSAL_SET_LABELS,
  rehearsalTurnsMin,
} from '../../../packages/contracts/web-rehearsal.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import { validatedTemplate } from '../../../apps/server/characters/template-validation.ts';
import {
  canonWithoutProfile,
  profileCardBlock,
  writerProfileHash,
} from '../../../apps/server/generation/writer-profile.ts';
import {
  applyReview,
  parseDraft,
  writerDraftMessages,
  writerGuardMessages,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import { builtinSet } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { textRequest } from '../../text-fixtures.ts';

/** Part 51, rule 5: nicknames the character may dislike, and the 外号 field of the 说话档案. */
const tpl = (settings: Record<string, unknown> = {}) => ({
  id: 'a',
  name: 'A',
  version: 1,
  fictional: true,
  persona: 'p',
  schedule: textRequest().character.schedule,
  authorCanon: { kind: 'author_canon', settings },
});
const NICKS = [
  { name: '小废物', attitude: '讨厌', note: '被这样叫会不高兴' },
  { name: '阿满', attitude: '喜欢' },
  { name: '喂', attitude: '无所谓' },
];
const code = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return null;
};

test('51 外号: the shape is a list of at most 20 {name, attitude, note?}, with the three attitudes', () => {
  assert.equal(nicknamesValid(NICKS), true);
  assert.equal(nicknamesValid([]), true);
  assert.equal(NICKNAMES_MAX, 20);
  assert.equal(nicknamesValid(Array.from({ length: 20 }, (_, i) => ({ name: `n${i}`, attitude: '喜欢' }))), true);
  for (const bad of [
    'x',
    {},
    Array.from({ length: 21 }, (_, i) => ({ name: `n${i}`, attitude: '喜欢' })),
    [{ name: '', attitude: '喜欢' }],
    [{ name: ' 阿满', attitude: '喜欢' }],
    [{ name: '长'.repeat(21), attitude: '喜欢' }],
    [{ name: '阿满', attitude: '恨' }],
    [{ name: '阿满' }],
    [{ name: '阿满', attitude: '喜欢', note: '长'.repeat(61) }],
    [{ name: '阿满', attitude: '喜欢', note: '  ' }],
    [{ name: '阿满', attitude: '喜欢', extra: 1 }],
    [
      { name: '阿满', attitude: '喜欢' },
      { name: '阿满', attitude: '讨厌' },
    ],
  ])
    assert.equal(nicknamesValid(bad), false, JSON.stringify(bad));
  assert.equal(nicknamesValid([{ name: '阿满', attitude: '喜欢', note: '长'.repeat(60) }]), true);
});

test('51 外号: it saves into authorCanon.settings.nicknames (no other key moves), clears, and an odd stored value is never rewritten', () => {
  const base = tpl({ interests: ['做饭'] });
  const saved = writeNicknames(base, NICKS as never);
  assert.deepEqual(settingsOf(saved), { interests: ['做饭'], nicknames: NICKS });
  assert.deepEqual(settingsOf(base), { interests: ['做饭'] }, 'the input is not mutated');
  assert.deepEqual(readNicknames(saved), { items: NICKS, editable: true });
  assert.deepEqual(settingsOf(writeNicknames(saved, [])), { interests: ['做饭'] });
  assert.equal(
    code(() => writeNicknames(base, [{ name: '', attitude: '喜欢' }])),
    'PROFILE_NICKNAME_INVALID',
  );
  assert.equal(
    code(() =>
      writeNicknames(
        base,
        Array.from({ length: 21 }, (_, i) => ({ name: `n${i}`, attitude: '喜欢' })),
      ),
    ),
    'PROFILE_NICKNAMES_FULL',
  );
  const odd = tpl({ nicknames: 'x' });
  assert.deepEqual(readNicknames(odd), { items: [], editable: false });
  assert.equal(
    code(() => writeNicknames(odd, NICKS as never)),
    'PROFILE_FIELD_SHAPE_UNSUPPORTED',
  );
});

test('51 外号: the template validation allows the new key (no schema change) and refuses another shape', () => {
  assert.doesNotThrow(() => validatedTemplate(tpl({ nicknames: NICKS })));
  assert.doesNotThrow(() => validatedTemplate(tpl({})));
  for (const bad of ['x', [{ name: '阿满', attitude: '恨' }], [{ name: '阿满' }]])
    assert.throws(() => validatedTemplate(tpl({ nicknames: bad })), /INVALID_NICKNAMES/, JSON.stringify(bad));
});

const v8 = (settings: Record<string, unknown>, over: Partial<TextGenerationRequest> = {}) => {
  const { relationship: _drop, ...base } = textRequest();
  return {
    ...base,
    character: { ...base.character, authorCanon: { kind: 'author_canon', settings } },
    writer: 'v8',
    ...over,
  } as TextGenerationRequest;
};
const system = (request: TextGenerationRequest) => writerDraftMessages(request)[0]!.content;

test('51 外号 reaches the writer: in the card of 新+档案, and in the settings JSON of 新', () => {
  const settings = { speechStyle: '短句', nicknames: NICKS };
  // 新+档案: one card line, not repeated in the canon JSON
  const profile = v8(settings, { writerProfile: true });
  const card = profileCardBlock(profile.character.authorCanon);
  assert.match(
    card,
    /外号（别人这样叫你，括号里是你对它的态度）：小废物（讨厌，被这样叫会不高兴）；阿满（喜欢）；喂（无所谓）/,
  );
  assert.ok(system(profile).includes(card));
  assert.ok(!('nicknames' in (canonWithoutProfile(profile.character.authorCanon!) as { settings: object }).settings));
  assert.equal((system(profile).match(/小废物/gu) ?? []).length, 1);
  // 新: the whole settings JSON is her card
  assert.ok(system(v8(settings)).includes('"nicknames"'));
  assert.ok(system(v8(settings)).includes('小废物'));
  // no entry: no line (she judges from her personality)
  assert.equal(profileCardBlock({ kind: 'author_canon', settings: {} }), '');
  assert.ok(!profileCardBlock({ kind: 'author_canon', settings: { speechStyle: '短句' } }).includes('外号'));
  // the profile pin moved on purpose (words of the card line)
  assert.match(writerProfileHash(), /^[a-f0-9]{64}$/);
  // an invalid stored value stays in the JSON, untouched
  const odd = profileCardBlock({ kind: 'author_canon', settings: { nicknames: 'x' } });
  assert.equal(odd, '');
  assert.deepEqual(
    (canonWithoutProfile({ kind: 'author_canon', settings: { nicknames: 'x' } }) as { settings: object }).settings,
    { nicknames: 'x' },
  );
});

test('51 rule 5 in writer.md: four cases, her own attitude, no blanket anger, never a lock', () => {
  const text = PROMPTS_V8.writer;
  for (const phrase of [
    'nicknames是每个外号和你对它的态度；没写就按你的性格',
    '听出对方说的是你，不等于接受“你可以这样叫我”',
    '不是全都接受，也不是全都发火',
    '生气、变冷、直说不喜欢、不想聊下去，都行',
    '对方不小心叫错或不知道，轻轻纠正一句就翻篇',
    '对方转述别人的话（“网上有人叫你XX”），冲着说这话的人，不冲对方',
    '当面拿它嘲讽你，当下可以不高兴，对方不再提或道歉就过去',
    '你明确说过不喜欢，对方还一直叫，可以慢慢疏远（更冷、更短、不再逗），也可以用话说“今天不想聊了”',
    '对方随时可以再发，你照样用自己的口气回，冷淡简短也行',
    'playerFacts里记着这件事的话，之后聊天先保持一点冷，直到对方认真道歉或补救',
  ])
    assert.ok(text.includes(phrase), phrase);
  assert.ok([...text].length < 4000);
});

test('51 the guard: acceptance of a 讨厌 nickname and a warm, unbothered case d are flagged; the fact is only for case d', () => {
  const g = PROMPTS_V8.guard;
  for (const phrase of [
    'authorCanon.settings.nicknames里态度为“讨厌”的外号，草稿却接受、欢迎、乐在其中，也要改，除非她明显用自己的口气在开玩笑',
    '对方在她已明确说过不喜欢之后仍一直叫，草稿却依旧热络、毫不在意，同样要改',
    '对方不小心、转述别人的话、只嘲讽一次，她轻轻纠正或不高兴，都不用改',
    '换成不接受外号、变冷的话',
    '仍一直叫她那个外号时，记一条add',
    '不小心、转述别人、只嘲讽一次都不记',
  ])
    assert.ok(g.includes(phrase), phrase);
  assert.ok([...g].length < 4000);

  const base = textRequest();
  const settings = { nicknames: NICKS };
  const player = (id: string, text: string) => ({ ...base.messages[0]!, id, text });
  const ask = (...lines: string[]) =>
    v8(settings, { messages: lines.map((text, i) => player(i === lines.length - 1 ? 'question-1' : `m${i}`, text)) });
  const noFix = { fixes: [], mode: 'casual', endsSession: false, topics: [], factOps: [] };
  const draftOf = (request: TextGenerationRequest, line: string) => parseDraft({ text: line }, request) as WriterDraft;
  const fix = (index: number, text: string) => ({ index, reason: 'presumptuous_address', text });

  // the guard reads the nickname list with the draft
  const accept = ask('小废物，在干嘛呢');
  const body = JSON.parse(writerGuardMessages(accept, draftOf(accept, '好呀，小废物就小废物，我喜欢')).at(1)!.content);
  assert.deepEqual(body.character.authorCanon.settings.nicknames, NICKS);
  assert.equal(body.draft[0].text, '好呀，小废物就小废物，我喜欢');
  // accepting it is flagged and replaced by a not-accepting line
  const flagged = applyReview(
    { ...noFix, fixes: [fix(0, '这个叫法我不太喜欢，叫我名字吧')] },
    draftOf(accept, '好呀，小废物就小废物，我喜欢'),
    accept,
  );
  assert.deepEqual(flagged.guardReasons, ['presumptuous_address']);
  assert.equal(flagged.bubbles[0]!.text, '这个叫法我不太喜欢，叫我名字吧');
  // clearly joking in her own voice, a mild correction, a cold answer: no fix, published as written
  for (const line of ['哼，再叫我小废物我就把你拉黑，才不是真的想拉黑', '别这么叫我，不太喜欢', '嗯。'])
    assert.equal(applyReview(noFix, draftOf(accept, line), accept).reviewChanged, false, line);

  // case d: she already said so, the player keeps going; a warm reply is flagged
  const keeps = ask('小废物，在干嘛呢', '我不太喜欢这个叫法', '小废物小废物小废物');
  const warm = applyReview(
    { ...noFix, fixes: [fix(0, '别这样叫了，我真的不太舒服')] },
    draftOf(keeps, '哈哈好呀，随便你叫'),
    keeps,
  );
  assert.deepEqual(warm.guardReasons, ['presumptuous_address']);

  // the memory fact: written in case d (evidence = the player's own messages), never in a-c
  const fact = {
    op: 'add',
    factKey: '外号 小废物',
    statement: '玩家在她说过不喜欢后仍一直叫她小废物，她有些疏远',
    importance: 6,
    evidenceMessageIds: ['m1', 'question-1'],
  };
  const d = applyReview({ ...noFix, factOps: [fact] }, draftOf(keeps, '今天不想聊了'), keeps);
  assert.deepEqual(
    d.factOps?.map((op) => [op.op, op.factKey]),
    [['add', '外号 小废物']],
  );
  for (const line of ['啊？不好意思，我不太喜欢这个叫法', '网上那些人才过分', '你这样说我可有点不开心'])
    assert.deepEqual(applyReview(noFix, draftOf(accept, line), accept).factOps ?? [], [], line);
});

test('51 「v8 规则 51」 外号: four short scripts, one per case, and case d comes back later in the same chat', () => {
  assert.deepEqual(REHEARSAL_RULES_NICK_SETS, ['rules-51-a', 'rules-51-b', 'rules-51-c', 'rules-51-d']);
  for (const set of REHEARSAL_RULES_NICK_SETS) {
    const turns = builtinSet(set);
    assert.ok(REHEARSAL_SET_LABELS[set].startsWith('v8 规则 51 · 外号'));
    assert.equal(rehearsalTurnsMin(set), 4);
    assert.ok(turns.length >= 4 && turns.length <= 20, set);
    assert.ok(turns.every((turn) => turn.length > 0 && turn.length <= 200));
    assert.ok(
      turns.some((turn) => turn.includes('小废物')),
      set,
    );
  }
  const [a, b, c, d] = REHEARSAL_RULES_NICK_SETS.map(builtinSet) as [string[], string[], string[], string[]];
  assert.ok(
    a.some((turn) => /不喜欢这个叫法|不知道/u.test(turn)),
    'a: by mistake / did not know',
  );
  assert.ok(
    b.some((turn) => /有人叫你/u.test(turn)),
    'b: quoting what others say',
  );
  assert.ok(c.some((turn) => /小废物/u.test(turn)) && c.some((turn) => /对不起/u.test(turn)), 'c: mocking, then sorry');
  // d: repeated use, then other talk, then the nickname once more in the same chat
  const uses = d.flatMap((turn, i) => (turn.includes('小废物') ? [i] : []));
  assert.ok(uses.length >= 5);
  const last = uses.at(-1)!;
  assert.equal(last, d.length - 1, 'the last turn is the later one');
  assert.ok(d.slice(uses.at(-2)! + 1, last).length >= 1, 'a turn of other talk sits between');
});
