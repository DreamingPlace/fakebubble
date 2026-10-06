import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  WEB_CONCURRENCY_DEPLOYMENT_DEFAULT,
  WEB_CONCURRENCY_LIBRARY_DEFAULT,
  parseWebConcurrency,
  webConcurrency,
  webConcurrencyFromEnv,
} from '../../../config/web-concurrency.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { providerHistoryMessage } from '../../../apps/server/generation/web-provider-application.ts';

test('deployment default is 20 text and 4 audio; the global ticket count covers running plus waiting operations', () => {
  const d = WEB_CONCURRENCY_DEPLOYMENT_DEFAULT;
  assert.deepEqual(
    [d.maxTextRunning, d.maxAudioRunning, d.audioFallbackWaitMs],
    [20, 4, 8000],
    'Fish allows 5 concurrent requests, DeepSeek hundreds',
  );
  assert.equal(d.maxGlobalReservedOperations, d.maxTextRunning + d.maxAudioRunning + d.maxWaitingOperations);
  assert.ok(d.maxGlobalReservedOperations > d.maxTextRunning + d.maxAudioRunning, 'room to wait');
  const l = WEB_CONCURRENCY_LIBRARY_DEFAULT;
  assert.equal(l.maxGlobalReservedOperations, l.maxTextRunning + l.maxAudioRunning + l.maxWaitingOperations);
  assert.equal(WEB_LIMITS.maxGlobalReservedOperations, d.maxGlobalReservedOperations);
  assert.equal(WEB_LIMITS.maxGlobalReservedOperations, l.maxGlobalReservedOperations);
  const custom = parseWebConcurrency({ maxTextRunning: 64, maxAudioRunning: 48, maxWaitingOperations: 200 });
  assert.equal(custom.maxGlobalReservedOperations, 64 + 48 + 200);
});

test('configuration is validated: integers within 1..64 text, 1..48 audio; anything else refuses to start', () => {
  assert.deepEqual(parseWebConcurrency(undefined), WEB_CONCURRENCY_DEPLOYMENT_DEFAULT);
  assert.equal(parseWebConcurrency({ maxTextRunning: 1, maxAudioRunning: 1 }).maxTextRunning, 1);
  assert.equal(parseWebConcurrency({ maxTextRunning: 64, maxAudioRunning: 48 }).maxAudioRunning, 48);
  for (const bad of [0, 65, -1, 1.5, Number.NaN, Infinity, '', 'x', '1e1', ' 20', '20 ', null, true, {}, [20]])
    assert.throws(() => parseWebConcurrency({ maxTextRunning: bad }), /WEB_CONCURRENCY_INVALID_TEXT/, String(bad));
  for (const bad of [0, 49, 4.5, 'x', null])
    assert.throws(() => parseWebConcurrency({ maxAudioRunning: bad }), /WEB_CONCURRENCY_INVALID_AUDIO/, String(bad));
  assert.throws(() => parseWebConcurrency({ audioFallbackWaitMs: 999 }), /WEB_CONCURRENCY_INVALID_FALLBACK_WAIT/);
  assert.throws(() => parseWebConcurrency({ audioFallbackWaitMs: 60_001 }), /WEB_CONCURRENCY_INVALID_FALLBACK_WAIT/);
  assert.throws(() => parseWebConcurrency({ maxWaitingOperations: 0 }), /WEB_CONCURRENCY_INVALID_WAITING/);
});

test('Worker vars are decimal strings and share the same validation', () => {
  assert.deepEqual(webConcurrencyFromEnv({}), WEB_CONCURRENCY_DEPLOYMENT_DEFAULT);
  const configured = webConcurrencyFromEnv({
    MAX_TEXT_RUNNING: '30',
    MAX_AUDIO_RUNNING: '5',
    AUDIO_FALLBACK_WAIT_MS: '6000',
  });
  assert.deepEqual(
    [configured.maxTextRunning, configured.maxAudioRunning, configured.audioFallbackWaitMs],
    [30, 5, 6000],
  );
  assert.throws(() => webConcurrencyFromEnv({ MAX_TEXT_RUNNING: '0' }), /WEB_CONCURRENCY_INVALID_TEXT/);
  assert.throws(() => webConcurrencyFromEnv({ MAX_AUDIO_RUNNING: '49' }), /WEB_CONCURRENCY_INVALID_AUDIO/);
  assert.throws(() => webConcurrencyFromEnv({ MAX_TEXT_RUNNING: 'twenty' }), /WEB_CONCURRENCY_INVALID_TEXT/);
  const example = JSON.parse(readFileSync('workers/web-cloudflare/deploy/business.json.example', 'utf8')) as {
    vars: Record<string, string>;
  };
  assert.deepEqual(webConcurrencyFromEnv(example.vars), WEB_CONCURRENCY_DEPLOYMENT_DEFAULT);
});

test('every stage reader takes the store value; a store without configuration keeps the library default', () => {
  assert.deepEqual(webConcurrency({}), WEB_CONCURRENCY_LIBRARY_DEFAULT);
  const configured = parseWebConcurrency({ maxTextRunning: 9 });
  assert.equal(webConcurrency({ concurrency: configured }).maxTextRunning, 9);
});

