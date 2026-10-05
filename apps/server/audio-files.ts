import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError, ensure } from '../../packages/domain/errors.ts';

import { maximumAudioBytes } from './audio-validation.ts';

/** Separate private roots for published attachments and admin auditions; no caller-supplied paths. */
export class AudioFiles {
  readonly root: string;
  constructor(root: string) {
    this.root = root; mkdirSync(root, { recursive: true, mode: 0o700 }); const info = lstatSync(root);
    ensure(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'INSECURE_MEDIA_DIRECTORY');
  }
  write(id: string, bytes: Uint8Array) {
    ensure(/^[a-f0-9-]{36}$/.test(id) && bytes.byteLength <= maximumAudioBytes, 'INVALID_MEDIA_ID');
    const file = openSync(join(this.root, id + '.wav'), 'wx', 0o600);
    try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
  }
  remove(id: string) {
    ensure(/^[a-f0-9-]{36}$/.test(id), 'INVALID_MEDIA_ID');
    const directory = lstatSync(this.root);
    ensure(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0, 'INSECURE_MEDIA_DIRECTORY');
    try { unlinkSync(join(this.root, id + '.wav')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DomainError('MEDIA_CLEANUP_FAILED'); }
  }
  read(id: string, expected: { byteLength: number | null; sha256: string | null }): Buffer {
    ensure(/^[a-f0-9-]{36}$/.test(id), 'INVALID_MEDIA_ID'); let file: number;
    try { file = openSync(join(this.root, id + '.wav'), constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new DomainError('MEDIA_FILE_UNAVAILABLE'); }
    try {
      const info = fstatSync(file); ensure(info.isFile() && info.size <= maximumAudioBytes && (info.mode & 0o077) === 0, 'MEDIA_INTEGRITY_ERROR');
      const bytes = readFileSync(file);
      ensure(bytes.length === expected.byteLength && createHash('sha256').update(bytes).digest('hex') === expected.sha256, 'MEDIA_INTEGRITY_ERROR');
      return bytes;
    } finally { closeSync(file); }
  }
}
