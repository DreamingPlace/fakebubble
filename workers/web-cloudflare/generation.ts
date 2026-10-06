import { WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { DeepSeekTextGenerator } from '../../apps/server/deepseek.ts';
import { TextGenerationFailure } from '../../apps/server/text-generation-error.ts';
import { FishAudio, fishSpeechRequest } from '../audio/fish.ts';
import { SpeechFailure } from '../audio/validation-error.ts';
import type { AcceptedV7StageOutput, TextGenerationRequest } from '../../packages/contracts/index.ts';
import type { ProviderMeter } from '../../packages/contracts/provider-calls.ts';
import type {
  WebGenerationSession,
  WebKnownDraft,
  WebSpeechWire,
} from '../../packages/contracts/web-generation-rpc.ts';
import type { TextRPCResult, SpeechRPCResult } from '../../packages/contracts/generation-rpc.ts';

export interface WebGenerationEnvironment {
  EXTERNAL_CALLS?: string;
  DEEPSEEK_API_KEY: string;
  FISH_API_KEY: string;
}
// Workers rejects redirect:'error' before dispatch. Manual mode preserves the
// adapters' fail-closed non-2xx checks without forwarding credentials elsewhere.
const providerFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'manual' });
const safeCode = (error: unknown) => (error instanceof DomainError ? error.code : 'GENERATION_SERVICE_FAILED');
async function callback<T>(work: () => T | Promise<T>) {
  try {
    return await work();
  } catch (error) {
    throw new DomainError(
      error instanceof Error && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.message)
        ? error.message
        : 'WEB_GENERATION_CALLBACK_FAILED',
    );
  }
}

/** Provider keys only: no database, bucket or budget binding. Every session is single-use. */
export class WebIsolatedGenerationSession extends RpcTarget implements WebGenerationSession {
  private readonly controller = new AbortController();
  private started = false;
  private readonly env: WebGenerationEnvironment;
  private readonly fetcher: typeof fetch;
  constructor(env: WebGenerationEnvironment, fetcher: typeof fetch = providerFetch) {
    super();
    this.env = env;
    this.fetcher = fetcher;
  }
  private begin() {
    ensure(this.env.EXTERNAL_CALLS === 'true', 'WEB_PROVIDER_LIVE_OPT_IN_REQUIRED');
    ensure(!this.started && !this.controller.signal.aborted, 'GENERATION_SESSION_CLOSED');
    this.started = true;
  }
  async cancel() {
    this.controller.abort();
  }
  [Symbol.dispose]() {
    this.controller.abort();
  }
  async text(
    request: TextGenerationRequest,
    policyHash: string,
    known: WebKnownDraft | null,
    meter: ProviderMeter,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
  ): Promise<TextRPCResult> {
    try {
      this.begin();
      const text = new DeepSeekTextGenerator({
        apiKey: this.env.DEEPSEEK_API_KEY,
        textProtocol: 'accepted-v7',
        fetch: this.fetcher,
      });
      ensure(text.policyHash === policyHash, 'WEB_PROVIDER_WIRE_MISMATCH');
      const remote: ProviderMeter = {
        reserve: (specs) =>
          callback(async () => {
            const reservation = await meter.reserve(specs);
            return {
              start: (stage, hash, bytes) =>
                callback(async () => {
                  const observer = await reservation.start(stage, hash, bytes);
                  return { finish: (value) => callback(() => observer.finish(value)) };
                }),
              close: () => callback(() => reservation.close()),
            };
          }),
      };
      const confirmed = (stage: AcceptedV7StageOutput) => callback(() => accept(stage));
      const value = known
        ? await text.generateAcceptedReviewFromKnownDraft(request, this.controller.signal, known, confirmed, remote)
        : await text.generateAcceptedStages(request, this.controller.signal, confirmed, remote);
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        code: safeCode(error),
        generation: error instanceof TextGenerationFailure ? error.generation : null,
      };
    }
  }
  async speech(wire: WebSpeechWire, authorize: () => Promise<void>): Promise<SpeechRPCResult> {
    try {
      this.begin();
      wire = structuredClone(wire);
      const prepared = fishSpeechRequest(wire.speech, wire.model);
      ensure(
        prepared.body === wire.body &&
          prepared.requestHash === wire.wireRequestHash &&
          prepared.bytes === wire.billedTextBytes,
        'WEB_PROVIDER_WIRE_MISMATCH',
      );
      const meter: ProviderMeter = {
        reserve: (specs) => {
          ensure(
            specs.length === 1 &&
              specs[0]!.provider === 'fish' &&
              specs[0]!.stage === 'speech' &&
              specs[0]!.model === wire.model,
            'WEB_PROVIDER_WIRE_MISMATCH',
          );
          return {
            start: async (stage, hash) => {
              ensure(stage === 'speech' && hash === wire.wireRequestHash, 'WEB_PROVIDER_WIRE_MISMATCH');
              await callback(authorize);
              ensure(!this.controller.signal.aborted, 'AUDIO_REQUEST_ABORTED');
              return { finish() {} };
            },
            close() {},
          };
        },
      };
      const value = await new FishAudio({
        apiKey: this.env.FISH_API_KEY,
        model: wire.model,
        fetch: this.fetcher,
      }).generate(wire.speech, this.controller.signal, meter);
      ensure(
        value.inputUTF8Bytes === wire.billedTextBytes && value.model === wire.model,
        'WEB_PROVIDER_USAGE_MISMATCH',
      );
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: safeCode(error), generation: error instanceof SpeechFailure ? error.generation : null };
    }
  }
}
export class WebGenerationService extends WorkerEntrypoint<WebGenerationEnvironment> {
  open() {
    ensure(this.env.EXTERNAL_CALLS === 'true', 'WEB_PROVIDER_LIVE_OPT_IN_REQUIRED');
    return new WebIsolatedGenerationSession(this.env);
  }
  fetch() {
    return new Response(null, { status: 404 });
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
