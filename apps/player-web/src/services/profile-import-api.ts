import type {
  ImportChange,
  ImportCharacter,
  ImportFile,
  ImportPreview,
  ImportProblem,
  ImportResult,
  ProfileImportApi,
} from '../features/admin/profile-import/profile-import-view.ts';

/** Part 24j: 导入角色资料. Two calls: preview (writes nothing) and apply (one transaction, idempotent per request id). */
const invalid = () => new Error('ADMIN_PROFILE_IMPORT_PROTOCOL_INVALID');
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw invalid();
  return v;
};
const str = (v: unknown) => {
  if (typeof v !== 'string') throw invalid();
  return v;
};
const nullableStr = (v: unknown) => (v === null ? null : str(v));
const changes = (v: unknown): ImportChange[] =>
  list(v).map((raw) => {
    const r = object(raw);
    return { field: str(r.field), old: str(r.old), new: str(r.new) };
  });
const problems = (v: unknown): ImportProblem[] =>
  list(v).map((raw) => {
    const r = object(raw);
    if (r.item !== null && !Number.isSafeInteger(r.item)) throw invalid();
    return {
      code: str(r.code),
      file: str(r.file),
      section: nullableStr(r.section),
      field: nullableStr(r.field),
      item: r.item as number | null,
      text: str(r.text),
    };
  });
const MODES = ['new', 'existing', 'bind'] as const;

export class ProfileImportClient implements ProfileImportApi {
  private readonly send: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  constructor(send: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
    this.send = send;
  }
  async profileImportPreview(files: ImportFile[]): Promise<ImportPreview> {
    const r = object(await this.send('preview', { files }));
    if (typeof r.ok !== 'boolean' || typeof r.unchanged !== 'boolean') throw invalid();
    return {
      ok: r.ok,
      unchanged: r.unchanged,
      basis: r.basis,
      characters: list(r.characters).map((raw): ImportCharacter => {
        const c = object(raw);
        if (!(MODES as readonly unknown[]).includes(c.mode) || typeof c.unchanged !== 'boolean') throw invalid();
        return {
          file: str(c.file),
          code: str(c.code),
          mode: c.mode as ImportCharacter['mode'],
          name: str(c.name),
          changes: changes(c.changes),
          castChanges: changes(c.castChanges),
          checklist: list(c.checklist).map((item) => ({ key: str(object(item).key), text: str(object(item).text) })),
          unchanged: c.unchanged,
        };
      }),
      castChangeCount: Number(object(r).castChangeCount ?? 0),
      problems: problems(r.problems),
      warnings: problems(r.warnings),
    };
  }
  async profileImportApply(input: { requestId: string; files: ImportFile[]; basis: unknown }): Promise<ImportResult> {
    const r = object(await this.send('apply', input));
    if (typeof r.unchanged !== 'boolean') throw invalid();
    return {
      unchanged: r.unchanged,
      characters: list(r.characters).map((raw) => {
        const c = object(raw);
        return {
          code: str(c.code),
          mode: c.mode as ImportCharacter['mode'],
          changed: c.changed === true,
          revision: c.revision === null ? null : Number(c.revision),
        };
      }),
      castRevision: r.castRevision === null ? null : Number(r.castRevision),
    };
  }
}
