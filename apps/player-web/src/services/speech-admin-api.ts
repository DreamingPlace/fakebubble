/**
 * Part 24k-1: the admin speech path as the pages see it (生成 a 成品, 预演 试听). Strict about shape; the cost is
 * micro-USD, the same unit as everywhere on the console.
 */
export type SpeechEstimate =
  | { ok: true; calls: number; characters: number; bytes: number; estimateMicros: number; model: string }
  | { ok: false; reason: string };
export type SpeechClip = { callId: string; ordinal: number; durationMs: number; byteLength: number; sha256: string };
const bad = () => new Error('ADMIN_SPEECH_PROTOCOL_INVALID');
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  return v as Record<string, unknown>;
};
const nat = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw bad();
  return v as number;
};
const text = (v: unknown) => {
  if (typeof v !== 'string') throw bad();
  return v;
};
export function speechEstimate(value: unknown): SpeechEstimate {
  const r = obj(value);
  if (r.ok === false) return { ok: false, reason: text(r.reason) };
  if (r.ok !== true) throw bad();
  return {
    ok: true,
    calls: nat(r.calls),
    characters: nat(r.characters),
    bytes: nat(r.bytes),
    estimateMicros: nat(r.estimateMicros),
    model: text(r.model),
  };
}
export function speechClips(value: unknown): SpeechClip[] {
  const list = obj(value).clips;
  if (!Array.isArray(list)) throw bad();
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
export function speechAudio(value: unknown) {
  const r = obj(value);
  return { base64: text(r.base64), sha256: text(r.sha256) };
}
