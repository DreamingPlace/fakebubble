// Staging listening aid: `pnpm voice:samples <provider-root> <env-dir> <out-dir> --live [--model=s2.1-pro|drama-3]`.
// Writes one clip per approved character voice per expression to <out-dir>/<character>/<expression>.<model>.wav plus a
// manifest. No player data is read or written. Run it once per model into two folders and compare them by ear.
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SITE_VOICE_MODEL, type FishModel } from '../packages/contracts/audio.ts';
import { ensure } from '../packages/domain/errors.ts';
import { siteVoiceModelFromEnv } from '../config/web-voice-model.ts';
import { FishAudio } from '../workers/audio/fish.ts';
import { openLiveBudget } from '../apps/server/budget/web-provider-live-budget.ts';
import {
  renderVoiceSamples,
  VOICE_SAMPLE_TEXT,
  type VoiceSampleClip,
} from '../apps/server/generation/web-voice-samples.ts';
import { openProviderStore, voiceEnvironment } from './web-provider.ts';

export async function writeVoiceSamples(root: string, envDir: string, outDir: string, modelArg?: string) {
  const voiceEnv = voiceEnvironment(join(envDir, '.env.voice'), {});
  ensure(Boolean(voiceEnv.FISH_API_KEY?.trim()), 'WEB_PROVIDER_CREDENTIAL_MISSING');
  const model: FishModel = siteVoiceModelFromEnv(modelArg ?? voiceEnv.FISH_VOICE_MODEL);
  const out = resolve(outDir);
  ensure(!existsSync(out) || readdirSync(out).length === 0, 'VOICE_SAMPLES_OUTPUT_NOT_EMPTY');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const budget = openLiveBudget();
  const { store } = openProviderStore(root);
  try {
    budget.recoverKnown(store);
    const fish = new FishAudio({ apiKey: voiceEnv.FISH_API_KEY!, model });
    const clips = await renderVoiceSamples(store, { now: () => Date.now() }, budget, fish.generate.bind(fish), {
      model,
      sink: (clip: VoiceSampleClip, wav) => {
        mkdirSync(join(out, clip.characterId), { recursive: true, mode: 0o700 });
        writeFileSync(join(out, clip.characterId, `${clip.expression}.${clip.model}.wav`), wav, { mode: 0o600 });
      },
    });
    const manifest = { model, defaultModel: DEFAULT_SITE_VOICE_MODEL, text: VOICE_SAMPLE_TEXT, clips };
    writeFileSync(join(out, `manifest.${model}.json`), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    return manifest;
  } finally {
    store.close();
    budget.close();
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  ensure(positional.length === 3, 'VOICE_SAMPLES_USAGE');
  // Paid calls: fail before reading credentials or opening anything.
  ensure(args.includes('--live'), 'WEB_PROVIDER_LIVE_OPT_IN_REQUIRED');
  const model = args.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
  const [root, envDir, outDir] = positional as [string, string, string];
  const manifest = await writeVoiceSamples(root, envDir, outDir, model);
  process.stdout.write(`${JSON.stringify({ model: manifest.model, clips: manifest.clips.length, outDir })}\n`);
}
