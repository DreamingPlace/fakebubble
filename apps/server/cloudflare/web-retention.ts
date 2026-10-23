import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { emptySession } from '../../../packages/domain/schedule.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { auditWebLifecycleWorld } from '../admission/web-lifecycle-audit.ts';
import { LATE_TABLES, embeddingTableExists, releaseUnsentEmbedHolds } from '../budget/web-embed-purge.ts';
import { purgeCocreation } from '../cocreation/web-cocreation-purge.ts';
import {
  bonusKeepsGuest,
  guestPurgeDue,
  PLAYER_INACTIVE_MS,
  playerLastSeenAt,
  playerLoginsExist,
  purgePlayerLogins,
  releasePlayerLogin,
} from '../identity/web-player-purge.ts';
import { WebProviderOffline } from '../generation/web-provider-offline.ts';
import { recordStat, type WebStats } from '../stats/web-stats.ts';
import { signupBonusTablesExist } from '../admission/web-free-tier.ts';
import {
  archivePlayerChats,
  chatReviewTablesExist,
  nextReviewArchiveExpiry,
  sweepReviewArchive,
} from '../review/web-chat-review.ts';
import { settleWebLifetimeReservation, webReceiptDigest, type WebRetentionRow } from '../admission/web-retention.ts';
import { checkAudioReference, speechObjectScope } from '../audio/web-provider-media.ts';
import type { MediaObjectReference } from './media-objects.ts';
import {
  ageBucket,
  backoffDelay,
  errorName,
  firstFrame,
  messageShape,
  olderBucket,
  type AgeBucket,
  type RetentionPhase,
} from './web-retention-diagnostics.ts';

export type { AgeBucket, RetentionPhase } from './web-retention-diagnostics.ts';

/**
 * What a failed purge step reports: a fixed step name and a safe code, never an id, an address or an error text.
 * Part 17g adds where it broke and what kind of failure it was - still only fixed labels, a class name, a message with its
 * values taken out, `file:line` and counts. `code` stays WEB_RETENTION_FAILED when the error is not a DomainError.
 */
export type RetentionReport = {
  event: 'web_retention_failed';
  step: 'sweep' | 'deletion';
  code: string;
  /** Principals whose purge failed in this group (a report is one group of identical failures). */
  failed: number;
  /** The call that threw, and the fixed label of the statement group inside it. */
  phase?: RetentionPhase;
  sub?: string;
  errorName?: string;
  messageShape?: string;
  at?: string;
  principalKind?: 'guest' | 'account';
  state?: string;
  /** Distinct principals that failed in this whole sweep, and how many were left alone because they are in backoff. */
  stuck?: number;
  backedOff?: number;
  oldestAgeBucket?: AgeBucket;
};
const safeCode = (error: unknown) =>
  error instanceof DomainError && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code : 'WEB_RETENTION_FAILED';

/**
 * Part 17g. The only thing the retention remembers between sweeps: per principal the number of failures in a row and the
 * time of the last attempt (the backoff), and when a purge last completed (the health line). It lives in the Durable
 * Object's key-value storage, not in SQL: web_guest_retention has no column for it and this Part adds no migration.
 */
export type RetentionLedger = {
  failures: Record<string, [number, number, RetentionFailureDetail?]>;
  lastSuccessAt: number | null;
};
/**
 * Part 22a2. Where the LAST failure of one principal broke, as the same fixed labels a report carries (never an id): kept per
 * principal so the operator's inspect can say what is failing without a live tail.
 */
