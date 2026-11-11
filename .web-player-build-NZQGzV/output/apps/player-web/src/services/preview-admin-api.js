import { speechAudio, speechClips, speechEstimate } from "./speech-admin-api.js";
import { COMPARE_MARKS, } from "../../../../packages/contracts/review-compare.js";
const invalid = () => new Error('ADMIN_PREVIEW_PROTOCOL_INVALID');
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
const nstring = (v) => (v === null ? null : string(v));
const int = (v) => {
    if (!Number.isSafeInteger(v) || v < 0)
        throw invalid();
    return v;
};
const nint = (v) => (v === null ? null : int(v));
const rows = (v) => {
    if (!Array.isArray(v))
        throw invalid();
    return v;
};
const STATUSES = ['queued', 'generating', 'succeeded', 'failed'];
const status = (v) => {
    if (!STATUSES.includes(v))
        throw invalid();
    return v;
};
const settlement = (v) => {
    if (v === null)
        return null;
    if (v !== 'settled_known' && v !== 'held_unknown' && v !== 'released_unsent')
        throw invalid();
    return v;
};
const bubbles = (v) => rows(v).map((b) => {
    const r = object(b);
    return { text: string(r.text), expression: nstring(r.expression) };
});
const sim = (v) => {
    if (v === null)
        return null;
    const r = object(v);
    return { time: string(r.time), timeZone: string(r.timeZone) };
};
const stage = (v) => {
    if (v === null)
        return null;
    const r = object(v);
    return {
        state: string(r.state),
        outcome: nstring(r.outcome),
        model: string(r.model),
        reservedMicros: int(r.reservedMicros),
        chargedMicros: nint(r.chargedMicros),
        heldMicros: int(r.heldMicros),
        wallMs: nint(r.wallMs),
    };
};
/** The short answer of review-start: what a just-queued single preview is, with the rest of the row empty until it is read again. */
export function previewStartRow(v) {
    const r = object(v);
    return {
        previewId: string(r.previewId),
        characterId: string(r.characterId),
        draftRevision: int(r.draftRevision),
        profileHash: string(r.profileHash),
        status: status(r.status),
        errorCode: nstring(r.errorCode),
        input: nstring(r.input),
        createdAt: int(r.createdAt),
        finishedAt: null,
        runId: null,
        ordinal: null,
        note: null,
        simulatedTime: null,
        settlement: null,
        cost: { draft: null, review: null, chargedMicros: 0, heldMicros: 0 },
        latency: { draftMs: null, reviewMs: null },
        final: null,
    };
}
export function previewRow(v) {
    const r = object(v), cost = object(r.cost), latency = object(r.latency);
    const f = r.final === null ? null : object(r.final);
    return {
        previewId: string(r.previewId),
        characterId: string(r.characterId),
        draftRevision: int(r.draftRevision),
        profileHash: string(r.profileHash),
        status: status(r.status),
        errorCode: nstring(r.errorCode),
        input: nstring(r.input),
        createdAt: int(r.createdAt),
        finishedAt: nint(r.finishedAt),
        runId: nstring(r.runId),
        ordinal: nint(r.ordinal),
        note: nstring(r.note),
        simulatedTime: sim(r.simulatedTime),
        settlement: settlement(r.settlement),
        cost: {
            draft: stage(cost.draft),
            review: stage(cost.review),
            chargedMicros: int(cost.chargedMicros),
            heldMicros: int(cost.heldMicros),
        },
        latency: { draftMs: nint(latency.draftMs), reviewMs: nint(latency.reviewMs) },
        final: f && {
            bubbles: bubbles(f.bubbles),
            mode: nstring(f.mode),
            endsSession: f.endsSession === true,
            reviewChanged: f.reviewChanged === true,
            reviewDecisionNormalized: f.reviewDecisionNormalized === true,
            coverage: rows(f.coverage).map((c) => {
                const x = object(c);
                const s = string(x.status);
                if (s !== 'answered' && s !== 'later' && s !== 'needs_player')
                    throw invalid();
                return { messageId: string(x.messageId), status: s };
            }),
            topics: rows(f.topics),
            factOps: rows(f.factOps),
        },
    };
}
function previewDetail(v) {
    const r = object(v);
    const draft = r.draft === null ? null : object(r.draft);
    const review = r.review === null ? null : object(r.review);
    const ids = object(r.ids);
    return {
        ...previewRow(v),
        draft: draft && { mode: nstring(draft.mode), bubbles: draft.bubbles === null ? null : bubbles(draft.bubbles) },
        review: review && {
            decision: nstring(review.decision),
            replacementBubbles: bubbles(review.replacementBubbles),
            coverage: review.coverage === null ? null : object(review.coverage),
            topics: rows(review.topics),
            factOps: rows(review.factOps),
        },
        rejected: rows(r.rejected).map((x) => {
            const o = object(x);
            const phase = string(o.phase);
            if (phase !== 'draft' && phase !== 'review')
                throw invalid();
            return {
                phase,
                errorCode: string(o.errorCode),
                rawOutput: string(o.rawOutput),
                rawBytes: int(o.rawBytes),
                truncated: o.truncated === true,
            };
        }),
        ids: {
            previewId: string(ids.previewId),
            runId: nstring(ids.runId),
            budgetIds: rows(ids.budgetIds).map((x) => ({
                phase: string(object(x).phase),
                budgetId: string(object(x).budgetId),
            })),
            providerRequestIds: rows(ids.providerRequestIds).map((x) => ({
                phase: string(object(x).phase),
                requestId: string(object(x).requestId),
            })),
        },
    };
}
function runSummary(v) {
    const r = object(v), counts = object(r.counts), set = r.evalSet === null ? null : object(r.evalSet);
    return {
        runId: string(r.runId),
        characterId: string(r.characterId),
        label: nstring(r.label),
        draftRevision: int(r.draftRevision),
        profileHash: string(r.profileHash),
        relationship: string(r.relationship),
        simulatedTime: sim(r.simulatedTime),
        timeZone: string(r.timeZone),
        evalSet: set && { id: string(set.id), version: int(set.version) },
        itemCount: int(r.itemCount),
        createdBy: string(r.createdBy),
        createdAt: int(r.createdAt),
        counts: {
            queued: int(counts.queued),
            generating: int(counts.generating),
            succeeded: int(counts.succeeded),
            failed: int(counts.failed),
        },
    };
}
function evalSet(v) {
    const r = object(v);
    return {
        id: string(r.id),
        name: string(r.name),
        version: int(r.version),
        items: rows(r.items).map((x) => ({ text: string(object(x).text), note: nstring(object(x).note) })),
        updatedBy: string(r.updatedBy),
        updatedAt: int(r.updatedAt),
    };
}
export class PreviewAdminClient {
    characters;
    sets;
    compare;
    /** Part 26b: `compare` is the 审核对比 endpoint; without it the page simply has no such section. */
    constructor(characters, sets, compare) {
        this.characters = characters;
        this.sets = sets;
        this.compare = compare;
    }
    get reviewCompare() {
        return this.compare ? new ReviewCompareClient(this.compare) : null;
    }
    call(id, action, body = {}) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
            throw invalid();
        return this.characters(`${id}/${action}`, body);
    }
    /** Part 24k-1: what 试听 of a succeeded 预演 would cost (one call per final bubble), or why it is not offered. */
    async speechEstimate(id, previewId) {
        return speechEstimate(await this.call(id, 'speech-estimate', { kind: 'preview', previewId }));
    }
    /** 试听: speak the final bubbles (one confirmed cost, idempotent by requestId). */
    async listen(id, input) {
        return speechClips(await this.call(id, 'preview-listen', input));
    }
    /** The clips already spoken for a 预演 (playing them again costs nothing). */
    async clips(id, previewId) {
        return speechClips(await this.call(id, 'speech-clips', { previewId }));
    }
    async clipAudio(id, callId) {
        return speechAudio(await this.call(id, 'speech-audio', { callId }));
    }
    async startRun(id, input) {
        const r = object(await this.call(id, 'run-start', input));
        return { runId: string(r.runId), replayed: r.replayed === true };
    }
    async startSingle(id, input) {
        const r = object(await this.call(id, 'review-start', input));
        // The server answers a started single preview with the short start shape (no cost, latency or result rows yet); the full
        // row arrives with the next status read. Both shapes are accepted, so the row can be shown at once as 排队中.
        return 'cost' in r ? previewRow(r) : previewStartRow(r);
    }
    async list(id) {
        const r = object(await this.call(id, 'run-list'));
        return { runs: rows(r.runs).map(runSummary), singles: rows(r.singles).map(previewRow) };
    }
    async run(id, runId) {
        const r = object(await this.call(id, 'run-detail', { runId }));
        return { run: runSummary(r.run), previews: rows(r.previews).map(previewRow) };
    }
    async detail(id, previewId) {
        return previewDetail(await this.call(id, 'preview-detail', { previewId }));
    }
    /** The one polling call: statuses of a run's previews (runId given) or of the character's recent ones (null). */
    async status(id, runId) {
        const r = object(await this.call(id, 'previews-status', { runId }));
        return {
            previews: rows(r.previews).map((x) => {
                const o = object(x);
                return {
                    previewId: string(o.previewId),
                    status: status(o.status),
                    errorCode: nstring(o.errorCode),
                    runId: nstring(o.runId),
                    ordinal: nint(o.ordinal),
                    finishedAt: nint(o.finishedAt),
                    settlement: settlement(o.settlement),
                };
            }),
            active: int(r.active),
        };
    }
    async evalSets() {
        return rows(object(await this.sets('list', {})).sets).map(evalSet);
    }
    async saveEvalSet(input) {
        return evalSet(await this.sets('save', input));
    }
    async deleteEvalSet(id, expectedVersion) {
        await this.sets('delete', { id, expectedVersion });
    }
}
const COMPARE_STATES = ['ok', 'invalid', 'unknown', 'pending'];
const COMPARE_CASE_STATUSES = ['queued', 'generating', 'done', 'failed'];
const numberOrNull = (v) => (v === null ? null : int(v));
const strings = (v) => rows(v).map(string);
const compareSide = (v) => {
    const o = object(v);
    if (!COMPARE_STATES.includes(o.state))
        throw invalid();
    const quotes = object(o.quotes);
    const tokens = o.tokens === null ? null : object(o.tokens);
    const mark = o.mark === null
        ? null
        : COMPARE_MARKS.includes(o.mark)
            ? o.mark
            : (() => {
                throw invalid();
            })();
    return {
        state: o.state,
        errorCode: nstring(o.errorCode),
        bubbles: o.bubbles === null ? null : strings(o.bubbles),
        changed: o.changed === null ? null : o.changed === true,
        needlessRewrite: o.needlessRewrite === true,
        quotes: { checked: int(quotes.checked), failed: int(quotes.failed) },
        expectations: rows(o.expectations).map((e) => {
            const x = object(e);
            return { label: string(x.label), pass: x.pass === true, detail: string(x.detail) };
        }),
        latencyMs: numberOrNull(o.latencyMs),
        tokens: tokens ? { hit: int(tokens.hit), miss: int(tokens.miss), out: int(tokens.out) } : null,
        costMicros: numberOrNull(o.costMicros),
        mark,
    };
};
const compareSummarySide = (v) => {
    const o = object(v);
    return {
        reviews: int(o.reviews),
        invalid: int(o.invalid),
        unknown: int(o.unknown),
        passed: int(o.passed),
        total: int(o.total),
        quoteChecked: int(o.quoteChecked),
        quoteFailures: int(o.quoteFailures),
        needlessRewrites: int(o.needlessRewrites),
        changed: int(o.changed),
        avgLatencyMs: numberOrNull(o.avgLatencyMs),
        p90LatencyMs: numberOrNull(o.p90LatencyMs),
        avgCostMicros: numberOrNull(o.avgCostMicros),
    };
};
const compareInfo = (v) => {
    const o = object(v);
    return {
        runId: string(o.runId),
        createdAt: int(o.createdAt),
        cases: int(o.cases),
        done: int(o.done),
        failed: int(o.failed),
        running: o.running === true,
        estimatedMicros: int(o.estimatedMicros),
        chargedMicros: int(o.chargedMicros),
    };
};
/** Part 26b: 审核对比. Strict parsing like the rest of this file: a shape that is not the documented one is rejected. */
export class ReviewCompareClient {
    call;
    constructor(call) {
        this.call = call;
    }
    async estimate() {
        const o = object(await this.call('estimate', {}));
        return {
            cases: int(o.cases),
            calls: int(o.calls),
            typicalMicros: int(o.typicalMicros),
            holdMicros: int(o.holdMicros),
        };
    }
    async start(input) {
        const o = object(await this.call('start', input));
        return { runId: string(o.runId), replayed: o.replayed === true };
    }
    async list() {
        return rows(object(await this.call('list', {})).runs).map(compareInfo);
    }
    async detail(runId) {
        const o = object(await this.call('detail', { runId }));
        const summary = object(o.summary);
        return {
            run: compareInfo(o.run),
            summary: { pro: compareSummarySide(summary.pro), flash: compareSummarySide(summary.flash) },
            cases: rows(o.cases).map((c) => {
                const x = object(c);
                if (!COMPARE_CASE_STATUSES.includes(x.status))
                    throw invalid();
                return {
                    ordinal: int(x.ordinal),
                    group: string(x.group),
                    title: string(x.title),
                    input: strings(x.input),
                    status: x.status,
                    errorCode: nstring(x.errorCode),
                    draft: x.draft === null ? null : strings(x.draft),
                    expected: strings(x.expected),
                    pro: compareSide(x.pro),
                    flash: compareSide(x.flash),
                };
            }),
        };
    }
    async mark(input) {
        await this.call('mark', input);
    }
    async exportText(runId) {
        return string(object(await this.call('export', { runId })).text);
    }
}
