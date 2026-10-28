import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { localRuntime, initProviderInstance } from '../../../apps/server/platform/web-local-config.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { WebProviderRunner } from '../../../apps/server/generation/web-provider-runner.ts';
import { WebProviderServer } from '../../../apps/server/generation/web-provider-server.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { migrateProvider, openProviderStore } from '../../../scripts/web-provider.ts';
import { syntheticSelection } from '../../../tests/web/fixtures/provider-selection.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../../tests/text-fixtures.ts';

/**
 * Part 22x: the signed-out page, signup and login in a REAL browser (Chromium): JavaScript runs, cookies are set and sent by the
 * browser, and nothing is replayed. The server is the provider-local listener over HTTPS with offline providers and a captured
 * mailbox; the player is the build in apps/player-web/dist (run `pnpm web:player:build` first).
 *
 * usage: node scripts/check-web-browser.ts [screenshot-dir]
 * Playwright is not a dependency of the repository: it is resolved from PLAYWRIGHT_MODULE, the working tree, or the usual global
 * tool directories, and the script exits with a clear message when no Chromium is available.
 */

type Cookie = { name: string; value: string; httpOnly: boolean; secure: boolean; expires: number };

// Playwright is not a repository dependency, so it has no types here.
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
function loadPlaywright(): any {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/node-tools/node_modules/playwright',
    '/opt/node22/lib/node_modules/playwright',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      return createRequire(import.meta.url)(candidate);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_MODULE to its directory');
}

const PASSWORD = 'correct horse battery';
const EMAIL = 'browser.player@example.com';
const { parent } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `provider-browser-${randomUUID().slice(0, 12)}`);
initProviderInstance(root);
migrateProvider(root, syntheticSelection());
const { config, store } = openProviderStore(root);
const clock = { now: () => Date.now() };
const budgetPath = join(root, 'browser-budget.sqlite');
WebProviderBudget.initialize(
  budgetPath,
  ['deepseek', 'fish'].map((provider) => ({
    source: 'synthetic',
    provider: provider as 'deepseek' | 'fish',
    digest: 'a'.repeat(64),
    spentMicros: 0,
    heldMicros: 0,
  })),
);
const shared = new WebProviderBudget(budgetPath, clock);
const ledger = new WebProviderOffline(store, clock);
for (const characterId of ['wei-guagua', 'jojo', 'chen-jimi'] as const) {
  const voiceVersion = `${characterId}-fish:v1`;
  ledger.registerApprovedFooter({
    characterId,
    voiceVersion,
    body: SYNTHETIC_TRIAL_FOOTER,
    wav: syntheticTone(),
    approved: true,
  });
  ledger.registerWelcome({
      characterId,
      voiceVersion,
      body: WEB_PROVIDER_WELCOME[characterId].text,
      wav: syntheticTone(),
    });
}
const running = () =>
  store.get<{ id: string }>("SELECT id FROM web_operations WHERE status='text_running' ORDER BY admission_seq LIMIT 1")!
    .id;
const text = new DeepSeekTextGenerator({
  apiKey: 'offline-only',
  fetch: async (_url, init) => {
    const { request } = readWebV7Request(store, running());
    const tool = JSON.parse(String(init?.body)).tools[0].function.name;
    return Response.json(tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request));
  },
});
const runner = new WebProviderRunner(
  store,
  clock,
  text,
  async (request) => ({ audio: syntheticTone(), receipt: { id: 'fake' }, usageUnits: request.billedTextBytes }),
  shared,
);
const mails: { to: string; kind: string; code: string | null }[] = [];
const app = new WebProviderServer(store, config, clock, runner, undefined, undefined, {
  signupEnabled: true,
  mailer: {
    send: async (message: { to: string; kind: string; code: string | null }) => void mails.push(message),
    waitUntil: (task: Promise<void>) => void task,
  },
  dailyCap: 50,
});
await app.listen();
export const origin = new URL(config.origin).origin;
export { config, mails, loadPlaywright };
export async function close() { await app.close(); shared.close(); try { store.close(); } catch {} }
