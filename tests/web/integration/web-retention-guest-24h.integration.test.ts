import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60_000;
type Client = { cookie: string; csrf: string; peer?: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
type Sweep = { processed: number; failed: number; error: string | null };
type Health = {
  failing: number;
  failures: { code: string; phase: string; sub: string; table?: string; count: number }[];
};
type TableRow = { table: string; worldId: boolean; operationId: boolean; worldRows: number; operationRows: number };
type World = {
  rows: Record<string, number>;
  retention: { state: string; db_cleared_at: number | null };
  foreignKeyViolations: number;
};

/**
 * Part 24h. A production guest was stuck for ever on WEB_RETENTION_UNEXPECTED_WORLD_DATA (clearDatabase / audit_source). This is
 * the guest who uses every player feature that writes a per-world or per-operation row today, expires, and is purged by the
 * real sweep (clearDatabase, then the file erase) on workerd SQLite.
 */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-cross-path-worker.ts',
    { STATE: 'WebCrossPathFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  let tokens = 0;
  const call = async (path: string, actor: Client, body?: unknown, status = 200, turnstile?: string) => {
    const response = await runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        ...(turnstile ? { 'x-turnstile-token': `good-${turnstile}-${++tokens}` } : {}),
        ...(actor.peer ? { 'x-fixture-peer': actor.peer } : {}),
        'x-fixture-host': 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, status, text);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) actor.cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return result;
  };
  const settle = async (actor: Client, id: string, timeout = 30_000) => {
    const end = Date.now() + timeout;
    while (true) {
      const operation = await call(`${API}/operations/${id}`, actor);
      if (['published', 'failed', 'cancelled'].includes(operation.status)) return operation;
      assert.ok(Date.now() < end, JSON.stringify(operation));
      await sleep(100);
    }
  };
  const reply = async (actor: Client, text: string, timeout?: number) => {
    const sent = await call(
      `${API}/characters/wei-guagua/operations`,
      actor,
      { requestId: randomUUID(), text, delivery: 'voice' },
      202,
    );
    assert.equal((await settle(actor, sent.operation.operationId, timeout)).status, 'published');
  };
  const boot = async (actor: Client) =>
    (await call(`${API}/bootstrap`, actor, undefined, 200, 'guest')).access.principalId as string;
  const signUp = async (actor: Client, email: string) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(`${API}/account/request-code`, actor, { purpose: 'signup', email }, 200, 'code');
    let mail: Mail | undefined;
    for (let i = 0; i < 100 && !mail; i++) {
      const list = await runtime.call<Mail[]>('/fixture/player-mail');
      if (list.length > before) mail = list.at(-1);
      else await sleep(20);
    }
    await call(`${API}/account/verify-code`, actor, { challengeId: challenge.challengeId, code: mail!.code });
    return call(`${API}/account/signup`, actor, {
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname: '阿泡',
      adult: true,
    });
  };
  return { call, reply, boot, signUp, fixture: runtime.call };
}

/** What may remain of a purged player: shells of ids, times and counters, never content. */
const SHELLS = new Set([
  'world_characters',
  'conversations',
  'participants',
  'contacts',
  'web_principals',
  'web_operations',
  'web_sessions',
  'web_guest_retention',
  'web_invite_grants',
  'web_external_attempts',
  'web_provider_attempts',
  'cf_web_audio_objects',
  'web_operation_metrics',
  'web_attempt_rejections',
  'web_free_operations',
  'web_operation_models',
  'web_provider_backups',
  'web_operation_user_types',
]);

async function expiredGuest(t: test.TestContext, peer: string) {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', {
    signupEnabled: true,
    accountDelete: true,
    legalPages: true,
    graceMs: DAY,
    turnstile: true,
  });
  // Model choice, the signup bonus (free trial and points) and chat review are all on, as in production.
  await f.fixture('/fixture/cross/choice', { on: true });
  await f.fixture('/fixture/cross/signup-switch', { on: true });
  await f.fixture('/fixture/cross/review-switch', { on: true });
  const actor: Client = { cookie: '', csrf: '', peer };
  const principalId = await f.boot(actor);
  // The email login and the 名片 (nickname card), then text and voice chat: a voice reply, a reply that fell back to text
  // (the only delivery the player API accepts is 'voice'), and a third, each with its model choice and points charge.
  await f.signUp(actor, 'guest-24h@example.com');
  await f.reply(actor, '第一句，语音');
  await f.fixture('/fixture/world/speech-fail', { on: true });
  await f.reply(actor, '语音失败后的文字回复', 120_000);
  await f.fixture('/fixture/world/speech-fail', { on: false });
  await f.reply(actor, '第三句，语音');
  // Co-creation.
  await f.call(
    `${API}/cocreation/submit`,
    actor,
    { characterId: 'wei-guagua', requestId: 'co-24h', answers: [{ cardId: 'catchphrase', text: '哎呀妈呀' }] },
    201,
  );
  // Memory, relationship and scene jobs, embeddings, chat-review code and sampling, points and billing rows.
  await f.fixture('/fixture/world/seed', { principalId, code: 'K7M2' });
  return { f, actor, principalId };
}

