import {
  REHEARSAL_MODEL_IDS,
  parseRehearsalColumn,
  type RehearsalCell,
  type RehearsalCellState,
  type RehearsalCounts,
  type RehearsalEstimate,
  type RehearsalItems,
  type RehearsalLibrary,
  type RehearsalMemeCell,
  type RehearsalMemeRow,
  type RehearsalPhrases,
  type RehearsalRunDetail,
  type RehearsalRunInfo,
  type RehearsalScriptView,
  type RehearsalSource,
  type RehearsalStartInput,
  type RehearsalTurn,
} from '../../../../packages/contracts/web-rehearsal.ts';
import type { PlayerModelId } from '../../../../packages/contracts/player-models.ts';

type Request = (path: string, body: Record<string, unknown>) => Promise<unknown>;
const invalid = () => new Error('ADMIN_REHEARSAL_PROTOCOL_INVALID');
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
};
const string = (v: unknown) => {
  if (typeof v !== 'string') throw invalid();
  return v;
};
const nstring = (v: unknown) => (v === null || v === undefined ? null : string(v));
const int = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid();
  return v as number;
};
const bool = (v: unknown) => {
  if (typeof v !== 'boolean') throw invalid();
  return v;
};
const rows = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw invalid();
  return v;
};
const strings = (v: unknown) => rows(v).map(string);
const model = (v: unknown): PlayerModelId => {
  if (typeof v !== 'string' || !(REHEARSAL_MODEL_IDS as readonly string[]).includes(v)) throw invalid();
  return v as PlayerModelId;
};
/** Part 37a: a column key (`deepseek`, `deepseek-v8`). */
const column = (v: unknown): string => {
  if (parseRehearsalColumn(v) === null) throw invalid();
  return v as string;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw invalid();
  return v as T;
};
const nbool = (v: unknown) => (v === null ? null : bool(v));

const script = (v: unknown): RehearsalScriptView => {
  const o = object(v);
  return { id: string(o.id), name: string(o.name), turns: strings(o.turns), updatedAt: int(o.updatedAt) };
};
const phrases = (v: unknown): RehearsalPhrases => {
  const o = object(v);
  return { customerService: strings(o.customerService), advice: strings(o.advice) };
};
const estimate = (v: unknown): RehearsalEstimate => {
  const o = object(v);
  return {
    models: rows(o.models).map(column),
    turns: int(o.turns),
    replyCalls: int(o.replyCalls),
    judgeCalls: int(o.judgeCalls),
    calls: int(o.calls),
    totalMicros: int(o.totalMicros),
  };
};
const info = (v: unknown): RehearsalRunInfo => {
  const o = object(v);
  return {
    runId: string(o.runId),
    createdAt: int(o.createdAt),
    scriptName: string(o.scriptName),
    models: rows(o.models).map(column),
    turns: int(o.turns),
    withCast: bool(o.withCast),
    status: oneOf(o.status, ['running', 'done', 'failed'] as const),
    estimatedMicros: int(o.estimatedMicros),
    chargedMicros: int(o.chargedMicros),
  };
};
const CELL_STATES = ['pending', 'running', 'done', 'failed', 'unconfirmed', 'skipped'] as const;
const cell = (v: unknown): RehearsalCell => {
  const o = object(v);
  return {
    state: oneOf<RehearsalCellState>(o.state, CELL_STATES),
    errorCode: nstring(o.errorCode),
    bubbles: o.bubbles === null ? null : strings(o.bubbles),
    answered: nbool(o.answered),
  };
};
const nnum = (v: unknown) => {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid();
  return v;
};
const counts = (v: unknown): RehearsalCounts => {
  const o = object(v);
  return {
    replies: int(o.replies),
    answeredAll: o.answeredAll === null ? null : int(o.answeredAll),
    unaskedAdvice: int(o.unaskedAdvice),
    endsWithQuestion: int(o.endsWithQuestion),
    avgChars: nnum(o.avgChars),
    avgBubbles: nnum(o.avgBubbles),
    customerService: int(o.customerService),
    repeated: int(o.repeated),
    unconfirmed: int(o.unconfirmed),
    failed: int(o.failed),
  };
};
const memeCell = (v: unknown): RehearsalMemeCell => {
  const o = object(v);
  const hints = rows(o.hints).map(nbool);
  if (hints.length !== 2) throw invalid();
  return {
    hints,
    falseTrigger: nbool(o.falseTrigger),
    ownSide: nbool(o.ownSide),
    state: oneOf(o.state, ['judged', 'pending', 'unconfirmed', 'failed', 'skipped'] as const),
  };
};

