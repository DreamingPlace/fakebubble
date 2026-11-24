import test from 'node:test';
import assert from 'node:assert/strict';
import { topology54 } from '../fixtures/topology-54.ts';

/**
 * Part 54: a reply costs at most two calls to the generation Worker (the text call, and the voice call as its own call), each a
 * single call with plain data and a single result. No generation session is opened, so nothing can call back into the business
 * object while a reply is made, and nothing the business object sends is a function.
 */
test('a reply is ONE call to generation for its text and one call per voice clip; no session, no callback', async (t) => {
  const f = await topology54(t);
  await f.install();
  await f.configure({ scale: 0.01, slowEvery: 0 });
  const player = await f.newPlayer(1);
  const id = await f.send(player, '要语音', 'voice');
  const reply = await f.poll(player, id, 60_000);
  assert.equal(reply.status, 'published', JSON.stringify(reply));
  const stats = await f.stats();
  const speeches = stats.calls.filter((c) => c.stage === 'speech').length;
  assert.ok(speeches >= 1, 'the reply has a voice');
  assert.deepEqual(
    stats.calls.filter((c) => c.stage !== 'speech').map((c) => c.stage),
    ['draft', 'review'],
    'both text stages run inside the ONE text call',
  );
  assert.equal(stats.roundTrips, 1 + speeches, 'one text call plus one call per voice clip: ' + JSON.stringify(stats));
  assert.equal(stats.opens, 0, 'no generation session is ever opened for a reply');
});
