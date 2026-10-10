import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { localRuntime, initProviderInstance } from '../../../apps/server/platform/web-local-config.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { WebProviderRunner } from '../../../apps/server/generation/web-provider-runner.ts';
import { WebProviderServer } from '../../../apps/server/generation/web-provider-server.ts';
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
const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const API = '/api/web/provider';

test('provider-local over HTTPS: signup, login, nickname reaches the character, dead cookie and redeem gate', async (t) => {
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
  const introductions: (Record<string, unknown> | null)[] = [];
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
      introductions.push(request.playerIntroduction ? { ...request.playerIntroduction } : null);
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
  const mails: { to: string; kind: string; code: string | null }[] = [];
  const mailer = {
    send: async (message: { to: string; kind: string; code: string | null }) => void mails.push(message),
    waitUntil: (task: Promise<void>) => void task,
  };
  let app = new WebProviderServer(store, config, clock, runner, undefined, undefined, {
    signupEnabled: true,
    mailer,
    dailyCap: 50,
  });
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

  const account = (path: string) => `${API}/account${path}`;
  const PASSWORD = 'correct horse battery';
  const email = 'Local.Player@Example.com';
  const guest: Client = { cookie: '', csrf: '' };
  const raw: string[] = [];
  const rawCall = async (method: string, path: string, actor: Client, body?: unknown) => {
    const reply = await call(method, path, actor, body);
    const header = reply.headers['set-cookie'] as string[] | undefined;
    if (header) raw.push(...header);
    return reply;
  };

  // Not signed in: signup is open, the page can tell, and nothing has been created.
  assert.deepEqual((await call('GET', account(''), { cookie: '', csrf: '' })).data, {
    signupEnabled: true,
    signedIn: false,
  });
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_principals')!.n, 0);
  const boot = parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, guest)).data);
  const principal = boot.access.principalId;

  // 注册: email → code → password + nickname, bound to the current guest principal.
  const challenge = await call('POST', account('/request-code'), guest, { purpose: 'signup', email });
  assert.equal(challenge.status, 200);
  assert.equal(mails.length, 1);
  assert.deepEqual([mails[0]!.to, mails[0]!.kind], ['local.player@example.com', 'code']);
  const wrongCode = mails[0]!.code === '000000' ? '111111' : '000000';
  assert.equal(
    (await call('POST', account('/verify-code'), guest, { challengeId: challenge.data.challengeId, code: wrongCode }))
      .status,
    400,
  );
  const verified = await call('POST', account('/verify-code'), guest, {
    challengeId: challenge.data.challengeId,
    code: mails[0]!.code,
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  const signedUp = await rawCall('POST', account('/signup'), guest, {
    challengeId: challenge.data.challengeId,
    password: PASSWORD,
    nickname: '阿泡',
  });
  assert.equal(signedUp.status, 200, JSON.stringify(signedUp.data));
  assert.match(raw.at(-1)!, /Max-Age=34560000$/);
  assert.equal(
    parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, guest)).data).access.principalId,
    principal,
  );

  // The nickname is the 名片 name: the very next request to the character carries it in playerIntroduction.
  const hello = await send(guest, 'wei-guagua', '你好呀');
  assert.equal(hello.status, 202);
  assert.equal((await settle(guest, hello.data.operation.operationId)).status, 'published');
  assert.ok(introductions.length > 0);
  assert.ok(
    introductions.every((introduction) => introduction?.name === '阿泡'),
    JSON.stringify(introductions),
  );
  const operationId = hello.data.operation.operationId as string;
  const stored = readWebV7Request(store, operationId).request;
  assert.equal(stored.playerIntroduction?.name, '阿泡');
  assert.equal(stored.playerIntroduction?.source, 'player_setup');
  assert.equal(JSON.parse(JSON.stringify(stored)).playerIntroduction.name, '阿泡', 'in the request JSON itself');
  // 我的昵称: a new revision, and the next request carries the new name; the first one is unchanged.
  assert.deepEqual((await call('POST', account('/nickname'), guest, { nickname: '小泡' })).data, {
    nickname: '小泡',
    revision: 2,
  });
  introductions.length = 0;
  const again = await send(guest, 'wei-guagua', '再来一句');
  assert.equal((await settle(guest, again.data.operation.operationId)).status, 'published');
  assert.ok(introductions.length > 0 && introductions.every((introduction) => introduction?.name === '小泡'));
  assert.equal(readWebV7Request(store, again.data.operation.operationId).request.playerIntroduction?.name, '小泡');
  assert.equal(readWebV7Request(store, operationId).request.playerIntroduction?.name, '阿泡');
  assert.equal(
    store.get<{ n: number }>('SELECT count(*) n FROM player_profile_versions WHERE world_id=?', boot.access.worldId)!.n,
    2,
  );

  // 登录 on another device: same principal, same chat history, first device untouched.
  const other: Client = { cookie: '', csrf: '' };
  await call('GET', `${API}/bootstrap`, other);
  assert.equal((await call('POST', account('/login'), other, { email, password: 'wrong password' })).status, 401);
  assert.equal((await rawCall('POST', account('/login'), other, { email, password: PASSWORD })).status, 200);
  assert.match(raw.at(-1)!, /Max-Age=34560000$/);
  const second = parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, other)).data);
  assert.equal(second.access.principalId, principal);
  const conversation = second.conversations.find((item) => item.characterId === 'wei-guagua')!;
  assert.equal((await call('GET', `${API}/conversations/${conversation.conversationId}/history`, other)).status, 200);
  assert.equal((await call('GET', `${API}/bootstrap`, guest)).status, 200);
  assert.equal((await call('POST', account('/logout-others'), other, {})).data.ended, 1);
  const dead = await call('GET', `${API}/bootstrap`, guest);
  assert.equal(dead.status, 401);
  assert.equal(dead.data.error.code, 'SESSION_EXPIRED');
  assert.deepEqual(dead.headers['set-cookie'], [
    `${config.cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  ]);

  // Redeeming needs a login: a fresh guest without one is told so, nothing is redeemed.
  const newcomer: Client = { cookie: '', csrf: '' };
  await call('GET', `${API}/bootstrap`, newcomer);
  const refused = await call('POST', `${API}/invites/redeem`, newcomer, {
    requestId: randomUUID(),
    code: 'A'.repeat(43),
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error.code, 'PLAYER_LOGIN_REQUIRED');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')!.n, 0);
});