export class RehearsalAdminClient {
  private readonly call: Request;
  constructor(call: Request) {
    this.call = call;
  }
  async library(): Promise<RehearsalLibrary> {
    const o = object(await this.call('library', {}));
    return {
      scripts: rows(o.scripts).map(script),
      sets: rows(o.sets).map((s) => {
        const x = object(s);
        return { set: oneOf(x.set, ['chat', 'repeat'] as const), label: string(x.label), turns: strings(x.turns) };
      }),
      phrases: phrases(o.phrases),
      defaultPhrases: phrases(o.defaultPhrases),
      models: rows(o.models).map((m) => {
        const x = object(m);
        return { id: model(x.id), label: string(x.label), available: bool(x.available) };
      }),
    };
  }
  async saveScript(input: { requestId: string; id: string | null; name: string; turns: string[] }) {
    return script(await this.call('script-save', input));
  }
  async deleteScript(input: { requestId: string; id: string }) {
    return { id: string(object(await this.call('script-delete', input)).id) };
  }
  async savePhrases(input: { requestId: string; customerService: string[]; advice: string[] }) {
    return phrases(await this.call('phrases-save', input));
  }
  async items(characterId: string): Promise<RehearsalItems> {
    const o = object(await this.call('items', { characterId }));
    return {
      available: bool(o.available),
      items: rows(o.items).map((i) => {
        const x = object(i);
        return { key: string(x.key), kind: oneOf(x.kind, ['meme', 'story'] as const), label: string(x.label) };
      }),
    };
  }
  private body(
    characterId: string,
    input: Omit<RehearsalStartInput, 'requestId' | 'acknowledgeMicros' | 'characterId'>,
  ) {
    return {
      characterId,
      draftRevision: input.draftRevision,
      profileHash: input.profileHash,
      source: input.source as RehearsalSource,
      models: input.models,
      withCast: input.withCast,
    };
  }
  async estimate(
    characterId: string,
    input: Omit<RehearsalStartInput, 'requestId' | 'acknowledgeMicros' | 'characterId'>,
  ): Promise<RehearsalEstimate> {
    return estimate(await this.call('estimate', this.body(characterId, input)));
  }
  async start(characterId: string, input: Omit<RehearsalStartInput, 'characterId'>) {
    const o = object(
      await this.call('start', {
        ...this.body(characterId, input),
        requestId: input.requestId,
        acknowledgeMicros: input.acknowledgeMicros,
      }),
    );
    return { runId: string(o.runId), replayed: o.replayed === true };
  }
  async list(characterId: string): Promise<RehearsalRunInfo[]> {
    return rows(object(await this.call('list', { characterId })).runs).map(info);
  }
  async detail(characterId: string, runId: string): Promise<RehearsalRunDetail> {
    const o = object(await this.call('detail', { characterId, runId }));
    return {
      run: info(o.run),
      reviewer: string(o.reviewer),
      turns: rows(o.turns).map((t): RehearsalTurn => {
        const x = object(t);
        return {
          text: string(x.text),
          role: x.role === null ? null : oneOf(x.role, ['hint', 'negative'] as const),
          item: nstring(x.item),
        };
      }),
      columns: rows(o.columns).map((c) => {
        const x = object(c);
        const key = column(x.key);
        return {
          key,
          model: model(x.model),
          writer: oneOf(x.writer, ['v7', 'v8'] as const),
          label: string(x.label),
          cells: rows(x.cells).map(cell),
          counts: counts(x.counts),
        };
      }),
      memes:
        o.memes === null
          ? null
          : rows(o.memes).map((m): RehearsalMemeRow => {
              const x = object(m);
              const byModel: Record<string, RehearsalMemeCell> = {};
              for (const [key, value] of Object.entries(object(x.models))) byModel[column(key)] = memeCell(value);
              return {
                label: string(x.label),
                kind: oneOf(x.kind, ['meme', 'story'] as const),
                played: bool(x.played),
                models: byModel,
              };
            }),
    };
  }
}
