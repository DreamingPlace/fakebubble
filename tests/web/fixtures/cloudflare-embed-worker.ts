import { WorkerEntrypoint } from 'cloudflare:workers';
import { WebIsolatedGenerationSession } from '../../../workers/web-cloudflare/generation.ts';
import { fixtureVector } from '../../../apps/server/generation/embedding-provider.ts';

let mode = '',
  calls: string[][] = [];
/** A fake Workers AI binding: never leaves the isolate. */
const ai = {
  async run(model: string, input: unknown) {
    const text = (input as { text: string[] }).text;
    calls.push(text);
    if (model !== '@cf/baai/bge-m3') throw new Error('5007: No such model');
    if (mode === 'capacity') throw new Error('AiError: 3040: Capacity temporarily exceeded');
    if (mode === 'boom') throw new Error('InferenceUpstreamError');
    if (mode === 'slow') await new Promise(() => {});
    if (mode === 'invalid') return { data: [[1, 2, 3]] };
    return {
      shape: [text.length, 1024],
      data: text.map((_, i) => Array.from(fixtureVector({ [i]: 1 }))),
      usage: mode === 'usage' ? { prompt_tokens: 7 } : undefined,
    };
  },
};
/** Never deployed: the generation session with a fake `AI` binding and no network. */
export class SyntheticEmbedService extends WorkerEntrypoint {
  open() {
    return new WebIsolatedGenerationSession({
      EXTERNAL_CALLS: mode === 'disabled' ? 'false' : 'true',
      EMBEDDINGS_ENABLED: mode === 'off' ? 'false' : 'true',
      DEEPSEEK_API_KEY: 'offline-only',
      FISH_API_KEY: 'offline-only',
      AI: ai,
    });
  }
  configure(value: string) {
    mode = value;
    calls = [];
  }
  stats() {
    return calls.map((texts) => [...texts]);
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
