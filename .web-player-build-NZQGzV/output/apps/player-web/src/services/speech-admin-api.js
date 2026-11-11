const bad = () => new Error('ADMIN_SPEECH_PROTOCOL_INVALID');
const obj = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw bad();
    return v;
};
const nat = (v) => {
    if (!Number.isSafeInteger(v) || v < 0)
        throw bad();
    return v;
};
const text = (v) => {
    if (typeof v !== 'string')
        throw bad();
    return v;
};
export function speechEstimate(value) {
    const r = obj(value);
    if (r.ok === false)
        return { ok: false, reason: text(r.reason) };
    if (r.ok !== true)
        throw bad();
    return {
        ok: true,
        calls: nat(r.calls),
        characters: nat(r.characters),
        bytes: nat(r.bytes),
        estimateMicros: nat(r.estimateMicros),
        model: text(r.model),
    };
}
export function speechClips(value) {
    const list = obj(value).clips;
    if (!Array.isArray(list))
        throw bad();
    return list.map((v) => {
        const c = obj(v);
        return {
            callId: text(c.callId),
            ordinal: nat(c.ordinal),
            durationMs: nat(c.durationMs),
            byteLength: nat(c.byteLength),
            sha256: text(c.sha256),
        };
    });
}
export function speechAudio(value) {
    const r = obj(value);
    return { base64: text(r.base64), sha256: text(r.sha256) };
}
