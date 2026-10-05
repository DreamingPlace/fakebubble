import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import { WebDurableStore } from '../../../apps/server/cloudflare/web-store.ts';
import { webMigrations, webR2Migrations } from '../../../workers/web-cloudflare/migrations.ts';
import { PrivateMediaObjects, type PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebInviteAdmin } from '../../../apps/server/web-invite-admin.ts';
import { WebInvites } from '../../../apps/server/web-invites.ts';
import { WebInviteActions } from '../../../apps/server/web-invite-actions.ts';
import { requireWebContent } from '../../../apps/server/web-retention.ts';
import { configureWebProvider } from '../../../apps/server/web-provider-configuration.ts';
import { WebProviderOffline } from '../../../apps/server/web-provider-offline.ts';
import { WebProviderRunner } from '../../../apps/server/web-provider-runner.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { WebVerticalPublisher, SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/web-vertical-publisher.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/deepseek.ts';
import { readWebV7Request } from '../../../apps/server/web-v7-request.ts';
import { syntheticTone } from '../../../apps/server/web-local-fake.ts';
import { draftEnvelope, acceptedAuditEnvelope } from '../../text-fixtures.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { syntheticSelection } from './provider-selection.ts';
import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import type { Clock } from '../../../packages/contracts/index.ts';

const origin = 'https://fixture.invalid', fixedClock = { now: () => 1_800_000_000_000 };
const requestKey = Buffer.alloc(32, 2);
const identityConfig = { instanceId: '00000000-0000-4000-8000-000000000001',
  recoveryEpoch: '00000000-0000-4000-8000-000000000002',
  keys: { ipKey: Buffer.alloc(32, 1), requestKey } };

