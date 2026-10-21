import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';

type Client = { cookie: string; csrf: string };
type Reply = { status: number; data: any; bytes: Buffer; headers: Record<string, unknown> };
const client = (): Client => ({ cookie: '', csrf: '' });
const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

test('C isolated schema 110 guest/account stays usable over real HTTPS', async (t) => {
  const { parent, port } = localRuntime();
  assert.ok([18461, 18491].includes(port));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `local-110-c-${randomUUID().slice(0, 12)}`);
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
