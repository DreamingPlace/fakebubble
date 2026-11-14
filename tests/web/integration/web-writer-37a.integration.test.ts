import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { FishModel, VoiceModelBinding } from '../../../packages/contracts/audio.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { WebProviderRunner, type FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';
import {
  framePinsMatch,
  freezeWebV7Request,
  readWebV7Request,
} from '../../../apps/server/generation/web-v7-request.ts';
import { installWriterSetting, readWriter, writeWriter } from '../../../apps/server/generation/web-writer-setting.ts';
import { writerPins } from '../../../apps/server/generation/writer-v8.ts';
import { protocolFingerprint } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { captureFreeze, FREEZE_NOW, schema128, seedFreezeScenario } from '../fixtures/cast-freeze.ts';
import { MemoryBudget } from '../fixtures/memory-budget.ts';
import { createHash } from 'node:crypto';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const signal = () => new AbortController().signal;

function scenario(t: TestContext, options: { writer?: 'v7' | 'v8'; binding?: string; installed?: boolean } = {}) {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store, 'character', (options.binding ?? 's2.1-pro') as VoiceModelBinding);
  if (options.installed !== false) installWriterSetting(store);
  if (options.writer) writeWriter(store, FREEZE_NOW, 'owner', options.writer);
  return store;
}

test('the switch defaults to 现行: no table, an empty table and an explicit v7 freeze byte-identical requests', (t) => {
  const bare = scenario(t, { installed: false });
  const fresh = scenario(t);
  const explicit = scenario(t, { writer: 'v7' });
  assert.equal(readWriter(bare), 'v7');
  assert.equal(readWriter(fresh), 'v7');
  const a = captureFreeze(bare),
    b = captureFreeze(fresh),
    c = captureFreeze(explicit);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  const request = JSON.parse(a.request.request_json as string) as Record<string, unknown>;
  assert.equal(request.relationship, 'friend');
  for (const key of ['writer', 'voiceDirections']) assert.ok(!(key in request), key);
  assert.equal(a.request.prompt_digest, textPromptHash());
  assert.equal(a.request.protocol_digest, sha(JSON.stringify(protocolFingerprint())));
});

test('the switch on 新: the request freezes the writer, has no relationship preset, and carries the v8 pins', (t) => {
  const store = scenario(t, { writer: 'v8' });
  freezeInputSnapshot(store as unknown as WebStore, 'operation', FREEZE_NOW);
  freezeWebV7Request(store as unknown as WebStore, 'operation', FREEZE_NOW);
  const { request, row } = readWebV7Request(store as unknown as WebStore, 'operation');
  assert.equal(request.writer, 'v8');
  assert.equal(request.relationship, undefined);
  assert.ok(!('voiceDirections' in request));
  assert.deepEqual({ protocolDigest: row.protocol_digest, promptDigest: row.prompt_digest }, writerPins());
  // A reply in flight keeps its writer: flipping the switch afterwards does not touch the frozen row.
  writeWriter(store, FREEZE_NOW + 1, 'owner', 'v7');
  assert.equal(readWebV7Request(store as unknown as WebStore, 'operation').request.writer, 'v8');
  // A v8 request holding v7 pins (or the reverse) is refused; the stored row itself is immutable.
  const v7pins = { protocol_digest: sha(JSON.stringify(protocolFingerprint())), prompt_digest: textPromptHash() };
  assert.equal(framePinsMatch(v7pins, request), false);
  assert.equal(
    framePinsMatch({ protocol_digest: row.protocol_digest, prompt_digest: row.prompt_digest }, request),
    true,
  );
  assert.equal(framePinsMatch(v7pins, {}), true);
  assert.equal(framePinsMatch({ protocol_digest: row.protocol_digest, prompt_digest: row.prompt_digest }, {}), false);
  assert.throws(() => store.run("UPDATE web_v7_requests SET prompt_digest=? WHERE operation_id='operation'", 'x'), {
    message: 'WEB_V7_REQUEST_IMMUTABLE',
  });
});

test('voice directions are frozen only for a Drama 3 voice (the binding resolved against the site model)', (t) => {
  for (const [binding, directions] of [
    ['s2.1-pro', false],
    ['drama-3', true],
    ['pin:s2.1-pro', false],
  ] as const) {
    const store = scenario(t, { writer: 'v8', binding });
    freezeInputSnapshot(store as unknown as WebStore, 'operation', FREEZE_NOW);
    freezeWebV7Request(store as unknown as WebStore, 'operation', FREEZE_NOW);
    const { request } = readWebV7Request(store as unknown as WebStore, 'operation');
    assert.equal(request.voiceDirections === true, directions, binding);
  }
});

