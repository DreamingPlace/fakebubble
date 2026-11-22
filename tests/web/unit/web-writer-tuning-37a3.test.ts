import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import {
  WRITER_ADDENDA,
  WRITER_V8_PROMPT_SHA256,
  parseDraft,
  writerDraftMessages,
  writerGuardMessages,
  writerPromptBytesHash,
  writerPromptHash,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import { textRequest } from '../../text-fixtures.ts';

const v8 = (over: Partial<TextGenerationRequest> = {}): TextGenerationRequest => {
  const { relationship: _drop, ...base } = textRequest();
  return { ...base, writer: 'v8', ...over } as TextGenerationRequest;
};
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const V8_DIR = new URL('../../../prompts/v8/', import.meta.url);

test('37a-3 pins: every v8 file and the whole set are pinned, and the new pin is written in docs/STATUS.md', () => {
  // Named, deliberate change (Part 37a-3): v8 is not live, so these hashes moved; v7 did not.
  const pinned: Record<string, string> = {
    'cast-context.md': '533488c6a6e27c0fba1ecc01317e24f05d7f9ff6f856cbc8d3d45b2fd0daa42f',
    'guard.md': '41922f8c998c2a493f8996c28b1bae6fef86a6dbeb74862afe0043141100b1e4',
    'writer-addendum-deepseek.md': '4fa7b9f3497637f3c8ef30d48f69c2af551afa5a5a4a5e302fbf0ab4b105f359',
    'writer-addendum-gemini.md': 'd430a20548be34d725518d1e36bd166be1bd9669d3e0bd44db6bf45e50c601ea',
    'writer-addendum-grok.md': 'af2561424f21aafc8568f4d1b6d5800ca0d1c5fcc03b4dc77306627040bdb70f',
    'writer-directions.md': '1457f247f8cbb1d4bb60ffed958fd059d62b52cad20034a68b807bc86f3a6e00',
    'writer.md': '6014684fbe9eca8b1115bd3ddcb80ad1df10f4cf754d5987e0009581ec9044b9',
  };
  assert.deepEqual(readdirSync(V8_DIR).sort(), Object.keys(pinned).sort(), 'a new v8 file must be pinned here');
  for (const [file, hash] of Object.entries(pinned)) assert.equal(sha(readFileSync(new URL(file, V8_DIR))), hash, file);
  assert.equal(WRITER_V8_PROMPT_SHA256, 'e74f31060043b3e15af08a7222b78b82610ce628faaa81fc33ac6c1ecec1819e');
  assert.equal(writerPromptBytesHash(), WRITER_V8_PROMPT_SHA256);
  assert.equal(writerPromptHash(), 'b9a6a845235d85c5679270c3bf60a4b3cddc0b47f927a8b2ed5fb7c0a87d814a');
  const status = readFileSync(new URL('../../../docs/STATUS.md', import.meta.url), 'utf8');
  assert.ok(status.includes(WRITER_V8_PROMPT_SHA256), 'STATUS.md documents the pin');
  assert.ok(status.includes(writerPromptHash()), 'STATUS.md documents the request prompt hash');
  // v7 does not move.
  assert.equal(textPromptHash(), 'c5f8018e564754d8f1fd968388fd1b6c164d231e94dc5add9df67460292ab7fa');
});

test('37a-3 sizes: the rules and each addendum stay small', () => {
  assert.ok([...PROMPTS_V8.writer].length <= 4000);
  for (const text of Object.values(WRITER_ADDENDA)) assert.ok([...text].length <= 200);
});

test('37a-3 writer.md says the new things in plain words, and its hard lines are unchanged', () => {
  const text = PROMPTS_V8.writer;
  for (const phrase of [
    '常带点你自己的东西来聊',
    '情绪写在字里',
    '起个话题',
    '问句偶尔才用，多数回复不以问句收尾',
    '现编',
    '说忘了',
  ])
    assert.ok(text.includes(phrase), phrase);
  // The added section sits before the hard lines and adds no prohibition list to them.
  const [soft, hard] = text.split('只有这几条不能碰');
  assert.ok(soft!.includes('你自己的生活'));
  assert.equal(hard!.split('\n').filter((line) => line.startsWith('- ')).length, 5);
});

test('37a-3 addendum: chosen by the model that writes the draft; none without one; the guard never has one', () => {
  const request = v8();
  const system = (provider?: 'deepseek' | 'gemini' | 'xai') => writerDraftMessages(request, provider)[0]!.content;
  assert.ok(!Object.values(WRITER_ADDENDA).some((text) => system().includes(text)));
  for (const [provider, text] of Object.entries(WRITER_ADDENDA)) {
    const mine = system(provider as keyof typeof WRITER_ADDENDA);
    assert.ok(mine.includes(text), provider);
    for (const other of Object.values(WRITER_ADDENDA).filter((o) => o !== text)) assert.ok(!mine.includes(other));
    // after the shared rules, before the cast and the roster
    assert.ok(mine.indexOf(PROMPTS_V8.writer) < mine.indexOf(text));
    // the user message does not depend on the model
    assert.equal(
      writerDraftMessages(request, provider as keyof typeof WRITER_ADDENDA)[1]!.content,
      writerDraftMessages(request)[1]!.content,
    );
  }
  assert.throws(() => writerDraftMessages(request, 'openai' as never), { code: 'WRITER_V8_REQUIRED' });
  const draft = parseDraft({ text: '嗯' }, request) as WriterDraft;
  for (const text of Object.values(WRITER_ADDENDA))
    assert.ok(!writerGuardMessages(request, draft)[0]!.content.includes(text));
});

test('37a-3 addendum content follows the owner feedback, per model', () => {
  const { xai, gemini, deepseek } = WRITER_ADDENDA;
  assert.match(xai, /除非对方问了一个开放的问题，回复结尾不要带问句/);
  assert.match(xai, /至少有一句是你自己的/);
  assert.match(gemini, /多说说你自己的生活和近况/);
  assert.match(gemini, /最多一个问句/);
  assert.match(gemini, /不要放在第一句话之后/);
  assert.match(deepseek, /生动/);
  assert.match(deepseek, /用词和节奏/);
});
