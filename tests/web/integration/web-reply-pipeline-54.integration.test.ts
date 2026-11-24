import test from 'node:test';
import assert from 'node:assert/strict';
import { topology54, type Topology54, type Player } from '../fixtures/topology-54.ts';

/**
 * Part 54 (P0): replies hang, then the pipeline stays wedged. The real edge + business Durable Object + budget + generation
 * Workers run in workerd; only the PROVIDER NETWORK is fake. Cloudflare's limit of 6 simultaneous outbound connections per
 * invocation is not enforced by workerd, so the business object is built with a labelled MODEL of it (see
 * cloudflare-business-54-worker.ts): CONNECTION_LIMIT=6, and a connection that cannot progress is cancelled after
 * CONNECTION_HUNG_MS (90 000 in production; shortened here only so the test is quick).
 */
const MODEL = { CONNECTION_LIMIT: '6', CONNECTION_HUNG_MS: '20000' };
const tally = (results: { status: string }[]) => {
  const by: Record<string, number> = {};
  for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
  return by;
};
async function burst(f: Topology54, players: Player[], timeoutMs: number) {
  const ids = await Promise.all(players.map((p) => f.send(p)));
  return Promise.all(ids.map((id, n) => f.poll(players[n]!, id, timeoutMs)));
}

test('(a) HANG: a burst of 50 replies under the 6-connection limit all publish, and nothing hangs', async (t) => {
  const f = await topology54(t, undefined, MODEL);
  await f.install();
  await f.configure({ scale: 0.1, slowEvery: 0 });
  const players = await Promise.all(Array.from({ length: 50 }, (_, n) => f.newPlayer(n)));
  const results = await burst(f, players, 120_000);
  const conn = await f.business('/__test/connections');
  const by = tally(results);
  assert.deepEqual(by, { published: 50 }, JSON.stringify({ by, conn }));
  assert.equal(conn.hung, 0, 'no connection may be cancelled as hung: ' + JSON.stringify(conn));
});

test('(b) WEDGE: UNKNOWN calls must not use up the running slots; replies keep working afterwards', async (t) => {
  const f = await topology54(t);
  await f.install();
  // 21 draft calls never answer (the capacity is 20 text stages). Everything after them is a normal reply.
  await f.configure({ scale: 0.1, slowEvery: 0, hangFirst: 21, hangStage: 'draft' });
  const players = await Promise.all(Array.from({ length: 40 }, (_, n) => f.newPlayer(n)));
  const stuck = await burst(f, players.slice(0, 21), 200_000);
  assert.ok(
    stuck.every((r) => ['failed', 'unknown'].includes(r.status)),
    'stuck replies end (failed/unknown), they are not left running: ' + JSON.stringify(tally(stuck)),
  );
  const fresh = await burst(f, players.slice(21, 26), 120_000);
  const tickets = await f.business('/__test/tickets');
  assert.deepEqual(tally(fresh), { published: 5 }, JSON.stringify(tickets));
});

test('(c) a reply that ends UNKNOWN must not block the same player; their next message gets a normal reply', async (t) => {
  const f = await topology54(t);
  await f.install();
  await f.configure({ scale: 0.1, slowEvery: 0, hangFirst: 1, hangStage: 'draft' });
  const [player] = await Promise.all([f.newPlayer(0)]);
  const first = await f.send(player!);
  const ended = await f.poll(player!, first, 200_000);
  assert.ok(['failed', 'unknown'].includes(ended.status), JSON.stringify(ended));
  const next = await f.send(player!, '再说一句');
  const reply = await f.poll(player!, next, 100_000);
  assert.equal(reply.status, 'published', JSON.stringify(reply));
});
