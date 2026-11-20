import { createHash, createHmac } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { requireWebContent } from '../admission/web-retention.ts';
import { webBroadcastInstalled } from '../broadcast/web-broadcast-schema.ts';
import { broadcastAudio } from '../broadcast/web-broadcast-read.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import type { WebVerticalPublisher } from '../conversation/web-vertical-publisher.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { SHARE_TTL_MS, webShareInstalled } from './web-share-schema.ts';

/**
 * Part 45: a character's voice message as a link anyone can open for one day.
 *
 * What may be shared: a character's own voice message in the CALLER'S OWN conversation: a reply's narrative voice (origin
 * 'narrative' with its audio) and a broadcast voice message (Part 42). Not shareable, and each answers NOT_FOUND exactly like a
 * message that is not the caller's: the player's own messages, text-only messages (a reply delivered as text), the trial footer voice
 * (a system notice, not the character's words) and the welcome clip (a catalog clip shown on the card, not a message of the
 * conversation: it has no message row, and it is already public).
 *
 * The token is 24 random-looking bytes (192 bits, base64url): HMAC-SHA256 under a server secret over (principal, request id). Deriving
 * it makes a repeat of the same request id answer the same link without keeping the token itself; only its SHA-256 is stored. It is
 * unguessable without the secret and different for every (player, request).
 *
 * The public answer carries the CHARACTER's published card fields and the voice's length: no field names the sharer, and nothing in
 * the URL or the audio URL is anything but the token.
 */
