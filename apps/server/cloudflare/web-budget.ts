import { ensure } from '../../../packages/domain/errors.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import type { DurableSQLStorage } from './store.ts';
import {
  budgetHash,
  validateCloudBudgetAuthorization,
  validateCloudBudgetTarget,
  type CloudBudgetAuthorization,
  type CloudBudgetTarget,
  type Provider,
} from '../budget/web-provider-budget-contract.ts';

const schema = `CREATE TABLE cf_web_budget_grants(provider TEXT PRIMARY KEY,manifest_json TEXT NOT NULL,
  micros INTEGER CHECK(micros IS NULL OR (micros>0 AND micros<=3000000))) STRICT;
CREATE TABLE cf_web_budget_calls(id TEXT PRIMARY KEY,provider TEXT NOT NULL REFERENCES cf_web_budget_grants(provider),
  fingerprint TEXT NOT NULL,held_micros INTEGER NOT NULL CHECK(held_micros>0),
  charged_micros INTEGER,receipt_hash TEXT,created_at INTEGER NOT NULL,settled_at INTEGER,
  CHECK((charged_micros IS NULL AND receipt_hash IS NULL AND settled_at IS NULL) OR
    (charged_micros>=0 AND charged_micros<=held_micros AND receipt_hash IS NOT NULL AND settled_at IS NOT NULL))) STRICT;`;
/**
 * Part 22b: allowance added by the owner after initialization (console 预算充值). A separate, additive table created on first
 * start: the grant rows and the hashed schema above are untouched (their CHECK still caps the INITIAL grant at USD 3), so a
 * deployed authority keeps its identity. The allowance of a capped provider is its grant plus the sum of these rows.
 */
const topupSchema = `CREATE TABLE IF NOT EXISTS cf_web_budget_topups(request_id TEXT PRIMARY KEY,provider TEXT NOT NULL,
  micros INTEGER NOT NULL CHECK(micros>0),created_at INTEGER NOT NULL) STRICT`;
const BUDGET_TOPUP_MIN_MICROS = 1_000_000;
const BUDGET_TOPUP_MAX_MICROS = 50_000_000;
export type CloudBudgetEntry = {
  provider: Provider;
  fingerprint: string;
  held_micros: number;
  charged_micros: number | null;
  receipt_hash: string | null;
};

