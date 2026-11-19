import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { COCREATION_THEMES, COCREATION_THEME_IDS } from '../../../packages/contracts/cocreation-wordings.ts';
import {
  COCREATION_LIMITS,
  COCREATION_PAIR_CARD,
  cocreationNoteOk,
} from '../../../packages/contracts/cocreation-cards.ts';
import {
  RELATION_MAX_MEMBERS,
  RELATION_MIN_MEMBERS,
  RELATION_REASON_MAX,
  RELATION_TEXT_MAX,
} from '../../../packages/contracts/cocreation-relations.ts';
import { CAST_LIMITS, type CastDoc, type CastGroup } from '../../../packages/contracts/web-cast.ts';
import { hasCastPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { DetailedError, RetryAfterError, ensure } from '../../../packages/domain/errors.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import { takeIpDaily } from '../admission/web-ip-daily.ts';
import { castTablesExist, latestPublication, readDraft, saveDraft } from '../cast/cast-store.ts';
import { canonicalCastJson } from '../cast/cast-validation.ts';
import { consoleCharacterOrder, sortByConsoleOrder } from '../characters/web-character-order.ts';
import { publishedWebCharacters } from '../characters/web-character-catalog.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import type { WebIdentity } from '../identity/web-identity.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { cocreationTablesExist } from './web-cocreation-purge.ts';
import { cocreationPointsTablesExist, pairScope } from './web-cocreation-points.ts';
import { installCocreationRelations, relationTablesExist } from './web-cocreation-relations-schema.ts';
import type { TidyResult, WebCocreationTidy } from './web-cocreation-tidy.ts';
import { installCocreationWordings, wordingTablesExist } from './web-cocreation-wordings-schema.ts';
import { WordingPool } from './web-cocreation-wordings.ts';
import type { WebCocreationWordingGen } from './web-cocreation-wordings-gen.ts';
import { WebCocreation, identifier, requestIdOk, type Auth, type SubmissionRow } from './web-cocreation.ts';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const clip = (value: string, max: number) => [...value].slice(0, max).join('');
/** A group name: 1-30 UTF-16 units (the cast's own length rule), one line, no control characters. */
const groupNameOk = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= CAST_LIMITS.groupName &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);

type RelationRow = {
  submission_id: string;
  member_count: number;
  set_key: string;
  reason: string | null;
  excluded: number;
  edited_text: string | null;
  decision: 'adopted' | 'rejected' | null;
};
export type RelationMatch =
  | { kind: 'join'; groupId: string; name: string; stories: number; inDraft: boolean }
  | { kind: 'new'; suggestedName: string };

/**
 * Part 39: players' relation notes (two to eight characters) and everything the administrators do with them. Shared canon only: a
 * submission becomes a story of the cast DRAFT, never a player-private story, and the stars players give are opinions that are only
 * counted here, never written into the cast's ratings grid. Nothing here publishes; the administrator publishes the cast as before.
 */
export class WebCocreationRelations extends WebCocreation {
  private tidyService: WebCocreationTidy | null = null;
  private wordingGen: WebCocreationWordingGen | null = null;
  private readonly pool: WordingPool;
  constructor(
    store: BusinessStore,
    clock: Clock,
    identity: Pick<WebIdentity, 'authorizeWrite'>,
    admin: WebAccountAdmin,
    pseudonymKey: Buffer,
    nextId: () => string,
  ) {
    super(store, clock, identity, admin, pseudonymKey, nextId);
    // Part 39's tables (digest-checked; STOP WEB_COCREATION_RELATIONS_SCHEMA_MISMATCH).
    installCocreationRelations(store);
    // Part 39b's tables (digest-checked; STOP WEB_COCREATION_WORDINGS_SCHEMA_MISMATCH).
    installCocreationWordings(store);
    this.pool = new WordingPool(
      store,
      () => this.clock.now(),
      () => this.id(),
    );
  }
  enableWordingGen(gen: WebCocreationWordingGen) {
    this.wordingGen = gen;
  }
  enableTidy(tidy: WebCocreationTidy) {
    this.tidyService = tidy;
  }
  /** Whether the Part 39 tables exist (a database without the prerequisites simply has no relation notes). */
  relationsAvailable() {
    return relationTablesExist(this.store);
  }

  // ---- player ---------------------------------------------------------------------------------------------------

