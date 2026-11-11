/** Part 24j: 导入角色资料. Two calls: preview (writes nothing) and apply (one transaction, idempotent per request id). */
const invalid = () => new Error('ADMIN_PROFILE_IMPORT_PROTOCOL_INVALID');
const object = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw invalid();
    return v;
};
const list = (v) => {
    if (!Array.isArray(v))
        throw invalid();
    return v;
};
const str = (v) => {
    if (typeof v !== 'string')
        throw invalid();
    return v;
};
const nullableStr = (v) => (v === null ? null : str(v));
const changes = (v) => list(v).map((raw) => {
    const r = object(raw);
    return { field: str(r.field), old: str(r.old), new: str(r.new) };
});
const problems = (v) => list(v).map((raw) => {
    const r = object(raw);
    if (r.item !== null && !Number.isSafeInteger(r.item))
        throw invalid();
    return {
        code: str(r.code),
        file: str(r.file),
        section: nullableStr(r.section),
        field: nullableStr(r.field),
        item: r.item,
        text: str(r.text),
    };
});
const MODES = ['new', 'existing', 'bind'];
export class ProfileImportClient {
    send;
    constructor(send) {
        this.send = send;
    }
    async profileImportPreview(files) {
        const r = object(await this.send('preview', { files }));
        if (typeof r.ok !== 'boolean' || typeof r.unchanged !== 'boolean')
            throw invalid();
        return {
            ok: r.ok,
            unchanged: r.unchanged,
            basis: r.basis,
            characters: list(r.characters).map((raw) => {
                const c = object(raw);
                if (!MODES.includes(c.mode) || typeof c.unchanged !== 'boolean')
                    throw invalid();
                return {
                    file: str(c.file),
                    code: str(c.code),
                    mode: c.mode,
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
    async profileImportApply(input) {
        const r = object(await this.send('apply', input));
        if (typeof r.unchanged !== 'boolean')
            throw invalid();
        return {
            unchanged: r.unchanged,
            characters: list(r.characters).map((raw) => {
                const c = object(raw);
                return {
                    code: str(c.code),
                    mode: c.mode,
                    changed: c.changed === true,
                    revision: c.revision === null ? null : Number(c.revision),
                };
            }),
            castRevision: r.castRevision === null ? null : Number(r.castRevision),
        };
    }
}
