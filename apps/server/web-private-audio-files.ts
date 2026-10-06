import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { inspectPCM } from '../../workers/audio/wav.ts';

export interface PrivateAudioExpectation {
  byteLength: number;
  sha256: string;
  durationMs: number;
}
const mediaIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only service-generated UUIDs enter this private, non-HTTP file store. */
export class WebPrivateAudioFiles {
  readonly root: string;
  private readonly parent: string;
  private readonly parentReal: string;
  private readonly rootReal: string;
  private readonly parentIdentity: { dev: number; ino: number };
  private readonly rootIdentity: { dev: number; ino: number };

  constructor(webRoot: string) {
    this.parent = webRoot;
    const initialParent = lstatSync(webRoot);
    ensure(
      initialParent.isDirectory() &&
        !initialParent.isSymbolicLink() &&
        (initialParent.mode & 0o777) === 0o700 &&
        realpathSync(webRoot) === webRoot,
      'WEB_PRIVATE_AUDIO_ROOT_UNSAFE',
    );
    this.parentReal = realpathSync(webRoot);
    this.root = join(webRoot, 'private-audio');
    try {
      mkdirSync(this.root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.rootReal = realpathSync(this.root);
    const parent = lstatSync(this.parent),
      root = lstatSync(this.root);
    this.parentIdentity = { dev: parent.dev, ino: parent.ino };
    this.rootIdentity = { dev: root.dev, ino: root.ino };
    this.checkRoot();
    this.syncDirectory(this.parent);
  }

  private syncDirectory(path: string) {
    this.checkRoot();
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd),
        expected = path === this.parent ? this.parentIdentity : this.rootIdentity;
      ensure(
        stat.isDirectory() && stat.dev === expected.dev && stat.ino === expected.ino,
        'WEB_PRIVATE_AUDIO_ROOT_UNSAFE',
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.checkRoot();
  }

  private checkRoot() {
    const parent = lstatSync(this.parent),
      root = lstatSync(this.root);
    ensure(
      parent.isDirectory() &&
        !parent.isSymbolicLink() &&
        (parent.mode & 0o777) === 0o700 &&
        realpathSync(this.parent) === this.parentReal &&
        root.isDirectory() &&
        !root.isSymbolicLink() &&
        (root.mode & 0o777) === 0o700 &&
        realpathSync(this.root) === this.rootReal &&
        dirname(this.rootReal) === this.parentReal &&
        parent.dev === this.parentIdentity.dev &&
        parent.ino === this.parentIdentity.ino &&
        root.dev === this.rootIdentity.dev &&
        root.ino === this.rootIdentity.ino,
      'WEB_PRIVATE_AUDIO_ROOT_UNSAFE',
    );
  }

  private path(mediaId: string) {
    ensure(mediaIdPattern.test(mediaId), 'WEB_PRIVATE_AUDIO_ID_INVALID');
    return join(this.root, `${mediaId}.wav`);
  }

  read(mediaId: string, expected: PrivateAudioExpectation): Buffer {
    return this.checkedRead(mediaId, expected, false);
  }

  /** Recovery cannot infer durability from a readable path: re-sync that same FD and its name. */
  durableRead(mediaId: string, expected: PrivateAudioExpectation): Buffer {
    return this.checkedRead(mediaId, expected, true);
  }

  /** Only a committed, scope-checked cleanup manifest may call this. Missing is idempotent. */
  deletePrivate(mediaId: string, expected: PrivateAudioExpectation): void {
    this.checkRoot();
    const path = this.path(mediaId);
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      // A previous unlink may have succeeded before its directory fsync failed.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.syncDirectory(this.root);
        return;
      }
      throw new DomainError('WEB_PRIVATE_AUDIO_UNAVAILABLE');
    }
    try {
      const stat = fstatSync(fd),
        named = lstatSync(path);
      ensure(
        stat.isFile() &&
          named.isFile() &&
          !named.isSymbolicLink() &&
          stat.dev === named.dev &&
          stat.ino === named.ino &&
          stat.nlink === 1 &&
          (stat.mode & 0o777) === 0o600 &&
          stat.size === expected.byteLength,
        'WEB_PRIVATE_AUDIO_INTEGRITY',
      );
      const bytes = readFileSync(fd);
      ensure(
        createHash('sha256').update(bytes).digest('hex') === expected.sha256 &&
          Math.round(inspectPCM(bytes, 60_000).durationMs) === expected.durationMs,
        'WEB_PRIVATE_AUDIO_INTEGRITY',
      );
      this.checkRoot();
      const beforeUnlink = lstatSync(path);
      ensure(beforeUnlink.dev === stat.dev && beforeUnlink.ino === stat.ino, 'WEB_PRIVATE_AUDIO_INTEGRITY');
      unlinkSync(path);
      this.syncDirectory(this.root);
    } finally {
      closeSync(fd);
    }
  }

  private checkedRead(mediaId: string, expected: PrivateAudioExpectation, durable: boolean): Buffer {
    this.checkRoot();
    let fd: number;
    try {
      fd = openSync(this.path(mediaId), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new DomainError('WEB_PRIVATE_AUDIO_UNAVAILABLE');
    }
    try {
      const stat = fstatSync(fd);
      ensure(
        stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size === expected.byteLength && stat.size <= 6_000_000,
        'WEB_PRIVATE_AUDIO_INTEGRITY',
      );
      const bytes = readFileSync(fd);
      ensure(
        bytes.length === expected.byteLength &&
          createHash('sha256').update(bytes).digest('hex') === expected.sha256 &&
          Math.round(inspectPCM(bytes, 60_000).durationMs) === expected.durationMs,
        'WEB_PRIVATE_AUDIO_INTEGRITY',
      );
      if (durable) fsyncSync(fd);
      this.checkRoot();
      if (durable) this.syncDirectory(this.root);
      return bytes;
    } finally {
      closeSync(fd);
    }
  }

  /** Never overwrites a final file. A crash may leave a restricted final file for the same intent. */
  write(mediaId: string, bytes: Buffer, expected: PrivateAudioExpectation) {
    ensure(
      bytes.length === expected.byteLength && createHash('sha256').update(bytes).digest('hex') === expected.sha256,
      'WEB_PRIVATE_AUDIO_INTEGRITY',
    );
    this.checkRoot();
    const finalPath = this.path(mediaId),
      tempPath = join(this.root, `.tmp-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.checkRoot();
      try {
        linkSync(tempPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.read(mediaId, expected);
      }
      this.syncDirectory(this.root);
    } finally {
      if (fd !== undefined) closeSync(fd);
      this.checkRoot();
      try {
        unlinkSync(tempPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.syncDirectory(this.root);
    }
    this.read(mediaId, expected);
  }
}
