import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import {
  TOKEN_LIST_PRICES,
  SPEECH_LIST_MICROS_PER_BYTE,
  listPriceMicros,
  speechListMicrosPerByte,
} from '../../../apps/server/generation/model-list-prices.ts';
import { formatUsageReport, usageReport, type UsageRow } from '../../../apps/server/generation/usage-report.ts';
import { readUsageRows } from '../../../scripts/usage-report.ts';
import { inspectWebAuthority } from '../../../apps/server/cloudflare/web-inspect.ts';
import { draftArgs, modelFixture, wire } from '../fixtures/model-choice.ts';

test('every known provider call lands in the aggregate table at LIST price; the report averages the real cost per reply per model', async (t) => {
  const f = modelFixture(t, {
    chosen: 'xai',
    fetch: (call, _n, request) =>
      call.provider === 'xai'
        ? Response.json(wire.xai(call.tool, draftArgs(request)))
        : Response.json(
            call.tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request),
          ),
  });
  await f.runText();
  await f.finishReply('operation');
  const rows = f.all<UsageRow>('SELECT * FROM web_provider_usage ORDER BY phase,provider').map((row) => ({ ...row }));
  assert.deepEqual(
    rows.map((row) => `${row.provider}:${row.model}:${row.phase}`),
    ['xai:grok-4.7:draft', 'deepseek:deepseek-v4-pro:review', 'fish:s2.1-pro:speech'],
  );
  assert.ok(rows.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day) && row.calls === 1));
  assert.deepEqual(Object.keys(rows[0]!).sort(), [
    'bytes',
    'cached_input_tokens',
    'calls',
    'cost_micros',
    'day',
    'input_tokens',
    'model',
    'output_tokens',
    'phase',
    'provider',
    'replies',
  ]);

  const [draft, review, speech] = rows as [UsageRow, UsageRow, UsageRow];
  assert.equal(
    draft.cost_micros,
    listPriceMicros('xai', 'grok-4.7', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 1000 }),
  );
  assert.equal(
    review.cost_micros,
    listPriceMicros('deepseek', 'deepseek-v4-pro', { inputTokens: 10, cachedInputTokens: 8, outputTokens: 5 }),
  );
  assert.equal(speech.cost_micros, speech.bytes * SPEECH_LIST_MICROS_PER_BYTE);
  assert.ok(speech.bytes > 0);

  const report = usageReport(rows);
  const xai = report.models.find((m) => m.model === 'xai')!;
  assert.equal(report.replies, 1);
  assert.equal(xai.replies, 1);
  assert.equal(xai.draftMicros, draft.cost_micros);
  assert.equal(xai.reviewMicros, review.cost_micros);
  assert.equal(xai.speechMicros, speech.cost_micros);
  assert.equal(xai.totalMicros, draft.cost_micros + review.cost_micros + speech.cost_micros);
  assert.equal(xai.points, 27, 'Part 21f: xAI is 25 points + 2 for voice (was 42 at 40 + 2)');
  assert.equal(
    report.models.find((m) => m.model === 'gemini')!.totalMicros,
    null,
    'a model with no replies yet has no average',
  );
  const text = formatUsageReport(rows);
  assert.match(text, /xai\s+1\s+\$/);
  // Part 21f (named exception): the table is version 2 and xAI is 25 points.
  assert.match(text, /Points table v2: deepseek 10, gemini 20, xai 25, voice \+2/);
  assert.doesNotMatch(text, /operation|principal|world/i, 'nothing but aggregates');

  // The same rows through the CLI readers: a local database, and the operator's inspect receipt.
  const dir = mkdtempSync(join(tmpdir(), 'usage-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'web.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    readFileSync(new URL('../../../apps/server/web-migrations/123_model_choice.sql', import.meta.url), 'utf8')
      .split('CREATE TABLE web_provider_usage')[1]!
      .replace(/^/, 'CREATE TABLE web_provider_usage'),
  );
  const insert = db.prepare('INSERT INTO web_provider_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows)
    insert.run(
      r.day,
      r.provider,
      r.model,
      r.phase,
      r.calls,
      r.input_tokens,
      r.cached_input_tokens,
      r.output_tokens,
      r.bytes,
      r.cost_micros,
      r.replies,
    );
  db.close();
  const key = (row: UsageRow) => `${row.provider}:${row.phase}`;
  assert.deepEqual(
    readUsageRows([`--database=${path}`])
      .map((row) => ({ ...row }))
      .sort((a, b) => key(a).localeCompare(key(b))),
    [...rows].sort((a, b) => key(a).localeCompare(key(b))),
  );

  const inspect = inspectWebAuthority(
    { all: <T>(sql: string, ...p: (string | number)[]) => f.store.all<T>(sql, ...p) },
    { active: 'inline', inline: [], r2: [] },
    {},
    [] as never,
  );
  assert.deepEqual(inspect.usage.rows.length, 3);
  const receipt = join(dir, 'inspect.jsonl');
  writeFileSync(
    receipt,
    JSON.stringify({ state: 'prepared', detail: null }) +
      '\n' +
      JSON.stringify({ state: 'completed', action: 'inspect', detail: inspect }) +
      '\n',
  );
  assert.equal(readUsageRows([`--receipt=${receipt}`]).length, 3);
  assert.throws(() => readUsageRows(['--receipt=relative/path']), /USAGE_REPORT_ABSOLUTE_PATH_REQUIRED/);
  assert.equal(
    TOKEN_LIST_PRICES['gemini:gemini-3.8-flash']!.output,
    7.5,
    'the 2027 list price, not the introductory one',
  );
});

test('usage:report costs a drama-3 reply at its LIST price (10 micros/byte) while the budget ledger holds and charges the 15 upper bound', async (t) => {
  const f = modelFixture(t, {
    siteVoiceModel: 'drama-3',
    fetch: (_call, _n, request) =>
      Response.json(_call.tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request)),
  });
  await f.runText();
  await f.finishReply('operation');
  const rows = f.all<UsageRow>("SELECT * FROM web_provider_usage WHERE phase='speech'").map((row) => ({ ...row }));
  assert.equal(rows.length, 1);
  const [speech] = rows as [UsageRow];
  assert.equal(speech.model, 'drama-3');
  assert.ok(speech.bytes > 0);
  assert.equal(speechListMicrosPerByte('drama-3'), 10);
  assert.equal(speech.cost_micros, speech.bytes * 10, 'list price: USD 10 per million bytes');
  const charged = f.all<{ model: string; charged_micros: number }>(
    "SELECT model,charged_micros FROM web_provider_attempts WHERE phase='speech'",
  );
  assert.deepEqual(
    charged.map((row) => [row.model, row.charged_micros]),
    [['drama-3', speech.bytes * 15]],
    'the ledger keeps the s2.1 upper bound',
  );
  // The report (what usage:report prints) attributes the voice cost of the reply to its model, at the list cost.
  const all = f.all<UsageRow>('SELECT * FROM web_provider_usage').map((row) => ({ ...row }));
  const model = usageReport(all).models.find((m) => m.model === 'deepseek')!;
  assert.equal(model.replies, 1);
  assert.equal(model.speechMicros, speech.bytes * 10);
  assert.equal(speechListMicrosPerByte('s2.1-pro'), SPEECH_LIST_MICROS_PER_BYTE);
  assert.equal(speechListMicrosPerByte('s2-pro'), 15, 'an unlisted speech model is costed at the dearer rate');
});
