/**
 * Part 22d review material: sample JSON from each new admin read route on a SEEDED SYNTHETIC database (a Node in-memory SQLite
 * through schema 130, synthetic characters and players, synthetic clock). Run from the repository root:
 *   node review/part-22d/samples-22d.ts review/part-22d/samples
 * Nothing here is real data.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { WebSecurityCounters, installWebAdminActions } from '../../apps/server/admin/web-admin-actions.ts';
import { WebSystemAdmin } from '../../apps/server/admin/web-system-admin.ts';
import { DAY, T0, tiersFixture } from '../../tests/web/fixtures/invite-tiers.ts';

const out = process.argv[2] ?? 'review/part-22d/samples';
mkdirSync(out, { recursive: true });
const HOUR = 3_600_000;
const fake = { test: () => undefined, after: (fn: () => void) => void process.on('exit', fn) } as never;
const f = tiersFixture(fake, { stats: true, extras: true });
installWebAdminActions(f.store);
const live = { now: () => f.clock() };
const admin = new WebSystemAdmin(f.store, live, f.accounts, {
  ops: undefined,
  security: new WebSecurityCounters(f.store, live),
  emailKey: Buffer.alloc(32, 7),
});
// Two synthetic characters with display names (the real table comes from the character schema; this is a stand-in).
f.store.run('CREATE TABLE web_character_versions(character_id TEXT,version INTEGER,profile_json TEXT)');
f.addCharacter('synthetic-b');
for (const [id, name] of [['fixture-character', '角色甲（合成）'], ['synthetic-b', '角色乙（合成）']] as const)
  f.store.run('INSERT INTO web_character_versions VALUES (?,1,?)', id, JSON.stringify({ presentation: { displayName: name } }));
const players = {
  guest: f.player('guest1'),
  registered: f.player('reg1', { signedUp: true }),
  refill: f.player('refill1', { signedUp: true }),
  unlimited: f.player('unl1', { signedUp: true }),
  tester: f.player('test1', { signedUp: true }),
};
f.redeem(players.refill, f.create(f.owner, { count: 1 }).codes![0]!);
f.redeem(players.unlimited, f.create(f.owner, { count: 1, tier: { kind: 'unlimited' } }).codes![0]!);
f.redeem(players.tester, f.create(f.owner, { count: 1, test: true }).codes![0]!);
// Three days of synthetic traffic: every few hours someone writes to one of the two characters.
let n = 0;
const kinds = Object.values(players);
for (let hour = 0; hour < 60; hour += 3) {
  f.setNow(T0 - 2 * DAY + hour * HOUR);
  const who = kinds[(hour / 3) % kinds.length]!;
  // a guest's trial is locked to one character and three replies
  if (who === players.guest && hour > 30) continue;
  const character = who === players.guest || hour % 2 === 0 ? 'fixture-character' : 'synthetic-b';
  f.finish(f.admit(who.principalId, `s-${++n}`, 'a', character).operationId, hour % 7 === 0 ? 'failed' : 'published');
  if (hour % 6 === 0) f.stats!.maintain(f.clock());
}
f.setNow(T0 + 10 * HOUR);
f.stats!.maintain(f.clock());
// Synthetic provider spend by user type (the real counters are written by the provider ledger; micros of USD).
f.store.run("UPDATE web_stats_daily SET day=? WHERE metric='extras_started'", new Date(T0 - 1 * DAY).toISOString().slice(0, 10));
let i = 0;
for (const day of [T0 - DAY, T0].map((t) => new Date(t).toISOString().slice(0, 10)))
  for (const type of ['test', 'unlimited', 'daily_refill', 'registered', 'guest'])
    for (const kind of ['text', 'voice'])
      f.store.run(
        'INSERT INTO web_stats_spend(day,user_type,kind,calls,charged_micros) VALUES (?,?,?,?,?)',
        day, type, kind, 3 + (i % 4), (kind === 'text' ? 2_100 : 9_800) * (1 + (i++ % 5)),
      );
const write = (name: string, value: unknown) => writeFileSync(`${out}/${name}.json`, JSON.stringify(value, null, 2) + '\n');
for (const [metric, range] of [['replies', '24h'], ['replies', '7d'], ['replies', '14d'], ['chat_users', '24h'], ['chat_users', '7d'], ['chat_users', '14d']] as const)
  write(`chart-${metric}-${range}`, admin.chart(f.owner, { metric, range }));
write('spend-by-type-7', admin.spendByType(f.owner, { range: 7 }));
