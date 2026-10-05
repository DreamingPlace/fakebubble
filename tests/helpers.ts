import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { CharacterScope, Clock, RandomSource } from '../packages/contracts/index.ts';
import { testCharacters } from '../packages/domain/defaults.ts';
import { Engine } from '../apps/server/engine.ts';
import { Store } from '../apps/server/store.ts';
import { DomainError } from '../packages/domain/errors.ts';

export const at = (value: string) => Date.parse(value);
export class FakeClock implements Clock {
  value: number;
  constructor(value = '2026-09-07T08:00:00+08:00') { this.value = at(value); }
  now() { return this.value; }
  set(value: string) { this.value = at(value); }
  advance(ms: number) { this.value += ms; }
}
export class SequenceRandom implements RandomSource {
  calls = 0;
  values: number[];
  constructor(values = [0.99]) { this.values = values; }
  next() { return this.values[this.calls++] ?? this.values.at(-1)!; }
}
export function setup(t: TestContext, time?: string, values?: number[]) {
  const store = new Store();
  t.after(() => store.close());
  const clock = new FakeClock(time);
  const random = new SequenceRandom(values);
  const engine = new Engine(store, { clock, random, delayRandom: { next: () => 0 } });
  for (const role of testCharacters()) engine.registerTemplate(role);
  const context = engine.createWorld('player-1', testCharacters().map(role => ({ characterId: role.id, relationship: 'friend' as const })));
  const scopes = testCharacters().map(role => ({ ...context, characterId: role.id,
    conversationId: engine.createConversation(context, [role.id]) }));
  return { store, clock, random, engine, context, scopes, scope: scopes[0]! };
}
export function send(engine: Engine, scope: CharacterScope, body = '测试消息', requestId: string = randomUUID()) {
  return engine.receivePlayer(scope, { conversationId: scope.conversationId, requestId, text: body, targetCharacterIds: [scope.characterId] });
}
export function answer(engine: Engine, scope: CharacterScope) {
  const job = engine.claimReply(scope);
  assert.ok(job);
  return engine.publish(scope, job.id, { text: '明确标记的测试回复', coveredMessageIds: job.messageIds,
    delivery: 'text', endsSession: job.mustClose });
}
export function rejects(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}
