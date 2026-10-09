import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebLocalExecutor } from '../../../apps/server/platform/web-local-executor.ts';
import { WebRetentionCleaner } from '../../../apps/server/admission/web-retention-cleaner.ts';
import { WebPrivateAudioFiles } from '../../../apps/server/audio/web-private-audio-files.ts';
import { localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';

type Client = { cookie: string; csrf: string };
type Reply = { status: number; data: any; bytes: Buffer; headers: Record<string, unknown> };
const client = (): Client => ({ cookie: '', csrf: '' });
const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

test('C fixed 112: independent synthetic HTTPS invite, isolation, cleanup and restart', async (t) => {
  const { parent, port } = localRuntime();
  assert.ok([18461, 18491].includes(port), 'C or single-agent S must use its registered API port');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `local-invite-c-${randomUUID().slice(0, 12)}`);
  assert.equal(existsSync(root), false);
  const script = resolve('scripts/web-v1.ts');
  const cli = (action: string) => {
    const result = spawnSync(process.execPath, [script, action, root], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${action}: ${result.stderr.slice(0, 500)}`);
    return result.stdout;
  };
  cli('init');
  cli('migrate');
  cli('migrate-data-lifecycle');
  cli('migrate-invites');
  const config = readLocalConfig(root),
    ca = readFileSync(join(root, 'local-cert.pem'));
  const context = { port, ca, origin: config.origin };
  const clock = { now: () => Date.now() };
  const openStore = () =>
    new WebStore(root, { create: false, instanceId: config.instanceId, dataLifecycleTest: true, inviteTest: true });
  let server: ChildProcess | null = null;
  const start = async (action = 'serve-invites') => {
    const child = spawn(process.execPath, [script, action, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    server = child;
    await new Promise<void>((resolveReady, reject) => {
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('serve timeout'));
      }, 10_000);
      child.stderr!.on('data', (chunk) => {
        stderr += String(chunk).slice(0, 300);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error(`serve exit ${code}: ${stderr}`));
      });
      child.stdout!.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.includes(`"action":"${action}"`)) {
          clearTimeout(timer);
          resolveReady();
        }
      });
    });
  };
  const stop = async () => {
    const child = server;
    server = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(Error('serve stop timeout')), 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    child.kill('SIGTERM');
    await exited;
  };
  t.after(stop);
  const call = async (method: string, path: string, actor: Client, body?: unknown): Promise<Reply> => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolveReply, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          port: context.port,
          path,
          method,
          ca: context.ca,
          headers: {
            ...(actor.cookie ? { Cookie: actor.cookie } : {}),
            ...(bytes
              ? { Origin: context.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': actor.csrf }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks),
              setCookie = res.headers['set-cookie']?.[0]?.split(';')[0];
            if (setCookie) actor.cookie = setCookie;
            let data: any = null;
            try {
              data = JSON.parse(raw.toString('utf8'));
            } catch {
              /* private WAV */
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
      if (bytes) req.write(bytes);
      req.end();
    });
  };
  const published = async (actor: Client, operationId: string) => {
    for (let i = 0; i < 100; i++) {
      const reply = await call('GET', `/api/web/local/operations/${operationId}`, actor);
      if (reply.data?.status === 'published') return reply.data;
      assert.notEqual(reply.data?.status, 'failed');
      await pause(30);
    }
    throw Error('publication timeout');
  };
  const send = async (actor: Client, id: string, text: string) => {
    const reply = await call('POST', '/api/web/local/characters/synthetic-local/operations', actor, {
      requestId: id,
      text,
      delivery: 'voice',
    });
    assert.equal(reply.status, 202);
    return published(actor, reply.data.operation.operationId);
  };
  const historyPath = (conversationId: string) => `/api/web/local/conversations/${conversationId}/history`;
  const mediaPath = (conversationId: string, message: any) =>
    `/api/web/local/conversations/${conversationId}/messages/${message.messageId}` + `/audio/${message.audio.mediaId}`;

  // The role-gated CLI writes a 0600 file; its stdout must never disclose the token.
  const grantOutput = cli('admin-grant');
  const grantFile = JSON.parse(grantOutput).file as string;
  assert.equal(statSync(grantFile).mode & 0o777, 0o600);
  const loginGrant = JSON.parse(readFileSync(grantFile, 'utf8')) as { token: string };
  assert.ok(!grantOutput.includes(loginGrant.token));
  await start();
  const admin = client(),
    invitee = client(),
    account = client(),
    expiring = client();
  const login = await call('POST', '/api/web/local/admin/login', admin, { token: loginGrant.token });
  assert.equal(login.status, 200);
  unlinkSync(grantFile);
  assert.match(admin.cookie, /_admin=/);
  const adminSession = await call('GET', '/api/web/local/admin/session', admin);
  assert.equal(adminSession.status, 200);
  assert.equal(adminSession.data.csrf, login.data.csrf);
  const replayLogin = await call('POST', '/api/web/local/admin/login', client(), { token: loginGrant.token });
  assert.equal(replayLogin.status, 403, 'admin grant is single-use');
  assert.equal(replayLogin.data.error.code, 'ADMIN_INVALID_GRANT');
  const issue = await call('POST', '/api/web/local/admin/invites/issue', admin, {
    requestId: 'c-issue-once',
    redeemBy: Date.now() + 60_000,
    accessDurationMs: null,
    batch: 'c-synthetic',
    note: null,
  });
  assert.equal(issue.status, 201);
  assert.match(issue.data.code, /^[A-Za-z0-9_-]{43}$/);
  const first = await call('GET', '/api/web/local/bootstrap', invitee);
  assert.equal(first.status, 200);
  assert.equal(first.data.contractVersion, 'web-v1-local-2');
  const old = { ...invitee };
  const redeemed = await call('POST', '/api/web/local/invites/redeem', invitee, {
    code: issue.data.code,
    requestId: 'c-redeem-once',
  });
  assert.equal(redeemed.status, 201);
  assert.equal(redeemed.data.principalId, first.data.access.principalId);
  assert.notEqual(invitee.cookie, old.cookie);
  const invited = await call('GET', '/api/web/local/bootstrap', invitee);
  assert.equal(invited.data.contractVersion, 'web-v1-local-3');
  assert.equal(invited.data.access.grantId, redeemed.data.grantId);
  assert.equal(invited.data.access.worldId, first.data.access.worldId);
  const challenge = await call('POST', '/api/web/local/identity/invite-receipt-challenge', old, {});
  assert.equal(challenge.status, 200);
  const recovered = await call('POST', '/api/web/local/identity/invite-receipt-recover', old, {
    code: issue.data.code,
    requestId: 'c-redeem-once',
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.grantId, redeemed.data.grantId);
  const receipt = await call('POST', '/api/web/local/identity/invite-receipt-status', invitee, {
    requestId: 'c-redeem-once',
  });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.grantId, redeemed.data.grantId);

  const contestIssue = await call('POST', '/api/web/local/admin/invites/issue', admin, {
    requestId: 'c-issue-contest',
    redeemBy: Date.now() + 60_000,
    accessDurationMs: null,
    batch: 'c-synthetic',
    note: null,
  });
  assert.equal(contestIssue.status, 201);
  const contenders = [client(), client()];
  for (const contender of contenders)
    assert.equal((await call('GET', '/api/web/local/bootstrap', contender)).status, 200);
  const contest = await Promise.all(
    contenders.map((contender, index) =>
      call('POST', '/api/web/local/invites/redeem', contender, {
        code: contestIssue.data.code,
        requestId: `c-contest-${index}`,
      }),
    ),
  );
  assert.deepEqual(contest.map((result) => result.status).sort(), [201, 409]);
  const winner = contest.findIndex((result) => result.status === 201);
  assert.equal((await call('GET', '/api/web/local/access', contenders[winner]!)).data.kind, 'invite');
  assert.equal((await call('GET', '/api/web/local/access', contenders[1 - winner]!)).data.kind, 'guest');

  const disabled = await call('POST', '/api/web/local/admin/invites/issue', admin, {
    requestId: 'c-issue-disabled',
    redeemBy: Date.now() + 60_000,
    accessDurationMs: null,
    batch: 'c-synthetic',
    note: null,
  });
  assert.equal(disabled.status, 201);
  assert.equal(
    (await call('POST', '/api/web/local/admin/invites/revoke-code', admin, { id: disabled.data.inviteId })).status,
    200,
  );
  const denied = client();
  await call('GET', '/api/web/local/bootstrap', denied);
  assert.equal(
    (
      await call('POST', '/api/web/local/invites/redeem', denied, {
        code: disabled.data.code,
        requestId: 'c-redeem-disabled',
      })
    ).status,
    409,
  );

  const expired = await call('POST', '/api/web/local/admin/invites/issue', admin, {
    requestId: 'c-issue-expired',
    redeemBy: Date.now() + 150,
    accessDurationMs: null,
    batch: 'c-synthetic',
    note: null,
  });
  assert.equal(expired.status, 201);
  await pause(180);
  assert.equal(
    (
      await call('POST', '/api/web/local/invites/redeem', denied, {
        code: expired.data.code,
        requestId: 'c-redeem-expired',
      })
    ).status,
    409,
  );

  const invitedOp = await send(invitee, 'c-invite-message', 'C 合成邀请文本');
  const invitedHistory = await call('GET', historyPath(invitedOp.conversationId), invitee);
  assert.equal(invitedHistory.status, 200);
  assert.ok(invitedHistory.data.messages.some((message: any) => message.text === 'C 合成邀请文本'));
  const invitedVoice = invitedHistory.data.messages.find((message: any) => message.audio?.status === 'ready');
  assert.ok(invitedVoice);
  const invitedMedia = mediaPath(invitedOp.conversationId, invitedVoice);
  assert.equal((await call('GET', invitedMedia, invitee)).bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal((await call('GET', invitedMedia, account)).status, 401);

  const accountBoot = await call('GET', '/api/web/local/bootstrap', account);
  assert.notEqual(accountBoot.data.access.principalId, first.data.access.principalId);
  assert.equal((await call('GET', historyPath(invitedOp.conversationId), account)).status, 404);
  assert.equal(
    (
      await call('POST', '/api/web/local/register', account, {
        requestId: 'c-register',
        username: `c_${randomUUID().slice(0, 10)}`,
        password: 'synthetic-passphrase',
      })
    ).status,
    200,
  );
  const accountOp = await send(account, 'c-account-message', 'C 健康账号文本');
  const accountHistory = await call('GET', historyPath(accountOp.conversationId), account);
  assert.equal(accountHistory.status, 200);
  const accountVoice = accountHistory.data.messages.find((message: any) => message.audio?.status === 'ready');
  assert.ok(accountVoice);
  const accountMedia = mediaPath(accountOp.conversationId, accountVoice);
  assert.equal((await call('GET', accountMedia, account)).status, 200);
  assert.equal((await call('GET', accountMedia, invitee)).status, 404);

  const raceIssue = await call('POST', '/api/web/local/admin/invites/issue', admin, {
    requestId: 'c-issue-race',
    redeemBy: Date.now() + 60_000,
    accessDurationMs: null,
    batch: 'c-synthetic',
    note: null,
  });
  assert.equal(raceIssue.status, 201);
  const racing = client();
  const racingBoot = await call('GET', '/api/web/local/bootstrap', racing);
  const raceRedeem = await call('POST', '/api/web/local/invites/redeem', racing, {
    code: raceIssue.data.code,
    requestId: 'c-redeem-race',
  });
  assert.equal(raceRedeem.status, 201);
  assert.equal(raceRedeem.data.principalId, racingBoot.data.access.principalId);

  const expiringBoot = await call('GET', '/api/web/local/bootstrap', expiring);
  const expiringOp = await send(expiring, 'c-expiring-message', 'C 待清理游客文本');
  const expiringHistory = await call('GET', historyPath(expiringOp.conversationId), expiring);
  const expiringVoice = expiringHistory.data.messages.find((message: any) => message.audio?.status === 'ready');
  assert.ok(expiringVoice);
  const healthyCursor = (await call('GET', '/api/web/local/bootstrap', account)).data.syncCursor;
  assert.equal(
    (await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(healthyCursor)}`, account)).status,
    200,
  );
  const revoke = await call('POST', '/api/web/local/admin/invites/revoke-grant', admin, { id: redeemed.data.grantId });
  assert.equal(revoke.status, 200);
  // Revoking the grant ends every session of the player, so each private read and write is now signed out (401).
  assert.equal((await call('GET', '/api/web/local/access', invitee)).status, 401);
  assert.equal((await call('GET', invitedMedia, invitee)).status, 401);
  assert.equal((await call('GET', historyPath(invitedOp.conversationId), invitee)).status, 401);
  assert.equal(
    (
      await call('POST', '/api/web/local/characters/synthetic-local/operations', invitee, {
        requestId: 'c-revoked-send',
        text: 'C 不可发布',
        delivery: 'voice',
      })
    ).status,
    401,
  );
  assert.equal((await call('GET', historyPath(accountOp.conversationId), account)).status, 200);
  assert.equal((await call('POST', '/api/web/local/admin/logout', admin, {})).status, 200);
  assert.notEqual((await call('GET', '/api/web/local/admin/session', admin)).status, 200);
  await stop();

  // The same real 112 database now exercises 003 and 004 without service races.
  const audit = openStore();
  assert.equal(
    audit.get<{ n: number }>(
      `SELECT count(*) n FROM web_invite_grants
    WHERE invite_id=?`,
      contestIssue.data.inviteId,
    )?.n,
    1,
  );
  const expiringId = expiringBoot.data.access.principalId as string;
  const now = Date.now();
  audit.run(
    `UPDATE web_guest_retention SET started_at=?,expires_at=?,revision=revision+1
    WHERE principal_id=? AND state='active'`,
    now - 3 * 60 * 60_000,
    now - 1,
    expiringId,
  );
  const cleaner = new WebRetentionCleaner(audit, clock);
  assert.deepEqual(cleaner.markExpired(expiringId), { duplicate: false });
  assert.deepEqual(cleaner.clearDatabase(expiringId), { duplicate: false });
  const high = audit.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name='web_local_events'")!.seq;
  const live = audit.get<{ seq: number }>('SELECT coalesce(max(seq),0) seq FROM web_local_events')!.seq;
  assert.ok(high > live, '003 fixture must remove the allocated event tail');
  const privateFile = join(root, 'private-audio', `${expiringVoice.audio.mediaId}.wav`);
  assert.equal(existsSync(privateFile), true);
  const files = (cleaner as unknown as { files: WebPrivateAudioFiles }).files;
  const seam = files as unknown as { syncDirectory: (path: string) => void };
  const sync = seam.syncDirectory;
  try {
    seam.syncDirectory = function (path) {
      if (path === files.root) throw Error('C_SYNTHETIC_DIRECTORY_SYNC_FAILURE');
      return sync.call(files, path);
    };
    assert.throws(() => cleaner.clearFiles(expiringId), /C_SYNTHETIC_DIRECTORY_SYNC_FAILURE/);
    assert.equal(existsSync(privateFile), false, 'unlink precedes failed directory sync');
    assert.equal(
      audit.get<{ state: string }>(
        `SELECT state FROM web_retention_file_cleanup
      WHERE media_id=?`,
        expiringVoice.audio.mediaId,
      )?.state,
      'pending',
    );
    assert.throws(
      () => cleaner.clearFiles(expiringId),
      /C_SYNTHETIC_DIRECTORY_SYNC_FAILURE/,
      '004 ENOENT retry must still sync the directory',
    );
    assert.equal(
      audit.get<{ state: string }>(
        `SELECT state FROM web_retention_file_cleanup
      WHERE media_id=?`,
        expiringVoice.audio.mediaId,
      )?.state,
      'pending',
    );
  } finally {
    seam.syncDirectory = sync;
  }
  cleaner.clearFiles(expiringId);
  assert.equal(
    audit.get<{ state: string }>(
      `SELECT state FROM web_retention_file_cleanup
    WHERE media_id=?`,
      expiringVoice.audio.mediaId,
    )?.state,
    'deleted',
  );
  assert.ok(audit.get('SELECT 1 FROM web_local_events WHERE principal_id=?', accountBoot.data.access.principalId));
  assert.equal(audit.get('PRAGMA foreign_key_check'), undefined);
  audit.close();

  await start();
  assert.equal(
    (await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(healthyCursor)}`, account)).status,
    200,
    '003 healthy signed cursor survives other guest T2',
  );
  const fields = JSON.parse(Buffer.from(healthyCursor.split('.')[0]!, 'base64url').toString('utf8'));
  fields[5] = high + 1;
  const payload = Buffer.from(JSON.stringify(fields)).toString('base64url');
  const mac = createHmac('sha256', Buffer.from(config.cursorKey, 'base64url')).update(payload).digest('base64url');
  const future = `${payload}.${mac}`;
  assert.equal(
    (await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(future)}`, account)).data.error.code,
    'INVALID_CURSOR',
  );
  assert.equal((await call('GET', historyPath(accountOp.conversationId), account)).status, 200);
  assert.equal((await call('GET', accountMedia, account)).bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal((await call('GET', invitedMedia, invitee)).status, 401);
  assert.equal((await call('GET', historyPath(expiringOp.conversationId), expiring)).status, 410);
  assert.equal(
    (await call('GET', `/api/web/local/operations/by-request/c-account-message`, account)).data.status,
    'published',
  );
  const sse = await new Promise<{ status: number; type: string | undefined }>((resolveSse, reject) => {
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        ca,
        method: 'GET',
        path: `/api/web/local/events?cursor=${encodeURIComponent(healthyCursor)}`,
        headers: { Cookie: account.cookie },
      },
      (res) => {
        res.once('data', () => {
          resolveSse({ status: res.statusCode ?? 0, type: res.headers['content-type'] });
          req.destroy();
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(sse.status, 200);
  assert.match(sse.type ?? '', /text\/event-stream/);
  await stop();

  // Separate controlled race: revocation lands after audio dispatch but before publication.
  const raceStore = openStore();
  const racingOp = new WebAdmission(raceStore, clock, randomUUID).admit({
    principalId: racingBoot.data.access.principalId,
    requestId: 'c-race-operation',
    characterId: 'synthetic-local',
    text: 'C 撤权中禁止发布',
    ipHash: 'c'.repeat(64),
  });
  const controlled = new WebLocalExecutor(raceStore, clock, {
    audioDelayMs: 25,
    afterSpeechSent: () =>
      raceStore.run('UPDATE web_invite_grants SET revoked_at=? WHERE id=?', Date.now(), raceRedeem.data.grantId),
  });
  try {
    controlled.start();
    for (
      let i = 0;
      i < 60 &&
      raceStore.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', racingOp.operationId)
        ?.status !== 'failed';
      i++
    ) {
      controlled.pump();
      await pause(10);
    }
    assert.equal(
      raceStore.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', racingOp.operationId)?.status,
      'failed',
    );
    assert.equal(
      raceStore.get('SELECT 1 FROM web_publications WHERE operation_id=?', racingOp.operationId),
      undefined,
      'revoked in-flight output must not publish',
    );
    assert.equal(
      raceStore.get<{ dispatch_state: string }>(
        `SELECT dispatch_state FROM web_external_attempts
      WHERE operation_id=? AND stage='audio'`,
        racingOp.operationId,
      )?.dispatch_state,
      'unknown',
    );
  } finally {
    controlled.stop();
    raceStore.close();
  }
  await start();
  assert.equal((await call('GET', '/api/web/local/access', racing)).data.status, 'revoked');
  await stop();
  process.stdout.write(
    JSON.stringify({
      case: 'C-S2-INVITE-FULL-001',
      root,
      schema: 112,
      invitePublished: true,
      accountPublished: true,
      data003: true,
      data004: true,
      restart: true,
      inFlightRevoke: true,
    }) + '\n',
  );
});

test('C isolated schema 110 guest/account remains usable without invite migration', async (t) => {
  const { parent, port } = localRuntime();
  assert.ok([18461, 18491].includes(port));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `local-invite-c-old110-${randomUUID().slice(0, 12)}`);
  const script = resolve('scripts/web-v1.ts');
  for (const action of ['init', 'migrate', 'migrate-data-lifecycle']) {
    const result = spawnSync(process.execPath, [script, action, root], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${action}: ${result.stderr.slice(0, 300)}`);
  }
  const config = readLocalConfig(root),
    ca = readFileSync(join(root, 'local-cert.pem'));
  const child = spawn(process.execPath, [script, 'serve-data-lifecycle', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise<void>((resolveEnd, reject) => {
      const timer = setTimeout(() => reject(Error('110 stop timeout')), 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveEnd();
      });
    });
    child.kill('SIGTERM');
    await ended;
  };
  t.after(stop);
  await new Promise<void>((resolveReady, reject) => {
    let output = '',
      errors = '';
    const timer = setTimeout(() => reject(Error(`110 serve timeout ${errors}`)), 10_000);
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk).slice(0, 200);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`110 serve ${code} ${errors}`));
    });
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('"action":"serve-data-lifecycle"')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  const guest = client(),
    account = client();
  const call = (method: string, path: string, actor: Client, body?: unknown): Promise<Reply> => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolveReply, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          port,
          ca,
          method,
          path,
          headers: {
            ...(actor.cookie ? { Cookie: actor.cookie } : {}),
            ...(bytes ? { Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': actor.csrf } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks),
              setCookie = res.headers['set-cookie']?.[0]?.split(';')[0];
            if (setCookie) actor.cookie = setCookie;
            let data: any = null;
            try {
              data = JSON.parse(raw.toString('utf8'));
            } catch {
              /* WAV */
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
      if (bytes) req.write(bytes);
      req.end();
    });
  };
  const guestBoot = await call('GET', '/api/web/local/bootstrap', guest);
  assert.equal(guestBoot.status, 200);
  assert.equal(guestBoot.data.contractVersion, 'web-v1-local-2');
  const accountBoot = await call('GET', '/api/web/local/bootstrap', account);
  assert.notEqual(accountBoot.data.access.principalId, guestBoot.data.access.principalId);
  const registered = await call('POST', '/api/web/local/register', account, {
    requestId: 'c-old110-register',
    username: `c_${randomUUID().slice(0, 10)}`,
    password: 'synthetic-passphrase',
  });
  assert.equal(registered.status, 200);
  const sent = await call('POST', '/api/web/local/characters/synthetic-local/operations', guest, {
    requestId: 'c-old110-guest-send',
    text: 'C 旧110游客合成文本',
    delivery: 'voice',
  });
  assert.equal(sent.status, 202);
  const operationId = sent.data.operation.operationId;
  for (let i = 0; i < 80; i++) {
    const status = await call('GET', `/api/web/local/operations/${operationId}`, guest);
    if (status.data?.status === 'published') break;
    assert.notEqual(status.data?.status, 'failed');
    await pause(25);
  }
  assert.equal((await call('GET', `/api/web/local/operations/${operationId}`, guest)).data.status, 'published');
  const path = `/api/web/local/conversations/${sent.data.operation.conversationId}/history`;
  assert.equal((await call('GET', path, guest)).status, 200);
  assert.equal((await call('GET', path, account)).status, 404);
  assert.equal((await call('GET', '/api/web/local/bootstrap', account)).data.contractVersion, 'web-v1-local-2');
  await stop();
  process.stdout.write(
    JSON.stringify({
      case: 'C-S2-INVITE-FULL-001-old110',
      root,
      schema: 110,
      guestPublished: true,
      accountIsolated: true,
    }) + '\n',
  );
});
