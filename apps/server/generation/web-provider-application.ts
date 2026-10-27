import { effectiveTier } from '../admission/web-model-settings.ts';
import { cheapestReplyPoints, hasPoints, modelChoiceState, modelChoiceTablesExist } from '../admission/web-points.ts';
import { ensureRegisteredBonus, signupBonusEmailKey, type BonusEmailKey } from '../admission/web-registered.ts';
import { DEFAULT_PLAYER_MODEL, isPlayerModelId } from '../../../packages/contracts/player-models.ts';
import { billedModelAt } from '../admission/web-model-settings.ts';
import { installWebCharacterDeletion } from '../characters/web-character-deletion-schema.ts';
import { WebCharacterDeletion } from '../characters/web-character-deletion.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import {
  WEB_PROVIDER_CONTRACT,
  isWebProviderCharacterId,
  type WebProviderAccess,
  type WebProviderBootstrap,
  type WebProviderCharacterId,
  type WebProviderMessage,
  type WebProviderOperation,
} from '../../../packages/contracts/web-provider.ts';
import { installWebCharacterCatalog, publishedWebCharacters } from '../characters/web-character-catalog.ts';
import { installWebCharacterMaterials } from '../characters/web-character-material-schema.ts';
import { WebCharacterMaterials } from '../characters/web-character-materials.ts';
import { WebCharacterAdmin } from '../characters/web-character-admin.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { WebIdentity } from '../identity/web-identity.ts';
import { WebAdmission } from '../admission/web-admission.ts';
import { WebVerticalPublisher } from '../conversation/web-vertical-publisher.ts';
import { WebAccountAdmin, type AdminMailer } from '../admin/web-account-admin.ts';
import { WebSystemAdmin, type WebSystemOps } from '../admin/web-system-admin.ts';
import { WebCastAdmin } from '../admin/web-cast-admin.ts';
import { castTablesExist } from '../cast/cast-store.ts';
import { WebSecurityCounters, installWebAdminActions } from '../admin/web-admin-actions.ts';
import { WebInviteTiers } from '../invites/web-invite-tiers.ts';
import { WebInviteActions } from '../invites/web-invite-actions.ts';
import { WebCocreation } from '../cocreation/web-cocreation.ts';
import { WebBilling } from '../admission/web-billing.ts';
import { chatReviewTablesExist } from '../review/web-chat-review.ts';
import { WebChatReviewAdmin } from '../review/web-chat-review-admin.ts';
import { playerLoginRetainsGuest } from '../identity/web-player-purge.ts';
import { WebStats, recordStat } from '../stats/web-stats.ts';
import {
  PLAYER_LIMITS,
  WebPlayerAccounts,
  type AccountPurger,
  type PlayerMailer,
} from '../identity/web-player-accounts.ts';
import { requireWebContent, type WebRetentionRow } from '../admission/web-retention.ts';
import { bonusRemaining, extraTrialRemaining, freeTier, isRegistered } from '../admission/web-free-tier.ts';
import { lockedCharacterIds } from '../admission/web-guest-lock.ts';

/** A cookie that names nothing recoverable: the transport expires it so the next visit starts from the signed-out page. */
export class SessionClearedError extends DomainError {
  constructor(code = 'SESSION_EXPIRED') {
    super(code);
    this.name = 'SessionClearedError';
  }
}
/** Flag GUEST_GRACE_ENABLED: the guest's trial and grace period are over; the cookie is dead and the data is (being) purged. */
export class GuestGraceEndedError extends SessionClearedError {
  constructor() {
    super('GUEST_GRACE_ENDED');
    this.name = 'GuestGraceEndedError';
  }
}
/** Email logins (schema 118): flag, mailer and daily cap come from the Worker environment. */
export interface WebPlayerAccountsConfig {
  mailer?: PlayerMailer | undefined;
  signupEnabled?: boolean | undefined;
  dailyCap?: number | undefined;
  /** Part 17 switches (all default off). graceMs 0 = GUEST_GRACE_ENABLED off. */
  graceMs?: number | undefined;
  accountDelete?: boolean | undefined;
  legalPages?: boolean | undefined;
  turnstileSiteKey?: string | null | undefined;
  /** The audited purge path behind account deletion (absent = the delete route answers NOT_FOUND). */
  purger?: AccountPurger | undefined;
}

