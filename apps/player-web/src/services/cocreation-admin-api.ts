import {
  COCREATION_TARGET_FIELDS,
  type CocreationTargetField,
} from '../../../../packages/contracts/cocreation-cards.ts';

export type InboxStatus = 'new' | 'processed' | 'archived';
/** Part 24c: a note about one character (the cards), to the production team (留言条) or about the story between two characters. */
export type InboxKind = 'character' | 'memo' | 'pair';
const kindOf = (v: unknown): InboxKind => {
  if (v === undefined) return 'character';
  if (v !== 'character' && v !== 'memo' && v !== 'pair') throw invalid();
  return v;
};
export type InboxItem = {
  id: string;
  characterId: string;
  /** Part 39: every member of a relation note (two to eight) in the console's order; absent on older notes. */
  memberIds?: string[];
  excluded?: boolean;
  decision?: 'adopted' | 'rejected' | null;
  /** Absent on a server before migration 131 (every note is a 'character' note then). */
  kind?: InboxKind;
  partnerId?: string | null;
  createdAt: number;
  pseudonym: string;
  answerCount: number;
  adoptedCount: number;
  firstLine: string;
  status: InboxStatus;
  starred: boolean;
  hasNote: boolean;
};
export type InboxAnswer = {
  ordinal: number;
  cardId: string;
  targetField: CocreationTargetField;
  kind: 'text' | 'dialogue';
  adoptedAt: number | null;
  /** Part 39b: the exact question the player was shown (theme answers only). */
  wording?: string;
} & ({ kind: 'text'; text: string } | { kind: 'dialogue'; player: string; replies: string[] });
export type InboxDetail = {
  id: string;
  characterId: string;
  /** Absent on a server before migration 131 (every note is a 'character' note then). */
  kind?: InboxKind;
  partnerId?: string | null;
  createdAt: number;
  pseudonym: string;
  batch: string | null;
  status: InboxStatus;
  starred: boolean;
  adminNote: string | null;
  processedAt: number | null;
  answers: InboxAnswer[];
};
export type InboxFilter = {
  characterId: string | null;
  status: InboxStatus | null;
  starred: boolean;
  query: string;
};
export type InboxCursor = { createdAt: number; id: string };

const invalid = () => new Error('ADMIN_COCREATION_PROTOCOL_INVALID');
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
};
const string = (v: unknown) => {
  if (typeof v !== 'string') throw invalid();
  return v;
};
const count = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid();
  return v as number;
};
const flag = (v: unknown) => {
  if (typeof v !== 'boolean') throw invalid();
  return v;
};
const status = (v: unknown) => {
  if (v !== 'new' && v !== 'processed' && v !== 'archived') throw invalid();
  return v;
};
const rows = (v: unknown) => {
  if (!Array.isArray(v)) throw invalid();
  return v as unknown[];
};
const item = (v: unknown): InboxItem => {
  const r = object(v);
  return {
    id: string(r.id),
    characterId: string(r.characterId),
    kind: kindOf(r.kind),
    partnerId: r.partnerId == null ? null : string(r.partnerId),
    ...(Array.isArray(r.memberIds) ? { memberIds: rows(r.memberIds).map(string) } : {}),
    ...(typeof r.excluded === 'boolean' ? { excluded: r.excluded } : {}),
    ...(r.decision === 'adopted' || r.decision === 'rejected' || r.decision === null
      ? { decision: r.decision as 'adopted' | 'rejected' | null }
      : {}),
    createdAt: count(r.createdAt),
    pseudonym: string(r.pseudonym),
    answerCount: count(r.answerCount),
    adoptedCount: count(r.adoptedCount),
    firstLine: string(r.firstLine),
    status: status(r.status),
    starred: flag(r.starred),
    hasNote: flag(r.hasNote),
  };
};
const answer = (v: unknown): InboxAnswer => {
  const r = object(v);
  const field = string(r.targetField);
  if (!(COCREATION_TARGET_FIELDS as readonly string[]).includes(field)) throw invalid();
  const base = {
    ordinal: count(r.ordinal),
    cardId: string(r.cardId),
    targetField: field as CocreationTargetField,
    adoptedAt: r.adoptedAt === null ? null : count(r.adoptedAt),
    ...(typeof r.wording === 'string' ? { wording: r.wording } : {}),
  };
  if (r.kind === 'text') return { ...base, kind: 'text', text: string(r.text) };
  if (r.kind === 'dialogue')
    return { ...base, kind: 'dialogue', player: string(r.player), replies: rows(r.replies).map(string) };
  throw invalid();
};

