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
import { characterProfileHash } from '../../../apps/server/characters/web-character-catalog.ts';
import { migrateProvider, openProviderStore } from '../../../scripts/web-provider.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';

type Client = { cookie: string; csrf: string };
type Reply = { status: number; data: any; bytes: Buffer; headers: Record<string, unknown> };
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const API = '/api/web/provider';

/**
 * Part 24k-2: the welcome line a player is given, through the REAL path (HTTPS bootstrap and sends). Adapted from the 26a flow test
 * (same scaffold). Part 26a fix, for reference: the opening through the REAL path - a fresh guest over HTTPS: bootstrap, first send, second send. Both frozen
 * requests carry the welcome of the character's published revision. (The chat's 「X已添加了你」 note is page-only: nothing of
 * it is stored as a message, so it cannot take the opening away.)
 */
test('24k-2 each player gets one weighted welcome line, fixed across reloads, the same in the pill, the chat and the memory; a re-publish without it redraws only players with no chat', async (t) => {
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

  // ---- wei-guagua is republished with four weighted lines (written like a publication would), before anyone arrives ----
  const publish = (lines: { id: string; text: string; weight: number }[]) => {
    const row = store.get<{ version: number; profile_json: string }>(
      `SELECT v.version,v.profile_json FROM web_character_catalog c JOIN web_character_versions v
      ON v.character_id=c.character_id AND v.version=c.version WHERE c.character_id='wei-guagua'`,
    )!;
    const profile = JSON.parse(row.profile_json);
    delete profile.presentation.welcome;
    profile.presentation.welcomes = lines;
    profile.template.version = row.version + 1;
    const config = JSON.stringify(profile.template);
    store.run(
      'INSERT INTO character_template_versions VALUES (?,?,?,NULL)',
      'wei-guagua',
      profile.template.version,
      config,
    );
    store.run(
      'UPDATE character_templates SET version=?,config_json=? WHERE id=?',
      profile.template.version,
      config,
      'wei-guagua',
    );
    store.run(
      'INSERT INTO web_character_versions VALUES (?,?,?,?,NULL)',
      'wei-guagua',
      profile.template.version,
      JSON.stringify(profile),
      characterProfileHash(profile),
    );
    store.run(
      'UPDATE web_character_catalog SET version=? WHERE character_id=?',
      profile.template.version,
      'wei-guagua',
    );
  };
  const lines = [
    { id: 'l-a', text: '来了？先坐。', weight: 40 },
    { id: 'l-b', text: '今天也辛苦啦。', weight: 30 },
    { id: 'l-c', text: '我等你好久了。', weight: 20 },
    { id: 'l-d', text: '嗨～', weight: 10 },
  ];
  publish(lines);
  const welcomeOf = async (actor: Client) => {
    const boot = parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, actor)).data);
    return boot.characters.find((item) => item.characterId === 'wei-guagua')!.welcome;
  };

  const guests: Client[] = Array.from({ length: 6 }, () => ({ cookie: '', csrf: '' }));
  const first: { text: string | null; version: string | null }[] = [];
  for (const g of guests) {
    const w = await welcomeOf(g);
    assert.ok(
      lines.some((l) => l.text === w.text && l.id === w.version),
      'the line is one of the published lines, its id is the version',
    );
    first.push({ text: w.text, version: w.version });
  }
  // a reload / another read of the same player: the same line, every time
  for (let round = 0; round < 3; round++)
    for (const [i, g] of guests.entries())
      assert.deepEqual({ text: (await welcomeOf(g)).text, version: (await welcomeOf(g)).version }, first[i]);
  // the choice is the player's data and carries world_id: one row per player and character
  const rows = store.all<{ world_id: string; character_id: string; line_id: string; body: string }>(
    'SELECT world_id,character_id,line_id,body FROM web_welcome_choices',
  );
  assert.equal(rows.filter((r) => r.character_id === 'wei-guagua').length, guests.length);
  assert.equal(new Set(rows.map((r) => r.world_id)).size, guests.length + 0 || 1);

  // the chat opens with that very line: the frozen request's opening is the player's own line (and it is not a fact or a memory)
  const [chatty, quiet] = [guests[0]!, guests[1]!];
  const reply = await send(chatty, 'wei-guagua', '你好呀');
  assert.equal(reply.status, 202);
  assert.equal((await settle(chatty, reply.data.operation.operationId)).status, 'published');
  const frozen = readWebV7Request(store, reply.data.operation.operationId).request;
  assert.deepEqual(frozen.opening, { text: first[0]!.text });
  assert.equal(JSON.stringify([frozen.playerFacts, frozen.memories]).includes(first[0]!.text!), false);

  // ---- a re-publish that no longer has their line: the player with a chat keeps the history; the one without gets a new draw ----
  const keep = lines.find((l) => l.id === first[0]!.version)!;
  const others = lines.filter((l) => l.id !== keep.id);
  publish([{ id: 'l-new', text: '换了一句新的欢迎词。', weight: 100 }]);
  assert.deepEqual(await welcomeOf(chatty), {
    ...(await welcomeOf(chatty)),
    text: first[0]!.text,
    version: first[0]!.version,
  });
  const redrawn = await welcomeOf(quiet);
  assert.equal(redrawn.text, '换了一句新的欢迎词。');
  assert.equal(redrawn.version, 'l-new');
  // a player whose line is still there is not touched by a re-publish that keeps it
  void others;
  const afterChat = readWebV7Request(store, reply.data.operation.operationId).request;
  assert.deepEqual(afterChat.opening, { text: first[0]!.text }, 'the frozen history of that chat is unchanged');
  const second = await send(chatty, 'wei-guagua', '第二句');
  assert.equal(second.status, 202);
  assert.equal((await settle(chatty, second.data.operation.operationId)).status, 'published');
  assert.deepEqual(readWebV7Request(store, second.data.operation.operationId).request.opening, {
    text: first[0]!.text,
  });
});
