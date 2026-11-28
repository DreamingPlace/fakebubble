/** Part 42: the console's 广播 client. Shapes are checked just enough to refuse a reply that is not one. */
export type BroadcastState = 'scheduled' | 'sending' | 'sent' | 'cancelled';
export type BroadcastCharacter = { characterId: string; name: string; color: string | null; voice: boolean };
export type BroadcastOptions = {
  characters: BroadcastCharacter[];
  recipients: number;
  speechAvailable: boolean;
  limits: { bubbles: number; bubbleCharacters: number; totalCharacters: number; audioBytes: number };
  now: number;
};
export type BroadcastRow = {
  id: string;
  state: BroadcastState;
  revision: number;
  sendAt: number;
  characters: { characterId: string; name: string }[];
  recipients: number;
  delivered: number;
  percent: number;
};
export type BroadcastDetail = BroadcastRow & {
  editable: boolean;
  bubbles?: string[];
  characterIds?: string[];
  voices?: Record<string, { kind: 'generated' | 'uploaded'; durationMs: number }>;
};
export type BroadcastTake = {
  takeId: string;
  characterId: string;
  origin: 'generated' | 'uploaded';
  durationMs: number;
};
export type BroadcastEstimate =
  | { ok: true; estimateMicros: number; characters: number }
  | { ok: false; reason: string };
/** A voice per character: a take id, null for none, 'keep' for the one a scheduled broadcast already has. */
export type BroadcastVoices = Record<string, string | null>;
export type BroadcastDraft = {
  bubbles: string[];
  characterIds: string[];
  voices: BroadcastVoices;
  sendAt: number | null;
  acknowledge: { characters: number; recipients: number };
};

type Send = (path: string, body: Record<string, unknown>) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ADMIN_RESPONSE_INVALID');
  return value as Record<string, unknown>;
};
export class BroadcastAdminClient {
  private readonly send: Send;
  constructor(send: Send) {
    this.send = send;
  }
  async options(): Promise<BroadcastOptions> {
    const r = record(await this.send('options', {}));
    if (!Array.isArray(r.characters) || !Number.isSafeInteger(r.recipients)) throw new Error('ADMIN_RESPONSE_INVALID');
    return r as unknown as BroadcastOptions;
  }
  async list(): Promise<{ broadcasts: BroadcastRow[]; recipients: number }> {
    const r = record(await this.send('list', {}));
    if (!Array.isArray(r.broadcasts)) throw new Error('ADMIN_RESPONSE_INVALID');
    return r as unknown as { broadcasts: BroadcastRow[]; recipients: number };
  }
  async detail(id: string): Promise<BroadcastDetail> {
    return record(await this.send('detail', { id })) as unknown as BroadcastDetail;
  }
  async estimate(characterId: string, bubbles: string[]): Promise<BroadcastEstimate> {
    const r = record(await this.send('estimate', { characterId, bubbles }));
    return r as unknown as BroadcastEstimate;
  }
  async speak(input: { requestId: string; characterId: string; bubbles: string[]; acknowledgeMicros: number }) {
    return record(await this.send('speak', input)) as unknown as BroadcastTake;
  }
  async upload(characterId: string, base64: string) {
    return record(await this.send('upload', { characterId, base64 })) as unknown as BroadcastTake;
  }
  async takeAudio(takeId: string): Promise<{ base64: string; durationMs: number }> {
    return record(await this.send('take-audio', { takeId })) as unknown as { base64: string; durationMs: number };
  }
  async create(requestId: string, draft: BroadcastDraft): Promise<BroadcastRow> {
    return record(await this.send('send', { requestId, ...draft })) as unknown as BroadcastRow;
  }
  async update(requestId: string, id: string, expectedRevision: number, draft: BroadcastDraft): Promise<BroadcastRow> {
    return record(await this.send('update', { requestId, id, expectedRevision, ...draft })) as unknown as BroadcastRow;
  }
  async cancel(requestId: string, id: string): Promise<BroadcastRow> {
    return record(await this.send('cancel', { requestId, id })) as unknown as BroadcastRow;
  }
}
