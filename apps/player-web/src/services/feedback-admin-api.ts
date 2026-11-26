/** 语音反馈 (Part 36): the owner's counts and 👎 list. Same session and routes as every admin page. */
export type FeedbackRange = 7 | 30 | 90;
export type FeedbackFilter = {
  range: FeedbackRange;
  characterId?: string;
  writer?: string;
  model?: string;
  unheardOnly?: boolean;
};
export type FeedbackCounts = {
  total: { up: number; down: number; downVoice: number; downContent: number };
  byCharacter: { characterId: string; label: string; up: number; down: number }[];
  byWriter: { writer: string; label: string; up: number; down: number }[];
  byModel: { model: string; up: number; down: number }[];
};
export type FeedbackItem = {
  itemId: number;
  time: string;
  characterId: string;
  label: string;
  target: 'voice' | 'content';
  writer: string;
  writerLabel: string;
  model: string;
  playerLines: string[];
  replyText: string;
  hasVoice: boolean;
  heard: boolean;
};
const invalid = () => new Error('ADMIN_FEEDBACK_PROTOCOL_INVALID');
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
};
const array = (v: unknown) => {
  if (!Array.isArray(v)) throw invalid();
  return v as unknown[];
};
const string = (v: unknown) => {
  if (typeof v !== 'string') throw invalid();
  return v;
};
const count = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid();
  return v as number;
};

export class FeedbackAdminClient {
  private readonly call: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  constructor(call: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
    this.call = call;
  }
  async counts(filter: FeedbackFilter): Promise<FeedbackCounts> {
    const r = object(await this.call('counts', { ...filter, unheardOnly: undefined }));
    const total = object(r.total);
    const pair = (v: unknown) => {
      const o = object(v);
      return { up: count(o.up), down: count(o.down), o };
    };
    return {
      total: {
        up: count(total.up),
        down: count(total.down),
        downVoice: count(total.downVoice),
        downContent: count(total.downContent),
      },
      byCharacter: array(r.byCharacter).map((v) => {
        const { up, down, o } = pair(v);
        return { characterId: string(o.characterId), label: string(o.label), up, down };
      }),
      byWriter: array(r.byWriter).map((v) => {
        const { up, down, o } = pair(v);
        return { writer: string(o.writer), label: string(o.label), up, down };
      }),
      byModel: array(r.byModel).map((v) => {
        const { up, down, o } = pair(v);
        return { model: string(o.model), up, down };
      }),
    };
  }
  async list(filter: FeedbackFilter & { before?: number }): Promise<{ items: FeedbackItem[]; hasMore: boolean }> {
    const r = object(await this.call('list', filter));
    return {
      items: array(r.items).map((v) => {
        const o = object(v);
        if (o.target !== 'voice' && o.target !== 'content') throw invalid();
        return {
          itemId: count(o.itemId),
          time: string(o.time),
          characterId: string(o.characterId),
          label: string(o.label),
          target: o.target,
          writer: string(o.writer),
          writerLabel: string(o.writerLabel),
          model: string(o.model),
          playerLines: array(o.playerLines).map(string),
          replyText: string(o.replyText),
          hasVoice: o.hasVoice === true,
          heard: o.heard === true,
        };
      }),
      hasMore: r.hasMore === true,
    };
  }
  async heard(itemId: number, heard: boolean) {
    const r = object(await this.call('heard', { itemId, heard }));
    return { itemId: count(r.itemId), heard: r.heard === true };
  }
  async audio(itemId: number): Promise<{ contentType: string; base64: string }> {
    const r = object(await this.call('audio', { itemId }));
    return { contentType: string(r.contentType), base64: string(r.base64) };
  }
}
