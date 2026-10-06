import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { localRuntime, initProviderInstance } from '../../../apps/server/web-local-config.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebProviderOffline } from '../../../apps/server/web-provider-offline.ts';
import { WebProviderRunner } from '../../../apps/server/web-provider-runner.ts';
import { WebProviderServer } from '../../../apps/server/web-provider-server.ts';
import { WebInviteAdmin } from '../../../apps/server/web-invite-admin.ts';
import { WebAccountAdmin } from '../../../apps/server/web-account-admin.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/deepseek.ts';
import { readWebV7Request } from '../../../apps/server/web-v7-request.ts';
import { syntheticTone } from '../../../apps/server/web-local-fake.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/web-vertical-publisher.ts';
import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';
import { migrateProvider, openProviderStore } from '../../../scripts/web-provider.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { WebProviderBudget } from '../../../apps/server/web-provider-budget.ts';

type Client = { cookie: string; csrf: string };
type Reply = { status: number; data: any; bytes: Buffer; headers: Record<string, unknown> };
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const API = '/api/web/provider';

test('provider-local 113 over HTTPS: catalog, guest lock, three turns + footer, private audio, invite upgrade', async (t) => {
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
    textProtocol: 'accepted-v7',
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

  // The real provider listener must never silently show the unbound synthetic demo.
  const anonymous: Client = { cookie: '', csrf: '' };
  for (const method of ['GET', 'HEAD']) {
    const entry = await call(method, '/', anonymous);
    assert.equal(entry.status, 302);
    assert.equal(entry.headers.location, '/?mode=provider');
    assert.equal(entry.headers['cache-control'], 'no-store');
    assert.equal(entry.headers['set-cookie'], undefined);
  }
  assert.equal(
    (await call('GET', '/index.html?from=invite', anonymous)).headers.location,
    '/index.html?from=invite&mode=provider',
  );
  for (const mode of ['local-2', 'local-3', 'local-3-admin', 'preview', 'provider&mode=local-3'])
    assert.equal((await call('GET', `/?mode=${mode}`, anonymous)).status, 404);
  assert.equal((await call('GET', '/health', anonymous, undefined, { Host: 'untrusted.example' })).status, 403);
  assert.equal((await call('GET', 'https://untrusted.example/health', anonymous)).status, 400);
  assert.equal(textCalls, 0);
  assert.equal(fishCalls, 0);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_principals')!.n, 0);

  // Catalog: exact provider wire, real welcome lines, welcome audio only where a clip exists.
  const guest: Client = { cookie: '', csrf: '' };
  const boot = await call('GET', `${API}/bootstrap`, guest);
  assert.equal(boot.status, 200);
  const catalog = parseWebProviderBootstrap(boot.data);
  assert.equal(catalog.fixture, false);
  assert.deepEqual(
    catalog.slots.slice(0, 3).map((slot) => slot.kind === 'character' && slot.characterId),
    ['wei-guagua', 'jojo', 'chen-jimi'],
  );
  const guagua = catalog.characters.find((item) => item.characterId === 'wei-guagua')!;
  assert.equal(guagua.welcome.text, '我才放学回来，让你等久了');
  assert.equal(guagua.welcome.audio.state, 'available');
  assert.equal(catalog.characters.find((item) => item.characterId === 'chen-jimi')!.welcome.audio.state, 'unavailable');
  assert.ok(!JSON.stringify(boot.data).includes('synthetic-wei-guagua'), 'no private reference id');
  const clip = await call('GET', (guagua.welcome.audio as { url: string }).url, { cookie: '', csrf: '' });
  assert.equal(clip.status, 200);
  assert.equal(sha(clip.bytes), (guagua.welcome.audio as { sha256: string }).sha256);
  assert.equal(catalog.access.kind, 'guest');
  assert.equal(catalog.access.lockedCharacterId, null);
  assert.equal(catalog.access.remainingReplies, 3);

  // Guest: first accepted send locks the character; three published turns, footer on the third.
  const first = await send(guest, 'wei-guagua', '你好呀');
  assert.equal(first.status, 202);
  assert.equal((await settle(guest, first.data.operation.operationId)).status, 'published');
  const locked = await send(guest, 'jojo', '换个人聊');
  assert.equal(locked.status, 403);
  assert.equal(locked.data.error.code, 'TRIAL_CHARACTER_LOCKED');
  let last: any = null;
  for (const line of ['第二句', '第三句']) {
    const reply = await send(guest, 'wei-guagua', line);
    assert.equal(reply.status, 202);
    last = await settle(guest, reply.data.operation.operationId);
    assert.equal(last.status, 'published');
  }
  assert.ok(last.publication.footerMessageId, 'third reply carries the trial footer');
  const exhausted = await send(guest, 'wei-guagua', '第四句');
  assert.equal(exhausted.status, 403);
  const after = parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, guest)).data);
  assert.equal(after.access.kind === 'guest' && after.access.lockedCharacterId, 'wei-guagua');
  assert.equal(after.access.canSend, false);
  const conversation = after.conversations.find((item) => item.characterId === 'wei-guagua')!;
  const history = await call('GET', `${API}/conversations/${conversation.conversationId}/history`, guest);
  assert.equal(history.status, 200);
  const footer = history.data.messages.find((m: any) => m.origin === 'trial_footer');
  assert.equal(footer.text, SYNTHETIC_TRIAL_FOOTER);
  const voiced = history.data.messages.find((m: any) => m.origin === 'narrative' && m.audio);
  assert.ok(voiced.audio.durationMs > 0);
  const audioPath = `${API}/conversations/${conversation.conversationId}/messages/${voiced.messageId}/audio/${voiced.audio.mediaId}`;
  const privateAudio = await call('GET', audioPath, guest);
  assert.equal(privateAudio.status, 200);
  assert.equal(privateAudio.headers['cache-control'], 'no-store');
  assert.equal((await call('GET', audioPath, { cookie: '', csrf: '' })).status, 401);
  const sync = await call('GET', `${API}/sync`, guest);
  assert.ok(sync.data.events.some((e: any) => e.kind === 'publication' && e.characterId === 'wei-guagua'));

  // A naturally expired guest can re-enter, without changing the exhausted IP allowance or old history.
  const expiredClient: Client = { cookie: '', csrf: '' },
    expiredBoot = await call('GET', `${API}/bootstrap`, expiredClient);
  const oldPrincipal = expiredBoot.data.access.principalId,
    oldCookie = expiredClient.cookie;
  // Creation and expiry injection may share a millisecond; preserve the schema lifetime invariant.
  store.run(
    'UPDATE web_sessions SET created_at=created_at-1,absolute_expires_at=? WHERE principal_id=?',
    clock.now(),
    oldPrincipal,
  );
  const beforeExpiry = store.get<{ n: number }>('SELECT count(*) n FROM web_principals')!.n;
  const expiry = await call('GET', `${API}/bootstrap`, expiredClient);
  assert.equal(expiry.status, 401);
  assert.equal(expiry.data.error.code, 'GUEST_SESSION_EXPIRED');
  assert.match(String(expiry.headers['set-cookie']), /Max-Age=0/);
  assert.equal(expiredClient.cookie, '');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_principals')!.n, beforeExpiry);
  const fresh = await call('GET', `${API}/bootstrap`, expiredClient);
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.data.access.principalId, oldPrincipal);
  assert.notEqual(expiredClient.cookie, oldCookie);
  assert.equal(fresh.data.access.remainingReplies, 0);
  assert.equal(fresh.data.access.canSend, false);
  const unknownGuest = await call('GET', `${API}/bootstrap`, {
    cookie: config.cookieName + '=' + 'z'.repeat(43),
    csrf: '',
  });
  assert.equal(unknownGuest.status, 401);
  assert.equal(unknownGuest.data.error.code, 'SESSION_EXPIRED');
  assert.equal(unknownGuest.headers['set-cookie'], undefined);

  // Invite: admin issues a code; a fresh guest redeems and may talk to any character.
  const legacyGrant = new WebInviteAdmin(store, clock, config.origin).issueLoginGrant();
  const admin: Client = { cookie: '', csrf: '' };
  assert.equal(
    (await call('POST', `${API}/admin/login`, admin, { token: legacyGrant.token })).status,
    403,
    'an unscoped legacy credential must not acquire account permissions',
  );
  const grant = new WebAccountAdmin(store, clock, config.origin).issueLoginGrant();
  assert.equal((await call('POST', `${API}/admin/login`, admin, { token: grant.token })).status, 200);
  const issued = await call('POST', `${API}/admin/invites/issue`, admin, {
    requestId: randomUUID(),
    redeemBy: null,
    accessDurationMs: null,
    batch: 'provider-it',
    note: null,
  });
  assert.equal(issued.status, 201);
  const code = issued.data.code ?? issued.data.codes?.[0]?.code;
  assert.equal(typeof code, 'string');
  const invitee: Client = { cookie: '', csrf: '' };
  await call('GET', `${API}/bootstrap`, invitee);
  const invalid = await call('POST', `${API}/invites/redeem`, invitee, {
    requestId: randomUUID(),
    code: 'A'.repeat(43),
  });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.data.error.code, 'WEB_INVITE_UNAVAILABLE');
  const redeemed = await call('POST', `${API}/invites/redeem`, invitee, { requestId: randomUUID(), code });
  assert.equal(redeemed.status, 201);
  assert.equal(typeof redeemed.data.grantId, 'string');
  const upgraded = parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, invitee)).data);
  assert.equal(upgraded.access.kind, 'invite');
  assert.equal(upgraded.access.canSend, true);
  const otherGuest: Client = { cookie: '', csrf: '' };
  await call('GET', `${API}/bootstrap`, otherGuest);
  const used = await call('POST', `${API}/invites/redeem`, otherGuest, { requestId: randomUUID(), code });
  assert.equal(used.status, 409);
  assert.equal(used.data.error.code, 'WEB_INVITE_UNAVAILABLE');
  assert.equal(
    parseWebProviderBootstrap((await call('GET', `${API}/bootstrap`, otherGuest)).data).access.kind,
    'guest',
  );
  for (const characterId of ['jojo', 'chen-jimi']) {
    const reply = await send(invitee, characterId, '受邀用户你好');
    assert.equal(reply.status, 202);
    assert.equal((await settle(invitee, reply.data.operation.operationId)).status, 'published');
  }
  const cross = await call('GET', `${API}/conversations/${conversation.conversationId}/history`, invitee);
  assert.equal(cross.status, 404, 'invitee cannot read the guest conversation');
  assert.equal(textCalls, 10);
  assert.ok(fishCalls >= 5);
  const spent = store.all<{ provider: string; held_micros: number; spent_micros: number }>(
    'SELECT provider,held_micros,spent_micros FROM web_provider_spending ORDER BY provider',
  );
  assert.ok(
    spent.every((row) => row.held_micros === 0 && row.spent_micros > 0 && row.spent_micros <= 3_000_000),
    JSON.stringify(spent),
  );
  for (const total of shared.summary()) {
    assert.equal(total.heldMicros, 0);
    assert.equal(total.spentMicros, spent.find((row) => row.provider === total.provider)!.spent_micros);
  }

  // Recreate the exact crash window: local receipt committed, shared ledger still held.
  const fault = new DatabaseSync(budgetPath);
  fault.exec(`UPDATE calls SET state='sent',charged_micros=NULL,receipt_hash=NULL,settled_at=NULL
    WHERE id=(SELECT id FROM calls WHERE provider='deepseek' LIMIT 1)`);
  fault.close();
  assert.ok(shared.summary()[0]!.heldMicros > 0);

  // Restart: a reopened persistent 113 keeps sessions, history and spending.
  await app.close();
  store.close();
  ({ config, store } = openProviderStore(root));
  app = new WebProviderServer(
    store,
    config,
    clock,
    new WebProviderRunner(
      store,
      clock,
      text,
      async () => {
        throw new Error('no speech after restart');
      },
      shared,
    ),
  );
  await app.listen();
  assert.equal(shared.summary()[0]!.heldMicros, 0, 'local durable receipt settles a crash gap without another call');
  assert.equal(shared.summary()[0]!.spentMicros, spent.find((row) => row.provider === 'deepseek')!.spent_micros);
  const reopened = await call('GET', `${API}/conversations/${conversation.conversationId}/history`, guest);
  assert.equal(reopened.status, 200);
  assert.deepEqual(
    reopened.data.messages.map((m: any) => m.messageId),
    history.data.messages.map((m: any) => m.messageId),
  );
  assert.equal(
    store.get<{ spent_micros: number }>("SELECT spent_micros FROM web_provider_spending WHERE provider='deepseek'")!
      .spent_micros,
    spent.find((row) => row.provider === 'deepseek')!.spent_micros,
  );

  // An in-flight abort persists UNKNOWN before closing SQLite; restart never resends it.
  stallText = true;
  const pending = await send(invitee, 'jojo', '合成未知回执');
  assert.equal(pending.status, 202);
  for (let i = 0; i < 100 && textCalls === 10; i++) await pause(10);
  assert.equal(textCalls, 11);
  await app.close();
  const unknown = store.get<{ state: string; held_micros: number }>(
    'SELECT state,held_micros FROM web_provider_attempts WHERE operation_id=?',
    pending.data.operation.operationId,
  )!;
  assert.equal(unknown.state, 'unknown');
  assert.equal(shared.summary()[0]!.heldMicros, unknown.held_micros);
  store.close();
  ({ config, store } = openProviderStore(root));
  app = new WebProviderServer(
    store,
    config,
    clock,
    new WebProviderRunner(
      store,
      clock,
      text,
      async () => {
        throw Error('unknown must not reach speech');
      },
      shared,
    ),
  );
  await app.listen();
  await pause(100);
  assert.equal(textCalls, 11);
  assert.equal(shared.summary()[0]!.heldMicros, unknown.held_micros);

  // Native Node/BLOB deletion: preserve another role and UNKNOWN shared spend.
  const protectedConversation = (await call('GET', `${API}/bootstrap`, invitee)).data.conversations.find(
    (c: any) => c.characterId === 'chen-jimi',
  );
  const protectedPath = `${API}/conversations/${protectedConversation.conversationId}/history`;
  const protectedHistory = await call('GET', protectedPath, invitee),
    budgetBeforeDelete = shared.summary();
  const replayRow = store.get<any>(`SELECT a.*,o.spoken_text,o.audio_bytes FROM web_provider_attempts a
    JOIN web_provider_outputs o USING(operation_id,phase,ordinal) WHERE a.character_id='wei-guagua' AND a.phase='speech' LIMIT 1`)!;
  const replayKey = { operationId: replayRow.operation_id, phase: 'speech' as const, ordinal: replayRow.ordinal };
  const replayScope = {
    principalId: replayRow.principal_id,
    playerId: replayRow.player_id,
    worldId: replayRow.world_id,
    conversationId: replayRow.conversation_id,
    characterId: replayRow.character_id,
    inputMessageId: replayRow.input_message_id,
  };
  const replayResult = {
    outcome: 'succeeded' as const,
    receipt: JSON.parse(replayRow.receipt_json),
    usageUnits: replayRow.usage_units,
    spokenText: replayRow.spoken_text,
    output: Buffer.from(replayRow.audio_bytes),
  };
  for (const id of ['wei-guagua', 'jojo']) {
    const base = `${API}/admin/characters/${id}`,
      preview = await call('POST', `${base}/delete-preview`, admin, {});
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const started = await call('POST', `${base}/delete-start`, admin, {
      requestId: randomUUID(),
      previewHash: preview.data.previewHash,
      acknowledgeDeleteAllChats: true,
    });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const deadline = Date.now() + 10_000;
    while (true) {
      const done = await call('POST', `${base}/delete-status`, admin, {});
      assert.equal(done.status, 200);
      if (done.data.state === 'deleted') break;
      assert.ok(Date.now() < deadline, JSON.stringify(done.data));
      await pause(100);
    }
  }
  assert.equal((await call('GET', audioPath, guest)).status, 404);
  assert.deepEqual(await call('GET', protectedPath, invitee).then((r) => r.data), protectedHistory.data);
  assert.deepEqual(shared.summary(), budgetBeforeDelete);
  assert.equal(new WebProviderOffline(store, clock).confirm(replayKey, replayScope, replayResult).duplicate, true);
  assert.throws(
    () =>
      new WebProviderOffline(store, clock).confirm(replayKey, replayScope, { ...replayResult, spokenText: 'changed' }),
    /RECEIPT_CONFLICT/,
  );
  assert.equal(
    store.get<{ n: number }>(`SELECT count(*) n FROM web_provider_outputs WHERE operation_id IN
    (SELECT id FROM web_operations WHERE character_id IN ('wei-guagua','jojo'))`)!.n,
    0,
  );
  await app.close();
  store.close();
  ({ config, store } = openProviderStore(root));
  app = new WebProviderServer(
    store,
    config,
    clock,
    new WebProviderRunner(
      store,
      clock,
      text,
      async () => {
        throw Error('deleted role must not reach speech');
      },
      shared,
    ),
  );
  await app.listen();
  assert.deepEqual(shared.summary(), budgetBeforeDelete);
  assert.equal(textCalls, 11);
  assert.equal((await call('GET', `${API}/conversations/${conversation.conversationId}/history`, guest)).status, 404);
  assert.deepEqual(await call('GET', protectedPath, invitee).then((r) => r.data), protectedHistory.data);
  assert.equal(store.get<{ n: number }>("SELECT count(*) n FROM web_character_deletions WHERE state='deleted'")!.n, 2);
});
