import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { emptySession } from '../../../packages/domain/schedule.ts';
import { DomainError, ensure, RetryAfterError } from '../../../packages/domain/errors.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { webConcurrency, webDailyReplyLimit } from '../../../config/web-concurrency.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { requireWebContent, webDataLifecycleEnabled } from './web-retention.ts';
import {
  bonusRemaining,
  bonusSpent,
  extraTrialRemaining,
  extraTrialSpent,
  freeTier,
  guestTrialOver,
  hasSignupBonus,
  isRegistered,
} from './web-free-tier.ts';
import { DEFAULT_PLAYER_MODEL, type PlayerModelId } from '../../../packages/contracts/player-models.ts';
import {
  canChooseModel,
  chargeAdmission,
  effectiveModel,
  hasPoints,
  offeredModels,
  isInvited,
  quote,
  recordUnmetered,
} from './web-points.ts';
import { effectiveTier } from './web-model-settings.ts';
import { ensureRegisteredBonus, type BonusEmailKey } from './web-registered.ts';
import type { WebStats } from '../stats/web-stats.ts';
import { lockedCharacterIds } from './web-guest-lock.ts';
import { requirePublishedWebCharacter } from '../characters/web-character-catalog.ts';

interface PrincipalRow {
  id: string;
  player_id: string;
  world_id: string;
  kind: 'guest' | 'account';
  trial_character_id: string | null;
  trial_used: number;
  trial_reserved: number;
}
interface OperationRow {
  id: string;
  principal_id: string;
  request_id: string;
  payload_hash: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
  ip_window_id: string | null;
  status: 'queued' | 'ready_to_publish' | 'published' | 'cancelled' | 'failed';
  quota_state: 'reserved' | 'used' | 'released';
  created_at: number;
  deadline_at: number;
}
type Terminal = 'cancelled' | 'failed';

/** Trusted internal service. HTTP must authenticate the principal and derive ipHash at a trusted boundary. */
export class WebAdmission {
  private readonly store: WebStore;
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly ipKeyFingerprint: string | null;
  /** Part 17h: the keyed digest of a bonus address; without it a registered player that holds no bonus row cannot be granted one. */
  private readonly bonusKey: BonusEmailKey | undefined;
  /** Part 22c: marks the principal active ('chat') on the day it sends a message. Absent in a harness without statistics. */
  private readonly stats: WebStats | undefined;
  constructor(store: WebStore, clock: Clock, nextId: () => string, bonusKey?: BonusEmailKey, stats?: WebStats) {
    this.store = store;
    this.clock = clock;
    this.nextId = nextId;
    this.bonusKey = bonusKey;
    this.stats = stats;
    this.ipKeyFingerprint = webDataLifecycleEnabled(store) ? store.webIpKeyFingerprint() : null;
  }

  registerGuest(input: { principalId: string; playerId: string; worldId: string }) {
    return this.store.transaction(() => {
      ensure(
        this.store.get<{ owner_id: string }>('SELECT owner_id FROM worlds WHERE id=?', input.worldId)?.owner_id ===
          input.playerId && this.store.get('SELECT 1 FROM api_players WHERE id=?', input.playerId),
        'WEB_WORLD_OWNER_MISMATCH',
      );
      this.store.run(
        "INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,'guest')",
        input.principalId,
        input.playerId,
        input.worldId,
      );
      if (webDataLifecycleEnabled(this.store))
        this.store.run(
          `INSERT INTO web_guest_retention
        (principal_id,world_id,state) VALUES (?,?,'unstarted')`,
          input.principalId,
          input.worldId,
        );
    });
  }

