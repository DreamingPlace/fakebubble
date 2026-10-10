import {
  COCREATION_TARGET_FIELDS,
  type CocreationTargetField,
} from '../../../../packages/contracts/cocreation-cards.ts';

export type InboxStatus = 'new' | 'processed' | 'archived';
export type InboxItem = {
  id: string;
  characterId: string;
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
} & ({ kind: 'text'; text: string } | { kind: 'dialogue'; player: string; replies: string[] });
export type InboxDetail = {
  id: string;
  characterId: string;
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
}
