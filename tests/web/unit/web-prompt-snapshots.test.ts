import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { promptMessages, reviewPromptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { promptSnapshotCases } from '../fixtures/prompt-snapshot-cases.ts';

const dir = new URL('../fixtures/prompt-snapshots/', import.meta.url);

// Regenerate only for an intended prompt change: UPDATE_PROMPT_SNAPSHOTS=1 node --test tests/web/unit/web-prompt-snapshots.test.ts
for (const item of promptSnapshotCases()) {
  test(`assembled prompt messages are byte-identical: ${item.name}`, () => {
    const actual = `${JSON.stringify(
      { draft: promptMessages(item.request), review: reviewPromptMessages(item.request, item.draft) },
      null,
      1,
    )}\n`;
    const file = new URL(`${item.name}.json`, dir);
    if (process.env.UPDATE_PROMPT_SNAPSHOTS === '1') writeFileSync(file, actual);
    assert.equal(actual, readFileSync(file, 'utf8'));
  });
}