  admit(input: { principalId: string; requestId: string; characterId: string; text: string; ipHash: string }) {
    ensure(/^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId), 'INVALID_REQUEST_ID');
    ensure(typeof input.text === 'string' && typeof input.characterId === 'string', 'INVALID_TEXT');
    ensure(/^[a-f0-9]{64}$/.test(input.ipHash), 'WEB_TRUSTED_IP_REQUIRED');
    const payloadHash = createHash('sha256')
      .update(JSON.stringify([input.characterId, input.text, 'voice']))
      .digest('hex');
    return this.store.transaction(() => {
      const principal = this.store.get<PrincipalRow>('SELECT * FROM web_principals WHERE id=?', input.principalId);
      ensure(principal, 'WEB_PRINCIPAL_NOT_FOUND');
      // Part 17h: a registered player (email login) without a bonus row gets it, once, before anything is decided.
      ensureRegisteredBonus(this.store, this.bonusKey, this.clock.now(), principal.id);
      const webSchema = this.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      const lifecycle = webDataLifecycleEnabled(this.store);
      // The lifecycle gate precedes idempotent replay: expired content stays private.
      const retention = lifecycle ? requireWebContent(this.store, this.clock, principal.id, principal.world_id) : null;
      requirePublishedWebCharacter(this.store, input.characterId);
      const prior = this.store.get<OperationRow>(
        'SELECT * FROM web_operations WHERE principal_id=? AND request_id=?',
        input.principalId,
        input.requestId,
      );
      if (prior) {
        ensure(prior.payload_hash === payloadHash, 'IDEMPOTENCY_CONFLICT');
        return {
          operationId: prior.id,
          conversationId: prior.conversation_id,
          inputMessageId: prior.input_message_id,
          status: prior.status,
          duplicate: true as const,
        };
      }
      ensure(
        input.text.trim().length > 0 &&
          [...input.text].length <= WEB_LIMITS.maxInputCodePoints &&
          !/[\u0000-\u001f\u007f]/u.test(input.text),
        'INVALID_TEXT',
      );
      const trial = principal.kind === 'guest';
      ensure(
        trial ||
          ([
            108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128,
            129,
          ].includes(webSchema) &&
            principal.kind === 'account' &&
            this.store.get(`SELECT 1 FROM web_accounts WHERE principal_id=? AND active=1`, principal.id)),
        'WEB_ADMISSION_ENTITLEMENT_REQUIRED',
      );
      ensure(
        this.store.get(
          'SELECT 1 FROM world_characters WHERE world_id=? AND character_id=?',
          principal.world_id,
          input.characterId,
        ),
        'WEB_CHARACTER_UNAVAILABLE',
      );
      const eff = effectiveTier(this.store, principal.id, this.clock.now());
      // Part 22a: a HOLDER is a signed-in player with an active entitlement (the principal stays a guest). Its tier and liveness
      // never depend on the free-tier switch. unlimited is never charged; daily_refill is charged in points while points exist.
      const holder = principal.kind === 'guest' && (eff?.kind === 'unlimited' || eff?.kind === 'daily_refill');
      const holderPoints = holder && hasPoints(this.store, principal.id, this.clock.now());
      // Points switched off: nothing to charge a holder with; it chats unmetered under the daily cap (like any invited player).
      const holderFree = holder && !holderPoints;
      // Part 26a: an unregistered guest that already chats with a character may not start another. Decided HERE, before any
      // reservation, trial counter, conversation or provider call, so the refusal costs nothing.
      const guestMay = lockedCharacterIds(this.store, principal.id, this.clock.now());
      if (guestMay && guestMay.length > 0 && !guestMay.includes(input.characterId))
        throw new DomainError('GUEST_CHARACTER_LOCKED');
      // An unmetered tier (an unlimited entitlement, or a holder while points are off) is never
      // charged, so the per-day reply cap stays as its invisible abuse guard. Decided from the EFFECTIVE tier, not the kind.
      if (holderFree || eff?.kind === 'unlimited') this.dailyLimit(principal.id);
      const tier = freeTier(this.store);
      const trialWindowMs = tier.trialWindowMs;
      // Part 17b: the signup bonus is one more entitlement, decided HERE, before any reservation or provider call.
      // Part 21b (flag PLAYER_MODEL_CHOICE_ENABLED): a principal holding the signup bonus pays in POINTS instead. The old
      // bonus accounting is not consulted for it. Part 21f: it ALWAYS pays points, whatever the model: the guest trial path is
      // never used (its unused trial replies were converted into the opening balance). Everyone else, and every deployment
      // with the flag off, takes the path above unchanged.
      const pointsMode = holderPoints || (trial && tier.on && hasPoints(this.store, principal.id, this.clock.now()));
      let free: 'trial' | 'extra' | 'bonus' | 'points' =
        trial && tier.on && !pointsMode && !holderFree
          ? this.pickFreeEntitlement(principal, input, retention)
          : 'trial';
      // Part 17h: a registered player whose trial window is over has nothing left on the trial path; it is never told the trial
      // expired - it is told its free replies are used up (the page offers what to do next). Only the bonus replies can pay.
      if (
        trial &&
        tier.on &&
        !pointsMode &&
        !holderFree &&
        free === 'trial' &&
        isRegistered(this.store, principal.id) &&
        retention !== null &&
        guestTrialOver(this.store, principal.id, this.clock.now())
      )
        throw new DomainError('TRIAL_EXHAUSTED');
      let chosen: PlayerModelId = DEFAULT_PLAYER_MODEL;
      if (pointsMode) {
        chosen = effectiveModel(this.store, this.clock.now(), principal.id);
        free = 'points';
        const decision = quote(this.store, this.clock.now(), principal.id, chosen);
        if (!decision.ok) throw new DomainError(decision.code);
      }
      const bonus = free === 'bonus',
        extra = free === 'extra',
        points = free === 'points';
      // Part 21g: a trial guest may be allowed another model than DeepSeek (or several). The model is frozen into the operation like
      // any other; the reply still costs exactly one trial reply, whatever the model. A DeepSeek-only guest keeps no row at all.
      let guestModel: PlayerModelId | null = null;
      if (trial && !pointsMode && !bonus && !holderFree) {
        const effective = effectiveModel(this.store, this.clock.now(), principal.id);
        if (effective !== DEFAULT_PLAYER_MODEL || canChooseModel(this.store, principal.id)) guestModel = effective;
      }
      // Both outside-the-counters entitlements are 'entitled' operations with a web_free_operations row: no IP window, no trial counter.
      // A points reply is entitled too, with a points event (and web_operation_models row) instead.
      const counted = trial && !bonus && !extra && !points && !holderFree;
      if (counted) {
        ensure(
          principal.trial_character_id === null || principal.trial_character_id === input.characterId,
          'TRIAL_CHARACTER_LOCKED',
        );
        ensure(principal.trial_used + principal.trial_reserved < WEB_LIMITS.trialReplies, 'TRIAL_EXHAUSTED');
      }
      const pending = this.store.get<{ count: number }>(
        `SELECT count(*) count FROM web_operations
        WHERE principal_id=? AND status NOT IN ('published','cancelled','failed')`,
        principal.id,
      )!.count;
      ensure(pending < WEB_LIMITS.maxPrincipalPending, 'WEB_USER_QUEUE_FULL');
      const global = this.store.get<{ count: number }>(`SELECT count(*) count FROM web_operations
        WHERE status NOT IN ('published','cancelled','failed')`)!.count;
      ensure(global < webConcurrency(this.store).maxGlobalReservedOperations, 'QUEUE_FULL');

      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      if (lifecycle) ensure(now <= Number.MAX_SAFE_INTEGER - trialWindowMs, 'INVALID_TIME');
      let window: { id: string; used: number; reserved: number } | undefined;
      if (counted) {
        if (lifecycle) {
          ensure(this.ipKeyFingerprint, 'WEB_IP_KEY_REQUIRED');
          this.store.run(
            `INSERT INTO web_ip_lifetime_quota(ip_hash,key_fingerprint,used_total,reserved_total)
            VALUES (?,?,0,0) ON CONFLICT(ip_hash) DO NOTHING`,
            input.ipHash,
            this.ipKeyFingerprint,
          );
          const quota = this.store.get<{ key_fingerprint: string; used_total: number; reserved_total: number }>(
            'SELECT * FROM web_ip_lifetime_quota WHERE ip_hash=?',
            input.ipHash,
          );
          ensure(quota?.key_fingerprint === this.ipKeyFingerprint, 'WEB_IP_KEY_MISMATCH');
          ensure(quota.used_total + quota.reserved_total < WEB_LIMITS.trialReplies, 'TRIAL_EXHAUSTED');
        }
        window = this.store.get<{ id: string; used: number; reserved: number }>(
          `SELECT id,used,reserved FROM web_ip_windows
          WHERE ip_hash=? ${lifecycle ? '' : 'AND starts_at<=? AND expires_at>?'}
          ORDER BY starts_at DESC,id DESC LIMIT 1`,
          ...(lifecycle ? [input.ipHash] : [input.ipHash, now, now]),
        );
        if (!window) {
          window = { id: this.nextId(), used: 0, reserved: 0 };
          this.store.run(
            'INSERT INTO web_ip_windows(id,ip_hash,starts_at,expires_at) VALUES (?,?,?,?)',
            window.id,
            input.ipHash,
            now,
            lifecycle ? Number.MAX_SAFE_INTEGER : now + WEB_LIMITS.ipWindowMs,
          );
        }
        ensure(window.used + window.reserved < WEB_LIMITS.trialReplies, 'TRIAL_EXHAUSTED');
      }

      let conversation = this.store.get<{ id: string }>(
        `SELECT id FROM conversations
        WHERE world_id=? AND private_character_id=? AND kind='private'`,
        principal.world_id,
        input.characterId,
      );
      if (!conversation) {
        conversation = { id: this.nextId() };
        this.store.run(
          "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,?,'private',?)",
          principal.world_id,
          conversation.id,
          input.characterId,
        );
        this.store.run(
          'INSERT INTO participants VALUES (?,?,?)',
          principal.world_id,
          conversation.id,
          input.characterId,
        );
        this.store.run(
          'INSERT INTO contacts VALUES (?,?,?,?)',
          principal.world_id,
          conversation.id,
          input.characterId,
          JSON.stringify(emptySession()),
        );
      }
      const messageId = this.nextId(),
        operationId = this.nextId();
      this.store.run(
        `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,request_id,request_hash)
        VALUES (?,?,?,'player',?,?,?,'text',?,?)`,
        messageId,
        principal.world_id,
        conversation.id,
        principal.player_id,
        input.text,
        now,
        input.requestId,
        payloadHash,
      );
      this.store.run(
        'INSERT INTO outbox(world_id,conversation_id,message_id,created_at) VALUES (?,?,?,?)',
        principal.world_id,
        conversation.id,
        messageId,
        now,
      );
      if (extra && lifecycle) {
        // The first reply of a guest may already be an extra one (its IP's counters are spent): the trial window starts now.
        ensure(retention?.state === 'unstarted' || retention?.state === 'active', 'TRIAL_EXPIRED');
        if (retention.state === 'unstarted')
          ensure(
            this.store.run(
              `UPDATE web_guest_retention
            SET started_at=?,expires_at=?,state='active',revision=revision+1
            WHERE principal_id=? AND world_id=? AND state='unstarted' AND revision=?`,
              now,
              now + trialWindowMs,
              principal.id,
              principal.world_id,
              retention.revision,
            ).changes === 1,
            'WEB_RETENTION_STALE',
          );
      }
      if (extra)
        this.store.run(
          'UPDATE web_principals SET trial_character_id=coalesce(trial_character_id,?),revision=revision+1 WHERE id=?',
          input.characterId,
          principal.id,
        );
      if (counted) {
        if (lifecycle) {
          ensure(retention?.state === 'unstarted' || retention?.state === 'active', 'TRIAL_EXPIRED');
          if (retention.state === 'unstarted')
            ensure(
              this.store.run(
                `UPDATE web_guest_retention
            SET started_at=?,expires_at=?,state='active',revision=revision+1
            WHERE principal_id=? AND world_id=? AND state='unstarted' AND revision=?`,
                now,
                now + trialWindowMs,
                principal.id,
                principal.world_id,
                retention.revision,
              ).changes === 1,
              'WEB_RETENTION_STALE',
            );
          ensure(
            this.store.run(
              `UPDATE web_ip_lifetime_quota SET reserved_total=reserved_total+1,
            revision=revision+1 WHERE ip_hash=? AND key_fingerprint=? AND used_total+reserved_total<?`,
              input.ipHash,
              this.ipKeyFingerprint!,
              WEB_LIMITS.trialReplies,
            ).changes === 1,
            'TRIAL_EXHAUSTED',
          );
        }
        ensure(
          this.store.run(
            'UPDATE web_ip_windows SET reserved=reserved+1 WHERE id=? AND used+reserved<?',
            window!.id,
            WEB_LIMITS.trialReplies,
          ).changes === 1,
          'TRIAL_EXHAUSTED',
        );
        ensure(
          this.store.run(
            `UPDATE web_principals SET trial_character_id=coalesce(trial_character_id,?),
          trial_reserved=trial_reserved+1,revision=revision+1 WHERE id=? AND trial_used+trial_reserved<?`,
            input.characterId,
            principal.id,
            WEB_LIMITS.trialReplies,
          ).changes === 1,
          'TRIAL_EXHAUSTED',
        );
      }
      const operationColumns = `id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,
        input_message_id,ip_window_id,status,quota_state,created_at,deadline_at`;
      const operationValues = [
        operationId,
        principal.id,
        input.requestId,
        payloadHash,
        principal.world_id,
        conversation.id,
        input.characterId,
        messageId,
        window?.id ?? null,
        now,
        now + WEB_LIMITS.operationDeadlineMs,
      ];
      if (webSchema >= 102 && webSchema <= 129) {
        const sequence = this.store.get<{ last_seq: number }>(`UPDATE web_admission_counter
          SET last_seq=last_seq+1 WHERE singleton=1 RETURNING last_seq`)?.last_seq;
        ensure(sequence !== undefined, 'WEB_ADMISSION_ORDER_MISSING');
        this.store.run(
          `INSERT INTO web_operations(${operationColumns},text_queued_at,admission_seq${webSchema >= 108 ? ',metering_type' : ''})
          VALUES (?,?,?,?,?,?,?,?,?,'queued','reserved',?,?,?,?${webSchema >= 108 ? ',?' : ''})`,
          ...operationValues,
          now,
          sequence,
          ...(webSchema >= 108 ? [counted ? 'trial' : 'entitled'] : []),
        );
      } else if (webSchema === 101) {
        this.store.run(
          `INSERT INTO web_operations(${operationColumns},text_queued_at)
          VALUES (?,?,?,?,?,?,?,?,?,'queued','reserved',?,?,?)`,
          ...operationValues,
          now,
        );
      } else {
        this.store.run(
          `INSERT INTO web_operations(${operationColumns})
          VALUES (?,?,?,?,?,?,?,?,?,'queued','reserved',?,?)`,
          ...operationValues,
        );
      }
      if (bonus) {
        // The allowance is re-checked in the same transaction as the reservation it guards.
        ensure(bonusSpent(this.store, principal.id) < tier.bonusReplies, 'TRIAL_EXHAUSTED');
        this.store.run(
          "INSERT INTO web_free_operations(operation_id,principal_id,tier,ip_hash) VALUES (?,?,'bonus',NULL)",
          operationId,
          principal.id,
        );
      } else if (points) {
        chargeAdmission(this.store, now, principal.id, operationId, chosen);
      } else if (holderFree || isInvited(this.store, principal.id, now)) {
        // Invited players may pick a model; nothing is charged and the rolling daily limit above is unchanged.
        if (offeredModels(this.store) !== null)
          recordUnmetered(this.store, now, operationId, effectiveModel(this.store, now, principal.id));
      } else if (extra) {
        this.store.run(
          "INSERT INTO web_free_operations(operation_id,principal_id,tier,ip_hash) VALUES (?,?,'trial_extra',?)",
          operationId,
          principal.id,
          input.ipHash,
        );
        ensure(
          extraTrialSpent(this.store, { principalId: principal.id }) <= tier.extraTrialReplies &&
            extraTrialSpent(this.store, { ipHash: input.ipHash }) <= tier.extraTrialReplies,
          'TRIAL_EXHAUSTED',
        );
      }
      if (guestModel) recordUnmetered(this.store, now, operationId, guestModel);
      // Part 22c: a message was sent (the reply may still fail): the principal counts as a chatter of this UTC day.
      this.stats?.markActive(principal.id, 'chat', now);
      return {
        operationId,
        conversationId: conversation.id,
        inputMessageId: messageId,
        status: 'queued' as const,
        duplicate: false as const,
      };
    });
  }

  /**
   * Which entitlement pays for this reply of a guest with the free tier on, in this order: 'trial' (the existing counters,
   * replies 1-3 per guest and per IP), 'extra' (trial replies 4-5, derived accounting, per guest and per IP), 'bonus' (the
   * signup bonus, only for a guest that holds it). 'trial' is also the answer when nothing is left: the checks that follow
   * in admit() then refuse with the same codes as before (TRIAL_EXHAUSTED, TRIAL_CHARACTER_LOCKED). Only reads happen here.
   */
  private pickFreeEntitlement(
    principal: PrincipalRow,
    input: { characterId: string; ipHash: string },
    retention: { state: string; expires_at: number | null } | null,
  ): 'trial' | 'extra' | 'bonus' {
    const now = this.clock.now();
    const windowLive =
      retention === null ||
      retention.state === 'unstarted' ||
      (retention.state === 'active' && retention.expires_at !== null && now < retention.expires_at);
    const bonus = hasSignupBonus(this.store, principal.id);
    const lockOk = principal.trial_character_id === null || principal.trial_character_id === input.characterId;
    if (windowLive) {
      let counterOk = lockOk && principal.trial_used + principal.trial_reserved < WEB_LIMITS.trialReplies;
      if (counterOk) {
        const quota = this.store.get<{ used_total: number; reserved_total: number }>(
          'SELECT used_total,reserved_total FROM web_ip_lifetime_quota WHERE ip_hash=?',
          input.ipHash,
        );
        const window = this.store.get<{ used: number; reserved: number }>(
          'SELECT used,reserved FROM web_ip_windows WHERE ip_hash=? ORDER BY starts_at DESC,id DESC LIMIT 1',
          input.ipHash,
        );
        counterOk =
          !(quota && quota.used_total + quota.reserved_total >= WEB_LIMITS.trialReplies) &&
          !(window && window.used + window.reserved >= WEB_LIMITS.trialReplies);
      }
      if (counterOk) return 'trial';
      if (lockOk && extraTrialRemaining(this.store, principal.id, input.ipHash) > 0) return 'extra';
    }
    if (bonus) {
      // Out of bonus too: with the window gone everything free is used up; with it open the checks below say why.
      if (bonusRemaining(this.store, principal.id) > 0) return 'bonus';
      ensure(windowLive, 'TRIAL_EXHAUSTED');
    }
    return 'trial';
  }

  /**
   * Rolling 24h cap on accepted player-initiated operations for an entitled principal. It runs at admission, before any
   * budget reservation or provider call; proactive character messages are not operations and the guest trial has its own cap.
   */
  private dailyLimit(principalId: string) {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    const limit = webDailyReplyLimit(this.store);
    const since = now - 86_400_000;
    const count = this.store.get<{ count: number }>(
      `SELECT count(*) count FROM web_operations WHERE principal_id=? AND created_at>? AND quota_state<>'released'`,
      principalId,
      since,
    )!.count;
    if (count < limit) return;
    const edge = this.store.get<{ created_at: number }>(
      `SELECT created_at FROM web_operations WHERE principal_id=? AND created_at>? AND quota_state<>'released'
      ORDER BY created_at,id LIMIT 1 OFFSET ?`,
      principalId,
      since,
      count - limit,
    );
    throw new RetryAfterError('WEB_DAILY_LIMIT_REACHED', Math.max(1, (edge?.created_at ?? now) + 86_400_000 - now));
  }

  /** Only confirmed termination is available until an atomic voice publisher is implemented. */
  finalize(operationId: string, terminal: Terminal) {
    return this.store.transaction(() => {
      ensure(
        ![
          104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125,
          126, 127, 128, 129,
        ].includes(this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1),
        'WEB_DISPATCH_FENCE_REQUIRED',
      );
      const operation = this.store.get<OperationRow>('SELECT * FROM web_operations WHERE id=?', operationId);
      ensure(operation, 'WEB_OPERATION_NOT_FOUND');
      // Runtime guard also rejects JavaScript callers bypassing the TypeScript Terminal type.
      if ((terminal as string) === 'published') {
        const now = this.clock.now();
        ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
        ensure(now < operation.deadline_at, 'OPERATION_EXPIRED');
        ensure(false, 'WEB_PUBLICATION_NOT_READY');
      }
      ensure(terminal === 'cancelled' || terminal === 'failed', 'WEB_PUBLICATION_NOT_READY');
      if (operation.quota_state !== 'reserved') {
        ensure(operation.status === terminal, 'WEB_OPERATION_TERMINAL_CONFLICT');
        return { status: operation.status, duplicate: true as const };
      }
      ensure(
        this.store.run(
          'UPDATE web_ip_windows SET reserved=reserved-1 WHERE id=? AND reserved>0',
          operation.ip_window_id,
        ).changes === 1,
        'WEB_QUOTA_STATE_INVALID',
      );
      ensure(
        this.store.run(
          'UPDATE web_principals SET trial_reserved=trial_reserved-1,revision=revision+1 WHERE id=? AND trial_reserved>0',
          operation.principal_id,
        ).changes === 1,
        'WEB_QUOTA_STATE_INVALID',
      );
      ensure(
        this.store.run(
          'UPDATE web_operations SET status=?,quota_state=? WHERE id=? AND quota_state=?',
          terminal,
          'released',
          operationId,
          'reserved',
        ).changes === 1,
        'WEB_OPERATION_STATE_INVALID',
      );
      return { status: terminal, duplicate: false as const };
    });
  }
}