/** Shares the owning admin client's in-memory CSRF; never stores a credential. */
export class CocreationAdminClient {
  private readonly request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  constructor(request: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
    this.request = request;
  }
  /** New (unread) submissions per character, for the badge in the character workbench. */
  async counts(): Promise<Record<string, number>> {
    const counts = object(object(await this.request('counts', {})).counts);
    return Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, count(n)]));
  }
  async list(filter: InboxFilter, before: InboxCursor | null) {
    const r = object(
      await this.request('list', {
        characterId: filter.characterId,
        status: filter.status,
        starred: filter.starred ? true : null,
        query: filter.query.trim() === '' ? null : filter.query.trim(),
        before,
      }),
    );
    const next = r.next === null ? null : object(r.next);
    return {
      items: rows(r.items).map(item),
      next: next ? ({ createdAt: count(next.createdAt), id: string(next.id) } satisfies InboxCursor) : null,
    };
  }
  async detail(id: string): Promise<InboxDetail> {
    const r = object(await this.request('detail', { id }));
    return {
      id: string(r.id),
      characterId: string(r.characterId),
      kind: kindOf(r.kind),
      partnerId: r.partnerId == null ? null : string(r.partnerId),
      createdAt: count(r.createdAt),
      pseudonym: string(r.pseudonym),
      batch: r.batch === null ? null : string(r.batch),
      status: status(r.status),
      starred: flag(r.starred),
      adminNote: r.adminNote === null ? null : string(r.adminNote),
      processedAt: r.processedAt === null ? null : count(r.processedAt),
      answers: rows(r.answers).map(answer),
    };
  }
  async setStatus(ids: string[], next: InboxStatus) {
    const r = object(await this.request('set-status', { ids, status: next }));
    return { updated: count(r.updated), status: status(r.status) };
  }
  async star(id: string, starred: boolean) {
    flag(object(await this.request('star', { id, starred })).starred);
  }
  async note(id: string, note: string | null) {
    const r = object(await this.request('note', { id, note }));
    return r.adminNote === null ? null : string(r.adminNote);
  }
  async adopt(id: string, ordinal: number) {
    const r = object(await this.request('adopt', { id, ordinal }));
    return { ordinal: count(r.ordinal), status: status(r.status) };
  }
  /** Takes the adoption mark off an answer. Points already paid stay paid. */
  async unadopt(id: string, ordinal: number) {
    count(object(await this.request('unadopt', { id, ordinal })).ordinal);
  }
  /** 加入关系与故事: a pair note becomes a story of the cast draft (written at its current revision), never published. */
  async addToCastStory(id: string, ordinal: number) {
    const r = object(await this.request('cast-story', { id, ordinal }));
    return { ordinal: count(r.ordinal), castRevision: count(r.castRevision) };
  }
  /**
   * Part 55: 采纳 of one or many answers. The server merges each into its destination (a character's draft, or the cast draft for a
   * relation note) at the draft's CURRENT revision, marks it adopted and pays the author, in one transaction per answer. No
   * revision is sent. A refusal is named per item (`code`, and `fields` when a field was changed on both sides).
   */
  async adoptAnswers(items: AdoptItem[]): Promise<{ results: AdoptResult[]; adopted: number }> {
    const r = object(await this.request('adopt-answers', { items }));
    return {
      results: rows(r.results)
        .map(object)
        .map((entry) => ({
          id: string(entry.id),
          ordinal: count(entry.ordinal),
          ok: flag(entry.ok),
          ...(entry.duplicate === true ? { duplicate: true } : {}),
          ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
          ...(Array.isArray(entry.fields) ? { fields: entry.fields.map(string) } : {}),
        })),
      adopted: count(r.adopted),
    };
  }
}

