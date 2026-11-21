import { createHash } from 'node:crypto';
import { CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 37c-1: where a cast document too big for its own row lives.
 *
 * Migration 129 (immutable) bounds `web_cast_draft.doc_json` and `web_cast_publications.doc_json` at 300,000 CHARACTERS. The 10x
 * library (stories 600, inside jokes 300, groups 600) can need up to CAST_LIMITS.docBytesMax = 1,900,000 UTF-8 BYTES, which is under
 * Cloudflare's 2 MiB limit for one Durable Object value but over that CHECK. So a document of up to 300,000 characters is stored
 * exactly as before (the same bytes in the same row: nothing a smaller cast has changes), and a bigger one is stored here, content
 * addressed by the sha256 of its canonical JSON, while its own row holds a short pointer:
 *
 *     {"largeDoc":{"digest":"<sha256>","bytes":<UTF-8 bytes>}}
 *
 * A read resolves the pointer and checks the digest (CAST_STORED_DOC_INVALID when it does not hold, as for any stored document).
 * NO numbered migration (expected-migrations is untouched): the table is a digest-checked runtime step installed at business-object
 * start. Any other state (a foreign `web_cast_doc*` table, a changed digest) stops the start with WEB_CAST_DOC_SCHEMA_MISMATCH.
 * Rows are immutable; one that neither the draft nor a publication points at is deleted when the draft is written.
 */
const statements = [
  `CREATE TABLE web_cast_docs(digest TEXT PRIMARY KEY CHECK(length(digest)=64),
    doc_json TEXT NOT NULL CHECK(json_valid(doc_json) AND length(CAST(doc_json AS BLOB))<=${CAST_LIMITS.docBytesMax}),
    created_at INTEGER NOT NULL CHECK(created_at>=0)) STRICT`,
  'CREATE TABLE web_cast_docs_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
  `CREATE TRIGGER web_cast_docs_no_update BEFORE UPDATE ON web_cast_docs
    BEGIN SELECT RAISE(ABORT,'WEB_CAST_DOC_IMMUTABLE'); END`,
];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = sha(statements.join(';\n'));
/** The CHECK of migration 129: what one row may hold inline, in characters. */
export const CAST_INLINE_MAX = 300_000;

export function installCastDocs(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_cast_docs_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_cast_doc*'"), 'WEB_CAST_DOC_SCHEMA_MISMATCH');
      for (const statement of statements) store.run(statement);
      store.run('INSERT INTO web_cast_docs_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_cast_docs_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_CAST_DOC_SCHEMA_MISMATCH');
    const names = store
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name GLOB 'web_cast_doc*' AND name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .map((row) => row.name);
    ensure(
      names.join(',') === 'web_cast_docs,web_cast_docs_no_update,web_cast_docs_schema',
      'WEB_CAST_DOC_SCHEMA_MISMATCH',
    );
  });
}

const POINTER = '{"largeDoc":';
const hasTable = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cast_docs'");

/** What goes into a row's `doc_json`: the document itself when it fits, else a pointer to its own row here. */
export function packCastDoc(store: Pick<BusinessStore, 'get' | 'run'>, now: number, json: string): string {
  if (json.length <= CAST_INLINE_MAX) return json;
  ensure(hasTable(store), 'CAST_DOC_STORE_UNAVAILABLE');
  const key = sha(json);
  store.run('INSERT OR IGNORE INTO web_cast_docs(digest,doc_json,created_at) VALUES (?,?,?)', key, json, now);
  return `${POINTER}${JSON.stringify({ digest: key, bytes: Buffer.byteLength(json) })}}`;
}

/** The document's JSON behind a row's `doc_json` (the same text when it is not a pointer). */
export function unpackCastDoc(store: Pick<BusinessStore, 'get'>, stored: string): string {
  if (!stored.startsWith(POINTER)) return stored;
  let pointer: { digest?: unknown; bytes?: unknown };
  try {
    pointer = (JSON.parse(stored) as { largeDoc: typeof pointer }).largeDoc;
  } catch {
    throw new Error('CAST_STORED_DOC_INVALID');
  }
  ensure(typeof pointer.digest === 'string' && hasTable(store), 'CAST_STORED_DOC_INVALID');
  const row = store.get<{ doc_json: string }>('SELECT doc_json FROM web_cast_docs WHERE digest=?', pointer.digest);
  ensure(
    row && sha(row.doc_json) === pointer.digest && Buffer.byteLength(row.doc_json) === pointer.bytes,
    'CAST_STORED_DOC_INVALID',
  );
  return row.doc_json;
}

/** Delete the rows no draft and no publication points at (called when the draft is written). */
export function pruneCastDocs(store: Pick<BusinessStore, 'get' | 'all' | 'run'>) {
  if (!hasTable(store)) return;
  const keep = new Set<string>();
  const rows = [
    ...store.all<{ doc_json: string }>('SELECT doc_json FROM web_cast_draft'),
    ...store.all<{ doc_json: string }>(`SELECT doc_json FROM web_cast_publications WHERE doc_json LIKE '${POINTER}%'`),
  ];
  for (const row of rows)
    if (row.doc_json.startsWith(POINTER))
      keep.add((JSON.parse(row.doc_json) as { largeDoc: { digest: string } }).largeDoc.digest);
  for (const { digest: key } of store.all<{ digest: string }>('SELECT digest FROM web_cast_docs'))
    if (!keep.has(key)) store.run('DELETE FROM web_cast_docs WHERE digest=?', key);
}
