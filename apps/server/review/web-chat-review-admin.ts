import type { Clock } from '../../../packages/contracts/index.ts';
import { hasConversationsPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import {
  characterFacts,
  characterLocalTime,
  chatReviewTablesExist,
  nicknamesOfWorld,
  readTranscript,
  reviewCodeFor,
  reviewLabel,
  REVIEW_ALPHABET,
  type CharacterFacts,
  type TranscriptLine,
} from './web-chat-review.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const codeOk = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 4 && [...value].every((c) => REVIEW_ALPHABET.includes(c));
export const REVIEW_LIST_PAGE = 50;
export const REVIEW_DETAIL_PAGE = 100;
export const REVIEW_EXPORT_LIMIT = 50_000;
const DAY = 86_400_000;

export type ReviewRow = {
  label: string;
  characterId: string;
  code: string;
  archived: boolean;
  /** "YYYY-MM-DD" (UTC) on which an archived transcript disappears. */
  expiresOn: string | null;
  messages: number;
  failed: number;
  firstAt: string;
  lastAt: string;
};
export type ReviewDetailLine = {
  n: number;
  time: string;
  speaker: TranscriptLine['speaker'];
  text: string;
  status: TranscriptLine['status'];
  errorCode: string | null;
  reviewChanged: boolean;
};

/** A spreadsheet must not run player text as a formula. */
const cell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const CSV_HEADER = 'label,time,speaker,text,status,error_code,审核改动';
const csvLine = (label: string, line: ReviewDetailLine | TranscriptLine) =>
  [label, line.time, line.speaker, line.text, line.status, line.errorCode ?? '', line.reviewChanged ? '1' : '0']
    .map(cell)
    .join(',');

/**
 * 测试对话: the owner reads transcripts under an anonymous code. Read-only: nothing here writes player data except
 * assigning a missing code; each call writes one audit row (actor, action, label, time - no content). Never returned: email,
 * nickname, any id of a principal / player / world / session / operation, IP hash, invite code, memories or voice files.
 */
export class WebChatReviewAdmin {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  constructor(store: BusinessStore, clock: Clock, admin: WebAccountAdmin) {
    this.store = store;
    this.clock = clock;
    this.admin = admin;
  }

  private actor(auth: Auth) {
    ensure(chatReviewTablesExist(this.store), 'NOT_FOUND');
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin),
      member = this.admin.session(auth.cookie).member;
    ensure(actor.role === 'owner' || hasConversationsPermission(member.permissions), 'ADMIN_PERMISSION_REQUIRED');
    return actor;
  }
  private audit(actorId: string, action: string, label: string) {
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actorId,
      action,
      label,
      this.clock.now(),
    );
  }

  /** The principals that have chats a review can show (not the ones whose purge has begun: their copy is in the archive). */
  private liveRows(characterId: string | null) {
    const rows = this.store.all<{
      principal_id: string;
      world_id: string;
      character_id: string;
      n: number;
      first_at: number;
      last_at: number;
    }>(
      `SELECT p.id principal_id,p.world_id,c.private_character_id character_id,count(m.seq) n,
        min(m.created_at) first_at,max(m.created_at) last_at
      FROM web_principals p JOIN conversations c ON c.world_id=p.world_id AND c.kind='private'
      JOIN messages m ON m.world_id=c.world_id AND m.conversation_id=c.id
      WHERE NOT EXISTS (SELECT 1 FROM web_guest_retention r WHERE r.principal_id=p.id AND r.state IN ('purging','purged'))
      ${characterId === null ? '' : 'AND c.private_character_id=?'}
      GROUP BY p.id,c.private_character_id`,
      ...(characterId === null ? [] : [characterId]),
    );
    return rows.filter((row) => !webCharacterDeleted(this.store, row.character_id));
  }
  private archiveRows(characterId: string | null) {
    return this.store.all<{
      label: string;
      review_code: string;
      character_id: string;
      messages: number;
      failed: number;
      first_local: string;
      last_local: string;
      expires_at: number;
    }>(
      `SELECT label,review_code,character_id,coalesce(sum(status='ok'),0) messages,coalesce(sum(status='failed'),0) failed,
        min(at_local) first_local,max(at_local) last_local,max(expires_at) expires_at
      FROM web_review_archive ${characterId === null ? '' : 'WHERE character_id=?'}
      GROUP BY label,review_code,character_id`,
      ...(characterId === null ? [] : [characterId]),
    );
  }

  /** One row per labelled conversation (live and archived) with at least one message, newest activity first. */
  list(
    auth: Auth,
    input: { characterId: unknown; scope: unknown; page: unknown },
  ): {
    rows: ReviewRow[];
    page: number;
    pageSize: number;
    total: number;
    characters: { characterId: string; label: string }[];
  } {
    const actor = this.actor(auth);
    ensure(input.characterId === null || identifier(input.characterId), 'INVALID_REQUEST');
    ensure(input.scope === null || input.scope === 'live' || input.scope === 'archived', 'INVALID_REQUEST');
    ensure(
      Number.isSafeInteger(input.page) && (input.page as number) >= 0 && (input.page as number) < 10_000,
      'INVALID_REQUEST',
    );
    const characterId = input.characterId as string | null,
      page = input.page as number;
    const facts = new Map<string, CharacterFacts>();
    const factsOf = (id: string) => {
      let value = facts.get(id);
      if (!value) facts.set(id, (value = characterFacts(this.store, id)));
      return value;
    };
    const failedBy = new Map<string, number>();
    for (const row of this.store.all<{ world_id: string; character_id: string; n: number }>(
      "SELECT world_id,character_id,count(*) n FROM web_operations WHERE status='failed' GROUP BY world_id,character_id",
    ))
      failedBy.set(`${row.world_id}\0${row.character_id}`, row.n);
    const rows: ReviewRow[] = [];
    if (input.scope !== 'archived') {
      // The only write: a code that does not exist yet is drawn the first time its transcript is listed.
      const live = this.liveRows(characterId);
      this.store.transaction(() => {
        for (const row of live) {
          const code = reviewCodeFor(this.store, row.principal_id, this.clock.now());
          const character = factsOf(row.character_id);
          rows.push({
            label: reviewLabel(character, code),
            characterId: row.character_id,
            code,
            archived: false,
            expiresOn: null,
            messages: row.n,
            failed: failedBy.get(`${row.world_id}\0${row.character_id}`) ?? 0,
            firstAt: characterLocalTime(row.first_at, character.timeZone),
            lastAt: characterLocalTime(row.last_at, character.timeZone),
          });
        }
      });
    }
    if (input.scope !== 'live')
      for (const row of this.archiveRows(characterId))
        rows.push({
          label: row.label,
          characterId: row.character_id,
          code: row.review_code,
          archived: true,
          expiresOn: new Date(Math.floor(row.expires_at / DAY) * DAY).toISOString().slice(0, 10),
          messages: row.messages,
          failed: row.failed,
          firstAt: row.first_local,
          lastAt: row.last_local,
        });
    const shown = rows.filter((row) => row.messages > 0);
    shown.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.label < b.label ? -1 : 1));
    this.audit(actor.memberId, 'chat-review-list', characterId ?? '*');
    const known = new Set([...shown.map((row) => row.characterId)]);
    return {
      rows: shown.slice(page * REVIEW_LIST_PAGE, (page + 1) * REVIEW_LIST_PAGE),
      page,
      pageSize: REVIEW_LIST_PAGE,
      total: shown.length,
      characters: [...known].sort().map((id) => ({ characterId: id, label: factsOf(id).label })),
    };
  }

  /** The lines of one transcript. Live: found by its code; archived: read from the archive. */
  private transcript(characterId: string, code: string, archived: boolean) {
    if (archived) {
      const lines = this.store.all<{
        label: string;
        line_order: number;
        at_local: string;
        speaker: TranscriptLine['speaker'];
        text: string;
        status: TranscriptLine['status'];
        error_code: string | null;
        review_changed: number;
        expires_at: number;
      }>(
        'SELECT * FROM web_review_archive WHERE character_id=? AND review_code=? ORDER BY line_order',
        characterId,
        code,
      );
      ensure(lines.length > 0, 'NOT_FOUND');
      return {
        label: lines[0]!.label,
        expiresOn: new Date(Math.floor(lines[0]!.expires_at / DAY) * DAY).toISOString().slice(0, 10),
        lines: lines.map(
          (row): ReviewDetailLine => ({
            n: row.line_order + 1,
            time: row.at_local,
            speaker: row.speaker,
            text: row.text,
            status: row.status,
            errorCode: row.error_code,
            reviewChanged: row.review_changed === 1,
          }),
        ),
      };
    }
    const owner = this.store.get<{ principal_id: string }>(
      'SELECT principal_id FROM web_review_codes WHERE code=?',
      code,
    );
    ensure(owner, 'NOT_FOUND');
    const world = this.store.get<{ world_id: string; state: string | null }>(
      `SELECT p.world_id,(SELECT r.state FROM web_guest_retention r WHERE r.principal_id=p.id) state
      FROM web_principals p WHERE p.id=?`,
      owner.principal_id,
    );
    ensure(
      world && world.state !== 'purging' && world.state !== 'purged' && !webCharacterDeleted(this.store, characterId),
      'NOT_FOUND',
    );
    const lines = readTranscript(this.store, world.world_id, characterId, nicknamesOfWorld(this.store, world.world_id));
    ensure(lines.length > 0, 'NOT_FOUND');
    return {
      label: reviewLabel(characterFacts(this.store, characterId), code),
      expiresOn: null as string | null,
      lines: lines.map(
        (line): ReviewDetailLine => ({
          n: line.order + 1,
          time: line.time,
          speaker: line.speaker,
          text: line.text,
          status: line.status,
          errorCode: line.errorCode,
          reviewChanged: line.reviewChanged,
        }),
      ),
    };
  }

  detail(auth: Auth, input: { characterId: unknown; code: unknown; archived: unknown; page: unknown }) {
    const actor = this.actor(auth);
    ensure(identifier(input.characterId) && codeOk(input.code), 'INVALID_REQUEST');
    ensure(typeof input.archived === 'boolean', 'INVALID_REQUEST');
    ensure(
      Number.isSafeInteger(input.page) && (input.page as number) >= 0 && (input.page as number) < 100_000,
      'INVALID_REQUEST',
    );
    const page = input.page as number;
    const found = this.transcript(input.characterId, input.code, input.archived);
    this.audit(actor.memberId, 'chat-review-detail', found.label);
    return {
      label: found.label,
      characterId: input.characterId,
      code: input.code,
      archived: input.archived,
      expiresOn: found.expiresOn,
      total: found.lines.length,
      page,
      pageSize: REVIEW_DETAIL_PAGE,
      lines: found.lines.slice(page * REVIEW_DETAIL_PAGE, (page + 1) * REVIEW_DETAIL_PAGE),
    };
  }

  /**
   * CSV of one conversation (characterId + code + archived) or of all conversations of one character (code null, archived
   * null). The CSV carries exactly the columns the screen shows.
   */
  export(auth: Auth, input: { characterId: unknown; code: unknown; archived: unknown }) {
    const actor = this.actor(auth);
    ensure(identifier(input.characterId), 'INVALID_REQUEST');
    const one = input.code !== null;
    ensure(
      one ? codeOk(input.code) && typeof input.archived === 'boolean' : input.archived === null,
      'INVALID_REQUEST',
    );
    const characterId = input.characterId as string;
    const parts: { label: string; lines: ReviewDetailLine[] }[] = [];
    let auditLabel: string;
    if (one) {
      const found = this.transcript(characterId, input.code as string, input.archived as boolean);
      parts.push({ label: found.label, lines: found.lines });
      auditLabel = found.label;
    } else {
      const character = characterFacts(this.store, characterId);
      auditLabel = `${character.label}-*`;
      const live = this.liveRows(characterId),
        archived = this.archiveRows(characterId);
      this.store.transaction(() => {
        for (const row of live) {
          const code = reviewCodeFor(this.store, row.principal_id, this.clock.now());
          parts.push({ label: reviewLabel(character, code), lines: this.transcript(characterId, code, false).lines });
        }
      });
      for (const row of archived)
        parts.push({ label: row.label, lines: this.transcript(characterId, row.review_code, true).lines });
      ensure(parts.length > 0, 'NOT_FOUND');
      parts.sort((a, b) => (a.label < b.label ? -1 : 1));
    }
    const total = parts.reduce((n, part) => n + part.lines.length, 0);
    ensure(total <= REVIEW_EXPORT_LIMIT, 'REVIEW_EXPORT_TOO_LARGE');
    this.audit(actor.memberId, 'chat-review-export', auditLabel);
    const csv =
      '﻿' +
      [CSV_HEADER, ...parts.flatMap((part) => part.lines.map((line) => csvLine(part.label, line)))].join('\r\n') +
      '\r\n';
    return { filename: `${auditLabel.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.csv`, lines: total, csv };
  }
}
