import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';

/** Deliberately synthetic protocol fixture. No model, cloned voice, or business Store access. */
export function syntheticText(request: TextGenerationRequest) {
  const reply = '这是本地合成测试回复，不代表真实人物。';
  const draft = {
    mode: 'casual',
    utterance: { text: reply, expression: 'neutral' },
    afterthoughts: [],
    endsSession: request.mustClose,
  };
  const coverage = Object.fromEntries(
    request.requiredMessageIds.map((id) => [id, { status: 'answered', supportQuote: reply, missingInformation: '' }]),
  );
  const review = {
    decision: 'accept',
    replacementBubbles: [],
    topics: [],
    ...(request.requiredMessageIds.length ? { coverage } : {}),
    ...(request.evidence.length
      ? { sourceUsage: Object.fromEntries(request.evidence.map((source) => [source.id, []])) }
      : {}),
    ...(request.relationshipContext?.auditEnabled ? { relationshipEvents: [] } : {}),
    ...(request.sceneContext ? { sceneUpdate: null } : {}),
  };
  return { draft, review };
}

/** Fixed, short PCM tone; bytes are marked synthetic_test at the business boundary. */
export function syntheticTone(durationMs = 250): Buffer {
  const sampleRate = 24_000,
    frames = Math.round((durationMs * sampleRate) / 1000);
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    wav.writeInt16LE(Math.round(Math.sin((i * 440 * 2 * Math.PI) / sampleRate) * 6000), 44 + i * 2);
  return wav;
}