/** The real text stage on fake providers: a plain draft, a guard answer, then the speech call. */
function pipeline(
  t: TestContext,
  options: { binding?: string; site?: FishModel; draft: string; guard?: Record<string, unknown> },
) {
  const store = scenario(t, { writer: 'v8', ...(options.binding ? { binding: options.binding } : {}) });
  const now = FREEZE_NOW;
  const clock = { now: () => now };
  const wire: { body: Record<string, unknown>; url: string }[] = [];
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      wire.push({ body, url: String(url) });
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 10,
      };
      if (!body.tools)
        return Response.json({
          id: 'draft-1',
          model: 'deepseek-v4-flash',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: options.draft } }],
          usage,
        });
      const answer = {
        fixes: [],
        mode: 'casual',
        endsSession: false,
        topics: [],
        factOps: [],
        ...(JSON.parse(String(init?.body)).tools[0].function.parameters.properties.sceneUpdate
          ? { sceneUpdate: null }
          : {}),
        ...(JSON.parse(String(init?.body)).tools[0].function.parameters.properties.relationshipEvents
          ? { relationshipEvents: [] }
          : {}),
        ...options.guard,
      };
      return Response.json({
        id: 'guard-1',
        model: 'deepseek-v4-flash',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call',
                  type: 'function',
                  function: { name: 'submit_reply_check', arguments: JSON.stringify(answer) },
                },
              ],
            },
          },
        ],
        usage,
      });
    },
  });
  const spoken: Parameters<FakeFish>[0][] = [];
  const fish: FakeFish = async (request) => {
    spoken.push(request);
    return { audio: syntheticTone(), receipt: { id: 'fake-fish' }, usageUnits: request.billedTextBytes };
  };
  const runner = new WebProviderRunner(store, clock, generator, fish, new MemoryBudget(), undefined, {
    voiceModel: options.site ?? 's2.1-pro',
  });
  const ledger = new WebProviderOffline(store, clock);
  const capacity = new WebDispatchLedger(store as unknown as WebStore, clock);
  for (const provider of ['deepseek', 'fish']) ledger.configureBudget(provider, 3_000_000);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configurePrice({
      id: `deepseek-${phase}`,
      provider: 'deepseek',
      model: phase === 'draft' ? generator.model : generator.reviewModel,
      phase,
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: 1,
      validFrom: now - 1,
      validUntil: now + 1_000_000,
      version: 1,
    });
    capacity.configureBudget({ provider: 'deepseek', stage: 'text', phase, capacity: 2 });
  }
  for (const model of ['s2.1-pro', 'drama-3'] as const)
    ledger.configurePrice({
      id: `fish-speech-${model}`,
      provider: 'fish',
      model,
      phase: 'speech',
      currency: 'USD',
      unit: 'byte',
      upperMicrosPerUnit: 15,
      validFrom: now - 1,
      validUntil: now + 1_000_000,
      version: 1,
    });
  capacity.configureBudget({ provider: 'fish', stage: 'audio', phase: 'speech', capacity: 2 });
  freezeInputSnapshot(store as unknown as WebStore, 'operation', now);
  freezeWebV7Request(store as unknown as WebStore, 'operation', now);
  store.run(
    "UPDATE web_operations SET deadline_at=?,text_queued_at=?,admission_seq=1 WHERE id='operation'",
    now + 300_000,
    now,
  );
  let ids = 0;
  const queue = new WebStageQueue(store as unknown as WebStore, clock, () => `stage-id-${++ids}`);
  const lease = queue.acquireCoordinator('coordinator');
  return { store, runner, queue, lease, wire, spoken, generator };
}