test('local instance config carries the concurrency and refuses to start when it is invalid', (t) => {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-conc-${crypto.randomUUID().slice(0, 8)}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initLocalInstance(root);
  const path = join(root, 'local-config.json');
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(readLocalConfig(root).concurrency, WEB_CONCURRENCY_DEPLOYMENT_DEFAULT);
  for (const [field, value, code] of [
    ['maxTextRunning', 65, /WEB_CONCURRENCY_INVALID_TEXT/],
    ['maxTextRunning', 0, /WEB_CONCURRENCY_INVALID_TEXT/],
    ['maxAudioRunning', 49, /WEB_CONCURRENCY_INVALID_AUDIO/],
    ['maxAudioRunning', 2.5, /WEB_CONCURRENCY_INVALID_AUDIO/],
  ] as const) {
    writeFileSync(
      path,
      JSON.stringify({ ...written, concurrency: { ...(written.concurrency as object), [field]: value } }),
    );
    assert.throws(() => readLocalConfig(root), code);
  }
  writeFileSync(
    path,
    JSON.stringify({
      ...written,
      concurrency: { ...(written.concurrency as object), maxTextRunning: 12, maxAudioRunning: 3 },
    }),
  );
  assert.equal(readLocalConfig(root).concurrency.maxTextRunning, 12);
  assert.equal(readLocalConfig(root).concurrency.maxGlobalReservedOperations, 12 + 3 + 104);
});

test('a text fallback is an ordinary narrative text bubble for the player; only deliveryFallback marks it', () => {
  const base = { id: 'm', body: '你好', created_at: 5, operation_id: 'op', ordinal: 1, duration_ms: null };
  const fallback = providerHistoryMessage(
    { ...base, origin: 'text_fallback', media_id: null },
    'conversation',
    'wei-guagua',
  );
  assert.equal(fallback.origin, 'narrative');
  assert.equal(fallback.replyOrdinal, 1);
  assert.equal(fallback.audio, null);
  assert.equal(fallback.deliveryFallback, 'text');
  assert.equal(fallback.text, '你好');
  const voice = providerHistoryMessage(
    { ...base, origin: 'narrative', media_id: 'media' },
    'conversation',
    'wei-guagua',
  );
  assert.equal('deliveryFallback' in voice, false, 'a voice reply is unchanged');
  assert.equal(voice.audio?.mediaId, 'media');
});

function metricsTable(store: Store) {
  const sql = readFileSync('apps/server/web-migrations/114_stage_metrics.sql', 'utf8');
  const start = sql.indexOf('CREATE TABLE web_operation_metrics');
  store.db.exec(
    sql.slice(start, sql.indexOf('STRICT;', start) + 'STRICT;'.length).replace(/REFERENCES web_operations\(id\)/, ''),
  );
}

test('admin stage-latency view is owner-only and reports per-day p50/p95, retries and fallbacks', (t) => {
  const origin = 'https://admin.fixture.invalid';
  const store = new Store(':memory:');
  t.after(() => store.close());
  const clock = { now: () => 1_800_000_000_000 };
  const admin = new WebAccountAdmin(store, clock, origin);
  metricsTable(store);
  const owner = admin.login(admin.issueLoginGrant().token, origin);
  const auth = [owner.cookie, owner.csrf, origin] as const;
  const insert = (
    id: string,
    day: string,
    textWait: number,
    audioWait: number | null,
    retries: number,
    fallback: number,
  ) =>
    store.run(
      `INSERT INTO web_operation_metrics(operation_id,day,text_queue_wait_ms,audio_queue_wait_ms,text_stage_ms,
      audio_stage_ms,audio_rate_limit_retries,fallback_used,fallback_reason) VALUES (?,?,?,?,?,?,?,?,?)`,
      id,
      day,
      textWait,
      audioWait,
      textWait * 10,
      audioWait === null ? null : audioWait * 2,
      retries,
      fallback,
      fallback ? 'audio_wait' : null,
    );
  for (let i = 1; i <= 20; i++) insert(`a${i}`, '2026-10-01', i * 100, i * 50, i % 4 === 0 ? 1 : 0, i === 20 ? 1 : 0);
  insert('b1', '2026-10-02', 700, null, 0, 0);
  const view = admin.stageLatency(...auth, 7) as { days: Record<string, any>[] };
  assert.deepEqual(
    view.days.map((d) => d.day),
    ['2026-10-02', '2026-10-01'],
  );
  const day = view.days[1]!;
  assert.equal(day.operations, 20);
  assert.deepEqual(day.textQueueWait, { samples: 20, p50Ms: 1000, p95Ms: 1900 });
  assert.deepEqual(day.audioQueueWait, { samples: 20, p50Ms: 500, p95Ms: 950 });
  assert.deepEqual(day.textStage, { samples: 20, p50Ms: 10000, p95Ms: 19000 });
  assert.equal(day.rateLimitRetries, 5);
  assert.equal(day.fallbacks, 1);
  assert.deepEqual(view.days[0]!.audioQueueWait, { samples: 0, p50Ms: null, p95Ms: null });
  assert.equal((admin.stageLatency(...auth, 1) as { days: unknown[] }).days.length, 1, 'only the newest day');
  assert.throws(() => admin.stageLatency(...auth, 0), /INVALID_REQUEST/);
  assert.throws(() => admin.stageLatency(...auth, 32), /INVALID_REQUEST/);
  assert.throws(() => admin.stageLatency(owner.cookie, 'wrong-csrf', origin, 7));
  assert.throws(() => admin.stageLatency(owner.cookie, owner.csrf, 'https://evil.invalid', 7));
  assert.throws(() => admin.stageLatency('', '', origin, 7));
  const member = admin.issueMember(...auth, {
    requestId: crypto.randomUUID(),
    label: '协作管理员',
    memberId: null,
    permissions: ['invites.read'],
  });
  const session = admin.login(member.token!, origin);
  assert.throws(() => admin.stageLatency(session.cookie, session.csrf, origin, 7), /ADMIN_OWNER_REQUIRED/);
});
