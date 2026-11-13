import { speechEstimate } from './speech-admin-api.ts';
import {
  bundleResult,
  clipTakes,
  directionEstimate,
  generateAllResult,
  rewriteResult,
  takeAudioBase64,
  takeEstimate,
  takeOf,
} from './clip-takes-api.ts';
import type { CharacterTemplate } from '../../../../packages/contracts/index.ts';
import {
  RESTORE_PROBLEMS,
  type RestoreProblem,
  type VersionActor,
  type VersionHistory,
  type VersionOrigin,
  type VersionRow,
} from '../../../../packages/contracts/web-character-history.ts';
import { upgradeWelcomes, type WelcomeLine } from '../../../../packages/contracts/web-welcomes.ts';
export type CharacterProfile = {
  template: CharacterTemplate;
  presentation: {
    displayName: string;
    publicDescription: string;
    /** Part 24k-2: 1-8 weighted lines; the weights are whole percents summing to 100. */
    welcomes: WelcomeLine[];
    /** The main chat colour, '#RRGGBB'; absent = the player page's built-in palette. */
    color?: string;
    /** Part 24j: the colours the profile template listed, in order (stored now, used by the player page after 24k). */
    palette?: { hex: string; name: string; role: 'main' | 'accent' }[];
  };
};
/** Part 24j: the 角色代码 and what a profile import recorded against it. */
export type ProfileMeta = {
  available: boolean;
  code: string | null;
  avatarFile: string | null;
  /** The Fish voice reference id from the file: the 声音 page prefills its referenceId field with it. */
  voiceReferenceId: string | null;
  checklist: { key: string; text: string; state: 'open' | 'dismissed' }[];
};
export type CharacterDraft = {
  characterId: string;
  revision: number;
  baseVersion: number | null;
  profile: CharacterProfile;
  contentHash: string;
  savedAt: number;
};
/** Part 24l: where the workbench sidebar puts a character (server truth): 当前阵容 / 未发布草稿 / 已下线. */
export type SidebarGroup = 'live' | 'draft' | 'offline';
export const SIDEBAR_GROUPS: readonly SidebarGroup[] = ['live', 'draft', 'offline'];
export const SIDEBAR_GROUP_LABEL: Record<SidebarGroup, string> = {
  live: '当前阵容',
  draft: '未发布草稿',
  offline: '已下线',
};
export type CharacterSummary = {
  characterId: string;
  displayName: string;
  publishedVersion: number | null;
  draftRevision: number | null;
  /** The main colour ('#RRGGBB'): the draft's, else the published one, else null (Part 24b-6, round 4). */
  color: string | null;
  group: SidebarGroup;
  /** On the home page now (Part 24l). */
  online: boolean;
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
/** Part 24b-7: who saved a draft revision (the place in the 管理员与权限 order, the initial and the label; never an id). */
export type DraftBy = { index: number | null; initial: string; label: string };
export type DraftHistory = {
  draftRevision: number | null;
  revisions: { revision: number; savedAt: number; by: DraftBy; summary: string; profile: CharacterProfile }[];
  earlier: CharacterProfile | null;
  groups: { group: string; by: DraftBy }[];
};
export type VersionSnapshot = VersionRow & {
  characterId: string;
  profile: CharacterProfile;
  profileHash: string;
  /** The same for a version and for the restore of it (the version number set aside). */
  contentKey: string;
  liveProfile: CharacterProfile | null;
};
export type CharacterDetail = {
  characterId: string;
  published: { version: number; profile: CharacterProfile } | null;
  draft: CharacterDraft | null;
  previews: PreviewJob[];
  previewAvailable: boolean;
  /** Part 24l: on the home page now. A published character that is not is 已下线 (its live version stays). Absent = online. */
  online?: boolean;
  /** Part 24j. Absent (an older answer, a test double) reads as 'not available': no code field, no checklist. */
  profileMeta?: ProfileMeta;
  /** Part 24k-1. Absent reads as 'not available': no 生成 and no 试听 are offered. */
  speech?: {
    available: boolean;
    hasVoice: boolean;
    /** Part 29 B: the one voice the character speaks with. null = no binding and no recorded Fish id. */
    voice?: { referenceId: string; profileId: string; version: number; speed: number; derived: boolean } | null;
    /** The model that will actually speak for an un-pinned voice. */
    siteModel?: string;
    /** The 结束成品 exists only while the free tier is off. */
    footerRequired?: boolean;
  };
};
/** Part 29 C: one slot of a 素材版本 against the draft's clip manifest. */
export type MaterialSlot = {
  kind: 'welcome' | 'footer';
  lineId: string | null;
  text: string;
  state: 'ready' | 'empty' | 'stale';
  /** A call for this slot ended UNKNOWN or released: the underlying code (a fixed string), shown on the slot. */
  issue?: { state: 'unknown' | 'released'; code: string } | null;
};
export type Material = {
  materialId: string;
  draftRevision: number;
  profileHash: string;
  approved: boolean;
  createdAt: number;
  voice: { profileId: string; version: number; referenceId: string; model: string; pinned?: boolean };
  /** Part 29: N in creation order for this character ("素材版本 N"). */
  number?: number;
  /** Why it cannot be used with the draft as it is now (null: usable). */
  stale?: 'voice' | 'text' | 'slots' | null;
  slots?: MaterialSlot[];
  assets: {
    kind: 'welcome' | 'footer';
    body: string;
    sha256: string;
    durationMs: number;
    byteLength: number;
    /** Part 24k-1: where the audio came from. Absent in an older answer. */
    origin?: 'generated' | 'uploaded';
  }[];
  /** Part 24k-2: the welcome slots of a profile with 2+ lines, one per line (a one-line profile uses `assets`). */
  lines: {
    lineId: string;
    body: string;
    sha256: string;
    durationMs: number;
    byteLength: number;
    origin?: 'generated' | 'uploaded';
  }[];
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
function speechOf(r: Record<string, unknown>): NonNullable<CharacterDetail['speech']> {
  const v = r.voice && typeof r.voice === 'object' ? (r.voice as Record<string, unknown>) : null;
  return {
    available: flag(r.available),
    hasVoice: flag(r.hasVoice),
    ...(v
      ? {
          voice: {
            referenceId: string(v.referenceId),
            profileId: string(v.profileId),
            version: num(v.version),
            speed: num(v.speed),
            derived: flag(v.derived),
          },
        }
      : r.voice === null
        ? { voice: null }
        : {}),
    ...(typeof r.siteModel === 'string' ? { siteModel: r.siteModel } : {}),
    ...(typeof r.footerRequired === 'boolean' ? { footerRequired: r.footerRequired } : {}),
  };
}
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
/** `welcomes` as the server sends it; a stored snapshot of an old version still has the single `welcome` (upgraded here, in memory). */
function welcomes(d: Record<string, unknown>): WelcomeLine[] {
  if (d.welcomes === undefined) {
    const w = object(d.welcome);
    string(w.text);
    return upgradeWelcomes({ welcome: { text: w.text } });
  }
  const list = rows(d.welcomes);
  if (list.length < 1 || list.length > 8) throw invalid();
  return list.map((entry) => {
    const l = object(entry);
    if (!Number.isInteger(l.weight)) throw invalid();
    return { id: string(l.id), text: string(l.text), weight: l.weight as number };
  });
}
function profile(v: unknown): CharacterProfile {
  const p = object(v),
    t = object(p.template),
    d = object(p.presentation);
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
      welcomes: welcomes(d),
      ...(d.color === undefined ? {} : { color: string(d.color) }),
      ...(d.palette === undefined
        ? {}
        : {
            palette: rows(d.palette).map((v) => {
              const c = object(v);
              if (c.role !== 'main' && c.role !== 'accent') throw invalid();
              return { hex: string(c.hex), name: string(c.name), role: c.role };
            }),
          }),
    },
  };
}
function profileMeta(v: unknown): ProfileMeta {
  const r = object(v);
  return {
    available: flag(r.available),
    code: nullable(r.code),
    avatarFile: nullable(r.avatarFile),
    voiceReferenceId: nullable(r.voiceReferenceId),
    checklist: rows(r.checklist).map((item) => {
      const c = object(item);
      if (c.state !== 'open' && c.state !== 'dismissed') throw invalid();
      return { key: string(c.key), text: string(c.text), state: c.state };
    }),
  };
}
function versionRow(v: unknown): VersionRow {
  const r = object(v),
    o = object(r.origin),
    by = string(r.by);
  if (!['owner', 'admin', 'system'].includes(by)) throw invalid();
  const kind = string(o.kind);
  if (!['publish', 'colour', 'restore'].includes(kind)) throw invalid();
  const problem = r.problem === null ? null : string(r.problem);
  if (problem !== null && !(RESTORE_PROBLEMS as readonly string[]).includes(problem)) throw invalid();
  return {
    version: num(r.version),
    publishedAt: r.publishedAt === null ? null : num(r.publishedAt),
    by: by as VersionActor,
    origin: (kind === 'restore' ? { kind, from: num(o.from) } : { kind }) as VersionOrigin,
    summary: string(r.summary),
    live: flag(r.live),
    restorable: flag(r.restorable),
    problem: problem as RestoreProblem | null,
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
/** An older answer without a group reads as the old rule: never published = a draft, else on the home page. */
function sidebarGroup(value: unknown, publishedVersion: unknown): SidebarGroup {
  if (value === undefined) return publishedVersion === null ? 'draft' : 'live';
  if (value !== 'live' && value !== 'draft' && value !== 'offline') throw invalid();
  return value;
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
          color: typeof c.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c.color) ? c.color.toUpperCase() : null,
          group: sidebarGroup(c.group, c.publishedVersion),
          online: c.online === undefined ? c.publishedVersion !== null : flag(c.online),
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
      ...(r.online === undefined ? {} : { online: flag(r.online) }),
      ...(r.profileMeta === undefined ? {} : { profileMeta: profileMeta(r.profileMeta) }),
      ...(r.speech === undefined ? {} : { speech: speechOf(object(r.speech)) }),
    };
  }
  /** 角色代码 by hand (身份与展示). */
  async saveCode(id: string, code: string) {
    return profileMeta(await this.call(id, 'code-save', { code }));
  }
  /** 清单: mark one item dismissed. */
  async dismissChecklist(id: string, key: string) {
    return profileMeta(await this.call(id, 'checklist-dismiss', { key }));
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
  // ---- Part 30: slots and takes ----
  async takes(id: string) {
    return clipTakes(await this.call(id, 'take-list'));
  }
  async takeAudio(id: string, takeId: string) {
    return takeAudioBase64(await this.call(id, 'take-audio', { takeId }));
  }
  async takeUpload(id: string, slotKey: string, base64: string) {
    return takeOf(await this.call(id, 'take-upload', { slotKey, base64 }));
  }
  async takeEstimate(id: string, slotKeys: string[], markup?: string) {
    return takeEstimate(
      await this.call(id, 'take-estimate', { slotKeys, ...(markup === undefined ? {} : { markup }) }),
    );
  }
  async takeGenerate(
    id: string,
    input: { requestId: string; slotKey: string; acknowledgeMicros: number; feedback?: string; markup?: string },
  ) {
    return takeOf(await this.call(id, 'take-generate', input));
  }
  async takeGenerateAll(id: string, input: { requestId: string; acknowledgeMicros: number }) {
    return generateAllResult(await this.call(id, 'take-generate-all', input));
  }
  async takeSelect(id: string, takeId: string) {
    await this.call(id, 'take-select', { takeId });
  }
  async takeRename(id: string, takeId: string, name: string) {
    await this.call(id, 'take-rename', { takeId, name });
  }
  async takeDelete(id: string, takeId: string) {
    await this.call(id, 'take-delete', { takeId });
  }
  async takeApprove(id: string, slots: { slotKey: string; takeId: string }[]) {
    await this.call(id, 'take-approve', {
      acknowledgeRights: true,
      slots: slots.map((slot) => ({ ...slot, heard: true })),
    });
  }
  async takeEstimateDirection(id: string, slotKey: string, feedback: string) {
    return directionEstimate(await this.call(id, 'take-estimate-direction', { slotKey, feedback }));
  }
  async takeRewrite(id: string, input: { requestId: string; slotKey: string; feedback: string }) {
    return rewriteResult(await this.call(id, 'take-rewrite', input));
  }
  /** The 素材版本 a publication names, made from the approved 选用 takes (never shown). */
  async takeBundle(id: string) {
    return bundleResult(await this.call(id, 'take-bundle'));
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
          ...(typeof voice.pinned === 'boolean' ? { pinned: voice.pinned } : {}),
        },
        ...(typeof r.number === 'number' ? { number: r.number } : {}),
        ...(r.stale === 'voice' || r.stale === 'text' || r.stale === 'slots' ? { stale: r.stale } : {}),
        ...(Array.isArray(r.slots)
          ? {
              slots: rows(r.slots).map((v) => {
                const a = object(v);
                if (a.kind !== 'welcome' && a.kind !== 'footer') throw invalid();
                if (a.state !== 'ready' && a.state !== 'empty' && a.state !== 'stale') throw invalid();
                const issue = a.issue && typeof a.issue === 'object' ? (a.issue as Record<string, unknown>) : null;
                return {
                  kind: a.kind,
                  lineId: typeof a.lineId === 'string' ? a.lineId : null,
                  text: string(a.text),
                  state: a.state,
                  ...(issue && (issue.state === 'unknown' || issue.state === 'released')
                    ? { issue: { state: issue.state, code: string(issue.code) } }
                    : {}),
                };
              }),
            }
          : {}),
        lines:
          r.lines === undefined
            ? []
            : rows(r.lines).map((v) => {
                const a = object(v);
                return {
                  lineId: string(a.lineId),
                  body: string(a.body),
                  sha256: string(a.sha256),
                  durationMs: num(a.durationMs),
                  byteLength: num(a.byteLength),
                  ...(a.origin === 'generated' || a.origin === 'uploaded' ? { origin: a.origin } : {}),
                };
              }),
        assets: rows(r.assets).map((v) => {
          const a = object(v);
          if (a.kind !== 'welcome' && a.kind !== 'footer') throw invalid();
          return {
            kind: a.kind,
            body: string(a.body),
            sha256: string(a.sha256),
            durationMs: num(a.durationMs),
            byteLength: num(a.byteLength),
            ...(a.origin === 'generated' || a.origin === 'uploaded' ? { origin: a.origin } : {}),
          };
        }),
      };
    });
  }
  async prepareMaterial(
    id: string,
    input: { requestId: string; draftRevision: number; profileHash: string; model?: string },
  ) {
    return string(object(await this.call(id, 'material-prepare', input)).materialId);
  }
  async upload(id: string, materialId: string, kind: 'welcome' | 'footer', base64: string, lineId?: string) {
    await this.call(id, 'material-upload', { materialId, kind, base64, ...(lineId === undefined ? {} : { lineId }) });
  }
  /** What 生成 of one slot would say and cost, or why it is not offered. Holds nothing. */
  async speechEstimate(id: string, materialId: string, slot: 'welcome' | 'footer', lineId?: string) {
    return speechEstimate(
      await this.call(id, 'speech-estimate', {
        kind: 'material',
        materialId,
        slot,
        ...(lineId === undefined ? {} : { lineId }),
      }),
    );
  }
  /** 生成: one paid Fish call, confirmed with the estimate the person saw. Never approves. */
  async generate(
    id: string,
    input: {
      requestId: string;
      materialId: string;
      kind: 'welcome' | 'footer';
      lineId?: string;
      acknowledgeMicros: number;
    },
  ) {
    await this.call(id, 'material-generate', input);
  }
  async audio(id: string, materialId: string, kind: 'welcome' | 'footer', lineId?: string) {
    return string(
      object(await this.call(id, 'material-audio', { materialId, kind, ...(lineId === undefined ? {} : { lineId }) }))
        .base64,
    );
  }
  /** `lineIds`: the lines heard and ticked, for a welcome of 2+ lines (a single welcome is ticked as before). */
  async approve(id: string, materialId: string, note: string, lineIds?: string[], footer = true) {
    await this.call(id, 'material-approve', {
      materialId,
      note,
      acknowledgeRights: true,
      ...(lineIds ? { acknowledgeLines: lineIds } : { acknowledgeWelcomeListening: true }),
      // Part 29 D: the footer is listened to only while it exists (the free tier is off).
      ...(footer ? { acknowledgeFooterListening: true } : {}),
    });
  }
  async publish(
    id: string,
    input: {
      requestId: string;
      draftRevision: number;
      profileHash: string;
      /** Absent only for a colour-only change (the server decides; every other change needs its 预演). */
      previewId?: string;
      acknowledgeReview: boolean;
      materialId?: string;
    },
  ) {
    const r = object(await this.call(id, 'publish', input));
    return { version: num(r.version) };
  }
  /** 版本历史: every published version, newest first. Roles and snapshots only. */
  async history(id: string): Promise<VersionHistory> {
    const r = object(await this.call(id, 'history'));
    return {
      characterId: string(r.characterId),
      live: r.live === null ? null : num(r.live),
      versions: rows(r.versions).map(versionRow),
    };
  }
  /** 草稿记录: the revisions of the current draft line (newest first, up to 20) and who last changed each group. Read-only. */
  async draftHistory(id: string): Promise<DraftHistory> {
    const r = object(await this.call(id, 'draft-history'));
    const by = (v: unknown): DraftBy => {
      const b = object(v);
      return { index: b.index === null ? null : num(b.index), initial: string(b.initial), label: string(b.label) };
    };
    return {
      draftRevision: r.draftRevision === null ? null : num(r.draftRevision),
      revisions: rows(r.revisions).map((raw) => {
        const row = object(raw);
        return {
          revision: num(row.revision),
          savedAt: num(row.savedAt),
          by: by(row.by),
          summary: string(row.summary),
          profile: profile(row.profile),
        };
      }),
      earlier: r.earlier === null ? null : profile(r.earlier),
      groups: rows(r.groups).map((raw) => {
        const row = object(raw);
        return { group: string(row.group), by: by(row.by) };
      }),
    };
  }
  async historyVersion(id: string, version: number): Promise<VersionSnapshot> {
    const r = object(await this.call(id, 'history-version', { version }));
    return {
      ...versionRow(r),
      characterId: string(r.characterId),
      profile: profile(r.profile),
      profileHash: string(r.profileHash),
      contentKey: string(r.contentKey),
      liveProfile: r.liveProfile === null ? null : profile(r.liveProfile),
    };
  }
  /** 恢复此版本 (owner only): publishes version `version` again as the next version. Same requestId = same answer. */
  async restore(id: string, input: { requestId: string; version: number; liveVersion: number }) {
    const r = object(await this.call(id, 'restore', input));
    return { version: num(r.version), restoredFrom: num(r.restoredFrom), publishedAt: num(r.publishedAt) };
  }
  /** 下线 / 重新上线 (owner only). Same requestId = same answer. `liveVersion` is the version the confirm named. */
  async setAvailability(id: string, action: 'offline' | 'online', input: { requestId: string; liveVersion: number }) {
    const r = object(await this.call(id, action, input));
    if (r.action !== action) throw invalid();
    return { version: num(r.version), position: r.position === null ? null : num(r.position) };
  }
  /** 拖动排序: this admin's own order of one group (all of its members, in the new order). Never affects anyone else. */
  async saveOrder(group: SidebarGroup, ids: readonly string[]) {
    const r = object(await this.request('order', { group, ids: [...ids] }));
    if (r.group !== group) throw invalid();
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