/** Independent cumulative authority: no default grant, business-instance reset or unknown release. */
export class WebCloudBudget {
  private readonly storage: DurableSQLStorage;
  private readonly clock: Clock;
  private readonly target: CloudBudgetTarget;
  constructor(storage: DurableSQLStorage, clock: Clock, target: CloudBudgetTarget, actualObjectId: string) {
    validateCloudBudgetTarget(target);
    ensure(target.objectId === actualObjectId, 'WEB_CLOUD_BUDGET_TARGET_MISMATCH');
    this.storage = storage;
    this.clock = clock;
    this.target = { accountId: target.accountId, namespaceId: target.namespaceId, objectId: target.objectId };
    storage.transactionSync(() => {
      if (!this.row("SELECT 1 FROM sqlite_master WHERE name='cf_web_budget_meta'")) {
        ensure(
          !this.row("SELECT 1 FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'"),
          'WEB_CLOUD_BUDGET_EMPTY_REQUIRED',
        );
        this.sql(
          'CREATE TABLE cf_web_budget_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_hash TEXT NOT NULL,target_json TEXT NOT NULL) STRICT',
        );
        this.sql(schema);
        this.sql('INSERT INTO cf_web_budget_meta VALUES (1,?,?)', budgetHash(schema), JSON.stringify(this.target));
      }
      const meta = this.row<{ schema_hash: string; target_json: string }>(
        'SELECT * FROM cf_web_budget_meta WHERE singleton=1',
      );
      ensure(
        meta?.schema_hash === budgetHash(schema) && meta.target_json === JSON.stringify(this.target),
        'WEB_CLOUD_BUDGET_IDENTITY_MISMATCH',
      );
      this.sql(topupSchema);
    });
  }
  private sql(query: string, ...bindings: (string | number)[]) {
    return this.storage.sql.exec(query, ...bindings).toArray();
  }
  private row<T>(query: string, ...bindings: (string | number)[]) {
    return this.sql(query, ...bindings)[0] as T | undefined;
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  /** Private operator only: v1 requires local test allocation; v2 is separate production consent. */
  initialize(grants: CloudBudgetAuthorization[]) {
    ensure(
      grants.length === 2 &&
        new Set(grants.map((g) => g.provider)).size === 2 &&
        new Set(grants.map((g) => g.version)).size === 1,
      'WEB_CLOUD_BUDGET_GRANTS_REQUIRED',
    );
    return this.storage.transactionSync(() => {
      for (const grant of grants) {
        validateCloudBudgetAuthorization(grant);
        ensure(
          grant.accountId === this.target.accountId &&
            grant.namespaceId === this.target.namespaceId &&
            grant.objectId === this.target.objectId,
          'WEB_CLOUD_BUDGET_TARGET_MISMATCH',
        );
        const prior = this.row<{ manifest_json: string }>(
          'SELECT manifest_json FROM cf_web_budget_grants WHERE provider=?',
          grant.provider,
        );
        if (prior) ensure(prior.manifest_json === JSON.stringify(grant), 'WEB_CLOUD_BUDGET_GRANT_CONFLICT');
        else
          this.storage.sql.exec(
            'INSERT INTO cf_web_budget_grants VALUES (?,?,?)',
            grant.provider,
            JSON.stringify(grant),
            grant.version === 1 ? grant.micros : null,
          );
      }
      return this.summary();
    });
  }
  summary() {
    return (['deepseek', 'fish'] as const).map((provider) => {
      const grant = this.row<{ micros: number | null; manifest_json: string }>(
        'SELECT micros,manifest_json FROM cf_web_budget_grants WHERE provider=?',
        provider,
      );
      ensure(grant, 'WEB_CLOUD_BUDGET_NOT_INITIALIZED');
      const authorization = JSON.parse(grant.manifest_json) as CloudBudgetAuthorization;
      validateCloudBudgetAuthorization(authorization);
      ensure(grant.micros === (authorization.version === 1 ? authorization.micros : null), 'WEB_CLOUD_BUDGET_CORRUPT');
      // The allowance is the initial grant plus every top-up; a production-unlimited authority has none (and takes none).
      const allowance = grant.micros === null ? null : grant.micros + this.toppedUp(provider);
      const used = this.row<{ spent: number; held: number }>(
        `SELECT COALESCE(SUM(charged_micros),0) spent,
        COALESCE(SUM(CASE WHEN charged_micros IS NULL THEN held_micros ELSE 0 END),0) held
        FROM cf_web_budget_calls WHERE provider=?`,
        provider,
      )!;
      ensure(
        [used.spent, used.held].every((n) => Number.isSafeInteger(n) && n >= 0) &&
          Number.isSafeInteger(used.spent + used.held) &&
          (allowance === null || used.spent + used.held <= allowance),
        'WEB_CLOUD_BUDGET_CORRUPT',
      );
      return {
        provider,
        allowanceMicros: allowance,
        spentMicros: used.spent,
        heldMicros: used.held,
        remainingMicros: allowance === null ? null : allowance - used.spent - used.held,
        policy: authorization.version === 1 ? ('test-cumulative' as const) : ('production-unlimited' as const),
        grantHash: budgetHash(authorization),
      };
    });
  }
  private toppedUp(provider: string) {
    return this.row<{ total: number }>(
      'SELECT COALESCE(SUM(micros),0) total FROM cf_web_budget_topups WHERE provider=?',
      provider,
    )!.total;
  }
  /**
   * Part 22b, owner console only (reached through the business Worker's service binding; there is no operator or HTTP path):
   * add USD 1-50 to the allowance of a CAPPED provider. Idempotent per request id - the same id with the same provider and
   * amount answers the stored result and adds nothing; the same id with anything else is a conflict. A production-unlimited
   * authority has no allowance to add to and refuses. Nothing here touches a reservation or a settled call.
   */
  topUp(requestId: string, provider: Provider, micros: number) {
    ensure(
      typeof requestId === 'string' &&
        /^[A-Za-z0-9_-]{8,128}$/.test(requestId) &&
        ['deepseek', 'fish'].includes(provider) &&
        Number.isSafeInteger(micros) &&
        micros >= BUDGET_TOPUP_MIN_MICROS &&
        micros <= BUDGET_TOPUP_MAX_MICROS &&
        micros % 1_000_000 === 0,
      'WEB_BUDGET_TOPUP_INVALID',
    );
    return this.storage.transactionSync(() => {
      const grant = this.row<{ micros: number | null }>(
        'SELECT micros FROM cf_web_budget_grants WHERE provider=?',
        provider,
      );
      ensure(grant, 'WEB_CLOUD_BUDGET_NOT_INITIALIZED');
      ensure(grant.micros !== null, 'WEB_BUDGET_TOPUP_UNLIMITED');
      const prior = this.row<{ provider: string; micros: number }>(
        'SELECT provider,micros FROM cf_web_budget_topups WHERE request_id=?',
        requestId,
      );
      if (prior) ensure(prior.provider === provider && prior.micros === micros, 'WEB_BUDGET_TOPUP_CONFLICT');
      else
        this.sql(
          'INSERT INTO cf_web_budget_topups(request_id,provider,micros,created_at) VALUES (?,?,?,?)',
          requestId,
          provider,
          micros,
          this.now(),
        );
      const row = this.summary().find((entry) => entry.provider === provider)!;
      return {
        provider,
        addedMicros: micros,
        allowanceMicros: row.allowanceMicros!,
        remainingMicros: row.remainingMicros!,
        duplicate: !!prior,
      };
    });
  }
  read(id: string, fingerprint: string) {
    ensure(
      typeof id === 'string' && id.length > 0 && id.length <= 512 && /^[a-f0-9]{64}$/.test(fingerprint),
      'WEB_SHARED_RESERVATION_INVALID',
    );
    const entry = this.row<CloudBudgetEntry>(
      'SELECT provider,fingerprint,held_micros,charged_micros,receipt_hash FROM cf_web_budget_calls WHERE id=?',
      id,
    );
    if (entry) ensure(entry.fingerprint === fingerprint, 'WEB_SHARED_REQUEST_CONFLICT');
    return entry;
  }
  reserve(id: string, provider: Provider, fingerprint: string, heldMicros: number) {
    ensure(
      ['deepseek', 'fish'].includes(provider) && Number.isSafeInteger(heldMicros) && heldMicros > 0,
      'WEB_SHARED_RESERVATION_INVALID',
    );
    this.storage.transactionSync(() => {
      ensure(!this.read(id, fingerprint), 'WEB_SHARED_ATTEMPT_UNRESOLVED');
      const summary = this.summary().find((row) => row.provider === provider)!;
      ensure(summary.remainingMicros === null || summary.remainingMicros >= heldMicros, 'WEB_SHARED_BUDGET_EXHAUSTED');
      ensure(
        Number.isSafeInteger(summary.spentMicros + summary.heldMicros + heldMicros),
        'WEB_SHARED_RESERVATION_INVALID',
      );
      this.sql(
        'INSERT INTO cf_web_budget_calls(id,provider,fingerprint,held_micros,created_at) VALUES (?,?,?,?,?)',
        id,
        provider,
        fingerprint,
        heldMicros,
        this.now(),
      );
    });
  }
  settle(id: string, fingerprint: string, chargedMicros: number, receipt: unknown) {
    ensure(
      Number.isSafeInteger(chargedMicros) && chargedMicros >= 0 && receipt !== undefined,
      'WEB_SHARED_RECEIPT_INVALID',
    );
    const receiptHash = budgetHash(receipt);
    this.storage.transactionSync(() => {
      const entry = this.read(id, fingerprint);
      ensure(entry && chargedMicros <= entry.held_micros, 'WEB_SHARED_RECEIPT_INVALID');
      if (entry.charged_micros !== null) {
        ensure(
          entry.charged_micros === chargedMicros && entry.receipt_hash === receiptHash,
          'WEB_SHARED_RECEIPT_CONFLICT',
        );
        return;
      }
      this.sql(
        'UPDATE cf_web_budget_calls SET charged_micros=?,receipt_hash=?,settled_at=? WHERE id=? AND charged_micros IS NULL',
        chargedMicros,
        receiptHash,
        this.now(),
        id,
      );
    });
  }
}
