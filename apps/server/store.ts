import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import { WEB_LIMITS } from '../../config/web-v1.ts';
import type { Clock } from '../../packages/contracts/index.ts';
import { preflightWebDataPolicyInTransaction } from './web-data-policy-preflight.ts';
import { auditWebLifecycleWorld } from './web-lifecycle-audit.ts';
import { assertLocalRoot, localRuntime, readLocalConfig } from './web-local-config.ts';
import { loadRecoveryPoint } from './recovery.ts';
import type { RecoveryPoint } from '../../packages/contracts/player-api.ts';
import { registerWebRuntime } from './web-store-contract.ts';
import { WebPrivateAudioFiles } from './web-private-audio-files.ts';

interface WebStoreOptions {
  root: string;
  create: boolean;
  instanceId: string;
  dataLifecycleTest?: true;
  inviteTest?: true;
  providerRuntime?: true;
}
const WEB_SCHEMA = 100;
const WEB_STAGE_SCHEMA = 101;
const WEB_ORDER_SCHEMA = 102;
const WEB_IDENTITY_SCHEMA = 103;
const WEB_DISPATCH_SCHEMA = 104;
const WEB_SYNTHETIC_VOICE_SCHEMA = 105;
const WEB_INPUT_SNAPSHOT_SCHEMA = 106;
const WEB_PRIVATE_AUDIO_SCHEMA = 107;
const WEB_VERTICAL_SCHEMA = 108;
const WEB_LOCAL_SCHEMA = 109;
const WEB_DATA_SCHEMA = 110;
const WEB_INVITE_CORE_SCHEMA = 111;
const WEB_INVITE_IDENTITY_SCHEMA = 112;
const WEB_PROVIDER_SCHEMA = 113;
const webDbName = 'web.sqlite';
const webMarkerName = '.web-instance.json';
type WebMarker = {
  format: 1;
  mode: 'web';
  instanceId: string;
  database: 'web.sqlite';
  state: 'initializing' | 'ready';
};

function markerPath(root: string) {
  return join(root, webMarkerName);
}

