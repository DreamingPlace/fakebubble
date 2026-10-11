// Usage: node screens.mjs <player build output dir> <png output dir>
// Serves the built player (real page modules) plus a synthetic-fixture harness, and takes 1440x900 screenshots.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [build, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = path === '/harness.html' ? join(here, 'harness.html') : path === '/harness/scene.js' ? join(here, 'scene.js') : join(build, path);
  if (!file.startsWith(build) && !file.startsWith(here)) return res.writeHead(403).end();
  if (!existsSync(file)) return res.writeHead(404).end('missing ' + path);
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && problems.push('console: ' + m.text()));
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, name + '.png') });
  console.log('wrote', name);
};
const openAdmin = async () => {
  await page.goto(`${base}/harness.html?scene=admin#/preview/wei-guagua`);
  await page.waitForSelector('.pw [data-run]');
  await page.waitForSelector('.pw tbody tr');
};

await openAdmin();
await shot('1-runs-table');
await page.click('.pw [data-run] tbody tr:nth-child(1)');
await page.waitForSelector('.admin-drawer:not([hidden]) .pw-diff');
await shot('2-drawer-success');
await page.keyboard.press('Escape');
await page.click('.pw [data-run] tbody tr:nth-child(2)');
await page.waitForSelector('.admin-drawer:not([hidden]) .pw-raw');
await shot('3-drawer-failure-rejected-output');
await page.keyboard.press('Escape');
// Compare the two runs.
await page.locator('input[data-compare]').nth(0).click();
await page.locator('input[data-compare]').nth(1).click();
await page.click('[data-compare-go]');
await page.waitForSelector('.admin-drawer-wide:not([hidden]) tbody tr');
await shot('4-compare');
await page.keyboard.press('Escape');
await page.click('button:has-text("编辑评测集")');
await page.waitForSelector('.pw-eval');
await page.click('[data-eval-set]');
await shot('5-eval-set-editor');

for (const [scene, name] of [['player-guest', '6-player-top-bar-guest'], ['player-trial-used', '7-player-top-bar-trial-used'], ['player-signed-in', '8-player-top-bar-signed-in']]) {
  await page.goto(`${base}/harness.html?scene=${scene}`);
  await page.waitForSelector('.site-head .head-actions');
  if (scene === 'player-signed-in') await page.click('.head-account');
  await shot(name);
}
await browser.close();
server.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