export const WEB_PROVIDER_API = '/api/web/provider';
const API = WEB_PROVIDER_API;
export type WebProviderPrincipal = ReturnType<WebIdentity['authenticate']>;
type Principal = WebProviderPrincipal;
export const providerCharacterId = isWebProviderCharacterId;
const characterId = providerCharacterId;
export interface WebProviderApplicationConfig {
  mode: 'provider-local' | 'provider-cloud';
  origin: string;
  cookieName: string;
  instanceId: string;
  recoveryEpoch: string;
  ipKey: string;
  sealKey: string;
  requestKey: string;
  cursorKey: string;
}

/** Shared schema113 application/projections. Transports alone own headers, trusted peer and streams. */
export interface ProviderHistoryRow {
  id: string;
  body: string;
  created_at: number;
  operation_id: string;
  origin: 'input' | 'narrative' | 'trial_footer' | 'text_fallback';
  ordinal: number | null;
  media_id: string | null;
  duration_ms: number | null;
  /** Part 21b: 1 when the draft of this reply was written by the backup model (web_operation_models.backup). */
  via_backup?: number;
  /** Part 21f: the chosen model and the model that wrote the draft (web_operation_models.chosen / draft_provider). */
  chosen_model?: string | null;
  actual_model?: string | null;
  /** Part 21g: the model this reply is billed as, at the prices of the operation's own price version (computed by the server). */
  billed_model?: string | null;
}
/** One history row as the player sees it. A text fallback is an ordinary narrative text bubble; no error is shown. */
export function providerHistoryMessage(
  row: ProviderHistoryRow,
  conversationId: string,
  character: WebProviderCharacterId,
): WebProviderMessage {
  return {
    messageId: row.id,
    conversationId,
    characterId: character,
    operationId: row.operation_id,
    replyOrdinal: row.origin === 'narrative' || row.origin === 'text_fallback' ? row.ordinal : null,
    author: row.origin === 'input' ? 'player' : 'character',
    origin: row.origin === 'text_fallback' ? 'narrative' : row.origin,
    ...(row.origin === 'text_fallback' ? { deliveryFallback: 'text' as const } : {}),
    ...(row.via_backup === 1 &&
    row.origin !== 'input' &&
    isPlayerModelId(row.chosen_model) &&
    isPlayerModelId(row.actual_model) &&
    row.chosen_model !== row.actual_model
      ? {
          viaBackup: {
            chosen: row.chosen_model,
            actual: row.actual_model,
            ...(isPlayerModelId(row.billed_model) ? { billed: row.billed_model } : {}),
          },
        }
      : {}),
    text: row.body,
    createdAt: row.created_at,
    audio: row.media_id
      ? { revision: 1, status: 'ready', mediaId: row.media_id, durationMs: row.duration_ms, errorCode: null }
      : null,
  };
}

