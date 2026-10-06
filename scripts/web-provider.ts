import { WebCharacterPreviewRunner } from '../apps/server/characters/web-character-preview-runner.ts';
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebStore } from '../apps/server/platform/store.ts';
import { initProviderInstance, readLocalConfig } from '../apps/server/platform/web-local-config.ts';
import {
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../apps/server/generation/web-provider-migration.ts';
import {
  validateSelectedVoicePins,
  verifySelectedVoiceSetup,
  type SelectedVoicePins,
  type SelectedCharacterId,
} from '../apps/server/generation/web-provider-materials.ts';
import { configureWebProvider } from '../apps/server/generation/web-provider-configuration.ts';
export { PROVIDER_PRICES, PROVIDER_LIMIT_MICROS } from '../apps/server/generation/web-provider-configuration.ts';
import { DomainError, ensure } from '../packages/domain/errors.ts';
import { textConfiguration } from '../apps/server/platform/config.ts';
import { DeepSeekTextGenerator } from '../apps/server/generation/deepseek.ts';
import { fishTransport, WebProviderRunner } from '../apps/server/generation/web-provider-runner.ts';
import { privateIPv4, WebProviderServer, type ProviderNetwork } from '../apps/server/generation/web-provider-server.ts';
import { WebAccountAdmin } from '../apps/server/admin/web-account-admin.ts';
import { FishAudio } from '../workers/audio/fish.ts';
import { randomUUID } from 'node:crypto';
import { WebProviderBudget } from '../apps/server/budget/web-provider-budget.ts';
import {
  liveBudgetPath,
  openLiveBudget,
  readLiveBudgetHistory,
} from '../apps/server/budget/web-provider-live-budget.ts';
import { renderProviderAssets } from '../apps/server/generation/web-provider-assets.ts';

export function readSelectedVoiceFiles(setupRoot: string, pinned: SelectedVoicePins) {
  validateSelectedVoicePins(pinned);
  const dir = join(setupRoot, pinned.directory);
  const read = (name: string) => readFileSync(join(dir, name));
  const ids = Object.keys(pinned.characters) as SelectedCharacterId[];
  return {
    selection: read('USER-SELECTION.json'),
    publication: read('PUBLICATION.json'),
    characters: Object.fromEntries(
      ids.map((id) => [
        id,
        { voice: read(`${id}-VOICE.json`), draft: read(`${id}-DRAFT.json`), published: read(`${id}-PUBLISHED.json`) },
      ]),
    ) as Record<SelectedCharacterId, { voice: Buffer; draft: Buffer; published: Buffer }>,
  };
}

export function openProviderStore(root: string) {
  const config = readLocalConfig(root);
  ensure(config.mode === 'provider-local', 'WEB_PROVIDER_CONFIG_INVALID');
  return {
    config,
    store: new WebStore(root, {
      create: false,
      instanceId: config.instanceId,
      dataLifecycleTest: true,
      inviteTest: true,
      providerRuntime: true,
      concurrency: config.concurrency,
    }),
  };
}

/** 100→114 on a new provider-* root, importing only digest-verified user selections. */
export function migrateProvider(root: string, selected: ReturnType<typeof verifySelectedVoiceSetup>, now = Date.now()) {
  const { config, store } = openProviderStore(root);
  try {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 100,
      'WEB_PROVIDER_NEW_INSTANCE_REQUIRED',
    );
    store.migrateStages();
    store.migrateAdmissionOrder();
    store.migrateIdentity(config.recoveryEpoch);
    store.migrateDispatchLedger();
    store.migrateSyntheticVoiceQueue();
    store.migrateInputSnapshot();
    store.migrateSyntheticPrivateAudio();
    store.migrateVerticalCandidate();
    store.migrateLocalTransport();
    for (const item of selected)
      store.run(
        'INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)',
        item.characterId,
        item.personaVersion,
        JSON.stringify(item.template),
      );
    store.migrateDataLifecycle({ now: () => now });
    store.migrateInviteCore();
    store.migrateInviteIdentity();
    migrateWebProviderOffline(store);
    configureWebProvider(store, selected, now);
    migrateWebProviderMetrics(store);
    return {
      schema: 114,
      characters: selected.map((item) => ({
        characterId: item.characterId,
        personaVersion: item.personaVersion,
        voiceVersion: item.voice.voiceVersion,
      })),
    };
  } finally {
    store.close();
  }
}

