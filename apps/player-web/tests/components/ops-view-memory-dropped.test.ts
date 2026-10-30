import assert from 'node:assert/strict';
import test from 'node:test';
import { opsView } from '../../src/features/admin/ops-view.ts';
import type { StageLatencyDay } from '../../src/services/account-admin-api.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

const none = { samples: 0, p50Ms: null, p95Ms: null };
const cache = { calls: 0, hitTokens: 0, missTokens: 0, hitRatio: null };
const day = (memoryDropped: { topics: number; facts: number }): StageLatencyDay => ({
  day: '2026-10-11',
  operations: 4,
  textQueueWait: none,
  audioQueueWait: none,
  textStage: none,
  audioStage: none,
  rateLimitRetries: 0,
  fallbacks: 0,
  review: { samples: 0, changed: 0, rate: null },
  memoryDropped,
  cache: { draft: cache, review: cache },
  embedding: { calls: 0, texts: 0, failures: 0, unknowns: 0, queryFallbacks: 0, queryTimeouts: 0 },
});

test('运营数据 shows the daily count of replies delivered with dropped topics / facts', async (t) => {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const view = opsView(root, {
    load: async () => [day({ topics: 3, facts: 1 })],
    run: (work) => work(),
    disposed: () => false,
  });
  await view.load();
  const node = root as unknown as FakeElement;
  // Named exception (Part 24b-6): the table is an open-below grid now (header cells .ot-cell in .ot-head, rows .ot-row).
  const headers = node.querySelectorAll('.ot-head .ot-cell').map((th) => th.textContent);
  assert.ok(headers.includes('话题/事实丢弃'), headers.join('|'));
  const cells = node.querySelectorAll('.ot-row .ot-cell').map((td) => td.textContent);
  // A numeric cell carries its hover value (Part 24b-6), so the visible text starts the cell's text.
  assert.ok(
    cells.some((c) => c.startsWith('3/1')),
    cells.join('|'),
  );
});
