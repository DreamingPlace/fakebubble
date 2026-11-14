/**
 * Lint gate. Biome's recommended rules are on except those that still report findings (see biome.json); any finding
 * from an enabled rule, error or warning, fails the check.
 *
 * Suppression comments for a rule that is off ("suppressions/unused") are tolerated: they become live again the day
 * the rule is turned on, so they are kept as they are.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = spawnSync(
  'pnpm',
  ['exec', 'biome', 'lint', '--max-diagnostics=100000', '--reporter=json', '--colors=off', '.'],
  { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
const out = run.stdout ?? '';
const start = out.indexOf('{');
if (start < 0) {
  console.error(`lint: biome produced no report\n${run.stderr}`);
  process.exit(1);
}
const report = JSON.parse(out.slice(start)) as {
  diagnostics: { category: string; severity: string; message: string; location?: { path?: unknown } }[];
};
const findings = report.diagnostics.filter((d) => d.category !== 'suppressions/unused');
if (findings.length > 0) {
  for (const d of findings.slice(0, 50)) {
    const path = d.location?.path;
    const file = typeof path === 'string' ? path : ((path as { file?: string } | undefined)?.file ?? '?');
    console.error(`${d.severity} ${d.category} ${file}: ${d.message}`);
  }
  console.error(`lint: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log('lint: clean');