test('v8 end to end (voice): plain draft with no tool, guard with a tool, directions go to Fish only as markup, text is the stripped line', async (t) => {
  const f = pipeline(t, { binding: 'drama-3', draft: '[笑着，慢一点]哈哈，行啊\n<whisper>别告诉别人</whisper>' });
  await f.runner.runText(f.queue.claimText(f.lease, 'text-worker')!, signal());
  // Two provider calls, in order: the plain draft (no tools, the pinned temperature, thinking off) then the guard (one forced tool).
  assert.equal(f.wire.length, 2);
  assert.ok(!('tools' in f.wire[0]!.body) && !('tool_choice' in f.wire[0]!.body));
  assert.equal(f.wire[0]!.body.temperature, 0.9);
  assert.deepEqual(f.wire[0]!.body.thinking, { type: 'disabled' });
  const messages = f.wire[0]!.body.messages as { role: string; content: string }[];
  assert.ok(messages[0]!.content.startsWith('你是快照角色。'));
  assert.ok(messages[0]!.content.includes('<whisper>'));
  assert.equal((f.wire[1]!.body.tools as { function: { name: string } }[])[0]!.function.name, 'submit_reply_check');
  assert.ok(!('temperature' in f.wire[1]!.body));
  const stored = JSON.parse(
    f.store.get<{ candidate_json: string }>('SELECT candidate_json FROM web_provider_candidates')!.candidate_json,
  );
  assert.deepEqual(
    stored.bubbles.map((b: { text: string }) => b.text),
    ['哈哈，行啊', '别告诉别人'],
  );
  assert.deepEqual(stored.bubbleMarkup, ['[笑着，慢一点]哈哈，行啊', '<whisper>别告诉别人</whisper>']);
  assert.deepEqual(stored.deferredMessageIds, []);
  assert.deepEqual(stored.awaitingPlayerMessageIds, []);
  const attempts = f.store.all<{ phase: string; policy_hash: string }>(
    "SELECT phase,policy_hash FROM web_provider_attempts WHERE phase IN ('draft','review')",
  );
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((a) => a.policy_hash === f.generator.writerPolicyHash));
  assert.notEqual(f.generator.writerPolicyHash, f.generator.policyHash);
  // Speech: the markup is what Fish receives (Drama 3), the stripped text is what is checked.
  const audio = f.queue.claimAudio(f.lease, 'audio-worker')!;
  await f.runner.runSpeech(audio, signal());
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0]!.speech.text, '哈哈，行啊');
  assert.equal(f.spoken[0]!.speech.markup, '[笑着，慢一点]哈哈，行啊');
  assert.ok(JSON.parse(f.spoken[0]!.body).text.includes('[笑着，慢一点]哈哈，行啊'));
});

test('v8 end to end (voice, s2): the same line is plain text and no markup reaches Fish', async (t) => {
  const f = pipeline(t, { binding: 's2.1-pro', draft: '[笑着]哈哈，行啊' });
  await f.runner.runText(f.queue.claimText(f.lease, 'text-worker')!, signal());
  const messages = f.wire[0]!.body.messages as { content: string }[];
  assert.ok(!messages[0]!.content.includes('<whisper>'));
  const stored = JSON.parse(
    f.store.get<{ candidate_json: string }>('SELECT candidate_json FROM web_provider_candidates')!.candidate_json,
  );
  assert.deepEqual(
    stored.bubbles.map((b: { text: string }) => b.text),
    ['哈哈，行啊'],
  );
  assert.ok(!('bubbleMarkup' in stored));
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  assert.equal(f.spoken[0]!.speech.markup, undefined);
  assert.ok(!/[[\]]笑/.test(JSON.parse(f.spoken[0]!.body).text));
});

test('v8: the guard replaces only the offending bubble; markup of a replaced line is gone, the others keep theirs', async (t) => {
  const f = pipeline(t, {
    binding: 'drama-3',
    draft: '[笑着]哈哈\n我刚看到一条新闻\n[轻声]晚点再说',
    guard: { fixes: [{ index: 1, reason: 'fabricated_real_world', text: '我没刷到新闻，你先说' }] },
  });
  await f.runner.runText(f.queue.claimText(f.lease, 'text-worker')!, signal());
  const stored = JSON.parse(
    f.store.get<{ candidate_json: string }>('SELECT candidate_json FROM web_provider_candidates')!.candidate_json,
  );
  assert.deepEqual(
    stored.bubbles.map((b: { text: string }) => b.text),
    ['哈哈', '我没刷到新闻，你先说', '晚点再说'],
  );
  assert.deepEqual(stored.bubbleMarkup, ['[笑着]哈哈', null, '[轻声]晚点再说']);
  assert.deepEqual(stored.guardReasons, ['fabricated_real_world']);
});

test('v8 publishes with no follow-up: the operation set is unchanged and nothing is deferred', async (t) => {
  const f = pipeline(t, { binding: 's2.1-pro', draft: '嗯，行' });
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n;
  await f.runner.runText(f.queue.claimText(f.lease, 'text-worker')!, signal());
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n, before);
  const stored = JSON.parse(
    f.store.get<{ candidate_json: string }>('SELECT candidate_json FROM web_provider_candidates')!.candidate_json,
  );
  assert.deepEqual(stored.coveredMessageIds, ['input']);
  assert.deepEqual(stored.deferredMessageIds, []);
  assert.deepEqual(stored.awaitingPlayerMessageIds, []);
});
