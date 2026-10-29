import { createHash, createHmac } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import {
  COCREATION_LIMITS,
  COCREATION_MEMO_CARD,
  COCREATION_MEMO_CHARACTER,
  COCREATION_PAIR_NOTE_MAX,
  COCREATION_PAIR_CARD,
  cocreationCard,
  cocreationNoteOk,
  validateCocreationAnswers,
  type CocreationKind,
  type CocreationTargetField,
} from '../../../packages/contracts/cocreation-cards.ts';
import {
  hasCastPermission,
  hasCocreationPermission,
  type CocreationAdminPermission,
} from '../../../packages/contracts/web-admin-permissions.ts';
import { RetryAfterError, ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import type { WebIdentity } from '../identity/web-identity.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import { takeIpDaily } from '../admission/web-ip-daily.ts';
import { cocreationTablesExist } from './web-cocreation-purge.ts';
import { awardCocreationPoints, cocreationReceiver } from '../admin/web-points-admin.ts';
import { readDraft, saveDraft } from '../cast/cast-store.ts';
import {
  characterScope,
  cocreationPointsTablesExist,
  noteHash,
  pairScope,
  readCocreationPoints,
} from './web-cocreation-points.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
export type CocreationStatus = 'new' | 'processed' | 'archived';
export type CocreationSubmissionKind = 'character' | 'memo' | 'pair';
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
  /** Migration 131; rows of an older database are all 'character'. */
  kind?: CocreationSubmissionKind;
  partner_id?: string | null;
};
type AnswerRow = {
  ordinal: number;
  card_id: string;
  target_field: CocreationTargetField;
  kind: CocreationKind;
  text_json: string;
  adopted_at: number | null;
  adopt_paid?: number;
  paid_points?: number;
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
  private readonly identity: Pick<WebIdentity, 'authorizeWrite'>;
  private readonly admin: WebAccountAdmin;
  private readonly key: Buffer;
  private readonly id: () => string;
  constructor(
    store: BusinessStore,
    clock: Clock,
    identity: Pick<WebIdentity, 'authorizeWrite'>,
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
    /** The transport's keyed hash of the peer: the per-IP daily cap. Every transport passes it. */
    ipHash?: string,
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
      // Part 21f: any principal with a valid session may submit (guest, signed-up, account, invite). Guest sessions are
      // Turnstile-verified when they are created, exactly as for chat.
      const principal = this.identity.authorizeWrite(token, csrf, origin);
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
        return { submissionId: prior.id, answered: answers.length, duplicate: true, ...this.earnedOf(prior.id) };
      }
      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      // One answer per player per character per card per UTC day, counted from the existing rows. A submission that
      // contains any card already answered today is refused whole: nothing is written.
      const dayStart = Math.floor(now / COCREATION_LIMITS.dayMs) * COCREATION_LIMITS.dayMs;
      const untilTomorrow = Math.max(1, dayStart + COCREATION_LIMITS.dayMs - now);
      const answeredToday = this.cardsAnsweredToday(principal.principalId, characterId, dayStart);
      if (answers.some((answer) => answeredToday.has(answer.cardId)))
        throw new RetryAfterError('COCREATION_DAILY_LIMIT', untilTomorrow);
      // Anti-abuse: submissions per IP hash per UTC day (a submission row holds no address, so the counter is kept apart).
      if (
        ipHash !== undefined &&
        !takeIpDaily(this.store, 'cocreation', ipHash, dayStart, COCREATION_LIMITS.perIpPerDay)
      )
        throw new RetryAfterError('COCREATION_IP_LIMIT', untilTomorrow);
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
      // Part 24c: points for the notes, in this same transaction (a refused or rolled-back submission pays nothing).
      const notes = answers.map((answer) =>
        'text' in answer ? answer.text : [answer.player, ...answer.replies].join('\n'),
      );
      const earned = this.payNotes(principal.principalId, submissionId, characterScope(characterId), notes, now);
      return { submissionId, answered: answers.length, duplicate: false, ...(earned > 0 ? { earned } : {}) };
    });
  }

  /** The points a stored submission earned, as the `earned` member of its reply (absent when nothing was paid). */
  private earnedOf(submissionId: string) {
    if (!cocreationPointsTablesExist(this.store)) return {};
    const earned =
      this.store.get<{ n: number }>(
        'SELECT coalesce(sum(paid_points),0) n FROM web_cocreation_answers WHERE submission_id=?',
        submissionId,
      )?.n ?? 0;
    return earned > 0 ? { earned } : {};
  }

  /**
   * Part 24c: +notePoints per note, at most dailyCap PAID notes per player per UTC day, and only for a player on points (the population
   * 积分发放 grants to: reuse of its tier rule, its daily_refill cap and its event writer). A note beyond the cap is still stored, just
   * unpaid; an empty note or one the same player already wrote about the same character / pair earns nothing, silently. Records the
   * digest and the payment on each answer. Returns the points paid. The caller owns the transaction.
   */
  private payNotes(principalId: string, submissionId: string, scope: string, notes: string[], now: number) {
    if (!cocreationPointsTablesExist(this.store)) return 0;
    const settings = readCocreationPoints(this.store),
      dayStart = Math.floor(now / COCREATION_LIMITS.dayMs) * COCREATION_LIMITS.dayMs,
      receiver = cocreationReceiver(this.store, now, principalId);
    let paidToday =
        this.store.get<{ n: number }>(
          `SELECT count(*) n FROM web_cocreation_answers a JOIN web_cocreation_submissions s ON s.id=a.submission_id
          WHERE s.principal_id=? AND a.paid_points>0 AND s.created_at>=? AND s.created_at<?`,
          principalId,
          dayStart,
          dayStart + COCREATION_LIMITS.dayMs,
        )?.n ?? 0,
      earned = 0;
    notes.forEach((text, ordinal) => {
      const hash = noteHash(scope, text);
      const duplicate = !!this.store.get(
        `SELECT 1 FROM web_cocreation_answers a JOIN web_cocreation_submissions s ON s.id=a.submission_id
        WHERE s.principal_id=? AND a.note_hash=? LIMIT 1`,
        principalId,
        hash,
      );
      let paid = 0;
      if (receiver && !duplicate && text.trim() !== '' && settings.notePoints > 0 && paidToday < settings.dailyCap) {
        paid = awardCocreationPoints(
          this.store,
          now,
          principalId,
          'cocreation_note',
          settings.notePoints,
          `${submissionId}:${ordinal}`,
          null,
        );
        if (paid > 0) paidToday += 1;
      }
      this.store.run(
        'UPDATE web_cocreation_answers SET note_hash=?,paid_points=? WHERE submission_id=? AND ordinal=?',
        hash,
        paid,
        submissionId,
        ordinal,
      );
      earned += paid;
    });
    return earned;
  }

  /**
   * A 留言条 (to the production team, kind 'memo') or the story between two characters (kind 'pair'). Same session / CSRF / Origin,
   * request-id idempotency and per-IP daily cap as the cards; one answer holding the text. A memo is stored under the placeholder
   * character '_memo', is hashed for no duplicate check and NEVER earns points. A pair note earns like any note.
   */
  submitNote(
    token: string,
    csrf: string,
    origin: string,
    input: { kind: 'memo' | 'pair'; requestId: unknown; text: unknown; characterId?: unknown; partnerId?: unknown },
    ipHash?: string,
  ) {
    this.identity.authorizeWrite(token, csrf, origin);
    const memo = input.kind === 'memo';
    ensure(requestIdOk(input.requestId), 'INVALID_REQUEST');
    ensure(memo || (identifier(input.characterId) && identifier(input.partnerId)), 'INVALID_REQUEST');
    ensure(memo || input.characterId !== input.partnerId, 'INVALID_REQUEST');
    ensure(
      cocreationNoteOk(input.text) && (memo || [...input.text].length <= COCREATION_PAIR_NOTE_MAX),
      'COCREATION_TEXT_INVALID',
    );
    const requestId = input.requestId,
      text = input.text,
      characterId = memo ? COCREATION_MEMO_CHARACTER : (input.characterId as string),
      partnerId = memo ? null : (input.partnerId as string),
      hash = createHash('sha256')
        .update(JSON.stringify([input.kind, characterId, partnerId, text]))
        .digest('hex');
    return this.store.transaction(() => {
      ensure(cocreationTablesExist(this.store) && cocreationPointsTablesExist(this.store), 'COCREATION_UNAVAILABLE');
      const principal = this.identity.authorizeWrite(token, csrf, origin);
      if (!memo)
        for (const id of [characterId, partnerId!])
          ensure(
            this.store.get('SELECT 1 FROM web_character_catalog WHERE character_id=?', id) &&
              !webCharacterDeleted(this.store, id),
            'NOT_FOUND',
          );
      const prior = this.store.get<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM web_cocreation_submissions WHERE principal_id=? AND request_id=?',
        principal.principalId,
        requestId,
      );
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return { submissionId: prior.id, answered: 1, duplicate: true, ...this.earnedOf(prior.id) };
      }
      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      const dayStart = Math.floor(now / COCREATION_LIMITS.dayMs) * COCREATION_LIMITS.dayMs;
      if (
        ipHash !== undefined &&
        !takeIpDaily(this.store, 'cocreation-note', ipHash, dayStart, COCREATION_LIMITS.notePerIpPerDay)
      )
        throw new RetryAfterError('COCREATION_IP_LIMIT', Math.max(1, dayStart + COCREATION_LIMITS.dayMs - now));
      const submissionId = this.id();
      this.store.run(
        `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,kind,partner_id)
        VALUES (?,?,?,?,?,?,?,?)`,
        submissionId,
        characterId,
        principal.principalId,
        requestId,
        hash,
        now,
        input.kind,
        partnerId,
      );
      this.store.run(
        `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,0,?,'free','text',?)`,
        submissionId,
        memo ? COCREATION_MEMO_CARD : COCREATION_PAIR_CARD,
        JSON.stringify(text),
      );
      const earned = memo
        ? 0
        : this.payNotes(principal.principalId, submissionId, pairScope(characterId, partnerId!), [text], now);
      return { submissionId, answered: 1, duplicate: false, ...(earned > 0 ? { earned } : {}) };
    });
  }

  private cardsAnsweredToday(principalId: string, characterId: string, dayStart: number) {
    return new Set(
      this.store
        .all<{ card_id: string }>(
          `SELECT DISTINCT a.card_id FROM web_cocreation_answers a
          JOIN web_cocreation_submissions s ON s.id=a.submission_id
          WHERE s.principal_id=? AND s.character_id=? AND s.created_at>=? AND s.created_at<?`,
          principalId,
          characterId,
          dayStart,
          dayStart + COCREATION_LIMITS.dayMs,
        )
        .map((row) => row.card_id),
    );
  }

  /**
   * Which cards has this player already answered today for this character? Same session/CSRF/Origin checks as a
   * write, so the sheet can disable them before the player starts typing. Reads only this principal's own rows.
   */
  usedToday(token: string, csrf: string, origin: string, characterIdInput: unknown) {
    const principal = this.identity.authorizeWrite(token, csrf, origin);
    ensure(identifier(characterIdInput), 'INVALID_REQUEST');
    ensure(cocreationTablesExist(this.store), 'COCREATION_UNAVAILABLE');
    const dayStart = Math.floor(this.clock.now() / COCREATION_LIMITS.dayMs) * COCREATION_LIMITS.dayMs;
    return { cardIds: [...this.cardsAnsweredToday(principal.principalId, characterIdInput, dayStart)].sort() };
  }

  /**
   * The live numbers of points for notes, for the 获得点数 sheet of 我的信息. Same session / CSRF / Origin as a write; the numbers
   * are the same for everyone and name nobody. Without migration 131 there are none.
   */
  rewards(token: string, csrf: string, origin: string) {
    this.identity.authorizeWrite(token, csrf, origin);
    ensure(cocreationTablesExist(this.store) && cocreationPointsTablesExist(this.store), 'COCREATION_UNAVAILABLE');
    const { notePoints, dailyCap, adoptPoints } = readCocreationPoints(this.store);
    return { notePoints, dailyCap, adoptPoints };
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
      // A pair note is about both of its characters.
      if (this.hasKinds()) {
        where.push('(s.character_id=? OR s.partner_id=?)');
        args.push(input.characterId as string, input.characterId as string);
      } else {
        where.push('s.character_id=?');
        args.push(input.characterId as string);
      }
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
        ...this.kindOf(row),
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
  private hasKinds() {
    return cocreationPointsTablesExist(this.store);
  }
  /** `kind` and `partnerId` of a submission; a database before migration 131 only has character notes, and says nothing. */
  private kindOf(row: Pick<SubmissionRow, 'kind' | 'partner_id'>) {
    return row.kind === undefined ? {} : { kind: row.kind, partnerId: row.partner_id ?? null };
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
        `SELECT c.batch FROM web_entitlements e JOIN web_invite_codes c ON c.id=e.invite_id WHERE e.principal_id=?
        ORDER BY e.starts_at DESC LIMIT 1`,
        row.principal_id,
      )?.batch ?? null;
    return {
      id: row.id,
      characterId: row.character_id,
      ...this.kindOf(row),
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

  /**
   * Records that an administrator copied this answer into a draft or the cast; the first adoption also marks the submission processed
   * and (Part 24c) pays the author the adoption reward ONCE per note, in this same transaction: a second adoption, or an adoption after
   * an undo, pays nothing. A memo is adopted without a reward. Used by the draft route and by 加入关系与故事.
   */
  markAdopted(auth: Auth, id: unknown, ordinal: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    return this.store.transaction(() => this.adopt(actor.memberId, id, ordinal));
  }
  private adopt(actorId: string, id: unknown, ordinal: unknown) {
    ensure(Number.isSafeInteger(ordinal) && (ordinal as number) >= 0 && (ordinal as number) <= 11, 'INVALID_REQUEST');
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
      actorId,
      row.id,
      answer.ordinal,
    );
    if (row.status !== 'processed') this.setStatusRow(actorId, row, 'processed');
    this.audit(actorId, `cocreation-adopted:${answer.ordinal}`, row.id);
    if (answer.adopt_paid === 0 && row.kind !== undefined) {
      // The marker is set whether or not points are paid (a guest never gets them later), so the reward is for the first adoption only.
      this.store.run(
        'UPDATE web_cocreation_answers SET adopt_paid=1 WHERE submission_id=? AND ordinal=?',
        row.id,
        answer.ordinal,
      );
      if (row.kind !== 'memo')
        awardCocreationPoints(
          this.store,
          now,
          row.principal_id,
          'cocreation_adopted',
          readCocreationPoints(this.store).adoptPoints,
          `${row.id}:${answer.ordinal}`,
          actorId,
        );
    }
    return { id: row.id, ordinal: answer.ordinal, status: 'processed' as const };
  }

  /** Takes the adoption mark off an answer. Nothing already paid is taken back, and the reward is not paid again by adopting anew. */
  unadopt(auth: Auth, id: unknown, ordinal: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    ensure(Number.isSafeInteger(ordinal) && (ordinal as number) >= 0 && (ordinal as number) <= 11, 'INVALID_REQUEST');
    return this.store.transaction(() => {
      const row = this.row(id);
      const cleared = this.store.run(
        'UPDATE web_cocreation_answers SET adopted_at=NULL,adopted_by=NULL WHERE submission_id=? AND ordinal=? AND adopted_at IS NOT NULL',
        row.id,
        ordinal as number,
      );
      ensure(cleared.changes === 1, 'NOT_FOUND');
      this.audit(actor.memberId, `cocreation-unadopted:${ordinal as number}`, row.id);
      return { id: row.id, ordinal: ordinal as number };
    });
  }

  /**
   * 加入关系与故事: a pair note becomes a story of the cast DRAFT - the two characters as participants, the note as the summary.
   * Compare-and-swap on the cast draft revision the administrator looked at; a stale revision is refused and nothing (no story, no
   * adoption, no points) is written. Never publishes. Needs cocreation.manage and cast.edit.
   */
  addToCastStory(auth: Auth, id: unknown, ordinal: unknown, expectedRevision: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    ensure(
      actor.role === 'owner' || hasCastPermission(this.admin.session(auth.cookie).member.permissions, 'cast.edit'),
      'ADMIN_PERMISSION_REQUIRED',
    );
    ensure(Number.isSafeInteger(expectedRevision) && (expectedRevision as number) > 0, 'INVALID_REQUEST');
    return this.store.transaction(() => {
      const row = this.row(id);
      ensure(row.kind === 'pair' && row.partner_id, 'INVALID_REQUEST');
      const answer = this.store.get<AnswerRow>(
        'SELECT * FROM web_cocreation_answers WHERE submission_id=? AND ordinal=?',
        row.id,
        ordinal as number,
      );
      ensure(answer, 'NOT_FOUND');
      const draft = readDraft(this.store),
        name = (characterId: string) =>
          draft.doc.characters.find((entry) => entry.characterId === characterId)?.identity.names[0]?.text ??
          characterId;
      // The story is added to the draft the administrator saw; saveDraft refuses a draft that has moved on.
      const next = {
        ...draft.doc,
        stories: [
          ...draft.doc.stories,
          {
            title: [...`${name(row.character_id)}与${name(row.partner_id!)}`].slice(0, 30).join(''),
            summary: answerValue(answer) as string,
            details: '',
            period: { start: '', end: '' },
            participants: [row.character_id, row.partner_id!],
            boundary: '',
            overrides: [],
          },
        ],
      };
      const saved = saveDraft(this.store, this.clock.now(), expectedRevision, next);
      const adopted = this.adopt(actor.memberId, row.id, answer.ordinal);
      this.audit(actor.memberId, 'cocreation-cast-story', `${row.id}:${answer.ordinal};revision=${saved.revision}`);
      return { ...adopted, castRevision: saved.revision };
    });
  }
}
