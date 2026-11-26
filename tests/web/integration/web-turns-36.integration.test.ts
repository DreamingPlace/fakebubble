import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { topology54, type Player } from '../fixtures/topology-54.ts';

/**
 * Part 36 on the production topology (edge, business Durable Object with its ALARM, budget, generation; a fake provider network):
 *   - three bubbles are stored one by one; the business object's own alarm closes the batch after 4 s of quiet and ONE reply answers
 *     them (one draft + one review call, one voice call per clip: Part 54's round-trip count is unchanged);
 *   - five bubbles close the batch at once, without waiting for the alarm;
 *   - a bubble sent while she replies waits for the next turn;
 *   - a reload (a second read of the history) mid-batch shows every bubble;
 *   - one trial reply is charged per turn, not per bubble.
 */
const origin = 'https://fixture.invalid';
const api = '/api/web/provider';
const headers = (player: Player) => ({
  cookie: player.cookie,
  origin,
  'x-csrf-token': player.csrf,
  'content-type': 'application/json',
  'cf-connecting-ip': player.ip,
});

const bubble = async (f: Awaited<ReturnType<typeof topology54>>, player: Player, text: string, quoteMessageId?: string) => {
  const response = await f.call(
    {
      action: 'edge',
      path: `${api}/characters/wei-guagua/bubbles`,
      method: 'POST',
      headers: headers(player),
      body: { requestId: randomUUID(), text, ...(quoteMessageId ? { quoteMessageId } : {}) },
    },
    202,
  );
  return (await response.json()) as { messageId: string; conversationId: string; turn: { state: string; pending: number; operationId: string | null } };
};
const turn = async (f: Awaited<ReturnType<typeof topology54>>, player: Player) => {
  const response = await f.call({ action: 'edge', path: `${api}/characters/wei-guagua/turn`, headers: { cookie: player.cookie, 'cf-connecting-ip': player.ip } });
  return (await response.json()) as { state: string; pending: number; operationId: string | null };
};
const untilTurn = async (f: Awaited<ReturnType<typeof topology54>>, player: Player, wanted: (t: { state: string; pending: number; operationId: string | null }) => boolean, ms = 30_000) => {
  let last: { state: string; pending: number; operationId: string | null } | null = null;
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    last = await turn(f, player);
    if (wanted(last)) return last;
    await sleep(300);
  }
  throw new Error(`turn never reached the wanted state: ${JSON.stringify(last)}`);
};

test('three bubbles → ONE reply after 4 s of quiet (the alarm closes the batch); Part 54 round trips unchanged; one charge', async (t) => {
  const f = await topology54(t);
  await f.install();
  await f.configure({ scale: 0.01, slowEvery: 0 });
  const player = await f.newPlayer(1);
  const before = JSON.parse(JSON.stringify(await (await f.call({ action: 'edge', path: api + '/bootstrap', headers: { cookie: player.cookie, 'cf-connecting-ip': player.ip } })).json())) as { access: { remainingReplies: number } };
  const sentAt = Date.now();
  const sent = [];
  for (const text of ['在吗', '我刚下班', '今天好累']) sent.push(await bubble(f, player, text));
  assert.equal(sent[2]!.turn.state, 'collecting');
  assert.equal(sent[2]!.turn.pending, 3);
  // reload mid-batch: the history already holds all three, none answered yet
  const mid = (await (await f.call({ action: 'edge', path: `${api}/conversations/${sent[0]!.conversationId}/history`, headers: { cookie: player.cookie, 'cf-connecting-ip': player.ip } })).json()) as { messages: { text: string; operationId: string | null }[] };
  assert.deepEqual(mid.messages.filter((m) => m.operationId === null).map((m) => m.text), ['在吗', '我刚下班', '今天好累'], 'nothing is lost on reload, in order');
  const replying = await untilTurn(f, player, (s) => s.state === 'replying');
  assert.ok(Date.now() - sentAt >= 3_500, `the batch waited for the quiet period (${Date.now() - sentAt} ms)`);
  const done = await f.poll(player, replying.operationId!, 60_000);
  assert.equal(done.status, 'published', JSON.stringify(done));
  const stats = await f.stats();
  const speeches = stats.calls.filter((c) => c.stage === 'speech').length;
  assert.deepEqual(stats.calls.filter((c) => c.stage !== 'speech').map((c) => c.stage), ['draft', 'review'], 'one text call for the whole batch');
  assert.equal(stats.roundTrips, 1 + speeches, JSON.stringify(stats));
  assert.equal(stats.opens, 0);
  const after = (await (await f.call({ action: 'edge', path: api + '/bootstrap', headers: { cookie: player.cookie, 'cf-connecting-ip': player.ip } })).json()) as { access: { remainingReplies: number } };
  assert.equal(before.access.remainingReplies - after.access.remainingReplies, 1, 'one trial reply for three bubbles');
  const final = await untilTurn(f, player, (s) => s.state === 'idle');
  assert.equal(final.pending, 0);
});

