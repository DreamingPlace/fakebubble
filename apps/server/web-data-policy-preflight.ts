import { createHash } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import type { WebStore } from './store.ts';
import { readLocalConfig } from './web-local-config.ts';

const TWO_HOURS = 2 * 60 * 60_000;
const terminal = new Set(['published', 'cancelled', 'failed']);
const safe = (value: number) => Number.isSafeInteger(value) && value >= 0;

type Window = { id: string; ip_hash: string; starts_at: number; expires_at: number; used: number; reserved: number };
type Principal = {
  id: string;
  player_id: string;
  world_id: string;
  kind: string;
  trial_used: number;
  trial_reserved: number;
  trial_character_id: string | null;
};
type Operation = {
  id: string;
  principal_id: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
  ip_window_id: string | null;
  metering_type: string;
  quota_state: string;
  status: string;
  created_at: number;
  deadline_at: number;
  request_id: string;
  payload_hash: string;
};
type Attempt = {
  operation_id: string;
  stage: string;
  phase: string;
  ordinal: number;
  provider: string;
  provider_request_id: string;
  dispatch_state: string;
  outcome: string | null;
  stage_version: number;
  lease_epoch: number;
  lease_token: string;
  principal_id: string;
  world_id: string;
  conversation_id: string;
  input_message_id: string;
  created_at: number;
  sent_at: number | null;
  settled_at: number | null;
  receipt_json: string | null;
  usage_json: string | null;
};
type Budget = { provider: string; stage: string; phase: string; capacity: number; reserved: number };
type Publication = {
  operation_id: string;
  principal_id: string;
  player_id: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
};

/** Fixture evidence is explicitly synthetic; only runtime-config reads a validated private config. */
export type DataPolicyKeySource =
  | { kind: 'runtime-config' }
  | { kind: 'synthetic-fixture'; instanceId: string; recoveryEpoch: string; fingerprint: string };
export type DataPolicyPreflight = {
  sourceSchema: number;
  instanceId: string;
  recoveryEpoch: string;
  observedAt: number;
  keySource: 'runtime-config' | 'synthetic-fixture' | 'unverified';
  keyFingerprint: string | null;
  sourceDigest: string | null;
  consistent: boolean;
  migrationAuthorized: false;
  historicalKeyLineageProven: false;
  reasons: string[];
  quotas: { ipHash: string; windowIds: string[]; usedTotal: number; reservedTotal: number; overLimit: boolean }[];
  retention: {
    principalId: string;
    kind: string;
    firstTrialAcceptedAt: number | null;
    expiresAt: number | null;
    protectedByUpgrade: boolean;
  }[];
  unknownExternalAttempts: number;
};

/** A dry-run snapshot, not a permit to migrate or clean content. Never writes the business DB. */
export function preflightWebDataPolicy(
  store: WebStore,
  clock: Clock,
  source: DataPolicyKeySource | null,
): DataPolicyPreflight {
  if (store.db.isTransaction) throw new Error('WEB_DATA_PREFLIGHT_TRANSACTION_ACTIVE');
  return scanWebDataPolicy(store, clock, source, false);
}

/** For an explicit migration already holding the SQLite write transaction. */
export function preflightWebDataPolicyInTransaction(
  store: WebStore,
  clock: Clock,
  source: DataPolicyKeySource | null,
): DataPolicyPreflight {
  if (!store.db.isTransaction) throw new Error('WEB_DATA_PREFLIGHT_TRANSACTION_REQUIRED');
  return scanWebDataPolicy(store, clock, source, true);
}

