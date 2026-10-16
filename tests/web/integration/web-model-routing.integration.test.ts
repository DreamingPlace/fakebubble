import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { PLAYER_MODELS } from '../../../packages/contracts/player-models.ts';
import { TOKEN_LIST_PRICES } from '../../../apps/server/generation/model-list-prices.ts';
import { draftArgs, modelFixture, reviewArgs, wire, type FetchCall } from '../fixtures/model-choice.ts';

/**
 * Part 21b: the model that WRITES the reply (draft) is the player's frozen choice; the house reviewer (DeepSeek v4 pro, then
 * Gemini) always reviews. Provider answers below are recorded-shape fixtures derived from each provider's documentation
 * (docs/PROVIDERS.md), served through the real generator, runner, ledger and a mirror of the shared budget.
 */
const DRAFT = 'submit_dialogue_draft';
type Handler = (
  call: FetchCall,
  n: number,
  request: Parameters<Parameters<typeof modelFixture>[1]['fetch']>[2],
) => Response;

/** DeepSeek answers both stages; xAI/Gemini answer drafts with their own envelope. */
const answer =
  (
    draftOverride?: Partial<Record<'xai' | 'gemini' | 'deepseek', (call: FetchCall, request: never) => Response>>,
  ): Handler =>
  (call, _n, request) => {
    if (call.tool === DRAFT && draftOverride?.[call.provider])
      return draftOverride[call.provider]!(call, request as never);
    if (call.provider === 'xai') return Response.json(wire.xai(call.tool, draftArgs(request)));
    if (call.provider === 'gemini')
      return Response.json(wire.gemini(call.tool, call.tool === DRAFT ? draftArgs(request) : reviewArgs(request)));
    return Response.json(call.tool === DRAFT ? draftEnvelope(request) : acceptedAuditEnvelope(request));
  };

const providers = (calls: FetchCall[]) =>
  calls.map((call) => `${call.provider}:${call.tool === DRAFT ? 'draft' : 'review'}`);

test('xAI happy path: Grok drafts (reasoning low, reasoning tokens reserved and billed), the house reviewer reviews, one prompt for every provider', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', fetch: answer() });
  await f.runText();
  assert.deepEqual(providers(f.calls), ['xai:draft', 'deepseek:review']);
  const grok = f.calls[0]!;
  assert.equal(grok.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(grok.body.model, 'grok-4.7');
  assert.equal(grok.body.reasoning_effort, 'low');
  assert.equal(grok.body.max_completion_tokens, 4096 + 12_288, 'visible reply limit plus the reasoning headroom');
  assert.equal(grok.body.stream, false);
  assert.deepEqual(grok.body.tool_choice, { type: 'function', function: { name: DRAFT } });

  // The PROMPT TEXT and the output tool are identical for every provider: only the envelope differs.
  const reference = modelFixture(t, { chosen: 'deepseek', fetch: answer() });
  await reference.runText();
  assert.deepEqual(grok.body.messages, reference.calls[0]!.body.messages);
  assert.deepEqual(grok.body.tools, reference.calls[0]!.body.tools);
  assert.doesNotMatch(
    JSON.stringify(grok.body.messages),
    /grok|xai|gemini|deepseek/i,
    'the model name is never in a prompt',
  );

  const [draft, review] = f.attempts();
  assert.deepEqual(
    [draft!.phase, draft!.provider, draft!.model, draft!.state, draft!.outcome],
    ['draft', 'xai', 'grok-4.7', 'known', 'succeeded'],
  );
  assert.deepEqual([review!.provider, review!.model], ['deepseek', 'deepseek-v4-pro']);
  const bytes = Buffer.byteLength(JSON.stringify(grok.body), 'utf8');
  assert.equal(
    draft!.held_micros,
    6 * (bytes + 4096 + 12_288),
    'hold = list upper bound x (request bytes + visible + reasoning headroom)',
  );
  assert.equal(
    draft!.charged_micros,
    6 * 2000,
    'prompt 1000 + (completion 300 + reasoning 700) billed as output, at the upper price',
  );
  assert.equal(f.spending('xai').held_micros, 0);
  assert.equal(f.spending('xai').spent_micros, 12_000);
  assert.equal(f.status(), 'text_ready');
  assert.deepEqual(f.budget.calls, [
    'begin:draft:xai',
    'settle:draft:xai',
    'begin:review:deepseek',
    'settle:review:deepseek',
  ]);
  // E: the known call is recorded at LIST price in the aggregate table (no principal, no content).
  const usage = f.get<Record<string, number>>("SELECT * FROM web_provider_usage WHERE provider='xai'")!;
  assert.deepEqual(
    [usage.calls, usage.input_tokens, usage.cached_input_tokens, usage.output_tokens, usage.replies],
    [1, 1000, 400, 1000, 1],
  );
  const grokList = TOKEN_LIST_PRICES['xai:grok-4.7']!;
  assert.equal(
    usage.cost_micros,
    Math.ceil(600 * grokList.input + 400 * grokList.cachedInput + 1000 * grokList.output),
  );
  // B: what really wrote and reviewed the reply is stored on the operation.
  assert.deepEqual(
    [
      f.models()!.draft_provider,
      f.models()!.draft_model,
      f.models()!.review_provider,
      f.models()!.review_model,
      f.models()!.backup,
    ],
    ['xai', 'grok-4.7', 'deepseek', 'deepseek-v4-pro', 0],
  );
});

