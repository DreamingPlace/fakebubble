import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { run24b6cChecks } from './console-24b6c-checks.ts';

/**
 * Part 24b-6c on its own (the same checks the 24b-6 audit now runs at its end): usage
 *   node scripts/check-web-console-24b6c-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 * The provider is the OFFLINE stand-in of the fixture: a scripted answer after a short wait. Nothing reaches a real provider.
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const f = await startConsoleFixture({ provider: { draftMs: 700, reviewMs: 700 } });
const problems: string[] = [];
const errors: string[] = [];
let failure: unknown = null;
try {
  const page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  const wait = (ms = 600) => page.waitForTimeout(ms);
  await run24b6cChecks({
    f,
    page,
    wait,
    open: async (route) => {
      await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
      await page.reload();
      await page.locator('.admin-content').first().waitFor({ timeout: 20_000 });
      await wait(1400);
    },
    shot: async (name) => {
      if (!shots) return;
      await wait(300);
      await page.screenshot({ path: join(shots, `${name}.png`) });
    },
    check: (condition, message) => {
      if (!condition) problems.push(message);
    },
    sizes: [
      [1280, 800],
      [1440, 900],
      [1920, 1080],
    ],
  });
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (problems.length) console.error(`24b-6c problems (${problems.length}):\n- ${problems.join('\n- ')}`);
if (errors.length) console.error(`page errors:\n${errors.join('\n')}`);
if (failure) console.error(failure);
if (problems.length || errors.length || failure) process.exitCode = 1;
else console.log('console 24b-6c browser check: PASS');
