import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

/**
 * Part 40 on the Cloudflare path (workerd): a 多轮预演 started over HTTP is driven by the alarm alone (no other request wakes it),
 * the Grok and Gemini columns (旧 and 新) run through the real business -> generation route and produce replies, and a refusal that
 * waiting cannot lift fails that column at once with its code.
 */
function setup(t: test.TestContext) {
  const f = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-rehearsal-40-worker.ts',
    { STATE: 'WebHTTPFixture', PREVIEW_BUDGET: 'PreviewBudgetFixture' },
    ['MEDIA'],
    [
      {
        binding: 'GENERATION',
        entry: 'tests/web/fixtures/cloudflare-generation-40-worker.ts',
        entrypoint: 'SyntheticWebGenerationService',
      },
    ],
    ['enable_request_signal'],
  );
  const origin = 'https://fixture.invalid',
    base = '/api/web/provider/admin';
  let cookie = '',
    csrf = '';
  const call = async (path: string, body: unknown, status = 200) => {
    const response = await f.request(origin + path, {
      headers: {
        'x-fixture-host': 'fixture.invalid',
        origin,
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      method: 'POST',
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, status, text);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const result = JSON.parse(text);
    if (result.csrf) csrf = result.csrf;
    return result;
  };
  const stats = () => f.call<any>('/fixture/rehearsal/stats');
  /** Waits by reading the fixture's own route: it never goes through the HTTP transport, so it cannot wake the executor. */
  const until = async (predicate: (s: any) => boolean, seconds = 90) => {
    const end = Date.now() + seconds * 1000;
    while (true) {
      const s = await stats();
      if (predicate(s)) return s;
      assert.ok(Date.now() < end, JSON.stringify(s.units.slice(0, 8)));
      await sleep(500);
    }
  };
  const start = async (models: string[]) => {
    const detail = await call(`${base}/characters/wei-guagua/detail`, {});
    const profile = detail.published.profile;
    profile.template.version++;
    profile.template.persona += `（多轮预演 ${randomUUID().slice(0, 4)}）`;
    const saved = await call(`${base}/characters/wei-guagua/save`, {
      expectedRevision: detail.draft?.revision ?? null,
      profile,
    });
    const input = {
      characterId: 'wei-guagua',
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      source: { kind: 'set', set: 'chat' },
      models,
      withCast: false,
    };
    const estimate = await call(`${base}/rehearsal/estimate`, input);
    return call(`${base}/rehearsal/start`, {
      ...input,
      requestId: randomUUID(),
      acknowledgeMicros: estimate.totalMicros,
    });
  };
  const login = async () => {
    await f.call('/fixture/assets');
    const grant = await f.call<{ token: string }>('/fixture/grant');
    await call(`${base}/login`, { token: grant.token });
  };
  return { f, call, stats, until, start, login };
}

test('a 多轮预演 started over HTTP progresses with no other request, and Grok and Gemini (旧 and 新) answer through business -> generation', async (t) => {
  const { f, stats, until, start, login } = setup(t);
  await login();
  const run = await start(['gemini', 'gemini-v8', 'xai', 'xai-v8']);
  assert.equal(run.replayed, false);
  // Nothing is sent to the site from here on except reads of the fixture's own route: only the alarm woken by the start can move it.
  const progressed = await until((s) => s.units.some((u: any) => u.status === 'done'), 60);
  assert.ok(progressed.units.some((u: any) => u.status === 'done'));
  const finished = await until(
    (s) => s.units.every((u: any) => ['done', 'failed', 'skipped', 'unconfirmed'].includes(u.status)),
    150,
  );
  const columns = ['gemini', 'gemini-v8', 'xai', 'xai-v8'];
  for (const column of columns) {
    const cells = finished.units.filter((u: any) => u.kind === 'cell' && u.model_key === column);
    assert.equal(cells.length, 8, column);
    assert.ok(
      cells.every((u: any) => u.status === 'done' && u.error_code === null),
      `${column}: ${JSON.stringify(cells.map((u: any) => [u.status, u.error_code]))}`,
    );
  }
  // the providers really were called, on the right model and shape
  const sent: string[] = finished.calls;
  assert.ok(
    sent.some((c) => c.startsWith('gemini:') && c.endsWith(':submit_dialogue_draft')),
    'Gemini 旧 draft',
  );
  assert.ok(
    sent.some((c) => c.startsWith('gemini:') && c.endsWith(':plain')),
    'Gemini 新 plain draft',
  );
  assert.ok(
    sent.some((c) => c.startsWith('xai:') && c.endsWith(':submit_dialogue_draft')),
    'Grok 旧 draft',
  );
  assert.ok(
    sent.some((c) => c.startsWith('xai:') && c.endsWith(':plain')),
    'Grok 新 plain draft',
  );
  assert.ok(
    sent.some((c) => c.startsWith('deepseek:')),
    'the house reviewer',
  );
  const spent = finished.spending.filter((r: any) => ['gemini', 'xai'].includes(r.provider));
  assert.ok(
    spent.length === 2 && spent.every((r: any) => r.spent_micros > 0 && r.held_micros === 0),
    JSON.stringify(spent),
  );
  void stats;
  void f;
});

test('a refusal that waiting cannot lift fails that column at once with its code, and the other column goes on', async (t) => {
  const { f, until, start, login } = setup(t);
  await login();
  // the Gemini bound is spent (1 micro): nothing can ever be held for it (a refusal waiting does not change)
  await f.call('/fixture/rehearsal/limit', { provider: 'gemini', micros: 1 });
  await start(['deepseek', 'gemini']);
  const failed = await until((s) => s.units.some((u: any) => u.model_key === 'gemini' && u.status === 'failed'), 30);
  const cell = failed.units.find((u: any) => u.model_key === 'gemini' && u.status === 'failed');
  assert.equal(cell.error_code, 'WEB_PROVIDER_BUDGET_EXHAUSTED');
  assert.equal(cell.turn, 1);
  const done = await until(
    (s) => s.units.every((u: any) => ['done', 'failed', 'skipped', 'unconfirmed'].includes(u.status)),
    120,
  );
  const deepseek = done.units.filter((u: any) => u.kind === 'cell' && u.model_key === 'deepseek');
  assert.ok(deepseek.every((u: any) => u.status === 'done'));
  // the rest of the Gemini column is closed at once, with a code, never left waiting for the run's deadline
  const rest = done.units.filter((u: any) => u.kind === 'cell' && u.model_key === 'gemini' && u.turn > 1);
  assert.ok(rest.every((u: any) => u.status === 'skipped' && u.error_code === 'REHEARSAL_REPLY_MISSING'));
  assert.ok(!done.calls.some((c: string) => c.startsWith('gemini:')), 'nothing was sent to Gemini');
});

test('a refusal that goes away by waiting (capacity full right now) waits and retries, then the column runs', async (t) => {
  const { f, until, start, login } = setup(t);
  await login();
  await f.call('/fixture/rehearsal/capacity', { full: true });
  await start(['gemini']);
  // refused before anything is sent: still waiting, not failed, nothing sent
  await sleep(4000);
  const waiting = await until(() => true);
  const first = waiting.units.find((u: any) => u.kind === 'cell' && u.turn === 1);
  assert.equal(first.status, 'queued');
  assert.equal(first.error_code, null);
  assert.ok(!waiting.calls.some((c: string) => c.startsWith('gemini:')));
  await f.call('/fixture/rehearsal/capacity', { full: false });
  const done = await until((s) => s.units.every((u: any) => u.status === 'done'), 90);
  assert.ok(done.calls.some((c: string) => c.startsWith('gemini:')));
});