test('Gemini happy path: thinking kept low, schema rewritten for the OpenAI-compatible endpoint, thinking tokens billed as output', async (t) => {
  const f = modelFixture(t, { chosen: 'gemini', fetch: answer() });
  await f.runText();
  assert.deepEqual(providers(f.calls), ['gemini:draft', 'deepseek:review']);
  const body = f.calls[0]!.body;
  assert.equal(f.calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(body.model, 'gemini-3.8-flash');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, 4096 + 12_288);
  const schema = JSON.stringify(body.tools);
  assert.doesNotMatch(schema, /additionalProperties|"strict"|"type":\[/, 'only the OpenAPI subset Gemini accepts');
  const [draft] = f.attempts();
  assert.deepEqual([draft!.provider, draft!.model, draft!.outcome], ['gemini', 'gemini-3.8-flash', 'succeeded']);
  assert.equal(
    draft!.charged_micros,
    8 * (1200 + 900),
    'finish_reason "stop" with a forced call is accepted; output = total - prompt',
  );
  assert.equal(f.models()!.draft_provider, 'gemini');
});

test('schema slip: a draft that breaks our strict schema is a KNOWN billed failure on that model, never a backup', async (t) => {
  const f = modelFixture(t, {
    chosen: 'xai',
    fetch: answer({
      xai: (call, request) =>
        Response.json(wire.xai(call.tool, { ...draftArgs(request), surprise: 'x', mode: 'free_form' })),
    }),
  });
  await assert.rejects(f.runText());
  assert.deepEqual(
    providers(f.calls),
    ['xai:draft'],
    'the strict server-side validation decides; nothing is retried elsewhere',
  );
  const [draft] = f.attempts();
  assert.deepEqual([draft!.state, draft!.outcome], ['known', 'failed']);
  assert.equal(draft!.charged_micros, 12_000, 'the provider ran and billed it');
  assert.equal(f.backups().length, 0);
  assert.equal(
    f.status(),
    'failed',
    'a known failure ends the operation (its quota is released, the points are refunded)',
  );
});

test('HTTP 429 is definitely not billed: settled at zero, the stage retried ONCE on DeepSeek as a fresh attempt', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', fetch: answer({ xai: () => wire.error.xaiRateLimit() }) });
  await f.runText();
  assert.deepEqual(providers(f.calls), ['xai:draft', 'deepseek:draft', 'deepseek:review']);
  assert.deepEqual(
    f.backups().map((b) => [b.phase, b.generation, b.provider, b.model, b.code]),
    [['draft', 0, 'xai', 'grok-4.7', 'XAI_RATE_LIMITED']],
  );
  const draft = f.attempts().find((a) => a.phase === 'draft')!;
  assert.deepEqual([draft.provider, draft.state, draft.outcome], ['deepseek', 'known', 'succeeded']);
  assert.equal(f.spending('xai').held_micros, 0);
  assert.equal(f.spending('xai').spent_micros, 0, 'nothing was charged for the model that did not run');
  assert.deepEqual(f.budget.calls, [
    'begin:draft:xai',
    'settle:draft:xai',
    'begin:draft:deepseek',
    'settle:draft:deepseek',
    'begin:review:deepseek',
    'settle:review:deepseek',
  ]);
  assert.equal(
    [...f.budget.entries.values()].every((entry) => entry.settled),
    true,
    'every shared reservation is settled; none released',
  );
  assert.equal(f.models()!.backup, 1);
  assert.equal(f.models()!.draft_provider, 'deepseek');
  assert.equal(f.models()!.chosen, 'xai', 'the frozen choice is untouched');
});

