import { createHash } from 'node:crypto';

/** Compose time for the NEXT bubble. This never draws from the availability RNG or changes audio. */
export function deliveryDelay(jobId: string, ordinal: number, text: string, speechDurationMs?: number): number {
  const variation = createHash('sha256').update(`${jobId}:${ordinal}`).digest().readUInt16BE(0) / 65535;
  // Keep short bursts observable by the current native poller without exceeding its API rate budget.
  if (speechDurationMs !== undefined) return Math.ceil(Math.max(2600, speechDurationMs + 350 + variation * 450));
  return Math.round(Math.max(2600, Math.min(12_000, 550 + [...text].length * (100 + variation * 90))));
}