test('five bubbles close the batch at once; a bubble sent while she replies waits for the next turn', async (t) => {
  const f = await topology54(t);
  await f.install();
  await f.configure({ scale: 0.05, slowEvery: 0 });
  const player = await f.newPlayer(2);
  let last: Awaited<ReturnType<typeof bubble>> | null = null;
  const started = Date.now();
  for (const text of ['一', '二', '三', '四', '五']) last = await bubble(f, player, text);
  assert.equal(last!.turn.state, 'replying', 'the fifth closes the batch inside its own request');
  assert.ok(Date.now() - started < 3_900, 'no wait for 4 s of quiet');
  const first = last!.turn.operationId!;
  const extra = await bubble(f, player, '她回复的时候我又发了一条');
  assert.equal(extra.turn.state, 'replying');
  assert.equal(extra.turn.operationId, first, 'still the first turn: the new bubble is not part of it');
  assert.equal(extra.turn.pending, 1);
  assert.equal((await f.poll(player, first, 60_000)).status, 'published');
  // the next turn: the quiet period, then a second reply for the one bubble
  const second = await untilTurn(f, player, (s) => s.state === 'replying' && s.operationId !== first, 40_000);
  assert.equal((await f.poll(player, second.operationId!, 60_000)).status, 'published');
  const stats = await f.stats();
  assert.equal(stats.calls.filter((c) => c.stage === 'draft').length, 2, 'two turns, two replies');
});

test('a quote of a message from another conversation is refused by the real edge; nothing is stored', async (t) => {
  const f = await topology54(t);
  await f.install();
  await f.configure({ scale: 0.01, slowEvery: 0 });
  const player = await f.newPlayer(3);
  const first = await bubble(f, player, '第一句');
  const ok = await bubble(f, player, '引用上一句', first.messageId);
  assert.ok(ok.messageId);
  const refused = await f.call(
    { action: 'edge', path: `${api}/characters/wei-guagua/bubbles`, method: 'POST', headers: headers(player), body: { requestId: randomUUID(), text: '引用别处', quoteMessageId: 'not-a-message-of-this-chat' } },
    404,
  );
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'QUOTE_UNAVAILABLE');
  const history = (await (await f.call({ action: 'edge', path: `${api}/conversations/${first.conversationId}/history`, headers: { cookie: player.cookie, 'cf-connecting-ip': player.ip } })).json()) as { messages: { text: string; quote?: { text: string | null } }[] };
  assert.deepEqual(history.messages.map((m) => m.text), ['第一句', '引用上一句']);
  assert.equal(history.messages[1]!.quote?.text, '第一句');
});

test('👍 / 👎 through the real edge: rate, switch, remove; CSRF and Origin; another player cannot rate her message', async (t) => {
  const f = await topology54(t);
  await f.install();
  await f.configure({ scale: 0.01, slowEvery: 0 });
  const a = await f.newPlayer(4);
  const b = await f.newPlayer(5);
  const sent = await bubble(f, a, '你好');
  const replying = await untilTurn(f, a, (s) => s.state === 'replying');
  assert.equal((await f.poll(a, replying.operationId!, 60_000)).status, 'published');
  const history = (await (await f.call({ action: 'edge', path: `${api}/conversations/${sent.conversationId}/history`, headers: { cookie: a.cookie, 'cf-connecting-ip': a.ip } })).json()) as {
    messages: { messageId: string; author: string; origin: string; operationId: string | null; audio: { mediaId: string | null } | null; rating?: unknown }[];
  };
  const reply = history.messages.find((m) => m.author === 'character' && m.origin === 'narrative' && m.operationId);
  assert.ok(reply, 'her reply is in the history');
  const rate = (player: Player, body: Record<string, unknown>, status = 200, extra: Record<string, string> = {}) =>
    f.call({ action: 'edge', path: `${api}/ratings`, method: 'POST', headers: { ...headers(player), ...extra }, body: { requestId: randomUUID(), conversationId: sent.conversationId, messageId: reply!.messageId, ...body } }, status).then((r) => r.json()) as Promise<{ rating: string | null; target: string | null }>;
  assert.deepEqual(await rate(a, { rating: 'up' }), { rating: 'up', target: null });
  assert.deepEqual(await rate(a, { rating: 'down', target: 'content' }), { rating: 'down', target: 'content' }, 'the other button switches it');
  const marked = (await (await f.call({ action: 'edge', path: `${api}/conversations/${sent.conversationId}/history`, headers: { cookie: a.cookie, 'cf-connecting-ip': a.ip } })).json()) as { messages: { messageId: string; rating?: { value: string; target: string } }[] };
  assert.deepEqual(marked.messages.find((m) => m.messageId === reply!.messageId)!.rating, { value: 'down', target: 'content' }, 'a reload shows the mark');
  assert.deepEqual(await rate(a, { rating: 'none' }), { rating: null, target: null });
  await rate(a, { rating: 'up' }, 403, { 'x-csrf-token': 'wrong' });
  await rate(a, { rating: 'up' }, 403, { origin: 'https://evil.invalid' });
  await rate(b, { rating: 'up' }, 404);
  await rate(a, { rating: 'up', messageId: 'welcome-clip' }, 404);
});
