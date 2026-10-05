import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../../packages/contracts/index.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import { budgetAttempt, budgetHash as hash, validateCloudBudgetTarget, validateCloudBudgetGrant,
  type Provider, type BudgetAttemptKey as AttemptKey, type WebAttemptBudget,
  type CloudBudgetTarget, type CloudBudgetGrant } from './web-provider-budget-contract.ts';
export type { Provider } from './web-provider-budget-contract.ts';

export type BudgetHistory = { source: string; digest: string; provider: Provider;
  spentMicros: number; heldMicros: number };
type Entry = { id: string; provider: Provider; fingerprint: string; held_micros: number;
  state: 'sent' | 'known'; charged_micros: number | null; receipt_hash: string | null;
  audio: Uint8Array | null };
const LIMIT = 3_000_000;
const amount = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** One fixed local business-service ledger, shared by every live instance and asset render.
 * No transaction spans two databases: reserve globally before dispatch, settle locally first.
 * A crash in either gap over-holds rather than undercounts. There is deliberately no release API.
 */
export class WebProviderBudget implements WebAttemptBudget {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  static initialize(path: string, history: BudgetHistory[]) {
    ensure(history.length > 0, 'WEB_SHARED_HISTORY_REQUIRED');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    ensure(realpathSync(dirname(path)) === dirname(path), 'WEB_SHARED_PATH_INVALID');
    const fd = openSync(path, 'wx', 0o600); closeSync(fd);
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE history(source TEXT,provider TEXT,digest TEXT NOT NULL,
        spent_micros INTEGER NOT NULL CHECK(spent_micros>=0),
        held_micros INTEGER NOT NULL CHECK(held_micros>=0), PRIMARY KEY(source,provider)) STRICT;
        CREATE TABLE calls(id TEXT PRIMARY KEY,provider TEXT NOT NULL CHECK(provider IN ('deepseek','fish')),
        fingerprint TEXT NOT NULL,held_micros INTEGER NOT NULL CHECK(held_micros>0),
        state TEXT NOT NULL CHECK(state IN ('sent','known')),charged_micros INTEGER,
        receipt_hash TEXT,audio BLOB,created_at INTEGER NOT NULL,settled_at INTEGER,
        CHECK((state='sent' AND charged_micros IS NULL AND receipt_hash IS NULL) OR
          (state='known' AND charged_micros>=0 AND charged_micros<=held_micros AND receipt_hash IS NOT NULL))) STRICT;`);
      for (const row of history) {
        ensure(['deepseek','fish'].includes(row.provider) && row.source.length > 0 &&
          /^[a-f0-9]{64}$/.test(row.digest) && amount(row.spentMicros) && amount(row.heldMicros),
        'WEB_SHARED_HISTORY_INVALID');
        db.prepare('INSERT INTO history VALUES (?,?,?,?,?)').run(row.source, row.provider,
          row.digest, row.spentMicros, row.heldMicros);
      }
      for (const provider of ['deepseek', 'fish']) {
        const row = db.prepare('SELECT SUM(spent_micros+held_micros) n FROM history WHERE provider=?')
          .get(provider) as { n: number | null };
        ensure(row.n !== null && row.n <= LIMIT, 'WEB_SHARED_BUDGET_EXHAUSTED');
      }
      db.exec('PRAGMA user_version=1; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  }
  constructor(path: string, clock: Clock) {
    ensure(resolve(path) === path && realpathSync(path) === path, 'WEB_SHARED_PATH_INVALID');
    const stat = lstatSync(path);
    ensure(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 &&
      (process.getuid?.() === undefined || stat.uid === process.getuid()), 'WEB_SHARED_PATH_INVALID');
    this.db = new DatabaseSync(path, { open: true }); this.clock = clock;
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
    ensure((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version === 1,
      'WEB_SHARED_SCHEMA_INVALID');
  }
  close() { this.db.close(); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  verifyHistory(history: BudgetHistory[]) {
    const expected = history.map(r => [r.source, r.provider, r.digest, r.spentMicros, r.heldMicros]);
    const actual = this.db.prepare('SELECT * FROM history ORDER BY source,provider').all()
      .map(r => [r.source, r.provider, r.digest, r.spent_micros, r.held_micros]);
    ensure(hash(expected.sort()) === hash(actual.sort()), 'WEB_SHARED_HISTORY_CHANGED');
  }
  summary() {
    return (['deepseek','fish'] as const).map(provider => {
      const history = this.db.prepare(`SELECT COALESCE(SUM(spent_micros),0) spent,
        COALESCE(SUM(held_micros),0) held FROM history WHERE provider=?`).get(provider)!;
      const calls = this.db.prepare(`SELECT COALESCE(SUM(charged_micros),0) spent,
        COALESCE(SUM(CASE WHEN state='sent' THEN held_micros ELSE 0 END),0) held,
        SUM(CASE WHEN state='sent' THEN 1 ELSE 0 END) unresolved FROM calls WHERE provider=?`).get(provider)!;
      const spentMicros = Number(history.spent) + Number(calls.spent);
      const heldMicros = Number(history.held) + Number(calls.held);
      return { provider, limitMicros: LIMIT, spentMicros, heldMicros,
        remainingMicros: LIMIT - spentMicros - heldMicros, unresolvedNewCalls: Number(calls.unresolved) };
    });
  }
  read(id: string, fingerprint: string) {
    const entry = this.db.prepare('SELECT * FROM calls WHERE id=?').get(id) as Entry | undefined;
    if (entry) ensure(entry.fingerprint === fingerprint, 'WEB_SHARED_REQUEST_CONFLICT');
    return entry;
  }
  /** Persist the possible-send boundary before any transport, including material rendering. */
  reserve(id: string, provider: Provider, fingerprint: string, heldMicros: number) {
    ensure(!id.startsWith('cloud-grant:'), 'WEB_SHARED_GRANT_RESERVED_ID');
    ensure(id.length > 0 && id.length <= 512 && /^[a-f0-9]{64}$/.test(fingerprint) &&
      ['deepseek','fish'].includes(provider) && amount(heldMicros) && heldMicros > 0,
    'WEB_SHARED_RESERVATION_INVALID');
    return this.transaction(() => {
      ensure(!this.read(id, fingerprint), 'WEB_SHARED_ATTEMPT_UNRESOLVED');
      ensure(this.summary().find(row => row.provider === provider)!.remainingMicros >= heldMicros,
        'WEB_SHARED_BUDGET_EXHAUSTED');
      this.db.prepare(`INSERT INTO calls(id,provider,fingerprint,held_micros,state,created_at)
        VALUES (?,?,?,?,'sent',?)`).run(id, provider, fingerprint, heldMicros, this.clock.now());
    });
  }
  settle(id: string, fingerprint: string, chargedMicros: number, receipt: unknown, audio?: Uint8Array) {
    ensure(!id.startsWith('cloud-grant:'), 'WEB_SHARED_GRANT_IMMUTABLE');
    ensure(amount(chargedMicros) && receipt !== undefined, 'WEB_SHARED_RECEIPT_INVALID');
    const receiptHash = hash(receipt);
    return this.transaction(() => {
      const prior = this.read(id, fingerprint);
      ensure(prior && chargedMicros <= prior.held_micros, 'WEB_SHARED_RECEIPT_INVALID');
      if (prior.state === 'known') {
        ensure(prior.charged_micros === chargedMicros && prior.receipt_hash === receiptHash &&
          hash(prior.audio ? Buffer.from(prior.audio) : null) === hash(audio ? Buffer.from(audio) : null),
        'WEB_SHARED_RECEIPT_CONFLICT');
        return;
      }
      this.db.prepare(`UPDATE calls SET state='known',charged_micros=?,receipt_hash=?,audio=?,settled_at=?
        WHERE id=? AND state='sent'`).run(chargedMicros, receiptHash, audio ?? null, this.clock.now(), id);
    });
  }
  /** Irrevocable local hold before cloud initialization. A lost response replays the same grant.
   * The grant is pinned to one DO ID; no refund/retarget/reset API exists in this version. */
  allocateCloud(id: string, target: CloudBudgetTarget, provider: Provider, micros: number): CloudBudgetGrant {
    validateCloudBudgetTarget(target);
    ensure(/^[A-Za-z0-9_-]{1,128}$/.test(id) && ['deepseek','fish'].includes(provider) &&
      amount(micros) && micros > 0, 'WEB_CLOUD_BUDGET_GRANT_INVALID');
    return this.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS cloud_grants(id TEXT PRIMARY KEY,manifest_json TEXT NOT NULL) STRICT');
      const callId = `cloud-grant:${id}`;
      const prior = this.db.prepare('SELECT manifest_json FROM cloud_grants WHERE id=?').get(id);
      if (prior) {
        const grant = JSON.parse(String(prior.manifest_json)) as CloudBudgetGrant;
        ensure(grant.provider === provider && grant.micros === micros && grant.accountId === target.accountId &&
          grant.namespaceId === target.namespaceId && grant.objectId === target.objectId, 'WEB_CLOUD_BUDGET_GRANT_CONFLICT');
        const entry = this.read(callId, hash(grant));
        ensure(entry?.state === 'sent' && entry.provider === provider && entry.held_micros === micros,
          'WEB_CLOUD_BUDGET_GRANT_CONFLICT');
        return grant;
      }
      const summary = this.summary().find(row => row.provider === provider)!;
      ensure(summary.remainingMicros >= micros, 'WEB_SHARED_BUDGET_EXHAUSTED');
      const grant: CloudBudgetGrant = { version: 1, id, accountId: target.accountId,
        namespaceId: target.namespaceId, objectId: target.objectId, provider, micros,
        priorSpentMicros: summary.spentMicros, priorHeldMicros: summary.heldMicros, createdAt: this.clock.now() };
      validateCloudBudgetGrant(grant);
      this.db.prepare(`INSERT INTO calls(id,provider,fingerprint,held_micros,state,created_at)
        VALUES (?,?,?,?,'sent',?)`).run(callId, provider, hash(grant), micros, grant.createdAt);
      this.db.prepare('INSERT INTO cloud_grants VALUES (?,?)').run(id, JSON.stringify(grant));
      return grant;
    });
  }
  beginAttempt(store: Store, key: AttemptKey) {
    const { row, id, fingerprint } = budgetAttempt(store, key);
    ensure(row.state === 'not_sent', 'WEB_SHARED_ATTEMPT_UNRESOLVED');
    this.reserve(id, row.provider, fingerprint, row.held_micros);
  }
  settleAttempt(store: Store, key: AttemptKey) {
    const { row, id, fingerprint } = budgetAttempt(store, key);
    ensure(row.state === 'known' && row.outcome !== 'not_dispatched', 'WEB_SHARED_RECEIPT_INVALID');
    this.settle(id, fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
  }
  /** Repair only local-known → shared-held gaps; never infer a receipt from a timeout. */
  recoverKnown(store: Store) {
    for (const key of store.all<{ operationId: string; phase: string; ordinal: number }>(
      `SELECT operation_id operationId,phase,ordinal FROM web_provider_attempts
       WHERE state='known' AND outcome IN ('succeeded','failed')`)) {
      const { id, fingerprint } = budgetAttempt(store, key);
      if (this.read(id, fingerprint)) this.settleAttempt(store, key);
    }
  }
}
