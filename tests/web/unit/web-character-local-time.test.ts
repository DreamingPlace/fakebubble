import assert from 'node:assert/strict';
import test from 'node:test';
import {
  promptMessages,
  reviewPromptMessages,
  TEXT_REVIEW_PROMPT,
  TEXT_SYSTEM_PROMPT,
} from '../../../apps/server/generation/accepted-text-prompt.ts';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { draftPresentation, textRequest } from '../../text-fixtures.ts';

// Part 16: the model sees only the CHARACTER's clock, under that name; the UTC instant stays server-side.
test('draft and review messages carry characterLocalTime and never a UTC currentTime or the old field name', () => {
  const request = textRequest();
  const draft = draftPresentation(request) as TextDraft;
  const utc = new Date(request.now).toISOString();
  for (const messages of [promptMessages(request), reviewPromptMessages(request, draft)]) {
    const content = JSON.parse(messages[1]!.content) as Record<string, unknown>;
    assert.match(String(content.characterLocalTime), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.ok(!('currentTime' in content));
    assert.ok(!('currentLocalTime' in content));
    assert.ok(!messages[1]!.content.includes(utc), 'the UTC instant must not reach the model');
  }
});

test("both prompts say characterLocalTime is the character's clock and the player's time and sleep are unknown", () => {
  for (const prompt of [TEXT_SYSTEM_PROMPT, TEXT_REVIEW_PROMPT]) {
    assert.ok(prompt.includes('characterLocalTime'));
    assert.ok(!prompt.includes('currentLocalTime') && !prompt.includes('currentTime'));
    assert.match(prompt, /玩家那边的时间、时区和睡没睡都未知/);
    assert.match(prompt, /我记着的/);
    assert.match(prompt, /湖人今晚是真的顶/);
  }
  assert.match(TEXT_REVIEW_PROMPT, /假定玩家的时间或睡眠状态/);
});
