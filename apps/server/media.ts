import type { SpeechGenerator } from '../../packages/contracts/audio.ts';
import type { Engine } from './engine.ts';
import { AudioFiles } from './audio-files.ts';
import { MediaServiceCore } from './media-core.ts';
export type { PreparedVoice } from './media-core.ts';

/** Original private local filesystem adapter; cloud code imports only the shared core. */
export class MediaService extends MediaServiceCore {
  readonly root: string;
  constructor(
    engine: Engine,
    root: string,
    generator: SpeechGenerator | null = null,
    notify: (worldId: string) => void = () => {},
  ) {
    const files = new AudioFiles(root);
    super(
      engine,
      {
        kind: 'local',
        write: (id, bytes) => files.write(id, bytes),
        read: (id, expected) => files.read(id, expected),
        remove: (id) => files.remove(id),
      },
      generator,
      notify,
    );
    this.root = root;
  }
}
