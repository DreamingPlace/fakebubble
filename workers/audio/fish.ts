import { providerRequestHash } from '../../packages/domain/provider-request.ts';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type {
  FishAPICredit,
  FishModel,
  PrivateVoice,
  SpeechGenerator,
  SpeechRequest,
  SpeechResult,
  VoiceUploadApproval,
} from '../../packages/contracts/audio.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { finalizeFishWav, inspectPCM, pcmLevels } from './wav.ts';
import { AudioValidationFailure, SpeechFailure } from './validation-error.ts';
import type { ProviderMeter } from '../../packages/contracts/provider-calls.ts';
import { meteredSpeech } from './metering.ts';

// S2 bracket cues are natural-language direction, not guaranteed emotion tokens.
// Mock annoyance is deliberately not real anger or shouting.
const expressions = {
  neutral: '',
  upbeat: '[happy]',
  soft: '[soft tone]',
  hesitant: '[uncertain]',
  serious: '[serious, sincere]',
  playful: '[playful, smiling]',
  mock_annoyed: '[playfully indignant, teasing, not angry]',
  excited: '[excited]',
  sad: '[sad, subdued]',
  surprised: '[surprised]',
} as const;
function id(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'INVALID_VOICE_ID');
}
export function speechPayload(request: SpeechRequest) {
  id(request.jobId);
  ensure(request.voice, 'VOICE_REQUIRED');
  id(request.voice.profileId);
  id(request.voice.referenceId);
  ensure(Number.isSafeInteger(request.voice.version) && request.voice.version > 0, 'INVALID_VOICE_VERSION');
  ensure(
    typeof request.text === 'string' && request.text.trim() && [...request.text].length <= 700,
    'INVALID_SPEECH_TEXT',
  );
  ensure(!/[\[\]<>]/u.test(request.text), 'AUDIO_CONTROL_MARKER_FORBIDDEN');
  ensure(Object.hasOwn(expressions, request.expression), 'INVALID_AUDIO_EXPRESSION');
  ensure(Number.isFinite(request.speed) && request.speed >= 0.5 && request.speed <= 2, 'INVALID_SPEECH_SPEED');
  ensure(
    request.qualityGuard === undefined || typeof request.qualityGuard === 'boolean',
    'INVALID_AUDIO_QUALITY_GUARD',
  );
  const style = request.deliveryStyle ?? 'conversational';
  const deliveryCues = {
    conversational: '',
    quiet: '[quiet, soft conversational tone]',
    tender_whisper: '[whispering][warm, gentle, natural voice]',
  } as const;
  ensure(Object.hasOwn(deliveryCues, style), 'INVALID_SPEECH_STYLE');
  return {
    text: `${expressions[request.expression]}${deliveryCues[style]}${request.text}`,
    reference_id: request.voice.referenceId,
    format: 'wav',
    sample_rate: 24000,
    prosody: { speed: request.speed, volume: 0, normalize_loudness: true },
    latency: 'normal',
    normalize: true,
    chunk_length: 200,
    temperature: 0.7,
    top_p: 0.7,
    ...(request.qualityGuard ? { features: ['quality-guard'] } : {}),
  };
}
/** Shared by direct and child-process transports: serialize once before the send gate. */
export function fishSpeechRequest(request: SpeechRequest, model: FishModel) {
  const payload = speechPayload(request),
    body = JSON.stringify(payload);
  return {
    body,
    bytes: Buffer.byteLength(payload.text, 'utf8'),
    requestHash: providerRequestHash('https://api.fish.audio/v1/tts', model, body),
  };
}
async function readLimited(response: Response, limit: number): Promise<Buffer> {
  ensure(response.body, 'EMPTY_AUDIO_RESPONSE');
  const announced = response.headers.get('content-length');
  if (announced && Number(announced) > limit) {
    await response.body.cancel();
    throw new DomainError('AUDIO_RESPONSE_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new DomainError('AUDIO_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
function privateVoice(input: unknown): PrivateVoice {
  ensure(
    input &&
      typeof input === 'object' &&
      '_id' in input &&
      'state' in input &&
      'visibility' in input &&
      'type' in input &&
      input.type === 'tts',
    'INVALID_FISH_MODEL',
  );
  id(input._id);
  ensure(input.visibility === 'private', 'VOICE_NOT_PRIVATE');
  ensure(
    typeof input.state === 'string' && ['created', 'training', 'trained', 'failed'].includes(input.state),
    'INVALID_FISH_MODEL',
  );
  return { id: input._id, state: input.state as PrivateVoice['state'], visibility: 'private' };
}

/** Provider adapter only: no SQLite, business credentials, private chat context, retries or publication. */
export class FishAudio implements SpeechGenerator {
  readonly providerCalls = 'external' as const;
  #key: string;
  #fetch: typeof fetch;
  #model: FishModel;
  #timeoutMs: number;
  get model() {
    return this.#model;
  }
  constructor(options: { apiKey: string; model?: FishModel; fetch?: typeof fetch; timeoutMs?: number }) {
    ensure(
      typeof options.apiKey === 'string' &&
        options.apiKey.trim() &&
        options.apiKey.length <= 512 &&
        !/[\r\n]/.test(options.apiKey),
      'FISH_KEY_MISSING',
    );
    this.#key = options.apiKey.trim();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#model = options.model ?? 's2.1-pro';
    ensure(['s2.1-pro', 's2-pro'].includes(this.model), 'UNSUPPORTED_FISH_MODEL');
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    ensure(
      Number.isSafeInteger(this.#timeoutMs) && this.#timeoutMs > 0 && this.#timeoutMs <= 120_000,
      'INVALID_AUDIO_TIMEOUT',
    );
  }
  async generate(request: SpeechRequest, signal: AbortSignal, meter?: ProviderMeter): Promise<SpeechResult> {
    request = structuredClone(request);
    ensure(request.model === undefined || request.model === this.model, 'VOICE_MODEL_MISMATCH');
    const prepared = fishSpeechRequest(request, this.model);
    const start = performance.now();
    ensure(!signal.aborted, 'AUDIO_REQUEST_ABORTED');
    return meteredSpeech(meter, this.model, prepared.bytes, prepared.requestHash, () =>
      this.run(signal, async (combined) => {
        const response = await this.send(
          '/v1/tts',
          { method: 'POST', body: prepared.body, headers: { 'content-type': 'application/json', model: this.model } },
          combined,
        );
        const type = response.headers.get('content-type')?.split(';')[0]?.trim();
        if (!type || !['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'].includes(type)) {
          await response.body?.cancel();
          throw new DomainError('INVALID_AUDIO_CONTENT_TYPE');
        }
        const raw = await readLimited(response, 6_000_000);
        const providerRequestId = response.headers.get('x-request-id');
        const generation = {
          provider: 'fish' as const,
          model: this.model,
          elapsedMs: Math.round(performance.now() - start),
          requestId: providerRequestId && /^[A-Za-z0-9_-]{1,256}$/.test(providerRequestId) ? providerRequestId : null,
          inputCharacters: [...request.text].length,
          inputUTF8Bytes: prepared.bytes,
          billedAmount: null,
          ...(request.qualityGuard === undefined ? {} : { qualityGuardRequested: request.qualityGuard }),
        };
        try {
          ensure(!combined.aborted, 'AUDIO_REQUEST_ABORTED');
          const { audio, finalized } = finalizeFishWav(raw);
          const info = inspectPCM(audio, 60_000);
          ensure(info.channels === 1 && info.sampleRate === 24000, 'UNEXPECTED_AUDIO_FORMAT');
          ensure(pcmLevels(audio).rms > 0.00001, 'SILENT_AUDIO_RESPONSE');
          return {
            jobId: request.jobId,
            voice: structuredClone(request.voice),
            ...generation,
            audio,
            mime: 'audio/wav',
            durationMs: info.durationMs,
            sampleRate: info.sampleRate,
            ...(finalized ? { originalAudio: raw, containerNormalization: 'stream_length_fields' as const } : {}),
          };
        } catch (error) {
          if (error instanceof DomainError) throw new AudioValidationFailure(error.code, raw, generation);
          throw error;
        }
      }),
    );
  }
  async createPrivateVoice(
    reference: Uint8Array,
    title: string,
    approval: VoiceUploadApproval,
    signal: AbortSignal,
    enhanceAudioQuality = false,
  ): Promise<PrivateVoice> {
    ensure(typeof enhanceAudioQuality === 'boolean', 'INVALID_VOICE_ENHANCEMENT');
    ensure(
      approval?.provider === 'fish' &&
        approval.uploadApproved === true &&
        createHash('sha256').update(reference).digest('hex') === approval.referenceSHA256,
      'VOICE_UPLOAD_NOT_APPROVED',
    );
    const info = inspectPCM(reference, 30_000);
    ensure(
      info.channels === 1 && info.durationMs >= 10_000 && reference.length <= 3_000_000,
      'INVALID_VOICE_REFERENCE',
    );
    ensure(typeof title === 'string' && /^[A-Za-z0-9 _-]{1,100}$/.test(title), 'INVALID_VOICE_TITLE');
    const form = new FormData();
    form.set('type', 'tts');
    form.set('title', title);
    form.set('visibility', 'private');
    form.set('train_mode', 'fast');
    form.set('enhance_audio_quality', String(enhanceAudioQuality));
    form.set('voices', new Blob([Uint8Array.from(reference)], { type: 'audio/wav' }), 'reference.wav');
    return this.run(signal, async (combined) => {
      const response = await this.send('/model', { method: 'POST', body: form }, combined);
      return privateVoice(await this.json(response));
    });
  }
  async getPrivateVoice(referenceId: string, signal: AbortSignal): Promise<PrivateVoice> {
    id(referenceId);
    return this.run(signal, async (combined) => {
      const result = privateVoice(
        await this.json(await this.send('/model/' + referenceId, { method: 'GET' }, combined)),
      );
      ensure(result.id === referenceId, 'VOICE_ID_MISMATCH');
      return result;
    });
  }
  async getAPICredit(signal: AbortSignal): Promise<FishAPICredit> {
    return this.run(signal, async (combined) => {
      const value = await this.json(await this.send('/wallet/self/api-credit', { method: 'GET' }, combined));
      ensure(
        value &&
          typeof value === 'object' &&
          'credit' in value &&
          typeof value.credit === 'string' &&
          value.credit.length <= 64 &&
          /^-?\d+(\.\d+)?$/.test(value.credit),
        'INVALID_FISH_CREDIT',
      );
      const credit = value.credit;
      // Only availability matters here; do not infer currency, prices or retain account identifiers.
      return { credit, hasCredit: !credit.startsWith('-') && /[1-9]/.test(credit) };
    });
  }
  private async json(response: Response): Promise<unknown> {
    const bytes = await readLimited(response, 262_144);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new DomainError('INVALID_FISH_RESPONSE');
    }
  }
  private async send(path: string, init: RequestInit, signal: AbortSignal) {
    const response = await this.#fetch('https://api.fish.audio' + path, {
      ...init,
      redirect: 'error',
      signal,
      headers: { ...init.headers, authorization: 'Bearer ' + this.#key },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError(
        response.status === 401 || response.status === 403
          ? 'FISH_AUTH_FAILED'
          : response.status === 402
            ? 'FISH_BALANCE_REQUIRED'
            : response.status === 429
              ? 'FISH_RATE_LIMITED'
              : response.status >= 500
                ? 'FISH_UNAVAILABLE'
                : 'FISH_REQUEST_REJECTED',
      );
    }
    return response;
  }
  private async run<T>(signal: AbortSignal, action: (combined: AbortSignal) => Promise<T>): Promise<T> {
    ensure(!signal.aborted, 'AUDIO_REQUEST_ABORTED');
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const result = await action(combined);
      ensure(!combined.aborted, 'AUDIO_REQUEST_ABORTED');
      return result;
    } catch (error) {
      if (error instanceof SpeechFailure && (signal.aborted || timeout.aborted))
        throw new SpeechFailure(signal.aborted ? 'AUDIO_REQUEST_ABORTED' : 'AUDIO_REQUEST_TIMEOUT', error.generation);
      if (signal.aborted) throw new DomainError('AUDIO_REQUEST_ABORTED');
      if (timeout.aborted) throw new DomainError('AUDIO_REQUEST_TIMEOUT');
      if (error instanceof DomainError) throw error;
      throw new DomainError('AUDIO_NETWORK_ERROR');
    }
  }
}