/** Offline workerd fixture only. The testing routes and fixed keys are never a deployment entry. */
export class WebBusinessFixture {
  protected readonly store: WebDurableStore;
  protected readonly clock: Clock;
  private readonly identity: WebIdentity;
  private readonly admin: WebInviteAdmin;
  private readonly actions: WebInviteActions;
  private readonly admission: WebAdmission;
  private fault: { mode: string; principalId?: string } | null = null;
  private readonly bucket: PrivateBucket | undefined;
  constructor(ctx: { storage: DurableSQLStorage }, env?: { MEDIA?: PrivateBucket }, clock: Clock = fixedClock) {
    this.clock = clock;
    this.bucket = env?.MEDIA;
    const media = this.bucket ? new PrivateMediaObjects({
      put: async (key, bytes, options) => {
        if (this.fault?.mode === 'put-fail') { this.fault = null; throw new DomainError('OFFLINE_R2_FAILED'); }
        const result = await this.bucket!.put(key, bytes, options);
        if (this.fault?.mode === 'stale-on-put') {
          this.fault = null;
          this.store.run("UPDATE web_operations SET lease_expires_at=? WHERE status='audio_running'", clock.now());
        }
        return result;
      }, get: async key => {
        const result = await this.bucket!.get(key);
        if (this.fault?.mode === 'expire-on-get') {
          // The fixture clock is fixed. Preserve expires_at > started_at while expiring at now.
          this.store.run('UPDATE web_guest_retention SET started_at=started_at-1,expires_at=? WHERE principal_id=?',
            clock.now(), this.fault.principalId!);
          this.fault = null;
        }
        if (this.fault?.mode === 'publish-stale-on-get' &&
          this.store.get("SELECT 1 FROM web_operations WHERE status='ready_to_publish'")) {
          this.store.run("UPDATE web_operations SET lease_expires_at=? WHERE status='ready_to_publish'", clock.now());
          this.fault = null;
        }
        return result;
      },
    }) : undefined;
    this.store = new WebDurableStore(ctx.storage, media ? webR2Migrations : webMigrations,
      { ...identityConfig, ...(media ? { providerAudio: media } : {}) });
    if (!this.store.get('SELECT 1 FROM character_templates')) this.store.transaction(() => {
      const selected = syntheticSelection();
      for (const item of selected) this.store.run('INSERT INTO character_templates VALUES (?,?,?)',
        item.characterId, item.personaVersion, JSON.stringify(item.template));
      configureWebProvider(this.store, selected, clock.now());
      const ledger = new WebProviderOffline(this.store, clock);
      if (!media) for (const item of selected) ledger.registerApprovedFooter({ characterId: item.characterId,
        voiceVersion: item.voice.voiceVersion, body: SYNTHETIC_TRIAL_FOOTER, wav: syntheticTone(), approved: true });
      this.store.run('CREATE TABLE cf_fixture_calls(provider TEXT PRIMARY KEY,n INTEGER NOT NULL)');
    });
    this.identity = new WebIdentity(this.store, { origin, cookieName: '__Host-fixture', clock,
      keys: { keyId: 'fixture', sealKey: Buffer.alloc(32, 3), requestKey } });
    this.admin = new WebInviteAdmin(this.store, clock, origin);
    const invites = new WebInvites(this.store, { clock,
      codeKey: createHmac('sha256', requestKey).update('web-local-invite-code-v1').digest(),
      authorize: this.identity.authorizeInviteAction.bind(this.identity), identity: this.identity });
    this.actions = new WebInviteActions(this.store, clock, origin, invites, this.identity);
    this.admission = new WebAdmission(this.store, clock, randomUUID);
  }
  protected createRunner(audioMs = 250, beforeResult?: (provider: string, signal: AbortSignal) => Promise<void>) {
    const called = (provider: string) => this.store.run(`INSERT INTO cf_fixture_calls VALUES (?,1)
      ON CONFLICT(provider) DO UPDATE SET n=n+1`, provider);
    const text = new DeepSeekTextGenerator({ apiKey: 'offline-only', textProtocol: 'accepted-v7',
      fetch: async (_url, init) => {
        called('text');
        const body = JSON.parse(String(init?.body));
        const current = this.store.all<{ id: string; world_id: string; conversation_id: string; character_id: string }>(
          "SELECT * FROM web_operations WHERE status='text_running'").find(row =>
          createHash('sha256').update(JSON.stringify([row.world_id,row.conversation_id,row.character_id])).digest('hex') === body.user_id)!;
        const { request } = readWebV7Request(this.store, current.id);
        const tool = body.tools[0].function.name;
        await beforeResult?.('text', init!.signal!);
        return Response.json(tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request));
      } });
    return new WebProviderRunner(this.store, this.clock, text, async (wire, signal) => {
      called('speech'); await beforeResult?.('speech', signal);
      return { audio: syntheticTone(audioMs), receipt: { offline: true }, usageUnits: wire.billedTextBytes };
    });
  }
  async fetch(request: Request) {
    try {
      const clock = this.clock;
      const body = request.method === 'POST' ? await request.json() as Record<string, any> : {};
      const path = new URL(request.url).pathname;
      let value: unknown;
      if (path === '/bootstrap') {
        value = this.store.transaction(() => {
          const result = this.identity.bootstrap(body.token);
          const principal = this.store.get<{ world_id: string }>('SELECT world_id FROM web_principals WHERE id=?', result.principalId)!;
          for (const { characterId } of syntheticSelection()) this.store.run(
            "INSERT INTO world_characters VALUES (?,?,'new') ON CONFLICT DO NOTHING", principal.world_id, characterId);
          return result;
        });
      } else if (path === '/authenticate') value = this.identity.authenticate(body.token);
      else if (path === '/admin') value = this.admin.login(this.admin.issueLoginGrant().token, origin);
      else if (path === '/issue') value = this.actions.issue(body.cookie, body.csrf, body.origin, body.input);
      else if (path === '/redeem') value = this.actions.redeem(body.token, body.csrf, body.origin, body.ipHash, body.input);
      else if (path === '/challenge') value = this.actions.redemptionChallenge(body.token, body.origin);
      else if (path === '/recover-redemption') value = this.actions.recoverRedemption(body.token, body.csrf, body.origin, body.input);
      else if (path === '/credential') value = this.actions.createRecoveryCredential(body.token, body.csrf, body.origin);
      else if (path === '/recover-invite') value = this.actions.recoverInvite(body.origin, body.ipHash, body.input);
      else if (path === '/revoke') value = this.actions.revokeGrant(body.cookie, body.csrf, body.origin, body.grantId);
      else if (path === '/content') {
        const principal = this.identity.authenticate(body.token);
        value = requireWebContent(this.store, clock, principal.principalId, body.worldId ?? principal.world_id);
      } else if (path === '/admit') value = this.store.transaction(() => {
        const principal = this.identity.authorizeWrite(body.token, body.csrf, body.origin);
        return this.admission.admit({ ...body.input, principalId: principal.principalId, ipHash: body.ipHash });
      });
      else if (path === '/register') value = await this.identity.register(body.token, body.csrf, body.origin, body.input);
      else if (path === '/assets') {
        const ledger = new WebProviderOffline(this.store, clock);
        const clips: string[] = [];
        for (const item of syntheticSelection()) for (const kind of ['welcome','footer'] as const)
          clips.push(await ledger.registerFixedAudio(kind, { characterId: item.characterId,
            voiceVersion: item.voice.voiceVersion, body: kind === 'footer' ? SYNTHETIC_TRIAL_FOOTER :
              WEB_PROVIDER_WELCOME[item.characterId].text, wav: syntheticTone() }));
        value = clips;
      } else if (path === '/fault') { this.fault = body as { mode: string; principalId?: string }; value = { configured: true }; }
      else if (path === '/welcome') {
        const bytes = await new WebProviderOffline(this.store, clock).readWelcomeAudio(body.mediaId);
        value = { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      else if (path === '/storage') value = {
        tables: ['outputs','media_assets','footer_assets','welcome_assets'].map(name => ({ name,
          ...this.store.get<{ n: number; refs: number; blobBytes: number }>(`SELECT count(*) AS n,count(audio_ref_json) AS refs,
            coalesce(sum(length(audio_bytes)),0) AS blobBytes FROM web_provider_${name}`) })),
        attempts: this.store.all('SELECT phase,state,outcome,charged_micros FROM web_provider_attempts ORDER BY operation_id,phase,ordinal'),
        operations: this.store.all('SELECT id,status,quota_state FROM web_operations'),
      };
      else if (path === '/run') {
        const queue = new WebStageQueue(this.store, clock, randomUUID);
        const coordinator = queue.acquireCoordinator('offline-fixture');
        const runner = this.createRunner(body.largeAudio ? 60_000 : 250);
        try {
          const signal = new AbortController().signal;
          const recovery = new WebDispatchLedger(this.store, clock);
          for (const row of this.store.all<{ id: string; status: string }>(`SELECT id,status FROM web_operations
            WHERE status IN ('text_running','audio_running','ready_to_publish')
            AND (lease_epoch<>? OR lease_expires_at<=?)`, coordinator.epoch, clock.now())) {
            if (row.status === 'ready_to_publish') new WebVerticalPublisher(this.store, clock).recover(coordinator, row.id);
            else recovery.recover(coordinator, recovery.fence(row.id));
          }
          const textClaim = queue.claimText(coordinator, 'offline-text');
          if (textClaim) await runner.runText(textClaim, signal);
          for (let i = 0; i < 8; i++) {
            const audio = queue.claimAudio(coordinator, 'offline-audio');
            if (!audio) break;
            await runner.runSpeech(audio, signal);
          }
          value = await runner.publishAsync(coordinator, body.operationId);
        } finally { queue.releaseCoordinator(coordinator); }
      } else if (path === '/audio') {
        const actor = this.identity.authenticate(body.token);
        const media = await new WebVerticalPublisher(this.store, clock).readPublishedAudioAsync({
          principalId: actor.principalId, playerId: actor.player_id, worldId: actor.world_id,
          characterId: body.characterId, conversationId: body.conversationId }, body.mediaId);
        value = { byteLength: media.length, sha256: createHash('sha256').update(media).digest('hex') };
      } else if (path === '/tamper') {
        const row = this.store.get<{ audio_ref_json: string }>('SELECT audio_ref_json FROM web_provider_media_assets WHERE media_id=?', body.mediaId)!;
        const ref = JSON.parse(row.audio_ref_json), bytes = Buffer.alloc(ref.byteLength);
        const key = `private/v1/${ref.kind}/${createHash('sha256').update(JSON.stringify([ref.instanceId,ref.ownerId,ref.mediaId])).digest('hex')}`;
        await this.bucket!.put(key, bytes, { onlyIf: new Headers(), sha256: createHash('sha256').update(bytes).digest('hex'),
          httpMetadata: { contentType: 'audio/wav', cacheControl: 'no-store' } });
        value = { tampered: true };
      } else if (path === '/state') {
        const actor = this.identity.authenticate(body.token);
        value = {
          principal: this.store.get('SELECT trial_used,trial_reserved FROM web_principals WHERE id=?', actor.principalId),
          messages: this.store.all('SELECT id,body,media_id,delivery FROM messages WHERE world_id=? ORDER BY seq', actor.world_id),
          calls: this.store.all('SELECT * FROM cf_fixture_calls ORDER BY provider'),
        };
      }
      else if (path === '/counts') value = {
        principals: this.store.get('SELECT count(*) n FROM web_principals'),
        grants: this.store.get('SELECT count(*) n FROM web_invite_grants'),
        accounts: this.store.get('SELECT count(*) n FROM web_accounts'),
        operations: this.store.get('SELECT count(*) n FROM web_operations'),
        budgets: this.store.all('SELECT * FROM web_provider_spending ORDER BY provider'),
        quota: this.store.all('SELECT used_total,reserved_total FROM web_ip_lifetime_quota'),
      };
      else return new Response('Not found', { status: 404 });
      return Response.json(value);
    } catch (error) {
      return Response.json({ error: error instanceof DomainError ? error.code : String(error) },
        { status: error instanceof DomainError ? 409 : 500 });
    }
  }
}
export default { fetch(request: Request, env: { STATE: {
  idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> };
} }) { return env.STATE.get(env.STATE.idFromName('business')).fetch(request); } };