test('a guest who uses every player feature (including reply-time query embeddings) is purged by the sweep and the cleared audit passes', async (t) => {
  const { f, principalId } = await expiredGuest(t, '10.24.0.1');
  // The reply-time embedding of the player's input (schema 116, kind 'query') is keyed by the operation, not only the world.
  assert.ok((await f.fixture<{ seeded: number }>('/fixture/world/seed-query-embeds', { principalId })).seeded >= 3);
  const before = await f.fixture<World>('/fixture/world/state', { principalId });
  for (const table of [
    'messages',
    'memory_facts',
    'web_embed_attempts',
    'web_cocreation_submissions',
    'web_points_events',
    'web_player_logins',
    'web_signup_bonus',
    'web_provider_media_assets',
  ])
    assert.ok(before.rows[table]! > 0, `${table} holds rows before the purge`);

  await f.fixture('/fixture/world/age', { principalId, ms: 181 * DAY });
  const sweep = await f.fixture<Sweep>('/fixture/world/sweep');
  const health = await f.fixture<Health>('/fixture/world/health');
  assert.deepEqual(
    { sweep, failures: health.failures.map((x) => [x.code, x.phase, x.sub, x.table]) },
    { sweep: { processed: 1, failed: 0, error: null }, failures: [] },
    'the purge completes; if it fails, the health names the failing table',
  );
  const after = await f.fixture<World>('/fixture/world/state', { principalId });
  assert.equal(after.retention.state, 'purged');
  assert.ok(after.retention.db_cleared_at !== null);
  assert.equal(after.foreignKeyViolations, 0);
  assert.deepEqual(
    Object.keys(after.rows).filter((table) => !SHELLS.has(table)),
    [],
    'only shells remain',
  );
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId }), { clean: true, loginsRemain: false });
  assert.equal(health.failing, 0);
});

test('every table with a world_id or operation_id that holds this guest’s rows is a known purge table (the map in the PR body)', async (t) => {
  const { f, principalId } = await expiredGuest(t, '10.24.0.2');
  await f.fixture('/fixture/world/seed-query-embeds', { principalId });
  const map = await f.fixture<TableRow[]>('/fixture/world/table-map', { principalId });
  const used = map.filter((row) => row.worldRows > 0 || row.operationRows > 0).map((row) => row.table);
  // NAMED EXCEPTION: the unknown-table check itself is the audit's; here we only pin that no table outside the three
  // audit lists (shells / handled / operationContent+providerShells) is written for a guest by the features above. A new
  // table must be added to a list on purpose, and a content table to a cleaner.
  const known = new Set([
    ...SHELLS,
    // Part 26b: frozen review model, shell (no content)
    'web_operation_review_models',
    'web_local_events',
    'web_user_events',
    'web_input_snapshots',
    'web_v7_requests',
    'web_v7_candidates',
    'web_private_audio_assets',
    'web_publications',
    'web_publication_items',
    'web_provider_outputs',
    'web_provider_candidates',
    'web_provider_voice_segments',
    'web_provider_media_assets',
    'web_stage_attempts',
    'web_synthetic_voice_segments',
    'web_reviewed_candidates',
    'web_local_text_outputs',
    'web_local_audio_outputs',
    'web_points_events',
    'messages',
    'jobs',
    'memory_facts',
    'memory_embeddings',
    'web_embed_attempts',
    'memory_episode_sources',
    'memory_mentions',
    'memory_episodes',
    'memory_corrections',
    'memory_catalog',
    'memory_context_versions',
    'memory_topics',
    'relationship_corrections',
    'relationship_reviews',
    'relationship_events',
    'relationship_job_contexts',
    'relationship_daily_budgets',
    'relationship_states',
    'scene_events',
    'scene_job_contexts',
    'scene_end_requests',
    'scene_states',
    'job_evidence_snapshots',
    'dialogue_bubbles',
    'outbox',
    'player_profile_versions',
    'player_profile_requests',
    // Part 24k-2 (named exception): the welcome line a player was given; removed with the player by purgePlayerLogins.
    'web_welcome_choices',
    'web_retention_file_cleanup',
  ]);
  assert.deepEqual(
    used.filter((table) => !known.has(table)),
    [],
    'a table the guest wrote is in no audit list',
  );
});

test('the failing check is named: a table outside every audit list fails closed with its name, a check label otherwise, never an id', async (t) => {
  const { f, principalId } = await expiredGuest(t, '10.24.0.3');
  await f.fixture('/fixture/world/age', { principalId, ms: 181 * DAY });
  // A table the audit does not know, holding a row of this world: the audit must still refuse (fail closed) and say which.
  assert.deepEqual(await f.fixture('/fixture/world/create-table', { name: 'zz_unknown_24h', principalId }), {
    created: true,
  });
  const sweep = await f.fixture<Sweep>('/fixture/world/sweep');
  assert.deepEqual(sweep, { processed: 1, failed: 1, error: 'WEB_RETENTION_UNEXPECTED_WORLD_DATA' });
  const health = await f.fixture<Health>('/fixture/world/health');
  assert.deepEqual(
    health.failures.map((x) => [x.code, x.phase, x.sub, x.table, x.count]),
    [['WEB_RETENTION_UNEXPECTED_WORLD_DATA', 'clearDatabase', 'audit_source', 'zz_unknown_24h', 1]],
  );
  const serialized = JSON.stringify(health) + JSON.stringify(await f.fixture('/fixture/world/reports'));
  for (const secret of [principalId, 'guest-24h', '阿泡', '第一句'])
    assert.ok(!serialized.includes(secret), `the failure detail does not contain ${secret}`);
  // The reports carry the same table name.
  const reports = await f.fixture<{ table?: string }[]>('/fixture/world/reports');
  assert.deepEqual(
    reports.map((r) => r.table),
    ['zz_unknown_24h'],
  );
});
