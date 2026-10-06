import type { Buffer } from 'node:buffer';
import type { CharacterScope } from '../../packages/contracts/index.ts';

export interface AudioIntegrity {
  byteLength: number | null;
  sha256: string | null;
}
export interface LocalAudioStorage {
  kind: 'local';
  write(id: string, bytes: Uint8Array): void;
  read(id: string, expected: AudioIntegrity): Buffer;
  remove(id: string): void;
}
export interface ExternalAudioStorage {
  kind: 'external';
  authorize(scope: CharacterScope): Promise<void>;
  stage(scope: CharacterScope, id: string, bytes: Uint8Array, checkCurrent: () => void): Promise<void>;
  read(scope: CharacterScope, id: string, expected: AudioIntegrity, checkCurrent: () => void): Promise<Buffer>;
}
export type AudioStorage = LocalAudioStorage | ExternalAudioStorage;

export interface ExternalAuditionStorage {
  kind: 'external';
  authorize(): Promise<void>;
  stage(id: string, bytes: Uint8Array, checkCurrent: () => void): Promise<void>;
  read(id: string, expected: AudioIntegrity, checkCurrent: () => void): Promise<Buffer>;
}
export type AuditionStorage = LocalAudioStorage | ExternalAuditionStorage;