/** Explicit CLI-only load. Tests and configuration diagnostics never call this implicitly. */
function deepSeekEnvironment(path: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return selectedEnvironment(
    path,
    ['TEXT_PROVIDER', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_REVIEW_MODEL', 'DEEPSEEK_API_KEY'],
    inherited,
  );
}

function voiceEnvironment(path: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return selectedEnvironment(path, ['FISH_API_KEY', 'FISH_MODEL'], inherited);
}

function selectedEnvironment(path: string, allowed: string[], inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let values: NodeJS.ProcessEnv = {};
  try {
    const stat = lstatSync(path);
    ensure(stat.isFile() && stat.size <= 16_384 && (stat.mode & 0o077) === 0, 'INSECURE_ENV_FILE');
    values = parseEnv(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DomainError('ENV_FILE_UNREADABLE');
  }
  const selected: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (inherited[key] !== undefined) selected[key] = inherited[key];
    else if (values[key] !== undefined) selected[key] = values[key];
  }
  return selected;
}

/** Live transports from an explicitly named key directory (.env / .env.voice); never logged. */
export function liveTransports(envDir: string) {
  const textEnv = deepSeekEnvironment(join(envDir, '.env'), {});
  const voiceEnv = voiceEnvironment(join(envDir, '.env.voice'), {});
  const text = textConfiguration(textEnv);
  ensure(text.credentialConfigured && Boolean(voiceEnv.FISH_API_KEY?.trim()), 'WEB_PROVIDER_CREDENTIAL_MISSING');
  return {
    text: new DeepSeekTextGenerator({
      apiKey: textEnv.DEEPSEEK_API_KEY!,
      baseUrl: text.baseUrl,
      model: text.model,
      reviewModel: text.reviewModel,
    }),
    fish: new FishAudio({ apiKey: voiceEnv.FISH_API_KEY!, model: 's2.1-pro' }),
  };
}

/**
 * Renders each character's fixed welcome line and trial footer in its bound voice (6 short Fish
 * calls). The shared ledger reserves before dispatch and durably saves bills/results for recovery.
 */
export async function renderAssets(root: string, envDir: string) {
  const budget = openLiveBudget();
  const { store } = openProviderStore(root);
  try {
    budget.recoverKnown(store);
    const { fish } = liveTransports(envDir);
    return await renderProviderAssets(store, { now: () => Date.now() }, budget, fish.generate.bind(fish));
  } finally {
    store.close();
    budget.close();
  }
}

/** Device testing only: this host's own private IPv4 with a matching self-signed certificate. */
export function lanNetwork(root: string, host: string): ProviderNetwork {
  const own = Object.values(networkInterfaces())
    .flat()
    .some((item) => item?.family === 'IPv4' && item.address === host);
  ensure(privateIPv4(host) === host && own, 'WEB_PROVIDER_LAN_INVALID');
  const cert = join(root, `lan-${host}-cert.pem`),
    key = join(root, `lan-${host}-key.pem`);
  if (!existsSync(cert)) {
    const made = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '7',
        '-subj',
        `/CN=${host}`,
        '-addext',
        `subjectAltName=IP:${host}`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    ensure(made.status === 0, 'WEB_LOCAL_TLS_INIT_FAILED');
    chmodSync(cert, 0o600);
    chmodSync(key, 0o600);
  }
  return { host, cert: readFileSync(cert), key: readFileSync(key) };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action, root = '', extra] = process.argv.slice(2);
  ensure(
    ['init', 'migrate', 'render-assets', 'admin-grant', 'serve', 'budget-init', 'budget-status'].includes(
      action ?? '',
    ) &&
      (action?.startsWith('budget-') || root.length > 0),
    'WEB_PROVIDER_USAGE',
  );
  // Fail before reading credentials, opening an instance, generating a certificate, or listening.
  if (action === 'serve' || action === 'render-assets')
    ensure(process.argv.slice(5).includes('--live'), 'WEB_PROVIDER_LIVE_OPT_IN_REQUIRED');
  if (action === 'budget-init') {
    WebProviderBudget.initialize(liveBudgetPath(), readLiveBudgetHistory());
    const budget = openLiveBudget();
    try {
      process.stdout.write(JSON.stringify({ action, budget: budget.summary() }) + '\n');
    } finally {
      budget.close();
    }
  } else if (action === 'budget-status') {
    const budget = openLiveBudget();
    try {
      process.stdout.write(JSON.stringify({ action, budget: budget.summary() }) + '\n');
    } finally {
      budget.close();
    }
  } else if (action === 'init') {
    const created = initProviderInstance(root);
    process.stdout.write(
      JSON.stringify({ action, root: created.root, instanceId: created.instanceId, certificate: created.certificate }) +
        '\n',
    );
  } else if (action === 'migrate') {
    ensure(typeof extra === 'string', 'WEB_PROVIDER_USAGE');
    const pinsFile = join(extra, 'selected-voice-pins.json');
    const stat = lstatSync(pinsFile);
    ensure(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= 16_384,
      'WEB_PROVIDER_PRIVATE_PINS_REQUIRED',
    );
    const pins: unknown = JSON.parse(readFileSync(pinsFile, 'utf8'));
    validateSelectedVoicePins(pins);
    process.stdout.write(
      JSON.stringify({
        action,
        root,
        ...migrateProvider(root, verifySelectedVoiceSetup(readSelectedVoiceFiles(extra, pins), pins)),
      }) + '\n',
    );
  } else if (action === 'render-assets') {
    ensure(typeof extra === 'string', 'WEB_PROVIDER_USAGE');
    const log = (await renderAssets(root, extra)) as { kind: string; characterId: string; billedBytes: number }[];
    process.stdout.write(
      JSON.stringify({ action, rendered: log.map((item) => `${item.characterId}:${item.kind}:${item.billedBytes}B`) }) +
        '\n',
    );
  } else if (action === 'admin-grant') {
    const { config, store } = openProviderStore(root);
    try {
      const grant = new WebAccountAdmin(store, { now: () => Date.now() }, config.origin).issueLoginGrant();
      const file = join(root, `admin-login-grant-${randomUUID()}.json`);
      writeFileSync(file, JSON.stringify(grant), { flag: 'wx', mode: 0o600, flush: true });
      process.stdout.write(JSON.stringify({ action, file, expiresAt: grant.expiresAt }) + '\n');
    } finally {
      store.close();
    }
  } else {
    ensure(typeof extra === 'string', 'WEB_PROVIDER_USAGE');
    const budget = openLiveBudget();
    const lan = process.argv
      .slice(5)
      .find((arg) => arg.startsWith('--lan='))
      ?.slice(6);
    const network = lan === undefined ? undefined : lanNetwork(root, lan);
    const { config, store } = openProviderStore(root);
    const clock = { now: () => Date.now() };
    const live = liveTransports(extra);
    const app = new WebProviderServer(
      store,
      config,
      clock,
      new WebProviderRunner(store, clock, live.text, fishTransport(live.fish), budget),
      network,
      new WebCharacterPreviewRunner(store, clock, live.text, budget),
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      store.close();
      budget.close();
    };
    process.on('SIGINT', () => {
      void stop();
    });
    process.on('SIGTERM', () => {
      void stop();
    });
    try {
      await app.listen();
    } catch (error) {
      store.close();
      budget.close();
      throw error;
    }
    process.stdout.write(
      JSON.stringify({
        action,
        mode: config.mode,
        origin: network ? `https://${network.host}:${config.port}` : config.origin,
        certificate: network ? join(root, `lan-${network.host}-cert.pem`) : join(root, 'local-cert.pem'),
      }) + '\n',
    );
  }
}
