import { WorkerEntrypoint } from 'cloudflare:workers';
import { WebIsolatedGenerationSession } from '../../../workers/web-cloudflare/generation.ts';
import type { TextGenerationRequest, AcceptedV7StageOutput } from '../../../packages/contracts/index.ts';
import type { TextRoute } from '../../../packages/contracts/text-route.ts';
import type { WebKnownDraft } from '../../../packages/contracts/web-generation-rpc.ts';
import type { ProviderMeter } from '../../../packages/contracts/provider-calls.ts';
import { acceptedAuditEnvelope, draftEnvelope, draftWire, toolEnvelope } from '../../text-fixtures.ts';

// Part 40: the REAL generation session (keys for Grok and Gemini, the route passed on) with a fake transport that answers like each
// provider. Every call is logged as provider:model:shape. Never deployed.
let calls: string[] = [];
const usage = { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300 };
class Session extends WebIsolatedGenerationSession {
  private readonly input: { request?: TextGenerationRequest };
  constructor() {
    const input: { request?: TextGenerationRequest } = {};
    super(
      {
        EXTERNAL_CALLS: 'true',
        DEEPSEEK_API_KEY: 'offline-only',
        FISH_API_KEY: 'offline-only',
        XAI_API_KEY: 'offline-x',
        GEMINI_API_KEY: 'offline-g',
      },
      async (url, init) => {
        const body = JSON.parse(String(init!.body));
        const provider = String(url).includes('x.ai')
          ? 'xai'
          : String(url).includes('googleapis')
            ? 'gemini'
            : 'deepseek';
        const request = input.request!;
        const tool = body.tools ? (body.tools[0].function.name as string) : 'plain';
        calls.push(`${provider}:${body.model}:${tool}`);
        if (tool === 'plain') {
          const message = { role: 'assistant', content: '行啊\n晚点再说' };
          return Response.json({
            id: 'plain',
            model: body.model,
            choices: [{ finish_reason: 'stop', message }],
            usage,
          });
        }
        if (tool === 'submit_reply_check') {
          const properties = body.tools[0].function.parameters.properties;
          const answer = {
            fixes: [],
            mode: 'casual',
            endsSession: false,
            topics: [],
            factOps: [],
            ...(properties.sceneUpdate ? { sceneUpdate: null } : {}),
            ...(properties.relationshipEvents ? { relationshipEvents: [] } : {}),
          };
          return Response.json({ ...toolEnvelope('submit_reply_check', answer), model: body.model, usage });
        }
        if (tool !== 'submit_dialogue_draft') return Response.json(acceptedAuditEnvelope(request));
        if (provider === 'deepseek') return Response.json(draftEnvelope(request));
        const base = toolEnvelope('submit_dialogue_draft', draftWire(request));
        return Response.json({
          ...base,
          model: body.model,
          choices: [{ ...base.choices[0]!, finish_reason: provider === 'xai' ? 'tool_calls' : 'stop' }],
          usage,
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
    route?: TextRoute,
  ) {
    this.input.request = structuredClone(request);
    return super.text(request, policyHash, known, meter, accept, route);
  }
}
export class SyntheticWebGenerationService extends WorkerEntrypoint {
  open() {
    return new Session();
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
