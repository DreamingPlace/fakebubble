import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WriterChoice } from '../../../packages/contracts/web-writer.ts';

/**
 * Part 37a: the owner's switch 「回复写法：现行 / 新」. ONE row, default 现行 (v7). NO numbered migration (expected-migrations is untouched):
 * the table is installed idempotently at business-object start and checked against the digest of its statement. A mismatch stops the
 * start with WEB_WRITER_SCHEMA_MISMATCH. The row holds the choice, who set it and when: no content, no player data, no world id.
 * The request freezes the choice (`writer` in request_json), so a reply in flight finishes with the writer it started with.
 */
const statements = [
  `CREATE TABLE web_writer_setting(id INTEGER PRIMARY KEY CHECK(id=1),writer TEXT NOT NULL CHECK(writer IN ('v7','v8')),
    changed_by TEXT NOT NULL,changed_at INTEGER NOT NULL) STRICT`,
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');

export function installWriterSetting(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_writer_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_writer_*'"), 'WEB_WRITER_SCHEMA_MISMATCH');
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_writer_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_writer_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_writer_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_WRITER_SCHEMA_MISMATCH');
  });
}

/** The writer new replies freeze: 'v7' (现行) unless the owner chose the new one. A database without the table is always 'v7'. */
export function readWriter(store: Pick<BusinessStore, 'get'>): WriterChoice {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_writer_setting'")) return 'v7';
  return store.get<{ writer: WriterChoice }>('SELECT writer FROM web_writer_setting WHERE id=1')?.writer ?? 'v7';
}

export function writeWriter(store: Pick<BusinessStore, 'run'>, now: number, adminId: string, writer: WriterChoice) {
  store.run(
    `INSERT INTO web_writer_setting(id,writer,changed_by,changed_at) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET writer=excluded.writer,changed_by=excluded.changed_by,changed_at=excluded.changed_at`,
    writer,
    adminId,
    now,
  );
}
