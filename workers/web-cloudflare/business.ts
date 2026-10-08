import { WebCharacterDeletion } from '../../apps/server/characters/web-character-deletion.ts';
import { WebCharacterPreviews } from '../../apps/server/characters/web-character-preview.ts';
import { WebCharacterPreviewRunner } from '../../apps/server/characters/web-character-preview-runner.ts';
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import { safeError } from '../../apps/server/cloudflare/safe-error.ts';
import type { WebGenerationBinding } from '../../packages/contracts/web-generation-rpc.ts';
import { WebDurableStore } from '../../apps/server/cloudflare/web-store.ts';
import { PrivateMediaObjects, type PrivateBucket } from '../../apps/server/cloudflare/media-objects.ts';
import type { DurableSQLStorage } from '../../apps/server/cloudflare/store.ts';
import type { AlarmStorage } from '../../apps/server/cloudflare/queue-alarm.ts';
import { WebCloudBudgetClient, type WebBudgetStatusRPC } from '../../apps/server/cloudflare/web-budget-client.ts';
import {
  WebCloudTextGenerator,
  webCloudEmbeddings,
  webCloudSpeech,
} from '../../apps/server/cloudflare/web-generators.ts';
import { WebCloudSetup, type WebCloudMaterialPackage } from '../../apps/server/cloudflare/web-setup.ts';
import { WebProviderRunner } from '../../apps/server/generation/web-provider-runner.ts';
import {
  WebProviderApplication,
  type WebProviderApplicationConfig,
} from '../../apps/server/generation/web-provider-application.ts';
import { WebCloudExecutor } from '../../apps/server/cloudflare/web-executor.ts';
import { WebCloudRetention } from '../../apps/server/cloudflare/web-retention.ts';
import { WebProviderHTTP } from '../../apps/server/cloudflare/web-http.ts';
import { trustedWebRequest } from '../../apps/server/cloudflare/web-edge-request.ts';
import { expectedWebMigrations, webR2Migrations } from './migrations.ts';
import {
  inspectBudget,
  inspectErrorCode,
  inspectWebAuthority,
  type WebInspectBudget,
} from '../../apps/server/cloudflare/web-inspect.ts';
import { webConcurrencyFromEnv } from '../../config/web-concurrency.ts';
import { embeddingsEnabled, webEmbedConfigFromEnv, type WebEmbedConfig } from '../../config/web-embeddings.ts';
import type { WebBudgetPolicy } from '../../apps/server/budget/web-provider-budget-contract.ts';
import { cloudAdminMailer, type AdminEmailBinding } from '../../apps/server/cloudflare/web-admin-mail.ts';

interface BusinessContext {
  id: { toString(): string };
  storage: DurableSQLStorage & AlarmStorage;
  waitUntil(task: Promise<void>): void;
}
export interface WebBusinessEnvironment {
  INSTANCE_ID: string;
  RECOVERY_EPOCH: string;
  BUSINESS_OBJECT_ID: string;
  ORIGIN: string;
  COOKIE_NAME: string;
  IP_KEY: string;
  SEAL_KEY: string;
  REQUEST_KEY: string;
  CURSOR_KEY: string;
  MATERIAL_PACKAGE_SHA256: string;
  BUDGET_GRANT_HASHES: string;
  BUDGET_POLICY?: string;
  PUBLIC_ENABLED?: string;
  EXTERNAL_CALLS?: string;
  OPERATOR_ENABLED?: string;
  /** Stage concurrency (decimal strings); validated at construction, absent means the deployment default. */
  MAX_TEXT_RUNNING?: string;
  MAX_AUDIO_RUNNING?: string;
  MAX_WAITING_OPERATIONS?: string;
  AUDIO_FALLBACK_WAIT_MS?: string;
  /** Memory embeddings: off unless 'true' (the generation Worker's AI binding repeats the gate). */
  EMBEDDINGS_ENABLED?: string;
  MAX_EMBED_RUNNING?: string;
  EMBED_QUERY_TIMEOUT_MS?: string;
  ADMIN_EMAIL_ENABLED?: string;
  ADMIN_EMAIL_FROM?: string;
  ADMIN_EMAIL?: AdminEmailBinding;
  MEDIA: PrivateBucket;
  BUDGET: WebBudgetStatusRPC;
  GENERATION: WebGenerationBinding;
}

