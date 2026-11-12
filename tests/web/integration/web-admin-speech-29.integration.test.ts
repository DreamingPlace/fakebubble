import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';

/**
 * Part 29 A. The 24k-1 tests put a fake Fish provider ABOVE the worker boundary, so the production path
 * (business object -> WebAdminSpeech -> webCloudSpeech(env.GENERATION) -> generation worker speech() -> FishAudio) was never
 * exercised end to end. Here the business object, the budget object and the generation SESSION (the real class, which
 * enforces the send gate and the wire/usage checks) are real, workerd runs them, and only the Fish HTTP answer is faked.
 */
function runtime(t: test.TestContext) {
  return localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-speech-29-worker.ts',
    { STATE: 'WebHTTPFixture', PREVIEW_BUDGET: 'PreviewBudgetFixture' },
    ['MEDIA'],
    [
      {
        binding: 'GENERATION',
        entry: 'tests/web/fixtures/cloudflare-generation-worker.ts',
        entrypoint: 'SyntheticWebGenerationService',
      },
    ],
    ['enable_request_signal'],
  );
}
async function admin(f: ReturnType<typeof runtime>) {
  const origin = 'https://fixture.invalid',
    base = '/api/web/provider/admin/characters';
  let cookie = '',
    csrf = '';
  const call = async (path: string, body?: unknown, status = 200) => {
    const response = await f.request(origin + path, {
      headers: {
        'x-fixture-host': 'fixture.invalid',
        origin,
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, status, text);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const result = JSON.parse(text);
    if (result.csrf) csrf = result.csrf;
    return result;
  };
  await f.call('/fixture/assets');
  const grant = await f.call<{ token: string }>('/fixture/grant');
  await call('/api/web/provider/admin/login', { token: grant.token });
  const detail = await call(base + '/wei-guagua/detail', {}),
    profile = detail.published.profile;
  profile.template.version++;
  profile.template.persona += '语音端到端';
  // A binding that carries the Fish id (the single field of Part 29 B): what the form writes when the id is typed.
  profile.template.voice = { profileId: 'e2e-voice', version: 1, speed: 1, referenceId: 'e2e-fish-reference' };
  const saved = await call(base + '/wei-guagua/save', { expectedRevision: null, profile });
  const prepared = await call(base + '/wei-guagua/material-prepare', {
    requestId: randomUUID(),
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
  });
  return { call, base, saved, materialId: prepared.materialId as string };
}
const slot = (materialId: string, kind: 'welcome' | 'footer') => ({ kind: 'material', materialId, slot: kind });

test('admin 生成 through the real worker path succeeds, settles once, and a replay spends nothing', async (t) => {
  const f = runtime(t);
  const { call, base, materialId } = await admin(f);
  const estimate = await call(base + '/wei-guagua/speech-estimate', slot(materialId, 'welcome'));
  assert.equal(estimate.ok, true, JSON.stringify(estimate));
  const request = {
    requestId: randomUUID(),
    materialId,
    kind: 'welcome',
    acknowledgeMicros: estimate.estimateMicros,
  };
  const first = await call(base + '/wei-guagua/material-generate', request);
  assert.equal(first.origin, 'generated');
  const stats = await f.call<any>('/fixture/speech/stats');
  assert.deepEqual(stats.fishCalls, ['speech'], 'one call reached the fake Fish endpoint');
  assert.equal(stats.calls.length, 1);
  assert.equal(stats.calls[0].state, 'known');
  assert.equal(stats.calls[0].outcome, 'succeeded');
  assert.equal(stats.calls[0].shared_settled, 1, 'settled once in the shared budget');
  const fish = stats.budget.find((row: any) => row.provider === 'fish');
  assert.equal(fish.heldMicros, 0);
  assert.equal(fish.spentMicros, stats.calls[0].charged_micros);
  // The same request again: answered from the ledger, nothing sent, nothing charged twice.
  await call(base + '/wei-guagua/material-generate', request);
  const again = await f.call<any>('/fixture/speech/stats');
  assert.deepEqual(again.fishCalls, ['speech']);
  assert.equal(again.calls.length, 1);
  assert.equal(again.budget.find((row: any) => row.provider === 'fish').spentMicros, fish.spentMicros);
});

test('a forced Fish failure records its code on the row; UNKNOWN is never resent and keeps its hold', async (t) => {
  const f = runtime(t);
  const { call, base, materialId } = await admin(f);
  await f.call('/fixture/speech/mode?mode=invalid-audio');
  const estimate = await call(base + '/wei-guagua/speech-estimate', slot(materialId, 'welcome'));
  const request = { requestId: randomUUID(), materialId, kind: 'welcome', acknowledgeMicros: estimate.estimateMicros };
  const failed = await call(base + '/wei-guagua/material-generate', request, 409);
  assert.equal(failed.error.code, 'SPEECH_CALL_UNKNOWN');
  const stats = await f.call<any>('/fixture/speech/stats');
  assert.equal(stats.calls.length, 1);
  assert.equal(stats.calls[0].state, 'unknown');
  assert.match(stats.calls[0].error_code, /^[A-Z][A-Z0-9_]+$/, 'the underlying code is kept on the row');
  assert.notEqual(stats.calls[0].error_code, 'SPEECH_CALL_UNKNOWN');
  const held = stats.budget.find((row: any) => row.provider === 'fish').heldMicros;
  assert.ok(held > 0, 'the hold stays');
  // The same request is never sent again.
  const sent = stats.fishCalls.length;
  await call(base + '/wei-guagua/material-generate', request, 409);
  const after = await f.call<any>('/fixture/speech/stats');
  assert.equal(after.fishCalls.length, sent);
  assert.equal(after.budget.find((row: any) => row.provider === 'fish').heldMicros, held);
  // The slot shows the code (the page prints 「未确认 · CODE」).
  const list = await call(base + '/wei-guagua/material-list', {});
  const welcome = list.find((m: any) => m.materialId === materialId).slots.find((s: any) => s.kind === 'welcome');
  assert.equal(welcome.state, 'empty');
  assert.equal(welcome.issue.state, 'unknown');
  assert.equal(welcome.issue.code, stats.calls[0].error_code);
});