  /**
   * The world background of the latest cast DRAFT an administrator has SAVED (by editing or by importing a file), as plain text, and
   * nothing else of the cast: no story, meme, rating or hidden setting. A draft nobody has saved yet (updated_at 0) has none.
   * Same session / CSRF / Origin as any player write; the text is the same for everyone.
   */
  worldBackground(token: string, csrf: string, origin: string) {
    this.identity.authorizeWrite(token, csrf, origin);
    if (!castTablesExist(this.store)) return { background: null as string | null };
    const draft = readDraft(this.store);
    const text = draft.updatedAt > 0 ? draft.doc.world.background : '';
    return { background: text.trim() === '' ? null : text };
  }

  /**
   * Two to eight characters and a story. A pair also carries both directed ratings in whole stars (0-5) and a reason; a group carries
   * neither. Stored as a 'pair' submission (the kind column is fixed by migration 131) whose member set is in web_cocreation_members.
   * Idempotent per request id; at most one note per player per exact member set per UTC day; the existing per-IP cap of notes.
   */
  submitRelation(
    token: string,
    csrf: string,
    origin: string,
    input: { requestId: unknown; characterIds: unknown; ratings: unknown; reason: unknown; text: unknown },
    ipHash?: string,
  ) {
    this.identity.authorizeWrite(token, csrf, origin);
    ensure(requestIdOk(input.requestId), 'INVALID_REQUEST');
    ensure(
      Array.isArray(input.characterIds) &&
        input.characterIds.length >= RELATION_MIN_MEMBERS &&
        input.characterIds.length <= RELATION_MAX_MEMBERS &&
        new Set(input.characterIds).size === input.characterIds.length &&
        input.characterIds.every(identifier),
      'INVALID_REQUEST',
    );
    const given = input.characterIds as string[];
    ensure(cocreationNoteOk(input.text) && [...input.text].length <= RELATION_TEXT_MAX, 'COCREATION_TEXT_INVALID');
    const pair = given.length === 2;
    let ratings: { from: string; to: string; stars: number }[] = [];
    let reason: string | null = null;
    if (pair) {
      ensure(Array.isArray(input.ratings) && input.ratings.length === 2, 'INVALID_REQUEST');
      ratings = (input.ratings as unknown[]).map((raw) => {
        ensure(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_REQUEST');
        const entry = raw as Record<string, unknown>;
        ensure(Object.keys(entry).sort().join(',') === 'from,stars,to', 'INVALID_REQUEST');
        ensure(
          typeof entry.from === 'string' &&
            typeof entry.to === 'string' &&
            Number.isInteger(entry.stars) &&
            (entry.stars as number) >= 0 &&
            (entry.stars as number) <= 5,
          'COCREATION_RATING_INVALID',
        );
        return { from: entry.from as string, to: entry.to as string, stars: entry.stars as number };
      });
      ensure(
        ratings.some((r) => r.from === given[0] && r.to === given[1]) &&
          ratings.some((r) => r.from === given[1] && r.to === given[0]),
        'COCREATION_RATING_INVALID',
      );
      ensure(
        cocreationNoteOk(input.reason) && [...input.reason].length <= RELATION_REASON_MAX,
        'COCREATION_REASON_INVALID',
      );
      reason = input.reason;
    } else ensure(input.ratings === null && input.reason === null, 'INVALID_REQUEST');
    const requestId = input.requestId,
      text = input.text;
    return this.store.transaction(() => {
      ensure(
        cocreationTablesExist(this.store) && cocreationPointsTablesExist(this.store) && relationTablesExist(this.store),
        'COCREATION_UNAVAILABLE',
      );
      const principal = this.identity.authorizeWrite(token, csrf, origin);
      for (const id of given)
        ensure(
          this.store.get('SELECT 1 FROM web_character_catalog WHERE character_id=?', id) &&
            !webCharacterDeleted(this.store, id),
          'NOT_FOUND',
        );
      // The member set is stored (and hashed) in console order, so the same set in another click order is the same note.
      const members = sortByConsoleOrder(consoleCharacterOrder(this.store, given), given);
      const sortedRatings = [...ratings].sort(
        (a, b) => members.indexOf(a.from) - members.indexOf(b.from) || members.indexOf(a.to) - members.indexOf(b.to),
      );
      const hash = sha(['relation', members, sortedRatings, reason, text]);
      const prior = this.store.get<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM web_cocreation_submissions WHERE principal_id=? AND request_id=?',
        principal.principalId,
        requestId,
      );
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return { submissionId: prior.id, answered: 1, duplicate: true, ...this.earnedOfRelation(prior.id) };
      }
      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      const dayStart = Math.floor(now / COCREATION_LIMITS.dayMs) * COCREATION_LIMITS.dayMs;
      const untilTomorrow = Math.max(1, dayStart + COCREATION_LIMITS.dayMs - now);
      const setKey = [...members].sort().join('|');
      const sameDay = this.store.get(
        `SELECT 1 FROM web_cocreation_relations r JOIN web_cocreation_submissions s ON s.id=r.submission_id
        WHERE s.principal_id=? AND r.set_key=? AND s.created_at>=? AND s.created_at<? LIMIT 1`,
        principal.principalId,
        setKey,
        dayStart,
        dayStart + COCREATION_LIMITS.dayMs,
      );
      if (sameDay) throw new RetryAfterError('COCREATION_DAILY_LIMIT', untilTomorrow);
      if (
        ipHash !== undefined &&
        !takeIpDaily(this.store, 'cocreation-note', ipHash, dayStart, COCREATION_LIMITS.notePerIpPerDay)
      )
        throw new RetryAfterError('COCREATION_IP_LIMIT', untilTomorrow);
      const submissionId = this.id();
      this.store.run(
        `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,kind,partner_id)
        VALUES (?,?,?,?,?,?,'pair',?)`,
        submissionId,
        members[0]!,
        principal.principalId,
        requestId,
        hash,
        now,
        members[1]!,
      );
      this.store.run(
        `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,0,?,'free','text',?)`,
        submissionId,
        COCREATION_PAIR_CARD,
        JSON.stringify(text),
      );
      this.store.run(
        'INSERT INTO web_cocreation_relations(submission_id,member_count,set_key,reason) VALUES (?,?,?,?)',
        submissionId,
        members.length,
        setKey,
        reason,
      );
      members.forEach((id, position) =>
        this.store.run(
          'INSERT INTO web_cocreation_members(submission_id,position,character_id) VALUES (?,?,?)',
          submissionId,
          position,
          id,
        ),
      );
      for (const rating of sortedRatings)
        this.store.run(
          'INSERT INTO web_cocreation_ratings(submission_id,from_id,to_id,stars) VALUES (?,?,?,?)',
          submissionId,
          rating.from,
          rating.to,
          rating.stars,
        );
      const scope = pair ? pairScope(members[0]!, members[1]!) : `g:${setKey}`;
      const earned = this.payNotes(principal.principalId, submissionId, scope, [text], now);
      return { submissionId, answered: 1, duplicate: false, ...(earned > 0 ? { earned } : {}) };
    });
  }
  private earnedOfRelation(submissionId: string) {
    const earned =
      this.store.get<{ n: number }>(
        'SELECT coalesce(sum(paid_points),0) n FROM web_cocreation_answers WHERE submission_id=?',
        submissionId,
      )?.n ?? 0;
    return earned > 0 ? { earned } : {};
  }

  // ---- administrators -------------------------------------------------------------------------------------------

  private relation(submissionId: string) {
    return this.store.get<RelationRow>('SELECT * FROM web_cocreation_relations WHERE submission_id=?', submissionId);
  }
  /** The members of a submission in console order (a note from before Part 39 has the two characters on its row). */
  private membersOf(row: Pick<SubmissionRow, 'id' | 'character_id' | 'partner_id'>) {
    const stored = relationTablesExist(this.store)
      ? this.store
          .all<{ character_id: string }>(
            'SELECT character_id FROM web_cocreation_members WHERE submission_id=? ORDER BY position',
            row.id,
          )
          .map((m) => m.character_id)
      : [];
    const ids = stored.length ? stored : [row.character_id, ...(row.partner_id ? [row.partner_id] : [])];
    return sortByConsoleOrder(consoleCharacterOrder(this.store, ids), ids);
  }
  private castNames(ids: readonly string[], doc: CastDoc) {
    const published = new Map<string, string>();
    try {
      for (const c of publishedWebCharacters(this.store)) published.set(c.characterId, c.presentation.displayName);
    } catch {
      /* a catalog that cannot be read leaves the ids as the last resort */
    }
    return ids.map(
      (id) => doc.characters.find((c) => c.characterId === id)?.identity.names[0]?.text ?? published.get(id) ?? id,
    );
  }
  /** 加入：<group> when the draft (else the published cast) already has a group with EXACTLY these members; else 新建组合. */
  private matchGroup(
    members: readonly string[],
    draft: CastDoc,
    published: CastDoc | null,
    names: readonly string[],
  ): RelationMatch {
    const inDraft = draft.groups.find((g) => sameSet(g.members, members));
    if (inDraft)
      return { kind: 'join', groupId: inDraft.id, name: inDraft.name, stories: inDraft.stories.length, inDraft: true };
    const inPublished = published?.groups.find((g) => sameSet(g.members, members));
    if (inPublished)
      return {
        kind: 'join',
        groupId: inPublished.id,
        name: inPublished.name,
        stories: inPublished.stories.length,
        inDraft: false,
      };
    return {
      kind: 'new',
      suggestedName: clip(names.length === 2 ? `${names[0]}与${names[1]}` : names.join('、'), CAST_LIMITS.groupName),
    };
  }
  private relationContext(members: readonly string[]) {
    const draft = readDraft(this.store);
    const published = latestPublication(this.store)?.doc ?? null;
    const names = this.castNames(members, draft.doc);
    return { draft, published, names, match: this.matchGroup(members, draft.doc, published, names) };
  }
  /** Which cast limit would refuse the adoption right now (null: none), so the page can say so before the click. */
  private adoptBlock(match: RelationMatch, draft: CastDoc) {
    if (match.kind === 'join') {
      const group = draft.groups.find((g) => g.id === match.groupId);
      if (group && group.stories.length >= CAST_LIMITS.groupStories) return 'COCREATION_GROUP_STORIES_FULL';
      return null;
    }
    return draft.groups.length >= CAST_LIMITS.groups ? 'COCREATION_GROUPS_FULL' : null;
  }

  /** The inbox list; a relation note also carries all of its members (console order) and the administrator's marks on it. */
  override list(auth: Auth, input: Parameters<WebCocreation['list']>[1]) {
    const result = super.list(auth, input);
    if (!relationTablesExist(this.store)) return result;
    return {
      ...result,
      items: result.items.map((item) => {
        if (item.kind !== 'pair') return item;
        const rel = this.relation(item.id);
        return {
          ...item,
          memberIds: this.membersOf({
            id: item.id,
            character_id: item.characterId,
            partner_id: item.partnerId ?? null,
          }),
          excluded: rel?.excluded === 1,
          decision: rel?.decision ?? null,
        };
      }),
    };
  }

  /** The members, ratings, reason, text and the group match of one relation note, for the inbox. cocreation.read. */
  relationDetail(auth: Auth, id: unknown) {
    this.actor(auth, 'cocreation.read');
    const row = this.row(id);
    ensure(row.kind === 'pair', 'COCREATION_NOT_RELATION');
    const rel = relationTablesExist(this.store) ? this.relation(row.id) : undefined;
    const members = this.membersOf(row);
    const order = consoleCharacterOrder(this.store, members);
    const ratings = rel
      ? this.store
          .all<{ from_id: string; to_id: string; stars: number }>(
            'SELECT from_id,to_id,stars FROM web_cocreation_ratings WHERE submission_id=?',
            row.id,
          )
          .sort(
            (a, b) =>
              order.indexOf(a.from_id) - order.indexOf(b.from_id) || order.indexOf(a.to_id) - order.indexOf(b.to_id),
          )
          .map((r) => ({ from: r.from_id, to: r.to_id, stars: r.stars }))
      : [];
    const original = JSON.parse(
      this.store.get<{ text_json: string }>(
        'SELECT text_json FROM web_cocreation_answers WHERE submission_id=? AND ordinal=0',
        row.id,
      )?.text_json ?? '""',
    ) as string;
    const context = castTablesExist(this.store) ? this.relationContext(members) : null;
    return {
      id: row.id,
      members,
      ratings,
      reason: rel?.reason ?? null,
      text: rel?.edited_text ?? original,
      originalText: original,
      excluded: rel?.excluded === 1,
      decision: rel?.decision ?? null,
      match: context?.match ?? null,
      blocked: context ? this.adoptBlock(context.match, context.draft.doc) : null,
      castRevision: context?.draft.revision ?? null,
    };
  }

  /** The characters of the console in console order (live first), for every list of the co-creation pages. */
  consoleOrder(auth: Auth) {
    this.actor(auth, 'cocreation.read');
    return { order: consoleCharacterOrder(this.store) };
  }

  /** 不计入 / 计入: spam control. The ratings of the submission leave (or re-enter) the statistics; the story is not touched. */
  setExcluded(auth: Auth, id: unknown, excluded: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    ensure(typeof excluded === 'boolean', 'INVALID_REQUEST');
    return this.store.transaction(() => {
      const row = this.row(id);
      ensure(row.kind === 'pair' && relationTablesExist(this.store), 'COCREATION_NOT_RELATION');
      this.ensureRelationRow(row);
      this.store.run(
        'UPDATE web_cocreation_relations SET excluded=?,excluded_by=?,excluded_at=? WHERE submission_id=?',
        excluded ? 1 : 0,
        excluded ? actor.memberId : null,
        excluded ? this.clock.now() : null,
        row.id,
      );
      this.audit(actor.memberId, `cocreation-excluded:${excluded ? 1 : 0}`, row.id);
      return { id: row.id, excluded };
    });
  }
  /** A note from before Part 39 has no relation row; the first mark an administrator sets creates it (same member set, no ratings). */
  private ensureRelationRow(row: SubmissionRow) {
    if (this.relation(row.id)) return;
    const members = this.membersOf(row);
    this.store.run(
      'INSERT INTO web_cocreation_relations(submission_id,member_count,set_key,reason) VALUES (?,?,?,NULL)',
      row.id,
      members.length,
      [...members].sort().join('|'),
    );
    members.forEach((character, position) =>
      this.store.run(
        'INSERT OR IGNORE INTO web_cocreation_members(submission_id,position,character_id) VALUES (?,?,?)',
        row.id,
        position,
        character,
      ),
    );
  }

  /** 不采纳: the note is archived and marked rejected. Its ratings stay in the statistics (use 不计入 for that). Idempotent. */
  rejectRelation(auth: Auth, id: unknown) {
    const actor = this.actor(auth, 'cocreation.manage');
    return this.store.transaction(() => {
      const row = this.row(id);
      ensure(row.kind === 'pair' && relationTablesExist(this.store), 'COCREATION_NOT_RELATION');
      this.ensureRelationRow(row);
      const rel = this.relation(row.id)!;
      ensure(rel.decision !== 'adopted', 'COCREATION_ALREADY_DECIDED');
      if (rel.decision !== 'rejected') {
        this.store.run(
          "UPDATE web_cocreation_relations SET decision='rejected',decided_by=?,decided_at=? WHERE submission_id=?",
          actor.memberId,
          this.clock.now(),
          row.id,
        );
        this.audit(actor.memberId, 'cocreation-rejected', row.id);
      }
      if (row.status !== 'archived') {
        this.store.run("UPDATE web_cocreation_submissions SET status='archived' WHERE id=?", row.id);
        this.audit(actor.memberId, 'cocreation-status:archived', row.id);
      }
      return { id: row.id, decision: 'rejected' as const };
    });
  }

  /**
   * 采纳: the STORY (the administrator's edited text) is written into the cast DRAFT, to the group with exactly these members or to a
   * new group with them. It never touches the ratings grid and never publishes. Idempotent per request id; compare-and-swap on the
   * draft revision the administrator looked at; refused with its own code when a cast limit would be exceeded (nothing is written).
   * Pays the existing adoption points once. Needs cocreation.manage and cast.edit.
   */
  adoptRelation(
    auth: Auth,
    input: { id: unknown; requestId: unknown; expectedRevision: unknown; text: unknown; groupName: unknown },
  ) {
    const actor = this.actor(auth, 'cocreation.manage');
    ensure(
      actor.role === 'owner' || hasCastPermission(this.admin.session(auth.cookie).member.permissions, 'cast.edit'),
      'ADMIN_PERMISSION_REQUIRED',
    );
    ensure(identifier(input.id) && requestIdOk(input.requestId), 'INVALID_REQUEST');
    ensure(Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) > 0, 'INVALID_REQUEST');
    ensure(input.groupName === null || typeof input.groupName === 'string', 'INVALID_REQUEST');
    ensure(typeof input.text === 'string' && cocreationNoteOk(input.text), 'COCREATION_TEXT_INVALID');
    ensure([...input.text].length <= CAST_LIMITS.storySummary, 'COCREATION_STORY_TOO_LONG');
    const text = input.text,
      requestId = input.requestId,
      expectedRevision = input.expectedRevision as number,
      groupName = input.groupName as string | null;
    const hash = sha(['adopt-relation', input.id, text, groupName, expectedRevision]);
    return this.store.transaction(() => {
      ensure(relationTablesExist(this.store) && castTablesExist(this.store), 'COCREATION_UNAVAILABLE');
      const prior = this.store.get<{
        request_hash: string;
        submission_id: string;
        group_id: string;
        created_group: number;
        cast_revision: number;
      }>('SELECT * FROM web_cocreation_adoptions WHERE request_id=?', requestId);
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return {
          id: prior.submission_id,
          status: 'processed' as const,
          groupId: prior.group_id,
          joined: prior.created_group === 0,
          castRevision: prior.cast_revision,
          duplicate: true,
        };
      }
      const row = this.row(input.id);
      ensure(row.kind === 'pair', 'COCREATION_NOT_RELATION');
      this.ensureRelationRow(row);
      ensure(this.relation(row.id)!.decision !== 'adopted', 'COCREATION_ALREADY_DECIDED');
      const members = this.membersOf(row);
      const { draft, match, names } = this.relationContext(members);
      if (draft.revision !== expectedRevision)
        throw new DetailedError('CAST_REVISION_CONFLICT', { currentRevision: draft.revision });
      const block = this.adoptBlock(match, draft.doc);
      ensure(block === null, block ?? '');
      const title = clip(names.length === 2 ? `${names[0]}与${names[1]}` : names.join('、'), CAST_LIMITS.storyTitle);
      const story = {
        title,
        summary: text,
        details: '',
        period: { start: '', end: '' },
        boundary: '',
      };
      let groups: CastGroup[];
      let created = false;
      const target = match.kind === 'join' ? draft.doc.groups.find((g) => g.id === match.groupId) : undefined;
      if (target) {
        groups = draft.doc.groups.map((g) => (g === target ? { ...g, stories: [...g.stories, story as never] } : g));
      } else {
        const name = match.kind === 'join' ? match.name : (groupName ?? match.suggestedName);
        ensure(groupNameOk(name), 'COCREATION_GROUP_NAME_INVALID');
        groups = [
          ...draft.doc.groups,
          { id: '', name, members: [...members], background: '', stories: [story as never] } as unknown as CastGroup,
        ];
        created = true;
      }
      const next: CastDoc = { ...draft.doc, groups };
      ensure(canonicalCastJson(next).length <= CAST_LIMITS.docMax, 'COCREATION_CAST_DOC_FULL');
      const saved = saveDraft(this.store, this.clock.now(), expectedRevision, next);
      const after = readDraft(this.store).doc.groups.find((g) => sameSet(g.members, members));
      ensure(after, 'COCREATION_UNAVAILABLE');
      const now = this.clock.now();
      this.store.run(
        `INSERT INTO web_cocreation_adoptions(request_id,request_hash,submission_id,group_id,created_group,cast_revision,actor_id,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        requestId,
        hash,
        row.id,
        after.id,
        created ? 1 : 0,
        saved.revision,
        actor.memberId,
        now,
      );
      const original = JSON.parse(
        this.store.get<{ text_json: string }>(
          'SELECT text_json FROM web_cocreation_answers WHERE submission_id=? AND ordinal=0',
          row.id,
        )!.text_json,
      ) as string;
      this.store.run(
        "UPDATE web_cocreation_relations SET decision='adopted',decided_by=?,decided_at=?,edited_text=? WHERE submission_id=?",
        actor.memberId,
        now,
        text === original ? null : text,
        row.id,
      );
      this.adopt(actor.memberId, row.id, 0);
      this.audit(actor.memberId, 'cocreation-cast-group-story', `${row.id};revision=${saved.revision}`);
      return {
        id: row.id,
        status: 'processed' as const,
        groupId: after.id,
        joined: !created,
        castRevision: saved.revision,
        duplicate: false,
      };
    });
  }

  /**
   * 玩家眼中的关系: for every DIRECTED pair players have rated: how many ratings, the average and the distribution 0-5, next to the
   * administrator's current grid value (the cast draft), in console order. Computed from the submissions, so a purged player's
   * ratings are gone and a submission marked 不计入 does not count. Counts only: nobody is named.
   */
  relationStats(auth: Auth) {
    this.actor(auth, 'cocreation.read');
    if (!relationTablesExist(this.store))
      return { pairs: [], excludedSubmissions: 0, order: consoleCharacterOrder(this.store) };
    const rows = this.store.all<{ from_id: string; to_id: string; stars: number; n: number }>(
      `SELECT r.from_id,r.to_id,r.stars,count(*) n FROM web_cocreation_ratings r
      JOIN web_cocreation_relations x ON x.submission_id=r.submission_id WHERE x.excluded=0
      GROUP BY r.from_id,r.to_id,r.stars`,
    );
    const grid = castTablesExist(this.store) ? readDraft(this.store).doc.ratings : {};
    const byPair = new Map<string, { from: string; to: string; distribution: number[] }>();
    for (const r of rows) {
      const key = `${r.from_id}\u0000${r.to_id}`;
      const found = byPair.get(key) ?? { from: r.from_id, to: r.to_id, distribution: [0, 0, 0, 0, 0, 0] };
      found.distribution[r.stars] = r.n;
      byPair.set(key, found);
    }
    const ids = [...new Set([...byPair.values()].flatMap((p) => [p.from, p.to]))];
    const order = consoleCharacterOrder(this.store, ids);
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : 1e9);
    const pairs = [...byPair.values()]
      .sort((a, b) => rank(a.from) - rank(b.from) || rank(a.to) - rank(b.to))
      .map((p) => {
        const count = p.distribution.reduce((s, n) => s + n, 0);
        const sum = p.distribution.reduce((s, n, stars) => s + n * stars, 0);
        const value = grid[p.from]?.[p.to];
        return {
          from: p.from,
          to: p.to,
          count,
          average: count ? Math.round((sum / count) * 100) / 100 : null,
          distribution: p.distribution,
          gridValue: typeof value === 'number' ? value : null,
        };
      });
    const excludedSubmissions =
      this.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_relations WHERE excluded=1')?.n ?? 0;
    return { pairs, excludedSubmissions, order };
  }

  /** 整理 (optional, the administrator clicks it): the tidied story for the edit box. One budgeted call; see web-cocreation-tidy.ts. */
  async tidy(auth: Auth, input: { id: unknown; requestId: unknown }): Promise<TidyResult> {
    this.actor(auth, 'cocreation.manage');
    ensure(identifier(input.id) && requestIdOk(input.requestId), 'INVALID_REQUEST');
    ensure(this.tidyService && relationTablesExist(this.store), 'COCREATION_TIDY_UNAVAILABLE');
    const tidy = this.tidyService;
    const row = this.row(input.id);
    ensure(row.kind === 'pair', 'COCREATION_NOT_RELATION');
    const rel = relationTablesExist(this.store) ? this.relation(row.id) : undefined;
    const members = this.membersOf(row);
    const { draft, match, names } = this.relationContext(members);
    const original = JSON.parse(
      this.store.get<{ text_json: string }>(
        'SELECT text_json FROM web_cocreation_answers WHERE submission_id=? AND ordinal=0',
        row.id,
      )?.text_json ?? '""',
    ) as string;
    const group = match.kind === 'join' ? draft.doc.groups.find((g) => g.id === match.groupId) : undefined;
    const content = {
      members: names,
      text: original,
      reason: rel?.reason ?? '',
      world: draft.doc.world.background,
      canon: (group?.stories ?? []).map((s) => `${s.title}：${s.summary}`),
    };
    const authorize = () => {
      const current = this.actor(auth, 'cocreation.manage') as { memberId: string; sessionId: string };
      return { memberId: current.memberId, sessionId: current.sessionId };
    };
    return tidy.tidy(authorize, { submissionId: row.id, requestId: input.requestId as string, content });
  }

  // ---- Part 39b: the wording pool ---------------------------------------------------------------------------------------

  /** Whether the pool exists (a database without the prerequisites has none: the sheet uses the plain defaults). */
  wordingsAvailable() {
    return wordingTablesExist(this.store);
  }
  /**
   * The enabled wordings of one character per theme (text only), for the player's sheet. Same session / CSRF / Origin as any player write;
   * the same for everyone. Without the pool every theme is empty (the sheet shows the plain defaults).
   */
  playerWordings(token: string, csrf: string, origin: string, characterId: unknown) {
    this.identity.authorizeWrite(token, csrf, origin);
    ensure(identifier(characterId), 'INVALID_REQUEST');
    ensure(
      this.store.get('SELECT 1 FROM web_character_catalog WHERE character_id=?', characterId) &&
        !webCharacterDeleted(this.store, characterId),
      'NOT_FOUND',
    );
    const themes = this.wordingsAvailable()
      ? this.pool.enabled(characterId)
      : Object.fromEntries(COCREATION_THEME_IDS.map((id) => [id, [] as string[]]));
    return { themes };
  }
  private wordingActor(auth: Auth, permission: 'cocreation.read' | 'cocreation.manage') {
    const actor = this.actor(auth, permission);
    ensure(wordingTablesExist(this.store), 'COCREATION_UNAVAILABLE');
    return actor;
  }
  /** 「题目」: every wording of every live character, characters in console order. cocreation.read. */
  wordingList(auth: Auth) {
    this.wordingActor(auth, 'cocreation.read');
    return { themes: COCREATION_THEMES.map(({ id, label }) => ({ id, label })), ...this.pool.all() };
  }
  wordingAdd(
    auth: Auth,
    input: { characterId: unknown; themeId: unknown; text: unknown; enabled: unknown; requestId: unknown },
  ) {
    const actor = this.wordingActor(auth, 'cocreation.manage');
    return this.store.transaction(() => {
      const added = this.pool.add(input);
      this.audit(actor.memberId, 'cocreation-wording-add', added.id);
      return added;
    });
  }
  wordingEdit(auth: Auth, input: { id: unknown; text: unknown }) {
    const actor = this.wordingActor(auth, 'cocreation.manage');
    return this.store.transaction(() => {
      const edited = this.pool.edit(input.id, input.text);
      this.audit(actor.memberId, 'cocreation-wording-edit', edited.id);
      return edited;
    });
  }
  wordingToggle(auth: Auth, input: { id: unknown; enabled: unknown }) {
    const actor = this.wordingActor(auth, 'cocreation.manage');
    return this.store.transaction(() => {
      const set = this.pool.setEnabled(input.id, input.enabled);
      this.audit(actor.memberId, set.enabled ? 'cocreation-wording-on' : 'cocreation-wording-off', set.id);
      return set;
    });
  }
  wordingDelete(auth: Auth, input: { id: unknown }) {
    const actor = this.wordingActor(auth, 'cocreation.manage');
    return this.store.transaction(() => {
      const gone = this.pool.remove(input.id);
      this.audit(actor.memberId, 'cocreation-wording-delete', gone.id);
      return gone;
    });
  }
  /** What a 生成 would hold: one line per character (console order) and the total, or why not. cocreation.manage. */
  wordingEstimate(auth: Auth, input: { characterIds: unknown }) {
    this.wordingActor(auth, 'cocreation.manage');
    const gen = this.wordingGen;
    if (!gen) return { ok: false as const, reason: 'UNAVAILABLE' };
    const ids = this.generationTargets(input.characterIds);
    const items: { characterId: string; estimateMicros: number }[] = [];
    for (const id of ids) {
      const estimate = gen.estimate(this.generationContent(id));
      if (!estimate.ok) return { ok: false as const, reason: estimate.reason };
      items.push({ characterId: id, estimateMicros: estimate.estimateMicros });
    }
    return { ok: true as const, items, totalMicros: items.reduce((sum, item) => sum + item.estimateMicros, 0) };
  }
  private generationTargets(characterIds: unknown) {
    const live = consoleCharacterOrder(this.store).filter((id) => this.pool.characterOk(id));
    if (characterIds === null) return live;
    ensure(
      Array.isArray(characterIds) &&
        characterIds.length >= 1 &&
        characterIds.length <= 64 &&
        characterIds.every(identifier),
      'INVALID_REQUEST',
    );
    const wanted = new Set(characterIds as string[]);
    ensure(
      [...wanted].every((id) => live.includes(id)),
      'NOT_FOUND',
    );
    return live.filter((id) => wanted.has(id));
  }
  private generationContent(characterId: string) {
    const draft = castTablesExist(this.store) ? readDraft(this.store).doc : null;
    const cast = draft?.characters.find((c) => c.characterId === characterId);
    const [name] = this.castNames([characterId], draft ?? ({ characters: [] } as unknown as CastDoc));
    return {
      name: name ?? characterId,
      personality: cast?.personality ?? '',
      existing: this.pool.forCharacter(characterId).map((e) => e.text),
    };
  }
  /** 生成 for ONE character (「全部生成」 calls it once per character). Drafts land switched off. cocreation.manage. */
  async wordingGenerate(
    auth: Auth,
    input: { characterId: unknown; requestId: unknown; acknowledgeMicros: unknown },
  ): Promise<{ added: number }> {
    this.wordingActor(auth, 'cocreation.manage');
    ensure(identifier(input.characterId) && requestIdOk(input.requestId), 'INVALID_REQUEST');
    ensure(Number.isSafeInteger(input.acknowledgeMicros) && (input.acknowledgeMicros as number) > 0, 'INVALID_REQUEST');
    const gen = this.wordingGen;
    ensure(gen, 'COCREATION_WORDINGS_UNAVAILABLE');
    const characterId = input.characterId as string,
      requestId = input.requestId as string;
    ensure(this.pool.characterOk(characterId), 'NOT_FOUND');
    const authorize = () => {
      const current = this.actor(auth, 'cocreation.manage') as { memberId: string; sessionId: string };
      return { memberId: current.memberId, sessionId: current.sessionId };
    };
    return gen.generate(authorize, {
      characterId,
      requestId,
      acknowledgeMicros: input.acknowledgeMicros as number,
      content: this.generationContent(characterId),
      land: (drafts) => this.pool.landDrafts(characterId, requestId, drafts),
    });
  }
}
