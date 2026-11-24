import test from 'node:test';
import assert from 'node:assert/strict';
import { topology54 } from '../fixtures/topology-54.ts';

/**
 * Part 54: a reply costs at most two calls to the generation Worker (the text call, and the voice call as its own call), each a
 * single call with plain data and a single result. No generation session is opened, so nothing can call back into the business
 * object while a reply is made, and nothing the business object sends is a function.
 */
test('a text reply is ONE call to generation and a voice reply is that call plus its voice call; no session, no callback', async (t) => {
  const f = await topology54(t);
  await f.install();
  await f.configure({ scale: 0.01, slowEvery: 0 });
  const [a, b] = await Promise.all([f.newPlayer(1), f.newPlayer(2)]);
  const textId = await f.send(a, '只要文字', 'text');
  const text = await f.poll(a, textId, 60_000);
  assert.equal(text.status, 'published', JSON.stringify(text));
  let stats = await f.stats();
  assert.equal(stats.roundTrips, 1, 'a text reply is exactly one call and one return: ' + JSON.stringify(stats));
  assert.equal(stats.opens, 0);
  assert.deepEqual(
    stats.calls.map((c) => c.stage),
    ['draft', 'review'],
  );
  await f.configure({ scale: 0.01 });
  const voiceId = await f.send(b, '要语音', 'voice');
  const voice = await f.poll(b, voiceId, 60_000);
  assert.equal(voice.status, 'published', JSON.stringify(voice));
  stats = await f.stats();
  const speeches = stats.calls.filter((c) => c.stage === 'speech').length;
  assert.ok(speeches >= 1, 'the reply has a voice');
  assert.equal(stats.roundTrips, 1 + speeches, 'one text call plus one call per voice clip: ' + JSON.stringify(stats));
  assert.equal(stats.opens, 0, 'no generation session is ever opened for a reply');
});