export const SHARE_LIVE_LIMIT = 100;
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{32}$/;
export interface SharePrincipal {
  principalId: string;
  player_id: string;
  world_id: string;
}
export interface PublicShareCharacter {
  characterId: string;
  displayName: string;
  portraitUrl: string | null;
  mainColor: string | null;
  palette: { hex: string; role: 'main' | 'accent' }[] | null;
  birthDate: string | null;
}
export interface PublicShare {
  characterId: string;
  displayName: string;
  portraitUrl: string | null;
  mainColor: string | null;
  palette: { hex: string; role: 'main' | 'accent' }[] | null;
  birthDate: string | null;
  /** The number printed on the card when the character has no birthday: its place among the catalog's characters. */
  noRank: number;
  durationMs: number | null;
  voiceUrl: string;
}
interface ShareRow {
  token_hash: string;
  world_id: string;
  conversation_id: string;
  message_id: string;
  media_id: string;
  character_id: string;
  kind: 'reply' | 'broadcast';
  expires_at: number;
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export class WebShare {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  private readonly tokenKey: Buffer;
  private readonly publisher: Pick<WebVerticalPublisher, 'readPublishedAudioAsync'>;
  /** The catalog's published characters (public card fields), in catalog order. */
  private readonly catalog: () => PublicShareCharacter[];
  private readonly apiBase: string;
  constructor(
    store: WebRuntimeStore,
    clock: Clock,
    tokenKey: Buffer,
    publisher: Pick<WebVerticalPublisher, 'readPublishedAudioAsync'>,
    catalog: () => PublicShareCharacter[],
    apiBase: string,
  ) {
    this.store = store;
    this.clock = clock;
    this.tokenKey = tokenKey;
    this.publisher = publisher;
    this.catalog = catalog;
    this.apiBase = apiBase;
  }

  private tokenFor(principalId: string, requestId: string) {
    return createHmac('sha256', this.tokenKey)
      .update(`${principalId}\n${requestId}`)
      .digest()
      .subarray(0, 24)
      .toString('base64url');
  }

  /** Counters never name anyone: created, opened, and links that passed their day (swept ones plus the ones waiting to be swept). */
  stats() {
    if (!webShareInstalled(this.store)) return { created: 0, opened: 0, expired: 0, active: 0 };
    const counts = Object.fromEntries(
      this.store
        .all<{ name: string; n: number }>('SELECT name,n FROM web_share_counts')
        .map((row) => [row.name, row.n]),
    );
    const now = this.clock.now();
    const late = this.store.get<{ n: number }>('SELECT count(*) n FROM web_shares WHERE expires_at<=?', now)!.n;
    const live = this.store.get<{ n: number }>('SELECT count(*) n FROM web_shares WHERE expires_at>?', now)!.n;
    return {
      created: counts.created ?? 0,
      opened: counts.opened ?? 0,
      expired: (counts.expired ?? 0) + late,
      active: live,
    };
  }

  /** Deletes the links past their day (and the requests that named them), counting them. Runs inside the caller's transaction. */
  sweep() {
    const swept = this.store.run('DELETE FROM web_shares WHERE expires_at<=?', this.clock.now());
    const n = Number(swept.changes);
    if (n > 0) {
      this.store.run("UPDATE web_share_counts SET n=n+? WHERE name='expired'", n);
      this.store.run('DELETE FROM web_share_requests WHERE token_hash NOT IN (SELECT token_hash FROM web_shares)');
    }
    return n;
  }

  /**
   * Create a link for one voice message of the caller's own conversation. Idempotent per (principal, request id): a repeat with the
   * same body answers the same link, a different body under the same id is IDEMPOTENCY_CONFLICT. Runs in ONE transaction.
   */
  create(principal: SharePrincipal, input: { requestId: string; conversationId: string; messageId: string }) {
    ensure(webShareInstalled(this.store), 'NOT_FOUND');
    ensure(
      /^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.conversationId) &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.messageId),
      'INVALID_REQUEST',
    );
    return this.store.transaction(() => {
      requireWebContent(this.store, this.clock, principal.principalId, principal.world_id, 'read');
      const now = this.clock.now();
      const hash = sha256(JSON.stringify([input.conversationId, input.messageId]));
      const token = this.tokenFor(principal.principalId, input.requestId);
      const prior = this.store.get<{ request_hash: string; token_hash: string }>(
        'SELECT request_hash,token_hash FROM web_share_requests WHERE principal_id=? AND request_id=?',
        principal.principalId,
        input.requestId,
      );
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        const row = this.store.get<{ expires_at: number }>(
          'SELECT expires_at FROM web_shares WHERE token_hash=?',
          prior.token_hash,
        );
        ensure(row, 'NOT_FOUND');
        return { token, expiresAt: row.expires_at, duplicate: true };
      }
      this.sweep();
      const conversation = this.store.get<{ private_character_id: string }>(
        "SELECT private_character_id FROM conversations WHERE world_id=? AND id=? AND kind='private'",
        principal.world_id,
        input.conversationId,
      );
      ensure(conversation && !webCharacterDeleted(this.store, conversation.private_character_id), 'NOT_FOUND');
      const reply = this.store.get<{ media_id: string; character_id: string }>(
        `SELECT i.media_id,p.character_id FROM web_publication_items i
        JOIN web_publications p ON p.operation_id=i.operation_id
        WHERE i.message_id=? AND i.origin='narrative' AND i.media_id IS NOT NULL
          AND p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=?`,
        input.messageId,
        principal.principalId,
        principal.player_id,
        principal.world_id,
        input.conversationId,
      );
      const broadcast =
        !reply && webBroadcastInstalled(this.store)
          ? this.store.get<{ media_id: string; character_id: string }>(
              `SELECT m.media_id,b.character_id FROM web_broadcast_messages b JOIN messages m ON m.id=b.message_id
              WHERE b.message_id=? AND b.principal_id=? AND b.world_id=? AND b.conversation_id=? AND b.kind='voice'
                AND m.world_id=b.world_id AND m.conversation_id=b.conversation_id AND m.media_id IS NOT NULL`,
              input.messageId,
              principal.principalId,
              principal.world_id,
              input.conversationId,
            )
          : undefined;
      const source = reply ?? broadcast;
      ensure(source && source.character_id === conversation.private_character_id, 'NOT_FOUND');
      const live = this.store.get<{ n: number }>(
        'SELECT count(*) n FROM web_shares WHERE world_id=? AND expires_at>?',
        principal.world_id,
        now,
      )!.n;
      ensure(live < SHARE_LIVE_LIMIT, 'SHARE_LIMIT_REACHED');
      this.store.run(
        `INSERT INTO web_shares(token_hash,world_id,conversation_id,message_id,media_id,character_id,kind,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        sha256(token),
        principal.world_id,
        input.conversationId,
        input.messageId,
        source.media_id,
        source.character_id,
        reply ? 'reply' : 'broadcast',
        now,
        now + SHARE_TTL_MS,
      );
      this.store.run(
        'INSERT INTO web_share_requests(principal_id,request_id,request_hash,token_hash,created_at) VALUES (?,?,?,?,?)',
        principal.principalId,
        input.requestId,
        hash,
        sha256(token),
        now,
      );
      this.store.run("UPDATE web_share_counts SET n=n+1 WHERE name='created'");
      return { token, expiresAt: now + SHARE_TTL_MS, duplicate: false };
    });
  }

  /** The row of a live link whose message still exists, or null: unknown, expired and purged all look the same. */
  private live(token: string): (ShareRow & { principal_id: string; player_id: string }) | null {
    if (!webShareInstalled(this.store) || !SHARE_TOKEN.test(token)) return null;
    const row = this.store.get<ShareRow>(
      'SELECT * FROM web_shares WHERE token_hash=? AND expires_at>?',
      sha256(token),
      this.clock.now(),
    );
    if (!row) return null;
    // The message must still be there (the purges delete the link with it; this is the second lock).
    const found =
      row.kind === 'reply'
        ? this.store.get<{ principal_id: string; player_id: string }>(
            `SELECT p.principal_id,p.player_id FROM web_publication_items i JOIN web_publications p ON p.operation_id=i.operation_id
            JOIN messages m ON m.id=i.message_id
            WHERE i.message_id=? AND i.media_id=? AND p.world_id=? AND p.conversation_id=? AND p.character_id=?
              AND m.world_id=p.world_id AND m.conversation_id=p.conversation_id`,
            row.message_id,
            row.media_id,
            row.world_id,
            row.conversation_id,
            row.character_id,
          )
        : webBroadcastInstalled(this.store)
          ? this.store.get<{ principal_id: string; player_id: string }>(
              `SELECT b.principal_id,'' player_id FROM web_broadcast_messages b JOIN messages m ON m.id=b.message_id
              WHERE b.message_id=? AND b.world_id=? AND b.conversation_id=? AND b.character_id=? AND m.media_id=?`,
              row.message_id,
              row.world_id,
              row.conversation_id,
              row.character_id,
              row.media_id,
            )
          : undefined;
    if (!found || webCharacterDeleted(this.store, row.character_id)) return null;
    // The player's own content must still be readable: a guest's content goes when their trial's data does (the retention rules), and
    // the link goes with it, card and voice alike.
    try {
      requireWebContent(this.store, this.clock, found.principal_id, row.world_id, 'read');
    } catch {
      return null;
    }
    return { ...row, ...found };
  }

  /** The public card. Counts one open. Null when the link is unknown, expired or its message is gone. */
  open(token: string): PublicShare | null {
    const row = this.live(token);
    if (!row) return null;
    const list = this.catalog();
    const index = list.findIndex((character) => character.characterId === row.character_id);
    if (index < 0) return null;
    const character = list[index]!;
    const durationMs = this.store.get<{ duration_ms: number | null }>(
      row.kind === 'reply'
        ? 'SELECT duration_ms FROM web_provider_media_assets WHERE media_id=?'
        : `SELECT c.duration_ms FROM web_broadcast_messages b JOIN web_broadcast_characters c
          ON c.broadcast_id=b.broadcast_id AND c.character_id=b.character_id WHERE b.message_id=?`,
      row.kind === 'reply' ? row.media_id : row.message_id,
    )?.duration_ms;
    this.store.run("UPDATE web_share_counts SET n=n+1 WHERE name='opened'");
    // A character with no birthday is numbered after the three built-in ones, in catalog order (the player page's own rule).
    const builtin = ['wei-guagua', 'jojo', 'chen-jimi'];
    const known = builtin.indexOf(character.characterId);
    const noRank =
      known >= 0 ? known + 1 : 4 + list.slice(0, index).filter((other) => !builtin.includes(other.characterId)).length;
    return {
      characterId: character.characterId,
      displayName: character.displayName,
      portraitUrl: character.portraitUrl,
      mainColor: character.mainColor,
      palette: character.palette,
      birthDate: character.birthDate,
      noRank,
      durationMs: typeof durationMs === 'number' && durationMs > 0 ? durationMs : null,
      voiceUrl: `${this.apiBase}/shares/${token}/audio`,
    };
  }

  /** The voice, through the same token and the same day. Null for every kind of unavailable. */
  async audio(token: string): Promise<Uint8Array | null> {
    const row = this.live(token);
    if (!row) return null;
    try {
      if (row.kind === 'broadcast')
        return broadcastAudio(
          this.store,
          { principalId: row.principal_id, worldId: row.world_id, conversationId: row.conversation_id },
          row.message_id,
          row.media_id,
        );
      const bytes = await this.publisher.readPublishedAudioAsync(
        {
          principalId: row.principal_id,
          playerId: row.player_id,
          worldId: row.world_id,
          conversationId: row.conversation_id,
          characterId: row.character_id,
        },
        row.media_id,
      );
      // The link is checked again after the (possibly asynchronous) read: a purge in between kills it.
      return this.live(token) ? bytes : null;
    } catch {
      return null;
    }
  }
}