test('a region / location error from Gemini is definitely not billed: backup on DeepSeek', async (t) => {
  const f = modelFixture(t, { chosen: 'gemini', fetch: answer({ gemini: () => wire.error.geminiRegion() }) });
  await f.runText();
  assert.deepEqual(providers(f.calls), ['gemini:draft', 'deepseek:draft', 'deepseek:review']);
  assert.equal(f.backups()[0]!.code, 'GEMINI_REGION_UNSUPPORTED');
  assert.equal(f.spending('gemini').spent_micros, 0);
});

test('documented overload (503) on Gemini is retried once on the next model; a plain 500 from xAI is UNKNOWN and never retried', async (t) => {
  const overloaded = modelFixture(t, {
    chosen: 'gemini',
    fetch: answer({ gemini: () => wire.error.geminiOverloaded() }),
  });
  await overloaded.runText();
  assert.equal(overloaded.backups()[0]!.code, 'GEMINI_OVERLOADED');
  assert.deepEqual(providers(overloaded.calls), ['gemini:draft', 'deepseek:draft', 'deepseek:review']);

  const broken = modelFixture(t, { chosen: 'xai', fetch: answer({ xai: () => wire.error.xaiServerError() }) });
  await assert.rejects(broken.runText());
  assert.deepEqual(
    providers(broken.calls),
    ['xai:draft'],
    'sent, then a server error: UNKNOWN, no other model is tried',
  );
  assert.equal(broken.attempts()[0]!.state, 'unknown');
  assert.equal(broken.backups().length, 0);
  assert.ok(broken.spending('xai').held_micros > 0, 'its reservation is never released');
});

test('a timeout / reset after the send is UNKNOWN: no retry on any model and the reservation stays held', async (t) => {
  const f = modelFixture(t, {
    chosen: 'gemini',
    fetch: () => {
      throw new TypeError('Network connection lost.');
    },
  });
  await assert.rejects(f.runText());
  assert.equal(f.calls.length, 1);
  assert.equal(f.attempts()[0]!.state, 'unknown');
  assert.equal(f.backups().length, 0);
  assert.ok(f.spending('gemini').held_micros > 0);
  assert.deepEqual(f.budget.calls, ['begin:draft:gemini'], 'the shared reservation is neither settled nor released');
  // A later claim of the same stage refuses to send again.
  f.advance(200_000);
  assert.equal(f.calls.length, 1);
});

test('a missing API key makes that model unavailable (not a crash): the reply is written by the next model, nothing was reserved', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', keys: { gemini: 'only-gemini' }, fetch: answer() });
  await f.runText();
  assert.deepEqual(providers(f.calls), ['deepseek:draft', 'deepseek:review'], 'xAI was never contacted');
  assert.equal(f.backups().length, 0, 'nothing reached the ledger for a model that was never started');
  assert.equal(f.attempts().find((a) => a.phase === 'draft')!.provider, 'deepseek');
  assert.equal(f.spending('xai').spent_micros + f.spending('xai').held_micros, 0);
  assert.equal(f.models()!.backup, 0, 'no attempt was abandoned, so no backup note');
});

