import { WebCharacterPreviews } from '../../../apps/server/characters/web-character-preview.ts';
import { legacySchema } from './legacy-schema.ts';
import { WebCharacterPreviewRunner } from '../../../apps/server/characters/web-character-preview-runner.ts';
import { WebCloudTextGenerator } from '../../../apps/server/cloudflare/web-generators.ts';
import type { WebGenerationBinding } from '../../../packages/contracts/web-generation-rpc.ts';
import type { WebBudgetStatusRPC } from '../../../apps/server/cloudflare/web-budget-client.ts';
import { WebBudgetObject } from '../../../workers/web-cloudflare/budget.ts';

type PreviewBudgetNamespace = {
  idFromName(name: string): { toString(): string };
  get(id: unknown): WebBudgetStatusRPC;
};
const ALERT_FIXTURE_BASE_MS = Date.parse('2026-01-05T02:00:00Z');

export class PreviewBudgetFixture extends WebBudgetObject {
  constructor(
    ctx: { storage: DurableSQLStorage; id: { toString(): string } },
    env: { PREVIEW_BUDGET: PreviewBudgetNamespace },
  ) {
    const target = {
      accountId: 'a'.repeat(32),
      namespaceId: 'b'.repeat(32),
      objectId: env.PREVIEW_BUDGET.idFromName('budget').toString(),
    };
    super(ctx, {
      ACCOUNT_ID: target.accountId,
      BUDGET_NAMESPACE_ID: target.namespaceId,
      BUDGET_OBJECT_ID: target.objectId,
      OPERATOR_ENABLED: 'true',
      BUDGET: { idFromString: (id) => id, get: (id) => env.PREVIEW_BUDGET.get(id) },
    });
    this.initialize(
      (['deepseek', 'fish'] as const).map((provider) => ({
        ...target,
        version: 1,
        id: 'synthetic-' + provider,
        provider,
        micros: 3_000_000,
        priorSpentMicros: 0,
        priorHeldMicros: 0,
        createdAt: 0,
      })),
    );
  }
}
import { WebBusinessFixture } from './cloudflare-business-worker.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { AlarmStorage } from '../../../apps/server/cloudflare/queue-alarm.ts';
import type { PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { WebCloudExecutor } from '../../../apps/server/cloudflare/web-executor.ts';
import { reviewState } from './review-state.ts';
import { WebProviderApplication } from '../../../apps/server/generation/web-provider-application.ts';
import { WebProviderHTTP } from '../../../apps/server/cloudflare/web-http.ts';
import { auditWebLifecycleWorld } from '../../../apps/server/admission/web-lifecycle-audit.ts';
import { playerLoginsRemain, purgeDiagnostics } from '../../../apps/server/identity/web-player-purge.ts';
import { WebAlerts, durableAlertState } from '../../../apps/server/cloudflare/web-alerts.ts';
import { WebCloudRetention } from '../../../apps/server/cloudflare/web-retention.ts';
import { TurnstileGate, type TurnstileVerifier } from '../../../apps/server/identity/web-turnstile.ts';
import {
  publishedWebCharacters,
  characterProfileHash,
  type WebCharacterProfile,
} from '../../../apps/server/characters/web-character-catalog.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { syntheticCharacterReview } from './character-review.ts';

/** Real HTTP, SQL, R2 and Alarm with synthetic transports; these operator routes never ship. */
export class WebHTTPFixture extends WebBusinessFixture {
  private app: WebProviderApplication;
  private http: WebProviderHTTP;
  private readonly appConfig: ConstructorParameters<typeof WebProviderApplication>[2];
  private readonly adminMailer: ConstructorParameters<typeof WebProviderApplication>[3];
  private readonly waitUntil: (task: Promise<void>) => void;
  protected readonly durableStorage: Parameters<typeof durableAlertState>[0];
  private alerts: WebAlerts | undefined;
  private alertMails: { subject: string; text: string }[] = [];
  private alertSkew = 0;
  private readonly execution: WebCloudExecutor;
  private revokeOnRead: string | null = null;
  private readonly previewBudget: WebBudgetStatusRPC | undefined;
  private readonly generation: (WebGenerationBinding & { stats(): Promise<string[]> }) | undefined;
  constructor(
    ctx: { storage: DurableSQLStorage & AlarmStorage; waitUntil(task: Promise<void>): void },
    env: {
      MEDIA: PrivateBucket;
      PREVIEW_BUDGET?: PreviewBudgetNamespace;
      GENERATION?: WebGenerationBinding & { stats(): Promise<string[]> };
    },
  ) {
    let afterRead: () => void = () => {};
    super(
      ctx,
      {
        MEDIA: {
          put: (key, bytes, options) => env.MEDIA.put(key, bytes, options),
          get: async (key) => {
            const result = await env.MEDIA.get(key);
            afterRead();
            return result;
          },
        },
      },
      { now: () => Date.now() },
    );
    afterRead = () => {
      if (this.revokeOnRead) {
        this.revoke(this.revokeOnRead);
        this.revokeOnRead = null;
      }
    };
    this.store.all(
      'CREATE TABLE IF NOT EXISTS cf_fixture_admin_mail(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT',
    );
    this.waitUntil = (task) => ctx.waitUntil(task);
    this.durableStorage = ctx.storage as unknown as Parameters<typeof durableAlertState>[0];
    this.appConfig = {
      mode: 'provider-cloud',
      origin: 'https://fixture.invalid',
      cookieName: '__Host-fixture',
      instanceId: this.store.instanceId,
      recoveryEpoch: '00000000-0000-4000-8000-000000000002',
      ipKey: Buffer.alloc(32, 1).toString('base64url'),
      requestKey: Buffer.alloc(32, 2).toString('base64url'),
      sealKey: Buffer.alloc(32, 3).toString('base64url'),
      cursorKey: Buffer.alloc(32, 4).toString('base64url'),
    };
    this.adminMailer = {
      send: async (message) => {
        this.store.run('INSERT INTO cf_fixture_admin_mail VALUES (?,?)', message.id, JSON.stringify(message));
      },
      waitUntil: (task) => ctx.waitUntil(task),
    };
    this.store.all(
      'CREATE TABLE IF NOT EXISTS cf_fixture_player_mail(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT',
    );
    this.app = new WebProviderApplication(this.store, this.clock, this.appConfig, this.adminMailer);
    let previews: WebCharacterPreviewRunner | undefined;
    if (env.PREVIEW_BUDGET && env.GENERATION) {
      this.previewBudget = env.PREVIEW_BUDGET.get(env.PREVIEW_BUDGET.idFromName('budget'));
      this.generation = env.GENERATION;
      this.store.all(
        'CREATE TABLE IF NOT EXISTS cf_preview_fault(singleton INTEGER PRIMARY KEY,lost_settle INTEGER NOT NULL) STRICT',
      );
      this.store.run('INSERT OR IGNORE INTO cf_preview_fault VALUES (1,0)');
      this.app.characterAdmin.enablePreviews(new WebCharacterPreviews(this.store, this.clock));
      previews = new WebCharacterPreviewRunner(this.store, this.clock, new WebCloudTextGenerator(env.GENERATION), {
        reserve: (...args) => this.previewBudget!.reserve(...args),
        settle: async (...args) => {
          await this.previewBudget!.settle(...args);
          if (this.store.get<{ lost_settle: number }>('SELECT lost_settle FROM cf_preview_fault')!.lost_settle) {
            this.store.run('UPDATE cf_preview_fault SET lost_settle=0');
            throw Error('offline lost RPC receipt');
          }
        },
      });
    }
    this.execution = new WebCloudExecutor(ctx, this.store, this.clock, this.createRunner(), undefined, previews);
    this.http = this.transport();
  }
  /** Part 17 test switches (set through /fixture/players). The Turnstile verifier is fake: no network, ever. */
  private human: TurnstileGate | undefined;
  private humanCalls: { token: string; remoteIp: string | null }[] = [];
  private humanMode: 'normal' | 'down' = 'normal';
  private serverErrors = 0;
  private transport() {
    return new WebProviderHTTP(
      this.app,
      {
        wake: () => this.execution.wake(),
        cancel: (id, principal) => this.execution.executor.cancelManaged(id, principal),
      },
      { human: this.human, onServerError: () => void this.serverErrors++ },
    );
  }
  private fakeVerifier(): TurnstileVerifier {
    return {
      verify: async ({ token, remoteIp }) => {
        this.humanCalls.push({ token, remoteIp });
        if (this.humanMode === 'down') throw new Error('offline siteverify');
        // "good…" tokens pass; the action travels in the token text ("good-guest-1") like Turnstile's own answer.
        const match = /^good-([a-z]+)-/.exec(token);
        return match
          ? { success: true, hostname: 'fixture.invalid', action: match[1]! }
          : { success: false, hostname: 'fixture.invalid' };
      },
    };
  }
  /** Opens player signup with a mailer that records every message (codes included: a fixture, never shipped). */
  private enablePlayers(
    signupEnabled: boolean,
    dailyCap: number | undefined,
    pub: { graceMs?: number; accountDelete?: boolean; legalPages?: boolean; turnstile?: boolean } = {},
  ) {
    const retention = new WebCloudRetention(
      this.store,
      this.clock,
      pub.graceMs ?? 0,
      (report) => this.retentionReports.push(report),
      // Part 17g: tests here retry a failing purge on purpose, back to back; the backoff has its own test (web-retention-world-17g).
      { load: async () => ({ failures: {}, lastSuccessAt: null }), save: async () => {} },
    );
    this.retention = retention;
    this.human = pub.turnstile
      ? new TurnstileGate({
          siteKey: '1x00000000000000000000AA',
          secret: 'fixture-secret-not-real',
          origin: this.appConfig.origin,
          verifier: this.fakeVerifier(),
          clock: this.clock,
        })
      : undefined;
    this.app = new WebProviderApplication(this.store, this.clock, this.appConfig, this.adminMailer, {
      signupEnabled,
      dailyCap,
      graceMs: pub.graceMs ?? 0,
      accountDelete: pub.accountDelete === true,
      legalPages: pub.legalPages === true,
      turnstileSiteKey: this.human ? this.human.siteKey : null,
      purger: {
        begin: (principalId) => retention.beginDeletion(principalId),
        finish: (principalId) => retention.finishDeletion(principalId),
      },
      mailer: {
        send: async (message) => {
          if (this.failPlayerMail) throw new Error('fixture mail failure');
          this.store.run('INSERT INTO cf_fixture_player_mail VALUES (?,?)', message.id, JSON.stringify(message));
        },
        waitUntil: this.waitUntil,
      },
    });
    this.http = this.transport();
  }
  private failPlayerMail = false;
  private revoke(principal: string) {
    this.store.run('UPDATE web_sessions SET revoked_at=? WHERE principal_id=?', this.clock.now(), principal);
  }
  /** Part 17f: what the production Durable Object's alarm does for retention - sweep first, then the queues. */
  private retention: WebCloudRetention | undefined;
  private retentionReports: unknown[] = [];
  async alarm() {
    await this.retention?.sweep();
    return this.execution.alarm();
  }
  handle(request: Request, peer: string) {
    return this.http.fetch(request, peer);
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture/schema-124') return Response.json(legacySchema(this.store));
    if (path === '/fixture/preview/lost-settle') {
      this.store.run('UPDATE cf_preview_fault SET lost_settle=1');
      return Response.json({ configured: true });
    }
    if (path === '/fixture/preview/stats')
      return Response.json({
        budget: await this.previewBudget!.summary(),
        calls: await this.generation!.stats(),
        attempts: this.store.all(
          'SELECT preview_id,phase,state,outcome,shared_settled FROM web_character_preview_attempts',
        ),
        jobs: this.store.all('SELECT id,status,error_code FROM admin_previews'),
      });
    if (path === '/fixture/request') return Response.json({ url: request.url, headers: [...request.headers] });
    if (path === '/fixture/assets') return super.fetch(new Request('http://fixture.invalid/assets'));
    if (path === '/fixture/catalog/review') {
      const { characterId } = (await request.json()) as { characterId: string };
      return Response.json({ previewId: await syntheticCharacterReview(this.store, this.clock.now(), characterId) });
    }
    if (path === '/fixture/catalog/fourth') {
      // SQL fixture of a completed future publication, not a production publication bypass/API.
      const source = publishedWebCharacters(this.store)[0]!,
        id = 'fourth-synthetic';
      const profile: WebCharacterProfile = {
        template: { ...source.template, id, version: 1 },
        presentation: {
          displayName: '<img src=x onerror="alert(1)">',
          publicDescription: '离线动态目录',
          welcome: { text: '合成第四人物欢迎词', version: 'welcome-v1' },
        },
      };
      this.store.transaction(() => {
        this.store.run('INSERT INTO character_templates VALUES (?,1,?)', id, JSON.stringify(profile.template));
        this.store.run(
          'INSERT INTO web_character_versions VALUES (?,1,?,?,NULL)',
          id,
          JSON.stringify(profile),
          characterProfileHash(profile),
        );
        this.store.run('INSERT INTO web_character_catalog VALUES (?,1,3)', id);
        this.store.run(
          `INSERT INTO web_provider_voice_bindings SELECT ?,voice_version,voice_revision,profile_id,
          reference_id,model,source,approved,evidence_json FROM web_provider_voice_bindings WHERE character_id=?`,
          id,
          source.characterId,
        );
      });
      const version = this.store.get<{ voice_version: string }>(
        'SELECT voice_version FROM web_provider_voice_bindings WHERE character_id=?',
        id,
      )!.voice_version;
      await new WebProviderOffline(this.store, this.clock).registerFixedAudio('welcome', {
        characterId: id,
        voiceVersion: version,
        body: profile.presentation.welcome.text,
        wav: syntheticTone(),
      });
      return Response.json({ characterId: id });
    }
    if (path === '/fixture/players') {
      const body = (await request.json()) as {
        signupEnabled: boolean;
        dailyCap?: number;
        failMail?: boolean;
        graceMs?: number;
        accountDelete?: boolean;
        legalPages?: boolean;
        turnstile?: boolean;
        turnstileDown?: boolean;
      };
      this.failPlayerMail = body.failMail === true;
      this.humanMode = body.turnstileDown === true ? 'down' : 'normal';
      this.enablePlayers(body.signupEnabled, body.dailyCap, body);
      return Response.json({ configured: true });
    }
    if (path === '/fixture/turnstile-calls')
      return Response.json({ calls: this.humanCalls, serverErrors: this.serverErrors });
    if (path === '/fixture/turnstile-mode') {
      this.humanMode = ((await request.json()) as { down: boolean }).down ? 'down' : 'normal';
      return Response.json({ configured: true });
    }
    if (path === '/fixture/retention-expire') {
      // Part 17: end this player's trial `agoMs` ago (expires_at in the past) without touching anything else.
      const { principalId, agoMs } = (await request.json()) as { principalId: string; agoMs: number };
      this.store.run(
        "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=? WHERE principal_id=? AND state IN ('active','unstarted')",
        this.clock.now() - agoMs - 1,
        this.clock.now() - agoMs,
        principalId,
      );
      return Response.json({ configured: true });
    }
    if (path === '/fixture/age-principal') {
      // Part 17c: let `ms` pass for one player. The fixture clock is real, so the trial window and the sessions of that
      // player move into the past instead; counters, ledgers and ip rows are untouched. Answers the retention window.
      const { principalId, ms } = (await request.json()) as { principalId: string; ms: number };
      this.store.run(
        'UPDATE web_guest_retention SET started_at=started_at-?,expires_at=expires_at-? WHERE principal_id=? AND started_at IS NOT NULL',
        ms,
        ms,
        principalId,
      );
      this.store.run(
        'UPDATE web_sessions SET created_at=created_at-?,last_active_at=last_active_at-?,absolute_expires_at=absolute_expires_at-? WHERE principal_id=?',
        ms,
        ms,
        ms,
        principalId,
      );
      return Response.json(
        this.store.get('SELECT state,started_at,expires_at FROM web_guest_retention WHERE principal_id=?', principalId),
      );
    }
    if (path === '/fixture/session-lifetime') {
      const { principalId } = (await request.json()) as { principalId: string };
      return Response.json(
        this.store.get(
          'SELECT absolute_expires_at-created_at AS lifetime FROM web_sessions WHERE principal_id=? ORDER BY created_at DESC LIMIT 1',
          principalId,
        ),
      );
    }
    if (path.startsWith('/fixture/alerts/')) {
      // Owner alerts over the REAL Durable Object key-value storage and SQL; the mailer only records.
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, number>) : {};
      const build = () =>
        new WebAlerts({
          store: this.store,
          // ALERT_FIXTURE_CLOCK: deterministic. A fixed base instant (02:00 UTC, well before digestHourUtc 23)
          // plus the test's skew, never the wall clock - otherwise a 6 h skew crosses the digest hour
          // whenever the suite happens to run between ~17:00 and 24:00 UTC.
          clock: { now: () => ALERT_FIXTURE_BASE_MS + this.alertSkew },
          config: {
            to: 'owner@example.com',
            errorsPerHour: body.errorsPerHour ?? 1,
            dailySpendMicros: 1_000_000_000,
            budgetPercent: 80,
            validationFailPercent: 20,
            validationMinSamples: 10,
            digestHourUtc: 23,
          },
          mail: { send: async (message) => void this.alertMails.push(message) },
          state: durableAlertState(this.durableStorage),
          budget: async () => [],
          emailDailyCap: null,
        });
      const action = path.slice('/fixture/alerts/'.length);
      if (action === 'start' || action === 'restart') this.alerts = build();
      else if (action === 'error') await this.alerts!.recordError();
      else if (action === 'skew') this.alertSkew += body.ms ?? 0;
      else if (action === 'check')
        return Response.json({ ...(await this.alerts!.check()), mails: this.alertMails.length });
      return Response.json({ ok: true, mails: this.alertMails });
    }
    if (path === '/fixture/finish-deletion') {
      // Debug aid: run the second half of the purge by hand and report the error code, if any.
      const { principalId } = (await request.json()) as { principalId: string };
      try {
        await new WebCloudRetention(this.store, this.clock).finishDeletion(principalId);
        return Response.json({ error: null });
      } catch (error) {
        const world = this.store.get<{ world_id: string }>(
          'SELECT world_id FROM web_principals WHERE id=?',
          principalId,
        )!.world_id;
        const left = this.store
          .all<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%sqlite%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
          )
          .filter(({ name }) => {
            if (!this.store.all<{ name: string }>(`PRAGMA table_info("${name}")`).some((c) => c.name === 'world_id'))
              return false;
            return !!this.store.get(`SELECT 1 FROM "${name}" WHERE world_id=? LIMIT 1`, world);
          })
          .map((row) => row.name);
        return Response.json({ error: (error as { code?: string }).code ?? String(error), left });
      }
    }
    if (path === '/fixture/purge-diagnostics') return Response.json(purgeDiagnostics(this.store, this.clock.now()));
    if (path === '/fixture/retention-reports') return Response.json(this.retentionReports);
    if (path === '/fixture/purge-block') {
      // Part 17f test fault: a leftover purge gate row makes every clearDatabase fail closed (WEB_RETENTION_SCOPE_UNSAFE).
      const { principalId, on } = (await request.json()) as { principalId: string; on: boolean };
      const world = this.store.get<{ world_id: string }>(
        'SELECT world_id FROM web_principals WHERE id=?',
        principalId,
      )!.world_id;
      if (on) this.store.run('INSERT INTO web_retention_purge_gate VALUES (?,?,1)', principalId, world);
      else this.store.run('DELETE FROM web_retention_purge_gate WHERE principal_id=?', principalId);
      return Response.json({ configured: true });
    }
    if (path === '/fixture/run-alarm') {
      await this.alarm();
      return Response.json({ ran: true });
    }
    if (path === '/fixture/bonus-state') {
      const { principalId } = (await request.json()) as { principalId: string };
      const n = (sql: string, ...args: string[]) => this.store.get<{ n: number }>(sql, ...args)!.n;
      return Response.json({
        grant: n('SELECT count(*) n FROM web_signup_bonus WHERE principal_id=?', principalId),
        bonusOps: n("SELECT count(*) n FROM web_free_operations WHERE tier='bonus' AND principal_id=?", principalId),
        extraOps: n(
          "SELECT count(*) n FROM web_free_operations WHERE tier='trial_extra' AND principal_id=?",
          principalId,
        ),
        bonusOpsLive: n(
          `SELECT count(*) n FROM web_free_operations b JOIN web_operations o ON o.id=b.operation_id
          WHERE b.tier='bonus' AND b.principal_id=? AND o.quota_state IN ('reserved','used')`,
          principalId,
        ),
        entitledOps: n(
          "SELECT count(*) n FROM web_operations WHERE principal_id=? AND metering_type='entitled'",
          principalId,
        ),
        trialOps: n(
          "SELECT count(*) n FROM web_operations WHERE principal_id=? AND metering_type='trial'",
          principalId,
        ),
        principal: this.store.get('SELECT trial_used,trial_reserved FROM web_principals WHERE id=?', principalId),
        ipQuota: this.store.all('SELECT used_total,reserved_total FROM web_ip_lifetime_quota'),
        emails: this.store.all('SELECT email_hmac FROM web_bonus_emails'),
        ipDaily: this.store.all('SELECT day,signups FROM web_signup_ip_daily'),
      });
    }
    if (path === '/fixture/review-state') return Response.json(reviewState(this.store));
    if (path === '/fixture/review-age') {
      // Part 19: let `ms` pass for the anonymous archive (archived_at and expires_at move together, so the 180-day rule holds).
      const { ms } = (await request.json()) as { ms: number };
      this.store.run('UPDATE web_review_archive SET archived_at=archived_at-?,expires_at=expires_at-?', ms, ms);
      return Response.json({ aged: true });
    }
    if (path === '/fixture/review-sweep') {
      await new WebCloudRetention(this.store, this.clock).sweep();
      return Response.json({ swept: true });
    }
    if (path === '/fixture/audit-world') {
      // The same fail-closed lifecycle audit the cleaner ends with: it throws while anything private is left.
      const { principalId } = (await request.json()) as { principalId: string };
      const world = this.store.get<{ world_id: string }>(
        'SELECT world_id FROM web_principals WHERE id=?',
        principalId,
      )!.world_id;
      auditWebLifecycleWorld(this.store, world, 'cleared', 'provider');
      return Response.json({ clean: true, loginsRemain: playerLoginsRemain(this.store, [principalId]) });
    }
    if (path === '/fixture/player-state') {
      const { principalId } = (await request.json()) as { principalId: string };
      const world = this.store.get<{ world_id: string }>(
        'SELECT world_id FROM web_principals WHERE id=?',
        principalId,
      )!.world_id;
      const n = (sql: string, ...args: string[]) => this.store.get<{ n: number }>(sql, ...args)!.n;
      return Response.json({
        retention: this.store.get(
          'SELECT state,db_cleared_at FROM web_guest_retention WHERE principal_id=?',
          principalId,
        ),
        messages: n('SELECT count(*) n FROM messages WHERE world_id=?', world),
        logins: n('SELECT count(*) n FROM web_player_logins WHERE principal_id=?', principalId),
        challenges: n('SELECT count(*) n FROM web_email_challenges WHERE principal_id=?', principalId),
        cards: n('SELECT count(*) n FROM player_profile_versions WHERE world_id=?', world),
        liveSessions: n('SELECT count(*) n FROM web_sessions WHERE principal_id=? AND revoked_at IS NULL', principalId),
        grants: this.store.all(
          'SELECT revoked_at IS NOT NULL AS revoked FROM web_invite_grants WHERE principal_id=?',
          principalId,
        ),
        audit: this.store.all('SELECT actor_id,action,target_id FROM web_admin_audit ORDER BY seq'),
      });
    }
    if (path === '/fixture/age-challenges') {
      // Moves every email challenge into the past so the 60-second cooldown has passed (the fixture clock is real).
      const { ms } = (await request.json()) as { ms: number };
      this.store.run('UPDATE web_email_challenges SET created_at=created_at-?,expires_at=expires_at-?', ms, ms);
      return Response.json({ configured: true });
    }
    if (path === '/fixture/player-mail')
      return Response.json(
        this.store
          .all<{ payload: string }>('SELECT payload FROM cf_fixture_player_mail ORDER BY rowid')
          .map((row) => JSON.parse(row.payload)),
      );
    if (path === '/fixture/grant') return Response.json(this.app.inviteAdmin.issueLoginGrant());
    if (path === '/fixture/admin-mail')
      return Response.json(
        this.store
          .all<{ payload: string }>('SELECT payload FROM cf_fixture_admin_mail ORDER BY rowid')
          .map((row) => JSON.parse(row.payload)),
      );
    if (path === '/fixture/streams')
      return Response.json({ active: Object.getOwnPropertyDescriptor(this.http, 'streams')!.value.size });
    if (path === '/fixture/session-expire') {
      const { principalId } = (await request.json()) as { principalId: string };
      this.store.run(
        'UPDATE web_sessions SET absolute_expires_at=? WHERE principal_id=?',
        this.clock.now(),
        principalId,
      );
      return Response.json({ configured: true });
    }
    if (path === '/fixture/stats')
      return Response.json({
        calls: this.store.all('SELECT * FROM cf_fixture_calls ORDER BY provider'),
        operations: this.store.all('SELECT id,status,quota_state FROM web_operations ORDER BY admission_seq'),
        spending: this.store.all(
          'SELECT provider,spent_micros,held_micros FROM web_provider_spending ORDER BY provider',
        ),
        principals: this.store.get<{ n: number }>('SELECT count(*) n FROM web_principals')!.n,
      });
    if (path === '/fixture/revoke' || path === '/fixture/revoke-on-read' || path === '/fixture/expire') {
      const { principalId } = (await request.json()) as { principalId: string };
      if (path.endsWith('/revoke-on-read')) this.revokeOnRead = principalId;
      else if (path.endsWith('/revoke')) this.revoke(principalId);
      else
        this.store.run(
          'UPDATE web_guest_retention SET started_at=started_at-1,expires_at=? WHERE principal_id=?',
          this.clock.now(),
          principalId,
        );
      return Response.json({ configured: true });
    }
    // Miniflare forwards the local TCP Host even when dispatchFetch preserves the URL.
    const headers = new Headers(request.headers);
    headers.set('host', headers.get('x-fixture-host') ?? 'fixture.invalid');
    headers.delete('x-fixture-host');
    // The fetch client of the test runtime always sends sec-fetch-mode: cors; a test may stand in for a browser navigation.
    const mode = headers.get('x-fixture-fetch-mode');
    if (mode) headers.set('sec-fetch-mode', mode);
    headers.delete('x-fixture-fetch-mode');
    // Part 17b: a test may pick the peer address (per-IP limits); otherwise every request comes from 192.0.2.1.
    const peer = headers.get('x-fixture-peer') ?? '192.0.2.1';
    headers.delete('x-fixture-peer');
    return this.http.fetch(new Request(request, { headers }), peer);
  }
}
export default {
  fetch(
    request: Request,
    env: {
      STATE: {
        idFromName(name: string): unknown;
        get(id: unknown): { fetch(request: Request): Promise<Response> };
      };
    },
  ) {
    return env.STATE.get(env.STATE.idFromName('http')).fetch(request);
  },
};
