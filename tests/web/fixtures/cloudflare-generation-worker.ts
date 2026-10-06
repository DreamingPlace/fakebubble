import { WorkerEntrypoint } from 'cloudflare:workers';
import { WebIsolatedGenerationSession } from '../../../workers/web-cloudflare/generation.ts';
import type { TextGenerationRequest, AcceptedV7StageOutput } from '../../../packages/contracts/index.ts';
import type { WebKnownDraft } from '../../../packages/contracts/web-generation-rpc.ts';
import type { ProviderMeter } from '../../../packages/contracts/provider-calls.ts';
import { draftEnvelope, acceptedAuditEnvelope } from '../../text-fixtures.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';

let mode = '',
  calls: string[] = [];
class SyntheticWebSession extends WebIsolatedGenerationSession {
  private readonly input: { request?: TextGenerationRequest };
  constructor() {
    const input: { request?: TextGenerationRequest } = {};
    super(
      {
        EXTERNAL_CALLS: mode === 'disabled' ? 'false' : 'true',
        DEEPSEEK_API_KEY: 'offline-only',
        FISH_API_KEY: 'offline-only',
      },
      async (url, init) => {
        const speech = String(url).includes('fish.audio');
        const body = JSON.parse(String(init!.body));
        calls.push(speech ? 'speech' : body.tools[0].function.name);
        if (mode === 'slow')
          await new Promise<void>((_resolve, reject) => {
            const signal = init!.signal!;
            const abort = () => reject(Error('offline abort'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
        if (speech)
          return new Response(
            mode === 'invalid-audio'
              ? new Uint8Array([1, 2, 3])
              : Uint8Array.from(syntheticTone(mode === 'large-audio' ? 60_000 : 250)),
            { headers: { 'content-type': 'audio/wav', 'x-request-id': 'offline-speech' } },
          );
        const draft = body.tools[0].function.name === 'submit_dialogue_draft';
        return Response.json({
          ...(draft ? draftEnvelope(input.request!) : acceptedAuditEnvelope(input.request!)),
          id: draft ? 'offline-draft' : 'offline-review',
        });
      },
    );
    this.input = input;
  }
  override text(
    request: TextGenerationRequest,
    policyHash: string,
    known: WebKnownDraft | null,
    meter: ProviderMeter,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
  ) {
    this.input.request = structuredClone(request);
    return super.text(request, policyHash, known, meter, accept);
  }
}
/** Never deployed: configurable fake transport replaces all outbound fetches. */
export class SyntheticWebGenerationService extends WorkerEntrypoint {
  open() {
    return new SyntheticWebSession();
  }
  configure(value: string) {
    mode = value;
    calls = [];
  }
  stats() {
    return [...calls];
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