export type RetentionFailureDetail = {
  code: string;
  phase: RetentionPhase;
  sub: string;
  errorName: string;
  messageShape: string;
};
export type RetentionMemory = { load(): Promise<RetentionLedger>; save(ledger: RetentionLedger): Promise<void> };
const emptyLedger = (): RetentionLedger => ({ failures: {}, lastSuccessAt: null });
export function inMemoryRetention(): RetentionMemory {
  let kept = emptyLedger();
  return { load: async () => structuredClone(kept), save: async (ledger) => void (kept = structuredClone(ledger)) };
}
const LEDGER_KEY = 'retention:ledger';
const LEDGER_MAX = 500;
/** Durable Object key-value storage (the same API the owner alerts use). */
export function durableRetentionMemory(storage: {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}): RetentionMemory {
  return {
    load: async () => {
      const value = (await storage.get(LEDGER_KEY)) as Partial<RetentionLedger> | undefined;
      const failures: RetentionLedger['failures'] = {};
      for (const [id, entry] of Object.entries(value?.failures ?? {}))
        if (
          Array.isArray(entry) &&
          Number.isSafeInteger(entry[0]) &&
          Number.isSafeInteger(entry[1]) &&
          Object.keys(failures).length < LEDGER_MAX
        ) {
          const detail = failureDetail(entry[2]);
          failures[id] = detail ? [entry[0], entry[1], detail] : [entry[0], entry[1]];
        }
      return {
        failures,
        lastSuccessAt: Number.isSafeInteger(value?.lastSuccessAt) ? (value!.lastSuccessAt as number) : null,
      };
    },
    save: (ledger) => storage.put(LEDGER_KEY, ledger),
  };
}
const failureDetail = (value: unknown): RetentionFailureDetail | undefined => {
  const v = value as Partial<Record<keyof RetentionFailureDetail, unknown>> | null | undefined;
  return v &&
    typeof v.code === 'string' &&
    typeof v.phase === 'string' &&
    typeof v.sub === 'string' &&
    typeof v.errorName === 'string' &&
    typeof v.messageShape === 'string'
    ? ({
        code: v.code.slice(0, 64),
        phase: v.phase as RetentionPhase,
        sub: v.sub.slice(0, 64),
        errorName: v.errorName.slice(0, 40),
        messageShape: v.messageShape.slice(0, 160),
      } satisfies RetentionFailureDetail)
    : undefined;
};
/**
 * What the operator sees: counts, a time and, per failing principal, where its last failure broke (labels, an error class
 * name, a message with its values taken out, and how many times in a row) - never an id.
 */
export type RetentionHealth = {
  failing: number;
  oldestAgeBucket: AgeBucket | null;
  lastSuccessAt: number | null;
  failures: (RetentionFailureDetail & { count: number })[];
};
/** At most this many failing principals are listed on the operator's inspect, the most frequent first. */
const HEALTH_LIST_LIMIT = 20;
/** Candidates looked at per sweep when some of them are in backoff (so a stuck few cannot hide the rest). */
const SCAN_PAGE = 64;
const SCAN_PAGES = 8;

type Retention = WebRetentionRow & { db_cleared_at: number | null };
type ObjectIntent = {
  operation_id: string;
  ordinal: number;
  principal_id: string;
  world_id: string;
  reference_json: string;
  erased_at: number | null;
};

