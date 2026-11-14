import { textPolicyHash, textWriterPolicyHash } from '../../../apps/server/generation/text-generation-policy.ts';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type { ProviderMeter } from '../../../packages/contracts/provider-calls.ts';
import type { WebGenerationBinding } from '../../../packages/contracts/web-generation-rpc.ts';
import { textRequest } from '../../text-fixtures.ts';

type Binding = WebGenerationBinding & {
  reset(): Promise<void>;
  stats(): Promise<{ plain: boolean; temperature: unknown }[]>;
};
const meter: ProviderMeter = {
  async reserve() {
    return {
      async start() {
        return { async finish() {} };
      },
      close() {},
    };
  },
};
export default {
  async fetch(request: Request, env: { GENERATION: Binding }) {
    const { hash = 'v8', writer = 'v8' } = (await request.json()) as {
      hash?: 'v7' | 'v8' | 'junk';
      writer?: 'v7' | 'v8';
    };
    await env.GENERATION.reset();
    const { relationship, ...base } = textRequest();
    const input: TextGenerationRequest =
      writer === 'v8' ? { ...base, writer: 'v8' } : { ...base, relationship: relationship! };
    const policyHash = hash === 'v7' ? textPolicyHash() : hash === 'v8' ? textWriterPolicyHash() : 'f'.repeat(64);
    const session = await env.GENERATION.open();
    const result = await session.text(input, policyHash, null, meter, async () => {});
    await session.cancel();
    return Response.json({
      result: result.ok ? { ok: true } : { ok: false, code: result.code },
      calls: await env.GENERATION.stats(),
    });
  },
};
