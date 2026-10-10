import { createHash, createHmac } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import {
  COCREATION_LIMITS,
  cocreationCard,
  validateCocreationAnswers,
  type CocreationKind,
  type CocreationTargetField,
} from '../../../packages/contracts/cocreation-cards.ts';
import {
  hasCocreationPermission,
  type CocreationAdminPermission,
} from '../../../packages/contracts/web-admin-permissions.ts';
import { RetryAfterError, ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import type { WebIdentity } from '../identity/web-identity.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import { cocreationTablesExist } from './web-cocreation-purge.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
export type CocreationStatus = 'new' | 'processed' | 'archived';
const STATUSES: readonly string[] = ['new', 'processed', 'archived'];
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const requestIdOk = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const PAGE = 30;
const BULK_LIMIT = 100;

type SubmissionRow = {
  id: string;
  character_id: string;
  principal_id: string;
  created_at: number;
  status: CocreationStatus;
  starred: number;
  admin_note: string | null;
  processed_at: number | null;
};
type AnswerRow = {
  ordinal: number;
  card_id: string;
  target_field: CocreationTargetField;
  kind: CocreationKind;
  text_json: string;
  adopted_at: number | null;
};
const answerValue = (row: Pick<AnswerRow, 'kind' | 'text_json'>) =>
  JSON.parse(row.text_json) as string | { player: string; replies: string[] };
const firstLine = (row: Pick<AnswerRow, 'kind' | 'text_json'>) => {
  const value = answerValue(row);
  const text = typeof value === 'string' ? value : value.player;
  return [...text].slice(0, 60).join('');
};
const likePattern = (query: string) => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Players' ideas for official characters, and the administrators' inbox over them. The business object is the only
 * writer. Nothing here calls a provider, reviews text automatically or touches a prompt: submissions are untrusted
 * text that reach a prompt only after an administrator copies them into a draft and publishes it.
 */
export class WebCocreation {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly identity: Pick<WebIdentity, 'authorizeWrite' | 'isInvitedSession'>;
  private readonly admin: WebAccountAdmin;
  private readonly key: Buffer;
  private readonly id: () => string;
  constructor(
    store: BusinessStore,
    clock: Clock,
    identity: Pick<WebIdentity, 'authorizeWrite' | 'isInvitedSession'>,
    admin: WebAccountAdmin,
    pseudonymKey: Buffer,
    nextId: () => string,
  ) {
    this.store = store;
    this.clock = clock;
    this.identity = identity;
    this.admin = admin;
    this.key = pseudonymKey;
    this.id = nextId;
  }

  /** Stable per-player label for the inbox: a keyed hash of the principal id, never an identity. */
  pseudonym(principalId: string) {
    return `玩家#${createHmac('sha256', this.key).update('web-cocreation-pseudonym-v1\0').update(principalId).digest('hex').slice(0, 4)}`;
  }

  // ---- player ---------------------------------------------------------------------------------------------------

  submit(
    token: string,
    csrf: string,
    origin: string,
    input: { characterId: unknown; requestId: unknown; answers: unknown },
  ) {
    // Session, CSRF and Origin first, so an unauthenticated caller learns nothing about the card list.
    this.identity.authorizeWrite(token, csrf, origin);
    ensure(identifier(input.characterId) && requestIdOk(input.requestId), 'INVALID_REQUEST');
    const checked = validateCocreationAnswers(input.answers);
    ensure(checked.ok, checked.ok ? '' : checked.code);
    const characterId = input.characterId,
      requestId = input.requestId,
      answers = checked.answers,
      hash = createHash('sha256')
        .update(JSON.stringify([characterId, answers]))
        .digest('hex');
    return this.store.transaction(() => {
      ensure(cocreationTablesExist(this.store), 'COCREATION_UNAVAILABLE');
      const principal = this.identity.authorizeWrite(token, csrf, origin);
      ensure(principal.kind === 'invite' && this.identity.isInvitedSession(token), 'COCREATION_INVITE_REQUIRED');
      ensure(
        this.store.get('SELECT 1 FROM web_character_catalog WHERE character_id=?', characterId) &&
          !webCharacterDeleted(this.store, characterId),
        'NOT_FOUND',
      );
      const prior = this.store.get<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM web_cocreation_submissions WHERE principal_id=? AND request_id=?',
        principal.principalId,
        requestId,
      );
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return { submissionId: prior.id, answered: answers.length, duplicate: true };
      }
      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      const recent = this.store.all<{ created_at: number }>(
        `SELECT created_at FROM web_cocreation_submissions
        WHERE principal_id=? AND character_id=? AND created_at>? ORDER BY created_at DESC`,
        principal.principalId,
        characterId,
        now - COCREATION_LIMITS.windowMs,
      );
      if (recent.length >= COCREATION_LIMITS.submissionsPerDay)
        throw new RetryAfterError(
          'COCREATION_RATE_LIMITED',
          Math.max(1, recent[COCREATION_LIMITS.submissionsPerDay - 1]!.created_at + COCREATION_LIMITS.windowMs - now),
        );
      const submissionId = this.id();
      this.store.run(
        `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at)
        VALUES (?,?,?,?,?,?)`,
        submissionId,
        characterId,
        principal.principalId,
        requestId,
        hash,
        now,
      );
      answers.forEach((answer, ordinal) => {
        const card = cocreationCard(answer.cardId)!;
        const value = 'text' in answer ? answer.text : { player: answer.player, replies: answer.replies };
        this.store.run(
          `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,?,?,?,?,?)`,
          submissionId,
          ordinal,
          card.id,
          card.targetField,
          card.kind,
          JSON.stringify(value),
        );
      });
      return { submissionId, answered: answers.length, duplicate: false };
    });
  }

  // ---- administrators -------------------------------------------------------------------------------------------

  private actor(auth: Auth, permission: CocreationAdminPermission) {
    // The tables exist from schema 117; an older database has no inbox.
    ensure(cocreationTablesExist(this.store), 'COCREATION_UNAVAILABLE');
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin),
      member = this.admin.session(auth.cookie).member;
    ensure(
      actor.role === 'owner' || hasCocreationPermission(member.permissions, permission),
      'ADMIN_PERMISSION_REQUIRED',
    );
    return actor;
  }
  private audit(actor: string, action: string, target: string) {
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actor,
      action,
      target,
      this.clock.now(),
    );
  }
  private row(id: unknown) {
    ensure(identifier(id), 'INVALID_REQUEST');
    const row = this.store.get<SubmissionRow>('SELECT * FROM web_cocreation_submissions WHERE id=?', id);
    ensure(row, 'NOT_FOUND');
    return row;
  }

  /** Newly arrived (status new) submissions per character, for the badge in the character workbench. */
  counts(auth: Auth) {
    this.actor(auth, 'cocreation.read');
    const counts: Record<string, number> = {};
    for (const row of this.store.all<{ character_id: string; n: number }>(
      "SELECT character_id,count(*) n FROM web_cocreation_submissions WHERE status='new' GROUP BY character_id",
    ))
      counts[row.character_id] = row.n;
    return { counts };
  }

  list(
    auth: Auth,
    input: {
      characterId: unknown;
      status: unknown;
      starred: unknown;
      query: unknown;
      before: unknown;
    },
  ) {
    this.actor(auth, 'cocreation.read');
    ensure(input.characterId === null || identifier(input.characterId), 'INVALID_REQUEST');
    ensure(
      input.status === null || (typeof input.status === 'string' && STATUSES.includes(input.status)),
      'INVALID_REQUEST',
    );
    ensure(input.starred === null || input.starred === true, 'INVALID_REQUEST');
    ensure(
      input.query === null ||
        (typeof input.query === 'string' && input.query.trim().length > 0 && [...input.query].length <= 100),
      'INVALID_REQUEST',
    );
    const before = input.before as { createdAt?: unknown; id?: unknown } | null;
    ensure(
      before === null ||
        (typeof before === 'object' && Number.isSafeInteger(before.createdAt) && identifier(before.id)),
      'INVALID_CURSOR',
    );
    const where: string[] = [],
      args: (string | number)[] = [];
    if (input.characterId !== null) {
      where.push('s.character_id=?');
      args.push(input.characterId as string);
    }
    if (input.status !== null) {
      where.push('s.status=?');
      args.push(input.status as string);
    }
    if (input.starred === true) where.push('s.starred=1');
    if (input.query !== null) {
      const like = likePattern((input.query as string).trim());
      where.push(`(coalesce(s.admin_note,'') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM web_cocreation_answers a
        WHERE a.submission_id=s.id AND (CASE a.kind WHEN 'text' THEN json_extract(a.text_json,'$')
          ELSE json_extract(a.text_json,'$.player')||' '||json_extract(a.text_json,'$.replies') END) LIKE ? ESCAPE '\\'))`);
      args.push(like, like);
    }
    if (before !== null) {
      where.push('(s.created_at<? OR (s.created_at=? AND s.id<?))');
      args.push(before.createdAt as number, before.createdAt as number, before.id as string);
    }
    const rows = this.store.all<SubmissionRow & { answers: number; adopted: number }>(
      `SELECT s.*,(SELECT count(*) FROM web_cocreation_answers a WHERE a.submission_id=s.id) answers,
        (SELECT count(*) FROM web_cocreation_answers a WHERE a.submission_id=s.id AND a.adopted_at IS NOT NULL) adopted
      FROM web_cocreation_submissions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.created_at DESC,s.id DESC LIMIT ${PAGE + 1}`,
      ...args,
    );
    const page = rows.slice(0, PAGE);
    return {
      items: page.map((row) => ({
        id: row.id,
        characterId: row.character_id,
        createdAt: row.created_at,
        pseudonym: this.pseudonym(row.principal_id),
        answerCount: row.answers,
        adoptedCount: row.adopted,
        firstLine: this.firstAnswer(row.id),
        status: row.status,
        starred: row.starred === 1,
        hasNote: row.admin_note !== null && row.admin_note !== '',
      })),
      next: rows.length > PAGE ? { createdAt: page.at(-1)!.created_at, id: page.at(-1)!.id } : null,
    };
  }
  private firstAnswer(submissionId: string) {
    const first = this.store.get<AnswerRow>(
      'SELECT * FROM web_cocreation_answers WHERE submission_id=? ORDER BY ordinal LIMIT 1',
      submissionId,
    );
    return first ? firstLine(first) : '';
  }

  detail(auth: Auth, id: unknown) {
    this.actor(auth, 'cocreation.read');
    const row = this.row(id);
    // The invite batch name is the only provenance an administrator sees besides the pseudonym.
    const batch =
      this.store.get<{ batch: string }>(
        `SELECT c.batch FROM web_invite_grants g JOIN web_invite_codes c ON c.id=g.invite_id WHERE g.principal_id=?`,
        row.principal_id,
      )?.batch ?? null;
    return {
      id: row.id,
      characterId: row.character_id,
      createdAt: row.created_at,
      pseudonym: this.pseudonym(row.principal_id),
      batch,
      status: row.status,
      starred: row.starred === 1,
      adminNote: row.admin_note,
      processedAt: row.processed_at,
      answers: this.store
        .all<AnswerRow>('SELECT * FROM web_cocreation_answers WHERE submission_id=? ORDER BY ordinal', row.id)
        .map((answer) => {
          const value = answerValue(answer);
          return {
            ordinal: answer.ordinal,
            cardId: answer.card_id,
            targetField: answer.target_field,
            kind: answer.kind,
            ...(typeof value === 'string' ? { text: value } : { player: value.player, replies: value.replies }),
            adoptedAt: answer.adopted_at,
          };
        }),
    };
  }

  private setStatusRow(actorId: string, row: SubmissionRow, status: CocreationStatus) {
    const now = this.clock.now();
    this.store.run(
      `UPDATE web_cocreation_submissions SET status=?,
        processed_by=CASE WHEN ?='processed' THEN ? WHEN ?='new' THEN NULL ELSE processed_by END,
        processed_at=CASE WHEN ?='processed' THEN ? WHEN ?='new' THEN NULL ELSE processed_at END WHERE id=?`,
      status,
      status,
      actorId,
      status,
      status,
      now,
      status,
      row.id,
    );
    this.audit(actorId, `cocreation-status:${status}`, row.id);
  }

  /** One or many (bulk archive): all-or-nothing in one transaction. */
  setStatus(auth: Auth, ids: unknown, status: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    ensure(
      Array.isArray(ids) &&
        ids.length >= 1 &&
        ids.length <= BULK_LIMIT &&
        new Set(ids).size === ids.length &&
        ids.every(identifier),
      'INVALID_REQUEST',
    );
    ensure(typeof status === 'string' && STATUSES.includes(status), 'INVALID_REQUEST');
    return this.store.transaction(() => {
      const rows = (ids as string[]).map((id) => this.row(id));
      for (const row of rows) this.setStatusRow(actor.memberId, row, status as CocreationStatus);
      return { updated: rows.length, status };
    });
  }

  star(auth: Auth, id: unknown, starred: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    ensure(typeof starred === 'boolean', 'INVALID_REQUEST');
    return this.store.transaction(() => {
      const row = this.row(id);
      this.store.run('UPDATE web_cocreation_submissions SET starred=? WHERE id=?', starred ? 1 : 0, row.id);
      this.audit(actor.memberId, `cocreation-star:${starred ? 1 : 0}`, row.id);
      return { id: row.id, starred };
    });
  }

  note(auth: Auth, id: unknown, note: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    ensure(
      note === null ||
        (typeof note === 'string' &&
          [...note].length <= COCREATION_LIMITS.note &&
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(note)),
      'INVALID_REQUEST',
    );
    return this.store.transaction(() => {
      const row = this.row(id),
        text = typeof note === 'string' && note.trim() !== '' ? note : null;
      this.store.run('UPDATE web_cocreation_submissions SET admin_note=? WHERE id=?', text, row.id);
      this.audit(actor.memberId, 'cocreation-note', row.id);
      return { id: row.id, adminNote: text };
    });
  }

  /** Records that an administrator copied this answer into a draft; the first adoption also marks the submission processed. */
  markAdopted(auth: Auth, id: unknown, ordinal: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    ensure(Number.isSafeInteger(ordinal) && (ordinal as number) >= 0 && (ordinal as number) <= 11, 'INVALID_REQUEST');
    return this.store.transaction(() => {
      const row = this.row(id),
        answer = this.store.get<AnswerRow>(
          'SELECT * FROM web_cocreation_answers WHERE submission_id=? AND ordinal=?',
          row.id,
          ordinal as number,
        );
      ensure(answer, 'NOT_FOUND');
      const now = this.clock.now();
      this.store.run(
        'UPDATE web_cocreation_answers SET adopted_at=?,adopted_by=? WHERE submission_id=? AND ordinal=? AND adopted_at IS NULL',
        now,
        actor.memberId,
        row.id,
        answer.ordinal,
      );
      if (row.status !== 'processed') this.setStatusRow(actor.memberId, row, 'processed');
      this.audit(actor.memberId, `cocreation-adopted:${answer.ordinal}`, row.id);
      return { id: row.id, ordinal: answer.ordinal, status: 'processed' as const };
    });
  }
}
