import { speechEstimate, type SpeechEstimate } from './speech-admin-api.ts';

/** Part 30: slots and takes as the 声音 tab sees them. Strict about shape; no ids are ever shown, only names. */
export type TakeOrigin = 'generated' | 'feedback' | 'uploaded';
export type Take = {
  takeId: string;
  name: string;
  note: string;
  origin: TakeOrigin;
  status: 'ready' | 'unusable';
  durationMs: number | null;
  sha256: string | null;
  createdAt: number;
  /** 选用: the take the slot uses. */
  selected: boolean;
  /** Its text and voice are the slot's now. */
  usable: boolean;
  feedback?: string;
  markup?: string;
  errorCode?: string;
};
export type Slot = {
  slotKey: string;
  kind: 'welcome' | 'footer';
  lineId: string | null;
  text: string;
  takes: Take[];
  selectedTakeId: string | null;
  approved: boolean;
  issue: { state: 'unknown' | 'released' | 'failed'; code: string } | null;
};
export type ClipTakes = {
  voice: { referenceId: string; model: string; url: string; speed: number } | null;
  footerRequired: boolean;
  speechAvailable: boolean;
  directionAvailable: boolean;
  slots: Slot[];
  ready: boolean;
};
const bad = () => new Error('CLIP_TAKES_PROTOCOL_INVALID');
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  return v as Record<string, unknown>;
};
const str = (v: unknown) => {
  if (typeof v !== 'string') throw bad();
  return v;
};
const int = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw bad();
  return v as number;
};
const bool = (v: unknown) => {
  if (typeof v !== 'boolean') throw bad();
  return v;
};
const list = (v: unknown) => {
  if (!Array.isArray(v)) throw bad();
  return v;
};
const optionalText = (r: Record<string, unknown>, key: string) => (r[key] === undefined ? {} : { [key]: str(r[key]) });
export function takeOf(v: unknown): Take {
  const r = obj(v);
  const origin = str(r.origin);
  if (origin !== 'generated' && origin !== 'feedback' && origin !== 'uploaded') throw bad();
  const status = str(r.status);
  if (status !== 'ready' && status !== 'unusable') throw bad();
  return {
    takeId: str(r.takeId),
    name: str(r.name),
    note: str(r.note),
    origin,
    status,
    durationMs: r.durationMs === null ? null : int(r.durationMs),
    sha256: r.sha256 === null ? null : str(r.sha256),
    createdAt: int(r.createdAt),
    selected: bool(r.selected),
    usable: bool(r.usable),
    ...optionalText(r, 'feedback'),
    ...optionalText(r, 'markup'),
    ...optionalText(r, 'errorCode'),
  } as Take;
}
export function clipTakes(value: unknown): ClipTakes {
  const r = obj(value);
  const voice = r.voice === null ? null : obj(r.voice);
  return {
    voice: voice
      ? {
          referenceId: str(voice.referenceId),
          model: str(voice.model),
          url: str(voice.url),
          speed: Number(voice.speed),
        }
      : null,
    footerRequired: bool(r.footerRequired),
    speechAvailable: bool(r.speechAvailable),
    directionAvailable: bool(r.directionAvailable),
    ready: bool(r.ready),
    slots: list(r.slots).map((v) => {
      const s = obj(v);
      const kind = str(s.kind);
      if (kind !== 'welcome' && kind !== 'footer') throw bad();
      const issue = s.issue === null ? null : obj(s.issue);
      return {
        slotKey: str(s.slotKey),
        kind,
        lineId: s.lineId === null ? null : str(s.lineId),
        text: str(s.text),
        takes: list(s.takes).map(takeOf),
        selectedTakeId: s.selectedTakeId === null ? null : str(s.selectedTakeId),
        approved: bool(s.approved),
        issue: issue ? { state: str(issue.state) as 'unknown' | 'released' | 'failed', code: str(issue.code) } : null,
      };
    }),
  };
}
export type DirectionEstimate = { ok: true; estimateMicros: number } | { ok: false; reason: string };
export function directionEstimate(value: unknown): DirectionEstimate {
  const r = obj(value);
  if (r.ok === false) return { ok: false, reason: str(r.reason) };
  if (r.ok !== true) throw bad();
  return { ok: true, estimateMicros: int(r.estimateMicros) };
}
export function generateAllResult(value: unknown) {
  return list(obj(value).results).map((v) => {
    const r = obj(v);
    return {
      slotKey: str(r.slotKey),
      ...(r.takeId === undefined ? {} : { takeId: str(r.takeId) }),
      ...(r.code === undefined ? {} : { code: str(r.code) }),
    };
  });
}
export const takeEstimate = (value: unknown): SpeechEstimate => speechEstimate(value);
export const takeAudioBase64 = (value: unknown) => str(obj(value).base64);
export const rewriteResult = (value: unknown) => str(obj(value).markup);
export const bundleResult = (value: unknown) => str(obj(value).materialId);
