import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

test('native HTTP + Alarm + isolated generation RPC + separate budget DO: durable preview, known draft recovery and publication', async (t) => {
  const f = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-worker.ts',
    {
      STATE: 'WebHTTPFixture',
      PREVIEW_BUDGET: 'PreviewBudgetFixture',
    },
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
  const until = async (work: () => Promise<any>, predicate: (result: any) => boolean) => {
    const end = Date.now() + 25_000;
    while (true) {
      const value = await work();
      if (predicate(value)) return value;
      assert.ok(Date.now() < end, JSON.stringify(value));
      await sleep(1000);
    }
  };
  await f.call('/fixture/assets');
  const grant = await f.call<{ token: string }>('/fixture/grant');
  await call('/api/web/provider/admin/login', { token: grant.token });
  const detail = await call(base + '/wei-guagua/detail', {}),
    profile = detail.published.profile;
  profile.template.version++;
  profile.template.persona += '隔离预演';
  const saved = await call(base + '/wei-guagua/save', { expectedRevision: null, profile });
  const before = await f.call<any>('/fixture/stats');
  await f.call('/fixture/preview/lost-settle');
  const input = {
    requestId: randomUUID(),
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    relationship: 'friend',
    message: '今天好吗',
  };
  const job = await call(base + '/wei-guagua/review-start', input, 202);
  const stalled = await until(
    () => f.call<any>('/fixture/preview/stats'),
    (r) => r.attempts.length === 1 && r.jobs[0]?.status === 'queued',
  );
  assert.deepEqual(stalled.calls, ['submit_dialogue_draft']);
  assert.equal(stalled.attempts[0].shared_settled, 0);
  assert.equal(stalled.budget[0].heldMicros, 0);
  assert.ok(stalled.budget[0].spentMicros > 0);
  await f.restart();
  const result = await until(
    () => call(base + '/wei-guagua/review-status', { previewId: job.previewId }),
    (r) => r.status === 'succeeded' || r.status === 'failed',
  );
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const final = await f.call<any>('/fixture/preview/stats');
  assert.deepEqual(final.calls, ['submit_dialogue_audit'], 'restart sends review only');
  assert.ok(final.attempts.every((a: any) => a.state === 'known' && a.shared_settled === 1));
  assert.equal(final.budget[0].spentMicros, 90);
  assert.equal(final.budget[0].heldMicros, 0);
  const after = await f.call<any>('/fixture/stats');
  assert.deepEqual(after.operations, before.operations);
  assert.equal(after.principals, before.principals);
  assert.deepEqual(after.calls, before.calls, 'no player transport runs during admin preview');
  assert.equal(after.spending[0].spent_micros, 90);
  const publication = await call(base + '/wei-guagua/publish', {
    requestId: randomUUID(),
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    previewId: job.previewId,
    acknowledgeReview: true,
  });
  assert.equal(publication.version, profile.template.version);
  await f.restart();
  assert.equal((await call(base + '/wei-guagua/detail', {})).published.version, publication.version);
});