function syncPath(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function markerExists(root: string) {
  try {
    lstatSync(markerPath(root));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readWebMarker(root: string, expectedId: string) {
  const path = markerPath(root);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') ensure(false, 'WEB_MARKER_MISSING');
    throw error;
  }
  ensure(
    stat.isFile() &&
      stat.nlink === 1 &&
      stat.size > 0 &&
      stat.size <= 512 &&
      (stat.mode & 0o777) === 0o600 &&
      (process.getuid?.() === undefined || stat.uid === process.getuid()),
    'WEB_MARKER_INVALID',
  );
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    ensure(false, 'WEB_MARKER_INVALID');
  }
  ensure(marker !== null && typeof marker === 'object' && !Array.isArray(marker), 'WEB_MARKER_INVALID');
  const value = marker as Partial<WebMarker>;
  ensure(
    Object.keys(value).sort().join(',') === 'database,format,instanceId,mode,state' &&
      value.format === 1 &&
      value.mode === 'web' &&
      value.database === webDbName &&
      typeof value.instanceId === 'string' &&
      /^[a-f0-9-]{36}$/.test(value.instanceId) &&
      (value.state === 'initializing' || value.state === 'ready'),
    'WEB_MARKER_INVALID',
  );
  ensure(value.instanceId === expectedId, 'WEB_INSTANCE_MISMATCH');
  ensure(value.state === 'ready', 'WEB_INSTANCE_INITIALIZING');
}

function writeWebMarker(root: string, instanceId: string, state: WebMarker['state']) {
  const path = state === 'initializing' ? markerPath(root) : `${markerPath(root)}.ready`;
  const marker: WebMarker = { format: 1, mode: 'web', instanceId, database: webDbName, state };
  writeFileSync(path, JSON.stringify(marker), { flag: 'wx', mode: 0o600, flush: true });
  syncPath(root);
  if (state === 'ready') {
    renameSync(path, markerPath(root));
    syncPath(root);
  }
}

function guardNonWebPath(path: string) {
  if (path === ':memory:') return;
  const root = dirname(path);
  ensure(!markerExists(root), 'WEB_SEPARATE_INSTANCE_REQUIRED');
  ensure(basename(path) !== webDbName, 'WEB_MARKER_MISSING');
}

function safeWebPath(path: string, options: WebStoreOptions) {
  ensure(
    isAbsolute(options.root) && resolve(options.root) === options.root && path === join(options.root, webDbName),
    'WEB_ROOT_REQUIRED',
  );
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      ensure(
        !stat.isSymbolicLink() && (current !== absolute || (stat.isFile() && stat.nlink === 1)),
        'WEB_UNSAFE_PATH',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  ensure(!existsSync(join(options.root, 'accepted-release.json')), 'WEB_SEPARATE_INSTANCE_REQUIRED');
  for (let ancestor = options.root; ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    ensure(
      !(basename(ancestor) === 'server' && basename(dirname(ancestor)) === 'runtime') &&
        !existsSync(join(ancestor, 'accepted-release.json')) &&
        !existsSync(join(ancestor, 'runtime/server/state.sqlite')),
      'WEB_SEPARATE_INSTANCE_REQUIRED',
    );
  }
  ensure(/^[a-f0-9-]{36}$/.test(options.instanceId), 'WEB_INSTANCE_ID_REQUIRED');
  if (options.create) ensure(existsSync(dirname(options.root)), 'WEB_PARENT_MISSING');
  ensure(
    options.create ? !existsSync(options.root) : existsSync(path),
    options.create ? 'WEB_INSTANCE_ALREADY_EXISTS' : 'WEB_DATABASE_MISSING',
  );
}

function webIdentity(
  db: DatabaseSync,
  instanceId: string,
  dataLifecycleTest = false,
  inviteTest = false,
  providerRuntime = false,
) {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  ensure(
    [
      WEB_SCHEMA,
      WEB_STAGE_SCHEMA,
      WEB_ORDER_SCHEMA,
      WEB_IDENTITY_SCHEMA,
      WEB_DISPATCH_SCHEMA,
      WEB_SYNTHETIC_VOICE_SCHEMA,
      WEB_INPUT_SNAPSHOT_SCHEMA,
      WEB_PRIVATE_AUDIO_SCHEMA,
      WEB_VERTICAL_SCHEMA,
      WEB_LOCAL_SCHEMA,
      ...(dataLifecycleTest ? [WEB_DATA_SCHEMA] : []),
      ...(inviteTest ? [WEB_INVITE_CORE_SCHEMA, WEB_INVITE_IDENTITY_SCHEMA] : []),
      ...(providerRuntime ? [WEB_PROVIDER_SCHEMA] : []),
    ].includes(version),
    'WEB_SCHEMA_MISMATCH',
  );
  const row = db.prepare('SELECT instance_id FROM web_instance WHERE singleton=1').get() as
    | { instance_id: string }
    | undefined;
  ensure(row?.instance_id === instanceId, 'WEB_INSTANCE_MISMATCH');
}

function preflightWeb(path: string, options: WebStoreOptions) {
  safeWebPath(path, options);
  ensure(
    !options.create || (!options.dataLifecycleTest && !options.inviteTest),
    'WEB_DATA_TEST_EXISTING_ROOT_REQUIRED',
  );
  ensure(!options.inviteTest || options.dataLifecycleTest, 'WEB_INVITE_TEST_SCOPE_REQUIRED');
  ensure(!options.providerRuntime || (options.inviteTest && options.dataLifecycleTest), 'WEB_PROVIDER_SCOPE_REQUIRED');
  if (options.create) return;
  readWebMarker(options.root, options.instanceId);
  if (options.providerRuntime) {
    const runtime = localRuntime();
    ensure(
      dirname(options.root) === runtime.parent && basename(options.root).startsWith('provider-'),
      'WEB_PROVIDER_ROOT_REQUIRED',
    );
    const config = readLocalConfig(options.root);
    ensure(
      config.instanceId === options.instanceId &&
        config.mode === 'provider-local' &&
        config.region === 'local-test' &&
        config.origin === `https://127.0.0.1:${runtime.port}`,
      'WEB_PROVIDER_CONFIG_INVALID',
    );
  } else if (options.dataLifecycleTest) {
    const runtime = localRuntime();
    const role = basename(dirname(runtime.parent));
    const rolePorts: Record<string, number> = { public: 18491 };
    ensure(runtime.port === rolePorts[role] && dirname(options.root) === runtime.parent, 'WEB_DATA_TEST_ROOT_REQUIRED');
    assertLocalRoot(options.root);
    const config = readLocalConfig(options.root);
    ensure(
      config.instanceId === options.instanceId &&
        config.mode === 'synthetic-local' &&
        config.region === 'local-test' &&
        config.origin === `https://127.0.0.1:${runtime.port}`,
      'WEB_DATA_TEST_CONFIG_INVALID',
    );
    if (options.inviteTest) ensure(basename(options.root).startsWith('local-invite-'), 'WEB_INVITE_TEST_ROOT_REQUIRED');
  }
  const probe = new DatabaseSync(path, { readOnly: true });
  try {
    if (options.dataLifecycleTest) {
      const version = (probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      ensure(
        version >= WEB_SCHEMA &&
          version <=
            (options.providerRuntime
              ? WEB_PROVIDER_SCHEMA
              : options.inviteTest
                ? WEB_INVITE_IDENTITY_SCHEMA
                : WEB_DATA_SCHEMA),
        'WEB_DATA_TEST_SCHEMA_REQUIRED',
      );
      if (version >= WEB_IDENTITY_SCHEMA) {
        const config = readLocalConfig(options.root);
        ensure(
          (
            probe.prepare('SELECT recovery_epoch FROM web_instance WHERE singleton=1').get() as
              | { recovery_epoch: string }
              | undefined
          )?.recovery_epoch === config.recoveryEpoch,
          'WEB_DATA_TEST_EPOCH_MISMATCH',
        );
      }
    }
    webIdentity(
      probe,
      options.instanceId,
      options.dataLifecycleTest === true,
      options.inviteTest === true,
      options.providerRuntime === true,
    );
  } finally {
    probe.close();
  }
}

function schemaAllowed(db: DatabaseSync, beta: boolean) {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  ensure(version >= 0 && version <= (beta ? 33 : 24), 'UNSUPPORTED_SCHEMA');
  if (beta && version > 0 && version < 25) {
    ensure(version === 24, 'BETA_EMPTY_INSTANCE_REQUIRED');
    ensure(
      !db.prepare('SELECT 1 FROM worlds LIMIT 1').get() && !db.prepare('SELECT 1 FROM api_players LIMIT 1').get(),
      'BETA_EMPTY_INSTANCE_REQUIRED',
    );
  }
}

export class Store {
  readonly db: DatabaseSync;
  readonly recoveryPoint: RecoveryPoint | null;
  readonly beta: boolean;
  readonly web: boolean;
  readonly betaExternalCalls: boolean;
  #depth = 0;
  constructor(path = ':memory:', options: { beta?: boolean; betaExternalCalls?: boolean; web?: WebStoreOptions } = {}) {
    this.beta = options.beta === true;
    this.web = options.web !== undefined;
    ensure(!(this.beta && this.web), 'WEB_BETA_MODE_CONFLICT');
    // Preserve the old release marker guard before inspecting any beta database.
    ensure(
      !this.beta || path === ':memory:' || !existsSync(join(dirname(path), 'accepted-release.json')),
      'BETA_SEPARATE_INSTANCE_REQUIRED',
    );
    if (options.web) preflightWeb(path, options.web);
    else guardNonWebPath(path);
    if (!options.web && path !== ':memory:' && existsSync(path)) {
      const probe = new DatabaseSync(path, { readOnly: true });
      try {
        schemaAllowed(probe, this.beta);
      } finally {
        probe.close();
      }
    }
    // Process-local permission: opening/restoring a database never restores permission to spend.
    this.betaExternalCalls = this.beta && options.betaExternalCalls === true;
    ensure(options.betaExternalCalls !== true || this.beta, 'BETA_DISABLED');
    this.recoveryPoint = path === ':memory:' ? null : loadRecoveryPoint(dirname(path));
    if (options.web?.create) {
      // The root itself is the create lock: another creator must not join this instance.
      try {
        mkdirSync(options.web.root, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') ensure(false, 'WEB_INSTANCE_ALREADY_EXISTS');
        throw error;
      }
      syncPath(dirname(options.web.root));
      writeWebMarker(options.web.root, options.web.instanceId, 'initializing');
    } else if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true });
    try {
      // Recheck the opened connection before any write-capable PRAGMA or migration.
      if (options.web) {
        if (options.web.create) {
          ensure(
            (this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) === 0 &&
              !this.get("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1"),
            'WEB_DATABASE_NOT_EMPTY',
          );
        } else
          webIdentity(
            this.db,
            options.web.instanceId,
            options.web.dataLifecycleTest === true,
            options.web.inviteTest === true,
            options.web.providerRuntime === true,
          );
      } else schemaAllowed(this.db, this.beta);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    } catch (error) {
      this.db.close();
      throw error;
    }
    try {
      this.transaction(() => {
        const version = this.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
        ensure(
          version >= 0 &&
            (this.web
              ? [
                  0,
                  WEB_SCHEMA,
                  WEB_STAGE_SCHEMA,
                  WEB_ORDER_SCHEMA,
                  WEB_IDENTITY_SCHEMA,
                  WEB_DISPATCH_SCHEMA,
                  WEB_SYNTHETIC_VOICE_SCHEMA,
                  WEB_INPUT_SNAPSHOT_SCHEMA,
                  WEB_PRIVATE_AUDIO_SCHEMA,
                  WEB_VERTICAL_SCHEMA,
                  WEB_LOCAL_SCHEMA,
                  ...(options.web?.dataLifecycleTest ? [WEB_DATA_SCHEMA] : []),
                  ...(options.web?.inviteTest ? [WEB_INVITE_CORE_SCHEMA, WEB_INVITE_IDENTITY_SCHEMA] : []),
                  ...(options.web?.providerRuntime ? [WEB_PROVIDER_SCHEMA] : []),
                ].includes(version)
              : version <= (this.beta ? 33 : 24)),
          'UNSUPPORTED_SCHEMA',
        );
        if (options.web) {
          if (options.web.create) {
            ensure(
              version === 0 && !this.get("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1"),
              'WEB_DATABASE_NOT_EMPTY',
            );
          } else
            webIdentity(
              this.db,
              options.web.instanceId,
              options.web.dataLifecycleTest === true,
              options.web.inviteTest === true,
              options.web.providerRuntime === true,
            );
        }
        if (this.beta && version > 0 && version < 25) {
          ensure(version === 24, 'BETA_EMPTY_INSTANCE_REQUIRED');
          ensure(
            !this.get('SELECT 1 FROM worlds LIMIT 1') && !this.get('SELECT 1 FROM api_players LIMIT 1'),
            'BETA_EMPTY_INSTANCE_REQUIRED',
          );
        }
        if (version < 1) this.db.exec(readFileSync(new URL('./migrations/001_core.sql', import.meta.url), 'utf8'));
        if (version < 2)
          this.db.exec(readFileSync(new URL('./migrations/002_dialogue_memory.sql', import.meta.url), 'utf8'));
        if (version < 3)
          this.db.exec(readFileSync(new URL('./migrations/003_proactive_topics.sql', import.meta.url), 'utf8'));
        if (version < 4)
          this.db.exec(readFileSync(new URL('./migrations/004_player_api.sql', import.meta.url), 'utf8'));
        if (version < 5) this.db.exec(readFileSync(new URL('./migrations/005_admin.sql', import.meta.url), 'utf8'));
        if (version < 6)
          this.db.exec(readFileSync(new URL('./migrations/006_memory_corrections.sql', import.meta.url), 'utf8'));
        if (version < 7) this.db.exec(readFileSync(new URL('./migrations/007_groups.sql', import.meta.url), 'utf8'));
        if (version < 8)
          this.db.exec(readFileSync(new URL('./migrations/008_memory_sources.sql', import.meta.url), 'utf8'));
        if (version < 9)
          this.db.exec(readFileSync(new URL('./migrations/009_clarifications.sql', import.meta.url), 'utf8'));
        if (version < 10) this.db.exec(readFileSync(new URL('./migrations/010_moments.sql', import.meta.url), 'utf8'));
        if (version < 11) this.db.exec(readFileSync(new URL('./migrations/011_autonomy.sql', import.meta.url), 'utf8'));
        if (version < 12)
          this.db.exec(readFileSync(new URL('./migrations/012_voice_delivery.sql', import.meta.url), 'utf8'));
        if (version < 13)
          this.db.exec(readFileSync(new URL('./migrations/013_admin_voice_previews.sql', import.meta.url), 'utf8'));
        if (version < 14)
          this.db.exec(readFileSync(new URL('./migrations/014_external_sources.sql', import.meta.url), 'utf8'));
        if (version < 15)
          this.db.exec(readFileSync(new URL('./migrations/015_paced_delivery.sql', import.meta.url), 'utf8'));
        if (version < 16)
          this.db.exec(readFileSync(new URL('./migrations/016_chat_interactions.sql', import.meta.url), 'utf8'));
        if (version < 17)
          this.db.exec(readFileSync(new URL('./migrations/017_playtest_reset.sql', import.meta.url), 'utf8'));
        if (version < 18)
          this.db.exec(readFileSync(new URL('./migrations/018_audition_expressions.sql', import.meta.url), 'utf8'));
        if (version < 19)
          this.db.exec(readFileSync(new URL('./migrations/019_player_profiles.sql', import.meta.url), 'utf8'));
        if (version < 20)
          this.db.exec(readFileSync(new URL('./migrations/020_relationship_events.sql', import.meta.url), 'utf8'));
        if (version < 21) this.db.exec(readFileSync(new URL('./migrations/021_scenes.sql', import.meta.url), 'utf8'));
        if (version < 22)
          this.db.exec(readFileSync(new URL('./migrations/022_autonomous_moments.sql', import.meta.url), 'utf8'));
        if (version < 23)
          this.db.exec(readFileSync(new URL('./migrations/023_playtest_social.sql', import.meta.url), 'utf8'));
        if (version < 24)
          this.db.exec(readFileSync(new URL('./migrations/024_moment_audience_groups.sql', import.meta.url), 'utf8'));
        if (this.beta && version < 25) {
          this.db.exec(readFileSync(new URL('./migrations/025_beta_accounts.sql', import.meta.url), 'utf8'));
          this.run('INSERT INTO beta_instance VALUES (1,?)', randomUUID());
        }
        if (this.beta && version < 26)
          this.db.exec(readFileSync(new URL('./migrations/026_beta_feedback.sql', import.meta.url), 'utf8'));
        if (this.beta && version < 27)
          this.db.exec(readFileSync(new URL('./migrations/027_beta_evaluations.sql', import.meta.url), 'utf8'));
        if (this.beta && version < 28)
          this.db.exec(readFileSync(new URL('./migrations/028_feedback_workflow.sql', import.meta.url), 'utf8'));
        if (this.beta && version < 29)
          this.db.exec(readFileSync(new URL('./migrations/029_character_requests.sql', import.meta.url), 'utf8'));
        if (this.beta && version < 30)
          this.db.exec(readFileSync(new URL('./migrations/030_beta_costs.sql', import.meta.url), 'utf8'));
        if (this.beta && version < 31)
          this.db.exec(readFileSync(new URL('./migrations/031_beta_audio_queue.sql', import.meta.url), 'utf8'));
        if (this.beta && version < 32)
          this.db.exec(readFileSync(new URL('./migrations/032_beta_reviewed_replies.sql', import.meta.url), 'utf8'));
        if (this.beta && version < 33)
          this.db.exec(readFileSync(new URL('./migrations/033_beta_cost_history.sql', import.meta.url), 'utf8'));
        if (options.web && version < WEB_SCHEMA) {
          this.db.exec(readFileSync(new URL('./web-migrations/100_web_instance.sql', import.meta.url), 'utf8'));
          this.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', options.web.instanceId);
        }
        if (!this.web || version === 0)
          this.db.exec(
            this.web
              ? `PRAGMA user_version = ${WEB_SCHEMA}`
              : this.beta
                ? 'PRAGMA user_version = 33'
                : 'PRAGMA user_version = 24',
          );
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    try {
      if (options.web)
        webIdentity(
          this.db,
          options.web.instanceId,
          options.web.dataLifecycleTest === true,
          options.web.inviteTest === true,
          options.web.providerRuntime === true,
        );
      this.db.exec('PRAGMA optimize');
      if (path !== ':memory:') chmodSync(path, 0o600);
      if (options.web?.create) {
        // SQLite has already committed with synchronous=FULL; persist file names before ready.
        syncPath(path);
        syncPath(options.web.root);
        writeWebMarker(options.web.root, options.web.instanceId, 'ready');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  transaction<T>(work: () => T): T {
    const depth = this.#depth++;
    const savepoint = `nested_${depth}`;
    try {
      this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    } catch (error) {
      this.#depth--;
      throw error;
    }
    try {
      const result = work();
      ensure(!(result instanceof Promise), 'ASYNC_TRANSACTION_FORBIDDEN');
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      // SQLite can already have rolled back the whole transaction on SQLITE_FULL or I/O failure.
      if (this.db.isTransaction)
        this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.#depth--;
    }
  }
  close() {
    this.db.close();
  }
}

/** Explicit web-only entry point; never accepts a beta/original database in place. */
export class WebStore extends Store {
  readonly instanceId: string;
  readonly root: string;
  private readonly dataLifecycleTest: boolean;
  private readonly inviteTest: boolean;
  readonly providerRuntime: boolean;
  /** A persisted invite runtime must have passed the role/root/config preflight on open. */
  requireInviteTest() {
    ensure(
      this.dataLifecycleTest &&
        this.inviteTest &&
        (this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_INVITE_IDENTITY_SCHEMA ||
          (this.providerRuntime &&
            this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_PROVIDER_SCHEMA)),
      'WEB_INVITE_TEST_NOT_AUTHORIZED',
    );
  }
  requireProviderRuntime() {
    ensure(
      this.providerRuntime &&
        this.dataLifecycleTest &&
        this.inviteTest &&
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_PROVIDER_SCHEMA,
      'WEB_PROVIDER_RUNTIME_NOT_AUTHORIZED',
    );
  }
  constructor(
    root: string,
    options: {
      create: boolean;
      instanceId: string;
      dataLifecycleTest?: true;
      inviteTest?: true;
      providerRuntime?: true;
    },
  ) {
    super(join(root, webDbName), { web: { root, ...options } });
    this.instanceId = options.instanceId;
    this.root = root;
    this.dataLifecycleTest = options.dataLifecycleTest === true;
    this.inviteTest = options.inviteTest === true;
    this.providerRuntime = options.providerRuntime === true;
    registerWebRuntime(this);
  }

  webIpKeyFingerprint() {
    return createHash('sha256')
      .update(Buffer.from(readLocalConfig(this.root).ipKey, 'base64url'))
      .digest('hex');
  }
  webReceiptDigest(kind: 'receipt' | 'usage', json: string) {
    const config = readLocalConfig(this.root);
    ensure(
      config.instanceId === this.instanceId &&
        (config.mode === 'synthetic-local' || (config.mode === 'provider-local' && this.providerRuntime)),
      'WEB_LOCAL_INSTANCE_MISMATCH',
    );
    if (config.mode === 'provider-local') this.requireProviderRuntime();
    return createHmac('sha256', Buffer.from(config.requestKey, 'base64url'))
      .update(`web-attempt-${kind}\0`)
      .update(json)
      .digest('hex');
  }
  webPrivateAudioFiles() {
    return new WebPrivateAudioFiles(this.root);
  }

  /** Explicit web-only migration. An ordinary reopen never advances schema100. */
  migrateStages() {
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_SCHEMA,
        'WEB_STAGE_MIGRATION_REQUIRED',
      );
      ensure(
        !this.get("SELECT 1 FROM web_operations WHERE status NOT IN ('queued','failed','cancelled') LIMIT 1"),
        'WEB_STAGE_MIGRATION_UNSAFE',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/101_stage_queue.sql', import.meta.url), 'utf8'));
      this.db.exec(`PRAGMA user_version = ${WEB_STAGE_SCHEMA}`);
    });
  }

  /** Explicit 101→102: persist an admission ticket; never use opaque IDs as FIFO order. */
  migrateAdmissionOrder() {
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_STAGE_SCHEMA,
        'WEB_ADMISSION_ORDER_MIGRATION_REQUIRED',
      );
      ensure(
        this.get<{ n: number }>(`SELECT count(*) n FROM web_operations
        WHERE status NOT IN ('published','cancelled','failed')`)!.n <= WEB_LIMITS.maxGlobalReservedOperations,
        'WEB_GLOBAL_BUDGET_OVERFLOW',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/102_admission_order.sql', import.meta.url), 'utf8'));
      this.db.exec(`PRAGMA user_version = ${WEB_ORDER_SCHEMA}`);
    });
  }

  /** Explicit 102→103; identity is never silently attached to an existing web instance. */
  migrateIdentity(recoveryEpoch: string) {
    ensure(/^[a-f0-9-]{36}$/.test(recoveryEpoch), 'WEB_RECOVERY_EPOCH_REQUIRED');
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_ORDER_SCHEMA,
        'WEB_IDENTITY_MIGRATION_REQUIRED',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/103_identity.sql', import.meta.url), 'utf8'));
      this.run('UPDATE web_instance SET recovery_epoch=? WHERE singleton=1', recoveryEpoch);
      this.db.exec(`PRAGMA user_version = ${WEB_IDENTITY_SCHEMA}`);
    });
  }

  /** Explicit 103→104. Old running/attempt state cannot be inferred as unsent. */
  migrateDispatchLedger() {
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_IDENTITY_SCHEMA,
        'WEB_DISPATCH_MIGRATION_REQUIRED',
      );
      ensure(
        !this.get(
          "SELECT 1 FROM web_operations WHERE status IN ('text_running','audio_running','unknown','retryable_failed') LIMIT 1",
        ) && !this.get('SELECT 1 FROM web_stage_attempts LIMIT 1'),
        'WEB_DISPATCH_MIGRATION_UNSAFE',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/104_dispatch_ledger.sql', import.meta.url), 'utf8'));
      this.db.exec(`PRAGMA user_version = ${WEB_DISPATCH_SCHEMA}`);
    });
  }

  /** Explicit 104→105; the replacement attempt table is audited before the old table is dropped. */
  migrateSyntheticVoiceQueue() {
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_DISPATCH_SCHEMA,
        'WEB_SYNTHETIC_VOICE_MIGRATION_REQUIRED',
      );
      ensure(
        !this.get(`SELECT 1 FROM web_operations WHERE status IN
        ('audio_running','audio_pending','ready_to_publish') LIMIT 1`) &&
          !this.get(`SELECT 1 FROM web_operations o JOIN web_external_attempts a ON a.operation_id=o.id
          WHERE o.status NOT IN ('failed','cancelled') AND a.stage='audio' LIMIT 1`),
        'WEB_SYNTHETIC_VOICE_MIGRATION_UNSAFE',
      );
      ensure(
        !this.get(`SELECT 1 FROM sqlite_master WHERE sql LIKE '%web_external_attempts%'
        AND name NOT IN ('web_external_attempts','web_external_attempts_state') LIMIT 1`),
        'WEB_SYNTHETIC_VOICE_UNRECOGNIZED_REFERENCE',
      );
      ensure(
        !this.get(`SELECT 1 FROM web_external_budgets b WHERE b.reserved<>
        (SELECT count(*) FROM web_external_attempts a WHERE a.provider=b.provider AND a.stage=b.stage
          AND a.phase=b.phase AND a.dispatch_state!='known') LIMIT 1`),
        'WEB_SYNTHETIC_VOICE_BUDGET_MISMATCH',
      );
      const active = this.all<{
        id: string;
        audio_queued_at: number | null;
        reviewed_at: number | null;
        lease_token: string | null;
        audio_attempts: number;
      }>(`SELECT o.id,o.audio_queued_at,c.reviewed_at,o.lease_token,
        (SELECT count(*) FROM web_external_attempts a WHERE a.operation_id=o.id AND a.stage='audio') audio_attempts
        FROM web_operations o LEFT JOIN web_reviewed_candidates c ON c.operation_id=o.id WHERE o.status='text_ready'`);
      ensure(
        active.every(
          (row) =>
            row.audio_queued_at !== null &&
            row.audio_queued_at === row.reviewed_at &&
            row.lease_token === null &&
            row.audio_attempts === 0,
        ),
        'WEB_SYNTHETIC_VOICE_MIGRATION_UNSAFE',
      );
      const candidates = this.all<{ operation_id: string; narrative_json: string; voice_version: string }>(
        'SELECT operation_id,narrative_json,voice_version FROM web_reviewed_candidates',
      );
      const segments = candidates.map((row) => {
        let narrative: unknown;
        try {
          narrative = JSON.parse(row.narrative_json);
        } catch {
          narrative = null;
        }
        ensure(
          Array.isArray(narrative) &&
            narrative.length > 0 &&
            narrative.every((text) => typeof text === 'string' && text.length > 0) &&
            row.voice_version.length > 0,
          'WEB_SYNTHETIC_CANDIDATE_UNSAFE',
        );
        return { operationId: row.operation_id, voiceVersion: row.voice_version, narrative: narrative as string[] };
      });
      this.db.exec(readFileSync(new URL('./web-migrations/105_synthetic_voice_queue.sql', import.meta.url), 'utf8'));
      const oldCount = this.get<{ n: number }>('SELECT count(*) n FROM web_external_attempts')!.n;
      ensure(
        this.get<{ n: number }>('SELECT count(*) n FROM web_external_attempts_next')?.n === oldCount &&
          !this.get('SELECT * FROM web_external_attempts EXCEPT SELECT * FROM web_external_attempts_next LIMIT 1') &&
          !this.get('SELECT * FROM web_external_attempts_next EXCEPT SELECT * FROM web_external_attempts LIMIT 1'),
        'WEB_SYNTHETIC_VOICE_COPY_MISMATCH',
      );
      for (const item of segments)
        for (const [ordinal, body] of item.narrative.entries()) {
          this.run(
            `INSERT INTO web_synthetic_voice_segments(operation_id,ordinal,text_digest,voice_version,state)
          VALUES (?,?,?,?,'pending')`,
            item.operationId,
            ordinal,
            createHash('sha256').update(body).digest('hex'),
            item.voiceVersion,
          );
        }
      for (const row of active)
        this.run(
          `UPDATE web_operations SET audio_wait_used_ms=0,audio_wait_started_at=?
        WHERE id=? AND status='text_ready'`,
          row.audio_queued_at!,
          row.id,
        );
      this.db.exec(`DROP TABLE web_external_attempts;
        ALTER TABLE web_external_attempts_next RENAME TO web_external_attempts;
        CREATE INDEX web_external_attempts_state ON web_external_attempts(dispatch_state,operation_id);
        PRAGMA user_version = ${WEB_SYNTHETIC_VOICE_SCHEMA};`);
      ensure(!this.get('PRAGMA foreign_key_check'), 'WEB_SYNTHETIC_VOICE_FOREIGN_KEY_INVALID');
    });
  }

  /** Explicit 105→106; only queued operations may acquire a first input snapshot. */
  migrateInputSnapshot() {
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_SYNTHETIC_VOICE_SCHEMA,
        'WEB_INPUT_SNAPSHOT_MIGRATION_REQUIRED',
      );
      ensure(
        !this.get(`SELECT 1 FROM web_operations WHERE status NOT IN
        ('queued','published','cancelled','failed') LIMIT 1`) &&
          !this.get(`SELECT 1 FROM web_operations o WHERE o.status='queued' AND
          (EXISTS (SELECT 1 FROM web_reviewed_candidates c WHERE c.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_synthetic_voice_segments s WHERE s.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_external_attempts a WHERE a.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_stage_attempts a WHERE a.operation_id=o.id)) LIMIT 1`),
        'WEB_INPUT_SNAPSHOT_MIGRATION_UNSAFE',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/106_input_snapshot.sql', import.meta.url), 'utf8'));
      this.db.exec(`PRAGMA user_version = ${WEB_INPUT_SNAPSHOT_SCHEMA}`);
      ensure(!this.get('PRAGMA foreign_key_check'), 'WEB_INPUT_SNAPSHOT_FOREIGN_KEY_INVALID');
    });
  }

  /** Explicit 106→107; historical synthetic metadata remains ineligible for assets. */
  migrateSyntheticPrivateAudio() {
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_INPUT_SNAPSHOT_SCHEMA,
        'WEB_PRIVATE_AUDIO_MIGRATION_REQUIRED',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/107_synthetic_private_audio.sql', import.meta.url), 'utf8'));
      this.db.exec(`PRAGMA user_version = ${WEB_PRIVATE_AUDIO_SCHEMA}`);
      ensure(!this.get('PRAGMA foreign_key_check'), 'WEB_PRIVATE_AUDIO_FOREIGN_KEY_INVALID');
    });
  }

  /** Explicit 107→108; old unfinished synthetic work cannot acquire full-v7 publication rights. */
  migrateVerticalCandidate() {
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_PRIVATE_AUDIO_SCHEMA,
        'WEB_VERTICAL_MIGRATION_REQUIRED',
      );
      ensure(
        !this.get(`SELECT 1 FROM web_operations WHERE status NOT IN
        ('queued','published','cancelled','failed') LIMIT 1`) &&
          !this.get(`SELECT 1 FROM web_operations o WHERE o.status='queued' AND
          (EXISTS (SELECT 1 FROM web_reviewed_candidates c WHERE c.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_synthetic_voice_segments s WHERE s.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_external_attempts a WHERE a.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_stage_attempts a WHERE a.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_input_snapshots i WHERE i.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_private_audio_assets p WHERE p.operation_id=o.id)) LIMIT 1`),
        'WEB_VERTICAL_MIGRATION_UNSAFE',
      );
      ensure(
        !this.get(`SELECT 1 FROM web_operations WHERE NOT (
        (status='queued' AND quota_state='reserved') OR
        (status='published' AND quota_state='used') OR
        (status IN ('cancelled','failed') AND quota_state='released')) LIMIT 1`),
        'WEB_VERTICAL_MIGRATION_UNSAFE',
      );
      ensure(
        !this.get(`SELECT 1 FROM web_external_budgets b WHERE b.reserved<>
        (SELECT count(*) FROM web_external_attempts a WHERE a.provider=b.provider AND a.stage=b.stage
          AND a.phase=b.phase AND a.dispatch_state!='known') LIMIT 1`),
        'WEB_VERTICAL_BUDGET_MISMATCH',
      );
      // The old trial debit belongs to the original admission, even if its principal is now an account.
      ensure(
        !this.get(`SELECT 1 FROM web_principals p WHERE p.trial_reserved<>
        (SELECT count(*) FROM web_operations o WHERE o.principal_id=p.id AND o.quota_state='reserved') LIMIT 1`) &&
          !this.get(`SELECT 1 FROM web_ip_windows w WHERE w.reserved<>
          (SELECT count(*) FROM web_operations o WHERE o.ip_window_id=w.id AND o.quota_state='reserved') LIMIT 1`),
        'WEB_VERTICAL_TRIAL_RESERVATION_MISMATCH',
      );
      ensure(
        this.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1 &&
          !this.get(`SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view')
          AND sql LIKE '%web_operations%' LIMIT 1`),
        'WEB_VERTICAL_UNRECOGNIZED_REFERENCE',
      );
      try {
        this.db.exec(readFileSync(new URL('./web-migrations/108_vertical_candidate.sql', import.meta.url), 'utf8'));
      } catch (error) {
        if (String(error).includes('near "ALTER"') || String(error).includes('syntax error'))
          ensure(false, 'WEB_NATIVE_ALTER_COLUMN_REQUIRED');
        throw error;
      }
      this.db.exec(`PRAGMA user_version = ${WEB_VERTICAL_SCHEMA}`);
      ensure(!this.get('PRAGMA foreign_key_check'), 'WEB_VERTICAL_FOREIGN_KEY_INVALID');
    });
  }

  /** Explicit 108→109; never reconstruct old operation events from current rows. */
  migrateLocalTransport() {
    this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_VERTICAL_SCHEMA,
        'WEB_LOCAL_MIGRATION_REQUIRED',
      );
      ensure(
        !this.get(`SELECT 1 FROM web_operations WHERE status NOT IN
        ('queued','published','cancelled','failed','unknown') LIMIT 1`) &&
          !this.get(`SELECT 1 FROM web_operations o WHERE o.status='queued' AND
          (EXISTS (SELECT 1 FROM web_external_attempts a WHERE a.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_v7_requests r WHERE r.operation_id=o.id) OR
           EXISTS (SELECT 1 FROM web_private_audio_assets p WHERE p.operation_id=o.id)) LIMIT 1`),
        'WEB_LOCAL_MIGRATION_UNSAFE',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/109_local_transport.sql', import.meta.url), 'utf8'));
      this.db.exec(`PRAGMA user_version = ${WEB_LOCAL_SCHEMA}`);
      ensure(!this.get('PRAGMA foreign_key_check'), 'WEB_LOCAL_FOREIGN_KEY_INVALID');
    });
  }

  /** Explicit 109→110 only; ordinary reopen still rejects 110 without the scoped test option. */
  migrateDataLifecycle(clock: Clock) {
    ensure(this.dataLifecycleTest, 'WEB_DATA_TEST_NOT_AUTHORIZED');
    return this.transaction(() => {
      webIdentity(this.db, this.instanceId);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_LOCAL_SCHEMA,
        'WEB_DATA_MIGRATION_REQUIRED',
      );
      const migrationNow = clock.now();
      ensure(Number.isSafeInteger(migrationNow) && migrationNow >= 0, 'INVALID_TIME');
      const snapshot = preflightWebDataPolicyInTransaction(
        this,
        { now: () => migrationNow },
        { kind: 'runtime-config' },
      );
      ensure(
        snapshot.consistent && snapshot.keySource === 'runtime-config' && snapshot.keyFingerprint,
        'WEB_DATA_MIGRATION_SOURCE_UNSAFE',
      );
      ensure(
        !this.get(`SELECT 1 FROM worlds w LEFT JOIN web_principals p ON p.world_id=w.id
        GROUP BY w.id HAVING count(p.id)<>1 LIMIT 1`) &&
          !this.get(`SELECT 1 FROM api_players a LEFT JOIN web_principals p ON p.player_id=a.id
          GROUP BY a.id HAVING count(p.id)<>1 LIMIT 1`),
        'WEB_DATA_MIGRATION_SCOPE_UNSAFE',
      );
      for (const principal of this.all<{ world_id: string }>('SELECT world_id FROM web_principals'))
        auditWebLifecycleWorld(this, principal.world_id, 'source');
      const scheduler = this.get<{ coordinator_token: string | null; coordinator_expires_at: number }>(
        'SELECT coordinator_token,coordinator_expires_at FROM web_scheduler_state WHERE singleton=1',
      );
      ensure(
        scheduler &&
          (scheduler.coordinator_token === null || scheduler.coordinator_expires_at <= migrationNow) &&
          !this.get(
            "SELECT 1 FROM web_operations WHERE status IN ('text_running','audio_running','ready_to_publish') LIMIT 1",
          ),
        'WEB_DATA_MIGRATION_ACTIVE_WORK',
      );
      ensure(
        this.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1 &&
          !this.get('PRAGMA foreign_key_check'),
        'WEB_DATA_MIGRATION_FOREIGN_KEY_INVALID',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/110_data_lifecycle.sql', import.meta.url), 'utf8'));
      for (const quota of snapshot.quotas)
        this.run(
          `INSERT INTO web_ip_lifetime_quota
        (ip_hash,key_fingerprint,used_total,reserved_total) VALUES (?,?,?,?)`,
          quota.ipHash,
          snapshot.keyFingerprint!,
          quota.usedTotal,
          quota.reservedTotal,
        );
      for (const retention of snapshot.retention)
        this.run(
          `INSERT INTO web_guest_retention
        (principal_id,world_id,started_at,expires_at,state) VALUES (?,?,?,?,?)`,
          retention.principalId,
          this.get<{ world_id: string }>('SELECT world_id FROM web_principals WHERE id=?', retention.principalId)!
            .world_id,
          retention.firstTrialAcceptedAt,
          retention.expiresAt,
          retention.protectedByUpgrade ? 'protected' : retention.firstTrialAcceptedAt === null ? 'unstarted' : 'active',
        );
      ensure(!this.get('PRAGMA foreign_key_check'), 'WEB_DATA_MIGRATION_FOREIGN_KEY_INVALID');
      this.db.exec(`PRAGMA user_version = ${WEB_DATA_SCHEMA}`);
      return snapshot.sourceDigest;
    });
  }

  /** Explicit offline 110→111; no ordinary open or local-2 serve can opt into this. */
  migrateInviteCore() {
    ensure(this.inviteTest, 'WEB_INVITE_TEST_NOT_AUTHORIZED');
    this.transaction(() => {
      webIdentity(this.db, this.instanceId, true, true);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_DATA_SCHEMA,
        'WEB_INVITE_MIGRATION_REQUIRED',
      );
      ensure(
        !this.get("SELECT 1 FROM web_operations WHERE status NOT IN ('published','cancelled','failed') LIMIT 1"),
        'WEB_INVITE_MIGRATION_ACTIVE_WORK',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/111_invite_core.sql', import.meta.url), 'utf8'));
      ensure(!this.get('PRAGMA foreign_key_check'), 'WEB_INVITE_MIGRATION_FOREIGN_KEY_INVALID');
      this.db.exec(`PRAGMA user_version = ${WEB_INVITE_CORE_SCHEMA}`);
    });
  }

  /** Explicit offline 111→112; no public serve switch is implied. */
  migrateInviteIdentity() {
    ensure(this.inviteTest, 'WEB_INVITE_TEST_NOT_AUTHORIZED');
    this.transaction(() => {
      webIdentity(this.db, this.instanceId, true, true);
      ensure(
        this.get<{ user_version: number }>('PRAGMA user_version')?.user_version === WEB_INVITE_CORE_SCHEMA,
        'WEB_INVITE_IDENTITY_MIGRATION_REQUIRED',
      );
      this.db.exec(readFileSync(new URL('./web-migrations/112_invite_identity.sql', import.meta.url), 'utf8'));
      ensure(!this.get('PRAGMA foreign_key_check'), 'WEB_INVITE_MIGRATION_FOREIGN_KEY_INVALID');
      this.db.exec(`PRAGMA user_version = ${WEB_INVITE_IDENTITY_SCHEMA}`);
    });
  }
}
