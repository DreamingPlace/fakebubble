import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensure } from '../packages/domain/errors.ts';
import { formatUsageReport, type UsageRow } from '../apps/server/generation/usage-report.ts';

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
if (import.meta.main) {
  try {
    console.log(formatUsageReport(readUsageRows(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'USAGE_REPORT_FAILED');
    process.exitCode = 1;
  }
}
