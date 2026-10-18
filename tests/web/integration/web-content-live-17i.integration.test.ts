import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { claimRetention } from '../../../apps/server/admission/web-stage-queue.ts';
import { requireWebContent } from '../../../apps/server/admission/web-retention.ts';
import { guestPurgeDue } from '../../../apps/server/identity/web-player-purge.ts';
import { inspectWebAuthority } from '../../../apps/server/cloudflare/web-inspect.ts';
import { webReplyLine } from '../../../apps/server/generation/web-reply-telemetry.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { enableModelChoice, modelFixture } from '../fixtures/model-choice.ts';
import { schema124 } from '../fixtures/model-settings.ts';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const characterId = 'fixture-character';

type Shape = {
  name: string;
  kind?: 'guest' | 'invite' | 'account';
  window?: 'in' | 'out';
  state?: 'purging' | 'purged';
  bonus?: boolean;
  login?: boolean;
  grant?: 'active' | 'lapsed';
  /** Registered by the 17h definition (flag on). */
  registered: boolean;
};
/** Every principal shape of Part 17i. `registered` is what the product says; the test also checks the rule says it. */
const SHAPES: Shape[] = [
  { name: 'plain guest in window', kind: 'guest', window: 'in', registered: false },
  { name: 'plain guest out of window', kind: 'guest', window: 'out', registered: false },
  { name: 'guest+bonus in window', kind: 'guest', window: 'in', bonus: true, registered: true },
  { name: 'guest+bonus out of window', kind: 'guest', window: 'out', bonus: true, registered: true },
  { name: 'guest+login without bonus out of window', kind: 'guest', window: 'out', login: true, registered: true },
  { name: 'invite active', kind: 'invite', grant: 'active', registered: false },
  { name: 'invite active with login', kind: 'invite', grant: 'active', login: true, registered: false },
  { name: 'invite lapsed with login', kind: 'invite', grant: 'lapsed', login: true, registered: true },
  { name: 'invite lapsed with bonus', kind: 'invite', grant: 'lapsed', bonus: true, registered: true },
  { name: 'invite lapsed with neither', kind: 'invite', grant: 'lapsed', registered: false },
  { name: 'account', kind: 'account', registered: false },
  { name: 'guest purging', kind: 'guest', state: 'purging', registered: false },
  { name: 'guest+bonus purging', kind: 'guest', state: 'purging', bonus: true, registered: true },
  { name: 'guest purged', kind: 'guest', state: 'purged', registered: false },
];

function world(t: TestContext) {
  const store = schema124();
  t.after(() => store.close());
  Object.assign(store, { webIpKeyFingerprint: () => 'f'.repeat(64) });
  enableModelChoice(store);
  let seq = 0;
  const admission = new WebAdmission(store as WebStore, { now: () => T0 }, () => `id-${++seq}`);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  let n = 0;
  const build = (shape: Shape) => {
    const name = `p${++n}`,
      playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, T0);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, characterId);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    if (shape.bonus) store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', principalId, T0);
    if (shape.login)
      store.run(
        'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
        principalId,
        `${name}@example.com`,
        'x',
        T0,
        T0,
        T0,
      );
    if (shape.window === 'out' || shape.window === 'in')
      store.run(
        "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=? WHERE principal_id=?",
        shape.window === 'out' ? T0 - 30 * DAY : T0 - DAY,
        shape.window === 'out' ? T0 - 23 * DAY : T0 + 6 * DAY,
        principalId,
      );
    if (shape.state)
      store.run(
        'UPDATE web_guest_retention SET state=?,started_at=?,expires_at=? WHERE principal_id=?',
        shape.state,
        T0 - 30 * DAY,
        T0 - 23 * DAY,
        principalId,
      );
    if (shape.kind === 'invite' || shape.kind === 'account') {
      store.run('UPDATE web_principals SET kind=?,revision=revision+1 WHERE id=?', shape.kind, principalId);
      store.run(
        "UPDATE web_guest_retention SET state='protected',started_at=NULL,expires_at=NULL,revision=revision+1 WHERE principal_id=?",
        principalId,
      );
    }
    if (shape.kind === 'invite') {
      store.db.exec('PRAGMA foreign_keys=OFF');
      store.run(
        'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?)',
        `grant-${name}`,
        `invite-${name}`,
        principalId,
        playerId,
        worldId,
        1,
        shape.grant === 'lapsed' ? T0 - DAY : null,
        null,
      );
    }
    return { principalId, worldId };
  };
  return { store, build };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'live';
};

/** The claim's own SQL, applied to a one-row stand-in for web_operations `o`. */
const claimable = (
  store: ReturnType<typeof schema124>,
  schema: number,
  flag: boolean,
  principalId: string,
  worldId: string,
) => {
  const retention = claimRetention(schema, T0, flag);
  return !!store.get(
    `SELECT 1 FROM (SELECT ? AS principal_id, ? AS world_id) o WHERE 1=1 ${retention.sql}`,
    principalId,
    worldId,
    ...retention.args,
  );
};

