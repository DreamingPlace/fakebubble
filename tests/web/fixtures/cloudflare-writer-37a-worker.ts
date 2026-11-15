import { WorkerEntrypoint } from 'cloudflare:workers';
import { WebIsolatedGenerationSession } from '../../../workers/web-cloudflare/generation.ts';

let calls: { plain: boolean; temperature: unknown }[] = [];
/** Never deployed: the real generation session with a fake transport. A v8 draft is a plain completion, the guard is a forced tool. */
class SyntheticWriterSession extends WebIsolatedGenerationSession {
  constructor() {
    super(
      { EXTERNAL_CALLS: 'true', DEEPSEEK_API_KEY: 'offline-only', FISH_API_KEY: 'offline-only' },
      async (_url, init) => {
        const body = JSON.parse(String(init!.body));
        calls.push({ plain: !body.tools, temperature: body.temperature });
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (!body.tools)
          return Response.json({
            id: 'offline-draft',
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '好呀' } }],
            usage,
          });
        const properties = body.tools[0].function.parameters.properties;
        return Response.json({
          id: 'offline-guard',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call',
                    type: 'function',
                    function: {
                      name: 'submit_reply_check',
                      arguments: JSON.stringify({
                        fixes: [],
                        mode: 'casual',
                        endsSession: false,
                        topics: [],
                        factOps: [],
                        ...(properties.sceneUpdate ? { sceneUpdate: null } : {}),
                        ...(properties.relationshipEvents ? { relationshipEvents: [] } : {}),
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage,
        });
      },
    );
  }
}
export class SyntheticWriterService extends WorkerEntrypoint {
  open() {
    return new SyntheticWriterSession();
  }
  reset() {
    calls = [];
  }
  stats() {
    return calls.map((call) => ({ ...call }));
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
