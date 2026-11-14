import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { contentHash } from '../characters/admin-content-hash.ts';
import { publishedWebCharacters } from '../characters/web-character-catalog.ts';
import { purgeAdminSpeechAudio } from '../characters/web-admin-speech-schema.ts';
import { eraseRehearsalRun, rehearsalRunBusy } from '../characters/web-rehearsal-erase.ts';
import { deleteLiveConversation, conversationBusy } from '../characters/web-conversation-deletion.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import {
  chatReviewTablesExist,
  deleteArchivedChats,
  deleteArchivedTranscript,
  REVIEW_ALPHABET,
} from '../review/web-chat-review.ts';
import { closedChatPolicy, ownerOpsInstalled } from './web-owner-ops-schema.ts';
import type { WebAccountAdmin } from './web-account-admin.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const code = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 4 && [...value].every((c) => REVIEW_ALPHABET.includes(c));
export const OWNER_BATCH_MAX = 200;
/** 200 items of about 70 bytes, and the envelope. */
export const OWNER_BODY_LIMIT = 32_768;
const DAY = 86_400_000;
const day = (at: number) => new Date(Math.floor(at / DAY) * DAY).toISOString().slice(0, 10);
const exact = (value: unknown, names: string[]): Record<string, unknown> => {
  ensure(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === [...names].sort().join(','),
    'INVALID_REQUEST',
  );
  return value as Record<string, unknown>;
};
const list = <T>(value: unknown, ok: (item: unknown) => item is T): T[] => {
  ensure(Array.isArray(value) && value.length <= OWNER_BATCH_MAX && value.every(ok), 'INVALID_REQUEST');
  ensure(new Set(value.map((v) => JSON.stringify(v))).size === value.length, 'INVALID_REQUEST');
  return value as T[];
};

/**
 * Part 31: the owner's operations. Every write here is idempotent per request id (web_owner_requests: the request id, a hash of the
 * body and the COUNTS the first run produced), writes one web_admin_audit row that holds a fixed action and a count (never an
 * id or content), and is refused for anyone but the owner (arc order: the owner or the 角色 category grant).
 * The business object is the only writer; nothing here calls a provider, reserves, releases or settles money.
 */
