import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { topology54, type Player, type Topology54 } from '../fixtures/topology-54.ts';

/**
 * Part 54 ACCEPTANCE: the real edge, business Durable Object, budget and generation Workers in workerd; fake providers with
 * realistic latency (draft 2-5 s, review 2-5 s, voice 3-8 s, every 20th call 15 s). The business object carries the labelled model
 * of Cloudflare's 6-simultaneous-connections limit PER INVOCATION (see cloudflare-business-54-worker.ts).
 *
 * LOAD54_SCALE multiplies every provider wait and the whole schedule (1 = the real figures: 300 replies in 15 minutes, about
 * 17 minutes of wall time). The default 0.05 keeps `pnpm test` quick; thresholds scale with it (plus a fixed allowance for the
 * poll interval and workerd overhead, which do not scale).
 */
const SCALE = Number(process.env.LOAD54_SCALE ?? 0.05);
const MODEL = { CONNECTION_LIMIT: '6', CONNECTION_HUNG_MS: String(Math.round(90_000 * Math.max(SCALE, 0.2))), SIGNUP_BONUS_ENABLED: 'true' };
// 4 s of poll interval and workerd overhead, plus the 8 s voice-to-text fallback wait (a Worker var that does not scale with the providers).
const OVERHEAD_MS = 12_000;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0;
};
interface Sent {
  player: Player;
  id: string;
  at: number;
  voice: boolean;
}
interface Outcome {
  status: string;
  ms: number;
  voice: boolean;
}

/** 300 replies from 60 players over 15 minutes, with a burst of 50 replies inside 10 seconds. */
function schedule(scale: number) {
  const window = 15 * 60_000 * scale;
  let seed = 540;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const sends: { player: number; at: number; voice: boolean }[] = [];
  const perPlayer = new Array<number>(60).fill(0);
  const add = (player: number, at: number) => {
    perPlayer[player]!++;
    // Every reply asks for voice (the only delivery the app sends); one that cannot get a slot in time is published as text.
    sends.push({ player, at, voice: true });
  };
  // The burst: 50 different players, one reply each, inside 10 seconds, 40% of the way in.
  const burstAt = window * 0.4;
  for (let n = 0; n < 50; n++) add(n, burstAt + rand() * 10_000 * scale);
  // The other 250 replies: spread over the whole window, at most 5 per player in all.
  for (let n = 0; n < 250; n++) {
    let player = Math.floor(rand() * 60);
    while (perPlayer[player]! >= 5) player = (player + 1) % 60;
    add(player, rand() * window);
  }
  return sends.sort((a, b) => a.at - b.at);
}

async function drive(f: Topology54, players: Player[], plan: ReturnType<typeof schedule>, timeoutMs: number) {
  const started = Date.now();
  const outcomes: Outcome[] = [];
  // A player has at most one reply in flight in a real chat; a second message waits for the first (the app does that).
  const busy = new Map<number, Promise<void>>();
  const jobs: Promise<void>[] = [];
  for (const step of plan) {
    const wait = started + step.at - Date.now();
    if (wait > 0) await sleep(wait);
    const player = players[step.player]!;
    const previous = busy.get(step.player) ?? Promise.resolve();
    const run = previous.then(async () => {
      const at = Date.now();
      const id = await f.send(player, undefined, 'voice');
      const last = await f.poll(player, id, timeoutMs);
      outcomes.push({ status: last?.status ?? 'timeout', ms: Date.now() - at, voice: step.voice });
    });
    busy.set(step.player, run.catch(() => {}));
    jobs.push(run);
  }
  await Promise.all(jobs);
  return outcomes;
}

function replyLines(logs: string[]) {
  const lines: { outcome: string; voice: boolean }[] = [];
  for (const chunk of logs)
    for (const line of chunk.split('\n'))
      if (line.includes('"event":"web_reply"')) {
        try {
          lines.push(JSON.parse(line.slice(line.indexOf('{'))));
        } catch {
          /* a partial line */
        }
      }
  return lines;
}

