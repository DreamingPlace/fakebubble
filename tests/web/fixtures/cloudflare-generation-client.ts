import { WebCloudTextGenerator, webCloudSpeech } from '../../../apps/server/cloudflare/web-generators.ts';
import type { WebGenerationBinding } from '../../../packages/contracts/web-generation-rpc.ts';
import type { AcceptedV7StageOutput } from '../../../packages/contracts/index.ts';
import type { ProviderMeter, ProviderObservation } from '../../../packages/contracts/provider-calls.ts';
import { textRequest } from '../../text-fixtures.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { fishSpeechRequest } from '../../../workers/audio/fish.ts';
import type { SpeechRequest } from '../../../packages/contracts/audio.ts';
import { SpeechFailure } from '../../../workers/audio/validation-error.ts';
export default {
  async fetch(
    request: Request,
    env: {
      GENERATION: WebGenerationBinding & {
        configure(mode: string): Promise<void>;
        stats(): Promise<string[]>;
      };
    },
  ) {
    const { mode = '', speech = false } = (await request.json()) as { mode?: string; speech?: boolean };
    await env.GENERATION.configure(mode);
    const starts: { stage: string; hash: string | undefined; bytes: number | undefined }[] = [];
    const accepted: AcceptedV7StageOutput[] = [],
      observations: ProviderObservation[] = [];
    let closes = 0,
      gates = 0;
    const controller = new AbortController();
    const meter: ProviderMeter = {
      async reserve() {
        return {
          async start(stage, hash, bytes) {
            if (mode === 'gate') throw new DomainError('WEB_SHARED_BUDGET_EXHAUSTED');
            starts.push({ stage, hash, bytes });
            if (mode === 'slow') setTimeout(() => controller.abort(), 50);
            return {
              async finish(value) {
                observations.push(value);
              },
            };
          },
          close() {
            closes++;
          },
        };
      },
    };
    const accept = async (stage: AcceptedV7StageOutput) => {
      if (mode === 'accept-failed') throw new DomainError('WEB_SHARED_RECEIPT_MISSING');
      // Force a real callback await: the next stage must wait for this completed handoff.
      await new Promise((resolve) => setTimeout(resolve, 20));
      accepted.push(stage);
    };
    try {
      let result;
      if (speech) {
        const input: SpeechRequest = {
          jobId: 'offline',
          text: '合成RPC语音',
          expression: 'neutral',
          speed: 1,
          model: 's2.1-pro',
          qualityGuard: true,
          voice: { profileId: 'offline', referenceId: 'offline', version: 1 },
        };
        const prepared = fishSpeechRequest(input, 's2.1-pro');
        result = await webCloudSpeech(env.GENERATION)(
          {
            body: prepared.body,
            wireRequestHash: mode === 'tamper' ? 'f'.repeat(64) : prepared.requestHash,
            model: 's2.1-pro',
            billedTextBytes: prepared.bytes,
            speech: input,
          },
          controller.signal,
          async () => {
            gates++;
            if (mode === 'gate') throw new DomainError('WEB_PROVIDER_CLAIM_STALE');
            if (mode === 'slow') setTimeout(() => controller.abort(), 50);
          },
        );
        result = { bytes: result.audio.byteLength, usageUnits: result.usageUnits };
      } else {
        const text = new WebCloudTextGenerator(env.GENERATION),
          input = textRequest();
        result = await text.generateAcceptedStages(input, controller.signal, accept, meter);
        if (mode === 'resume') {
          const draft = accepted[0]!;
          await env.GENERATION.configure('');
          await text.generateAcceptedReviewFromKnownDraft(
            input,
            controller.signal,
            {
              payload: draft.payload,
              metadata: draft.metadata,
              requestDigest: draft.requestDigest,
              policyHash: draft.policyHash,
            },
            accept,
            meter,
          );
        }
      }
      return Response.json({
        ok: true,
        result,
        starts,
        stages: accepted.map((s) => s.stage),
        observations,
        closes,
        gates,
        calls: await env.GENERATION.stats(),
      });
    } catch (error) {
      return Response.json({
        ok: false,
        code: error instanceof DomainError ? error.code : 'RPC_FAILED',
        generation: error instanceof SpeechFailure ? error.generation : null,
        starts,
        stages: accepted.map((s) => s.stage),
        observations,
        closes,
        gates,
        calls: await env.GENERATION.stats(),
      });
    }
  },
};
