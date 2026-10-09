import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensure } from '../../../packages/domain/errors.ts';
import { WebStore } from './store.ts';
import {
  parseWebConcurrency,
  parseWebDailyReplyLimit,
  WEB_DAILY_REPLY_LIMIT,
  WEB_CONCURRENCY_DEPLOYMENT_DEFAULT,
  type WebConcurrency,
} from '../../../config/web-concurrency.ts';

export interface WebLocalConfig {
  mode: 'synthetic-local' | 'provider-local';
  region: 'local-test';
  instanceId: string;
  recoveryEpoch: string;
  port: number;
  origin: string;
  cookieName: string;
  sealKey: string;
  requestKey: string;
  ipKey: string;
  cursorKey: string;
  /** Stage concurrency and the voice-to-text fallback wait; validated on every read (invalid refuses to start). */
  concurrency: WebConcurrency;
  /** Player-initiated replies per invited player per rolling 24h (1–10000, default 100); invalid refuses to start. */
  dailyReplyLimit: number;
}
const configName = 'local-config.json';
const certName = 'local-cert.pem';
const keyName = 'local-key.pem';
const projectRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export function localRuntime() {
  // Repository-local offline instances; never discovers or opens another checkout's data.
  ensure(realpathSync(projectRoot) === projectRoot, 'WEB_LOCAL_ROOT_INVALID');
  return { parent: join(projectRoot, 'runtime', 'web-v1', 'public', 'db'), port: 18491 };
}

function privateFile(path: string, max: number) {
  const stat = lstatSync(path);
  ensure(
    stat.isFile() &&
      stat.nlink === 1 &&
      stat.size > 0 &&
      stat.size <= max &&
      (stat.mode & 0o777) === 0o600 &&
      (process.getuid?.() === undefined || stat.uid === process.getuid()),
    'WEB_LOCAL_PRIVATE_FILE_INVALID',
  );
  return readFileSync(path);
}

export function assertLocalRoot(root: string) {
  const { parent } = localRuntime();
  ensure(
    resolve(root) === root &&
      dirname(root) === parent &&
      (basename(root).startsWith('local-') || basename(root).startsWith('provider-')) &&
      /^[a-zA-Z0-9_-]{7,60}$/.test(basename(root)),
    'WEB_LOCAL_ROOT_REQUIRED',
  );
  ensure(realpathSync(parent) === parent, 'WEB_LOCAL_PARENT_INVALID');
}

export function initLocalInstance(root: string) {
  ensure(basename(root).startsWith('local-'), 'WEB_LOCAL_ROOT_REQUIRED');
  return initInstance(root, 'synthetic-local');
}

/** Only an explicit new provider-* root can receive this configuration; no schema is migrated here. */
export function initProviderInstance(root: string) {
  ensure(basename(root).startsWith('provider-'), 'WEB_PROVIDER_ROOT_REQUIRED');
  return initInstance(root, 'provider-local');
}

function initInstance(root: string, mode: WebLocalConfig['mode']) {
  assertLocalRoot(root);
  const { port } = localRuntime();
  const instanceId = randomUUID(),
    recoveryEpoch = randomUUID();
  const config: WebLocalConfig = {
    mode,
    region: 'local-test',
    instanceId,
    recoveryEpoch,
    port,
    origin: `https://127.0.0.1:${port}`,
    cookieName: `__Host-fakebubble_${instanceId.replaceAll('-', '').slice(0, 12)}`,
    sealKey: randomBytes(32).toString('base64url'),
    requestKey: randomBytes(32).toString('base64url'),
    ipKey: randomBytes(32).toString('base64url'),
    cursorKey: randomBytes(32).toString('base64url'),
    concurrency: {
      maxTextRunning: WEB_CONCURRENCY_DEPLOYMENT_DEFAULT.maxTextRunning,
      maxAudioRunning: WEB_CONCURRENCY_DEPLOYMENT_DEFAULT.maxAudioRunning,
      maxWaitingOperations: WEB_CONCURRENCY_DEPLOYMENT_DEFAULT.maxWaitingOperations,
      maxGlobalReservedOperations: WEB_CONCURRENCY_DEPLOYMENT_DEFAULT.maxGlobalReservedOperations,
      audioFallbackWaitMs: WEB_CONCURRENCY_DEPLOYMENT_DEFAULT.audioFallbackWaitMs,
    },
    dailyReplyLimit: WEB_DAILY_REPLY_LIMIT.default,
  };
  const store = new WebStore(root, { create: true, instanceId });
  store.close();
  writeFileSync(join(root, configName), JSON.stringify(config), { flag: 'wx', mode: 0o600, flush: true });
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, keyName),
      '-out',
      join(root, certName),
      '-days',
      '7',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { encoding: 'utf8', timeout: 20_000, maxBuffer: 32_000 },
  );
  ensure(result.status === 0, 'WEB_LOCAL_TLS_INIT_FAILED');
  chmodSync(join(root, keyName), 0o600);
  chmodSync(join(root, certName), 0o600);
  return { root, instanceId, certificate: join(root, certName) };
}

export function readLocalConfig(root: string): WebLocalConfig {
  assertLocalRoot(root);
  const { port } = localRuntime();
  let parsed: unknown;
  try {
    parsed = JSON.parse(privateFile(join(root, configName), 4096).toString('utf8'));
  } catch {
    ensure(false, 'WEB_LOCAL_CONFIG_INVALID');
  }
  ensure(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'WEB_LOCAL_CONFIG_INVALID');
  const config = parsed as WebLocalConfig;
  // An absent block (an older instance) takes the deployment default; a present but invalid one refuses to start.
  config.concurrency = parseWebConcurrency(
    (parsed as { concurrency?: Parameters<typeof parseWebConcurrency>[0] }).concurrency,
  );
  config.dailyReplyLimit = parseWebDailyReplyLimit((parsed as { dailyReplyLimit?: unknown }).dailyReplyLimit);
  ensure(
    (config.mode === 'synthetic-local' || config.mode === 'provider-local') &&
      config.region === 'local-test' &&
      config.port === port &&
      config.origin === `https://127.0.0.1:${port}` &&
      /^[a-f0-9-]{36}$/.test(config.instanceId) &&
      /^[a-f0-9-]{36}$/.test(config.recoveryEpoch) &&
      /^__Host-[A-Za-z0-9_-]+$/.test(config.cookieName) &&
      [config.sealKey, config.requestKey, config.ipKey, config.cursorKey].every(
        (value) => typeof value === 'string' && Buffer.from(value, 'base64url').length === 32,
      ),
    'WEB_LOCAL_CONFIG_INVALID',
  );
  privateFile(join(root, certName), 8192);
  privateFile(join(root, keyName), 8192);
  return config;
}

export function localTls(root: string) {
  readLocalConfig(root);
  return { cert: privateFile(join(root, certName), 8192), key: privateFile(join(root, keyName), 8192) };
}