/** Part 55: where an answer goes (absent = the default of its card). */
export type AdoptItem = {
  id: string;
  ordinal: number;
  destination?: { field: string; situation?: string; part?: string };
};
export type AdoptResult = {
  id: string;
  ordinal: number;
  ok: boolean;
  duplicate?: boolean;
  code?: string;
  fields?: string[];
};

// ---- Part 39: relation notes (two to eight characters) --------------------------------------------------------------------
export type RelationMatch =
  | { kind: 'join'; groupId: string; name: string; stories: number; inDraft: boolean }
  | { kind: 'new'; suggestedName: string };
export type RelationDetail = {
  id: string;
  /** In the console's order. */
  members: string[];
  ratings: { from: string; to: string; stars: number }[];
  reason: string | null;
  /** The text the administrator edits (an earlier edit, else what the player wrote). */
  text: string;
  originalText: string;
  excluded: boolean;
  decision: 'adopted' | 'rejected' | null;
  match: RelationMatch | null;
  /** The cast limit that would refuse an adoption right now, as its code (null: none). */
  blocked: string | null;
  castRevision: number | null;
};
export type RelationPairStat = {
  from: string;
  to: string;
  count: number;
  average: number | null;
  distribution: number[];
  gridValue: number | null;
};
export type RelationStats = { pairs: RelationPairStat[]; excludedSubmissions: number; order: string[] };
export type RelationAdopted = {
  id: string;
  groupId: string;
  joined: boolean;
  castRevision: number;
  duplicate: boolean;
};
export type TidyResult = { story: string; flags: string[] };

const match = (v: unknown): RelationMatch | null => {
  if (v === null) return null;
  const r = object(v);
  if (r.kind === 'join')
    return {
      kind: 'join',
      groupId: string(r.groupId),
      name: string(r.name),
      stories: count(r.stories),
      inDraft: flag(r.inDraft),
    };
  if (r.kind === 'new') return { kind: 'new', suggestedName: string(r.suggestedName) };
  throw invalid();
};
const stars = (v: unknown) => {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 5) throw invalid();
  return v as number;
};

export class CocreationRelationsClient {
  private readonly request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  constructor(request: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
    this.request = request;
  }
  /** Every character id in the console's order (首页顺序, then the rest by id). */
  async order(): Promise<string[]> {
    return rows(object(await this.request('relation/order', {})).order).map(string);
  }
  async detail(id: string): Promise<RelationDetail> {
    const r = object(await this.request('relation/detail', { id }));
    return {
      id: string(r.id),
      members: rows(r.members).map(string),
      ratings: rows(r.ratings).map((x) => {
        const e = object(x);
        return { from: string(e.from), to: string(e.to), stars: stars(e.stars) };
      }),
      reason: r.reason === null ? null : string(r.reason),
      text: string(r.text),
      originalText: string(r.originalText),
      excluded: flag(r.excluded),
      decision: r.decision === null ? null : (string(r.decision) as 'adopted' | 'rejected'),
      match: match(r.match),
      blocked: r.blocked === null ? null : string(r.blocked),
      castRevision: r.castRevision === null ? null : count(r.castRevision),
    };
  }
  async stats(): Promise<RelationStats> {
    const r = object(await this.request('relation/stats', {}));
    return {
      pairs: rows(r.pairs).map((x) => {
        const e = object(x);
        const distribution = rows(e.distribution).map(count);
        if (distribution.length !== 6) throw invalid();
        return {
          from: string(e.from),
          to: string(e.to),
          count: count(e.count),
          average: e.average === null ? null : Number(e.average),
          distribution,
          gridValue: e.gridValue === null ? null : Number(e.gridValue),
        };
      }),
      excludedSubmissions: count(r.excludedSubmissions),
      order: rows(r.order).map(string),
    };
  }
  async exclude(id: string, excluded: boolean) {
    flag(object(await this.request('relation/exclude', { id, excluded })).excluded);
  }
  async reject(id: string) {
    object(await this.request('relation/reject', { id }));
  }
  async adopt(input: {
    id: string;
    requestId: string;
    text: string;
    groupName: string | null;
  }): Promise<RelationAdopted> {
    const r = object(await this.request('relation/adopt', input));
    return {
      id: string(r.id),
      groupId: string(r.groupId),
      joined: flag(r.joined),
      castRevision: count(r.castRevision),
      duplicate: flag(r.duplicate),
    };
  }
  /** 整理: one budgeted call; the answer only fills the edit box. */
  async tidy(id: string, requestId: string): Promise<TidyResult> {
    const r = object(await this.request('relation/tidy', { id, requestId }));
    return { story: string(r.story), flags: rows(r.flags).map(string) };
  }
}

