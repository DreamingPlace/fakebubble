import { WebCharacterPreviewRunner } from '../apps/server/web-character-preview-runner.ts';
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebStore } from '../apps/server/store.ts';
import { initProviderInstance, readLocalConfig } from '../apps/server/web-local-config.ts';
import { migrateWebProviderOffline } from '../apps/server/web-provider-migration.ts';
import {
  validateSelectedVoicePins,
  verifySelectedVoiceSetup,
  type SelectedVoicePins,
  type SelectedCharacterId,
} from '../apps/server/web-provider-materials.ts';
import { configureWebProvider } from '../apps/server/web-provider-configuration.ts';
export { PROVIDER_PRICES, PROVIDER_LIMIT_MICROS } from '../apps/server/web-provider-configuration.ts';
import { ensure } from '../packages/domain/errors.ts';
import { textConfiguration } from '../apps/server/config.ts';
import { deepSeekEnvironment, voiceEnvironment } from '../apps/server/credentials.ts';
import { DeepSeekTextGenerator } from '../apps/server/deepseek.ts';
import { fishTransport, WebProviderRunner } from '../apps/server/web-provider-runner.ts';
import { privateIPv4, WebProviderServer, type ProviderNetwork } from '../apps/server/web-provider-server.ts';
import { WebAccountAdmin } from '../apps/server/web-account-admin.ts';
import { FishAudio } from '../workers/audio/fish.ts';
import { randomUUID } from 'node:crypto';
import { WebProviderBudget } from '../apps/server/web-provider-budget.ts';
import { liveBudgetPath, openLiveBudget, readLiveBudgetHistory } from '../apps/server/web-provider-live-budget.ts';
import { renderProviderAssets } from '../apps/server/web-provider-assets.ts';

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
    }),
  };
}

/** 100→113 on a new provider-* root, importing only digest-verified user selections. */
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
    return {
      schema: 113,
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