export class WebProviderApplication {
  readonly store: WebRuntimeStore;
  readonly clock: Clock;
  readonly config: WebProviderApplicationConfig;
  readonly identity: WebIdentity;
  readonly admission: WebAdmission;
  /** Part 17h: lets a registered player without a bonus row be granted it once, on its first touch. */
  private readonly bonusKey: BonusEmailKey;
  readonly publisher: WebVerticalPublisher;
  readonly inviteAdmin: WebAccountAdmin;
  /** Part 22b: 概览, 系统状态, 积分发放 (the administrator's system pages). */
  readonly system: WebSystemAdmin;
  /** Part 24a: the cast's draft, publications and compiled views. Null on a database older than schema 129. */
  readonly cast: WebCastAdmin | null;
  /** Part 22b: Turnstile failure counts for 系统状态 → 安全. */
  readonly security: WebSecurityCounters;
  readonly characterDeletion: WebCharacterDeletion;
  readonly characterAdmin: WebCharacterAdmin;
  readonly inviteActions: WebInviteActions;
  readonly cocreation: WebCocreation;
  /** Part 21f: the player's own 消费记录. */
  readonly billing: WebBilling;
  /** CHAT_REVIEW_ENABLED (Part 19): 测试对话. Null with the flag off (and on a database older than schema 122). */
  readonly chatReview: WebChatReviewAdmin | null;
  /** GUEST_GRACE_ENABLED: 0 when off. */
  readonly graceMs: number;
  /** Null on a database older than schema 118. */
  readonly playerAccounts: WebPlayerAccounts | null;
  /** Part 22c: the statistics counters' write side (daily active markers, cohort close). */
  readonly stats: WebStats;
  constructor(
    store: WebRuntimeStore,
    clock: Clock,
    config: WebProviderApplicationConfig,
    mailer?: AdminMailer,
    players: WebPlayerAccountsConfig = {},
    /** What only the Worker knows (environment, budget Worker, retention ledger, price renewal). Absent in a harness. */
    ops?: WebSystemOps,
  ) {
    store.requireProviderRuntime();
    ensure(
      store.instanceId === config.instanceId &&
        store.get<{ recovery_epoch: string }>('SELECT recovery_epoch FROM web_instance WHERE singleton=1')
          ?.recovery_epoch === config.recoveryEpoch,
      'WEB_LOCAL_INSTANCE_MISMATCH',
    );
    ensure(
      ['provider-local', 'provider-cloud'].includes(config.mode) &&
        [config.ipKey, config.sealKey, config.requestKey, config.cursorKey].every(
          (key) => /^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, 'base64url').length === 32,
        ),
      'WEB_IDENTITY_KEYS_REQUIRED',
    );
    this.store = store;
    this.clock = clock;
    this.graceMs = players.graceMs ?? 0;
    this.config = { ...config };
    this.identity = new WebIdentity(store, {
      origin: config.origin,
      cookieName: config.cookieName,
      keys: {
        keyId: config.mode === 'provider-local' ? 'local-v1' : 'cloud-v1',
        sealKey: Buffer.from(config.sealKey, 'base64url'),
        requestKey: Buffer.from(config.requestKey, 'base64url'),
      },
      clock,
      ...(players.graceMs ? { guestGraceMs: players.graceMs } : {}),
    });
    this.bonusKey = signupBonusEmailKey(Buffer.from(config.requestKey, 'base64url'));
    this.stats = new WebStats(store, Buffer.from(config.sealKey, 'base64url'));
    this.stats.start(clock.now());
    this.admission = new WebAdmission(store, clock, () => globalThis.crypto.randomUUID(), this.bonusKey, this.stats);
    this.publisher = new WebVerticalPublisher(store, clock);
    const chatReviewOn = store.chatReview === true && chatReviewTablesExist(store);
    this.inviteAdmin = new WebAccountAdmin(store, clock, config.origin, {
      ...(mailer ? { mailer } : {}),
      ...(chatReviewOn ? { features: { chatReview: true } } : {}),
    });
    this.chatReview = chatReviewOn ? new WebChatReviewAdmin(store, clock, this.inviteAdmin) : null;
    installWebAdminActions(store);
    this.security = new WebSecurityCounters(store, clock);
    this.system = new WebSystemAdmin(store, clock, this.inviteAdmin, {
      ops,
      security: this.security,
      emailKey: createHmac('sha256', Buffer.from(config.requestKey, 'base64url'))
        .update('web-admin-points-lookup-v1')
        .digest(),
    });
    this.cast = castTablesExist(store) ? new WebCastAdmin(store, clock, this.inviteAdmin) : null;
    installWebCharacterCatalog(store);
    installWebCharacterMaterials(store);
    installWebCharacterDeletion(store);
    this.characterDeletion = new WebCharacterDeletion(store, clock);
    this.characterAdmin = new WebCharacterAdmin(store, clock, this.inviteAdmin);
    this.characterAdmin.enableMaterials(new WebCharacterMaterials(store, clock));
    this.characterAdmin.enableDeletion(this.characterDeletion);
    const inviteTiers = new WebInviteTiers(store, {
      clock,
      codeKey: createHmac('sha256', Buffer.from(config.requestKey, 'base64url'))
        .update('web-local-invite-code-v1')
        .digest(),
      // Part 22a2: new codes are sealed under a key derived from SEAL_KEY (HKDF, 'invite-code-v1') so they can be shown again.
      sealKey: Buffer.from(config.sealKey, 'base64url'),
      authorize: this.identity.authorizeInviteAction.bind(this.identity),
    });
    this.playerAccounts = store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_player_logins'")
      ? new WebPlayerAccounts(store, this.identity, {
          origin: config.origin,
          requestKey: Buffer.from(config.requestKey, 'base64url'),
          clock,
          mailer: players.mailer ?? null,
          signupEnabled: players.signupEnabled === true && !!players.mailer,
          dailyCap: players.dailyCap ?? PLAYER_LIMITS.defaultDailyCap,
          ...(players.graceMs ? { graceMs: players.graceMs } : {}),
          ...(players.accountDelete && players.purger ? { purger: players.purger } : {}),
          features: {
            accountDelete: players.accountDelete === true && !!players.purger,
            legal: players.legalPages === true,
            turnstileSiteKey: players.turnstileSiteKey ?? null,
            signupBonus: freeTier(this.store).on,
            chatReview: chatReviewOn,
          },
        })
      : null;
    this.inviteActions = new WebInviteActions(store, clock, config.origin, inviteTiers);
    this.cocreation = new WebCocreation(
      store,
      clock,
      this.identity,
      this.inviteAdmin,
      createHmac('sha256', Buffer.from(config.requestKey, 'base64url'))
        .update('web-cocreation-pseudonym-key-v1')
        .digest(),
      () => globalThis.crypto.randomUUID(),
    );
    this.billing = new WebBilling(store, clock, this.identity);
  }

  bootstrap(token: string | undefined, ipHash: string) {
    let issued: string | null = null;
    let durable = false;
    const body = this.store.transaction((): WebProviderBootstrap => {
      if (!token) {
        const start = Math.floor(this.clock.now() / 86_400_000) * 86_400_000;
        this.store.run(
          `INSERT INTO web_local_guest_budget(ip_hash,window_start,created)
          VALUES (?,?,0) ON CONFLICT DO NOTHING`,
          ipHash,
          start,
        );
        ensure(
          this.store.run(
            `UPDATE web_local_guest_budget SET created=created+1
          WHERE ip_hash=? AND window_start=? AND created<32`,
            ipHash,
            start,
          ).changes === 1,
          'WEB_GUEST_RATE_LIMITED',
        );
      }
      let boot: ReturnType<WebIdentity['bootstrap']>;
      try {
        boot = this.identity.bootstrap(token);
      } catch (error) {
        if (
          token &&
          error instanceof DomainError &&
          error.code === 'SESSION_EXPIRED' &&
          this.identity.expiredGuest(token)
        )
          // With the grace flag on, a dead guest cookie is a signed-out visit (the transport clears it and the page
          // offers 登录 / 注册 / 以访客继续); with it off the old "访客会话已过期" answer is unchanged.
          throw this.graceMs > 0 ? new GuestGraceEndedError() : new DomainError('GUEST_SESSION_EXPIRED');
        // A revoked / unknown cookie leaves the page signed out: the transport clears it.
        if (
          token &&
          error instanceof DomainError &&
          error.code === 'SESSION_EXPIRED' &&
          this.identity.isDeadCookie(token)
        )
          throw new SessionClearedError();
        throw error;
      }
      issued = boot.issuedToken;
      // Part 22c: a NEW guest principal was issued (a returning cookie issues nothing).
      if (issued) recordStat(this.store, 'new_guests', this.clock.now());
      durable = this.identity.isDurableSession(token ?? boot.issuedToken!);
      const principal = this.identity.authenticate(token ?? boot.issuedToken!);
      // Activity for the 180-day inactivity purge (at most one write per UTC day).
      this.playerAccounts?.touch(principal.principalId);
      // Part 22c: opened the site this UTC day (once per day and principal; the marker names nobody).
      this.stats.markActive(principal.principalId, 'visit', this.clock.now());
      const { inaccessible, ...access } = this.access(principal, ipHash);
      const characters = this.characters(),
        ids = new Set(characters.map((entry) => entry.characterId));
      if (!inaccessible)
        for (const entry of characters)
          this.store.run(
            `INSERT OR IGNORE INTO world_characters(world_id,character_id,relationship)
          VALUES (?,?,'new')`,
            principal.world_id,
            entry.characterId,
          );
      const high = this.eventHighWater();
      const conversations = inaccessible
        ? []
        : this.store
            .all<{ id: string; character_id: string; last: string | null }>(
              `SELECT c.id,c.private_character_id character_id,
        (SELECT m.id FROM messages m WHERE m.world_id=c.world_id AND m.conversation_id=c.id ORDER BY m.seq DESC LIMIT 1) last
        FROM conversations c WHERE c.world_id=? AND c.kind='private' ORDER BY c.id`,
              principal.world_id,
            )
            .filter((row) => ids.has(row.character_id))
            .map((row) => ({
              conversationId: row.id,
              characterId: row.character_id as WebProviderCharacterId,
              lastMessageId: row.last,
              unreadCount: 0,
            }));
      return {
        contractVersion: WEB_PROVIDER_CONTRACT,
        ...(this.config.mode === 'provider-local'
          ? { mode: 'provider-local' as const, region: 'local-test' as const }
          : { mode: 'provider-cloud' as const, region: 'public' as const }),
        fixture: false,
        instanceId: this.config.instanceId,
        recoveryEpoch: this.config.recoveryEpoch,
        csrf: boot.csrf,
        access,
        characters,
        slots: [
          ...characters.map((entry) => ({ kind: 'character' as const, characterId: entry.characterId })),
          ...Array.from({ length: 15 - characters.length }, (_, index) => ({
            kind: 'preview' as const,
            slotId: `preview-${index + 1}`,
            label: '敬请期待',
          })),
        ],
        conversations,
        syncCursor: this.cursor(principal.principalId, high),
      };
    });
    return { body, issuedToken: issued, durable };
  }

  cursor(principalId: string, seq: number, conversationId?: string) {
    const payload = Buffer.from(
      JSON.stringify([1, this.config.instanceId, this.config.recoveryEpoch, principalId, conversationId ?? null, seq]),
    ).toString('base64url');
    const mac = createHmac('sha256', Buffer.from(this.config.cursorKey, 'base64url'))
      .update(payload)
      .digest('base64url');
    return `${payload}.${mac}`;
  }

  parseCursor(raw: string | null, principalId: string, conversationId?: string) {
    if (raw === null) return 0;
    ensure(raw.length <= 512 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw), 'INVALID_CURSOR');
    const [payload, supplied] = raw.split('.');
    const actual = createHmac('sha256', Buffer.from(this.config.cursorKey, 'base64url')).update(payload!).digest();
    const proposed = Buffer.from(supplied!, 'base64url');
    ensure(proposed.length === actual.length && timingSafeEqual(proposed, actual), 'INVALID_CURSOR');
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    } catch {
      ensure(false, 'INVALID_CURSOR');
    }
    ensure(
      Array.isArray(decoded) &&
        decoded.length === 6 &&
        decoded[0] === 1 &&
        decoded[1] === this.config.instanceId &&
        decoded[2] === this.config.recoveryEpoch &&
        decoded[3] === principalId &&
        decoded[4] === (conversationId ?? null) &&
        Number.isSafeInteger(decoded[5]) &&
        decoded[5] >= 0,
      'INVALID_CURSOR',
    );
    return decoded[5] as number;
  }

  eventHighWater() {
    const seq = this.store.get<{ seq: number }>(`SELECT coalesce(
      (SELECT seq FROM sqlite_sequence WHERE name='web_local_events'),0) seq`)!.seq;
    ensure(Number.isSafeInteger(seq) && seq >= 0, 'WEB_EVENT_SEQUENCE_INVALID');
    return seq;
  }

  access(principal: Principal, ipHash: string): WebProviderAccess & { inaccessible: boolean } {
    const access = this.accessCore(principal, ipHash);
    const may = lockedCharacterIds(this.store, principal.principalId, this.clock.now());
    return may ? { ...access, lockedCharacterIds: may.filter(characterId) } : access;
  }

  private accessCore(principal: Principal, ipHash: string): WebProviderAccess & { inaccessible: boolean } {
    const now = this.clock.now();
    const tier = freeTier(this.store);
    // Part 17h: a registered player (email login) that never got the signup bonus gets it here, once, on its first touch.
    this.store.transaction(() => ensureRegisteredBonus(this.store, this.bonusKey, now, principal.principalId));
    const row = this.store.get<{
      kind: string;
      trial_used: number;
      trial_reserved: number;
      trial_character_id: string | null;
      revision: number;
    }>('SELECT * FROM web_principals WHERE id=? AND world_id=?', principal.principalId, principal.world_id)!;
    const base = {
      principalId: principal.principalId,
      playerId: principal.player_id,
      worldId: principal.world_id,
      revision: row.revision,
    };
    // Part 21b (flag PLAYER_MODEL_CHOICE_ENABLED): a registered player pays in points, so what it can still send follows the
    // balance (after settling what finished). Part 21f: the guest trial is never spent by it (its unused replies were
    // converted into the opening balance), so only the balance counts. Part 17h: registered = the signup bonus or an email
    // login, as a guest or as an invited player whose grant lapsed; such a player is never "trial ended" or "invite gone".
    const pointsAccess = (trialExpiresAt: number | null, inaccessible: boolean) => {
      const state = modelChoiceState(this.store, now, principal.principalId, false)!;
      return {
        kind: 'guest' as const,
        ...base,
        lockedCharacterId: null,
        remainingReplies: state.repliesLeft,
        reservedReplies: row.trial_reserved,
        trialExpiresAt,
        // An unlimited holder is never charged (admission: holderFree), so a zero balance never stops it.
        canSend:
          effectiveTier(this.store, principal.principalId, now)?.unlimited === true ||
          state.balance >= cheapestReplyPoints(this.store, principal.principalId, now),
        inaccessible,
      };
    };
    ensure(row.kind === 'guest', 'WEB_PROVIDER_ACCESS_UNSUPPORTED');
    const retention = this.store.get<WebRetentionRow>(
      `SELECT * FROM web_guest_retention
      WHERE principal_id=? AND world_id=?`,
      principal.principalId,
      principal.world_id,
    );
    ensure(retention, 'WEB_RETENTION_SCOPE_INVALID');
    const quota = this.store.get<{ used_total: number; reserved_total: number }>(
      'SELECT used_total,reserved_total FROM web_ip_lifetime_quota WHERE ip_hash=?',
      ipHash,
    );
    const expired =
      retention.state !== 'unstarted' &&
      (retention.state !== 'active' || retention.expires_at === null || now >= retention.expires_at);
    // A guest with an email login keeps reading after the trial ended (requireWebContent 'read'); it still cannot send.
    const retained =
      expired && retention.state === 'active' && playerLoginRetainsGuest(this.store, principal.principalId);
    const registered = isRegistered(this.store, principal.principalId);
    const counterRemaining = Math.max(
      0,
      Math.min(
        tier.counterReplies - row.trial_used - row.trial_reserved,
        tier.counterReplies - (quota?.used_total ?? 0) - (quota?.reserved_total ?? 0),
      ),
    );
    const locked = row.trial_character_id;
    ensure(locked === null || characterId(locked), 'WEB_PROVIDER_CATALOG_INVALID');
    // Part 17b (flag on): trial replies 4-5 are outside the counters (see admission/web-free-tier.ts); they are open while the
    // trial window is. The signup bonus is spent after the trial, works with any character and has no time window.
    const extraLeft = tier.on && !expired ? extraTrialRemaining(this.store, principal.principalId, ipHash) : 0;
    const remaining = counterRemaining + extraLeft;
    const trialCanSend = !expired && remaining > 0 && (locked === null || !webCharacterDeleted(this.store, locked));
    if (hasPoints(this.store, principal.principalId, now))
      return pointsAccess(retention.expires_at ?? null, expired && !retained && !registered);
    // Part 22a: a holder of an entitlement with points switched off chats unmetered (admission: holderFree); it is never shown
    // as a trial that ended or ran out.
    const heldKind = effectiveTier(this.store, principal.principalId, now)?.kind;
    if (heldKind === 'unlimited' || heldKind === 'daily_refill')
      return {
        kind: 'guest' as const,
        ...base,
        lockedCharacterId: null,
        remainingReplies: 0,
        reservedReplies: row.trial_reserved,
        trialExpiresAt: retention.expires_at ?? null,
        canSend: true,
        inaccessible: false,
      };
    const bonusLeft = bonusRemaining(this.store, principal.principalId);
    if (bonusLeft > 0)
      return {
        kind: 'guest',
        ...base,
        lockedCharacterId: null,
        remainingReplies: (expired ? 0 : remaining) + bonusLeft,
        reservedReplies: row.trial_reserved,
        trialExpiresAt: retention.expires_at ?? null,
        canSend: true,
        inaccessible: expired && !retained && !registered,
      };
    return {
      kind: 'guest',
      ...base,
      lockedCharacterId: locked,
      remainingReplies: registered && expired ? 0 : remaining,
      reservedReplies: row.trial_reserved,
      trialExpiresAt: retention.expires_at ?? null,
      canSend: trialCanSend,
      inaccessible: expired && !retained && !registered,
    };
  }

  characters() {
    return publishedWebCharacters(this.store).map((entry) => {
      const line = entry.presentation.welcome;
      const approved = this.store.get(
        `SELECT 1 FROM web_provider_voice_bindings WHERE character_id=?
        AND approved=1 AND source='user_selected'`,
        entry.characterId,
      );
      const clip = this.store.get<{ media_id: string; text_version: string; sha256: string; duration_ms: number }>(
        `SELECT w.media_id,w.text_version,w.sha256,w.duration_ms
        FROM web_provider_welcome_assets w JOIN web_provider_voice_bindings v
          ON v.character_id=w.character_id AND v.voice_version=w.voice_version
        WHERE w.character_id=? AND w.body=? AND w.text_version=? AND v.approved=1 AND v.source='user_selected'`,
        entry.characterId,
        line.text,
        line.version,
      );
      return {
        characterId: entry.characterId,
        displayName: entry.presentation.displayName,
        publicDescription: entry.presentation.publicDescription,
        portraitUrl: null,
        theme: null,
        mainColor: entry.presentation.color ?? null,
        availability: approved
          ? { state: 'available' as const, personaVersion: entry.version }
          : { state: 'unavailable' as const, reason: 'voice_unverified' as const },
        welcome: !approved
          ? { text: null, version: null, audio: { state: 'unavailable' as const, reason: 'voice_unverified' as const } }
          : {
              text: line.text,
              version: line.version,
              audio: clip
                ? {
                    state: 'available' as const,
                    mediaId: clip.media_id,
                    url: `${API}/public-audio/${clip.media_id}`,
                    version: clip.text_version,
                    sha256: clip.sha256,
                    durationMs: clip.duration_ms,
                  }
                : { state: 'unavailable' as const, reason: 'audio_missing' as const },
            },
      };
    });
  }

  operation(principal: Principal, operationId: string): WebProviderOperation {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id, 'read');
    const row = this.store.get<{
      id: string;
      request_id: string;
      conversation_id: string;
      character_id: string;
      status: WebProviderOperation['status'];
      stage_version: number;
      created_at: number;
      deadline_at: number;
      failure_code: WebProviderOperation['errorCode'];
    }>(
      'SELECT * FROM web_operations WHERE id=? AND principal_id=? AND world_id=?',
      operationId,
      principal.principalId,
      principal.world_id,
    );
    ensure(row && characterId(row.character_id) && !webCharacterDeleted(this.store, row.character_id), 'NOT_FOUND');
    const publication = this.store.get<{ receipt_json: string }>(
      'SELECT receipt_json FROM web_publications WHERE operation_id=? AND principal_id=?',
      operationId,
      principal.principalId,
    );
    const receipt = publication
      ? (JSON.parse(publication.receipt_json) as { messageIds: string[]; footerMessageId: string | null })
      : null;
    return {
      operationId: row.id,
      requestId: row.request_id,
      characterId: row.character_id,
      conversationId: row.conversation_id,
      status: row.status,
      revision: row.stage_version + 1,
      acceptedAt: row.created_at,
      deadlineAt: row.deadline_at,
      errorCode: row.failure_code,
      canCancel: !['published', 'cancelled', 'failed'].includes(row.status),
      canRetry: false,
      publication: receipt
        ? { narrativeMessageIds: receipt.messageIds, footerMessageId: receipt.footerMessageId }
        : null,
    };
  }

  events(principal: Principal, after: number, limit = 100) {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id, 'read');
    const high = this.eventHighWater();
    ensure(after <= high && limit >= 1 && limit <= 100, 'INVALID_CURSOR');
    const rows = this.store.all<{
      seq: number;
      conversation_id: string | null;
      character_id: string | null;
      kind: 'operation' | 'publication' | 'access';
      revision: number;
      payload_json: string;
    }>(
      `SELECT e.seq,e.conversation_id,c.private_character_id character_id,e.kind,e.revision,e.payload_json
        FROM web_local_events e LEFT JOIN conversations c
          ON c.world_id=e.world_id AND c.id=e.conversation_id AND c.kind='private'
        WHERE e.principal_id=? AND e.world_id=? AND e.seq>? AND NOT EXISTS
          (SELECT 1 FROM web_character_deletions d WHERE d.character_id=c.private_character_id) ORDER BY e.seq LIMIT ?`,
      principal.principalId,
      principal.world_id,
      after,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.seq ?? after;
    return {
      events: page.map((row) => ({
        eventId: this.cursor(principal.principalId, row.seq),
        conversationId: row.conversation_id,
        characterId: row.character_id && characterId(row.character_id) ? row.character_id : null,
        kind: row.kind,
        revision: row.revision,
        payload: JSON.parse(row.payload_json),
      })),
      cursor: this.cursor(principal.principalId, last),
      hasMore: rows.length > limit,
    };
  }

  history(principal: Principal, conversationId: string, before: number | null) {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id, 'read');
    const conversation = this.store.get<{ private_character_id: string }>(
      `SELECT private_character_id
      FROM conversations WHERE world_id=? AND id=? AND kind='private'`,
      principal.world_id,
      conversationId,
    );
    ensure(
      conversation &&
        characterId(conversation.private_character_id) &&
        !webCharacterDeleted(this.store, conversation.private_character_id),
      'NOT_FOUND',
    );
    const rows = this.store.all<{
      seq: number;
      id: string;
      body: string;
      created_at: number;
      operation_id: string;
      origin: 'input' | 'narrative' | 'trial_footer' | 'text_fallback';
      ordinal: number | null;
      media_id: string | null;
      duration_ms: number | null;
      via_backup: number;
      chosen_model: string | null;
      actual_model: string | null;
      price_version: number | null;
    }>(
      `
      SELECT m.seq,m.id,m.body,m.created_at,o.id operation_id,'input' origin,NULL ordinal,
          NULL media_id,NULL duration_ms,0 via_backup,NULL chosen_model,NULL actual_model,NULL price_version
        FROM web_operations o JOIN messages m ON m.id=o.input_message_id
        WHERE o.principal_id=? AND o.world_id=? AND o.conversation_id=? AND m.seq<?
      UNION ALL
      SELECT m.seq,m.id,m.body,m.created_at,p.operation_id,i.origin,i.ordinal,i.media_id,
          coalesce(a.duration_ms,f.duration_ms) duration_ms,${
            modelChoiceTablesExist(this.store)
              ? '(SELECT backup FROM web_operation_models b WHERE b.operation_id=p.operation_id)'
              : '0'
          } via_backup,${
            modelChoiceTablesExist(this.store)
              ? '(SELECT chosen FROM web_operation_models b WHERE b.operation_id=p.operation_id)'
              : 'NULL'
          } chosen_model,${
            modelChoiceTablesExist(this.store)
              ? '(SELECT draft_provider FROM web_operation_models b WHERE b.operation_id=p.operation_id)'
              : 'NULL'
          } actual_model,${
            modelChoiceTablesExist(this.store)
              ? '(SELECT price_version FROM web_operation_models b WHERE b.operation_id=p.operation_id)'
              : 'NULL'
          } price_version
        FROM web_publication_items i JOIN web_publications p ON p.operation_id=i.operation_id
        JOIN messages m ON m.id=i.message_id
        LEFT JOIN web_provider_media_assets a ON a.media_id=i.media_id AND i.origin='narrative'
        LEFT JOIN web_provider_footer_assets f ON f.media_id=i.media_id AND i.origin='trial_footer'
        WHERE p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=? AND m.seq<?
      ORDER BY seq DESC LIMIT 51`,
      principal.principalId,
      principal.world_id,
      conversationId,
      before ?? Number.MAX_SAFE_INTEGER,
      principal.principalId,
      principal.player_id,
      principal.world_id,
      conversationId,
      before ?? Number.MAX_SAFE_INTEGER,
    );
    const page = rows.slice(0, 50).reverse();
    const character = conversation.private_character_id as WebProviderCharacterId;
    return {
      characterId: character,
      conversationId,
      messages: page.map((row) =>
        providerHistoryMessage(
          {
            ...row,
            billed_model:
              isPlayerModelId(row.chosen_model) && isPlayerModelId(row.actual_model)
                ? billedModelAt(this.store, row.price_version, row.chosen_model, row.actual_model)
                : null,
          },
          conversationId,
          character,
        ),
      ),
      before: page.length ? this.cursor(principal.principalId, page[0]!.seq, conversationId) : null,
      hasMore: rows.length > 50,
    };
  }
}
