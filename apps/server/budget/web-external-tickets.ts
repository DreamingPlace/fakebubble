import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 54: an UNKNOWN provider call keeps its MONEY (held_micros stays held until the owner checks the bill) but it does not keep
 * its RUNNING-SLOT ticket. The ticket (web_external_budgets.reserved) bounds how many calls run at once; before this part an
 * UNKNOWN call kept it forever, so every call killed at the timeout permanently removed one of the 20 text / 4 voice slots and
 * after enough of them every reply failed at the claim, at any volume.
 *
 * A row that went UNKNOWN carries this marker in usage_json (an unknown row has no usage yet), so the ticket is freed exactly
 * once, however the row got there, and a legacy UNKNOWN row (no marker) is recognised and freed by healLegacyUnknownTickets.
 */
export const TICKET_FREED = '{"ticketFreed":true}';

type Selector = { operationId: string; stage?: 'text' | 'audio'; phase?: string; ordinal?: number };

/** sent -> unknown for the matching rows, freeing each ticket. Returns how many rows changed. */
export function markExternalAttemptsUnknown(store: BusinessStore, selector: Selector): number {
  const rows = store.all<{ stage: string; phase: string; ordinal: number; provider: string }>(
    `SELECT stage,phase,ordinal,provider FROM web_external_attempts
    WHERE operation_id=? AND dispatch_state='sent'
      ${selector.stage === undefined ? '' : 'AND stage=?'}
      ${selector.phase === undefined ? '' : 'AND phase=?'}
      ${selector.ordinal === undefined ? '' : 'AND ordinal=?'}`,
    selector.operationId,
    ...(selector.stage === undefined ? [] : [selector.stage]),
    ...(selector.phase === undefined ? [] : [selector.phase]),
    ...(selector.ordinal === undefined ? [] : [selector.ordinal]),
  );
  let changed = 0;
  for (const row of rows) {
    const updated = store.run(
      `UPDATE web_external_attempts SET dispatch_state='unknown',usage_json=?
      WHERE operation_id=? AND stage=? AND phase=? AND ordinal=? AND dispatch_state='sent'`,
      TICKET_FREED,
      selector.operationId,
      row.stage,
      row.phase,
      row.ordinal,
    ).changes;
    if (updated === 1) {
      store.run(
        `UPDATE web_external_budgets SET reserved=reserved-1 WHERE provider=? AND stage=? AND phase=? AND reserved>0`,
        row.provider,
        row.stage,
        row.phase,
      );
      changed++;
    }
  }
  return changed;
}

/** UNKNOWN rows written before this part still hold a ticket: free each once. Cheap (indexed by state); safe to repeat. */
export function healLegacyUnknownTickets(store: BusinessStore): number {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_external_attempts'")) return 0;
  const rows = store.all<{ operation_id: string; stage: string; phase: string; ordinal: number; provider: string }>(
    "SELECT operation_id,stage,phase,ordinal,provider FROM web_external_attempts WHERE dispatch_state='unknown' AND usage_json IS NULL LIMIT 500",
  );
  for (const row of rows) {
    const updated = store.run(
      `UPDATE web_external_attempts SET usage_json=?
      WHERE operation_id=? AND stage=? AND phase=? AND ordinal=? AND dispatch_state='unknown' AND usage_json IS NULL`,
      TICKET_FREED,
      row.operation_id,
      row.stage,
      row.phase,
      row.ordinal,
    ).changes;
    if (updated === 1)
      store.run(
        `UPDATE web_external_budgets SET reserved=reserved-1 WHERE provider=? AND stage=? AND phase=? AND reserved>0`,
        row.provider,
        row.stage,
        row.phase,
      );
  }
  return rows.length;
}
