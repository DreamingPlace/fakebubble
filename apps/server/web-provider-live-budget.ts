import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensure } from '../../packages/domain/errors.ts';
import { WebProviderBudget, type BudgetHistory } from './web-provider-budget.ts';

/** One explicitly configured authority for every local instance using the same provider accounts.
 * Never defaults to a new instance-local ledger or silently resets prior spending. */
export function liveBudgetAuthority() {
  const file = process.env.FAKEBUBBLE_BUDGET_AUTHORITY;
  ensure(typeof file === 'string' && isAbsolute(file), 'WEB_BUDGET_AUTHORITY_REQUIRED');
  const stat = lstatSync(file);
  ensure(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600 &&
      stat.size > 0 &&
      stat.size <= 16_384,
    'WEB_BUDGET_AUTHORITY_INVALID',
  );
  const value = JSON.parse(readFileSync(file, 'utf8')) as { budgetPath?: string; historyRoots?: string[] };
  ensure(
    value &&
      Object.keys(value).sort().join(',') === 'budgetPath,historyRoots' &&
      typeof value.budgetPath === 'string' &&
      isAbsolute(value.budgetPath) &&
      Array.isArray(value.historyRoots) &&
      value.historyRoots.every((p) => typeof p === 'string' && isAbsolute(p)) &&
      new Set(value.historyRoots).size === value.historyRoots.length,
    'WEB_BUDGET_AUTHORITY_INVALID',
  );
  return { budgetPath: value.budgetPath, historyRoots: value.historyRoots };
}
export const liveBudgetPath = () => liveBudgetAuthority().budgetPath;

/** Read-only, no chat, credentials, private voice references, or media are imported. */
export function readLiveBudgetHistory(): BudgetHistory[] {
  const history: BudgetHistory[] = [];
  const instances = new Set<string>();
  for (const root of liveBudgetAuthority().historyRoots) {
    ensure(realpathSync(root) === root, 'WEB_SHARED_HISTORY_INVALID');
    const db = new DatabaseSync(join(root, 'web.sqlite'), { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; BEGIN');
      const instance = db.prepare('SELECT instance_id FROM web_instance WHERE singleton=1').get()!;
      ensure(
        typeof instance.instance_id === 'string' && !instances.has(instance.instance_id),
        'WEB_SHARED_HISTORY_INVALID',
      );
      instances.add(instance.instance_id);
      const assets = readdirSync(root)
        .filter((n) => /^asset-render-.*\.json$/.test(n))
        .sort()
        .map((n) => {
          const data = readFileSync(join(root, n));
          const items = JSON.parse(data.toString('utf8')) as { upperUSDMicros: number; billedBytes: number }[];
          ensure(
            Array.isArray(items) &&
              items.length > 0 &&
              items.every(
                (r) =>
                  Number.isSafeInteger(r.billedBytes) && r.billedBytes > 0 && r.upperUSDMicros === r.billedBytes * 15,
              ),
            'WEB_SHARED_HISTORY_INVALID',
          );
          return {
            file: n,
            digest: createHash('sha256').update(data).digest('hex'),
            micros: items.reduce((sum, r) => sum + r.upperUSDMicros, 0),
          };
        });
      for (const provider of ['deepseek', 'fish'] as const) {
        const total = db
          .prepare('SELECT spent_micros,held_micros FROM web_provider_spending WHERE provider=?')
          .get(provider) as { spent_micros: number; held_micros: number };
        const attempts = db
          .prepare(`SELECT operation_id,phase,ordinal,state,held_micros,charged_micros,
          wire_request_hash FROM web_provider_attempts WHERE provider=? ORDER BY operation_id,phase,ordinal`)
          .all(provider);
        ensure(
          total &&
            total.spent_micros === attempts.reduce((sum, r) => sum + Number(r.charged_micros ?? 0), 0) &&
            total.held_micros ===
              attempts.reduce((sum, r) => sum + (r.state === 'known' ? 0 : Number(r.held_micros)), 0),
          'WEB_SHARED_HISTORY_INVALID',
        );
        const relevantAssets = provider === 'fish' ? assets : [];
        history.push({
          source: `${root}:${instance.instance_id}`,
          provider,
          digest: createHash('sha256')
            .update(JSON.stringify([total, attempts, relevantAssets]))
            .digest('hex'),
          spentMicros: total.spent_micros + relevantAssets.reduce((s, r) => s + r.micros, 0),
          heldMicros: total.held_micros,
        });
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  }
  return history;
}

export function openLiveBudget() {
  const history = readLiveBudgetHistory();
  const budget = new WebProviderBudget(liveBudgetPath(), { now: () => Date.now() });
  try {
    budget.verifyHistory(history);
    return budget;
  } catch (error) {
    budget.close();
    throw error;
  }
}
