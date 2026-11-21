import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WriterChoice } from '../../../packages/contracts/web-writer.ts';

/**
 * Part 37a: the owner's switch 「回复写法：旧写法 / 新写法」 (Part 37b: and 新+档案). ONE row, default 旧 (v7). NO numbered migration (expected-migrations is untouched):
 * the table is installed idempotently at business-object start and checked against the digest of its statement. A mismatch stops the
 * start with WEB_WRITER_SCHEMA_MISMATCH. The row holds the choice, who set it and when: no content, no player data, no world id.
 * The request freezes the choice (`writer` in request_json), so a reply in flight finishes with the writer it started with.
 */
/**
 * Version 1 (Part 37a): 旧 / 新. Kept byte for byte: its digest is the first row of the schema table, forever.
 * Version 2 (Part 37b): the same table with 'v8p' (新+档案) allowed. SQLite cannot change a CHECK in place, so the step rebuilds the
 * table (rename, create, copy, drop) in ONE transaction and appends row 2 to the schema table (which is rebuilt to allow it). Any
 * other state (a foreign table, a changed digest, a missing row) stops the start with WEB_WRITER_SCHEMA_MISMATCH. NOT a numbered
 * migration: expected-migrations is untouched.
 */
const stepOne = `CREATE TABLE web_writer_setting(id INTEGER PRIMARY KEY CHECK(id=1),writer TEXT NOT NULL CHECK(writer IN ('v7','v8')),
    changed_by TEXT NOT NULL,changed_at INTEGER NOT NULL) STRICT`;
const stepTwo = `CREATE TABLE web_writer_setting(id INTEGER PRIMARY KEY CHECK(id=1),writer TEXT NOT NULL CHECK(writer IN ('v7','v8','v8p')),
    changed_by TEXT NOT NULL,changed_at INTEGER NOT NULL) STRICT`;
const schemaTwo =
  'CREATE TABLE web_writer_schema(version INTEGER PRIMARY KEY CHECK(version IN (1,2)),sha256 TEXT NOT NULL) STRICT';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digestOne = sha([stepOne].join(';\n'));
const digestTwo = sha([stepTwo].join(';\n'));

export function installWriterSetting(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_writer_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_writer_*'"), 'WEB_WRITER_SCHEMA_MISMATCH');
      store.run(stepTwo);
      store.run(schemaTwo);
      store.run('INSERT INTO web_writer_schema VALUES (1,?),(2,?)', digestOne, digestTwo);
    }
    const found = () =>
      store.all<{ version: number; sha256: string }>('SELECT * FROM web_writer_schema ORDER BY version');
    let rows = found();
    // An authority that ran step one only (Part 37a): take step two.
    if (rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digestOne) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name IN ('web_writer_setting_v1','web_writer_schema_v1')"),
        'WEB_WRITER_SCHEMA_MISMATCH',
      );
      store.run('ALTER TABLE web_writer_setting RENAME TO web_writer_setting_v1');
      store.run(stepTwo);
      store.run('INSERT INTO web_writer_setting SELECT id,writer,changed_by,changed_at FROM web_writer_setting_v1');
      store.run('DROP TABLE web_writer_setting_v1');
      store.run('ALTER TABLE web_writer_schema RENAME TO web_writer_schema_v1');
      store.run(schemaTwo);
      store.run('INSERT INTO web_writer_schema SELECT version,sha256 FROM web_writer_schema_v1');
      store.run('INSERT INTO web_writer_schema VALUES (2,?)', digestTwo);
      store.run('DROP TABLE web_writer_schema_v1');
      rows = found();
    }
    ensure(
      rows.length === 2 &&
        rows[0]!.version === 1 &&
        rows[0]!.sha256 === digestOne &&
        rows[1]!.version === 2 &&
        rows[1]!.sha256 === digestTwo,
      'WEB_WRITER_SCHEMA_MISMATCH',
    );
  });
}

/** The writer new replies freeze: 'v7' (旧) unless the owner chose the new one. A database without the table is always 'v7'. */
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
