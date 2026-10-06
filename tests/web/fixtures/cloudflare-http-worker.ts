import { WebCharacterPreviews } from '../../../apps/server/characters/web-character-preview.ts';
import { WebCharacterPreviewRunner } from '../../../apps/server/characters/web-character-preview-runner.ts';
import { WebCloudTextGenerator } from '../../../apps/server/cloudflare/web-generators.ts';
import type { WebGenerationBinding } from '../../../packages/contracts/web-generation-rpc.ts';
import type { WebBudgetStatusRPC } from '../../../apps/server/cloudflare/web-budget-client.ts';
import { WebBudgetObject } from '../../../workers/web-cloudflare/budget.ts';

type PreviewBudgetNamespace = {
  idFromName(name: string): { toString(): string };
  get(id: unknown): WebBudgetStatusRPC;
};
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
import { WebProviderApplication } from '../../../apps/server/generation/web-provider-application.ts';
import { WebProviderHTTP } from '../../../apps/server/cloudflare/web-http.ts';
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
  private readonly app: WebProviderApplication;
  private readonly http: WebProviderHTTP;
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
    this.app = new WebProviderApplication(
      this.store,
      this.clock,
      {
        mode: 'provider-cloud',
        origin: 'https://fixture.invalid',
        cookieName: '__Host-fixture',
        instanceId: this.store.instanceId,
        recoveryEpoch: '00000000-0000-4000-8000-000000000002',
        ipKey: Buffer.alloc(32, 1).toString('base64url'),
        requestKey: Buffer.alloc(32, 2).toString('base64url'),
        sealKey: Buffer.alloc(32, 3).toString('base64url'),
        cursorKey: Buffer.alloc(32, 4).toString('base64url'),
      },
      {
        send: async (message) => {
          this.store.run('INSERT INTO cf_fixture_admin_mail VALUES (?,?)', message.id, JSON.stringify(message));
        },
        waitUntil: (task) => ctx.waitUntil(task),
      },
    );
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
    this.http = new WebProviderHTTP(this.app, {
      wake: () => this.execution.wake(),
      cancel: (id, principal) => this.execution.executor.cancelManaged(id, principal),
    });
  }
  private revoke(principal: string) {
    this.store.run('UPDATE web_sessions SET revoked_at=? WHERE principal_id=?', this.clock.now(), principal);
  }
  alarm() {
    return this.execution.alarm();
  }
  handle(request: Request, peer: string) {
    return this.http.fetch(request, peer);
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
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
    return this.http.fetch(new Request(request, { headers }), '192.0.2.1');
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