test('LOAD: 300 replies from 60 players in 15 minutes with a burst of 50: zero hangs, >=99% published, p95 under the limits', async (t) => {
  const f = await topology54(t, undefined, MODEL);
  await f.install();
  await f.configure({ scale: SCALE, slowEvery: 20, slowMs: 15_000 });
  const players = await Promise.all(Array.from({ length: 60 }, (_, n) => f.newPlayer(n)));
  const plan = schedule(SCALE);
  const outcomes = await drive(f, players, plan, Math.max(120_000, 300_000 * SCALE));
  const conn = await f.business('/__test/connections');
  const stats = await f.stats();
  const published = outcomes.filter((o) => o.status === 'published');
  const all = published.map((o) => o.ms);
  const lines = replyLines(f.logs);
  const voiced = lines.filter((l) => l.outcome === 'published' && l.voice).length;
  const requestedVoice = published.length;
  const report = {
    scale: SCALE,
    replies: outcomes.length,
    published: published.length,
    byStatus: outcomes.reduce<Record<string, number>>((a, o) => ((a[o.status] = (a[o.status] ?? 0) + 1), a), {}),
    p95Ms: percentile(all, 95),
    p50Ms: percentile(all, 50),
    voiceRequestedAndPublished: requestedVoice,
    publishedWithVoice: voiced,
    publishedAsTextFallback: requestedVoice - voiced,
    maxProviderCallsInFlight: stats.maxInFlight,
    generationCalls: stats.roundTrips,
    sessionsOpened: stats.opens,
    invocationsSeen: conn.contexts,
    peakConnectionsOneInvocation: conn.peak,
    connectionsCancelledAsHung: conn.hung,
  };
  console.log('LOAD54 ' + JSON.stringify(report));
  assert.equal(conn.hung, 0, 'zero hangs: ' + JSON.stringify(report));
  assert.equal(outcomes.length, 300);
  assert.ok(published.length / outcomes.length >= 0.99, '>= 99% published: ' + JSON.stringify(report));
  // Every reply asks for voice, so the bound is the voice one (40 s); a reply that fell back to text is faster still.
  assert.ok(report.p95Ms < 40_000 * SCALE + OVERHEAD_MS, 'p95 to the reply: ' + JSON.stringify(report));
  assert.equal(stats.opens, 0, 'no generation session is opened for a reply: nothing can call back');
});

test('WEDGE: one provider call never returns, then 50 normal replies all succeed; the stuck one ends UNKNOWN within its deadline', async (t) => {
  const callTimeout = 4_000;
  const f = await topology54(t, undefined, { ...MODEL, TEXT_CALL_TIMEOUT_MS: String(callTimeout) });
  await f.install();
  await f.configure({ scale: 0.05, slowEvery: 0, hangFirst: 1, hangStage: 'draft' });
  const players = await Promise.all(Array.from({ length: 51 }, (_, n) => f.newPlayer(n)));
  const started = Date.now();
  const stuckId = await f.send(players[0]!);
  // The stuck call is the FIRST draft call: wait until generation has it before the normal replies start.
  while (!(await f.stats()).calls.some((c) => c.stage === 'draft')) await sleep(100);
  const rest = await Promise.all(players.slice(1).map((p) => f.send(p)));
  const results = await Promise.all(rest.map((id, n) => f.poll(players[1 + n]!, id, 120_000)));
  assert.deepEqual(
    results.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
    { published: 50 },
  );
  const stuck = await f.poll(players[0]!, stuckId, 60_000);
  const took = Date.now() - started;
  assert.equal(stuck.status, 'failed');
  // The call limit plus two budget calls and one poll interval; never the 90 s of the old behaviour.
  assert.ok(took < 2 * callTimeout + 8_000, `the stuck reply ended within its deadline (${took} ms)`);
  const tickets = (await f.business('/__test/tickets')) as { attempts: { state: string; n: number }[]; budgets: { reserved: number }[] };
  assert.equal(tickets.attempts.find((a) => a.state === 'unknown')?.n, 1, JSON.stringify(tickets));
  assert.ok(tickets.budgets.every((b) => b.reserved === 0), 'no running slot is left taken: ' + JSON.stringify(tickets));
  // The money stays held for the UNKNOWN call.
  const state = await f.business('/__test/state');
  assert.ok(state.spending.find((r: { provider: string }) => r.provider === 'deepseek').held_micros > 0);
});
