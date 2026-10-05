import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebStore } from '../../../apps/server/store.ts';
import { WebLocalServer } from '../../../apps/server/web-local-server.ts';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/web-local-config.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

test('INCOMPLETE same-process local-2 TLS revokes history, sync, replay, SSE and media at 2h', async () => {
  const { parent, port } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-a3-http-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root), config = readLocalConfig(root);
  const store = new WebStore(root, { create: false, instanceId: initialized.instanceId,
    dataLifecycleTest: true });
  let app: WebLocalServer | null = null;
  let listening = false;
  try {
    store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(config.recoveryEpoch);
    store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
    store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
    store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic-local', 1,
      JSON.stringify({ id: 'synthetic-local', name: '合成测试人物', version: 1, fictional: true,
        persona: '仅供本地离线接口测试，不是真实人物设定。', schedule: defaultSchedule() }));
    let now = 1_700_000_000_000; const clock = { now: () => now };
    store.migrateDataLifecycle(clock);
    app = new WebLocalServer(store, config, clock);
    await app.listen();
    listening = true;
    const ca = readFileSync(join(root, 'local-cert.pem'));
    let cookie = '', csrf = '';
    const call = async (method: string, path: string, body?: unknown) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      return new Promise<{ status: number; data: any; bytes: Buffer }>((resolve, reject) => {
        const req = httpsRequest({ hostname: '127.0.0.1', port, path, method, ca,
          headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bytes ? {
            'Content-Type': 'application/json', Origin: config.origin, 'X-CSRF-Token': csrf } : {}) } }, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks), set = res.headers['set-cookie']?.[0]?.split(';')[0];
            if (set) cookie = set;
            let data: any = null;
            try { data = JSON.parse(raw.toString('utf8')); } catch { /* WAV or empty */ }
            if (typeof data?.csrf === 'string') csrf = data.csrf;
            resolve({ status: res.statusCode ?? 0, data, bytes: raw });
          });
        });
        req.on('error', reject);
        if (bytes) req.write(bytes);
        req.end();
      });
    };
    const boot = await call('GET', '/api/web/local/bootstrap');
    assert.equal(boot.status, 200);
    assert.equal(boot.data.contractVersion, 'web-v1-local-2');
    assert.equal(boot.data.access.retentionState, 'unstarted');
    const sent = await call('POST', '/api/web/local/characters/synthetic-local/operations',
      { requestId: 'synthetic-first', text: 'synthetic private text', delivery: 'voice' });
    assert.equal(sent.status, 202);
    const operationId = sent.data.operation.operationId, conversationId = sent.data.operation.conversationId;
    let published: any = null;
    for (let i = 0; i < 30; i++) {
      app.executor.pump();
      const response = await call('GET', `/api/web/local/operations/${operationId}`);
      if (response.data?.status === 'published') { published = response.data; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(published, 'synthetic operation published');
    const historyPath = `/api/web/local/conversations/${conversationId}/history`;
    const history = await call('GET', historyPath);
    assert.equal(history.status, 200);
    const voice = history.data.messages.find((message: any) => message.audio?.status === 'ready');
    assert.ok(voice);
    const mediaPath = `/api/web/local/conversations/${conversationId}/messages/${voice.messageId}` +
      `/audio/${voice.audio.mediaId}`;
    assert.equal((await call('GET', mediaPath)).status, 200);
    assert.equal((await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(boot.data.syncCursor)}`)).status, 200);
    let streamReadyResolve!: () => void;
    const streamReady = new Promise<void>(resolve => { streamReadyResolve = resolve; });
    const streamEnded = new Promise<void>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port,
        path: `/api/web/local/events?cursor=${encodeURIComponent(boot.data.syncCursor)}`,
        method: 'GET', ca, headers: { Cookie: cookie } }, res => {
          assert.equal(res.statusCode, 200);
          streamReadyResolve();
          res.on('data', () => {}); res.on('end', resolve);
        });
      req.on('error', reject); req.end();
    });
    await streamReady;
    now += 2 * 60 * 60_000;
    assert.equal((await call('GET', '/api/web/local/access')).data.retentionState, 'expired');
    for (const path of [historyPath, mediaPath,
      `/api/web/local/operations/${operationId}`,
      '/api/web/local/operations/by-request/synthetic-first',
      `/api/web/local/sync?cursor=${encodeURIComponent(boot.data.syncCursor)}`]) {
      const response = await call('GET', path);
      assert.equal(response.status, 410, path);
      assert.equal(response.data.error.code, 'TRIAL_EXPIRED');
      assert.equal(response.bytes.includes(Buffer.from('synthetic private text')), false);
    }
    await Promise.race([streamEnded, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('expired SSE remained open')), 2000))]);
    assert.equal(store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?',
      boot.data.access.principalId)?.state, 'purged');
    const after = await call('GET', '/api/web/local/bootstrap');
    assert.equal(after.data.contractVersion, 'web-v1-local-2');
    assert.deepEqual(after.data.conversations, []);
    assert.deepEqual(after.data.activeOperations, []);
  } finally {
    if (app && listening) await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