for (const flag of [true, false])
  test(`17i the JS rule and the SQL fragment agree for every principal shape (free tier ${flag ? 'on' : 'off'})`, (t) => {
    const w = world(t);
    Object.assign(w.store, { publicFreeTier: flag });
    const schema = w.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
    const clock = { now: () => T0 };
    const seen = new Set<string>();
    for (const shape of SHAPES) {
      const { principalId, worldId } = w.build(shape);
      const js = code(() => requireWebContent(w.store, clock, principalId, worldId));
      const sql = claimable(w.store, schema, flag, principalId, worldId);
      assert.equal(sql, js === 'live', `${shape.name}: SQL ${sql}, JS ${js}`);
      seen.add(`${shape.name}=${js}`);
      // What the product says: registered players (free tier on) are live in every shape but a purge; off, nothing changes.
      const expected =
        shape.state === undefined &&
        (shape.kind === 'account' ||
          (shape.kind === 'guest' && (shape.window === 'in' || (flag && shape.registered))) ||
          (shape.kind === 'invite' && (shape.grant === 'active' || (flag && shape.registered))));
      assert.equal(js === 'live', expected, `${shape.name} (flag ${flag}): ${js}`);
    }
    // The exact refusals are part of the rule too.
    assert.equal(seen.size, SHAPES.length);
  });

test('17i data safety: no cleaner selection and no markExpired guard touches a registered player; a plain guest is still due', (t) => {
  const w = world(t);
  Object.assign(w.store, { publicFreeTier: true });
  const due = guestPurgeDue(w.store, T0);
  const dueIds = new Set(
    w.store
      .all<{ principal_id: string }>(
        `SELECT r.principal_id FROM web_guest_retention r JOIN web_principals p ON p.id=r.principal_id
        WHERE (p.kind='guest' OR p.kind='invite' AND r.state='purging') AND ${due.sql}`,
        ...due.args,
      )
      .map((r) => r.principal_id),
  );
  const built = SHAPES.map((shape) => ({ shape, ...w.build(shape) }));
  const selected = new Set(
    w.store
      .all<{ principal_id: string }>(
        `SELECT r.principal_id FROM web_guest_retention r JOIN web_principals p ON p.id=r.principal_id
        WHERE (p.kind='guest' OR p.kind='invite' AND r.state='purging') AND ${due.sql}`,
        ...due.args,
      )
      .map((r) => r.principal_id),
  );
  assert.equal(dueIds.size, 0);
  for (const { shape, principalId } of built) {
    // Due only when a purge is under way ('purged' is finished) or the player is an unregistered guest past its window.
    const mustBeDue =
      shape.state === 'purging' || (shape.kind === 'guest' && shape.window === 'out' && !shape.registered);
    assert.equal(selected.has(principalId), mustBeDue, shape.name);
  }
  // The lapsed-invite-with-login shape: never selected, whatever the window columns say.
  const lapsed = built.find((b) => b.shape.name === 'invite lapsed with login')!;
  assert.equal(selected.has(lapsed.principalId), false);
  assert.equal(
    w.store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', lapsed.principalId)!
      .state,
    'protected',
  );
});

test('17i web_reply on a failed operation carries the stored failure code (a fixed code) and an age bucket', () => {
  // A reader holding only the operation row, like the 21i telemetry test: the line is a read of that row.
  const reader = (failure_code: string | null) =>
    ({
      get: (sql: string) =>
        sql.includes('FROM web_operations') ? { status: 'failed', failure_code, created_at: T0 } : undefined,
      all: () => [],
    }) as never;
  const line = webReplyLine(reader('TRIAL_EXPIRED'), 'x', T0 + 400_000)!;
  assert.deepEqual([line.outcome, line.failureCode, line.ageAtFailureMs], ['failed', 'TRIAL_EXPIRED', '>5m']);
  // Content in the column is never logged.
  assert.equal(webReplyLine(reader('some message with 合成 content'), 'x', T0)!.failureCode, null);
  const unset = webReplyLine(reader(null), 'x', T0 + 500)!;
  assert.deepEqual([unset.failureCode, unset.ageAtFailureMs], [null, '<1s']);
  assert.equal(webReplyLine(reader('X'), 'x', T0 + 5_000)!.ageAtFailureMs, '1-10s');
  assert.equal(webReplyLine(reader('X'), 'x', T0 + 30_000)!.ageAtFailureMs, '10-60s');
  assert.equal(webReplyLine(reader('X'), 'x', T0 + 120_000)!.ageAtFailureMs, '1-5m');
});

test('17i operator inspect names the running commit and, for each price in force, its upper_micros_per_unit and version', (t) => {
  const f = modelFixture(t, { chosen: 'deepseek', fetch: () => new Response('{}') });
  const view = inspectWebAuthority(
    { all: (sql, ...params) => f.store.all(sql, ...params) },
    { active: 'r2', inline: [], r2: [] },
    {},
    { available: false, error: 'WEB_INSPECT_BUDGET_UNAVAILABLE' },
    {},
    f.clock.now(),
  );
  assert.equal(typeof view.build.commit, 'string');
  const forced = view.prices.filter((price) => price.inForce);
  assert.ok(forced.length >= 3, 'prices are in force');
  for (const price of forced) {
    assert.equal(Number.isInteger(price.inForce!.version), true);
    assert.equal(price.inForce!.upperMicrosPerUnit > 0, true);
  }
  const row = f.get<{ version: number; upper_micros_per_unit: number }>(
    "SELECT version,upper_micros_per_unit FROM web_provider_prices WHERE id='deepseek-draft'",
  )!;
  const draft = view.prices.find((price) => price.inForce?.id === 'deepseek-draft')!;
  assert.deepEqual(
    [draft.inForce!.version, draft.inForce!.upperMicrosPerUnit],
    [row.version, row.upper_micros_per_unit],
  );
});
