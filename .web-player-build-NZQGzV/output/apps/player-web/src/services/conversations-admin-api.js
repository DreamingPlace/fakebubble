const invalid = () => new Error('ADMIN_CONVERSATIONS_PROTOCOL_INVALID');
const object = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw invalid();
    return v;
};
const string = (v) => {
    if (typeof v !== 'string')
        throw invalid();
    return v;
};
const count = (v) => {
    if (!Number.isSafeInteger(v) || v < 0)
        throw invalid();
    return v;
};
const flag = (v) => {
    if (typeof v !== 'boolean')
        throw invalid();
    return v;
};
const array = (v) => {
    if (!Array.isArray(v))
        throw invalid();
    return v;
};
const nullable = (v) => (v === null ? null : string(v));
const row = (v) => {
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
const line = (v) => {
    const r = object(v);
    const speaker = string(r.speaker), status = string(r.status);
    if (!['player', 'character', 'proactive'].includes(speaker) || !['ok', 'failed'].includes(status))
        throw invalid();
    return {
        n: count(r.n),
        time: string(r.time),
        speaker: speaker,
        text: string(r.text),
        status: status,
        errorCode: nullable(r.errorCode),
        reviewChanged: flag(r.reviewChanged),
    };
};
export class ConversationsAdminClient {
    call;
    constructor(call) {
        this.call = call;
    }
    async list(input) {
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
    async detail(input) {
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
    async export(input) {
        const r = object(await this.call('export', 'code' in input ? input : { characterId: input.characterId, code: null, archived: null }));
        return { filename: string(r.filename), lines: count(r.lines), csv: string(r.csv) };
    }
}
