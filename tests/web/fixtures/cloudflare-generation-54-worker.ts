import { WorkerEntrypoint } from 'cloudflare:workers';
import { WebIsolatedGenerationSession } from '../../../workers/web-cloudflare/generation.ts';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { draftEnvelope, acceptedAuditEnvelope } from '../../text-fixtures.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';

/**
 * Part 54 test generation Worker: the REAL session code (workers/web-cloudflare/generation.ts) over a fake provider network with
 * latency, a slow tail, a call that never answers, and a provider concurrency limit (HTTP 429). It counts what it was asked.
 */
interface Model {
  scale: number;
  draft: [number, number];
  review: [number, number];
  voice: [number, number];
  slowEvery: number;
  slowMs: number;
  hangFirst: number;
  hangStage: string;
  providerLimit: number;
}
let model: Model = {
  scale: 0.01,
  draft: [2000, 5000],
  review: [2000, 5000],
  voice: [3000, 8000],
  slowEvery: 0,
  slowMs: 15000,
  hangFirst: 0,
  hangStage: 'draft',
  providerLimit: 0,
};
const calls: { stage: string; start: number; end: number; outcome: string }[] = [];
let inFlight = 0,
  maxInFlight = 0,
  opens = 0,
  roundTrips = 0,
  seq = 0;
const perStage: Record<string, number> = {};
// A small deterministic generator so a run is repeatable.
let seed = 54;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const between = ([a, b]: [number, number]) => a + rand() * (b - a);

class SyntheticWebSession extends WebIsolatedGenerationSession {
  private readonly input: { request?: TextGenerationRequest };
  constructor() {
    const input: { request?: TextGenerationRequest } = {};
    super(
      { EXTERNAL_CALLS: 'true', DEEPSEEK_API_KEY: 'offline-only', FISH_API_KEY: 'offline-only' },
      async (url, init) => {
        const speech = String(url).includes('fish.audio');
        const body = JSON.parse(String(init!.body));
        const stage = speech ? 'speech' : body.tools[0].function.name === 'submit_dialogue_draft' ? 'draft' : 'review';
        const nth = (perStage[stage] = (perStage[stage] ?? 0) + 1);
        const entry = { stage, start: Date.now(), end: 0, outcome: 'open' };
        calls.push(entry);
        seq++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const done = (outcome: string) => {
          if (entry.outcome === 'open') {
            entry.end = Date.now();
            entry.outcome = outcome;
            inFlight--;
          }
        };
        try {
          if (model.providerLimit > 0 && inFlight > model.providerLimit) {
            done('429');
            return new Response('{}', { status: 429 });
          }
          const signal = init!.signal!;
          const wait = (ms: number) =>
            new Promise<void>((resolve, reject) => {
              const abort = () => reject(new DOMException('aborted', 'AbortError'));
              if (signal.aborted) return abort();
              signal.addEventListener('abort', abort, { once: true });
              if (ms === Infinity) return;
              setTimeout(() => {
                signal.removeEventListener('abort', abort);
                resolve();
              }, ms);
            });
          if (model.hangFirst > 0 && stage === model.hangStage && nth <= model.hangFirst) await wait(Infinity);
          const slow = model.slowEvery > 0 && seq % model.slowEvery === 0;
          const ms = slow ? model.slowMs : between(speech ? model.voice : stage === 'draft' ? model.draft : model.review);
          await wait(ms * model.scale);
          done('ok');
          if (speech)
            return new Response(Uint8Array.from(syntheticTone(250)), {
              headers: { 'content-type': 'audio/wav', 'x-request-id': 'offline-speech' },
            });
          return Response.json({
            ...(stage === 'draft' ? draftEnvelope(input.request!) : acceptedAuditEnvelope(input.request!)),
            id: 'offline-' + stage,
          });
        } catch (error) {
          done('aborted');
          throw error;
        }
      },
    );
    this.input = input;
  }
  override async text(...args: Parameters<WebIsolatedGenerationSession['text']>) {
    this.input.request = structuredClone(args[0]);
    return super.text(...args);
  }
  override async runText(job: Parameters<WebIsolatedGenerationSession['runText']>[0]) {
    this.input.request = structuredClone(job.request);
    roundTrips++;
    return super.runText(job);
  }
}
export class SyntheticWebGenerationService extends WorkerEntrypoint {
  open() {
    opens++;
    return new SyntheticWebSession();
  }
  /** Part 54: the reply path, one call and one result. The real session code runs; only the provider network is fake. */
  runText(job: Parameters<WebIsolatedGenerationSession['runText']>[0]) {
    return new SyntheticWebSession().runText(job);
  }
  runSpeech(job: { wire: Parameters<WebIsolatedGenerationSession['speech']>[0]; callTimeoutMs: number }) {
    roundTrips++;
    return new SyntheticWebSession().speech(job.wire, async () => {}, job.callTimeoutMs);
  }
  configure(value: string) {
    model = { ...model, ...(JSON.parse(value) as Partial<Model>) };
    calls.length = 0;
    inFlight = maxInFlight = opens = seq = roundTrips = 0;
    for (const key of Object.keys(perStage)) delete perStage[key];
  }
  stats() {
    return [JSON.stringify({ calls: [...calls], maxInFlight, opens, roundTrips })];
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