// ---- Part 39b: 题目, the wording pool ---------------------------------------------------------------------------------------
export type WordingEntry = {
  id: string;
  characterId: string;
  themeId: string;
  text: string;
  enabled: boolean;
  source: 'manual' | 'generated';
};
export type WordingPool = {
  themes: { id: string; label: string }[];
  /** Live characters in the console's order. */
  order: string[];
  entries: WordingEntry[];
};
export type WordingEstimate =
  | { ok: true; items: { characterId: string; estimateMicros: number }[]; totalMicros: number }
  | { ok: false; reason: string };
const wordingEntry = (v: unknown): WordingEntry => {
  const r = object(v);
  const source = string(r.source);
  if (source !== 'manual' && source !== 'generated') throw invalid();
  return {
    id: string(r.id),
    characterId: string(r.characterId),
    themeId: string(r.themeId),
    text: string(r.text),
    enabled: flag(r.enabled),
    source,
  };
};

export type WordingBulkResult = {
  enabled: boolean;
  switched: string[];
  unchanged: string[];
  failed: { id: string; code: string }[];
};
export class CocreationWordingsClient {
  private readonly request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  constructor(request: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
    this.request = request;
  }
  async list(): Promise<WordingPool> {
    const r = object(await this.request('wordings/list', {}));
    return {
      themes: rows(r.themes).map((t) => {
        const e = object(t);
        return { id: string(e.id), label: string(e.label) };
      }),
      order: rows(r.order).map(string),
      entries: rows(r.entries).map(wordingEntry),
    };
  }
  async add(input: { characterId: string; themeId: string; text: string; enabled: boolean; requestId: string }) {
    return wordingEntry(await this.request('wordings/add', input));
  }
  async edit(id: string, text: string) {
    return wordingEntry(await this.request('wordings/edit', { id, text }));
  }
  async toggle(id: string, enabled: boolean) {
    return wordingEntry(await this.request('wordings/toggle', { id, enabled }));
  }
  /** Part 44: 上线 / 下线 for a selection (online status only); says which ones switched, which already were so, which failed. */
  async setEnabled(ids: string[], enabled: boolean): Promise<WordingBulkResult> {
    const r = object(await this.request('wordings/set-enabled', { ids, enabled }));
    return {
      enabled: r.enabled === true,
      switched: rows(r.switched).map(string),
      unchanged: rows(r.unchanged).map(string),
      failed: rows(r.failed).map((x) => {
        const e = object(x);
        return { id: string(e.id), code: string(e.code) };
      }),
    };
  }
  async remove(id: string) {
    object(await this.request('wordings/delete', { id }));
  }
  /** What 生成 would hold: one line per character (console order) and the total; `characterIds: null` = every live character. */
  async estimate(characterIds: string[] | null): Promise<WordingEstimate> {
    const r = object(await this.request('wordings/estimate', { characterIds }));
    if (r.ok === false) return { ok: false, reason: string(r.reason) };
    return {
      ok: true,
      items: rows(r.items).map((x) => {
        const e = object(x);
        return { characterId: string(e.characterId), estimateMicros: count(e.estimateMicros) };
      }),
      totalMicros: count(r.totalMicros),
    };
  }
  /** 生成 for ONE character; the drafts land switched off. */
  async generate(input: { characterId: string; requestId: string; acknowledgeMicros: number }) {
    return { added: count(object(await this.request('wordings/generate', input)).added) };
  }
}
