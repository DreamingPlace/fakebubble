import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 54: 「未确认的调用」. A provider call whose result is not known (the request may have been sent and nothing was seen
 * coming back) keeps its money HELD, is never retried and is never released automatically. This module lets the OWNER settle one
 * after checking the provider's bill: at the held amount, or at a lower amount he reads from the bill. Nothing here runs by itself.
 *
 * Installed by an idempotent, digest-checked runtime step (like the clip-takes tables): no numbered migration, `expected-migrations`
 * is unchanged. STOP code: WEB_UNKNOWN_CALLS_SCHEMA_MISMATCH.
 *
 *  - web_unknown_codes: why a call became UNKNOWN (a fixed upper-case code, never content), noted when it happens.
 *  - web_unknown_resolutions: one immutable row per settlement (the short code, held and settled micros, who, when). Never an id,
 *    an email, a nickname, an IP hash or message content.
 */
const statements = [
  `CREATE TABLE web_unknown_codes(ref TEXT PRIMARY KEY CHECK(length(ref)=10),code TEXT NOT NULL CHECK(code GLOB '[A-Z]*' AND length(code)<=64),
    noted_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_unknown_resolutions(ref TEXT PRIMARY KEY CHECK(length(ref)=10),held_micros INTEGER NOT NULL CHECK(held_micros>0),
    settled_micros INTEGER NOT NULL CHECK(settled_micros>=0 AND settled_micros<=held_micros),
    member_id TEXT NOT NULL,resolved_at INTEGER NOT NULL) STRICT`,
  `CREATE TRIGGER web_unknown_resolutions_no_update BEFORE UPDATE ON web_unknown_resolutions
    BEGIN SELECT RAISE(ABORT,'WEB_UNKNOWN_RESOLUTION_IMMUTABLE'); END`,
  `CREATE TRIGGER web_unknown_resolutions_no_delete BEFORE DELETE ON web_unknown_resolutions
    BEGIN SELECT RAISE(ABORT,'WEB_UNKNOWN_RESOLUTION_IMMUTABLE'); END`,
];

export function installWebUnknownCalls(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_unknown_calls_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_unknown_*'"),
        'WEB_UNKNOWN_CALLS_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_unknown_calls_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_unknown_calls_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_unknown_calls_schema');
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest,
      'WEB_UNKNOWN_CALLS_SCHEMA_MISMATCH',
    );
  });
}
export const webUnknownCallsInstalled = (store: BusinessStore) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_unknown_calls_schema'");

/** A short code the owner can read out loud: derived from the call's key by a one-way hash, it identifies nothing outside this database. */
export const unknownCallRef = (key: { operationId: string; phase: string; ordinal: number }) =>
  createHash('sha256')
    .update(`unknown-call:${key.operationId}:${key.phase}:${key.ordinal}`)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();
/** `U-XXXXX-XXXXX`: what the page shows and what the owner types back. */
export const unknownCallCode = (ref: string) => `U-${ref.slice(0, 5)}-${ref.slice(5)}`;
export const parseUnknownCallCode = (code: unknown) => {
  const match = typeof code === 'string' ? /^U-([0-9A-F]{5})-([0-9A-F]{5})$/.exec(code) : null;
  ensure(match, 'INVALID_REQUEST');
  return match[1]! + match[2]!;
};

/** Called when a call becomes UNKNOWN; a fixed code only. Never throws (it is a note, not part of the money path). */
export function noteUnknownCode(
  store: BusinessStore,
  key: { operationId: string; phase: string; ordinal: number },
  code: string,
  now: number,
) {
  try {
    if (!webUnknownCallsInstalled(store) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return;
    store.run(
      'INSERT OR IGNORE INTO web_unknown_codes(ref,code,noted_at) VALUES (?,?,?)',
      unknownCallRef(key),
      code,
      now,
    );
  } catch {
    /* a note */
  }
}

export type { UnknownCallRow, UnknownCallsView } from '../../../packages/contracts/web-system.ts';
import type { UnknownCallRow, UnknownCallsView } from '../../../packages/contracts/web-system.ts';
type Attempt = {
  operation_id: string;
  phase: 'draft' | 'review' | 'speech';
  ordinal: number;
  provider: string;
  model: string;
  held_micros: number;
  sent_at: number;
};
const has = (store: BusinessStore, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

export function unknownAttempts(store: BusinessStore): Attempt[] {
  if (!has(store, 'web_provider_attempts')) return [];
  return store.all<Attempt>(
    `SELECT operation_id,phase,ordinal,provider,model,held_micros,sent_at FROM web_provider_attempts
    WHERE state='unknown' ORDER BY sent_at,operation_id,phase,ordinal`,
  );
}

export function readUnknownCalls(store: BusinessStore, now: number): UnknownCallsView {
  const codes = webUnknownCallsInstalled(store)
    ? new Map(
        store.all<{ ref: string; code: string }>('SELECT ref,code FROM web_unknown_codes').map((r) => [r.ref, r.code]),
      )
    : new Map<string, string>();
  const calls = unknownAttempts(store).map((a): UnknownCallRow => {
    const ref = unknownCallRef({ operationId: a.operation_id, phase: a.phase, ordinal: a.ordinal });
    return {
      code: unknownCallCode(ref),
      provider: a.provider,
      model: a.model,
      stage: a.phase,
      heldMicros: a.held_micros,
      ageMs: Math.max(0, now - a.sent_at),
      errorCode: codes.get(ref) ?? 'NOT_RECORDED',
    };
  });
  return {
    calls,
    other: {
      embed: has(store, 'web_embed_attempts')
        ? (store.get<{ n: number }>("SELECT count(*) n FROM web_embed_attempts WHERE state='unknown'")?.n ?? 0)
        : 0,
    },
    resolved: webUnknownCallsInstalled(store)
      ? (store.get<{ n: number }>('SELECT count(*) n FROM web_unknown_resolutions')?.n ?? 0)
      : 0,
  };
}

/** The attempt a short code names, or null. The code is derived, so it is looked up among the UNKNOWN calls only. */
export function findUnknownAttempt(store: BusinessStore, ref: string) {
  return (
    unknownAttempts(store).find(
      (a) => unknownCallRef({ operationId: a.operation_id, phase: a.phase, ordinal: a.ordinal }) === ref,
    ) ?? null
  );
}
