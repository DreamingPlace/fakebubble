import assert from 'node:assert/strict';
import type { WebAttemptBudget } from '../../../apps/server/budget/web-provider-budget-contract.ts';
import type { BusinessStore } from '../../../apps/server/platform/store-contract.ts';

type Key = { operationId: string; phase: string; ordinal: number };

/** Mirrors the shared budget authority: one reservation per attempt id, settled once, never released. */
export class MemoryBudget implements WebAttemptBudget {
  readonly calls: string[] = [];
  readonly entries = new Map<string, { settled: boolean; charged: number | null }>();
  private id(key: Key) {
    return `${key.operationId}:${key.phase}:${key.ordinal}`;
  }
  beginAttempt(_store: unknown, key: Key, resume = false) {
    const id = this.id(key);
    if (resume) {
      assert.equal(this.entries.get(id)?.settled, false, 'a retry reuses the still-held reservation');
      this.calls.push(`resume:${key.phase}:${key.ordinal}`);
      return;
    }
    assert.equal(this.entries.has(id), false, 'a reservation is never made twice');
    this.entries.set(id, { settled: false, charged: null });
    this.calls.push(`begin:${key.phase}:${key.ordinal}`);
  }
  settleAttempt(store: BusinessStore, key: Key) {
    const row = store.get<{ charged_micros: number }>(
      'SELECT charged_micros FROM web_provider_attempts WHERE operation_id=? AND phase=? AND ordinal=?',
      key.operationId,
      key.phase,
      key.ordinal,
    )!;
    assert.equal(this.entries.get(this.id(key))?.settled, false, 'settled once');
    this.entries.set(this.id(key), { settled: true, charged: row.charged_micros });
    this.calls.push(`settle:${key.phase}:${key.ordinal}`);
  }
  recoverKnown() {}
  /** Every reservation made is settled, and the sum charged. */
  reconcile() {
    let charged = 0;
    for (const [id, entry] of this.entries) {
      assert.equal(entry.settled, true, `${id} is settled`);
      charged += entry.charged ?? 0;
    }
    return { reservations: this.entries.size, charged };
  }
}
