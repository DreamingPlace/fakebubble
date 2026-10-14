/** 测试对话 (Part 19): the owner's read-only view of chat transcripts under an anonymous code. */
export type ReviewScope = 'live' | 'archived';
export type ReviewListRow = {
  label: string;
  characterId: string;
  code: string;
  archived: boolean;
  /** "YYYY-MM-DD": the day an archived transcript disappears. */
  expiresOn: string | null;
  messages: number;
  failed: number;
  firstAt: string;
  lastAt: string;
};
export type ReviewList = {
  rows: ReviewListRow[];
  page: number;
  pageSize: number;
  total: number;
  characters: { characterId: string; label: string }[];
};
export type ReviewLine = {
  n: number;
  time: string;
  speaker: 'player' | 'character' | 'proactive';
  text: string;
  status: 'ok' | 'failed';
  errorCode: string | null;
  reviewChanged: boolean;
};
export type ReviewDetail = {
  label: string;
  characterId: string;
  code: string;
  archived: boolean;
  expiresOn: string | null;
  total: number;
  page: number;
  pageSize: number;
  lines: ReviewLine[];
};
export type ReviewExport = { filename: string; lines: number; csv: string };
export type ReviewKey = { characterId: string; code: string; archived: boolean };

const invalid = () => new Error('ADMIN_CONVERSATIONS_PROTOCOL_INVALID');
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
const array = (v: unknown) => {
  if (!Array.isArray(v)) throw invalid();
  return v as unknown[];
};
const nullable = (v: unknown) => (v === null ? null : string(v));
const row = (v: unknown): ReviewListRow => {
  const r = object(v);
  return {
    label: string(r.label),
    characterId: string(r.characterId),
    code: string(r.code),
    archived: flag(r.archived),
    expiresOn: nullable(r.expiresOn),
    messages: count(r.messages),
    failed: count(r.failed),
    firstAt: string(r.firstAt),
    lastAt: string(r.lastAt),
  };
};
const line = (v: unknown): ReviewLine => {
  const r = object(v);
  const speaker = string(r.speaker),
    status = string(r.status);
  if (!['player', 'character', 'proactive'].includes(speaker) || !['ok', 'failed'].includes(status)) throw invalid();
  return {
    n: count(r.n),
    time: string(r.time),
    speaker: speaker as ReviewLine['speaker'],
    text: string(r.text),
    status: status as ReviewLine['status'],
    errorCode: nullable(r.errorCode),
    reviewChanged: flag(r.reviewChanged),
  };
};

export class ConversationsAdminClient {
  private readonly call: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  constructor(call: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
    this.call = call;
  }
  async list(input: { characterId: string | null; scope: ReviewScope | null; page: number }): Promise<ReviewList> {
    const r = object(await this.call('list', input));
    return {
      rows: array(r.rows).map(row),
      page: count(r.page),
      pageSize: count(r.pageSize),
      total: count(r.total),
      characters: array(r.characters).map((c) => {
        const o = object(c);
        return { characterId: string(o.characterId), label: string(o.label) };
      }),
    };
  }
  async detail(input: ReviewKey & { page: number }): Promise<ReviewDetail> {
    const r = object(await this.call('detail', input));
    return {
      label: string(r.label),
      characterId: string(r.characterId),
      code: string(r.code),
      archived: flag(r.archived),
      expiresOn: nullable(r.expiresOn),
      total: count(r.total),
      page: count(r.page),
      pageSize: count(r.pageSize),
      lines: array(r.lines).map(line),
    };
  }
  /** One conversation (key), or every conversation of a character (characterId only). */
  async export(input: ReviewKey | { characterId: string }): Promise<ReviewExport> {
    const r = object(
      await this.call(
        'export',
        'code' in input ? input : { characterId: input.characterId, code: null, archived: null },
      ),
    );
    return { filename: string(r.filename), lines: count(r.lines), csv: string(r.csv) };
  }
}
