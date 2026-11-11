import { speechEstimate } from "./speech-admin-api.js";
import { RESTORE_PROBLEMS, } from "../../../../packages/contracts/web-character-history.js";
import { upgradeWelcomes } from "../../../../packages/contracts/web-welcomes.js";
export const SIDEBAR_GROUPS = ['live', 'draft', 'offline'];
export const SIDEBAR_GROUP_LABEL = {
    live: '当前阵容',
    draft: '未发布草稿',
    offline: '已下线',
};
const invalid = () => new Error('ADMIN_CHARACTER_PROTOCOL_INVALID');
function object(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw invalid();
    return v;
}
function string(v) {
    if (typeof v !== 'string')
        throw invalid();
    return v;
}
function num(v) {
    if (!Number.isSafeInteger(v) || v < 0)
        throw invalid();
    return v;
}
function flag(v) {
    if (typeof v !== 'boolean')
        throw invalid();
    return v;
}
function rows(v) {
    if (!Array.isArray(v))
        throw invalid();
    return v;
}
const nullable = (v) => (v === null ? null : string(v));
/** `welcomes` as the server sends it; a stored snapshot of an old version still has the single `welcome` (upgraded here, in memory). */
function welcomes(d) {
    if (d.welcomes === undefined) {
        const w = object(d.welcome);
        string(w.text);
        return upgradeWelcomes({ welcome: { text: w.text } });
    }
    const list = rows(d.welcomes);
    if (list.length < 1 || list.length > 8)
        throw invalid();
    return list.map((entry) => {
        const l = object(entry);
        if (!Number.isInteger(l.weight))
            throw invalid();
        return { id: string(l.id), text: string(l.text), weight: l.weight };
    });
}
function profile(v) {
    const p = object(v), t = object(p.template), d = object(p.presentation);
    string(t.id);
    string(t.name);
    string(t.persona);
    num(t.version);
    if (t.fictional !== true)
        throw invalid();
    object(t.schedule);
    return {
        template: structuredClone(t),
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
                        if (c.role !== 'main' && c.role !== 'accent')
                            throw invalid();
                        return { hex: string(c.hex), name: string(c.name), role: c.role };
                    }),
                }),
        },
    };
}
function profileMeta(v) {
    const r = object(v);
    return {
        available: flag(r.available),
        code: nullable(r.code),
        avatarFile: nullable(r.avatarFile),
        voiceReferenceId: nullable(r.voiceReferenceId),
        checklist: rows(r.checklist).map((item) => {
            const c = object(item);
            if (c.state !== 'open' && c.state !== 'dismissed')
                throw invalid();
            return { key: string(c.key), text: string(c.text), state: c.state };
        }),
    };
}
function versionRow(v) {
    const r = object(v), o = object(r.origin), by = string(r.by);
    if (!['owner', 'admin', 'system'].includes(by))
        throw invalid();
    const kind = string(o.kind);
    if (!['publish', 'colour', 'restore'].includes(kind))
        throw invalid();
    const problem = r.problem === null ? null : string(r.problem);
    if (problem !== null && !RESTORE_PROBLEMS.includes(problem))
        throw invalid();
    return {
        version: num(r.version),
        publishedAt: r.publishedAt === null ? null : num(r.publishedAt),
        by: by,
        origin: (kind === 'restore' ? { kind, from: num(o.from) } : { kind }),
        summary: string(r.summary),
        live: flag(r.live),
        restorable: flag(r.restorable),
        problem: problem,
    };
}
function draft(v) {
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
function preview(v) {
    const r = object(v);
    if (!['queued', 'generating', 'succeeded', 'failed'].includes(string(r.status)))
        throw invalid();
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
function deletion(v) {
    const r = object(v);
    if (!['purging', 'deleted'].includes(string(r.state)))
        throw invalid();
    return {
        characterId: string(r.characterId),
        deletionId: string(r.deletionId),
        state: r.state,
        total: num(r.total),
        databaseCleared: num(r.databaseCleared),
        audioCleared: num(r.audioCleared),
        errorCode: nullable(r.errorCode),
    };
}
/** An older answer without a group reads as the old rule: never published = a draft, else on the home page. */
function sidebarGroup(value, publishedVersion) {
    if (value === undefined)
        return publishedVersion === null ? 'draft' : 'live';
    if (value !== 'live' && value !== 'draft' && value !== 'offline')
        throw invalid();
    return value;
}
/** Shares the owning admin client's current in-memory CSRF; never stores a credential or request body. */
export class CharacterAdminClient {
    request;
    constructor(request) {
        this.request = request;
    }
    call(id, action, body = {}) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
            throw invalid();
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
    async detail(id) {
        const r = object(await this.call(id, 'detail'));
        return {
            characterId: string(r.characterId),
            published: r.published === null
                ? null
                : { version: num(object(r.published).version), profile: profile(object(r.published).profile) },
            draft: r.draft === null ? null : draft(r.draft),
            previews: rows(r.previews).map(preview),
            previewAvailable: flag(r.previewAvailable),
            ...(r.online === undefined ? {} : { online: flag(r.online) }),
            ...(r.profileMeta === undefined ? {} : { profileMeta: profileMeta(r.profileMeta) }),
            ...(r.speech === undefined
                ? {}
                : { speech: { available: flag(object(r.speech).available), hasVoice: flag(object(r.speech).hasVoice) } }),
        };
    }
    /** 角色代码 by hand (身份与展示). */
    async saveCode(id, code) {
        return profileMeta(await this.call(id, 'code-save', { code }));
    }
    /** 清单: mark one item dismissed. */
    async dismissChecklist(id, key) {
        return profileMeta(await this.call(id, 'checklist-dismiss', { key }));
    }
    async save(id, expectedRevision, p) {
        return draft(await this.call(id, 'save', { expectedRevision, profile: p }));
    }
    async discard(id, expectedRevision) {
        const r = object(await this.call(id, 'discard', { expectedRevision }));
        if (r.discarded !== true)
            throw invalid();
    }
    async profilePreview(id, expectedRevision) {
        const r = object(await this.call(id, 'preview', { expectedRevision }));
        if (r.kind !== 'profile-preview' || r.externalCalls !== false)
            throw invalid();
        return { draft: draft(r.draft), published: r.published === null ? null : profile(r.published) };
    }
    async startPreview(id, input) {
        return preview(await this.call(id, 'review-start', input));
    }
    async previewStatus(id, previewId) {
        return preview(await this.call(id, 'review-status', { previewId }));
    }
    async materials(id) {
        return rows(await this.call(id, 'material-list')).map((v) => {
            const r = object(v), voice = object(r.voice);
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
                lines: r.lines === undefined
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
                    if (a.kind !== 'welcome' && a.kind !== 'footer')
                        throw invalid();
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
    async prepareMaterial(id, input) {
        return string(object(await this.call(id, 'material-prepare', input)).materialId);
    }
    async upload(id, materialId, kind, base64, lineId) {
        await this.call(id, 'material-upload', { materialId, kind, base64, ...(lineId === undefined ? {} : { lineId }) });
    }
    /** What 生成 of one slot would say and cost, or why it is not offered. Holds nothing. */
    async speechEstimate(id, materialId, slot, lineId) {
        return speechEstimate(await this.call(id, 'speech-estimate', {
            kind: 'material',
            materialId,
            slot,
            ...(lineId === undefined ? {} : { lineId }),
        }));
    }
    /** 生成: one paid Fish call, confirmed with the estimate the person saw. Never approves. */
    async generate(id, input) {
        await this.call(id, 'material-generate', input);
    }
    async audio(id, materialId, kind, lineId) {
        return string(object(await this.call(id, 'material-audio', { materialId, kind, ...(lineId === undefined ? {} : { lineId }) }))
            .base64);
    }
    /** `lineIds`: the lines heard and ticked, for a welcome of 2+ lines (a single welcome is ticked as before). */
    async approve(id, materialId, note, lineIds) {
        await this.call(id, 'material-approve', {
            materialId,
            note,
            acknowledgeRights: true,
            ...(lineIds ? { acknowledgeLines: lineIds } : { acknowledgeWelcomeListening: true }),
            acknowledgeFooterListening: true,
        });
    }
    async publish(id, input) {
        const r = object(await this.call(id, 'publish', input));
        return { version: num(r.version) };
    }
    /** 版本历史: every published version, newest first. Roles and snapshots only. */
    async history(id) {
        const r = object(await this.call(id, 'history'));
        return {
            characterId: string(r.characterId),
            live: r.live === null ? null : num(r.live),
            versions: rows(r.versions).map(versionRow),
        };
    }
    /** 草稿记录: the revisions of the current draft line (newest first, up to 20) and who last changed each group. Read-only. */
    async draftHistory(id) {
        const r = object(await this.call(id, 'draft-history'));
        const by = (v) => {
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
    async historyVersion(id, version) {
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
    async restore(id, input) {
        const r = object(await this.call(id, 'restore', input));
        return { version: num(r.version), restoredFrom: num(r.restoredFrom), publishedAt: num(r.publishedAt) };
    }
    /** 下线 / 重新上线 (owner only). Same requestId = same answer. `liveVersion` is the version the confirm named. */
    async setAvailability(id, action, input) {
        const r = object(await this.call(id, action, input));
        if (r.action !== action)
            throw invalid();
        return { version: num(r.version), position: r.position === null ? null : num(r.position) };
    }
    /** 拖动排序: this admin's own order of one group (all of its members, in the new order). Never affects anyone else. */
    async saveOrder(group, ids) {
        const r = object(await this.request('order', { group, ids: [...ids] }));
        if (r.group !== group)
            throw invalid();
    }
    async deletePreview(id) {
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
    async deleteStart(id, input) {
        return deletion(await this.call(id, 'delete-start', input));
    }
    async deleteStatus(id) {
        return deletion(await this.call(id, 'delete-status'));
    }
}
