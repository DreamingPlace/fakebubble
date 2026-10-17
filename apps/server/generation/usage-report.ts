import { PLAYER_MODELS, POINTS, type PlayerModelId } from '../../../packages/contracts/player-models.ts';
import type { PriceTable } from '../admission/web-model-settings.ts';

/** Part 21g: the points table in force is the owner's (web_model_settings); the constant only serves a database without it. */
const CONSTANT_TABLE: PriceTable = { version: POINTS.version, perReply: POINTS.perReply, voice: POINTS.voice };

/** One row of web_provider_usage: a UTC day, one provider/model/phase, summed. No principal, operation or content. */
export interface UsageRow {
  day: string;
  provider: string;
  model: string;
  phase: 'draft' | 'review' | 'speech';
  calls: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  bytes: number;
  cost_micros: number;
  replies: number;
}
export interface ModelCost {
  model: PlayerModelId;
  provider: string;
  providerModel: string;
  /** Accepted replies this model drafted in the period. */
  replies: number;
  draftMicros: number | null;
  reviewMicros: number | null;
  speechMicros: number | null;
  /** Average real cost of ONE reply when this model drafts: its draft + the house review + voice. */
  totalMicros: number | null;
  /** Current points for one such reply (voice included). */
  points: number;
  /** What one point is worth at this model's measured cost, in micro-USD. */
  microsPerPoint: number | null;
}

const sum = (rows: UsageRow[], field: 'cost_micros' | 'replies' | 'calls') =>
  rows.reduce((total, row) => total + row[field], 0);
const average = (cost: number, count: number) => (count > 0 ? Math.round(cost / count) : null);

/**
 * Average real cost per reply per model, from the aggregate rows. Draft cost is this model's own; review and speech are
 * the same for every model (the house reviewer reviews, one voice), so they are averaged over ALL replies of the period.
 * All amounts are LIST prices in micro-USD (1 USD = 1,000,000).
 */
export function usageReport(
  rows: UsageRow[],
  table: PriceTable = CONSTANT_TABLE,
): { models: ModelCost[]; replies: number; unpriced: string[] } {
  const reviews = rows.filter((row) => row.phase === 'review');
  const speech = rows.filter((row) => row.phase === 'speech');
  const drafts = rows.filter((row) => row.phase === 'draft');
  const allReplies = sum(drafts, 'replies');
  const review = average(sum(reviews, 'cost_micros'), sum(reviews, 'replies'));
  const voice = average(sum(speech, 'cost_micros'), allReplies);
  const models: ModelCost[] = (Object.keys(PLAYER_MODELS) as PlayerModelId[]).map((id) => {
    const info = PLAYER_MODELS[id];
    const own = drafts.filter((row) => row.provider === info.provider && row.model === info.model);
    // Calls beyond the accepted replies (a slipped schema is billed too) are part of the real cost of a reply.
    const draft = average(sum(own, 'cost_micros'), sum(own, 'replies'));
    const total = draft === null || review === null ? null : draft + review + (voice ?? 0);
    const points = table.perReply[id] + table.voice;
    return {
      model: id,
      provider: info.provider,
      providerModel: info.model,
      replies: sum(own, 'replies'),
      draftMicros: draft,
      reviewMicros: review,
      speechMicros: voice,
      totalMicros: total,
      points,
      microsPerPoint: total === null ? null : Math.round(total / points),
    };
  });
  const unpriced = [
    ...new Set(
      rows.filter((row) => row.cost_micros === 0 && row.calls > 0).map((row) => `${row.provider}:${row.model}`),
    ),
  ];
  return { models, replies: allReplies, unpriced };
}

const usd = (micros: number | null) => (micros === null ? '    n/a' : `$${(micros / 1_000_000).toFixed(5)}`);
export function formatUsageReport(rows: UsageRow[], table: PriceTable = CONSTANT_TABLE): string {
  const days = [...new Set(rows.map((row) => row.day))].sort();
  const report = usageReport(rows, table);
  const lines = [
    `Usage at list price, UTC ${days[0] ?? '-'} .. ${days.at(-1) ?? '-'} (${days.length} day${days.length === 1 ? '' : 's'}, ${report.replies} accepted replies)`,
    `Points table v${table.version}: deepseek ${table.perReply.deepseek}, gemini ${table.perReply.gemini}, xai ${table.perReply.xai}, voice +${table.voice}`,
    '',
    'model       replies   draft       review      voice       per reply   points  USD/point',
  ];
  for (const m of report.models)
    lines.push(
      [
        m.model.padEnd(11),
        String(m.replies).padStart(7),
        usd(m.draftMicros).padStart(10),
        usd(m.reviewMicros).padStart(11),
        usd(m.speechMicros).padStart(11),
        usd(m.totalMicros).padStart(11),
        String(m.points).padStart(8),
        (m.microsPerPoint === null ? 'n/a' : `$${(m.microsPerPoint / 1_000_000).toFixed(6)}`).padStart(10),
      ].join(' '),
    );
  if (report.unpriced.length)
    lines.push('', `No list price known for: ${report.unpriced.join(', ')} (cost counted as 0)`);
  if (report.replies === 0) lines.push('', 'No accepted reply in the period yet: nothing to average.');
  return lines.join('\n');
}
