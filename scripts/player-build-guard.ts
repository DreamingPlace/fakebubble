import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Part 27: every browser script serves apps/player-web/dist. When that build is missing, or older than the player sources it was
 * built from, the script stops at once with the one instruction that fixes it, instead of waiting out a TimeoutError on a page that
 * is blank or shows yesterday's UI. Import this module FIRST (it runs when imported, before a fixture starts anything).
 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = join(root, 'apps/player-web/dist/player-manifest.json');
const MESSAGE = 'run pnpm web:player:build first';

/** The newest modification time (ms) of any file under `dir` (0 when it is missing). */
function newest(dir: string): number {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

if (!existsSync(manifest)) {
  console.error(`player build is missing: ${MESSAGE}`);
  process.exit(1);
}
const builtAt = statSync(manifest).mtimeMs;
const sourceAt = Math.max(newest(join(root, 'apps/player-web/src')), newest(join(root, 'packages')));
if (sourceAt > builtAt + 1000) {
  console.error(`player build is stale (a source file is newer than the build): ${MESSAGE}`);
  process.exit(1);
}
