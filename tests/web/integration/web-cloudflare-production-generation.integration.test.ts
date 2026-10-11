import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { testModules } from '../../cloudflare/modules.ts';
import { draftEnvelope, acceptedAuditEnvelope, toolEnvelope } from '../../text-fixtures.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';

test('production generation entry uses the real fetch path across RPC, with outbound replaced only at the network boundary', async (t) => {
  const calls: string[] = [];
  let redirect = false;
  let invalid = false;
  const common = { modulesRoot: resolve('.'), compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'] };
  const mf = new Miniflare({
    workers: [
      {
        ...common,
        name: 'client',
        modules: testModules('tests/web/fixtures/cloudflare-production-generation-client.ts'),
        serviceBindings: { GENERATION: { name: 'generation', entrypoint: 'WebGenerationService' } },
      },
      {
        ...common,
        name: 'generation',
        modules: testModules('workers/web-cloudflare/generation.ts'),
        bindings: { EXTERNAL_CALLS: 'true', DEEPSEEK_API_KEY: 'offline-only', FISH_API_KEY: 'offline-only' },
        outboundService: async (request: Request) => {
          assert.ok(
            ['https://api.deepseek.com/beta/chat/completions', 'https://api.fish.audio/v1/tts'].includes(request.url),
            'must never forward credentials or bodies to a redirect destination',
          );
          if (redirect) {
            calls.push('redirect');
            return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/steal' } });
          }
          if (request.url.includes('fish.audio')) {
            calls.push('speech');
            return new Response(Uint8Array.from(syntheticTone()), { headers: { 'content-type': 'audio/wav' } });
          }
          const body = (await request.json()) as { tools: { function: { name: string } }[] };
          const stage = body.tools[0]!.function.name;
          calls.push(stage);
          if (invalid) return Response.json(toolEnvelope('submit_dialogue_draft', { mode: 'text', bubbles: [] }));
          return Response.json(stage === 'submit_dialogue_draft' ? draftEnvelope() : acceptedAuditEnvelope());
        },
      },
    ],
  });
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch('http://localhost');
  const result = await response.json();
  assert.deepEqual(
    result,
    { ok: true, starts: ['draft', 'review'], stages: ['draft', 'review'] },
    JSON.stringify({ result, calls }),
  );
  assert.deepEqual(calls, ['submit_dialogue_draft', 'submit_dialogue_audit']);
  calls.length = 0;
  const speech = (await (await mf.dispatchFetch('http://localhost/?speech')).json()) as {
    ok: boolean;
    starts: string[];
    bytes: number;
  };
  assert.equal(speech.ok, true);
  assert.deepEqual(speech.starts, ['speech']);
  assert.ok(speech.bytes > 44);
  assert.deepEqual(calls, ['speech']);
  // Part 16: a complete response that fails validation must hand its raw words across the Worker RPC bridge to the
  // business-side observer, before finish(), without touching the observation (still failed, same error code).
  invalid = true;
  calls.length = 0;
  const bad = (await (await mf.dispatchFetch('http://localhost/?diag')).json()) as {
    ok: boolean;
    error: string;
    events: string[];
    offered: { raw: string; errorCode: string }[];
  };
  assert.equal(bad.ok, false);
  assert.deepEqual(calls, ['submit_dialogue_draft']);
  assert.equal(bad.offered.length, 1, JSON.stringify(bad));
  assert.match(bad.offered[0]!.raw, /"bubbles"\s*:\s*\[\s*\]/);
  assert.equal(bad.offered[0]!.errorCode, bad.error);
  assert.equal(bad.events.length, 2);
  assert.equal(bad.events[0], 'rejected');
  assert.match(bad.events[1]!, new RegExp(`^finish:failed:${bad.error}:`));
  invalid = false;
  redirect = true;
  for (const path of ['/', '/?speech']) {
    calls.length = 0;
    const rejected = (await (await mf.dispatchFetch('http://localhost' + path)).json()) as {
      ok: boolean;
      error: string;
    };
    assert.equal(rejected.ok, false);
    assert.notEqual(rejected.error, 'TEXT_NETWORK_ERROR');
    assert.deepEqual(calls, ['redirect']);
  }
});
