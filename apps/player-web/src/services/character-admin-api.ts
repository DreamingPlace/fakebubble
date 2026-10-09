import type { CharacterTemplate } from '../../../../packages/contracts/index.ts';
export type CharacterProfile = {
  template: CharacterTemplate;
  presentation: { displayName: string; publicDescription: string; welcome: { text: string; version: string } };
};
export type CharacterDraft = {
  characterId: string;
  revision: number;
  baseVersion: number | null;
  profile: CharacterProfile;
  contentHash: string;
  savedAt: number;
};
export type CharacterSummary = {
  characterId: string;
  displayName: string;
  publishedVersion: number | null;
  draftRevision: number | null;
};
export type DeletionStatus = {
  characterId: string;
  deletionId: string;
  state: 'purging' | 'deleted';
  total: number;
  databaseCleared: number;
  audioCleared: number;
  errorCode: string | null;
};
export type PreviewJob = {
  previewId: string;
  characterId: string;
  draftRevision: number;
  profileHash: string;
  status: string;
  errorCode: string | null;
  input?: string;
  createdAt?: number;
  result: unknown;
};
export type CharacterDetail = {
  characterId: string;
  published: { version: number; profile: CharacterProfile } | null;
  draft: CharacterDraft | null;
  previews: PreviewJob[];
  previewAvailable: boolean;
};
export type Material = {
  materialId: string;
  draftRevision: number;
  profileHash: string;
  approved: boolean;
  createdAt: number;
  voice: { profileId: string; version: number; referenceId: string; model: string };
  assets: { kind: 'welcome' | 'footer'; body: string; sha256: string; durationMs: number; byteLength: number }[];
};
export type DeleteImpact = {
  previewHash: string;
  characterId: string;
  version: number;
  conversations: number;
  messages: number;
  pendingOperations: number;
};
const invalid = () => new Error('ADMIN_CHARACTER_PROTOCOL_INVALID');
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
}
function string(v: unknown) {
  if (typeof v !== 'string') throw invalid();
  return v;
}
function num(v: unknown) {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid();
  return v as number;
}
function flag(v: unknown) {
  if (typeof v !== 'boolean') throw invalid();
  return v;
}
function rows(v: unknown) {
  if (!Array.isArray(v)) throw invalid();
  return v as unknown[];
}
const nullable = (v: unknown) => (v === null ? null : string(v));
function profile(v: unknown): CharacterProfile {
  const p = object(v),
    t = object(p.template),
    d = object(p.presentation),
    w = object(d.welcome);
  string(t.id);
  string(t.name);
  string(t.persona);
  num(t.version);
  if (t.fictional !== true) throw invalid();
  object(t.schedule);
  return {
    template: structuredClone(t) as unknown as CharacterTemplate,
    presentation: {
      displayName: string(d.displayName),
      publicDescription: string(d.publicDescription),
      welcome: { text: string(w.text), version: string(w.version) },
    },
  };
}
function draft(v: unknown): CharacterDraft {
  const r = object(v);
  return {
    characterId: string(r.characterId),
    revision: num(r.revision),
    baseVersion: r.baseVersion === null ? null : num(r.baseVersion),
    profile: profile(r.profile),
    contentHash: string(r.contentHash),
    savedAt: num(r.savedAt),
  };
}
function preview(v: unknown): PreviewJob {
  const r = object(v);
  if (!['queued', 'generating', 'succeeded', 'failed'].includes(string(r.status))) throw invalid();
  return {
    previewId: string(r.previewId),
    characterId: string(r.characterId),
    draftRevision: num(r.draftRevision),
    profileHash: string(r.profileHash),
    status: string(r.status),
    errorCode: nullable(r.errorCode),
    ...(typeof r.input === 'string' ? { input: r.input } : {}),
    ...(typeof r.createdAt === 'number' ? { createdAt: r.createdAt } : {}),
    result: r.result,
  };
}
function deletion(v: unknown): DeletionStatus {
  const r = object(v);
  if (!['purging', 'deleted'].includes(string(r.state))) throw invalid();
  return {
    characterId: string(r.characterId),
    deletionId: string(r.deletionId),
    state: r.state as DeletionStatus['state'],
    total: num(r.total),
    databaseCleared: num(r.databaseCleared),
    audioCleared: num(r.audioCleared),
    errorCode: nullable(r.errorCode),
  };
}
/** Shares the owning admin client's current in-memory CSRF; never stores a credential or request body. */
export class CharacterAdminClient {
  private readonly request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  constructor(request: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
    this.request = request;
  }
  private call(id: string, action: string, body: Record<string, unknown> = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalid();
    return this.request(`${id}/${action}`, body);
  }
  async list() {
    const r = object(await this.request('list', {}));
    return {
      characters: rows(r.characters).map((v) => {
        const c = object(v);
        return {
          characterId: string(c.characterId),
          displayName: string(c.displayName),
          publishedVersion: c.publishedVersion === null ? null : num(c.publishedVersion),
          draftRevision: c.draftRevision === null ? null : num(c.draftRevision),
        };
      }),
      deletions: rows(r.deletions).map(deletion),
    };
  }
  async detail(id: string): Promise<CharacterDetail> {
    const r = object(await this.call(id, 'detail'));
    return {
      characterId: string(r.characterId),
      published:
        r.published === null
          ? null
          : { version: num(object(r.published).version), profile: profile(object(r.published).profile) },
      draft: r.draft === null ? null : draft(r.draft),
      previews: rows(r.previews).map(preview),
      previewAvailable: flag(r.previewAvailable),
    };
  }
  async save(id: string, expectedRevision: number | null, p: CharacterProfile) {
    return draft(await this.call(id, 'save', { expectedRevision, profile: p }));
  }
  async discard(id: string, expectedRevision: number) {
    const r = object(await this.call(id, 'discard', { expectedRevision }));
    if (r.discarded !== true) throw invalid();
  }
  async profilePreview(id: string, expectedRevision: number) {
    const r = object(await this.call(id, 'preview', { expectedRevision }));
    if (r.kind !== 'profile-preview' || r.externalCalls !== false) throw invalid();
    return { draft: draft(r.draft), published: r.published === null ? null : profile(r.published) };
  }
  async startPreview(
    id: string,
    input: { requestId: string; draftRevision: number; profileHash: string; relationship: string; message: string },
  ) {
    return preview(await this.call(id, 'review-start', input));
  }
  async previewStatus(id: string, previewId: string) {
    return preview(await this.call(id, 'review-status', { previewId }));
  }
  async materials(id: string): Promise<Material[]> {
    return rows(await this.call(id, 'material-list')).map((v) => {
      const r = object(v),
        voice = object(r.voice);
      return {
        materialId: string(r.materialId),
        draftRevision: num(r.draftRevision),
        profileHash: string(r.profileHash),
        approved: flag(r.approved),
        createdAt: num(r.createdAt),
        voice: {
          profileId: string(voice.profileId),
          version: num(voice.version),
          referenceId: string(voice.referenceId),
          model: string(voice.model),
        },
        assets: rows(r.assets).map((v) => {
          const a = object(v);
          if (a.kind !== 'welcome' && a.kind !== 'footer') throw invalid();
          return {
            kind: a.kind,
            body: string(a.body),
            sha256: string(a.sha256),
            durationMs: num(a.durationMs),
            byteLength: num(a.byteLength),
          };
        }),
      };
    });
  }
  async prepareMaterial(
    id: string,
    input: { requestId: string; draftRevision: number; profileHash: string; referenceId: string; model: string },
  ) {
    return string(object(await this.call(id, 'material-prepare', input)).materialId);
  }
  async upload(id: string, materialId: string, kind: 'welcome' | 'footer', base64: string) {
    await this.call(id, 'material-upload', { materialId, kind, base64 });
  }
  async audio(id: string, materialId: string, kind: 'welcome' | 'footer') {
    return string(object(await this.call(id, 'material-audio', { materialId, kind })).base64);
  }
  async approve(id: string, materialId: string, note: string) {
    await this.call(id, 'material-approve', {
      materialId,
      note,
      acknowledgeRights: true,
      acknowledgeWelcomeListening: true,
      acknowledgeFooterListening: true,
    });
  }
  async publish(
    id: string,
    input: {
      requestId: string;
      draftRevision: number;
      profileHash: string;
      previewId: string;
      acknowledgeReview: boolean;
      materialId?: string;
    },
  ) {
    const r = object(await this.call(id, 'publish', input));
    return { version: num(r.version) };
  }
  async deletePreview(id: string): Promise<DeleteImpact> {
    const r = object(await this.call(id, 'delete-preview'));
    return {
      characterId: string(r.characterId),
      version: num(r.version),
      previewHash: string(r.previewHash),
      conversations: num(r.conversations),
      messages: num(r.messages),
      pendingOperations: num(r.pendingOperations),
    };
  }
  async deleteStart(id: string, input: { requestId: string; previewHash: string; acknowledgeDeleteAllChats: boolean }) {
    return deletion(await this.call(id, 'delete-start', input));
  }
  async deleteStatus(id: string) {
    return deletion(await this.call(id, 'delete-status'));
  }
}
