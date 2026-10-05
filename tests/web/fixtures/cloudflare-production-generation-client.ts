import { WebCloudTextGenerator, webCloudSpeech } from '../../../apps/server/cloudflare/web-generators.ts';
import type { WebGenerationBinding } from '../../../packages/contracts/web-generation-rpc.ts';
import type { ProviderMeter } from '../../../packages/contracts/provider-calls.ts';
import { textRequest } from '../../text-fixtures.ts';
import { fishSpeechRequest } from '../../../workers/audio/fish.ts';
import type { SpeechRequest } from '../../../packages/contracts/audio.ts';

export default { async fetch(request: Request, env: { GENERATION: WebGenerationBinding }) {
  const starts: string[] = [], stages: string[] = [];
  const meter: ProviderMeter = { reserve: () => ({ start: stage => {
    starts.push(stage); return { finish() {} };
  }, close() {} }) };
  try {
    if (new URL(request.url).searchParams.has('speech')) {
      const speech: SpeechRequest = { jobId: 'offline', text: '仅离线测试', expression: 'neutral', speed: 1,
        voice: { profileId: 'offline', referenceId: 'offline', version: 1 } };
      const prepared = fishSpeechRequest(speech, 's2.1-pro');
      const result = await webCloudSpeech(env.GENERATION)({ speech, model: 's2.1-pro', body: prepared.body,
        wireRequestHash: prepared.requestHash, billedTextBytes: prepared.bytes }, AbortSignal.timeout(3000),
      async () => { starts.push('speech'); });
      return Response.json({ ok: true, starts, bytes: result.audio.byteLength });
    }
    const generator = new WebCloudTextGenerator(env.GENERATION);
    await generator.generateAcceptedStages(textRequest(), AbortSignal.timeout(3000),
      async stage => { stages.push(stage.stage); }, meter);
    return Response.json({ ok: true, starts, stages });
  } catch (error) {
    return Response.json({ ok: false, starts, stages, error: error instanceof Error ? error.message : 'UNKNOWN' });
  }
} };
