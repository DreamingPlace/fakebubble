import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { characterFacts } from '../review/web-chat-review.ts';
import {
  parseConversationFilters,
  readOperations,
  statusLabel,
  utc8Time,
  WRITER_LABEL,
  type ConversationFilters,
} from './web-export-conversations.ts';
import type { Cell, Sheet } from './web-export-file.ts';

/**
 * Part 57: the provider-call ledgers and the failed replies as tables. Columns are chosen one by one: a time, a provider and model
 * name, a stage, a state, an error code, an HTTP status, an amount, an age. Never read: a request or response body, a receipt's other
 * fields (only `errorCode` / `code` / `httpStatus` / `status` are extracted, and checked against a fixed shape), a key, an id of an
 * operation / player / world / conversation, the text of a message.
 */
type Reader = Pick<BusinessStore, 'get' | 'all'>;
const FIXED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const NAME = /^[A-Za-z0-9._:/-]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UTC8 = 8 * 3_600_000;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - UTC8;
const tableExists = (store: Reader, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

export const CALL_STATES = ['not_sent', 'sent', 'unknown', 'known'] as const;
export type CallFilters = {
  from: string | null;
  to: string | null;
  provider: string | null;
  state: (typeof CALL_STATES)[number] | null;
};
export function parseCallFilters(input: unknown): CallFilters {
  ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST');
  const body = input as Record<string, unknown>;
  const day = (value: unknown) => {
    ensure(
      value === null ||
        value === undefined ||
        (typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(value))),
      'INVALID_REQUEST',
    );
    return (value ?? null) as string | null;
  };
  const provider = body.provider ?? null;
  ensure(provider === null || (typeof provider === 'string' && NAME.test(provider)), 'INVALID_REQUEST');
  ensure(
    body.state === null || body.state === undefined || CALL_STATES.includes(body.state as never),
    'INVALID_REQUEST',
  );
  const from = day(body.from),
    to = day(body.to);
  ensure(from === null || to === null || from <= to, 'INVALID_REQUEST');
  return { from, to, provider: provider as string | null, state: (body.state ?? null) as CallFilters['state'] };
}

const CALL_FILE: Record<string, string> = { 模型调用: 'provider', 外部调用: 'external', 向量调用: 'embedding' };
export const CALLS_HEADER = [
  '时间（UTC+8）',
  '种类',
  '供应商',
  '模型',
  '阶段',
  '状态',
  '结果',
  '错误代码',
  'HTTP 状态',
  '预留金额（美元）',
  '实际扣款（美元）',
  '已过时间（分钟）',
] as const;
const STATE_LABEL = { not_sent: '未发出', sent: '已发出', unknown: '结果未确认', known: '已确认' } as const;
const OUTCOME_LABEL = { succeeded: '成功', failed: '失败', not_dispatched: '未发出' } as const;
const PHASE_LABEL = {
  draft: '草稿',
  review: '审核',
  speech: '语音',
  embed: '向量',
  text: '文字',
  audio: '语音',
} as const;
const usd = (micros: number | null) => (micros === null ? null : Number((micros / 1_000_000).toFixed(6)));
const word = <T extends Record<string, string>>(table: T, key: string | null) =>
  key === null ? '' : (table[key as keyof T] ?? '');

type CallRow = {
  at: number;
  provider: string;
  model: string | null;
  phase: string;
  state: string;
  outcome: string | null;
  code: string | null;
  http: number | null;
  held: number | null;
  charged: number | null;
};
const safeCode = (value: string | null) => (value && FIXED_CODE.test(value) ? value : '');
const safeHttp = (value: number | null) => (Number.isInteger(value) && value! >= 100 && value! <= 599 ? value : null);

/** Fixed extraction of a receipt: only the code and the status, nothing else leaves the column. */
const receiptFields = (column: string) =>
  `coalesce(json_extract(${column},'$.errorCode'),json_extract(${column},'$.code')) code,
   coalesce(json_extract(${column},'$.httpStatus'),json_extract(${column},'$.status')) http`;

