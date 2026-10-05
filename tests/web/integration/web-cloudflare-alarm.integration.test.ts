import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; issuedToken: string; csrf: string };
type State = { alarm: number | null; due: number | null; error: string | null;
  coordinator: { epoch: number; coordinator_expires_at: number };
  operations: { id: string; status: string; deadline_at: number; quota_state: string }[];
  attempts: { phase: string; state: string; outcome: string | null; held_micros: number }[];
  calls: { provider: string; n: number }[];
  budgets: { provider: string; spent_micros: number; held_micros: number }[] };
const setup = (t: test.TestContext) => localRuntime(t, 'tests/web/fixtures/cloudflare-alarm-worker.ts',
  { STATE: 'WebAlarmFixture' }, ['MEDIA']);
const admission = (guest: Guest, n = 1) => ({ token: guest.issuedToken, csrf: guest.csrf,
  origin: 'https://fixture.invalid', ipHash: 'a'.repeat(64),
  input: { characterId: 'wei-guagua', requestId: `alarm-${n}`, text: '离线持久 Alarm' } });
async function until(f: ReturnType<typeof setup>, predicate: (value: State) => boolean, milliseconds = 20_000) {
  const end = Date.now() + milliseconds;
  do {
    const value = await f.call<State>('/alarm-status');
    if (predicate(value)) return value;
    assert.ok(Date.now() < end, JSON.stringify(value));
    await sleep(100);
  } while (true);
}

test('actual persistent alarms drive three guest rounds after restart, then become idle without resending', async t => {
  const f = setup(t); await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  assert.equal((await f.call<State>('/alarm-status')).alarm, null);
  for (let n = 1; n <= 3; n++) {
    const op = await f.call<{ operationId: string }>('/admit', admission(guest, n));
    assert.notEqual((await f.call<State>('/alarm-status')).alarm, null);
    await f.restart();
    await until(f, s => s.operations.some(row => row.id === op.operationId && row.status === 'published') && s.alarm === null);
  }
  const state = await f.call<{ principal: { trial_used: number; trial_reserved: number }; messages: { body: string }[] }>('/state', { token: guest.issuedToken });
  assert.deepEqual(state.principal, { trial_used: 3, trial_reserved: 0 });
  assert.equal(state.messages.filter(row => row.body === '有空一定要来找我呀～').length, 1);
  const before = await f.call<State>('/alarm-status');
  assert.equal(before.due, null); assert.equal(before.calls.find(row => row.provider === 'text')!.n, 6);
  await f.restart(); await f.call('/wake');
  const after = await until(f, s => s.alarm === null);
  assert.deepEqual(after.calls, before.calls); assert.deepEqual(after.budgets, before.budgets);
});

test('alarm recovers known R2 audio after stale lease/restart without another speech call for that segment', async t => {
  const f = setup(t); await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  await f.call('/fault', { mode: 'stale-on-put' });
  await f.call('/admit', admission(guest));
  await until(f, s => s.attempts.some(row => row.phase === 'speech' && row.state === 'known') && s.operations[0]?.status === 'audio_running');
  await f.restart();
  const state = await until(f, s => s.operations[0]?.status === 'published' && s.alarm === null);
  const storage = await f.call<{ tables: { name: string; n: number }[] }>('/storage');
  assert.equal(state.calls.find(row => row.provider === 'speech')!.n,
    storage.tables.find(row => row.name === 'media_assets')!.n);
});

test('uncertain Alarm output is never retried, survives restart, and original deadline releases quota but not provider hold', async t => {
  const f = setup(t); await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  await f.call('/alarm-mode', { mode: 'unknown' });
  await f.call('/admit', admission(guest));
  const before = await until(f, s => s.operations[0]?.status === 'unknown');
  assert.equal(before.due, before.operations[0]!.deadline_at);
  assert.ok(before.budgets.find(row => row.provider === 'fish')!.held_micros > 0);
  await f.restart(); await f.call('/wake');
  await until(f, s => s.alarm !== null && s.alarm === s.due);
  assert.deepEqual((await f.call<State>('/alarm-status')).calls, before.calls);
  await f.call('/expire');
  const after = await until(f, s => s.operations[0]?.status === 'failed' && s.alarm === null);
  assert.equal(after.operations[0]!.quota_state, 'released');
  assert.deepEqual(after.calls, before.calls); assert.deepEqual(after.budgets, before.budgets);
});

test('a real 32-second provider await renews the 30-second coordinator while preserving the stage lease', async t => {
  const f = setup(t); await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  await f.call('/alarm-mode', { mode: 'slow-text' });
  await f.call('/admit', admission(guest));
  const state = await until(f, s => s.operations[0]?.status === 'published' && s.alarm === null, 50_000);
  assert.equal(state.calls.find(row => row.provider === 'text')!.n, 2);
  assert.ok(state.attempts.every(row => row.state === 'known' && row.outcome === 'succeeded'));
});

test('slow audio does not block newly admitted text in another principal during an Alarm task', async t => {
  const f = setup(t); await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {}), other = await f.call<Guest>('/bootstrap', {});
  await f.call('/alarm-mode', { mode: 'hold-speech' });
  await f.call('/admit', admission(guest));
  await until(f, s => s.calls.some(row => row.provider === 'speech'));
  try {
    await f.call('/admit', { ...admission(other), ipHash: 'b'.repeat(64) });
    const state = await until(f, s => s.calls.find(row => row.provider === 'text')?.n === 4, 4_000);
    assert.equal(state.operations[0]!.status, 'audio_running');
  } finally { await f.call('/release-speech'); }
  await until(f, s => s.operations.every(row => row.status === 'published') && s.alarm === null);
});

test('workerd restart during sent speech waits out the old coordinator and never replays the uncertain call', async t => {
  const f = setup(t); await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  await f.call('/alarm-mode', { mode: 'hold-speech' });
  await f.call('/admit', admission(guest));
  const sent = await until(f, s => s.attempts.some(row => row.phase === 'speech' && row.state === 'sent'));
  const epoch = sent.coordinator.epoch;
  await f.restart();
  const reopened = await f.call<State>('/alarm-status');
  assert.equal(reopened.coordinator.epoch, epoch);
  assert.deepEqual(reopened.calls, sent.calls);
  const recovered = await until(f, s => s.operations[0]?.status === 'unknown', 45_000);
  assert.ok(recovered.coordinator.epoch > epoch);
  assert.deepEqual(recovered.calls, sent.calls); assert.deepEqual(recovered.budgets, sent.budgets);
  assert.equal(recovered.due, sent.operations[0]!.deadline_at);
});
