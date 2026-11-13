import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CLIP_DIRECTION_PROMPT, clipPromptHash } from '../../../apps/server/characters/clip-direction-prompt.ts';
import { localRuntime } from '../../cloudflare/runtime.ts';

/**
 * Part 30 P1-b. 按反馈重录 on the production path: business object -> WebClipDirection -> webCloudDirection(env.GENERATION) ->
 * the REAL generation session (`complete`, which pins the system prompt) -> DeepSeek (only the HTTP answer is faked), with the
 * shared budget object real. workerd runs it all.
 */
function runtime(t: test.TestContext) {
  return localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-direction-30-worker.ts',
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
  profile.template.persona += '反馈重录';
  profile.template.voice = { profileId: 'e2e-voice', version: 1, speed: 1, referenceId: 'e2e-fish-reference' };
  await call(base + '/wei-guagua/save', { expectedRevision: null, profile });
  const list = await call(base + '/wei-guagua/take-list', {});
  return { call, base, list, slotKey: list.slots[0].slotKey as string };
}

test('the takes list offers 按反馈重录 (directionAvailable) and one rewrite goes reserve -> call -> settle', async (t) => {
  const f = runtime(t);
  const { call, base, list, slotKey } = await admin(f);
  assert.equal(list.directionAvailable, true);
  const estimate = await call(base + '/wei-guagua/take-estimate-direction', { slotKey, feedback: '开头更懒一点' });
  assert.equal(estimate.ok, true, JSON.stringify(estimate));
  const out = await call(base + '/wei-guagua/take-rewrite', {
    requestId: randomUUID(),
    slotKey,
    feedback: '开头更懒一点',
  });
  assert.match(out.markup, /^\[lazy, drawn out\].*\[small laugh\]/);
  const stats = await f.call<any>('/fixture/speech/stats');
  assert.deepEqual(stats.fishCalls, ['direction'], 'one call reached the (fake) DeepSeek endpoint');
  assert.equal(stats.direction.length, 1);
  const row = stats.direction[0];
  assert.deepEqual(
    [row.state, row.outcome, row.shared_settled],
    ['known', 'succeeded', 1],
    'settled once in the shared budget',
  );
  const deepseek = stats.budget.find((r: any) => r.provider === 'deepseek');
  assert.equal(deepseek.heldMicros, 0, 'the hold was released into the bill');
  assert.equal(deepseek.spentMicros, row.charged_micros);
  assert.ok(row.charged_micros > 0);
});

test('a failed text call is UNKNOWN: it keeps its hold and is never sent again', async (t) => {
  const f = runtime(t);
  const { call, base, slotKey } = await admin(f);
  await f.call('/fixture/speech/mode?mode=direction-down');
  const request = { requestId: randomUUID(), slotKey, feedback: '最后一句带笑' };
  const failed = await call(base + '/wei-guagua/take-rewrite', request, 409);
  assert.equal(failed.error.code, 'CLIP_DIRECTION_UNKNOWN');
  const stats = await f.call<any>('/fixture/speech/stats');
  assert.equal(stats.direction.length, 1);
  assert.equal(stats.direction[0].state, 'unknown');
  const held = stats.budget.find((r: any) => r.provider === 'deepseek').heldMicros;
  assert.ok(held > 0, 'reserved before the call, and the hold stays');
  const sent = stats.fishCalls.length;
  await call(base + '/wei-guagua/take-rewrite', request, 409);
  const after = await f.call<any>('/fixture/speech/stats');
  assert.equal(after.fishCalls.length, sent, 'the same request is never resent');
  assert.equal(after.budget.find((r: any) => r.provider === 'deepseek').heldMicros, held);
  const list = await call(base + '/wei-guagua/take-list', {});
  assert.equal(list.slots[0].issue.state, 'unknown');
});

test('business.ts builds 按反馈重录 the production way', () => {
  const source = readFileSync(new URL('../../../workers/web-cloudflare/business.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /new WebClipDirection\([\s\S]*webCloudDirection\(this\.env\.GENERATION\)[\s\S]*this\.env\.BUDGET/,
  );
  assert.match(source, /previews\.useDirection\(direction\)/);
  assert.match(source, /app\.characterAdmin\.enableDirection\(direction\)/);
});

test('the generation Worker runs only the pinned clip-direction prompt', async (t) => {
  const f = runtime(t);
  const post = (wire: unknown) => f.call<any>('/fixture/direction/complete', wire);
  const user = '{"line":"你好","feedback":"轻一点"}';
  assert.deepEqual(
    await post({ system: '随便什么提示词', systemSha256: clipPromptHash('随便什么提示词'), user, maxTokens: 10 }),
    { ok: false, code: 'WEB_PROVIDER_WIRE_MISMATCH' },
  );
  assert.equal(
    (await post({ system: CLIP_DIRECTION_PROMPT, systemSha256: '0'.repeat(64), user, maxTokens: 10 })).ok,
    false,
  );
  assert.deepEqual(await f.call<string[]>('/fixture/direction/sent'), [], 'nothing was sent for a refused prompt');
  const ok = await post({
    system: CLIP_DIRECTION_PROMPT,
    systemSha256: clipPromptHash(CLIP_DIRECTION_PROMPT),
    user,
    maxTokens: 10,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(await f.call<string[]>('/fixture/direction/sent'), ['direction']);
});