/** Private authority: only the edge's native DO Fetch may enter HTTP. No provider keys are bound here. */
export class WebBusinessObject extends DurableObject<WebBusinessEnvironment> {
  private readonly env: WebBusinessEnvironment;
  private readonly context: BusinessContext;
  private readonly store: WebDurableStore;
  private readonly clock = { now: () => Date.now() };
  private readonly config: WebProviderApplicationConfig;
  private readonly setup: WebCloudSetup;
  private readonly retention: WebCloudRetention;
  private readonly grantHashes: Record<'deepseek' | 'fish', string>;
  private readonly budgetPolicy: WebBudgetPolicy;
  /** Validated at construction (invalid refuses to start); null while embeddings are disabled. */
  private readonly embedConfig: WebEmbedConfig | null;
  private app?: WebProviderApplication;
  private services: Promise<{ execution: WebCloudExecutor; http: WebProviderHTTP }> | undefined;
  constructor(ctx: BusinessContext, env: WebBusinessEnvironment) {
    super(ctx, env);
    this.env = env;
    this.context = ctx;
    const policy = env.BUDGET_POLICY ?? 'test-cumulative';
    ensure(policy === 'test-cumulative' || policy === 'production-unlimited', 'WEB_CLOUD_BUDGET_POLICY_INVALID');
    this.budgetPolicy = policy;
    this.embedConfig = embeddingsEnabled(env as unknown as Record<string, unknown>)
      ? webEmbedConfigFromEnv(env as unknown as Record<string, unknown>)
      : null;
    ensure(
      /^[a-f0-9]{64}$/.test(env.BUSINESS_OBJECT_ID) && ctx.id.toString() === env.BUSINESS_OBJECT_ID,
      'WEB_CLOUD_OBJECT_MISMATCH',
    );
    const origin = new URL(env.ORIGIN);
    ensure(
      origin.protocol === 'https:' &&
        origin.origin === env.ORIGIN &&
        !origin.username &&
        !origin.password &&
        /^__Host-[A-Za-z0-9_-]{1,48}$/.test(env.COOKIE_NAME),
      'WEB_CLOUD_CONFIG_INVALID',
    );
    const keys = [env.IP_KEY, env.SEAL_KEY, env.REQUEST_KEY, env.CURSOR_KEY];
    ensure(
      keys.every(
        (key) =>
          typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, 'base64url').length === 32,
      ),
      'WEB_IDENTITY_KEYS_REQUIRED',
    );
    this.grantHashes = JSON.parse(env.BUDGET_GRANT_HASHES) as typeof this.grantHashes;
    ensure(
      this.grantHashes &&
        Object.keys(this.grantHashes).sort().join(',') === 'deepseek,fish' &&
        Object.values(this.grantHashes).every((hash) => /^[a-f0-9]{64}$/.test(hash)),
      'WEB_CLOUD_BUDGET_GRANTS_REQUIRED',
    );
    this.config = {
      mode: 'provider-cloud',
      origin: env.ORIGIN,
      cookieName: env.COOKIE_NAME,
      instanceId: env.INSTANCE_ID,
      recoveryEpoch: env.RECOVERY_EPOCH,
      ipKey: env.IP_KEY,
      sealKey: env.SEAL_KEY,
      requestKey: env.REQUEST_KEY,
      cursorKey: env.CURSOR_KEY,
    };
    this.store = new WebDurableStore(ctx.storage, webR2Migrations, {
      instanceId: env.INSTANCE_ID,
      recoveryEpoch: env.RECOVERY_EPOCH,
      keys: { ipKey: Buffer.from(env.IP_KEY, 'base64url'), requestKey: Buffer.from(env.REQUEST_KEY, 'base64url') },
      providerAudio: new PrivateMediaObjects(env.MEDIA),
      concurrency: webConcurrencyFromEnv(env as unknown as Record<string, unknown>),
    });
    const configHash = createHash('sha256')
      .update(
        JSON.stringify([
          this.config,
          env.BUSINESS_OBJECT_ID,
          this.grantHashes.deepseek,
          this.grantHashes.fish,
          this.budgetPolicy,
        ]),
      )
      .digest('hex');
    this.setup = new WebCloudSetup(this.store, this.clock, configHash, env.MATERIAL_PACKAGE_SHA256, this.budgetPolicy);
    this.retention = new WebCloudRetention(this.store, this.clock);
  }
  private operator() {
    ensure(this.env.OPERATOR_ENABLED === 'true', 'WEB_CLOUD_OPERATOR_DISABLED');
  }
  initialize(value: WebCloudMaterialPackage) {
    this.operator();
    return this.setup.initialize(value);
  }
  importFixed(kind: 'welcome' | 'footer', characterId: string, bytes: Uint8Array) {
    this.operator();
    return this.setup.importFixed(kind, characterId, bytes);
  }
  private application() {
    this.setup.ready();
    if (!this.app) {
      const enabled = this.env.ADMIN_EMAIL_ENABLED === 'true';
      ensure(!enabled || (this.env.ADMIN_EMAIL && this.env.ADMIN_EMAIL_FROM), 'WEB_ADMIN_MAIL_CONFIG_INVALID');
      this.app = new WebProviderApplication(
        this.store,
        this.clock,
        this.config,
        enabled
          ? cloudAdminMailer(this.env.ADMIN_EMAIL!, this.env.ADMIN_EMAIL_FROM!, (task) => this.context.waitUntil(task))
          : undefined,
      );
    }
    return this.app;
  }
  adminGrant() {
    this.operator();
    return this.application().inviteAdmin.issueLoginGrant();
  }
  adminRecoveryGrant(memberId: string) {
    this.operator();
    return this.application().inviteAdmin.issueRecoveryGrant(memberId);
  }
  inviteGrants(inviteId: string) {
    this.operator();
    this.setup.ready();
    ensure(typeof inviteId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(inviteId), 'WEB_INVITE_UNAVAILABLE');
    ensure(this.store.get('SELECT 1 FROM web_invite_codes WHERE id=?', inviteId), 'WEB_INVITE_UNAVAILABLE');
    // IDs only; revocation still requires the existing administrator/CSRF route.
    return this.store.all<{ grantId: string }>(
      'SELECT id AS grantId FROM web_invite_grants WHERE invite_id=? ORDER BY id',
      inviteId,
    );
  }
  async status() {
    this.operator();
    return { instanceId: this.store.instanceId, setup: this.setup.status(), budget: await this.budget() };
  }
  /** Read-only: SELECTs and one budget summary read. The constructor has already applied and verified migrations. */
  async inspect() {
    this.operator();
    let budget: WebInspectBudget;
    try {
      budget = inspectBudget(await this.env.BUDGET.summary());
    } catch (error) {
      budget = { available: false, error: inspectErrorCode(error) };
    }
    return inspectWebAuthority(
      { all: (sql, ...params) => this.store.all(sql, ...params) },
      { active: 'r2', ...expectedWebMigrations() },
      {
        PUBLIC_ENABLED: this.env.PUBLIC_ENABLED,
        EXTERNAL_CALLS: this.env.EXTERNAL_CALLS,
        OPERATOR_ENABLED: this.env.OPERATOR_ENABLED,
        EMBEDDINGS_ENABLED: this.env.EMBEDDINGS_ENABLED,
      },
      budget,
    );
  }
  private async budget() {
    const summary = await this.env.BUDGET.summary();
    ensure(
      summary.length === 2 &&
        summary.every((row) => row.grantHash === this.grantHashes[row.provider] && row.policy === this.budgetPolicy) &&
        new Set(summary.map((row) => row.provider)).size === 2,
      'WEB_CLOUD_BUDGET_GRANT_MISMATCH',
    );
    return summary;
  }
  private async start() {
    ensure(this.env.EXTERNAL_CALLS === 'true', 'WEB_PROVIDER_LIVE_OPT_IN_REQUIRED');
    const app = this.application();
    if (!this.services) {
      const pending = (async () => {
        await this.budget();
        const runner = new WebProviderRunner(
          this.store,
          this.clock,
          new WebCloudTextGenerator(this.env.GENERATION),
          webCloudSpeech(this.env.GENERATION),
          new WebCloudBudgetClient(this.env.BUDGET),
          this.embedConfig
            ? { provider: webCloudEmbeddings(this.env.GENERATION), config: this.embedConfig }
            : undefined,
        );
        await runner.whenReady();
        app.characterAdmin.enablePreviews(new WebCharacterPreviews(this.store, this.clock));
        const previews = new WebCharacterPreviewRunner(
          this.store,
          this.clock,
          new WebCloudTextGenerator(this.env.GENERATION),
          this.env.BUDGET,
        );
        const execution = new WebCloudExecutor(
          this.context,
          this.store,
          this.clock,
          runner,
          () => this.retention.nextDue(),
          previews,
        );
        const http = new WebProviderHTTP(app, {
          wake: () => execution.wake(),
          cancel: (id, principal) => execution.executor.cancelManaged(id, principal),
        });
        return { execution, http };
      })();
      this.services = pending;
      void pending.catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'web_business_start_failed', ...safeError(error) }));
        if (this.services === pending) this.services = undefined;
      });
    }
    return this.services;
  }
  async alarm() {
    // Privacy cleanup must survive restart, disabled providers and unavailable budget RPC.
    await this.context.storage.setAlarm(this.clock.now() + 30_000);
    await this.retention.sweep();
    const deletion = this.store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_deletion_schema'")
      ? new WebCharacterDeletion(this.store, this.clock)
      : null;
    await deletion?.sweep();
    if (this.env.EXTERNAL_CALLS === 'true') {
      let services: Awaited<ReturnType<typeof this.start>>;
      try {
        services = await this.start();
      } catch (error) {
        console.error(JSON.stringify({ event: 'web_business_alarm_start_failed', ...safeError(error) }));
        throw error;
      }
      return services.execution.alarm();
    }
    const next = Math.min(this.retention.nextDue() ?? Infinity, deletion?.nextDue() ?? Infinity);
    const due = Number.isFinite(next) ? next : null;
    if (due === null) await this.context.storage.deleteAlarm();
    else await this.context.storage.setAlarm(Math.max(this.clock.now() + 1000, due));
  }
  async fetch(incoming: Request) {
    let stage: 'public-disabled' | 'edge-request' | 'start' | 'unknown' = 'public-disabled';
    try {
      ensure(this.env.PUBLIC_ENABLED === 'true', 'WEB_CLOUD_PUBLIC_DISABLED');
      stage = 'edge-request';
      const { request, peer } = trustedWebRequest(incoming);
      stage = 'start';
      const services = await this.start();
      stage = 'unknown';
      return services.http.fetch(request, peer);
    } catch (error) {
      console.error(JSON.stringify({ event: 'web_business_unavailable', stage, ...safeError(error) }));
      return Response.json(
        { error: { code: 'SERVICE_UNAVAILABLE', requestId: null, retryAfterMs: null } },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
  }
}

interface OperatorEnvironment {
  OPERATOR_ENABLED?: string;
  BUSINESS_OBJECT_ID: string;
  BUSINESS: {
    idFromName(name: string): { toString(): string };
    idFromString(id: string): unknown;
    get(id: unknown): {
      initialize(value: WebCloudMaterialPackage): Promise<unknown>;
      importFixed(kind: 'welcome' | 'footer', characterId: string, bytes: Uint8Array): Promise<string>;
      adminGrant(): Promise<unknown>;
      adminRecoveryGrant(memberId: string): Promise<unknown>;
      inviteGrants(inviteId: string): Promise<unknown>;
      status(): Promise<unknown>;
      inspect(): Promise<unknown>;
    };
  };
}
/** Invoked only through an authenticated private service binding, never an HTTP operator route. */
export class WebOperatorService extends WorkerEntrypoint<OperatorEnvironment> {
  private enabled() {
    ensure(this.env.OPERATOR_ENABLED === 'true', 'WEB_CLOUD_OPERATOR_DISABLED');
  }
  objectId(name: string) {
    this.enabled();
    ensure(/^[A-Za-z0-9_-]{1,128}$/.test(name), 'WEB_CLOUD_OBJECT_NAME_INVALID');
    return this.env.BUSINESS.idFromName(name).toString();
  }
  private authority() {
    this.enabled();
    return this.env.BUSINESS.get(this.env.BUSINESS.idFromString(this.env.BUSINESS_OBJECT_ID));
  }
  async initialize(value: WebCloudMaterialPackage) {
    return this.authority().initialize(value);
  }
  async importFixed(kind: 'welcome' | 'footer', characterId: string, bytes: Uint8Array) {
    return this.authority().importFixed(kind, characterId, bytes);
  }
  async adminGrant() {
    return this.authority().adminGrant();
  }
  async adminRecoveryGrant(memberId: string) {
    return this.authority().adminRecoveryGrant(memberId);
  }
  async inviteGrants(inviteId: string) {
    return this.authority().inviteGrants(inviteId);
  }
  async status() {
    return this.authority().status();
  }
  async inspect() {
    return this.authority().inspect();
  }
  fetch() {
    return new Response(null, { status: 404 });
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
