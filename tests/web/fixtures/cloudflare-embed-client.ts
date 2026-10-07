import { webCloudEmbeddings } from '../../../apps/server/cloudflare/web-generators.ts';
import { EmbeddingFailure } from '../../../apps/server/generation/embedding-provider.ts';
import type { WebGenerationBinding } from '../../../packages/contracts/web-generation-rpc.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

export default {
  async fetch(
    request: Request,
    env: {
      GENERATION: WebGenerationBinding & { configure(mode: string): Promise<void>; stats(): Promise<string[][]> };
    },
  ) {
    const { mode = '', texts = ['猫'] } = (await request.json()) as { mode?: string; texts?: string[] };
    await env.GENERATION.configure(mode);
    const controller = new AbortController();
    let gates = 0;
    try {
      const result = await webCloudEmbeddings(env.GENERATION).embed(texts, controller.signal, async () => {
        gates++;
        if (mode === 'gate') throw new DomainError('WEB_PROVIDER_CLAIM_STALE');
        if (mode === 'slow') setTimeout(() => controller.abort(), 50);
      });
      return Response.json({
        ok: true,
        count: result.vectors.length,
        dims: result.vectors.map((v) => v.length),
        axes: result.vectors.map((v) => v.indexOf(1)),
        usageTokens: result.usageTokens,
        gates,
        calls: await env.GENERATION.stats(),
      });
    } catch (error) {
      return Response.json({
        ok: false,
        code: error instanceof EmbeddingFailure || error instanceof DomainError ? error.code : 'RPC_FAILED',
        known: error instanceof EmbeddingFailure ? error.known : null,
        gates,
        calls: await env.GENERATION.stats(),
      });
    }
  },
};
