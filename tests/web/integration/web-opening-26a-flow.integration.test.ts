import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { localRuntime, initProviderInstance } from '../../../apps/server/platform/web-local-config.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { WebProviderRunner } from '../../../apps/server/generation/web-provider-runner.ts';
import { WebProviderServer } from '../../../apps/server/generation/web-provider-server.ts';
import { WebInviteAdmin } from '../../../apps/server/invites/web-invite-admin.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';
import { migrateProvider, openProviderStore } from '../../../scripts/web-provider.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';

type Client = { cookie: string; csrf: string };
type Reply = { status: number; data: any; bytes: Buffer; headers: Record<string, unknown> };
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const API = '/api/web/provider';

/**
 * Part 26a fix: the opening through the REAL path - a fresh guest over HTTPS: bootstrap, first send, second send. Both frozen
 * requests carry the welcome of the character's published revision. (The chat's 「X已添加了你」 note is page-only: nothing of
 * it is stored as a message, so it cannot take the opening away.)
 */
test('26a a fresh guest: bootstrap, first send, second send - the opening is in both frozen requests', async (t) => {
  const { parent, port } = localRuntime();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `provider-it-${randomUUID().slice(0, 12)}`);
  initProviderInstance(root);
  migrateProvider(root, syntheticSelection());
  let { config, store } = openProviderStore(root);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  });
  const clock = { now: () => Date.now() };
  const budgetPath = join(root, 'test-shared-budget.sqlite');
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
  t.after(() => shared.close());
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
    if (characterId !== 'chen-jimi')
      ledger.registerWelcome({
        characterId,
        voiceVersion,
        body: WEB_PROVIDER_WELCOME[characterId].text,
        wav: syntheticTone(),
      });
  }
  let textCalls = 0,
    fishCalls = 0;
  let stallText = false;
  const running = () =>
    store.get<{ id: string }>(
      "SELECT id FROM web_operations WHERE status='text_running' ORDER BY admission_seq LIMIT 1",
    )!.id;
  const text = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      textCalls++;
      if (stallText)
        return new Promise<never>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(Error('offline aborted unknown call')), { once: true });
        });
      const { request } = readWebV7Request(store, running());
      const tool = JSON.parse(String(init?.body)).tools[0].function.name;
      return Response.json(tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request));
    },
  });
  const runner = new WebProviderRunner(
    store,
    clock,
    text,
    async (request) => {
      fishCalls++;
      assert.ok(request.speech.voice.referenceId.startsWith('synthetic-'));
      assert.equal(request.speech.qualityGuard, true);
      assert.ok(JSON.parse(request.body).features.includes('quality-guard'));
      return { audio: syntheticTone(), receipt: { id: `fake-${fishCalls}` }, usageUnits: request.billedTextBytes };
    },
    shared,
  );
  let app = new WebProviderServer(store, config, clock, runner);
  await app.listen();
  t.after(() => app.close());

  const ca = readFileSync(join(root, 'local-cert.pem'));
  const call = (
    method: string,
    path: string,
    actor: Client,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolveReply, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          servername: '',
          port,
          path,
          method,
          ca,
          agent: false,
          headers: {
            ...(actor.cookie ? { Cookie: actor.cookie } : {}),
            ...(payload
              ? { Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': actor.csrf }
              : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks),
              cookie = res.headers['set-cookie']?.[0]?.split(';')[0];
            if (cookie && res.headers['set-cookie']![0]!.includes('Max-Age=0'))
              actor.cookie = actor.cookie
                .split('; ')
                .filter((part) => !part.startsWith(cookie.split('=')[0] + '='))
                .join('; ');
            else if (cookie && !cookie.includes('_admin=')) actor.cookie = cookie;
            else if (cookie) actor.cookie = [actor.cookie, cookie].filter(Boolean).join('; ');
            let data: any = null;
            try {
              data = JSON.parse(raw.toString('utf8'));
            } catch {
              /* audio */
            }
            if (typeof data?.csrf === 'string') actor.csrf = data.csrf;
            resolveReply({
              status: res.statusCode ?? 0,
              data,
              bytes: raw,
              headers: res.headers as Record<string, unknown>,
            });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
  const settle = async (actor: Client, operationId: string) => {
    for (let i = 0; i < 200; i++) {
      const reply = await call('GET', `${API}/operations/${operationId}`, actor);
      assert.equal(reply.status, 200);
      if (['published', 'failed', 'cancelled'].includes(reply.data.status)) return reply.data;
      await pause(25);
    }
    throw Error('operation did not settle');
  };
  const send = async (actor: Client, characterId: string, textBody: string) =>
    call('POST', `${API}/characters/${characterId}/operations`, actor, {
      requestId: randomUUID(),
      text: textBody,
      delivery: 'voice',
    });

  const guest: Client = { cookie: '', csrf: '' };
  const boot = parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, guest)).data);
  const welcome = boot.characters.find((item) => item.characterId === 'wei-guagua')!.welcome.text;
  assert.equal(welcome, WEB_PROVIDER_WELCOME['wei-guagua'].text);
  const operations: string[] = [];
  for (const line of ['你好呀', '第二句']) {
    const reply = await send(guest, 'wei-guagua', line);
    assert.equal(reply.status, 202);
    operations.push(reply.data.operation.operationId);
    assert.equal((await settle(guest, reply.data.operation.operationId)).status, 'published');
  }
  assert.equal(
    store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind NOT IN ('player','character')")!.n,
    0,
    'the chat stores nothing but dialogue',
  );
  const frozen = operations.map((id) => readWebV7Request(store, id).request);
  for (const request of frozen) assert.deepEqual(request.opening, { text: welcome });
  assert.equal(frozen[0]!.messages.length, 1);
  assert.ok(frozen[1]!.messages.length > 1, 'the second request carries the first turn');
  // It never became a player fact or a memory.
  assert.equal(JSON.stringify(frozen.map((r) => [r.playerFacts, r.memories])).includes(welcome), false);
});
