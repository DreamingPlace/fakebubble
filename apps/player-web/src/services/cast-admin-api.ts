import type {
  CastDoc,
  CastIssue,
  CastKnowledge,
  CastRequestContext,
  CastValidation,
} from '../../../../packages/contracts/web-cast.ts';
import { InviteLocalApiError } from './invite-local-api.ts';

/** Client for 关系与故事 (the Part 24a cast API). Requests go through the admin session; the server checks every permission. */
export type CastCounts = { characters: number; people: number; groups: number; stories: number; memes: number };
export type CastDraftResult = {
  revision: number;
  digest: string;
  updatedAt: number;
  doc: CastDoc;
  counts: CastCounts;
  validation: CastValidation;
};
export type CastVersion = {
  version: number;
  kind: 'publish' | 'rollback';
  fromVersion: number | null;
  digest: string;
  publishedAt: number;
  counts: CastCounts;
};
export type CastVersionsResult = { versions: CastVersion[]; latest: number | null };
export type CastSaveResult = { revision: number; digest: string; counts: CastCounts; validation: CastValidation };
export type CastPublishResult = {
  version: number;
  digest: string;
  kind: 'publish' | 'rollback';
  fromVersion: number | null;
  counts: CastCounts;
  warnings: number;
};
export type CastKnowledgeRow = { storyId: string; level: CastKnowledge; fromOverride: boolean };
export type CastCompilePreviewResult = {
  source: { kind: 'draft'; revision: number } | { kind: 'published'; version: number };
  size: number;
  view: CastRequestContext['view'];
  knowledge: CastKnowledgeRow[];
  dropOrder: readonly string[];
};
export type CastRequest = (path: string, body: Record<string, unknown>) => Promise<unknown>;

const invalid = () => new Error('ADMIN_CAST_PROTOCOL_INVALID');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const int = (value: unknown) => {
  if (!Number.isSafeInteger(value)) throw invalid();
  return value as number;
};
const validation = (value: unknown): CastValidation => {
  const v = object(value);
  if (!Array.isArray(v.errors) || !Array.isArray(v.warnings)) throw invalid();
  return { errors: v.errors as CastIssue[], warnings: v.warnings as CastIssue[] };
};
const counts = (value: unknown): CastCounts => {
  const c = object(value);
  return {
    characters: int(c.characters),
    people: int(c.people),
    groups: int(c.groups),
    stories: int(c.stories),
    memes: int(c.memes),
  };
};

/** The issues a CAST_INVALID / CAST_PUBLISH_BLOCKED answer carries: codes and id paths, never content. */
export function castIssues(error: unknown): CastIssue[] {
  if (!(error instanceof InviteLocalApiError)) return [];
  const issues = (error.detail as { issues?: unknown } | undefined)?.issues;
  return Array.isArray(issues)
    ? issues.filter((i): i is CastIssue => !!i && typeof i.code === 'string' && typeof i.path === 'string')
    : [];
}

export class CastAdminClient {
  private readonly send: CastRequest;
  private readonly newId: () => string;
  constructor(send: CastRequest, newId: () => string = () => globalThis.crypto.randomUUID()) {
    this.send = send;
    this.newId = newId;
  }
  async draft(): Promise<CastDraftResult> {
    const r = object(await this.send('draft', {}));
    return {
      revision: int(r.revision),
      digest: String(r.digest),
      updatedAt: int(r.updatedAt),
      doc: object(r.doc) as unknown as CastDoc,
      counts: counts(r.counts),
      validation: validation(r.validation),
    };
  }
  async versions(): Promise<CastVersionsResult> {
    const r = object(await this.send('versions', {}));
    if (!Array.isArray(r.versions)) throw invalid();
    return {
      versions: r.versions.map((raw) => {
        const v = object(raw);
        return {
          version: int(v.version),
          kind: v.kind === 'rollback' ? 'rollback' : 'publish',
          fromVersion: v.fromVersion === null ? null : int(v.fromVersion),
          digest: String(v.digest),
          publishedAt: int(v.publishedAt),
          counts: counts(v.counts),
        };
      }),
      latest: r.latest === null ? null : int(r.latest),
    };
  }
  async validate(): Promise<{ revision: number; validation: CastValidation }> {
    const r = object(await this.send('validate', {}));
    return { revision: int(r.revision), validation: validation(r.validation) };
  }
  async compilePreview(characterId: string, source: 'draft' | 'published'): Promise<CastCompilePreviewResult> {
    const r = object(await this.send('compile-preview', { characterId, source }));
    if (!Array.isArray(r.knowledge)) throw invalid();
    return {
      source: object(r.source) as CastCompilePreviewResult['source'],
      size: int(r.size),
      view: object(r.view) as unknown as CastCompilePreviewResult['view'],
      knowledge: r.knowledge as CastKnowledgeRow[],
      dropOrder: Array.isArray(r.dropOrder) ? (r.dropOrder as string[]) : [],
    };
  }
  /** `requestId` is fixed by the caller so a lost answer can be retried as the same request. */
  async save(expectedRevision: number, doc: CastDoc, requestId = this.newId()): Promise<CastSaveResult> {
    const r = object(await this.send('save', { requestId, expectedRevision, doc }));
    return {
      revision: int(r.revision),
      digest: String(r.digest),
      counts: counts(r.counts),
      validation: validation(r.validation),
    };
  }
  async publish(expectedRevision: number, requestId = this.newId()): Promise<CastPublishResult> {
    return publishResult(await this.send('publish', { requestId, expectedRevision }));
  }
  async rollback(version: number, requestId = this.newId()): Promise<CastPublishResult> {
    return publishResult(await this.send('rollback', { requestId, version }));
  }
  async importLegacy(expectedRevision: number, requestId = this.newId()): Promise<CastSaveResult> {
    const r = object(await this.send('import-legacy', { requestId, expectedRevision, overwrite: false }));
    return {
      revision: int(r.revision),
      digest: String(r.digest),
      counts: counts(r.counts),
      validation: validation(r.validation),
    };
  }
}
const publishResult = (value: unknown): CastPublishResult => {
  const r = object(value);
  return {
    version: int(r.version),
    digest: String(r.digest),
    kind: r.kind === 'rollback' ? 'rollback' : 'publish',
    fromVersion: r.fromVersion === null ? null : int(r.fromVersion),
    counts: counts(r.counts),
    warnings: int(r.warnings),
  };
};
