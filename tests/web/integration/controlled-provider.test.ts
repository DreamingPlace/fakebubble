import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlledProvider, ManualClock } from './controlled-provider.ts';

test('fixture self-check: a held audio call does not block a different text call', async () => {
  const clock = new ManualClock(10), provider = new ControlledProvider(clock);
  provider.script('a', 'audio', 0, { kind: 'ok', value: 'clip-a' }, true);
  const slow = provider.invoke('a', 'audio');
  provider.script('b', 'text', 0, { kind: 'ok', value: 'draft-b' });
  clock.advance(7);
  assert.deepEqual(await provider.invoke('b', 'text'), { kind: 'ok', value: 'draft-b' });
  assert.deepEqual(provider.calls.map(call => call.atMs), [10, 17]);
  provider.release('a', 'audio');
  assert.deepEqual(await slow, { kind: 'ok', value: 'clip-a' });
});

test('fixture self-check: partial audio and unknown receipt have exact call counts', async () => {
  const provider = new ControlledProvider(new ManualClock());
  provider.script('round', 'audio', 0, { kind: 'ok', value: 'clip-0' });
  provider.script('round', 'audio', 1, { kind: 'rate_limited', retryAfterMs: 100 });
  provider.script('round', 'audio', 1, { kind: 'unknown' });
  assert.equal((await provider.invoke('round', 'audio', 0)).kind, 'ok');
  assert.equal((await provider.invoke('round', 'audio', 1)).kind, 'rate_limited');
  assert.equal((await provider.invoke('round', 'audio', 1)).kind, 'unknown');
  assert.equal(provider.count('round', 'audio', 0), 1);
  assert.equal(provider.count('round', 'audio', 1), 2);
  await assert.rejects(provider.invoke('round', 'audio', 1), /unscripted provider call/);
});