/** Only this new cloud113 authority. No legacy Node paths, account deletion or shared fixed media. */
export class WebCloudRetention {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  lastError: string | null = null;
  /** GUEST_GRACE_ENABLED: a guest without a login is purged at expires_at + graceMs (0 = at expires_at, as before). */
  private readonly graceMs: number;
  /** Part 17f: told (coarse code only) whenever a purge step fails, so it shows in the tail and counts for the owner alerts. */
  private readonly report: ((report: RetentionReport) => void) | undefined;
  /** Part 17g: which call and which statement group is running, so a failure can say where it broke. */
  private phase: RetentionPhase = 'markExpired';
  private sub = 'start';
  /** Part 17g: durable per-principal failure bookkeeping (backoff + health); in memory when none is given. */
  private readonly memory: RetentionMemory;
  private readonly stats: WebStats | undefined;
  constructor(
    store: WebRuntimeStore,
    clock: Clock,
    graceMs = 0,
    report?: (report: RetentionReport) => void,
    memory: RetentionMemory = inMemoryRetention(),
    /** Part 22c: closes the D1 / D7 cohorts and prunes the active markers once per UTC day, on the same alarm. */
    stats?: WebStats,
  ) {
    this.report = report;
    this.memory = memory;
    this.stats = stats;
    ensure(
      Number.isSafeInteger(graceMs) && graceMs >= 0 && graceMs <= 30 * 24 * 60 * 60_000,
      'WEB_RETENTION_GRACE_INVALID',
    );
    this.graceMs = graceMs;
    store.requireProviderRuntime();
    ensure(
      store.providerAudio && store.get("SELECT 1 FROM sqlite_master WHERE name='cf_web_audio_objects'"),
      'WEB_CLOUD_MEDIA_MODE_MISMATCH',
    );
    this.store = store;
    this.clock = clock;
  }
  /** The row of a principal this class may purge: a guest (no administrator account). */
  private guest(principalId: string) {
    const row = this.store.get<Retention>('SELECT * FROM web_guest_retention WHERE principal_id=?', principalId);
    ensure(
      row &&
        this.store.get(
          `SELECT 1 FROM web_principals p WHERE p.id=? AND p.world_id=? AND p.kind='guest'
      AND NOT EXISTS (SELECT 1 FROM web_accounts a WHERE a.principal_id=p.id)`,
          principalId,
          row.world_id,
        ),
      'WEB_RETENTION_SCOPE_UNSAFE',
    );
    return row;
  }
  nextDue() {
    // A guest with a login is due when it has been inactive for 180 days, not when its trial ends.
    const logins = playerLoginsExist(this.store);
    const row = this.store.get<{ due: number | null }>(
      `SELECT min(CASE WHEN r.state='purging' THEN ?
        ${logins ? 'WHEN l.principal_id IS NOT NULL THEN l.last_seen_at+?' : ''}
        ELSE r.expires_at+${this.graceMs} END) due
      FROM web_guest_retention r JOIN web_principals p ON p.id=r.principal_id AND p.world_id=r.world_id
      ${logins ? 'LEFT JOIN web_player_logins l ON l.principal_id=r.principal_id' : ''}
      WHERE p.kind='guest' AND (r.state IN ('active','purging')${logins ? " OR r.state='unstarted' AND l.principal_id IS NOT NULL" : ''})`,
      this.clock.now() + 30_000,
      ...(logins ? [PLAYER_INACTIVE_MS] : []),
    );
    // Part 19: the anonymous review archive's rows expire on their own clock.
    const archive = nextReviewArchiveExpiry(this.store);
    const due = row?.due == null ? archive : archive === null ? row.due : Math.min(row.due, archive);
    // Part 22c: the statistics wake the alarm at the next UTC midnight while a cohort or a marker is waiting.
    const stats = this.stats?.nextDue(this.clock.now()) ?? null;
    return due === null ? stats : stats === null ? due : Math.min(due, stats);
  }
  /** What is known about a failing principal, as labels only: kind, retention state and how long it has been due. */
  private describe(principalId: string): {
    principalKind?: 'guest' | 'account';
    state?: string;
    oldestAgeBucket?: AgeBucket;
  } {
    try {
      const row = this.store.get<{
        kind: string;
        state: string | null;
        expires_at: number | null;
        revoked: number | null;
        last_seen: number | null;
      }>(
        `SELECT p.kind,r.state,r.expires_at,
          (SELECT max(s.revoked_at) FROM web_sessions s WHERE s.principal_id=p.id) revoked,
          ${playerLoginsExist(this.store) ? '(SELECT l.last_seen_at FROM web_player_logins l WHERE l.principal_id=p.id)' : 'NULL'} last_seen
        FROM web_principals p LEFT JOIN web_guest_retention r ON r.principal_id=p.id WHERE p.id=?`,
        principalId,
      );
      if (!row) return {};
      // The same approximation as purgeDiagnostics: there is no purge-start column, so a purge counts from the moment its
      // sessions were revoked, a retained player from the end of its inactivity window, a guest from the end of its trial.
      const since =
        row.state === 'purging'
          ? (row.revoked ?? row.expires_at)
          : row.last_seen !== null
            ? row.last_seen + PLAYER_INACTIVE_MS
            : row.expires_at === null
              ? null
              : row.expires_at + this.graceMs;
      return {
        principalKind: row.kind === 'account' ? ('account' as const) : ('guest' as const),
        ...(row.state
          ? {
              state:
                row.state === 'active' || row.state === 'purging' || row.state === 'unstarted' ? row.state : 'other',
            }
          : {}),
        ...(since === null ? {} : { oldestAgeBucket: ageBucket(Math.max(0, this.clock.now() - since)) }),
      };
    } catch {
      return {};
    }
  }
  private schemaNames() {
    try {
      return new Set(
        this.store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name),
      );
    } catch {
      return new Set<string>();
    }
  }
  /** One failed purge, read at the catch site (the call and statement group that was running, the error's shape). */
  private failure(error: unknown, principalId: string | null, names: ReadonlySet<string>) {
    const info = principalId === null ? {} : this.describe(principalId);
    return {
      code: safeCode(error),
      phase: this.phase,
      sub: this.sub,
      errorName: errorName(error),
      messageShape: messageShape(
        error instanceof Error ? error.message : typeof error === 'string' ? error : '',
        names,
      ),
      ...(firstFrame(error) ? { at: firstFrame(error)! } : {}),
      ...info,
    };
  }
  /** The fixed labels of a failure that happened just now (this.phase / this.sub are where it broke). */
  private detail(error: unknown, names: ReadonlySet<string>): RetentionFailureDetail {
    const found = this.failure(error, null, names);
    return {
      code: found.code,
      phase: found.phase,
      sub: found.sub,
      errorName: found.errorName,
      messageShape: found.messageShape,
    };
  }
  async sweep(limit = 8) {
    ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 16, 'WEB_RETENTION_SWEEP_INVALID');
    this.lastError = null;
    // Part 22c: the daily statistics work (cohort close, marker pruning) never blocks or fails a purge.
    try {
      this.stats?.maintain(this.clock.now());
    } catch (error) {
      this.lastError ??= safeCode(error);
    }
    const names = this.schemaNames();
    // A broken ledger must never stop a purge: the worst case is that nothing is backed off.
    const ledger = await this.memory.load().catch(emptyLedger);
    let dirty = false;
    const groups = new Map<
      string,
      { report: Omit<RetentionReport, 'failed' | 'stuck' | 'backedOff'>; count: number }
    >();
    const stuck = new Set<string>();
    const note = (error: unknown, principalId: string | null) => {
      const found = this.failure(error, principalId, names);
      this.lastError ??= found.code;
      const key = JSON.stringify([
        found.code,
        found.phase,
        found.sub,
        found.errorName,
        found.messageShape,
        found.at,
        found.principalKind,
        found.state,
      ]);
      const group = groups.get(key);
      if (group) {
        group.count++;
        if (found.oldestAgeBucket)
          group.report.oldestAgeBucket = olderBucket(group.report.oldestAgeBucket, found.oldestAgeBucket);
      } else groups.set(key, { report: { event: 'web_retention_failed', step: 'sweep', ...found }, count: 1 });
    };
    // Part 19: delete anonymous review archive rows past their 180 days (batched, idempotent; independent of the flag).
    // A failure here is reported on its own and never keeps the principals below from being purged.
    try {
      this.phase = 'archive';
      this.sub = 'review_archive';
      sweepReviewArchive(this.store, this.clock.now());
    } catch (error) {
      note(error, null);
    }
    const now = this.clock.now();
    // Forget what is no longer pending (purged or gone), then choose who to try: the oldest due principals that are not in backoff.
    for (const id of Object.keys(ledger.failures)) {
      const state = this.store.get<{ state: string }>(
        'SELECT state FROM web_guest_retention WHERE principal_id=?',
        id,
      )?.state;
      if (state === undefined || state === 'purged') {
        delete ledger.failures[id];
        dirty = true;
      }
    }
    const due = guestPurgeDue(this.store, now, this.graceMs);
    const rows: { principal_id: string }[] = [];
    let backedOff = 0;
    for (let page = 0; page < SCAN_PAGES && rows.length < limit; page++) {
      const found = this.store.all<{ principal_id: string }>(
        `SELECT r.principal_id FROM web_guest_retention r
        JOIN web_principals p ON p.id=r.principal_id AND p.world_id=r.world_id
        WHERE p.kind='guest'
        AND ${due.sql} ORDER BY r.expires_at,r.principal_id LIMIT ? OFFSET ?`,
        ...due.args,
        SCAN_PAGE,
        page * SCAN_PAGE,
      );
      for (const row of found) {
        const previous = ledger.failures[row.principal_id];
        if (previous && now < previous[1] + backoffDelay(previous[0])) backedOff++;
        else if (rows.length < limit) rows.push(row);
      }
      if (found.length < SCAN_PAGE) break;
    }
    let failed = 0;
    for (const { principal_id } of rows) {
      this.phase = 'markExpired';
      this.sub = 'start';
      try {
        this.markExpired(principal_id);
        this.clearDatabase(principal_id);
        await this.eraseAudio(principal_id);
        if (ledger.failures[principal_id]) delete ledger.failures[principal_id];
        ledger.lastSuccessAt = this.clock.now();
        dirty = true;
      } catch (error) {
        failed++;
        stuck.add(principal_id);
        const previous = ledger.failures[principal_id];
        ledger.failures[principal_id] = [(previous?.[0] ?? 0) + 1, this.clock.now(), this.detail(error, names)];
        dirty = true;
        note(error, principal_id);
      }
    }
    if (dirty) await this.memory.save(ledger).catch(() => {});
    // Most 4 reports per sweep, the most frequent cause first: a tail full of one repeated line helps nobody.
    for (const group of [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 4))
      this.report?.({ ...group.report, failed: group.count, stuck: stuck.size, backedOff } as RetentionReport);
    return { processed: rows.length, failed };
  }
  /** Counts for the operator: how many principals are failing now, how long the oldest has been due, when a purge last completed. */
  async health(): Promise<RetentionHealth> {
    const ledger = await this.memory.load().catch(emptyLedger);
    let failing = 0,
      oldest: AgeBucket | undefined;
    const failures: RetentionHealth['failures'] = [];
    for (const id of Object.keys(ledger.failures)) {
      const state = this.store.get<{ state: string }>(
        'SELECT state FROM web_guest_retention WHERE principal_id=?',
        id,
      )?.state;
      if (state === undefined || state === 'purged') continue;
      failing++;
      const bucket = this.describe(id).oldestAgeBucket;
      if (bucket) oldest = olderBucket(oldest, bucket);
      const entry = ledger.failures[id]!;
      // (An entry written before Part 22a2 has no detail until its next failure.)
      if (entry[2]) failures.push({ ...entry[2], count: entry[0] });
    }
    failures.sort((a, b) => b.count - a.count);
    return {
      failing,
      oldestAgeBucket: oldest ?? null,
      lastSuccessAt: ledger.lastSuccessAt,
      failures: failures.slice(0, HEALTH_LIST_LIMIT),
    };
  }
  /** The player's own deletion request, step 1 (fence + release): the caller is WebPlayerAccounts.deleteAccount. */
  beginDeletion(principalId: string) {
    this.phase = 'markExpired';
    this.sub = 'start';
    this.markExpired(principalId, 'deleted');
  }
  /** Step 2 and 3 of the same audited path (T2 database clear, then F file erase). A failure leaves 'purging' for the alarm. */
  async finishDeletion(principalId: string) {
    this.phase = 'clearDatabase';
    this.sub = 'start';
    try {
      this.clearDatabase(principalId);
      await this.eraseAudio(principalId);
      const ledger = await this.memory.load().catch(emptyLedger);
      if (ledger.failures[principalId]) delete ledger.failures[principalId];
      ledger.lastSuccessAt = this.clock.now();
      await this.memory.save(ledger).catch(() => {});
    } catch (error) {
      // The caller must not turn a deletion into an error page, so it swallows this; the alarm resumes the purge.
      const found = this.failure(error, principalId, this.schemaNames());
      const ledger = await this.memory.load().catch(emptyLedger);
      ledger.failures[principalId] = [
        (ledger.failures[principalId]?.[0] ?? 0) + 1,
        this.clock.now(),
        {
          code: found.code,
          phase: found.phase,
          sub: found.sub,
          errorName: found.errorName,
          messageShape: found.messageShape,
        },
      ];
      await this.memory.save(ledger).catch(() => {});
      this.report?.({ event: 'web_retention_failed', step: 'deletion', ...found, failed: 1, stuck: 1 });
      throw error;
    }
  }
  /**
   * T1. reason 'deleted' is the player's own request (删除我的账号 / 清除本设备的体验数据): it replaces the time condition
   * and nothing else, so the same fencing, release and audit steps run.
   */
  markExpired(principalId: string, reason: 'expired' | 'deleted' = 'expired') {
    this.phase = 'markExpired';
    this.sub = 'scope';
    this.store.transaction(() => {
      const row = this.guest(principalId),
        now = this.clock.now();
      if (['purging', 'purged'].includes(row.state)) return;
      this.sub = 'state';
      if (reason === 'deleted')
        ensure(['unstarted', 'active', 'protected'].includes(row.state), 'WEB_RETENTION_NOT_EXPIRED');
      else {
        // A guest with an email login is purged for inactivity, not at trial end (web-player-purge.ts).
        const lastSeen = playerLastSeenAt(this.store, principalId);
        ensure(
          lastSeen === null
            ? row.state === 'active' &&
                row.expires_at !== null &&
                row.expires_at + this.graceMs <= now &&
                !bonusKeepsGuest(this.store, principalId)
            : (row.state === 'active' || row.state === 'unstarted') && lastSeen + PLAYER_INACTIVE_MS <= now,
          'WEB_RETENTION_NOT_EXPIRED',
        );
      }
      // Part 19 (flag CHAT_REVIEW_ENABLED): the anonymous transcript copy is made HERE, in the transaction that starts the
      // purge and before anything is cleared, so a crash can neither lose the copy nor leave content without one. A purge
      // resumed later finds state 'purging' above and returns before this line: it never archives twice.
      this.sub = 'review_archive';
      if (this.store.chatReview === true && chatReviewTablesExist(this.store))
        archivePlayerChats(this.store, principalId, row.world_id, now);
      // Part 22c: the purge STARTS here (T1), once per principal - the 'purging' / 'purged' return above and this transaction see
      // to that. Counted by why it started: the player's own deletion, 180 days without a visit (a login), or an ended trial.
      this.sub = 'stats';
      recordStat(
        this.store,
        reason === 'deleted'
          ? 'purge_deleted'
          : playerLastSeenAt(this.store, principalId) !== null
            ? 'purge_inactive'
            : 'purge_expired',
        now,
      );
      // The table only allows a purging row that has a trial window; a never-started guest gets a one-ms one.
      this.sub = 'retention_row';
      this.store.run(
        `UPDATE web_guest_retention SET state='purging',revision=revision+1,
        started_at=coalesce(started_at,?),expires_at=coalesce(expires_at,?) WHERE principal_id=?`,
        now,
        now + 1,
        principalId,
      );
      // Part 17f: the address is free from here on, whatever happens to the heavier clear that follows.
      this.sub = 'player_logins';
      releasePlayerLogin(this.store, principalId);
      this.sub = 'operations';
      for (const operation of this.store.all<{ id: string; ip_window_id: string | null; metering_type: string }>(
        "SELECT * FROM web_operations WHERE principal_id=? AND world_id=? AND quota_state='reserved'",
        principalId,
        row.world_id,
      )) {
        ensure(
          this.store.run(
            `UPDATE web_operations SET status='failed',quota_state='released',failure_code='TRIAL_EXPIRED',
          stage_version=stage_version+1,lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
          WHERE id=? AND status NOT IN ('published','cancelled','failed') AND quota_state='reserved'`,
            operation.id,
          ).changes === 1,
          'WEB_RETENTION_STALE',
        );
        // An entitled operation of a guest has no trial slot to give back: a deletion on request, or one admitted
        // on a free allowance outside the counters (its row in web_free_operations: the signup bonus or trial replies 4-5); the budget hold is settled below like any other.
        if (
          operation.metering_type === 'entitled' &&
          (reason === 'deleted' ||
            (signupBonusTablesExist(this.store) &&
              this.store.get('SELECT 1 FROM web_free_operations WHERE operation_id=?', operation.id)))
        ) {
          ensure(operation.ip_window_id === null, 'WEB_RETENTION_SCOPE_UNSAFE');
          continue;
        }
        ensure(operation.metering_type === 'trial' && operation.ip_window_id, 'WEB_RETENTION_SCOPE_UNSAFE');
        ensure(
          this.store.run(
            'UPDATE web_ip_windows SET reserved=reserved-1 WHERE id=? AND reserved>0',
            operation.ip_window_id,
          ).changes === 1,
          'WEB_QUOTA_STATE_INVALID',
        );
        settleWebLifetimeReservation(this.store, operation.ip_window_id, 'released');
        ensure(
          this.store.run(
            'UPDATE web_principals SET trial_reserved=trial_reserved-1,revision=revision+1 WHERE id=? AND trial_reserved>0',
            principalId,
          ).changes === 1,
          'WEB_QUOTA_STATE_INVALID',
        );
      }
      this.sub = 'provider_attempts';
      const ledger = new WebProviderOffline(this.store, this.clock);
      for (const attempt of this.store.all<{
        operation_id: string;
        phase: 'draft' | 'review' | 'speech';
        ordinal: number;
        player_id: string;
        conversation_id: string;
        character_id: string;
        input_message_id: string;
        state: string;
      }>(
        "SELECT * FROM web_provider_attempts WHERE principal_id=? AND world_id=? AND state IN ('not_sent','sent')",
        principalId,
        row.world_id,
      )) {
        const key = { operationId: attempt.operation_id, phase: attempt.phase, ordinal: attempt.ordinal };
        const scope = {
          principalId,
          worldId: row.world_id,
          playerId: attempt.player_id,
          conversationId: attempt.conversation_id,
          characterId: attempt.character_id,
          inputMessageId: attempt.input_message_id,
        };
        if (attempt.state === 'not_sent') ledger.releaseUnsent(key, scope);
        else {
          ledger.markUnknown(key, scope);
          this.store.run(
            `UPDATE web_external_attempts SET dispatch_state='unknown'
            WHERE operation_id=? AND phase=? AND ordinal=? AND dispatch_state='sent'`,
            attempt.operation_id,
            attempt.phase,
            attempt.ordinal,
          );
        }
      }
    });
  }
  clearDatabase(principalId: string) {
    this.phase = 'clearDatabase';
    this.sub = 'scope';
    this.store.transaction(() => {
      const row = this.guest(principalId),
        world = row.world_id;
      ensure(row.state === 'purging' || row.state === 'purged', 'WEB_RETENTION_NOT_PURGING');
      if (row.db_cleared_at !== null) return;
      ensure(
        row.state === 'purging' &&
          this.store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1 &&
          this.store.get<{ policy_json: string }>('SELECT policy_json FROM worlds WHERE id=?', world)?.policy_json ===
            '{}' &&
          !this.store.get('SELECT 1 FROM web_principals WHERE world_id=? AND id<>?', world, principalId) &&
          !this.store.get('SELECT 1 FROM web_retention_purge_gate'),
        'WEB_RETENTION_SCOPE_UNSAFE',
      );
      this.sub = 'audit_source';
      auditWebLifecycleWorld(this.store, world, 'source', 'provider');
      this.sub = 'media_intent';
      for (const table of ['web_provider_outputs', 'web_provider_media_assets'])
        ensure(
          !this.store.get(
            `SELECT 1 FROM ${table} m
        JOIN web_operations o ON o.id=m.operation_id WHERE o.world_id=? AND m.audio_ref_json IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM cf_web_audio_objects c WHERE c.operation_id=m.operation_id AND c.ordinal=m.ordinal
          AND c.principal_id=o.principal_id AND c.world_id=o.world_id AND c.reference_json=m.audio_ref_json) LIMIT 1`,
            world,
          ),
          'WEB_RETENTION_MEDIA_INTENT_REQUIRED',
        );
      this.sub = 'purge_gate';
      this.store.run('INSERT INTO web_retention_purge_gate VALUES (?,?,?)', principalId, world, row.revision);
      const operations = 'SELECT id FROM web_operations WHERE principal_id=? AND world_id=?';
      for (const table of ['web_local_events', 'web_user_events']) {
        this.sub = table;
        this.store.run(`DELETE FROM ${table} WHERE principal_id=? AND world_id=?`, principalId, world);
      }
      for (const table of [
        'web_publication_items',
        'web_publications',
        'web_provider_media_assets',
        'web_provider_voice_segments',
        'web_provider_candidates',
        'web_provider_outputs',
        'web_local_text_outputs',
        'web_local_audio_outputs',
        'web_v7_candidates',
        'web_v7_requests',
        'web_input_snapshots',
        'web_reviewed_candidates',
        'web_private_audio_assets',
        'web_synthetic_voice_segments',
        'web_stage_attempts',
      ]) {
        this.sub = table;
        this.store.run(`DELETE FROM ${table} WHERE operation_id IN (${operations})`, principalId, world);
      }
      this.sub = 'embed_holds';
      releaseUnsentEmbedHolds(this.store, world);
      // Co-creation ideas (schema 117) are the player's data and go with the player.
      this.sub = 'cocreation';
      purgeCocreation(this.store, { principalId });
      // The email login (schema 118) and the nickname 名片 revisions it wrote are the player's data too.
      purgePlayerLogins(
        this.store,
        { principalId, worldId: world, now: this.clock.now() },
        (group) => void (this.sub = group),
      );
      for (const table of [
        'memory_facts',
        'memory_embeddings',
        'web_embed_attempts',
        'memory_episode_sources',
        'memory_mentions',
        'memory_episodes',
        'memory_corrections',
        'memory_catalog',
        'memory_context_versions',
        'memory_topics',
        'relationship_corrections',
        'relationship_reviews',
        'relationship_events',
        'relationship_job_contexts',
        'relationship_daily_budgets',
        'relationship_states',
        'scene_events',
        'scene_job_contexts',
        'scene_end_requests',
        'scene_states',
        'job_evidence_snapshots',
        'dialogue_bubbles',
        'outbox',
      ]) {
        this.sub = table;
        if (!LATE_TABLES.has(table) || embeddingTableExists(this.store, table))
          this.store.run(`DELETE FROM ${table} WHERE world_id=?`, world);
      }
      this.sub = 'jobs';
      this.store.run('UPDATE jobs SET published_message_id=NULL WHERE world_id=?', world);
      this.store.run('DELETE FROM jobs WHERE world_id=?', world);
      this.sub = 'operations_scrub';
      for (const operation of this.store.all<{ id: string; payload_hash: string }>(
        'SELECT id,payload_hash FROM web_operations WHERE principal_id=? AND world_id=?',
        principalId,
        world,
      ))
        this.store.run(
          'UPDATE web_operations SET input_message_id=NULL,payload_hash=? WHERE id=?',
          webReceiptDigest(this.store, 'receipt', `purged-payload\0${operation.payload_hash}`),
          operation.id,
        );
      this.sub = 'external_attempts';
      for (const attempt of this.store.all<{
        operation_id: string;
        stage: string;
        phase: string;
        ordinal: number;
        receipt_json: string | null;
        usage_json: string | null;
      }>(
        `SELECT * FROM web_external_attempts
        WHERE operation_id IN (${operations}) AND dispatch_state='known'`,
        principalId,
        world,
      ))
        this.store.run(
          `UPDATE web_external_attempts SET receipt_json=NULL,usage_json=NULL,receipt_digest=coalesce(receipt_digest,?),usage_digest=coalesce(usage_digest,?)
          WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?`,
          attempt.receipt_json === null ? null : webReceiptDigest(this.store, 'receipt', attempt.receipt_json),
          attempt.usage_json === null ? null : webReceiptDigest(this.store, 'usage', attempt.usage_json),
          attempt.operation_id,
          attempt.stage,
          attempt.phase,
          attempt.ordinal,
        );
      this.sub = 'messages';
      this.store.run('DELETE FROM messages WHERE world_id=?', world);
      this.sub = 'contacts';
      this.store.run('UPDATE contacts SET state_json=? WHERE world_id=?', JSON.stringify(emptySession()), world);
      this.store.run("UPDATE world_characters SET relationship='new' WHERE world_id=?", world);
      // The principal's 'access' events (trigger web_local_access_update) are the player's rows too.
      this.sub = 'web_local_events';
      this.store.run('DELETE FROM web_local_events WHERE principal_id=? AND world_id=?', principalId, world);
      this.sub = 'audit_cleared';
      this.store.run('DELETE FROM web_retention_purge_gate WHERE principal_id=?', principalId);
      auditWebLifecycleWorld(this.store, world, 'cleared', 'provider');
      this.sub = 'foreign_key_check';
      ensure(!this.store.get('PRAGMA foreign_key_check'), 'WEB_RETENTION_CLEANUP_INCOMPLETE');
      this.sub = 'retention_row';
      this.store.run(
        'UPDATE web_guest_retention SET db_cleared_at=?,revision=revision+1 WHERE principal_id=?',
        this.clock.now(),
        principalId,
      );
    });
  }
  async eraseAudio(principalId: string) {
    this.phase = 'eraseAudio';
    this.sub = 'scope';
    const row = this.guest(principalId);
    ensure(['purging', 'purged'].includes(row.state) && row.db_cleared_at !== null, 'WEB_RETENTION_DB_NOT_CLEARED');
    for (const intent of this.store.all<ObjectIntent>(
      `SELECT * FROM cf_web_audio_objects
      WHERE principal_id=? AND world_id=? AND erased_at IS NULL ORDER BY operation_id,ordinal`,
      principalId,
      row.world_id,
    )) {
      this.sub = 'audio_objects';
      const reference = JSON.parse(intent.reference_json) as MediaObjectReference;
      const authorize = async () => {
        const current = this.guest(principalId);
        ensure(
          ['purging', 'purged'].includes(current.state) &&
            current.db_cleared_at !== null &&
            current.world_id === row.world_id &&
            this.store.get(
              'SELECT 1 FROM cf_web_audio_objects WHERE operation_id=? AND ordinal=? AND principal_id=? AND world_id=? AND reference_json=?',
              intent.operation_id,
              intent.ordinal,
              principalId,
              row.world_id,
              intent.reference_json,
            ),
          'WEB_RETENTION_SCOPE_UNSAFE',
        );
        const a = this.store.get<{
          player_id: string;
          conversation_id: string;
          character_id: string;
          input_message_id: string;
        }>(
          "SELECT * FROM web_provider_attempts WHERE operation_id=? AND phase='speech' AND ordinal=? AND principal_id=? AND world_id=?",
          intent.operation_id,
          intent.ordinal,
          principalId,
          row.world_id,
        );
        ensure(a, 'WEB_RETENTION_SCOPE_UNSAFE');
        checkAudioReference(
          reference,
          speechObjectScope(this.store, intent.operation_id, intent.ordinal, {
            principalId,
            worldId: row.world_id,
            playerId: a.player_id,
            conversationId: a.conversation_id,
            characterId: a.character_id,
            inputMessageId: a.input_message_id,
          }),
        );
      };
      await this.store.providerAudio!.erase(reference, authorize);
      this.store.run(
        'UPDATE cf_web_audio_objects SET erased_at=? WHERE operation_id=? AND ordinal=? AND erased_at IS NULL',
        this.clock.now(),
        intent.operation_id,
        intent.ordinal,
      );
    }
    this.sub = 'retention_row';
    this.store.transaction(() => {
      this.guest(principalId);
      ensure(
        !this.store.get(
          'SELECT 1 FROM cf_web_audio_objects WHERE principal_id=? AND world_id=? AND erased_at IS NULL',
          principalId,
          row.world_id,
        ),
        'WEB_RETENTION_FILES_PENDING',
      );
      this.store.run(
        "UPDATE web_guest_retention SET state='purged',revision=revision+1 WHERE principal_id=? AND state='purging' AND db_cleared_at IS NOT NULL",
        principalId,
      );
    });
  }
}