export class WebOwnerOps {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  constructor(store: WebRuntimeStore, clock: Clock, admin: WebAccountAdmin) {
    this.store = store;
    this.clock = clock;
    this.admin = admin;
  }
  private actor(auth: Auth, who: 'owner' | 'characters') {
    ensure(ownerOpsInstalled(this.store), 'NOT_FOUND');
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    const member = this.admin.session(auth.cookie).member;
    ensure(
      actor.role === 'owner' || (who === 'characters' && member.permissions.includes('category.characters')),
      who === 'owner' ? 'ADMIN_OWNER_REQUIRED' : 'ADMIN_PERMISSION_REQUIRED',
    );
    return actor;
  }
  private audit(memberId: string, action: string, count: number) {
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      memberId,
      action,
      `n=${count}`,
      this.clock.now(),
    );
  }
  /** Runs `work` once per request id (inside the caller's transaction); a repeat answers with the counts of the first run. */
  private once(
    kind: string,
    memberId: string,
    requestId: unknown,
    body: unknown,
    work: () => { a: number; b: number },
  ): { a: number; b: number; replayed: boolean } {
    ensure(id(requestId), 'INVALID_REQUEST');
    const hash = contentHash([memberId, kind, body]);
    return this.store.transaction(() => {
      const prior = this.store.get<{ kind: string; request_hash: string; count_a: number; count_b: number }>(
        'SELECT kind,request_hash,count_a,count_b FROM web_owner_requests WHERE request_id=?',
        requestId,
      );
      if (prior) {
        ensure(prior.kind === kind && prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return { a: prior.count_a, b: prior.count_b, replayed: true };
      }
      const done = work();
      this.store.run(
        'INSERT INTO web_owner_requests(request_id,kind,request_hash,member_id,count_a,count_b,created_at) VALUES (?,?,?,?,?,?,?)',
        requestId,
        kind,
        hash,
        memberId,
        done.a,
        done.b,
        this.clock.now(),
      );
      return { ...done, replayed: false };
    });
  }

  // ---- A. the order of the cards on the home arc ------------------------------------------------------------------------------

  /**
   * The home arc reads `web_character_catalog.position` (publishedWebCharacters orders by it). That is a different list from the
   * workbench's 角色 order (web_admin_character_order: one rank per ADMIN and sidebar group, never read by the home page), so the
   * arc keeps its own single, global order and it IS the catalog position: no second table, nothing to drift.
   */
  arcOrder(auth: Auth) {
    this.actor(auth, 'characters');
    return {
      characters: publishedWebCharacters(this.store).map((c, i) => ({
        characterId: c.characterId,
        name: c.presentation.displayName,
        color: c.presentation.color ?? null,
        position: i + 1,
      })),
    };
  }
  saveArcOrder(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'characters');
    const body = exact(input, ['requestId', 'ids']);
    const ids = list(body.ids, id);
    const done = this.once('arc-order', actor.memberId, body.requestId, body, () => {
      const live = publishedWebCharacters(this.store);
      // Exactly the characters that are on the arc now (an offline one has no place to order), each once.
      ensure(ids.length === live.length && ids.every((x) => live.some((c) => c.characterId === x)), 'ARC_ORDER_STALE');
      for (const c of live) this.store.run('DELETE FROM web_character_catalog WHERE character_id=?', c.characterId);
      ids.forEach((characterId, position) =>
        this.store.run(
          'INSERT INTO web_character_catalog VALUES (?,?,?)',
          characterId,
          live.find((c) => c.characterId === characterId)!.version,
          position,
        ),
      );
      // The catalog read verifies every hash again: an order that would break a version is refused with nothing changed.
      ensure(publishedWebCharacters(this.store).length === live.length, 'WEB_PROVIDER_CATALOG_INVALID');
      this.audit(actor.memberId, 'arc-order-saved', live.length);
      return { a: live.length, b: 0 };
    });
    return { saved: done.a, ...this.arcOrder(auth) };
  }

  // ---- C. 预演 records --------------------------------------------------------------------------------------------------------

  /**
   * Deletes 预演 records for good: the runs (a run goes with all its results), single previews, their audio, rejected output and
   * time marks. A preview that is still queued or generating is refused as a whole (nothing is cancelled here). The bills
   * (attempt ledger rows and their receipts, the admin speech call ledger) stay as counts; only the request text, the model output
   * and the audio go. Previews a published version stood on lose their result too, so they can no longer gate a publication.
   */
  deletePreviews(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'owner');
    const body = exact(input, ['requestId', 'runIds', 'previewIds']);
    const runIds = list(body.runIds, id),
      previewIds = list(body.previewIds, id);
    ensure(runIds.length + previewIds.length > 0, 'INVALID_REQUEST');
    const done = this.once('preview-delete', actor.memberId, body.requestId, body, () => {
      const wanted = new Set(previewIds);
      for (const runId of runIds) {
        ensure(this.store.get('SELECT 1 FROM web_preview_runs WHERE id=?', runId), 'NOT_FOUND');
        for (const row of this.store.all<{ preview_id: string }>(
          'SELECT preview_id FROM web_preview_run_items WHERE run_id=?',
          runId,
        ))
          wanted.add(row.preview_id);
      }
      let removed = 0;
      for (const previewId of wanted) {
        const row = this.store.get<{ character_id: string; status: string }>(
          `SELECT p.character_id,p.status FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id WHERE p.id=?`,
          previewId,
        );
        ensure(row, 'NOT_FOUND');
        ensure(row.status === 'succeeded' || row.status === 'failed', 'PREVIEW_DELETE_BUSY');
        if (this.store.get('SELECT 1 FROM web_preview_erased WHERE preview_id=?', previewId)) continue;
        this.store.run(
          'INSERT INTO web_preview_erased(preview_id,erased_at) VALUES (?,?)',
          previewId,
          this.clock.now(),
        );
        purgeAdminSpeechAudio(this.store, { characterId: row.character_id, previewIds: [previewId] });
        for (const table of ['web_preview_rejected', 'web_preview_marks', 'web_preview_run_items'])
          this.store.run(`DELETE FROM ${table} WHERE preview_id=?`, previewId);
        this.store.run("UPDATE admin_previews SET result_json=NULL,request_json='{}' WHERE id=?", previewId);
        this.store.run(
          'UPDATE web_character_preview_attempts SET output_json=NULL,metadata_json=NULL WHERE preview_id=?',
          previewId,
        );
        removed++;
      }
      // A run with nothing left in it is deleted with them (its row holds only the settings it ran with).
      let runs = 0;
      for (const run of this.store.all<{ id: string }>(
        'SELECT id FROM web_preview_runs r WHERE NOT EXISTS(SELECT 1 FROM web_preview_run_items i WHERE i.run_id=r.id)',
      )) {
        this.store.run('DELETE FROM web_preview_runs WHERE id=?', run.id);
        runs++;
      }
      this.audit(actor.memberId, 'previews-deleted', removed);
      return { a: removed, b: runs };
    });
    return { previews: done.a, runs: done.b };
  }

  /** Part 31b: 多轮预演 runs. Same rules as 预演: content goes, every money row of web_rehearsal_calls stays; a running run is refused whole. */
  deleteRehearsals(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'owner');
    const body = exact(input, ['requestId', 'runIds']);
    const runIds = list(body.runIds, id);
    ensure(runIds.length > 0, 'INVALID_REQUEST');
    const done = this.once('preview-delete', actor.memberId, body.requestId, body, () => {
      let erased = 0;
      for (const runId of runIds) {
        ensure(this.store.get('SELECT 1 FROM web_rehearsal_runs WHERE id=?', runId), 'NOT_FOUND');
        ensure(!rehearsalRunBusy(this.store, runId), 'REHEARSAL_DELETE_BUSY');
      }
      for (const runId of runIds) if (eraseRehearsalRun(this.store, runId, this.clock.now())) erased++;
      this.audit(actor.memberId, 'rehearsals-deleted', erased);
      return { a: erased, b: 0 };
    });
    return { runs: done.a };
  }

  // ---- C + D. conversations ---------------------------------------------------------------------------------------------------

  /**
   * Deletes 测试对话 (a character-code pair, live or archived) for good. A live conversation with an unfinished operation is skipped
   * and counted; everything else goes through the shared purge audit (deleteLiveConversation). Money and ledger rows stay.
   */
  deleteConversations(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'owner');
    ensure(chatReviewTablesExist(this.store), 'NOT_FOUND');
    const body = exact(input, ['requestId', 'items']);
    const items = list(
      body.items,
      (v): v is { characterId: string; code: string; archived: boolean } =>
        !!v &&
        typeof v === 'object' &&
        Object.keys(v).sort().join(',') === 'archived,characterId,code' &&
        id((v as Record<string, unknown>).characterId) &&
        code((v as Record<string, unknown>).code) &&
        typeof (v as Record<string, unknown>).archived === 'boolean',
    );
    ensure(items.length > 0, 'INVALID_REQUEST');
    const done = this.once('conversation-delete', actor.memberId, body.requestId, body, () => {
      let deleted = 0,
        skipped = 0;
      for (const item of items) {
        if (item.archived) {
          if (deleteArchivedTranscript(this.store, item.code, item.characterId) > 0) deleted++;
          continue;
        }
        const owner = this.store.get<{ principal_id: string }>(
          'SELECT principal_id FROM web_review_codes WHERE code=?',
          item.code,
        );
        const world = owner
          ? this.store.get<{ world_id: string; state: string | null }>(
              `SELECT p.world_id,(SELECT r.state FROM web_guest_retention r WHERE r.principal_id=p.id) state FROM web_principals p WHERE p.id=?`,
              owner.principal_id,
            )
          : undefined;
        const conversation =
          owner &&
          world &&
          world.state !== 'purging' &&
          world.state !== 'purged' &&
          !webCharacterDeleted(this.store, item.characterId)
            ? this.store.get<{ id: string }>(
                `SELECT id FROM conversations WHERE world_id=? AND kind='private' AND private_character_id=?`,
                world.world_id,
                item.characterId,
              )
            : undefined;
        if (!owner || !world || !conversation) continue;
        const ref = {
          principalId: owner.principal_id,
          worldId: world.world_id,
          conversationId: conversation.id,
          characterId: item.characterId,
        };
        if (conversationBusy(this.store, ref)) {
          skipped++;
          continue;
        }
        deleteLiveConversation(this.store, this.clock, ref);
        deleted++;
      }
      this.audit(actor.memberId, 'conversations-deleted', deleted);
      return { a: deleted, b: skipped };
    });
    return { deleted: done.a, skipped: done.b };
  }

  // ---- D. closed accounts -----------------------------------------------------------------------------------------------------

  closedAccounts(auth: Auth) {
    this.actor(auth, 'owner');
    return {
      policy: closedChatPolicy(this.store),
      rows: this.store
        .all<{ player_number: string; closed_at: number }>(
          'SELECT player_number,closed_at FROM web_closed_accounts ORDER BY closed_at DESC,player_number LIMIT 500',
        )
        .map((r) => ({ playerNumber: r.player_number, closedOn: day(r.closed_at) })),
    };
  }
  saveClosedPolicy(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'owner');
    const body = exact(input, ['requestId', 'policy']);
    ensure(body.policy === 'retention' || body.policy === 'immediate', 'INVALID_REQUEST');
    this.once('closed-setting', actor.memberId, body.requestId, body, () => {
      this.store.run(
        `INSERT INTO web_owner_settings(key,value,member_id,updated_at) VALUES ('closed_chats',?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,member_id=excluded.member_id,updated_at=excluded.updated_at`,
        body.policy as string,
        actor.memberId,
        this.clock.now(),
      );
      this.audit(actor.memberId, `closed-chats-${body.policy}`, 0);
      return { a: 0, b: 0 };
    });
    return this.closedAccounts(auth);
  }
  /** One closed account's remaining chat text, now: the archive copy and its list row. Nothing else is touched. */
  deleteClosedAccount(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'owner');
    ensure(chatReviewTablesExist(this.store), 'NOT_FOUND');
    const body = exact(input, ['requestId', 'playerNumber']);
    ensure(
      typeof body.playerNumber === 'string' && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(body.playerNumber),
      'INVALID_REQUEST',
    );
    const done = this.once('closed-delete', actor.memberId, body.requestId, body, () => {
      const row = this.store.get<{ review_code: string }>(
        'SELECT review_code FROM web_closed_accounts WHERE player_number=?',
        body.playerNumber as string,
      );
      const lines = row ? deleteArchivedChats(this.store, row.review_code) : 0;
      this.audit(actor.memberId, 'closed-account-chats-deleted', lines > 0 ? 1 : 0);
      return { a: row ? 1 : 0, b: lines };
    });
    return { accounts: done.a, lines: done.b };
  }
}
