import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensure } from '../packages/domain/errors.ts';
import { formatUsageReport, type UsageRow } from '../apps/server/generation/usage-report.ts';
import { currentPrices, type PriceTable } from '../apps/server/admission/web-model-settings.ts';

/**
 * `pnpm usage:report --receipt=/abs/inspect-receipt` (a staging/production deployment: the receipt file of the operator's
 * `inspect` action, which carries the aggregate usage rows) or `--database=/abs/web.sqlite` (a local provider instance, read-only).
 * Prints the average REAL cost per reply per model at list price; the owner recalibrates the points table from it.
 */
export function readUsageRows(args: string[]): UsageRow[] {
  const values = new Map(args.map((arg) => [arg.split('=')[0]!, arg.slice(arg.indexOf('=') + 1)]));
  const receipt = values.get('--receipt'),
    database = values.get('--database');
  ensure(args.length === 1 && (receipt ?? database) !== undefined, 'USAGE_REPORT_ARGUMENT_REQUIRED');
  if (receipt !== undefined) {
    ensure(isAbsolute(receipt), 'USAGE_REPORT_ABSOLUTE_PATH_REQUIRED');
    const lines = readFileSync(receipt, 'utf8').trim().split('\n');
    const last = JSON.parse(lines.at(-1)!) as {
      state?: string;
      action?: string;
      detail?: { usage?: { rows?: UsageRow[] } };
    };
    ensure(last.state === 'completed' && last.action === 'inspect', 'USAGE_REPORT_INSPECT_RECEIPT_REQUIRED');
    ensure(Array.isArray(last.detail?.usage?.rows), 'USAGE_REPORT_NO_USAGE_IN_RECEIPT');
    return last.detail.usage.rows;
  }
  ensure(isAbsolute(database!), 'USAGE_REPORT_ABSOLUTE_PATH_REQUIRED');
  const db = new DatabaseSync(database!, { readOnly: true });
  try {
    return db
      .prepare('SELECT * FROM web_provider_usage ORDER BY day,provider,model,phase')
      .all() as unknown as UsageRow[];
  } finally {
    db.close();
  }
}
/** The points table the report prices against: the receipt's (the deployment's own) or the local database's; undefined = the constants. */
export function readPointsTable(args: string[]): PriceTable | undefined {
  const values = new Map(args.map((arg) => [arg.split('=')[0]!, arg.slice(arg.indexOf('=') + 1)]));
  const receipt = values.get('--receipt'),
    database = values.get('--database');
  if (receipt !== undefined) {
    const last = JSON.parse(readFileSync(receipt, 'utf8').trim().split('\n').at(-1)!) as {
      detail?: { usage?: { points?: PriceTable } };
    };
    return last.detail?.usage?.points;
  }
  const db = new DatabaseSync(database!, { readOnly: true });
  try {
    return currentPrices({
      get: (sql, ...bindings) => db.prepare(sql).get(...(bindings as never[])) as never,
      all: (sql, ...bindings) => db.prepare(sql).all(...(bindings as never[])) as never,
    });
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    console.log(formatUsageReport(readUsageRows(args), readPointsTable(args)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'USAGE_REPORT_FAILED');
    process.exitCode = 1;
  }
}
