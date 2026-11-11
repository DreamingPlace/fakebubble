import { InviteLocalApiError } from "./invite-local-api.js";
const invalid = () => new Error('ADMIN_CAST_PROTOCOL_INVALID');
const object = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw invalid();
    return value;
};
const int = (value) => {
    if (!Number.isSafeInteger(value))
        throw invalid();
    return value;
};
const validation = (value) => {
    const v = object(value);
    if (!Array.isArray(v.errors) || !Array.isArray(v.warnings))
        throw invalid();
    return { errors: v.errors, warnings: v.warnings };
};
const problems = (value) => {
    if (!Array.isArray(value))
        throw invalid();
    return value.map((raw) => {
        const p = object(raw);
        return {
            code: String(p.code),
            path: String(p.path),
            who: typeof p.who === 'string' ? p.who : null,
            text: String(p.text),
        };
    });
};
const counts = (value) => {
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
export function castIssues(error) {
    if (!(error instanceof InviteLocalApiError))
        return [];
    const issues = error.detail?.issues;
    return Array.isArray(issues)
        ? issues.filter((i) => !!i && typeof i.code === 'string' && typeof i.path === 'string')
        : [];
}
export class CastAdminClient {
    send;
    newId;
    constructor(send, newId = () => globalThis.crypto.randomUUID()) {
        this.send = send;
        this.newId = newId;
    }
    async draft() {
        const r = object(await this.send('draft', {}));
        return {
            revision: int(r.revision),
            digest: String(r.digest),
            updatedAt: int(r.updatedAt),
            doc: object(r.doc),
            counts: counts(r.counts),
            validation: validation(r.validation),
        };
    }
    async versions() {
        const r = object(await this.send('versions', {}));
        if (!Array.isArray(r.versions))
            throw invalid();
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
    /** Part 24b-7: one stored version's document, exactly as stored (read-only). */
    async version(version) {
        const r = object(await this.send('version', { version }));
        return { version: int(r.version), digest: String(r.digest), doc: object(r.doc) };
    }
    async validate() {
        const r = object(await this.send('validate', {}));
        return { revision: int(r.revision), validation: validation(r.validation) };
    }
    async compilePreview(characterId, source) {
        const r = object(await this.send('compile-preview', { characterId, source }));
        if (!Array.isArray(r.knowledge))
            throw invalid();
        return {
            source: object(r.source),
            size: int(r.size),
            view: object(r.view),
            knowledge: r.knowledge,
            dropOrder: Array.isArray(r.dropOrder) ? r.dropOrder : [],
        };
    }
    /** `requestId` is fixed by the caller so a lost answer can be retried as the same request. */
    async save(expectedRevision, doc, requestId = this.newId()) {
        const r = object(await this.send('save', { requestId, expectedRevision, doc }));
        return {
            revision: int(r.revision),
            digest: String(r.digest),
            counts: counts(r.counts),
            validation: validation(r.validation),
        };
    }
    async publish(expectedRevision, requestId = this.newId()) {
        return publishResult(await this.send('publish', { requestId, expectedRevision }));
    }
    async rollback(version, requestId = this.newId()) {
        return publishResult(await this.send('rollback', { requestId, version }));
    }
    /** The current draft as a cast file (the server builds it; the page only saves it). */
    async exportFile() {
        const r = object(await this.send('export', {}));
        return { revision: int(r.revision), file: object(r.file) };
    }
    async importPreview(file) {
        const r = object(await this.send('import-preview', { file }));
        if (!Array.isArray(r.created) || !Array.isArray(r.views))
            throw invalid();
        return {
            revision: int(r.revision),
            importable: r.importable === true,
            created: r.created.map((raw) => {
                const c = object(raw);
                return { name: String(c.name), matched: c.matched === true };
            }),
            problems: problems(r.problems),
            publishBlockers: problems(r.publishBlockers),
            warnings: problems(r.warnings),
            summary: r.summary === null ? null : object(r.summary),
            views: r.views,
        };
    }
    /** `requestId` is fixed by the caller so a lost answer can be retried as the same request. */
    async importFile(expectedRevision, file, requestId = this.newId()) {
        const r = object(await this.send('import-file', { requestId, expectedRevision, file }));
        return {
            revision: int(r.revision),
            counts: counts(r.counts),
            created: int(r.created),
            unchanged: r.unchanged === true,
        };
    }
    async importLegacy(expectedRevision, requestId = this.newId()) {
        const r = object(await this.send('import-legacy', { requestId, expectedRevision, overwrite: false }));
        return {
            revision: int(r.revision),
            digest: String(r.digest),
            counts: counts(r.counts),
            validation: validation(r.validation),
        };
    }
}
const publishResult = (value) => {
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