function readCalls(store: Reader, filters: CallFilters) {
  const bound = (column: string) => {
    const where: string[] = [],
      args: (string | number)[] = [];
    if (filters.from !== null) {
      where.push(`${column}>=?`);
      args.push(dayStart(filters.from));
    }
    if (filters.to !== null) {
      where.push(`${column}<?`);
      args.push(dayStart(filters.to) + 86_400_000);
    }
    return { where, args };
  };
  const out: { kind: string; rows: CallRow[] }[] = [];
  const build = (kind: string, table: string, select: string, stateColumn: string, providerColumn: string | null) => {
    if (!tableExists(store, table)) {
      out.push({ kind, rows: [] });
      return;
    }
    const { where, args } = bound('created_at');
    if (filters.state !== null) {
      where.push(`${stateColumn}=?`);
      args.push(filters.state);
    }
    if (filters.provider !== null && providerColumn) {
      where.push(`${providerColumn}=?`);
      args.push(filters.provider);
    }
    out.push({
      kind,
      rows: store
        .all<{
          at: number;
          sent_at: number | null;
          provider: string;
          model: string | null;
          phase: string;
          state: string;
          outcome: string | null;
          code: string | null;
          http: number | null;
          held: number | null;
          charged: number | null;
        }>(
          `SELECT ${select} FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200000`,
          ...args,
        )
        .map((row) => ({ ...row, at: row.at })),
    });
  };
  build(
    '模型调用',
    'web_provider_attempts',
    `created_at at,sent_at,provider,model,phase,state,outcome,${receiptFields('receipt_json')},held_micros held,charged_micros charged`,
    'state',
    'provider',
  );
  build(
    '外部调用',
    'web_external_attempts',
    `created_at at,sent_at,provider,NULL model,phase,dispatch_state state,outcome,${receiptFields('receipt_json')},NULL held,NULL charged`,
    'dispatch_state',
    'provider',
  );
  build(
    '向量调用',
    'web_embed_attempts',
    `created_at at,sent_at,'embedding' provider,model,phase,state,outcome,${receiptFields('receipt_json')},held_micros held,charged_micros charged`,
    'state',
    null,
  );
  return out;
}

const callCells = (kind: string, row: CallRow, now: number): Cell[] => [
  utc8Time(row.at),
  kind,
  NAME.test(row.provider) ? row.provider : '',
  row.model && NAME.test(row.model) ? row.model : '',
  word(PHASE_LABEL, row.phase),
  word(STATE_LABEL, row.state),
  word(OUTCOME_LABEL, row.outcome),
  safeCode(row.code),
  safeHttp(row.http),
  usd(row.held),
  usd(row.charged),
  Math.max(0, Math.floor((now - row.at) / 60_000)),
];

/** 模型调用, 外部调用, 向量调用 and the 结果未知的调用 ledger (the three kinds' UNKNOWN rows together). */
export function callSheets(store: Reader, now: number, filters: CallFilters): Sheet[] {
  const kinds = readCalls(store, filters);
  const sheets: Sheet[] = kinds.map(({ kind, rows }) => ({
    name: kind,
    file: CALL_FILE[kind] ?? 'calls',
    header: CALLS_HEADER,
    rows: rows.map((row) => callCells(kind, row, now)),
  }));
  const unknown = kinds.flatMap(({ kind, rows }) =>
    rows.filter((row) => row.state === 'unknown').map((row) => callCells(kind, row, now)),
  );
  unknown.sort((a, b) => (a[0]! < b[0]! ? 1 : -1));
  sheets.push({ name: '结果未知的调用', file: 'unknown', header: CALLS_HEADER, rows: unknown });
  return sheets;
}

export const FAILURES_HEADER = [
  '时间（UTC+8）',
  '角色',
  '回复写法',
  '草稿模型',
  '审核模型',
  '失败阶段',
  '状态',
  '错误代码',
] as const;

/** 失败的回复: failed and 结果未知 replies still on the books, newest first, with the stage the last failed call belonged to. */
export function failureSheets(
  store: Reader,
  filters: Pick<ConversationFilters, 'from' | 'to' | 'characterId' | 'writer' | 'model'>,
): Sheet[] {
  const where = ["o.status IN ('failed','unknown')"],
    args: (string | number)[] = [];
  if (filters.from !== null) {
    where.push('o.created_at>=?');
    args.push(dayStart(filters.from));
  }
  if (filters.to !== null) {
    where.push('o.created_at<?');
    args.push(dayStart(filters.to) + 86_400_000);
  }
  if (filters.characterId !== null) {
    where.push('o.character_id=?');
    args.push(filters.characterId);
  }
  const { byOperation } = readOperations(store, where.join(' AND '), args);
  const names = new Map<string, string>();
  const attempts = tableExists(store, 'web_provider_attempts');
  const rows: Cell[][] = [];
  const ops = [...byOperation.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [operationId, op] of ops) {
    if (filters.writer !== null && op.writer !== filters.writer) continue;
    if (filters.model !== null && op.draftModel !== filters.model && op.reviewModel !== filters.model) continue;
    let name = names.get(op.characterId);
    if (name === undefined) names.set(op.characterId, (name = characterFacts(store, op.characterId).label));
    const stage = attempts
      ? store.get<{ phase: string }>(
          `SELECT phase FROM web_provider_attempts WHERE operation_id=? AND (outcome='failed' OR state='unknown')
          ORDER BY created_at DESC,phase LIMIT 1`,
          operationId,
        )?.phase
      : undefined;
    rows.push([
      utc8Time(op.createdAt),
      name,
      WRITER_LABEL[op.writer as keyof typeof WRITER_LABEL],
      op.draftModel,
      op.reviewModel,
      stage ? word(PHASE_LABEL, stage) : '未到模型调用',
      statusLabel(op.status),
      op.status === 'failed' ? (op.failureCode ?? 'UNKNOWN') : '',
    ]);
  }
  return [{ name: '失败的回复', header: FAILURES_HEADER, rows }];
}

export { parseConversationFilters };