test('a request above the xAI size cap is never sent (the doubled 200k-token tier is impossible)', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', padMessages: 20, fetch: answer() });
  await f.runText();
  assert.deepEqual(providers(f.calls), ['deepseek:draft', 'deepseek:review']);
});

test('the chain is chosen -> DeepSeek -> Gemini, each tried once; the last model failing definitely-not-billed ends at a known zero charge', async (t) => {
  const f = modelFixture(t, {
    chosen: 'deepseek',
    fetch: (call, _n, request) =>
      call.provider === 'deepseek' && call.tool === DRAFT
        ? new Response('{}', { status: 429 })
        : call.provider === 'gemini'
          ? wire.error.geminiRegion()
          : Response.json(acceptedAuditEnvelope(request)),
  });
  await assert.rejects(f.runText());
  assert.deepEqual(providers(f.calls), ['deepseek:draft', 'gemini:draft']);
  assert.deepEqual(
    f.backups().map((b) => b.provider),
    ['deepseek'],
  );
  const [draft] = f.attempts();
  assert.deepEqual(
    [draft!.provider, draft!.state, draft!.outcome, draft!.charged_micros],
    ['gemini', 'known', 'failed', 0],
  );
  assert.equal(f.spending('gemini').held_micros + f.spending('deepseek').held_micros, 0, 'nothing is left held');
  assert.equal(
    [...f.budget.entries.values()].every((entry) => entry.settled),
    true,
  );
});

test('the owner kill switch: a model that is not offered is never used, even for an operation that froze it', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', offered: ['deepseek', 'gemini'], fetch: answer() });
  await f.runText();
  assert.deepEqual(providers(f.calls), ['deepseek:draft', 'deepseek:review']);
  assert.equal(f.models()!.chosen, 'xai');
});

test('flag off = today: no route, DeepSeek writes and reviews, nothing is retried elsewhere, no Part 21b row is written', async (t) => {
  const f = modelFixture(t, {
    chosen: 'xai',
    flag: false,
    fetch: (call, _n, request) =>
      call.tool === DRAFT && call.provider === 'deepseek'
        ? new Response('{}', { status: 503 })
        : Response.json(acceptedAuditEnvelope(request)),
  });
  await assert.rejects(f.runText());
  assert.deepEqual(providers(f.calls), ['deepseek:draft']);
  assert.equal(f.attempts()[0]!.state, 'unknown', 'DeepSeek 5xx stays UNKNOWN exactly as before this Part');
  assert.equal(f.backups().length, 0);
  assert.equal(f.get('SELECT 1 FROM web_provider_usage'), undefined);
});

test('renew-prices seeds a model that has no rows yet (spending bound, capacity ticket, list-price upper bounds)', (t) => {
  const f = modelFixture(t, { chosen: 'xai', fetch: answer() });
  const price = (provider: string, phase: string) =>
    f.get<{ upper_micros_per_unit: number; valid_until: number }>(
      'SELECT upper_micros_per_unit,valid_until FROM web_provider_prices WHERE provider=? AND phase=?',
      provider,
      phase,
    )!;
  assert.equal(price('xai', 'draft').upper_micros_per_unit, 6);
  assert.equal(
    price('gemini', 'draft').upper_micros_per_unit,
    8,
    '$7.50 per million (the 2027 list price), rounded up',
  );
  assert.equal(price('gemini', 'review').upper_micros_per_unit, 8);
  assert.ok(f.get("SELECT 1 FROM web_external_budgets WHERE provider='gemini' AND phase='review'"));
  assert.equal(PLAYER_MODELS.xai.model, 'grok-4.7');
});
