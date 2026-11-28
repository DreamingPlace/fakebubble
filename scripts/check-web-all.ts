import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Part 50: runs every browser check, ONE AT A TIME (they share ports, a display and a lot of CPU, so parallel runs only cause flakes).
 * A new Part adds its `scripts/check-web-<name>-browser.ts` and nothing else: this runner finds the scripts by their file name, so
 * package.json no longer needs a line per Part (the existing `check:web:*` lines stay as they are).
 *
 *   pnpm check:web:all                       every script, then the table
 *   pnpm check:web:all -- part-44 share-45   only the scripts whose name contains one of the words
 *
 * Run `pnpm web:player:build` first. Per-script output goes to work/check-web-all/<name>.log (the last lines are printed for a failure);
 * the table (name, exit code, seconds) is printed and written to work/check-web-all/results.json. Exit code 0 only if nothing failed.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(root, 'scripts');
const out = join(root, 'work', 'check-web-all');

/** Known stale scripts: found by the file name like every other one, but skipped, each for its written reason. */
const SKIP: Record<string, string> = {
  // The admin-console layout audit of 24b-7c pins the pre-V3 layout of the console; it was superseded by the 24b-6 console checks.
  'admin-24b7c': 'pins a console layout that 24b-6 replaced',
  // The cast-file check pins the old (pre schema 2) cast page controls; the cast file itself is covered by unit and integration tests.
  'cast-file': 'pins the pre-schema-2 cast page; the file format is covered by unit and integration tests',
  // The 24b-2 console check pins the first console layout, later replaced by V3 (24b-3 and on); kept for history, not run.
  'console-24b2': 'pins the first console layout, replaced by V3',
};

/** `check-web-<name>-browser.ts`, plus the two scripts whose package.json names are `check:web:browser` and `check:web:history`. */
function discover(files: string[]) {
  const names = new Set<string>();
  for (const file of files) {
    const match = /^check-web-(.+)-browser\.ts$/.exec(file);
    if (match) names.add(match[1]!);
  }
  names.add('browser'); // scripts/check-web-browser.ts (check:web:browser)
  names.add('history-24f'); // scripts/check-web-history-24f-browser.ts (check:web:history)
  return [...names].sort((a, b) => a.localeCompare(b));
}
const fileOf = (name: string) => (name === 'browser' ? 'check-web-browser.ts' : `check-web-${name}-browser.ts`);

const words = process.argv.slice(2).filter((word) => word !== '--');
const all = discover(readdirSync(scripts)).filter((name) => readdirSync(scripts).includes(fileOf(name)));
const chosen = words.length ? all.filter((name) => words.some((word) => name.includes(word))) : all;
if (!chosen.length) {
  console.error(`no browser check matches ${words.join(' ')}; known: ${all.join(', ')}`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

interface Row {
  name: string;
  exit: number | 'skipped';
  seconds: number;
  note?: string;
}
const rows: Row[] = [];
for (const name of chosen) {
  if (SKIP[name]) {
    rows.push({ name, exit: 'skipped', seconds: 0, note: SKIP[name]! });
    console.log(`- ${name}: skipped (${SKIP[name]})`);
    continue;
  }
  const started = Date.now();
  const log = join(out, `${name}.log`);
  console.log(`> ${name} ...`);
  const exit = await new Promise<number>((done) => {
    const stream = createWriteStream(log);
    const child = spawn(process.execPath, [join(scripts, fileOf(name))], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on('error', () => done(127));
    child.on('close', (code) => {
      stream.end();
      done(code ?? 1);
    });
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  rows.push({ name, exit, seconds });
  if (exit !== 0) console.log(readFileSync(log, 'utf8').split('\n').slice(-15).join('\n'));
}

const width = Math.max(...rows.map((row) => row.name.length), 4);
const line = (a: string, b: string, c: string) => `${a.padEnd(width)}  ${b.padStart(7)}  ${c.padStart(8)}`;
console.log(`\n${line('name', 'exit', 'seconds')}`);
for (const row of rows)
  console.log(line(row.name, String(row.exit), row.exit === 'skipped' ? '-' : row.seconds.toFixed(1)));
writeFileSync(join(out, 'results.json'), `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`);
const failed = rows.filter((row) => row.exit !== 0 && row.exit !== 'skipped');
console.log(
  `\n${rows.length - failed.length}/${rows.length} ok (${failed.length} failed); table: work/check-web-all/results.json`,
);
process.exit(failed.length ? 1 : 0);
