import { COCREATION_TARGET_FIELDS, } from "../../../../packages/contracts/cocreation-cards.js";
const kindOf = (v) => {
    if (v === undefined)
        return 'character';
    if (v !== 'character' && v !== 'memo' && v !== 'pair')
        throw invalid();
    return v;
};
const invalid = () => new Error('ADMIN_COCREATION_PROTOCOL_INVALID');
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
const status = (v) => {
    if (v !== 'new' && v !== 'processed' && v !== 'archived')
        throw invalid();
    return v;
};
const rows = (v) => {
    if (!Array.isArray(v))
        throw invalid();
    return v;
};
const item = (v) => {
    const r = object(v);
    return {
        id: string(r.id),
        characterId: string(r.characterId),
        kind: kindOf(r.kind),
        partnerId: r.partnerId == null ? null : string(r.partnerId),
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
const answer = (v) => {
    const r = object(v);
    const field = string(r.targetField);
    if (!COCREATION_TARGET_FIELDS.includes(field))
        throw invalid();
    const base = {
        ordinal: count(r.ordinal),
        cardId: string(r.cardId),
        targetField: field,
        adoptedAt: r.adoptedAt === null ? null : count(r.adoptedAt),
    };
    if (r.kind === 'text')
        return { ...base, kind: 'text', text: string(r.text) };
    if (r.kind === 'dialogue')
        return { ...base, kind: 'dialogue', player: string(r.player), replies: rows(r.replies).map(string) };
    throw invalid();
};
/** Shares the owning admin client's in-memory CSRF; never stores a credential. */
export class CocreationAdminClient {
    request;
    constructor(request) {
        this.request = request;
    }
    /** New (unread) submissions per character, for the badge in the character workbench. */
    async counts() {
        const counts = object(object(await this.request('counts', {})).counts);
        return Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, count(n)]));
    }
    async list(filter, before) {
        const r = object(await this.request('list', {
            characterId: filter.characterId,
            status: filter.status,
            starred: filter.starred ? true : null,
            query: filter.query.trim() === '' ? null : filter.query.trim(),
            before,
        }));
        const next = r.next === null ? null : object(r.next);
        return {
            items: rows(r.items).map(item),
            next: next ? { createdAt: count(next.createdAt), id: string(next.id) } : null,
        };
    }
    async detail(id) {
        const r = object(await this.request('detail', { id }));
        return {
            id: string(r.id),
            characterId: string(r.characterId),
            kind: kindOf(r.kind),
            partnerId: r.partnerId == null ? null : string(r.partnerId),
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
    async setStatus(ids, next) {
        const r = object(await this.request('set-status', { ids, status: next }));
        return { updated: count(r.updated), status: status(r.status) };
    }
    async star(id, starred) {
        flag(object(await this.request('star', { id, starred })).starred);
    }
    async note(id, note) {
        const r = object(await this.request('note', { id, note }));
        return r.adminNote === null ? null : string(r.adminNote);
    }
    async adopt(id, ordinal) {
        const r = object(await this.request('adopt', { id, ordinal }));
        return { ordinal: count(r.ordinal), status: status(r.status) };
    }
    /** Takes the adoption mark off an answer. Points already paid stay paid. */
    async unadopt(id, ordinal) {
        count(object(await this.request('unadopt', { id, ordinal })).ordinal);
    }
    /** 加入关系与故事: a pair note becomes a story of the cast draft the administrator looked at (revision), never published. */
    async addToCastStory(id, ordinal, expectedRevision) {
        const r = object(await this.request('cast-story', { id, ordinal, expectedRevision }));
        return { ordinal: count(r.ordinal), castRevision: count(r.castRevision) };
    }
}
