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
import { deleteLiveConversation } from '../../../apps/server/characters/web-conversation-deletion.ts';
import { purgeShareWorld, shareResidue } from '../../../apps/server/share/web-share-schema.ts';

type Client = { cookie: string; csrf: string };
type Reply = { status: number; data: any; bytes: Buffer; headers: Record<string, unknown> };
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const API = '/api/web/provider';

test('45 voice-card links over HTTPS: create (owner, voice only, idempotent), open without a session, one day, expired = unknown, purges', async (t) => {
  const { parent, port } = localRuntime();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `provider-share-${randomUUID().slice(0, 12)}`);
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
  // the clock stands still while a time is pinned (so "one millisecond before the day" is exact)
  let pinned: number | null = null;
  const clock = { now: () => pinned ?? Date.now() };
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

  // ---- a guest with three published turns (the third carries the trial footer) ----
  const guest: Client = { cookie: '', csrf: '' };
  const boot = parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, guest)).data);
  const principalId = boot.access.principalId;
  let operation: any = null;
  const inputs: string[] = [];
  for (const line of ['你好呀', '第二句', '第三句']) {
    const reply = await send(guest, 'wei-guagua', line);
    assert.equal(reply.status, 202);
    operation = await settle(guest, reply.data.operation.operationId);
    assert.equal(operation.status, 'published');
    inputs.push(line);
  }
  const conversation = parseWebProviderBootstrap(
    (await call('GET', `${API}/bootstrap`, guest)).data,
  ).conversations.find((item) => item.characterId === 'wei-guagua')!;
  const history = (await call('GET', `${API}/conversations/${conversation.conversationId}/history`, guest)).data;
  const voiced = history.messages.filter((m: any) => m.origin === 'narrative' && m.audio);
  const mine = history.messages.find((m: any) => m.author === 'player');
  const footer = history.messages.find((m: any) => m.origin === 'trial_footer');
  assert.ok(voiced.length >= 3 && mine && footer);
  const privateAudio = (m: any) =>
    call(
      'GET',
      `${API}/conversations/${conversation.conversationId}/messages/${m.messageId}/audio/${m.audio.mediaId}`,
      guest,
    );
  const share = (actor: Client, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    call('POST', `${API}/shares`, actor, body, headers);
  const cid = conversation.conversationId;
  const requestId = randomUUID();
  const shares = () => store.get<{ n: number }>('SELECT count(*) n FROM web_shares')!.n;

  // ---- create: the owner's own character voice message ----
  const made = await share(guest, { requestId, conversationId: cid, messageId: voiced[0].messageId });
  assert.equal(made.status, 200);
  assert.deepEqual(
    Object.keys(made.data).sort(),
    ['expiresAt', 'token'],
    'the answer is the token and a time, nothing else',
  );
  assert.match(made.data.token, /^[A-Za-z0-9_-]{32}$/, '192 random-looking bits as base64url');
  assert.equal(made.data.expiresAt - clock.now() <= 86_400_000 && made.data.expiresAt - clock.now() > 86_000_000, true);
  assert.equal(shares(), 1);
  // the same request id: no second share, the same token
  const again = await share(guest, { requestId, conversationId: cid, messageId: voiced[0].messageId });
  assert.equal(again.status, 200);
  assert.equal(again.data.token, made.data.token);
  assert.equal(shares(), 1, 'a repeat makes no second share');
  assert.equal(store.get<{ n: number }>("SELECT n FROM web_share_counts WHERE name='created'")!.n, 1);
  // the same id with another message is a conflict, and nothing is made
  const clash = await share(guest, { requestId, conversationId: cid, messageId: voiced[1].messageId });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.error.code, 'IDEMPOTENCY_CONFLICT');
  // only the token's hash is stored
  const token = made.data.token as string;
  assert.equal(store.get('SELECT 1 FROM web_shares WHERE token_hash=?', token), undefined);
  assert.ok(store.get('SELECT 1 FROM web_shares WHERE token_hash=?', createHash('sha256').update(token).digest('hex')));
  const row = store.get<Record<string, unknown>>('SELECT * FROM web_shares')!;
  assert.deepEqual(Object.keys(row).sort(), [
    'character_id',
    'conversation_id',
    'created_at',
    'expires_at',
    'kind',
    'media_id',
    'message_id',
    'token_hash',
    'world_id',
  ]);
  assert.equal(row.expires_at, (row.created_at as number) + 86_400_000);
  assert.equal(JSON.stringify(row).includes(principalId), false, 'the share row never names the principal');

  // ---- not shareable: the player's own text, the trial footer, an invented id, another player's message, a text-only reply ----
  for (const [label, messageId] of [
    ['the player’s own message', mine.messageId],
    ['the trial footer voice', footer.messageId],
    ['an unknown message', 'message-nope'],
  ] as const) {
    const refused = await share(guest, { requestId: randomUUID(), conversationId: cid, messageId });
    assert.equal(refused.status, 404, label);
    assert.equal(refused.data.error.code, 'NOT_FOUND', label);
  }
  const textOnly = history.messages.find((m: any) => m.author === 'character' && m.origin === 'narrative' && !m.audio);
  if (textOnly)
    assert.equal(
      (await share(guest, { requestId: randomUUID(), conversationId: cid, messageId: textOnly.messageId })).status,
      404,
    );
  assert.equal(shares(), 1, 'a refusal makes nothing');
  // a different player cannot share this player's message, with the right ids
  const other: Client = { cookie: '', csrf: '' };
  assert.equal((await call('GET', `${API}/bootstrap`, other)).status, 200);
  const stolen = await share(other, { requestId: randomUUID(), conversationId: cid, messageId: voiced[0].messageId });
  assert.equal(stolen.status, 404);
  assert.equal(stolen.data.error.code, 'NOT_FOUND');
  // signed-out, no CSRF, wrong Origin, a body with an extra key
  assert.equal(
    (
      await share(
        { cookie: '', csrf: '' },
        { requestId: randomUUID(), conversationId: cid, messageId: voiced[0].messageId },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await call(
        'POST',
        `${API}/shares`,
        { cookie: guest.cookie, csrf: 'x'.repeat(43) },
        { requestId: randomUUID(), conversationId: cid, messageId: voiced[0].messageId },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await share(
        guest,
        { requestId: randomUUID(), conversationId: cid, messageId: voiced[0].messageId },
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await share(guest, {
        requestId: randomUUID(),
        conversationId: cid,
        messageId: voiced[0].messageId,
        nickname: 'x',
      })
    ).status,
    400,
  );
  assert.equal(shares(), 1);

  // ---- open: public, no session; exactly the card fields and the voice, no sender field ----
  const visitor: Client = { cookie: '', csrf: '' };
  const opened = await call('GET', `${API}/shares/${token}`, visitor);
  assert.equal(opened.status, 200);
  assert.deepEqual(
    Object.keys(opened.data).sort(),
    [
      'birthDate',
      'characterId',
      'displayName',
      'durationMs',
      'mainColor',
      'noRank',
      'palette',
      'portraitUrl',
      'voiceUrl',
    ],
    'the public answer has exactly these keys: no sender field of any kind',
  );
  assert.equal(opened.data.characterId, 'wei-guagua');
  assert.equal(opened.data.voiceUrl, `${API}/shares/${token}/audio`, 'the voice URL carries only the token');
  assert.ok(opened.data.durationMs > 0);
  assert.equal(opened.headers['cache-control'], 'no-store');
  assert.equal(opened.headers['referrer-policy'], 'no-referrer');
  assert.equal(opened.headers['set-cookie'], undefined, 'no session is made for a visitor');
  const exposed = JSON.stringify(opened.data) + JSON.stringify(opened.headers);
  for (const secret of [
    principalId,
    boot.access.playerId,
    boot.access.worldId,
    cid,
    voiced[0].messageId,
    voiced[0].audio.mediaId,
    'nickname',
  ])
    assert.equal(
      exposed.includes(String(secret)),
      false,
      `the public answer never carries ${String(secret).slice(0, 8)}…`,
    );
  const voice = await call('GET', opened.data.voiceUrl, visitor);
  assert.equal(voice.status, 200);
  assert.equal(voice.headers['content-type'], 'audio/wav');
  assert.equal(voice.headers['cache-control'], 'no-store');
  assert.equal(sha(voice.bytes), sha((await privateAudio(voiced[0])).bytes), 'the voice is the message’s own clip');
  assert.equal(store.get<{ n: number }>("SELECT n FROM web_share_counts WHERE name='opened'")!.n, 1);
  // the page itself is the player's own page, served at /s/<token> with no redirect and no cookie
  const page = await call('GET', `/s/${token}`, visitor);
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['set-cookie'], undefined);
  assert.equal((await call('GET', `/s/${token}?mode=provider`, visitor)).status, 404);

  // the guest's own data lives a day too; keep it readable so the link's day is what is measured here (retention is checked below)
  store.run(
    'UPDATE web_guest_retention SET expires_at=? WHERE principal_id=?',
    clock.now() + 10 * 86_400_000,
    principalId,
  );
  // ---- one day: still open one millisecond before, closed at the day, identical to an unknown token ----
  const unknownToken = 'A'.repeat(32);
  const unknownCard = await call('GET', `${API}/shares/${unknownToken}`, visitor);
  const unknownVoice = await call('GET', `${API}/shares/${unknownToken}/audio`, visitor);
  const shape = (reply: Reply) => ({
    status: reply.status,
    body: reply.data,
    headers: Object.fromEntries(
      Object.entries(reply.headers).filter(([key]) => !['date', 'content-length'].includes(key)),
    ),
  });
  assert.equal(unknownCard.status, 404);
  const createdAt = row.created_at as number;
  pinned = createdAt + 86_400_000 - 1;
  assert.equal(
    (await call('GET', `${API}/shares/${token}`, visitor)).status,
    200,
    'open until the last millisecond of the day',
  );
  assert.equal((await call('GET', opened.data.voiceUrl, visitor)).status, 200);
  pinned = createdAt + 86_400_000;
  const lateCard = await call('GET', `${API}/shares/${token}`, visitor);
  const lateVoice = await call('GET', opened.data.voiceUrl, visitor);
  assert.deepEqual(shape(lateCard), shape(unknownCard), 'expired and unknown look the same (card)');
  assert.deepEqual(shape(lateVoice), shape(unknownVoice), 'expired and unknown look the same (voice)');
  assert.equal(lateCard.status, 404);
  assert.equal(
    store.get<{ n: number }>("SELECT n FROM web_share_counts WHERE name='opened'")!.n,
    2,
    'a refusal is not counted as an open',
  );
  // malformed tokens answer the same too
  for (const bad of ['short', 'A'.repeat(33), 'a%20b'])
    assert.deepEqual(shape(await call('GET', `${API}/shares/${bad}`, visitor)).status, 404);
  pinned = null;

  // ---- retention: when the player's own content goes (a guest's data after its days), the link and its voice go with it ----
  const kept = await share(guest, { requestId: randomUUID(), conversationId: cid, messageId: voiced[2].messageId });
  assert.equal(kept.status, 200);
  assert.equal((await call('GET', `${API}/shares/${kept.data.token}`, visitor)).status, 200);
  store.run('UPDATE web_guest_retention SET expires_at=? WHERE principal_id=?', clock.now() - 1, principalId);
  assert.deepEqual(shape(await call('GET', `${API}/shares/${kept.data.token}`, visitor)), shape(unknownCard));
  assert.deepEqual(shape(await call('GET', `${API}/shares/${kept.data.token}/audio`, visitor)), shape(unknownVoice));
  store.run(
    'UPDATE web_guest_retention SET expires_at=? WHERE principal_id=?',
    clock.now() + 10 * 86_400_000,
    principalId,
  );
  assert.equal(
    (await call('GET', `${API}/shares/${kept.data.token}`, visitor)).status,
    200,
    'and it is the retention that closed it',
  );

  // ---- deletion kills the link and its voice ----
  const second = await share(guest, { requestId: randomUUID(), conversationId: cid, messageId: voiced[1].messageId });
  assert.equal(second.status, 200);
  assert.equal((await call('GET', `${API}/shares/${second.data.token}`, visitor)).status, 200);
  store.transaction(() =>
    deleteLiveConversation(store as never, clock, {
      principalId,
      worldId: boot.access.worldId,
      conversationId: cid,
      characterId: 'wei-guagua',
    }),
  );
  assert.equal(shares(), 0, 'the conversation’s deletion removes its links');
  assert.equal(shareResidue(store, boot.access.worldId), 0);
  const gone = await call('GET', `${API}/shares/${second.data.token}`, visitor);
  const goneVoice = await call('GET', `${API}/shares/${second.data.token}/audio`, visitor);
  assert.deepEqual(shape(gone), shape(unknownCard));
  assert.deepEqual(shape(goneVoice), shape(unknownVoice));
  // the counters survive (counts only)
  assert.equal(store.get<{ n: number }>("SELECT n FROM web_share_counts WHERE name='created'")!.n, 3);
  // and the world's purge removes what is left (requests of the world included)
  store.run(
    'INSERT INTO web_shares VALUES (?,?,?,?,?,?,?,?,?)',
    'f'.repeat(64),
    boot.access.worldId,
    'c',
    'm',
    'x',
    'wei-guagua',
    'reply',
    1,
    86_400_001,
  );
  store.run('INSERT INTO web_share_requests VALUES (?,?,?,?,?)', principalId, 'req-left', 'h', 'f'.repeat(64), 1);
  assert.equal(shareResidue(store, boot.access.worldId), 2);
  store.transaction(() => purgeShareWorld(store as never, boot.access.worldId));
  assert.equal(shareResidue(store, boot.access.worldId), 0);
});
