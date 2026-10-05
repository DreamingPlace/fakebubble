import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { WebStore } from '../../../apps/server/store.ts';
import { WebLocalServer } from '../../../apps/server/web-local-server.ts';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/web-local-config.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

test('112 isolated HTTPS invite exchange, private publication and revoked access', async (t) => {
  const { parent, port } = localRuntime();
  assert.ok([18441, 18451, 18461, 18491].includes(port));
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-invite-${randomUUID().slice(0, 12)}`);
  initLocalInstance(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = readLocalConfig(root),
    clock = { now: () => Date.now() };
  const store = new WebStore(root, {
    create: false,
    instanceId: config.instanceId,
    dataLifecycleTest: true,
    inviteTest: true,
  });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(config.recoveryEpoch);
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  store.migrateVerticalCandidate();
  store.migrateLocalTransport();
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'synthetic-local',
    1,
    JSON.stringify({
      id: 'synthetic-local',
      name: '合成测试人物',
      version: 1,
      fictional: true,
      persona: '仅供本地离线接口测试，不是真实人物设定。',
      schedule: defaultSchedule(),
    }),
  );
  store.migrateDataLifecycle(clock);
  store.migrateInviteCore();
  store.migrateInviteIdentity();
  const ca = readFileSync(join(root, 'local-cert.pem'));
  const app = new WebLocalServer(store, config, clock);
  await app.listen();
  t.after(async () => app.close());

  async function call(method: string, path: string, body?: unknown, cookie?: string, csrf?: string) {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<{ status: number; data: any; cookie: string | undefined }>((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          ca,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(bytes
              ? {
                  Origin: config.origin,
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': csrf ?? '',
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (value) => chunks.push(Buffer.from(value)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            let data: any;
            try {
              data = JSON.parse(raw.toString('utf8'));
            } catch {
              data = raw;
            }
            resolve({ status: res.statusCode ?? 0, data, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
          });
        },
      );
      req.on('error', reject);
      if (bytes) req.write(bytes);
      req.end();
    });
  }

  const grantRun = spawnSync(process.execPath, ['scripts/web-v1.ts', 'admin-grant', root], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(grantRun.status, 0, grantRun.stderr);
  const grantFile = JSON.parse(grantRun.stdout).file as string;
  assert.equal(statSync(grantFile).mode & 0o777, 0o600);
  const loginGrant = JSON.parse(readFileSync(grantFile, 'utf8')) as { token: string; expiresAt: number };
  assert.ok(!grantRun.stdout.includes(loginGrant.token));
  const login = await call('POST', '/api/web/local/admin/login', { token: loginGrant.token });
  assert.equal(login.status, 200);
  assert.ok(login.cookie?.startsWith(`${config.cookieName}_admin=`));
  const adminSession = await call('GET', '/api/web/local/admin/session', undefined, login.cookie);
  assert.equal(adminSession.status, 200);
  assert.equal(adminSession.data.csrf, login.data.csrf);
  const issue = await call(
    'POST',
    '/api/web/local/admin/invites/issue',
    { requestId: 'issue-1', redeemBy: clock.now() + 60_000, accessDurationMs: null, batch: 'synthetic', note: null },
    login.cookie,
    login.data.csrf,
  );
  assert.equal(issue.status, 201);
  assert.match(issue.data.code, /^[A-Za-z0-9_-]{43}$/);

  const boot = await call('GET', '/api/web/local/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.data.contractVersion, 'web-v1-local-2');
  assert.ok(!boot.data.unsupported.includes('invite'));
  assert.ok(!boot.data.unsupported.includes('admin'));
  const redeem = await call(
    'POST',
    '/api/web/local/invites/redeem',
    { code: issue.data.code, requestId: 'redeem-1' },
    boot.cookie,
    boot.data.csrf,
  );
  assert.equal(redeem.status, 201);
  assert.equal(redeem.data.principalId, boot.data.access.principalId);
  const invited = await call('GET', '/api/web/local/bootstrap', undefined, redeem.cookie);
  assert.equal(invited.status, 200);
  assert.equal(invited.data.contractVersion, 'web-v1-local-3');
  assert.equal(invited.data.access.status, 'active');
  assert.equal(invited.data.access.grantId, redeem.data.grantId);
  const send = await call(
    'POST',
    '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'send-1', text: '你好', delivery: 'voice' },
    redeem.cookie,
    invited.data.csrf,
  );
  assert.equal(send.status, 202);
  let operation: any;
  for (let i = 0; i < 40; i++) {
    const result = await call(
      'GET',
      `/api/web/local/operations/${send.data.operation.operationId}`,
      undefined,
      redeem.cookie,
    );
    operation = result.data;
    if (operation.status === 'published' || operation.status === 'failed') break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.equal(operation.status, 'published');
  const history = await call(
    'GET',
    `/api/web/local/conversations/${operation.conversationId}/history`,
    undefined,
    redeem.cookie,
  );
  assert.equal(history.status, 200);
  assert.ok(history.data.messages.some((message: any) => message.audio?.status === 'ready'));
  const stranger = await call('GET', '/api/web/local/bootstrap');
  const strangerHistory = await call(
    'GET',
    `/api/web/local/conversations/${operation.conversationId}/history`,
    undefined,
    stranger.cookie,
  );
  assert.equal(strangerHistory.status, 404);
  const revoke = await call(
    'POST',
    '/api/web/local/admin/invites/revoke-grant',
    { id: redeem.data.grantId },
    login.cookie,
    login.data.csrf,
  );
  assert.equal(revoke.status, 200);
  const after = await call('GET', '/api/web/local/access', undefined, redeem.cookie);
  assert.equal(after.status, 200);
  assert.equal(after.data.status, 'revoked');
  const forbidden = await call(
    'GET',
    `/api/web/local/conversations/${operation.conversationId}/history`,
    undefined,
    redeem.cookie,
  );
  assert.equal(forbidden.status, 410);
  assert.equal(forbidden.data.error.code, 'WEB_INVITE_ACCESS_REQUIRED');
  const forbiddenSync = await call('GET', '/api/web/local/sync', undefined, redeem.cookie);
  assert.equal(forbiddenSync.status, 410);
  const forbiddenSend = await call(
    'POST',
    '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'send-after-revoke', text: '不应接纳', delivery: 'voice' },
    redeem.cookie,
    invited.data.csrf,
  );
  assert.equal(forbiddenSend.status, 410);
  assert.equal(store.get('SELECT 1 FROM web_operations WHERE request_id=?', 'send-after-revoke'), undefined);
  const logout = await call('POST', '/api/web/local/admin/logout', {}, login.cookie, login.data.csrf);
  assert.equal(logout.status, 200);
  const signedOut = await call('GET', '/api/web/local/admin/session', undefined, login.cookie);
  assert.equal(signedOut.status, 401);
});