function scanWebDataPolicy(
  store: WebStore,
  clock: Clock,
  source: DataPolicyKeySource | null,
  withinTransaction: boolean,
): DataPolicyPreflight {
  const now = clock.now();
  if (!safe(now) || now > Number.MAX_SAFE_INTEGER - TWO_HOURS) throw new Error('WEB_DATA_PREFLIGHT_CLOCK_INVALID');
  const result: DataPolicyPreflight = {
    sourceSchema: -1,
    instanceId: store.instanceId,
    recoveryEpoch: '',
    observedAt: now,
    keySource: 'unverified',
    keyFingerprint: null,
    sourceDigest: null,
    consistent: false,
    migrationAuthorized: false,
    historicalKeyLineageProven: false,
    reasons: [],
    quotas: [],
    retention: [],
    unknownExternalAttempts: 0,
  };
  const fail = (code: string) => {
    if (!result.reasons.includes(code)) result.reasons.push(code);
  };
  if (!withinTransaction) store.db.exec('BEGIN');
  try {
    const db = store.db;
    result.sourceSchema = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const instance = db.prepare('SELECT instance_id,recovery_epoch FROM web_instance WHERE singleton=1').get() as
      | { instance_id: string; recovery_epoch: string }
      | undefined;
    result.recoveryEpoch = instance?.recovery_epoch ?? '';
    if (result.sourceSchema !== 109) fail('SCHEMA_NOT_109');
    if (
      instance?.instance_id !== store.instanceId ||
      !instance.recovery_epoch ||
      instance.recovery_epoch === 'uninitialized'
    )
      fail('INSTANCE_SCOPE_INVALID');
    if (source?.kind === 'runtime-config') {
      try {
        const config = readLocalConfig(store.root);
        if (config.instanceId !== store.instanceId || config.recoveryEpoch !== result.recoveryEpoch)
          fail('KEY_BINDING_MISMATCH');
        else {
          result.keySource = 'runtime-config';
          result.keyFingerprint = createHash('sha256').update(Buffer.from(config.ipKey, 'base64url')).digest('hex');
        }
      } catch {
        fail('KEY_SOURCE_UNVERIFIED');
      }
    } else if (
      source?.kind === 'synthetic-fixture' &&
      source.instanceId === store.instanceId &&
      source.recoveryEpoch === result.recoveryEpoch &&
      /^[a-f0-9]{64}$/.test(source.fingerprint)
    ) {
      result.keySource = 'synthetic-fixture';
      result.keyFingerprint = source.fingerprint;
    } else fail('KEY_SOURCE_UNVERIFIED');
    if (
      result.sourceSchema !== 109 ||
      result.keySource === 'unverified' ||
      result.reasons.includes('KEY_BINDING_MISMATCH')
    )
      return result;
    for (const table of [
      'web_ip_windows',
      'web_principals',
      'web_operations',
      'web_external_attempts',
      'web_external_budgets',
      'web_publications',
      'web_accounts',
      'worlds',
      'conversations',
      'messages',
    ]) {
      const count = (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
      if (!safe(count) || count > 100_000) fail('SNAPSHOT_TOO_LARGE');
    }
    if (result.reasons.includes('SNAPSHOT_TOO_LARGE')) return result;

    const windows = db.prepare('SELECT * FROM web_ip_windows ORDER BY ip_hash,starts_at,id').all() as Window[];
    const principals = db.prepare('SELECT * FROM web_principals ORDER BY id').all() as Principal[];
    const operations = db
      .prepare(`SELECT id,principal_id,world_id,conversation_id,character_id,input_message_id,
      ip_window_id,metering_type,quota_state,status,created_at,deadline_at,request_id,payload_hash
      FROM web_operations ORDER BY id`)
      .all() as Operation[];
    const attempts = db
      .prepare(`SELECT * FROM web_external_attempts
      ORDER BY operation_id,stage,phase,ordinal`)
      .all() as Attempt[];
    const budgets = db
      .prepare(`SELECT * FROM web_external_budgets
      ORDER BY provider,stage,phase`)
      .all() as Budget[];
    const publicationRows = db
      .prepare(`SELECT operation_id,principal_id,player_id,world_id,conversation_id,
      character_id,input_message_id FROM web_publications ORDER BY operation_id`)
      .all() as Publication[];
    const publications = new Set(publicationRows.map((row) => row.operation_id));
    const ownerRows = db.prepare('SELECT id,owner_id FROM worlds ORDER BY id').all() as {
      id: string;
      owner_id: string;
    }[];
    const accountRows = db.prepare('SELECT principal_id,active FROM web_accounts ORDER BY principal_id').all() as {
      principal_id: string;
      active: number;
    }[];
    const conversationRows = db
      .prepare(`SELECT world_id,id,kind,private_character_id FROM conversations
      ORDER BY world_id,id`)
      .all() as { world_id: string; id: string; kind: string; private_character_id: string | null }[];
    const messageRows = db
      .prepare(`SELECT id,world_id,conversation_id,author_kind,author_id,
      created_at,request_id,request_hash FROM messages
      ORDER BY id`)
      .all() as {
      id: string;
      world_id: string;
      conversation_id: string;
      author_kind: string;
      author_id: string;
      created_at: number;
      request_id: string | null;
      request_hash: string | null;
    }[];
    const owners = new Map(ownerRows.map((row) => [row.id, row.owner_id]));
    const accounts = new Map(accountRows.map((row) => [row.principal_id, row.active]));
    const conversations = new Map(conversationRows.map((row) => [`${row.world_id}\0${row.id}`, row]));
    const messages = new Map(messageRows.map((row) => [row.id, row]));
    const byWindow = new Map(windows.map((row) => [row.id, row]));
    const byPrincipal = new Map(principals.map((row) => [row.id, row]));
    const byOperation = new Map(operations.map((row) => [row.id, row]));
    const ipTotals = new Map<string, { ids: string[]; used: number; reserved: number }>();
    const windowCounts = new Map<string, { used: number; reserved: number }>();
    const principalCounts = new Map<string, { used: number; reserved: number; first: number | null; trials: number }>();
    for (const w of windows) {
      if (
        !/^[a-f0-9]{64}$/.test(w.ip_hash) ||
        !safe(w.starts_at) ||
        !safe(w.expires_at) ||
        w.expires_at <= w.starts_at ||
        !safe(w.used) ||
        !safe(w.reserved)
      )
        fail('WINDOW_INVALID');
      const total = ipTotals.get(w.ip_hash) ?? { ids: [], used: 0, reserved: 0 };
      total.ids.push(w.id);
      total.used += w.used;
      total.reserved += w.reserved;
      if (!safe(total.used) || !safe(total.reserved) || !safe(total.used + total.reserved)) fail('QUOTA_OVERFLOW');
      ipTotals.set(w.ip_hash, total);
      windowCounts.set(w.id, { used: 0, reserved: 0 });
    }
    for (const p of principals) {
      if (owners.get(p.world_id) !== p.player_id || !safe(p.trial_used) || !safe(p.trial_reserved))
        fail('PRINCIPAL_SCOPE_OR_COUNT_INVALID');
      if (p.kind === 'account' ? !accounts.has(p.id) : p.kind === 'guest' ? accounts.has(p.id) : true)
        fail('PRINCIPAL_ENTITLEMENT_INVALID');
      principalCounts.set(p.id, { used: 0, reserved: 0, first: null, trials: 0 });
    }
    for (const op of operations) {
      const principal = byPrincipal.get(op.principal_id),
        counts = principalCounts.get(op.principal_id);
      const conversation = conversations.get(`${op.world_id}\0${op.conversation_id}`);
      const input = messages.get(op.input_message_id);
      if (
        !principal ||
        !counts ||
        principal.world_id !== op.world_id ||
        conversation?.kind !== 'private' ||
        conversation.private_character_id !== op.character_id ||
        input?.world_id !== op.world_id ||
        input.conversation_id !== op.conversation_id ||
        input.author_kind !== 'player' ||
        input.author_id !== principal.player_id ||
        input.created_at !== op.created_at ||
        input.request_id !== op.request_id ||
        input.request_hash !== op.payload_hash
      )
        fail('OPERATION_SCOPE_INVALID');
      if (
        !safe(op.created_at) ||
        !safe(op.deadline_at) ||
        op.created_at > now ||
        op.deadline_at <= op.created_at ||
        op.deadline_at > Number.MAX_SAFE_INTEGER
      )
        fail('OPERATION_TIME_INVALID');
      if (
        op.status === 'published'
          ? op.quota_state !== 'used' || !publications.has(op.id)
          : terminal.has(op.status)
            ? op.quota_state !== 'released' || publications.has(op.id)
            : op.quota_state !== 'reserved' || publications.has(op.id)
      )
        fail('OPERATION_STATE_INVALID');
      if (op.metering_type === 'trial') {
        const window = op.ip_window_id ? byWindow.get(op.ip_window_id) : undefined;
        const wcount = op.ip_window_id ? windowCounts.get(op.ip_window_id) : undefined;
        if (!window || !wcount || !counts) {
          fail('TRIAL_WINDOW_OR_HISTORY_MISSING');
          continue;
        }
        if (
          op.created_at < window.starts_at ||
          op.created_at >= window.expires_at ||
          principal?.trial_character_id !== op.character_id
        )
          fail('TRIAL_SCOPE_INVALID');
        if (op.quota_state === 'used') {
          wcount.used++;
          counts.used++;
        }
        if (op.quota_state === 'reserved') {
          wcount.reserved++;
          counts.reserved++;
        }
        counts.trials++;
        if (safe(op.created_at) && (counts.first === null || op.created_at < counts.first))
          counts.first = op.created_at;
      } else if (op.metering_type !== 'entitled' || op.ip_window_id !== null || principal?.kind === 'guest')
        fail('METERING_OR_ENTITLEMENT_INVALID');
    }
    for (const w of windows) {
      const count = windowCounts.get(w.id)!;
      if (w.used !== count.used || w.reserved !== count.reserved) fail('WINDOW_COUNTER_MISMATCH');
    }
    for (const p of principals) {
      const counts = principalCounts.get(p.id)!;
      if (
        p.trial_used !== counts.used ||
        p.trial_reserved !== counts.reserved ||
        (counts.trials === 0 && p.trial_character_id !== null)
      )
        fail('PRINCIPAL_HISTORY_MISMATCH');
      const start = counts.first,
        expiry = start === null ? null : start + TWO_HOURS;
      if (expiry !== null && !safe(expiry)) fail('RETENTION_OVERFLOW');
      result.retention.push({
        principalId: p.id,
        kind: p.kind,
        firstTrialAcceptedAt: start,
        expiresAt: expiry,
        protectedByUpgrade: p.kind !== 'guest',
      });
    }
    const budgetKey = (provider: string, stage: string, phase: string) => `${provider}\0${stage}\0${phase}`;
    const budgetCounts = new Map(budgets.map((row) => [budgetKey(row.provider, row.stage, row.phase), 0]));
    for (const attempt of attempts) {
      const op = byOperation.get(attempt.operation_id);
      if (
        !op ||
        attempt.principal_id !== op.principal_id ||
        attempt.world_id !== op.world_id ||
        attempt.conversation_id !== op.conversation_id ||
        attempt.input_message_id !== op.input_message_id
      )
        fail('ATTEMPT_SCOPE_INVALID');
      const key = budgetKey(attempt.provider, attempt.stage, attempt.phase);
      if (!budgetCounts.has(key)) fail('ATTEMPT_BUDGET_MISSING');
      if (
        (attempt.stage === 'text'
          ? !['draft', 'review'].includes(attempt.phase) || attempt.ordinal !== -1
          : attempt.stage !== 'audio' || attempt.phase !== 'speech' || !safe(attempt.ordinal)) ||
        !attempt.provider ||
        !attempt.provider_request_id ||
        !safe(attempt.stage_version) ||
        !safe(attempt.lease_epoch) ||
        !attempt.lease_token ||
        !safe(attempt.created_at) ||
        attempt.created_at > now ||
        (attempt.sent_at !== null &&
          (!safe(attempt.sent_at) || attempt.sent_at < attempt.created_at || attempt.sent_at > now)) ||
        (attempt.settled_at !== null &&
          (!safe(attempt.settled_at) || attempt.settled_at < attempt.created_at || attempt.settled_at > now)) ||
        (attempt.dispatch_state === 'not_sent'
          ? attempt.sent_at !== null ||
            attempt.settled_at !== null ||
            attempt.outcome !== null ||
            attempt.receipt_json !== null ||
            attempt.usage_json !== null
          : attempt.dispatch_state === 'sent' || attempt.dispatch_state === 'unknown'
            ? attempt.sent_at === null ||
              attempt.settled_at !== null ||
              attempt.outcome !== null ||
              attempt.receipt_json !== null ||
              attempt.usage_json !== null
            : attempt.dispatch_state === 'known'
              ? attempt.settled_at === null ||
                !['succeeded', 'failed', 'not_dispatched'].includes(attempt.outcome ?? '') ||
                (attempt.outcome === 'not_dispatched'
                  ? attempt.sent_at !== null || attempt.receipt_json !== null || attempt.usage_json !== null
                  : attempt.sent_at === null ||
                    attempt.sent_at > attempt.settled_at ||
                    attempt.receipt_json === null ||
                    attempt.usage_json === null)
              : true)
      )
        fail('ATTEMPT_STATE_INVALID');
      if (attempt.dispatch_state !== 'known' && budgetCounts.has(key))
        budgetCounts.set(key, budgetCounts.get(key)! + 1);
      if (attempt.dispatch_state === 'unknown') result.unknownExternalAttempts++;
    }
    for (const budget of budgets) {
      const key = budgetKey(budget.provider, budget.stage, budget.phase);
      if (
        !budget.provider ||
        (budget.stage === 'text'
          ? !['draft', 'review'].includes(budget.phase)
          : budget.stage !== 'audio' || budget.phase !== 'speech') ||
        !safe(budget.capacity) ||
        budget.capacity === 0 ||
        !safe(budget.reserved) ||
        budget.reserved > budget.capacity
      )
        fail('EXTERNAL_BUDGET_INVALID');
      if (budget.reserved !== budgetCounts.get(key)) fail('EXTERNAL_BUDGET_MISMATCH');
    }
    for (const publication of publicationRows) {
      const op = byOperation.get(publication.operation_id),
        principal = op && byPrincipal.get(op.principal_id);
      if (
        !op ||
        op.status !== 'published' ||
        !principal ||
        publication.principal_id !== op.principal_id ||
        publication.player_id !== principal.player_id ||
        publication.world_id !== op.world_id ||
        publication.conversation_id !== op.conversation_id ||
        publication.character_id !== op.character_id ||
        publication.input_message_id !== op.input_message_id
      )
        fail('PUBLICATION_HISTORY_INVALID');
    }
    for (const [ipHash, total] of [...ipTotals].sort(([a], [b]) => a.localeCompare(b)))
      result.quotas.push({
        ipHash,
        windowIds: total.ids,
        usedTotal: total.used,
        reservedTotal: total.reserved,
        overLimit: total.used + total.reserved > 3,
      });
    result.sourceDigest = createHash('sha256')
      .update(
        JSON.stringify({
          version: 109,
          instance: instance?.instance_id,
          epoch: instance?.recovery_epoch,
          windows,
          principals,
          operations,
          attempts,
          budgets,
          publications: publicationRows,
          owners: ownerRows,
          accounts: accountRows,
          conversations: conversationRows,
          messages: messageRows,
        }),
      )
      .digest('hex');
    result.consistent = result.reasons.length === 0;
    return result;
  } catch {
    fail('SNAPSHOT_READ_FAILED');
    result.consistent = false;
    result.sourceDigest = null;
    return result;
  } finally {
    if (!withinTransaction && store.db.isTransaction) store.db.exec('ROLLBACK');
  }
}
