import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { AVATAR_MAX_BYTES, normalizeAvatar } from '../../../packages/imaging/avatar.ts';
import { ImageError } from '../../../packages/imaging/png.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { publishedWebCharacters } from './web-character-catalog.ts';
import { identifier, keys, record } from './template-validation.ts';

/**
 * Part 31 (25e): one image per character. NO numbered migration: a digest-checked runtime step. STOP code:
 * WEB_AVATAR_SCHEMA_MISMATCH (a table of this step exists with other contents, or the stored digest differs).
 *
 *   web_character_avatars  one row per (character, picture). The picture is content-addressed (avatar_id = sha256 of the re-encoded
 *                          PNG), so its URL never changes meaning and may be cached for ever. The bytes live in R2 (through the business
 *                          object's private bucket) when the deployment has one, else in `bytes` (local Node server). The row says
 *                          nothing about the uploader's file name, camera, place or time: only what the re-encoded picture is.
 *                          state 'erase' = nobody refers to it any more; the alarm erases the R2 object and then the row.
 *
 * The business object is the only writer. An upload is decoded and re-encoded here (packages/imaging), so EXIF / GPS / ICC / text
 * never reach storage; nothing in this module calls a provider or touches money.
 */
const statements = [
  `CREATE TABLE web_character_avatars(character_id TEXT NOT NULL,avatar_id TEXT NOT NULL CHECK(length(avatar_id)=64),
    content_type TEXT NOT NULL CHECK(content_type='image/png'),width INTEGER NOT NULL CHECK(width>0),height INTEGER NOT NULL CHECK(height>0),
    byte_length INTEGER NOT NULL CHECK(byte_length>0),source TEXT NOT NULL CHECK(source IN ('png','jpeg','webp')),
    source_width INTEGER NOT NULL,source_height INTEGER NOT NULL,bytes BLOB,in_r2 INTEGER NOT NULL CHECK(in_r2 IN (0,1)),
    state TEXT NOT NULL CHECK(state IN ('live','erase')),created_at INTEGER NOT NULL,
    PRIMARY KEY(character_id,avatar_id),CHECK((in_r2=1 AND bytes IS NULL) OR (in_r2=0 AND bytes IS NOT NULL))) STRICT`,
  `CREATE INDEX web_character_avatars_id ON web_character_avatars(avatar_id)`,
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
export function installWebAvatars(store: WebRuntimeStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_avatar_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name IN ('web_character_avatars','web_character_avatars_id')"),
        'WEB_AVATAR_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_avatar_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_avatar_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_avatar_schema');
    ensure(rows.length === 1 && rows[0]!.sha256 === digest, 'WEB_AVATAR_SCHEMA_MISMATCH');
  });
}
export const avatarsInstalled = (store: Pick<WebRuntimeStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_avatar_schema'");

const AVATAR_ID = /^[a-f0-9]{64}$/;
export const isAvatarId = (value: unknown): value is string => typeof value === 'string' && AVATAR_ID.test(value);
/** The longest base64 text of a picture of AVATAR_MAX_BYTES, with a little slack for padding. */
const BASE64_MAX = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 8;
/** The request body: the base64 text and the JSON around it. */
export const AVATAR_BODY_LIMIT = BASE64_MAX + 1024;
/**
 * What a player's browser gets with a picture: the right type, no sniffing, no cookie, and a year of caching (the address is the
 * content's hash, so it can never mean anything else). The edge Worker sets the same cache value itself for this one verified path.
 */
export const avatarHeaders = (length: number) => ({
  'content-type': 'image/png',
  'content-length': String(length),
  'x-content-type-options': 'nosniff',
  'cache-control': 'public, max-age=31536000, immutable',
});

type Row = {
  character_id: string;
  avatar_id: string;
  width: number;
  height: number;
  byte_length: number;
  source: 'png' | 'jpeg' | 'webp';
  source_width: number;
  source_height: number;
  bytes: Uint8Array | null;
  in_r2: number;
  state: string;
};
export type AvatarInfo = {
  id: string;
  width: number;
  height: number;
  bytes: number;
  source: 'png' | 'jpeg' | 'webp';
  sourceWidth: number;
  sourceHeight: number;
};
const info = (row: Row): AvatarInfo => ({
  id: row.avatar_id,
  width: row.width,
  height: row.height,
  bytes: row.byte_length,
  source: row.source,
  sourceWidth: row.source_width,
  sourceHeight: row.source_height,
});

export class WebAvatars {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  constructor(store: WebRuntimeStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }
  private scope(characterId: string, avatarId: string) {
    return { instanceId: this.store.instanceId, ownerId: characterId, mediaId: avatarId, kind: 'avatar' as const };
  }

  /** The picture the page may show for this character: one that exists and has not been marked for erasure. */
  exists(characterId: string, avatarId: string) {
    return (
      avatarsInstalled(this.store) &&
      !!this.store.get(
        "SELECT 1 FROM web_character_avatars WHERE character_id=? AND avatar_id=? AND state='live'",
        characterId,
        avatarId,
      )
    );
  }
  info(characterId: string, avatarId: string): AvatarInfo | null {
    if (!avatarsInstalled(this.store)) return null;
    const row = this.store.get<Row>(
      "SELECT * FROM web_character_avatars WHERE character_id=? AND avatar_id=? AND state='live'",
      characterId,
      avatarId,
    );
    return row ? info(row) : null;
  }

  /**
   * Admin upload: base64 of the file as chosen (PNG, JPEG or WebP, at most 2 MB). The caller has checked the member's right to
   * edit this character and passes `authorize` again for the storage steps (the identity may have been revoked meanwhile).
   * The same picture uploaded twice is the same row.
   */
  async upload(characterId: string, memberId: string, input: unknown, authorize: () => void) {
    identifier(characterId);
    record(input);
    keys(input, ['base64']);
    ensure(
      typeof input.base64 === 'string' && input.base64.length > 0 && input.base64.length <= BASE64_MAX,
      'AVATAR_TOO_LARGE',
    );
    ensure(/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) && input.base64.length % 4 === 0, 'AVATAR_INVALID');
    ensure(avatarsInstalled(this.store), 'AVATAR_UNAVAILABLE');
    ensure(
      !this.store.get('SELECT 1 FROM web_character_deletions WHERE character_id=?', characterId),
      'CHARACTER_DELETED',
    );
    const bytes = Buffer.from(input.base64, 'base64');
    let picture;
    try {
      picture = normalizeAvatar(bytes);
    } catch (error) {
      throw new DomainError(error instanceof ImageError ? error.code : 'AVATAR_INVALID');
    }
    const inR2 = !!this.store.providerAudio;
    if (inR2) {
      const reference = await this.store.providerAudio!.stage(
        this.scope(characterId, picture.sha256),
        picture.png,
        async () => authorize(),
      );
      ensure(reference.sha256 === picture.sha256, 'MEDIA_INTEGRITY_ERROR');
    }
    authorize();
    const now = this.clock.now();
    this.store.transaction(() => {
      ensure(
        !this.store.get('SELECT 1 FROM web_character_deletions WHERE character_id=?', characterId),
        'CHARACTER_DELETED',
      );
      const held = this.store.get<{ state: string }>(
        'SELECT state FROM web_character_avatars WHERE character_id=? AND avatar_id=?',
        characterId,
        picture.sha256,
      );
      if (!held)
        this.store.run(
          `INSERT INTO web_character_avatars(character_id,avatar_id,content_type,width,height,byte_length,source,source_width,source_height,bytes,in_r2,state,created_at)
          VALUES (?,?,'image/png',?,?,?,?,?,?,?,?,'live',?)`,
          characterId,
          picture.sha256,
          picture.width,
          picture.height,
          picture.png.length,
          picture.source,
          picture.sourceWidth,
          picture.sourceHeight,
          inR2 ? null : picture.png,
          inR2 ? 1 : 0,
          now,
        );
      else
        this.store.run(
          "UPDATE web_character_avatars SET state='live' WHERE character_id=? AND avatar_id=?",
          characterId,
          picture.sha256,
        );
      // Pictures of this character that no draft or published version refers to (an earlier upload that was never saved) are done with.
      for (const other of this.store.all<{ avatar_id: string }>(
        "SELECT avatar_id FROM web_character_avatars WHERE character_id=? AND avatar_id<>? AND state='live'",
        characterId,
        picture.sha256,
      ))
        if (!this.referenced(characterId, other.avatar_id))
          this.store.run(
            "UPDATE web_character_avatars SET state='erase' WHERE character_id=? AND avatar_id=?",
            characterId,
            other.avatar_id,
          );
      this.store.run(
        'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
        memberId,
        'character-avatar-uploaded',
        characterId,
        now,
      );
    });
    return { avatar: this.info(characterId, picture.sha256)! };
  }

  /** True while a saved revision or a published version of the character names this picture. */
  private referenced(characterId: string, avatarId: string) {
    const needle = `"${avatarId}"`;
    return (
      !!this.store.get(
        'SELECT 1 FROM web_character_revisions WHERE character_id=? AND instr(profile_json,?)>0 LIMIT 1',
        characterId,
        needle,
      ) ||
      !!this.store.get(
        'SELECT 1 FROM web_character_versions WHERE character_id=? AND instr(profile_json,?)>0 LIMIT 1',
        characterId,
        needle,
      )
    );
  }

  private async bytesOf(row: Row, authorize: () => Promise<void>): Promise<Uint8Array> {
    if (row.in_r2 === 0) return row.bytes!;
    ensure(this.store.providerAudio, 'MEDIA_FILE_UNAVAILABLE');
    return new Uint8Array(
      await this.store.providerAudio.read(
        { ...this.scope(row.character_id, row.avatar_id), byteLength: row.byte_length, sha256: row.avatar_id },
        authorize,
      ),
    );
  }
  /** The admin's own view of a picture of the character (the draft's, which may not be published). */
  async readForAdmin(characterId: string, avatarId: string, authorize: () => void) {
    ensure(isAvatarId(avatarId) && avatarsInstalled(this.store), 'NOT_FOUND');
    const row = this.store.get<Row>(
      "SELECT * FROM web_character_avatars WHERE character_id=? AND avatar_id=? AND state='live'",
      characterId,
      avatarId,
    );
    ensure(row, 'NOT_FOUND');
    const bytes = await this.bytesOf(row, async () => authorize());
    return { contentType: 'image/png' as const, base64: Buffer.from(bytes).toString('base64') };
  }
  /**
   * The picture a PLAYER may fetch: only one the character's LIVE catalog entry names (an offline or unpublished picture is
   * NOT_FOUND). No identity is read or needed; the bytes are checked against their address before they are returned.
   */
  async readPublic(avatarId: string) {
    ensure(isAvatarId(avatarId) && avatarsInstalled(this.store), 'NOT_FOUND');
    const entry = publishedWebCharacters(this.store).find((c) => c.presentation.avatar?.id === avatarId);
    ensure(entry, 'NOT_FOUND');
    const row = this.store.get<Row>(
      "SELECT * FROM web_character_avatars WHERE character_id=? AND avatar_id=? AND state='live'",
      entry.characterId,
      avatarId,
    );
    ensure(row, 'NOT_FOUND');
    const bytes = await this.bytesOf(row, async () => {
      ensure(this.exists(row.character_id, row.avatar_id), 'NOT_FOUND');
    });
    ensure(
      createHash('sha256').update(bytes).digest('hex') === avatarId && bytes.length === row.byte_length,
      'MEDIA_INTEGRITY_ERROR',
    );
    return { bytes, contentType: 'image/png' as const };
  }

  /** Character deletion (inside its transaction): local pictures go now, R2 ones are marked for the alarm. */
  purgeCharacter(characterId: string) {
    purgeAvatars(this.store, characterId);
  }
  /** Erases the R2 objects of every picture marked 'erase' and then its row. Idempotent; a failure is retried by the next sweep. */
  async sweep(limit = 4) {
    if (!avatarsInstalled(this.store)) return 0;
    const rows = this.store.all<Row>("SELECT * FROM web_character_avatars WHERE state='erase' LIMIT ?", limit);
    for (const row of rows) {
      if (row.in_r2 === 1 && this.store.providerAudio)
        await this.store.providerAudio.erase(
          { ...this.scope(row.character_id, row.avatar_id), byteLength: row.byte_length, sha256: row.avatar_id },
          async () => {
            ensure(
              this.store.get(
                "SELECT 1 FROM web_character_avatars WHERE character_id=? AND avatar_id=? AND state='erase'",
                row.character_id,
                row.avatar_id,
              ),
              'MEDIA_INTEGRITY_ERROR',
            );
          },
        );
      this.store.run(
        'DELETE FROM web_character_avatars WHERE character_id=? AND avatar_id=?',
        row.character_id,
        row.avatar_id,
      );
    }
    return rows.length;
  }
  pending() {
    return (
      avatarsInstalled(this.store) &&
      !!this.store.get("SELECT 1 FROM web_character_avatars WHERE state='erase' LIMIT 1")
    );
  }
}

/** Retention for a deleted character: local bytes are deleted, R2 objects are marked so the alarm erases them. No picture outlives its character. */
export function purgeAvatars(store: Pick<WebRuntimeStore, 'get' | 'run'>, characterId: string) {
  if (!avatarsInstalled(store)) return;
  store.run('DELETE FROM web_character_avatars WHERE character_id=? AND in_r2=0', characterId);
  store.run("UPDATE web_character_avatars SET state='erase' WHERE character_id=?", characterId);
}
